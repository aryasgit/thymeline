"""SQLite index over the markdown vault. Source of truth is the .md files
in vault/entries; this DB is a queryable mirror that gets rebuilt from
files if missing or stale."""

from __future__ import annotations
import sqlite3
import json
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Optional

SCHEMA = """
CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    device TEXT,
    is_owner INTEGER NOT NULL DEFAULT 0,
    joined_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    device TEXT,
    created_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
    token TEXT PRIMARY KEY,
    created_by TEXT NOT NULL REFERENCES members(id),
    created_at TEXT NOT NULL,
    used_at TEXT,
    used_by TEXT REFERENCES members(id)
);

CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT,
    body TEXT NOT NULL DEFAULT '',
    author_id TEXT NOT NULL REFERENCES members(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    file_path TEXT NOT NULL,
    assets TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(type);
CREATE INDEX IF NOT EXISTS idx_entries_author ON entries(author_id);

CREATE TABLE IF NOT EXISTS tags (
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (entry_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


class DB:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.conn() as c:
            c.executescript(SCHEMA)

    @contextmanager
    def conn(self) -> Iterator[sqlite3.Connection]:
        c = sqlite3.connect(self.path, isolation_level=None)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys = ON")
        try:
            yield c
        finally:
            c.close()

    def get_meta(self, key: str) -> Optional[str]:
        with self.conn() as c:
            r = c.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
            return r["value"] if r else None

    def set_meta(self, key: str, value: str) -> None:
        with self.conn() as c:
            c.execute(
                "INSERT INTO meta(key,value) VALUES(?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, value),
            )

    def upsert_entry(self, e: dict) -> None:
        with self.conn() as c:
            c.execute(
                """INSERT INTO entries
                   (id,type,title,body,author_id,created_at,updated_at,file_path,assets)
                   VALUES(?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET
                     type=excluded.type, title=excluded.title, body=excluded.body,
                     updated_at=excluded.updated_at, file_path=excluded.file_path,
                     assets=excluded.assets""",
                (
                    e["id"], e["type"], e.get("title"), e.get("body", ""),
                    e["author_id"], e["created_at"], e["updated_at"],
                    e["file_path"], json.dumps(e.get("assets", [])),
                ),
            )
            c.execute("DELETE FROM tags WHERE entry_id=?", (e["id"],))
            for t in e.get("tags") or []:
                c.execute(
                    "INSERT OR IGNORE INTO tags(entry_id,tag) VALUES(?,?)",
                    (e["id"], t),
                )

    def delete_entry(self, entry_id: str) -> None:
        with self.conn() as c:
            c.execute("DELETE FROM entries WHERE id=?", (entry_id,))

    def list_entries(
        self,
        limit: int = 100,
        before: Optional[str] = None,
        type_: Optional[str] = None,
        tag: Optional[str] = None,
        author: Optional[str] = None,
        q: Optional[str] = None,
    ) -> list[dict]:
        sql = (
            "SELECT e.*, GROUP_CONCAT(t.tag) AS tag_csv "
            "FROM entries e LEFT JOIN tags t ON t.entry_id = e.id WHERE 1=1"
        )
        args: list = []
        if before:
            sql += " AND e.created_at < ?"
            args.append(before)
        if type_:
            sql += " AND e.type = ?"
            args.append(type_)
        if author:
            sql += " AND e.author_id = ?"
            args.append(author)
        if q:
            sql += " AND (e.title LIKE ? OR e.body LIKE ?)"
            args += [f"%{q}%", f"%{q}%"]
        if tag:
            sql += (
                " AND e.id IN (SELECT entry_id FROM tags WHERE tag = ?)"
            )
            args.append(tag)
        sql += " GROUP BY e.id ORDER BY e.created_at DESC LIMIT ?"
        args.append(limit)
        with self.conn() as c:
            rows = c.execute(sql, args).fetchall()
            return [self._row_to_entry(r) for r in rows]

    def get_entry(self, entry_id: str) -> Optional[dict]:
        with self.conn() as c:
            r = c.execute(
                "SELECT e.*, GROUP_CONCAT(t.tag) AS tag_csv "
                "FROM entries e LEFT JOIN tags t ON t.entry_id = e.id "
                "WHERE e.id = ? GROUP BY e.id",
                (entry_id,),
            ).fetchone()
            return self._row_to_entry(r) if r else None

    @staticmethod
    def _row_to_entry(r: sqlite3.Row) -> dict:
        return {
            "id": r["id"],
            "type": r["type"],
            "title": r["title"],
            "body": r["body"],
            "author_id": r["author_id"],
            "created_at": r["created_at"],
            "updated_at": r["updated_at"],
            "file_path": r["file_path"],
            "assets": json.loads(r["assets"] or "[]"),
            "tags": (r["tag_csv"] or "").split(",") if r["tag_csv"] else [],
        }

    def all_tags(self) -> list[dict]:
        with self.conn() as c:
            rows = c.execute(
                "SELECT tag, COUNT(*) AS n FROM tags "
                "GROUP BY tag ORDER BY n DESC, tag ASC"
            ).fetchall()
            return [{"tag": r["tag"], "count": r["n"]} for r in rows]

    def type_counts(self) -> dict[str, int]:
        with self.conn() as c:
            rows = c.execute(
                "SELECT type, COUNT(*) AS n FROM entries GROUP BY type"
            ).fetchall()
            return {r["type"]: r["n"] for r in rows}

    def member_count(self) -> int:
        with self.conn() as c:
            return c.execute("SELECT COUNT(*) AS n FROM members").fetchone()["n"]

    def total_entries(self) -> int:
        with self.conn() as c:
            return c.execute("SELECT COUNT(*) AS n FROM entries").fetchone()["n"]

    def create_member(self, m: dict) -> None:
        with self.conn() as c:
            c.execute(
                "INSERT INTO members(id,name,color,device,is_owner,joined_at) "
                "VALUES(?,?,?,?,?,?)",
                (m["id"], m["name"], m["color"], m.get("device"),
                 1 if m.get("is_owner") else 0, m["joined_at"]),
            )

    def list_members(self) -> list[dict]:
        with self.conn() as c:
            rows = c.execute(
                "SELECT m.*, COUNT(e.id) AS entry_count "
                "FROM members m LEFT JOIN entries e ON e.author_id = m.id "
                "GROUP BY m.id ORDER BY m.is_owner DESC, m.joined_at ASC"
            ).fetchall()
            return [
                {
                    "id": r["id"], "name": r["name"], "color": r["color"],
                    "device": r["device"], "is_owner": bool(r["is_owner"]),
                    "joined_at": r["joined_at"],
                    "entry_count": r["entry_count"],
                }
                for r in rows
            ]

    def get_member(self, member_id: str) -> Optional[dict]:
        with self.conn() as c:
            r = c.execute("SELECT * FROM members WHERE id=?", (member_id,)).fetchone()
            if not r:
                return None
            return {
                "id": r["id"], "name": r["name"], "color": r["color"],
                "device": r["device"], "is_owner": bool(r["is_owner"]),
                "joined_at": r["joined_at"],
            }

    def create_session(self, token: str, member_id: str, device: str, now: str) -> None:
        with self.conn() as c:
            c.execute(
                "INSERT INTO sessions(token,member_id,device,created_at,last_seen) "
                "VALUES(?,?,?,?,?)",
                (token, member_id, device, now, now),
            )

    def touch_session(self, token: str, now: str) -> Optional[dict]:
        with self.conn() as c:
            r = c.execute(
                "SELECT s.token,s.member_id,m.name,m.color,m.is_owner "
                "FROM sessions s JOIN members m ON m.id = s.member_id "
                "WHERE s.token=?",
                (token,),
            ).fetchone()
            if not r:
                return None
            c.execute(
                "UPDATE sessions SET last_seen=? WHERE token=?", (now, token)
            )
            return {
                "token": r["token"], "id": r["member_id"], "name": r["name"],
                "color": r["color"], "is_owner": bool(r["is_owner"]),
            }

    def create_invite(self, token: str, created_by: str, now: str) -> None:
        with self.conn() as c:
            c.execute(
                "INSERT INTO invites(token,created_by,created_at) VALUES(?,?,?)",
                (token, created_by, now),
            )

    def consume_invite(self, token: str, used_by: str, now: str) -> bool:
        with self.conn() as c:
            r = c.execute(
                "SELECT used_at FROM invites WHERE token=?", (token,)
            ).fetchone()
            if not r or r["used_at"]:
                return False
            c.execute(
                "UPDATE invites SET used_at=?, used_by=? WHERE token=?",
                (now, used_by, token),
            )
            return True
