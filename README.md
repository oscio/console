# console

AWS-console-style monorepo for the Agent Platform.

```
apps/
  web/          Next.js 16 (App Router, React 19) — UI shell + sidebar
  api/          NestJS 11 — REST API (currently: /accounts/me)
  mock-idp/     Dependency-free in-memory OIDC provider for compose dev
packages/
  auth/         Shared better-auth instance (Keycloak via genericOAuth, pg)
  ui/           shadcn/ui components (re-exported as @workspace/ui)
  eslint-config, typescript-config
```

## Architecture

- **`apps/web`** mounts better-auth at `/api/auth/[...all]`. Sign-in
  redirects to Keycloak (the platform realm), the callback comes back
  to better-auth, the session cookie is set on `BETTER_AUTH_URL`.
- **`apps/api`** imports the same `@workspace/auth` instance and uses an
  `AuthGuard` that calls `auth.api.getSession({ headers })` against the
  same Postgres — no JWT validation, no second IdP roundtrip.
- **Postgres** holds better-auth's `user` / `session` / `account` /
  `verification` tables. Local dev uses `docker-compose.yml` at the
  repo root; in-cluster uses the platform Postgres.
- **Keycloak** is the production IdP. Email/password sign-in is disabled
  in better-auth so users can't bypass the platform realm. Docker Compose
  swaps in `apps/mock-idp` via the same OIDC provider id and callback path.

## Local dev

The whole stack runs under one docker-compose profile. **No `pnpm dev`** —
that path was retired so the dev runtime matches what gets shipped.

```sh
# 1. Env. The monorepo root .env is the single source of truth, mounted
#    into every container via env_file.
cp .env.example .env
# edit .env — generate BETTER_AUTH_SECRET via `openssl rand -base64 32`.
# Compose overrides the Keycloak env to the local mock IdP.

# 2. Bring up mock OIDC + Postgres + auth-watcher + api + web together.
docker compose --profile dev up        # add --build on first run
```

The five services in the `dev` profile:

| Service    | Container          | Port (host) | Command                         |
| ---------- | ------------------ | ----------- | ------------------------------- |
| `mock-idp` | `console-mock-idp` | `:4010`     | in-memory OIDC provider         |
| `postgres` | `console-postgres` | `:5433`     | postgres:16.4-alpine            |
| `auth`     | `console-auth`     | —           | `tsup --watch` on packages/auth |
| `api`      | `console-api`      | `:3001`     | `nest start --watch`            |
| `web`      | `console-web`      | `:3000`     | `next dev --turbopack`          |

The repo is bind-mounted into each container at `/app`; per-package
`node_modules` are anonymous volumes so host (macOS) binaries don't
leak into the linux containers. Edits on the host hot-reload inside
the containers.

### One-time: better-auth migration

After the first compose up (postgres healthy + auth dist built),
materialize the `user` / `session` / `account` / `verification` tables:

```sh
docker compose --profile dev exec auth pnpm auth:migrate
```

Re-run only when `packages/auth/src/index.ts` changes the schema.

### Using the app

Open `http://localhost:3000`. Unauthenticated visits redirect to
`/sign-in`, which kicks off the OIDC flow. In compose, the "Continue
with Keycloak" button redirects to the mock IdP at
`http://mock-idp.localhost:4010`, where you can select a seeded user or
create a new in-memory user for the current compose session. After login
you land on `/dashboard` with the left navbar (Dashboard, Accounts, VMs,
Settings). `/accounts` does a server-side fetch to `console-api` (over
the compose network at `http://api:3001`) to render the current user's
profile.

The mock IdP intentionally has no database. Restarting the service resets
users to the two seeded accounts. It still speaks normal OIDC
authorization-code flow: discovery, authorize, token, JWKS, userinfo, and
signed ID tokens.

### Common operations

```sh
docker compose --profile dev down              # stop everything
docker compose --profile dev down -v           # stop + drop the postgres volume
docker compose --profile dev logs -f web       # tail one service
docker compose --profile dev exec api sh       # shell into a container
```

## Keycloak client

The `console` confidential client is provisioned by
`infra/modules/keycloak-realm` (gated by `console_enabled = true` in
`infra/clusters/dev/terraform.tfvars`). Redirect URIs:

- `https://console.<domain>/api/auth/oauth2/callback/keycloak` (prod)
- `http://localhost:3000/api/auth/oauth2/callback/keycloak` (local dev)

After applying terraform, copy the `console` client secret out of
Keycloak (or from your tfvars) into `.env` as `KEYCLOAK_CLIENT_SECRET`.

## Adding a shadcn component

```sh
pnpm dlx shadcn@latest add <component> -c apps/web
```

Components land in `packages/ui/src/components/`. Import from
`@workspace/ui/components/<name>`.
