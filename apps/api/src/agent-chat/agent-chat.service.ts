import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common"
import type { Response } from "express"
import { OpenFgaService } from "../openfga/openfga.service"
import { RESOURCE_NS } from "../vms/vms.service"

// The agent wrapper (services/agents) inside each sandbox listens
// here, port 8000 by convention. Service name is the resource slug
// (vm-XXXX or agent-XXXX) under the unified resource namespace.
function wrapperUrl(slug: string, path: string): string {
  return `http://${slug}.${RESOURCE_NS}.svc.cluster.local:8000${path}`
}

export type Resource = "vm" | "agent"

@Injectable()
export class AgentChatService {
  constructor(private readonly fga: OpenFgaService) {}

  // FGA gate. 404 (not 403) on miss so we don't leak slug existence
  // to non-owners — same convention as VmsService / AgentsService.
  async assertOwner(
    ownerId: string,
    resource: Resource,
    slug: string,
  ): Promise<void> {
    const allowed = resource === "vm"
      ? await this.fga.canAccessVm(ownerId, slug)
      : await this.fga.canAccessAgent(ownerId, slug)
    if (!allowed) {
      throw new NotFoundException(`${resource} "${slug}" not found.`)
    }
  }

  // Plain JSON pass-through. Wrapper returns JSON for everything
  // except /tasks/<id>/stream (SSE) which goes through proxyStream.
  async proxyJson(
    slug: string,
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const url = wrapperUrl(slug, path)
    const init: RequestInit = {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    }
    let res: globalThis.Response
    try {
      res = await fetch(url, init)
    } catch (err) {
      throw new BadRequestException(
        `agent wrapper unreachable: ${(err as Error).message}`,
      )
    }
    const text = await res.text()
    if (!res.ok) {
      // Forward the wrapper's status + body so the UI sees the real
      // reason instead of a generic 500.
      throw new BadRequestException(
        `wrapper ${method} ${path} -> ${res.status}: ${text}`,
      )
    }
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  // SSE streaming proxy. Pipes the wrapper's text/event-stream body
  // straight into our outgoing response. Sets the right headers up
  // front so Traefik / browser don't buffer the chunks.
  async proxyStream(
    slug: string,
    path: string,
    res: Response,
  ): Promise<void> {
    const url = wrapperUrl(slug, path)
    let upstream: globalThis.Response
    try {
      upstream = await fetch(url, { headers: { accept: "text/event-stream" } })
    } catch (err) {
      throw new BadRequestException(
        `agent wrapper unreachable: ${(err as Error).message}`,
      )
    }
    if (!upstream.ok || !upstream.body) {
      const body = await upstream.text().catch(() => "")
      throw new BadRequestException(
        `wrapper stream -> ${upstream.status}: ${body}`,
      )
    }
    res.setHeader("Content-Type", "text/event-stream")
    res.setHeader("Cache-Control", "no-cache, no-transform")
    res.setHeader("Connection", "keep-alive")
    res.setHeader("X-Accel-Buffering", "no")
    res.flushHeaders()

    const reader = upstream.body.getReader()
    const onClose = () => {
      reader.cancel().catch(() => undefined)
    }
    res.on("close", onClose)
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) res.write(value)
      }
    } finally {
      res.off("close", onClose)
      res.end()
    }
  }
}
