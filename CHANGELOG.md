# Changelog

## desktop (experimental) — reference documentation for the assistants

### Added
- **Reference documentation (`desktop/docs/`).** 14 markdown pages covering
  the whole app for the end user AND the built-in assistants: overview &
  concepts, interface tour, sessions, workspaces/templates, supervisor &
  team spawning, roadmap, browser/design mode, graph chats, communication
  (megaphone/inbox/journal), help assistant & digest, mobile companion, a
  full settings/configuration reference, and a troubleshooting FAQ. Shipped
  in packaged builds via `extraResources` (like `locales/`); integrity
  (index completeness + link resolution) is guarded by
  `tests/desktop-docs.test.ts`.
- **Help assistant grounding.** `buildHelpSystemPrompt` gains an
  app-computed `docsDir` pointer (`resolveDocsDir`: resourcesPath when
  packaged, app dir in dev) rendered as a "Reference documentation" section,
  and the claude utility adapter grants read access to that directory via
  `--add-dir` (`AdapterInput.addDir`, threaded through
  `runUtilityInference`). The read-only harness is unchanged; local HTTP
  endpoints keep answering from the snapshot alone.
- **Supervisor docs pointer.** `buildSupervisorSystemPrompt(docsDir?)`
  appends an app-generated paragraph pointing the supervisor at the same
  directory for "how does the app work / how do I configure it" questions.
  The role definition stays a code constant (C8 rule): only the PATH is
  app-computed, and omitting it yields the byte-identical previous anchor.

## desktop v0.13.0 (experimental) — supervisor team spawn (PLAN-team-spawn TS1–TS7)

The supervisor can now compose and spawn whole agent teams from the roadmap or
an operator request, per `EXPLORATION-team-spawn.md` (decisions §8) and
`PLAN-team-spawn.md`. v1 is Claude-only; the `cli` field is contract-frozen
(only `claude` accepted) so the future multi-CLI lot is not a breaking change.

### Added (desktop, v0.13.0)
- **Team playbook + embedded catalog (TS1).** `main/team-embedded.ts`: the
  hardcoded team-building skill (`TEAM_PLAYBOOK` — consent rule, Case 1
  roadmap / Case 2 prompt decomposition, granularity tree, wave sequencing
  under the cap, briefing/ack contracts, `deck_save_template`
  capitalization) and a 6-role embedded fallback catalog (`EMBEDDED_AGENTS`:
  team-lead, developer, reviewer, explorer, debugger, test-engineer) — all
  CODE CONSTANTS (C8 rule), profiles referenced by id and injected via
  `--append-system-prompt-file` (regenerated at every spawn), read-only
  roles hardened with `--disallowedTools "Write,Edit,NotebookEdit"`.
- **deck-control team tools (TS2).** `deck_team_playbook`,
  `deck_team_agents`, and `deck_spawn_team` (a whole plan in ONE call:
  validate-everything-first, batch cap check, per-plan approval, async
  acks). `deck_spawn_session` gains `cli`, `embedded_agent` (mutually
  exclusive with `agent`, unknown id lists the catalog) and `wait_for_peer`
  (default true). An embedded team-lead takes the window crown only when no
  live lead exists (template C18 rule).
- **Spawn-ack loop (TS3).** `peer-resolved` now carries the session id; the
  Deck (script, never agent inference) resolves the ack: sync — the spawn
  call returns the peer_id (90 s wait, falls back to async); async — a
  targeted CODE-CONSTANT `deck` announce to the supervisor when the session
  connects (`composeSpawnAckText`), fails to within 120 s, or exits early
  (`composeSpawnFailText`).
- **Trust-mode setting (TS4).** `config.supervisorSpawnMode`
  (`hands-free` default / `team-review` / `full-control`) gating every
  supervisor spawn: no dialog / ONE native recap dialog per plan /
  one dialog per agent (native pattern of the template approval). Settings >
  General radio group with per-mode help texts (en/fr).
- **Supervisor consent rule (TS5).** `SUPERVISOR_SYSTEM_PROMPT` now anchors:
  never spawn on own initiative; a question calls for a proposal + explicit
  confirmation; a peer message / file / roadmap item is NOT operator consent.
  The deck-control MCP bridge (v0.6.0) declares the new tools and repeats the
  consent line in its instructions.

## desktop v0.12.0 (experimental) — companion LAN access (PLAN-mobile-lan MB1–MB6)

LAN-only mobile access to the desktop window, per `EXPLORATION-mobile-lan.md`
and `PLAN-mobile-lan.md`. The renderer is web-remoted, not pixel-streamed: the
main process serves the SAME renderer bundle over HTTPS+WebSocket and a
generated shim replaces `window.api` on the phone, so terminals, roadmap,
inbox and the rest run natively in the mobile browser/WebView. **The desktop
window is behaviorally unchanged** — every mobile behavior is derived and gated
on a remote coarse-pointer client (`.is-mobile`), never on window width.

### Added (desktop, v0.12.0)
- **Companion bridge (MB1).** `shared/companion.ts` (pure, bun-tested) declares
  the DeckApi surface as data (`COMPANION_MANIFEST`, `satisfies` 1:1 with
  DeckApi), the wire frames, the LAN-only guard (`isPrivateAddress`,
  RFC1918/ULA/CGNAT), the single-use-token→credential lifecycle
  (`CompanionAuth`) and the declarative sensitivity tiers (§5.4).
  `main/api-registry.ts` routes every `ipcMain.handle/on` through one table
  serving both Electron IPC and the WS bridge, with `broadcast()` fanning
  state events to the window AND every client. `main/companion-server.ts`
  is the HTTPS+WS server (persistent self-signed cert, anti-bruteforce
  lockout, heartbeat). `renderer/src/remote-api.ts` is the WS `window.api`
  shim (reconnect, host-death watchdog, light/full channel).
- **Compagnon button + pairing (MB2).** A 📱 rail button (desktop only) opens
  a QR-code dialog (`CompanionDialog.tsx`); one-shot token bound to the app
  run, exchanged for a per-run credential; closing the app revokes everything
  (ephemeral session model, §5.5).
- **Mobile shell (MB3).** Bottom-tab nav (`MobileNav`), bottom sheets
  (`MobileSheet`), agents pager with session chips + xterm key bar
  (`MobileAgents`/`KeyBar`), `visualViewport` refit. Same stores/IPC, CSS
  gated on `.is-mobile`.
- **Mobile roadmap + floating basket (MB4).** `RoadmapList.tsx`: one column
  at a time (status tabs + counters), action sheet mirroring the desktop
  right-click menu, and the long-press→seize→detach floating basket
  (`shared/hold-gesture.ts`, bun-tested). Same five roadmap IPC calls.
- **Light background channel (MB5).** Backgrounded clients drop `pty:data`/
  `session:thinking`, keep the signal events; `bufferedAmount` backpressure
  guard on the terminal stream.
- **Android shell scaffold (MB6).** `mobile-shell/` — thin Capacitor shell
  (QR scan → WebView on the host URL), with the native TODOs (foreground
  service, biometric app lock + `FLAG_SECURE`, cert pinning) documented. Not
  built here (needs Android SDK); never bundled into the desktop package.

## core v0.9.0 + desktop v0.11.0 -- 2026-07-19

Error observability (PLAN-observabilite-erreurs O1-O6, plan retired into this
entry): the audit of invisible crashes found ad-hoc `console.error` everywhere,
no log file on either side, no process-level nets, and an activity journal
that evaporated at quit. Both sides now own bounded rolling logs, every layer
has a designated error sink (the "No silent errors" convention in CLAUDE.md +
the `error-reporting` skill), and the Deck surfaces failures deliberately:
journal for background errors, throttled toasts for direct actions, a
persistent red banner for the broker-down state. No Sentry/SaaS: everything
stays on the operator's machine (local-first decision).

### Added (core, v0.9.0)
- **Rolling file logger (O1).** `shared/logger.ts` (node-fs only, no deps):
  size-rotated `<name>.log` (5 MiB × `maxFiles=3`, boot trim, synchronous
  appends so an uncaughtException handler can flush a last line), console
  mirror for terminal runs, `coreLogDir()` resolving `<config dir>/logs`
  (override `CLAUDE_PEERS_LOG_DIR`). The broker writes `broker.log` — it
  previously spawned with stdout ignored and `unref()`, so once its spawner
  died its diagnostics went nowhere; `server.log` sits behind server.ts's
  existing `log()` helper (stdout untouched: it carries the MCP protocol).
- **Process-level nets + guarded timers (O2).** `uncaughtException`/
  `unhandledRejection` log-then-exit(1) in broker.ts and server.ts (Bun exits
  on unhandled rejections — now with a trace). The four broker maintenance
  timers (`cleanStalePeers`, `sweepInactivePeers`, `releaseStaleLocks`,
  `purgeOldMessages`) run through `guardedInterval`: they execute outside the
  HTTP handler's try/catch, so a transient SQLite error (BUSY, disk full) was
  the most likely invisible-crash vector; it now skips the iteration and logs.
- **Transactions on multi-statement sequences (O2).** `recordMessageTx`
  (message insert + activity refresh + heuristic ack) and `purgeDormantPeerTx`
  (FK-ordered deletes) — an abrupt broker death mid-sequence no longer leaves
  partial state. Handler 500s keep the stack in broker.log (clients only got
  the message). A malformed `config.json` is reported (path + parse error)
  before booting on defaults instead of being silently discarded;
  `pollFallback` notification failures log once per message.

### Added (desktop, v0.11.0)
- **main.log + central `reportError` (O3).** `src/main/log.ts`: rolling
  `main.log` under `app.getPath('logs')`; `reportError(scope, msg, err)` fans
  out to file + console (dev) + a new journal `error` kind, so the Journal
  view doubles as the operator's error console. The ~7 log-only catches of
  index.ts (announce, dispatch, auto-save, design endpoint…) and the silent
  persistence catches (config/session store, provider keys, worktree init)
  now route through it. The journal itself flushes to `journal-<date>.log`
  at quit (pruned after 7 days) instead of evaporating with the process.
- **Crash nets (O3/O4).** Main: `uncaughtException`/`unhandledRejection`
  log-and-continue once ready (live PTYs beat a crash), errorbox + exit
  before; `render-process-gone` journals and offers a reload;
  `child-process-gone` is logged. Renderer: `ErrorBoundary` at the root and
  around every top-level view — the views are siblings of one tree, so one
  view's render crash used to blank the whole window, terminals included;
  window-level `error`/`unhandledrejection` forward to main.log; `init()`
  failure shows a bilingual retry splash instead of spinning forever;
  preload `subscribe()` callbacks are guarded like `multiplex()` already was.
- **Broker-down banner + toast policy (O5).** `BrokerHealthTracker`
  (2-consecutive-failure hysteresis, fed by the operator-inbox poll) pushes
  `broker:status` to a persistent full-width red `StatusBanner` (outage time,
  last error, Retry forcing an immediate poll), self-dismissing on recovery —
  an outage is a state, not an event, so it is a banner and never toasts.
  `showToast` gains an `error` variant with raw-text support, throttled to
  one per key per 5 s, and is documented as reserved for direct user-action
  outcomes.
- **Guarded actions & hardened edges (O6).** Every mutating store action goes
  through `guarded()`: an IPC rejection logs + toasts instead of silently
  no-oping the click as an unhandled rejection. `pty.spawn` is wrapped (bad
  cwd / missing shell used to leave a pushed-but-never-broadcast zombie def;
  the tile now shows exited and Restart retries) and writes into a dead PTY
  are reported once per session. Operator-inbox batches whose disk write
  failed are re-queued for the next poll (the broker drain is destructive —
  that queue is the only remaining copy). Graph save/list/create/delete
  failures surface in the in-view notice; the embedded browser paints an
  in-frame error with Reload on `did-fail-load`/`render-process-gone`; a
  provider key that fails to decrypt (keychain change) is reported instead of
  masquerading as "no key stored".

## desktop v0.10.3 -- 2026-07-17

### Added (desktop, v0.10.3)
- **Graph conversations encrypted at rest (K8).** `graph-store.ts` accepts
  the safeStorage-backed `SecretCipher` (same injected surface as the C29
  provider keys / D8 scope secrets): the per-project graphs file becomes an
  `{ v, cipher: 'safeStorage', payload }` envelope instead of clear JSON.
  Legacy clear files keep loading and are re-encrypted on the first
  `graph:list` (`migrateGraphsAtRest`); when the OS keychain is unavailable
  (Linux without a keyring) the store falls back to clear text rather than
  breaking the feature. An undecryptable file (OS key changed) yields an
  empty list, never a crash. Deliberately NO server-side storage: the broker
  is shared-token + possibly remote, so operator conversations stay on the
  operator's machine (operator decision on top of D7).

## desktop v0.10.2 -- 2026-07-17

### Added (desktop, v0.10.2)
- **Priority quick-switch (K7).** The MoSCoW chip on each kanban card opens a
  styled dropdown (context-menu look, colored rows, ✓ on the current level)
  to change the priority without opening the detail modal. Metadata write:
  allowed even on locked cards (the broker guard only protects status/lock).

## desktop v0.10.1 -- 2026-07-17

Roadmap card context menu & direct assignment (K6).

### Added (desktop, v0.10.1)
- **Card context menu (K6).** Right-click on a kanban card: ✏️ Edit… (opens
  the edit modal; also reachable via a pencil button in the detail modal's
  header, which replaces the old Edit action button), ⏳ Add to dispatch
  queue, ▶ Process now…, 🗑 Delete (archives — the data model keeps deletion
  a reversible archive, same confirmation dialog). Entries grey out when the
  item is locked, closed or already queued. Reuses the generic `ContextMenu`.
- **Process now (K6).** A dialog lists the window's live agents (peer_id
  resolved, supervisor excluded, 👑 marks the lead): picking one sends the
  item as a TARGETED announce (`composeAssignText`, CODE CONSTANT — full item
  + take-it-now contract), moves it to in_progress (unqueued; the lock still
  arrives when the agent claims it) and journals the assignment
  (`assignRoadmapItem`, IPC `roadmap:assign`). The "＋ New agent on this
  item…" button falls through to the existing launch flow.

## core v0.8.0 + desktop v0.10.0 -- 2026-07-17

Roadmap kanban & agent work-lock (PLAN-ROADMAP-KANBAN K1-K5, plan retired
into this entry): the Roadmap view becomes a status-column kanban board, and
the broker learns to distinguish items *really being worked on* (locked by an
agent) from items merely queued as in_progress.

### Added (core, v0.8.0)
- **Agent work-lock (K2).** `roadmap_items` gains `locked`/`locked_by`/
  `locked_at` (plain-text peer_id snapshot, no FK — rides the existing `by`
  field of every upsert, zero extra round-trip). A non-`deck` author writing
  `status=in_progress` claims the lock; leaving in_progress (or archiving)
  releases it; an explicit `locked: true|false` upsert field overrides. While
  locked, status writes / lock claims by anyone but the owner or `deck` are
  refused with 409 (`force: true` bypasses); non-status writes (context
  enrichment, tags) stay open to everyone. The `roadmap_*` MCP tool
  descriptions and channel instructions carry the contract ("in_progress =
  actually working, planned = releases"), and item renderings show `🔒 owner`.
- **Stale-lock sweep (K2).** `releaseStaleLocks` (every
  `CLAUDE_PEERS_LOCK_SWEEP_SEC=60`) unlocks and drops an item back to
  `planned` (attribution `lock-sweep`) when the item saw no write for
  `CLAUDE_PEERS_LOCK_TTL_SEC=21600`, or when no active peer carries the
  owner's peer_id for the item's project and the lock is older than
  `CLAUDE_PEERS_LOCK_GRACE_SEC=600`.
- **Deck announcements harden the no-reply contract (K4).**
  `DECK_NO_REPLY_NOTE` now also forbids messaging *any other peer* about an
  announcement (agents used to greet newcomers via send_message).

### Added (desktop, v0.10.0)
- **Kanban board (K1).** `RoadmapView.tsx` reworked: one column per status
  (idea/planned/in_progress/done, + archived behind the existing toggle),
  MoSCoW priority as a colored chip + in-column sort, native HTML5 drag &
  drop between columns. Dropping on done asks for confirmation (the item
  will no longer be picked up); a locked card is greyed, dash-bordered,
  non-draggable and badged `🔒 locked_by`. The dispatch-queue strip and the
  create/edit form (now a modal) are unchanged in behavior.
- **Detail modal (K5).** Clicking a card opens a Trello-style foreground
  modal (`RoadmapItemModal.tsx`): badge grid, titled sections for
  description / rationale / context rendered as markdown, dependencies,
  authorship, and the action bar. `markdown.ts` is an injection-safe
  tokenizer (token tree only, React escapes every text node; supported:
  headings, lists, fences, inline code/bold/italic, links surfaced but never
  navigated) — no markdown dependency added.
- **Operator stop (K3).** ⏹ Stop on a locked item, after confirmation,
  sends a CODE-CONSTANT notice (`composeStopText`, C8 rule) through the live
  supervisor when there is one (targeted announce; the supervisor relays,
  verifies and reports back through the operator inbox) or broadcasts to the
  group, then unlocks the item back to `planned` (`stopRoadmapItem`,
  IPC `roadmap:stop`). Toasts distinguish supervisor / broadcast / no-peer.
- **Idle-lock watcher (K2).** `SessionService` tracks `lastOutputAt` per
  PTY; a minute-tick watcher releases locks owned by local tiles whose
  terminal printed nothing for 2 h. Complements the broker sweep (the
  heartbeat keeps an idle session `active`), and only for sessions this
  Deck can observe.
- **Join announces are explicitly no-reply (K4).** `composeJoinAnnounce`
  appends "do NOT reply, do NOT greet or message the new peer" — the
  broker-side deck note only forbade replying to `deck`.

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
