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
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="bg-card text-card-foreground w-full max-w-sm rounded-lg border p-8 shadow-sm">
        <div className="space-y-1.5 pb-6">
          <h1 className="text-2xl font-semibold">Sign in to Console</h1>
          <p className="text-muted-foreground text-sm">
            Continue with your platform account.
          </p>
        </div>
        <Button className="w-full" disabled={loading} onClick={onSignIn}>
          {loading ? "Redirecting…" : "Continue with Keycloak"}
        </Button>
        {error ? (
          <p className="text-destructive mt-4 text-sm">{error}</p>
        ) : null}
      </div>
    </div>
  )
}
