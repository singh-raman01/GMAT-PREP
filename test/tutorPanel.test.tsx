import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { TutorExchange } from "../src/api/Tutor.ts"
import {
  closedNote,
  emptyMessageNote,
  failureNote,
  notSetUpNote,
  replyAnnouncement,
  withLatest
} from "../web/src/tutor/chatText.ts"
import { Conversation } from "../web/src/tutor/Conversation.tsx"
import { onReportSent, reportSent } from "../web/src/tutor/reportEvents.ts"

// What the Tutor panel shows and says, without a browser: its wording, its
// markup rendered on the server, and the style rules that fit it to a phone.

const exchange = (id: string, fields: Partial<{ reused: boolean; oldKey: string | null }> = {}) =>
  new TutorExchange({ id, message: `Message ${id}`, reply: `Reply ${id}`, at: 0, reused: false, oldKey: null, ...fields })

// The declarations of every rule that names the selector, comments left out.
const declarationsOf = async (selector: string) => {
  const css = (await Bun.file("web/src/styles.css").text()).replace(/\/\*[\s\S]*?\*\//g, "")
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((rule) => rule[1]!.split(",").map((each) => each.trim()).includes(selector))
    .map((rule) => rule[2]!)
    .join(";")
}

describe("The Tutor panel", () => {
  test("its grid items can shrink and long words break, so a long link or formula stays inside a phone's width", async () => {
    for (const selector of [".tutor-chat > *", ".tutor-form > *", ".tutor-exchanges > li"]) {
      expect({ selector, rule: await declarationsOf(selector) }).toMatchObject({ rule: expect.stringMatching(/min-width:\s*0/) })
    }
    for (const selector of [".tutor-message", ".tutor-reply"]) {
      expect({ selector, rule: await declarationsOf(selector) }).toMatchObject({ rule: expect.stringMatching(/overflow-wrap:\s*anywhere/) })
    }
    // A wide formula then scrolls in its own box.
    expect(await declarationsOf(".math-display")).toMatch(/overflow-x:\s*auto/)
  })

  test("a reply is read out from a status line, and an empty question says what to do", () => {
    const markup = renderToStaticMarkup(
      <Conversation older={[]} latest={[exchange("a")]} announcement={replyAnnouncement(exchange("a"))} />
    )
    expect(markup).toContain(`<p class="visually-hidden" role="status">The tutor replied.</p>`)
    expect(replyAnnouncement(exchange("a", { reused: true }))).toBe("You asked this before. The tutor's earlier reply is now the last one.")
    expect(emptyMessageNote).toBe("Write your question first.")
  })

  test("a reply written for a key since changed says so, and so does one asked again", () => {
    const markup = renderToStaticMarkup(
      <Conversation older={[]} latest={[exchange("a", { oldKey: "C" }), exchange("b", { reused: true })]} announcement="" />
    )
    expect(markup).toContain("Written when the key was C. The Curator has changed the key since")
    expect(markup).toContain("You asked this before, so this is the earlier reply, at no cost.")
  })

  test("the latest page replaces what was shown of it: an exchange asked again moves to the end, and older ones stay", () => {
    const shown = [exchange("a"), exchange("b"), exchange("c")]
    expect(withLatest(shown, [exchange("c"), exchange("a", { reused: true })]).map((each) => each.id)).toEqual(["b", "c", "a"])
  })

  test("a closed Question says why and what to do, a refused call sends the Learner to the Curator, and a missing setting is named", () => {
    const notes = [
      closedNote("not-answered", "chat"),
      closedNote("held", "chat"),
      closedNote("withdrawn", "chat"),
      closedNote("withdrawn", "report")
    ]
    expect(new Set(notes).size).toBe(4)
    expect(closedNote("held", "report")).toBe(
      "A Sectional or Mock you are taking holds this Question. Ask about it, or report it, once that ends."
    )
    expect(failureNote({ _tag: "TutorQuestionClosed", reason: "withdrawn" } as { readonly _tag: string }, "report")).toBe(
      "The Curator has already taken this Question out of the Question Bank, so there is nothing to report."
    )
    expect(failureNote({ _tag: "TutorRefused" }, "chat")).toContain("Tell the Curator")
    expect(failureNote({ _tag: "TutorUnavailable" }, "chat")).toContain("Try again in a little while")
    expect(failureNote({ _tag: "TutorNotSetUp", missing: ["the API key"] } as { readonly _tag: string }, "chat")).toBe(
      "Tutor Chat is not set up yet: the Curator has to set the API key under Settings."
    )
    expect(notSetUpNote([])).toBe("Tutor Chat is not set up yet. The Curator sets it up under Settings.")
  })

  test("sending a report tells the list of the Learner's reports to read itself again", () => {
    let heard = 0
    const stop = onReportSent(() => {
      heard += 1
    })
    reportSent()
    stop()
    reportSent()
    expect(heard).toBe(1)
  })
})
