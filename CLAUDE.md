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

## Architecture (core)

Two entrypoints. Two deployment modes (local-only / HTTP).

- `server.ts` -- per-session MCP stdio server. Spawned by Claude Code, runs locally on
  the PC. Detects local context (cwd, git_root, branch, hostname, pid, project_key)
  and resolves the group via `resolveGroup` from `shared/config.ts`. Registers with
  the broker (HTTP), opens a WebSocket for push delivery. On SIGTERM/SIGINT or stdin
  EOF (Claude Code exits or shuts the MCP server down), `server.ts` calls
  `/disconnect` then `process.exit(0)`. This is the primary auto-disconnect path on
  every platform.

- `broker.ts` -- singleton HTTP + WebSocket daemon on `<BIND_HOST>:<port>` + SQLite.
  Endpoints: `/register`, `/heartbeat`, `/set-summary`, `/disconnect`,
  `/unregister`, `/set-id`, `/list-peers`, `/send-message`, `/poll-messages`,
  `/peek-messages`, `/group-stats`, `/announce` (Deck outbound broadcast, see
  below), `/operator-inbox`, the `/roadmap/*` routes and the `/ws` upgrade.
  Two cleanup timers:
  `cleanStalePeers` (every `CLAUDE_PEERS_CLEAN_INTERVAL_SEC` = 30s default:
  same-host PID-dead -> dormant via `process.kill(pid, 0)`, dormant past 24h ->
  DELETE cascade; cross-host peers where `peer.host != hostname()` are skipped in
  the PID check because the broker cannot reason about a foreign machine's process
  table -- they are reaped by the heartbeat sweep instead) and `sweepInactivePeers`
  (every `CLAUDE_PEERS_DORMANT_SWEEP_SEC` = 60s default: active without recent
  heartbeat for more than `CLAUDE_PEERS_ACTIVE_STALE_SEC` = 120s default -> dormant).
  Worst case for a crashed cross-host peer: ~180s before it flips dormant
  (120s stale threshold + one 60s sweep tick).

- `cli.ts` -- diagnostic CLI for the broker (status, peers, groups, kill-broker,
  roadmap-export/import).

- `shared/config.ts` -- Centralized configuration loader. Settings: env var > settings file > default. Group resolution is hierarchical: `.claude-peers.local.json` > `.claude-peers.json` (walking up to git_root) > user config `default_group` > env `CLAUDE_PEERS_GROUP` > sentinel `'default'`. Helpers: `resolveGroup`, `resolveGroupName`, `resolveGroupSecret`, `computeGroupId`, `computeGroupSecretHash`, `brokerUrl`. Settings file at `$XDG_CONFIG_HOME/claude-peers/config.json` (Linux/macOS) or `%APPDATA%\claude-peers\config.json` (Windows). The `groups` field maps logical names to secrets; `default_group` picks one. HTTP mode fields: `broker_url` (direct broker URL, overrides loopback), `broker_token` (Bearer auth token), `bind_host` (broker listen address).
- `shared/types.ts` -- Shared types: `InstanceToken` (UUID v4 routing), `PeerId` (display, mutable), `GroupId` (32-hex or 'default'), `Peer` (full row with `status: 'active' | 'dormant'`), `Message` (with `from_token`/`to_token` and `group_id`), `WsAuthFrame`, `WsMessageFrame`.
- `shared/summarize.ts` -- Auto-summary generation. Multi-provider: Anthropic (`api.anthropic.com/v1/messages`) or any OpenAI-compatible `/chat/completions` endpoint (LiteLLM, Ollama via `/v1`, vLLM, OpenAI, OpenRouter). Provider selection via `CLAUDE_PEERS_SUMMARY_PROVIDER` (default `auto` resolves at runtime). Heuristic fallback always returns a non-empty string on any failure. Also hosts `computeProjectKey` and `normalizeRemoteUrl`.
- `shared/peer-cache.ts` -- Opt-in writer (via env `CLAUDE_PEERS_STATUS_LINE_CACHE=1`, off by default) that puts the active `peer_id` into `$HOME/.claude/peers/peer-id-<cwd_key>-<session_id>.txt` after every `/register` so a status-line script can display it. The session suffix comes from `CLAUDE_CODE_SESSION_ID` (Claude Code 2.x+), passed through `sanitizeSessionId` (only `[A-Za-z0-9-]`, capped at 64 chars) -- this is what disambiguates multiple sessions sharing the same cwd. When `CLAUDE_CODE_SESSION_ID` is unset the writer falls back to the legacy `peer-id-<cwd_key>.txt` layout. `computeCwdKey` matches the bash sanitization (non-`[A-Za-z0-9-]` chars to `_`, last 40 chars with explicit offset to dodge the MSYS2 bash 5.2 `${str: -N}` quirk). Writes are best-effort and never break the register flow.

## Shared roadmap

One `roadmap_items` table in the broker DB, scoped by `project_key` (normalized git remote; repos without a remote fall back to `local:<sha256(git_root||cwd)[:16]>` computed identically by `server.ts` and the Deck's `roadmap-service.ts`). Items carry `kind` (feature|bug|debt|idea|chore), MoSCoW `priority`, `value`/`effort` levels, `status` (idea|planned|in_progress|done|archived), tags, dependencies, a `queue` position (targeted dispatch to the team-lead), a `context` agent briefing (description = what, rationale = why, context = how/where -- filled by agents on `roadmap_add`, by the operator in the Deck editor, or by the 🪄 wand), and plain-text `created_by`/`updated_by` attribution (no FK -- no cleanup timer touches the table; deletion is a reversible archive via `deleted_at`). Routes: `POST /roadmap/list|upsert|archive|import`, `GET /roadmap/export`. Agents interact through the `roadmap_*` MCP tools (unique id prefixes accepted); the Deck reads/writes over the same routes with `by='deck'`. Deferred backlog seeds live in `roadmap-seed-*.json` (import: `bun cli.ts roadmap-import <file>`).

## Delivery hardening

Three cumulative mechanics in `broker.ts` eliminate the "backlog avalanche on
reconnect" pattern (a peer reopening on a known cwd receiving the entire
historical backlog at once):

- **A. Heuristic ack via `send_message`** (`handleSendMessage`, `ackPriorMessagesForSender`): when peer X posts a message in group G, all `delivered=0` messages addressed to X in G with `sent_at < now` are promoted to `delivered=1`. Rationale: if X replies, X has necessarily processed prior incoming messages.
- **B. Capped WS flush** (`flushPendingForToken`, `selectUndeliveredCapped`): the WS push replay at each auth is capped to `CLAUDE_PEERS_FLUSH_MAX_COUNT=20` most-recent messages within `CLAUDE_PEERS_FLUSH_MAX_AGE_HOURS=24`. Older or excess messages stay in DB; the LLM can still pull the full backlog via `check_messages` (`/poll-messages`, uncapped).
- **C. TTL purge** (`purgeOldMessages`): a sweep at boot and every `CLAUDE_PEERS_PURGE_INTERVAL_SEC=3600` deletes `delivered=0` rows older than `CLAUDE_PEERS_MESSAGE_TTL_DAYS=7`. `delivered=1` is never purged. Manual trigger: `GET /admin/purge-messages`.

The fire-and-forget contract stays intact: WS push never marks `delivered=1`. Only `check_messages` and mechanic A do, plus the TTL purge removes orphaned old undelivered rows. The four ENV vars are documented in `README.md`.

## Deck announcements

The desktop Deck is a one-way (outbound-only) broker participant: it broadcasts but never reads inbound peer traffic (except the operator inbox drain).

- **Broker `POST /announce`** (`handleAnnounce`): body `{ group_id, group_secret_hash, text, exclude_peer_id?, to_peer_id? }`. TOFU-validates an existing non-default group's secret (401 on mismatch), then inserts one `delivered=0` message per active peer in the group (or the single `to_peer_id` target) from the reserved sender, WS-pushing each connected target (fire-and-forget, never marks delivered). `exclude_peer_id` skips a peer (used so a just-joined peer does not receive its own join announcement).
- **Reserved `deck` sender**: `DECK_INSTANCE_TOKEN='__deck__'` / `DECK_PEER_ID='deck'` (in `shared/types.ts`). `messages.from_token` has a NOT NULL FK to `peers`, so a permanently-`dormant` reserved peer row is seeded at boot. The row never surfaces in `list_peers`/`group-stats` and is exempt from the dormant TTL purge. `set_id` rejects the reserved names `deck`/`system` (`RESERVED_PEER_IDS`).
- **No-reply rendering** (`server.ts`, `isDeckSender`/`renderDeckAnnouncement`): any received message whose sender is the `deck` sentinel is rendered with an "informational only -- do not reply" framing in all three receive paths (WS push, fallback poll, `check_messages`). Replies are also structurally impossible (the sentinel has no active target).
- **Operator inbox**: the reserved `__operator__`/`operator` sentinel routes `send_message` to the human operator; the Deck drains `POST /operator-inbox` into its ✉ panel.

## Identity model

- `instance_token` (UUID v4, immutable) -- internal routing key. FK target for `messages`, key of the WebSocket pool, key of `peer_sessions`. Never exposed to Claude.
- `peer_id` (display, mutable via `set_id`) -- what `list_peers`, `whoami`, `send_message` speak. Unique per `(peer_id, group_id)`, all statuses included (renaming over a dormant peer's name is rejected with 409).

The default `peer_id` is derived from `(host, cwd, group_id)` via `deriveDefaultId` with a `MAX_SUFFIX=1000` guardrail. Typical defaults look like `<host>-<dir>` (e.g. `dev-pc-my-project`, `dev-pc-my-project-2` on collision).

## Resume flow

`session_key = sha256(host || \0 || cwd || \0 || group_id)`. On `/register`:
- session_key exists, peer is dormant -> bascule en active, returns the same `(peer_id, instance_token)`.
- session_key exists, peer is active but recorded `pid` is dead -> treat as dormant -> resurrect.
- session_key exists, peer is genuinely active (live pid) -> session_key collision: mint a fresh `(peer_id, instance_token)` with derived suffix; the original keeps the canonical session.
- session_key exists but the row was purged -> reuse the remembered `instance_token`, mint a fresh display id.
- Else -> fresh registration.

## Desktop (Koryphaios) overview

Electron + React 19 + zustand, xterm terminals over node-pty. Sources in
`desktop/src/{main,preload,renderer,shared}`; `@shared` maps to `src/shared`
(types and pure logic shared across processes). Highlights:

- **Sessions**: PTY tiles wrapped in a login shell (`shell-command.ts`),
  workspaces (save/restore) and portable templates; per-session worktrees
  (`worktree-service.ts`); git checkpoints before spawning into a dirty tree.
- **Supervisor (Home rail)**: a Claude session piloting the app through a
  loopback deck-control endpoint + dependency-free MCP stdio bridge, injected
  only into the supervisor via a generated `--mcp-config`.
- **Locked harnesses (C8 rule)**: every agent prompt (supervisor, plan import,
  reviewer, dispatch, digest, help assistant, context wand, graph chat/merge/
  judge) is a CODE CONSTANT, never operator- or repo-configurable. One-shot
  helpers run read-only: `claude -p` with `--strict-mcp-config` +
  `--disallowedTools` (Read/Grep/Glob stay available).
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
  is desktop-local per project_key (`graph-store.ts`).
- **Unified model picker** (`ModelPicker.tsx`, `shared/models.ts`,
  `model-registry.ts`): provider accordion + star-pinned favorites, shared by
  the graph fan-out and the agents' create menu. Frontier providers
  (Anthropic/OpenAI/Gemini) appear only when their CLI is detected
  (login-shell probe, cached); their model lists are curated in code
  (`FRONTIER_CATALOG` is the one constant to bump). Local OpenAI-compatible
  endpoints (Ollama, LiteLLM…) are configured in Settings > Models and
  discovered dynamically (`/v1/models`, `/api/tags` fallback); their API keys
  are encrypted at rest via safeStorage (`provider-secrets.ts` — the renderer
  only ever sees a `hasKey` marker).
- **Security gates**: PROJECT-config `launchCommand` requires a one-time
  operator approval (sha256 per project_key); resume-digest sources come from
  the GLOBAL config only (a repo-carried command list would execute arbitrary
  code on clone).

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

## Checks before committing

- `bun test` -- the full suite (core broker/server + desktop pure modules).
  Broker suites spin up an ephemeral broker on a random port via
  `tests/_helper.ts` (env-scrubbed so developer-side `CLAUDE_PEERS_*` vars do
  not leak in) and tear it down in `afterAll`. Desktop suites test the pure
  modules (no electron import: dirs and ciphers are injected).
- Smoke check: `bun build --target=bun broker.ts server.ts cli.ts
  --outdir=/tmp/cp-check` bundles all entrypoints in ~20 ms and surfaces any
  import or type-resolution error.
- `npm run typecheck` in `desktop/` (tsconfig.node + tsconfig.web).
- Locale parity: `desktop/locales/en.json`, `fr.json` and the embedded
  `EN_DEFAULTS` (`desktop/src/main/i18n.ts`) must carry the same key set
  (enforced by `tests/desktop-i18n.test.ts`).

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

(The `desktop/` package is the exception: it builds with electron-vite/npm and
its native module `node-pty` is rebuilt for Electron.)

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
