# The job worker runs in its own process and shares the database

Parsing PDFs and rendering pages is CPU-heavy, and a malformed file can stall or crash the process doing it, which must never freeze a running Mock. Ingestion, generation, Lesson writing and full rebuilds therefore run in a separate worker process that the app server starts and restarts. The database is the job queue: the server adds jobs, and the worker claims them, saves progress after each step and writes results, so the two processes need no other channel. Both processes write to the one SQLite file, which WAL mode allows on a single machine, and every transaction stays short. Expected result: no ingestion failure can stop or slow a Session, a learner's write waits at most a few milliseconds for the worker, and an interrupted job resumes from its last saved step.

## Considered options

- Jobs inside the app server process: rejected. A stalled or crashed parser would take a running Mock with it.
- Only the server writes, with the worker sending results over IPC: rejected. It adds a protocol for no gain at this write volume.
