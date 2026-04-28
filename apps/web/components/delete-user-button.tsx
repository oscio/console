"use client"

// Client component so we can attach a window.confirm() to the form
// submit. The delete itself runs as a server action passed in by the
// server-rendered accounts page.
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
    <form
      action={action}
      onSubmit={(event) => {
        if (
          !window.confirm(
            `Delete account "${label}"? This removes the user, their sessions, and any role bindings. Cannot be undone.`,
          )
        ) {
          event.preventDefault()
        }
      }}
    >
      <input type="hidden" name="userId" value={userId} />
      <button
        type="submit"
        className="text-destructive hover:bg-destructive/10 rounded-md border px-2 py-1 text-xs"
      >
        Delete
      </button>
    </form>
  )
}
