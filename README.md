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

Under Books, choose the book's PDF (up to 500 MB), give its title and edition, and say whether it is official GMAC material. The app reads every page, then tries the full run on 10 pages spread through the book: the Book Map model reads them, and the extraction model reads those with questions, keys or explanations. It shows what the full run would cost. Nothing more is spent until you start the full run with a spend cap, which covers the whole run even if you cancel and start it again. The Book Map model then reads every page in order and proposes the Book Map: where the book's questions, answer keys, explanations and difficulty labels are. You can also enter the Book Map yourself instead. Correct it on the book's page, opening any page in the browser's PDF viewer to check, and confirm it. Each confirmation is a new version, and starts extracting the book's questions of every Focus type: Problem Solving, Critical Reasoning, Reading Comprehension, and the Data Insights types, Data Sufficiency, Table Analysis, Graphics Interpretation, Two-Part Analysis and Multi-Source Reasoning. Data Sufficiency joins Data Insights, as on the Focus exam, even from an older book that prints it under Quant, and an older book's Integrated Reasoning becomes the Data Insights types it maps onto. Each passage, table and set of sources is kept once and shown beside every question about it. Tables keep typed columns, so they sort by value; charts are redrawn from their data, and one that will not draw waits for you. A figure that cannot become data is kept as an image of its part of the page and waits for you too. Sentence Correction and geometry are counted and skipped, since the Focus exam dropped them.

## Review the questions

Each extracted question is enriched: tagged with its Skills from the Taxonomy, given a Difficulty estimate, solved three times on its own, and given Approaches and a note for each wrong choice. Questions that pass every check are published on their own.

The rest wait in the Review Queue, each with every reason:

- answer choices that are not A to E, a passage question with no passage or with two, or text whose math does not render;
- no key, a key that disagrees with the explanation, or another book giving another key;
- a figure the text does not hold, shown as its image from the page, or a chart that will not draw;
- a near match, or the same text with another key, to a question already in the bank, including a question about a passage another edition prints with a few words changed;
- tags that do not fit the Taxonomy;
- a solve that disagrees with the key, or an Approach that misses it;
- a missing note on a wrong choice;
- a book's difficulty label two bands from the estimate.

You can publish past a solver's doubt or a difficulty mismatch, change the key with a reason (for a question with several parts, one part's key at a time; the question's Approaches and notes are written again and it is checked again), keep a near match as a Variant or merge it into the other question, move a question about a passage another edition reprints to the other question's passage when they are the same passage, or withdraw it. Fixing the Book Map checks each question again, and questions it no longer covers leave the bank. The book's page shows what became of every question it held.

A quarter of each book's questions is held back for Mocks, spread over question types and difficulty bands, with a passage's questions kept together, whichever book they come from. A passage that grows or shrinks past what a Mock could serve is released. The Books screen shows how many each Section holds back and can release some into Practice Sets, a passage at a time; release cannot be undone. It also lists Skills with fewer than 15 questions.

If a reply was unusable, "Check again" asks once more for the tags, solves, Approaches or notes. Questions waiting for a check that no job will run, as after a cancelled job, are counted at the top of the Review Queue with a button to check them.

Under Golden set, approve the first book's questions with their Skills, up to a hundred. Checking the golden set reads their pages again and tags them again with the current models. It passes when text, answer choices and keys are all exact and the Skills match yours on 90% or more. Run it after changing a model or prompt.

## Generate Data Insights questions

Under Generate, ask for a batch of Table Analysis, Graphics Interpretation, Two-Part Analysis or Multi-Source Reasoning questions: a Skill, a difficulty, how many (Multi-Source Reasoning comes in sets of three questions on shared tabs) and a spend cap. Set models for Generation and Statement translation in Settings first, and for tagging, solving and Approaches, which every new question goes through. The generator writes each question on a table of its own, with a small query for every statement, and the app works out each answer by running the query on the table, never from the model's arithmetic. A second model call reads each statement's words again and writes its own query; when the two give different answers, the question waits in the Review Queue until you change that part's key or withdraw it. A Multi-Source Reasoning statement that is an inference from the text cannot be checked this way, so it always waits for you: you can publish it when its three solves agree with its key, and otherwise change that key or withdraw it. Generated questions then go through the same checks as a book's, a repeat of another question waits beside it, and a quarter of the generated questions of each type is held back for Mocks.

## Practise

Open your Profile and choose Practice. Pick Questions by Section, Question Type, Skill, Difficulty and whether you have seen, missed or Bookmarked them, or follow a book in its own order, as in one book's Data Sufficiency 1 to 30. A set shows one Question at a time, with a reading passage, a table, a chart or a set of tabbed sources beside its Questions, which come one after another: choose with A to E, mark it as a guess if it was one, and submit with Enter. Data Insights Questions come as on the exam: a table you can sort with a Yes or No for each statement, a chart or figure with a menu in each sentence, a two-column grid, or tabbed sources. A Question with several parts is right only when every part is, and the on-screen calculator is there for Data Insights only. The Debrief follows straight away: why the option you picked tempts, and the ways to solve it, fastest first. "Practise 3 similar" starts a short set of unseen Questions with the same main Skill and Question Type and a similar Difficulty. Questions held back for Mocks stay out of your sets until the Curator releases them or you have seen them; in a book-order set they are listed as held for Mocks. Untimed sets never change your scores.

Tick "Time the set" for a timed set. It gives each Question its Target Time (2:09 in Quant, 1:57 in Verbal and 2:15 in Data Insights unless the Curator sets a Question Type's own under Settings) and runs on the app's clock, not the browser's: closing the tab does not stop it, so pause it when you step away. Each answer brings the next Question at once, and the Debriefs wait for the end. When time runs out, the set ends on its own and the Question on screen counts as timed out. A timed answer to a Question you had not seen before is Rated: when the set ends, it moves that Question's Difficulty and your Section's Score Estimate, which the Practice page shows with its likely range. A set is held by one tab at a time; another tab or device can look at it and take it over.

A forgotten passphrase is cleared on the computer the app runs on, with the app running or not:

```sh
gmat-prep reset-passphrase     # the executable you run
bun src/server/main.ts reset-passphrase   # from the repo
```

## Take a Sectional

Choose Sectionals for one Section on its own, as on the exam: 45 minutes, adaptive, and no going back. Each Question must be answered before the next appears, and the next one is picked from your answers so far, from the Questions held back for Mocks first. A reading passage or a Multi-Source Reasoning set comes as one unit, its Questions one after another. Bookmark any Question as you go. If time is left after the last Question, Review & Edit lists them all and lets you change up to three answers; if time runs out first, the Question on screen counts as timed out and there is no review. The report gives your Section score with its likely range, each Question's Difficulty, result and time, and whether your changes gained or lost points. Difficulty and your Score Estimates move only when the Section closes. While a Sectional runs, Practice Sets leave out the Questions it has chosen, so nothing there shows their answers before the Section ends. If an answer key changes later, the report follows it and says it was rescored.

A Sectional starts only when the Questions held back for Mocks that you have not seen come to at least twice what the Section asks of each group; the page says what is missing otherwise. The Curator sets how many Questions each group gets, and the sizes of reading passages and Multi-Source Reasoning sets, under Settings, Section Blueprint.

## Take a Mock

Choose Mocks for the whole exam: the three Sections in the order you pick, each run as a Sectional is, with one optional 10-minute break. The break begins as soon as the first Section closes; go on within its first minute to keep it for after the second Section instead. When a break runs out, the next Section starts on its own. A closed Section shows nothing until the Mock is over; then the report gives the Total with its likely range, each Section's score and report, and any time lost to an Interruption or Questions you had seen before. A Mock starts only when every Section passes the start check a Sectional uses.

Under Done on paper, mark the Books, or the pages of them, you worked through on paper. Their Questions count as seen: Mocks and Sectionals use them only when unseen ones run out, Practice Sets can use them, and answers to them never move your Score Estimates.

## Error Log

Every Question you answer wrong, slowly or by a guess goes into your Error Log, one entry each with every answer you gave it. A wrong answer's Debrief says what went wrong in each wrong part, as a Mistake Type the app picks from your answer and its timing; one tap changes it, and your choice is kept. An answer you fixed in Review & Edit stays out, and a Sectional's or Mock's answers come in only once their results show. Filter the log by Section, Question Type, Skill, Mistake Type, Trap Pattern, Difficulty, Book, status or date, and open an entry to see the Question and its Debrief again.

## Scores

Scores shows each Section's Score Estimate, and the Total once all three have one. Enter an Official Score from an official practice exam or the GMAT itself to calibrate them: each one is matched with your estimates as they stood that day, so it calibrates only the Sections you had an estimate for by then. One shifts each Section's scale to match it, and two or more fit it.

## Check it

```sh
bun run typecheck
bun test
```

After changing `src/server/db/schema.ts`, run `bun run db:generate` to write the migration and bundle it.
