import { useCallback, useEffect, useState } from "react"
import { FewSiblings, type SkillSiblings } from "../../../src/api/Siblings.ts"
import { call } from "../api.ts"
import { useFocusOnMount } from "../focus.ts"
import { dayAndTime } from "../format.ts"

// For the Curator: the Skills whose Retry Ladders run out of Siblings, so
// the next Book or generated batch can go where Learners need it.

interface Props {
  readonly onLocked: () => void
  readonly onStopped: (error: { readonly _tag: string }) => void
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

export const SiblingsPage = ({ onLocked, onStopped }: Props) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const [skills, setSkills] = useState<ReadonlyArray<SkillSiblings>>()

  const handle = useCallback(
    (failure: { readonly _tag: string }) => (failure._tag === "CuratorNotUnlocked" ? onLocked() : onStopped(failure)),
    [onLocked, onStopped]
  )

  useEffect(() => {
    let mounted = true
    void call((client) => client.siblings.report()).then((result) => {
      if (!mounted) return
      if (result._tag === "Failure") return handle(result.failure)
      setSkills(result.success)
    })
    return () => {
      mounted = false
    }
  }, [handle])

  return (
    <>
      <h1 ref={heading} tabIndex={-1}>Siblings</h1>
      <p className="lede">
        A Retry Ladder's later steps serve an unseen Sibling: a Question of the same type and Skill, outside the Mock
        Reserve, close in Difficulty. These Skills have run out of them for some Learner, or have {FewSiblings} or fewer
        of a type to give. More Books, or generated Questions, for them keep the ladders going.
      </p>
      {skills === undefined ? <p className="quiet" aria-busy="true">Counting Siblings</p> : skills.length === 0
        ? <p className="empty">No Skill is running out of Siblings.</p>
        : (
          <ul className="set-list sibling-list">
            {skills.map((each) => (
              <li key={`${each.skill.id}-${each.questionType.id}`} data-section={each.section.id}>
                <span className="swatch" aria-hidden="true" />
                <span className="set-name">{each.skill.name}, {each.questionType.name}</span>
                <span className="set-facts">
                  {each.section.name}.{" "}
                  {each.skipped === 0
                    ? "No step skipped yet"
                    : `${plural(each.skipped, "step", "steps")} skipped, last ${dayAndTime(each.lastSkippedAt!)}`}
                  , {plural(each.available, "Question", "Questions")} outside the Reserve.
                </span>
              </li>
            ))}
          </ul>
        )}
    </>
  )
}
