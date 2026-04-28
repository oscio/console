import { Injectable } from "@nestjs/common"
import { authPool } from "@workspace/auth"
import { PLATFORM_ADMIN_GROUP } from "../auth/admin.guard"
import { OpenFgaService } from "../openfga/openfga.service"

export type AccountRow = {
  id: string
  email: string
  name: string
  image: string | null
  groups: string[]
  createdAt: string
  // Keycloak-sourced. Cannot be granted in-app.
  isPlatformAdmin: boolean
  // FGA-sourced. Granted/revoked by platform-admins via /role-bindings.
  isConsoleAdmin: boolean
}

@Injectable()
export class AccountsService {
  constructor(private readonly fga: OpenFgaService) {}

  // Returns true if the user existed and was deleted, false if no row
  // matched. Wrapped in a transaction so a partial delete (e.g. session
  // wiped but user row not removed) isn't possible. better-auth's
  // CASCADEs would handle session/account too, but we delete explicitly
  // to keep this independent of schema-level FK behaviour.
  async deleteById(userId: string): Promise<boolean> {
    const client = await authPool.connect()
    try {
      await client.query("BEGIN")
      await client.query(`DELETE FROM "session" WHERE "userId" = $1`, [userId])
      await client.query(`DELETE FROM "account" WHERE "userId" = $1`, [userId])
      const res = await client.query(`DELETE FROM "user" WHERE id = $1`, [
        userId,
      ])
      await client.query("COMMIT")
      return (res.rowCount ?? 0) > 0
    } catch (err) {
      await client.query("ROLLBACK")
      throw err
    } finally {
      client.release()
    }
  }

  async listAll(): Promise<AccountRow[]> {
    const [{ rows }, consoleAdminIds] = await Promise.all([
      authPool.query<{
        id: string
        email: string
        name: string
        image: string | null
        groups: string[]
        createdAt: string
      }>(
        `SELECT id, email, name, image, groups, "createdAt"
           FROM "user"
           ORDER BY "createdAt" DESC`,
      ),
      this.fga.listConsoleAdmins(),
    ])
    const consoleAdmins = new Set(consoleAdminIds)
    return rows.map((r) => ({
      ...r,
      isPlatformAdmin: r.groups.includes(PLATFORM_ADMIN_GROUP),
      isConsoleAdmin: consoleAdmins.has(r.id),
    }))
  }
}
