import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import { randomBytes } from "node:crypto"
import { authPool } from "@workspace/auth"
import { ForgejoClient } from "../../forgejo/forgejo.client"
import { OpenFgaService } from "../../openfga/openfga.service"
import {
  CreateFunctionInput,
  FUNCTION_RUNTIMES,
  Func,
  FunctionRuntime,
} from "./functions.types"

// `function-` prefix matches the Forgejo repo name: a function whose
// slug is `function-abcd1234` lives at `service/function-abcd1234`.
// Single identifier, single mental model.
function randomSlug(): string {
  return `function-${randomBytes(4).toString("hex")}`
}

type Row = {
  slug: string
  owner_id: string
  name: string
  runtime: string
  created_at: Date
}

@Injectable()
export class FunctionsService {
  private readonly log = new Logger(FunctionsService.name)
  constructor(
    private readonly fga: OpenFgaService,
    private readonly forgejo: ForgejoClient,
  ) {}

  // listAll — admin path. No FGA filter, no visibility check.
  async listAll(): Promise<Func[]> {
    const { rows } = await authPool.query<Row>(
      `SELECT slug, owner_id, name, runtime, created_at
         FROM "function"
        ORDER BY created_at DESC`,
    )
    return Promise.all(rows.map((r) => this.toFunc(r)))
  }

  async listForOwner(ownerId: string): Promise<Func[]> {
    // listObjects with `can_access` returns owned + public via the
    // viewer:[user, user:*] union — no DB-side visibility filter.
    const slugs = await this.fga.listAccessibleFunctions(ownerId)
    if (slugs.length === 0) return []
    const { rows } = await authPool.query<Row>(
      `SELECT slug, owner_id, name, runtime, created_at
         FROM "function"
        WHERE slug = ANY($1::text[])
        ORDER BY created_at DESC`,
      [slugs],
    )
    return Promise.all(rows.map((r) => this.toFunc(r)))
  }

  async get(ownerId: string, slug: string): Promise<Func> {
    if (!(await this.fga.canAccessFunction(ownerId, slug))) {
      throw new NotFoundException(`function ${slug} not found`)
    }
    const { rows } = await authPool.query<Row>(
      `SELECT slug, owner_id, name, runtime, created_at
         FROM "function"
        WHERE slug = $1`,
      [slug],
    )
    const row = rows[0]
    if (!row) throw new NotFoundException(`function ${slug} not found`)
    return this.toFunc(row)
  }

  async create(ownerId: string, input: CreateFunctionInput): Promise<Func> {
    const name = input.name.trim()
    if (!name) throw new BadRequestException("name is required")
    if (name.length > 200) {
      throw new BadRequestException("name must be 200 characters or fewer")
    }
    if (!FUNCTION_RUNTIMES.includes(input.runtime)) {
      throw new BadRequestException(
        `runtime must be one of: ${FUNCTION_RUNTIMES.join(", ")}`,
      )
    }
    const slug = randomSlug()
    const isPublic = !!input.public

    // 1. Forgejo repo first. If we created the FGA tuple/DB row first
    // and Forgejo failed, the user would see a function in the list
    // with no repo behind it. Failing on Forgejo upfront keeps state
    // coherent — DB+FGA never get ahead of the repo.
    if (this.forgejo.enabled) {
      await this.forgejo.ensureOrg(this.forgejo.functionOrg)
      await this.forgejo.createOrgRepo({
        org: this.forgejo.functionOrg,
        name: slug,
        description: name,
      })
    } else {
      this.log.warn(
        `Forgejo client not configured — creating function ${slug} without a repo`,
      )
    }

    // 2. FGA owner tuple. Must precede the row insert so any reader
    // that races us through listObjects either sees nothing (tuple
    // not yet written) or the full pair (tuple + row).
    try {
      await this.fga.grantFunctionOwner(slug, ownerId)
      if (isPublic) await this.fga.grantFunctionPublic(slug)
    } catch (err) {
      await this.cleanupOnCreateError(slug, ownerId)
      throw err
    }

    // 3. Postgres row. On failure we rewind FGA + Forgejo.
    try {
      const { rows } = await authPool.query<Row>(
        `INSERT INTO "function" (slug, owner_id, name, runtime)
         VALUES ($1, $2, $3, $4)
         RETURNING slug, owner_id, name, runtime, created_at`,
        [slug, ownerId, name, input.runtime],
      )
      return this.toFunc(rows[0]!, isPublic)
    } catch (err) {
      await this.cleanupOnCreateError(slug, ownerId)
      throw err
    }
  }

  async rename(ownerId: string, slug: string, newName: string): Promise<void> {
    const name = newName.trim()
    if (!name) throw new BadRequestException("name is required")
    if (name.length > 200) {
      throw new BadRequestException("name must be 200 characters or fewer")
    }
    // Owner-only — viewer permission isn't enough to rename.
    const owners = await this.fga.listFunctionOwners(slug)
    if (!owners.includes(ownerId)) {
      throw new NotFoundException(`function ${slug} not found`)
    }
    const result = await authPool.query(
      `UPDATE "function" SET name = $1, updated_at = now() WHERE slug = $2`,
      [name, slug],
    )
    if (result.rowCount === 0) {
      throw new NotFoundException(`function ${slug} not found`)
    }
  }

  async setVisibility(
    ownerId: string,
    slug: string,
    isPublic: boolean,
  ): Promise<{ public: boolean }> {
    const owners = await this.fga.listFunctionOwners(slug)
    if (!owners.includes(ownerId)) {
      throw new NotFoundException(`function ${slug} not found`)
    }
    const wasPublic = await this.fga.isFunctionPublic(slug)
    if (isPublic && !wasPublic) {
      await this.fga.grantFunctionPublic(slug)
    } else if (!isPublic && wasPublic) {
      await this.fga.revokeFunctionPublic(slug)
    }
    return { public: isPublic }
  }

  async delete(ownerId: string, slug: string): Promise<void> {
    const owners = await this.fga.listFunctionOwners(slug)
    if (!owners.includes(ownerId)) {
      throw new NotFoundException(`function ${slug} not found`)
    }
    await authPool.query(`DELETE FROM "function" WHERE slug = $1`, [slug])
    if (await this.fga.isFunctionPublic(slug)) {
      await this.fga.revokeFunctionPublic(slug).catch(() => {})
    }
    for (const uid of owners) {
      await this.fga.revokeFunctionOwner(slug, uid).catch(() => {})
    }
    if (this.forgejo.enabled) {
      await this.forgejo
        .deleteRepo(this.forgejo.functionOrg, slug)
        .catch((err) => this.log.error(`Forgejo delete ${slug}: ${err}`))
    }
  }

  // Inverse of create()'s side effects up to but not including the
  // failed step. Best-effort: errors during cleanup are logged, not
  // rethrown, because the caller already has a primary error.
  private async cleanupOnCreateError(
    slug: string,
    ownerId: string,
  ): Promise<void> {
    if (this.forgejo.enabled) {
      await this.forgejo
        .deleteRepo(this.forgejo.functionOrg, slug)
        .catch((err) =>
          this.log.warn(`cleanupOnCreateError repo ${slug}: ${err}`),
        )
    }
    await this.fga
      .revokeFunctionOwner(slug, ownerId)
      .catch((err) =>
        this.log.warn(`cleanupOnCreateError fga owner ${slug}: ${err}`),
      )
    if (await this.fga.isFunctionPublic(slug).catch(() => false)) {
      await this.fga
        .revokeFunctionPublic(slug)
        .catch((err) =>
          this.log.warn(`cleanupOnCreateError fga public ${slug}: ${err}`),
        )
    }
  }

  // Pre-fetched isPublic flag avoids a second FGA round-trip when the
  // caller already has it (e.g. right after a setVisibility).
  private async toFunc(row: Row, knownPublic?: boolean): Promise<Func> {
    const isPublic =
      knownPublic !== undefined
        ? knownPublic
        : await this.fga.isFunctionPublic(row.slug).catch(() => false)
    return {
      id: row.slug,
      slug: row.slug,
      name: row.name,
      owner: row.owner_id,
      runtime: row.runtime as FunctionRuntime,
      status: "Draft",
      public: isPublic,
      forgejoUrl: this.forgejo.repoWebUrl(row.slug),
      createdAt: row.created_at.toISOString(),
    }
  }
}
