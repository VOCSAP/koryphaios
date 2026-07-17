# Architecture (core claude-peers)

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

One `roadmap_items` table in the broker DB, scoped by `project_key` (normalized git remote; repos without a remote fall back to `local:<sha256(git_root||cwd)[:16]>` computed identically by `server.ts` and the Deck's `roadmap-service.ts`). Items carry `kind` (feature|bug|debt|idea|chore), MoSCoW `priority`, `value`/`effort` levels, `status` (idea|planned|in_progress|done|archived), tags, dependencies, a `queue` position (targeted dispatch to the team-lead), a `context` agent briefing (description = what, rationale = why, context = how/where -- filled by agents on `roadmap_add`, by the operator in the Deck editor, or by the 🪄 wand), and plain-text `created_by`/`updated_by` attribution (no FK -- no cleanup timer touches the table except the lock sweep below; deletion is a reversible archive via `deleted_at`). Routes: `POST /roadmap/list|upsert|archive|import`, `GET /roadmap/export`. Agents interact through the `roadmap_*` MCP tools (unique id prefixes accepted); the Deck reads/writes over the same routes with `by='deck'`. Deferred backlog seeds live in `roadmap-seed-*.json` (import: `bun cli.ts roadmap-import <file>`).

### Agent work-lock (PLAN K2)

`locked`/`locked_by`/`locked_at` distinguish "really being worked on" from "in_progress but waiting". The lock is implicit and costs no extra round-trip: a **non-`deck`** author writing `status=in_progress` claims the lock under its `by` peer_id (the Deck's own in_progress writes never lock -- "submitted" is not "started"); any transition out of in_progress releases it; an explicit `locked: true|false` upsert field overrides. While locked, a status write (or lock claim) by anyone but the owner or `deck` is refused with 409 (`force: true` bypasses); non-status writes such as context enrichment stay open. Archive obeys the same guard.

Stale locks are swept by `releaseStaleLocks` (interval `CLAUDE_PEERS_LOCK_SWEEP_SEC=60`), which unlocks and drops the item back to `planned` (attribution `lock-sweep`) when either: the item saw **no write at all** for `CLAUDE_PEERS_LOCK_TTL_SEC=21600` (6 h -- the heartbeat keeps a peer `active` even when Claude sits idle, so the TTL is the "session open but abandoned" net), or **no active peer** carries the owner's peer_id for the item's project and the lock is older than `CLAUDE_PEERS_LOCK_GRACE_SEC=600` (grace so a reconnecting session is not stripped mid-restart). The Deck adds a finer, local-only release: a locked item owned by one of its tiles whose PTY printed nothing for 2 h is unlocked by the idle-lock watcher (`index.ts`, `SessionService.lastOutputAt`).

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
- session_key exists, peer is dormant -> flips to active, returns the same `(peer_id, instance_token)`.
- session_key exists, peer is active but recorded `pid` is dead -> treat as dormant -> resurrect.
- session_key exists, peer is genuinely active (live pid) -> session_key collision: mint a fresh `(peer_id, instance_token)` with derived suffix; the original keeps the canonical session.
- session_key exists but the row was purged -> reuse the remembered `instance_token`, mint a fresh display id.
- Else -> fresh registration.
