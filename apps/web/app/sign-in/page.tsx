"use client"

import { useEffect, useState } from "react"
import { Button } from "@workspace/ui/components/button"
import { signIn } from "@/lib/auth-client"

export default function SignInPage() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Pointer-follow glow over the dotted background — same effect as
  // the reference template. Cheap (CSS variables, no React state).
  // Skipped on coarse pointers (touch) to keep the surface calm.
  useEffect(() => {
    if (typeof window === "undefined") return
    if (!window.matchMedia("(pointer:fine)").matches) return
    const root = document.documentElement
    const onMove = (e: PointerEvent) => {
      root.style.setProperty("--glow-x", `${e.clientX}px`)
      root.style.setProperty("--glow-y", `${e.clientY}px`)
    }
    window.addEventListener("pointermove", onMove)
    return () => window.removeEventListener("pointermove", onMove)
  }, [])

  async function onSignIn() {
    setLoading(true)
    setError(null)
    const { error: err } = await signIn.oauth2({
      providerId: "keycloak",
      callbackURL: "/dashboard",
    })
    if (err) {
      setError(err.message ?? "Sign-in failed")
      setLoading(false)
    }
  }

  return (
    <div className="relative flex min-h-svh items-center justify-center overflow-hidden p-4">
      {/* Layered dotted background. Light theme uses dark dots, dark
          theme uses light dots — render both, hide one per theme.
          The second layer is brighter and masked to a circle around
          the cursor so it reads as a soft spotlight. */}
      <BackgroundDots />
      <BackgroundGlow />

      <div className="bg-card text-card-foreground animate-in fade-in slide-in-from-bottom-4 zoom-in-95 relative z-10 w-full max-w-2xl overflow-hidden rounded-md border shadow-lg duration-500">
        <div className="grid sm:grid-cols-[1fr_1.5fr]">
          {/* Aside: branding panel. Dark in both themes — the
              right-hand sign-in panel still flips with the theme. */}
          <div
            aria-hidden
            className="hidden min-h-[28rem] sm:block"
            style={{
              backgroundColor: "#0f0f11",
              backgroundImage:
                "linear-gradient(rgba(9,9,11,0.16), rgba(9,9,11,0.32))",
            }}
          >
            <div className="flex h-full flex-col p-5">
              <div className="text-xl leading-tight font-bold tracking-tight text-white">
                Console
              </div>
              <div className="mt-2 max-w-xs text-sm leading-relaxed text-white/85">
                Workspaces, agents, and platform resources for the
                Open Schema dev cluster.
              </div>
            </div>
          </div>

          <div className="border-t p-5 sm:min-h-[28rem] sm:border-t-0 sm:border-l sm:p-6">
            <div className="flex h-full flex-col justify-center">
              <h1 className="text-lg font-semibold tracking-tight">
                Sign in
              </h1>
              <p className="text-muted-foreground mt-1 text-sm">
                Continue with your platform account.
              </p>

              {error ? (
                <div
                  role="alert"
                  className="border-destructive/30 bg-destructive/5 text-destructive mt-5 rounded border px-3 py-2 text-sm"
                >
                  {error}
                </div>
              ) : null}

              <Button
                className="mt-5 w-full"
                disabled={loading}
                onClick={onSignIn}
              >
                {loading ? "Redirecting…" : "Continue with Keycloak"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

const DOT_BG_LIGHT =
  "radial-gradient(circle, rgba(24,24,27,0.24) 0.9px, transparent 1.25px)"
const DOT_BG_DARK =
  "radial-gradient(circle, rgba(244,244,245,0.12) 0.9px, transparent 1.25px)"
const GLOW_BG_LIGHT =
  "radial-gradient(circle, rgba(24,24,27,0.6) 1.1px, transparent 1.5px)"
const GLOW_BG_DARK =
  "radial-gradient(circle, rgba(244,244,245,0.2) 1.1px, transparent 1.5px)"
const GLOW_MASK =
  "radial-gradient(180px circle at var(--glow-x, 50%) var(--glow-y, 50%), rgba(0,0,0,1), rgba(0,0,0,0) 72%)"

function BackgroundDots() {
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-0 opacity-70 dark:hidden"
        style={{
          backgroundImage: DOT_BG_LIGHT,
          backgroundSize: "22px 22px",
          backgroundPosition: "center",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-0 hidden opacity-70 dark:block"
        style={{
          backgroundImage: DOT_BG_DARK,
          backgroundSize: "22px 22px",
          backgroundPosition: "center",
        }}
      />
    </>
  )
}

function BackgroundGlow() {
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-0 dark:hidden"
        style={{
          backgroundImage: GLOW_BG_LIGHT,
          backgroundSize: "22px 22px",
          backgroundPosition: "center",
          WebkitMaskImage: GLOW_MASK,
          maskImage: GLOW_MASK,
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-0 hidden dark:block"
        style={{
          backgroundImage: GLOW_BG_DARK,
          backgroundSize: "22px 22px",
          backgroundPosition: "center",
          WebkitMaskImage: GLOW_MASK,
          maskImage: GLOW_MASK,
        }}
      />
    </>
  )
}
