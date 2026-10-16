import { sql } from "drizzle-orm"
import { jobs } from "../db/schema.ts"

// The next job revision. SQLite runs one write at a time, so reading the
// maximum inside the same statement can never hand out a revision twice.
export const nextRevision = sql<number>`(select coalesce(max(${jobs.revision}), 0) + 1 from ${jobs})`
