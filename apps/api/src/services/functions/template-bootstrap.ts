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

// Ensure the org + per-runtime template repos exist and are flagged
// as Forgejo templates (so generate-from-template works). The repo
// content itself is authored separately — push commits to
// `service/<repoName>` from the on-disk checkout
// (services/<repoName>/) using your usual git workflow. Console-api
// never writes file content into these repos: git is the SoT.
//
// On a brand-new cluster the repo will be empty until someone pushes
// the initial template commit. FunctionsService.create surfaces the
// resulting Forgejo error if generate-from-template hits an empty
// repo.
//
// Skipped silently when the Forgejo client is disabled.
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
  for (const tpl of listTemplates()) {
    try {
      await ensureOne(forgejo, tpl)
    } catch (err) {
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
  // Create empty repo if missing. autoInit:false because a real
  // template push from the on-disk checkout will land the initial
  // commit; auto-init would just add a stray README.
  try {
    await forgejo.createOrgRepo({
      org: forgejo.functionOrg,
      name: tpl.repoName,
      description: tpl.description,
      autoInit: false,
      private: false,
    })
    log.log(`Created template repo ${forgejo.functionOrg}/${tpl.repoName}`)
  } catch (err) {
    const msg = (err as Error).message
    if (!/422|409|already.*exists/i.test(msg)) throw err
  }
  // Mark template — idempotent.
  await forgejo.markRepoAsTemplate(forgejo.functionOrg, tpl.repoName)
}
