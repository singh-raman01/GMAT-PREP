import type { Ref } from "react"
import type { TutorExchange } from "../../../src/api/Tutor.ts"
import { RichText } from "../RichText.tsx"

// The exchanges about a Question: any earlier pages, then the latest, and a
// status line a screen reader reads out when a reply arrives.

const Exchange = ({ exchange }: { readonly exchange: TutorExchange }) => (
  <li>
    <p className="tutor-message"><span className="visually-hidden">You asked:</span> {exchange.message}</p>
    <div className="tutor-reply">
      <span className="visually-hidden">The tutor:</span>
      <RichText source={exchange.reply} />
      {exchange.oldKey !== null && (
        <p className="tutor-note">
          Written when the key was {exchange.oldKey}. The Curator has changed the key since, so this reply may argue for the
          old answer.
        </p>
      )}
      {exchange.reused && <p className="tutor-note">You asked this before, so this is the earlier reply, at no cost.</p>}
    </div>
  </li>
)

export const Conversation = ({ older, latest, announcement, olderRef }: {
  readonly older: ReadonlyArray<TutorExchange>
  readonly latest: ReadonlyArray<TutorExchange>
  readonly announcement: string
  readonly olderRef?: Ref<HTMLOListElement>
}) => (
  <>
    {older.length > 0 && (
      <ol ref={olderRef} className="tutor-exchanges" tabIndex={-1} aria-label="Earlier messages">
        {older.map((exchange) => <Exchange key={exchange.id} exchange={exchange} />)}
      </ol>
    )}
    {latest.length > 0 && (
      <ol className="tutor-exchanges" aria-label="Messages">
        {latest.map((exchange) => <Exchange key={exchange.id} exchange={exchange} />)}
      </ol>
    )}
    <p className="visually-hidden" role="status">{announcement}</p>
  </>
)
