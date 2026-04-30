"use client"

import { useState } from "react"
import { Button } from "@workspace/ui/components/button"
import { signIn } from "@/lib/auth-client"

// Client island for the actual sign-in interaction; the surrounding
// page is server-rendered so branding values come baked into the
// HTML on first paint.
export function SignInButton() {
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
    <>
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
    </>
  )
}
