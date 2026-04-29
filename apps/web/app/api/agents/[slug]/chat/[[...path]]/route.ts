import { headers } from "next/headers"
import { NextRequest } from "next/server"

// Same-origin proxy for the chat endpoints. Client components fetch
// /api/agents/<slug>/chat/<...> on console.<domain>; this route
// forwards to console-api at api.<domain> with the request's
// authenticated cookie attached. Avoids CORS preflight + lets the
// browser's cookie policy stay simple (no SameSite=None needed).

const API_URL =
  process.env.API_URL_INTERNAL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:3001"

async function forward(
  req: NextRequest,
  slug: string,
  path: string[],
): Promise<Response> {
  const cookieHeader = (await headers()).get("cookie") ?? ""
  const suffix = path.length > 0 ? `/${path.map(encodeURIComponent).join("/")}` : ""
  const target = `${API_URL}/agents/${encodeURIComponent(slug)}/chat${suffix}`
  const init: RequestInit = {
    method: req.method,
    headers: {
      cookie: cookieHeader,
      ...(req.headers.get("content-type")
        ? { "content-type": req.headers.get("content-type")! }
        : {}),
    },
    body:
      req.method === "GET" || req.method === "HEAD"
        ? undefined
        : await req.text(),
    cache: "no-store",
  }
  const upstream = await fetch(target, init)
  // Pipe through. For SSE the upstream sets text/event-stream and
  // body is a ReadableStream — we forward it as-is so EventSource on
  // the client stays open.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type":
        upstream.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": upstream.headers.get("cache-control") ?? "no-store",
      "x-accel-buffering":
        upstream.headers.get("x-accel-buffering") ?? "no",
    },
  })
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; path?: string[] }> },
) {
  const { slug, path = [] } = await params
  return forward(req, slug, path)
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; path?: string[] }> },
) {
  const { slug, path = [] } = await params
  return forward(req, slug, path)
}
