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

  // `request.url` on a server route resolves to the internal pod
  // origin (http://0.0.0.0:3000) which Keycloak rejects as an
  // invalid redirect_uri. Use the BETTER_AUTH_URL env (= the public
  // console hostname, already configured for OIDC) instead, with a
  // fallback to the X-Forwarded-* headers if it isn't set.
  const publicOrigin = resolvePublicOrigin(request)
  const postLogout = `${publicOrigin}/sign-in`
  const target = new URL(`${issuer}/protocol/openid-connect/logout`)
  target.searchParams.set("client_id", clientId)
  target.searchParams.set("post_logout_redirect_uri", postLogout)
  return NextResponse.redirect(target.toString())
}

function resolvePublicOrigin(request: Request): string {
  const fromEnv = process.env.BETTER_AUTH_URL
  if (fromEnv) return fromEnv.replace(/\/$/, "")
  const proto =
    request.headers.get("x-forwarded-proto") ?? "https"
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    new URL(request.url).host
  return `${proto}://${host}`
}
