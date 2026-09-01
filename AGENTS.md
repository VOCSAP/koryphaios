# Koryphaios / claude-peers

Two products in one repo:

- **claude-peers (core, repo root)** -- peer discovery + messaging MCP channel
  for Claude Code instances: sessions on one machine (or sharing a remote
  broker) see each other, exchange messages scoped to isolated groups, share a
  persistent per-project roadmap.
- **Koryphaios (desktop, `desktop/`)** -- Κορυφαῖος, chorus leader: Electron
  orchestrator docking many Claude Code sessions in one window (npm package
  `koryphaios`, bin `kory`). Session tiles, workspaces + templates, git
  worktrees per agent, supervisor session piloting the app through an MCP
  bridge, shared roadmap view, operator inbox, diff review, embedded browser,
  graph-chat canvas with multi-model battle mode, unified model picker.

## Where things live

- **No `CHANGELOG.md`** (removed 2026-08-28). The narrative of a shipped lot
  lives ONLY in the body of the commit that delivered it, found by
  `git log --all --grep "Card <id8>"` -- the citation is in the commit
  MESSAGE, so neither `-S` nor `-G` finds it. Pre-removal history:
  `git show 0d5a4cb:CHANGELOG.md`.
- **Open work** (to-do / to-verify / deferred, security backlog) is
  centralized in `BACKLOG.md`.
- **Chantier ids in comments** (`C1`…`C29`, `D1`…, `MB1`…, `TS1`…, `GX1`…,
  `CT1`…, `SBX1`…, `N0`…`N5`) are historical tags from past working plans:
  do not add new ones. The standalone working docs (`PLAN-*`,
  `EXPLORATION-*`, `AUDIT-*`) were consolidated and removed; shipped design
  decisions live in commit bodies, open residual in `BACKLOG.md`.
- **`docs/` and `runbooks/` are tracked trees, NOT scratch**: `docs/` holds
  the design briefs that production comments in `broker.ts` / `shared/` cite
  by path, `runbooks/` the operational procedures for the deployed broker.
  Neither is a place to park a working note.

## Detailed docs (read on demand)

Read only the file/skill matching the area you touch:

| Touching | Read | Why |
|---|---|---|
| Core (`broker.ts`, `server.ts`, `cli.ts`, `shared/`) | `ARCHITECTURE.md` | entrypoints, endpoints, roadmap, delivery hardening, Deck announcements, identity model, resume flow |
| Desktop app (`desktop/`) | `DESKTOP.md` | Electron stack, sessions, supervisor, graph chat, model picker, security gates |
| Anything VISUAL in `desktop/` | `DESIGN.md` + `deck-design` skill | tokens, colour semantics, control archetypes, iconography. Two hard rules: **no control keeps its native look** (every `<button>`/`<select>`/`<input>`/`<textarea>`/checkbox) and **no emoji**, every icon a Greek SVG glyph from `components/icons.tsx`. Style un-ruled controls at ELEMENT level in `styles.css`; per-instance class fixes only this one. |
| Tests or a commit | `TESTING.md` | suite layout, smoke check, typecheck, locale parity |
| Model/provider picker, headless inference point (help, wand, digest, graph, judge), non-Anthropic CLI/API syntax | `model-providers` skill | -- |
| Nav-rail VIEW or `DeckApi` IPC channel (desktop only) | `add-deck-view` skill | agent→broker→Deck feature instead: `add-broker-feature` |
| SANDBOX mode (`desktop/src/main/sandbox-*.ts`, Docker rail) | `desktop/docs/sandbox.md` + commits `32d2249` (M1), `959c98f` (M2/M3) | behavior, guards, copy-not-mount rule, why each decision was taken |
| DEBUGGING sandbox (login loops, missing projected config, slow spawns, volume state) | `sandbox-debug` skill | field probes, confirmed root-cause catalogue |
| Bun runtime / API conventions | `BUN.md` | which libs to use or avoid |
| Bun-served frontend (HTML imports, React) | `FRONTEND.md` | -- |
| Open/deferred work | `BACKLOG.md` | single consolidated to-do list |

## Conventions (always apply)

- **Keyed by what, and what happens when there are two?** Ask before adding
  a `Map`, cache, table, lock or `SELECT … LIMIT 1`. The broker may be a
  shared server serving several people, one person may run several sessions
  across several PCs, and two OS accounts on one host are two identities by
  construction -- so one human may hold two identities and one identity may
  be reached at the same address twice. A singleton keyed by too little fails
  SILENTLY. Authorise in the direction that survives a second identity:
  resolve the OBJECT first, then "may this caller act on THAT object", never
  "who does this caller belong to". Shipped instances: gateway table keyed by
  channel `kind` (second operator replaced and stopped the first), an
  address→operator lookup whose `.get()` picked one of two rows, `hostname()`
  used as identity.

- **No literal control bytes in a source file.** Write `\0`, `\x1b`, `\x07`
  as escapes: a single embedded NUL makes git classify the file as binary
  (no diff, no blame, no 3-way merge, ripgrep skips it). Precedent:
  `notify/registry.ts`, whole rewrite unreviewable.

- **Bun, not Node**: `bun <file>`, `bun test`, `bun install`, `bunx`.
  Exception: `desktop/` builds with electron-vite/npm (native `node-pty`
  rebuilt for Electron). Details in `BUN.md`.

- **Who runs which tests.** The full gate is `bun test`, the smoke check
  (`bun build --target=bun broker.ts server.ts cli.ts --outdir=/tmp/cp-check`)
  and `npm run typecheck` in `desktop/` if touched. It is run ONCE, by
  whoever sequences the commits, immediately before committing. **If you do
  not commit, you do not run it**: run only the targeted file
  (`bun test tests/<file>.test.ts`) and report that exact command. `bun test`
  is ~113s with large output; replaying it after every edit, or to re-confirm
  someone else's green, is pure cost. Suspected cross-file breakage is raised
  as an open item, not investigated with the full suite. Details: `TESTING.md`.

- **No silent errors.** Never write `catch {}` or catch-and-return-default
  without leaving a trace in the layer's log sink; `console.error` alone is
  NOT a trace (invisible in the packaged app, lost when the broker outlives
  its spawner's stderr). Core via `shared/logger.ts`; Deck main via
  `reportError()` from `desktop/src/main/log.ts`; renderer via
  `window.api.reportError` or the store's `guarded()` wrapper. Swallow only
  when the fallback is truly equivalent (documented best-effort caches).
  Per-layer conventions: `error-reporting` skill.

- **Coverage rule: a gating mechanism (discipline test, validator, CI glob,
  allow-list, deny-list, parser feeding a decision) needs its COVERAGE
  audited, not just its sensitivity.** Ask two halves: what degradation
  yields a SUBSET rather than an error, and what growth of the DOMAIN slips
  through untouched? An allow-list shrinking fails CLOSED (surfaces the same
  day); deny-lists and omit-projections fail OPEN, silently -- audit those
  first. Canonical fail-open shape: `toPublicPeer` in `broker.ts`
  rest-spreads three fields out and projects the rest, so a new `Peer` field
  ships publicly with nothing failing; a pick-list would fail closed. Shipped
  green: a discipline test whose hardcoded list covered 4 of 8 handlers, a CI
  glob running 78 of 116 collected files (`TESTING.md`, "Cross-platform
  tests"). Corollary on the PROOF: a probe measured red-first and left out of
  the commit is not a guard, since nothing replays it -- ask of any "proved
  it bites": is that probe in the diff?

- **A comment or class that ASSERTS a guarantee must be wired to it, and
  point at what actually enforces it.** `PinnedTrust.kt` implemented pinning
  and was instantiated by nothing; a `DeckApi.onX` declared, multiplexed and
  subscribed tests green with NO producer. Grep that the emitter is called
  (`broadcast('<channel>'` / `send('<channel>'`), not just that a listener
  exists. A false pointer (a comment citing `pty.on('exit', ...)` for a field
  assigned in `pollPeerIds()`) costs as much: a reader who finds nothing at
  the cited spot stops trusting the comment even when its conclusion holds.

- **A new validator needs every call path enumerated**: live gesture,
  persisted-state restore/load, automatic-placement heuristic, IPC entry
  point -- wire or consciously exempt each. Numeric validators must reject
  `NaN` explicitly: every `<`/`>` against `NaN` is `false`, so it passes any
  comparison-based clamp silently.

- **Extracting logic into a pure module makes its CALL SITE invisible.** The
  tests prove the function; nothing proves it is CALLED, with which
  arguments, so the suite gets GREENER as the guarantee gets weaker
  (measured: 12 of 13 mutations of a wiring `case` stayed green after
  extraction). Three remedies, by increasing power: a SOURCE SCAN
  (`toContain("fn(")`) is the weakest and fails open (result DISCARDED,
  argument swapped for a literal -- presence is not contract); a BEHAVIOURAL
  probe (real input into the real exported function, require the real
  effect) is the right default; DEPENDENCY INJECTION closes by construction
  (make the wiring itself pure and executable). When two call sites of one
  module carry different disciplines, the exception is the bug.

- **Review against what a commit SHOULD contain, not just the diff it
  shows.** Costliest defects are invisible in the diff: a commit referencing
  a file that only existed in the working tree; a millisecond-resolution sort
  key dropping rows on tie; a validator wired to one of two callers; a prop
  default de-flagging a confirmation outside the hunks. Hence: stage
  explicitly by filename, `git show --stat` after every commit, `cat-file -e`
  on imports touching co-edited files.

- **A commit that advances a roadmap card names it, `Card <id8>.`, on the
  first line of the BODY** (not the subject: `git log --oneline` misses it).
  The link is CONSULTATIVE in both directions: a commit may cite the card it
  FILES, not only the one it closes, and a card need not produce a commit at
  all (its whole delivery may be an answer to a human), so closing a card is
  an agent's discipline, never a fact derived from the tree. A card-to-commit
  link matches PATH + SYMBOL, never `file:line`, which rots.

- **Five hostile inputs, never trusted.** Decide which one a new
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

- **Comparing two paths? Canonicalize both** through `canonicalPath`
  (`worktree-service.ts`: `realpathSync.native`, falling back to `resolve` if
  the path does not exist yet) before `===`, `startsWith` or a `Map` key. A
  path YOU built and one an EXTERNAL TOOL (git, docker, child process)
  reports are not string-comparable: macOS tmpdirs are symlinked (`/var` →
  `/private/var`), Windows hands back 8.3 short names. **Linux CI cannot see
  this class of bug**, so the regression test must build its own symlinked
  prefix (`TESTING.md`, "Cross-platform tests").

- **Naming a doc you intend to commit?** `.gitignore` silently excludes
  `findings.md`, `task_plan.md`, `progress.md`, `progress-archive.md`,
  `BACKLOG-ORDER.md`, `WORKFLOW-LOTS-DESIGN.md` and
  `.claude/session-checkpoint.md` -- bare patterns, so matched at every
  depth. Use another name or it vanishes from `git add`.
  `git check-ignore -v <path>` only tells the truth on an untracked path.
  `docs/` is tracked and no longer ignored; only `desktop/docs/reference/`
  is (anchored by its middle slash).

## Running

See `README.md` for full setup (local vs HTTP broker mode, `.mcp.json` /
`config.json`). CLI quick reference (run on the broker host):

```bash
bun cli.ts status
bun cli.ts peers [--include-dormant]
bun cli.ts groups
bun cli.ts kill-broker        # Linux/macOS only (uses lsof)
```
