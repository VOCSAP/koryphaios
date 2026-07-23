# Interface tour

## Navigation rail (far left)

The vertical rail switches the main view:

| Entry | View |
|-------|------|
| 🏠 Home | The **supervisor** session (see [supervisor-team.md](supervisor-team.md)) |
| Agents | The session tiles (the default working view) |
| 🌐 Browser | Embedded web browser for web-front work (see [browser-design.md](browser-design.md)) |
| 📁 Files | Read-only file explorer over the project, its worktrees and session dirs |
| ± Git | Read-only diff browser: what each session/worktree changed |
| Roadmap | The shared per-project backlog (see [roadmap.md](roadmap.md)) |
| Graph | Branching multi-model chats (see [graph.md](graph.md)) |
| ⎇ Worktrees | Every git worktree of the repo with status and attached session |
| 📜 Journal | The window's activity journal |
| Usage | The amphora's liquid level shows the mean remaining session quota of the providers this run uses (green / amber / red tone). Clicking opens a foreground modal with the subscription quota gauges of the detected CLIs (Claude Code / Codex / Antigravity): session + weekly windows, % used, reset time, Claude extra-usage credits. Providers whose CLI is absent are hidden; a provider that is installed but signed out shows a "not connected" note. Data is cached 3 min (↻ bypasses); Codex falls back to its last local session snapshot when the app-server is unreachable |
| ✉ Inbox | The operator inbox panel (unread bubble on the rail) |

## Sidebar (left, Agents view)

- **`＋ Add peer`** — start a new session in the window's project directory.
- **`▾` (advanced create)** — popover with agent profile, model, effort,
  extended context (1M), extra args, presets, initial prompt, join
  announcement, worktree branch, team-lead checkbox, custom colour, and (under
  *Advanced*) a different working folder. See [sessions.md](sessions.md).
- **Session rows** — each shows a colour swatch, a status dot
  (starting / running / exited, with a thinking pulse), the name
  (double-click to rename) and the live `peer_id` (or `Session <id>` until it
  resolves). Badges: 👑 team-lead, ⏸ needs you, orange dot + "auto-resume at
  HH:MM" while waiting out a usage limit, branch badge for worktree sessions.
- **Row actions** — maximize, remove (confirm dialog). Right-click a row for
  the context menu: rename, recolour, copy peer id, designate as team-lead,
  enable/disable quota auto-resume, view diff, close.
- **Drag** the right edge to resize the sidebar; drag rows to reorder
  sessions (order drives the tile layout).
- **Message bar** (bottom) — type a line and broadcast it as a one-way,
  no-reply announcement to every peer in the window's group (the *outbound
  megaphone*). Enter sends, Shift+Enter inserts a newline. See
  [communication.md](communication.md).
- **Header buttons** — 🗂 Workspaces and ⚙ Settings.

## Tile area (right, Agents view)

- **Display modes** (top bar): `1x1` (horizontal carousel), `1x2`, `2x2`, or
  a custom `X x Y` grid. Overflow scrolls.
- **Maximize / restore** a tile: its button, double-click its header, or
  `Ctrl+Shift+M` on the selected tile.
- **Per-tile buttons**: restart peer, close session, 🌐 open the browser view
  with this agent docked, snippet insert (saved prompts).
- The **empty state** offers `＋ Add peer terminal`, `Restore previous
  session` (when a previous workspace exists) and `Use template`.

## Files view (📁, read-only)

A VS Code-style explorer over the directories the window works in: the
project directory, its git worktrees and the working dirs of live sessions
(pick the root in the header when there are several). The left tree loads
lazily; clicking a file opens a plain-text preview with line numbers (big
files are truncated, binary files show no preview). Everything is
**read-only** — the Deck never edits or writes files, that is the agents'
job.

Selecting text in the preview reveals two actions in the file header:

- **❓ Explain** — opens the help assistant with a prefilled question and the
  selected snippet attached (file + line range); review the question, then
  send.
- **🗺 Create a task** — jumps to the Roadmap view with the create form
  prefilled (kind *debt*, status *planned*, the snippet quoted in the
  description); saving stays your explicit action.

## Git view (±, read-only)

An SCM-style view of what changed: pick a target on the left (a worktree of
the project — badge for the attached session — or the working dir of a live
session), and read its diff on the right. Worktrees show two sections:
commits of the branch versus the main branch, and uncommitted changes.
Clicking a file narrows the diff to that file; ✕ returns to the full diff.
The 🔎 button spawns the same one-shot review agent as the Worktrees view's
Diff dialog.

This view is deliberately **read-only**: there is no stage, commit or branch
action in the Deck (not even delegated) — committing remains the agents'
workflow.

## Cross-session search

🔍 in the top bar or `Ctrl+Shift+F`: searches the scrollback of every open
terminal, grouped by session. Double-click a result to focus its tile and
scroll the terminal to the match (highlighted via selection). Scope is the
live scrollback (last 8000 lines per session), not the full transcript
history; repeated TUI repaint frames of the same line are collapsed into one
result.

## Menus

- **File** — New (clear: close all sessions, empty window), Save workspace,
  Save As…, Restore, Workspaces list, Export template, Import template.
- **Edit** — Settings… (`Ctrl/Cmd+,`).

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd+,` | Open Settings |
| `Ctrl+Shift+F` | Cross-session search |
| `Ctrl+Shift+M` | Maximize / restore the selected tile |
| `Ctrl+Shift+D` | Element pick inside an external app running the design client (see [browser-design.md](browser-design.md)) |
| `Enter` / `Shift+Enter` | Send / newline in the megaphone message bar |
| `Esc` | Cancel element pick / draw mode |

## Status & error surfaces

- **Red banner** — broker unreachable since a given time, with a Retry
  button. Sessions keep running; group features (roadmap, inbox, announces)
  are paused until the broker is back.
- **Toasts** — transient confirmations (workspace saved, template applied,
  message sent…).
- **Journal** (📜) — the persistent narration of what the window did; errors
  land there too. See [communication.md](communication.md).
- **Floating "?"** (bottom corner) — the help assistant popup; right-click
  the button to hide it or switch its model. See
  [help-assistant.md](help-assistant.md).
