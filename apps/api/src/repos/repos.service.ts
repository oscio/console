import { Injectable, Logger, NotFoundException } from "@nestjs/common"
import { authPool } from "@workspace/auth"
import { ForgejoClient } from "../forgejo/forgejo.client"
import { OpenFgaService } from "../openfga/openfga.service"
import { Repo, RepoSource } from "./repos.types"

type Row = {
  slug: string
  owner_id: string
  name: string
  source: string
  created_at: Date
}

const ROW_COLUMNS = `slug, owner_id, name, source, created_at`

@Injectable()
export class ReposService {
  private readonly log = new Logger(ReposService.name)
  constructor(
    private readonly fga: OpenFgaService,
    private readonly forgejo: ForgejoClient,
  ) {}

  // listForOwner — page-driven query. listAll is the admin variant.
  async listAll(): Promise<Repo[]> {
    const { rows } = await authPool.query<Row>(
      `SELECT ${ROW_COLUMNS} FROM "repo" ORDER BY created_at DESC`,
    )
    return rows.map((r) => this.toRepo(r))
  }

  async listForOwner(ownerId: string): Promise<Repo[]> {
    const slugs = await this.fga.listAccessibleRepos(ownerId)
    if (slugs.length === 0) return []
    const { rows } = await authPool.query<Row>(
      `SELECT ${ROW_COLUMNS}
         FROM "repo"
        WHERE slug = ANY($1::text[])
        ORDER BY created_at DESC`,
      [slugs],
    )
    return rows.map((r) => this.toRepo(r))
  }

  async get(ownerId: string, slug: string): Promise<Repo> {
    if (!(await this.fga.canAccessRepo(ownerId, slug))) {
      throw new NotFoundException(`repo ${slug} not found`)
    }
    const { rows } = await authPool.query<Row>(
      `SELECT ${ROW_COLUMNS} FROM "repo" WHERE slug = $1`,
      [slug],
    )
    const row = rows[0]
    if (!row) throw new NotFoundException(`repo ${slug} not found`)
    return this.toRepo(row)
  }

  private toRepo(row: Row): Repo {
    const slug = row.slug
    const cloneUrl = this.forgejo.repoCloneUrl(slug)
    return {
      id: slug,
      slug,
      name: row.name,
      owner: row.owner_id,
      source: row.source as RepoSource,
      forgejoUrl: this.forgejo.repoWebUrl(slug),
      cloneUrl,
      createdAt: row.created_at.toISOString(),
    }
  }
}

// Best-effort sanitiser shared with create+import. Forgejo accepts a
// fairly permissive name set but we lock it down to the slug shape we
// already use elsewhere (lowercase letters/digits/hyphens) for DNS-
// safety in case repos start backing per-repo Knative/HTTP surfaces
// later.
export function sanitizeRepoName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
}
