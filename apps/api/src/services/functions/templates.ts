// Per-runtime starter templates for new function repos.
//
// What lives here vs. what lives in the Forgejo repo:
//   * The user only ever edits the handler file (handler.py / index.js)
//     via the console's Monaco editor — that's the AWS-Lambda-style
//     inline UX.
//   * The Dockerfile + .forgejo/workflows/build.yml + the tiny HTTP
//     runner that adapts handler() to a real server are committed
//     once on repo init and intentionally hidden from the console UI.
//     Power users can clone the repo and edit them via Forgejo / git.
//
// `handlerPath` is the single-file the console exposes; everything
// else is fire-and-forget bootstrapping.

import { FunctionRuntime } from "./functions.types"

export type FunctionFile = {
  path: string
  content: string
}

export type FunctionTemplate = {
  handlerPath: string
  // Monaco language id (matches monaco-editor's `language` prop).
  language: string
  // Files committed on repo creation, including handler.
  initialFiles: FunctionFile[]
}

const PYTHON_HANDLER = `def handler(event, context):
    """Function entry point.

    event:   {"method": str, "path": str, "headers": dict, "body": str}
    context: reserved for future use (request id, deadline, ...)

    Return  {"statusCode": int, "body": str, "headers": dict (optional)}.
    """
    return {
        "statusCode": 200,
        "body": "Hello from your function!",
    }
`

const PYTHON_RUNNER = `# runner.py — wraps handler.handler() in a tiny WSGI server. Lives in
# the repo (not the console UI) so power users can swap it out.
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

import handler as user_handler


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):  # silence default access logs
        pass

    def _serve(self):
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length).decode("utf-8") if length else ""
        event = {
            "method": self.command,
            "path": self.path,
            "headers": {k: v for k, v in self.headers.items()},
            "body": body,
        }
        try:
            res = user_handler.handler(event, {}) or {}
        except Exception as e:  # noqa: BLE001
            self.send_response(500)
            self.send_header("content-type", "text/plain")
            self.end_headers()
            self.wfile.write(f"handler error: {e}".encode("utf-8"))
            return
        status = int(res.get("statusCode", 200))
        body = res.get("body", "")
        if not isinstance(body, (str, bytes)):
            body = json.dumps(body)
        if isinstance(body, str):
            body = body.encode("utf-8")
        headers = res.get("headers") or {}
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        if "content-type" not in {k.lower() for k in headers}:
            self.send_header("content-type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(body)

    do_GET = _serve
    do_POST = _serve
    do_PUT = _serve
    do_DELETE = _serve
    do_PATCH = _serve


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    HTTPServer(("0.0.0.0", port), _Handler).serve_forever()
`

const PYTHON_DOCKERFILE = `# Slim base — paketo / buildpacks can replace this later. For now a
# plain Dockerfile keeps the build path obvious and dep-light.
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY handler.py runner.py ./

EXPOSE 8080
CMD ["python", "runner.py"]
`

const PYTHON_REQUIREMENTS = `# Add your dependencies here, one per line.
`

const NODE_HANDLER = `// Function entry point.
//
//   event:   { method, path, headers, body }
//   context: reserved for future use
//
//   return  { statusCode, body, headers? }
exports.handler = async (event, context) => {
  return {
    statusCode: 200,
    body: "Hello from your function!",
  };
};
`

const NODE_RUNNER = `// runner.js — wraps exports.handler in a minimal HTTP server. Lives in
// the repo (not the console UI) so power users can swap it out.
const http = require("http");
const handler = require("./index.js");

const port = parseInt(process.env.PORT || "8080", 10);

http
  .createServer(async (req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      const event = {
        method: req.method,
        path: req.url,
        headers: req.headers,
        body,
      };
      try {
        const r = (await handler.handler(event, {})) || {};
        res.writeHead(r.statusCode || 200, r.headers || { "content-type": "text/plain; charset=utf-8" });
        res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? ""));
      } catch (e) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("handler error: " + (e && e.message ? e.message : String(e)));
      }
    });
  })
  .listen(port);
`

const NODE_DOCKERFILE = `FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev || true

COPY index.js runner.js ./

EXPOSE 8080
CMD ["node", "runner.js"]
`

const NODE_PACKAGE_JSON = `{
  "name": "function",
  "version": "0.1.0",
  "private": true,
  "main": "index.js",
  "engines": { "node": ">=20" },
  "dependencies": {}
}
`

// Forgejo Actions workflow that builds + pushes on every push to main.
// The actual deploy hook (POST /functions/<slug>/deploy) lands in
// Step 5 — we leave a placeholder line so the runner has something
// to do today and the user can see the build run end-to-end.
const BUILD_WORKFLOW = (slug: string) => `name: build
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    container:
      image: gcr.io/kaniko-project/executor:v1.23.2-debug
    steps:
      - name: Checkout (raw)
        uses: actions/checkout@v4
      - name: Build + push
        run: |
          /kaniko/executor \\
            --dockerfile=Dockerfile \\
            --context=. \\
            --destination=cr.dev.openschema.io/agent-platform/functions/${slug}:\${{ github.sha }} \\
            --destination=cr.dev.openschema.io/agent-platform/functions/${slug}:latest \\
            --skip-tls-verify
`

const README = (slug: string) => `# ${slug}

This is a function repo managed by the platform's Functions service.

The console UI exposes only the **handler file** (\`handler.py\` /
\`index.js\`). Everything else — \`Dockerfile\`, the runner shim, the
\`.forgejo/workflows/build.yml\` — is bootstrapped here once and meant
to be edited by power users via git, not the console.
`

const TEMPLATES: Record<FunctionRuntime, FunctionTemplate> = {
  "python3.12": {
    handlerPath: "handler.py",
    language: "python",
    initialFiles: [
      { path: "handler.py", content: PYTHON_HANDLER },
      { path: "runner.py", content: PYTHON_RUNNER },
      { path: "requirements.txt", content: PYTHON_REQUIREMENTS },
      { path: "Dockerfile", content: PYTHON_DOCKERFILE },
    ],
  },
  node20: {
    handlerPath: "index.js",
    language: "javascript",
    initialFiles: [
      { path: "index.js", content: NODE_HANDLER },
      { path: "runner.js", content: NODE_RUNNER },
      { path: "package.json", content: NODE_PACKAGE_JSON },
      { path: "Dockerfile", content: NODE_DOCKERFILE },
    ],
  },
}

export function getTemplate(runtime: FunctionRuntime): FunctionTemplate {
  return TEMPLATES[runtime]
}

export function buildInitialFiles(
  runtime: FunctionRuntime,
  slug: string,
): FunctionFile[] {
  const t = TEMPLATES[runtime]
  return [
    ...t.initialFiles,
    { path: ".forgejo/workflows/build.yml", content: BUILD_WORKFLOW(slug) },
    { path: "README.md", content: README(slug) },
  ]
}
