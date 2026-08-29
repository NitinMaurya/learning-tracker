#!/usr/bin/env python3
"""learning tracker - static file server + SQLite JSON API.

Zero dependencies (stdlib only). The database is a real file next to this
script: tracker/learning-tracker.db. Open it with sqlite3 any time.

    python3 server.py [--port 8777] [--db learning-tracker.db]
"""

import argparse
import base64
import datetime
import json
import os
import re
import uuid
import sqlite3
import sys
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))

TABLES = ["phases", "breaks", "claims", "confusions", "parked", "sources", "sessions",
          "notes", "docs", "edges", "roadmaps", "tracks"]

FILES = os.path.join(HERE, "files")   # uploaded documents live here
TRASH = os.path.join(HERE, "trash")   # snapshots taken before a destructive delete

# Any OpenAI-compatible chat endpoint: OpenAI, Groq, Together, OpenRouter, a local
# vLLM or llama.cpp server. Anthropic's /v1/messages shape is handled too.
# Configure with env vars or tracker/llm.json (gitignored). Keys are never sent to
# the browser and never logged.
MAX_MARKDOWN = 400_000
CHUNK = 24_000


def llm_config():
    cfg = {"base": "https://api.openai.com/v1", "model": "gpt-4o-mini", "key": None}
    path = os.path.join(HERE, "llm.json")
    if os.path.exists(path):
        with open(path) as f:
            cfg.update({k: v for k, v in json.load(f).items() if k in cfg})
    cfg["base"] = os.environ.get("LT_LLM_BASE", cfg["base"]).rstrip("/")
    cfg["model"] = os.environ.get("LT_LLM_MODEL", cfg["model"])
    cfg["key"] = (os.environ.get("LT_LLM_KEY") or os.environ.get("OPENAI_API_KEY")
                  or os.environ.get("ANTHROPIC_API_KEY") or cfg["key"])
    return cfg


def llm_json(system, user):
    """One call, JSON back. Raises RuntimeError with something a human can act on."""
    stub = os.environ.get("LT_LLM_STUB")           # tests run without a provider
    if stub:
        with open(stub) as f:
            return json.load(f)

    cfg = llm_config()
    if not cfg["key"]:
        raise RuntimeError("No API key. Set LT_LLM_KEY (or OPENAI_API_KEY) and restart the server.")

    anthropic = "anthropic" in cfg["base"]
    if anthropic:
        url = cfg["base"] + "/messages"
        headers = {"x-api-key": cfg["key"], "anthropic-version": "2023-06-01",
                   "content-type": "application/json"}
        body = {"model": cfg["model"], "max_tokens": 8000, "system": system,
                "messages": [{"role": "user", "content": user}]}
    else:
        url = cfg["base"] + "/chat/completions"
        headers = {"Authorization": "Bearer " + cfg["key"], "content-type": "application/json"}
        body = {"model": cfg["model"], "temperature": 0,
                "response_format": {"type": "json_object"},
                "messages": [{"role": "system", "content": system},
                             {"role": "user", "content": user}]}

    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            payload = json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError("%s said %s: %s" % (cfg["base"], e.code, e.read().decode()[:300]))
    except Exception as e:
        raise RuntimeError("could not reach %s: %s" % (cfg["base"], e))

    text = (payload["content"][0]["text"] if anthropic
            else payload["choices"][0]["message"]["content"]).strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-z]*\n|\n```$", "", text)
    try:
        return json.loads(text)
    except ValueError:
        raise RuntimeError("the model did not return JSON: %s" % text[:200])


IMPORT_SYSTEM = """You convert a learning roadmap written in Markdown into structured JSON.

Return ONLY a JSON object of this shape:
{"name": "<roadmap name>",
 "tracks": [{"title": "<track title>",
             "concepts": [{"code": "<short id like F1 or 1.2, from the document if it has one>",
                           "name": "<concept name, under 90 characters>",
                           "hours": <number or null>,
                           "practical": "<the practical checkpoint or exercise, or null>"}]}]}

Rules:
- Use the document's own words. Do not invent concepts, hours or checkpoints.
- A track is a top level grouping (a section, module, phase or part). A concept is
  one learnable item inside it.
- If the document has no codes, number them within the track: 1, 2, 3.
- If a concept has no stated hours or checkpoint, use null. Never guess a number.
- No commentary, no markdown fences, JSON only."""


def parse_markdown(md, name_hint=None):
    """Split on top level headings so a long document still fits, then merge."""
    md = md[:MAX_MARKDOWN]
    parts, current = [], ""
    for line in md.splitlines(keepends=True):
        if line.startswith("## ") and len(current) > CHUNK:
            parts.append(current)
            current = line
        else:
            current += line
    parts.append(current)

    # the document names itself; the filename is only a fallback
    name, tracks = None, []
    for i, part in enumerate(parts):
        got = llm_json(IMPORT_SYSTEM, "Document part %d of %d:\n\n%s" % (i + 1, len(parts), part))
        name = name or (got.get("name") or "").strip() or None
        for t in got.get("tracks") or []:
            title = (t.get("title") or "untitled").strip()
            match = next((x for x in tracks if x["title"].lower() == title.lower()), None)
            if match:
                match["concepts"].extend(t.get("concepts") or [])
            else:
                tracks.append({"title": title, "concepts": t.get("concepts") or []})
    return {"name": name or name_hint or "imported roadmap", "tracks": tracks}


def clean_proposal(p):
    """Never trust the model with the database: shape, types and limits, all checked."""
    if not isinstance(p, dict):
        raise ValueError("expected an object")
    name = str(p.get("name") or "imported roadmap").strip()[:120]
    tracks, total, seen = [], 0, set()
    for t in (p.get("tracks") or [])[:60]:
        if not isinstance(t, dict):
            continue
        concepts = []
        for c in (t.get("concepts") or [])[:300]:
            if not isinstance(c, dict) or not str(c.get("name") or "").strip():
                continue
            if total >= 600:
                break
            code = str(c.get("code") or "").strip()[:12] or str(len(concepts) + 1)
            while code.lower() in seen:
                code += "'"
            seen.add(code.lower())
            hours = c.get("hours")
            hours = float(hours) if isinstance(hours, (int, float)) and 0 < float(hours) < 1000 else None
            practical = str(c.get("practical")).strip()[:600] if c.get("practical") else None
            concepts.append({"code": code, "name": str(c["name"]).strip()[:200],
                             "hours": hours, "practical": practical})
            total += 1
        if concepts:
            tracks.append({"title": str(t.get("title") or "untitled").strip()[:160], "concepts": concepts})
    if not tracks:
        raise ValueError("no concepts found in that file")
    return {"name": name, "tracks": tracks, "concepts": total,
            "hours": round(sum(c["hours"] or 0 for t in tracks for c in t["concepts"]), 1)}
def _hours(v):
    """2.0 reads as 2, 1.5 stays 1.5."""
    f = float(v)
    return str(int(f)) if f == int(f) else ("%g" % f)


def _indent(text, pad):
    return "\n".join(pad + line if line.strip() else "" for line in str(text).splitlines())


def export_filename(name):
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", (name or "roadmap")).strip("-")[:60]
    safe = re.sub(r"\.(md|markdown)$", "", safe, flags=re.I)
    return (safe or "roadmap") + ".md"


def roadmap_markdown(con, roadmap):
    """The mirror of the importer: one document that reads back as this roadmap.

    Structure is exactly what IMPORT_SYSTEM expects to find - a title, a heading
    per track, a bullet per concept carrying code, name, hours and checkpoint.
    Everything the user wrote themselves (notes, confusions, sources, documents)
    rides along as indented sub-bullets so an export loses nothing. A concept
    with nothing extra stays one line.
    """
    out = ["# %s" % (roadmap["name"] or "roadmap"), ""]
    tracks = con.execute(
        "SELECT * FROM tracks WHERE roadmap_id = ? ORDER BY pos", (roadmap["id"],)).fetchall()
    notes = con.execute("SELECT * FROM notes ORDER BY created_at").fetchall()

    for t in tracks:
        head = ("%s. %s" % (t["num"], t["title"])) if (t["num"] or "").strip() else (t["title"] or "untitled")
        out.append("## %s" % head)
        out.append("")
        concepts = con.execute(
            "SELECT * FROM phases WHERE track_id = ? ORDER BY pos", (t["id"],)).fetchall()
        for c in concepts:
            box = "[x]" if c["status"] == "closed" else "[ ]"
            line = "- %s `%s` %s" % (box, c["num"] or "", c["name"] or "")
            if c["hours"]:
                line += " (%sh)" % _hours(c["hours"])
            if (c["practical"] or "").strip():
                line += " - %s" % c["practical"].strip()
            out.append(line)

            for n in notes:
                if c["id"] not in [x for x in (n["phase_ids"] or "").split(",") if x]:
                    continue
                out.append("  - note: %s" % (n["title"] or "untitled"))
                if (n["body"] or "").strip():
                    out.append(_indent(n["body"].strip(), "    "))
            for cf in con.execute(
                    "SELECT * FROM confusions WHERE phase_num = ? ORDER BY created_at", (c["num"],)):
                if cf["resolved"]:
                    out.append("  - confusion (resolved): %s -> %s"
                               % (cf["text"], cf["resolution"] or "resolved"))
                else:
                    out.append("  - confusion: %s" % cf["text"])
            for s in con.execute(
                    "SELECT * FROM sources WHERE phase_id = ? ORDER BY created_at", (c["id"],)):
                out.append("  - source: %s%s" % (s["url"], (" - %s" % s["changed"]) if s["changed"] else ""))
            for d in con.execute(
                    "SELECT * FROM docs WHERE phase_id = ? ORDER BY created_at", (c["id"],)):
                out.append("  - document: %s" % d["filename"])
        out.append("")

    return "\n".join(out).rstrip("\n") + "\n"


MAX_UPLOAD = 50 * 1024 * 1024

SCHEMA = """
CREATE TABLE IF NOT EXISTS phases (
  id TEXT PRIMARY KEY, num TEXT, name TEXT, status TEXT,
  gate TEXT, build TEXT, verify_txt TEXT, wall TEXT, earned TEXT,
  pos INTEGER, last_touched TEXT
);
CREATE TABLE IF NOT EXISTS breaks (
  id TEXT PRIMARY KEY, phase_id TEXT, label TEXT, done INTEGER DEFAULT 0,
  pos INTEGER, trace TEXT
);
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY, phase_id TEXT, kind TEXT, text TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS confusions (
  id TEXT PRIMARY KEY, text TEXT, phase_num TEXT, created_at TEXT,
  resolved INTEGER DEFAULT 0, resolution TEXT
);
CREATE TABLE IF NOT EXISTS parked (
  id TEXT PRIMARY KEY, topic TEXT, trigger_text TEXT, fired INTEGER DEFAULT 0, fired_at TEXT
);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY, url TEXT, changed TEXT, created_at TEXT, phase_id TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, on_date TEXT, phase_num TEXT, kind TEXT,
  minutes INTEGER, note TEXT
);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, title TEXT, body TEXT, phase_ids TEXT,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY, phase_id TEXT, filename TEXT, stored TEXT,
  size INTEGER, mime TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS roadmaps (
  id TEXT PRIMARY KEY, name TEXT, note TEXT, pos INTEGER
);
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY, roadmap_id TEXT, num TEXT, title TEXT, pos INTEGER
);
CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY, from_id TEXT, to_id TEXT
);
-- the UI calls these concepts; the storage still calls them phases
CREATE VIEW IF NOT EXISTS concepts AS SELECT * FROM phases;
"""

DEFAULT_DB = os.path.join(HERE, "learning-tracker.db")
LEGACY_DB = os.path.join(HERE, "ai-lab.db")
DB_PATH = DEFAULT_DB


def connect():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    return con


def uid(prefix, n):
    return "%s-%03d" % (prefix, n)


def migrate(con):
    """Additive column migrations for databases created by earlier versions."""
    for table, column, ddl in [("sources", "phase_id", "TEXT"),
                               ("phases", "x", "REAL"),
                               ("phases", "y", "REAL"),
                               ("phases", "track_id", "TEXT"),
                               ("phases", "hours", "REAL"),
                               ("phases", "practical", "TEXT")]:
        cols = [r[1] for r in con.execute("PRAGMA table_info(%s)" % table)]
        if column not in cols:
            con.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, column, ddl))
            print("migrated: %s.%s added" % (table, column))
    con.commit()


def init_db():
    con = connect()
    con.executescript(SCHEMA)
    con.commit()
    migrate(con)
    if con.execute("SELECT count(*) FROM phases").fetchone()[0] == 0:
        seed(con)
    con.close()


def seed(con):
    """First run only: load the phases from spec.md."""
    with open(os.path.join(HERE, "seed.json")) as f:
        data = json.load(f)
    con.execute("INSERT INTO roadmaps VALUES ('rm-spec','spec.md',"
                "'The build units. Every one starts with a build and closes on a blank page.',0)")
    con.execute("INSERT INTO tracks VALUES ('tr-spec','rm-spec','','core build path',0)")
    for pos, p in enumerate(data["phases"]):
        pid = uid("phase", pos)
        con.execute(
            "INSERT INTO phases (id, num, name, status, gate, build, verify_txt, wall,"
            " earned, pos, last_touched, track_id) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,'tr-spec')",
            (pid, p["num"], p["name"], "not started", p["gate"], p["build"],
             p["verify"], p["wall"], p["earned"], pos),
        )
        for bp, b in enumerate(p["breaks"]):
            con.execute(
                "INSERT INTO breaks VALUES (?,?,?,0,?,NULL)",
                ("%s-b%d" % (pid, bp), pid, b, bp),
            )
    con.commit()
    print("seeded %s from seed.json" % DB_PATH)


class Handler(SimpleHTTPRequestHandler):
    # keep-alive: the dashboard fires several queries per render
    protocol_version = "HTTP/1.1"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=HERE, **kw)

    def log_message(self, fmt, *args):  # quiet
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        return self._payload

    def do_GET(self):
        if self.path.split("?")[0] == "/api/export-roadmap":
            return self._export_roadmap()
        if self.path == "/api/export":
            con = connect()
            out = {t: [dict(r) for r in con.execute("SELECT * FROM %s" % t)] for t in TABLES}
            con.close()
            return self._json(out)
        return super().do_GET()

    def do_POST(self):
        # Always drain the request body, whatever the path: on a keep-alive
        # connection an unread body is parsed as the next request line.
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            self._payload = json.loads(raw or b"{}")
        except ValueError:
            self._payload = {}
        try:
            if self.path == "/api/sql":
                return self._sql()
            if self.path == "/api/restore":
                return self._restore()
            if self.path == "/api/upload":
                return self._upload()
            if self.path == "/api/delete-doc":
                return self._delete_doc()
            if self.path == "/api/reset":
                return self._reset()
            if self.path == "/api/delete-roadmap":
                return self._delete_roadmap()
            if self.path == "/api/import-parse":
                return self._import_parse()
            if self.path == "/api/import-commit":
                return self._import_commit()
        except Exception as e:  # surface SQL errors to the console tab
            return self._json({"error": "%s: %s" % (type(e).__name__, e)}, 400)
        self.send_error(404)

    def _sql(self):
        body = self._body()
        sql = body.get("sql", "")
        params = body.get("params", [])
        con = connect()
        try:
            cur = con.execute(sql, params)
            rows = [dict(r) for r in cur.fetchall()]
            con.commit()
            return self._json({"rows": rows, "changes": cur.rowcount})
        finally:
            con.close()

    def _upload(self):
        """{phase_id, name, mime, data(base64)} -> writes files/<id>-<name>."""
        body = self._body()
        raw = base64.b64decode(body.get("data", ""))
        if len(raw) > MAX_UPLOAD:
            return self._json({"error": "file larger than %d MB" % (MAX_UPLOAD // 1048576)}, 400)

        name = os.path.basename(body.get("name") or "file")
        name = re.sub(r"[^A-Za-z0-9._\- ]", "_", name)[:120] or "file"
        doc_id = uuid.uuid4().hex[:12]
        stored = "%s-%s" % (doc_id, name)

        os.makedirs(FILES, exist_ok=True)
        with open(os.path.join(FILES, stored), "wb") as f:
            f.write(raw)

        row = (doc_id, body.get("phase_id"), name, stored, len(raw),
               body.get("mime") or "application/octet-stream",
               datetime.datetime.now().isoformat(timespec="seconds"))
        con = connect()
        con.execute("INSERT INTO docs VALUES (?,?,?,?,?,?,?)", row)
        con.commit()
        con.close()
        return self._json({"ok": True, "id": doc_id, "stored": stored, "size": len(raw)})

    def _delete_doc(self):
        doc_id = self._body().get("id")
        con = connect()
        row = con.execute("SELECT stored FROM docs WHERE id = ?", (doc_id,)).fetchone()
        if row:
            path = os.path.join(FILES, row["stored"])
            if os.path.commonpath([os.path.abspath(path), FILES]) == FILES and os.path.exists(path):
                os.remove(path)
            con.execute("DELETE FROM docs WHERE id = ?", (doc_id,))
            con.commit()
        con.close()
        return self._json({"ok": True})

    def _delete_roadmap(self):
        """Remove a roadmap and everything under it, in one transaction.

        Notes can be tagged across roadmaps: those lose the tag and survive if any
        other concept still holds them. Confusions and sessions key on the concept
        number, so they are only removed when no surviving concept shares it.
        """
        rid = self._body().get("id")
        con = connect()
        try:
            snapshot = self._snapshot_roadmap(con, rid)
            tracks = [r["id"] for r in con.execute("SELECT id FROM tracks WHERE roadmap_id = ?", (rid,))]
            concepts, nums = [], []
            if tracks:
                rows = con.execute(
                    "SELECT id, num FROM phases WHERE track_id IN (%s)" % ",".join("?" * len(tracks)),
                    tracks,
                ).fetchall()
                concepts = [r["id"] for r in rows]
                nums = [r["num"] for r in rows]

            files = 0
            if concepts:
                cq = ",".join("?" * len(concepts))
                for r in con.execute("SELECT stored FROM docs WHERE phase_id IN (%s)" % cq, concepts):
                    path = os.path.abspath(os.path.join(FILES, r["stored"]))
                    if os.path.commonpath([path, FILES]) == FILES and os.path.exists(path):
                        os.remove(path)
                        files += 1

                for table in ("docs", "breaks", "claims", "sources"):
                    con.execute("DELETE FROM %s WHERE phase_id IN (%s)" % (table, cq), concepts)
                con.execute("DELETE FROM edges WHERE from_id IN (%s) OR to_id IN (%s)" % (cq, cq),
                            concepts + concepts)

                doomed = set(concepts)
                for n in con.execute("SELECT id, phase_ids FROM notes").fetchall():
                    tags = [t for t in (n["phase_ids"] or "").split(",") if t]
                    kept = [t for t in tags if t not in doomed]
                    if len(kept) == len(tags):
                        continue
                    if kept:
                        con.execute("UPDATE notes SET phase_ids = ? WHERE id = ?", (",".join(kept), n["id"]))
                    else:
                        con.execute("DELETE FROM notes WHERE id = ?", (n["id"],))

                con.execute("DELETE FROM phases WHERE id IN (%s)" % cq, concepts)

                survivors = {r[0] for r in con.execute("SELECT DISTINCT num FROM phases")}
                orphaned = sorted(set(nums) - survivors)
                if orphaned:
                    nq = ",".join("?" * len(orphaned))
                    con.execute("DELETE FROM confusions WHERE phase_num IN (%s)" % nq, orphaned)
                    con.execute("DELETE FROM sessions WHERE phase_num IN (%s)" % nq, orphaned)

            con.execute("DELETE FROM tracks WHERE roadmap_id = ?", (rid,))
            con.execute("DELETE FROM roadmaps WHERE id = ?", (rid,))
            con.commit()
        finally:
            con.close()
        return self._json({"ok": True, "tracks": len(tracks), "concepts": len(concepts),
                           "files": files, "snapshot": os.path.basename(snapshot)})

    def _export_roadmap(self):
        """GET /api/export-roadmap?id=<roadmap_id> -> the roadmap as a .md download."""
        rid = (urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("id") or [""])[0]
        con = connect()
        try:
            row = con.execute("SELECT * FROM roadmaps WHERE id = ?", (rid,)).fetchone()
            if not row:
                return self._json({"error": "no roadmap with id %r" % rid}, 404)
            md = roadmap_markdown(con, row)
        finally:
            con.close()

        body = md.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/markdown; charset=utf-8")
        self.send_header("Content-Disposition",
                         'attachment; filename="%s"' % export_filename(row["name"]))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _import_parse(self):
        body = self._body()
        md = body.get("markdown") or ""
        if not md.strip():
            return self._json({"error": "that file is empty"}, 400)
        try:
            proposal = clean_proposal(parse_markdown(md, (body.get("name") or "").strip() or None))
        except (RuntimeError, ValueError) as e:
            return self._json({"error": str(e)}, 400)
        return self._json({"ok": True, "proposal": proposal, "model": llm_config()["model"]})

    def _import_commit(self):
        try:
            p = clean_proposal(self._body().get("proposal"))
        except ValueError as e:
            return self._json({"error": str(e)}, 400)

        con = connect()
        try:
            rid = "rm-" + uuid.uuid4().hex[:10]
            pos = (con.execute("SELECT max(pos) FROM roadmaps").fetchone()[0] or -1) + 1
            con.execute("INSERT INTO roadmaps VALUES (?,?,?,?)",
                        (rid, p["name"], "imported %s" % datetime.date.today().isoformat(), pos))
            for ti, t in enumerate(p["tracks"]):
                tid = "tr-" + uuid.uuid4().hex[:10]
                con.execute("INSERT INTO tracks VALUES (?,?,?,?,?)", (tid, rid, str(ti + 1), t["title"], ti))
                for ci, c in enumerate(t["concepts"]):
                    con.execute(
                        "INSERT INTO phases (id,num,name,status,gate,pos,"
                        "last_touched,track_id,hours,practical) VALUES (?,?,?,'not started','',?,NULL,?,?,?)",
                        ("k-" + uuid.uuid4().hex[:10], c["code"], c["name"], ci, tid, c["hours"], c["practical"]))
            con.commit()
        finally:
            con.close()
        return self._json({"ok": True, "id": rid, "tracks": len(p["tracks"]), "concepts": p["concepts"]})

    def _snapshot_roadmap(self, con, rid):
        """Write everything a roadmap owns to trash/ before deleting it.

        The delete cascade cannot be undone from the app, so it is never the only
        copy: this file is a plain JSON dump that /api/restore-shaped tooling or a
        few INSERTs can put back.
        """
        tracks = [dict(r) for r in con.execute("SELECT * FROM tracks WHERE roadmap_id = ?", (rid,))]
        data = {
            "roadmap": [dict(r) for r in con.execute("SELECT * FROM roadmaps WHERE id = ?", (rid,))],
            "tracks": tracks,
        }
        tids = [t["id"] for t in tracks]
        concepts = []
        if tids:
            concepts = [dict(r) for r in con.execute(
                "SELECT * FROM phases WHERE track_id IN (%s)" % ",".join("?" * len(tids)), tids)]
        data["phases"] = concepts

        cids = [c["id"] for c in concepts]
        nums = [c["num"] for c in concepts]
        if cids:
            cq = ",".join("?" * len(cids))
            for table in ("breaks", "claims", "sources", "docs"):
                data[table] = [dict(r) for r in con.execute(
                    "SELECT * FROM %s WHERE phase_id IN (%s)" % (table, cq), cids)]
            data["edges"] = [dict(r) for r in con.execute(
                "SELECT * FROM edges WHERE from_id IN (%s) OR to_id IN (%s)" % (cq, cq), cids + cids)]
            data["notes"] = [dict(r) for r in con.execute("SELECT * FROM notes")
                             if any(t in cids for t in (r["phase_ids"] or "").split(","))]
        if nums:
            nq = ",".join("?" * len(nums))
            for table in ("confusions", "sessions"):
                data[table] = [dict(r) for r in con.execute(
                    "SELECT * FROM %s WHERE phase_num IN (%s)" % (table, nq), nums)]

        # an append-only record of every destructive call, kept even if the
        # snapshot files are cleaned up
        os.makedirs(TRASH, exist_ok=True)
        with open(os.path.join(TRASH, "deletes.log"), "a") as log:
            log.write("%s  delete-roadmap  id=%s name=%r tracks=%d concepts=%d client=%s\n" % (
                datetime.datetime.now().isoformat(timespec="seconds"), rid,
                (data["roadmap"][0]["name"] if data["roadmap"] else "?"),
                len(tracks), len(concepts), self.headers.get("User-Agent", "?")[:60]))

        name = re.sub(r"[^A-Za-z0-9._-]", "-", (data["roadmap"][0]["name"] if data["roadmap"] else rid))[:60]
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        os.makedirs(TRASH, exist_ok=True)
        path = os.path.join(TRASH, "%s-%s.json" % (stamp, name))
        with open(path, "w") as f:
            json.dump(data, f, indent=1)
        return path

    def _reset(self):
        """Wipe every table and reseed. Used by test-ui.mjs; destructive."""
        con = connect()
        for t in TABLES:
            con.execute("DELETE FROM %s" % t)
        con.commit()
        seed(con)
        con.close()
        return self._json({"ok": True})

    def _restore(self):
        data = self._body()
        con = connect()
        try:
            for t in TABLES:
                con.execute("DELETE FROM %s" % t)
                rows = data.get(t) or []
                if not rows:
                    continue
                cols = list(rows[0].keys())
                con.executemany(
                    "INSERT INTO %s (%s) VALUES (%s)" % (t, ",".join(cols), ",".join("?" * len(cols))),
                    [[r.get(c) for c in cols] for r in rows],
                )
            con.commit()
        finally:
            con.close()
        return self._json({"ok": True})


def main():
    global DB_PATH
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8777)
    ap.add_argument("--db", default=DB_PATH, help="path to the sqlite file")
    ap.add_argument("--no-open", action="store_true")
    args = ap.parse_args()
    DB_PATH = os.path.abspath(args.db)

    # the database was called ai-lab.db before the rename; adopt it in place
    if DB_PATH == DEFAULT_DB and not os.path.exists(DB_PATH) and os.path.exists(LEGACY_DB):
        for suffix in ("", "-wal", "-shm"):
            if os.path.exists(LEGACY_DB + suffix):
                os.rename(LEGACY_DB + suffix, DB_PATH + suffix)
        print("adopted %s as %s" % (os.path.basename(LEGACY_DB), os.path.basename(DB_PATH)))

    init_db()
    url = "http://127.0.0.1:%d/" % args.port
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print("learning tracker\n  db    %s\n  files %s\n  url   %s\nctrl-c to stop" % (DB_PATH, FILES, url))
    if not args.no_open:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
        sys.exit(0)


if __name__ == "__main__":
    main()
