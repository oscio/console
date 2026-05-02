import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import { ForgejoClient, RepoMetadata } from "../forgejo/forgejo.client"
import { OpenFgaService } from "../openfga/openfga.service"
import {
  CreateRepoInput,
  ForkRepoInput,
  ImportRepoInput,
  Repo,
  RepoKind,
  RepoSource,
} from "./repos.types"

@Injectable()
export class ReposService {
  private readonly log = new Logger(ReposService.name)
  constructor(
    private readonly fga: OpenFgaService,
    private readonly forgejo: ForgejoClient,
  ) {}

  // Forgejo is the source of truth — we don't mirror metadata in our
  // DB. Only ownership lives console-side (FGA tuples). Listing =
  // FGA listObjects → fetch each repo's metadata from Forgejo.
  // Metadata fetches run in parallel; missing repos (Forgejo 404)
  // are skipped with a warning so a stale FGA tuple doesn't break
  // the whole list.

  async listAll(): Promise<Repo[]> {
    if (!this.forgejo.enabled) return []
    const [fnOrgItems, platformItems] = await Promise.all([
      this.forgejo.listOrgRepos({ org: this.forgejo.functionOrg }),
      this.forgejo.listOrgRepos({ org: this.forgejo.templateOrg }),
    ])
    // function-* repos under functionOrg are managed under
    // /services/functions; filter them out so /repos stays focused.
    return [
      ...fnOrgItems
        .filter((m) => !m.name.startsWith("function-"))
        .map((m) => this.toRepo(m, this.forgejo.functionOrg, "mine")),
      ...platformItems.map((m) =>
        this.toRepo(m, this.forgejo.templateOrg, "platform"),
      ),
    ]
  }

  // Mine = repos the user has an FGA owner tuple on (created via
  // /repos POST or fork/import endpoints). Admins go through
  // listAll() instead and see platform repos and other users' too.
  async listForOwner(ownerId: string): Promise<Repo[]> {
    if (!this.forgejo.enabled) return []
    const slugs = await this.fga.listAccessibleRepos(ownerId)
    if (slugs.length === 0) return []
    const results = await Promise.all(
      slugs.map((slug) =>
        this.forgejo
          .getRepo({ org: this.forgejo.functionOrg, repo: slug })
          .catch((err) => {
            this.log.warn(`getRepo ${slug}: ${(err as Error).message}`)
            return null
          }),
      ),
    )
    return results
      .filter((m): m is RepoMetadata => m !== null)
      .map((m) => this.toRepo(m, this.forgejo.functionOrg, "mine"))
  }

  // Fork-source candidates — what users can pick from in the Fork
  // dialog. Phase-2: every platform-shared (templateOrg) repo. Visible
  // to all signed-in users regardless of FGA role since cloning a
  // public template repo is harmless.
  async listForkSources(): Promise<Repo[]> {
    if (!this.forgejo.enabled) return []
    const items = await this.forgejo.listOrgRepos({
      org: this.forgejo.templateOrg,
    })
    return items.map((m) =>
      this.toRepo(m, this.forgejo.templateOrg, "platform"),
    )
  }

  async get(ownerId: string, slug: string): Promise<Repo> {
    if (!this.forgejo.enabled) {
      throw new NotFoundException("Forgejo is not configured")
    }
    // Try mine first (gated by FGA), fall back to platform (read-only,
    // visible to all signed-in users).
    if (await this.fga.canAccessRepo(ownerId, slug)) {
      const m = await this.forgejo.getRepo({
        org: this.forgejo.functionOrg,
        repo: slug,
      })
      if (m) return this.toRepo(m, this.forgejo.functionOrg, "mine")
    }
    const m = await this.forgejo.getRepo({
      org: this.forgejo.templateOrg,
      repo: slug,
    })
    if (m) return this.toRepo(m, this.forgejo.templateOrg, "platform")
    throw new NotFoundException(`repo ${slug} not found`)
  }

  // Create an empty Forgejo repo and grant the caller owner. The
  // sanitised name is the slug (= Forgejo repo name); the user's
  // input becomes the description so the human-readable form
  // survives. Reserved prefixes (function-) blocked so user repos
  // don't collide with the function namespace.
  async create(ownerId: string, input: CreateRepoInput): Promise<Repo> {
    const name = sanitizeRepoName(input.name)
    if (!name) {
      throw new BadRequestException("name is required")
    }
    if (name.startsWith("function-")) {
      throw new BadRequestException(
        "name conflicts with the reserved function- prefix",
      )
    }
    if (!this.forgejo.enabled) {
      throw new BadRequestException("Forgejo is not configured")
    }
    try {
      await this.forgejo.createOrgRepo({
        org: this.forgejo.functionOrg,
        name,
        description: input.name,
        autoInit: true,
        private: false,
      })
    } catch (err) {
      const msg = (err as Error).message
      if (/422|409|already.*exists/i.test(msg)) {
        throw new ConflictException(
          `repo "${name}" already exists — pick a different name`,
        )
      }
      throw err
    }
    try {
      await this.fga.grantRepoOwner(name, ownerId)
    } catch (err) {
      await this.forgejo
        .deleteRepo(this.forgejo.functionOrg, name)
        .catch((cleanupErr) =>
          this.log.warn(
            `cleanup failed for ${name}: ${(cleanupErr as Error).message}`,
          ),
        )
      throw err
    }
    return this.get(ownerId, name)
  }

  // Fork an existing Forgejo repo into the user's namespace. Uses
  // Forgejo's migrate API with the internal clone URL so we don't
  // depend on Forgejo's user-namespaced /forks API (which would land
  // under the admin user, not where we want it). One-time copy
  // (mirror=false) — no upstream auto-sync.
  async fork(ownerId: string, input: ForkRepoInput): Promise<Repo> {
    if (!this.forgejo.enabled) {
      throw new BadRequestException("Forgejo is not configured")
    }
    const targetName = sanitizeRepoName(input.name || input.sourceName)
    if (!targetName) {
      throw new BadRequestException("name is required")
    }
    if (targetName.startsWith("function-")) {
      throw new BadRequestException(
        "name conflicts with the reserved function- prefix",
      )
    }
    const cloneAddr = this.forgejo.internalCloneUrl(
      input.sourceOrg,
      input.sourceName,
    )
    if (!cloneAddr) {
      throw new BadRequestException("Forgejo internal URL not configured")
    }
    return this.materializeFromMigrate({
      ownerId,
      targetName,
      cloneAddr,
      description: `Forked from ${input.sourceOrg}/${input.sourceName}`,
    })
  }

  // Import a public GitHub repo via Forgejo's migrate. After this the
  // GitHub side is irrelevant — the repo is a normal Forgejo repo
  // owned by the caller. PATs / private repos intentionally not
  // supported in Phase-2.
  async import(ownerId: string, input: ImportRepoInput): Promise<Repo> {
    if (!this.forgejo.enabled) {
      throw new BadRequestException("Forgejo is not configured")
    }
    const url = (input.githubUrl ?? "").trim()
    if (!/^https?:\/\/github\.com\/[^/]+\/[^/]+/.test(url)) {
      throw new BadRequestException(
        "githubUrl must look like https://github.com/<owner>/<repo>",
      )
    }
    // Strip optional trailing .git and pull the last path segment
    // for the default name.
    const lastSegment =
      url
        .replace(/\.git$/, "")
        .split("/")
        .filter(Boolean)
        .pop() ?? ""
    const targetName = sanitizeRepoName(input.name || lastSegment)
    if (!targetName) {
      throw new BadRequestException("name is required")
    }
    if (targetName.startsWith("function-")) {
      throw new BadRequestException(
        "name conflicts with the reserved function- prefix",
      )
    }
    return this.materializeFromMigrate({
      ownerId,
      targetName,
      cloneAddr: url,
      description: `Imported from ${url}`,
    })
  }

  // Shared back-end for fork() and import(). Calls migrate, then
  // grants FGA owner. On grant failure, deletes the freshly migrated
  // repo so we don't leak orphaned Forgejo content.
  private async materializeFromMigrate(input: {
    ownerId: string
    targetName: string
    cloneAddr: string
    description: string
  }): Promise<Repo> {
    try {
      await this.forgejo.migrateRepo({
        cloneAddr: input.cloneAddr,
        repoOwner: this.forgejo.functionOrg,
        repoName: input.targetName,
        description: input.description,
        private: false,
      })
    } catch (err) {
      const msg = (err as Error).message
      if (/422|409|already.*exists/i.test(msg)) {
        throw new ConflictException(
          `repo "${input.targetName}" already exists — pick a different name`,
        )
      }
      throw err
    }
    try {
      await this.fga.grantRepoOwner(input.targetName, input.ownerId)
    } catch (err) {
      await this.forgejo
        .deleteRepo(this.forgejo.functionOrg, input.targetName)
        .catch((cleanupErr) =>
          this.log.warn(
            `cleanup failed for ${input.targetName}: ${(cleanupErr as Error).message}`,
          ),
        )
      throw err
    }
    return this.get(input.ownerId, input.targetName)
  }

  async delete(ownerId: string, slug: string): Promise<void> {
    const owners = await this.fga.listRepoOwners(slug)
    if (!owners.includes(ownerId)) {
      throw new NotFoundException(`repo ${slug} not found`)
    }
    for (const uid of owners) {
      await this.fga.revokeRepoOwner(slug, uid).catch(() => {})
    }
    if (this.forgejo.enabled) {
      await this.forgejo
        .deleteRepo(this.forgejo.functionOrg, slug)
        .catch((err) => this.log.error(`Forgejo delete ${slug}: ${err}`))
    }
  }

  // Maps Forgejo's response into our Repo type. Source is derived
  // from original_url — non-empty means the repo was created via
  // generate/migrate from somewhere else (currently only GitHub
  // import wires that up). Org + kind are passed in by the caller
  // so the same metadata shape works for "mine" and "platform"
  // listings without an extra Forgejo lookup.
  private toRepo(m: RepoMetadata, org: string, kind: RepoKind): Repo {
    const source: RepoSource = m.originalUrl ? "github-import" : "forgejo"
    const fallbackWebUrl =
      org === this.forgejo.functionOrg
        ? this.forgejo.repoWebUrl(m.name)
        : ""
    return {
      id: `${org}/${m.name}`,
      slug: m.name,
      name: m.name,
      forgejoOrg: org,
      kind,
      source,
      forgejoUrl: m.htmlUrl || fallbackWebUrl,
      cloneUrl: m.cloneUrl,
      createdAt: m.createdAt,
    }
  }
}

// Best-effort sanitiser shared with create+import (lands in follow-up
// commits). Forgejo accepts a fairly permissive name set but we lock
// it down to the slug shape we already use elsewhere.
export function sanitizeRepoName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
}
