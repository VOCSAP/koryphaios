# Overview & core concepts

## What Koryphaios is

Koryphaios (Κορυφαῖος — the leader of the chorus in Greek theatre) is a
desktop app that **docks multiple Claude Code sessions into a single window**,
so the operator stops juggling a dozen floating terminals. Every tile is a
real terminal (xterm.js + node-pty, the VS Code terminal stack) running a real
Claude Code session: OAuth in the browser, the full TUI, colours and key
handling behave exactly as in a normal terminal.

On top of the terminals the app adds:

- **layout** (grids, carousel, maximize, cross-session search),
- an **isolated peer group** per window so the sessions can discover and
  message each other privately,
- **save & restore** (workspaces, templates),
- a **shared per-project roadmap** the agents read and write,
- a **supervisor session** that pilots the window itself,
- assist features: floating "?" help assistant, resume digest, embedded
  browser with design feedback tools, graph chats, operator inbox, activity
  journal, mobile companion.

The app was formerly named **Claude Peers Deck** ("the Deck"); the word
*Deck* survives in tool names (`deck_*`) and internal identifiers.

## Core concepts

### Window & project directory

One app window is scoped to one **project directory** (the working directory
new sessions launch in). It is the directory the `kory` command was launched
from, or the `projectDir` configured in `Settings > Terminal`.

### Sandbox mode (optional)

A project can run its sessions inside a persistent Docker/Podman container
instead of directly on the machine, with the project folder mounted (or a
throwaway clone of it). The supervisor stays on the host and can install
things inside the container on request. See [sandbox.md](sandbox.md).

### Session = tile = agent = peer

One running Claude Code instance. The four words emphasise different aspects:

- **session** — the persisted definition (name, colour, args, session id…);
- **tile** — its terminal rectangle in the tile area;
- **agent** — its role as an autonomous worker (often launched with an agent
  profile from `.claude/agents`);
- **peer** — its identity on the claude-peers messaging channel (`peer_id`).

Sessions survive app restarts: the underlying Claude conversation can be
resumed later (see [workspaces-templates.md](workspaces-templates.md)).

### Group & scope

Every session a window spawns joins the same **private claude-peers group**,
so `list_peers` inside a tile shows only this window's sessions — not other
Claude instances on the machine. The group is defined by a **scope**:

- **Ephemeral scope** (launching `kory` with no argument): a fresh random
  secret each launch. Perfect for "just dock my sessions together".
- **Custom scope** (`kory my-team`): the argument is the group secret; anyone
  launching with the same argument (on machines sharing a broker) joins the
  same shared group. Choose something unguessable for real sharing.

The secret lives in memory and a chmod-600 temp file; only a hash
(`groupId`) is ever persisted. `Settings > General > Remember shared scope
secrets` can store custom secrets encrypted via the OS keystore so a saved
workspace can be restored without re-supplying the secret.

### The broker

claude-peers runs a background **broker** (HTTP + WebSocket + SQLite daemon)
that stores peers, messages and the roadmap. The window talks to it for
announcements, the inbox, the roadmap and peer state. When the broker is
unreachable a red banner appears with a Retry button; sessions themselves keep
running.

### Supervisor vs agents

- **Agents** (Agents view) do the work: they code, review, explore. They have
  the claude-peers MCP tools (`list_peers`, `send_message`, `roadmap_*`…).
- The **supervisor** (Home view) pilots the app: it is the only session
  bridged to the window through private `deck_*` tools (spawn/close tiles,
  worktrees, templates, announcements). It never codes itself. See
  [supervisor-team.md](supervisor-team.md).

### Worktrees

A session can run in a dedicated **git worktree** (`.worktrees/<name>`, fresh
branch), so parallel agents on the same repo each get their own working
directory and branch and never step on each other. See
[sessions.md](sessions.md) and the Worktrees view in
[interface.md](interface.md).

### Read-only assistants

Besides the interactive sessions, the app runs **one-shot, technically
read-only inferences** for assist features: the floating "?" help assistant,
the resume digest, the roadmap context wand and graph-chat nodes. These load
no MCP servers and have every mutating tool disabled — they advise, they
never act. See [help-assistant.md](help-assistant.md) and
[graph.md](graph.md).

## The two languages

The UI is available in **English and French**, switchable live in
`Settings > General > Language` (Auto follows the OS). Locale files are plain
JSON and user-overridable (see [settings.md](settings.md)).
