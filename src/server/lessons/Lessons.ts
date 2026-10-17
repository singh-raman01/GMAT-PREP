import { and, asc, desc, eq, inArray, max, sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Semaphore } from "effect"
import { type JobView, LlmNotConfigured } from "../../api/Jobs.ts"
import {
  CuratorLessonRow,
  CuratorLessonsView,
  LessonBody,
  LessonId,
  LessonJobRunning,
  LessonListItem,
  LessonNotDraft,
  LessonNotFound,
  type LessonPart,
  LessonProgress,
  type LessonStatus,
  LessonSubjectView,
  LessonView,
  NoLesson,
  NothingToWrite
} from "../../api/Lessons.ts"
import { Named, NoQuestionsMatch, type PracticeView, SessionId } from "../../api/Practice.ts"
import { Db } from "../db/Database.ts"
import { jobs, lessons, lessonViews, responses, sessions } from "../db/schema.ts"
import { JobStore } from "../jobs/JobStore.ts"
import { namesOf, practiceQuestion, storedQuestions } from "../practice/content.ts"
import { heldBySections, isCorrect, keysOf, readSelection } from "../practice/history.ts"
import { type Caller, Practice } from "../practice/Practice.ts"
import { ApiKeyStore } from "../settings/ApiKeyStore.ts"
import { missingSettings, Settings } from "../settings/Settings.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import { lessonCandidates } from "./candidates.ts"
import type { LessonContent } from "./content.ts"
import { checkQuestionsNow, FewestQuestions, type LessonCandidate } from "./pick.ts"
import { basisOf, type LessonSubject, lessonSubjects } from "./subjects.ts"
import { LessonWriting } from "./write.ts"

// Lessons (docs/design.md, decisions 93 to 102): the Curator's list, the
// job that writes them and the decision on each draft; the Learner's list,
// opening a Lesson, marking a part read, and its check.

// Words a minute, for how long a Lesson takes to read.
export const WordsPerMinute = 200

type LessonRow = typeof lessons.$inferSelect

export const minutesFor = (words: number) => Math.max(1, Math.ceil(words / WordsPerMinute))

// An approved Lesson as other services need it: the Study Plan and the
// Debrief.
export interface ApprovedLesson {
  readonly id: string
  readonly subjectId: string
  readonly words: number
  readonly methodsWords: number
  readonly decidedAt: number
}

// The latest version of each status for each subject, by the version's
// number, newest first.
const latestBy = (rows: ReadonlyArray<LessonRow>, status: string) => {
  const found = new Map<string, LessonRow>()
  for (const row of rows.toSorted((a, b) => b.version - a.version)) {
    if (row.status === status && !found.has(row.subjectId)) found.set(row.subjectId, row)
  }
  return found
}

const statusOf = (row: LessonRow): LessonStatus =>
  row.status === "approved" ? "approved" : row.status === "rejected" ? "rejected" : "draft"

// When a version was decided, or written while it waits.
const settledAt = (row: LessonRow) => (row.status === "draft" ? row.createdAt : row.decidedAt ?? row.createdAt)

// The states of a job that has not finished.
const Unfinished = ["queued", "running", "paused"]

export class Lessons extends Context.Service<Lessons, {
  readonly overview: Effect.Effect<CuratorLessonsView>
  write(
    subjects: ReadonlyArray<string> | undefined,
    spendCap: number
  ): Effect.Effect<JobView, LessonJobRunning | LlmNotConfigured | NothingToWrite>
  preview(id: string): Effect.Effect<LessonView, LessonNotFound>
  approve(id: string): Effect.Effect<LessonView, LessonNotFound | LessonNotDraft>
  reject(id: string, note: string): Effect.Effect<LessonView, LessonNotFound | LessonNotDraft>
  list(profileId: string): Effect.Effect<ReadonlyArray<LessonListItem>>
  open(profileId: string, subjectId: string, part: LessonPart, planItemId: string | undefined): Effect.Effect<LessonView, NoLesson>
  read(profileId: string, subjectId: string, part: LessonPart, planItemId: string | undefined): Effect.Effect<LessonView, NoLesson>
  check(caller: Caller, subjectId: string, planItemId: string | undefined): Effect.Effect<PracticeView, NoLesson | NoQuestionsMatch>
  // Each subject's approved Lesson, by subject id.
  readonly approved: Effect.Effect<ReadonlyMap<string, ApprovedLesson>>
}>()("gmat-prep/server/Lessons") {
  static readonly layer = Layer.effect(
    Lessons,
    Effect.gen(function*() {
      const db = yield* Db
      const store = yield* JobStore
      const settings = yield* Settings
      const keys = yield* ApiKeyStore
      const practice = yield* Practice
      const taxonomy = (yield* Taxonomy).view
      const names = namesOf(taxonomy)
      const subjects = lessonSubjects(taxonomy)
      const subjectOf = new Map(subjects.map((subject) => [subject.id, subject] as const))
      const run = <A, E>(effect: Effect.Effect<A, E, Db>) => effect.pipe(Effect.provideService(Db, db), Effect.orDie)
      // Writes and decisions one at a time, so a second Write finds the job
      // the first one queued.
      const oneAtATime = (yield* Semaphore.make(1)).withPermits(1)

      const subjectView = (subject: LessonSubject) =>
        new LessonSubjectView({
          kind: subject.kind,
          id: subject.id,
          name: subject.name,
          description: subject.description,
          section: new Named({ id: subject.section.id, name: subject.section.name }),
          topic: subject.topic === null ? null : new Named({ id: subject.topic.id, name: subject.topic.name })
        })

      // A subject the Taxonomy no longer has is shown by its id.
      const subjectViewOf = (row: LessonRow) => {
        const subject = subjectOf.get(row.subjectId)
        if (subject !== undefined) return subjectView(subject)
        return new LessonSubjectView({
          kind: row.subjectKind === "skill" ? "skill" : "questionType",
          id: row.subjectId,
          name: row.subjectId,
          description: "",
          section: names.named(row.subjectId.slice(0, row.subjectId.indexOf("."))),
          topic: null
        })
      }

      const allRows = db.select().from(lessons).pipe(Effect.orDie)

      const rowOf = (id: string) =>
        db.select().from(lessons).where(eq(lessons.id, id)).pipe(Effect.orDie, Effect.map((rows) => rows[0]))

      // The subject's latest approved Lesson.
      const approvedOf = (subjectId: string) =>
        db.select().from(lessons).where(and(eq(lessons.subjectId, subjectId), eq(lessons.status, "approved")))
          .orderBy(desc(lessons.version)).limit(1).pipe(Effect.orDie, Effect.map((rows) => rows[0]))

      // Why an approved Lesson should be written again, or undefined.
      const markedFor = (row: LessonRow, candidates: ReadonlyMap<string, ReadonlyArray<{ readonly id: string }>>) => {
        const subject = subjectOf.get(row.subjectId)
        if (subject === undefined) return "Its subject is no longer in the Taxonomy."
        if (row.basis !== basisOf(subject)) return "The Taxonomy changed how it describes the subject."
        const open = new Set((candidates.get(row.subjectId) ?? []).map((each) => each.id))
        const examples = JSON.parse(row.examples) as ReadonlyArray<string>
        if (examples.some((id) => !open.has(id))) {
          return "A worked example is no longer published with the subject outside the Mock Reserve."
        }
        return undefined
      }

      // The subject's Questions a reader may be shown now: those it may teach
      // from, less those a running Sectional or Mock holds for the Profile.
      const openFor = (row: LessonRow, profileId: string | undefined) =>
        Effect.gen(function*() {
          const candidates = (yield* run(lessonCandidates(taxonomy))).get(row.subjectId) ?? []
          if (profileId === undefined) return candidates
          const held = yield* run(heldBySections(profileId))
          return candidates.filter((each) => !held.has(each.id))
        })

      // The check's Questions now (decision 100).
      const checkIdsOf = (row: LessonRow, open: ReadonlyArray<LessonCandidate>) =>
        checkQuestionsNow(
          JSON.parse(row.checks) as ReadonlyArray<string>,
          JSON.parse(row.examples) as ReadonlyArray<string>,
          open
        )

      // What a page of the Lesson shows: the methods part alone, or the whole
      // Lesson with the worked examples among the Questions open now, so a
      // marked Lesson can show fewer of them (decision 97).
      const bodyOf = (row: LessonRow, part: LessonPart, open: ReadonlyArray<LessonCandidate>) =>
        Effect.gen(function*() {
          const content = JSON.parse(row.content) as LessonContent
          const methods = content.methods.map((method) => ({
            name: method.name,
            strategy: method.strategy === null ? null : names.named(method.strategy),
            whenValid: method.whenValid,
            steps: method.steps
          }))
          if (part === "methods") return new LessonBody({ rules: [], methods, traps: [], examples: [] })
          const openIds = new Set(open.map((each) => each.id))
          const exampleIds = JSON.parse(row.examples) as ReadonlyArray<string>
          const stored = yield* run(storedQuestions(exampleIds.filter((id) => openIds.has(id))))
          return new LessonBody({
            rules: content.rules,
            methods,
            traps: content.traps.map((trap) => ({
              trapPattern: trap.trapPattern === null ? null : names.named(trap.trapPattern),
              text: trap.text
            })),
            examples: content.examples.flatMap((example) => {
              const question = stored.get(exampleIds[example.example - 1] ?? "")
              if (question === undefined) return []
              return [{
                question: practiceQuestion(question, names, null),
                keys: question.parts.map((part) => ({ part: part.position, key: part.key })),
                walkthrough: example.walkthrough
              }]
            })
          })
        })

      // The Learner's record with this version of the Lesson.
      const progressOf = (profileId: string, row: LessonRow) =>
        Effect.gen(function*() {
          const [check] = yield* db.select({ id: sessions.id, status: sessions.status, finishedAt: sessions.finishedAt })
            .from(sessions)
            .where(and(
              eq(sessions.profileId, profileId),
              eq(sessions.kind, "practice"),
              sql`json_extract(${sessions.config}, '$.lesson.id') = ${row.id}`
            ))
            .orderBy(desc(sessions.createdAt), desc(sql`${sessions}.rowid`)).limit(1).pipe(Effect.orDie)
          const marks = yield* db.select({ part: lessonViews.part, at: max(lessonViews.viewedAt) }).from(lessonViews)
            .where(and(eq(lessonViews.profileId, profileId), eq(lessonViews.lessonId, row.id), eq(lessonViews.kind, "read")))
            .groupBy(lessonViews.part).pipe(Effect.orDie)
          let score = { right: 0, total: 0 }
          if (check !== undefined) {
            const answers = yield* db.select({ questionId: responses.questionId, selection: responses.selection })
              .from(responses).where(eq(responses.sessionId, check.id)).orderBy(asc(responses.seq)).pipe(Effect.orDie)
            const final = new Map(answers.map((answer) => [answer.questionId, answer.selection] as const))
            const found = yield* run(keysOf([...final.keys()]))
            score = {
              right: [...final].filter(([questionId, selection]) =>
                isCorrect(readSelection(selection), found.get(questionId) ?? [])
              ).length,
              total: final.size
            }
          }
          const readAt = (part: string) => {
            const at = marks.find((mark) => mark.part === part)?.at
            return at === undefined || at === null ? null : Number(at)
          }
          return new LessonProgress({
            check: check === undefined ? null : {
              id: SessionId.make(check.id),
              finishedAt: check.status === "finished" ? check.finishedAt : null,
              ...score
            },
            methodsRead: readAt("methods"),
            read: readAt("whole")
          })
        })

      const viewOf = (row: LessonRow, profileId: string | undefined, open: ReadonlyArray<LessonCandidate>, body: LessonBody) =>
        Effect.gen(function*() {
          return new LessonView({
            id: LessonId.make(row.id),
            subject: subjectViewOf(row),
            version: row.version,
            status: statusOf(row),
            body,
            minutes: minutesFor(row.words),
            methodsMinutes: minutesFor(row.methodsWords),
            checkQuestions: checkIdsOf(row, open).length,
            writtenAt: row.createdAt,
            progress: profileId === undefined ? null : yield* progressOf(profileId, row)
          })
        })

      // A version as the Curator reads it: the whole Lesson, as a Learner with
      // no Sectional or Mock running would.
      const previewOf = (row: LessonRow) =>
        Effect.gen(function*() {
          const open = yield* openFor(row, undefined)
          return yield* viewOf(row, undefined, open, yield* bodyOf(row, "whole", open))
        })

      const latestJob = store.list.pipe(Effect.map((all) => all.find((job) => job.kind === LessonWriting.kind) ?? null))

      const overview = Effect.gen(function*() {
        const rows = yield* allRows
        const candidates = yield* run(lessonCandidates(taxonomy))
        const approved = latestBy(rows, "approved")
        const drafts = latestBy(rows, "draft")
        const rejected = latestBy(rows, "rejected")
        const versionsOf = Map.groupBy(rows.toSorted((a, b) => b.version - a.version), (row) => row.subjectId)
        const ref = (row: LessonRow, at: number) => ({ id: LessonId.make(row.id), version: row.version, at })
        const lessonRows = subjects.map((subject) => {
          const current = approved.get(subject.id)
          const after = (row: LessonRow | undefined, than: number) => (row !== undefined && row.version > than ? row : undefined)
          const draft = after(drafts.get(subject.id), current?.version ?? 0)
          const turnedDown = after(rejected.get(subject.id), Math.max(current?.version ?? 0, draft?.version ?? 0))
          return new CuratorLessonRow({
            subject: subjectView(subject),
            approved: current === undefined ? null : ref(current, current.decidedAt ?? current.createdAt),
            draft: draft === undefined ? null : ref(draft, draft.createdAt),
            rejected: turnedDown === undefined
              ? null
              : { ...ref(turnedDown, turnedDown.decidedAt ?? turnedDown.createdAt), note: turnedDown.note ?? "" },
            versions: (versionsOf.get(subject.id) ?? []).map((row) => ({ ...ref(row, settledAt(row)), status: statusOf(row) })),
            marked: current === undefined ? null : markedFor(current, candidates) ?? null,
            questions: (candidates.get(subject.id) ?? []).length
          })
        })
        return new CuratorLessonsView({
          rows: lessonRows,
          needed: lessonRows.filter(isNeeded).length,
          fewest: FewestQuestions,
          job: yield* latestJob
        })
      })

      // A subject to write: none approved or waiting, or the approved one
      // marked, with enough Questions to write from.
      const isNeeded = (row: CuratorLessonRow) =>
        row.questions >= FewestQuestions && row.draft === null && (row.approved === null || row.marked !== null)

      const write = (given: ReadonlyArray<string> | undefined, spendCap: number) =>
        Effect.gen(function*() {
          const [unfinished] = yield* db.select({ id: jobs.id }).from(jobs)
            .where(and(eq(jobs.kind, LessonWriting.kind), inArray(jobs.status, Unfinished)))
            .limit(1).pipe(Effect.orDie)
          if (unfinished !== undefined) return yield* new LessonJobRunning()
          const llm = yield* settings.llm
          const missing = missingSettings(llm, Option.isSome(yield* keys.read), "lessons")
          if (missing.length > 0) return yield* new LlmNotConfigured({ missing })
          const view = yield* overview
          const wanted = given === undefined
            ? view.rows.filter(isNeeded).map((row) => row.subject.id)
            : [...new Set(given)].filter((id) => subjectOf.has(id))
          if (wanted.length === 0) return yield* new NothingToWrite()
          const label = wanted.length === 1
            ? `Write the Lesson on ${subjectOf.get(wanted[0]!)!.name}`
            : `Write ${wanted.length} Lessons`
          return yield* store.create(LessonWriting, { subjects: wanted, label }, spendCap)
        }).pipe(oneAtATime)

      const preview = (id: string) =>
        Effect.gen(function*() {
          const row = yield* rowOf(id)
          if (row === undefined) return yield* new LessonNotFound()
          return yield* previewOf(row)
        })

      const decide = (id: string, status: "approved" | "rejected", note: string | null) =>
        Effect.gen(function*() {
          const row = yield* rowOf(id)
          if (row === undefined) return yield* new LessonNotFound()
          if (row.status !== "draft") return yield* new LessonNotDraft({ status: row.status })
          const now = yield* Clock.currentTimeMillis
          yield* db.update(lessons).set({ status, decidedAt: now, note }).where(eq(lessons.id, id)).pipe(Effect.orDie)
          return yield* previewOf({ ...row, status, decidedAt: now, note })
        }).pipe(oneAtATime)

      const list = (_profileId: string) =>
        Effect.gen(function*() {
          const approved = latestBy(yield* allRows, "approved")
          return subjects.flatMap((subject) => {
            const row = approved.get(subject.id)
            return row === undefined
              ? []
              : [new LessonListItem({ id: LessonId.make(row.id), subject: subjectView(subject), minutes: minutesFor(row.words) })]
          })
        })

      // Records the view with the worked examples the page is sent, as those
      // are what it makes Seen (decision 99).
      const record = (
        profileId: string,
        subjectId: string,
        kind: "opened" | "read",
        part: LessonPart,
        planItemId: string | undefined
      ) =>
        Effect.gen(function*() {
          const row = yield* approvedOf(subjectId)
          if (row === undefined) return yield* new NoLesson()
          const open = yield* openFor(row, profileId)
          const body = yield* bodyOf(row, part, open)
          yield* db.insert(lessonViews).values({
            id: crypto.randomUUID(),
            profileId,
            lessonId: row.id,
            kind,
            part,
            planItemId: planItemId ?? null,
            viewedAt: yield* Clock.currentTimeMillis,
            shownExamples: JSON.stringify(body.examples.map((example) => example.question.id))
          }).pipe(Effect.orDie)
          return yield* viewOf(row, profileId, open, body)
        })

      const check = (caller: Caller, subjectId: string, planItemId: string | undefined) =>
        Effect.gen(function*() {
          const row = yield* approvedOf(subjectId)
          if (row === undefined) return yield* new NoLesson()
          const ids = checkIdsOf(row, yield* openFor(row, caller.profileId))
          if (ids.length === 0) return yield* new NoQuestionsMatch({ heldForMocks: 0, unavailable: 0, inSection: 0 })
          const name = subjectOf.get(subjectId)?.name ?? subjectId
          return yield* practice.startLessonCheck(caller, { id: row.id, title: `Lesson check: ${name}` }, ids, planItemId)
        })

      const approved = Effect.gen(function*() {
        const found = latestBy(yield* allRows, "approved")
        return new Map([...found].map(([subjectId, row]) => [subjectId, {
          id: row.id,
          subjectId,
          words: row.words,
          methodsWords: row.methodsWords,
          decidedAt: row.decidedAt ?? row.createdAt
        }] as const)) as ReadonlyMap<string, ApprovedLesson>
      })

      return Lessons.of({
        overview,
        write,
        preview,
        approve: (id) => decide(id, "approved", null),
        reject: (id, note) => decide(id, "rejected", note.trim()),
        list,
        open: (profileId, subjectId, part, planItemId) => record(profileId, subjectId, "opened", part, planItemId),
        read: (profileId, subjectId, part, planItemId) => record(profileId, subjectId, "read", part, planItemId),
        check,
        approved
      })
    })
  )
}
