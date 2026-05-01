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
import {
  deleteFunctionCodeConfigMap,
  deleteKnativeService,
  ensureKnativeService,
  getRuntimeMode,
  invokeFunction,
  productionImageRef,
  setProductionImage,
  syncFunctionCodeConfigMap,
} from "./function-runtime"

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

      // Stand up the dev runtime alongside the repo: ConfigMap holds
      // the user folder content, Knative Service mounts it. The
      // editor's Test tab hits this service. Errors here don't block
      // create — Forgejo + DB row are already coherent and the
      // runtime can be retried via Deploy.
      await this.ensureRuntime(slug, input.runtime).catch((err) =>
        this.log.warn(
          `ensureRuntime ${slug}: ${(err as Error).message}`,
        ),
      )
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

    // Recursively walk the userFolder. Forgejo's contents API is
    // per-directory, so we BFS through subfolders that show up in
    // the listing. Cap depth at 8 levels — deep enough for normal
    // use, shallow enough that a misconfigured repo can't pin the
    // worker.
    const fileEntries: { path: string }[] = []
    const queue: string[] = [tpl.userFolder]
    let visited = 0
    while (queue.length > 0 && visited < 256) {
      const dir = queue.shift()!
      visited++
      const entries = await this.forgejo.listDirectory({
        org: this.forgejo.functionOrg,
        repo: slug,
        path: dir,
      })
      for (const e of entries) {
        if (e.type === "file") fileEntries.push({ path: e.path })
        else if (e.type === "dir") queue.push(e.path)
      }
    }

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
    input: {
      files?: { path: string; content: string }[]
      deletes?: string[]
      message?: string
    },
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

    const writes = input.files ?? []
    const deletes = input.deletes ?? []
    // No-op Deploy still re-runs ensureRuntime — useful for backfilling
    // functions that pre-date the dev-runtime code or recovering from a
    // missing Knative Service. The Forgejo round-trip is skipped when
    // there's nothing to commit.

    // Reject paths that escape the userFolder — Phase-2 keeps the
    // platform layer (runner / Dockerfile / workflow) un-editable
    // through the API. Power users can still touch those via git.
    const inUserFolder = (p: string) => p.startsWith(tpl.userFolder + "/")
    for (const f of writes) {
      if (!inUserFolder(f.path)) {
        throw new BadRequestException(
          `path ${f.path} is outside the editable folder ${tpl.userFolder}/`,
        )
      }
    }
    for (const p of deletes) {
      if (!inUserFolder(p)) {
        throw new BadRequestException(
          `path ${p} is outside the editable folder ${tpl.userFolder}/`,
        )
      }
    }

    const commitMessage = (
      input.message?.trim() || `deploy: edit ${tpl.userFolder}/`
    ).slice(0, 200)

    // One commit per op because the contents API is per-file. Cheap
    // enough for the small folders we expect in Phase 2; revisit with
    // git/trees batch if function repos grow.
    for (const f of writes) {
      await this.forgejo.writeFile({
        org: this.forgejo.functionOrg,
        repo: slug,
        path: f.path,
        content: f.content,
        message: commitMessage,
      })
    }
    for (const p of deletes) {
      await this.forgejo.deleteFile({
        org: this.forgejo.functionOrg,
        repo: slug,
        path: p,
        message: commitMessage,
      })
    }
    await authPool.query(
      `UPDATE "function" SET updated_at = now() WHERE slug = $1`,
      [slug],
    )
    // Re-sync the dev runtime so the running pod picks up the edit.
    // Best-effort — the repo + commit are already saved, so a sync
    // failure is recoverable on the next Deploy.
    await this.ensureRuntime(slug, row.runtime as FunctionRuntime).catch(
      (err) =>
        this.log.warn(`ensureRuntime ${slug}: ${(err as Error).message}`),
    )
    return { commitMessage }
  }

  // Proxy a Test-tab request to the function's dev Knative Service.
  // canAccessFunction (not just owner) so a public function can be
  // exercised by anyone signed in.
  //
  // Self-heal: a 404 from Kourier means there's no Knative Service
  // registered for this Host, which usually means the function was
  // created before the dev-runtime code shipped. Try ensureRuntime
  // and retry once before surfacing the 404 to the caller.
  async invoke(
    ownerId: string,
    slug: string,
    request: {
      method: string
      path: string
      headers?: Record<string, string>
      body?: string
    },
  ): Promise<{
    status: number
    headers: Record<string, string>
    body: string
  }> {
    if (!(await this.fga.canAccessFunction(ownerId, slug))) {
      throw new NotFoundException(`function ${slug} not found`)
    }
    const first = await invokeFunction(slug, request)
    if (first.status !== 404 || first.body) return first
    // 404 with empty body matches Kourier's no-such-host signature —
    // try to materialise the runtime and retry. If the function is
    // genuinely returning a 404 of its own, we'd see a non-empty body.
    try {
      const owners = await this.fga.listFunctionOwners(slug)
      if (owners.length === 0) return first
      const { rows } = await authPool.query<Pick<Row, "runtime">>(
        `SELECT runtime FROM "function" WHERE slug = $1`,
        [slug],
      )
      const row = rows[0]
      if (!row) return first
      await this.ensureRuntime(slug, row.runtime as FunctionRuntime)
    } catch (err) {
      this.log.warn(`invoke self-heal ${slug}: ${(err as Error).message}`)
      return first
    }
    // Knative Services take a moment to register routes after create.
    // Brief delay before retry; if still 404 it isn't going to be
    // healed by another retry, just return what Kourier said.
    await new Promise((r) => setTimeout(r, 1500))
    return invokeFunction(slug, request)
  }

  // Deploy flow: swap the Knative Service to a function-specific
  // built image (one Revision per commit SHA). Different from Save
  // (= ensureRuntime) which just refreshes the dev-image ConfigMap
  // mount. Caller is the function owner; we surface 404 to viewers.
  async deployToProduction(
    ownerId: string,
    slug: string,
  ): Promise<{ image: string; sha: string }> {
    const owners = await this.fga.listFunctionOwners(slug)
    if (!owners.includes(ownerId)) {
      throw new NotFoundException(`function ${slug} not found`)
    }
    if (!this.forgejo.enabled) {
      throw new BadRequestException("Forgejo client is not configured")
    }

    // Pin to the head commit on main. The Forgejo Actions build runs
    // on every push and tags the image with the commit SHA, so this
    // gives us a stable Revision-per-commit story.
    const sha = await this.forgejo.getBranchHead({
      org: this.forgejo.functionOrg,
      repo: slug,
      branch: "main",
    })
    if (!sha) {
      throw new BadRequestException(
        `function ${slug} has no main branch — Save first`,
      )
    }
    const image = productionImageRef(slug, sha)
    await setProductionImage(slug, image)
    return { image, sha }
  }

  // Read current runtime mode (dev / prod) + image ref. Used by the
  // detail page and Editor's Deploy button to label state.
  async getRuntime(
    ownerId: string,
    slug: string,
  ): Promise<{ mode: "dev" | "prod" | "unknown"; image: string | null }> {
    if (!(await this.fga.canAccessFunction(ownerId, slug))) {
      throw new NotFoundException(`function ${slug} not found`)
    }
    return getRuntimeMode(slug)
  }

  // Pull the current function/* files from Forgejo and re-publish them
  // as a ConfigMap, then bump the Knative Service template so a new
  // Revision rolls. Idempotent (safe to call repeatedly).
  private async ensureRuntime(
    slug: string,
    runtime: FunctionRuntime,
  ): Promise<void> {
    const tpl = getTemplate(runtime)
    if (!this.forgejo.enabled) return

    // Re-fetch from Forgejo so the ConfigMap matches what's actually
    // committed (rather than relying on the caller to pass files).
    const fileEntries: { path: string; content: string }[] = []
    const queue: string[] = [tpl.userFolder]
    let visited = 0
    while (queue.length > 0 && visited < 256) {
      const dir = queue.shift()!
      visited++
      const entries = await this.forgejo.listDirectory({
        org: this.forgejo.functionOrg,
        repo: slug,
        path: dir,
      })
      for (const e of entries) {
        if (e.type === "file") {
          const f = await this.forgejo.getFileContent({
            org: this.forgejo.functionOrg,
            repo: slug,
            path: e.path,
          })
          if (f) fileEntries.push({ path: e.path, content: f.content })
        } else if (e.type === "dir") {
          queue.push(e.path)
        }
      }
    }
    await syncFunctionCodeConfigMap(slug, fileEntries, tpl.userFolder)
    await ensureKnativeService(slug)
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
    // Tear down the dev runtime — both ConfigMap and Knative Service.
    await deleteKnativeService(slug)
    await deleteFunctionCodeConfigMap(slug)
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
