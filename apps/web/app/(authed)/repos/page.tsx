import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import { Badge } from "@workspace/ui/components/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { createRepo, deleteRepo, fetchRepos } from "@/lib/api"
import { LocalTime } from "@/components/local-time"
import { DeleteRepoButton, NewRepoForm } from "./new-repo-form"

async function createRepoAction(formData: FormData) {
  "use server"
  const cookieHeader = (await headers()).get("cookie") ?? ""
  const name = String(formData.get("name") ?? "").trim()
  if (!name) return { error: "name is required" }
  try {
    await createRepo(cookieHeader, { name })
  } catch (err) {
    return { error: (err as Error).message }
  }
  revalidatePath("/repos")
}

async function deleteRepoAction(formData: FormData) {
  "use server"
  const slug = String(formData.get("slug") ?? "")
  if (!slug) return
  const cookieHeader = (await headers()).get("cookie") ?? ""
  await deleteRepo(cookieHeader, slug)
  revalidatePath("/repos")
}

export default async function ReposPage() {
  const cookieHeader = (await headers()).get("cookie") ?? ""
  const repos = await fetchRepos(cookieHeader)

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Repos</h1>
          <p className="text-muted-foreground text-sm">
            Standalone Forgejo repos. Function-backed repos live under
            Functions; this page is for general-purpose code (project
            scaffolds, imported GitHub repos, scratch).
          </p>
        </div>
        {repos !== null && <NewRepoForm action={createRepoAction} />}
      </div>

      {repos === null ? (
        <p className="text-destructive text-sm">
          Not authenticated against the Repos API.
        </p>
      ) : (
        <div className="overflow-hidden border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Org</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Clone URL</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {repos.map((repo) => (
                <TableRow key={repo.id}>
                  <TableCell>
                    {repo.forgejoUrl ? (
                      <a
                        href={repo.forgejoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline"
                      >
                        {repo.name}
                      </a>
                    ) : (
                      repo.name
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">
                    {repo.forgejoOrg}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={repo.kind === "mine" ? "default" : "outline"}
                    >
                      {repo.kind === "mine" ? "Mine" : "Platform"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{repo.source}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {repo.cloneUrl}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    <LocalTime iso={repo.createdAt} />
                  </TableCell>
                  <TableCell className="text-right">
                    {repo.kind === "mine" ? (
                      <DeleteRepoButton
                        action={deleteRepoAction}
                        slug={repo.slug}
                      />
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {repos.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-muted-foreground py-6 text-center"
                  >
                    No repos yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
