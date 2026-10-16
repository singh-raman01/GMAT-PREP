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

// The Question Bank. A Question keeps the model and prompt that extracted it.
export const questions = sqliteTable(
  "questions",
  {
    id: text("id").primaryKey(),
    section: text("section").notNull(),
    // A Question Type id from the Taxonomy, such as quant.ps.
    questionType: text("question_type").notNull(),
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
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [index("questions_hash").on(t.normalizedHash), index("questions_status").on(t.status)]
)

export const parts = sqliteTable(
  "parts",
  {
    id: text("id").primaryKey(),
    questionId: text("question_id").notNull().references(() => questions.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    // single-choice for PS, DS, CR and RC
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
// repeats a Question already in the Bank joins it as another Source.
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
    // What the Book gives for this item.
    bookKey: text("book_key"),
    explanation: text("explanation"),
    bookLabel: text("book_label"),
    // True when the item joined a Question that was already in the Bank.
    merged: integer("merged", { mode: "boolean" }).notNull(),
    createdAt: integer("created_at").notNull()
  },
  (t) => [uniqueIndex("sources_book_item").on(t.bookId, t.set, t.number), index("sources_question").on(t.questionId)]
)

// Items a Book holds that do not become Questions, such as Retired items.
export const bookSkips = sqliteTable(
  "book_skips",
  {
    bookId: text("book_id").notNull().references(() => books.id, { onDelete: "cascade" }),
    set: text("set_name").notNull(),
    number: integer("number").notNull(),
    page: integer("page").notNull(),
    // sentence-correction or geometry
    reason: text("reason").notNull()
  },
  (t) => [primaryKey({ columns: [t.bookId, t.set, t.number] })]
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
