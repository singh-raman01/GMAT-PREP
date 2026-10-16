# GMAT prep

A local study app for GMAT Focus. It turns Books into a shared Question Bank and tracks each Profile's practice, tests and progress.

## Language

### People and data

**Learner**:
A person studying for GMAT Focus with the app, through one or more Profiles.
_Avoid_: student, test taker

**Profile**:
One Learner's separate history on this install: their Responses, plans, Daily Logs and analytics. One person may own several.
_Avoid_: user, account, login

**Curator**:
The role that feeds Books in and decides what enters the Question Bank. It acts for the whole install.
_Avoid_: admin, owner

**Question Bank**:
Every published Question on this install, shared by all Profiles.
_Avoid_: question pool, item bank

### Exam

**GMAT Focus**:
The current edition of the GMAT and the only one this app targets.
_Avoid_: new GMAT

**Section**:
One of the three timed parts of GMAT Focus: Quantitative Reasoning, Verbal Reasoning or Data Insights.
_Avoid_: subtest

**Data Sufficiency (DS)**:
A Data Insights Question Type: decide whether two statements give enough information to answer a question.

**Multi-Source Reasoning (MSR)**:
A Data Insights Question Type built on two or three tabbed sources of text or tables.

**Table Analysis (TA)**:
A Data Insights Question Type built on a sortable table and a set of Yes/No or True/False statements.

**Graphics Interpretation (GI)**:
A Data Insights Question Type built on a chart, with dropdown blanks that complete statements about it.

**Two-Part Analysis (TPA)**:
A Data Insights Question Type where the Learner picks one answer in each of two columns.

**Retired item**:
Book content of a type GMAT Focus no longer tests, such as Sentence Correction or geometry.
_Avoid_: legacy question

### Questions

**Question**:
The scored unit. It counts as right only when every one of its Parts is right.
_Avoid_: item

**Part**:
One answer slot in a Question, such as a TA row, a GI blank or a TPA column. PS, DS, CR and RC Questions have one.
_Avoid_: sub-question

**Stimulus**:
Material a Question refers to, shown in its own pane: an RC passage, MSR tabs, a TA table or a GI chart. One Stimulus can serve several Questions.
_Avoid_: context, passage block

**Source**:
Where a Question came from: a Book, page and number, or the generator. A Question can have several.
_Avoid_: origin, provenance

**Variant**:
A near copy of a Question with changed numbers or wording. It is a separate Question.
_Avoid_: duplicate

**Extracted Question**:
A Question taken from a Book, carrying that Book's answer key.

**Generated Question**:
A Question the app wrote from its own Dataset, with its answer key computed from that Dataset.

**Dataset**:
The typed table or series behind a Data Insights Question. Its chart and its answer key both come from it.
_Avoid_: raw data, data table

**Approach**:
A stored worked route to a Question's answer, tagged with one Strategy, an expected time and when it is valid. A Book's own explanation is one.
_Avoid_: solution, explanation

**Trap Note**:
The stored explanation of why one wrong option tempts.
_Avoid_: distractor explanation

**Target Time**:
How long a Question should take at exam pace, set per Question Type.
_Avoid_: par time

### Taxonomy

**Taxonomy**:
The fixed, versioned lists every tag must come from: Sections, Topics, Skills, Question Types, Mistake Types, Trap Patterns and Strategies.
_Avoid_: tag list, categories

**Topic**:
A group of related Skills within a Section.

**Skill**:
A unit of ability a Question exercises, whichever Section serves the Question. Each Question has one primary Skill and up to two secondary ones.
_Avoid_: concept, subskill

**Question Type**:
The kind of task a Question sets, such as CR Assumption or RC Inference. Each Question has exactly one.
_Avoid_: item type, question format

**Mistake Type**:
The cause of a wrong Part: Concept gap, Wrong approach, Trap, Calculation slip, Misread or Time pressure.
_Avoid_: error category, error reason

**Trap Pattern**:
A recurring way wrong options tempt, such as assuming a number is an integer in DS.
_Avoid_: trap type

**Strategy**:
A named way of solving, such as picking numbers or testing the answer choices.
_Avoid_: technique, trick

### Content pipeline

**Book**:
A source document the Curator feeds in. A new edition of the same title is a different Book.
_Avoid_: upload, document

**Book Map**:
The Curator-confirmed layout of a Book: where each question set, its answer key, its explanations and its difficulty labels sit.

**Publish Gate**:
The checks a Question must pass before it enters the Question Bank.
_Avoid_: verification check, QA

**Review Queue**:
Questions waiting for a Curator decision, each with the reason it was held.

**Key Override**:
A Curator decision that replaces a Book's answer key, stored with its reason.
_Avoid_: correction, errata fix

**Withdrawn**:
The state of a Question the Curator has taken out of the Question Bank. Its past Responses stay in history.
_Avoid_: deleted, unpublished

**Problem Report**:
A Learner's report that a Question or its key may be wrong. It sends the Question to the Review Queue.
_Avoid_: dispute, complaint

### Sessions

**Session**:
One sitting of a Mock, a Sectional or a Practice Set.
_Avoid_: test session

**Mock**:
A full GMAT Focus simulation: all three Sections in the order the Learner picks, adaptive and timed, with the optional break.
_Avoid_: full-length test, practice test, paper, CAT

**Sectional**:
One Section taken alone under Mock rules.
_Avoid_: section test

**Practice Set**:
A Session of Questions chosen by Section, Question Type, Skill, Difficulty Band, status or Source, timed or untimed.
_Avoid_: quiz, worksheet

**Section Blueprint**:
The number of Questions each group of Question Types gets in an adaptive Section, such as 10 for the CR Question Types.
_Avoid_: question mix

**Mock Reserve**:
The share of each Section's Questions kept out of Practice Sets so that Mocks and Sectionals can serve unseen ones.
_Avoid_: hidden pool, test bank

**Bookmark**:
A Learner's mark on a Question during a Section, so it can be found again on the Review & Edit screen.
_Avoid_: flagged question

**Review & Edit**:
The screen after a Section's last Question, shown only if time remains, where up to three answers can be changed.
_Avoid_: review mode

**Interruption**:
Time a timed Section loses when the app stops or the machine sleeps. It is not counted, and the Session is marked.
_Avoid_: outage

### Performance

**Response**:
What a Profile selected for each Part of one Question at one moment in a Session, with the time spent.
_Avoid_: attempt, submission

**Seen**:
A Question is Seen by a Profile once a Session has served it to them, a Lesson has shown it as a worked example, or a Paper Mark covers it.
_Avoid_: attempted, exposed

**Rated Response**:
A Profile's final Response to a Question in the Session where the Question was first Seen, when that Session was timed and the Response is not a time-out. Only these move Difficulty and Ability.

**Difficulty**:
A Question's position on the scale it shares with Ability, seeded from its Book Label or an LLM estimate and adjusted by Rated Responses.
_Avoid_: hardness, difficulty level

**Difficulty Band**:
Easy, Medium or Hard, read off a Question's current Difficulty.

**Book Label**:
The difficulty label a Book prints for a Question, kept for reference.

**Ability**:
A Profile's estimated strength in a Section, Skill or Question Type, on the same scale as Difficulty.
_Avoid_: skill level, rating

**Weak Area**:
A Skill or Question Type whose Ability sits below the Ability of the Section or Sections it appears in.
_Avoid_: weakness, weak spot

**Priority**:
A Weak Area's rank: its gap, weighted by how often it appears on the exam.

### Scores

**Score Estimate**:
The app's estimate of a Section score (60 to 90) or a Total score (205 to 805), always shown with a range.
_Avoid_: predicted score, projected score

**Official Score**:
A score from an official GMAT practice exam or a real sitting, entered to calibrate Score Estimates.

### Learning

**Error Log**:
A Profile's record of Questions answered wrong, slowly or by a guess, with one entry per Question.
_Avoid_: mistake list, wrong-answer list

**Retry Ladder**:
The three scheduled steps that clear an Error Log entry: the same Question again, then two Siblings. Each step is a Retry.
_Avoid_: spaced repetition, review schedule

**Sibling**:
An unseen Question with the same primary Skill and Question Type as a missed one, and similar Difficulty.
_Avoid_: similar question, twin

**Resolved**:
The state of an Error Log entry whose Retry Ladder is complete.

**Debrief**:
What a Profile sees after a Question: the Trap Note for the option picked, the Approaches fastest first, and Siblings to practice.
_Avoid_: results screen, answer review

**Lesson**:
Curator-approved teaching material for one Skill or Question Type, with worked examples taken from the Question Bank.
_Avoid_: tutorial, chapter

**Tutor Chat**:
A conversation with the LLM about one Question, grounded in its key and Approaches.
_Avoid_: AI tutor, assistant

### Study

**Study Plan**:
A Profile's schedule of Plan Items up to its test date, rebuilt by rules as results come in.
_Avoid_: roadmap, study schedule

**Plan Item**:
One piece of scheduled work on a Study Day: a Lesson, a Practice Set, due Retries or a Mock.
_Avoid_: todo, study task

**Diagnostic**:
The first Mock of a Study Plan, taken whole or as three Sectionals.
_Avoid_: placement test

**Paper Mark**:
A Profile's record that it has studied a Book, or a page range of one, on paper.
_Avoid_: offline flag

**Daily Log**:
The automatic record of one Study Day for a Profile, plus an optional note.
_Avoid_: journal, diary

**Study Day**:
A day that starts at the Profile's rollover hour, 4 am local by default.
_Avoid_: calendar day
