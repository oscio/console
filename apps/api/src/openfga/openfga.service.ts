import { promises as fs } from "node:fs"
import { Injectable, Logger, OnModuleInit } from "@nestjs/common"

// Single object that platform-level role tuples hang off. The OpenFGA
// model has `type platform { relations: console_admin: [user] }` — there
// is no per-tenant scoping yet, so every check uses `platform:default`.
export const PLATFORM_OBJECT = "platform:default"

// Console-admin is the in-app role that platform-admins (Keycloak group,
// not an FGA relation) can grant/revoke. Console-admins themselves cannot
// manage roles. Underscore (not hyphen) because OpenFGA disallows hyphens
// in relation identifiers.
export const CONSOLE_ADMIN_RELATION = "console_admin"

export type TupleKey = { user: string; relation: string; object: string }

@Injectable()
export class OpenFgaService implements OnModuleInit {
  private readonly log = new Logger(OpenFgaService.name)
  private apiUrl!: string
  private storeId!: string

  async onModuleInit() {
    // Prefer real env (k8s Secret-injected); fall back to the file the
    // openfga-bootstrap container drops on the shared dev volume.
    const fileEnv = await readDevEnvFile("/var/run/openfga/openfga.env")

    const apiUrl = process.env.OPENFGA_API_URL ?? fileEnv.OPENFGA_API_URL
    const storeId = process.env.OPENFGA_STORE_ID ?? fileEnv.OPENFGA_STORE_ID

    if (!apiUrl || !storeId) {
      throw new Error(
        "OpenFGA not configured: missing OPENFGA_API_URL or OPENFGA_STORE_ID",
      )
    }

    this.apiUrl = apiUrl
    this.storeId = storeId
    this.log.log(`OpenFGA configured: ${apiUrl} store=${storeId}`)
  }

  async check(user: string, relation: string, object: string): Promise<boolean> {
    const res = await this.post(`/stores/${this.storeId}/check`, {
      tuple_key: { user, relation, object },
    })
    return Boolean(res.allowed)
  }

  async write(tuples: TupleKey[]): Promise<void> {
    await this.post(`/stores/${this.storeId}/write`, {
      writes: { tuple_keys: tuples },
    })
  }

  async deleteTuples(tuples: TupleKey[]): Promise<void> {
    await this.post(`/stores/${this.storeId}/write`, {
      deletes: { tuple_keys: tuples },
    })
  }

  // List user-shaped subjects with the given relation to the given object.
  async listSubjects(relation: string, object: string): Promise<string[]> {
    const res = await this.post(`/stores/${this.storeId}/read`, {
      tuple_key: { relation, object },
    })
    const tuples = (res.tuples ?? []) as Array<{ key: TupleKey }>
    return tuples.map((t) => t.key.user)
  }

  // List every object of `type` the user has `relation` on. The caller
  // gets back the bare slug (no `type:` prefix). Used to drive the
  // /vms /volumes /loadbalancers /agents list endpoints in place of
  // the old "list everything in resource-vm-<owner>" namespace scan.
  async listObjects(
    userId: string,
    relation: string,
    type: string,
  ): Promise<string[]> {
    const res = await this.post(`/stores/${this.storeId}/list-objects`, {
      type,
      relation,
      user: userKey(userId),
    })
    const objects = (res.objects ?? []) as string[]
    const prefix = `${type}:`
    return objects
      .filter((o) => o.startsWith(prefix))
      .map((o) => o.slice(prefix.length))
  }

  async listAccessibleVms(userId: string): Promise<string[]> {
    return this.listObjects(userId, "can_access", "vm")
  }
  async listAccessibleVolumes(userId: string): Promise<string[]> {
    return this.listObjects(userId, "can_access", "volume")
  }
  async listAccessibleLoadBalancers(userId: string): Promise<string[]> {
    return this.listObjects(userId, "can_access", "loadbalancer")
  }
  async listAccessibleAgents(userId: string): Promise<string[]> {
    return this.listObjects(userId, "can_access", "agent")
  }
  async listAccessibleFunctions(userId: string): Promise<string[]> {
    return this.listObjects(userId, "can_access", "function")
  }
  async listAccessibleRepos(userId: string): Promise<string[]> {
    return this.listObjects(userId, "can_access", "repo")
  }

  // ---- Console-admin convenience -----------------------------------------
  // Note: there is intentionally no platform-admin equivalent. Platform-admin
  // is sourced from the Keycloak `platform-admin` group claim; it never
  // becomes a tuple, so it cannot be granted or revoked via this service.

  async isConsoleAdmin(userId: string): Promise<boolean> {
    return this.check(userKey(userId), CONSOLE_ADMIN_RELATION, PLATFORM_OBJECT)
  }

  async listConsoleAdmins(): Promise<string[]> {
    const subjects = await this.listSubjects(
      CONSOLE_ADMIN_RELATION,
      PLATFORM_OBJECT,
    )
    return subjects
      .filter((s) => s.startsWith("user:"))
      .map((s) => s.slice("user:".length))
  }

  async grantConsoleAdmin(userId: string): Promise<void> {
    await this.write([
      {
        user: userKey(userId),
        relation: CONSOLE_ADMIN_RELATION,
        object: PLATFORM_OBJECT,
      },
    ])
  }

  async revokeConsoleAdmin(userId: string): Promise<void> {
    await this.deleteTuples([
      {
        user: userKey(userId),
        relation: CONSOLE_ADMIN_RELATION,
        object: PLATFORM_OBJECT,
      },
    ])
  }

  // Best-effort tuple cleanup when a user is deleted. Today only the
  // console_admin tuple — extend as new types (project, vm, ...) gain
  // user-shaped relations.
  async cleanupUserTuples(userId: string): Promise<void> {
    if (await this.isConsoleAdmin(userId)) {
      await this.revokeConsoleAdmin(userId)
    }
  }

  // ---- VM ownership ------------------------------------------------------
  // Per `openfga/model.fga`, type `vm` has a single `owner: [user]`
  // relation and `can_access` resolves to owner. The per-VM auth
  // gate (Traefik forwardAuth → /vms/auth) calls canAccessVm to
  // decide whether a logged-in user is allowed near the workload.

  async grantVmOwner(slug: string, userId: string): Promise<void> {
    await this.write([
      { user: userKey(userId), relation: "owner", object: vmKey(slug) },
    ])
  }

  async revokeVmOwner(slug: string, userId: string): Promise<void> {
    await this.deleteTuples([
      { user: userKey(userId), relation: "owner", object: vmKey(slug) },
    ])
  }

  // List every owner of a VM. Used so revoke/delete can tear down
  // the tuple without requiring the caller to know the owner.
  async listVmOwners(slug: string): Promise<string[]> {
    const subjects = await this.listSubjects("owner", vmKey(slug))
    return subjects
      .filter((s) => s.startsWith("user:"))
      .map((s) => s.slice("user:".length))
  }

  async canAccessVm(userId: string, slug: string): Promise<boolean> {
    return this.check(userKey(userId), "can_access", vmKey(slug))
  }

  // ---- Agent ownership ---------------------------------------------------
  // Mirrors the VM pattern. `type agent` has the same `owner` /
  // `can_access` shape so the per-agent forwardAuth gate (Traefik
  // → /agents/auth) reuses the same check semantics as VMs.

  async grantAgentOwner(slug: string, userId: string): Promise<void> {
    await this.write([
      { user: userKey(userId), relation: "owner", object: agentKey(slug) },
    ])
  }

  async revokeAgentOwner(slug: string, userId: string): Promise<void> {
    await this.deleteTuples([
      { user: userKey(userId), relation: "owner", object: agentKey(slug) },
    ])
  }

  async listAgentOwners(slug: string): Promise<string[]> {
    const subjects = await this.listSubjects("owner", agentKey(slug))
    return subjects
      .filter((s) => s.startsWith("user:"))
      .map((s) => s.slice("user:".length))
  }

  async canAccessAgent(userId: string, slug: string): Promise<boolean> {
    return this.check(userKey(userId), "can_access", agentKey(slug))
  }

  // ---- Volume ownership --------------------------------------------------

  async grantVolumeOwner(slug: string, userId: string): Promise<void> {
    await this.write([
      { user: userKey(userId), relation: "owner", object: volumeKey(slug) },
    ])
  }

  async revokeVolumeOwner(slug: string, userId: string): Promise<void> {
    await this.deleteTuples([
      { user: userKey(userId), relation: "owner", object: volumeKey(slug) },
    ])
  }

  async listVolumeOwners(slug: string): Promise<string[]> {
    const subjects = await this.listSubjects("owner", volumeKey(slug))
    return subjects
      .filter((s) => s.startsWith("user:"))
      .map((s) => s.slice("user:".length))
  }

  async canAccessVolume(userId: string, slug: string): Promise<boolean> {
    return this.check(userKey(userId), "can_access", volumeKey(slug))
  }

  // ---- LoadBalancer ownership --------------------------------------------

  async grantLoadBalancerOwner(slug: string, userId: string): Promise<void> {
    await this.write([
      { user: userKey(userId), relation: "owner", object: lbKey(slug) },
    ])
  }

  async revokeLoadBalancerOwner(slug: string, userId: string): Promise<void> {
    await this.deleteTuples([
      { user: userKey(userId), relation: "owner", object: lbKey(slug) },
    ])
  }

  async listLoadBalancerOwners(slug: string): Promise<string[]> {
    const subjects = await this.listSubjects("owner", lbKey(slug))
    return subjects
      .filter((s) => s.startsWith("user:"))
      .map((s) => s.slice("user:".length))
  }

  async canAccessLoadBalancer(userId: string, slug: string): Promise<boolean> {
    return this.check(userKey(userId), "can_access", lbKey(slug))
  }

  // ---- Function ownership ------------------------------------------------
  // Phase 1: tuple is the only ACL surface (metadata-only). Same shape as
  // VMs/agents so a future runtime gate (per-function URL) can reuse it.

  async grantFunctionOwner(slug: string, userId: string): Promise<void> {
    await this.write([
      { user: userKey(userId), relation: "owner", object: functionKey(slug) },
    ])
  }

  async revokeFunctionOwner(slug: string, userId: string): Promise<void> {
    await this.deleteTuples([
      { user: userKey(userId), relation: "owner", object: functionKey(slug) },
    ])
  }

  async listFunctionOwners(slug: string): Promise<string[]> {
    const subjects = await this.listSubjects("owner", functionKey(slug))
    return subjects
      .filter((s) => s.startsWith("user:"))
      .map((s) => s.slice("user:".length))
  }

  async canAccessFunction(userId: string, slug: string): Promise<boolean> {
    return this.check(userKey(userId), "can_access", functionKey(slug))
  }

  // ---- Repo (standalone Forgejo repos managed via /repos page) ----

  async grantRepoOwner(slug: string, userId: string): Promise<void> {
    await this.write([
      { user: userKey(userId), relation: "owner", object: repoKey(slug) },
    ])
  }

  async revokeRepoOwner(slug: string, userId: string): Promise<void> {
    await this.deleteTuples([
      { user: userKey(userId), relation: "owner", object: repoKey(slug) },
    ])
  }

  async listRepoOwners(slug: string): Promise<string[]> {
    const subjects = await this.listSubjects("owner", repoKey(slug))
    return subjects
      .filter((s) => s.startsWith("user:"))
      .map((s) => s.slice("user:".length))
  }

  async canAccessRepo(userId: string, slug: string): Promise<boolean> {
    return this.check(userKey(userId), "can_access", repoKey(slug))
  }

  // -------------------------------------------------------------------------

  private async post(path: string, body: unknown): Promise<any> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`OpenFGA ${path} -> ${res.status}: ${text}`)
    }
    return res.json()
  }
}

export function userKey(userId: string): string {
  return `user:${userId}`
}

export function vmKey(slug: string): string {
  return `vm:${slug}`
}

export function agentKey(slug: string): string {
  return `agent:${slug}`
}

export function volumeKey(slug: string): string {
  return `volume:${slug}`
}

export function lbKey(slug: string): string {
  return `loadbalancer:${slug}`
}

export function functionKey(slug: string): string {
  return `function:${slug}`
}

export function repoKey(slug: string): string {
  return `repo:${slug}`
}

async function readDevEnvFile(path: string): Promise<Record<string, string>> {
  try {
    const text = await fs.readFile(path, "utf8")
    const out: Record<string, string> = {}
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith("#")) continue
      const eq = line.indexOf("=")
      if (eq === -1) continue
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
    return out
  } catch {
    return {}
  }
}
