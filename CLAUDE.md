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

Release history and per-batch narratives live in `CHANGELOG.md`. Code comments
reference chantier ids (`C1`…`C29`, `D1`…) from past working plans; the
matching design decisions are summarized in the CHANGELOG entry of the batch
that shipped them.

## Detailed docs (read on demand)

Only read the file matching the area you are touching:

- Working on the core (`broker.ts`, `server.ts`, `cli.ts`, `shared/`) — read
  `ARCHITECTURE.md` (entrypoints, endpoints, roadmap, delivery
  hardening, Deck announcements, identity model, resume flow).
- Working on the desktop app (`desktop/`) — read `DESKTOP.md`
  (Electron stack, sessions, supervisor, graph chat, model picker, security
  gates).
- Writing or running tests, or preparing a commit — read `TESTING.md`
  (test suite layout, smoke check, typecheck, locale parity).
- Bun runtime / API conventions (which libs to use or avoid) — read
  `BUN.md`.
- Building a Bun-served frontend (HTML imports, React) — read
  `FRONTEND.md`.

## Conventions (always apply)

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
