# Desktop (Koryphaios) overview

Electron + React 19 + zustand, xterm terminals over node-pty. Sources in
`desktop/src/{main,preload,renderer,shared}`; `@shared` maps to `src/shared`
(types and pure logic shared across processes). Highlights:

- **Sessions**: PTY tiles wrapped in a login shell (`shell-command.ts`),
  workspaces (save/restore) and portable templates; per-session worktrees
  (`worktree-service.ts`); git checkpoints before spawning into a dirty tree.
  Per-session PTY-output detectors run on every tile: thinking (`thinking.ts`),
  usage-limit + auto-resume (`quota.ts`), "needs you" (`attention.ts`), and the
  dev-channels warning auto-ack (`startup-ack.ts` — issue #42486: the launch
  command's `--dangerously-load-development-channels` raises a full-screen
  warning before Claude's UI on EVERY spawn; the Deck acknowledges its OWN flag
  by typing one Enter on the dialog's default accept option, once per process
  run, re-armed on restart, journaled via the `startup-ack` event. The
  project-sourced MCP-server consent dialog is deliberately NOT auto-acked —
  that trust decision stays with the operator). **Every xterm the Deck hosts
  must wire `terminal-clipboard.ts`** (Ctrl+C copies a selection, right-click
  copies-or-pastes) and the `WebLinksAddon`: a terminal without them has NO
  copy path, and the failure is silent — the sandbox login terminal shipped
  that way, so the OAuth URL could not be moved to the host browser while the
  CLI's own "Copied!" (written to the CONTAINER's clipboard) said otherwise.
- **Sandbox mode (🏺 Docker rail view, SBX1–SBX5)**: per-project
  toggle that runs NEW sessions inside a persistent Docker/Podman container
  (`kory-sbx-<hash12>`, project bind-mounted at `/work`, `sleep infinity` +
  one `docker exec` per session via a launch script under `/kory-run` — no
  PowerShell→bash double quoting). Deterministic per-project naming, shared
  `kory-claude-auth` volume on `~/.claude` (one CLI login for every project,
  done in a blocking first-run modal with an embedded auth terminal — agents
  cannot spawn until authenticated, `sandboxGate` in create-session.ts). That
  volume is app-wide, so the login, its probe and its wipe all run in a
  THROWAWAY `--rm` container mounting only `kory-claude-auth`: no project
  container is involved, only the (also app-wide) image that carries the CLI.
  The broker is bridged through `host.docker.internal`, supervisor exempt
  (host-side pilot). Containers are STOPPED on app close, never removed — lifecycle
  (start/stop/rebuild/remove) lives in the Docker rail view, guarded by
  `hasLiveSessions()` exactly like the toggle. Settings in app-state
  `sandbox.json` (operator-owned, never the repo). Design + jalons M2/M3:
  commits `32d2249` (M1) and `959c98f` (M2/M3); operator docs:
  `desktop/docs/sandbox.md`.
- **Remote approvals (opt-in, `mobileApprovals`)**: when a session blocks, the
  question is parked broker-side and can be answered from elsewhere; the Deck
  holds the ONLY credential able to settle one. Three producers, because the
  kinds of question differ: the embedded plugin's `PermissionRequest` hook
  (structured detection — it fires only when a permission dialog appears,
  unlike `PreToolUse` which would fire on every tool call; it does NOT block,
  since Claude Code is already waiting on its own dialog and keeps waiting), the `ask_operator`
  MCP tool (open questions — no hook covers `AskUserQuestion` or plan
  approval, and the tool's return value IS the answer, so free text reaches
  the agent with no keystrokes), and `attention.ts` as the fallback for
  non-Claude CLIs. Answering IN the Deck settles the approval, which
  invalidates the remote notification (and vice versa — the broker's
  conditional update makes them exclusive). Verdicts that must be typed go
  through `buildKeystrokes`, which is deliberately conservative (allow = a
  bare Enter on the highlighted option, deny = Escape rather than guessing a
  "no" index that could land on "yes, and don't ask again") and appends the
  submitting Enter itself — a remote answer can never carry its own.
  Three channels are enrolled from `Settings > Notifications`: Telegram and
  Discord take a bot token, the **Parastatès** row takes an ntfy relay
  address (the broker mints the topics) and answers with a QR that is a
  CREDENTIAL — it carries the topics and the access token, so it is shown
  under a danger-coloured warning and dropped on Done. `approvals:connect`
  stays in `REMOTE_BLOCKED_CHANNELS`: a paired phone must never enrol a
  channel, and now even less so.
  Enabling is `global AND NOT project-opt-out`: a project can restrict, never
  enable. Identity lives in the app-state dir, which is per OS user, so two
  Windows accounts on one machine are compartmentalised without a line of code
  deciding it. Hooks fail CLOSED: no credential, broker down or budget spent
  yields no decision at all, leaving the native dialog up.
- **Supervisor (Home rail)**: a Claude session piloting the app through a
  loopback deck-control endpoint + dependency-free MCP stdio bridge, injected
  only into the supervisor via a generated `--mcp-config`.
- **Team spawn (TS1–TS5)**: the supervisor composes and spawns
  whole agent teams. `deck_team_playbook` serves the hardcoded team-building
  skill (consent rule, roadmap/prompt decomposition, sizing, briefing/ack
  contracts) and `deck_team_agents` a 6-role embedded fallback catalog
  (`team-embedded.ts` — team-lead/developer/reviewer/explorer/debugger/
  test-engineer, code constants referenced BY ID, injected via
  `--append-system-prompt-file`, read-only roles hardened with
  `--disallowedTools`; an embedded team-lead takes the window crown only when
  none is live). `deck_spawn_session` gains `cli` (contract-frozen, only
  `claude` accepted until the multi-CLI lot), `embedded_agent` and
  `wait_for_peer` (default true: the call returns the peer_id);
  `deck_spawn_team` spawns a whole plan in one call with async acks — the
  Deck (script, not inference) watches `peer-resolved` and taps the
  supervisor with a targeted CODE-CONSTANT announce as each session connects
  or fails to (120 s timer, early-fail on exit). Spawns pass the operator
  trust-mode gate (`config.supervisorSpawnMode`, Settings > General):
  `hands-free` (default, consent rule enforced at system-prompt level),
  `team-review` (one native recap dialog per plan), `full-control` (one
  dialog per agent). The broadcast fired when a fresh session's peer_id
  resolves is separately gated by `config.joinAnnounceLevel` (Settings >
  General, card `8cb54a0f`): `off` (default, no announce), `lead` (only the
  active team-lead session(s) by `role`, falling back to the active
  supervisor(s), silent if neither exists), `all` (the historical
  broadcast-to-everyone). Resolved per this Deck window's own `service.list()`
  only, same locality as the spawn-ack tap above.
- **Locked harnesses (C8 rule)**: every agent prompt (supervisor, plan import,
  reviewer, dispatch, digest, help assistant, context wand, graph chat/merge/
  judge) is a CODE CONSTANT, never operator- or repo-configurable. One-shot
  helpers (help, digest, wand — `utility-inference.ts`) target any catalog
  model (`config.helpTarget` / `config.wandTarget`) and run read-only per
  CLI: `claude -p --strict-mcp-config --disallowedTools` (Read/Grep/Glob
  stay), `codex exec --sandbox read-only`, `gemini --approval-mode plan`,
  `agy -p` (Antigravity — context via a "read this file" instruction +
  `--add-dir`, `--print-timeout` bound, run under a PTY via `pty-run.ts`
  because agy misbehaves without a TTY); local endpoints are pure chat
  (no tools).
- **Graph chat (🕸 rail view)**: per-project chat graphs where every exchange
  is a node and the graph is the source of truth — each assistant node is ONE
  stateless headless invocation whose context is recompiled from its
  ancestors (`graph-engine.ts`, `shared/graph.ts`). DAG: branch anywhere,
  cross N nodes into a fresh prompt node; multi-parent nodes get a
  documentary three-way merge rendering (common trunk once + labeled
  divergent branch sections — never a fake linear history). Fan-out targets
  `claude -p` / `codex exec --sandbox read-only` / `gemini` / local HTTP
  endpoints, the compiled context traveling by FILE
  (`--append-system-prompt-file` or stdin — never the command line). Battle
  mode adds a 🏆 judge node arbitrating the anonymized answers. Persistence
  is desktop-local per project_key (`graph-store.ts`), encrypted at rest via
  the safeStorage-backed cipher (K8: envelope with a base64 payload; legacy
  clear files are re-encrypted on first list; clear-text fallback when the OS
  keychain is unavailable so the feature never breaks). Graph drafts: the
  main process polls the broker's pending `graph_drafts` (agent-escalated
  questions, see ARCHITECTURE.md) — they surface as action cards in the ✉
  inbox with a pulsing rail glyph (`is-glowing`), and "Open in graph" creates
  a doc with the pre-filled unsubmitted prompt node, flips the draft
  broker-side, and navigates the graph view onto it (`graphFocus` in the
  store). The inbox itself is persisted to `inbox-history.json`
  (`inbox-store.ts`) because the broker drain is destructive.
- **Roadmap (🗺 rail view)**: kanban board over the broker's shared roadmap —
  one column per status (idea/planned/in_progress/done, + archived behind the
  toggle), MoSCoW priority as a colored chip + in-column sort, native HTML5
  drag & drop between columns (`RoadmapView.tsx`). Dropping on done asks for
  confirmation; a card locked by an agent (K2 work-lock: the broker locks an
  item whose status an agent set to in_progress) is greyed, non-draggable and
  carries a 🔒 `locked_by` badge. Clicking a card opens a foreground detail
  modal (`RoadmapItemModal.tsx`) rendering description/rationale/context
  through the injection-safe markdown tokenizer (`markdown.ts` — token tree,
  React escapes every text node; agent links are shown, never navigated).
  The ⏹ Stop button on a locked item routes a CODE-CONSTANT stop notice
  through the live supervisor when there is one (report back via the operator
  inbox) or broadcasts it to the group, then unlocks the item back to planned
  (`stopRoadmapItem`, `composeStopText`). An idle-lock watcher releases locks
  held by local tiles whose PTY printed nothing for 2 h; the broker's
  TTL/owner-gone sweep covers everything the Deck cannot observe. Right-click
  on a card opens a context menu (edit / queue-or-unqueue / process-now /
  delete-as-archive); "Process now" targets one live agent with a CODE-CONSTANT
  announce (`composeAssignText`, IPC `roadmap:assign`) or spawns a fresh one.
  Below the board, the **Workflow lane** (`WorkflowLane.tsx`) draws the
  dispatch queue as a left-to-right chain of cards, GraphView-style (manual
  camera, SVG edges, no library): every position is DERIVED
  (`shared/workflow.ts`), hierarchy-first — the column is the `depends_on`
  DEPTH inside a connected component, so parallel branches (N:1 / 1:N
  fan-ins) stack vertically in the same column, while unrelated components
  chain left-to-right by queue rank (a dependency-free queue stays a flat
  chain). Nothing visual is persisted, so the lane always agrees with the
  kanban. Cards drag in from the board (HTML5 DnD) or reorder in place
  (insertion caret between columns); dropping a card clearly above/below
  another (grid-assisted dashed slot) makes it a PARALLEL SIBLING — it
  adopts the target's dependencies (`siblingDeps`, sanitized + cycle-checked)
  — and commits go through ONE atomic `roadmap:reorder` IPC → broker
  `/roadmap/reorder`. Dependency-RELATED cards can never be parallel: the
  stack slot is not offered between them (`dependsRelated` — the card slides
  sideways instead), and while a drag hovers an insertion that would
  wrong-side a link, the link and both cards' borders turn red live
  (`slotConflicts`). Dragging a card's port onto another card wires a
  `depends_on` link (cycle-checked); into the void, it opens the create form
  pre-wired (nothing exists until Save). Edges turn red when the queue order
  breaks a dependency — clicking one explains why and offers to drop the
  link; a warning badge flags dependencies neither scheduled nor done.
  Locked cards are frozen here too; zoom wheel/buttons + auto-fit down to a
  floor, then a thin proportional scrollbar takes over; an expand button
  blows the lane up into a fullscreen foreground modal (same component,
  `fullscreen` prop).
- **Replica mode in the Deck (offline replica)**: when the local broker
  replicates a distant one, the Deck reads the replication state off its OWN
  broker and never addresses the upstream — pushing, pulling and relaying
  locks are the local broker's job, so a network cut is invisible to the
  tiles. `/roadmap/sync/status` rides the existing `INBOX_POLL_MS` tick and
  self-gates: outside replica mode it is one probe at startup plus one per
  broker recovery, and only a broker that positively answers `replica` also
  gets `/roadmap/sync/conflicts` polled for the current project. The
  `roadmap:sync` broadcast fires on a signature change only (health fields +
  each conflict's upstream `content_rev`, so an edit landing on an already
  conflicted card is not mistaken for "nothing moved"). A broker with no
  `/roadmap/sync/status` route at all is a VERSION gap, not an outage: the
  404 parks the poll on a terminal internal `legacy` mode (never a protocol
  mode, never broadcast) and pushes one inert `{ mode: 'local' }` state, and
  only a broker-health up-flip re-arms the probe. Renderer side: a
  numeric badge on the Roadmap rail entry (this project's conflicts, never
  the broker's cross-project counter); ONE status banner over four
  overlapping states, arbitrated by the pure `bannerKind`
  (`shared/status-banner.ts`) since the bar is a fixed overlay — local broker
  down (red) > conflicts awaiting arbitration (amber, and the only banner
  carrying an action, "open the Roadmap": they appear exactly when the
  offline banner disappears) > pushes the upstream REFUSED, `last_error` as
  the detail (amber) > upstream unreachable (neutral info tone: the local
  broker is up, work continues, only the sharing is paused); a red ring + a
  clickable badge on a conflicted
  card, an amber ring on a contested lock, the lock glyph with a "remote
  lock" title for one held upstream, and `RoadmapConflictDialog` listing ONLY
  the content fields that differ (lifecycle `status`/`deleted_at` first) with
  the three arbitrations `remote` / `local` / `merge_reopen`. The choice is
  re-validated main-side against `ROADMAP_SYNC_RESOLUTIONS` before it reaches
  the broker, and every broker response goes through the pick-list sanitizers
  of `roadmap-service.ts` whose defaults are inert: an unreadable status reads
  as a non-replica broker, an unknown `sync_state` as `clean`, an unknown
  `lock_scope` as null. The opt-in itself is reachable from **Settings >
  Broker**: a read-only report of the resolved mode (the three shapes
  explained side by side), the broker URL, whether a bearer token is
  configured (yes/no — the value never crosses the IPC boundary) and which
  `CLAUDE_PEERS_*` variable is deciding instead of the file, plus the
  `offline_replica` checkbox. No token is a WARNING, never a disable (the
  operator can add one right after ticking): the upstream's replication routes
  answer 403 without one, and that surfaces as "upstream unreachable", a
  symptom saying nothing about its cause. A read that fails renders an explicit
  error with a re-read button — a category rendering nothing reads as a broken
  app, and the main-side `reportError` is invisible to the operator. That checkbox writes the claude-peers CORE
  config (`peers-config-store.ts`: read-modify-write preserving every other
  key, atomic, 0600, and a file it could not parse is never overwritten) —
  the same file `server.ts`, `cli.ts` and every non-Kory session read, so the
  channel is tier 3 / remote-blocked and the help text says plainly that the
  change only reaches sessions and brokers started afterwards.
- **Files & Git rail views (GX1–GX9)**: two READ-ONLY rail
  views. 📁 Files: lazy explorer + plain-text viewer (line-number gutter, no
  highlighting in v1 — shiki/highlight.js noted for v2) over roots the main
  process re-validates on EVERY call (project dir, worktrees, live session
  cwds; `explorer-service.ts` — realpath containment incl. symlinks, 512 Ko
  cap, binary sniff). ± Git: SCM-style diff browser per worktree/session dir
  (`collectDiff` + per-file `collectFileDiff`, repo-relative path enforced),
  DiffPanel's colorizer reused, one-shot reviewer button. Viewer selection
  flows to the help assistant (`HelpSelection` → `code_selection` in the
  system snapshot, `helpSeed` in the store) or prefills a roadmap draft
  (`roadmapSeed`, wand-style: saving stays manual). NO stage/commit/branch
  action, even delegated — operator decision; both views are desktop-only on
  mobile (`mobile-views.ts`).
- **Browser REC — screen recording + scripted demo (🌐 toolbar)**: the
  embedded browser's REC button records a demo-ready video (MP4 when the
  runtime muxes it, else WebM; saved under app-state `recordings/`) of the
  browser pane (canvas crop, `shared/recording.ts`) or the whole window —
  `getDisplayMedia` is answered main-side with the Deck's OWN window only
  (`setDisplayMediaRequestHandler`, no OS picker). The dialog's optional
  **scripted scenario** hands the prompt to a one-shot demo-driver agent
  (`demo-driver.ts`, C8 code-constant harness, `config.demoTarget` — Sonnet
  default, claude-only: the browser bridge rides `--mcp-config`) that drives
  the webview through a PER-RUN loopback endpoint + token (`demo-control.ts`,
  never the supervisor's deck-control token) with five `demo_*` tools
  (read/navigate/click/type/wait — real `sendInputEvent` clicks/keystrokes,
  `browser-drive.ts`; agent strings enter page scripts JSON-encoded only,
  `browser-drive-scripts.ts`); recording auto-stops when the scenario ends.
  Docs: `desktop/docs/browser-design.md`.
- **Unified model picker** (`ModelPicker.tsx`, `shared/models.ts`,
  `model-registry.ts`): provider accordion + star-pinned favorites, shared by
  the graph fan-out and the agents' create menu. Frontier providers
  (Anthropic/OpenAI/Gemini/Antigravity — bins `claude`/`codex`/`gemini`/`agy`)
  appear only when their CLI is detected
  (login-shell probe, cached); their model lists are curated in code
  (`FRONTIER_CATALOG` is the one constant to bump). Local OpenAI-compatible
  endpoints (Ollama, LiteLLM…) are configured in Settings > Models and
  discovered dynamically (`/v1/models`, `/api/tags` fallback); their API keys
  are encrypted at rest via safeStorage (`provider-secrets.ts` — the renderer
  only ever sees a `hasKey` marker).
- **Usage limits (amphora rail button)**: the amphora's liquid level IS the
  mean remaining session (5 h) quota of the providers this run draws down —
  live tiles + inference targets marked via `markProviderUsed`, math in
  `shared/usage.ts`, 5-min renderer poll — and the glyph's tone shifts green /
  amber (≤30 % left) / red (≤10 %). Clicking opens a foreground modal
  (`UsageLimitsModal.tsx`, IPC `usage:read`, `main/usage-service.ts`) stacking
  the subscription quota gauges of the DETECTED frontier CLIs — Claude Code
  (`api.anthropic.com/api/oauth/usage` with the token from
  `~/.claude/.credentials.json`; UA `claude-code/<version>` mandatory), Codex
  (`codex app-server` JSON-RPC `account/rateLimits/read`, fallback: the
  rate_limits snapshot persisted in the newest `~/.codex/sessions` rollout,
  flagged stale) and Antigravity (`cloudcode-pa` `retrieveUserQuotaSummary`
  pools gemini/3p × 5h/weekly, OAuth blob read from the OS keyring, in-memory
  refresh). Gemini CLI is intentionally NOT a provider (individual accounts
  cut 2026-06-18, migrated to Antigravity). All three mechanisms are
  reverse-engineered (operator-approved risk): every failure degrades to a
  per-provider status, never a throw; tokens never cross the IPC boundary
  (reports carry percentages only); snapshot cached 3 min main-side because
  the Anthropic endpoint rate-limits aggressive polling.
- **Security gates**: any value that comes from a CLONED REPO (project
  `.claude/claude-peers/config.json`, project-local `templates/*.json`) and
  reaches a shell / spawn is an RCE vector, so it is either GLOBAL-config-only
  or approval-gated. Reuse `launch-approval.ts` (sha256 per project_key,
  one-time operator dialog) — never invent a new trust store, and never put the
  trust decision in the repo. Currently gated: project `launchCommand`, project
  `worktreeInit`, and a repo-local template's shell-bearing `command`/`args`
  (`resolveTemplateInputs` in `index.ts`). GLOBAL-only (never read from a repo):
  resume-digest sources. Separately, `agent`/`model`/`args` interpolated into
  the login-shell command line are allow-listed + quoted (`sanitizeFlagValue` /
  `quotePromptArg` in `session-command.ts`) — add new interpolated fields the
  same way, never raw. `config:set` refuses a `projectDir` override (it would
  repoint every project-scoped resolver past the boot gate).
- **Companion LAN access (MB1–MB6)**: the 📱 button starts an
  HTTPS+WebSocket server (`main/companion-server.ts`) that serves the built
  renderer bundle to a phone on the LAN and bridges the DeckApi protocol
  (`shared/companion.ts` manifest → `main/api-registry.ts` handler table →
  `renderer/src/remote-api.ts` shim). Web-remoting, NOT pixel streaming: the
  phone runs the same renderer, flipped to a mobile layout (`.is-mobile`, only
  ever for a remote coarse-pointer client — the desktop window is untouched).
  Ephemeral session model: one-shot QR token → per-run credential, closing the
  app revokes; the operator can also list + revoke paired devices (lost-phone
  kill switch: `companion:devices`/`revoke`/`revoke-all`, `CompanionAuth`
  device map). When adding a DeckApi method, touch ALL of: the `DeckApi` type
  (`shared/types.ts`), `COMPANION_MANIFEST` (a `satisfies` clause makes a miss a
  compile error), `CHANNEL_TIERS` (every invoke/send channel needs a tier), the
  `preload/index.ts` bridge — and add it to `REMOTE_BLOCKED_CHANNELS` if it is
  host-only or trust-changing (a paired phone must never call it). State events
  reaching the phone must go through
  `broadcast()` (not `mainWindow.webContents.send`); window-only events
  (menu:*, design:pick, session:focus, inbox:open) stay on the window.
  `CompanionInfo.certFingerprint` (SHA-256 of the served certificate) rides in
  the QR as `&f=` so the Android shell can PIN this host; a browser ignores it.
- **The Android shell (`mobile-shell/`, N5)** carries TWO features that must
  not be merged: *companion* (this LAN mirror, now a LIST of paired Decks with
  a selector — nothing changes here, each Deck keeps its own server) and
  *approvals* (ntfy, reachable anywhere, tied to an operator identity, and it
  must work with no Deck reachable at all). Separate storage, separate
  lifecycles, separate threat models. Its decision logic is pure TypeScript
  under `bun test`; the Kotlin in `android-src/` is uncompiled here (no SDK)
  and therefore decides nothing. Resuming a host needs no change on this side:
  `connectRemoteApi` already boots from a stored credential, so the shell
  seeds `COMPANION_CRED_STORAGE_KEY` before navigating.

## Error reporting & logs (PLAN-observabilite O3–O6)

- The main process logs to a rolling `main.log` under `app.getPath('logs')`
  (`desktop/src/main/log.ts`); `reportError(scope, msg, err)` is the single
  sink (file + console in dev + a journal `error` entry). The renderer reaches
  it via `window.api.reportError` / the store's `guarded()` wrapper.
- Process nets live in `index.ts`: `uncaughtException`/`unhandledRejection`
  (log-and-continue once the app is ready; dialog + exit before),
  `render-process-gone` (reload offer), `child-process-gone`.
- Every top-level view is wrapped in an `ErrorBoundary` (App.tsx) — a render
  crash falls back per-view, terminals survive. Wrap new views the same way.
- Broker reachability: `BrokerHealthTracker` (broker-client.ts, fed by the
  inbox poll, 2-failure hysteresis) → `broker:status` → the renderer's red
  `StatusBanner`. Outages are a banner (state), never toasts (events).
- Toast policy: `showToast` is reserved for direct user-action outcomes,
  throttled per key; `error` variant carries raw text (`{ raw: true }`).
- The activity journal flushes to `logs/journal-<date>.log` at quit (pruned
  after 7 days). Full conventions: `.claude/skills/error-reporting/`.

## Renderer view conventions (canvas views especially)

Micro-conventions inferred from the existing views — follow them when
touching `GraphView.tsx` or building anything canvas-like:

- **Dependency-free rendering**: SVG edges + absolutely-positioned divs,
  manual camera (`translate/scale` on a world div). No graph/layout library.
- **Pure logic goes to `desktop/src/shared/`**: anything main AND renderer
  need (or that deserves a bun test) lives there with no electron/node
  imports — e.g. grid constants, `layoutGraph`, `outlineOrder` in
  `shared/graph.ts`. The renderer imports via the `@shared/` alias.
- **Persistence pattern**: clone-and-replace the doc in local state, then
  save through one `mutateDoc(next, debounce?)` helper (400 ms debounce for
  keystroke/drag streams, immediate otherwise).
- **Canvas overlays** (toolbars, panels floating over the canvas) must
  `stopPropagation` on `mouseDown`/`click` (and `wheel` if scrollable),
  otherwise the canvas pan/deselect handlers swallow the interaction.
- **Reuse the app chrome**: `btn`, `icon-btn` (+ `.is-active`), CSS variables
  (`--bg*`, `--fg*`, `--accent`, `--selected`, `--border`). Node-kind colors
  are centralized in the `--graph-k-*` variables (styles.css) — timeline
  bullets, card accents and edges must all read from them.
- **i18n**: no hardcoded UI strings — see "Adding a UI string" in
  `TESTING.md` (three files, parity-tested).
