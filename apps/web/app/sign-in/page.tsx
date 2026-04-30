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
      <div className="bg-card text-card-foreground grid w-full max-w-2xl overflow-hidden rounded-md border sm:grid-cols-[1fr_1.5fr]">
        {/* Branding panel — dark in both themes. Single piece of
            copy: the "Console" wordmark, top-left. */}
        <div
          aria-hidden
          className="hidden min-h-[28rem] bg-zinc-950 sm:block"
        >
          <div className="p-5">
            <span className="text-xl leading-tight font-bold tracking-tight text-white">
              Console
            </span>
          </div>
        </div>

        <div className="border-t p-5 sm:min-h-[28rem] sm:border-t-0 sm:border-l sm:p-6">
          <div className="flex h-full flex-col justify-center">
            <h1 className="text-lg font-semibold tracking-tight">Sign in</h1>
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
  )
}
