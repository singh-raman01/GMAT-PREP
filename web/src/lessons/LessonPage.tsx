import { useCallback, useEffect, useRef, useState } from "react"
import type { LessonListItem, LessonPart, LessonView } from "../../../src/api/Lessons.ts"
import type { PracticeQuestion } from "../../../src/api/Practice.ts"
import { call } from "../api.ts"
import { useFocusOnMount, useFocusWhenReady } from "../focus.ts"
import { dayAndTime } from "../format.ts"
import { AnswerParts } from "../practice/Parts.tsx"
import { useReading } from "../progress/reading.ts"
import { RichInline, RichText } from "../RichText.tsx"
import { linkProps, navigate } from "../router.ts"
import { StimulusDetails } from "../stimulus/StimulusPane.tsx"
import { lessonPath } from "./paths.ts"

// Lessons (docs/design.md, decisions 93 to 102): the approved ones by
// Section, and one Lesson to read, whole or its methods alone, with its
// check.

interface Props {
  readonly onSessionLost: () => void
  readonly onStopped: (error: { readonly _tag: string }) => void
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
const minutesText = (minutes: number) => plural(minutes, "minute", "minutes")

// The approved Lessons, by Section, then Topic, Question Types last.
export const LessonsIndex = ({ onSessionLost, onStopped }: Props) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const handle = useCallback(
    (failure: { readonly _tag: string }) => (failure._tag === "NotUnlocked" ? onSessionLost() : onStopped(failure)),
    [onSessionLost, onStopped]
  )
  const read = useCallback(() => call((client) => client.lessons.list()), [])
  const lessons = useReading(read, handle)
  const sections = lessons === undefined ? [] : [...new Map(lessons.map((each) => [each.subject.section.id, each.subject.section])).values()]
  const groupsOf = (section: string) => {
    const mine = lessons!.filter((each) => each.subject.section.id === section)
    const groups = new Map<string, { readonly name: string; readonly items: Array<LessonListItem> }>()
    for (const item of mine) {
      const key = item.subject.topic?.id ?? "question-types"
      const group = groups.get(key) ?? { name: item.subject.topic?.name ?? "Question Types", items: [] }
      group.items.push(item)
      groups.set(key, group)
    }
    return [...groups.values()].toSorted((a, b) => Number(a.name === "Question Types") - Number(b.name === "Question Types"))
  }
  return (
    <>
      <h1 ref={heading} tabIndex={-1}>Lessons</h1>
      <p className="lede">
        Each Lesson teaches one Skill or Question Type: its rules, the ways to solve it and when each works, the traps, and
        worked examples from real Questions, then a 5-Question check.
      </p>
      {lessons === undefined
        ? <p className="quiet" aria-busy="true">Finding your Lessons</p>
        : lessons.length === 0
        ? <p className="empty">No Lessons yet. They show here once written and checked.</p>
        : sections.map((section) => (
          <section key={section.id} className="group" data-section={section.id} aria-labelledby={`lessons-${section.id}`}>
            <h2 id={`lessons-${section.id}`}>
              <span className="swatch" aria-hidden="true" /> {section.name}
            </h2>
            {groupsOf(section.id).map((group) => (
              <div key={group.name} className="lesson-group">
                <h3 className="map-topic">{group.name}</h3>
                <ul className="set-list">
                  {group.items.map((item) => (
                    <li key={item.id}>
                      <a className="set-name" {...linkProps(lessonPath(item.subject.id))}>{item.subject.name}</a>
                      <span className="set-facts">{minutesText(item.minutes)} to read, then a 5-Question check.</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ))}
    </>
  )
}

// A worked example: the Question as a set shows it, with its answer marked.
const WorkedQuestion = ({ question, keys }: {
  readonly question: PracticeQuestion
  readonly keys: ReadonlyArray<{ readonly part: number; readonly key: string | null }>
}) => {
  const part = question.parts[0]
  const keyOf = new Map(keys.map((each) => [each.part, each.key] as const))
  return (
    <div className="worked-question">
      {question.stimulus !== null && <StimulusDetails stimulus={question.stimulus} />}
      <RichText source={question.stem} className="worked-stem" />
      {question.parts.length > 1 || part?.kind !== "single-choice"
        ? <AnswerParts parts={question.parts} picks={{}} onPick={() => {}} disabled keys={keyOf} />
        : (
          <ul className="answered-options">
            {part.options.map((option) => (
              <li key={option.label} className="answered-option" data-key={option.label === keyOf.get(part.position) || undefined}>
                <span className="answer-letter">{option.label}</span>
                <span className="answer-text">
                  <RichInline source={option.text} />
                  {option.label === keyOf.get(part.position) && <span className="answer-flag">The answer</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}

// The methods: shown alone for a Study Plan item about method.
const Methods = ({ lesson }: { readonly lesson: LessonView }) => (
  <section className="group lesson-part" aria-labelledby="lesson-methods">
    <h2 id="lesson-methods">Ways to solve it</h2>
    <ol className="lesson-methods">
      {lesson.body.methods.map((method, index) => (
        <li key={index}>
          <h3>{method.name}</h3>
          {method.strategy !== null && <p className="hint">Strategy: {method.strategy.name}</p>}
          <p className="lesson-when">
            <strong>When it works.</strong> <RichInline source={method.whenValid} />
          </p>
          <RichText source={method.steps} />
        </li>
      ))}
    </ol>
  </section>
)

// What a Lesson teaches: its methods alone, or the whole of it.
export const LessonContent = ({ lesson, part }: { readonly lesson: LessonView; readonly part: LessonPart }) => (
  <>
    {part === "methods"
      ? (
        <>
          <Methods lesson={lesson} />
          <p className="hint measure">
            <a {...linkProps(lessonPath(lesson.subject.id))}>Read the whole Lesson</a>, with its rules, traps and worked examples.
          </p>
        </>
      )
      : (
        <>
          <section className="group lesson-part" aria-labelledby="lesson-rules">
            <h2 id="lesson-rules">The rules</h2>
            {lesson.body.rules.map((rule, index) => (
              <div key={index} className="lesson-rule">
                <h3>{rule.title}</h3>
                <RichText source={rule.text} />
              </div>
            ))}
          </section>
          <Methods lesson={lesson} />
          <section className="group lesson-part" aria-labelledby="lesson-traps">
            <h2 id="lesson-traps">Traps</h2>
            <ul className="lesson-traps">
              {lesson.body.traps.map((trap, index) => (
                <li key={index}>
                  {trap.trapPattern !== null && <h3>{trap.trapPattern.name}</h3>}
                  <RichText source={trap.text} />
                </li>
              ))}
            </ul>
          </section>
          <section className="group lesson-part" aria-labelledby="lesson-examples">
            <h2 id="lesson-examples">Worked examples</h2>
            {lesson.body.examples.length === 0 && <p className="empty">No worked example can be shown now.</p>}
            {lesson.body.examples.map((example, index) => (
              <div key={example.question.id} className="worked-example">
                <h3>Example {index + 1}</h3>
                <WorkedQuestion question={example.question} keys={example.keys} />
                <div className="walkthrough">
                  <h4>How to solve it</h4>
                  <RichText source={example.walkthrough} />
                </div>
              </div>
            ))}
          </section>
        </>
      )}
  </>
)

export const LessonPage = ({ subject, part, onSessionLost, onStopped }: Props & {
  readonly subject: string
  readonly part: LessonPart
}) => {
  const handle = useCallback(
    (failure: { readonly _tag: string }) => (failure._tag === "NotUnlocked" ? onSessionLost() : onStopped(failure)),
    [onSessionLost, onStopped]
  )
  // The Study Plan item it was opened from, if any.
  const [planItemId] = useState(() => new URLSearchParams(window.location.search).get("item") ?? undefined)
  const [lesson, setLesson] = useState<LessonView | null>()
  const heading = useFocusWhenReady<HTMLHeadingElement>(lesson !== undefined)
  const [problem, setProblem] = useState<string>()
  const busy = useRef(false)

  useEffect(() => {
    let live = true
    void call((client) =>
      client.lessons.open({ params: { subject }, payload: { part, ...(planItemId === undefined ? {} : { planItemId }) } })
    ).then((result) => {
      if (!live) return
      if (result._tag === "Success") return setLesson(result.success)
      if (result.failure._tag === "NoLesson") return setLesson(null)
      handle(result.failure)
    })
    return () => {
      live = false
    }
  }, [subject, part, planItemId, handle])

  const markRead = async () => {
    if (busy.current) return
    busy.current = true
    const result = await call((client) =>
      client.lessons.read({ params: { subject }, payload: { part, ...(planItemId === undefined ? {} : { planItemId }) } })
    )
    busy.current = false
    if (result._tag === "Success") return setLesson(result.success)
    handle(result.failure)
  }

  const startCheck = async () => {
    if (busy.current) return
    busy.current = true
    setProblem(undefined)
    const result = await call((client) =>
      client.lessons.check({ params: { subject }, payload: planItemId === undefined ? {} : { planItemId } })
    )
    busy.current = false
    if (result._tag === "Success") return navigate(`/practice/${result.success.id}`)
    if (result.failure._tag === "NoQuestionsMatch") {
      return setProblem("No check Question can be served now: they may be in your running Sectional or Mock.")
    }
    handle(result.failure)
  }

  if (lesson === undefined) return <p className="quiet" aria-busy="true">Opening the Lesson</p>
  if (lesson === null) {
    return (
      <>
        <h1 ref={heading} tabIndex={-1}>No Lesson yet</h1>
        <p className="empty">This subject has no Lesson yet. <a {...linkProps("/lessons")}>See the Lessons there are</a>.</p>
      </>
    )
  }
  const where = lesson.subject.topic === null ? lesson.subject.section.name : `${lesson.subject.section.name}, ${lesson.subject.topic.name}`
  const progress = lesson.progress
  const readAt = part === "methods" ? progress?.methodsRead ?? progress?.read : progress?.read
  const check = progress?.check ?? null
  return (
    <article className="lesson" data-section={lesson.subject.section.id}>
      <p className="back">
        <a className="quiet-link" {...linkProps("/lessons")}>Lessons</a>
      </p>
      <h1 ref={heading} tabIndex={-1}>{lesson.subject.name}</h1>
      <p className="lede">
        {lesson.subject.kind === "skill" ? "A Skill" : "A Question Type"} in {where}.{" "}
        {part === "methods"
          ? `Its ways to solve, about ${minutesText(lesson.methodsMinutes)}.`
          : `About ${minutesText(lesson.minutes)} to read, then a 5-Question check.`}
      </p>
      <LessonContent lesson={lesson} part={part} />
      <section className="group lesson-part" aria-labelledby="lesson-done">
        <h2 id="lesson-done">{part === "methods" ? "Done reading" : "Check yourself"}</h2>
        {part === "whole" && (
          <>
            <p className="group-about">
              {lesson.checkQuestions === 0
                ? "No check Question can be served now."
                : `${plural(lesson.checkQuestions, "Question", "Questions")} on ${lesson.subject.name}, untimed, each with its Debrief.`}
              {check === null
                ? ""
                : check.finishedAt === null
                ? " Your check is under way."
                : ` Last time: ${check.right} of ${check.total} right, ${dayAndTime(check.finishedAt)}.`}
            </p>
            <div className="actions">
              {check !== null && check.finishedAt === null
                ? <a className="button" {...linkProps(`/practice/${check.id}`)}>Go back to the check</a>
                : (
                  <button type="button" className="button" aria-disabled={lesson.checkQuestions === 0} onClick={() => void startCheck()}>
                    {check === null ? "Start the check" : "Take the check again"}
                  </button>
                )}
            </div>
            {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
          </>
        )}
        <div className="actions">
          <button type="button" className="button button-quiet" onClick={() => void markRead()}>
            {part === "methods" ? "Mark the methods read" : "Mark the Lesson read"}
          </button>
          {readAt !== null && readAt !== undefined && <p className="saved" role="status">Read {dayAndTime(readAt)}.</p>}
        </div>
      </section>
    </article>
  )
}
