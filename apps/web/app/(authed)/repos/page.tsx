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
import { fetchRepos } from "@/lib/api"
import { LocalTime } from "@/components/local-time"

export default async function ReposPage() {
  const cookieHeader = (await headers()).get("cookie") ?? ""
  const repos = await fetchRepos(cookieHeader)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Repos</h1>
        <p className="text-muted-foreground text-sm">
          Standalone Forgejo repos. Function-backed repos live under
          Functions; this page is for general-purpose code (project
          scaffolds, imported GitHub repos, scratch).
        </p>
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
                <TableHead>ID</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Clone URL</TableHead>
                <TableHead>Created</TableHead>
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
                    {repo.slug}
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
                </TableRow>
              ))}
              {repos.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={5}
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
