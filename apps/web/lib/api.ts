// Server-side calls (RSC) hit the api on the docker-compose network via
// API_URL_INTERNAL. Outside compose the var is unset and we fall back to
// the public URL.
const API_URL =
  process.env.API_URL_INTERNAL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:3001"

export type Account = {
  id: string
  email: string
  name: string | null
  image: string | null
  groups: string[]
  // Keycloak-sourced (the `platform-admin` group claim). Never grantable
  // in-app — Keycloak owns this role.
  isPlatformAdmin: boolean
  // OpenFGA-sourced (`platform#console_admin` tuple). Granted/revoked by
  // platform-admins via /role-bindings.
  isConsoleAdmin: boolean
}

export type AccountListEntry = Account & { createdAt: string }

export async function fetchMe(cookieHeader: string): Promise<Account | null> {
  const res = await fetch(`${API_URL}/accounts/me`, {
    headers: { cookie: cookieHeader },
    cache: "no-store",
  })
  if (res.status === 401) return null
  if (!res.ok) {
    throw new Error(`accounts/me failed: ${res.status}`)
  }
  return (await res.json()) as Account
}

// Returns null when the caller can't view the user list (401/403),
// so callers can gate UI on a single nullable result.
export async function fetchAccounts(
  cookieHeader: string,
): Promise<AccountListEntry[] | null> {
  const res = await fetch(`${API_URL}/accounts`, {
    headers: { cookie: cookieHeader },
    cache: "no-store",
  })
  if (res.status === 401 || res.status === 403) return null
  if (!res.ok) {
    throw new Error(`accounts failed: ${res.status}`)
  }
  return (await res.json()) as AccountListEntry[]
}

// Hard-delete a user account. Platform-admin only on the api side.
export async function deleteAccount(
  cookieHeader: string,
  userId: string,
): Promise<void> {
  const res = await fetch(`${API_URL}/accounts/${userId}`, {
    method: "DELETE",
    headers: { cookie: cookieHeader },
    cache: "no-store",
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`accounts delete failed: ${res.status} ${text}`)
  }
}

// Grant/revoke the `console-admin` role on a user. Platform-admin only on
// the api side; this client just forwards the cookie.
export async function setConsoleAdminRole(
  cookieHeader: string,
  userId: string,
  grant: boolean,
): Promise<void> {
  const res = await fetch(`${API_URL}/role-bindings/console-admin/${userId}`, {
    method: grant ? "PUT" : "DELETE",
    headers: { cookie: cookieHeader },
    cache: "no-store",
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(
      `role-bindings ${grant ? "grant" : "revoke"} failed: ${res.status} ${text}`,
    )
  }
}
