import { useCallback } from "react"
import type { ScopeView } from "../../../src/api/Analytics.ts"
import { call } from "../api.ts"
import { levelText, paceText, plural, useReading } from "./reading.ts"

// The Skill map: every Skill and Question Type of each Section against the
// Section's level, its Weak Areas marked, those without enough answers said
// so, and those with no timed answers named together.

// How far from the Section's level a bar reaches at full length, in Ability.
const BarReach = 2

// A gap as a bar from the middle: left for below the Section's level, right
// for above.
const GapBar = ({ gap }: { readonly gap: number }) => {
  const share = Math.min(1, Math.abs(gap) / BarReach) * 50
  return (
    <span className="gap-bar" aria-hidden="true">
      <span className="gap-fill" style={gap > 0 ? { right: "50%", width: `${share}%` } : { left: "50%", width: `${share}%` }} />
      <span className="gap-middle" />
    </span>
  )
}

const scopeText = (scope: ScopeView) => {
  if (!scope.enough) return `Not enough data: ${scope.evidence} of the 8 Rated Responses it needs.`
  return `${levelText(scope.gap, scope.section.name)}, from ${plural(scope.evidence, "Rated Response", "Rated Responses")}.${
    scope.slow && scope.pace !== null ? ` Slow: right answers take ${paceText(scope.pace)}.` : ""
  }`
}

// Below the level with enough data: a Weak Area, as that list counts them.
const isWeak = (scope: ScopeView) => scope.enough && scope.gap > 0

const Row = ({ name, scope }: { readonly name: string; readonly scope: ScopeView }) => (
  <li className={scope.enough ? "map-row" : "map-row map-row-quiet"}>
    <span className="map-name">
      {isWeak(scope) ? <span className="mark">{name}</span> : name}
      {isWeak(scope) && <span className="visually-hidden">, a Weak Area</span>}
    </span>
    {scope.enough ? <GapBar gap={scope.gap} /> : <span className="gap-bar gap-bar-empty" aria-hidden="true" />}
    <span className="map-facts">{scopeText(scope)}</span>
  </li>
)

interface Entry {
  readonly id: string
  readonly name: string
  readonly scope: ScopeView | null
}

// A row for each one with timed answers; the rest named in one line, so a
// map with few answers yet stays short.
const Rows = ({ entries }: { readonly entries: ReadonlyArray<Entry> }) => {
  const answered = entries.flatMap((entry) => (entry.scope === null ? [] : [{ ...entry, scope: entry.scope }]))
  const unanswered = entries.filter((entry) => entry.scope === null)
  return (
    <>
      {answered.length > 0 && (
        <ul className="map-list">
          {answered.map((entry) => <Row key={entry.id} name={entry.name} scope={entry.scope} />)}
        </ul>
      )}
      {unanswered.length > 0 && (
        <p className="map-unanswered">No timed answers yet: {unanswered.map((entry) => entry.name).join(", ")}.</p>
      )}
    </>
  )
}

export const SkillMap = ({ onFailure }: { readonly onFailure: (failure: { readonly _tag: string }) => void }) => {
  const read = useCallback(() => call((client) => client.analytics.skillMap()), [])
  const view = useReading(read, onFailure)
  if (view === undefined) return <p className="quiet" aria-busy="true">Drawing your Skill map</p>
  return (
    <>
      <p className="group-about">
        Each Skill and Question Type against your level in its Section, from your timed answers. A bar to the left sits
        below your level, to the right above it; the ones marked are your Weak Areas.
      </p>
      {view.sections.map((section) => (
        <section key={section.section.id} className="group map-section" data-section={section.section.id} aria-labelledby={`map-${section.section.id}`}>
          <h2 id={`map-${section.section.id}`}>
            <span className="swatch" aria-hidden="true" /> {section.section.name}
          </h2>
          {section.questionTypes.every((each) => each.scope === null) &&
              section.topics.every((topic) => topic.skills.every((each) => each.scope === null))
            ? <p className="quiet">No timed answers in this Section yet.</p>
            : (
              <>
                <h3 className="map-topic">Question Types</h3>
                <Rows entries={section.questionTypes.map((each) => ({ id: each.questionType.id, name: each.questionType.name, scope: each.scope }))} />
                {section.topics.map((topic) => (
                  <div key={topic.topic.id}>
                    <h3 className="map-topic">{topic.topic.name}</h3>
                    <Rows entries={topic.skills.map((each) => ({ id: each.skill.id, name: each.skill.name, scope: each.scope }))} />
                  </div>
                ))}
              </>
            )}
        </section>
      ))}
    </>
  )
}
