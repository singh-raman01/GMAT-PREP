import { Fragment, type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useState } from "react"
import type { TaxonomySection, TaxonomyView } from "../../src/api/Taxonomy.ts"
import { call } from "./api.ts"
import { findInTaxonomy, highlight, searchTerms } from "./search.ts"

interface Props {
  readonly onSessionLost: () => void
  readonly onStopped: (error: { readonly _tag: string }) => void
}

// Question Type id to its name and the Section that asks it.
type TypeIndex = ReadonlyMap<string, { readonly name: string; readonly section: string }>

const MistakesTab = "mistakes"

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

const hashTab = () => decodeURIComponent(window.location.hash.slice(1))

export const TaxonomyBrowser = ({ onSessionLost, onStopped }: Props) => {
  const [view, setView] = useState<TaxonomyView>()
  const [tab, setTab] = useState(hashTab)
  const [query, setQuery] = useState("")
  const searchId = useId()

  useEffect(() => {
    let live = true
    void call((client) => client.taxonomy.current()).then((result) => {
      if (!live) return
      if (result._tag === "Success") setView(result.success)
      else if (result.failure._tag === "NotUnlocked") onSessionLost()
      else onStopped(result.failure)
    })
    return () => {
      live = false
    }
  }, [onSessionLost, onStopped])

  useEffect(() => {
    const follow = () => setTab(hashTab())
    window.addEventListener("hashchange", follow)
    return () => window.removeEventListener("hashchange", follow)
  }, [])

  const types: TypeIndex = useMemo(
    () =>
      new Map(
        (view?.sections ?? []).flatMap((section) =>
          section.questionTypes.map((type) => [type.id, { name: type.name, section: section.id }] as const)
        )
      ),
    [view]
  )

  if (view === undefined) {
    return (
      <>
        <h1>What the GMAT tests</h1>
        <p className="lede quiet" aria-busy="true">Loading the taxonomy</p>
      </>
    )
  }

  const tabIds = [...view.sections.map((section) => section.id), MistakesTab]
  const current = tabIds.includes(tab) ? tab : tabIds[0]!
  const section = view.sections.find((candidate) => candidate.id === current)
  const searching = searchTerms(query).length > 0
  const c = view.counts

  const select = (id: string) => {
    setTab(id)
    window.history.replaceState(null, "", `#${id}`)
  }

  const moveTab = (event: KeyboardEvent<HTMLButtonElement>) => {
    const at = tabIds.indexOf(current)
    const next = event.key === "ArrowRight"
      ? (at + 1) % tabIds.length
      : event.key === "ArrowLeft"
      ? (at - 1 + tabIds.length) % tabIds.length
      : event.key === "Home"
      ? 0
      : event.key === "End"
      ? tabIds.length - 1
      : undefined
    if (next === undefined) return
    event.preventDefault()
    const id = tabIds[next]!
    select(id)
    document.getElementById(`tab-${id}`)?.focus()
  }

  return (
    <>
      <h1>What the GMAT tests</h1>
      <p className="lede">
        Taxonomy version {view.version} has {count(c.sections, "section", "sections")},{" "}
        {count(c.topics, "topic", "topics")}, {count(c.skills, "skill", "skills")},{" "}
        {count(c.questionTypes, "question type", "question types")},{" "}
        {count(c.mistakeTypes, "mistake type", "mistake types")},{" "}
        {count(c.trapPatterns, "trap pattern", "trap patterns")} and{" "}
        {count(c.strategies, "strategy", "strategies")}.
      </p>

      <div className="search">
        <label htmlFor={searchId}>Find a skill, trap or strategy</label>
        <input
          id={searchId}
          type="search"
          autoComplete="off"
          spellCheck={false}
          placeholder="For example, remainder"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setQuery("")
          }}
        />
      </div>

      {searching ? <Results view={view} query={query} /> : (
        <>
          <div className="tabs" role="tablist" aria-label="Sections and mistake types">
            {tabIds.map((id) => {
              const named = view.sections.find((candidate) => candidate.id === id)
              const selected = id === current
              return (
                <button
                  key={id}
                  id={`tab-${id}`}
                  type="button"
                  role="tab"
                  className={named === undefined ? "tab tab-aside" : "tab"}
                  data-section={named?.id}
                  aria-selected={selected}
                  aria-controls={`panel-${id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => select(id)}
                  onKeyDown={moveTab}
                >
                  {named !== undefined && <span className="swatch" aria-hidden="true" />}
                  <span className={selected ? "tab-label mark" : "tab-label"}>{named?.name ?? "Mistake types"}</span>
                </button>
              )
            })}
          </div>
          <div className="panel" id={`panel-${current}`} role="tabpanel" aria-labelledby={`tab-${current}`} tabIndex={0}>
            {section === undefined
              ? (
                <Group
                  title="Mistake types"
                  about={`${
                    count(c.mistakeTypes, "reason", "reasons")
                  } an answer goes wrong. The app labels each wrong answer with one of them.`}
                >
                  <ul className="entries">
                    {view.mistakeTypes.map((mistake) => (
                      <Entry key={mistake.id} name={mistake.name} description={mistake.description} level={3} />
                    ))}
                  </ul>
                </Group>
              )
              : <SectionPanel section={section} types={types} />}
          </div>
        </>
      )}
    </>
  )
}

const SectionPanel = ({ section, types }: { readonly section: TaxonomySection; readonly types: TypeIndex }) => {
  const skills = section.topics.reduce((total, topic) => total + topic.skills.length, 0)
  return (
    <>
      <Group
        title="Question types"
        about={`${count(section.questionTypes.length, "format", "formats")} this section asks in.`}
      >
        <ul className="entries">
          {section.questionTypes.map((type) => (
            <Entry key={type.id} name={type.name} description={type.description} level={3} />
          ))}
        </ul>
      </Group>
      <Group
        title="Topics and skills"
        about={`${count(skills, "skill", "skills")} in ${
          count(section.topics.length, "topic", "topics")
        }. A skill can also appear in another section's questions.`}
      >
        {section.topics.map((topic) => (
          <div className="topic" key={topic.id}>
            <h3 className="topic-name">{topic.name}</h3>
            <ul className="entries">
              {topic.skills.map((skill) => (
                <Entry key={skill.id} name={skill.name} description={skill.description} level={4}>
                  <UsedIn label="Used in" ids={skill.appliesTo} types={types} />
                </Entry>
              ))}
            </ul>
          </div>
        ))}
      </Group>
      <Group
        title="Trap patterns"
        about={`${count(section.trapPatterns.length, "way", "ways")} a wrong option is made to look right.`}
      >
        <ul className="entries">
          {section.trapPatterns.map((trap) => (
            <Entry key={trap.id} name={trap.name} description={trap.description} level={3}>
              <UsedIn label="Seen in" ids={trap.appliesTo} types={types} />
            </Entry>
          ))}
        </ul>
      </Group>
      <Group
        title="Strategies"
        about={`${count(section.strategies.length, "method", "methods")} for solving, each with when it works.`}
      >
        <ul className="entries">
          {section.strategies.map((strategy) => (
            <Entry key={strategy.id} name={strategy.name} description={strategy.description} level={3}>
              <p className="entry-when">
                <span className="when-label">Use when:</span> {strategy.validWhen}
              </p>
              <UsedIn label="Used in" ids={strategy.appliesTo} types={types} />
            </Entry>
          ))}
        </ul>
      </Group>
    </>
  )
}

const Group = ({ title, about, children }: { readonly title: string; readonly about: string; readonly children: ReactNode }) => {
  const id = useId()
  return (
    <section className="group" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      <p className="group-about">{about}</p>
      {children}
    </section>
  )
}

interface EntryProps {
  readonly name: ReactNode
  readonly description: ReactNode
  readonly level: 3 | 4
  readonly children?: ReactNode
}

const Entry = ({ name, description, level, children }: EntryProps) => {
  const Heading = level === 3 ? "h3" : "h4"
  return (
    <li className="entry">
      <Heading className="entry-name">{name}</Heading>
      <p className="entry-text">{description}</p>
      {children}
    </li>
  )
}

const UsedIn = ({ label, ids, types }: { readonly label: string; readonly ids: ReadonlyArray<string>; readonly types: TypeIndex }) =>
  ids.length === 0 ? null : (
    <div className="used-in">
      <span className="used-in-label">{label}</span>
      <ul className="type-list">
        {ids.map((id) => {
          const type = types.get(id)
          return (
            <li key={id} data-section={type?.section}>
              <span className="swatch" aria-hidden="true" />
              {type?.name ?? id}
            </li>
          )
        })}
      </ul>
    </div>
  )

const Marked = ({ text, terms }: { readonly text: string; readonly terms: ReadonlyArray<string> }) => (
  <>
    {highlight(text, terms).map((segment, index) =>
      segment.marked ? <mark key={index}>{segment.text}</mark> : <Fragment key={index}>{segment.text}</Fragment>
    )}
  </>
)

const Results = ({ view, query }: { readonly view: TaxonomyView; readonly query: string }) => {
  const terms = searchTerms(query)
  const groups = findInTaxonomy(view, query)
  const total = groups.reduce((sum, group) => sum + group.hits.length, 0)
  return (
    <div className="results">
      <p className="result-count" role="status">
        {total === 0 ? "Nothing matches. Try a shorter or different word." : `${count(total, "entry matches", "entries match")}.`}
      </p>
      {groups.map((group) => (
        <section
          key={group.id}
          className="group"
          data-section={group.id === MistakesTab ? undefined : group.id}
          aria-labelledby={`results-${group.id}`}
        >
          <h2 id={`results-${group.id}`} className="results-title">
            {group.id !== MistakesTab && <span className="swatch" aria-hidden="true" />}
            {group.name}
          </h2>
          <ul className="entries">
            {group.hits.map((hit) => (
              <li key={hit.key} className="entry">
                <h3 className="entry-name">
                  <Marked text={hit.name} terms={terms} />
                </h3>
                <p className="entry-context">
                  <Marked text={hit.context} terms={terms} />
                </p>
                <p className="entry-text">
                  <Marked text={hit.description} terms={terms} />
                </p>
                {hit.validWhen !== undefined && (
                  <p className="entry-when">
                    <span className="when-label">Use when:</span> <Marked text={hit.validWhen} terms={terms} />
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
