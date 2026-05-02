import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import { ForgejoClient, RepoMetadata } from "../forgejo/forgejo.client"
import { OpenFgaService } from "../openfga/openfga.service"
import { CreateRepoInput, Repo, RepoKind, RepoSource } from "./repos.types"

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

  // Lists repos the caller cares about: their own (functionOrg + FGA
  // tuple) plus the platform-shared catalog (templateOrg). Function
  // repos and orgs the user has no business in are filtered out.
  async listForOwner(ownerId: string): Promise<Repo[]> {
    if (!this.forgejo.enabled) return []

    const mineSlugs = await this.fga.listAccessibleRepos(ownerId)
    const [mine, platform] = await Promise.all([
      Promise.all(
        mineSlugs.map((slug) =>
          this.forgejo
            .getRepo({ org: this.forgejo.functionOrg, repo: slug })
            .catch((err) => {
              this.log.warn(`getRepo ${slug}: ${(err as Error).message}`)
              return null
            }),
        ),
      ),
      this.forgejo
        .listOrgRepos({ org: this.forgejo.templateOrg })
        .catch((err) => {
          this.log.warn(
            `listOrgRepos ${this.forgejo.templateOrg}: ${(err as Error).message}`,
          )
          return []
        }),
    ])

    const out: Repo[] = []
    for (const m of mine) {
      if (m) out.push(this.toRepo(m, this.forgejo.functionOrg, "mine"))
    }
    for (const m of platform) {
      out.push(this.toRepo(m, this.forgejo.templateOrg, "platform"))
    }
    return out
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
