# GMAT prep design

Agreed in the design session of 15 and 16 October 2026. Terms follow GLOSSARY.md, decisions with a lasting cost have an ADR in docs/adr, and the C4 model is docs/workspace.dsl. Where this document sets a rule or starting value that the session did not discuss, it is listed under "Decisions added while writing this spec", and changes to agreed lines are listed under "Corrections to agreed lines".

## Problem statement

A Learner preparing for GMAT Focus owns prep Books full of good Questions, but paper cannot time a Section, adapt to the Learner's level, track every mistake or show which Skills cost the most points. Paper also cannot present Data Insights the way the exam does, with sortable tables, charts with dropdown blanks and tabbed sources. Online prep tools do these things only with their own content, and none of them can use the Learner's Books.

## Solution

One executable, installed and run on the Learner's own computer, that:

- reads the Curator's Books with an LLM and turns them into a verified Question Bank, holding back anything it cannot verify;
- writes new Data Insights Questions whose answer keys are computed by code from typed Datasets;
- runs Mocks, Sectionals and Practice Sets under exam rules, with a clock the browser cannot change;
- records every Response as a fact and derives Difficulty, Ability, Score Estimates and Weak Areas from those facts;
- logs every mistake with its cause, schedules Retries, builds a Study Plan, and teaches through Debriefs, Lessons and Tutor Chat;
- keeps working without the LLM, except for Tutor Chat.

Several Profiles share one install and one Question Bank.

## User stories

### Curator

1. As the Curator, I want to add a Book file and have the same file ignored if I add it again, so that the Question Bank never doubles up.
2. As the Curator, I want to mark a Book as official GMAC material, so that Weak Area priorities use official frequencies.
3. As the Curator, I want a cost projection from a 10-page sample before a Book's full run, so that I choose the spend knowingly.
4. As the Curator, I want to confirm the Book Map the app proposes, so that extraction reads the right page ranges for Questions, keys, explanations and difficulty labels.
5. As the Curator, I want each Book's report to count extracted, published, held, merged and skipped Questions, so that nothing vanishes silently.
6. As the Curator, I want Sentence Correction and geometry skipped and counted, so that the Question Bank holds only what GMAT Focus tests.
7. As the Curator, I want old Data Sufficiency and Integrated Reasoning content mapped into Data Insights, so that older Books still help.
8. As the Curator, I want an ingestion job to resume after a crash, a rate limit or a spend cap without paying again for finished pages, so that interruptions cost nothing.
9. As the Curator, I want a spend cap per job, so that a runaway job stops on its own.
10. As the Curator, I want every held Question to show why it was held, so that I can decide quickly.
11. As the Curator, I want to replace a Book's answer key with a stated reason, so that a known erratum stops teaching the wrong answer.
12. As the Curator, I want past Responses re-scored and the key-dependent teaching content rewritten after a key change, so that neither analytics nor Debriefs rest on a wrong key.
13. As the Curator, I want to fix a Book Map after the fact and re-run only the steps that depend on the keys, so that a misaligned answer key costs little LLM spend.
14. As the Curator, I want near matches put to me to judge as a Variant or a merge, so that changed numbers are never merged silently.
15. As the Curator, I want to generate Data Insights Questions in batches by Question Type, Skill and Difficulty, so that GI, TA, TPA and MSR practice does not depend on what my Books contain.
16. As the Curator, I want to approve generated statements that code cannot evaluate, so that nothing unverified is published.
17. As the Curator, I want to approve each Lesson before Learners see it, so that a person checks all teaching text.
18. As the Curator, I want to withdraw a Question without losing its history, so that a broken Question leaves practice while past results stay explainable.
19. As the Curator, I want to release Mock Reserve Questions into practice, so that I control the trade between practice volume and Mock freshness.
20. As the Curator, I want Question Bank coverage by Skill and Difficulty Band, and a list of Skills running out of Questions, so that I know which Books or generation batches to add.
21. As the Curator, I want Skills with fewer than 15 Questions flagged after ingestion, so that I can merge them into a related Skill.
22. As the Curator, I want Learners' Problem Reports in the Review Queue, so that suspected key errors reach me.
23. As the Curator, I want to set the API base URL, the key, a model per task and the price per model, so that I can use any OpenAI-compatible provider and see real spend.
24. As the Curator, I want a monthly Tutor Chat cap, so that chat spend stays bounded.
25. As the Curator, I want to see jobs, their progress and their spend, so that I know what the worker is doing.
26. As the Curator, I want to restore a snapshot, so that a bad change can be undone.
27. As the Curator, I want to export the whole install, so that I can move it to another computer.
28. As the Curator, I want to reset a Profile's PIN, so that a forgotten PIN does not lose a history.
29. As the Curator, I want to reset my passphrase with a command on the host computer, so that physical access is the final authority.
30. As the Curator, I want to turn on LAN mode, pair a tablet with a code shown on the host and revoke it later, so that only devices I approve can connect.

### Learner

31. As a Learner, I want to create one or more Profiles, each with an optional PIN, so that a retake cycle or a second person keeps a separate history.
32. As a Learner, I want to set a test date, target score, weekly hours and days off, so that the Study Plan fits my life.
33. As a Learner, I want to start with a Diagnostic, taken as one Mock or as three Sectionals over up to 3 days, so that the plan starts from evidence.
34. As a Learner, I want Mocks with Sections in my chosen order and the optional 10-minute break after the first or second Section, so that practice matches exam day.
35. As a Learner, I want Sectionals under the same rules, so that I can work on one Section at exam conditions.
36. As a Learner, I want Practice Sets chosen by Section, Question Type, Skill, Difficulty Band and status (unseen, missed, bookmarked), timed or untimed, so that I can aim my practice.
37. As a Learner, I want Practice Sets that follow a Book in order, such as one Book's Data Sufficiency 1 to 30, so that I can work alongside the printed book.
38. As a Learner, I want to mark a Book or a page range as studied on paper, so that Mocks avoid Questions I have already seen.
39. As a Learner, I want Mocks to adapt to my answers and to serve RC passages and MSR sets as a unit, so that they behave like the exam.
40. As a Learner, I want to Bookmark Questions and change up to three answers on the Review & Edit screen, so that I practise the exam's review rules.
41. As a Learner, I want the clock to keep running when I close the tab and the Session to resume exactly where I was, so that the Section is timed honestly.
42. As a Learner, I want time lost to a crash or a sleeping computer left uncounted, with the Session marked, so that an Interruption does not cost me the Section.
43. As a Learner, I want to take over a Session from another device after confirming, so that a stuck tab never blocks me.
44. As a Learner, I want the calculator only in Data Insights, so that I practise Quant without one.
45. As a Learner, I want to hide the timer, get a warning at 5 minutes, answer with the keyboard, and use dark mode and a larger font, so that the screen suits me.
46. As a Learner, I want to mark a Practice Set answer as guessed, so that a lucky guess still reaches my Error Log.
47. As a Learner, I want the Debrief after each Question in untimed Practice Sets and at the end of timed ones, so that I learn without breaking timing practice.
48. As a Learner, I want to pause Practice Sets, so that interruptions at home do not spoil them.
49. As a Learner, I want every Score Estimate shown with a range and marked uncalibrated until I enter an Official Score, so that I do not over-trust it.
50. As a Learner, I want to enter Official Scores, so that Score Estimates line up with GMAC's scale.
51. As a Learner, I want a Mock report with each Question's Difficulty, result and time, the effect of my Review & Edit changes, Interruptions and repeats, so that I can study the Mock afterwards.
52. As a Learner, I want a Debrief that explains why the option I picked tempted me, shows the verified Approaches fastest first and offers Siblings, so that each mistake teaches something.
53. As a Learner, I want wrong, slow and guessed Questions to enter my Error Log automatically, so that I never curate it by hand.
54. As a Learner, I want each wrong Part's Mistake Type filled in for me and changeable with one tap, so that tagging takes seconds.
55. As a Learner, I want missed Questions to come back on a Retry Ladder, first the same Question and then two Siblings, so that I prove I learned the Skill and not the answer.
56. As a Learner, I want Weak Areas ranked by the points they cost, each with a button that starts its remedy, so that I work on what matters most.
57. As a Learner, I want a Skill map shaded by each Skill's gap, grey where data is thin, so that I see the whole picture.
58. As a Learner, I want timing analysis by Question Type and a pacing curve for each Mock, so that I can fix time management.
59. As a Learner, I want Mistake Types and Trap Patterns tracked over time, so that I see whether careless errors are falling.
60. As a Learner, I want the Study Plan to rebuild itself each Study Day and after each Mock, and to list what it dropped when time runs short, so that the plan stays honest.
61. As a Learner, I want a Daily Log filled in automatically, with room for a note, so that I can see my consistency.
62. As a Learner, I want my Study Day to start at an hour I choose, 4 am by default, so that late sessions count for the right day.
63. As a Learner, I want a Lesson for every Skill and Question Type, with worked examples from real Questions and a 5-Question check, so that I can learn what I am weak at.
64. As a Learner, I want to ask Tutor Chat why my approach to a Question was wrong, so that I get an explanation of my own reasoning.
65. As a Learner, I want to report a Question I believe is wrong, so that the Curator checks it.
66. As a Learner, I want to use the app from a tablet on my home network, so that I can take a Mock away from my desk.
67. As a Learner, I want my Profile hidden from other Profiles on the same install, so that my results are private.
68. As a Learner, I want to export and delete my Profile, so that I own my data.
69. As a Learner, I want my Study Days to follow my time zone when I travel, so that the Daily Log stays correct.

## Implementation decisions

### The exam the app imitates

Checked against mba.com on 15 October 2026.

| Section | Questions | Time | Content |
|---|---|---|---|
| Quantitative Reasoning | 21 | 45 min | Problem Solving; no calculator; no geometry |
| Verbal Reasoning | 23 | 45 min | Critical Reasoning and Reading Comprehension |
| Data Insights | 20 | 45 min | DS, MSR, TA, GI, TPA; on-screen calculator |

- The exam lasts 2 hours 15 minutes for 64 Questions. Sections come in any order, with one optional 10-minute break after the first or second Section.
- A Question must be answered before the next appears. There is no skipping and no going back.
- Any Question can be Bookmarked. If time remains after the last Question, Review & Edit allows up to three changed answers. A Section that times out ends with no review.
- Section scores run from 60 to 90. The Total runs from 205 to 805 in steps of 10 and always ends in 5. The three Sections weigh equally, unanswered Questions lower the score, and GMAC does not publish its scoring formula.
- Multi-Part Data Insights Questions score all or nothing.

### System shape

![System context](diagrams/context.png)

![Containers](diagrams/containers.png)

![Deployment](diagrams/deployment-production.png)

| Container | Technology | Responsibility |
|---|---|---|
| Web app | React, Vite; static files | Learner and Curator screens |
| App server | Bun, Effect 4 | API, Session clock, adaptive selection, scoring, analytics, Study Plan, Tutor Chat |
| Job worker | Bun, Effect 4; separate process | Ingestion, generation, Lesson writing, full rebuilds; every LLM call except Tutor Chat |
| Database | SQLite in WAL mode | Everything except files; also the job queue |
| File store | Local folder | Books keyed by content hash, page images, figure crops, snapshots |

- `bun build --compile` makes one executable per OS. The app server starts the job worker from the same executable and restarts it if it dies (ADR 0001, ADR 0010). For development, `bun install && bun dev` runs from the repo.
- Data lives in the OS's app-data folder by default, and the location can be changed.
- The stack is Effect 4 (stable since 1 October 2026) with the Bun platform package, and Drizzle 1.0's Effect driver for Bun SQLite, pinned while it is a release candidate. Database access sits behind repository services, so the stable fallback, @effect/sql-sqlite-bun with hand-written SQL, can replace the driver without touching callers (ADR 0011).
- The API is HTTP JSON defined with Effect HttpApi and Schema. The web app calls it through a client derived from the same definitions. One Server-Sent Events stream per device, GET /api/events, pushes six events: clock sync, Section expired, Session claimed elsewhere, job progress, plan rebuilt and Review Queue changed. Job progress reaches the server through the database: each open stream reads changed jobs by revision twice a second. Each event's id is the revision it carries, so a page opens the stream after the job list it has read, and a browser that reconnects resumes from the last event it received. The stream's keep-alive checks the Curator unlock without counting as use, so an open page does not keep the Curator unlocked.
- Derived numbers update in small steps when a timed Practice Set ends, one Rated Response at a time, when a Sectional closes, and when a Mock ends, its Sections in the order taken. Full rebuilds, for example after a Key Override, run in the worker.
- The web app renders math with KaTeX, and both Question charts and analytics charts with Vega-Lite.

### Modules

Rules live in pure modules that take plain data and return plain data. Services wrap them with storage and time, which keeps the hard logic testable without a database.

| Module | Owns | Interface | Runs in |
|---|---|---|---|
| Taxonomy | Loading, validating and looking up the versioned Taxonomy | current version; whether a tag is valid for a Question Type | both |
| Question Bank | Questions, Parts, options, Stimuli, Datasets, Sources and Approaches; publishing, withdrawing, Key Overrides, dedupe | publish, withdraw, override a key, find candidates by filter | both |
| Ingestion | Book registry, cost preview, Book Map, extraction steps and their checkpoints | add a Book, preview cost, propose and confirm a Map, run a range | worker; adding a Book in the server |
| Publish Gate | Every check before publishing, and the Review Queue | check a draft and return pass, or held with reasons | worker |
| DI generator | Datasets, statements with predicates, computed keys, chart specs | generate a batch from a spec | worker |
| DI evaluator | Evaluating a predicate over a Dataset | evaluate a predicate against a Dataset | worker and tests |
| Renderer | Markdown with KaTeX, Vega-Lite to SVG, custom shapes such as Venn diagrams | render a Question, or fail with the reason | both |
| LLM adapter | Task routing, schema validation, retries, spend, the recorded-reply fake | call a task with input and an output schema | both |
| Session engine | Session lifecycle, Section clock, adaptive selection, Section Blueprint, Mock Reserve rules, Review & Edit, device claims, idempotent submits | start, claim, submit, Bookmark, edit, finish review, break, pause, resume | server |
| Ratings | Rated Response rules, Difficulty updates, Ability fits, Score Estimates, calibration | record a Rated Response, fit a Profile, score a Section, compute a Total, rebuild | server; rebuilds in worker |
| Learning | Error Log, Mistake Types, Retry Ladder, Sibling choice, Weak Areas | record a Response, set a Mistake Type, due Retries for a Study Day, Weak Areas | server |
| Planner | Study Plan rules and the Diagnostic | build a plan version from inputs, state and Study Day | server |
| Teaching | Debriefs, Lessons, Tutor Chat, Problem Reports | Debrief for a Response, Lesson for a subject, Tutor Chat message | server; Lesson writing in worker |
| Access | Profiles, PINs, the Curator passphrase, pairing, cookies, lockouts | create, unlock, pair, revoke, reset | server |
| Operations | Snapshots, restore, export, integrity checks, migrations, single-instance lock, worker supervision | snapshot, restore, export | server |

### Data model

Facts are written once and never edited. Derived tables can be dropped and rebuilt from facts and the current keys (ADR 0005). Plans are a third kind: append-only versions. Every row an LLM wrote records the model, prompt version and creation time.

Question Bank, written by the worker and by Curator decisions:

| Table | Holds |
|---|---|
| books | title, edition, file hash (unique), size, page count, pages with text, how scanned pages are read, official GMAC flag, status, cost preview, current job |
| book pages | Book, page number, text, whether it has a text layer, how it is read (text, image or Review Queue), what the Book Map model found on it |
| book map proposals | Book, page ranges, model, prompt version, time |
| book maps | Book, version, page ranges by role (questions, answer key, explanations, difficulty labels), each with its question set and Question Type group, confirmation time |
| page readings | Book, page, role, Question Type group, what the extraction model read there, model, prompt version, time |
| book skips | Book, question set, number, page, why it is not a Question (geometry or Sentence Correction) |
| stimuli | kind (passage, MSR tabs, table, chart, figure), Markdown body, Dataset, chart spec, figure crop, Reserve flag |
| datasets | typed columns (number, percent, currency, date, text), rows, whether a Book or the generator made it |
| questions | Section, Question Type, Stimulus, stem, status (draft, held, published, withdrawn), Difficulty seed and its basis (Book Label or LLM estimate), Book Label, primary and secondary Skills, Reserve flag, normalized-text hash, Taxonomy version |
| parts | Question, position, kind (single choice, yes/no, true/false, dropdown, column choice), prompt, key, key basis (Book, computed, override) |
| options | Part, position, text; for wrong options the Trap Note, Mistake Type and Trap Pattern |
| statement predicates | Part, predicate, independent second predicate, evaluated result (Generated Questions only) |
| approaches | Question, Strategy, steps, expected seconds, valid-when note, author (Book or LLM), position |
| sources | Question, with a Book, question set, page and number, the Book's key, explanation and label, and whether it joined a Question already in the Bank; or a generation batch |
| key overrides | Part, previous key, new key, reason, time |
| review items | Question, or a Book page extraction could not read; reasons, the related Question, status, decision, time |
| lessons | subject (Skill or Question Type), version, status (draft, approved or rejected), basis, content, words, worked-example and check Questions, model, prompt version, job, written and decided times, note (decision 93) |
| generation batches | spec, status, counts |

Profiles and activity, written by the server:

| Table | Holds |
|---|---|
| profiles | name, PIN hash, the time zone and rollover hour it was made with |
| profile days | Profile, time zone, rollover hour, when it takes effect (the next rollover), time set (decision 92) |
| plan settings | Profile, test date, target Total, weekly minutes, days off, Diagnostic skipped, time set; the latest applies (decision 81) |
| paper marks | Profile, Book, page range, time |
| lesson views | Profile, Lesson, opened or read, part, plan item, time; the whole Lesson's worked examples become Seen (decision 99) |
| sessions | Profile, kind, configuration (Section order, filters, timed or not, size), status, holding device, interrupted flag, the plan item it was started from |
| section runs | Session, Section, position, time limit, elapsed time, edits used, how it ended |
| served questions | Session or section run, position, Question, time served; what Sessions made Seen |
| responses | Profile, Session, Question, client sequence number, selection per Part, time spent, guessed flag, kind (first, edit, retry, time-out with no selection), the Response it supersedes, time |
| bookmarks | Session, Question |
| mistake labels | Profile, Response, Part, Mistake Type the Learner set, time (the app's own are worked out, not stored) |
| retry skips | Profile, entry, Retry Ladder step, time, note: a Sibling step with no Sibling left |
| official scores | Profile, date, kind, Total and Section scores |
| tutor messages | Profile, Question, message and the key it is compared by, reply, the message it reused, model, prompt version, tokens, cost, time (decision 104) |
| problem reports | Profile, Question, the Learner's words, the Review Queue item it joined, time (decision 107) |
| daily notes | Profile, Study Day, note, time; the latest kept |

Derived and rebuildable:

| Table | Holds |
|---|---|
| difficulty | Question, current Difficulty, count of Rated Responses |
| abilities | Profile, scope (Section, Skill or Question Type), value, uncertainty, evidence count |
| score estimates | Profile, Section or Total, time, value, range, calibrated flag |
| error log entries | worked out on read, not stored: Profile, Question, reasons (wrong, slow, guessed), status (open, Resolved, withdrawn) |
| retry steps | worked out on read, not stored: entry, step, due Study Day, Sibling, outcome (decision 66) |
| weak areas | Profile, Skill or Question Type, gap, Priority, slow flag, evidence count |
| daily logs | worked out on read, not stored: Profile, Study Day, minutes, Questions, accuracy by Section, Mocks, planned and completed items (decision 91) |
| analytics rollups | aggregates behind each analytics view |

Plans, append-only:

| Table | Holds |
|---|---|
| plan versions | Profile, version, build time, the Study Day it starts from, its basis, inputs, the days' outline |
| plan items | plan version, Study Day, position, kind, the item as planned, estimated minutes, status (planned or dropped), reason for dropping; started and done are worked out from the Sessions started from it (decision 90) |

Operations:

| Table | Holds |
|---|---|
| jobs | kind, parameters, status, checkpoint, spend cap and spend so far, claimant, heartbeat |
| llm calls | job, task, model, prompt version, tokens in and out, estimated cost, outcome |
| devices | name, token hash, pairing time, last seen, revocation time (decision 122) |
| lan mode | on or off, and when it changed (decision 119) |
| snapshots | kind, file, time, the host's calendar date, size, checksum, status (ok, failed, removed), error (decision 109) |
| settings | non-secret settings |
| taxonomy versions | version, file hash, load time |

The API key never enters the database (see "LLM adapter").

### API

Every Profile operation needs an unlocked Profile on the host or a paired device, and Curator operations need the Curator passphrase. Errors are tagged and map to HTTP statuses.

| Area | Operations |
|---|---|
| Access | create, unlock, lock, update or delete a Profile; export a Profile; unlock as Curator; reset a PIN; turn LAN mode on or off; make a pairing code; pair, list or revoke devices |
| Sessions | start; get state, including the server's remaining time; claim from another device; submit a Response; set a Bookmark; take or skip the break; pause and resume a Practice Set; change an answer in Review & Edit; finish review; get the report |
| Learning | get a Debrief; set a Mistake Type; get the Error Log; get due Retries; get Weak Areas; get an analytics view; get the Study Plan; get the Daily Log; write a Daily Log note; add an Official Score; add or remove a Paper Mark; file a Problem Report; open a Lesson; send a Tutor Chat message |
| Curator | add a Book; list or get Books; read a Book again; start the full run after the cost preview; confirm a Book Map; open a Book's PDF; list, pause, resume or cancel jobs; get the Review Queue; decide a review item; override a key; withdraw a Question; release Reserve Questions; start a generation batch; approve a Lesson; get coverage; read and change settings; take or restore a snapshot; export the install |
| Events | clock sync, Section expired, Session claimed elsewhere, job progress, plan rebuilt, Review Queue changed |

### Content pipeline

Books with a text layer come first, starting with the Official Guide family. A page with fewer than 20 characters of text is a scanned page. Scanned pages take the image path when the extraction model is marked in Settings as reading images; otherwise figure Questions and scanned pages go to the Review Queue. The route is decided when the full run starts, from the model set then.

Ingestion runs these steps. Each step saves its progress, so a job resumes from the last finished step after a crash, a rate limit or its spend cap.

1. Register. The PDF streams to the books folder while it is hashed; its SHA-256 is its fingerprint, and a known fingerprint does nothing. The file is stored once under its hash, with the official flag the Curator set. The worker then reads every page's text, a hundred pages a step, and records which pages carry a text layer.
2. Preview cost. The pipeline runs on a 10-page sample spread through the Book: the Book Map model surveys the 10 pages, and the extraction model reads those it can extract. The preview projects each step's tokens and cost for the full run from what the sample's calls took. Its Questions are counted a question set at a time, as the survey gives them, every one of them, a passage's later questions and a set's repeated numbers included; only those whose passage the sample has are enriched to cost enrichment. The full run waits for the Curator, who starts it with a spend cap that all the run's jobs share, across restarts. The sample's extraction readings are kept for the full run; its surveys are not, since a page surveyed among its neighbours gets its chapter right more often.
3. Map. The Book Map model reads every page with text, in order and ten at a time, and says what each holds: its role, its Question Type group and its chapter. Code joins neighbouring pages into ranges. Chapters compare by number and title, so "Chapter 3" and "Chapter 4" stay apart. Answer keys, explanations and difficulty labels join the questions of their chapter and group, or else the nearest earlier questions of their group, or else the next ones. Questions with no chapter are named after their group, with their first page when another set has that name. The Curator can also map a Book by hand before the full run, which skips the survey. The Curator corrects the proposal on one screen, opening pages in the browser's PDF viewer to check, and confirms it. Each confirmation is a new Book Map version.
4. Extract. Confirming a Book Map starts extraction. The extraction model reads each page of a range in the range's role: the questions that start on the page, finishing one that runs on from the next page; the answers on a key page; the explanations that start on the page; or its difficulty labels. Each reading is stored by page, role and Question Type group, so a page is read once however often the Book Map changes. Each range yields Questions, Parts, options, Stimuli and figure crops, and tables and charts become Datasets where possible. Question text is Markdown with LaTeX between `\(` and `\)` or `\[` and `\]`, so a dollar sign stays a price. Retired items, geometry and Sentence Correction, are skipped and counted. Old DS becomes Data Insights, and old Integrated Reasoning maps onto MSR, TA, GI and TPA (ADR 0004). Pages with no text layer in a mapped range wait in the Review Queue until the image path exists.
5. Link. Each Question is linked by its question set and number to its key, its explanation and its difficulty label. The key comes from the answer key, else from the explanation; when both give one and they differ, the Question is held.
6. Enrich. The LLM tags the Question Type and Skills from the Taxonomy, estimates Difficulty and writes one or two Approaches with their Strategies; a Book's own explanation becomes one Approach. For each wrong option it writes a Trap Note, the Mistake Type the option most likely signals and, where one fits, a Trap Pattern. Option tags never use Time pressure, which comes only from timing.
7. Dedupe. Questions with identical normalized text (question and choices, ignoring case, spacing, math delimiters and a few equivalent LaTeX spellings) and the same key merge into one Question with several Sources, unless the text or a figure is in doubt; a keyless Question takes the key of the same Question from another Book and waits for the Curator. Every Source's key must agree with the Question's. Identical text with different keys, and near matches, go to the Review Queue with the other Question beside them, because a copy with changed numbers is a Variant. A near match is text whose three-character pieces, with every number masked, are at least 85% shared. The Curator keeps a near match as a Variant or merges it into the other Question.
8. Publish Gate.

A Question publishes only when every check passes. Otherwise it is held with every failing reason.

| Check | Held when |
|---|---|
| Structure | a Part lacks options or a single key, a referenced Stimulus is missing, or a Dataset column has the wrong type |
| Key | an Extracted Question has no Book key |
| Solver agreement | any of three independent LLM solves disagrees with the Book key; the key is never changed automatically |
| Approaches | an Approach still misses the key after one regeneration |
| Tags | a tag is outside the Taxonomy or not allowed for the Question Type |
| Difficulty | the Book Label and the LLM estimate are two bands apart |
| Figures | a figure could not become data and is still an image |
| Rendering | KaTeX or Vega-Lite fails to render on the server |
| Near match | the Question nearly matches another (a possible Variant), or matches one with a different key |
| Generated keys | a statement's two predicates disagree, or a statement code cannot evaluate lacks solver agreement and Curator approval |

A key change, from a Key Override or a fixed Book Map, holds the Question while its key-dependent content (its Approaches and, for each wrong option, the Trap Note, Mistake Type and Trap Pattern) is regenerated, then sends it back through the Publish Gate. Tags, Difficulty estimates and solver runs are reused. Every past Response is re-scored, and affected Mock scores are marked "rescored". A Key Override also stores its reason.

Generated Questions (ADR 0003):

- The Curator starts a batch by Question Type, Skill, Difficulty and count. v1 generates only GI, TA, TPA and MSR with data tabs. Quant, Verbal and DS Questions come from Books.
- The LLM writes a typed Dataset and the statements. Each statement carries a predicate in a small query language (filter, sort, rank, count, sum, average, ratio, percent change, compare), and the DI evaluator runs it to get the key.
- A second, independent LLM pass translates each statement's text into a predicate. Both predicates must give the same result on the Dataset, which catches text that says something different from its predicate.
- A GI dropdown must have exactly one option that fits the computed value. For "approximately", the nearest option counts, and options must sit far enough apart that rounding cannot change the answer. A TPA must have exactly one pair that meets every condition.
- MSR statements that are inferences from text, which code cannot evaluate, need three agreeing solver runs and Curator approval.
- The chart is a Vega-Lite spec bound to the same Dataset (ADR 0006).
- Generated Questions then go through Enrich and the Publish Gate like Extracted ones, and each batch gives a quarter of its Questions to the Mock Reserve.

Lessons cover each Skill and each Question Type, 73 subjects in Taxonomy v1 (52 Skills and 21 Question Types). Each Lesson holds the rules, the methods with when each is valid, common traps, worked examples, and a 5-Question check that runs as an untimed Practice Set. Worked examples and check Questions are published Questions from outside the Mock Reserve, and opening a Lesson makes its worked examples Seen for that Profile. The worker writes Lessons after ingestion and the Curator approves each one. A Taxonomy change marks affected Lessons for rewriting.

The Taxonomy file, taxonomy/v1.yaml, holds 3 Sections, 13 Topics, 52 Skills, 21 Question Types, 6 Mistake Types, 38 Trap Patterns and 21 Strategies. Skills are shared across Sections (ADR 0007). Taxonomy changes ship as migrations that re-tag the affected Questions. After ingestion, any Skill with fewer than 15 Questions is flagged for merging.

### Sessions

| Kind | Rules |
|---|---|
| Mock | All three Sections in the Learner's order, 45 minutes each, adaptive, optional 10-minute break after Section 1 or 2, Review & Edit, calculator in Data Insights only |
| Sectional | One Section under Mock rules |
| Practice Set | Chosen by Section, Question Type, Skill, Difficulty Band, status (unseen, missed, bookmarked) or Source in book order. A timed set gets the sum of its Target Times and shows Debriefs at the end; an untimed set shows the Debrief after each Question. It can pause and has the guessed button |

The Section Blueprint sets how many Questions each group of Question Types gets. GMAC does not publish the mix, so these defaults are editable.

| Section | Groups |
|---|---|
| Quantitative Reasoning | PS: 21 |
| Verbal Reasoning | RC Question Types: 13, in 4 passages of 3, 3, 3 and 4 Questions; CR Question Types: 10 |
| Data Insights | DS: 7; MSR: 3, as one set; TA: 3; GI: 4; TPA: 3 |

The RC count follows prep-company estimates of 13 to 14, and the DS count follows the common estimate of about a third of the Section. The split among MSR, TA, GI and TPA is an even split with no published source.

Adaptive selection in Mocks and Sectionals:

- Each Section's estimate starts at Medium (0) and is refitted from that Section's Responses after each one (see "Ratings and scores").
- A candidate is a published Question, or an RC passage or MSR set taken as a unit, whose group still has room. A unit's size must match one of its group's open slots (RC passages of 3 or 4 Questions and MSR sets of 3, by default), and outside the last tier below, none of its Questions may be Seen. When no unit fits, the remaining slots pass to the Section's other groups.
- Candidates are tried in this order: unseen Reserve candidates within 0.5 of the estimate; unseen candidates from anywhere within 0.5; unseen candidates at any distance, Reserve first; then the candidate Seen longest ago (for a unit, the one whose Questions were Seen longest ago), with Paper Marks counting as Seen from the day they were made. Within a tier, the pick is random among the five closest to the estimate. The report counts repeats.
- A unit's Questions are served one after another.

The Mock Reserve (ADR 0008) is a quarter of each Section's Questions, chosen per Stimulus, stratified by Question Type and Difficulty Band, and assigned deterministically as each Book or generation batch publishes. Practice Sets cannot use a Reserve Question until the Curator releases it or the Profile has Seen it. Release is one-way. Only units that fit a Blueprint slot can join the Mock Reserve, so oversized passages and sets serve Practice Sets only. A Mock can start only when the Mock Reserve holds, unseen by the Profile, at least twice the Blueprint count for every group of every Section, counting the three Difficulty Bands together; a Sectional checks only its own Section. This start check runs each time, and the screen says what is missing.

A Paper Mark makes a Book's Questions, or a page range of them, Seen for that Profile. Keeping at least one Book unread on paper leaves Mocks unseen Quant and Verbal Questions, since generation covers only Data Insights.

The clock (ADR 0009) ticks every second on the server and saves elapsed time every 5 seconds. A gap of more than 5 seconds between ticks means the process stopped or the machine slept; it is not counted and the Session is marked interrupted. The browser shows the time the server sends and resyncs on every Response and every 15 seconds. When time runs out with no browser connected, the server still ends the Section. In a Mock only the 10-minute break pauses the clock, and when the break runs out the next Section starts. Practice Sets can pause.

Every submit carries a per-Session sequence number, so a retry or double click is recorded once. One device holds a Session at a time. Opening it elsewhere asks whether to take over, and the old device turns read-only.

In Review & Edit, each change is a new Response that supersedes the earlier one in that Session, and both stay on record. The final answer is scored and becomes the Rated Response, and the report shows whether the changes gained or lost points. Because answers can still change, a Sectional updates Difficulty and Ability only when it closes, and a Mock only when it ends, its Sections in the order taken, since an estimate that moved at each Section's close would show how that Section went while the Mock runs. Timed Practice Sets update when the set ends, since a Score Estimate that moved after each answer would give away whether it was right.

When time runs out with a Question on screen, that Question gets a time-out Response with no selection. It counts as wrong, enters the Error Log with Time pressure and counts against the Mock Section score, but it is never a Rated Response.

### Ratings and scores

The model is logistic: a Profile with Ability θ gets a Question of Difficulty b right with probability 1 / (1 + e^-(θ - b)).

| Item | Rule |
|---|---|
| Difficulty seed | Book Label Easy -1, Medium 0, Hard +1; the LLM estimate on the same scale when the Book gives no label |
| Difficulty Band | Easy below -0.5, Hard above +0.5, Medium between |
| Rated Response | the final Response in the Session where the Question was first Seen, if that Session was timed and the Response is not a time-out. A Question first Seen through a Paper Mark or a Lesson is never Rated |
| Difficulty update | after each Rated Response, b moves by K × (expected - actual), with K = 0.3 / sqrt(1 + n) for a Question with n earlier Rated Responses |
| Section Ability | fitted per Profile by maximum a posteriori over the Section's Rated Responses, each weighted by recency with a 30-Study-Day half-life, under a normal prior with mean 0 and spread 1 |
| Skill and Question Type Ability | the same fit over Rated Responses carrying that Skill or Question Type, each also weighted 1 when the Skill is the Question's primary Skill and 0.5 when secondary. The prior has spread 1 and centres on the reference Ability |
| Reference Ability | the Section Ability, or for a Skill seen in several Sections, the Section Abilities averaged by where its Rated Responses came from |
| Ability uncertainty | the standard error from the same fit |
| Section score | uncalibrated: 75 + 5θ, rounded and kept within 60 to 90. One Official Score shifts the line to match it; two or more fit slope and offset by least squares, the slope kept within 2.5 to 10 (decision 56) |
| Section range | the scores of θ minus and plus 1.96 standard errors |
| Mock Section score | fitted from that Section's final Responses with prior mean 0 and spread 1. A time-out Response counts as wrong at its own Difficulty, and each unreached slot counts as wrong at the Difficulty of the last Question served |
| Total | 205 + (Q + V + DI - 180) × 20/3, rounded to the nearest value ending in 5 |
| Total range | plus or minus 1.96 × 20/3 × the square root of the sum over Sections of (slope × standard error) squared, where slope is the Section score's points per unit of θ (5 before calibration); rounded outward to values ending in 5 and kept within 205 to 805 |

The Total formula is not official. It reproduces the published third-party examples checked (81, 84 and 82 give 655; 84, 87 and 81 give 685) and both ends of the scale (all 60s give 205, all 90s give 805). The rounding never ties, since a tie would need (Q + V + DI - 180) × 4 to be odd.

### Learning loop

A Question enters the Error Log as one entry, holding every Response to it, when the final Response in a Session is:

- wrong: any Part wrong, including a time-out Response;
- slow: right, but over 1.5 × its Target Time, with RC passages and MSR sets timed as a whole;
- guessed: right, but marked guessed (Practice Sets only).

Target Time defaults to Section pace, 2:09 per Question in Quant, 1:57 in Verbal and 2:15 in Data Insights, and can be changed per Question Type.

Each wrong Part gets a Mistake Type, filled in by the app and changeable with one tap. The Mistake Type decides the remedy.

| Mistake Type | Meaning | What the Study Plan adds |
|---|---|---|
| Concept gap | Didn't know the rule or method | The Skill's Lesson, then practice |
| Wrong approach | Knew the content but used a slow or invalid method | The methods part of the Lesson, then timed practice |
| Trap | Chose the option written to tempt | Practice on Questions with the same Trap Pattern |
| Calculation slip | Right method, wrong arithmetic | Timed practice on that Skill |
| Misread | Misread the question, a statement or the data | Nothing extra; the trend is tracked |
| Time pressure | Rushed, or ran out of time | Timed practice at exam pace |

The app fills in the chosen wrong option's stored Mistake Type, unless timing points to Time pressure: the answer came in the Section's last 10% of time, took under a quarter of the Target Time, or was cut off by the clock. The timing rules read the Question's first Response in the Session, so a quick late edit in Review & Edit does not count as rushing. Slow and guessed entries carry "slow" or "guessed" instead.

A Weak Area is a Skill or Question Type whose Ability sits below its reference Ability. Its gap is the reference Ability minus its Ability. Priority is the gap times exam frequency, where frequency is the share of Questions from Books marked official that carry the Skill (primary Skill 1, secondary 0.5), falling back to the whole Question Bank until an official Book is loaded. A Skill is flagged slow when, on its correct Rated Responses, the median of time spent divided by each Question's own Target Time is over 1.3. Under 8 Rated Responses it shows "not enough data". Only Rated Responses count, so untimed practice never moves Weak Areas.

The Retry Ladder clears each Error Log entry in three steps, counted in Study Days after the miss:

| Step | When | What |
|---|---|---|
| 1 | Day 2 | The same Question with its Approaches hidden; untimed, or timed for a slow entry |
| 2 | Day 7 | An unseen Sibling, timed |
| 3 | Day 21 | Another unseen Sibling, timed |

- A step passes when the answer is right. For a slow entry it must also come within 1.5 × the Target Time, and for a guessed entry it must not be marked guessed.
- A miss repeats the step 2 Study Days later, with a new Sibling for steps 2 and 3, and the missed Sibling gets its own entry.
- Passing step 3 marks the entry Resolved, and it stays in the history.
- A Sibling is unseen, outside the Mock Reserve, within 0.5 of the missed Question's Difficulty, and shares its primary Skill and Question Type. Failing that, the step keeps those three conditions but matches the Question Type and a shared secondary Skill other than the DS sufficiency Skills; failing that, it is skipped with a note. The Curator sees which Skills are running dry.
- Due Retries take at most a fifth of a Study Day's planned time, ordered by the Priority of the Weak Area of their primary Skill; Retries whose Skill is not a Weak Area come last.
- A Withdrawn Question closes its entries as withdrawn.

The Debrief shows the Trap Note for each wrong option picked, the Approaches with the fastest valid one first (each with its Strategy, expected time and when it is valid), the Mistake Type control, and buttons for 3 Siblings, the Lesson, Tutor Chat and Report a problem. It makes no LLM call.

Tutor Chat sends the Question, its key, its Approaches and the Profile's mistake history for that Skill. The system prompt says the key is correct and that a Learner who believes otherwise should file a Problem Report. An identical message from the same Profile about the same Question reuses that Profile's stored reply. When the API is down or the monthly cap is reached, the chat says so and everything else keeps working.

### Study Plan, Diagnostic and Daily Log

Code builds the Study Plan by fixed rules, with no LLM, from the test date, target score, weekly hours, days off and the Weak Area ranking.

- Phases: the Diagnostic; Lessons and practice on the top Weak Areas; mixed practice; then one Mock a week over the last 4 weeks (fewer when the test is closer), with the last Mock at least 3 days before the test.
- A Mock day gets the minutes the Mock needs, and the week's other study days share the rest of the weekly hours. If the weekly hours are shorter than a Mock, the plan schedules Sectionals instead and says why.
- Each Study Day gets Plan Items that fit its minutes: Lessons, Practice Sets, due Retries and Mocks. A Practice Set is estimated at its Target Times plus 20% for Debriefs, a Lesson at 200 words a minute plus its 5-Question check, and a Mock at 2 hours 25 minutes including the break.
- Practice is pitched where the Profile gets about two in three right, at a Difficulty near θ - 0.69, since 1 / (1 + e^-0.69) is about 2/3.
- Remedies follow the Mistake Types in the table above.
- Plan Items are ordered by the Priority of the Weak Area they target; items that target no Weak Area come last.
- Each rebuild, at the Study Day rollover and after each Mock, writes a new plan version from the current Study Day on. Earlier days, done items and dropped items keep their history. Missed work is never piled onto later days: when time runs short, the lowest items drop and the plan lists them.
- The plan schedules only as many Mocks as the start check will allow, counting one Blueprint's worth of unseen Reserve Questions per Mock. Without a test date the plan covers 2 weeks at a time.
- The target score sets the Section targets that progress is measured against.

The Diagnostic is a full Mock, or the three Sectionals spread over up to 3 days, and counts as the plan's first Mock. If the Learner skips it, or Mocks cannot start yet, every Section starts at Medium and the plan rebuilds once each Section has 20 Rated Responses; the Diagnostic is offered again once a Mock can start.

The Daily Log records, per Study Day, active minutes, Questions answered, accuracy by Section, Mocks, planned and completed Plan Items, and the Learner's note. The rollover hour is set per Profile, 4 am by default. A time zone change takes effect at the next rollover, and a 23- or 25-hour Study Day still gets one Daily Log.

### Analytics

| View | Shows |
|---|---|
| Score trend | Total and Section Score Estimates over time with ranges, plus Official Scores and the target |
| Weak Areas | Ranked by Priority, with gap, evidence count, slow flag, Mistake Type mix and a button that starts the remedy |
| Skill map | The Taxonomy tree shaded by gap, grey where there isn't enough data |
| Timing | Time against Target Time by Question Type, each Mock's pacing curve, accuracy on a Section's last 5 Questions compared with the rest, and slowness on Questions whose fastest Approach uses a given Strategy |
| Mistakes | Mistake Types and Trap Patterns per 100 Questions over time |
| Mock report | Per Section: Score Estimate, each Question's Difficulty, result and time, the effect of Review & Edit, Interruptions and repeats |
| Error Log | Filterable by Section, Skill, Question Type, Mistake Type, Trap Pattern, Difficulty Band, Book, status and date |
| Study | Daily Log calendar, and planned work against work done |

The Curator view shows Question Bank coverage by Skill and Difficulty Band, the Review Queue, jobs and spend, Mock Reserve remaining per Section, Skills running out of Questions, and Problem Reports. Profiles cannot see each other's data.

### Exam screen

- Layout: the Stimulus on the left and the Question on the right, stacked on narrow screens, with the question count and timer at the top.
- Exam rules: answer before moving on, no going back, Bookmark any Question, calculator only in Data Insights, Review & Edit at the end.
- Additions: a timer that can be hidden, a warning at 5 minutes left, keyboard shortcuts (A to E select, Enter submits), dark mode and adjustable font size (decision 126).
- Practice Set extras that never appear in Mocks: the guessed button, the instant Debrief in untimed sets, and pause.
- The calculator offers addition, subtraction, multiplication, division, square root, percent and memory.

### Profiles, access and LAN mode

- A Profile can have a PIN. PINs and the Curator passphrase are stored as argon2id hashes. An unlocked Profile and an unlocked Curator are held in HttpOnly, SameSite=Strict cookies. An unlock ends after 12 hours without use, and a browser holds one at a time: unlocking another Profile ends the one before.
- Tabs share the browser's unlock, so each request names the Profile its tab shows, and the server refuses it when another tab has opened a different Profile. The tab then shows the Profile now unlocked.
- Five wrong PINs lock the Profile for 5 minutes. PIN checks run one at a time, so wrong PINs sent together still count one by one.
- The Curator passphrase is set the first time the Curator tools open. It has 8 to 200 characters, and five wrong entries lock the tools for 5 minutes, as with PINs.
- The Curator resets PINs, and the passphrase is reset by a command run on the host computer: `gmat-prep reset-passphrase`, which also ends every Curator unlock.
- Deleting a Profile needs its PIN or the Curator passphrase, and a snapshot is taken first.
- The server accepts connections from the host only, unless LAN mode is on (decisions 119 to 125), and answers only requests whose Host header names this computer (127.0.0.1, localhost or [::1], and in LAN mode its network addresses and host names), which stops a web page from reaching it through DNS rebinding. Every response forbids framing and type sniffing. Writes are accepted only from the app's own pages (by Origin) and only as JSON of at most 1 MB, except adding a Book, whose body is the PDF itself, of at most 500 MB. In LAN mode it listens on the local network, and a new device must enter a 6-digit pairing code shown on the host; codes are single-use and expire after 5 minutes, and paired devices can be revoked. LAN traffic is plain HTTP, so LAN mode is for trusted networks.
- Profiles cannot see each other's data.

### LLM adapter

- Curator settings cover the base URL, a model per task and the price per model, all stored in the database, and the API key, stored only in a config file that the OS user alone can read, outside the data folder, so it never reaches snapshots or exports. The file is credentials.json in the config folder: ~/.config/gmat-prep on Linux, ~/Library/Preferences/gmat-prep on macOS and %LOCALAPPDATA%\gmat-prep on Windows, unless GMAT_PREP_CONFIG_DIR names another. The app refuses to start when that folder is inside the data folder.
- The adapter speaks the OpenAI-compatible chat completions API. It asks for JSON with structured outputs, JSON mode or instructions alone, as the Curator chooses, since providers differ in what they accept.
- The tasks are Book Map, extraction, solving, tagging, Approaches, generation, statement translation (the second predicate), Lessons and Tutor Chat.
- Every reply must match its JSON schema. The schema sent with a request is the strict form that structured outputs accept: an object at the root, every property required, null for a missing value, and few keywords; lengths, ranges and the like are checked when the reply is decoded. An invalid reply is retried once with the error attached, unless the first reply used up the job's cap. If it fails again, a Question-level step sends the Question to the Review Queue; any other job step fails and shows the error, and Tutor Chat shows an error to the Learner.
- 429, 5xx and lost connections are retried up to six times, with backoff that doubles from 1 second to at most 30, jitter of half either way, and at least the Retry-After the API gives. When the attempts run out, or Retry-After asks for more than a minute, the job pauses and resumes on its own after 5 minutes or that Retry-After, whichever is longer. Other refusals, such as a wrong key, and requests that could not be sent at all fail the step at once. A provider's error text is stored with any copy of the API key removed.
- A worker claims a job in one statement, so two workers never share one, and renews a heartbeat every 5 seconds; a job whose heartbeat is 30 seconds old is claimed again. Pausing a running job waits for its current step to be saved; cancelling stops the step at once. A pause or cancel asked while a step runs holds even when the step then fails or the API goes down.
- Every stored output records its model, prompt version and date, so a better model can re-run only what it would change.
- Spend is tokens times the per-model prices the Curator enters, since the API reports tokens but not cost. A reply without usage figures is priced from an estimate of four characters per token and marked as estimated. Spend counts against each job's cap and the monthly Tutor Chat cap; no call starts once a job's cap is reached, so the job pauses at its last saved step.
- Book text goes to the model as quoted data. Schema checks and key verification stop instruction-like text in a Book from changing a key.
- Math renders with KaTeX without commands that reach outside the page, such as links, and with its sizes capped; a Question that uses such a command is held. The web app renders math into the DOM and sets KaTeX's few style attributes again through the DOM, so the content security policy can refuse style attributes.

### Data safety and operations

- SQLite runs in WAL mode. Startup runs a quick integrity check and a full check runs weekly.
- `VACUUM INTO` takes consistent snapshots while the app runs: daily, keeping 7 daily and 4 weekly, and before every migration, Taxonomy change, bulk re-score, Profile deletion and restore.
- Book files are stored once, keyed by content hash. Snapshots skip page images, which can be rebuilt from the Books.
- Restore runs from the Curator screen, and the replaced database is kept as a snapshot too.
- Export covers one Profile (JSON) or the whole install (database plus Books and their page images).
- When the disk is full, ingestion pauses with a message and Sessions keep working. A failed snapshot is reported, never skipped silently.
- Migrations run at startup after a snapshot, each in its own transaction with foreign keys off, and each is rolled back if it leaves a broken reference. An app older than its database refuses to start rather than damage it.
- A lock stops a second copy from opening the same data folder. It is a file lock the operating system releases when the process ends, so a crash never leaves the folder locked. If the port is taken, the app uses the next free one and says which.
- Everything the app writes in the data folder is readable by the user who runs it and no one else.

### Speed targets

Measured on the install machine; each target must hold 95% of the time.

| Action | Target |
|---|---|
| Submit a Response until the next Question is on screen | under 100 ms |
| Start a Section | under 300 ms |
| Open an analytics view with 50,000 Responses | under 300 ms |
| Start the app | under 2 s |

`test/speed.test.ts` checks all four (`bun run test:speed`, decision 127).

Ingestion has no speed target, because the API's rate limits set its pace. It shows progress and an estimated finish time and never slows a Learner.

### Edge cases

| Scenario | Behavior |
|---|---|
| Tab closed during a timed Section | The clock keeps running. Reopening restores the exact state; if time ran out meanwhile, the Section has ended and unanswered slots count against the score |
| App stops or the machine sleeps during a Section | The gap is not counted, and the Session is marked interrupted |
| The break runs past 10 minutes | The next Section starts when the break ends |
| A Session opened on a second device | The second device asks to take over, and the first turns read-only |
| Double click or network retry on submit | The sequence number records the Response once |
| The clock runs out with a Question on screen | A time-out Response marks it wrong with Time pressure; it is never Rated |
| Curator withdraws a Question that is in Error Logs, plans or a running Session | A running Session keeps it. Afterwards its Responses stay in history but leave Ability, its Error Log entries close as withdrawn, and plans rebuild |
| Key Override while a Session is running | The Session is scored with the new key when it ends, past Responses are re-scored, and the Question is held until its key-dependent content is regenerated |
| Too few Questions on a fresh install | Mocks and Sectionals cannot start until the Mock Reserve passes the start check, and the screen lists what is missing |
| Diagnostic before a Mock can start | The plan starts every Section at Medium and offers the Diagnostic once a Mock can start |
| Same Book file added twice | Nothing happens |
| A rescan of a Book already ingested | It becomes a new Book. Identical Questions with the same key merge as extra Sources; near matches and conflicting keys go to the Review Queue |
| The Book Map was wrong, for example keys offset by one | Solver disagreements in the Publish Gate reveal it. After the Map is fixed, linking, the key-dependent content and the checks re-run; tags, Difficulty estimates and solver runs are reused |
| A formula or chart fails to render | The Publish Gate holds it, so Learners never see it |
| The Learner studied a Book on paper | A Paper Mark makes its Questions Seen for that Profile; Mocks use them only after unseen ones run out, and the report counts them |
| A Practice Set follows a Book in order | Unseen Reserve Questions in the range are skipped and shown as held for Mocks |
| No unseen Sibling left | The step falls back to a shared secondary Skill, then is skipped with a note |
| A Profile travels, or DST changes | Study Days follow the Profile's current time zone from the next rollover |
| App upgrade while a timed Section runs | The upgrade waits until the Section ends; a forced upgrade counts as an Interruption |
| Forgotten PIN or Curator passphrase | The Curator resets the PIN; the passphrase is reset by a command on the host computer |
| Repeated wrong PINs | After 5 misses the Profile locks for 5 minutes |
| Deleting a Profile | Needs its PIN or the Curator passphrase, and a snapshot is taken first |
| API down or rate limited | Jobs back off, pause and resume on their own; Tutor Chat says it is unavailable; everything else works |
| A job reaches its spend cap | It pauses at its last saved step |
| An LLM reply fails its schema twice | A Question-level step holds the Question in the Review Queue; any other step fails with the error |
| Disk full | Ingestion pauses with a message, Sessions keep working, and a failed snapshot is reported |
| A database written by a newer app version | The older app refuses to start |

### Defaults

| Topic | Default |
|---|---|
| Score conversion before calibration | Linear in Section Ability: Easy (-1) = 70, Medium (0) = 75, Hard (+1) = 80, kept within 60 to 90 |
| Ingestion cost | A 10-page sample projects tokens and cost before a full run, which starts only after the Curator confirms |
| Calculator | Basic arithmetic, square root, percent and memory |
| Language | English only |

### Build order

Tickets follow this agreed order: data model and Taxonomy, ingesting one Book, Practice Sets, Mocks, Error Log and Retry Ladder, Study Plan, then Lessons and Tutor Chat.

## Testing decisions

A good test drives the system through a seam and checks what a Learner or Curator would observe, never internal tables. The seams, highest first:

1. The HTTP API, with a fake clock and the recorded-reply LLM adapter. Most behavior is tested here: Sessions, scoring, the Error Log, Retries and plans.
2. The pure rule modules (Ratings, the Planner, the Retry Ladder, the DI evaluator), written test-first. Property tests check, for example, that every computed DI key matches a brute-force evaluation over its Dataset, that every Total stays within 205 to 805 and ends in 5, and that a plan never schedules more minutes than a Study Day has.
3. Ingestion against the golden set, the first 100 Questions the Curator approves from the first Book. Every prompt or model change must keep text, Parts and keys exact on all of them, and tags must match the Curator's labels at least 90% of the time.
4. One Playwright run of a full Mock on a fake clock, including an Interruption and Review & Edit.

The speed targets run as automated performance tests on a seeded database with 50,000 Responses. All tests run offline and cost nothing, using recorded LLM replies. There is no prior art yet; this is a new codebase.

## Out of scope

- Study reminders, EPUB Books, sync between installs, and native mobile apps; tablets and phones use the browser.
- Generating Quant, Verbal or DS Questions.
- GMAT Classic and other exams (ADR 0004).
- Hosting the app for other people.
- Languages other than English.

## Further notes

### Corrections to agreed lines

Each of these changes something the session agreed, to fix a problem that writing the full spec exposed. The owner approved all five on 16 October 2026.

1. Book Map fixes and Key Overrides. Round 5 agreed that after a Book Map fix "only linking and checking re-run". That would leave Approaches, Trap Notes and option tags written against the old key, so Debriefs and Tutor Chat would teach the wrong answer. The spec re-runs linking, the key-dependent content and the checks, and reuses tags, Difficulty estimates and solver runs. A Key Override follows the same rule.
2. Ability. Round 2 agreed an Elo-style update for both Difficulty and Ability. Elo gives no uncertainty, and Score Estimates need a range, so Ability is fitted by maximum a posteriori with a recency weight. Difficulty keeps the Elo-style update.
3. When numbers update. Round 5 agreed that derived numbers update after each Response. In Mocks and Sectionals, answers can still change in Review & Edit, and round 3 agreed Ability is recalculated from the final answers, so a Sectional updates when it closes and a Mock when it ends (decision 52).
4. Retry step 1 for slow entries. Round 4 agreed an untimed first step. An untimed retry cannot show that a slow entry is fixed, so for slow entries step 1 is timed.
5. Study Plans. Round 2 listed plans among the numbers recalculated from Responses. Completed and dropped items must keep their history (round 4), so plans are append-only versions built forward from the current Study Day.

### Decisions added while writing this spec

The session did not discuss these. All are starting values that a rebuild can change (ADR 0005), except where noted.

1. The Difficulty Band cut points (plus and minus 0.5), the K formula for Difficulty, the 30-Study-Day half-life, the prior spreads, and the reference Ability for Skills seen in several Sections.
2. Ranges are 95% intervals (1.96 standard errors); the Total range combines the Section errors through the score slope; calibration with two or more Official Scores uses least squares.
3. Adaptive selection prefers candidates within 0.5 of the estimate, picks at random among the 5 closest in a tier, and follows the fallback order given above. A unit's size must match an open slot, slots no unit can fill pass to the other groups, and only units that fit a slot join the Mock Reserve.
4. Time-out Responses and unreached slots count as wrong in Mock Section scores, and time-out Responses are never Rated.
5. Generated Questions: the predicate plus an independent second predicate, the GI option-spacing and "approximately" rules, the unique TPA pair, three solver runs for text inferences (the session said "several"), Enrich for generated Questions, and a quarter of each batch going to the Mock Reserve. These shape the generator rather than a derived number.
6. The Section Blueprint as groups of Question Types, the split among MSR, TA, GI and TPA, and the RC passage sizes.
7. The start check: twice the Blueprint count in the Reserve, unseen, across all bands, checked every time a Mock or Sectional starts (a Sectional checks only its Section); the plan's Mock count follows it, and the Diagnostic waits for it.
8. Clock numbers: 1-second ticks, 5-second saves, a 5-second gap threshold and a 15-second browser resync. When the break runs out, the next Section starts.
9. Siblings: within 0.5 Difficulty, outside the Mock Reserve, and the DS sufficiency Skills excluded from the fallback match.
10. Retry pass rules: a right answer, within 1.5 × the Target Time for slow entries, and not marked guessed for guessed entries.
11. Planning: Plan Item estimates, Mock days taking the minutes they need, Sectionals when the weekly hours are shorter than a Mock, and ordering Retries and Plan Items by the Priority of their Weak Area.
12. Lessons: worked examples and checks from outside the Mock Reserve, worked examples Seen once a Lesson opens, the check as an untimed Practice Set, and rewriting after a Taxonomy change.
13. Identical text with different keys goes to the Review Queue instead of merging.
14. Tutor Chat replies are reused only within one Profile.
15. Exam frequency weights (primary 1, secondary 0.5), the whole-Bank fallback, the official flag on Books, and the slow flag measured per Question against its own Target Time.
16. The Error Log judges the final Response in each Session, so an answer fixed in Review & Edit stays out of it, while the Time pressure timing rules read the first Response.
17. SameSite=Strict cookies; pairing codes single-use with a 5-minute expiry.
18. Jobs with a stopped heartbeat can be reclaimed, and an LLM reply that fails twice outside a Question-level step fails the step with the error.
19. Mock Reserve assignment is deterministic.
20. The plan-rebuilt and Review-Queue-changed events.
21. Option tags never carry Time pressure; it comes only from Response timing.

### Decisions made while building

These came up while building a ticket. Like the starting values above, they can change without a data migration.

1. Practice Sets (ticket 06): "missed" means the Profile's latest Response to the Question is wrong against the current key. A Skill filter matches the primary or a secondary Skill, primary first, and the "any" status serves unseen Questions before Seen ones. A book-order set lists the items it skips, and why: in the Mock Reserve, waiting for the Reserve decision, being checked, or withdrawn. "Practise 3 similar" starts with however many it finds when fewer than 3 qualify.
2. Releasing the Mock Reserve takes each unit from the Question Type and Difficulty Band holding the most, so what stays held keeps its spread. A passage is released whole, and one with more Questions than are left to release is passed over.
3. A merged Question is withdrawn, never deleted, and records the Question it was merged into. A Learner's Seen, missed and Rated history with it counts for that Question, and Bookmarks move to it. A set that planned it serves that Question instead, unless the set has it already.
4. A Book's explanation is an Approach only when it states the key, or states no letter and its own Book gives that key; so after a Key Override an explanation written for the old key is left out.
5. A published Question waits out of Practice Sets until its Reserve decision is made, at the end of its Book's run, or when the run is cancelled or fails.
6. A Bookmark belongs to the Profile and the Question, whichever set marked it.
7. A planned Question that leaves the Question Bank while a set is open (withdrawn, held or sent back for checks) leaves the set; a set with nothing left to serve ends.
8. Untimed time spent is wall-clock time from serving to answering, with no pauses recorded, so it says little about pace. Rules about slow answers, such as the Error Log's, read timed Responses only.
9. Practice Sets took single-Part Questions only until the set screen showed several Parts (ticket 09; see 25).
10. Timed sets (ticket 07): each browser tab is a device of its own, named in the `X-GP-Device` header and kept for the tab's life, so a reload keeps holding the set. A request without the header acts as any device.
11. The clock stops ticking while no timed set runs. Every request to a running set first ticks its clock, so an answer, pause, end or next that arrives after the time limit but before the clock's next tick ends the set by time instead, and one that follows a gap marks the Session interrupted. The clock is also saved whenever a Question is served, so after a restart it never stands before a Question already on screen.
12. The timer turns to a warning in the last 5 minutes, or in the last fifth of a set shorter than 25 minutes, and says so once to a screen reader.
13. A timed set's Rated Responses count when it ends, in the order they were given: each moves its Question's Difficulty by the Section Ability before it, from the sets that ended earlier and the answers before it in the same set, and keeps a Score Estimate, for the trend. The Practice page shows each Section's estimate as it stands now, from ended sets. A paused set's answers wait until it ends.
14. A set chosen by filters takes its Questions in an order seeded by the Profile and how many sets it has started, so its preview shows exactly the Questions, and the time limit, the set then gets, and each new set gets a new order.
15. A paused set hides its Questions everywhere, the review of earlier ones included.
16. Ending a set from the Practice page while another tab or device holds it asks first, then takes it over and ends it. A tab that comes back into view reads its set again.
17. Verbal and Data Sufficiency extraction (ticket 08): each verbal reading gives a question's Question Type from the Taxonomy's list, and the question's own words then settle it where the Taxonomy has a rule. Only the question asked counts: the stem's last paragraph, and of that the last sentence that asks something, never the argument's words. A question about portions printed in boldface (boldface, bold-faced, bolded or in bold) is CR Argument structure, and so is one about a method of reasoning or how an argument proceeds, unless it asks for a flaw or a criticism. An EXCEPT question the reading typed as strengthen while its sentence names weakening, or the reverse, takes the task its sentence names; words that name support an argument already has, such as "in support of", "the support for" or "supported by", name no task, while "provides support for" or "the most support for" ask for support. An RC question about what, if true (or if accurate, or if it were true), would strengthen or weaken a claim is RC Application. Otherwise the reading's type stands.
18. An RC passage is stored once, as a Stimulus, and serves the questions the Book names for it ("Questions 1 to 3 refer to the passage"), else the questions printed after it. A question takes the passage that names it on the nearest page at or before its own, so a chapter that numbers each passage's questions from 1 gives each its own. A passage read with no text names nothing. An RC question no passage names, or one two passages on the same page both name, waits in the Review Queue, and the Publish Gate holds any RC Question without a passage. A Question's text hash includes its Stimulus's, so the same question about another passage is another Question, and near matches are looked for among Questions about the same passage, or about a stored passage this one nearly copies (85% of three-character pieces shared): another edition's reading with a word changed, or a rescan's. Such a Question waits in the Review Queue beside the other Question, for the Curator to merge or keep; one with no Question like it waits beside a Question on the closest near passage that still has Questions. The Curator can also say the two passages are one passage printed twice: the Question keeps its words, moves to the other passage, is compared with that passage's Questions, and goes back through enrichment and the Publish Gate. When a stored passage does not render and another Book's reading of the same passage does, the stored text is replaced, and the Questions held only for it go back through the Publish Gate, in a job queued with the change. A passage's render problem and the question's own are separate reasons, so a Question whose own words do not render stays held.
19. A DS item's stem is its question followed by its two statements; its choices are the five fixed ones. It joins Data Insights whatever Section the Book prints it in. Tagging gives its maths, a Quant Skill, as the primary Skill and exactly one of value or yes/no sufficiency as a secondary Skill; the other secondary slot takes a Quant Skill or, for a question about a table, the Taxonomy's table Skill. The Publish Gate holds a DS Question tagged otherwise. Near matches between DS Questions compare the question and statements only, since the five choices are the same for all.
20. A passage's published Questions form one Mock Reserve unit, counted toward its Blueprint group's share rather than one Question Type's, since a passage mixes types; its band is from its Questions' average Difficulty, and whether it fits a slot is judged on its Questions from every Book that are published, or decided before and being checked again. A Question waiting for its first decision, such as a near match the Curator has not settled, counts once it is published. A Question published after its passage was decided, in its own Book or another, takes the passage's decision, released or not. A passage in the Reserve that no longer fits a slot, because a later Book added Questions or the Curator withdrew one, is released. Releasing takes whole passages, sized as the Reserve table counts them, by their published Questions, with any of their Questions being checked again at the time, and the screen says when a count smaller than every held passage releases nothing.
21. Practice takes a passage's matching Questions together, at the place of the best of them, so they are served one after another; the set size may cut the last passage short. Within a passage they come in the order their Book prints them. "Practise 3 similar" keeps the Questions it picks about one passage together too. The set screen shows the passage beside the Question, or above it on a narrow screen, where it folds away for the passage's later Questions; the Review Queue, the golden set and the set summary show it too.
22. The golden set keeps an RC Question's passage with it. A check links each set from that set's own pages only, reading an RC Question's page and the pages back to where the Book's own readings say its passage starts (3 pages when they do not say). Passages are compared as normalized text, since the stored passage may be another Book's reading, and a different Question Type counts against tag agreement, except for a Question the check did not find, which is reported as not found.
23. Within a question set, a second item with a number already seen is skipped and counted, unless it is the same item read again on the next page: the same passage, and text and choices that read alike. Answer-key, explanation and difficulty-label pages are read whatever their group, mixed included; mixed pages of questions are not extracted yet, and the Book Map screen says so.
24. A Book Map fix that finds a Question's passage, or a different one, moves the Question to it and sends it back through enrichment and the Publish Gate, since its Approaches quote the passage: its Reserve decision is made again with its new passage's, its tags and solves are done again, and it is compared with the new passage's Questions. When other Books' items share the Question, the moved item leaves it and becomes a Question of its own. A reading that nearly copies the Question's passage is not a different passage, so a Question the Curator moved to the other passage stays there. The solve and Approaches prompts are versioned 2 for quoting the passage, and the verbal reading prompts carry the Taxonomy version, since they list its Question Types.
25. Data Insights from Books (ticket 09): a Question has one or more Parts. A single choice has five options, A to E; a two-choice Part is a statement row whose two options are the pair the Book prints, such as Yes and No or True and False; a dropdown Part is a sentence with `{{blank}}` where its menu goes; a column-choice Part is one column of a Two-Part Analysis, and both columns share one list of options. Options keep letters, and the screen shows their words. A key is each Part's letter, joined with commas, such as C or A,B,A, and a Response is right only when every Part is.
26. A Stimulus is a passage, a table, a chart, a figure, or the tabs of an MSR set, each tab a child Stimulus with its title. An MSR set's Questions share its tabs, so like a passage they are one Mock Reserve unit and Practice serves them together. A question takes the passage or the set that names it on the nearest page at or before its own. Sources that name the same questions on the same or the next page are one set, with a source read on both pages once; further on, sources that number their questions the same way are another set. An MSR set has two or three sources, each with words, a table, a chart or a figure: a set of one source or of four, or a source with no words, holds its Questions for their structure, and a figure source holds them for its figure. A reason about a source names it by its title.
27. A Dataset's columns have a name, a type (number, percent, currency, date or text) and a unit; each cell keeps the text the Book prints and the value it reads as for its column's type. A cell that does not read as its type holds the Question for its structure. Brackets make an amount negative with its sign inside or outside them, as ($1,200), $(1,200) and (3.5%); a date reads month first, so 15/3/2019 is not a date. Tables sort by value, so "1,200" comes after "980". Tables are compared by their headings, words and cell values, so a rescan that drops a thousands separator gives the same table, and the same Question merges as another Source; a table with a number changed is a near one, compared as passages are.
28. A chart is a Vega-Lite spec that code builds from the kind, axes and series the reading names, bound to its Dataset by the trimmed column names; the model never writes a spec. Bars split by a series stand side by side, and only a stacked bar chart stacks them. An axis carries its column's unit, and percents and amounts of money are labelled as such. A chart whose axes or Venn columns name no column of its data holds its Question for its structure. A Venn diagram is drawn by the app's own renderer. The server draws every chart when it is linked, and a chart that does not draw holds its Question with the render reason. Charts are served as SVG files, since the security policy refuses inline images and styles, with their data as a table beside them for screen readers.
29. A figure the text does not hold, in Graphics Interpretation or in a Problem Solving or Data Sufficiency question, is kept as the band of its page from its question's first line to the next question's, or the foot of the page. The job worker draws it with PDFium, which runs as WebAssembly, at twice the page's size, and keeps it once by its hash. Its Question waits in the Review Queue for its figure, where the Curator sees the image. Each figure is its own Stimulus, so a Question about a figure is compared with the Questions about every figure, and one worded like another waits beside it for the Curator to check that the figures match.
30. Answer keys of Data Insights and mixed pages are read as each Part's answer as printed. A printed letter names its option; otherwise the option's own words, or the start of exactly one option's words, as Y for Yes. A Book's explanation states one letter, so it can key single-Part Questions only. An answer key that gives more or fewer answers than the Question has Parts gives no key, and the reason says how many it gave. A stored page reading that no longer decodes, such as an answer key read before keys had Parts, counts as unread and is read again.
31. For several Parts, the independent solves and the Approaches give a letter for each Part, and every wrong option of every Part needs a note. The Publish Gate checks each Part, and holds a Question while any Part has no key. A Key Override names the Part it changes and settles questions about that Part's key only: another Book that gives a different key for another Part still holds the Question. The Review Queue and the golden set show every Part with its key.
32. A chapter's Data Insights questions of every type share one question set, since a Focus book numbers them on through the chapter and keys them in one answer key. An older book's Integrated Reasoning pages are read item by item as the TA, GI, TPA or MSR each maps onto (ADR 0004).
33. The calculator comes with Data Insights Questions only. It adds, subtracts, multiplies, divides, takes square roots and percents, and keeps a memory. It works from the keyboard while focus is inside it, and keys typed there stay there, so a letter never chooses an option. Enter gives the result, x is times, c clears, and a comma, as in 1,200, is passed over.
34. On a narrow screen a Stimulus stands above its Question and folds away for the later Questions about it; on a wide one it scrolls in its own pane beside them. The pane starts afresh for each Stimulus, with its first tab and the Book's row order.
35. The golden set keeps a Question's Stimulus and every Part. A check reads an MSR Question's page back to where its set's sources start, as it does for a passage.
36. Generated Questions (ticket 10): a batch asks for Questions of one Data Insights type (TA, GI, TPA, or MSR sets of three Questions on shared tabs), a Skill that applies to it, a Difficulty Band and 1 to 20 items, with a spend cap of its own. Its job writes one item a step, then enriches and gates each draft, then decides the batch's quarter of the Mock Reserve. Generated Questions of a Section share one quarter across batches: a batch's are decided with every earlier batch's decided ones counted, so small batches add up to a quarter, and a stratum takes a whole unit when that brings it nearer its share, so an MSR set of three can fill a share of two. A generated set is written whole, so its Questions count toward its size until withdrawn, an inference held for the Curator included. A Generated Question's Source is its batch and its item's place in it, kept on the Question; the sources table holds Book items only. A step run again after a stop gives the same counts: the batch's failed items are kept in the job's checkpoint, and what joined the Reserve is counted from the Question Bank.
37. The DI evaluator runs a predicate: a list of named steps, each reading earlier ones, the last giving the result. The steps are filter, sort, pick, row, count, sum, average, value, rank, label, ratio, percent change, difference, compare, relation (greater than, less than or equal to), same-row, all, any, not and choice, at most 12 of them. Rows are named by the Dataset's first column. A missing cell never passes a filter, != included, and is left out of sums and averages; tied rows share the better rank, and a pick at a place where rows tie on the sort's column fails, so a statement about the region with the most sales cannot be keyed by the table's order; numbers are equal when they differ only by floating-point rounding. A date filter reads its value as the table prints dates (2019, Mar 2019, 3/15/2019, Q1 2020) and compares at the coarser of the two, so after 2019 leaves out November 2019; a value that is no date fails.
38. Keys come from the predicate's result. A statement row takes its first option (Yes or True) when its predicate holds, else its second. A dropdown takes the one option its value rounds to at the finest places any of its options prints, or whose words match, so 2.3 fits none of 1.5, 2, 2.5 and 3; for an approximate blank the nearest option counts, and the value must lie within a quarter of the gap between that option and each neighbour, so a rounding error smaller than that cannot change the answer. A TPA's two column predicates may read the options chosen in either column, and exactly one pair of options may meet both.
39. A second, independent pass writes its own predicate for each computed Part from the Part's words and the material, never from the generator's predicate. The two must give the same result, numbers to six significant figures; a TPA's must be met by the same pairs. The second reading also says whether a blank asks for an approximate value and, in an MSR set, which tab its predicate reads; both must match the generator's. A Part whose readings disagree, or whose second reading cannot be run, holds its Question with a predicate-disagreement reason, which a Key Override of that Part settles: the Curator has read its words. A TPA's columns are read together, so its disagreement is settled once both columns are overridden.
40. The generator gets one more try at an item that breaks a rule (table size, unique column and row names, cell types, statement and option counts, three statement answers not all alike, a key code cannot reach), with every problem listed; an item still broken counts as failed, with the reason given in the job's note. A chart that does not draw holds its Question. A Generated Question with the same words and data as another Question of its type, or words 85% alike, waits as a near match beside it, as a Book's does.
41. An MSR statement that is an inference from text has no predicate: its key is the generator's (key basis generator), at most one per Question. The Publish Gate holds such a Question either way: the Curator may publish it when all three solves agree with that key, and cannot when they do not.
42. Sectionals (ticket 11): the Section Blueprint is data the Curator sets under Settings. A single-Question group has a count from 1 to 40; RC and MSR have a list of unit sizes, 1 to 8 units of 2 to 6 Questions each (RC 3, 3, 3, 4 and MSR 3 by default). It is kept in the settings table, and the server and the job worker both read it there, so the Mock Reserve takes only units that fit its slots. Saving it releases the passages and sets held for Mocks that fit no slot any more, which stay released if it changes back. A passage or set kept out of the Reserve only because no slot of the old Blueprint took its size is decided again when the new one does, by the usual share. The screen says how many were released and how many Questions joined.
43. The start check counts, for each group of the Section, the Profile's unseen Questions held for Mocks in units that fit a slot, all three Difficulty Bands together, against twice the group's count; a unit counts only when none of its Questions is Seen. The bands are shown, not required one by one: a band each would ask three MSR sets where twice the Blueprint count is two. A Section short of any group lists each short group with its count by band.
44. A Sectional is a Session of kind sectional, timed at 45 minutes, with no pause and no guessed button, held by one device as a timed set is. A Profile runs one Sectional at a time; starting another goes back to it. Its config keeps the Section, the Blueprint as it stood at the start, and each unit served with its Questions, those the Profile had Seen when it was chosen, those passed over, its tier and its slot, so its slots never change mid-Section.
45. After each Response the estimate is refitted from the Section's Responses so far at their Questions' current Difficulty, with prior mean 0 and spread 1. A unit started is served to its end, passing over a Question that left the Question Bank since; the unit keeps its slot, and the Question passed over leaves its place in it unfilled. Otherwise a unit qualifies when it is published with its Reserve decision made, nothing of it was served in this Section, and its group has an open slot of its size; the tiers of adaptive selection follow, a unit's distance taken from its Questions' mean Difficulty, and the pick within a tier comes from a generator seeded by the Session and the position, so a test can repeat it. A group with open slots that no unit in any tier fits passes them all on, as slots any single Question of the Section can take. When nothing is left to serve, the Section goes on to Review & Edit and the slots still open are left unfilled: not scored, and named in the report.
46. A Question must be answered to go on, and only the Question on screen can be answered; nothing earlier opens until Review & Edit. A Response must carry a sequence number after the last one's, so the Session's Responses stand in the order they were given. Ending the Section early counts the Question on screen, unanswered, and the slots not reached as wrong. While the Section runs, Practice leaves out every Question of the units it chose, served yet or not: from filters, Book order, Similar Questions and planned sets, whose turn passes it over. A preview counts them, all of them under Missed before, since that status would say how an answer went; a Book-order set lists their items as in the Sectional.
47. Review & Edit begins after the last slot's answer while time is left. It lists every Question with its Bookmark; one opens with the answer that stands. A change is a new Response of kind edit that supersedes the one that stood; each counts, up to three in the Section, and the answer that stands already is refused. Finishing asks to confirm. Time running out in Review & Edit ends the Section with no time-out Response; time running out before it gives the Question on screen a time-out Response, and there is no review.
48. When the Section closes, its score is fitted from the final Responses at their Questions' Difficulty as it stands then, before the Rated Responses move it: a time-out is wrong at its own Difficulty, and each slot not reached, the rest of a unit cut short included, is wrong at the Difficulty of the last Question served. Review & Edit's points are that score less the score had each changed Question kept its first answer. The report keeps each Question's Difficulty from then in the Session, so later Difficulty moves leave it as it was. Whether each answer is right is read against the current keys when the report is shown: after a Key Override the results, the score and Review & Edit's points follow, and the report says it was rescored. A Question merged into another is judged by the key of the one it became (decision 60), so a merge into a Question keyed differently re-scores the same way. Then the Section's Rated Responses move Difficulty and the Score Estimates, by the rating step timed sets use.
49. The report gives the score with its range; each Question's place, Question Type, Difficulty and band, result (right, wrong, time ran out, not answered), time, Bookmark, Review & Edit change and whether the Profile had Seen it before the Section chose it, Question by Question within a passage; the slots not reached and those left unfilled, a Question passed over or gone from the Question Bank when time ran out among the unfilled; repeats; and the changes with their points. While the Section runs a Question does not say which Book it comes from; once over, each opens with its final Response and Debrief.
50. Bookmarks in a Sectional are the Profile's, as in Practice Sets (decision 6), so Review & Edit marks a Question Bookmarked there or before.
51. Practice's clock ticks practice Sessions only. Sectionals keep a clock of their own with the same rules: ticks every second, saves every 5 seconds, a gap not counted, and the Section ended on time with no browser open.
52. Mocks (ticket 12): a Mock is a Session of kind mock, and each of its three Sections a Session of kind mock-section run by the Sectional engine, so a Section works exactly as a Sectional does: 45 minutes, adaptive, Review & Edit, and scored when it closes. Its Rated Responses move Difficulty and the Score Estimates when the Mock ends, the Sections in the order taken, and only then does a Mock's Section count as ended for the Score Estimates: until then they would show how a closed Section went. A timed Practice Set that ends while a Mock runs is rated when it ends, before the Mock's Sections. The Learner picks the order of the Sections at the start, from the six. One Mock or Sectional runs at a time: starting either while the other runs goes back to the one running.
53. The break: when Section 1 closes, the 10-minute break begins at once. Going on within its first minute keeps the break for after Section 2; going on later ends it early; and when it runs out, the next Section starts on the server, with no browser needed. After Section 2 the break comes only if it was kept, and with the break used, the next Section starts at once. The Mock checks every second; only the break runs on its clock, and each Section keeps its own. Each Section starts on the device that holds the Mock, and taking over a Mock's Section takes over the Mock. A Section is begun before the Mock's record names it, so a stop in between leaves one the Mock takes up when it next moves on, rather than beginning a second; one begun by going on from the break counts as gone on when it began, which decides whether the break was kept. A Mock stopped before its first Section began begins it then. Taking over a closed Section of a running Mock leaves the Mock where it is.
54. A Mock starts only when every group of every Section passes the start check (decision 43), and the page says which groups are short.
55. While the Mock runs, a closed Section shows neither its report nor its Debriefs, and Practice keeps leaving out the Questions of all its Sections, closed ones too (decision 46). The Mock's report gives each Section's report, the Total with its range from the three Section scores and their standard errors on the lines the reports kept, the Sections that lost time to an Interruption, the repeats and those of them a Paper Mark had made Seen. A Mock's Sections are listed with the Mock, not with the Sectionals.
56. Official Scores (date, official practice exam or GMAT exam, Total and the three Section scores) calibrate each Section's line. Each is paired with the latest Score Estimate for the Section on or before the day it was taken, in the Profile's time zone; one taken before any is left out of that Section's fit, and the page says which Sections each one calibrates. A date still to come is refused, and the form starts on today in the Profile's time zone. One Official Score shifts the line to match it; two or more fit slope and offset by least squares, but only when their paired Abilities lie at least 0.5 apart, and a fitted slope stays within 2.5 to 10 points per unit of Ability, half to twice the uncalibrated 5. Closer Abilities, or points that fit no rising line, keep the slope of 5 and fit the offset. Among Score Estimates kept at one moment, the last written is the latest. Score Estimates are kept as Abilities and shown on each Section's current line, and the Total shows once all three Sections have one. A Mock's or Sectional's report keeps the line from its close.
57. A Paper Mark covers a Book, or a page range of it, through the pages its Questions' Sources start on. From the time it is made, its Questions are Seen: they leave the unseen tiers and the start check, are served only in the Seen tier, and are never Rated, since their first sighting was on paper. Removing a mark makes them unseen again unless a Session has served them; a Response the mark had kept from rating then counts toward Ability, and toward Difficulty only on a rebuild. A Question several marks cover was first Seen at the earliest and last Seen at the latest. Pages are the PDF's, counted from its first page, and the form says so.
58. A Reserve Question Seen through a Session or a Paper Mark opens to the Profile's Practice Sets (follows from decision 57 and ADR 0008).
59. A Key Override re-scores Mocks as it does Sectionals (decision 48): each Section's report reads its answers against the current keys, the Total follows, and the report says it was rescored.
60. The Error Log (ticket 13) is worked out from Responses and the current keys on every read (ADR 0005): one entry per Profile and Question, a merged Question's Responses counting for the one it became and judged by that one's current key, holding every Response to it. A list reads the Profile's whole history; it keeps each Profile's Responses, and its timed Sessions' served rows, between reads, since neither changes once written, and reads only the Responses written since, checking first that the rows kept are all still there. An entry, and a change to its Mistake Types, read only the Sessions that answered its Question. A Practice Set's or Sectional's own Debrief and results judge a merged Question by the one it became too, so they agree with its entry. Only the Learner's Mistake Type changes are stored, as facts in mistake labels (Profile, Response, Part, Mistake Type, time; the latest for a Response and Part stands), so a Key Override or a rebuild recomputes the rest and keeps them. A key change that makes an answer right takes its entry out.
61. A Session's final Response to a Question counts once the Session shows how it went: an untimed Practice Set at once, a timed one when it ends, a Sectional when it closes, a Mock's Section when the Mock is over. Wrong is any Part wrong, a time-out included. Slow is right with the first Response over 1.5 times the Target Time, in a timed Session only, as decision 8 says; an RC passage's or MSR set's Questions in the Session are timed as a whole against the sum of their Target Times, and each right one of a slow passage is slow. Guessed is right and marked guessed, in Practice Sets only. An answer changed in Review & Edit is judged on its final answer alone: right, it stays out, slow or not. A Question on screen when a Section is ended early has no Response, so the report counts it wrong but it does not enter the Error Log.
62. A wrong Part's Mistake Type is Time pressure when the Question's first Response in the Session was a time-out, took under a quarter of the Target Time, or was given in the last 10% of a timed Session; otherwise the picked option's stored Mistake Type; and none when the option has no note, for the Learner to pick. A quick answer counts in untimed sets too: decision 8 is about time running long while a Question sits open, and untimed time never runs short. A passage's or set's Questions are rushed as a whole: under a quarter of the sum of their Target Times together, so a quick later Question of a passage read at pace keeps its option's Mistake Type. The Learner's label for that Response and Part replaces it, and the view says where each came from: the Learner, the timing, the option, or nowhere yet. The Trap Pattern comes from the picked option's note. Notes count only once written for the current key, as the Debrief shows them: while they wait to be written again after a key change, the Part has no Mistake Type or Trap Pattern from them.
63. An entry shows its latest miss: why it is there, its wrong Parts with Mistake Type and Trap Pattern, how many misses and when. Its status is open, or withdrawn when its Question is Withdrawn; Resolved comes with the Retry Ladder. While a running Sectional or Mock holds an entry's Question, the list leaves the entry out and says how many wait, and the entry does not open, as Practice leaves such Questions out (decision 46).
64. The Error Log filters on the server by Section, Skill (primary or secondary), Question Type, Mistake Type (Slow and Guessed among them), Trap Pattern, Difficulty Band (current Difficulty), Book (any Source), status and the latest miss's day in the Profile's time zone; each filter lists the values entries have, with counts over every entry, Difficulty Bands from easy to hard, Mistake Types with Not yet labelled for wrong Parts still to label, and Books by title and edition, with the day added, in the Profile's time zone, for Books that share both, then the minute, then copy 1, 2 and so on for copies added in the same minute; names come from every Book, so a Book's name is the same in every view. The list comes 50 entries at a time, each page following the last entry shown, so an entry a label change takes out of the filter moves no other entry off the list; times show in the Profile's time zone. An entry opens to the Question as last missed, its Debrief and every answer given to it, each as the screen showed it.
65. The Debrief of a wrong answer, once its Session shows how it went, has a one-tap control for each wrong Part's Mistake Type, in Practice Sets, Sectional and Mock reports and the Error Log alike. Each Part sends one save at a time, and picks made meanwhile wait for it, only the latest going next, so the stored label is the last one picked. Every save that lands is recorded and passed on, so a failed save puts back the last one saved, and one that fails after its control has closed is reported until the Learner dismisses it. Any of an entry's misses can be labelled, as each Session's Debrief shows its own, and the Error Log's list follows a change at once.
66. The Retry Ladder (ticket 14) is worked out from the facts on every read, with the Error Log: an entry's misses outside its own step-1 retries start a run (again after an earlier one, even once Resolved), and a miss in one of those starts a run when none is open then; the final Response to each retry Question, once its set shows how it went, is a step taken, a set taking at most one step of an entry; and a stored skip (retry_skips: Profile, entry, step, time, note) is a step with nothing to serve. Steps fall due 2, 7 and 21 Study Days after the miss that started the run; a missed step repeats 2 Study Days later; a step taken late puts the next no sooner than the next Study Day. A retry set made before the miss that started the current run takes none of its steps, so a set left open cannot pass a step the same day the Question was missed again. Merged Questions count as the ones they became here too. Passing step 3 resolves the entry, which stays in the Error Log as Resolved; a skipped step counts as passed, and the entry says which steps were skipped.
67. Retries are Practice Sets whose config lists, for each Question served, the entry and step it is for. Starting retries makes one set of the steps due with one timing: untimed for step 1 of a wrong or guessed entry, timed for step 1 of a slow entry and for every Sibling step. A set takes at most 20 steps, by the Priority of the Weak Area of their Question's primary Skill and then the longest waiting first (decision 88), so a backlog comes back a set at a time. A timed set's clock gives each step of a slow entry 1.5 times its Target Time, as its pass rule does, and every other step its Target Time. One retry set runs at a time, and starting another goes back to it. Step 1 serves the entry's Question as any set does, so its Approaches stay hidden until it is answered; while a running Sectional or Mock holds the entry's Question, every step of the entry waits, as the Error Log leaves the entry out then, and a step 1 also waits while its Question is out of the Question Bank for a check; the Practice home counts waiting steps without naming them. A Sibling is picked when its set starts: unseen, not held by a running Section, not about the passage the entry's Question asks about, and not already in the set. With none left, the step is skipped with a note, stored, and the next step falls due as after a pass.
68. A step passes on a right answer; for a slow entry, also within 1.5 times the Target Time; for a guessed entry, also not marked guessed. A step is judged by the reasons of the run it falls in, those of the miss that started it. A wrong answer to the entry's own Question in its step 1 is that step missed, not a new miss, while a run is open; with none open then, as when a Key Override made the earlier misses right or the run before ended Resolved, it starts a run, its own set taking no step, and later ones are its step 1 taken again. Within one retry set, each Response goes to the item whose Question it answered, and the set takes at most one step of an entry: the first item, in the set's order, whose step is the one due, as two items can count for one entry after a merge. A missed Sibling enters the Error Log itself, with a ladder of its own. A Sibling first Seen in its timed step is Rated, as in any timed set.
69. Error Log entries gain the status Resolved and a ladder view: the step due and its Study Day, and the steps of the current run with their outcomes and notes. The Practice home lists the steps due today with a start button for each timing, and how many fall due on each of the next 7 Study Days.
70. The Curator's Siblings view lists each Skill by Question Type, as a Sibling shares both, for every pair a published Question or a skipped step has (a Data Insights type can take a Quant or Verbal Skill), with a Sibling step skipped for want of one, over every Profile, or with 5 or fewer published Questions outside the Mock Reserve to serve one, those with every Question in the Reserve included; the most skipped first.
71. Skill and Question Type Abilities (ticket 15) are fitted on every read, with the same model as a Section's, from the Rated Responses of Sessions that have ended, so a running set or Mock adds nothing yet. A Rated Response counts 1 for its Question Type and its primary Skill and 0.5 for a secondary Skill, times its recency weight. The prior has spread 1 and centres on the reference Ability: the Section Ability, or for a Skill answered in more than one Section, the Section Abilities weighted by where its Rated Responses came from, each counted with the same role and recency weight as in its own fit. A Section with no Ability yet counts as 0, the prior's centre, and its Skills still show on the Skill map. Evidence is the number of Rated Responses carrying it; under 8 it shows "not enough data" and is never a Weak Area.
72. A Weak Area is a Skill or Question Type with enough evidence whose Ability is below its reference. Priority is the gap times exam frequency: its share of the published Questions with a Source in a Book marked official, merged Sources included, a secondary Skill counting half, or of the whole published Question Bank until an official Book's Questions are published. The page calls that share the Skill's share of the exam's weight, as a secondary Skill counts half. It is flagged slow when the median, over its correct Rated Responses, of the first Response's time over the Question's own Target Time is above 1.3. Pages give a gap as about so many Section points, 5 to each unit of Ability, and as "just below" or "just above" when that rounds to 0.
73. A Weak Area's mix counts what went wrong in its Error Log misses: each wrong Part's Mistake Type, the Learner's where set, and Slow and Guessed. Its button starts a Practice Set of 10 Questions with the Skill or of the Question Type, unseen first: timed when it is slow or its most common Mistake Type is Time pressure, Calculation slip or Wrong approach, untimed otherwise. Lessons (ticket 17) take over the Concept gap remedy.
74. The Score trend, on the Scores page, draws each Section's last Score Estimate of each Study Day on the Section's current line, with its likely range, and the Total on each day all three Sections have one by then. Official Scores are marked on the Total, and the Study Plan's targets are drawn as dashed lines (decision 82).
75. Timing reads each Question's first Response in timed Sessions, time-outs left out: the median time over Target Time by Question Type, and by the Strategy of the Question's fastest valid Approach, the first in the Debrief's order of two as fast; the first Responses' accuracy on the last 5 Questions served in each Sectional and Mock Section against the rest; and each finished Mock Section's pacing curve, the time used by each answer against an even pace through the Section's limit over all its Questions, as its Blueprint sets them, so a Section that ran out of time shows behind. A time-out is no answer, so it has no point on the curve. Mock times show in the Profile's time zone.
76. Mistakes counts each Mistake Type and Trap Pattern on wrong Parts per 100 Questions answered, a Study Week at a time: the 7 Study Days ending today, then the 7 before, back to the first week with an answer. It reads the final Responses of sets that show how they went.
77. Study shows, for each Study Day with work, the minutes worked (the first Responses' time), Questions answered, accuracy by Section where shown and Mocks finished, with a chart of the last 28 Study Days. Planned against done is in the Daily Log (decision 91).
78. Analytics charts are SVG drawn in the page with the app's colours, so they follow dark mode, each described in words for screen readers and backed by a table of its numbers. Each is drawn at the width it is shown, up to 640 pixels, so its text stays the page's size on a phone, with axis labels on steps a reader counts in, such as weeks for days. Vega-Lite stays for Question charts.
79. The Curator's Overview opens the Curator area. It shows published Questions carrying each Skill, as primary or secondary, by Difficulty Band; the Mock Reserve by the Blueprint's groups against what one Mock takes from each, and the whole Mocks that covers; how many Skills are running out of Siblings and how many have fewer than 15 published Questions; the Review Queue count; and this month's jobs and LLM spend, the month in the app's own time zone. Problem Reports arrive with ticket 18.
80. Every analytics view reads only the signed-in Profile's facts, and answers within 300 ms with 50,000 Responses, after a write too. Responses and servings are append-only, so each Profile's are kept in memory and a read takes only the rows after the last one kept, once a count and the last row's identity show nothing else changed. A Profile's facts are cached by the database's version, and Study Days are worked out once per quarter hour, as time zone offsets change only on quarter hours. Each view is also kept, with the fitted Abilities and the Approaches, until the database's version or the Study Day changes, so a view read again costs a few milliseconds. `test/speed.test.ts` checks the target (decision 127): on the 2-vCPU build container, right after a write, Weak Areas took about 256 ms, Timing 234, Mistakes 271, Study 235 and the Skill map 123 when this was written; decision 127's kept reads brought Weak Areas, the slowest, to about 210 ms at the 95th percentile, cold reads and reads right after an answer included.
81. Plan settings (ticket 16) are rows per Profile, the latest applying: plan_settings holds the set time, the test date or none, the target Total or none, weekly minutes, the days off as weekdays and whether the Diagnostic was skipped. Weekly time is 1 to 60 hours, entered in hours and kept in minutes. At least one weekday stays a study day, a test date falls after today and at most 730 days on, and a target Total is one a test gives, 205 to 805 and ending in 5. Saving changed settings, or skipping the Diagnostic, adds a row; saving the same settings again adds none and leaves the plan as it is. A time zone is kept under the name the runtime gives it, so one typed in other case is the same zone.
82. The target Total sets one target for every Section: the lowest Section score that, given in all three, reaches the Total. The Plan page shows each Section's estimate against it, the Scores page says how far each estimate is from its target, and the Score trend draws both targets as dashed lines.
83. The plan is a pure function (`src/server/plans/build.ts`) of the settings and a snapshot of the Profile, made again at each Study Day and after each Mock, so the snapshot carries what the plan has been doing: today's Study Day and the plan's start, the Study Day the current test date, or none, was first set; each Section's Ability, Rated Responses and default pace; the Weak Areas by Priority with their Ability, slow flag, most common Mistake Type, most common Trap Pattern and, for a Question Type, its own Target Time; each Retry step due with its Study Day, timing, minutes and Priority; how many more Mocks or Sectionals each Section can serve in turn (the start check passes while each Blueprint group holds twice its count unseen, and each one served takes at most its count, so the fewest, over its groups, of the unseen over the count, less one); the Diagnostic's state; the Mocks and Sectionals started in the last 7 Study Days, from the plan or not, by the day each started; and today's plan items started or done under any version. Property tests check that the same inputs give the same plan, that no day is given more minutes than it has, today's work included, that a day holds one Mock or Sectional at most and none after one was taken that day, and that Mocks keep to the start check, to 3 days before the test and to 3 days from every other Mock.
84. Each study day gets the weekly time divided by the study days a full week has, and a day off gets nothing. Weeks run back from the test date, so the last one ends the day before the test, or on from the plan's start without one. A Mock day gets the Mock's 145 minutes, and a Sectional day its 45 when that is more than the day's share; the week's other study days share what is left. A week's study days count from the plan's start, its past days and the Mocks and Sectionals taken on them included, so a plan made again during the week gives its days the same share. A Practice Set is its Questions' Target Times at the Section's pace, or at a Question Type's own Target Time for that Weak Area's sets, plus 20% for Debriefs, whole minutes up; a Retry its Target Time, 1.5 times for a slow entry, plus 20%; a Sectional 45 minutes.
85. With a test date, the Diagnostic comes first; the days from the plan's start to the Mock weeks go two thirds to Weak Area work and the last third to mixed practice; the Mock weeks are the last 4 weeks before the test, fewer when it is closer. Each Mock falls on the latest study day of its week that is at least 3 days before the test and 3 days after the Mock before it, taken or planned, the Diagnostic counting as one; a week that holds the Diagnostic, or a Mock already taken, needs no other, and under a Mock's time a week gets the Sectionals of the Sections it has not had yet. Without a test date the plan covers the next 14 Study Days, in turns of 7 days of Weak Area work and 7 of mixed practice from the plan's start, with no Mocks after the Diagnostic. Sets and Retries are planned for the next 28 days; the days after keep their time, phase, Mocks and Sectionals, and get their sets as they come nearer.
86. Each study day is filled in order. First its Mock or Sectional, a Mock day holding nothing else. Then due Retries, the highest Priority first, up to a fifth of the day, in sets of at most 20; Retries that do not fit, or fall due on a day off, wait for the next study day, as they stay due, and those still due when no study day is left before the test are listed as dropped. Then Weak Area sets: two a day in the Weak Area phase and one a day otherwise, rotating through the top 6 Weak Areas from day to day, each as big as fits from 10 Questions down to 5. Then timed mixed sets fill the rest, a Section at a time in turn. Both turns count the study days from the plan's start. Items follow the Priority of the Weak Area they target, and a Retries item that of its highest Retry; items for none come last. A Weak Area set with no room for 5 Questions is dropped and listed with its reason, which says when the day itself is shorter than such a set, and the plan says so when every day is. Missed work is never moved onto later days. Today's plan items started or done count against today: today takes a Mock or Sectional only when none was taken today and it fits what is left (a Mock when nothing else was done, a Sectional within the day's minutes left), else it goes to the next study day; a Weak Area worked on today is not planned again today, the mixed sets carry the turn on after today's, and Retries done today count against the day's fifth for them.
87. A Weak Area's set follows its most common Mistake Type: Trap, a set of Questions with its most common Trap Pattern in its Section; Wrong approach, Calculation slip and Time pressure, a timed set on the Skill or Question Type; Concept gap and Misread, an untimed set on it, timed when the Weak Area is slow; a slow Weak Area with no Mistake Type, a timed set. Lessons join the remedies with ticket 17.
88. Practice is pitched near difficulty θ - 0.69, where about two in three come out right: θ is the Weak Area's own Ability for its sets, else the Section's. A Section is pitched at Medium (difficulty 0) until it has an Ability and either the Diagnostic is done or it has 20 Rated Responses. Practice Sets take a target difficulty and a Trap Pattern among their filters, and matching Questions are ordered unseen first, then nearest the target. Retries go by the Priority of the Weak Area of their Question's primary Skill, then the longest waiting first.
89. The Diagnostic is a Mock on the first study day when weekly time holds a Mock, else the three Sectionals, one a day from the first study day. It is done once any Mock is finished, or the three Diagnostic Sectionals. Once begun as Sectionals it goes on, one a day, and a Section that cannot serve its Sectional is dropped with the reason. The plan schedules only as many Mocks and Sectionals as the start check allows, the Diagnostic first and then the Mocks nearest the test, and lists the rest as dropped with the reason. With weekly time under a Mock, each Mock week gets the three Sectionals on its last three study days instead, and the plan says why. While the Diagnostic is skipped, or no Mock can start and none of it is taken, the plan says each Section is practised at Medium until it has 20 Rated Responses; a Diagnostic that could not start is offered once a Mock can, and a skipped one is not offered again, so skipping asks first.
90. Plan versions are append-only: plan_versions (Profile, version, built time, from Study Day, basis, inputs and snapshot, and the days' outline as JSON) and plan_items (version, Study Day, position, kind, the item as JSON, minutes, planned or dropped, reason). Reading the plan builds a new version when its basis differs from the latest's: the Study Day, the settings row, the Mocks and Sectionals finished, the Diagnostic's state and Sections left, and, until the Diagnostic is done, which Sections have 20 Rated Responses. The basis is read first and cheaply, the start check only while the Diagnostic waits, and the whole snapshot only to build. One build runs at a time, and one start, and plan items are written 200 to a statement. A Session started from an item names it (sessions.plan_item_id); the item is started while that Session runs and done once it ends, worked out on read, never stored. Only today's planned items of the latest version start, and starting one already running goes back to its Session. A version built during a day plans only what is left of it (decision 86), and today's items started or done under an earlier version stay on today's list. No event tells an open page of a new version yet: the Plan page reads the plan again when it is shown again and every 5 minutes, and a Start refused because the plan changed says so above today's items.
91. The Daily Log covers the last 90 Study Days with work, a plan or a note: the minutes and Questions of first Responses, accuracy by Section, Mocks finished, the items the last version built before the day ended planned for it with those started or done under any version, and the Learner's note (daily_notes, append-only, the latest kept; an empty note clears it), kept for today and the 89 Study Days before it and refused for other days. It reads only the versions' times and the items of the days it shows. A Study Day is a date, so a 23- or 25-hour day is one entry.
92. A time zone or rollover hour change takes effect at the next rollover: profile_days rows (Profile, time zone, rollover hour, from, set time). A moment's Study Day uses the row in effect then, and never goes back to a day already ended, so a zone behind the old one holds the next day until its own date catches up. No day repeats or splits; a long move east can skip one. Undoing a change still waiting keeps the current rule, and no change shows as waiting. The Error Log's times and Book names use the rule in effect now, not one still waiting. The Profile's first row holds from always.
93. Lessons (ticket 17) are versions per subject, a Skill or a Question Type: lessons holds the subject, the version, its status (draft, approved or rejected), the subject's basis, the content as JSON, its words and the methods part's words, the worked example and check Question ids, the model, prompt version and job, when it was written, when it was decided and the Curator's note. Learners see each subject's latest approved version; a newer draft waits for the Curator and does not hide it.
94. A Lesson holds the rules (each with a title), the methods (each with a name, the Strategy it follows where one fits, when it is valid, and its steps, the fastest valid first), the common traps (each with its Trap Pattern where one fits), and a walkthrough of each worked example. Text is Markdown with math between \( \) or \[ \], rendered as Questions are.
95. The worker writes Lessons in a job, one subject a step: the subjects the Curator names, else every one with no Lesson approved or waiting, or marked for rewriting, under the spend cap the Curator gives (5 dollars unless changed). Each step picks the worked examples and the check by code, then asks the model for the content with the worked examples, their keys, explanations and Approaches quoted as data. The reply is checked: a walkthrough for every worked example, numbered in order; Strategies and Trap Patterns only from those of the subject's Question Types; lengths; math that renders. A reply unusable twice skips the subject with the reason, and the job goes on to the next. A step run again after a stop writes no second draft.
96. Worked examples and check Questions are published Questions that carry the subject (as their primary Skill, or their Question Type) and are outside the Mock Reserve or released from it. Up to 3 worked examples are picked first by having an Approach, then an explanation, then spread over the Difficulty Bands (Medium first) and over passages; the 5 check Questions spread the same way, none a worked example. The same Bank gives the same pick. A subject with fewer than 6 such Questions, one worked example and the check, gets no Lesson, and the Curator's page says how many it has.
97. A Lesson is marked for rewriting, worked out on read, when its basis (the subject's name and description in the Taxonomy, with its Section and Topic) differs from the current one, or when a worked example is no longer published with the subject outside the Mock Reserve. A marked Lesson stays visible to Learners until a new version is approved.
98. The Curator's Lessons page lists every subject with where its Lesson stands (approved, waiting, turned down with the note, marked and why, or too few Questions), starts the job for those needed or for one subject, and opens any version as a Learner would read it, to approve a draft or turn it down with a note.
99. Opening a Lesson records a lesson view (lesson views: Profile, Lesson, opened or read, part, plan item or none, time). The whole Lesson's worked examples count as Seen from the first time it opens, as a Paper Mark's Questions do (decision 57), so a Question first Seen in a Lesson is never Rated and practice that asks for unseen Questions leaves it out. A Sectional report still counts only Paper Marks as done on paper.
100. The check is an untimed Practice Set of the Lesson's 5 check Questions, started from the Lesson's page or its plan item. One no longer published with the subject outside the Reserve is replaced by another of the subject's Questions, never a worked example, and those a running Sectional or Mock holds are left out, so the check can be shorter when the subject runs short.
101. The Study Plan adds Lessons as remedies: for a Weak Area whose misses are most often a Concept gap, its subject's whole Lesson (its words at 200 a minute plus the check's Target Times and 20%) before its untimed set; for a Wrong approach, the Lesson's methods part (its words) before its timed set. A Lesson comes once in a plan, only while approved and not yet done since that version was approved: the whole Lesson by finishing its check, the methods by marking any part read. A Lesson item opens the Lesson's page; it is started once its page opens from the item, and done as the Lesson is. One no study day planned in full has room for is dropped with the reason. A Lesson started or done today is not planned again today, and is followed by its Weak Area's set. Approving a Lesson, or finishing one, builds the plan again.
102. The Debrief has a button to the Lesson on the Question's primary Skill, once approved. Lesson pages write the subject's id with slashes, as a path ending in a dotted name is taken for a file.
103. Tutor Chat (ticket 18) runs in the server, not the worker: one call a message, task "tutor-chat", through the same adapter, so its tokens and spend are recorded the same way. The server gains the adapter over the HTTP transport. A Learner waits on the reply, so a call the API refuses for being down or rate limited is sent twice at most, and one that asks to wait over a minute is not waited for.
104. tutor messages hold the Profile, the Question (as the one it counts as after a merge), the message, the reply, the model, prompt version, tokens, cost and time. A message the same as an earlier one from the same Profile about the same Question, compared after trimming, folding spaces and ignoring case, gets the stored reply with no call, marked as reused. No Profile's messages or replies are ever read for another.
105. The model is given the Question with its Stimulus, its key and the Book's explanation, the Approaches that reach the current key, the Learner's final answer in each Session that shows how it went with its Mistake Types, the Learner's misses on the Question's primary Skill counted by Mistake Type, and the last 6 exchanges about the Question, all quoted as data. The system prompt says the key is correct, never to argue it, and that a Learner who believes it is wrong can use Report a problem. A Learner can chat about a Question once a Session that shows how it went holds an answer to it, and not while a running Sectional or Mock holds it.
106. The monthly cap is a Curator setting in dollars, 5 until changed. Spend counts every Tutor Chat call this calendar month in the app's time zone, from the recorded calls. A call starts only while the month's spend is under the cap; one that crosses it is kept. The chat says when the cap is reached, Tutor Chat is not set up, the API cannot be reached, or a reply failed its check twice, and nothing else is affected.
107. problem reports hold the Profile, the Question, the Learner's words and time, and the Review Queue item they joined: each report adds its words as a "problem-report" reason to the Question's open item for reports, or opens one. The Question stays published. The Curator decides as for any item: keep it as it is (dismissed), change the key, which sends it through enrichment and the Publish Gate again, or withdraw it. The Learner's reports are listed on the Error Log page with the decision.
108. Every Debrief shown with its Question, in Practice Sets, Sectional and Mock reports and the Error Log, has Ask the tutor and Report a problem.
109. Snapshots (ticket 19) are files in the data folder's snapshots folder, each recorded in the snapshots table: kind (daily, pre-migration, pre-taxonomy, pre-rescore, pre-deletion, pre-restore or manual), file, time taken, the host's calendar date, size, SHA-256, status (ok, failed or removed) and error. Every attempt is recorded: a failed copy leaves no file, and its failure shows on the Curator's Overview and Data page until a later snapshot of its kind succeeds; a full disk is named as such. Files found in the folder with no record, such as those taken before a migration, before the table could hold them, are recorded from their names.
110. The day's snapshot is taken at startup and on the hour when none was taken that day, by the host's calendar. After each snapshot, those the rule no longer keeps are deleted: the 7 latest daily snapshots, the first daily one of each of the 4 weeks before them (weeks starting on Monday), and the 10 latest taken before a change, of any kind (`src/server/snapshots/retention.ts`).
111. A snapshot is `VACUUM INTO` on a read-only connection in a short process of the app's own executable (`snapshot-copy`), so a large database never holds up requests while the server waits for it. The same process checks a file (`snapshot-check`), brings one to this version's tables (`snapshot-migrate`) and hashes one (`snapshot-hash`); tests run the same work in process. The snapshot before a migration, at startup, runs on the server's own connection.
112. Restore, from the Curator's Data page, waits while a job runs or a Mock, Sectional or timed set is under way. The chosen snapshot's checksum is checked, then it is copied, checked with quick_check and brought to this version's tables on the side, and refused if a newer version took it. A pre-restore snapshot then keeps the database as it stands, and in one transaction with foreign keys off every table but the migration log, the snapshots, the Curator's passphrase and the unlocks is emptied and filled from the copy, its references checked before it commits. Unlocks of Profiles the snapshot does not hold end, jobs that were queued or running in it wait as paused, and job revisions move past those already sent. Caches follow the database's version, so every view is read anew.
113. A Profile exports as JSON from its profile page, reached from the Learner's name at the top: every row of each table with a profile_id, and of the tables whose rows belong to one of those, such as served Questions and plan items, found from the database's own foreign keys, so a later table joins by itself; with the Profile's name, time zone and whether it has a PIN, never the PIN's hash or its unlocks.
114. The install exports from the Curator's Data page as one tar archive in the POSIX ustar format, written a piece at a time: a fresh copy of the database as gmat-prep.sqlite, the books folder and the figures folder. Only the latest archive is kept, in the data folder's exports folder, for the Curator to download. Unpacking it into the data folder of a closed app on another computer moves the install; the LLM key, kept outside the data folder, is entered again there.
115. A Learner deletes their own Profile from its profile page with its PIN, if it has one, counted as an unlock attempt; the Curator deletes any Profile from the Data page after entering the passphrase again, counted as an unlock attempt too. A pre-deletion snapshot comes first, and nothing is deleted if it fails. Everything the Profile holds goes with it; a Problem Report's words stay in its Review Queue item, which is about the Question.
116. The Curator sets a Profile's PIN anew, or takes it away, on the Data page: its failed attempts and any lock clear, and every unlock of the Profile ends, so each browser asks for the new PIN.
117. A full integrity_check runs once a week on the live database, in the same short process. Its outcome is a file in the snapshots folder, as it is about the database file, so a restore leaves it alone; damage shows on the Overview and the Data page with the advice to restore a snapshot taken before.
118. A snapshot is also taken before a Key Override, which judges every past Response to the Question again (pre-rescore; the override waits when it fails), and at startup before a Taxonomy the database has not used is recorded (pre-taxonomy; a failure is shown and the app starts).
119. LAN mode (ticket 20) is off by default. The Curator turns it on or off on the Devices page, on this computer only, and it takes effect at once. It is kept in its own table, lan_mode, which a restore leaves as it is, with the devices, so a restore never opens the app to the network or brings back a revoked device.
120. In LAN mode the app also listens on each of this computer's IPv4 network addresses, at its own port, beside 127.0.0.1, which never closes. It looks at the addresses every 10 seconds, so it follows a laptop that joins another network, and says on the Devices page where other devices open it and any address it could not listen on. Turning LAN mode off closes those listeners, and requests from other devices still open are refused.
121. Every request is judged by where it comes from (src/server/access/reach.ts). From this computer, by loopback or any of its own addresses, it goes on as before. From another device it needs LAN mode on, a Host header naming this computer, and the cookie of a paired device not revoked; without that cookie only the app's pages and files, which hold no one's data, and pairing are answered, judged on the path as sent, plain characters only, so no encoding the router undoes reaches an API route. A refusal is 403 with X-GP-Refused saying why, and the app then shows its pairing page.
122. Pairing: the Curator, on this computer, shows a 6-digit code, every code equally likely, that works once within 5 minutes; a new code ends the one before. Five wrong codes in a row end it, and with no code waiting every try is wrong. The device gives itself a name and gets a token of 32 random bytes in an HttpOnly, SameSite=Strict cookie (gp_device) kept for 400 days; only the token's SHA-256 is stored, with the pairing time and the last time seen, written at most every 5 minutes. A device from this computer needs no pairing.
123. Revoking a device ends its requests at once, and the open event streams of any device that may no longer reach the app end too. A revoked device pairs again with a new code, as a new device. A Profile's PIN guards it on a paired device as on this computer, and Curator tools work from a paired device with the passphrase, but LAN mode, pairing codes and the devices list answer only on this computer, checked again in their handlers.
124. LAN traffic is plain HTTP: the Devices page and the pairing page say so, and that LAN mode is for a trusted network such as home Wi-Fi, never public Wi-Fi.
125. On a narrow screen the Stimulus stands above its Question, and beside it from 64rem. Both layouts share one tree, so turning a tablet keeps the source tab and the table sort the Learner chose.
126. The exam screen's comforts (ticket 21): every screen has a Display button at its top, the Profile picker, the pairing page, the Curator passphrase screens and the stopped screen included; only the last-resort page shown when a screen crashes has none. It sets this browser's colours (match the device, light or dark) and text size (standard, larger at 112.5% and largest at 125%, which scale everything set in rem, and the analytics charts with their text). The choice is kept in this browser's storage only, as one person's eyes and screen decide it. A small script in the page head (web/public/display-boot.js) applies it before the first paint, and every open tab follows a change made in another; a change is made over the choice saved last, so a tab that missed another tab's change does not undo it. The timer can be hidden and shown again, and stays hidden for the rest of the Session, a Mock's later Sections included. Once the time left reaches 5 minutes, or a fifth of a shorter limit, a warning shows under the timer and is announced as it shows, whether the timer is shown or not. It stays until dismissed, and a dismissed warning stays dismissed through a pause or a reload. It gives the time left when it showed, rounded up to whole minutes, or to tens of seconds from 50 seconds down ("Under 5 minutes left."), so it stays true while it shows. Both choices are kept in this browser: the hidden timer for the Session, and the dismissed warning for its clock, as each Section of a Mock has a clock of its own. A to E pick an option and Enter submits in Practice Sets, Sectionals and Mocks, but not while focus is in a text field, the calculator or the Mistake Type control, and not while the Display panel is open, wherever focus is; Enter on a button, a link or a fold's summary presses that instead. The guessed button, the instant Debrief and pause belong to Practice Sets only: the Sectional and Mock screens and their API have none.
127. The speed targets and the end-to-end Mock (ticket 22). `test/speed.test.ts` runs when asked (`bun run test:speed`, `PERF=1`) on the real routes over HTTP with one Profile's 50,000 Responses, and holds each kind of action, and each analytics view, to its limit at the 95th percentile by nearest rank, so no slow kind hides among quick ones: Sectional submits, timed Practice Set submits and Next; Sectional starts, Mock starts and each Mock Section after a break, among them the first start after the app starts and the first after a Bank change; each of the seven analytics views 23 times: the first after a start, twenty with half right after a Mistake Type is set through the Error Log, one right after an answer, and one right after a Bank change; and the executable's start, four times on the 50,000 Responses, after one start that takes the day's snapshot and the week's integrity check as the day's first start does, and twice on an empty data folder. `PERF_SLACK` multiplies the limits for a slower machine. On the 2-vCPU build container under a load of about 2, the 95th percentiles were 44 ms a Sectional submit, 90 ms a Sectional start, 210 ms the slowest view (Weak Areas) and 1.1 s a start of the executable. What is kept to get there: a Question's summary, until the Question Bank changes, as triggers on the questions, parts, options, option notes, sources and books tables move a one-row `bank_version` on every write, from this process or the worker; each read works on the map for the version it read before its rows, the Difficulty is read fresh, and `bank_version` is kept on restore so it never goes back; the Bank's Skill and Question Type frequencies the same way. A Mistake Type change writes in a transaction whose changes the Error Log counts apart, so the facts, the Abilities and the views that show no Mistake Type (the Skill map, Timing and Study) stay kept, and only the labels are read again. The Rated Responses read their selections without the Schema's cost, as the Error Log does. The Sectional engine keeps, for the few Profiles read last, when each Question was last served to them, reading only the rows served since, the kept rows and the times moving together; merges are applied on each read. `test/mockEndToEnd.test.ts` runs when asked (`bun run test:e2e`, `E2E=1`) and takes a full Mock on the default blueprint in Chromium against the real server, the server's TestClock and the page's clock moved together, a minute a Question: a Bookmark and a changed answer in Review & Edit, checked there and in the Section's report; the break run out; the app stopped for a minute in Section 2 and started again (an Interruption, marked on the report); the time warning with the timer hidden; and Section 3 run out of time; then the Mock report and the Score Estimates. It runs offline: the page may reach only the app, and the LLM transport serves recorded replies from an empty folder and counts every call, which must be none. It found that the last Section of a Mock, finished or run out of time on the Mock's screen, showed its own report: it now hands back to the Mock's screen, which shows the Mock's report. Its review found that a snapshot's process ran on after the app stopped: an interrupted copy or check now ends its process. Test data folders are removed when a run ends, by the test preload `test/cleanup.ts`, as `bun test` runs no exit handlers.

### Taxonomy review notes

The drafting pass for Mistake Types, Trap Patterns and Strategies left these judgement calls for review:

- Math Trap Patterns live under Quant and also tag DS. Two of them (a different quantity, an ignored condition) also tag TPA, and the percent, averaging and overlap ones also tag other Data Insights types. Some Verbal entries also tag verbal TPA and text MSR.
- On a DS option, a specific math Trap Pattern wins over the general DS ones (agreeing cases, needless combination).
- Missed number cases are four separate Trap Patterns: non-integers, negatives, zero and equal values.
- Four Trap Patterns may recur too rarely and are candidates to cut: same topic with different logic (RC), filling in an unstated fact (DS), assuming different values (Quant) and missing a working combination (DS).

### Open items

- A sample Book is needed to confirm the Book Map heuristics and to build the golden set.
- The exam facts were checked on 15 October 2026, and GMAC can change the format.

### Sources

- [GMAT exam structure, mba.com](https://www.mba.com/exams/gmat-exam/about/exam-structure)
- [GMAT scores, mba.com](https://www.mba.com/exams/gmat-exam/scores)
- [GMAT Data Insights guide, Target Test Prep](https://blog.targettestprep.com/gmat-data-insights/)
- [GMAT Focus score chart, Target Test Prep](https://gmat.targettestprep.com/score_chart)
- [How many questions are on the GMAT, Test Prep Insight](https://testprepinsight.com/resources/how-many-questions-are-on-the-gmat/)
- [GMAT format and section breakdown, Magoosh](https://magoosh.com/gmat/what-is-the-format-of-the-gmat/)
