import { and, asc, eq, sql } from "drizzle-orm"
import { Clock, Effect } from "effect"
import { Db } from "../db/Database.ts"
import { problemReports, reviewItems } from "../db/schema.ts"

// The Review Queue item that gathers Learners' Problem Reports on a Question
// (decision 107). Only a Curator decision closes it; the Publish Gate never
// decides it or writes its reasons.

// The Question's open report item, if it has one.
export const openReportItem = (questionId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const [item] = yield* db.select({ id: reviewItems.id }).from(reviewItems)
      .where(and(eq(reviewItems.questionId, questionId), eq(reviewItems.status, "open"), eq(reviewItems.kind, "report")))
    return item?.id
  })

// An item's reasons are its reports' words, oldest first.
export const gatherReports = (itemId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const reports = yield* db.select({ text: problemReports.text }).from(problemReports)
      .where(eq(problemReports.reviewItemId, itemId))
      .orderBy(asc(problemReports.createdAt), asc(sql`${problemReports}.rowid`))
    yield* db.update(reviewItems)
      .set({ reasons: JSON.stringify(reports.map((report) => ({ code: "problem-report", detail: report.text }))) })
      .where(eq(reviewItems.id, itemId))
  })

// A merged Question's reports count for the Question it was merged into, and
// those still waiting go on waiting there: its open report item moves to that
// Question, or its reports join the open one that Question has.
export const carryReports = (from: string, into: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    yield* db.update(problemReports).set({ questionId: into }).where(eq(problemReports.questionId, from))
    const moving = yield* openReportItem(from)
    if (moving === undefined) return
    const joined = yield* openReportItem(into)
    if (joined === undefined) {
      yield* db.update(reviewItems).set({ questionId: into }).where(eq(reviewItems.id, moving))
      return
    }
    const now = yield* Clock.currentTimeMillis
    yield* db.update(problemReports).set({ reviewItemId: joined }).where(eq(problemReports.reviewItemId, moving))
    yield* db.update(reviewItems).set({ status: "decided", decision: "merged", decidedAt: now }).where(eq(reviewItems.id, moving))
    yield* gatherReports(joined)
  })
