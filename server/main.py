"""Thymeline — localhost timeline for a quadruped robot project.

Run:    uvicorn server.main:app --host 0.0.0.0 --port 8765 --reload
"""

from __future__ import annotations
import os
import json
import socket
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import (
    FastAPI, Request, Response, UploadFile, File, Form, HTTPException, status,
)
from fastapi.responses import (
    HTMLResponse, JSONResponse, FileResponse, RedirectResponse, PlainTextResponse,
)
from .db import DB
from .vault import Vault, now_iso, rebuild_index, extract_inline_tags
from .auth import (
    COOKIE, random_token, current_member, require_member, require_owner,
    create_member_and_session,
)


ROOT = Path(__file__).resolve().parent.parent
VAULT_DIR = Path(os.environ.get("THYMELINE_VAULT", ROOT / "vault"))
WEB_DIR = ROOT / "web"
DB_PATH = VAULT_DIR / ".thymeline.db"
CONFIG_PATH = VAULT_DIR / "project.json"

ENTRY_TYPES = {"progress", "log", "debug", "failure", "record", "idea", "code"}

app = FastAPI(title="Thymeline", docs_url=None, redoc_url=None)


# ---------- bootstrap ----------

def get_config() -> dict:
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {"name": "Untitled project", "created": None}


def write_config(cfg: dict) -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


db = DB(DB_PATH)
vault = Vault(VAULT_DIR)

# Reindex from files if DB looks empty but files exist
if db.total_entries() == 0 and any(VAULT_DIR.joinpath("entries").rglob("*.md")):
    rebuild_index(vault, db)


# ---------- helpers ----------

def device_of(req: Request) -> str:
    ua = req.headers.get("user-agent", "unknown")
    return ua[:120]


def member_public(m: dict, db_: DB) -> dict:
    full = db_.get_member(m["id"]) or m
    return {
        "id": full["id"], "name": full["name"], "color": full["color"],
        "is_owner": bool(full.get("is_owner")),
    }


def enrich_entry(e: dict, members: dict[str, dict]) -> dict:
    out = dict(e)
    a = members.get(e["author_id"])
    out["author"] = {
        "id": e["author_id"],
        "name": a["name"] if a else "unknown",
        "color": a["color"] if a else "#8a8a8a",
    }
    return out


def members_map() -> dict[str, dict]:
    return {m["id"]: m for m in db.list_members()}


# ---------- pages ----------

NO_STORE = {"Cache-Control": "no-store"}


@app.get("/", response_class=HTMLResponse)
def index_page():
    return HTMLResponse(
        (WEB_DIR / "index.html").read_text(encoding="utf-8"), headers=NO_STORE,
    )


@app.get("/join", response_class=HTMLResponse)
def join_page():
    return HTMLResponse(
        (WEB_DIR / "join.html").read_text(encoding="utf-8"), headers=NO_STORE,
    )


# Serve static web files with no-store so browsers always pick up the latest
# JS/CSS during development.
@app.get("/static/{path:path}")
def static_file(path: str):
    target = (WEB_DIR / path).resolve()
    try:
        target.relative_to(WEB_DIR.resolve())
    except ValueError:
        raise HTTPException(404, "not found")
    if not target.exists() or not target.is_file():
        raise HTTPException(404, "not found")
    return FileResponse(target, headers=NO_STORE)


# ---------- bootstrap / auth ----------

@app.get("/api/bootstrap")
def bootstrap_status():
    """Tell the client what state the project is in."""
    cfg = get_config()
    return {
        "project": cfg,
        "owner_set": db.member_count() > 0,
    }


@app.post("/api/bootstrap")
async def bootstrap_owner(req: Request):
    """First-run: set project name + owner. Idempotent guard."""
    if db.member_count() > 0:
        raise HTTPException(status.HTTP_409_CONFLICT, "owner already set")
    body = await req.json()
    name = (body.get("name") or "").strip()
    project = (body.get("project") or "").strip()
    if not name:
        raise HTTPException(400, "name required")
    if not project:
        project = "Quadruped V2"
    write_config({"name": project, "created": now_iso()})
    member, token = create_member_and_session(db, name, device_of(req), is_owner=True)
    resp = JSONResponse({"member": member_public(member, db), "project": get_config()})
    resp.set_cookie(
        COOKIE, token, max_age=60 * 60 * 24 * 365, httponly=True,
        samesite="lax", path="/",
    )
    return resp


@app.get("/api/me")
def me(req: Request):
    m = current_member(req, db)
    if not m:
        return {"member": None, "project": get_config(), "owner_set": db.member_count() > 0}
    full = db.get_member(m["id"])
    return {"member": member_public(full, db), "project": get_config(), "owner_set": True}


@app.post("/api/invite")
def create_invite(req: Request):
    owner = require_owner(req, db)
    token = random_token(16)
    db.create_invite(token, owner["id"], now_iso())
    host = req.headers.get("host", "localhost")
    scheme = req.headers.get("x-forwarded-proto", req.url.scheme or "http")
    url = f"{scheme}://{host}/join?t={token}"
    return {"token": token, "url": url}


@app.get("/api/invite/{token}")
def invite_info(token: str):
    """Lookup invite to render the join page. Doesn't consume."""
    with db.conn() as c:
        r = c.execute(
            "SELECT i.token,i.used_at,m.name AS created_by_name "
            "FROM invites i JOIN members m ON m.id = i.created_by "
            "WHERE i.token=?",
            (token,),
        ).fetchone()
    if not r:
        raise HTTPException(404, "invite not found")
    return {
        "token": r["token"],
        "used": bool(r["used_at"]),
        "invited_by": r["created_by_name"],
        "project": get_config(),
    }


@app.post("/api/join")
async def join_with_invite(req: Request):
    body = await req.json()
    token = (body.get("token") or "").strip()
    name = (body.get("name") or "").strip()
    if not token or not name:
        raise HTTPException(400, "token and name required")
    member, session_token = create_member_and_session(
        db, name, device_of(req), is_owner=False
    )
    if not db.consume_invite(token, member["id"], now_iso()):
        # roll back the member we created — keep the table clean
        with db.conn() as c:
            c.execute("DELETE FROM sessions WHERE member_id=?", (member["id"],))
            c.execute("DELETE FROM members WHERE id=?", (member["id"],))
        raise HTTPException(400, "invite invalid or already used")
    resp = JSONResponse({"member": member_public(member, db), "project": get_config()})
    resp.set_cookie(
        COOKIE, session_token, max_age=60 * 60 * 24 * 365, httponly=True,
        samesite="lax", path="/",
    )
    return resp


@app.post("/api/signout")
def signout(req: Request):
    tok = req.cookies.get(COOKIE)
    if tok:
        with db.conn() as c:
            c.execute("DELETE FROM sessions WHERE token=?", (tok,))
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE, path="/")
    return resp


# ---------- members ----------

@app.get("/api/members")
def list_members(req: Request):
    require_member(req, db)
    return {"members": db.list_members()}


# ---------- entries ----------

@app.get("/api/entries")
def list_entries(
    req: Request,
    limit: int = 200,
    before: Optional[str] = None,
    type: Optional[str] = None,
    tag: Optional[str] = None,
    author: Optional[str] = None,
    q: Optional[str] = None,
):
    require_member(req, db)
    if type and type not in ENTRY_TYPES:
        type = None
    rows = db.list_entries(
        limit=min(max(limit, 1), 500),
        before=before, type_=type, tag=tag, author=author, q=q,
    )
    mm = members_map()
    return {"entries": [enrich_entry(e, mm) for e in rows]}


@app.get("/api/entries/{entry_id}")
def get_entry(entry_id: str, req: Request):
    require_member(req, db)
    e = db.get_entry(entry_id)
    if not e:
        raise HTTPException(404, "not found")
    return enrich_entry(e, members_map())


@app.post("/api/entries")
async def create_entry(
    req: Request,
    type: str = Form(...),
    body: str = Form(""),
    title: str = Form(""),
    tags: str = Form(""),
    files: list[UploadFile] = File(default=[]),
):
    me = require_member(req, db)
    if type not in ENTRY_TYPES:
        raise HTTPException(400, f"unknown type {type!r}")
    body = (body or "").strip()
    title = (title or "").strip() or None
    # Tags: explicit comma list + inline #tags in body
    explicit = [t.strip().lstrip("#").lower() for t in tags.split(",") if t.strip()]
    all_tags = sorted(set(explicit) | set(extract_inline_tags(body)))

    now = datetime.now(timezone.utc)
    iso = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    entry_id = random_token(10)
    asset_paths: list[str] = []
    for f in files or []:
        if not f.filename:
            continue
        data = await f.read()
        if not data:
            continue
        rel = vault.save_asset(data, f.filename, now)
        asset_paths.append(rel)

    member_row = db.get_member(me["id"])
    payload = {
        "id": entry_id,
        "type": type,
        "title": title,
        "body": body,
        "author_id": me["id"],
        "author_name": member_row["name"] if member_row else me.get("name", "unknown"),
        "created_at": iso,
        "updated_at": iso,
        "tags": all_tags,
        "assets": asset_paths,
    }
    path = vault.write_entry(payload)
    payload["file_path"] = path.relative_to(vault.root).as_posix()
    db.upsert_entry(payload)
    return enrich_entry(db.get_entry(entry_id), members_map())


@app.patch("/api/entries/{entry_id}")
async def update_entry(entry_id: str, req: Request):
    me = require_member(req, db)
    existing = db.get_entry(entry_id)
    if not existing:
        raise HTTPException(404, "not found")
    if existing["author_id"] != me["id"] and not me.get("is_owner"):
        raise HTTPException(403, "not your entry")
    body = await req.json()
    new_body = body.get("body", existing["body"]) or ""
    new_title = body.get("title", existing["title"]) or None
    new_type = body.get("type", existing["type"])
    if new_type not in ENTRY_TYPES:
        new_type = existing["type"]
    tags = body.get("tags")
    if tags is None:
        tags = existing["tags"]
    tags = sorted({t.lstrip("#").lower() for t in tags} | set(extract_inline_tags(new_body)))
    iso = now_iso()
    author = db.get_member(existing["author_id"])
    payload = {
        **existing,
        "type": new_type, "title": new_title, "body": new_body,
        "tags": tags, "updated_at": iso,
        "author_name": author["name"] if author else "unknown",
    }
    path = vault.write_entry(payload)
    payload["file_path"] = path.relative_to(vault.root).as_posix()
    db.upsert_entry(payload)
    return enrich_entry(db.get_entry(entry_id), members_map())


@app.delete("/api/entries/{entry_id}")
def delete_entry(entry_id: str, req: Request):
    me = require_member(req, db)
    existing = db.get_entry(entry_id)
    if not existing:
        raise HTTPException(404, "not found")
    if existing["author_id"] != me["id"] and not me.get("is_owner"):
        raise HTTPException(403, "not your entry")
    vault.delete_entry(existing["file_path"])
    db.delete_entry(entry_id)
    return {"ok": True}


# ---------- tags / stats ----------

@app.get("/api/tags")
def list_tags(req: Request):
    require_member(req, db)
    return {"tags": db.all_tags()}


@app.get("/api/stats")
def stats(req: Request):
    require_member(req, db)
    return {
        "types": db.type_counts(),
        "total": db.total_entries(),
        "members": db.member_count(),
        "host": socket.gethostname(),
    }


# ---------- assets ----------

@app.get("/asset/{path:path}")
def asset(path: str, req: Request):
    require_member(req, db)
    full = vault.asset_full_path(f"assets/{path}")
    if not full:
        raise HTTPException(404, "not found")
    return FileResponse(full)


@app.get("/healthz", response_class=PlainTextResponse)
def healthz():
    return "ok"
