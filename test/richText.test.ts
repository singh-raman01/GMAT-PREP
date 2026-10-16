import { describe, expect, test } from "bun:test"
import { mathIn, normalizeText, parseRichText, renderMath, renderProblem } from "../src/api/richText.ts"

describe("Question text", () => {
  test("paragraphs, line breaks, inline math, display math and emphasis are read; a dollar sign is text", () => {
    expect(parseRichText("A shirt costs $25 and \\(x^2\\) more.\nWhat is **x**?\n\n\\[ x = \\frac{1}{2} \\]\n\n*Note*: done.")).toEqual([
      {
        _tag: "Paragraph",
        inlines: [
          { _tag: "Text", text: "A shirt costs $25 and ", bold: false, italic: false },
          { _tag: "Math", tex: "x^2" },
          { _tag: "Text", text: " more.", bold: false, italic: false },
          { _tag: "Break" },
          { _tag: "Text", text: "What is ", bold: false, italic: false },
          { _tag: "Text", text: "x", bold: true, italic: false },
          { _tag: "Text", text: "?", bold: false, italic: false }
        ]
      },
      { _tag: "DisplayMath", tex: "x = \\frac{1}{2}" },
      {
        _tag: "Paragraph",
        inlines: [
          { _tag: "Text", text: "Note", bold: false, italic: true },
          { _tag: "Text", text: ": done.", bold: false, italic: false }
        ]
      }
    ])
    expect(mathIn("If \\(3x + 1 = 13\\), then \\[x = 4\\]")).toEqual([
      { tex: "3x + 1 = 13", display: false },
      { tex: "x = 4", display: true }
    ])
  })

  test("text whose math KaTeX can render passes, and the reason is given when it cannot", () => {
    expect(renderProblem("If \\(\\sqrt{x} = 3\\), what is \\(x\\)? It costs $5.")).toBeUndefined()
    expect(renderProblem("What is \\(\\frac{1}{\\)?")).toContain("\\(\\frac{1}{\\)")
    expect(renderProblem("What is \\(x^2 + 1?")).toContain("not closed")
    expect(renderProblem("\\[ x = 1")).toContain("not closed")
    expect(renderProblem("Links stay out: \\(\\href{https://example.com}{x}\\)")).toBeDefined()
  })

  test("the same Question written slightly differently compares equal", () => {
    expect(normalizeText("If \\(3x + 1 = 13\\),  what is **x**?")).toBe(normalizeText("if \\( 3x + 1 = 13 \\), What is x?"))
    expect(normalizeText("If \\(3x + 1 = 13\\)")).not.toBe(normalizeText("If \\(3x + 2 = 14\\)"))
    expect(normalizeText("\\(x^2 - 5x + 6 = 0\\)")).toBe(normalizeText("\\(x^2-5x+6=0\\)"))
    expect(normalizeText("\\(\\dfrac{3}{4}\\) of \\(20\\%\\)")).toBe(normalizeText("\\(\\frac{3}{4}\\) of \\(20%\\)"))
    expect(normalizeText("\\(\\left( a \\right)\\,b\\)")).toBe(normalizeText("\\((a)b\\)"))
    expect(normalizeText("\\(a \\leftarrow b\\)")).not.toBe(normalizeText("\\(a \\rightarrow b\\)"))
  })

  test("delimiters pair up, an escaped backslash is not one, and LaTeX outside them is caught", () => {
    expect(mathIn("A line break \\(a \\\\ b\\) stays inside")).toEqual([{ tex: "a \\\\ b", display: false }])
    expect(renderProblem("\\(a \\\\(b) c\\)")).toBeUndefined()
    expect(renderProblem("\\( a \\[ b \\] c \\)")).toContain("opened inside math")
    expect(renderProblem("It ends here \\] for no reason")).toContain("never opened")
    expect(renderProblem("What is $\\frac{3}{4}$ of it?")).toContain("LaTeX outside")
    expect(renderProblem("What is \\frac{3}{4} of it?")).toContain("LaTeX outside")
    expect(renderProblem("What is $x^2$ of it?")).toContain("LaTeX outside")
    expect(renderProblem("It costs $5 and $10.")).toBeUndefined()
  })

  test("KaTeX sizes are capped", () => {
    expect(renderProblem("\\(\\rule{30em}{4em}\\)")).toBeUndefined()
    expect(renderMath("\\rule{30em}{4em}", false)).toContain("border-right-width:10em")
  })
})
