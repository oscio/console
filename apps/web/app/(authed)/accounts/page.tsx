import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
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
        <dl className="bg-card text-card-foreground grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 rounded-md border p-4 text-sm">
          <dt className="text-muted-foreground">ID</dt>
          <dd className="font-mono">{me.id}</dd>
          <dt className="text-muted-foreground">Email</dt>
          <dd>{me.email}</dd>
          <dt className="text-muted-foreground">Name</dt>
          <dd>{me.name ?? "—"}</dd>
          <dt className="text-muted-foreground">Roles</dt>
          <dd className="flex flex-wrap gap-1">
            {me.isPlatformAdmin && <RoleBadge>platform-admin</RoleBadge>}
            {me.isConsoleAdmin && <RoleBadge>console-admin</RoleBadge>}
            {!me.isPlatformAdmin && !me.isConsoleAdmin && (
              <span className="text-muted-foreground text-xs">none</span>
            )}
          </dd>
        </dl>
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
          <div className="overflow-hidden rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr className="text-left">
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Email</th>
                  <th className="px-3 py-2 font-medium">Roles</th>
                  {canManageRoles && (
                    <th className="px-3 py-2 font-medium text-right">
                      Actions
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-t">
                    <td className="px-3 py-2">{u.name ?? "—"}</td>
                    <td className="px-3 py-2">{u.email}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {u.isPlatformAdmin && (
                          <RoleBadge>platform-admin</RoleBadge>
                        )}
                        {u.isConsoleAdmin && (
                          <RoleBadge>console-admin</RoleBadge>
                        )}
                        {!u.isPlatformAdmin && !u.isConsoleAdmin && (
                          <span className="text-muted-foreground text-xs">
                            —
                          </span>
                        )}
                      </div>
                    </td>
                    {canManageRoles && (
                      <td className="px-3 py-2">
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
                              <input
                                type="hidden"
                                name="userId"
                                value={u.id}
                              />
                              <input
                                type="hidden"
                                name="grant"
                                value={u.isConsoleAdmin ? "false" : "true"}
                              />
                              <button
                                type="submit"
                                className="hover:bg-muted rounded-md border px-2 py-1 text-xs"
                              >
                                {u.isConsoleAdmin
                                  ? "Revoke console-admin"
                                  : "Grant console-admin"}
                              </button>
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
                      </td>
                    )}
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr>
                    <td
                      colSpan={canManageRoles ? 4 : 3}
                      className="text-muted-foreground px-3 py-6 text-center"
                    >
                      No users yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}

function RoleBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium">
      {children}
    </span>
  )
}
