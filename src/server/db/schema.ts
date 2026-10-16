import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

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
