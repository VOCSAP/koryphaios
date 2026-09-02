# Koryphaios / claude-peers

Two products in one repo:

- **claude-peers (core, repo root)** -- peer discovery + messaging MCP channel
  for Claude Code instances: sessions on one machine (or sharing a remote
  broker) see each other, exchange messages scoped to isolated groups, share a
  persistent per-project roadmap.
- **Koryphaios (desktop, `desktop/`)** -- Κορυφαῖος, chorus leader: Electron
  orchestrator docking many Claude Code sessions in one window (npm package
  `koryphaios`, bin `kory`): session tiles, workspaces + templates, git
  worktrees per agent, supervisor session piloting the app through an MCP
  bridge, roadmap view, operator inbox, diff review, embedded browser,
  graph-chat canvas, unified model picker.

## Where things live

- **History of a shipped lot**: only in the body of the commit that delivered
  it, found by `git log --all --grep "Card <id8>"` (the citation is in the
  message, so `-S`/`-G` cannot find it). No `CHANGELOG.md` since 2026-08-28;
  `git show 0d5a4cb:CHANGELOG.md` for older entries.
- **Open work** (to-do / to-verify / deferred, security backlog): `BACKLOG.md`
  only.
- **`docs/` and `runbooks/` are tracked, not scratch**: design briefs and
  procedures for the deployed broker. Working notes go elsewhere. Code does
  not cite them by path: a comment states the non-obvious choice in a line or
  two, the design stays in the brief, the rationale in the commit body.
- **Chantier ids in comments** (`C1`…`C29`, `D1`…, `MB1`…, `TS1`…, `GX1`…,
  `CT1`…, `SBX1`…, `N0`…`N5`) are historical tags: do not add new ones.
- **Comments carry no history.** The card id, the lot, the review and the
  measurement go in the commit body; a comment never says "previously",
  "used to", a date, a session, or `see <file>`. Existing narrative comments
  are deleted when the code around them is touched, not extended.

## Read on demand

Read only the file/skill matching the area you touch:

| Touching | Read |
|---|---|
| Core (`broker.ts`, `server.ts`, `cli.ts`, `shared/`) | `ARCHITECTURE.md` -- entrypoints, endpoints, roadmap, delivery hardening, identity model, resume flow |
| Desktop app (`desktop/`) | `DESKTOP.md` -- Electron stack, sessions, supervisor, graph chat, model picker, security gates |
| Anything VISUAL in `desktop/` | `DESIGN.md` + `deck-design` skill. Two hard rules: **no control keeps its native look** and **no emoji** (every icon a Greek SVG glyph from `components/icons.tsx`) |
| Tests, a code review, or a commit | `TESTING.md` -- the gate, review checklist and guard-coverage audit, cross-platform tests, locale parity |
| Any `catch`, timer/poll, or failure shown to the operator | `error-reporting` skill |
| Model/provider picker, headless inference point (help, wand, digest, graph, judge), non-Anthropic CLI/API syntax | `model-providers` skill |
| Nav-rail VIEW or `DeckApi` IPC channel | `add-deck-view` skill (agent→broker→Deck feature: `add-broker-feature`) |
| SANDBOX mode (`desktop/src/main/sandbox-*.ts`, Docker rail) | `desktop/docs/sandbox.md`; debugging a sandbox: `sandbox-debug` skill |
| Bun runtime / Bun-served frontend | `BUN.md` / `FRONTEND.md` |
| Running the broker or the CLI | `README.md` |

## Rules for every task

- **Bun, not Node**: `bun <file>`, `bun test`, `bun install`, `bunx`.
  Exception: `desktop/` builds with electron-vite/npm (native `node-pty`).

- **Who runs which tests.** The full gate (`bun test` ~113s, smoke build,
  desktop typecheck) runs ONCE, by whoever sequences the commits, right before
  committing. **If you do not commit, you do not run it**: run the targeted
  file (`bun test tests/<file>.test.ts`) and report that exact command. A hook
  enforces this; suspected cross-file breakage is raised as an open item.

- **No silent errors.** Never `catch {}` or catch-and-return-default without
  a trace in the layer's log sink: core `shared/logger.ts`, Deck main
  `reportError()` (`desktop/src/main/log.ts`), renderer `window.api.reportError`
  or the store's `guarded()`. `console.error` alone is NOT a trace.

- **Commits.** One that advances a roadmap card names it, `Card <id8>.`, on
  the first line of the BODY (not the subject). Stage explicitly by filename,
  `git show --stat` after committing. No literal control byte (`\0`, `\x1b`,
  `\x07`) in a source file -- write the escape, or git treats the file as
  binary. `.gitignore` silently excludes `findings.md`, `task_plan.md`,
  `progress.md`, `progress-archive.md`, `BACKLOG-ORDER.md`,
  `WORKFLOW-LOTS-DESIGN.md` and `.claude/session-checkpoint.md` at every depth:
  do not name a doc you intend to commit that way.

## Rules for code

- **Keyed by what, and what happens when there are two?** Ask before adding a
  `Map`, cache, table, lock or `SELECT … LIMIT 1`: one human may hold two
  identities, one identity may be reached at the same address twice, and a
  singleton keyed by too little fails SILENTLY. Resolve the OBJECT first, then
  "may this caller act on THAT object", never "who does this caller belong
  to". Precedents: `ARCHITECTURE.md`, "What happens when there are two?".

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
  (`worktree-service.ts`) before `===`, `startsWith` or a `Map` key: macOS
  symlinks `/var` → `/private/var`, Windows returns 8.3 names, and Linux CI
  sees neither, so the regression test must build its own symlinked prefix
  (`TESTING.md`, "Cross-platform tests").

- **A guard needs its COVERAGE audited, not just its sensitivity**: what
  degradation yields a SUBSET instead of an error? Deny-lists and
  omit-projections fail OPEN; a source scan (`toContain("fn(")`) is the
  weakest guard; a guarantee is an assertion whose message names what it
  guards, never a comment; a new validator has every call path enumerated and rejects
  `NaN`. Full checklist with precedents: `TESTING.md`, "Reviewing a commit
  and auditing a guard".
