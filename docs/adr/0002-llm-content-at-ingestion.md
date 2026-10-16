# LLM work happens at ingestion; only Tutor Chat calls the API at runtime

Tests and practice must stay fast and must keep working when the completions API is slow, rate limited or down. Everything a Question needs is generated once at ingestion, checked by the Publish Gate and stored: Skill and Question Type tags, a Difficulty estimate, one or two Approaches tagged with Strategies, and for each wrong option a Trap Note, a likely Mistake Type and a Trap Pattern. Lessons are written once after ingestion and approved by the Curator, and the Study Plan is built by rules in code. Outside Curator-run jobs, only Tutor Chat calls the API, under a monthly spend cap. Expected result: everything except Tutor Chat works with the API unreachable, and almost all LLM cost is paid up front at ingestion.

## Considered options

- An LLM-written Study Plan: rejected. Rules give the same plan for the same inputs and can be tested.
- Classifying each mistake with an LLM call after the answer: rejected. Per-option tags written at ingestion give the same pre-fill offline.
