// Per-runtime function templates.
//
// Source-of-truth lives in two places:
//   - The local `services/function-template-base-python/` directory
//     (visual reference, `git clone`-able by power users)
//   - The `service/<TEMPLATE_REPO>` Forgejo repo (what FunctionsService
//     actually forks via the generate-from-template API)
//
// At console-api boot time, ensureTemplateRepos() materialises this
// constant into Forgejo if the repo is missing, and overwrites any
// drift on a per-file basis. So the *codebase* wins on conflicts —
// admins who want template tweaks should send a PR against this file
// rather than editing Forgejo directly.

import { FunctionRuntime } from "./functions.types"

export type TemplateFile = {
  path: string
  content: string
}

export type FunctionTemplate = {
  // Forgejo repo under the `service` org that FunctionsService.create
  // forks from. Naming convention: `function-template-<id>`.
  repoName: string
  description: string
  // Monaco language id for the user-editable folder; the `function/`
  // tree is what the console UI exposes.
  language: string
  // Folder the console exposes for editing. Anything outside is
  // platform-managed (runner / Dockerfile / workflow).
  userFolder: string
  // Default file the editor opens onto.
  defaultFile: string
  // All files committed when the template repo is materialised.
  files: TemplateFile[]
}

const PYTHON_USER_MAIN = `from starlette.responses import JSONResponse


async def main(request):
    if request.method == "GET":
        return JSONResponse(
            content={"message": "success!"},
            status_code=200,
        )
    elif request.method == "POST":
        body: dict = await request.json()
        return JSONResponse(
            content={"message": f"Received data: {body}"},
            status_code=200,
        )
    return JSONResponse(
        content={"message": "Method not allowed"},
        status_code=405,
    )
`

const PYTHON_RUNNER = `"""Function platform runner.

Vercel-style routing: each \`.py\` file under \`function/\` exports a
\`main\` callable that gets mounted at the URL derived from the file
path. One file = one route; helpers in the same file stay private.

Examples:
    function/main.py:def main           → /
    function/foo.py:def main            → /foo
    function/users/main.py:def main     → /users          (dir index)
    function/users/list.py:def main     → /users/list

User contract: \`main\` receives a Starlette \`Request\` and returns a
Starlette \`Response\`. All HTTP methods dispatch to the same handler.
"""
import importlib.util
from pathlib import Path
from types import ModuleType

from starlette.applications import Starlette
from starlette.routing import Route

ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]
USER_FOLDER = "function"


def _load(path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(path.stem, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _route_path(rel_path: str) -> str:
    if rel_path == "main":
        return "/"
    if rel_path.endswith("/main"):
        rel_path = rel_path[: -len("/main")]
    return "/" + rel_path


def _discover(folder: str) -> list[Route]:
    routes: list[Route] = []
    root = Path(folder)
    for path in sorted(root.rglob("*.py")):
        if path.name == "__init__.py":
            continue
        mod = _load(path)
        fn = getattr(mod, "main", None)
        if not callable(fn):
            continue
        rel = str(path.relative_to(root).with_suffix(""))
        routes.append(Route(_route_path(rel), fn, methods=ALL_METHODS))
    return routes


app = Starlette(debug=False, routes=_discover(USER_FOLDER))
`

const PYTHON_DOCKERFILE = `# Function template — Python 3.12, Starlette runner.
#
# Layout (the runner expects):
#   /app/main.py                ← platform runner; auto-mounts function/
#   /app/function/main.py       ← user handler (visible in console UI)
#   /app/function/requirements.txt  user deps (optional)
#   /app/requirements.txt       ← platform deps (starlette, uvicorn)
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \\
    PYTHONUNBUFFERED=1 \\
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Platform deps first so user-deps changes don't bust this layer.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# User deps next. The COPY of an empty requirements.txt is fine and
# keeps \`pip install\` a no-op when the user hasn't added anything.
COPY function/requirements.txt /tmp/user-requirements.txt
RUN pip install --no-cache-dir -r /tmp/user-requirements.txt

# Source last. main.py is the runner; function/ is the user-edited tree.
COPY main.py ./
COPY function/ ./function/

EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
`

const PYTHON_BUILD_WORKFLOW = `name: build-and-push

# Forgejo Actions workflow shipped with every function repo (forked
# from this template). Builds the user's image on every push to main
# and pushes to the in-cluster Harbor under
#   cr.<domain>/agent-platform/functions/<repo-name>:<sha>
#   cr.<domain>/agent-platform/functions/<repo-name>:latest

on:
  push:
    branches: [main]
  workflow_dispatch: {}

env:
  HARBOR: cr.dev.openschema.io
  PROJECT: agent-platform

jobs:
  build:
    runs-on: docker
    steps:
      - uses: actions/checkout@v4

      - name: Install docker CLI
        run: |
          apt-get update -qq
          apt-get install -y --no-install-recommends docker.io ca-certificates

      - name: Login to Harbor
        env:
          HU: \${{ secrets.HARBOR_USER }}
          HT: \${{ secrets.HARBOR_TOKEN }}
        run: |
          echo "$HT" | docker login "$HARBOR" -u "$HU" --password-stdin

      - name: Build and push
        env:
          IMAGE: \${{ env.HARBOR }}/\${{ env.PROJECT }}/functions/\${{ github.event.repository.name }}
          SHA: \${{ github.sha }}
        run: |
          set -eu
          docker build -t "$IMAGE:$SHA" -t "$IMAGE:latest" -f Dockerfile .
          docker push "$IMAGE:$SHA"
          docker push "$IMAGE:latest"

      - name: Notify console-api
        if: success()
        env:
          SLUG: \${{ github.event.repository.name }}
          SHA: \${{ github.sha }}
        run: |
          curl -sS -X POST \\
            -H 'content-type: application/json' \\
            "http://console-api.platform-console.svc.cluster.local:3001/functions/$SLUG/deploy" \\
            -d "{\\"sha\\":\\"$SHA\\"}" || true
`

const PYTHON_TEMPLATE: FunctionTemplate = {
  repoName: "function-template-base-python",
  description: "Function template — Python 3.12, Starlette runner.",
  language: "python",
  userFolder: "function",
  defaultFile: "function/main.py",
  files: [
    { path: "main.py", content: PYTHON_RUNNER },
    { path: "Dockerfile", content: PYTHON_DOCKERFILE },
    { path: "requirements.txt", content: "starlette\nuvicorn\n" },
    { path: ".forgejo/workflows/build.yml", content: PYTHON_BUILD_WORKFLOW },
    { path: "function/main.py", content: PYTHON_USER_MAIN },
    { path: "function/requirements.txt", content: "" },
  ],
}

const TEMPLATES: Record<FunctionRuntime, FunctionTemplate> = {
  "python3.12": PYTHON_TEMPLATE,
  // node20 not yet ported to the new layout. Falls back to the
  // python template until someone authors a Node equivalent.
  node20: PYTHON_TEMPLATE,
}

export function getTemplate(runtime: FunctionRuntime): FunctionTemplate {
  return TEMPLATES[runtime]
}

export function listTemplates(): FunctionTemplate[] {
  return Array.from(new Set(Object.values(TEMPLATES)))
}
