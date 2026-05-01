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
import { getTemplate } from "./templates"

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
    //
    // visibility mirrors to Forgejo's `private` flag: prod wants real
    // privacy; dev keeps it relaxed but the toggle still flows through
    // so we don't bake "always public" into the codepath.
    if (this.forgejo.enabled) {
      const tpl = getTemplate(input.runtime)
      // Single API call replaces the per-file seed loop. Forgejo's
      // generate-from-template fork copies the entire template repo
      // contents into the new repo as one initial commit.
      await this.forgejo.generateFromTemplate({
        templateOwner: this.forgejo.functionOrg,
        templateRepo: tpl.repoName,
        targetOwner: this.forgejo.functionOrg,
        targetName: slug,
        description: name,
        private: !isPublic,
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
    // Mirror to Forgejo so the asymmetry doesn't survive into prod.
    if (this.forgejo.enabled) {
      await this.forgejo
        .setRepoVisibility(this.forgejo.functionOrg, slug, !isPublic)
        .catch((err) => this.log.warn(`Forgejo visibility ${slug}: ${err}`))
    }
    return { public: isPublic }
  }

  // ---- handler files (Monaco editor) -------------------------------------
  // Console UI only exposes the user folder (e.g. `function/`). Anything
  // outside — runner main.py, Dockerfile, workflow — is platform-managed
  // and only edited by power users via git.

  async getFiles(
    ownerId: string,
    slug: string,
  ): Promise<{
    folder: string
    language: string
    defaultFile: string
    files: { path: string; content: string }[]
  }> {
    if (!(await this.fga.canAccessFunction(ownerId, slug))) {
      throw new NotFoundException(`function ${slug} not found`)
    }
    if (!this.forgejo.enabled) {
      throw new NotFoundException("Forgejo client is not configured")
    }
    const { rows } = await authPool.query<Pick<Row, "runtime">>(
      `SELECT runtime FROM "function" WHERE slug = $1`,
      [slug],
    )
    const row = rows[0]
    if (!row) throw new NotFoundException(`function ${slug} not found`)
    const tpl = getTemplate(row.runtime as FunctionRuntime)

    // Walk the userFolder one level (Forgejo's content API is
    // single-level). Phase-2 doesn't allow nested directories under
    // the user folder via console — power users can still nest via
    // git, but they won't surface in the editor.
    const entries = await this.forgejo.listDirectory({
      org: this.forgejo.functionOrg,
      repo: slug,
      path: tpl.userFolder,
    })
    const fileEntries = entries.filter((e) => e.type === "file")

    const files = await Promise.all(
      fileEntries.map(async (e) => {
        const f = await this.forgejo.getFileContent({
          org: this.forgejo.functionOrg,
          repo: slug,
          path: e.path,
        })
        return { path: e.path, content: f?.content ?? "" }
      }),
    )

    // Stable ordering: defaultFile first, rest alphabetical. Editor
    // opens onto defaultFile when it's present, falls back to the
    // first file otherwise.
    files.sort((a, b) => {
      if (a.path === tpl.defaultFile) return -1
      if (b.path === tpl.defaultFile) return 1
      return a.path.localeCompare(b.path)
    })

    return {
      folder: tpl.userFolder,
      language: tpl.language,
      defaultFile: tpl.defaultFile,
      files,
    }
  }

  async updateFiles(
    ownerId: string,
    slug: string,
    files: { path: string; content: string }[],
    message?: string,
  ): Promise<{ commitMessage: string }> {
    const owners = await this.fga.listFunctionOwners(slug)
    if (!owners.includes(ownerId)) {
      throw new NotFoundException(`function ${slug} not found`)
    }
    if (!this.forgejo.enabled) {
      throw new BadRequestException("Forgejo client is not configured")
    }
    const { rows } = await authPool.query<Pick<Row, "runtime">>(
      `SELECT runtime FROM "function" WHERE slug = $1`,
      [slug],
    )
    const row = rows[0]
    if (!row) throw new NotFoundException(`function ${slug} not found`)
    const tpl = getTemplate(row.runtime as FunctionRuntime)

    // Reject paths that escape the userFolder — Phase-2 keeps the
    // platform layer (runner / Dockerfile / workflow) un-editable
    // through the API. Power users can still touch those via git.
    for (const f of files) {
      if (!f.path.startsWith(tpl.userFolder + "/")) {
        throw new BadRequestException(
          `path ${f.path} is outside the editable folder ${tpl.userFolder}/`,
        )
      }
    }

    const commitMessage = (message?.trim() || `deploy: edit ${tpl.userFolder}/`).slice(
      0,
      200,
    )

    // One commit per file because the contents API is per-file. Cheap
    // enough for the small folders we expect in Phase 2; revisit with
    // git/trees batch if function repos grow.
    for (const f of files) {
      await this.forgejo.writeFile({
        org: this.forgejo.functionOrg,
        repo: slug,
        path: f.path,
        content: f.content,
        message: commitMessage,
      })
    }
    await authPool.query(
      `UPDATE "function" SET updated_at = now() WHERE slug = $1`,
      [slug],
    )
    return { commitMessage }
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
