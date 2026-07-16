---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# claude-peers (v0.6.0)

Peer discovery and messaging MCP channel for Claude Code instances. v0.3 introduces group isolation (TOFU), resumable identity, WebSocket push, and a dual `instance_token` / `peer_id` model. v0.3.1 adds server-side auto-disconnect (SIGTERM/stdin EOF + broker sweeps). v0.3.2 restores the status-line `peer_id` cache that v0.3 lost when the SSH `client.ts` was removed, and drops the SessionEnd bash hook. v0.3.3 hardens delivery against the "backlog avalanche on reconnect" pattern observed in production: three cumulative mechanics (heuristic ack on `send_message`, capped WS flush, TTL purge of stale undelivered messages) eliminate the symptom where a peer reopening on a known cwd received the entire historical backlog at once. v0.3.4 adds Deck-driven outbound announcements: a new broker `POST /announce` broadcasts one-way, no-reply system messages to a group from a reserved non-routable `deck` sender (auto join announcement when a session's peer_id resolves + free-text operator broadcasts from the Deck sidebar); `server.ts` renders `from_peer_id == 'deck'` messages as "informational only, do not reply", and `set_id` refuses the reserved names `deck`/`system`. v0.3.5 (desktop-only) adds opt-in quota auto-resume: `desktop/src/main/quota.ts` detects Claude Code's usage-limit screens in the PTY stream, parses the printed reset time and injects `Escape`+`continue`+`Enter` when it passes (global Settings toggle `autoResumeQuota` + per-session override, off by default; see PLAN-v0.4.md C1). v0.4.0 adds the shared per-project roadmap (PLAN-v0.4 C3): a persistent backlog in the broker (`roadmap_items`, scoped by `project_key`, zero FK to peers/groups so items outlive sessions), 5 MCP tools (`roadmap_list/get/add/update/archive`), a Deck navigation rail (Agents | Roadmap) with a MoSCoW-grouped operator view that can spawn an agent on an item (initial prompt from PLAN C2), and export/import JSON via `GET /roadmap/export` + `POST /roadmap/import` + `cli.ts roadmap-export/import`. v0.4.0 (desktop) also ships worktree sessions (PLAN C4): the advanced create menu can spawn a session in a fresh `git worktree` under `<projectDir>/.worktrees/<name>` on a new branch (`worktree-service.ts`; branch badge in the sidebar, opt-in removal on close that never forces and never deletes the branch, optional background `worktreeInit` hook from the launch config). v0.5.0 (desktop) adds the supervisor session (PLAN C5): a Home rail view hosting a Claude session that pilots the app through a loopback deck-control endpoint (`deck-control.ts`, per-launch Bearer token) bridged by a dependency-free MCP stdio server (`desktop/mcp/deck-control-mcp.ts` -> `deck-plugin/mcp/*.mjs`, run by the Electron binary as Node) injected ONLY into the supervisor via a generated `--mcp-config`; 14 `deck_*` tools (spawn/inspect/close sessions, worktrees, templates, announce) with ownership guardrails and a spawn cap. v0.6.0 is the "AI orchestrator" batch (PLAN C6-C19): Worktrees rail view (git status + attached session, orphan resume/cleanup), one-shot plan-import agent, floating read-only help assistant (`claude -p`, `--strict-mcp-config` + `--disallowedTools`), per-window team-lead 👑 (`SessionDef.lead`, broker `/announce {to_peer_id}` targeted notices), "needs you" PTY detection + system notifications, operator inbox (reserved `__operator__`/`operator` sentinel, `send_message` to 'operator' + `POST /operator-inbox` drained by the Deck every 10 s into a ✉ panel), diff/review panel with a one-shot reviewer agent reporting to the lead, per-window activity journal (ring buffer + 📜 view), roadmap dispatch queue (`roadmap_items.queue`, targeted dispatch to the lead + auto-dispatch on done), git checkpoints before spawning into a dirty tree (`git stash create` + `refs/claude-peers/checkpoint-<ts>`, 7-day purge), resume digest 📋 (sources from the GLOBAL config only — never project config — commands run with cwd=projectDir), hierarchical template composer (edit without spawning, single lead top-center, template lead only lands when the window has none), and a first-use approval dialog for PROJECT-config `launchCommand` (sha256 per project_key; refusal falls back to the global command). Every agent prompt (plan import, reviewer, dispatch, digest, help, supervisor) is a CODE CONSTANT — never operator/repo-configurable (C8 rule). v0.7.0 (desktop) renames the app to **Koryphaios** (Κορυφαῖος, the chorus leader): npm package `koryphaios`, bin `kory` (legacy `claude-peers-desk` alias kept), display name/window titles/i18n `app.brand` updated, userData + global launch-config dir moved to `koryphaios` with a chained no-overwrite copy migration from `claude-peers-desk` (migrate-data-dir.ts). The CORE keeps the `claude-peers` name (broker/server/cli/MCP channel), and protocol identifiers are deliberately unchanged: env vars `CLAUDE_PEERS_DESK_SESSION`/`CLAUDE_PEERS_DESK_PROJECT_DIR`/`CLAUDE_PEERS_DESK_SCOPE_ID`, `CLAUDE_DECK_DESIGN_*`, the reserved `deck` announce sender, and the embedded plugin id. v0.7.0 (core) + v0.8.0 (desktop) is the "briefed agents" batch (PLAN-context-et-snippets C20-C22): `roadmap_items.context` -- an implementation briefing (objective, constraints, file pointers, acceptance criteria, decisions made) that travels with the item through `roadmap_get`, the C15 dispatch and the launch prompt, exposed on `roadmap_add`/`roadmap_update` with MCP instructions telling agents to ALWAYS fill it; a context wand 🪄 in the Deck's item editor (one read-only `claude -p` pinned to haiku, C9 harness + C8 code-constant system prompt, grounds the briefing in the project files, result only fills the textarea); the plan-import prompt (C7) now requires filling context per item; and snippets -- reusable operator prompts, one `.md` per snippet, global (`<globalConfigDir>/snippets`) or project (`.claude/claude-peers/snippets`, shadows global on a name collision), inserted from a new tile ⚡ menu into Claude Code's input field via xterm bracketed paste (fill-not-send, never auto-submitted; `snippet-store.ts`, `SnippetsDialog.tsx`). Execution tracking for the v0.4+ chantiers lives in `PLAN-v0.4.md` (C20-C22 in `PLAN-context-et-snippets.md`); design rationale in `EXPLORATION-roadmap-et-auto-relance.md`.

## Roadmap partagée (v0.4)

One `roadmap_items` table in the broker DB, scoped by `project_key` (normalized git remote; repos without a remote fall back to `local:<sha256(git_root||cwd)[:16]>` computed identically by `server.ts` and the Deck's `roadmap-service.ts`). Items carry `kind` (feature|bug|debt|idea|chore), MoSCoW `priority`, `value`/`effort` levels, `status` (idea|planned|in_progress|done|archived), tags, dependencies, a `context` agent briefing (v0.7.0, PLAN C20: description = what, rationale = why, context = how/where -- filled by agents on `roadmap_add`, by the operator in the Deck editor, or by the 🪄 wand), and plain-text `created_by`/`updated_by` attribution (no FK -- no cleanup timer touches the table; deletion is a reversible archive via `deleted_at`). Routes: `POST /roadmap/list|upsert|archive|import`, `GET /roadmap/export`. Agents interact through the `roadmap_*` MCP tools (unique id prefixes accepted); the Deck reads/writes over the same routes with `by='deck'` and shows the Roadmap rail view (poll 5 s while visible).

## Architecture

Two entrypoints. Two deployment modes (local-only / HTTP).

- `server.ts` -- per-session MCP stdio server. Spawned by Claude Code, runs locally on
  the PC. Detects local context (cwd, git_root, branch, hostname, pid, project_key)
  and resolves the group via `resolveGroup` from `shared/config.ts`. Registers with
  the broker (HTTP), opens a WebSocket for push delivery. On SIGTERM/SIGINT or stdin
  EOF (Claude Code exits or shuts the MCP server down), `server.ts` calls
  `/disconnect` then `process.exit(0)`. This is the primary auto-disconnect path on
  every platform.

- `broker.ts` -- singleton HTTP + WebSocket daemon on `<BIND_HOST>:<port>` + SQLite.
  v0.3.2 endpoints: `/register`, `/heartbeat`, `/set-summary`, `/disconnect`,
  `/unregister`, `/set-id`, `/list-peers`, `/send-message`, `/poll-messages`,
  `/peek-messages`, `/group-stats`, plus the `/ws` upgrade. v0.3.4 adds `/announce`
  (Deck outbound broadcast to a group from the reserved `deck` sender; see
  "Deck announcements" below). Two cleanup timers:
  `cleanStalePeers` (every `CLAUDE_PEERS_CLEAN_INTERVAL_SEC` = 30s default:
  same-host PID-dead -> dormant via `process.kill(pid, 0)`, dormant past 24h ->
  DELETE cascade; cross-host peers where `peer.host != hostname()` are skipped in
  the PID check because the broker cannot reason about a foreign machine's process
  table -- they are reaped by the heartbeat sweep instead) and `sweepInactivePeers`
  (every `CLAUDE_PEERS_DORMANT_SWEEP_SEC` = 60s default: active without recent
  heartbeat for more than `CLAUDE_PEERS_ACTIVE_STALE_SEC` = 120s default -> dormant).
  Together with `server.ts` SIGTERM/stdin EOF cleanup, these timers replace the v0.3.1
  SessionEnd hook (removed in v0.3.2). Worst case for a crashed cross-host peer:
  ~180s before it flips dormant (120s stale threshold + one 60s sweep tick).

- `cli.ts` -- diagnostic CLI for the broker (status, peers, groups, kill-broker).
  Unchanged from v0.3 except for the version string.

- `shared/config.ts` -- Centralized configuration loader. Settings: env var > settings file > default. Group resolution (v0.3) is hierarchical: `.claude-peers.local.json` > `.claude-peers.json` (walking up to git_root) > user config `default_group` > env `CLAUDE_PEERS_GROUP` > sentinel `'default'`. Helpers: `resolveGroup`, `resolveGroupName`, `resolveGroupSecret`, `computeGroupId`, `computeGroupSecretHash`, `brokerUrl`. Settings file at `$XDG_CONFIG_HOME/claude-peers/config.json` (Linux/macOS) or `%APPDATA%\claude-peers\config.json` (Windows). The `groups` field maps logical names to secrets; `default_group` picks one. HTTP mode fields: `broker_url` (direct broker URL, overrides loopback), `broker_token` (Bearer auth token), `bind_host` (broker listen address).
- `shared/types.ts` -- Shared types. v0.3 entities: `InstanceToken` (UUID v4 routing), `PeerId` (display, mutable), `GroupId` (32-hex or 'default'), `Peer` (full row with `status: 'active' | 'dormant'`), `Message` (with `from_token`/`to_token` and `group_id`), `WsAuthFrame`, `WsMessageFrame`.
- `shared/summarize.ts` -- Auto-summary generation. Multi-provider: Anthropic (`api.anthropic.com/v1/messages`) or any OpenAI-compatible `/chat/completions` endpoint (LiteLLM, Ollama via `/v1`, vLLM, OpenAI, OpenRouter). Provider selection via `CLAUDE_PEERS_SUMMARY_PROVIDER` (default `auto` resolves at runtime). Heuristic fallback always returns a non-empty string on any failure. Also hosts `computeProjectKey` and `normalizeRemoteUrl`.
- `shared/peer-cache.ts` -- Opt-in writer (via env `CLAUDE_PEERS_STATUS_LINE_CACHE=1`, off by default) that puts the active `peer_id` into `$HOME/.claude/peers/peer-id-<cwd_key>-<session_id>.txt` after every `/register` so a status-line script (e.g. `~/.claude/status-line.sh`) can display it. The session suffix comes from `CLAUDE_CODE_SESSION_ID` (Claude Code 2.x+), passed through `sanitizeSessionId` (only `[A-Za-z0-9-]`, capped at 64 chars) -- this is what disambiguates multiple sessions sharing the same cwd, so each session shows its own peer_id. When `CLAUDE_CODE_SESSION_ID` is unset the writer falls back to the legacy `peer-id-<cwd_key>.txt` layout, and the status-line script (vocsap/claude-config) also falls back to that file when the per-session file is missing (older CC, exec hors-tool). `computeCwdKey` matches the bash sanitization (non-`[A-Za-z0-9-]` chars to `_`, last 40 chars with explicit offset to dodge the MSYS2 bash 5.2 `${str: -N}` quirk). Writes are best-effort and never break the register flow.

## Delivery hardening (v0.3.3)

Three cumulative mechanics in `broker.ts` to eliminate the "backlog avalanche on reconnect" pattern, where a peer reopening on a known cwd previously received every undelivered message accumulated for that `instance_token`.

- **A. Heuristic ack via `send_message`** (`handleSendMessage`, `ackPriorMessagesForSender`): when peer X posts a message in group G, all `delivered=0` messages addressed to X in G with `sent_at < now` are promoted to `delivered=1`. Rationale: if X replies, X has necessarily processed prior incoming messages. Covers the dominant bidirectional-conversation case without changing the protocol.
- **B. Capped WS flush** (`flushPendingForToken`, `selectUndeliveredCapped`): the WS push replay at each auth is capped to `CLAUDE_PEERS_FLUSH_MAX_COUNT=20` most-recent messages within `CLAUDE_PEERS_FLUSH_MAX_AGE_HOURS=24`. Older or excess messages stay in DB; the LLM can still pull the full backlog via `check_messages` (`/poll-messages`, uncapped).
- **C. TTL purge** (`purgeOldMessages`): a sweep at boot and every `CLAUDE_PEERS_PURGE_INTERVAL_SEC=3600` deletes `delivered=0` rows older than `CLAUDE_PEERS_MESSAGE_TTL_DAYS=7`. `delivered=1` is never purged. Manual trigger: `GET /admin/purge-messages` (returns `{ purged, cutoff_days }`).

The fire-and-forget contract from v0.3 stays intact: WS push never marks `delivered=1`. Only `check_messages` and mechanic A do, plus the TTL purge removes orphaned old undelivered rows. All four new ENV vars (`CLAUDE_PEERS_FLUSH_MAX_COUNT`, `CLAUDE_PEERS_FLUSH_MAX_AGE_HOURS`, `CLAUDE_PEERS_MESSAGE_TTL_DAYS`, `CLAUDE_PEERS_PURGE_INTERVAL_SEC`) are documented in `README.md`.

## Deck announcements (v0.3.4)

The desktop Deck is a one-way (outbound-only) broker participant: it broadcasts but never reads inbound peer traffic. Two triggers share one transport.

- **Broker `POST /announce`** (`handleAnnounce`): body `{ group_id, group_secret_hash, text, exclude_peer_id? }`. TOFU-validates an existing non-default group's secret (401 on mismatch), then inserts one `delivered=0` message per active peer in the group from the reserved sender, WS-pushing each connected target (fire-and-forget, never marks delivered). Returns `{ sent: N }`. `exclude_peer_id` skips a peer (used so a just-joined peer does not receive its own join announcement). Empty group -> `{ sent: 0 }`.
- **Reserved `deck` sender**: `DECK_INSTANCE_TOKEN='__deck__'` / `DECK_PEER_ID='deck'` (in `shared/types.ts`). `messages.from_token` has a NOT NULL FK to `peers`, so a permanently-`dormant` reserved peer row is seeded at boot to satisfy it. The row never surfaces in `list_peers`/`group-stats` (both filter `status='active'`) and is exempt from the dormant TTL purge in `cleanStalePeers`. `set_id` rejects the reserved names `deck`/`system` (`RESERVED_PEER_IDS`).
- **No-reply rendering** (`server.ts`, `isDeckSender`/`renderDeckAnnouncement`): any received message whose sender is the `deck` sentinel is rendered with an English "informational only -- do not reply, do not send_message toward 'deck'" framing in all three receive paths (WS push, fallback poll, `check_messages`), suppressing the channel's default reply nudge. Replies are also structurally impossible (the sentinel has no active target).
- **Desktop wiring**: `desktop/src/main/broker-client.ts` resolves the broker endpoint from the claude-peers config (Node fs, since `shared/config.ts` uses `Bun.file`) and POSTs `/announce`; `desktop/src/shared/announce.ts` composes the join text (`composeJoinAnnounce`, `defaultAnnounceDraft`). `SessionService` emits `peer-resolved` once on a fresh session's first peer_id resolution (never on restore); `index.ts` broadcasts the join announce (excluding the joiner). The sidebar `MessageBar` + IPC `announce:send` handle free-text operator broadcasts to the active window's group. Per-peer targeting (checkboxes) is deferred.

## Identity model (v0.3)

- `instance_token` (UUID v4, immutable) -- internal routing key. FK target for `messages`, key of the WebSocket pool, key of `peer_sessions`. Never exposed to Claude.
- `peer_id` (display, mutable via `set_id`) -- what `list_peers`, `whoami`, `send_message` speak. Unique per `(peer_id, group_id)`, all statuses included (renaming over a dormant peer's name is rejected with 409).

The default `peer_id` is derived from `(host, cwd, group_id)` via `deriveDefaultId` with a `MAX_SUFFIX=1000` guardrail. Typical defaults look like `olivier-pc-claude-peers-mcp` or `olivier-pc-foo-2` on collision.

## Resume flow (v0.3)

`session_key = sha256(host || \0 || cwd || \0 || group_id)`. On `/register`:
- session_key exists, peer is dormant -> bascule en active, returns the same `(peer_id, instance_token)`.
- session_key exists, peer is active but recorded `pid` is dead -> treat as dormant -> resurrect.
- session_key exists, peer is genuinely active (live pid) -> session_key collision: mint a fresh `(peer_id, instance_token)` with derived suffix; the original keeps the canonical session.
- session_key exists but the row was purged -> reuse the remembered `instance_token`, mint a fresh display id.
- Else -> fresh registration.

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

## Smoke check

`bun build --target=bun broker.ts server.ts cli.ts --outdir=/tmp/cp-check` bundles all entrypoints in ~20 ms and surfaces any import or type-resolution error. Use this between refactors instead of running each file. For type-strict checks: `bunx tsc --noEmit --skipLibCheck --module esnext --target es2022 --moduleResolution bundler --allowImportingTsExtensions broker.ts server.ts cli.ts`.

`bun test` runs the v0.3.3 suite (18 files, 76 cases): `tests/broker-groups.test.ts` (TOFU + isolation), `broker-resume.test.ts` (identity stability), `broker-set-id.test.ts` (rename + collision), `broker-websocket.test.ts` (auth, push, flush), `broker-ws-auth.test.ts` (Bearer-token upgrade, no-token rejection), `broker-status.test.ts` (dormant lifecycle, TTL purge), `broker-activity-status.test.ts` (fresh + resurrected peer reports active), `broker-migration.test.ts` (claude_cli_pid migration idempotency -- the column is kept for forward-compat even though no code reads it any more), `broker-sweep-inactive.test.ts` (heartbeat sweep), `broker-cross-host-cleanup.test.ts` (cleanStalePeers same-host filter), `broker-cross-host-register.test.ts` (handleRegister same-host filter + collision mints fresh id), `config-loopback.test.ts` (isLoopbackBrokerUrl detection), `peer-cache.test.ts` (status-line cwd_key derivation + cache file write + opt-in env gating), `server-stdin-eof.test.ts` (self-shutdown), `broker-fk-cleanup.test.ts` (FK cascade on dormant purge + unregister, v0.3.2.1 regression), `broker-send-ack.test.ts` (v0.3.3 heuristic ack on send_message), `broker-flush-cap.test.ts` (v0.3.3 capped WS flush + uncapped poll), `broker-message-ttl.test.ts` (v0.3.3 TTL purge of stale undelivered). Each suite spins up an ephemeral broker on a random port via `tests/_helper.ts` (env-scrubbed so developer-side `CLAUDE_PEERS_*` vars do not leak into the broker) and tears it down in `afterAll`.

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
