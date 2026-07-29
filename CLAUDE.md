# Koryphaios / claude-peers

Two products in one repo:

- **claude-peers (core, repo root)** — peer discovery and messaging MCP channel
  for Claude Code instances: sessions on the same machine (or sharing a remote
  broker) see each other, exchange messages scoped to isolated groups, and
  share a persistent per-project roadmap.
- **Koryphaios (desktop, `desktop/`)** — Κορυφαῖος, the chorus leader: an
  Electron orchestrator docking multiple Claude Code sessions in one window
  (npm package `koryphaios`, bin `kory`). Session tiles, workspaces and
  templates, git worktrees per agent, a supervisor session that pilots the app
  through a dedicated MCP bridge, a shared roadmap view, an operator inbox,
  diff review, an embedded browser, a graph-chat canvas with multi-model
  battle mode, and a unified model picker (frontier CLIs + local
  OpenAI-compatible endpoints).

Release history and per-batch narratives live in `CHANGELOG.md`; the remaining
open work (to-do / to-verify / deferred, incl. the security backlog) is
centralized in `BACKLOG.md`. Code comments reference chantier ids (`C1`…`C29`,
`D1`…, `MB1`…, `TS1`…, `GX1`…, `CT1`…, `SBX1`…, `N0`…`N5`) from past working plans. Those standalone working
docs (`PLAN-*`, `EXPLORATION-*`, `AUDIT-*`) were consolidated and removed: the
shipped design decisions are summarized in the CHANGELOG entry of the batch that
shipped them, the open residual lives in `BACKLOG.md`, and the full detail
(exploit chains, design alternatives) stays in git history.

## Detailed docs (read on demand)

Only read the file matching the area you are touching:

- Working on the core (`broker.ts`, `server.ts`, `cli.ts`, `shared/`) — read
  `ARCHITECTURE.md` (entrypoints, endpoints, roadmap, delivery
  hardening, Deck announcements, identity model, resume flow).
- Working on the desktop app (`desktop/`) — read `DESKTOP.md`
  (Electron stack, sessions, supervisor, graph chat, model picker, security
  gates).
- Creating or modifying anything VISUAL in `desktop/` (CSS, buttons, colours,
  badges, icons, a new view's look) — read `DESIGN.md` (design tokens, colour
  semantics, control archetypes, iconography, UI checklist). Two hard rules
  travel with it: **no control keeps its native look** — that is every
  `<button>`, `<select>`, `<input>`, `<textarea>` and checkbox, not just
  buttons (a square white dropdown is the same bug as a grey OS button, and it
  is the one that keeps shipping) — and NO EMOJI in the UI, every icon being a
  Greek-styled SVG glyph from `components/icons.tsx`. When a control type has
  no rule yet, style it at the ELEMENT level in `styles.css` so the NEXT one is
  themed by default; a per-instance class only fixes the instance in front of
  you. The `deck-design` skill (`.claude/skills/deck-design/SKILL.md`) wraps
  the workflow.
- Writing or running tests, or preparing a commit — read `TESTING.md`
  (test suite layout, smoke check, typecheck, locale parity).
- Adding a model/provider to the pickers, touching a headless inference
  point (help, wand, digest, graph, judge), or verifying non-Anthropic
  CLI/API syntax — the `model-providers` skill
  (`.claude/skills/model-providers/SKILL.md`).
- Adding a navigation-rail VIEW and/or a `DeckApi` IPC channel to the desktop
  app (no broker involved) — the `add-deck-view` skill
  (`.claude/skills/add-deck-view/SKILL.md`). For an agent→broker→Deck feature
  instead, use `add-broker-feature`.
- Touching SANDBOX mode (`desktop/src/main/sandbox-*.ts`, the Docker rail
  view, or anything that decides WHERE a session executes) — read
  `desktop/docs/sandbox.md` (behavior, guards, the copy-not-mount rule) and
  the "Sandbox mode" CHANGELOG entries (why each decision was taken).
  DEBUGGING it (login loops, missing projected config, slow spawns, volume
  state) — the `sandbox-debug` skill (`.claude/skills/sandbox-debug/SKILL.md`)
  holds the field probes and the confirmed root-cause catalogue.
- Bun runtime / API conventions (which libs to use or avoid) — read
  `BUN.md`.
- Building a Bun-served frontend (HTML imports, React) — read
  `FRONTEND.md`.
- Picking up open / deferred work (security backlog, v2 features, pending
  visual/E2E validations) — `BACKLOG.md` (the single consolidated to-do list).

## Conventions (always apply)

- **Who is actually running this.** Every design decision has to hold for the
  real deployments, not for the single-user single-machine case that is easiest
  to picture:
  - the broker is **local** (auto-spawned on the operator's PC) **or on a
    shared server** reached over HTTP;
  - a shared broker serves **several people**;
  - one person runs **several sessions at once**, across **several PCs they
    own** — usually linked to ONE `operator_id`, but not always (two OS
    accounts are two identities by construction);
  - so the same human may hold two identities, and one identity may be reached
    at the same address twice.

  The failure mode is always the same shape and it is always SILENT: some
  singleton is keyed by too little. Concretely, this repo has already shipped
  three of them — a gateway table keyed by channel `kind` (the second operator
  to enrol replaced and stopped the first one's), an authorisation that
  resolved an address to "its" operator and compared (`.get()` picked one of
  two rows, refusing half the answers as "already handled"), and `hostname()`
  used as an identity (two OS accounts share it). Before adding a `Map`, a
  cache, a table, a lock or a `SELECT … LIMIT 1`, answer: **keyed by what, and
  what happens when there are two?** And ask the authorisation question in the
  direction that survives a second identity — resolve the OBJECT first, then
  "may this caller act on THAT object", never "who does this caller belong to".

- **No literal control bytes in a source file.** Write `\0`, `\x1b`, `\x07` as
  escapes. A single embedded NUL makes git classify the file as **binary**: the
  diff becomes `Bin 4555 -> 7157 bytes`, `git blame` dies, 3-way merge dies,
  and `grep`/ripgrep refuse to show its contents — a whole module silently
  drops out of code search. Precedent: `notify/registry.ts` shipped that way
  and its entire rewrite was unreviewable.

- Default to Bun instead of Node.js: `bun <file>`, `bun test`, `bun install`,
  `bunx`. Exception: `desktop/` builds with electron-vite/npm (native module
  `node-pty` rebuilt for Electron). Details in `BUN.md`.
- Before committing: `bun test`, the smoke check
  (`bun build --target=bun broker.ts server.ts cli.ts --outdir=/tmp/cp-check`),
  and `npm run typecheck` in `desktop/` if it was touched. Details in
  `TESTING.md`.
- **No silent errors.** Never write `catch {}` / catch-and-return-default
  without leaving a trace in the layer's log sink — a `console.error` alone is
  NOT a trace (invisible in the packaged app, and lost when the broker outlives
  its spawner's stderr). Route errors to the rolling log files: core
  (broker/server) via `shared/logger.ts`; Deck main process via
  `reportError()` from `desktop/src/main/log.ts` (also journals the entry);
  renderer via `window.api.reportError` or the store's `guarded()` wrapper.
  Only swallow silently when the fallback is truly equivalent (documented
  best-effort caches). Full conventions per layer: the `error-reporting`
  skill (`.claude/skills/error-reporting/SKILL.md`).
- **A comment or a class that ASSERTS a guarantee must be wired to it.** This
  repo explains itself in prose more than most, which makes the opposite
  failure cheap to commit and expensive to find: `PinnedTrust.kt` described
  trust-on-first-use, implemented it correctly, and was instantiated by
  *nothing* — so certificate pinning read as done for weeks while the app
  accepted any certificate. Dead code claiming a security property is worse
  than no code, because it stops anyone looking. When you write "X is
  enforced", grep that the enforcer is called. The same check applies to
  EVENT CHANNELS: a `DeckApi.onX` declared in types, multiplexed in the
  preload and subscribed in the store compiles and tests green with NO
  producer — `sandbox:changed` shipped fully wired on the consumer side while
  nothing ever emitted it, so the UI only moved when another view happened to
  poll. When you add or review an `onX`, grep the EMITTER
  (`broadcast('<channel>'` / `send('<channel>'`), not just the listener.
- **A new validator needs every call path enumerated, not just the one you're
  looking at.** When adding a validator (clamp, sanitize, parse), enumerate
  ALL its potential call paths — a live gesture, a persisted-state
  restore/load, an automatic-placement heuristic, an IPC entry point — and
  wire or consciously exempt each one; numeric validators must reject `NaN`
  explicitly (`NaN` passes every comparison-based clamp silently, since every
  `<`/`>` against `NaN` is `false`). Three instances of exactly this bug
  shipped in one day: `clampNodeSize` not wired into `findFreeSpot`,
  `clampLaneHeight` not wired into the restore-time seed, `viewportH` left
  unguarded despite a comment claiming otherwise.
- **Review against what a commit SHOULD contain, not just the diff it shows.**
  The costliest defects are invisible in the diff itself: a commit
  referencing a file that only ever existed in the working tree; a
  millisecond-resolution sort key that silently drops rows on a tie; a
  validator wired to only one of its two callers; a prop default that
  de-flags a confirmation outside the diff's hunks. The question that catches
  these: "what should this commit contain, and what does it NOT show?" — the
  derived git habits (explicit staging by filename, `git show --stat` after
  every commit, `cat-file -e` on imports touching co-edited files) are
  consequences of this principle, not the principle itself.

- **Five hostile inputs, never trusted.** (1) A value from a CLONED REPO
  (project `.claude/claude-peers/config.json`, project-local `templates/*.json`)
  that reaches a shell/spawn must be GLOBAL-config-only or approval-gated —
  reuse `launch-approval.ts`, never put the trust decision in the repo (see the
  "Security gates" section of `DESKTOP.md`). (2) A message/peer field crossing
  the broker HTTP boundary must never carry `instance_token`/`from_token`/PIDs —
  project through `toPublicPeer` / `resolveSenderMeta` in `broker.ts`. (3) An
  IPC argument from the renderer OR the companion that becomes a FILESYSTEM
  PATH, a git target, or a spawned cwd must be re-validated MAIN-side against
  the work-dir allow-set on every call (`workDirRoots` / `requireWorkDir` in
  `ipc.ts`; realpath containment for the leaf via `resolveWithin` /
  `realpathWithin`) — the companion `CHANNEL_TIERS` tier is a declaration, NOT
  an access gate, so a tier-0 "read" channel with an unvalidated `dir` is an
  arbitrary-file-read (the GX-SEC finding: `git diff --no-index` dumping any
  file). (4) A string produced by a SPAWNED AGENT (MCP tool args crossing a
  loopback control endpoint — deck-control, demo-control) that reaches
  `executeJavaScript`, a page, a terminal or a command line must be
  encoded/validated at the boundary, never string-glued (precedent:
  `browser-drive-scripts.ts` JSON-encodes every agent selector; directive
  commands are re-validated enums). (5) Anything MOUNTED INTO a sandbox
  container is a capability granted to code you assume is compromised — the
  host `~/.claude` is therefore COPIED in, never mounted (a mounted
  `settings.json` lets a sandboxed agent plant a hook that later executes on
  the HOST, defeating the sandbox), secrets are excluded from the copy-mode
  clone by a deny-list that outranks any operator glob, and a container name
  or command coming back from the renderer/an agent is re-validated
  main-side before it reaches the engine CLI (`sandbox-command.ts` /
  `sandbox-projection.ts` / `sandbox-copy.ts`). When you add a config field,
  template field, shell-interpolated arg, broker response field, a path/dir
  IPC arg, an agent-facing tool arg, or a new sandbox mount/projection,
  decide which of these it is BEFORE wiring it.
- **Comparing two paths? Canonicalize both.** A path YOU built (`join`,
  `resolve`, an IPC arg, a stored cwd) and a path an EXTERNAL TOOL reports
  (git, docker, a child process) are not string-comparable: macOS tmpdirs are
  symlinked (`/var` → `/private/var`) and Windows can hand back an 8.3 short
  name, and the external tool always answers with the REAL path. Run both
  sides through `canonicalPath` (`worktree-service.ts` — `realpathSync.native`,
  falling back to `resolve` when the path does not exist yet) before `===`,
  `startsWith` or a `Map` key. Precedent: `removeWorktree` denied a worktree it
  had just created, and the sandbox re-hit it on the mount/transcript lookups.
  **Linux CI cannot see this class of bug** — its tmpdirs are not symlinked —
  so the regression test must build the symlinked prefix itself (see
  `TESTING.md`, "Cross-platform tests").
- **Naming a scratch/plan/report doc?** `.gitignore` silently excludes
  `findings.md`, `task_plan.md`, `progress.md`, `progress-archive.md`, `docs/`,
  and `.claude/session-checkpoint.md`. A deliverable you intend to commit (audit
  report, plan, notes) must use a different name, or it vanishes from `git add`.

## Running

See `README.md` for full setup. Quick references:

```bash
# Local mode (broker auto-spawned alongside server.ts):
#   .mcp.json: { "mcpServers": { "claude-peers": { "command": "bun", "args": ["./server.ts"] } } }
claude --dangerously-load-development-channels server:claude-peers

# HTTP mode (broker publicly accessible, server.ts runs locally):
#   config.json: { "broker_url": "http://broker:7899", "broker_token": "secret" }
#   broker side: CLAUDE_PEERS_BIND_HOST=0.0.0.0 CLAUDE_PEERS_BROKER_TOKEN=secret bun broker.ts
#   .mcp.json: { "mcpServers": { "claude-peers": { "command": "bun", "args": ["./server.ts"] } } }

# CLI (run on the broker host):
bun cli.ts status
bun cli.ts peers [--include-dormant]
bun cli.ts groups
bun cli.ts kill-broker        # Linux/macOS only (uses lsof)
```
