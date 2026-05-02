import { Injectable, Logger } from "@nestjs/common"

// Thin Harbor REST client. Single use case for now: deleting a
// function's repository (and all its artifacts) when the function is
// deleted, so abandoned images don't pile up.
//
// FUNCTION_IMAGE_PREFIX already encodes <host>/<project>/<repo-prefix>
// (e.g. "cr.dev.openschema.io/agent-platform/functions"); we reuse it
// rather than introducing a separate HARBOR_URL env var.

@Injectable()
export class HarborClient {
  private readonly log = new Logger(HarborClient.name)
  private readonly imagePrefix = (
    process.env.FUNCTION_IMAGE_PREFIX ?? ""
  ).replace(/\/$/, "")
  private readonly user = process.env.HARBOR_USER ?? ""
  private readonly token = process.env.HARBOR_TOKEN ?? ""

  get enabled(): boolean {
    return this.parts() !== null && !!this.user && !!this.token
  }

  // Splits "<host>/<project>/<repo-prefix>" into its components.
  // Returns null when the env var isn't shaped right — caller falls
  // back to a no-op so the rest of delete() can still finish.
  private parts(): { host: string; project: string; repoPrefix: string } | null {
    if (!this.imagePrefix) return null
    const segments = this.imagePrefix.split("/")
    if (segments.length < 3) return null
    return {
      host: segments[0]!,
      project: segments[1]!,
      repoPrefix: segments.slice(2).join("/"),
    }
  }

  // Drop the function's Harbor repo (which holds every per-commit
  // image plus :latest). 404 is treated as success — already gone is
  // the desired state. Any 2xx body is fine.
  async deleteFunctionRepo(slug: string): Promise<void> {
    const p = this.parts()
    if (!p) {
      throw new Error(
        "FUNCTION_IMAGE_PREFIX is not configured — Harbor cleanup unavailable",
      )
    }
    const repoName = `${p.repoPrefix}/${slug}`
    // Harbor wants slashes in the repo-name path segment to arrive as
    // literal "%2F". HTTP servers decode one layer of percent-encoding
    // by default, so we send "%252F" — server decodes once → Harbor
    // sees "%2F" and treats it as part of the repo name (not a path
    // separator).
    const encodedRepo = repoName.replace(/\//g, "%252F")
    const url = `https://${p.host}/api/v2.0/projects/${encodeURIComponent(p.project)}/repositories/${encodedRepo}`
    const auth = Buffer.from(`${this.user}:${this.token}`).toString("base64")
    const res = await fetch(url, {
      method: "DELETE",
      headers: { authorization: `Basic ${auth}` },
    })
    if (res.status === 200 || res.status === 204 || res.status === 404) return
    const text = await res.text().catch(() => "")
    throw new Error(
      `Harbor deleteFunctionRepo(${repoName}) -> ${res.status}: ${text}`,
    )
  }
}
