"""Markdown vault — source of truth for entries.

Each entry is a .md file under vault/entries/ with YAML frontmatter.
Assets (images, attached files) live under vault/assets/YYYY/MM/DD/.
The DB is a rebuildable index over these files."""

from __future__ import annotations
import re
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Iterable

import yaml


FRONT_RE = re.compile(r"^---\n(.*?)\n---\n?(.*)$", re.DOTALL)
TAG_RE = re.compile(r"(?<![\w/])#([A-Za-z][\w-]{0,40})")


class Vault:
    def __init__(self, root: Path):
        self.root = root
        self.entries_dir = root / "entries"
        self.assets_dir = root / "assets"
        self.entries_dir.mkdir(parents=True, exist_ok=True)
        self.assets_dir.mkdir(parents=True, exist_ok=True)

    def entry_path(self, entry_id: str, created_at: str, type_: str) -> Path:
        ts = created_at.replace(":", "-").replace(".", "-")
        slug = f"{ts}_{type_}_{entry_id[:6]}.md"
        return self.entries_dir / slug

    def write_entry(self, data: dict) -> Path:
        """Write entry to disk. data must include id, type, body, author_name,
        author_id, created_at, updated_at. Optionally title, tags, assets."""
        fm = {
            "id": data["id"],
            "type": data["type"],
            "title": data.get("title") or "",
            "author": data["author_name"],
            "author_id": data["author_id"],
            "created": data["created_at"],
            "updated": data["updated_at"],
            "tags": data.get("tags") or [],
            "assets": data.get("assets") or [],
        }
        front = yaml.safe_dump(fm, sort_keys=False, allow_unicode=True).strip()
        body = data.get("body") or ""
        text = f"---\n{front}\n---\n\n{body}\n"
        path = data.get("file_path")
        if path:
            path = self.root / path
        else:
            path = self.entry_path(data["id"], data["created_at"], data["type"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def delete_entry(self, file_path: str) -> None:
        p = self.root / file_path
        if p.exists():
            p.unlink()

    def read_entry(self, path: Path) -> Optional[dict]:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            return None
        m = FRONT_RE.match(text)
        if not m:
            return None
        try:
            fm = yaml.safe_load(m.group(1)) or {}
        except yaml.YAMLError:
            return None
        body = m.group(2).strip()
        if not fm.get("id"):
            return None
        rel = path.relative_to(self.root).as_posix()
        return {
            "id": str(fm["id"]),
            "type": fm.get("type") or "idea",
            "title": fm.get("title") or None,
            "body": body,
            "author_id": fm.get("author_id") or "",
            "author_name": fm.get("author") or "",
            "created_at": fm.get("created") or "",
            "updated_at": fm.get("updated") or fm.get("created") or "",
            "tags": list(fm.get("tags") or []),
            "assets": list(fm.get("assets") or []),
            "file_path": rel,
        }

    def iter_entries(self) -> Iterable[dict]:
        for p in self.entries_dir.rglob("*.md"):
            e = self.read_entry(p)
            if e:
                yield e

    def save_asset(self, content: bytes, original_name: str, when: datetime) -> str:
        """Save an asset under assets/YYYY/MM/DD/. Returns vault-relative path."""
        sub = when.strftime("%Y/%m/%d")
        target_dir = self.assets_dir / sub
        target_dir.mkdir(parents=True, exist_ok=True)
        safe = re.sub(r"[^A-Za-z0-9._-]+", "-", original_name).strip("-") or "file"
        stem, dot, ext = safe.rpartition(".")
        ts = when.strftime("%H%M%S")
        name = f"{ts}-{stem or safe}{dot}{ext}" if dot else f"{ts}-{safe}"
        target = target_dir / name
        n = 1
        while target.exists():
            target = target_dir / f"{ts}-{n}-{safe}"
            n += 1
        target.write_bytes(content)
        return target.relative_to(self.root).as_posix()

    def asset_full_path(self, relative: str) -> Optional[Path]:
        """Resolve a vault-relative asset path, refusing escapes."""
        try:
            full = (self.root / relative).resolve()
            full.relative_to(self.assets_dir.resolve())
        except (ValueError, OSError):
            return None
        return full if full.exists() else None


def extract_inline_tags(body: str) -> list[str]:
    return sorted({m.group(1).lower() for m in TAG_RE.finditer(body)})


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def rebuild_index(vault: Vault, db) -> int:
    """Walk vault and rebuild DB index. Returns entry count."""
    n = 0
    for e in vault.iter_entries():
        db.upsert_entry(e)
        n += 1
    db.set_meta("last_indexed", now_iso())
    return n
