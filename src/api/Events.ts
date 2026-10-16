import { Schema } from "effect"
import { JobView } from "./Jobs.ts"

// Events the server pushes over the one Server-Sent Events stream per device,
// GET /api/events. Each arrives as a message whose data is one event as JSON.

export class JobChanged extends Schema.TaggedClass<JobChanged>()("JobChanged", {
  job: JobView
}) {}

export const ServerEvent = Schema.Union([JobChanged])
export type ServerEvent = typeof ServerEvent.Type

export const EventsPath = "/api/events"
