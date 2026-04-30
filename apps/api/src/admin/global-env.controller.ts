import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
  UseGuards,
} from "@nestjs/common"
import { GLOBAL_AGENT_ENV_SECRET } from "../agents/agents.types"
import { k8sCore } from "../agents/k8s.client"
import { AuthGuard } from "../auth/auth.guard"
import { ConsoleAdminGuard } from "../auth/admin.guard"
import { RESOURCE_NS } from "../vms/vms.service"

// Single Secret that fronts the cluster-wide agent env. Every agent
// pod mounts this via `envFrom` (with `optional: true` so the pod
// schedules even before an admin populates it). Updates take effect
// on the next pod restart — k8s does not hot-reload env from
// Secrets.
//
// Read–modify–write rather than patch because the @kubernetes/
// client-node v1 typed client picks `application/json-patch+json`
// as its default content type, and we'd have to wrestle middleware
// to switch to merge-patch. A full replace with the previous
// `resourceVersion` is just simpler — concurrent admin edits to
// different keys race-resolve via 409, and we surface that.

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

@Controller("admin/global-env")
@UseGuards(AuthGuard, ConsoleAdminGuard)
export class GlobalEnvController {
  // Read the current key/value list. Values are returned in plain
  // text — admins manage these in the UI directly, and they can
  // already pull the Secret with `kubectl get secret -o yaml`, so
  // there's nothing to gain by masking here. The endpoint is gated
  // by ConsoleAdminGuard so non-admins never reach this code path.
  @Get()
  async list(): Promise<{ keys: { name: string; value: string }[] }> {
    const secret = await readSecret()
    if (!secret) return { keys: [] }
    const data = secret.data ?? {}
    const keys = Object.keys(data)
      .sort()
      .map((name) => {
        const raw = data[name]
        const value = raw ? Buffer.from(raw, "base64").toString("utf8") : ""
        return { name, value }
      })
    return { keys }
  }

  // Upsert a single key/value pair. `value === ""` is treated as a
  // delete to keep the surface symmetric with the modal which uses
  // an empty input to mean "clear it".
  @Put(":key")
  @HttpCode(204)
  async upsert(
    @Param("key") key: string,
    @Body() body: { value?: string },
  ): Promise<void> {
    if (!ENV_NAME_RE.test(key)) {
      throw new BadRequestException(
        "key must match [A-Za-z_][A-Za-z0-9_]*",
      )
    }
    const value = typeof body?.value === "string" ? body.value : ""
    if (value === "") {
      await mutateSecret((data) => {
        const { [key]: _drop, ...rest } = data
        void _drop
        return rest
      })
      return
    }
    const encoded = Buffer.from(value, "utf8").toString("base64")
    await mutateSecret((data) => ({ ...data, [key]: encoded }))
  }

  @Delete(":key")
  @HttpCode(204)
  async delete(@Param("key") key: string): Promise<void> {
    if (!ENV_NAME_RE.test(key)) {
      throw new BadRequestException("key must match [A-Za-z_][A-Za-z0-9_]*")
    }
    await mutateSecret((data) => {
      const { [key]: _drop, ...rest } = data
      void _drop
      return rest
    })
  }
}

type SecretSnapshot = {
  metadata?: { resourceVersion?: string; name?: string; namespace?: string }
  data?: Record<string, string>
}

// Returns null if the Secret hasn't been created yet — the GET path
// surfaces an empty list rather than a 404.
async function readSecret(): Promise<SecretSnapshot | null> {
  try {
    const res = await k8sCore().readNamespacedSecret({
      name: GLOBAL_AGENT_ENV_SECRET,
      namespace: RESOURCE_NS,
    })
    return res as SecretSnapshot
  } catch (err) {
    if (isNotFound(err)) return null
    throw err
  }
}

// Read-modify-write the Secret. `mutator` returns the new `data`
// map (already base64-encoded) given the current one. Handles the
// "doesn't exist yet" case by creating with the mutated data.
async function mutateSecret(
  mutator: (data: Record<string, string>) => Record<string, string>,
): Promise<void> {
  const core = k8sCore()
  const existing = await readSecret()
  const nextData = mutator(existing?.data ?? {})

  if (!existing) {
    if (Object.keys(nextData).length === 0) return
    await core.createNamespacedSecret({
      namespace: RESOURCE_NS,
      body: {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name: GLOBAL_AGENT_ENV_SECRET,
          namespace: RESOURCE_NS,
          labels: { "agent-platform/component": "global-env" },
        },
        type: "Opaque",
        data: nextData,
      },
    })
    return
  }

  try {
    await core.replaceNamespacedSecret({
      name: GLOBAL_AGENT_ENV_SECRET,
      namespace: RESOURCE_NS,
      body: {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name: GLOBAL_AGENT_ENV_SECRET,
          namespace: RESOURCE_NS,
          resourceVersion: existing.metadata?.resourceVersion,
          labels: { "agent-platform/component": "global-env" },
        },
        type: "Opaque",
        data: nextData,
      },
    })
  } catch (err) {
    if (isConflict(err)) {
      throw new ConflictException(
        "Secret was modified by another writer; refresh and retry.",
      )
    }
    throw err
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { code?: number; statusCode?: number; status?: number }
  return e?.code === 404 || e?.statusCode === 404 || e?.status === 404
}

function isConflict(err: unknown): boolean {
  const e = err as { code?: number; statusCode?: number; status?: number }
  return e?.code === 409 || e?.statusCode === 409 || e?.status === 409
}
