"use client"

import { useState } from "react"
import { Button } from "@workspace/ui/components/button"
import { signIn } from "@/lib/auth-client"

export default function SignInPage() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
    <div className="bg-background flex min-h-svh items-center justify-center p-4">
      <div className="bg-card text-card-foreground animate-in fade-in zoom-in-95 grid w-full max-w-2xl overflow-hidden border duration-500 sm:grid-cols-[1fr_1.5fr]">
        {/* Branding panel — dark in both themes. On mobile this
            becomes a thin top bar with the "Console" wordmark; on
            sm+ it's the left-hand side. Single piece of copy. */}
        <div aria-hidden className="bg-zinc-950 sm:min-h-[28rem]">
          <div className="p-5">
            <span className="text-xl leading-tight font-bold tracking-tight text-white">
              Console
            </span>
          </div>
        </div>

        <div className="p-5 sm:min-h-[28rem] sm:border-l sm:p-6">
          <div className="flex h-full flex-col justify-center">
            <h1 className="text-lg font-semibold tracking-tight">Sign in</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Continue with your platform account.
            </p>

            {error ? (
              <div
                role="alert"
                className="border-destructive/30 bg-destructive/5 text-destructive mt-5 border px-3 py-2 text-sm"
              >
                {error}
              </div>
            ) : null}

            <Button
              className="mt-5 w-full rounded-none"
              disabled={loading}
              onClick={onSignIn}
            >
              {loading ? "Redirecting…" : "Continue with Keycloak"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
