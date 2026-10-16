import { useId, useRef, useState } from "react"
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

// The pane beside a Question. It scrolls on its own on a wide screen, so it
// takes focus for the keyboard to scroll it.
export const StimulusPane = ({ stimulus }: { readonly stimulus: StimulusView }) => {
  const title = useId()
  return (
    <section className="stimulus" aria-labelledby={title} tabIndex={0}>
      <h2 id={title} className="stimulus-title">{titles[stimulus.kind]}</h2>
      {stimulus.kind === "tabs"
        ? <Tabs tabs={stimulus.tabs} />
        : <ContentOf content={stimulus} label={titles[stimulus.kind]} />}
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
