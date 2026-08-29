# ai-lab tracker — product truth

*Written from the build history of this repo and the author's stated intent. Assumptions are labelled.*

## What it is

A local instrument for running the learning system in `spec.md`. Not a course, not a
note app: a workbench that holds the discipline the spec describes, and refuses the
shortcuts the spec warns about.

## Who uses it

One person. A senior backend engineer moving into AI engineering, working in Arabic and
English, who lives in a terminal and an editor all day. There is no second user, no
onboarding funnel, no account. *(Assumption: single-user stays true; nothing in the code
anticipates sharing.)*

## The scene of use

At a desk, on a large display, alongside a terminal and an editor. Short visits, several
times a day: start a session, tick a concept, log a confusion, attach a trace. One long
visit occasionally, to plan the path in graph view. Dark room, dark tooling either side of
it. Offline-capable by construction: a stdlib Python server, a SQLite file, no CDN.

## What it holds

- **Roadmaps** (2) contain **tracks** (13) contain **concepts** (140).
- A concept is light by default: a name, planned hours, a practical checkpoint.
- A concept becomes a *unit* when it carries real work: build, verify, break-on-purpose
  with traces, wall, earned concepts, two exit lists, and its own confusions, notes,
  sources and documents.
- Around them: a one-hour session timer, a prerequisite graph that sets order and gating,
  an append-only confusion queue, and a parked registry of topics waiting for a trigger.

## What success looks like

The user opens it, sees what to do next without reading, starts the timer, and closes the
tab. The tool disappears into the work. Second: the rules survive contact with a tired
evening, because the app enforces them rather than reminding.

## What must not change

- Data and API contracts: `data-action` names, the SQLite schema, `/api/*`.
- The spec's rules: no close without both exit lists, sources need their one line, dry
  work flagged past 90 minutes, confusions append-only, gating by real prerequisites.
- Keyboard flow: enter submits, escape cancels, the timer survives reload.
- Offline: no runtime network dependency.
