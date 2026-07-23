# The roadmap

The **Roadmap** view exposes the project's persistent backlog, stored in the
claude-peers broker and shared with **every Claude session working on the
same repository** — agents read/write it through their `roadmap_*` MCP tools,
the operator through this view. Items are keyed per project, so all windows
and agents on the same repo see the same backlog.

## Items

Each item has:

- **Kind** — feature, bug, tech debt, idea, chore, or **directive** (a control
  card the app executes, see [Directive cards](#directive-cards-contexttoken-economy)).
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

## Directive cards (context/token economy)

A **directive card** (kind `directive`) is not a work item — it is a control
card the **Deck itself executes** to reset the context window of running
sessions, saving tokens on long-lived agents. It carries:

- a **command** — `clear` (a free, zero-inference context reset; the system
  prompt, `CLAUDE.md`, MCP servers and skills all survive), `compact`
  (summarize the conversation in place, one inference on the target's own
  model), or `magic_compact` (see below);
- a set of **target sessions** — the live peers whose terminals receive the
  command (multiselect in the editor).

When the card reaches the head of the dispatch queue (above), the
Deck **types the command into the targeted sessions' terminals** the way you
would (it waits for the tile to be idle so a reset never lands mid-turn), marks
the card done, and moves on — **agents never run directives themselves**. In
the Workflow lane a directive card shows a dashed violet frame, its command and
a target count.

Typical use: queue a `clear` card *between two independent roadmap items*
(or make it `depends_on` the item it should follow) to wipe a peer's context
at a clean boundary. If the next item needs a hand-off, put that briefing in
the **next item's Context field** — not in the directive — so the agent reads
it with `roadmap_get` after the reset.

The team-lead and the supervisor can queue directive cards too
(`roadmap_add`/`roadmap_update` with kind `directive`); the app is always the
one that injects the command.

### magic_compact

`magic_compact` prefers the third-party
[Magic Compact](https://github.com/aerovato/Magic-compact) plugin
(deterministic, zero-inference transcript compaction) when it is installed and
enabled ([Settings > feature flags](settings.md#feature-flags-per-machine)): the
Deck injects `/magic-compact`, captures the compacted session id the plugin
prints, and re-enters that session **in place** (the process is not restarted,
so the peer keeps its identity and launch harness). If the plugin is absent,
disabled, or does not respond, it falls back to a standard `/compact`.

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
