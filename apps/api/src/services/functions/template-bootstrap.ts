import { Logger } from "@nestjs/common"
import { ForgejoClient } from "../../forgejo/forgejo.client"
import { listTemplates, type FunctionTemplate } from "./templates"

const log = new Logger("FunctionTemplateBootstrap")

// HARBOR_USER / HARBOR_TOKEN are pre-set on the platform org by the
// forgejo-fork tf module so the runner can `docker push` to Harbor.
// Function repos live under `service` though, which forgejo-fork
// doesn't touch — so we mirror the same secrets here at boot. Without
// this, build.yml fails with `Must provide --username with --password-stdin`.
async function ensureFunctionOrgSecrets(forgejo: ForgejoClient): Promise<void> {
  const user = process.env.HARBOR_USER
  const token = process.env.HARBOR_TOKEN
  if (!user || !token) {
    log.warn(
      "HARBOR_USER/HARBOR_TOKEN env not set — skipping service-org Harbor secret sync",
    )
    return
  }
  await forgejo.setOrgSecret(forgejo.functionOrg, "HARBOR_USER", user)
  await forgejo.setOrgSecret(forgejo.functionOrg, "HARBOR_TOKEN", token)
  log.log(
    `Synced HARBOR_USER/HARBOR_TOKEN to org ${forgejo.functionOrg}`,
  )
}

// Materialise the in-code template definitions into Forgejo template
// repos under the `service` org so FunctionsService.create can fork
// from them via the generate-from-template API.
//
// Strategy:
//   1. ensure org `service` exists
//   2. for each runtime template:
//      a. create the repo if missing (auto_init=true so it has a
//         default branch we can write into)
//      b. write each template file (writeFile auto-detects create vs
//         update via 422 fallback and is content-idempotent at the
//         API level — Forgejo skips the commit if content matches)
//      c. PATCH the repo to set `template: true` so generate works
//
// Skipped silently when the Forgejo client is disabled (no creds wired
// yet — bridge state on a fresh dev cluster).
export async function ensureFunctionTemplates(
  forgejo: ForgejoClient,
): Promise<void> {
  if (!forgejo.enabled) {
    log.warn("Forgejo client not configured — skipping template bootstrap")
    return
  }
  await forgejo.ensureOrg(forgejo.functionOrg)
  await ensureFunctionOrgSecrets(forgejo).catch((err) =>
    log.warn(`ensureFunctionOrgSecrets: ${(err as Error).message}`),
  )
  const templates = listTemplates()
  for (const tpl of templates) {
    try {
      await ensureOne(forgejo, tpl)
    } catch (err) {
      // Don't fail boot — bootstrap errors shouldn't block the rest of
      // console-api from coming up. Surface the error in logs and let
      // an admin retry.
      log.error(
        `Failed to bootstrap template ${tpl.repoName}: ${(err as Error).message}`,
      )
    }
  }
}

async function ensureOne(
  forgejo: ForgejoClient,
  tpl: FunctionTemplate,
): Promise<void> {
  // Step 1: repo exists. createOrgRepo is the only "create if missing"
  // path we have today, so we attempt it and tolerate the 422/409 the
  // existing-repo case returns.
  try {
    await forgejo.createOrgRepo({
      org: forgejo.functionOrg,
      name: tpl.repoName,
      description: tpl.description,
      autoInit: true,
      private: false,
    })
    log.log(`Created template repo ${forgejo.functionOrg}/${tpl.repoName}`)
  } catch (err) {
    const msg = (err as Error).message
    if (!/422|409|already.*exists/i.test(msg)) throw err
  }

  // Step 2: seed/update files. writeFile handles create+update.
  for (const file of tpl.files) {
    await forgejo.writeFile({
      org: forgejo.functionOrg,
      repo: tpl.repoName,
      path: file.path,
      content: file.content,
      message: `template: sync ${file.path}`,
    })
  }

  // Step 3: mark as template. Idempotent.
  await forgejo.markRepoAsTemplate(forgejo.functionOrg, tpl.repoName)
}
