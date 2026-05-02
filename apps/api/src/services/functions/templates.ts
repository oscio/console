// Per-runtime function template metadata. The template content
// itself (runner, Dockerfile, sample handler, build workflow) lives
// in the Forgejo repo this file points at — `service/<repoName>` —
// and is the canonical source of truth. The on-disk equivalent at
// services/<repoName>/ is the development checkout for that repo.
//
// Console-api boot ensures the org + the empty repo + the template
// flag exist; it does NOT push file contents anymore. Authoring the
// runner/Dockerfile/etc. happens through git (push to Forgejo).

import { FunctionRuntime } from "./functions.types"

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
}

const PYTHON_TEMPLATE: FunctionTemplate = {
  repoName: "function-template-base-python",
  description: "Function template — Python 3.12, Starlette runner.",
  language: "python",
  userFolder: "function",
  defaultFile: "function/main.py",
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
