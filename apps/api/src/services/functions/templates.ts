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

const PYTHON_USER_MAIN = `"""User handler — Lambda-style entrypoint.

The platform's runner imports this file once on cold start and calls
\`handler(event, context)\` for every HTTP request.

  event   — dict shaped like AWS API Gateway HTTP API v2
            (event["requestContext"]["http"]["method"] etc.)
  context — dict with platform metadata about the running function:
              function_name        — slug (e.g. "function-abcd1234")
              function_arn         — stable identifier for this function
              function_version     — image tag ("dev" or commit SHA)
              function_target      — "dev" (Save) or "prod" (Deploy)
              function_namespace   — k8s namespace
              function_hostname    — public hostname (live when Exposed)
              request_id           — unique id for this invocation

Return a dict {statusCode, headers?, body?} and the runner maps it
back to an HTTP response.
"""
import json


def handler(event, context):
    method = event["requestContext"]["http"]["method"]
    if method == "GET":
        return {
            "statusCode": 200,
            "body": json.dumps({"message": "pong", "from": context["function_arn"]}),
        }
    if method == "POST":
        try:
            payload = json.loads(event.get("body") or "{}")
        except json.JSONDecodeError:
            return {"statusCode": 400, "body": json.dumps({"error": "invalid JSON"})}
        return {"statusCode": 200, "body": json.dumps({"received": payload})}
    return {"statusCode": 405, "body": json.dumps({"error": "method not allowed"})}
`

const PYTHON_RUNNER = `"""Function platform runner — Lambda-style.

The user's \`function/main.py\` exports a single \`handler(event, context)\`
callable. Every HTTP request is wrapped into an API-Gateway-shaped
event JSON and passed in; whatever the handler returns becomes an
HTTP response. One repo = one function = one entrypoint.
"""
import asyncio
import importlib.util
import os
import uuid
from pathlib import Path
from types import ModuleType
from typing import Any, Callable

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route

ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]
USER_FOLDER = "function"
HANDLER_FILE = "main.py"
HANDLER_NAME = "handler"

# Platform metadata baked into the Knative Service env at deploy/save
# time. Cold-start once and pass through to the handler's \`context\`
# dict on every invocation.
FUNCTION_INFO = {
    "function_name": os.environ.get("OS_FUNCTION_NAME", ""),
    "function_arn": os.environ.get("OS_FUNCTION_ARN", ""),
    "function_version": os.environ.get("OS_FUNCTION_VERSION", ""),
    "function_target": os.environ.get("OS_FUNCTION_TARGET", ""),
    "function_namespace": os.environ.get("OS_FUNCTION_NAMESPACE", ""),
    "function_hostname": os.environ.get("OS_FUNCTION_HOSTNAME", ""),
}


def _load_handler() -> Callable | None:
    path = Path(USER_FOLDER) / HANDLER_FILE
    if not path.exists():
        return None
    spec = importlib.util.spec_from_file_location("user_handler", path)
    if spec is None or spec.loader is None:
        return None
    mod: ModuleType = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    fn = getattr(mod, HANDLER_NAME, None)
    return fn if callable(fn) else None


HANDLER = _load_handler()


async def _invoke(request: Request) -> Response:
    if HANDLER is None:
        return Response(
            f"handler not found: expected {HANDLER_FILE}:{HANDLER_NAME}",
            status_code=500,
        )
    body_bytes = await request.body()
    body_text = body_bytes.decode("utf-8", errors="replace") if body_bytes else ""
    event: dict[str, Any] = {
        "version": "2.0",
        "rawPath": request.url.path,
        "rawQueryString": str(request.url.query) if request.url.query else "",
        "headers": {k: v for k, v in request.headers.items()},
        "body": body_text,
        "isBase64Encoded": False,
        "requestContext": {
            "http": {
                "method": request.method,
                "path": request.url.path,
                "sourceIp": request.client.host if request.client else "",
                "userAgent": request.headers.get("user-agent", ""),
            },
        },
    }
    context = {**FUNCTION_INFO, "request_id": str(uuid.uuid4())}
    result = HANDLER(event, context)
    if asyncio.iscoroutine(result):
        result = await result
    return _to_response(result)


def _to_response(result: Any) -> Response:
    if isinstance(result, Response):
        return result
    if isinstance(result, dict) and "statusCode" in result:
        status = int(result.get("statusCode", 200))
        headers = result.get("headers") or {}
        body = result.get("body", "")
        if not isinstance(body, (str, bytes)):
            import json

            body = json.dumps(body)
        if isinstance(body, str):
            body = body.encode("utf-8")
        return Response(content=body, status_code=status, headers=headers)
    if isinstance(result, str):
        return Response(result, status_code=200, media_type="text/plain")
    import json

    return Response(json.dumps(result), status_code=200, media_type="application/json")


app = Starlette(
    debug=False,
    routes=[Route("/{path:path}", _invoke, methods=ALL_METHODS)],
)
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
}

export function getTemplate(runtime: FunctionRuntime): FunctionTemplate {
  return TEMPLATES[runtime]
}

export function listTemplates(): FunctionTemplate[] {
  return Array.from(new Set(Object.values(TEMPLATES)))
}
