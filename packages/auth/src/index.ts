import { betterAuth } from "better-auth"
import { genericOAuth } from "better-auth/plugins"
import type { Auth } from "better-auth/types"
import { Pool } from "pg"
import { env } from "./env.js"

const pool = new Pool({ connectionString: env.databaseUrl })

// The inferred type names paths through zod internals in .pnpm and isn't
// portable across declaration emit. Erase via `unknown` and re-pin to the
// stable `Auth` surface the package exports — consumers use api.getSession
// and a handful of admin endpoints, all on the base type.
const _auth = betterAuth({
  baseURL: env.betterAuthUrl,
  secret: env.betterAuthSecret,
  database: pool,

  // Keycloak is the only IdP. Email/password sign-in stays off so users
  // can't bypass the platform realm.
  emailAndPassword: { enabled: false },

  // Auto-link OIDC accounts that arrive with an already-known email.
  // Keycloak owns identity, so trusting its `email_verified` is safe.
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["keycloak"],
    },
  },

  user: {
    additionalFields: {
      // Mirrored from the OIDC `groups` claim on every login. `input: false`
      // keeps it out of user-writable surfaces — only the IdP sets it.
      groups: {
        type: "string[]",
        input: false,
        defaultValue: [],
      },
    },
  },

  plugins: [
    genericOAuth({
      config: [
        {
          providerId: "keycloak",
          clientId: env.keycloakClientId,
          clientSecret: env.keycloakClientSecret,
          discoveryUrl: `${env.keycloakIssuerUrl}/.well-known/openid-configuration`,
          scopes: ["openid", "profile", "email", "groups"],
          mapProfileToUser: (profile: Record<string, unknown>) => ({
            email: String(profile.email ?? ""),
            name: String(profile.name ?? profile.preferred_username ?? ""),
            image:
              typeof profile.picture === "string" ? profile.picture : undefined,
            groups: Array.isArray(profile.groups)
              ? profile.groups.filter((g): g is string => typeof g === "string")
              : [],
          }),
        },
      ],
    }),
  ],
})

export const auth = _auth as unknown as Auth

type BaseSession = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>

// Re-pin the user shape to include our additionalFields. The erased `Auth`
// type has no knowledge of `groups`, so we add it explicitly here.
export type AppUser = BaseSession["user"] & { groups: string[] }
export type AppSession = Omit<BaseSession, "user"> & { user: AppUser }
export type Session = AppSession | null

// Exposed so the API can run authorized list queries against the same DB
// better-auth manages. Consumers should treat the schema as read-only.
export { pool as authPool }
