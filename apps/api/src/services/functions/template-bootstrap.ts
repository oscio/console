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

// Template repos are forked from oscio into <templateOrg>/<repoName>
// by terraform's forgejo-fork module — that's the SoT for both code
// and existence. Console-api boot only needs to:
//   1. Ensure the function org (where user-created function repos
//      land) exists and has the Harbor secrets the build workflow
//      expects.
//   2. Flip the `template:true` flag on the forked repo so
//      generate-from-template works against it.
//
// If a tf apply hasn't run yet the template repo won't exist —
// markRepoAsTemplate will fail and we surface that in the log; the
// rest of console-api still boots so users can drive non-Functions
// flows.
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
      await markTemplate(forgejo, tpl)
    } catch (err) {
      log.error(
        `Failed to flag template ${forgejo.templateOrg}/${tpl.repoName}: ${(err as Error).message}`,
      )
    }
  }
}

async function markTemplate(
  forgejo: ForgejoClient,
  tpl: FunctionTemplate,
): Promise<void> {
  await forgejo.markRepoAsTemplate(forgejo.templateOrg, tpl.repoName)
  log.log(
    `Marked ${forgejo.templateOrg}/${tpl.repoName} as a Forgejo template`,
  )
}
