---
name: error-reporting
description: Error-handling and logging conventions per layer (core broker/server, Deck main, renderer) — which sink to use, when a toast vs the banner vs the journal, and the rolling-log invariants. Use when writing or reviewing any catch block, adding a timer/poll, surfacing a failure to the operator, or touching shared/logger.ts / desktop log.ts / reportError.
---

# Error reporting conventions (PLAN-observabilite-erreurs)

One rule everywhere: **an error may be tolerated, never invisible**. Every
catch either rethrows, or leaves a trace in the layer's rolling log. Plain
`console.error` is not a trace: packaged Electron has no terminal, and the
spawned broker outlives its parent's stderr.

## Which sink, per layer

| Layer | Sink | File it lands in |
|---|---|---|
| broker.ts | `log.error/warn/info` (child of `shared/logger.ts`) | `<config dir>/logs/broker.log` |
| server.ts | `log()` / `logError()` helpers (stderr + file) | `<config dir>/logs/server.log` |
| shared/* (core) | throw to caller, or `console.error` only if the caller logs | caller's log |
| Deck main (`desktop/src/main/*`) | `reportError(scope, msg, err)` from `./log` | `app.getPath('logs')/main.log` + journal `error` entry |
| preload | `ipcRenderer.send('app:report-error', scope, msg)` | main.log + journal |
| renderer | `window.api.reportError(scope, msg)`; user actions via the store's `guarded()` | main.log + journal |

`<config dir>` = XDG/APPDATA claude-peers dir; override `CLAUDE_PEERS_LOG_DIR`.
All logs are size-rotated (5 MiB × 3 files) — never add an unbounded log file.

## Operator surfacing (Deck) — pick ONE, by nature

- **Direct user action failed** (button/menu click): error **toast**, raw
  message — the store's `guarded('label', fn)` does log + toast. Toasts are
  throttled (same key ≤ 1/5 s); never toast from background code.
- **Systemic state** (broker unreachable): the **StatusBanner** (red, top,
  persistent, self-dismissing). Fed by `BrokerHealthTracker` in main — do not
  invent a second channel; extend `.status-banner` for new blocking states.
- **Background failure** (poll, timer, persistence, auto-save): `reportError`
  only → main.log + journal `error` kind. The Journal view is the operator's
  error console.
- **View render crash**: already handled — per-view `ErrorBoundary` in
  App.tsx. Wrap any NEW top-level view the same way.

## Invariants to preserve when touching these paths

- **Broker timers** (`guardedInterval` in broker.ts): any new `setInterval`
  doing DB work must go through it — a timer throw outside the HTTP handler
  kills the daemon.
- **Multi-statement SQLite sequences** use `db.transaction(...)` (see
  `recordMessageTx`, `purgeDormantPeerTx`, `importAll`).
- **process-level nets exist** in broker.ts, server.ts and Deck index.ts
  (`uncaughtException`/`unhandledRejection`, plus `render-process-gone` in the
  Deck). Don't add competing handlers; don't remove the log-then-exit(1)
  behavior in core.
- **server.ts stdout is the MCP protocol**: never `console.log` there; its
  file logger runs with `mirrorToConsole: false` + explicit stderr writes.
- **Destructive reads persist before ack**: the operator-inbox drain re-queues
  the batch (`pendingInboxWrites` in index.ts) when the disk write fails.
  Imitate that pattern for any new consume-once data.
- **Journal at quit**: `flushJournalSnapshot` in `before-quit` writes
  `journal-<date>.log` (pruned after 7 days). New journal kinds go in BOTH
  `desktop/src/main/journal.ts` and the mirror in `desktop/src/shared/types.ts`
  + the `KINDS` filter in JournalView + `journal.kind.*` i18n keys (3 files —
  see TESTING.md locale parity).

## Acceptable silent catches (documented best-effort)

Only where the comment says so and the fallback is equivalent: peer-cache file
writes, `process.kill(pid, 0)` liveness probes, ws.send on a half-closed
socket (poll fallback ships it), heuristic summary fallbacks. When in doubt,
log it.

## Tests that guard all this

`tests/logger.test.ts` (rotation), `tests/broker-logging.test.ts` (broker.log
+ 500-survival), `tests/desktop-log.test.ts` (main.log + journal snapshot),
`tests/desktop-broker-health.test.ts` (banner hysteresis),
`tests/desktop-inbox-store.test.ts` (persist-failure callback).
