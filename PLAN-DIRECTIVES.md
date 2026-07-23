# PLAN-DIRECTIVES — Context / token optimization via directive cards (CT chantier)

Working plan for the context-window / token-economy batch designed on branch
`claude/context-token-optimization-4n7aqh` (based on `experimental`). Chantier
ids: `CT1`…`CT7`. When this ships: design summary goes to `CHANGELOG.md`,
residual items to `BACKLOG.md`, and this file is removed (repo convention).

## 0. Validated design (operator-approved)

- **One generic "directive" roadmap card** (not one card per command): a new
  `RoadmapKind` `'directive'` carrying a **closed enum** command
  (`clear` | `compact` | `magic_compact`) selected via a dropdown in the item
  editor, plus explicit **`target_peer_ids`**. Cards live in the shared broker
  roadmap so they flow through the existing Workflow-lane machinery (queue
  order, `depends_on`, drag/drop, conflict display) unchanged.
- **Decide vs execute split.** Deciding (queueing a directive card) is open to
  the operator (Workflow lane) and to the team-lead/supervisor (`roadmap_add`).
  Executing (writing into a PTY) is done **exclusively by the Deck main
  process**, from the enum, as a CODE CONSTANT sequence (C8 rule). No free-text
  PTY tool is ever exposed to any LLM (prompt-injection containment: a
  manipulated lead can at worst trigger a spurious `/clear`).
- **Live trigger = the existing conveyor belt.** The dispatch watcher already
  observes `status → done` (agents are contractually required to keep status
  current) and knows the worker via `locked_by`. A directive card executes when
  it reaches the head of the queue — typically placed between two work items,
  or made to `depends_on` the item whose completion should trigger it.
- **`/clear` semantics (verified):** zero-inference control command; system
  prompt, CLAUDE.md, MCP servers, skills and the Deck harness
  (`--append-system-prompt-file`) all survive; the transcript/session id
  rotates in-process (already handled by `refreshLiveSessionIds` + the
  SessionStart plugin hook). `/compact` runs one summarization inference on the
  **agent's own main model** (supports `/compact <instructions>`).
- **Magic-compact chain:** if the `claude-magic-compact` CC plugin is present
  (and the per-machine flag allows it), `magic_compact` is preferred — its
  compaction is deterministic (zero LLM cost). Its `UserPromptSubmit` hook
  blocks the prompt and prints `To enter the compacted session, run:
  /resume <new-session-id>`; the Deck captures the id from PTY output and
  re-enters the compacted session (options A/B/C below). Fallback: standard
  `/compact`.
- **Context gauge (deferred, advisory-only):** a per-tile context-% display
  must never fire a reset mid-task; at most it ARMS a directive that executes
  at the next `done` boundary.
- **Per-machine feature flags** (Kleos vs handoff file, magic-compact
  enablement…): a `features` map in the **global** claude-peers config.
  Anything that reaches a shell or PTY is GLOBAL-config-only; project-local
  (clonable, hostile) config may only restrict, never enable.

## CT1 — Core/broker: `directive` kind + fields

Files: `shared/` roadmap types used by `broker.ts`, `broker.ts`,
`desktop/src/shared/types.ts`.

- Add `'directive'` to `ROADMAP_KINDS` / `RoadmapKind`
  (`desktop/src/shared/types.ts:302`).
- New columns on the roadmap table (SQLite migration in `broker.ts`, follow the
  existing ALTER pattern): `directive TEXT NULL`,
  `target_peer_ids TEXT NOT NULL DEFAULT '[]'` (JSON array).
- Broker validation (`broker.ts` upsert, ~1244, and import path ~1537):
  `badEnum(body.directive, DIRECTIVE_COMMANDS)` with
  `DIRECTIVE_COMMANDS = ["clear", "compact", "magic_compact"]`;
  `target_peer_ids` must be an array of peer-id-shaped strings (reuse the
  peer-id charset check), capped (e.g. 16). `kind === 'directive'` requires
  `directive` non-null; other kinds must NOT carry it (400 otherwise).
- List/upsert/archive plumbing + response projection. Public fields only — no
  token/PID material involved, `toPublicPeer` untouched.
- Tests (`tests/`): roundtrip of both fields, enum rejection, kind/directive
  coherence rejection, import path.

## CT2 — LLM awareness (team-lead / supervisor / MCP schemas)

Files: `server.ts` (roadmap tool schemas + descriptions),
`desktop/src/main/team-embedded.ts` (TEAM_PLAYBOOK),
`desktop/src/main/supervisor.ts` (SUPERVISOR_BRIEFING),
`desktop/src/main/dispatch.ts` (dispatch contract text).

- `roadmap_add` / `roadmap_update` MCP schemas gain `directive` (enum) and
  `target_peer_ids`; tool descriptions explain: "directive cards are executed
  by the Deck app itself when they reach the head of the dispatch queue — the
  targeted peers get the command typed into their terminal by the app; agents
  never execute directives themselves."
- TEAM_PLAYBOOK + SUPERVISOR_BRIEFING: one short paragraph each — when to
  insert a `clear` (between independent items), `compact`/`magic_compact`
  (mid-stream, context pressure), how to target (`target_peer_ids` from
  `list_peers`), and that briefing re-injection for dependent items goes
  through the item's `context` field (not through the directive).
- `composeDispatchText` contract line unchanged for work items; the watcher
  never announces directive cards (CT3).

## CT3 — Deck main: directive executor + injection primitive

Files: `desktop/src/main/session-service.ts`, `desktop/src/main/index.ts`
(dispatch watcher, ~613-666), `desktop/src/main/launch-config.ts`,
`desktop/src/main/journal.ts` (existing sink).

- **Injection primitive** `SessionService.sendDirective(tileId, cmd)`:
  whitelist map `DIRECTIVE_SEQUENCES` (code constant) → the `autoResume`
  keystroke pattern (`session-service.ts:692-709`): `write('\x1b')` → 100 ms →
  `write('/clear')` → `write('\r')` (same for `/compact`, `/magic-compact`).
  Busy-guard: only inject when the tile's ThinkingDetector reports idle; else
  wait (poll, bounded ~10 min) and journal the wait. Never interpolate any
  broker-provided string into the written bytes.
- **Watcher branch**: in `dispatchNext` (`index.ts:621`), if
  `firstQueued(...)` has `kind === 'directive'` → do NOT `announceToLead`;
  run the executor instead: re-validate enum + peer-id shape Deck-side
  (hostile input #2: broker response), resolve `target_peer_ids` against live
  tiles (`r.peerId` from `pollPeerIds`); unknown/dormant targets are skipped
  with a journal entry (no silent drop); inject per target; on completion mark
  the card `done` via roadmap upsert (`updated_by: 'deck'`) so the conveyor
  belt proceeds. Partial failure (some targets injected, some not) → card
  `done` + journal per-target outcomes + operator inbox note.
- **Feature flags**: `features` map parsed in `launch-config.ts` with the
  existing project-local → global precedence, EXCEPT: flags that gate
  PTY/shell-reaching behavior (`magicCompact`) are read from the GLOBAL config
  only; a project-local value may only force-disable. Initial flags:
  `magicCompact: 'auto' | 'on' | 'off'` (default `auto`),
  `handoff: 'file' | 'kleos' | 'off'` (default `file`; consumed by CT2's
  playbook text — with `kleos`/`off` the playbook drops the handoff-file
  instruction).
- Tests: pure helpers extracted for target resolution, sequence table, flag
  precedence (global-only rule), watcher branching (mock roadmap).

## CT4 — Magic-compact chain (option A + fallbacks)

Files: `desktop/src/main/session-service.ts`,
`desktop/src/main/pty-manager.ts` (output scan hook),
`desktop/src/main/desk-session.ts` / `session-transcript.ts` (id checks).

- **Availability**: `features.magicCompact` + static detection of the
  `claude-magic-compact` plugin under `~/.claude/plugins` at spawn/refresh
  (best-effort; journal when `on` is forced but the plugin is absent).
- **Flow** for directive `magic_compact` on a target: inject `/magic-compact`;
  scan that tile's PTY output (hook in `PtyManager.handleData`, scoped to an
  armed window, not a permanent scanner) for
  `To enter the compacted session[\s\S]*?/resume ([0-9a-f-]{36})` and for the
  shim-failure text ("plugin is installed and enabled"); timeout 160 s (hook
  timeout is 150 s). Success → re-enter (below). Shim/timeout → fallback:
  inject `/compact` and journal the downgrade.
- **Re-enter, option A (primary)**: inject `/resume <id>\r` in the live TUI.
  Process never restarts → peer_id and harness trivially preserved. EMPIRICAL
  CHECK (backlog item until verified): argument-form `/resume <id>` support in
  the CC versions we target; verify the harness (`--append-system-prompt-file`
  content, MCP servers) survives the in-app session switch.
- **Option B (fallback)**: set `def.sessionId = <magic id>` then
  `SessionService.restart(tileId)` — existing fork-resume
  (`--resume <id> --fork-session --session-id <new>`) in the SAME visual pane
  (tile/xterm keyed by `def.id`; `pty-manager.ts:38,59-70` suppresses the dying
  proc's exit). Harness re-passed by `buildSessionCommandLine`. peer_id is
  preserved by the broker resume flow (`session_key = sha256(host‖cwd‖group)`)
  in the single-session-per-cwd case; NOT guaranteed with several sessions in
  the same cwd+group → residual: consider folding the stable
  `CLAUDE_PEERS_DESK_SESSION` token into the core's `session_key` (core
  change, separate chantier — goes to BACKLOG).
- **Option C (last resort)**: plain kill + respawn `--resume <magic id>`
  without fork, same harness flags.

## CT5 — Renderer: generic directive card in the Workflow lane

Files: `desktop/src/renderer/**` (lane + item editor + create menu),
`desktop/src/shared/workflow.ts` (only if display filters need it),
`desktop/src/main/ipc.ts` (peer list already exposed), locales.
**Read `DESIGN.md` first / use the `deck-design` skill** — no bare `<button>`,
no emoji, icons from `components/icons.tsx`.

- **One card, distinct frame**: directive cards render in the lane through the
  normal `laneItems` path (they are queued items) with a visually distinct
  chrome (dashed/accent border per DESIGN tokens + a Greek glyph badge — new
  icon in `icons.tsx` if none fits) and the command as the title line
  (`/clear`, `/compact`, `/magic-compact`) plus target chips.
- **Item editor**: when `kind === 'directive'` show (a) the directive
  dropdown (3 values), (b) a target multi-select fed by the live peers of the
  project group (existing peers data), storing `target_peer_ids`; hide
  work-item-only fields (value/effort/rationale). Card is created like any
  roadmap item (create menu / lane affordance) and queued by drag or "queue"
  action.
- **Status surface**: directive cards are `planned → done` only, never locked
  by agents; the Deck sets `done`. `laneItems`/`unmetDeps` need no change
  (verify with a unit test on kind `directive`).
- **i18n**: all new strings in every locale (parity check enforced by tests).

## CT6 — Deferred increment: `clear` + briefing re-injection, context gauge

Not in the first batch; keep visible here, move to BACKLOG on ship.

- Directive variant `clear_briefing`: Deck runs the existing digest path
  (`digest.ts` via `utility-inference.ts`, Haiku default) over cheap sources,
  injects `/clear`, then types the briefing as the first prompt. Zero lead
  inference; bounded Haiku cost. Needs a "paste-safely" injection variant
  (bracketed-paste or chunked writes) for multi-line briefings.
- Context gauge: per-tile % via the statusline cache-file channel
  (`CLAUDE_PEERS_STATUS_LINE_CACHE` precedent) + threshold that ARMS a
  directive insertion at the next `done` boundary. Requires empirical check of
  statusline JSON fields (`context_window_used/total`) per CC version.

## CT7 — Security review + verification

- Three-hostile-inputs mapping: (1) no repo-config value reaches the
  sequences — flags gating PTY behavior are GLOBAL-only; (2) broker fields
  (`directive`, `target_peer_ids`) re-validated Deck-side before use, never
  interpolated into written bytes; (3) no new renderer/companion path — the
  executor lives main-side; deck-control gets NO new PTY tool.
- Injection sequences and all operator-visible dispatch/briefing texts are
  CODE CONSTANTS (C8).
- No silent errors: every skip/downgrade/timeout goes through `reportError`
  or the journal (error-reporting skill conventions).
- Pre-commit gates per batch: `bun test`, smoke build
  (`bun build --target=bun broker.ts server.ts cli.ts --outdir=/tmp/cp-check`),
  `npm run typecheck` in `desktop/`, locale parity.
- Manual E2E to record in BACKLOG when shipping: directive card end-to-end on
  a live team; `/resume <id>` TUI argument support (option A); magic-compact
  detection on a machine with/without the plugin; multi-session-same-cwd
  peer_id behavior under option B.

## Suggested landing order

CT1 → CT2 → CT3 (app executes `clear`/`compact` end-to-end, minimal UI via
existing editor) → CT5 (proper card UI) → CT4 (magic-compact chain) → CT6
(deferred) — each increment passes the CT7 gates before commit.
