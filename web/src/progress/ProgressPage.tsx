import { useCallback } from "react"
import { useFocusOnMount } from "../focus.ts"
import { linkProps } from "../router.ts"
import { Mistakes } from "./Mistakes.tsx"
import { SkillMap } from "./SkillMap.tsx"
import { Study } from "./Study.tsx"
import { Timing } from "./Timing.tsx"
import { WeakAreas } from "./WeakAreas.tsx"

// Progress (docs/design.md, "Analytics"): Weak Areas, the Skill map, Timing,
// Mistakes and Study, one view at a time. The Score trend is on the Scores
// page, and every miss in the Error Log.

interface Props {
  readonly path: string
  readonly onSessionLost: () => void
  readonly onStopped: (error: { readonly _tag: string }) => void
}

const views = [
  { id: "weak-areas", name: "Weak Areas", path: "/progress" },
  { id: "skill-map", name: "Skill map", path: "/progress/skill-map" },
  { id: "timing", name: "Timing", path: "/progress/timing" },
  { id: "mistakes", name: "Mistakes", path: "/progress/mistakes" },
  { id: "study", name: "Study", path: "/progress/study" }
] as const

export const ProgressPage = ({ path, onSessionLost, onStopped }: Props) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const view = views.find((each) => each.path === path) ?? views[0]
  const handle = useCallback(
    (failure: { readonly _tag: string }) => (failure._tag === "NotUnlocked" ? onSessionLost() : onStopped(failure)),
    [onSessionLost, onStopped]
  )
  return (
    <>
      <h1 ref={heading} tabIndex={-1}>Progress</h1>
      <p className="lede">
        How your practice is going: where you lose points, how you pace yourself, what goes wrong and when you study.
        Your Score trend is on the Scores page, and every Question you missed in your Error Log.
      </p>
      <nav className="viewnav" aria-label="Progress views">
        {views.map((each) => (
          <a key={each.id} {...linkProps(each.path)} aria-current={each.id === view.id ? "page" : undefined}>
            <span className={each.id === view.id ? "mark" : undefined}>{each.name}</span>
          </a>
        ))}
      </nav>
      {view.id === "weak-areas"
        ? <WeakAreas key={view.id} onFailure={handle} />
        : view.id === "skill-map"
        ? <SkillMap key={view.id} onFailure={handle} />
        : view.id === "timing"
        ? <Timing key={view.id} onFailure={handle} />
        : view.id === "mistakes"
        ? <Mistakes key={view.id} onFailure={handle} />
        : <Study key={view.id} onFailure={handle} />}
    </>
  )
}
