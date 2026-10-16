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

Open Curator tools from the profile page and set the Curator passphrase. Under Settings, enter the base URL of an OpenAI-compatible chat completions API, the API key, a model for each task and each model's prices, and mark the models that accept images. Then test the connection. The Jobs page shows the test's result and what it cost.

## Add a book

Under Books, choose the book's PDF (up to 500 MB), give its title and edition, and say whether it is official GMAC material. The app reads every page, then tries the full run on 10 pages spread through the book: the Book Map model reads them, and the extraction model reads those with questions, keys or explanations. It shows what the full run would cost. Nothing more is spent until you start the full run with a spend cap, which covers the whole run even if you cancel and start it again. The Book Map model then reads every page in order and proposes the Book Map: where the book's questions, answer keys, explanations and difficulty labels are. You can also enter the Book Map yourself instead. Correct it on the book's page, opening any page in the browser's PDF viewer to check, and confirm it. Each confirmation is a new version, and starts extracting the book's Problem Solving questions.

## Review the questions

Extracted questions wait in the Review Queue, each with every problem found: no key, a key that disagrees with the explanation, math that does not render, a figure the text does not hold, or a near match to a question already in the bank. Publish a question to put it in the Question Bank, keep a near match as a Variant or merge it into the other question, or withdraw it. The book's page shows what became of every question it held.

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
