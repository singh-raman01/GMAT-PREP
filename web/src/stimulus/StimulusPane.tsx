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
  const [chosen, setShown] = useState(0)
  // A tab past the end of these tabs is the last one.
  const shown = Math.min(chosen, tabs.length - 1)
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
// Stimulus, so their choices are not far below. Both layouts share one tree,
// so turning a tablet keeps the tab and the table's sort the Learner chose.
// position is the Question's place in its set.
export const StimulusPane = (
  { stimulus, position }: { readonly stimulus: StimulusView; readonly position: number }
) => {
  const title = useId()
  const body = useId()
  const wide = useWide()
  const same = JSON.stringify(stimulus)
  // Open for the first Question about it; folded for the next ones. The fold
  // changes while rendering the next Question, so the pane never shows open
  // first.
  const [open, setOpen] = useState(true)
  const [shown, setShown] = useState({ same, position })
  if (shown.position !== position) {
    setShown({ same, position })
    setOpen(shown.same !== same)
  }
  const shownNow = wide || open
  return (
    <section className="stimulus" aria-labelledby={title} tabIndex={wide ? 0 : undefined}>
      <h2 id={title} className="stimulus-title">
        {wide
          ? titles[stimulus.kind]
          : (
            <button
              type="button"
              className="stimulus-toggle"
              aria-expanded={open}
              aria-controls={body}
              onClick={() => setOpen(!open)}
            >
              {titles[stimulus.kind]}
            </button>
          )}
      </h2>
      <div id={body} className="stimulus-body" hidden={!shownNow}>
        {stimulus.kind === "tabs"
          ? <Tabs tabs={stimulus.tabs} />
          : <ContentOf content={stimulus} label={titles[stimulus.kind]} />}
      </div>
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
