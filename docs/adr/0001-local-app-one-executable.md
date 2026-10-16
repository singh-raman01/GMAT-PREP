# Local app: one executable on Bun, Effect 4 and SQLite

The app runs on one machine for a handful of Profiles, so nothing in its load needs a database server or a cloud host. `bun build --compile` produces one executable per OS that holds the web app, the app server and the job worker. It runs as two processes (ADR 0010) over one SQLite file in WAL mode, plus a data folder for Books, page images and snapshots. The backend uses Effect 4, stable since 1 October 2026, for typed errors, retries and resumable jobs. The server accepts connections from this computer only. LAN mode lets a tablet in once it enters a pairing code shown on the host; its traffic is plain HTTP, so it is meant for a trusted network. Expected result: one file to install, one command to start, and a backup that is a database snapshot plus the Book files.

## Considered options

- Postgres in Docker: rejected. It adds a service to install and run, and no load here needs it.
- Tauri desktop app: rejected. A tablet could not reach it.
- Hosted web app: out of scope. The brief is a local installation.
- Effect 3.x: rejected. Effect 4.0 went stable before any code was written, so starting on 3.x would only mean a migration later.
