# Changelog

## docs -- 2026-07-16

- **Working plans retired.** `PLAN-v0.4.md`, `PLAN-context-et-snippets.md`,
  `EXPLORATION-roadmap-et-auto-relance.md` and `EXPLORATION-graph-chat.md`
  (all chantiers shipped) are deleted; their per-batch narratives live in
  this file, and the still-open deferred items (graph digest/artefact nodes,
  graph export + per-node cost, OTEL consumption tracking, GitHub Issues
  sync, the C23-C29 manual UI validation) moved to `roadmap-seed-v0.9.json`
  (`bun cli.ts roadmap-import roadmap-seed-v0.9.json`).
- **CLAUDE.md rewritten for a public repo.** The version-history narrative is
  replaced by a current-state overview (core architecture, protocol
  invariants, desktop overview, checks & conventions); pointers to the
  deleted plans and machine-specific examples are gone. `Cxx` ids in code
  comments now resolve through this changelog.

## desktop v0.9.0 -- 2026-07-16

Graph chat & battle mode (EXPLORATION-graph-chat C23-C27): a canvas view
where every exchange is a node — branch "what if" explorations anywhere,
cross N branches into one prompt node, fan a prompt out to several headless
CLIs, and let a judge node arbitrate a battle.

### Added (desktop, v0.9.0)
- **Graph data model + engine (C23).** `shared/graph.ts`: DAG of typed nodes
  (user / assistant / judge, N parents for cross/merge nodes), pure ops
  (ancestors, cycle refusal, deterministic topological linearization,
  three-way-style `mergePartition` — common trunk + per-branch deltas) and
  shape validation. Per-project persistence (`graph-store.ts`) under the app
  state dir, keyed by the deck project_key (stable across worktrees/clones).
- **Headless CLI adapters (C24).** `model-adapters.ts` generalizes the C9
  skeleton: `claude -p` (context via `--append-system-prompt-file`,
  `--strict-mcp-config` + `--disallowedTools`), `codex exec --sandbox
  read-only` and `gemini` (context file fed through stdin, POSIX redirection
  or PowerShell `Get-Content -Raw` pipe). The compiled context always travels
  by FILE (never the command line); `model` strings are sanitized; `runHelp`
  gains an optional timeout (300 s for inference).
- **Context compilation + inference (C25).** `graph-engine.ts`: three CODE
  CONSTANT system prompts (linear chat, merge, judge — C8 rule). 0-1 parents
  → labeled linear transcript; 2+ parents → documentary merge rendering
  (trunk once + labeled divergent branch sections, never a fake linear
  conversation). 60k-char budget with explicit elision markers. Fan-out via
  `Promise.allSettled` (a failed target yields an error node, never blocks
  siblings). IPC `graph:list/create/delete/save/compile/infer` + journal kind
  `graph`.
- **Graph view (C26).** New 🕸 rail view: per-project graph list,
  dependency-free canvas (SVG bezier edges + positioned cards, pan/zoom/drag,
  manual layout), multi-selection, reply / node-from-selection (cross) /
  connect-parent (cycles refused) / leaf-only delete, and a context inspector
  showing exactly what will be sent. i18n en/fr.
- **Battle mode (C27).** Check several CLIs on a prompt node: one answer node
  per target; with battle ON and ≥2 successful answers, a 🏆 judge node
  (default claude/sonnet, configurable) compares the ANONYMIZED answers,
  picks the strongest and produces the merged answer — the model mapping is
  revealed in a legend after the verdict. Degrades gracefully to no judge
  with <2 answers.
- **Unified model picker (C29).** One `ModelPicker` shared by the graph
  fan-out (multi-select chips) and the agents' advanced create menu (single,
  Anthropic ∪ launch-config models): expandable provider sections
  (Anthropic / OpenAI / Gemini + local endpoints), a separator, and
  star-pinned favorites persisted in the app config (`providerId:modelId`
  keys, pin order). Frontier providers only appear when their CLI is
  detected on the machine (login-shell `command -v` / `Get-Command`, cached,
  re-detect button in Settings); frontier model lists are CURATED IN CODE
  (`FRONTIER_CATALOG`, the one constant to bump — the OAuth CLIs expose no
  dynamic listing) while local OpenAI-compatible endpoints (Ollama, LiteLLM,
  vLLM…) are discovered dynamically (`/v1/models`, Ollama `/api/tags`
  fallback). New Settings > Models section manages local endpoints (name,
  base URL, optional API key, discovered-model count). Local targets run as
  a new `cli:'local'` through a direct `/v1/chat/completions` call from the
  main process — the API key never reaches the renderer or a command line.
- **Provider API keys encrypted at rest (C29/D12).** Local-provider Bearer
  tokens go through Electron `safeStorage` (`provider-secrets.ts`, same
  cipher surface as scope secrets): the renderer only ever sends a transient
  `apiKey` when the operator (re)types one ('' = forget, ⊘ button) and only
  ever receives a `hasKey` marker — `config:get/set/changed` are sanitized;
  the config file stores `enc:<base64>` blobs (explicit `plain:` fallback
  when no OS keyring), decrypted in main memory only at discovery/inference
  time. A corrupt blob (OS key change) degrades to "no key stored".

## v0.7.0 -- 2026-07-16

The "briefed agents" batch (PLAN-context-et-snippets C20-C22): roadmap items
carry an implementation briefing that travels to the agent, a magic-wand
assistant drafts it for manual creations, and recurring operator prompts
become reusable snippets.

### Added (core: broker / server, v0.7.0)
- **Roadmap `context` field (C20).** `roadmap_items.context TEXT NOT NULL
  DEFAULT ''` (idempotent migration): the implementation briefing for the
  agent that will pick the item up later — objective, constraints/scope
  boundaries, file pointers, acceptance criteria, decisions already made
  (description = what, rationale = why, context = how/where). Settable
  through `/roadmap/upsert` (partial-patch semantics), preserved by
  archive and export/import. `roadmap_add`/`roadmap_update` expose it,
  `roadmap_get` shows it, and the MCP instructions ask agents to ALWAYS
  fill it (the agent that discovers a bug writes the briefing for the
  future agent that fixes it).

### Added (desktop, v0.8.0)
- **Context in the Deck (C20).** Item editor textarea with a
  semi-structured placeholder (Objective / Constraints / Pointers /
  Acceptance criteria), detail panel block, and the briefing travels as a
  delimited data field in both agent hand-offs: the C15 queue dispatch to
  the team-lead (`Context (operator briefing): ...`) and the "Launch an
  agent on this item" prompt. The plan-import agent (C7) is instructed to
  fill `context` for every item it creates, quoting the plan's specifics.
  The help-assistant snapshot includes it (truncated).
- **Context wand (C21).** 🪄 button on the editor's context field: one
  throwaway read-only `claude -p` (pinned haiku, same locked harness as
  the help assistant — code-constant system prompt, `--strict-mcp-config`,
  `--disallowedTools`) drafts the briefing grounded in the project files
  (Read/Grep/Glob), preserving the operator's draft decisions. The result
  only fills the textarea — nothing is saved until Save.
- **Snippets (C22).** Reusable prompts as one `.md` file each, global
  (`<globalConfigDir>/snippets`) or project
  (`<projectDir>/.claude/claude-peers/snippets`, shadows global on a name
  collision, shareable via git). New ⚡ tile button opens a menu that
  pastes the snippet into Claude Code's input field through xterm's
  bracketed-paste path — **fill-not-send**, never auto-submitted — plus a
  manage dialog (create / edit / rename / change scope / delete).

### Fixed
- `tests/desktop-template-store.test.ts` still asserted the pre-rename
  `claude-peers-desk` global dir (stale since the v0.7.0 desktop rename).
- `desktop/package-lock.json` re-synced with the `kory` bin alias.

## v0.6.0 -- 2026-07-15

The "AI orchestrator" batch (PLAN C6-C19): the Deck grows from a session
container into a cockpit for a small agent team — a designated team-lead, an
operator inbox, diff review, an activity journal, a dispatch queue, git
checkpoints, a resume digest, a template composer, and two security gates.

### Added (core: broker / server)
- **Targeted announce (C10).** `POST /announce` accepts `to_peer_id` to
  deliver a Deck message to ONE active peer of the group (the team-lead
  notification path); 404 when the target is missing/dormant. Same reserved
  `deck` sender and no-reply semantics.
- **Operator inbox (C12).** New reserved sentinel `__operator__`/`operator`
  (dormant, never listed, never purged; `set_id` refuses the name).
  `send_message` to `operator` parks the message on the sentinel in the
  sender's group; new `POST /operator-inbox` (TOFU group auth) drains and
  marks them delivered. `server.ts` MCP instructions present 'operator' as
  the human in front of the Deck (questions, results, blockers).
- **Roadmap dispatch queue (C15).** `roadmap_items.queue INTEGER NULL`
  (idempotent migration): 1-based dispatch-queue position, settable through
  `/roadmap/upsert` (positive integer or null), preserved by export/import.

### Added (desktop, v0.6.0)
- **Worktrees view (C6)** in the rail: every worktree with branch, dirty
  count, last commit and the attached Deck session; orphans can be resumed
  into a new session or removed (never forced, branch kept).
- **Plan import (C7).** "Import a plan" in the Roadmap view: a file picker
  plus a ONE-SHOT agent (code-constant prompt) that converts the plan into
  deduplicated roadmap items, then exits.
- **Team-lead (C10).** One 👑 per window (`SessionDef.lead`, uniqueness
  enforced, captured in workspaces/templates): create-menu checkbox
  (suggested by the configurable `leadPattern`), right-click designation,
  and `announceToLead` targeted notices.
- **"Needs you" detection (C11).** `attention.ts` spots Claude Code waiting
  screens (permission chooser, trust prompt) in the PTY stream: ⏸ badge in
  the sidebar/tile plus a clickable system notification (toggle
  `notifyAttention`).
- **Operator inbox (C12).** 10 s drain of `/operator-inbox`, per-batch
  system notification, ✉ rail button with unread bubble and a read-only
  panel (replies go through the existing megaphone).
- **Diff / review (C13).** `diff-service.ts` collects uncommitted changes
  plus branch-vs-main commits (worktrees, merge-base); DiffPanel from the
  Worktrees view or a session's right-click; "Have an agent review this"
  spawns a one-shot reviewer that reports to the team-lead via
  `send_message` when one is live.
- **Activity journal (C14).** In-memory ring buffer (500 entries) narrating
  spawns/exits, quota episodes, attention screens, worktree operations,
  announces, dispatches, reviews and checkpoints; filterable 📜 rail view
  with plain-text export.
- **Dispatch queue (C15).** Roadmap items can be queued (⏳ #n) and sent to
  the team-lead one by one (full item + status contract, code-constant
  message); when a dispatched item turns `done`, the next queued one is
  auto-dispatched (20 s watcher). Button greyed with an explanation while
  no lead is designated.
- **Git checkpoints (C16).** Before an agent spawns into a DIRTY tree:
  `git stash create` anchored under `refs/claude-peers/checkpoint-<ts>` (no
  history/working-tree pollution), journal entry with the sha and the
  `git stash apply` restore command, 7-day purge. Fresh worktrees skip it.
- **Resume digest (C17).** 📋 button in the help popup: one read-only
  `claude -p` briefing (C9 harness) grounded in the app snapshot plus
  configured sources (files/globs + commands). Sources are read from the
  GLOBAL config only (`digest.sources`, `digest.perProject[project_key]`) —
  never from a project config, which would mean arbitrary command execution
  on clone; commands still run with cwd = projectDir.
- **Template composer (C18).** Create/edit/duplicate templates WITHOUT
  spawning (manage mode of the template picker): per-entry advanced fields
  (agent, model, effort, args, initial prompt, fresh-worktree branch,
  announce, colour) and a single-lead crown; hierarchical rendering (lead
  top-center). Applying routes through the worktree-aware path, and the
  template's lead only becomes the window's when none exists yet.

### Security
- **Project launchCommand gate (C19).** A `launchCommand` carried by the
  repo's `.claude/claude-peers/config.json` no longer runs silently: a
  first-use warning dialog shows the command; approval stores its sha256
  per project_key in the app state (a changed command asks again), refusal
  falls back to the global command and persists nothing. Journal entry
  either way.
- The C8 code-constant rule extends to every new agent prompt (plan import,
  reviewer, dispatch message, digest, help) — none is operator- or
  repo-configurable.

## v0.5.0 (desktop) -- 2026-07-14

### Added
- **Supervisor session (PLAN C5).** A new **Home** rail view hosts a full-width
  Claude Code session that PILOTS the Deck instead of coding: it reads the
  repo, consults the shared roadmap, spawns briefed agent tiles and coordinates
  them through the existing peers messaging. Spawned lazily on the first Home
  visit (manual start button after an intentional close). Its role definition
  is **locked in the application code**: a system-prompt anchor
  (`--append-system-prompt-file`, re-passed on resume) regenerated from a code
  constant at every spawn (a tampered file is overwritten) plus a short C2
  kickoff prompt -- deliberately NOT operator- or repo-configurable (no
  `supervisor.md`, no agent profile), so a cloned repository can never
  silently repurpose the session that pilots the app.
- **deck-control bridge.** The main process starts a loopback HTTP control
  endpoint (random port + per-launch Bearer token, `deck-control.ts`) and the
  supervisor is the ONLY session launched with a generated `--mcp-config`
  pointing at a dependency-free MCP stdio server
  (`desktop/mcp/deck-control-mcp.ts`, built to `deck-plugin/mcp/*.mjs`, run by
  the Electron binary as Node). 14 tools: `deck_list_agents/models/presets`,
  `deck_spawn_session` (agent/model/effort/prompt/worktree_branch/announce),
  `deck_list_sessions`, `deck_restart_session`, `deck_close_session`,
  `deck_create_worktree`, `deck_list_worktrees`, `deck_remove_worktree`,
  `deck_list_templates`, `deck_apply_template` (append-only),
  `deck_save_template`, `deck_announce`.
- **Guardrails.** Destructive tools (close session, remove worktree) only work
  on objects the supervisor itself created; template application never
  replaces/closes existing tiles; live sessions are capped at 8 on
  `deck_spawn_session`; the control token never touches the repo, project
  config or normal sessions. `--mcp-config` is re-passed on resume (like
  `--effort`), and the supervisor is excluded from workspace/template capture
  (its token only lives for the current app launch).
  Tests: `tests/desktop-deck-control.test.ts` (dispatch, auth, guards, and an
  end-to-end MCP stdio round-trip against a live control endpoint).
- **Floating "?" help assistant (PLAN C9).** A floating button (all views)
  opens a chat popup where each question runs a throwaway `claude -p` with an
  app-generated system prompt: the code-constant role (C8 rule) plus the
  active view and a JSON snapshot of what it shows (roadmap items, session
  list). The assistant is TECHNICALLY read-only, not just prompt-constrained:
  `--strict-mcp-config` loads zero MCP servers and `--disallowedTools` denies
  every mutating tool (Read/Grep/Glob stay, so answers can be grounded in the
  repo). Popup continuity replays the last 4 exchanges; a start marker strips
  login-profile noise from the captured output. Options in Settings > General
  and via right-click on the button: hide it, pick the model (default
  `haiku`). New `desktop/src/main/help-assistant.ts` +
  `tests/desktop-help.test.ts`.

## v0.4.0 -- 2026-07-14

### Added
- **Shared per-project roadmap (broker, C3-M1).** New `roadmap_items` table in
  the broker SQLite DB and three routes: `POST /roadmap/list` (filters
  kind/status/priority/tag, archived hidden by default), `POST /roadmap/upsert`
  (create with defaults or partial patch; a status change away from `archived`
  restores the item) and `POST /roadmap/archive` (reversible soft delete via
  `deleted_at`). Items are scoped by `project_key` (normalized git remote), NOT
  by group, and carry no FK to peers/groups — `created_by`/`updated_by` are
  plain-text peer_id snapshots — so their lifecycle is fully independent of
  sessions: no cleanup timer touches the table (`tests/broker-roadmap.test.ts`).
- **Roadmap MCP tools (C3-M2).** `server.ts` exposes `roadmap_list` (MoSCoW-
  grouped overview), `roadmap_get`, `roadmap_add` (only title required),
  `roadmap_update` (partial patch) and `roadmap_archive`. Ids accept unique
  8-char prefixes. Author stamps use the session's peer_id automatically;
  repos without a git remote fall back to a stable `local:<hash>` project key.
  The MCP instructions now tell agents to consult the roadmap at task start,
  record discovered bugs/debt, and keep item statuses current.
- **Deck roadmap view (C3-M3).** New navigation rail (Agents | Roadmap) on the
  left of the window; the agents view stays mounted (PTYs/xterm alive) while
  the roadmap is shown. The roadmap view groups items by MoSCoW priority with
  value/effort/status badges and tags, filters by kind, optional archived
  display, a detail panel and full operator CRUD (`created_by='deck'`); it
  polls the broker every 5 s while visible so agent writes appear live. Main
  process `roadmap-service.ts` mirrors server.ts's project-key resolution
  (normalized git remote, else the same `local:<hash>` fallback) so the Deck
  and its agents always see the same roadmap (`tests/desktop-roadmap-service.test.ts`).
- **Launch an agent on an item (C3-M4).** The item detail panel can spawn a
  session pre-filled with a composed initial prompt (uses the C2 positional
  prompt) and a join announcement; the item is flagged `in_progress` at spawn
  and the agent is instructed to keep its status current via the roadmap tools.
- **Roadmap export/import (C3-M4).** `GET /roadmap/export?project_key=` returns
  a versionable JSON snapshot (archived included); `POST /roadmap/import`
  bulk-imports it preserving ids, statuses, authors and timestamps (re-keying
  to a target project supported). New CLI commands `bun cli.ts roadmap-export`
  / `roadmap-import` (the local -> central broker migration path). The CLI now
  sends the configured Bearer token on all requests.
- **Worktree sessions (C4).** The advanced create menu takes a worktree branch
  name: the Deck runs `git worktree add <projectDir>/.worktrees/<name> -b
  <branch>` and spawns the session inside it, so parallel agents on the same
  repo never step on each other (one dir + one branch each; the roadmap stays
  shared since `project_key` derives from the remote, identical across
  worktrees). The sidebar row shows a `⎇ branch` badge; closing the tile
  offers (never forces) to remove the worktree — the branch and its commits
  are always kept, and git's dirty-tree refusal is surfaced, not overridden.
  Optional `worktreeInit` command in the launch config (e.g. `bun install`)
  runs in the background inside each fresh worktree. New
  `desktop/src/main/worktree-service.ts` + `tests/desktop-worktree.test.ts`.

## v0.3.5 (desktop) -- 2026-07-14

### Added
- **Quota auto-resume (opt-in).** When a tile hits Claude's usage limit, the
  Deck now detects the rate-limit screen in the PTY stream (rolling
  ANSI-stripped buffer; old "limit reached ∙ resets 2pm", new "You've hit your
  limit · resets 10pm (TZ)" and "resets Nm" formats, plus conservative
  fallbacks), parses the printed reset time (local clock; >1h past rolls to
  tomorrow; unknown time retries every 15 min), and once it passes injects
  `Escape` → `continue` → `Enter` — one shot per episode, exactly what a human
  would type. Off by default: global toggle in Settings > General
  (`autoResumeQuota`), overridable per session from the sidebar right-click
  menu (`SessionDef.autoResume`). The tile/sidebar dot turns orange while
  limited, with an "auto-resume at HH:MM" badge and a toast on injection
  (`session:quota` IPC event). New `desktop/src/main/quota.ts` +
  `tests/desktop-quota.test.ts` (PLAN-v0.4 C1).
- **Initial prompt at spawn.** A session can now be created with a prompt that
  is submitted to Claude as its positional argument on the fresh launch —
  never re-played on resume (`--resume` restores the conversation). New
  "Initial prompt" field in the advanced create menu; launch presets'
  `prompt` field (declared since M5, previously unwired) now pre-fills it.
  Quoting is platform-aware (POSIX `'\''` vs PowerShell `''`), covered in
  `tests/desktop-launch.test.ts`. Groundwork for roadmap→agent and the
  supervisor (PLAN-v0.4 C2).

## v0.3.4 -- 2026-06-03

### Added
- **Deck outbound announcements (`POST /announce`).** The desktop Deck can now
  broadcast one-way, fire-and-forget system messages to every active peer in a
  group: an automatic join announcement (with the newcomer's `peer_id` and its
  agent/model/effort) when a session's peer_id resolves, and free-text operator
  messages from a sidebar message bar (Send button). Both go through a single
  `/announce` endpoint.
- **Reserved system sender.** Announcements are stored from a non-routable
  sentinel (`from_token = '__deck__'`, `from_peer_id = 'deck'`), backed by one
  permanently-dormant reserved peer row so the `messages.from_token` FK resolves.
  The reserved row never appears in `list_peers`/`group-stats` and is exempt from
  the dormant TTL purge.
- **No-reply guarantee.** `server.ts` renders any `from_peer_id == 'deck'` message
  with an English "informational only -- do not reply" framing (WS push, fallback
  poll and `check_messages`), neutralising the channel's default reply nudge.
  Replies are also impossible: `send_message` toward `deck` finds no active
  target. `set_id` refuses the reserved names `deck` / `system`.

## v0.3.2.1 -- 2026-05-16

### Fixed
- **Broker crash-loop on dormant-peer purge (FK violation).** `cleanStalePeers`
  and `handleUnregister` deleted a peer row without first clearing the rows in
  `messages` that referenced it via `from_token`. Both `messages.from_token`
  and `messages.to_token` are FKs to `peers.instance_token`, so any peer that
  had sent at least one message would crash the `DELETE FROM peers` with
  `SQLiteError: FOREIGN KEY constraint failed` (errno 787). On a long-running
  broker this surfaced as a restart loop once the first dormant-with-history
  peer hit the TTL cutoff. Both DELETE paths now run
  `DELETE FROM messages WHERE from_token = ? OR to_token = ?` before deleting
  the peer (previously only `to_token = ? AND delivered = 0` was cleared, which
  covered neither `from_token` nor delivered receive-side history).
- Semantic change to be aware of: a purged peer's message history is now
  removed in full (both sent and received, regardless of `delivered`). This is
  required by the FK and is consistent with the v0.3.x model where messages
  have no lifetime independent of their peers.
- Regression covered by `tests/broker-fk-cleanup.test.ts` (sender purge via
  TTL, and direct `/unregister` of a peer with sent messages).

## v0.3.2 -- 2026-05-15

### Added
- New opt-in env var `CLAUDE_PEERS_STATUS_LINE_CACHE` (default off). When set to
  `1`/`true`/`yes`/`on` (case-insensitive), `server.ts` writes the active
  `peer_id` to `$HOME/.claude/peers/peer-id-<cwd_key>.txt` after every
  successful `/register` (initial and on group switch). This is the file
  consumed by status-line scripts such as `~/.claude/status-line.sh:get_peer_id`.
  Off by default because the cache is only useful for users who wire a
  status-line and most users will not want `server.ts` to litter `$HOME`.
- New module `shared/peer-cache.ts` exposing `computeCwdKey()`,
  `isPeerIdCacheEnabled()`, and `writePeerIdCache()`. The key derivation matches
  the bash logic exactly: non-alphanumeric (and non-hyphen) chars replaced with
  `_`, last 40 chars kept, with an explicit offset to avoid the MSYS2 bash 5.2
  `${str: -N}` quirk. Best-effort writes (FS failures do not break `/register`).

### Removed
- **SessionEnd bash hook** (`hook-session-end-peers.sh`), its installer
  (`install-hook.ts` + `--uninstall` flag), and the now-unused broker endpoint
  `POST /disconnect-by-cli-pid` (and its `DisconnectByCliPidRequest`/`Response`
  types). Rationale: the hook never fired at a useful moment on Windows
  (Claude Code detaches the hook so `$PPID = 1`, never matched a real peer),
  and on Linux/macOS it only duplicated the work that `server.ts`'s
  SIGTERM/stdin EOF handler already does. The broker-side safety nets
  (`cleanStalePeers` every 30s for same-host PIDs, `sweepInactivePeers` every
  60s for stale heartbeats >120s) cover every realistic crash scenario. Worst
  case for a crashed cross-host peer: ~180s before it flips dormant.
- Test files dropped along with the hook: `tests/hook-session-end.test.ts`,
  `tests/install-hook.test.ts`, `tests/broker-list-peers-by-host.test.ts` (the
  latter was a v0.3.2-internal experiment that never shipped to main).

### Note on upgrade

If a previous v0.3.1 install registered the hook in your `~/.claude/settings.json`
under `hooks.SessionEnd`, that entry now points at a non-existent script and
will be a silent no-op. To clean it up, remove the entry and delete
`~/.claude/hooks/session-end-peers.sh` (or `hook-session-end-peers.sh` depending
on how it was installed). No data loss, no DB migration.

### Fixed
- **Bug C -- status-line `peer_id` segment empty or stale.** Previously,
  `~/.claude/status-line.sh:get_peer_id` read a cache that only the deleted v0.2
  SSH client (`client.ts`) used to write, so on v0.3+ status-lines either showed
  nothing (fresh cwd) or a stale id from a v0.2 session. Users who set
  `CLAUDE_PEERS_STATUS_LINE_CACHE=1` now get a fresh cache file refreshed on
  every `/register`.

## v0.3.1 -- 2026-05-14

### Added
- Auto-disconnect on Claude Code session end via three mechanisms:
  - SessionEnd hook (`hook-session-end-peers.sh`) POSTs `/disconnect-by-cli-pid`.
  - `server.ts` self-shutdown on stdin EOF.
  - Broker `sweepInactivePeers` safety net (60s timer, 120s stale threshold).
- New env vars: `CLAUDE_PEERS_ACTIVE_STALE_SEC` (default 120), `CLAUDE_PEERS_DORMANT_SWEEP_SEC` (default 60).
- New broker endpoint: `POST /disconnect-by-cli-pid`.
- New DB column: `peers.claude_cli_pid INTEGER`.
- Installer: `bun install-hook.ts` (idempotent, supports `--uninstall`).

### Changed
- Hook script is now bash (.sh), installed under `~/.claude/hooks/session-end-peers.sh`
  for consistency with other Claude Code hooks (kleos pattern). The installer
  (`bun install-hook.ts`) copies it from the repo to the user's hooks directory and
  registers a `bash <path>` command in settings.json.

### Removed
- SSH deployment mode and `client.ts` (use HTTP mode or local-only).
- `CLAUDE_PEERS_REMOTE` env var.
- `tests/server-handshake.test.ts`, `tests/client-config.test.ts`.

### Fixed
- Windows: `server.ts` `BROKER_SCRIPT` path resolution via `fileURLToPath` (local-only mode now works on Windows).
- Cross-host peers no longer flap to `dormant`: `cleanStalePeers` now restricts its `process.kill(pid, 0)` liveness check to peers whose `host` matches the broker's `os.hostname()`. Foreign peers (HTTP mode, client on another machine) are reaped via the heartbeat sweep instead. Previously, all remote peers were flipped dormant on every 30s tick because their Windows/macOS PIDs were probed against the Linux broker's process table.
- New env var `CLAUDE_PEERS_CLEAN_INTERVAL_SEC` (default 30) to tune the `cleanStalePeers` interval.
