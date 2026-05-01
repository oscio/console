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
  fetchFunctions,
} from "@/lib/api"
import { LocalTime } from "@/components/local-time"
import { DeleteFunctionButton, NewFunctionForm } from "./new-function-form"

async function createFunctionAction(formData: FormData) {
  "use server"
  const cookieHeader = (await headers()).get("cookie") ?? ""
  const name = String(formData.get("name") ?? "").trim()
  const runtime = String(formData.get("runtime") ?? "node20") as FunctionRuntime
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
                    <Badge variant="outline">{fn.status}</Badge>
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
                    colSpan={6}
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
