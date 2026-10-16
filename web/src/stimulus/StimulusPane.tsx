import { useEffect, useId, useRef, useState } from "react"
import type { StimulusTab, StimulusView } from "../../../src/api/Stimulus.ts"
import { RichText } from "../RichText.tsx"
import { DataTable } from "./DataTable.tsx"

// What a Question asks about, in its own pane: a passage, a table, a chart
// with its data, a figure kept as a page image, or the tabs of a
// Multi-Source Reasoning set.

const titles: Record<StimulusView["kind"], string> = {
  passage: "The passage",
  table: "The table",
  chart: "The chart",
  figure: "The figure",
  tabs: "The sources"
}

type Content = Pick<StimulusView, "kind" | "body" | "dataset" | "image">

const ContentOf = ({ content, label }: { readonly content: Content; readonly label: string }) => (
  <>
    {content.body.trim() !== "" && <RichText source={content.body} />}
    {content.kind === "table" && content.dataset !== null && (
      <DataTable dataset={content.dataset} sortable caption={label} />
    )}
    {content.kind === "chart" && content.image !== null && (
      <>
        <img className="stimulus-image" src={content.image} alt={`${label}. Its data follows as a table.`} />
        {content.dataset !== null && (
          <details className="chart-data">
            <summary>The chart's data</summary>
            <DataTable dataset={content.dataset} sortable={false} caption={`${label}: its data`} />
          </details>
        )}
      </>
    )}
    {content.kind === "figure" && content.image !== null && (
      <img className="stimulus-image" src={content.image} alt={`${label}, as printed in the book.`} />
    )}
  </>
)

// The tabs of a set: one shows at a time; arrow keys move between them.
const Tabs = ({ tabs }: { readonly tabs: ReadonlyArray<StimulusTab> }) => {
  const [shown, setShown] = useState(0)
  const base = useId()
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const move = (to: number) => {
    const next = (to + tabs.length) % tabs.length
    setShown(next)
    buttons.current[next]?.focus()
  }
  return (
    <div className="stimulus-tabs">
      <div role="tablist" aria-label="Sources" className="tab-list">
        {tabs.map((tab, index) => (
          <button
            key={index}
            ref={(element) => {
              buttons.current[index] = element
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${index}`}
            aria-selected={index === shown}
            aria-controls={`${base}-panel-${index}`}
            tabIndex={index === shown ? 0 : -1}
            className="tab"
            onClick={() => setShown(index)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") move(index + 1)
              else if (event.key === "ArrowLeft") move(index - 1)
              else if (event.key === "Home") move(0)
              else if (event.key === "End") move(tabs.length - 1)
              else return
              event.preventDefault()
            }}
          >
            {tab.title}
          </button>
        ))}
      </div>
      {tabs.map((tab, index) => (
        <div
          key={index}
          role="tabpanel"
          id={`${base}-panel-${index}`}
          aria-labelledby={`${base}-tab-${index}`}
          hidden={index !== shown}
          className="tab-panel"
        >
          <ContentOf content={tab} label={tab.title} />
        </div>
      ))}
    </div>
  )
}

// Whether the screen is wide enough to show the pane beside its Question,
// as the styles do from 64rem.
const WideQuery = "(min-width: 64rem)"
const useWide = () => {
  const [wide, setWide] = useState(() => window.matchMedia(WideQuery).matches)
  useEffect(() => {
    const query = window.matchMedia(WideQuery)
    const change = () => setWide(query.matches)
    change()
    query.addEventListener("change", change)
    return () => query.removeEventListener("change", change)
  }, [])
  return wide
}

// The pane beside a Question. On a wide screen it scrolls on its own, so it
// takes focus for the keyboard to scroll it. On a narrow screen it stands
// above the Question, and folds away for the next Questions about the same
// Stimulus, so their choices are not far below. position is the Question's
// place in its set.
export const StimulusPane = (
  { stimulus, position }: { readonly stimulus: StimulusView; readonly position: number }
) => {
  const title = useId()
  const wide = useWide()
  const same = JSON.stringify(stimulus)
  // Open for the first Question about it; folded for the next ones.
  const [open, setOpen] = useState(true)
  const shown = useRef({ same, position })
  useEffect(() => {
    if (shown.current.position === position) return
    setOpen(shown.current.same !== same)
    shown.current = { same, position }
  }, [same, position])
  const heading = <h2 id={title} className="stimulus-title">{titles[stimulus.kind]}</h2>
  const content = stimulus.kind === "tabs"
    ? <Tabs tabs={stimulus.tabs} />
    : <ContentOf content={stimulus} label={titles[stimulus.kind]} />
  if (wide) {
    return (
      <section className="stimulus" aria-labelledby={title} tabIndex={0}>
        {heading}
        {content}
      </section>
    )
  }
  return (
    <section className="stimulus" aria-labelledby={title}>
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>{heading}</summary>
        {content}
      </details>
    </section>
  )
}

// The same, folded away, for screens that show it beside other work.
export const StimulusDetails = ({ stimulus }: { readonly stimulus: StimulusView }) => (
  <details className="stimulus-details">
    <summary>{titles[stimulus.kind]}</summary>
    {stimulus.kind === "tabs"
      ? <Tabs tabs={stimulus.tabs} />
      : <ContentOf content={stimulus} label={titles[stimulus.kind]} />}
  </details>
)
