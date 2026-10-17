import { useEffect, useState } from "react"
import type { LessonListItem } from "../../../src/api/Lessons.ts"
import { call } from "../api.ts"

// The approved Lessons, for the links a Debrief shows: read at most once a
// minute however many Debriefs a page shows. Anyone not signed in as a
// Learner, such as the Curator, gets none.
const FreshMs = 60_000
let kept: { readonly at: number; readonly lessons: Promise<ReadonlyArray<LessonListItem>> } | undefined

const approvedLessons = () => {
  const now = Date.now()
  if (kept === undefined || now - kept.at > FreshMs) {
    kept = {
      at: now,
      lessons: call((client) => client.lessons.list()).then((result) => (result._tag === "Success" ? result.success : []))
    }
  }
  return kept.lessons
}

// The approved Lesson on a subject, once known; undefined while unknown or
// when there is none.
export const useLessonOn = (subjectId: string | undefined) => {
  const [lesson, setLesson] = useState<LessonListItem>()
  useEffect(() => {
    if (subjectId === undefined) return
    let live = true
    void approvedLessons().then((all) => {
      if (live) setLesson(all.find((each) => each.subject.id === subjectId))
    })
    return () => {
      live = false
    }
  }, [subjectId])
  return lesson
}
