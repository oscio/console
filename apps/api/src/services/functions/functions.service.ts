import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { randomBytes } from "node:crypto"
import { authPool } from "@workspace/auth"
import { OpenFgaService } from "../../openfga/openfga.service"
import {
  CreateFunctionInput,
  FUNCTION_RUNTIMES,
  Func,
  FunctionRuntime,
} from "./functions.types"

// `fn-` prefix to keep slugs distinguishable from agents/vms in mixed
// log lines and to leave room for runtime-specific suffixes later
// (e.g. `fn-<slug>-rev-1`). 8 hex chars matches sibling resources.
function randomSlug(): string {
  return `fn-${randomBytes(4).toString("hex")}`
}

type Row = {
  slug: string
  owner_id: string
  name: string
  runtime: string
  created_at: Date
}

function toFunc(row: Row): Func {
  return {
    id: row.slug,
    slug: row.slug,
    name: row.name,
    owner: row.owner_id,
    runtime: row.runtime as FunctionRuntime,
    status: "Draft",
    createdAt: row.created_at.toISOString(),
  }
}

@Injectable()
export class FunctionsService {
  constructor(private readonly fga: OpenFgaService) {}

  // Admin-only path: dump every row. Sibling listAll on agents/vms is
  // a k8s scan; here it's just SELECT * because Postgres is the only
  // source of truth in Phase 1.
  async listAll(): Promise<Func[]> {
    const { rows } = await authPool.query<Row>(
      `SELECT slug, owner_id, name, runtime, created_at
         FROM "function"
        ORDER BY created_at DESC`,
    )
    return rows.map(toFunc)
  }

  async listForOwner(ownerId: string): Promise<Func[]> {
    // Mirrors VMs/agents: ask FGA which slugs the user can_access,
    // then read those rows. Avoids a `WHERE owner_id = $1` scan that
    // would silently drift if we ever add shared functions (editor
    // role on the model, etc.).
    const slugs = await this.fga.listAccessibleFunctions(ownerId)
    if (slugs.length === 0) return []
    const { rows } = await authPool.query<Row>(
      `SELECT slug, owner_id, name, runtime, created_at
         FROM "function"
        WHERE slug = ANY($1::text[])
        ORDER BY created_at DESC`,
      [slugs],
    )
    return rows.map(toFunc)
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
    return toFunc(row)
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

    // Grant FGA tuple before the DB insert. If the insert fails we'll
    // have a dangling tuple — but the alternative (dangling row, no
    // tuple) is worse because the user can't see it to delete. The
    // tuple alone is harmless because /functions list reads the row,
    // not the tuple.
    await this.fga.grantFunctionOwner(slug, ownerId)

    try {
      const { rows } = await authPool.query<Row>(
        `INSERT INTO "function" (slug, owner_id, name, runtime)
         VALUES ($1, $2, $3, $4)
         RETURNING slug, owner_id, name, runtime, created_at`,
        [slug, ownerId, name, input.runtime],
      )
      return toFunc(rows[0]!)
    } catch (err) {
      await this.fga.revokeFunctionOwner(slug, ownerId).catch(() => {})
      throw err
    }
  }

  async rename(ownerId: string, slug: string, newName: string): Promise<void> {
    const name = newName.trim()
    if (!name) throw new BadRequestException("name is required")
    if (name.length > 200) {
      throw new BadRequestException("name must be 200 characters or fewer")
    }
    if (!(await this.fga.canAccessFunction(ownerId, slug))) {
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

  async delete(ownerId: string, slug: string): Promise<void> {
    if (!(await this.fga.canAccessFunction(ownerId, slug))) {
      throw new NotFoundException(`function ${slug} not found`)
    }
    await authPool.query(`DELETE FROM "function" WHERE slug = $1`, [slug])
    // Best-effort tuple cleanup. Any other owner (group sharing,
    // editor role) would be torn down here once those exist; for now
    // there's only the single owner relation.
    const owners = await this.fga.listFunctionOwners(slug)
    for (const uid of owners) {
      await this.fga.revokeFunctionOwner(slug, uid).catch(() => {})
    }
  }
}
