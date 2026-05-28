# Thymeline

A local-first, editorial-style build journal for hardware projects.
Built for a quadruped robot, useful for anything you build over time.

```
log something. paste images. drop files. use #tags.
```

Every entry is a markdown file on disk. SQLite is a queryable index over
those files — your data is literally just a folder you can open in Obsidian.

## Features

- **Quick-entry, everywhere.** Type into the top bar; paste screenshots;
  drag-drop files. Press `n` to focus, `⌘⏎` to save, `Tab` to cycle type.
- **Seven entry types.** progress · failure · log · debug · code · record · idea.
- **Chronological feed.** Day grouping, hover-expand rows, inline images.
- **Tags.** Inline `#tag` anywhere in your text — auto-extracted and clickable.
- **Multi-user via invite link.** Owner mints a URL, teammate opens it on
  their machine, picks a name. No passwords. Works on LAN.
- **Obsidian-compatible vault.** Open the `vault/` folder in Obsidian and
  edit the same notes side-by-side.
- **Dark by default.** Toggle to light if you must.

## Run

```bash
./run.sh                 # http://localhost:8765
PORT=9000 ./run.sh       # custom port
./run.sh /path/to/vault  # custom data location
```

First run prompts for project name + your name. After that, click **Invite**
in the top-right to add teammates.

## Stack

- Backend: FastAPI + SQLite + plain markdown files
- Frontend: vanilla HTML/CSS/JS (no build step)
- Design system: editorial monochrome, typography on lines (no boxed cards)

## Data layout

```
vault/
├── entries/                    # one .md file per entry
│   └── 2026-05-28T11-23-00Z_progress_a1b2c3.md
├── assets/YYYY/MM/DD/          # image / file uploads
├── project.json                # project name + created date
└── .thymeline.db               # SQLite index (rebuildable from entries/)
```

Each entry file looks like:

```markdown
---
id: a1b2c3d4
type: progress
title: V2 leg assembly day 1
author: Barq
created: 2026-05-28T11:23:45Z
tags: [hardware, leg, assembly]
assets:
  - assets/2026/05/28/112345-leg-mount.jpg
---

Mounted the front-left leg. Servos warm but holding torque.
```

Delete the `.thymeline.db` file and restart — the index rebuilds from the markdown.
