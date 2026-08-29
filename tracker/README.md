# learning tracker

A local webapp for tracking progress against `spec.md`. Plain HTML + JavaScript,
no build step, no npm. Storage is a real SQLite file: `tracker/learning-tracker.db`, and
uploaded documents land in `tracker/files/`.

## Run

```bash
python3 tracker/server.py                  # serves the app and opens the browser
python3 tracker/server.py --port 9000 --db ~/learning-tracker.db --no-open
```

Stdlib only — nothing to install. First run seeds concepts 01–05 and the parked
registry from `seed.json` (transcribed from `spec.md` §4 and §6). It seeds only
when the table is empty, so restarting never touches your work.

```bash
sqlite3 tracker/learning-tracker.db "SELECT num, status, last_touched FROM concepts ORDER BY pos;"
```

## Look

The visual system lives in `../DESIGN.md`: a dark instrument, warm near-black neutrals,
hairlines instead of cards, and one ochre accent that means "now" and nothing else. Sans
carries prose, mono carries data. Icons are an authored SVG set at one weight (`icons.js`),
not emoji. Browser surfaces are themed too: selection, caret, scrollbars, focus ring, and
tabular numerals so counters do not jitter.

## Two tabs

**dashboard** — a "current concept + what to do next" banner, then two columns:
a sticky **progress rail** on the left (one compact row per concept — status,
gate, wall, breaks bar, exit counts, last touched; click to jump) and the
concepts themselves on the right. Expanding a concept gives
the whole unit: gate, build, verify, break-on-purpose (each failure with an
inline trace editor), wall, earned concepts, the two exit lists, and then its
own **confusions**, **notes**, **sources and links**, and **documents**. Drag a concept by
its handle to reorder.

Everything that is not a concept — sessions, the interest queue (every open
confusion across concepts, click one to jump to it), and the parked registry —
lives in the **side panel**: `☰ side panel` in the header, `esc` to close. The
badge counts open confusions so the queue still nags without taking up room.

Sections collapse and remember their state. `⏎` submits every add-field, `esc`
cancels an inline editor, `⌘⏎` saves a note.

## Roadmaps, tracks, concepts

```
roadmap   AI Engineer Practical Roadmap     several can coexist
└─ track  5. Inference & GPU Engineering    grouping inside a roadmap
   └─ concept  I3 KV cache mechanics        the leaf you tick or build
```

A concept starts light: a title, its planned hours and a practical checkpoint,
ticked when you can explain it and did the checkpoint. Opening one shows the
checkpoint and an add bar, nothing else. Blocks appear when they hold something
or when you ask for them, so an empty concept is never ten empty forms. The add
bar is a toggle: a block you opened by mistake and left empty can be put away
again, while one holding content stays. When a concept is one you
actually **build**, open it and fill in build / verify / break-on-purpose / wall
/ exit — it then carries sessions, confusions, notes, sources and documents, and
the spec's rules kick in (no closing without both exit lists). Most concepts stay
a checkbox forever; that is the "earned, not scheduled" rule expressed in data.

The left rail is the roadmap tree; picking a track swaps the concepts column. Deleting a
roadmap (the x on its header) asks first, naming how many tracks and concepts go with it,
then writes a full JSON snapshot to `tracker/trash/` and removes them in one transaction
along with their breaks, claims, sources, documents (files included), edges, confusions and
sessions. The snapshot is the undo: it holds every row that was deleted. A note tagged to a surviving concept in
another roadmap keeps living: it only loses the tag.
`spec.md`'s units live in their own roadmap, separate from anything imported.

The concepts section has a **list / graph** toggle. In graph view the selected
track's concepts are draggable nodes in a vertical path; drag from a node's bottom dot down onto
another to say *this one comes first*. Those edges are not decoration:

- concept order is a topological sort of the graph (ties break on current
  position, so one edge moves only what it constrains);
- gating switches from "the one above it in the list" to each concept's real
  prerequisites, named in the `gated · concept 04` pill;
- cycles are refused when drawn, and never silently reordered.

Click an edge to delete it, double-click a node to open it, `tidy layout` puts
everything back in one column.

**sql** — a console over the database with canned queries, plus backup and
restore. Writes are allowed.
`concepts` is a view over the `phases` table, which is what the storage still
calls them; both names work in queries.

## Session timer

`▶ start` on a concept runs a one-hour session: a live countdown in the header
and on the card, a progress bar, and a note field. Stopping — or letting the
hour run out — writes the session automatically with the elapsed minutes, the
note, and the concept. Starting a session moves a `not started` concept to
`building`. The timer survives a page reload, and only one runs at a time.

The `build / break / read / dry` control in the sessions panel sets what the
next session is logged as. There is no manual entry — a session exists only if
the timer recorded it.

## Notes and documents

A note is a claim, not a summary: the title states it, the body defends it. The
editor is a title and a body, nothing else; a new note is filed against the
concept you wrote it in. Notes can still belong to several concepts in the data
(they show a tag for each of the others, and editing preserves them), but the
picker is gone from the editor.

Documents attach per concept by drag-and-drop or file picker (50 MB each),
stored under `tracker/files/` and referenced from the database. §1.7 keeps PDFs
out of the repo, so `tracker/.gitignore` excludes that folder and the `.db`.

## Rules the app enforces

- A concept cannot be set `closed` unless **both** exit lists have entries (§3).
- Adding a gap to "still can't explain" also files it as a confusion (§3).
- A concept whose predecessor is not closed is flagged `gated`; moving it off
  `not started` asks for confirmation.
- A source with no "what it changed" line is rejected (§1.7).
- Dry sessions over 90 minutes are flagged (§1.5).
- Confusions are append-only — resolving strikes through and records where the
  answer went; nothing is deleted.

## Backup

Both live in the **sql** tab. `backup` downloads every table as JSON; `restore`
replaces the database from one. Uploaded files are not inside the JSON — copy
`tracker/files/` yourself.

## Tests

`test-ui.mjs` runs `app.js` against a minimal DOM shim and a real server,
covering the interaction paths. It writes data and uploads files, so point it at
a throwaway database:

```bash
python3 tracker/server.py --port 8788 --db /tmp/tracker-test.db --no-open &
node tracker/test-ui.mjs
```

## Files

| file | what it is |
|---|---|
| `server.py` | static server + `/api/sql`, `/api/export`, `/api/restore`, `/api/upload` |
| `api.js` | client for that API |
| `app.js` | dashboard + sql views, timer, drag-reorder, all actions |
| `seed.json` | concepts and parked registry from `spec.md` |
| `test-ui.mjs` | UI regression test |
| `learning-tracker.db`, `files/` | your data |
