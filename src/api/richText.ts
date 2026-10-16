import katex from "katex"

// Question text is a small part of Markdown with LaTeX math, shared by the
// server, which checks that every Question renders, and the web app, which
// shows it. Math sits between \( and \) inline and between \[ and \] on its
// own line. A dollar sign is plain text, since GMAT Questions are full of
// prices. Blank lines separate paragraphs; **bold** and *italic* mark words.

export type Inline =
  | { readonly _tag: "Text"; readonly text: string; readonly bold: boolean; readonly italic: boolean }
  | { readonly _tag: "Math"; readonly tex: string }
  | { readonly _tag: "Break" }

export type Block =
  | { readonly _tag: "Paragraph"; readonly inlines: ReadonlyArray<Inline> }
  | { readonly _tag: "DisplayMath"; readonly tex: string }

// Bold and italic within a run of plain text.
const emphasis = (text: string): ReadonlyArray<Inline> => {
  const result: Array<Inline> = []
  const pattern = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0
    if (start > last) result.push({ _tag: "Text", text: text.slice(last, start), bold: false, italic: false })
    const marked = match[0]
    result.push(
      marked.startsWith("**")
        ? { _tag: "Text", text: marked.slice(2, -2), bold: true, italic: false }
        : { _tag: "Text", text: marked.slice(1, -1), bold: false, italic: true }
    )
    last = start + marked.length
  }
  if (last < text.length) result.push({ _tag: "Text", text: text.slice(last), bold: false, italic: false })
  return result
}

// One paragraph's inline content: text, line breaks and inline math.
const inlines = (text: string): ReadonlyArray<Inline> => {
  const result: Array<Inline> = []
  const lines = text.split("\n")
  lines.forEach((line, index) => {
    if (index > 0) result.push({ _tag: "Break" })
    let rest = line
    for (;;) {
      const open = rest.indexOf("\\(")
      const close = open === -1 ? -1 : rest.indexOf("\\)", open + 2)
      if (open === -1 || close === -1) {
        result.push(...emphasis(rest))
        return
      }
      if (open > 0) result.push(...emphasis(rest.slice(0, open)))
      result.push({ _tag: "Math", tex: rest.slice(open + 2, close) })
      rest = rest.slice(close + 2)
    }
  })
  return result.filter((inline) => inline._tag !== "Text" || inline.text !== "")
}

export const parseRichText = (source: string): ReadonlyArray<Block> => {
  const blocks: Array<Block> = []
  // Display math first: it may span lines and stands as its own block.
  const parts = source.replace(/\r\n?/g, "\n").split(/\\\[([\s\S]*?)\\\]/)
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      blocks.push({ _tag: "DisplayMath", tex: part.trim() })
      return
    }
    for (const paragraph of part.split(/\n\s*\n/)) {
      const trimmed = paragraph.trim()
      if (trimmed !== "") blocks.push({ _tag: "Paragraph", inlines: inlines(trimmed) })
    }
  })
  return blocks
}

// Every piece of math in the text, in order.
export const mathIn = (source: string): ReadonlyArray<{ readonly tex: string; readonly display: boolean }> =>
  parseRichText(source).flatMap((block): ReadonlyArray<{ readonly tex: string; readonly display: boolean }> =>
    block._tag === "DisplayMath"
      ? [{ tex: block.tex, display: true }]
      : block.inlines.flatMap((inline) => (inline._tag === "Math" ? [{ tex: inline.tex, display: false }] : []))
  )

// KaTeX without anything that reaches outside the page, such as links or
// images. Such commands show as red text; refused names the ones used.
export const renderMath = (tex: string, display: boolean, refused: Array<string> = []): string =>
  katex.renderToString(tex, {
    throwOnError: true,
    strict: "ignore",
    output: "htmlAndMathml",
    displayMode: display,
    trust: (context) => {
      refused.push(context.command)
      return false
    }
  })

// Why the text does not render, or undefined when it does. Math left open,
// such as a \( with no \), is a failure too.
export const renderProblem = (source: string): string | undefined => {
  for (const { tex, display } of mathIn(source)) {
    try {
      const refused: Array<string> = []
      renderMath(tex, display, refused)
      if (refused.length > 0) return `${refused.join(", ")} cannot be used in a Question`
    } catch (error) {
      return `${display ? "\\[" : "\\("}${tex}${display ? "\\]" : "\\)"}: ${
        error instanceof Error ? error.message.replace(/^KaTeX parse error: /, "") : String(error)
      }`
    }
  }
  const unclosed = source.replace(/\\\[[\s\S]*?\\\]/g, "").split("\n").find((line) => {
    const opens = (line.match(/\\\(/g) ?? []).length
    const closes = (line.match(/\\\)/g) ?? []).length
    return opens !== closes
  })
  if (unclosed !== undefined) return `math opened with \\( is not closed with \\) in "${unclosed.trim().slice(0, 80)}"`
  if (/\\\[/.test(source.replace(/\\\[[\s\S]*?\\\]/g, ""))) return "math opened with \\[ is not closed with \\]"
  return undefined
}

// The text as compared when looking for the same Question: case, spacing,
// math delimiters and emphasis marks ignored.
export const normalizeText = (source: string) =>
  source
    .toLowerCase()
    .replace(/\\[()[\]]/g, " ")
    .replace(/\*+/g, "")
    .replace(/\\(?:left|right|,|;|!|quad)/g, "")
    .replace(/\s+/g, " ")
    .trim()
