import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core"

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
  // The job reading the Book or proposing its Book Map.
  jobId: text("job_id").references(() => jobs.id, { onDelete: "set null" }),
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
