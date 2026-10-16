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

// The source cut at its math delimiters. A backslash takes the character
// after it with it, so \\( is an escaped backslash and a parenthesis, not
// the start of math. Delimiters that do not pair up stay as text, and the
// first such problem is kept for the render check.
type Piece =
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Math"; readonly tex: string; readonly display: boolean }

const Opens: Readonly<Record<string, { readonly close: string; readonly display: boolean }>> = {
  "(": { close: ")", display: false },
  "[": { close: "]", display: true }
}

const holdsDelimiter = (tex: string) => {
  for (let i = 0; i < tex.length; i++) {
    if (tex[i] !== "\\") continue
    if ("()[]".includes(tex[i + 1] ?? "")) return true
    i++
  }
  return false
}

const scan = (source: string): { readonly pieces: ReadonlyArray<Piece>; readonly problem: string | undefined } => {
  const pieces: Array<Piece> = []
  let problem: string | undefined
  let text = ""
  const near = (at: number) => `"${source.slice(Math.max(0, at - 30), at + 30).replace(/\s+/g, " ").trim()}"`
  let i = 0
  while (i < source.length) {
    if (source[i] !== "\\" || i + 1 >= source.length) {
      text += source[i]
      i++
      continue
    }
    const next = source[i + 1]!
    const open = Opens[next]
    if (open === undefined) {
      if (next === ")" || next === "]") problem ??= `a \\${next} closes math that was never opened, near ${near(i)}`
      text += source.slice(i, i + 2)
      i += 2
      continue
    }
    // Inline math ends on its own line.
    let end = -1
    for (let j = i + 2; j < source.length; j++) {
      if (!open.display && source[j] === "\n") break
      if (source[j] !== "\\") continue
      if (source[j + 1] === open.close) {
        end = j
        break
      }
      j++
    }
    if (end === -1) {
      problem ??= `math opened with \\${next} is not closed with \\${open.close}, near ${near(i)}`
      text += source.slice(i, i + 2)
      i += 2
      continue
    }
    const tex = source.slice(i + 2, end)
    if (holdsDelimiter(tex)) problem ??= `math is opened inside math, near ${near(i)}`
    if (text !== "") pieces.push({ _tag: "Text", text })
    text = ""
    pieces.push({ _tag: "Math", tex, display: open.display })
    i = end + 2
  }
  if (text !== "") pieces.push({ _tag: "Text", text })
  return { pieces, problem }
}

// A paragraph's inlines without breaks or spaces at either end.
const tidyParagraph = (inlines: Array<Inline>): ReadonlyArray<Inline> => {
  while (inlines[0]?._tag === "Break") inlines.shift()
  while (inlines.at(-1)?._tag === "Break") inlines.pop()
  const first = inlines[0]
  if (first?._tag === "Text") inlines[0] = { ...first, text: first.text.trimStart() }
  const last = inlines.at(-1)
  if (last?._tag === "Text") inlines[inlines.length - 1] = { ...last, text: last.text.trimEnd() }
  return inlines.filter((inline) => inline._tag !== "Text" || inline.text !== "")
}

export const parseRichText = (source: string): ReadonlyArray<Block> => {
  const blocks: Array<Block> = []
  let paragraph: Array<Inline> = []
  const endParagraph = () => {
    const inlines = tidyParagraph(paragraph)
    if (inlines.length > 0) blocks.push({ _tag: "Paragraph", inlines })
    paragraph = []
  }
  for (const piece of scan(source.replace(/\r\n?/g, "\n")).pieces) {
    if (piece._tag === "Math") {
      if (piece.display) {
        endParagraph()
        blocks.push({ _tag: "DisplayMath", tex: piece.tex.trim() })
      } else {
        paragraph.push({ _tag: "Math", tex: piece.tex })
      }
      continue
    }
    piece.text.split(/\n[ \t]*\n\s*/).forEach((chunk, index) => {
      if (index > 0) endParagraph()
      chunk.split("\n").forEach((line, at) => {
        if (at > 0) paragraph.push({ _tag: "Break" })
        paragraph.push(...emphasis(line))
      })
    })
  }
  endParagraph()
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
// images. Such commands show as red text; refused names the ones used. Sizes
// are capped, so a rule or a space cannot cover the page.
const katexOptions = (display: boolean, refused: Array<string>) => ({
  throwOnError: true,
  strict: "ignore" as const,
  output: "htmlAndMathml" as const,
  displayMode: display,
  maxSize: 10,
  maxExpand: 1000,
  trust: (context: { readonly command: string }) => {
    refused.push(context.command)
    return false
  }
})

export const renderMath = (tex: string, display: boolean, refused: Array<string> = []): string =>
  katex.renderToString(tex, katexOptions(display, refused))

// KaTeX's tree before it becomes DOM nodes.
interface KatexNode {
  attributes?: Record<string, string>
  children?: Array<KatexNode>
  toNode(): Node
}

const renderToDomTree = (katex as unknown as {
  readonly __renderToDomTree: (tex: string, options: ReturnType<typeof katexOptions>) => KatexNode
}).__renderToDomTree

// KaTeX gives a few nodes a style attribute, such as the width of the arrow
// over a vector, and the content security policy refuses style attributes.
// Those styles are set through the DOM instead, which the policy allows.
const styleThroughDom = (node: KatexNode) => {
  const style = node.attributes?.["style"]
  if (style !== undefined) {
    delete node.attributes!["style"]
    const build = node.toNode.bind(node)
    node.toNode = () => {
      const built = build() as HTMLElement | SVGElement
      built.style.cssText = style
      return built
    }
  }
  node.children?.forEach(styleThroughDom)
}

// Renders into an element, as katex.render does, without style attributes.
export const renderMathInto = (element: HTMLElement, tex: string, display: boolean) => {
  const tree = renderToDomTree(tex, katexOptions(display, []))
  styleThroughDom(tree)
  element.replaceChildren(tree.toNode())
}

// LaTeX in plain text: a command, or math between dollar signs, which shows
// as raw LaTeX because only \( \) and \[ \] mark math.
const strayLatex = (text: string) =>
  /\\[a-zA-Z]+/.exec(text)?.[0] ?? /\$[^$\n]*[\\^_][^$\n]*\$/.exec(text)?.[0]

// Why the text does not render, or undefined when it does: delimiters that do
// not pair up, math KaTeX cannot render or that uses a refused command, and
// LaTeX outside the delimiters.
export const renderProblem = (source: string): string | undefined => {
  const { pieces, problem } = scan(source.replace(/\r\n?/g, "\n"))
  if (problem !== undefined) return problem
  for (const piece of pieces) {
    if (piece._tag === "Text") {
      const stray = strayLatex(piece.text)
      if (stray !== undefined) return `${stray} is LaTeX outside \\( \\) and \\[ \\], so it would show as typed`
      continue
    }
    const { tex, display } = piece
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
  return undefined
}

// The text as compared when looking for the same Question: case, spacing,
// math delimiters, emphasis marks and spacing commands ignored, and a few
// LaTeX spellings of the same thing made one.
export const normalizeText = (source: string) =>
  source
    .toLowerCase()
    .replace(/\\[()[\]]/g, " ")
    .replace(/\*+/g, "")
    .replace(/\\[dt]frac(?![a-z])/g, "\\frac")
    .replace(/\\([%$&#])/g, "$1")
    .replace(/\\(?:left|right|bigl|bigr|big|bigg)(?![a-z])/g, "")
    .replace(/\\(?:[,;:!]|(?:qquad|quad)(?![a-z]))/g, "")
    .replace(/~/g, "")
    .replace(/\s+/g, "")
