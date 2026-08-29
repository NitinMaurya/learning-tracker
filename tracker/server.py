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
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))

TABLES = ["phases", "breaks", "claims", "confusions", "parked", "sources", "sessions",
          "notes", "docs", "edges", "roadmaps", "tracks"]

FILES = os.path.join(HERE, "files")   # uploaded documents live here
TRASH = os.path.join(HERE, "trash")   # snapshots taken before a destructive delete
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
    """First run only: load the phases and parked registry from spec.md."""
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
    for i, (topic, trigger) in enumerate(data["parked"]):
        con.execute("INSERT INTO parked VALUES (?,?,?,0,NULL)", (uid("parked", i), topic, trigger))
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
