import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import Link from "next/link"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import {
  type FunctionRuntime,
  createFunction,
  deleteFunction,
  fetchFunctionRuntime,
  fetchFunctions,
  isDeployed,
} from "@/lib/api"
import { LocalTime } from "@/components/local-time"
import { DeleteFunctionButton, NewFunctionForm } from "./new-function-form"

async function createFunctionAction(formData: FormData) {
  "use server"
  const cookieHeader = (await headers()).get("cookie") ?? ""
  const name = String(formData.get("name") ?? "").trim()
  const runtime = String(formData.get("runtime") ?? "python3.12") as FunctionRuntime
  if (!name) return { error: "name is required" }
  try {
    await createFunction(cookieHeader, { name, runtime })
  } catch (err) {
    return { error: (err as Error).message }
  }
  revalidatePath("/services/functions")
}

async function deleteFunctionAction(formData: FormData) {
  "use server"
  const slug = String(formData.get("slug") ?? "")
  if (!slug) return
  const cookieHeader = (await headers()).get("cookie") ?? ""
  await deleteFunction(cookieHeader, slug)
  revalidatePath("/services/functions")
}

export default async function FunctionsPage() {
  const cookieHeader = (await headers()).get("cookie") ?? ""
  const fns = await fetchFunctions(cookieHeader)
  // Pull the live lifecycle for each row so the Status badge reflects
  // build/deploy state, not a hardcoded "Draft". Each call hits Forgejo
  // + Knative, so they run in parallel; an individual failure resolves
  // to "unknown" rather than failing the whole page.
  const deployed: Record<string, boolean> = {}
  if (fns) {
    const results = await Promise.all(
      fns.map((f) =>
        fetchFunctionRuntime(cookieHeader, f.slug)
          .then((r) => [f.slug, isDeployed(r)] as const)
          .catch(() => [f.slug, false] as const),
      ),
    )
    for (const [slug, d] of results) deployed[slug] = d
  }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Functions</h1>
          <p className="text-muted-foreground text-sm">
            Lambda-style serverless functions. Phase 1 is metadata only —
            execution runtime lands in a follow-up.
          </p>
        </div>
        {fns !== null && <NewFunctionForm action={createFunctionAction} />}
      </div>

      {fns === null ? (
        <p className="text-destructive text-sm">
          Not authenticated against the Functions API.
        </p>
      ) : (
        <div className="overflow-hidden border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>ID</TableHead>
                <TableHead>Runtime</TableHead>
                <TableHead>Exposure</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {fns.map((fn) => (
                <TableRow key={fn.id}>
                  <TableCell>
                    <Link
                      href={`/services/functions/${fn.slug}`}
                      className="hover:underline"
                    >
                      {fn.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">
                    {fn.slug}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{fn.runtime}</Badge>
                  </TableCell>
                  <TableCell>
                    {deployed[fn.slug] ? (
                      <Badge variant={fn.exposed ? "default" : "outline"}>
                        {fn.exposed ? "Public URL" : "Internal"}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {deployed[fn.slug] ? (
                      <Badge variant="default">Deployed</Badge>
                    ) : (
                      <Badge variant="outline">Draft</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    <LocalTime iso={fn.createdAt} />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/services/functions/${fn.slug}`}>
                          Open
                        </Link>
                      </Button>
                      <DeleteFunctionButton
                        action={deleteFunctionAction}
                        slug={fn.slug}
                        label={fn.name}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {fns.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-muted-foreground py-6 text-center"
                  >
                    No functions yet.
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
