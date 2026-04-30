// Browser-safe markdown → CLI-style text renderer.
//
// Goal: turn an assistant message that is markdown into something
// that reads like terminal output — Unicode box-drawing tables,
// list bullets, indented code blocks, no fancy fonts. Then a <pre
// font-mono> prints it. No Node-only deps so it ships cleanly to
// the browser (only `marked` for the lexer).
//
// Anything we don't recognize falls back to the token's `raw`
// string so worst case we get the original markdown back, never a
// crash. Caller wraps the whole call in try/catch as a final
// safety net.

import { marked, type Tokens } from "marked"

const CHAR_WIDTH_FALLBACK = 1

// Visual width approximation. JS string length counts UTF-16 code
// units, which double-counts surrogate pairs (most emoji) and
// ignores wide CJK. cli-table3 pulls in `string-width`; we don't
// want the dep, so use a quick heuristic: full-width CJK +
// fullwidth forms count as 2, surrogate pairs as 2, the rest as 1.
function visualWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp > 0xffff) {
      w += 2
      continue
    }
    if (
      (cp >= 0x1100 && cp <= 0x115f) || // Hangul jamo
      (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals … punctuation
      (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana / katakana / CJK
      (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
      (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility
      (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
      (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
      (cp >= 0xffe0 && cp <= 0xffe6)
    ) {
      w += 2
    } else {
      w += CHAR_WIDTH_FALLBACK
    }
  }
  return w
}

function pad(s: string, target: number): string {
  return s + " ".repeat(Math.max(0, target - visualWidth(s)))
}

// Concatenate inline tokens (bold/italic/code/text/...) into a flat
// string. We don't try to reproduce ANSI styling — mono is the only
// distinction we keep.
function renderInline(tokens: readonly Tokens.Generic[]): string {
  let out = ""
  for (const tok of tokens) {
    switch (tok.type) {
      case "text":
        out += (tok as Tokens.Text).text
        break
      case "strong":
      case "em":
      case "del":
        out += renderInline((tok as Tokens.Strong).tokens ?? [])
        break
      case "codespan":
        out += "`" + (tok as Tokens.Codespan).text + "`"
        break
      case "br":
        out += "\n"
        break
      case "link": {
        const t = tok as Tokens.Link
        const inner = renderInline(t.tokens ?? [])
        out += `${inner} (${t.href})`
        break
      }
      case "image": {
        const t = tok as Tokens.Image
        out += `[image: ${t.text || t.href}]`
        break
      }
      case "html":
        out += (tok as Tokens.HTML).text ?? (tok as { raw?: string }).raw ?? ""
        break
      case "escape":
        out += (tok as Tokens.Escape).text
        break
      default: {
        const t = tok as { tokens?: Tokens.Generic[]; text?: string; raw?: string }
        if (t.tokens) out += renderInline(t.tokens)
        else if (typeof t.text === "string") out += t.text
        else if (typeof t.raw === "string") out += t.raw
      }
    }
  }
  return out
}

// Wrap with full Unicode box-drawing borders. Cells are padded to
// the max visualWidth in their column.
function renderTable(token: Tokens.Table): string {
  const headerCells = token.header.map((c) => renderInline(c.tokens ?? []))
  const rowCells = token.rows.map((row) =>
    row.map((c) => renderInline(c.tokens ?? [])),
  )
  const ncols = headerCells.length
  const widths: number[] = []
  for (let i = 0; i < ncols; i++) {
    let w = visualWidth(headerCells[i] ?? "")
    for (const row of rowCells) {
      w = Math.max(w, visualWidth(row[i] ?? ""))
    }
    widths.push(w)
  }
  const dash = (w: number) => "─".repeat(w + 2)
  const top = "┌" + widths.map(dash).join("┬") + "┐"
  const sep = "├" + widths.map(dash).join("┼") + "┤"
  const bot = "└" + widths.map(dash).join("┴") + "┘"
  const formatRow = (cells: string[]) =>
    "│" +
    cells
      .map((c, i) => " " + pad(c ?? "", widths[i] ?? 0) + " ")
      .join("│") +
    "│"
  const lines = [top, formatRow(headerCells), sep]
  for (const row of rowCells) lines.push(formatRow(row))
  lines.push(bot)
  return lines.join("\n")
}

function renderToken(token: Tokens.Generic): string {
  switch (token.type) {
    case "heading": {
      const t = token as Tokens.Heading
      return (
        "\n" +
        "#".repeat(t.depth) +
        " " +
        renderInline(t.tokens) +
        "\n\n"
      )
    }
    case "paragraph":
      return renderInline((token as Tokens.Paragraph).tokens) + "\n\n"
    case "blockquote": {
      const t = token as Tokens.Blockquote
      const inner = (t.tokens ?? []).map(renderToken).join("")
      return inner
        .split("\n")
        .map((l) => (l ? "│ " + l : ""))
        .join("\n") + "\n"
    }
    case "list": {
      const t = token as Tokens.List
      const lines: string[] = []
      let n = t.start === "" || t.start == null ? 1 : Number(t.start)
      for (const item of t.items) {
        const bullet = t.ordered ? `${n}. ` : "• "
        const body = renderInline(
          (item as Tokens.ListItem).tokens ?? [],
        ).replace(/\n+$/, "")
        const [first, ...rest] = body.split("\n")
        lines.push(bullet + (first ?? ""))
        const indent = " ".repeat(bullet.length)
        for (const r of rest) lines.push(indent + r)
        if (t.ordered) n++
      }
      return lines.join("\n") + "\n\n"
    }
    case "code": {
      const t = token as Tokens.Code
      const body = (t.text ?? "")
        .split("\n")
        .map((l) => "  " + l)
        .join("\n")
      return "\n" + body + "\n\n"
    }
    case "table":
      return "\n" + renderTable(token as Tokens.Table) + "\n\n"
    case "hr":
      return "─".repeat(60) + "\n\n"
    case "html":
      return (token as Tokens.HTML).text ?? (token as { raw?: string }).raw ?? ""
    case "space":
      return ""
    case "text":
      return (token as Tokens.Text).text + "\n"
    default: {
      const t = token as { tokens?: Tokens.Generic[]; raw?: string; text?: string }
      if (t.tokens) return renderInline(t.tokens)
      if (typeof t.text === "string") return t.text
      return t.raw ?? ""
    }
  }
}

export function renderMarkdownAsCli(md: string): string {
  if (!md) return ""
  const tokens = marked.lexer(md)
  let out = ""
  for (const tok of tokens) out += renderToken(tok)
  // Collapse triple newlines from over-eager "\n\n" appends.
  return out.replace(/\n{3,}/g, "\n\n").trimEnd()
}
