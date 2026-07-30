# Koryphaios / claude-peers

Two products in one repo:

- **claude-peers (core, repo root)** -- peer discovery and messaging MCP channel
  for Claude Code instances: sessions on the same machine (or sharing a remote
  broker) see each other, exchange messages scoped to isolated groups, and
  share a persistent per-project roadmap.
- **Koryphaios (desktop, `desktop/`)** -- Κορυφαῖος, the chorus leader: an
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
`D1`…, `MB1`…, `TS1`…, `GX1`…, `CT1`…, `SBX1`…, `N0`…`N5`) from past working
plans; these are historical only, an artifact of agents self-tagging comments
with their spec ids -- do not introduce new ones. Those standalone working
docs (`PLAN-*`, `EXPLORATION-*`, `AUDIT-*`) were consolidated and removed: the
shipped design decisions are summarized in the CHANGELOG entry of the batch that
shipped them, the open residual lives in `BACKLOG.md`, and the full detail
(exploit chains, design alternatives) stays in git history.

## Detailed docs (read on demand)

Read only the file/skill matching the area you are touching:

| Touching | Read | Why |
|---|---|---|
| Core (`broker.ts`, `server.ts`, `cli.ts`, `shared/`) | `ARCHITECTURE.md` | entrypoints, endpoints, roadmap, delivery hardening, Deck announcements, identity model, resume flow |
| Desktop app (`desktop/`) | `DESKTOP.md` | Electron stack, sessions, supervisor, graph chat, model picker, security gates |
| Anything VISUAL in `desktop/` | `DESIGN.md` + `deck-design` skill | tokens, colour semantics, control archetypes, iconography, UI checklist. Two hard rules: **no control keeps its native look** (every `<button>`/`<select>`/`<input>`/`<textarea>`/checkbox -- a square white dropdown is the same bug as a grey OS button) and **no emoji**, every icon a Greek SVG glyph from `components/icons.tsx`. Style un-ruled controls at the ELEMENT level in `styles.css` so the next instance inherits it; a per-instance class only fixes this one. |
| Tests or a commit | `TESTING.md` | suite layout, smoke check, typecheck, locale parity |
| Model/provider picker, a headless inference point (help, wand, digest, graph, judge), non-Anthropic CLI/API syntax | `model-providers` skill (`.claude/skills/model-providers/SKILL.md`) | -- |
| Nav-rail VIEW or `DeckApi` IPC channel (desktop only) | `add-deck-view` skill | agent→broker→Deck feature instead: `add-broker-feature` |
| SANDBOX mode (`desktop/src/main/sandbox-*.ts`, Docker rail, where a session executes) | `desktop/docs/sandbox.md` + "Sandbox mode" CHANGELOG entries | behavior, guards, copy-not-mount rule, why each decision was taken |
| DEBUGGING sandbox (login loops, missing projected config, slow spawns, volume state) | `sandbox-debug` skill | field probes, confirmed root-cause catalogue |
| Bun runtime / API conventions | `BUN.md` | which libs to use or avoid |
| Bun-served frontend (HTML imports, React) | `FRONTEND.md` | -- |
| Open/deferred work (security backlog, v2, pending visual/E2E validations) | `BACKLOG.md` | the single consolidated to-do list |

## Conventions (always apply)

- **Who is actually running this.** Before adding a `Map`, a cache, a table, a
  lock or a `SELECT … LIMIT 1`, answer: **keyed by what, and what happens when
  there are two?** The failure mode is always the same shape and always
  SILENT: some singleton keyed by too little. Ask the authorisation question
  in the direction that survives a second identity -- resolve the OBJECT
  first, then "may this caller act on THAT object", never "who does this
  caller belong to". This matters because the broker can be local or a shared
  server serving several people, one person can run several sessions across
  several PCs (usually one `operator_id`, but not always -- two OS accounts
  are two identities by construction), so the same human may hold two
  identities and one identity may be reached at the same address twice. Three
  shipped instances: a gateway table keyed by channel `kind` (the second
  operator to enrol replaced and stopped the first one's), an authorisation
  that resolved an address to "its" operator and compared (`.get()` picked one
  of two rows, refusing half the answers as "already handled"), and
  `hostname()` used as an identity (two OS accounts share it).

- **No literal control bytes in a source file.** Write `\0`, `\x1b`, `\x07` as
  escapes. A single embedded NUL makes git classify the file as **binary**: the
  diff becomes `Bin 4555 -> 7157 bytes`, `git blame` dies, 3-way merge dies,
  and `grep`/ripgrep refuse to show its contents -- a whole module silently
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
  without leaving a trace in the layer's log sink -- a `console.error` alone is
  NOT a trace (invisible in the packaged app, and lost when the broker outlives
  its spawner's stderr). Route errors to the rolling log files: core
  (broker/server) via `shared/logger.ts`; Deck main process via
  `reportError()` from `desktop/src/main/log.ts` (also journals the entry);
  renderer via `window.api.reportError` or the store's `guarded()` wrapper.
  Only swallow silently when the fallback is truly equivalent (documented
  best-effort caches). Full conventions per layer: the `error-reporting`
  skill (`.claude/skills/error-reporting/SKILL.md`).
- **A gating mechanism (discipline test, validator, CI glob, allow-list,
  deny-list, parser feeding a decision) needs its COVERAGE audited, not just
  its sensitivity.** Ask two halves: what degradation yields a SUBSET rather
  than an error, and what growth of the DOMAIN yields the same effect
  untouched. Audit deny-lists/omit-projections first: an allow-list
  shrinking fails CLOSED (legitimate use refused, surfaces same day); those
  fail OPEN, silently. Sensitivity (fires on the known defect) is what
  people naturally test, and it honestly passes; coverage (fires over what
  fraction of the domain) never gets checked, so silent shrinkage there
  looks like success. Three shipped the same day, all green: a discipline
  test announcing "every handler mutating RuntimeState" whose hardcoded list
  covered 4 of 8; the extractor replacing it, returning 3 of 9 fields with no
  error if the `return` literal is reflowed or uses shorthand keys; a CI glob
  running 78 of the 116 files the local runner collects (`TESTING.md`,
  "Cross-platform tests"), so a new test passed locally and never ran in CI.
  Canonical fail-open shape: `broker.ts:1109` rest-spreads three fields out
  and projects the rest, so a 17th `Peer` field ships publicly with nothing
  failing -- a pick-list would have failed closed. The two bullets below are
  instances of this.
- **A comment or class that ASSERTS a guarantee must be wired to it, and
  point at what actually enforces it** (an instance of the coverage rule
  above). `PinnedTrust.kt` described trust-on-first-use, implemented it
  correctly, and was instantiated by *nothing* -- pinning read as done for
  weeks while the app accepted any certificate; a `DeckApi.onX` declared,
  multiplexed and subscribed compiles and tests green with NO producer
  (`sandbox:changed` shipped wired consumer-side while nothing ever emitted
  it). Grep that the enforcer/emitter is actually called
  (`broadcast('<channel>'`/`send('<channel>'` for an `onX`), not just that
  the listener exists. A false pointer is as costly: a `KNOWN_FIELDS` comment
  cited `pty.on('exit', ...)` for a field actually assigned in
  `pollPeerIds()`, and an `originOf` doc gave a true conclusion on a false
  reason -- four such occurrences in one file family in one day. A comment's
  job is to dissuade; a reader who checks the cited spot, finds nothing, and
  concludes it's stale stops trusting it even when its conclusion holds.
- **A new validator needs every call path enumerated** (the coverage
  question applied to a validator's own call sites): a live gesture, a
  persisted-state restore/load, an automatic-placement heuristic, an IPC
  entry point -- wire or consciously exempt each; numeric validators must
  reject `NaN` explicitly (it passes every comparison-based clamp silently,
  since every `<`/`>` against `NaN` is `false`). Three shipped in one day:
  `clampNodeSize` not wired into `findFreeSpot`, `clampLaneHeight` not wired
  into the restore-time seed, `viewportH` unguarded despite a comment
  claiming otherwise.
- **Review against what a commit SHOULD contain, not just the diff it
  shows.** The costliest defects are invisible in the diff itself: a commit
  referencing a file that only ever existed in the working tree; a
  millisecond-resolution sort key silently dropping rows on a tie; a
  validator wired to only one of two callers; a prop default de-flagging a
  confirmation outside the diff's hunks. The derived git habits (explicit
  staging by filename, `git show --stat` after every commit, `cat-file -e` on
  imports touching co-edited files) are consequences of this question, not
  the question itself.

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
- **Comparing two paths? Canonicalize both.** A path YOU built (`join`,
  `resolve`, an IPC arg, a stored cwd) and one an EXTERNAL TOOL reports (git,
  docker, a child process) aren't string-comparable: macOS tmpdirs are
  symlinked (`/var` → `/private/var`), Windows hands back 8.3 short names,
  and the external tool always answers with the REAL path. Run both through
  `canonicalPath` (`worktree-service.ts` -- `realpathSync.native`, falling
  back to `resolve` if the path doesn't exist yet) before `===`,
  `startsWith` or a `Map` key. Precedent: `removeWorktree` denied a worktree
  it had just created, and the sandbox re-hit it on mount/transcript lookups.
  **Linux CI can't see this class of bug** (its tmpdirs aren't symlinked), so
  the regression test must build the symlinked prefix itself (`TESTING.md`,
  "Cross-platform tests").
- **Naming a scratch/plan/report doc?** `.gitignore` silently excludes
  `findings.md`, `task_plan.md`, `progress.md`, `progress-archive.md`, `docs/`,
  and `.claude/session-checkpoint.md`. A deliverable you intend to commit (audit
  report, plan, notes) must use a different name, or it vanishes from `git add`.

## Running

See `README.md` for full setup (local vs HTTP broker mode, `.mcp.json` /
`config.json`). CLI quick reference (run on the broker host):

```bash
bun cli.ts status
bun cli.ts peers [--include-dormant]
bun cli.ts groups
bun cli.ts kill-broker        # Linux/macOS only (uses lsof)
```
