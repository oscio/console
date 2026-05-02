import { Injectable, Logger, NotFoundException } from "@nestjs/common"
import { ForgejoClient, RepoMetadata } from "../forgejo/forgejo.client"
import { OpenFgaService } from "../openfga/openfga.service"
import { Repo, RepoSource } from "./repos.types"

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
    const items = await this.forgejo.listOrgRepos({
      org: this.forgejo.functionOrg,
    })
    // Function repos share the org but are managed under
    // /services/functions; filter them out so /repos stays focused
    // on standalone repos. The "function-" prefix is the slug
    // contract enforced in functions.service.ts.
    return items
      .filter((m) => !m.name.startsWith("function-"))
      .map((m) => this.toRepo(m))
  }

  async listForOwner(ownerId: string): Promise<Repo[]> {
    const slugs = await this.fga.listAccessibleRepos(ownerId)
    if (slugs.length === 0) return []
    if (!this.forgejo.enabled) return []
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
      .map((m) => this.toRepo(m))
  }

  async get(ownerId: string, slug: string): Promise<Repo> {
    if (!(await this.fga.canAccessRepo(ownerId, slug))) {
      throw new NotFoundException(`repo ${slug} not found`)
    }
    if (!this.forgejo.enabled) {
      throw new NotFoundException("Forgejo is not configured")
    }
    const m = await this.forgejo.getRepo({
      org: this.forgejo.functionOrg,
      repo: slug,
    })
    if (!m) throw new NotFoundException(`repo ${slug} not found`)
    return this.toRepo(m)
  }

  // Maps Forgejo's response into our Repo type. Source is derived
  // from original_url — non-empty means the repo was created via
  // generate/migrate from somewhere else (currently only GitHub
  // import wires that up).
  private toRepo(m: RepoMetadata): Repo {
    const source: RepoSource = m.originalUrl ? "github-import" : "forgejo"
    return {
      id: m.name,
      slug: m.name,
      name: m.name,
      // owner is opaque to the page (it's the platform user id, not
      // a Forgejo identity). Filled in from FGA at controller scope
      // when needed; for the list we leave it as the requesting
      // user since we already gated on can_access.
      owner: "",
      source,
      forgejoUrl: m.htmlUrl || this.forgejo.repoWebUrl(m.name),
      cloneUrl: m.cloneUrl || this.forgejo.repoCloneUrl(m.name),
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
