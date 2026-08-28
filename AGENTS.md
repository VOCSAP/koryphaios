# Koryphaios / claude-peers

Two products in one repo:

- **claude-peers (core, repo root)** -- peer discovery + messaging MCP channel
  for Claude Code instances: sessions on same machine (or sharing remote
  broker) see each other, exchange messages scoped to isolated groups, share
  persistent per-project roadmap.
- **Koryphaios (desktop, `desktop/`)** -- Κορυφαῖος, chorus leader:
  Electron orchestrator docking many Claude Code sessions in one window
  (npm package `koryphaios`, bin `kory`). Session tiles, workspaces +
  templates, git worktrees per agent, supervisor session piloting app
  through dedicated MCP bridge, shared roadmap view, operator inbox,
  diff review, embedded browser, graph-chat canvas with multi-model
  battle mode, unified model picker (frontier CLIs + local
  OpenAI-compatible endpoints).

`CHANGELOG.md` was removed 2026-08-28 (operator decision, pre-1.0, no
external users, commit bodies already carry richer narrative than its
entries did). The narrative of a shipped lot now lives ONLY in the body of
the commit that delivered it, found by `git log --all --grep "Card <id8>"`
-- the only correct retrieval form by construction, since the citation lives
in the commit MESSAGE, not its content, so neither `-S` nor `-G` finds it.
Release history from before v1.0 stays fully consultable, nothing lost --
only the living file is gone: `git show 0d5a4cb:CHANGELOG.md`. Remaining
open work (to-do / to-verify / deferred, incl. security backlog) centralized
in `BACKLOG.md`. Code comments reference chantier ids (`C1`…`C29`,
`D1`…, `MB1`…, `TS1`…, `GX1`…, `CT1`…, `SBX1`…, `N0`…`N5`) from past working
plans; historical only, artifact of agents self-tagging comments with their
spec ids -- do not add new ones. Those standalone working docs (`PLAN-*`,
`EXPLORATION-*`, `AUDIT-*`) consolidated + removed: shipped design decisions
live in the commit body of the batch that shipped them, open residual
lives in `BACKLOG.md`, full detail (exploit chains, design alternatives)
stays in git history.

## Detailed docs (read on demand)

Read only file/skill matching area you touch:

| Touching | Read | Why |
|---|---|---|
| Core (`broker.ts`, `server.ts`, `cli.ts`, `shared/`) | `ARCHITECTURE.md` | entrypoints, endpoints, roadmap, delivery hardening, Deck announcements, identity model, resume flow |
| Desktop app (`desktop/`) | `DESKTOP.md` | Electron stack, sessions, supervisor, graph chat, model picker, security gates |
| Anything VISUAL in `desktop/` | `DESIGN.md` + `deck-design` skill | tokens, colour semantics, control archetypes, iconography, UI checklist. Two hard rules: **no control keeps its native look** (every `<button>`/`<select>`/`<input>`/`<textarea>`/checkbox -- square white dropdown same bug as grey OS button) and **no emoji**, every icon a Greek SVG glyph from `components/icons.tsx`. Style un-ruled controls at ELEMENT level in `styles.css` so next instance inherits it; per-instance class fixes only this one. |
| Tests or a commit | `TESTING.md` | suite layout, smoke check, typecheck, locale parity |
| Model/provider picker, headless inference point (help, wand, digest, graph, judge), non-Anthropic CLI/API syntax | `model-providers` skill (`.claude/skills/model-providers/SKILL.md`) | -- |
| Nav-rail VIEW or `DeckApi` IPC channel (desktop only) | `add-deck-view` skill | agent→broker→Deck feature instead: `add-broker-feature` |
| SANDBOX mode (`desktop/src/main/sandbox-*.ts`, Docker rail, where session executes) | `desktop/docs/sandbox.md` + commits `32d2249` (M1) and `959c98f` (M2/M3) | behavior, guards, copy-not-mount rule, why each decision taken |
| DEBUGGING sandbox (login loops, missing projected config, slow spawns, volume state) | `sandbox-debug` skill | field probes, confirmed root-cause catalogue |
| Bun runtime / API conventions | `BUN.md` | which libs to use or avoid |
| Bun-served frontend (HTML imports, React) | `FRONTEND.md` | -- |
| Open/deferred work (security backlog, v2, pending visual/E2E validations) | `BACKLOG.md` | single consolidated to-do list |

## Conventions (always apply)

- **Who is actually running this.** Before adding `Map`, cache, table,
  lock or `SELECT … LIMIT 1`, answer: **keyed by what, and what happens when
  there are two?** Failure mode always same shape, always SILENT: some
  singleton keyed by too little. Ask authorisation question in direction
  that survives second identity -- resolve OBJECT first, then "may this
  caller act on THAT object", never "who does this caller belong to". Matters
  because broker can be local or shared server serving several people, one
  person can run several sessions across several PCs (usually one
  `operator_id`, but not always -- two OS accounts are two identities by
  construction), so same human may hold two identities and one identity may
  be reached at same address twice. Three shipped instances: gateway table
  keyed by channel `kind` (second operator to enrol replaced + stopped
  first one's), authorisation that resolved address to "its" operator and
  compared (`.get()` picked one of two rows, refusing half the answers as
  "already handled"), and `hostname()` used as identity (two OS accounts
  share it).

- **No literal control bytes in a source file.** Write `\0`, `\x1b`, `\x07` as
  escapes. Single embedded NUL makes git classify file as **binary**: diff
  becomes `Bin 4555 -> 7157 bytes`, `git blame` dies, 3-way merge dies,
  `grep`/ripgrep refuse to show contents -- whole module silently drops out
  of code search. Precedent: `notify/registry.ts` shipped that way, entire
  rewrite unreviewable.

- Default to Bun instead of Node.js: `bun <file>`, `bun test`, `bun install`,
  `bunx`. Exception: `desktop/` builds with electron-vite/npm (native module
  `node-pty` rebuilt for Electron). Details in `BUN.md`.
- Before committing: `bun test`, smoke check
  (`bun build --target=bun broker.ts server.ts cli.ts --outdir=/tmp/cp-check`),
  and `npm run typecheck` in `desktop/` if touched. Details in
  `TESTING.md`.
- **No silent errors.** Never write `catch {}` / catch-and-return-default
  without leaving trace in layer's log sink -- `console.error` alone NOT a
  trace (invisible in packaged app, lost when broker outlives its spawner's
  stderr). Route errors to rolling log files: core (broker/server) via
  `shared/logger.ts`; Deck main process via `reportError()` from
  `desktop/src/main/log.ts` (also journals entry); renderer via
  `window.api.reportError` or store's `guarded()` wrapper. Only swallow
  silently when fallback truly equivalent (documented best-effort caches).
  Full conventions per layer: `error-reporting` skill
  (`.claude/skills/error-reporting/SKILL.md`).
- **A gating mechanism (discipline test, validator, CI glob, allow-list,
  deny-list, parser feeding a decision) needs its COVERAGE audited, not just
  its sensitivity.** Ask two halves: what degradation yields SUBSET rather
  than error, and what growth of DOMAIN yields same effect untouched. Audit
  deny-lists/omit-projections first: allow-list shrinking fails CLOSED
  (legitimate use refused, surfaces same day); those fail OPEN, silently.
  Sensitivity (fires on known defect) is what people naturally test, and it
  honestly passes; coverage (fires over what fraction of domain) never gets
  checked, so silent shrinkage there looks like success. Three shipped same
  day, all green: discipline test announcing "every handler mutating
  RuntimeState" whose hardcoded list covered 4 of 8; extractor replacing it,
  returning 3 of 9 fields with no error if `return` literal reflowed or uses
  shorthand keys; CI glob running 78 of 116 files local runner collects
  (`TESTING.md`, "Cross-platform tests"), so new test passed locally and
  never ran in CI. Canonical fail-open shape: `toPublicPeer` in `broker.ts`
  rest-spreads
  three fields out and projects the rest, so 17th `Peer` field ships publicly
  with nothing failing -- pick-list would have failed closed. Two bullets
  below are instances of this.
- **A comment or class that ASSERTS a guarantee must be wired to it, and
  point at what actually enforces it** (instance of coverage rule above).
  `PinnedTrust.kt` described trust-on-first-use, implemented it correctly,
  instantiated by *nothing* -- pinning read as done for weeks while app
  accepted any certificate; `DeckApi.onX` declared, multiplexed and
  subscribed compiles and tests green with NO producer (`sandbox:changed`
  shipped wired consumer-side while nothing ever emitted it). Grep that
  enforcer/emitter actually called (`broadcast('<channel>'`/`send('<channel>'`
  for an `onX`), not just that listener exists. False pointer equally costly:
  `KNOWN_FIELDS` comment cited `pty.on('exit', ...)` for field actually
  assigned in `pollPeerIds()`, and `originOf` doc gave true conclusion on
  false reason -- four such occurrences in one file family in one day.
  Comment's job is to dissuade; reader who checks cited spot, finds nothing,
  concludes it's stale stops trusting it even when conclusion holds.
- **A new validator needs every call path enumerated** (coverage question
  applied to validator's own call sites): live gesture, persisted-state
  restore/load, automatic-placement heuristic, IPC entry point -- wire or
  consciously exempt each; numeric validators must reject `NaN` explicitly
  (passes every comparison-based clamp silently, since every `<`/`>` against
  `NaN` is `false`). Three shipped in one day: `clampNodeSize` not wired into
  `findFreeSpot`, `clampLaneHeight` not wired into restore-time seed,
  `viewportH` unguarded despite comment claiming otherwise.
- **Review against what a commit SHOULD contain, not just the diff it
  shows.** Costliest defects invisible in diff itself: commit referencing
  file that only ever existed in working tree; millisecond-resolution sort
  key silently dropping rows on tie; validator wired to only one of two
  callers; prop default de-flagging a confirmation outside diff's hunks.
  Derived git habits (explicit staging by filename, `git show --stat` after
  every commit, `cat-file -e` on imports touching co-edited files) are
  consequences of this question, not the question itself.

- **A commit that advances a roadmap card names it, `Card <id8>.`, on the
  first line of the BODY** (not the subject -- `git log --oneline` misses it).
  Consultative only, in both directions: a commit may cite the card it FILES
  rather than closes, and a card need not produce any commit at all (a card
  can be answered to a human). Closing a card is an agent's discipline, never
  a fact derived from the tree. A card-to-commit link matches PATH + SYMBOL,
  never `file:line`, which rots.

- **Five hostile inputs, never trusted.** Decide which of these five a new
  config/template field, shell-interpolated arg, broker response field,
  path/dir IPC arg, agent-facing tool arg, or sandbox mount/projection is
  BEFORE wiring it:

  | # | Source → sink | Rule | Precedent |
  |---|---|---|---|
  | 1 | CLONED-REPO values (`.claude/claude-peers/config.json`, `templates/*.json`) → shell/spawn | GLOBAL-config-only or approval-gated, reuse `launch-approval.ts`, never trust the repo itself | "Security gates" in `DESKTOP.md` |
  | 2 | Message/peer field → broker HTTP boundary | never carry `instance_token`/`from_token`/PIDs; project through `toPublicPeer` / `resolveSenderMeta` in `broker.ts` | -- |
  | 3 | Renderer/companion IPC arg → FILESYSTEM PATH, git target, spawned cwd | re-validate MAIN-side against the work-dir allow-set every call (`workDirRoots`/`requireWorkDir` in `ipc.ts`; realpath containment via `resolveWithin`/`realpathWithin`); `CHANNEL_TIERS` is a declaration, NOT an access gate | GX-SEC: an unvalidated `dir` on a tier-0 "read" channel let `git diff --no-index` dump any file |
  | 4 | SPAWNED-AGENT string (MCP args crossing deck-control/demo-control) → `executeJavaScript`, a page, a terminal, a command line | encode/validate at the boundary, never string-glue | `browser-drive-scripts.ts` JSON-encodes every selector; directive commands re-validated as enums |
  | 5 | Anything MOUNTED INTO a sandbox = a capability granted to code assumed compromised | host `~/.claude` COPIED in, never mounted; secrets excluded by a deny-list outranking any operator glob; container name/command from renderer/agent re-validated main-side before the engine CLI (`sandbox-command.ts`/`sandbox-projection.ts`/`sandbox-copy.ts`) | a mounted `settings.json` would let a sandboxed agent plant a hook that later executes on the HOST |
- **Comparing two paths? Canonicalize both.** Path YOU built (`join`,
  `resolve`, IPC arg, stored cwd) and one EXTERNAL TOOL reports (git,
  docker, child process) not string-comparable: macOS tmpdirs symlinked
  (`/var` → `/private/var`), Windows hands back 8.3 short names, external
  tool always answers with REAL path. Run both through `canonicalPath`
  (`worktree-service.ts` -- `realpathSync.native`, falling back to `resolve`
  if path doesn't exist yet) before `===`, `startsWith` or `Map` key.
  Precedent: `removeWorktree` denied worktree it had just created, sandbox
  re-hit it on mount/transcript lookups. **Linux CI can't see this class of
  bug** (its tmpdirs aren't symlinked), so regression test must build
  symlinked prefix itself (`TESTING.md`, "Cross-platform tests").
- **Naming a scratch/plan/report doc?** `.gitignore` silently excludes
  `findings.md`, `task_plan.md`, `progress.md`, `progress-archive.md`, `docs/`,
  and `.claude/session-checkpoint.md`. Deliverable you intend to commit (audit
  report, plan, notes) must use different name, or it vanishes from `git add`.

## Running

See `README.md` for full setup (local vs HTTP broker mode, `.mcp.json` /
`config.json`). CLI quick reference (run on broker host):

```bash
bun cli.ts status
bun cli.ts peers [--include-dormant]
bun cli.ts groups
bun cli.ts kill-broker        # Linux/macOS only (uses lsof)
```