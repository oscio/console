import { NextResponse } from "next/server"

// RP-initiated logout. better-auth's signOut only clears the
// console's session cookie — it doesn't touch Keycloak, so the
// user could click "Continue with Keycloak" again and silently
// re-authenticate from Keycloak's still-active SSO session.
//
// Hit this route after the local signOut completes; it 302s to
// Keycloak's `end_session_endpoint` with a post-logout redirect
// back to /sign-in. Keycloak ends its session and bounces the user
// back, so the next sign-in actually goes through the full
// password / SSO flow.
//
// Issuer + client id come from server-side env vars (set on the
// console-web pod via the same ConfigMap the api uses). They're
// not secrets but we don't bother prefixing NEXT_PUBLIC_ since the
// route runs server-side anyway.
export async function GET(request: Request) {
  const issuer =
    process.env.KEYCLOAK_ISSUER_URL ??
    "https://auth.dev.openschema.io/realms/platform"
  const clientId = process.env.KEYCLOAK_CLIENT_ID ?? "console"
  const url = new URL(request.url)
  const postLogout = `${url.origin}/sign-in`
  const target = new URL(`${issuer}/protocol/openid-connect/logout`)
  target.searchParams.set("client_id", clientId)
  target.searchParams.set("post_logout_redirect_uri", postLogout)
  return NextResponse.redirect(target.toString())
}
