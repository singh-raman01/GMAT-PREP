import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

// Times are stored as epoch milliseconds read from the Effect Clock, so tests
// can drive them with TestClock.

export const profiles = sqliteTable("profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  nameKey: text("name_key").notNull().unique(),
  pinHash: text("pin_hash"),
  timeZone: text("time_zone").notNull(),
  rolloverHour: integer("rollover_hour").notNull().default(4),
  failedPinAttempts: integer("failed_pin_attempts").notNull().default(0),
  lockedUntil: integer("locked_until"),
  createdAt: integer("created_at").notNull()
})

export const profileUnlocks = sqliteTable("profile_unlocks", {
  tokenHash: text("token_hash").primaryKey(),
  profileId: text("profile_id")
    .notNull()
    .references(() => profiles.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull(),
  // An unlock unused for a while ends; see Profiles.UnlockIdleMs.
  lastUsedAt: integer("last_used_at").notNull()
})

export const taxonomyVersions = sqliteTable(
  "taxonomy_versions",
  {
    version: integer("version").notNull(),
    fileHash: text("file_hash").notNull(),
    loadedAt: integer("loaded_at").notNull()
  },
  (t) => [primaryKey({ columns: [t.version, t.fileHash] })]
)

// The Curator's passphrase, one row for the install (id 1). Wrong entries lock
// it the way wrong PINs lock a Profile.
export const curatorAccess = sqliteTable("curator_access", {
  id: integer("id").primaryKey(),
  passphraseHash: text("passphrase_hash").notNull(),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: integer("locked_until"),
  setAt: integer("set_at").notNull()
})

export const curatorUnlocks = sqliteTable("curator_unlocks", {
  tokenHash: text("token_hash").primaryKey(),
  createdAt: integer("created_at").notNull(),
  // Ends after the same idle time as a Profile's unlock.
  lastUsedAt: integer("last_used_at").notNull()
})

// Non-secret settings: one JSON value per key, checked against its schema
// when read. The API key is never stored here.
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull()
})

// The job queue. The server adds jobs and the worker claims them, saving a
// checkpoint after each step. Every visible change takes the next revision, so
// the server can send changes in order.
export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    params: text("params").notNull(),
    // queued, running, paused, failed, done or cancelled
    status: text("status").notNull(),
    checkpoint: text("checkpoint"),
    stepsDone: integer("steps_done").notNull().default(0),
    stepsTotal: integer("steps_total"),
    // What the job is doing, or why it paused or failed.
    note: text("note"),
    result: text("result"),
    spendCap: real("spend_cap").notNull(),
    spend: real("spend").notNull().default(0),
    claimant: text("claimant"),
    heartbeatAt: integer("heartbeat_at"),
    // pause or cancel, asked while the job runs
    requested: text("requested"),
    resumeAt: integer("resume_at"),
    // How often a worker stopped during the step now running, such as on a
    // crash; cleared when a step is saved or the Curator resumes the job.
    crashes: integer("crashes").notNull().default(0),
    revision: integer("revision").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    finishedAt: integer("finished_at")
  },
  (t) => [index("jobs_status").on(t.status), index("jobs_revision").on(t.revision)]
)

// One row per request to the LLM API, including failed ones.
export const llmCalls = sqliteTable(
  "llm_calls",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").references(() => jobs.id, { onDelete: "set null" }),
    task: text("task").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    tokensIn: integer("tokens_in").notNull(),
    tokensOut: integer("tokens_out").notNull(),
    // True when the API reported no usage and tokens were estimated from length.
    tokensEstimated: integer("tokens_estimated", { mode: "boolean" }).notNull(),
    cost: real("cost").notNull(),
    // ok, invalid, refused or unavailable
    outcome: text("outcome").notNull(),
    detail: text("detail"),
    createdAt: integer("created_at").notNull()
  },
  (t) => [index("llm_calls_job").on(t.jobId)]
)

// Books the Curator added. The file is stored once in the data folder's books
// folder, named by its SHA-256, so the same file is never added twice.
export const books = sqliteTable("books", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  edition: text("edition").notNull(),
  official: integer("official", { mode: "boolean" }).notNull(),
  fileHash: text("file_hash").notNull().unique(),
  fileSize: integer("file_size").notNull(),
  // added, unreadable, previewed, mapping, map-proposed or mapped
  status: text("status").notNull(),
  // Why the file could not be read.
  note: text("note"),
  pageCount: integer("page_count"),
  textPages: integer("text_pages"),
  // How pages with no text layer are read: image or review.
  scannedRoute: text("scanned_route"),
  // The cost preview, as JSON, once the sample has run.
  preview: text("preview"),
  // The job working on the Book now: reading it, proposing its Book Map or
  // extracting its Questions.
  jobId: text("job_id").references(() => jobs.id, { onDelete: "set null" }),
  // The spend cap the Curator set for the full run, in dollars; the jobs of
  // the run share it.
  runCap: real("run_cap"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
})

// Each page's text as read from the file, how the page is read, and what the
// Book Map model found on it.
export const bookPages = sqliteTable(
  "book_pages",
  {
    bookId: text("book_id").notNull().references(() => books.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    text: text("text").notNull(),
    hasText: integer("has_text", { mode: "boolean" }).notNull(),
    // text, image or review
    route: text("route").notNull(),
    // JSON: role, group and chapter, with the model, prompt version and time.
    survey: text("survey")
  },
  (t) => [primaryKey({ columns: [t.bookId, t.number] })]
)

// Book Maps the Book Map model proposed; the newest is shown to the Curator.
export const bookMapProposals = sqliteTable(
  "book_map_proposals",
  {
    id: text("id").primaryKey(),
    bookId: text("book_id").notNull().references(() => books.id, { onDelete: "cascade" }),
    // JSON array of ranges.
    ranges: text("ranges").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (t) => [index("book_map_proposals_book").on(t.bookId)]
)

// Book Maps the Curator confirmed. Each confirmation is a new version.
export const bookMaps = sqliteTable(
  "book_maps",
  {
    bookId: text("book_id").notNull().references(() => books.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    // JSON array of ranges.
    ranges: text("ranges").notNull(),
    confirmedAt: integer("confirmed_at").notNull()
  },
  (t) => [primaryKey({ columns: [t.bookId, t.version] })]
)

// What extraction read on one page in one role, as the model returned it. A
// Book Map fix reads again only the pages whose role or group changed.
export const pageReadings = sqliteTable(
  "page_readings",
  {
    bookId: text("book_id").notNull().references(() => books.id, { onDelete: "cascade" }),
    page: integer("page").notNull(),
    // questions, answer-key, explanations or difficulty-labels
    role: text("role").notNull(),
    // The Question Type group the page was read as, such as ps.
    group: text("group_name").notNull(),
    // JSON: the items found on the page.
    items: text("items").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (t) => [primaryKey({ columns: [t.bookId, t.page, t.role, t.group] })]
)

// A table of typed values (ADR 0006): a Data Insights table, or the data a
// chart draws. See api/dataset.ts for the columns and cells.
export const datasets = sqliteTable("datasets", {
  id: text("id").primaryKey(),
  // JSON: each column's name, type and unit.
  columns: text("columns").notNull(),
  // JSON: rows of cells, each the text the Book prints and its value.
  rows: text("rows").notNull(),
  // book or generator
  origin: text("origin").notNull(),
  createdAt: integer("created_at").notNull()
})

// Material Questions are asked about, shown in its own pane beside each of
// them: a Reading Comprehension passage, a table, a chart, a figure kept as
// a page image, or the tabs of a Multi-Source Reasoning set, each tab a
// Stimulus of its own. The Questions of one Stimulus share one Mock Reserve
// decision and are served one after another.
export const stimuli = sqliteTable(
  "stimuli",
  {
    id: text("id").primaryKey(),
    // passage, table, chart, figure or tabs
    kind: text("kind").notNull(),
    // Markdown with LaTeX math; see api/richText.ts. For a table, chart or
    // figure, the words printed with it; empty for tabs.
    body: text("body").notNull(),
    // The Stimulus as compared when looking for the same one in another Book.
    normalizedHash: text("normalized_hash").notNull(),
    // A table's rows, or the data its chart draws.
    datasetId: text("dataset_id").references(() => datasets.id, { onDelete: "restrict" }),
    // JSON: a chart's Vega-Lite spec, its data named "dataset", or a Venn
    // diagram's own spec.
    chartSpec: text("chart_spec"),
    // JSON: a figure kept as an image: its Book, page, the band of the page it
    // takes (top and bottom, as shares of the page's height) and the image
    // file's hash.
    figure: text("figure"),
    // A tab: the tabs Stimulus it belongs to, its place and its title.
    parentId: text("parent_id"),
    position: integer("position"),
    title: text("title"),
    createdAt: integer("created_at").notNull()
  },
  (t) => [index("stimuli_hash").on(t.normalizedHash), index("stimuli_parent").on(t.parentId)]
)

// The Question Bank. A Question keeps the model and prompt that extracted it.
export const questions = sqliteTable(
  "questions",
  {
    id: text("id").primaryKey(),
    section: text("section").notNull(),
    // A Question Type id from the Taxonomy, such as quant.ps.
    questionType: text("question_type").notNull(),
    // The passage it asks about, for a Reading Comprehension Question.
    stimulusId: text("stimulus_id").references(() => stimuli.id, { onDelete: "restrict" }),
    // Markdown with LaTeX math; see api/richText.ts.
    stem: text("stem").notNull(),
    // draft, held, published or withdrawn
    status: text("status").notNull(),
    // Stem and options as compared when looking for the same Question.
    normalizedText: text("normalized_text").notNull(),
    normalizedHash: text("normalized_hash").notNull(),
    // easy, medium or hard, as a Book printed it.
    bookLabel: text("book_label"),
    taxonomyVersion: integer("taxonomy_version").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    // Tags from the Taxonomy, and the LLM's Difficulty estimate on the
    // Difficulty scale, with the model and prompt that gave them.
    primarySkill: text("primary_skill"),
    // JSON array of up to two Skill ids.
    secondarySkills: text("secondary_skills").notNull().default("[]"),
    difficultyEstimate: real("difficulty_estimate"),
    tagsModel: text("tags_model"),
    tagsPromptVersion: text("tags_prompt_version"),
    taggedAt: integer("tagged_at"),
    // The starting Difficulty: from the Book Label, else the estimate.
    difficultySeed: real("difficulty_seed"),
    // book-label or estimate
    difficultyBasis: text("difficulty_basis"),
    // JSON array of { code, detail }: what extraction and linking found,
    // such as a missing key or a near match, for the Publish Gate.
    linkReasons: text("link_reasons").notNull().default("[]"),
    // The Question this one may repeat: a near match, or the same text.
    relatedQuestionId: text("related_question_id"),
    // What enrichment still owes the Question: pending (all of it),
    // key-content (Approaches and wrong-option notes after a key change)
    // or done.
    enrichment: text("enrichment").notNull().default("pending"),
    // Whether the Question belongs to the Mock Reserve; null until decided.
    reserve: integer("reserve", { mode: "boolean" }),
    reserveDecidedAt: integer("reserve_decided_at"),
    // When the Curator released a Reserve Question into Practice Sets; one-way.
    releasedAt: integer("released_at"),
    // The Question the Curator merged this one into. A merged Question stays,
    // withdrawn, and a Learner's history with it counts for that Question.
    mergedInto: text("merged_into"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    index("questions_hash").on(t.normalizedHash),
    index("questions_stimulus").on(t.stimulusId),
    index("questions_status").on(t.status),
    index("questions_enrichment").on(t.enrichment)
  ]
)

export const parts = sqliteTable(
  "parts",
  {
    id: text("id").primaryKey(),
    questionId: text("question_id").notNull().references(() => questions.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    // single-choice (one of five options, as in PS, DS, CR, RC and some
    // MSR), two-choice (a statement row such as Yes or No), dropdown (a GI
    // blank) or column-choice (one column of a TPA grid)
    kind: text("kind").notNull(),
    prompt: text("prompt"),
    // The right option's label, such as C; null while no key is known.
    key: text("key"),
    // book, computed or override
    keyBasis: text("key_basis")
  },
  (t) => [uniqueIndex("parts_question_position").on(t.questionId, t.position)]
)

export const options = sqliteTable(
  "options",
  {
    partId: text("part_id").notNull().references(() => parts.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    label: text("label").notNull(),
    text: text("text").notNull()
  },
  (t) => [primaryKey({ columns: [t.partId, t.position] })]
)

// Where a Question came from. One per extracted item: a Book's item that
// repeats a Question already in the Bank joins it as another Source. An item
// is known by its Book, the page it starts on and its number, so renaming its
// set in the Book Map keeps it the same item.
export const sources = sqliteTable(
  "sources",
  {
    id: text("id").primaryKey(),
    questionId: text("question_id").notNull().references(() => questions.id, { onDelete: "cascade" }),
    bookId: text("book_id").notNull().references(() => books.id, { onDelete: "cascade" }),
    // The question set's name as the Book Map gives it.
    set: text("set_name").notNull(),
    number: integer("number").notNull(),
    page: integer("page").notNull(),
    // What the Book gives for this item: the key it takes (the answer key's,
    // else the explanation's), and the explanation's own answer.
    bookKey: text("book_key"),
    explanation: text("explanation"),
    explanationAnswer: text("explanation_answer"),
    bookLabel: text("book_label"),
    // True when the item joined a Question that was already in the Bank.
    merged: integer("merged", { mode: "boolean" }).notNull(),
    // The Book Map version that last produced the item; older ones have left
    // the map.
    mapVersion: integer("map_version").notNull().default(0),
    createdAt: integer("created_at").notNull()
  },
  (t) => [uniqueIndex("sources_book_page_item").on(t.bookId, t.page, t.number), index("sources_question").on(t.questionId)]
)

// Items a Book holds that do not become Questions, such as Retired items.
export const bookSkips = sqliteTable(
  "book_skips",
  {
    bookId: text("book_id").notNull().references(() => books.id, { onDelete: "cascade" }),
    set: text("set_name").notNull(),
    number: integer("number").notNull(),
    page: integer("page").notNull(),
    // sentence-correction, geometry, or repeated-number for a second item
    // with a number its set already has
    reason: text("reason").notNull(),
    mapVersion: integer("map_version").notNull().default(0)
  },
  (t) => [primaryKey({ columns: [t.bookId, t.page, t.number] })]
)

// The Review Queue: a Question held with every reason, or a page extraction
// could not read.
export const reviewItems = sqliteTable(
  "review_items",
  {
    id: text("id").primaryKey(),
    questionId: text("question_id").references(() => questions.id, { onDelete: "cascade" }),
    // For a page that could not be read.
    bookId: text("book_id").references(() => books.id, { onDelete: "cascade" }),
    page: integer("page"),
    // JSON array of { code, detail }.
    reasons: text("reasons").notNull(),
    // The Question this one may repeat.
    relatedQuestionId: text("related_question_id").references(() => questions.id, { onDelete: "set null" }),
    // open or decided
    status: text("status").notNull(),
    // published, withdrawn, variant, merged or dismissed
    decision: text("decision"),
    createdAt: integer("created_at").notNull(),
    decidedAt: integer("decided_at")
  },
  (t) => [
    index("review_items_status").on(t.status),
    index("review_items_question").on(t.questionId),
    uniqueIndex("review_items_page").on(t.bookId, t.page)
  ]
)

// Independent LLM solves of a Question, kept so a key change can be checked
// against them without solving again.
export const solverRuns = sqliteTable(
  "solver_runs",
  {
    questionId: text("question_id").notNull().references(() => questions.id, { onDelete: "cascade" }),
    run: integer("run").notNull(),
    // The option the solver chose.
    answer: text("answer").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (t) => [primaryKey({ columns: [t.questionId, t.run] })]
)

// Worked routes to a Question's answer, each with one Strategy. The Book's
// own explanation is one.
export const approaches = sqliteTable(
  "approaches",
  {
    id: text("id").primaryKey(),
    questionId: text("question_id").notNull().references(() => questions.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    // A Strategy id from the Taxonomy.
    strategy: text("strategy").notNull(),
    // Markdown with LaTeX.
    steps: text("steps").notNull(),
    expectedSeconds: integer("expected_seconds").notNull(),
    validWhen: text("valid_when").notNull(),
    // book or llm
    author: text("author").notNull(),
    // The option the Approach arrives at.
    answer: text("answer"),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (t) => [index("approaches_question").on(t.questionId)]
)

// For each wrong option: why it tempts, the Mistake Type it most likely
// signals and, where one fits, its Trap Pattern.
export const optionNotes = sqliteTable(
  "option_notes",
  {
    partId: text("part_id").notNull().references(() => parts.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    trapNote: text("trap_note").notNull(),
    mistakeType: text("mistake_type").notNull(),
    trapPattern: text("trap_pattern"),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (t) => [primaryKey({ columns: [t.partId, t.position] })]
)

// Curator decisions that replace a Book's key, with the reason.
export const keyOverrides = sqliteTable(
  "key_overrides",
  {
    id: text("id").primaryKey(),
    partId: text("part_id").notNull().references(() => parts.id, { onDelete: "cascade" }),
    previousKey: text("previous_key"),
    newKey: text("new_key").notNull(),
    reason: text("reason").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (t) => [index("key_overrides_part").on(t.partId)]
)

// The golden set: the first Questions the Curator approves from the first
// Book, with the text, Parts, key and tags the Curator confirmed. Prompt and
// model changes are measured against it.
export const goldenQuestions = sqliteTable("golden_questions", {
  questionId: text("question_id").primaryKey().references(() => questions.id, { onDelete: "cascade" }),
  bookId: text("book_id").notNull().references(() => books.id, { onDelete: "cascade" }),
  set: text("set_name").notNull(),
  number: integer("number").notNull(),
  page: integer("page").notNull(),
  // JSON: stem, options, key, question type, primary and secondary Skills.
  expected: text("expected").notNull(),
  approvedAt: integer("approved_at").notNull()
})

// Checks of the golden set against the current prompts and models: each
// re-reads the golden Questions' pages and re-tags them, then reports.
export const goldenRuns = sqliteTable("golden_runs", {
  id: text("id").primaryKey(),
  jobId: text("job_id").references(() => jobs.id, { onDelete: "set null" }),
  createdAt: integer("created_at").notNull(),
  finishedAt: integer("finished_at"),
  // JSON: the report, once the run has finished.
  report: text("report")
})

// A golden run's fresh readings, kept apart from the Book's own.
export const goldenRunReadings = sqliteTable(
  "golden_run_readings",
  {
    runId: text("run_id").notNull().references(() => goldenRuns.id, { onDelete: "cascade" }),
    page: integer("page").notNull(),
    role: text("role").notNull(),
    group: text("group_name").notNull(),
    items: text("items").notNull()
  },
  (t) => [primaryKey({ columns: [t.runId, t.page, t.role, t.group] })]
)

// A golden run's fresh tags, by Question.
export const goldenRunTags = sqliteTable(
  "golden_run_tags",
  {
    runId: text("run_id").notNull().references(() => goldenRuns.id, { onDelete: "cascade" }),
    questionId: text("question_id").notNull(),
    // Null when the tagging reply could not be used.
    primarySkill: text("primary_skill"),
    secondarySkills: text("secondary_skills").notNull()
  },
  (t) => [primaryKey({ columns: [t.runId, t.questionId] })]
)

// Sessions and what they record. Served Questions and Responses are facts:
// written once, never edited (ADR 0005).

// One sitting of a Mock, a Sectional or a Practice Set.
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
    // practice, for now
    kind: text("kind").notNull(),
    timed: integer("timed", { mode: "boolean" }).notNull(),
    // JSON: how the Session was chosen, the Questions planned in order, and
    // those held for Mocks.
    config: text("config").notNull(),
    // active, paused or finished
    status: text("status").notNull(),
    // A timed Session's clock (ADR 0009): its limit, the elapsed time as last
    // saved and when, and whether time was lost to a stop.
    timeLimitMs: integer("time_limit_ms"),
    elapsedMs: integer("elapsed_ms").notNull().default(0),
    clockSavedAt: integer("clock_saved_at"),
    interrupted: integer("interrupted", { mode: "boolean" }).notNull().default(false),
    // The device that holds the Session; null when any may act on it.
    holder: text("holder"),
    // finished, or time when the clock ran out
    endedBy: text("ended_by"),
    createdAt: integer("created_at").notNull(),
    finishedAt: integer("finished_at")
  },
  (t) => [index("sessions_profile").on(t.profileId, t.status)]
)

// Each Question a Session served, in order; what made it Seen.
export const servedQuestions = sqliteTable(
  "served_questions",
  {
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    // A Question with history is withdrawn, never deleted, so its facts stay.
    questionId: text("question_id").notNull().references(() => questions.id, { onDelete: "restrict" }),
    servedAt: integer("served_at").notNull(),
    // In a timed Session, its clock when the Question was served.
    servedElapsedMs: integer("served_elapsed_ms")
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.position] }), index("served_questions_question").on(t.questionId)]
)

export const responses = sqliteTable(
  "responses",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    questionId: text("question_id").notNull().references(() => questions.id, { onDelete: "restrict" }),
    // The client's sequence number in the Session: a submit sent twice is
    // recorded once.
    seq: integer("seq").notNull(),
    // JSON array of { part, choice }: what was selected for each Part.
    selection: text("selection").notNull(),
    timeSpentMs: integer("time_spent_ms").notNull(),
    guessed: integer("guessed", { mode: "boolean" }).notNull(),
    // first, edit, retry or time-out
    kind: text("kind").notNull(),
    supersedes: text("supersedes"),
    createdAt: integer("created_at").notNull()
  },
  (t) => [
    uniqueIndex("responses_session_seq").on(t.sessionId, t.seq),
    index("responses_profile_question").on(t.profileId, t.questionId)
  ]
)

// A Profile's Bookmarks: one per Question, whichever set marked it, so a
// Bookmark can be cleared from any set that shows the Question.
export const bookmarks = sqliteTable(
  "bookmarks",
  {
    profileId: text("profile_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
    questionId: text("question_id").notNull().references(() => questions.id, { onDelete: "cascade" }),
    // The set it was marked in.
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull()
  },
  (t) => [primaryKey({ columns: [t.profileId, t.questionId] })]
)

// Derived and rebuildable: a Question's current Difficulty, moved from its
// seed by Rated Responses. A Question without a row is at its seed.
export const difficulty = sqliteTable("difficulty", {
  questionId: text("question_id").primaryKey().references(() => questions.id, { onDelete: "cascade" }),
  value: real("value").notNull(),
  ratedResponses: integer("rated_responses").notNull()
})

// Section Score Estimates as they stood after each Rated Response: derived,
// kept for the trend, and rebuildable.
export const scoreEstimates = sqliteTable(
  "score_estimates",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
    section: text("section").notNull(),
    at: integer("at").notNull(),
    ability: real("ability").notNull(),
    standardError: real("standard_error").notNull(),
    score: integer("score").notNull(),
    low: integer("low").notNull(),
    high: integer("high").notNull(),
    calibrated: integer("calibrated", { mode: "boolean" }).notNull(),
    ratedResponses: integer("rated_responses").notNull()
  },
  (t) => [index("score_estimates_profile").on(t.profileId, t.section, t.at)]
)
