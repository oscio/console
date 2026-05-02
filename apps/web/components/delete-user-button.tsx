"use client"

import { DeleteConfirmButton } from "@/components/delete-confirm-button"

export function DeleteUserButton({
  action,
  userId,
  label,
}: {
  action: (formData: FormData) => void | Promise<void>
  userId: string
  label: string
}) {
  return (
    <DeleteConfirmButton
      action={action}
      hiddenFields={{ userId }}
      title="Delete account?"
      description={
        <>
          Delete account <span className="font-mono">{label}</span>? This
          removes the user, their sessions, and any role bindings. Cannot
          be undone.
        </>
      }
    />
  )
}
