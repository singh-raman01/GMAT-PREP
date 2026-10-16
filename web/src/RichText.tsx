import { Fragment, type RefObject, useLayoutEffect, useMemo, useRef } from "react"
import { type Inline, parseRichText, renderMath, renderMathInto } from "../../src/api/richText.ts"

// Question text on screen: paragraphs, line breaks, emphasis and KaTeX math.
// KaTeX is given no commands that reach outside the page.

const MathPiece = ({ tex, display }: { readonly tex: string; readonly display: boolean }) => {
  const renders = useMemo(() => {
    try {
      renderMath(tex, display)
      return true
    } catch {
      return false
    }
  }, [tex, display])
  const ref = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    if (renders && ref.current !== null) renderMathInto(ref.current, tex, display)
  }, [renders, tex, display])
  if (!renders) return <code className="math-error">{tex}</code>
  return display
    ? <div ref={ref as RefObject<HTMLDivElement>} className="math-display" />
    : <span ref={ref as RefObject<HTMLSpanElement>} />
}

const InlineText = ({ inline }: { readonly inline: Inline }) => {
  switch (inline._tag) {
    case "Break":
      return <br />
    case "Math":
      return <MathPiece tex={inline.tex} display={false} />
    case "Text": {
      const text = inline.bold ? <strong>{inline.text}</strong> : <>{inline.text}</>
      return inline.italic ? <em>{text}</em> : text
    }
  }
}

export const RichText = ({ source, className }: { readonly source: string; readonly className?: string }) => {
  const blocks = useMemo(() => parseRichText(source), [source])
  return (
    <div className={className === undefined ? "rich-text" : `rich-text ${className}`}>
      {blocks.map((block, index) =>
        block._tag === "DisplayMath"
          ? <MathPiece key={index} tex={block.tex} display />
          : (
            <p key={index}>
              {block.inlines.map((inline, at) => (
                <Fragment key={at}>
                  <InlineText inline={inline} />
                </Fragment>
              ))}
            </p>
          )
      )}
    </div>
  )
}

// Text that runs inline, such as an answer choice: one paragraph's worth.
export const RichInline = ({ source }: { readonly source: string }) => {
  const blocks = useMemo(() => parseRichText(source), [source])
  return (
    <>
      {blocks.map((block, index) =>
        block._tag === "DisplayMath"
          ? <MathPiece key={index} tex={block.tex} display />
          : block.inlines.map((inline, at) => (
            <Fragment key={`${index}-${at}`}>
              <InlineText inline={inline} />
            </Fragment>
          ))
      )}
    </>
  )
}
