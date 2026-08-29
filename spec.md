# learning tracker — spec

Learning system for AI engineering. Build-and-fail, not read-and-summarise.

This document is the contract. If a decision isn't covered here, default to
"build the smaller thing and see what breaks."

---

## 1. Principles

1. **Every unit starts with a build.** No unit begins with reading.
2. **A concept is earned, not scheduled.** You learn a thing when a failure
   makes you want it. Topics without a trigger sit in `parked/`.
3. **Breaking is a deliverable.** "Break it on purpose" is a required step, not
   an optional extra. If nothing broke, the build was too easy.
4. **The exit is a blank-page claim.** A unit closes when you can explain the
   mechanism without notes — and have written down what you still can't.
5. **Dry work is timeboxed, not skipped.** 90 minutes maximum per session on
   labelling, statistics, or any task with no visible output.
6. **Ship to yourself.** Anything built in phase N should still be in daily use
   at phase N+2. Failures you notice for free beat failures you go hunting for.
7. **No PDFs in the repo.** A source earns a link and one line on what it
   changed in your head. If you can't write that line, you didn't read it.

---

## 2. Repo layout

```
learning-tracker/
├── SPEC.md                 this document
├── README.md               dashboard — status table, current phase
├── CONFUSIONS.md           append-only interest queue
├── sources.md              links + one line each
├── phases/
│   ├── 01-tool-calling/
│   │   ├── README.md       unit spec (see §4)
│   │   ├── src/
│   │   └── traces/         raw failure output
│   ├── 02-the-loop/
│   ├── 03-search/
│   ├── 04-serving/
│   └── 05-reassess/
├── parked/
│   └── README.md           trigger registry (see §6)
├── notes/                  flat. claim-shaped filenames.
└── benchmark/              your own eval suite. Arabic tasks. Survives phases.
```

Rules:

- **Folders for code, flat for notes.** A note on KV-cache arithmetic belongs to
  three phases at once. Nest it under one and you'll never find it from the
  others. `notes/kv-cache-memory-arithmetic.md`, not `notes/serving/cache.md`.
- **Notes are claims, not summaries.** Filename states the claim. Body defends
  it to a smarter colleague.
- **`benchmark/` is not phase-scoped.** It's the one asset that compounds across
  everything. Rerun it on every model release.
- **Never rewrite git history.** `git log --oneline` is the most truthful record
  of this project you will ever have.

---

## 3. Unit schema

Every phase README follows this shape. No exceptions — the structure is what
keeps the learning honest.

```markdown
# Phase NN — <name>

**Status:** not started | building | walled | closed
**Gate:** <prerequisite, or "none">

## Build
<what to construct. concrete. one paragraph.>

## Verify
<the observable proof it works. must be checkable in minutes, not days.>

## Break on purpose
- [ ] <failure to induce>
- [ ] <failure to induce>

## Wall
<the failure you expect to hit and not be able to explain>

## Earned concepts
<what the wall entitles you to learn. read these now, not before.>

## Exit — blank page
Can explain without notes:
- <claim>

Still can't explain:
- <gap>  → logged in CONFUSIONS.md
```

A phase is `closed` only when the exit section has entries in **both** lists. An
empty "still can't explain" list means you weren't honest, not that you're done.

---

## 4. Phases

### Phase 01 — tool calling

**Gate:** Python fluency — typed Python, `uv`, `pytest`, `pydantic`, async.
The only upfront prerequisite in the whole spec.

**Build.** One script. One model call. One tool with a real side effect — hits
an API, writes a file, queries a database. No framework.

**Verify.** The tool fires with correct arguments; you see the effect.

**Break on purpose.**
- Request a call whose argument the model cannot know
- Two tools with confusable descriptions
- Tool returns an error
- Required enum + a request matching no value

**Wall.** Arguments don't validate; the script crashes.

**Earned concepts.** The schema is a contract and the model is an unreliable
client. Validation, and feeding errors back into the loop rather than throwing.

---

### Phase 02 — the loop

**Gate:** phase 01 closed.

**Build.** While-loop over a message list. Tool results appended. Stop
condition. ~100 lines, no framework. Then three real tools, pointed at an
actual recurring annoyance in your own work.

**Verify.** It completes a task you would otherwise do by hand. Then use it
daily for a week — that week is part of the deliverable.

**Break on purpose.**
- A task needing 15+ steps
- A slow tool
- An intermittently failing tool
- Kill the process mid-run

**Wall.** Works at step 3, degrades by step 15, and you can't see why. Killing
it loses everything.

**Earned concepts.** Trajectory logging (just enough to debug). Context
accumulation as root cause. Checkpointing. The real lesson: an agent is a
stateful long-running job, not a function call.

---

### Phase 03 — search

**Gate:** phase 02 closed.

**Build.** BM25 from scratch over your own documents — Arabic, ideally.
Inverted index, term weighting, no retrieval libraries. Then wire it in as a
tool the phase-02 agent calls.

**Verify.** Type a query, judge results by eye. Feedback in seconds.

**Break on purpose.**
- A query whose answer exists but ranks 40th
- A document that should never match but does
- Arabic queries using different morphological forms of one root

**Wall.** Results are bad on some queries and you cannot tell whether the cause
is chunking, tokenisation, or ranking.

**Earned concepts.** recall@k and a golden set, bootstrapped from documents
whose answers you already know. Then embeddings and hybrid fusion — added *to*
BM25 and measured against it, never replacing it blind.

**Note.** Starting with BM25 rather than embeddings is deliberate. BM25 is
inspectable by hand, which is what makes the "retrieval or generation?"
question answerable at all.

---

### Phase 04 — serving

**Gate:** Linux + SSH + Docker + `nvidia-smi`. Rent the GPU before reading
anything.

**Build.** Serve an open-weights model with vLLM. Point a minimal gateway at
both it and the hosted API. Route your own tasks through both.

**Verify.** tokens/sec, cost per task, quality on your tasks. Numbers you
generated yourself.

**Break on purpose.**
- Raise concurrency until it OOMs
- Raise context length until it OOMs differently
- Run a quantised variant and hunt for degradation on your tasks

**Wall.** You can't predict when it will OOM, and can't explain why throughput
scales with batching while latency doesn't.

**Earned concepts.** KV-cache arithmetic. Paged attention. Continuous batching.
Memory-bound decode vs compute-bound prefill.

---

### Phase 05 — reassess

Not a build phase. Four working systems exist; pick a direction by pull, not by
plan.

Candidate directions: agent reliability and durability · retrieval quality ·
inference performance · Arabic-specific model behaviour.

**Output.** One paragraph in `README.md` naming the direction and why. Then a
new phase spec written to §3.

---

## 5. Cross-cutting: `benchmark/`

Not a phase. Standing asset, started at phase 03 and never closed.

50–100 tasks from your own domain, mostly Arabic. Rerun on every model release.
Over a year this becomes both your judgement and the thing about your work that
nobody else can fake.

---

## 6. Parked registry

Parked ≠ skipped. Each entry has a trigger. When the trigger fires, the topic
graduates into a phase written to §3. Studying these cold is the boredom this
spec exists to prevent.

| Topic | Trigger |
|---|---|
| Eval methodology — taxonomy, LLM judge, judge validation | Two versions exist and you genuinely can't tell which is better |
| Statistics for evals — sample size, paired tests, CIs | Your eval reads 74% vs 71% and you must decide whether to ship |
| Context engineering — compaction, budgeting | Long-run degradation is your top recurring failure |
| Guardrails, injection defense | Your agent reads something a stranger could have written |
| Durable execution — Temporal, DBOS | Losing a mid-run trajectory has cost you real time twice |
| Orchestration, subagents | A single agent with good tools has provably plateaued |
| LangGraph (read source; skip LangChain) | You've written your own loop and want to know what they add |
| Adaptation — LoRA, distillation, DPO | Prompting has plateaued on a narrow task you care about |
| Transformer from scratch | A model-behaviour question you actually care about — likely Arabic tokenisation |
| Compute substrate — roofline, bandwidth vs FLOPs | You're optimising serving and hit a ceiling you can't explain |

**Prerequisites follow the same rule.** Paid at the gate, not upfront. Python
fluency is the sole exception because it blocks phase 01. NumPy tensor work
waits for the transformer phase. Statistics waits for its trigger.

---

## 7. `CONFUSIONS.md`

Append-only. Never delete an entry; strike it through when resolved.

```markdown
## 2026-08-11
- Why does the loop degrade at step 15 but not step 5? Context length or
  something about tool-result formatting? [phase 02]
- ~~What does top-p actually do to the logits?~~ resolved →
  notes/sampling-top-p-truncates-the-tail.md
```

This file is the **interest queue**, not a homework list. Pick from it by
curiosity. Entries that keep resurfacing are the honest signal for where depth
is genuinely owed — that signal is more trustworthy than any curriculum,
including this one.

---

## 8. Dashboard (`README.md`)

```markdown
| Phase | Status | Wall hit? | Blocked on | Last touched |
|---|---|---|---|---|
| 01 tool-calling | closed | yes | — | Aug 09 |
| 02 the-loop | building | not yet | — | Aug 11 |
| 03 search | not started | — | phase 02 | — |
```

---

## 9. Anti-patterns

Explicitly out of scope. Each is a real failure mode for this specific project.

- **Scaffolding as procrastination.** Building the full folder tree before
  writing code. Create phase 01 and the three root files; extract the rest once
  two phases exist and you can see what they share.
- **What/why/how as entry point.** Writing a topic's summary before building it
  produces a summary of other people's explanations. What/why/how is the *exit*
  section, answering a failure you personally caused.
- **Framework-first.** Learning `AgentExecutor` instead of the loop. Write the
  loop, then read the framework's source to see what it adds.
- **Embeddings-first retrieval.** Skips the only debuggable baseline.
- **Reading the parked list for interest.** If it were interesting now it
  wouldn't be parked. Wait for the trigger.
- **Anki for concepts.** Atomic facts only — tensor shapes, memory formulas,
  API semantics. Concepts go on the blank page.

---

## 10. Session loop

1. Open `README.md`, find the current phase.
2. Build or break. Not read.
3. Anything unexplainable → `CONFUSIONS.md`, dated, tagged with the phase.
4. Commit small, message honest. Never amend.
5. If the wall is hit: mark status `walled`, then read the earned concepts.
6. If both exit lists have entries: mark `closed`, open the next phase.