# GMAT prep

A study app for the GMAT Focus Edition that runs on your own computer. It turns prep books into a Question Bank, builds Data Insights questions the books cannot hold, and runs timed Mocks, Practice Sets, an Error Log and a Study Plan for one or more Profiles. The design is in [docs/design.md](docs/design.md), the vocabulary in [GLOSSARY.md](GLOSSARY.md), and the decisions in [docs/adr](docs/adr).

## Run it from the repo

Needs [Bun](https://bun.sh) 1.4.2 or later.

```sh
bun install
bun dev
```

`bun dev` starts the app server (restarted when its code changes), its job worker, and the Vite dev server for the web app. Open the address Vite prints. Development data goes to `.data/` in the repo.

## Build the app

```sh
bun run build       # one executable for this computer, in dist/
bun run build:all   # Linux, macOS and Windows, x64 and arm64 where Bun supports them
```

Each executable holds the web app, the migrations and the Taxonomy. Run it and open the address it prints, normally http://127.0.0.1:4747. It accepts connections from this computer only.

| Setting | Default |
|---|---|
| `GMAT_PREP_DATA_DIR` | Linux `~/.local/share/gmat-prep` (or under `$XDG_DATA_HOME`), macOS `~/Library/Application Support/gmat-prep`, Windows `%APPDATA%\gmat-prep` |
| `GMAT_PREP_CONFIG_DIR` | where the LLM API key is kept, outside the data folder: Linux `~/.config/gmat-prep`, macOS `~/Library/Preferences/gmat-prep`, Windows `%LOCALAPPDATA%\gmat-prep` |
| `GMAT_PREP_PORT` | 4747, or the next free port within 20 |

## Set up the LLM

Open Curator tools from the profile page and set the Curator passphrase. Under Settings, enter the base URL of an OpenAI-compatible chat completions API, the API key, a model for each task and each model's prices, then test the connection. The Jobs page shows the test's result and what it cost.

A forgotten passphrase is cleared on the computer the app runs on, with the app running or not:

```sh
gmat-prep reset-passphrase     # the executable you run
bun src/server/main.ts reset-passphrase   # from the repo
```

## Check it

```sh
bun run typecheck
bun test
```

After changing `src/server/db/schema.ts`, run `bun run db:generate` to write the migration and bundle it.
