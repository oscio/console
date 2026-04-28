import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto"
import http from "node:http"

const host = "0.0.0.0"
const port = Number(process.env.PORT ?? 4010)
const issuer = process.env.MOCK_IDP_ISSUER ?? "http://mock-idp.localhost:4010"
const defaultRedirectUris = [
  "http://localhost:3000/api/auth/oauth2/callback/keycloak",
]
const redirectUris = new Set(
  (process.env.MOCK_IDP_REDIRECT_URIS ?? defaultRedirectUris.join(","))
    .split(",")
    .map((uri) => uri.trim())
    .filter(Boolean)
)

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
})
const keyId = createHash("sha256")
  .update(publicKey.export({ type: "spki", format: "der" }))
  .digest("base64url")
  .slice(0, 16)
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: keyId,
  alg: "RS256",
  use: "sig",
}

const users = new Map()
const codes = new Map()
const accessTokens = new Map()

seedUser({
  username: "admin",
  name: "Admin User",
  email: "admin@example.com",
  groups: ["platform-admin"],
})

function seedUser(input) {
  const id = randomUUID()
  users.set(id, {
    sub: id,
    username: input.username,
    name: input.name,
    email: input.email,
    groups: input.groups,
  })
}

function discovery() {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    userinfo_endpoint: `${issuer}/userinfo`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid", "profile", "email", "groups"],
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
      "none",
    ],
    claims_supported: [
      "sub",
      "name",
      "preferred_username",
      "email",
      "email_verified",
      "groups",
    ],
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  })
  res.end(body)
}

function sendHtml(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  })
  res.end(body)
}

function sendText(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ""
    req.on("data", (chunk) => {
      body += chunk
      if (body.length > 1024 * 1024) {
        req.destroy()
        reject(new Error("Request body too large"))
      }
    })
    req.on("end", () => resolve(body))
    req.on("error", reject)
  })
}

function parseForm(body) {
  return Object.fromEntries(new URLSearchParams(body))
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

function hiddenInputs(params) {
  return [
    "client_id",
    "redirect_uri",
    "response_type",
    "scope",
    "state",
    "nonce",
    "code_challenge",
    "code_challenge_method",
  ]
    .map(
      (name) =>
        `<input type="hidden" name="${name}" value="${escapeHtml(params.get(name) ?? "")}">`
    )
    .join("")
}

function authorizePage(params, error = "") {
  const userRows = [...users.values()]
    .map(
      (user) => `
        <form method="post" class="user">
          ${hiddenInputs(params)}
          <input type="hidden" name="action" value="login">
          <input type="hidden" name="sub" value="${escapeHtml(user.sub)}">
          <div>
            <strong>${escapeHtml(user.name)}</strong>
            <span>${escapeHtml(user.email)}</span>
            <small>${escapeHtml(user.groups.join(", "))}</small>
          </div>
          <button type="submit">Sign in</button>
        </form>
      `
    )
    .join("")

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mock OIDC</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7f9; color: #15171a; }
    main { width: min(760px, calc(100vw - 32px)); margin: 32px 0; }
    h1 { margin: 0 0 6px; font-size: 24px; line-height: 1.2; }
    p { margin: 0; color: #626a73; }
    section { margin-top: 18px; padding: 18px; border: 1px solid #d8dde3; border-radius: 8px; background: #fff; }
    .user { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 0; border-top: 1px solid #e7eaee; }
    .user:first-child { border-top: 0; padding-top: 0; }
    .user:last-child { padding-bottom: 0; }
    span, small { display: block; margin-top: 3px; color: #626a73; }
    small { font-size: 12px; }
    button { min-height: 36px; border: 1px solid #1f2937; border-radius: 6px; padding: 0 12px; background: #1f2937; color: #fff; font: inherit; cursor: pointer; white-space: nowrap; }
    input { box-sizing: border-box; width: 100%; min-height: 38px; border: 1px solid #c9d0d8; border-radius: 6px; padding: 8px 10px; font: inherit; }
    label { display: grid; gap: 6px; color: #30363d; font-size: 13px; }
    .grid { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .full { grid-column: 1 / -1; }
    .error { margin-top: 12px; color: #b42318; }
    @media (prefers-color-scheme: dark) {
      body { background: #111418; color: #f4f6f8; }
      section { background: #181c20; border-color: #30363d; }
      p, span, small, label { color: #aab2bd; }
      .user { border-color: #30363d; }
      input { background: #111418; color: #f4f6f8; border-color: #3a424c; }
      button { background: #f4f6f8; color: #111418; border-color: #f4f6f8; }
    }
  </style>
</head>
<body>
  <main>
    <h1>Mock OIDC Provider</h1>
    <p>Select an in-memory user or create one for this compose session.</p>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    <section>
      ${userRows}
    </section>
    <section>
      <form method="post" class="grid">
        ${hiddenInputs(params)}
        <input type="hidden" name="action" value="create">
        <label>Name<input name="name" value="Local User" required></label>
        <label>Username<input name="username" value="local-user" required></label>
        <label class="full">Email<input name="email" type="email" value="local@example.com" required></label>
        <label class="full">Groups, comma-separated<input name="groups" value="platform-admin"></label>
        <button type="submit" class="full">Create and sign in</button>
      </form>
    </section>
  </main>
</body>
</html>`
}

function validateAuthorize(params) {
  const clientId = params.get("client_id")
  const redirectUri = params.get("redirect_uri")
  const responseType = params.get("response_type")
  if (!clientId) return "Missing client_id"
  if (!redirectUri) return "Missing redirect_uri"
  if (!redirectUris.has(redirectUri))
    return `Unregistered redirect_uri: ${redirectUri}`
  if (responseType !== "code") return "Only response_type=code is supported"
  return ""
}

function issueCode(res, fields, user) {
  const redirectUri = fields.redirect_uri
  const state = fields.state
  const code = randomUUID()
  codes.set(code, {
    clientId: fields.client_id,
    redirectUri,
    scope: fields.scope ?? "openid profile email",
    nonce: fields.nonce,
    codeChallenge: fields.code_challenge,
    codeChallengeMethod: fields.code_challenge_method,
    user,
    createdAt: Date.now(),
  })

  const target = new URL(redirectUri)
  target.searchParams.set("code", code)
  if (state) target.searchParams.set("state", state)
  res.writeHead(302, { location: target.toString() })
  res.end()
}

function jwt(payload, lifetimeSeconds) {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: "RS256", typ: "JWT", kid: keyId }
  const body = {
    iss: issuer,
    iat: now,
    exp: now + lifetimeSeconds,
    ...payload,
  }
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString(
    "base64url"
  )
  const encodedBody = Buffer.from(JSON.stringify(body)).toString("base64url")
  const input = `${encodedHeader}.${encodedBody}`
  const signature = sign("RSA-SHA256", Buffer.from(input), privateKey).toString(
    "base64url"
  )
  return `${input}.${signature}`
}

function verifyPkce(entry, verifier) {
  if (!entry.codeChallenge) return true
  if (!verifier) return false
  if (entry.codeChallengeMethod === "S256") {
    return (
      createHash("sha256").update(verifier).digest("base64url") ===
      entry.codeChallenge
    )
  }
  return verifier === entry.codeChallenge
}

function parseBasicClient(req) {
  const header = req.headers.authorization
  if (!header?.startsWith("Basic ")) return {}
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString(
    "utf8"
  )
  const [clientId, clientSecret = ""] = decoded.split(":")
  return {
    client_id: decodeURIComponent(clientId ?? ""),
    client_secret: decodeURIComponent(clientSecret),
  }
}

function profile(user) {
  return {
    sub: user.sub,
    name: user.name,
    preferred_username: user.username,
    email: user.email,
    email_verified: true,
    groups: user.groups,
  }
}

async function handleAuthorize(req, res, url) {
  if (req.method === "GET") {
    const error = validateAuthorize(url.searchParams)
    sendHtml(res, error ? 400 : 200, authorizePage(url.searchParams, error))
    return
  }

  const fields = parseForm(await readBody(req))
  const params = new URLSearchParams(fields)
  const error = validateAuthorize(params)
  if (error) {
    sendHtml(res, 400, authorizePage(params, error))
    return
  }

  if (fields.action === "create") {
    const id = randomUUID()
    const user = {
      sub: id,
      username: fields.username.trim(),
      name: fields.name.trim(),
      email: fields.email.trim(),
      groups: fields.groups
        .split(",")
        .map((group) => group.trim())
        .filter(Boolean),
    }
    users.set(id, user)
    issueCode(res, fields, user)
    return
  }

  const user = users.get(fields.sub)
  if (!user) {
    sendHtml(res, 404, authorizePage(params, "Unknown user"))
    return
  }
  issueCode(res, fields, user)
}

async function handleToken(req, res) {
  const fields = {
    ...parseBasicClient(req),
    ...parseForm(await readBody(req)),
  }
  if (fields.grant_type !== "authorization_code") {
    sendJson(res, 400, { error: "unsupported_grant_type" })
    return
  }

  const entry = codes.get(fields.code)
  if (!entry) {
    sendJson(res, 400, { error: "invalid_grant" })
    return
  }
  codes.delete(fields.code)

  if (
    entry.clientId !== fields.client_id ||
    entry.redirectUri !== fields.redirect_uri
  ) {
    sendJson(res, 400, { error: "invalid_grant" })
    return
  }
  if (!verifyPkce(entry, fields.code_verifier)) {
    sendJson(res, 400, {
      error: "invalid_grant",
      error_description: "PKCE verification failed",
    })
    return
  }

  const userProfile = profile(entry.user)
  const accessToken = jwt(
    {
      aud: fields.client_id,
      scope: entry.scope,
      ...userProfile,
    },
    3600
  )
  const idToken = jwt(
    {
      aud: fields.client_id,
      nonce: entry.nonce || undefined,
      ...userProfile,
    },
    3600
  )
  accessTokens.set(accessToken, entry.user)
  sendJson(res, 200, {
    access_token: accessToken,
    id_token: idToken,
    token_type: "Bearer",
    expires_in: 3600,
    scope: entry.scope,
  })
}

function handleUserinfo(req, res) {
  const auth = req.headers.authorization ?? ""
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : ""
  const user = accessTokens.get(token)
  if (!user) {
    sendJson(res, 401, { error: "invalid_token" })
    return
  }
  sendJson(res, 200, profile(user))
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", issuer)
    if (req.method === "GET" && url.pathname === "/healthz") {
      sendText(res, 200, "ok")
      return
    }
    if (
      req.method === "GET" &&
      url.pathname === "/.well-known/openid-configuration"
    ) {
      sendJson(res, 200, discovery())
      return
    }
    if (req.method === "GET" && url.pathname === "/jwks") {
      sendJson(res, 200, { keys: [jwk] })
      return
    }
    if (url.pathname === "/authorize") {
      await handleAuthorize(req, res, url)
      return
    }
    if (req.method === "POST" && url.pathname === "/token") {
      await handleToken(req, res)
      return
    }
    if (req.method === "GET" && url.pathname === "/userinfo") {
      handleUserinfo(req, res)
      return
    }
    sendText(res, 404, "not found")
  } catch (error) {
    console.error(error)
    sendJson(res, 500, { error: "server_error" })
  }
})

server.listen(port, host, () => {
  console.log(`Mock OIDC provider listening at ${issuer}`)
})
