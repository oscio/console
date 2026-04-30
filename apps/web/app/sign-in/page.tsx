import { fetchBranding, type Branding } from "@/lib/api"
import { SignInButton } from "./sign-in-button"

// Server component so the branding values (color/image/title/description)
// are baked into the HTML on first paint — admins manage them at
// /settings via the Branding section.
export default async function SignInPage() {
  let branding: Branding
  try {
    branding = await fetchBranding()
  } catch {
    // api unavailable / first-boot → fall back to plain Console.
    branding = { color: "", imageUrl: "", title: "Console", description: "" }
  }

  // Image takes precedence over color when both are set. background-size:
  // cover keeps the image's ratio while filling the panel — same as
  // CSS object-fit: cover.
  const asideStyle: React.CSSProperties = branding.imageUrl
    ? {
        backgroundImage: `linear-gradient(rgba(9,9,11,0.16), rgba(9,9,11,0.32)), url(${JSON.stringify(branding.imageUrl)})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }
    : {
        backgroundColor: branding.color || "#0f0f11",
      }

  return (
    <div className="bg-background flex min-h-svh items-center justify-center p-4">
      <div className="bg-card text-card-foreground grid w-full max-w-2xl overflow-hidden border sm:grid-cols-[1fr_1.5fr]">
        {/* Aside. On mobile this is a thin top bar with just the
            wordmark — description is hidden because it doesn't fit
            and the form is the priority. On sm+ it's the left column
            with both lines. */}
        <div aria-hidden className="sm:min-h-[28rem]" style={asideStyle}>
          <div className="p-5">
            <div className="text-xl leading-tight font-bold tracking-tight text-white">
              {branding.title}
            </div>
            {branding.description ? (
              <div className="mt-2 hidden max-w-xs text-sm leading-relaxed text-white/85 sm:block">
                {branding.description}
              </div>
            ) : null}
          </div>
        </div>

        <div className="p-5 sm:min-h-[28rem] sm:border-l sm:p-6">
          <div className="flex h-full flex-col justify-center">
            <h1 className="text-lg font-semibold tracking-tight">Sign in</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Continue with your platform account.
            </p>
            <SignInButton />
          </div>
        </div>
      </div>
    </div>
  )
}
