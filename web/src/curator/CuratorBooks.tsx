import { type ChangeEvent, type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react"
import { MaxRelease, type ReserveSection, type SkillCount, ThinSkillThreshold } from "../../../src/api/Bank.ts"
import type { BookView } from "../../../src/api/Books.ts"
import { call } from "../api.ts"
import { useFocusOnMount } from "../focus.ts"
import { dayAndTime } from "../format.ts"
import { linkProps, navigate } from "../router.ts"
import { bookStatusText, fileSize, pageCountText } from "./bookText.ts"
import { afterStreamClosed, useJobEvents } from "./jobEvents.ts"
import { maxMegabytes, uploadBook } from "./upload.ts"

interface Props {
  readonly onLocked: () => void
  readonly onStopped: (error: { readonly _tag: string }) => void
  // A message for the page the Curator is about to be sent to.
  readonly onNotice: (notice: string, path: string) => void
}

export const CuratorBooks = ({ onLocked, onStopped, onNotice }: Props) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const [books, setBooks] = useState<ReadonlyArray<BookView>>()
  const [thinSkills, setThinSkills] = useState<ReadonlyArray<SkillCount>>([])
  const [reserve, setReserve] = useState<ReadonlyArray<ReserveSection>>([])
  const mounted = useRef(true)

  const handle = useCallback(
    (failure: { readonly _tag: string }) => (failure._tag === "CuratorNotUnlocked" ? onLocked() : onStopped(failure)),
    [onLocked, onStopped]
  )

  // The events stream starts after the newest job state in the first list
  // read, so no change between the two is missed.
  const [since, setSince] = useState<number | "now">()

  const load = useCallback(async (first: boolean) => {
    const result = await call((client) => client.books.list())
    if (!mounted.current) return
    if (result._tag === "Failure") return handle(result.failure)
    setBooks(result.success)
    const thin = await call((client) => client.bank.thinSkills())
    if (mounted.current && thin._tag === "Success") setThinSkills(thin.success)
    const held = await call((client) => client.bank.reserve())
    if (mounted.current && held._tag === "Success") setReserve(held.success)
    if (first) {
      const revisions = result.success.flatMap((book) => (book.job === null ? [] : [book.job.revision]))
      setSince(revisions.length === 0 ? "now" : Math.max(...revisions))
    }
  }, [handle])

  useEffect(() => {
    mounted.current = true
    void load(true)
    return () => {
      mounted.current = false
    }
  }, [load])

  // A Book's status moves on as its jobs run, so the list is read again
  // when any Book's job changes, including one started in another tab.
  useJobEvents(
    since,
    (job) => {
      if (job.kind.startsWith("book-")) void load(false)
    },
    () =>
      void afterStreamClosed(() => {
        setSince(undefined)
        return load(true)
      }, onLocked, () => mounted.current)
  )

  return (
    <>
      <h1 ref={heading} tabIndex={-1}>Books</h1>
      <p className="lede">
        Add a prep book as a PDF. The app reads its pages and costs a 10-page sample, then waits for you before the
        full run.
      </p>
      <AddBook onLocked={onLocked} onNotice={onNotice} />
      <section className="group" aria-labelledby="books-title">
        <h2 id="books-title">Your books</h2>
        {books === undefined
          ? <p className="quiet" aria-busy="true">Loading the books</p>
          : books.length === 0
          ? <p className="empty">No books yet. Add one above to start the Question Bank.</p>
          : (
            <ul className="books">
              {books.map((book) => (
                <li key={book.id} className="book" data-status={book.status}>
                  <div className="book-head">
                    <a className="book-title" {...linkProps(`/curator/books/${book.id}`)}>{book.title}</a>
                    {book.official && <span className="tag">Official GMAC</span>}
                  </div>
                  <p className="book-status">{bookStatusText(book)}</p>
                  <p className="book-meta">
                    {[book.edition, pageCountText(book), fileSize(book.fileSize), `added ${dayAndTime(book.createdAt)}`]
                      .filter((part) => part !== undefined && part !== "")
                      .join(", ")}
                  </p>
                </li>
              ))}
            </ul>
          )}
      </section>
      {reserve.some((section) => section.held + section.released > 0) && (
        <MockReserve sections={reserve} onChanged={setReserve} onLocked={onLocked} onStopped={onStopped} />
      )}
      {thinSkills.length > 0 && (
        <section className="group" aria-labelledby="thin-skills-title">
          <h2 id="thin-skills-title">Skills with few Questions</h2>
          <p className="group-about">
            These Skills have fewer than {ThinSkillThreshold} published Questions. Books that cover them would add
            Questions; a Skill that stays thin can be merged into a related one in the next Taxonomy version.
          </p>
          <ul className="thin-skills">
            {thinSkills.map((skill) => (
              <li key={skill.id}>
                <span>{skill.name}</span>
                <span>{skill.questions} {skill.questions === 1 ? "Question" : "Questions"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

// The Questions held back for Mocks, per Section, and releasing some of them
// into Practice Sets.
const MockReserve = (
  { sections, onChanged, onLocked, onStopped }: {
    readonly sections: ReadonlyArray<ReserveSection>
    readonly onChanged: (sections: ReadonlyArray<ReserveSection>) => void
    readonly onLocked: () => void
    readonly onStopped: (error: { readonly _tag: string }) => void
  }
) => {
  const ids = { section: useId(), count: useId(), hint: useId() }
  const withReserve = sections.filter((section) => section.held > 0)
  const [picked, setPicked] = useState(withReserve[0]?.id ?? "")
  // The Section chosen, while it still holds Questions to release.
  const section = withReserve.some((each) => each.id === picked) ? picked : withReserve[0]?.id ?? ""
  const [count, setCount] = useState("10")
  const [message, setMessage] = useState<{ readonly text: string; readonly problem: boolean }>()
  const messageRef = useRef<HTMLParagraphElement>(null)
  const busy = useRef(false)

  const release = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const wanted = /^\d+$/.test(count.trim()) ? Number(count.trim()) : 0
    if (wanted < 1 || wanted > MaxRelease) {
      return setMessage({ text: `Release from 1 to ${MaxRelease} Questions.`, problem: true })
    }
    if (busy.current) return
    busy.current = true
    const result = await call((client) => client.bank.releaseReserve({ payload: { section, count: wanted } }))
    busy.current = false
    if (result._tag === "Success") {
      const before = sections.find((each) => each.id === section)?.released ?? 0
      const after = result.success.find((each) => each.id === section)
      const released = (after?.released ?? before) - before
      onChanged(result.success)
      setMessage(
        released === 0 && (after?.held ?? 0) > 0
          ? {
            text: `Nothing released: each passage held for ${after?.name ?? "the Section"} Mocks has more Questions than ${
              Number(count)
            }, and a passage is released whole. Ask for more.`,
            problem: true
          }
          : {
            text: `Released ${released} ${after?.name ?? ""} ${released === 1 ? "Question" : "Questions"} into Practice Sets.`,
            problem: false
          }
      )
      // With nothing left to release, the form goes, and focus moves to what
      // was done.
      if (!result.success.some((each) => each.held > 0)) requestAnimationFrame(() => messageRef.current?.focus())
      return
    }
    if (result.failure._tag === "CuratorNotUnlocked") return onLocked()
    if (result.failure._tag === "UnknownSection") return setMessage({ text: "Choose a Section.", problem: true })
    onStopped(result.failure)
  }

  return (
    <section className="group" aria-labelledby="reserve-title">
      <h2 id="reserve-title">Mock Reserve</h2>
      <p className="group-about">
        A quarter of each Section's Questions is held back so that Mocks serve Questions a Learner has not seen.
        Practice Sets use a Reserve Question only once it is released, or once that Learner has seen it.
      </p>
      <ul className="set-list">
        {sections.map((each) => (
          <li key={each.id} data-section={each.id}>
            <span className="swatch" aria-hidden="true" />
            <span className="set-name">{each.name}</span>
            <span className="set-facts">
              {each.questions} published, {each.held} held for Mocks, {each.released} released
            </span>
          </li>
        ))}
      </ul>
      {withReserve.length > 0 && (
        <form className="release-form" noValidate onSubmit={(event) => void release(event)}>
          <div className="field">
            <label htmlFor={ids.section}>Section</label>
            <select id={ids.section} value={section} onChange={(event) => setPicked(event.target.value)}>
              {withReserve.map((each) => <option key={each.id} value={each.id}>{each.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor={ids.count}>How many</label>
            <input
              id={ids.count}
              className="number-input"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={count}
              aria-describedby={ids.hint}
              onChange={(event) => setCount(event.target.value)}
            />
          </div>
          <p id={ids.hint} className="hint">
            Release cannot be undone: once a Learner may have seen a Question, it cannot be held back again. The
            Questions released are spread over Question Types and Difficulty Bands, and a passage's Questions are
            released together, so fewer may be released than you ask for.
          </p>
          <div className="actions">
            <button type="submit" className="button button-quiet">Release into Practice Sets</button>
          </div>
        </form>
      )}
      {message !== undefined && (
        <p
          ref={messageRef}
          tabIndex={-1}
          className={message.problem ? "problem" : "saved"}
          role={message.problem ? "alert" : "status"}
        >
          {message.text}
        </p>
      )}
    </section>
  )
}

const titleFromFileName = (name: string) => name.replace(/\.pdf$/i, "").replace(/[_]+/g, " ").trim().slice(0, 200)

type Sending = { readonly _tag: "Idle" } | { readonly _tag: "Sending"; readonly fraction: number }

const AddBook = (
  { onLocked, onNotice }: { readonly onLocked: () => void; readonly onNotice: (notice: string, path: string) => void }
) => {
  const ids = { file: useId(), title: useId(), edition: useId(), official: useId(), progress: useId() }
  const [file, setFile] = useState<File>()
  const [title, setTitle] = useState("")
  const [edition, setEdition] = useState("")
  const [official, setOfficial] = useState(false)
  const [problem, setProblem] = useState<{ readonly field: "file" | "title" | "form"; readonly text: string }>()
  const [sending, setSending] = useState<Sending>({ _tag: "Idle" })
  const fileInput = useRef<HTMLInputElement>(null)
  const titleInput = useRef<HTMLInputElement>(null)

  // A field's problem is read out with the field, which takes focus.
  useEffect(() => {
    if (problem?.field === "file") fileInput.current?.focus()
    if (problem?.field === "title") titleInput.current?.focus()
  }, [problem])

  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0]
    setFile(chosen)
    setProblem(undefined)
    if (chosen !== undefined && title.trim() === "") setTitle(titleFromFileName(chosen.name))
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (sending._tag === "Sending") return
    if (file === undefined) return setProblem({ field: "file", text: "Choose the book's PDF file." })
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
      return setProblem({ field: "file", text: "Choose a PDF file." })
    }
    if (file.size > maxMegabytes * 1024 * 1024) {
      return setProblem({ field: "file", text: `Choose a file of at most ${maxMegabytes} MB.` })
    }
    if (title.trim() === "" || title.trim().length > 200) {
      return setProblem({ field: "title", text: "Give the book a title of up to 200 characters." })
    }
    setProblem(undefined)
    setSending({ _tag: "Sending", fraction: 0 })
    const outcome = await uploadBook(
      file,
      { title: title.trim(), edition: edition.trim(), official },
      (fraction) => setSending({ _tag: "Sending", fraction })
    )
    setSending({ _tag: "Idle" })
    switch (outcome._tag) {
      case "Added": {
        const page = `/curator/books/${outcome.added.book.id}`
        if (outcome.added.alreadyAdded) {
          onNotice(`This file was added before, as ${outcome.added.book.title}. Nothing new was stored.`, page)
        }
        return navigate(page)
      }
      case "Locked":
        return onLocked()
      case "Refused":
        return setProblem({ field: "form", text: outcome.message })
      case "Unreachable":
        return setProblem({ field: "form", text: "The app did not answer. Check that it is still running, then try again." })
    }
  }

  const percent = sending._tag === "Sending" ? Math.round(sending.fraction * 100) : 0

  return (
    <section className="group add-book" aria-labelledby={`${ids.file}-title`}>
      <h2 id={`${ids.file}-title`}>Add a book</h2>
      <form className="add-form" noValidate onSubmit={(event) => void submit(event)}>
        <div className="field">
          <label htmlFor={ids.file}>PDF file</label>
          <input
            ref={fileInput}
            id={ids.file}
            type="file"
            accept="application/pdf,.pdf"
            aria-invalid={problem?.field === "file"}
            aria-describedby={problem?.field === "file" ? `${ids.file}-error` : undefined}
            onChange={choose}
          />
          {problem?.field === "file" && <p id={`${ids.file}-error`} className="field-error">{problem.text}</p>}
        </div>
        <div className="field">
          <label htmlFor={ids.title}>Title</label>
          <input
            ref={titleInput}
            id={ids.title}
            type="text"
            autoComplete="off"
            value={title}
            aria-invalid={problem?.field === "title"}
            aria-describedby={problem?.field === "title" ? `${ids.title}-error` : undefined}
            onChange={(event) => setTitle(event.target.value)}
          />
          {problem?.field === "title" && <p id={`${ids.title}-error`} className="field-error">{problem.text}</p>}
        </div>
        <div className="field">
          <label htmlFor={ids.edition}>
            Edition <span className="optional">(optional)</span>
          </label>
          <p id={`${ids.edition}-hint`} className="hint">A new edition of a title is a separate book.</p>
          <input
            id={ids.edition}
            type="text"
            autoComplete="off"
            value={edition}
            aria-describedby={`${ids.edition}-hint`}
            onChange={(event) => setEdition(event.target.value)}
          />
        </div>
        <div className="check">
          <input
            id={ids.official}
            type="checkbox"
            checked={official}
            aria-describedby={`${ids.official}-hint`}
            onChange={(event) => setOfficial(event.target.checked)}
          />
          <div>
            <label htmlFor={ids.official}>Official GMAC material</label>
            <p id={`${ids.official}-hint`} className="hint">
              Such as the Official Guide. Weak Area priorities follow the question mix of official books.
            </p>
          </div>
        </div>
        {sending._tag === "Sending" && (
          <div className="upload-progress">
            <p id={ids.progress}>Sending the file: {percent}%</p>
            <div
              className="progress"
              role="progressbar"
              aria-labelledby={ids.progress}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <div className="progress-done" style={{ width: `${percent}%` }} />
            </div>
          </div>
        )}
        {problem?.field === "form" && <p className="problem" role="alert">{problem.text}</p>}
        <div className="actions">
          <button type="submit" className="button" aria-disabled={sending._tag === "Sending"}>Add book</button>
        </div>
      </form>
    </section>
  )
}
