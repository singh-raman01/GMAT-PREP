import { type ReactNode, useId, useLayoutEffect, useRef, useState } from "react"
import { onDisplayChanged } from "../display.ts"
import { labelledColumns, QuestionSteps, ticksAcross } from "./ticks.ts"

// The analytics' charts (docs/design.md, decision 78): drawn as SVG with the
// app's own colours, so they follow dark mode, each described in words for a
// screen reader and backed by a table of its numbers.

// A line's colour: a Section's, the ink of the page, or a quiet one for a
// guide such as an even pace.
export type Tone = "quant" | "verbal" | "di" | "ink" | "guide"

export interface LineSeries {
  readonly id: string
  readonly label: string
  readonly tone: Tone
  readonly points: ReadonlyArray<{ readonly x: number; readonly y: number }>
  // A range drawn around the line, as a Score Estimate's likely range.
  readonly band?: ReadonlyArray<{ readonly x: number; readonly low: number; readonly high: number }>
  readonly dashed?: boolean
}

export interface Marker {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly label: string
}

// A level to read the lines against, such as a target, drawn dashed across
// the chart.
export interface Guide {
  readonly id: string
  readonly y: number
  readonly label: string
}

// A chart is drawn as wide as it is shown, up to MaxWidth (the 40rem of
// .chart), in units that are a pixel at the standard text size and grow
// with a larger one. Its text, margins and label room grow with them, so
// they keep to the page's text on a phone as on a desktop.
const MaxWidth = 640
const MinWidth = 200
const Height = 260
const Margin = { top: 14, right: 16, bottom: 30, left: 44 }
const StandardRem = 16

// The room an axis label takes along the x axis, with space either side.
const LabelRoom = 90
const ColumnLabelRoom = 70

// A chart's width in its own units, for the width of its box and the root
// font size, both in CSS pixels.
export const chartWidth = (boxPx: number, remPx: number) =>
  Math.round(Math.min(MaxWidth, Math.max(MinWidth, (boxPx * StandardRem) / (remPx > 0 ? remPx : StandardRem))))

const useWidth = () => {
  const ref = useRef<SVGSVGElement>(null)
  const [width, setWidth] = useState(MaxWidth)
  useLayoutEffect(() => {
    const box = ref.current?.parentElement
    if (box === null || box === undefined) return
    const measure = () =>
      setWidth(chartWidth(box.clientWidth, parseFloat(getComputedStyle(document.documentElement).fontSize)))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    const stopFollowing = onDisplayChanged(measure)
    return () => {
      observer.disconnect()
      stopFollowing()
    }
  }, [])
  return [ref, width] as const
}

const scale = (domain: readonly [number, number], range: readonly [number, number]) => {
  const span = domain[1] - domain[0] || 1
  return (value: number) => range[0] + ((value - domain[0]) / span) * (range[1] - range[0])
}

export const LineChart = (
  { description, series, markers = [], guides = [], xDomain, xSteps = QuestionSteps, yDomain, xLabel, yTicks, yLabel }: {
    // What the chart shows, in words, for a screen reader.
    readonly description: string
    readonly series: ReadonlyArray<LineSeries>
    readonly markers?: ReadonlyArray<Marker>
    readonly guides?: ReadonlyArray<Guide>
    readonly xDomain: readonly [number, number]
    // The steps the x axis's labels may take, such as weeks for days.
    readonly xSteps?: ReadonlyArray<number>
    readonly yDomain: readonly [number, number]
    readonly xLabel: (x: number) => string
    readonly yTicks: ReadonlyArray<number>
    readonly yLabel?: (y: number) => string
  }
) => {
  const [ref, width] = useWidth()
  const x = scale(xDomain, [Margin.left, width - Margin.right])
  const y = scale(yDomain, [Height - Margin.bottom, Margin.top])
  const clampY = (value: number) => y(Math.min(yDomain[1], Math.max(yDomain[0], value)))
  const xTicks = ticksAcross(xDomain, Math.floor((width - Margin.left - Margin.right) / LabelRoom), xSteps)
  return (
    <svg ref={ref} className="chart" viewBox={`0 0 ${width} ${Height}`} role="img" aria-label={description}>
      {yTicks.map((tick) => (
        <g key={`y${tick}`} className="chart-grid">
          <line x1={Margin.left} x2={width - Margin.right} y1={y(tick)} y2={y(tick)} />
          <text x={Margin.left - 8} y={y(tick)} dy="0.35em" textAnchor="end">{yLabel?.(tick) ?? tick}</text>
        </g>
      ))}
      {xTicks.map((tick) => (
        <text key={`x${tick}`} className="chart-axis" x={x(tick)} y={Height - 8} textAnchor="middle">{xLabel(tick)}</text>
      ))}
      {series.map((each) =>
        each.band === undefined || each.band.length < 2 ? null : (
          <path
            key={`band-${each.id}`}
            className={`chart-band tone-${each.tone}`}
            d={[
              ...each.band.map((point, index) => `${index === 0 ? "M" : "L"}${x(point.x)},${clampY(point.high)}`),
              ...each.band.toReversed().map((point) => `L${x(point.x)},${clampY(point.low)}`),
              "Z"
            ].join(" ")}
          />
        )
      )}
      {guides.map((guide) => (
        <g key={`guide-${guide.id}`} className="chart-line tone-guide dashed">
          <polyline points={`${Margin.left},${clampY(guide.y)} ${width - Margin.right},${clampY(guide.y)}`} />
          <title>{guide.label}</title>
        </g>
      ))}
      {series.map((each) => (
        <g key={each.id} className={`chart-line tone-${each.tone}${each.dashed === true ? " dashed" : ""}`}>
          {each.points.length > 1 && (
            <polyline points={each.points.map((point) => `${x(point.x)},${clampY(point.y)}`).join(" ")} />
          )}
          {each.points.length <= 40 && each.points.map((point) => <circle key={point.x} cx={x(point.x)} cy={clampY(point.y)} r={3} />)}
        </g>
      ))}
      {markers.map((marker) => (
        <g key={marker.id} className="chart-marker">
          <circle cx={x(marker.x)} cy={clampY(marker.y)} r={6} />
          <title>{marker.label}</title>
        </g>
      ))}
    </svg>
  )
}

// A key to the lines, in words beside their colours.
export const Legend = ({ series }: { readonly series: ReadonlyArray<Pick<LineSeries, "id" | "label" | "tone" | "dashed">> }) => (
  <ul className="chart-legend">
    {series.map((each) => (
      <li key={each.id}>
        <svg viewBox="0 0 24 8" aria-hidden="true" className={`chart-line tone-${each.tone}${each.dashed === true ? " dashed" : ""}`}>
          <polyline points="0,4 24,4" />
        </svg>
        {each.label}
      </li>
    ))}
  </ul>
)

// Columns, one a day or week, for a count such as minutes studied.
export const ColumnChart = (
  { description, columns, yTicks, highlight }: {
    readonly description: string
    readonly columns: ReadonlyArray<{ readonly key: string; readonly label: string; readonly value: number }>
    readonly yTicks: ReadonlyArray<number>
    // The column to mark, such as today.
    readonly highlight?: string
  }
) => {
  const [ref, width] = useWidth()
  const top = Math.max(...yTicks, ...columns.map((column) => column.value), 1)
  const y = scale([0, top], [Height - Margin.bottom, Margin.top])
  const slot = (width - Margin.left - Margin.right) / Math.max(1, columns.length)
  const labelled = labelledColumns(columns.length, Math.floor((width - Margin.left - Margin.right) / ColumnLabelRoom))
  return (
    <svg ref={ref} className="chart" viewBox={`0 0 ${width} ${Height}`} role="img" aria-label={description}>
      {yTicks.map((tick) => (
        <g key={tick} className="chart-grid">
          <line x1={Margin.left} x2={width - Margin.right} y1={y(tick)} y2={y(tick)} />
          <text x={Margin.left - 8} y={y(tick)} dy="0.35em" textAnchor="end">{tick}</text>
        </g>
      ))}
      {columns.map((column, index) => (
        <g key={column.key}>
          <rect
            className={column.key === highlight ? "chart-column chart-column-now" : "chart-column"}
            x={Margin.left + index * slot + slot * 0.15}
            width={slot * 0.7}
            y={y(column.value)}
            height={Math.max(0, y(0) - y(column.value))}
          />
          {labelled.has(index) && (
            <text className="chart-axis" x={Margin.left + index * slot + slot / 2} y={Height - 8} textAnchor="middle">
              {column.label}
            </text>
          )}
        </g>
      ))}
    </svg>
  )
}

// A chart with its title, and its numbers folded below it.
export const Figure = (
  { title, chart, legend, numbers }: {
    readonly title: string
    readonly chart: ReactNode
    readonly legend?: ReactNode
    readonly numbers: ReactNode
  }
) => {
  const id = useId()
  return (
    <figure className="figure" aria-labelledby={id}>
      <figcaption id={id} className="figure-title">{title}</figcaption>
      {chart}
      {legend}
      <details className="figure-numbers">
        <summary>The numbers</summary>
        <div className="data-table-wrap">{numbers}</div>
      </details>
    </figure>
  )
}

// A share as a bar, for lists of paces or accuracy: the bar is drawn from
// the value over the largest, with a mark where the reference falls.
export const Bar = ({ value, max, reference, tone = "ink" }: {
  readonly value: number
  readonly max: number
  readonly reference?: number
  readonly tone?: Tone
}) => (
  <span className={`bar tone-${tone}`} aria-hidden="true">
    <span className="bar-fill" style={{ width: `${Math.min(100, (100 * value) / Math.max(max, 1e-9))}%` }} />
    {reference !== undefined && <span className="bar-reference" style={{ left: `${Math.min(100, (100 * reference) / Math.max(max, 1e-9))}%` }} />}
  </span>
)
