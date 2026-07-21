# Communication: peers, megaphone, inbox, journal

## Peer-to-peer messaging (agents)

Every session the window spawns shares one private claude-peers group. Inside
their terminals, agents use the claude-peers MCP tools:

- `list_peers` — discover the other sessions of this window (only them).
- `send_message` — message another peer by `peer_id`.
- `set_summary` — publish a 1-2 sentence "what I'm working on".
- `check_messages`, `whoami`, `set_id`…

Messages normally arrive by WebSocket push into the receiving session's
terminal.

## Outbound megaphone (operator → group)

The window can **broadcast one-way, no-reply system messages** to its group:

- **Automatic join announcement** when a tile's `peer_id` resolves
  (customizable per session in the advanced create menu).
- **Free-text operator broadcasts** typed into the sidebar message bar
  (Enter sends, Shift+Enter newline).

Peers receive them framed as "informational only — do not reply", sent from
the reserved non-routable `deck` sender. Per-peer targeting from the message
bar is not wired; a broadcast reaches all active peers. (Targeted announces
exist internally: dispatches and review reports go to the team-lead, spawn
acks to the supervisor.)

## Operator inbox (✉, agents → operator)

Agents write to the human with `send_message` to the reserved **`operator`**
peer — questions, results, blockers. The window drains the broker inbox
every 10 s into the Inbox panel (unread bubble on the rail) with one system
notification per batch.

- The inbox is **read-only**: answer through the megaphone (or a targeted
  session's terminal).
- It also lists pending **graph drafts** (agent-escalated questions) with an
  "Open in graph" action (see [graph.md](graph.md)).
- Inbox history is persisted and rehydrated on startup.

## Activity journal (📜)

A per-window ring buffer narrating what happened: session spawns and exits,
quota episodes, attention waits, worktree operations, announces, dispatches,
reviews, checkpoints, graph runs and errors.

- Filterable by event kind; plain-text export.
- Not persisted across app restarts (in-memory ring).

## Broker reachability

All of the above (except the terminals themselves) rides the claude-peers
broker. When it is unreachable, a red banner shows the outage start time and
a Retry button; features degrade gracefully and recover when the broker is
back.
