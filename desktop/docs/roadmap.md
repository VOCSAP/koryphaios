# The roadmap

The **Roadmap** view exposes the project's persistent backlog, stored in the
claude-peers broker and shared with **every Claude session working on the
same repository** — agents read/write it through their `roadmap_*` MCP tools,
the operator through this view. Items are keyed per project, so all windows
and agents on the same repo see the same backlog.

## Items

Each item has:

- **Kind** — feature, bug, tech debt, idea, chore.
- **Title / Description / Rationale** (why it matters).
- **Context** — the *agent briefing*: objective, constraints, file pointers,
  acceptance criteria — everything the next agent cannot rediscover alone.
- **Priority** — MoSCoW: Must / Should / Could / Won't have. The list is
  grouped by priority; click a priority badge to change it.
- **Value** and **Effort** — low / medium / high badges.
- **Status** — idea → planned → in progress → done (→ archived).
- **Tags**, **Depends on** (item dependencies).
- Audit fields: created/updated by & when. Agents stamp their `peer_id`; the
  operator's edits are stamped `deck`.

## Item actions

- **Edit** (✏️), **Archive / Restore** (archived items hidden by default,
  `Show archived` reveals them), **Delete** archives.
- **Launch an agent** — spawns a session pre-briefed with the item and flags
  it in progress.
- **Process now…** (▶) — send the item to a chosen live agent (targeted
  announce) or spawn a fresh one on it.
- **Queue for dispatch** (⏳) — add to the dispatch queue (below).
- **Stop** (⏹, on in-progress items) — tells agents to stop working on the
  item, unlocks it and returns it to planned. Routed through the supervisor
  when one runs (it reports back to the inbox), else broadcast to the group.
- **Mark done** — confirm dialog; agents will no longer pick it up.

## Work locks

An agent actively working on an item **locks** it (lock owner and time shown
in the UI). Locked items are protected from concurrent edits; the operator's
Stop action or the agent finishing releases the lock.

## Dispatch queue (⏳)

Queued items are sent **one by one to the team-lead** (👑): the full item
plus a "keep the status current" contract. When a dispatched item turns
`done`, the next queued item is dispatched automatically. Requires a
designated team-lead.

## Import a plan (📄)

`Import a plan…` hands a plan file (e.g. a `PLAN*.md`) to a **one-shot import
agent** that reads it, deduplicates against the existing roadmap
(`roadmap_list`), converts it into roadmap items (`roadmap_add`, tagged with
the plan's basename) and closes itself. It does not modify any file.

## Context wand (AI drafting)

In the item editor, the wand drafts the **Context** briefing with a read-only
inference grounded in the project files (model configurable in
`Settings > Models`, Haiku by default). Nothing is saved until the operator
hits Save.

## Agent-side tools

Sessions spawned by the window have `roadmap_*` MCP tools (list, add,
update…). The expected agent contract: set an item `in_progress` when work
really starts, `done` when complete, and report progress/blockers via
`send_message`.
