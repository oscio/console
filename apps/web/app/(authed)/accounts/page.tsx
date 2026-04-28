import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
} from "@workspace/ui/components/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import {
  deleteAccount,
  fetchAccounts,
  fetchMe,
  setConsoleAdminRole,
} from "@/lib/api"
import { DeleteUserButton } from "@/components/delete-user-button"

async function toggleConsoleAdmin(formData: FormData) {
  "use server"
  const userId = String(formData.get("userId") ?? "")
  const grant = formData.get("grant") === "true"
  if (!userId) return
  const cookieHeader = (await headers()).get("cookie") ?? ""
  await setConsoleAdminRole(cookieHeader, userId, grant)
  revalidatePath("/accounts")
}

async function deleteUser(formData: FormData) {
  "use server"
  const userId = String(formData.get("userId") ?? "")
  if (!userId) return
  const cookieHeader = (await headers()).get("cookie") ?? ""
  await deleteAccount(cookieHeader, userId)
  revalidatePath("/accounts")
}

export default async function AccountsPage() {
  const cookieHeader = (await headers()).get("cookie") ?? ""
  const me = await fetchMe(cookieHeader)
  // Either role lets you see the user list; only platform-admins can
  // mutate role bindings.
  const canSeeUsers = (me?.isPlatformAdmin || me?.isConsoleAdmin) ?? false
  const canManageRoles = me?.isPlatformAdmin ?? false
  const users = canSeeUsers ? await fetchAccounts(cookieHeader) : null

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Accounts</h1>
        <p className="text-muted-foreground text-sm">
          Your profile, served by the accounts API.
        </p>
      </div>

      {me ? (
        <Card>
          <CardContent>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-muted-foreground">ID</dt>
              <dd className="font-mono">{me.id}</dd>
              <dt className="text-muted-foreground">Email</dt>
              <dd>{me.email}</dd>
              <dt className="text-muted-foreground">Name</dt>
              <dd>{me.name ?? "—"}</dd>
              <dt className="text-muted-foreground">Roles</dt>
              <dd className="flex flex-wrap gap-1">
                {me.isPlatformAdmin && <Badge>platform-admin</Badge>}
                {me.isConsoleAdmin && <Badge variant="secondary">console-admin</Badge>}
                {!me.isPlatformAdmin && !me.isConsoleAdmin && (
                  <span className="text-muted-foreground text-xs">none</span>
                )}
              </dd>
            </dl>
          </CardContent>
        </Card>
      ) : (
        <p className="text-destructive text-sm">
          Not authenticated against the accounts API.
        </p>
      )}

      {users && (
        <section className="space-y-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold">Users</h2>
            <span className="text-muted-foreground text-xs">
              {users.length} total
            </span>
          </div>
          <div className="overflow-hidden border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Roles</TableHead>
                  {canManageRoles && (
                    <TableHead className="text-right">Actions</TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell>{u.name ?? "—"}</TableCell>
                    <TableCell>{u.email}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {u.isPlatformAdmin && <Badge>platform-admin</Badge>}
                        {u.isConsoleAdmin && (
                          <Badge variant="secondary">console-admin</Badge>
                        )}
                        {!u.isPlatformAdmin && !u.isConsoleAdmin && (
                          <span className="text-muted-foreground text-xs">
                            —
                          </span>
                        )}
                      </div>
                    </TableCell>
                    {canManageRoles && (
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          {u.isPlatformAdmin ? (
                            <span
                              title="platform-admin is managed in Keycloak"
                              className="text-muted-foreground text-xs"
                            >
                              keycloak-managed
                            </span>
                          ) : (
                            <form action={toggleConsoleAdmin}>
                              <input type="hidden" name="userId" value={u.id} />
                              <input
                                type="hidden"
                                name="grant"
                                value={u.isConsoleAdmin ? "false" : "true"}
                              />
                              <Button type="submit" variant="outline" size="sm">
                                {u.isConsoleAdmin
                                  ? "Revoke console-admin"
                                  : "Grant console-admin"}
                              </Button>
                            </form>
                          )}
                          {u.id !== me?.id && (
                            <DeleteUserButton
                              action={deleteUser}
                              userId={u.id}
                              label={u.name ?? u.email}
                            />
                          )}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
                {users.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={canManageRoles ? 4 : 3}
                      className="text-muted-foreground py-6 text-center"
                    >
                      No users yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </section>
      )}
    </div>
  )
}
