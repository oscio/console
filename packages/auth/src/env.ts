// Read env on demand. Throwing at import time breaks Next.js's
// build-time data-collection pass, which evaluates server modules
// without a populated environment. Real misconfiguration surfaces on
// first request via better-auth's own checks (DB connect, OIDC discovery).

function get(name: string, fallback = ""): string {
  return process.env[name] ?? fallback
}

export const env = {
  get databaseUrl() {
    return get("DATABASE_URL")
  },
  get betterAuthSecret() {
    return get("BETTER_AUTH_SECRET", "build-placeholder-secret")
  },
  get betterAuthUrl() {
    return get("BETTER_AUTH_URL", "http://localhost:3000")
  },
  get keycloakIssuerUrl() {
    return get("KEYCLOAK_ISSUER_URL")
  },
  get keycloakClientId() {
    return get("KEYCLOAK_CLIENT_ID", "console")
  },
  get keycloakClientSecret() {
    return get("KEYCLOAK_CLIENT_SECRET")
  },
}
