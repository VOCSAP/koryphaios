# claude-peers

Let your Claude Code instances find each other and talk -- across multiple projects on a single PC, or across multiple PCs sharing a common broker on the LAN. When you're running 5 sessions, any Claude can discover the others and send messages that arrive instantly via the `claude/channel` protocol.

```
  Terminal 1 (poker-engine)          Terminal 2 (eel)
  +---------------------------+      +----------------------+
  | Claude A                  |      | Claude B             |
  | "send a message to        |  --> |                      |
  |  peer xyz: what files     |      | <channel> arrives    |
  |  are you editing?"        |  <-- |  instantly, Claude B |
  |                           |      |  responds            |
  +---------------------------+      +----------------------+
```

This project started as a fork of [louislva/claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) and is now a standalone repository (`vocsap/koryphaios`, home of the **Koryphaios** desktop orchestrator + the `claude-peers` core it is built on). It extends the original with:

- **Remote broker over HTTP** (multi-PC LAN/Internet setup).
- **Cross-PC repo matching** via normalized git remote URL (`project_key`).
- **Multi-provider auto-summary** (Anthropic + any OpenAI-compatible endpoint), with deterministic heuristic fallback.
- **Centralized configuration** (env vars + JSON settings file).
- **isolation by groups** (TOFU), **resume of identity** across reconnects, **WebSocket push** transport, dual `instance_token` + `peer_id` model.
- **v0.3.3 delivery hardening**: heuristic ack via `send_message` (replying acknowledges prior messages from the same group), capped WS flush at reconnect (no more backlog avalanche), TTL purge of stale undelivered messages.
- **v0.3.4 Deck announcements (`POST /announce`)**: the desktop Deck broadcasts one-way, no-reply system messages to a group -- an automatic join announcement when a session's `peer_id` resolves, plus free-text operator messages from the sidebar. Sent from a reserved non-routable `deck` sender; peers receive them framed as "informational only, do not reply" and cannot reply back.
- **v0.4 Shared roadmap**: a persistent per-project backlog in the broker (`roadmap_items`, scoped by normalized git remote, zero FK to peers/groups so items outlive sessions), driven by 5 new MCP tools (`roadmap_list/get/add/update/archive`) and the Deck's Roadmap view; JSON export/import (`bun cli.ts roadmap-export/import`).
- **v0.6 orchestrator batch (broker side)**: targeted announces (`POST /announce` with `to_peer_id`, the team-lead notification path), an **operator inbox** (agents `send_message` to the reserved `operator` peer -- the human in front of the Deck -- drained via `POST /operator-inbox`), and a `queue` position on roadmap items (the Deck's dispatch queue).
- **Desktop app (Koryphaios, formerly Koryphaios)**: dock several Claude Code peer sessions in one window and orchestrate them as a small agent team (see below).

## Desktop app (Koryphaios)

[`desktop/`](desktop/) is an Electron app that docks multiple Claude Code peer
sessions into a single window -- each tile a real terminal (PTY) -- with an
isolated peer group per window, live tiling, and save / restore of session
workspaces (each tile resumes its Claude conversation). English / French UI.

Since v0.4-v0.6 the Deck has grown into an **AI orchestrator cockpit**:

- **Navigation rail**: Home (supervisor) | Agents (tiles) | Roadmap | Worktrees | Journal.
- **Supervisor session (Home)**: a Claude session that PILOTS the app through a locked, code-constant harness -- it reads the roadmap, spawns briefed agent tiles (14 `deck_*` MCP tools behind a loopback control endpoint) and coordinates them over the peers messaging.
- **Shared roadmap view**: MoSCoW backlog with operator CRUD, "launch an agent on this item", plan-file import by a one-shot agent, and a **dispatch queue** that sends items one by one to the team-lead (auto-dispatching the next when one turns `done`).
- **Team-lead 👑**: one designated session per window, target of dispatches and integration notices.
- **Git worktrees**: spawn each agent in its own worktree/branch; a Worktrees view shows dirty state, attached sessions and orphans (resume or clean up).
- **Diff / review**: per-session or per-worktree diff panel plus a one-shot reviewer agent that reports to the team-lead.
- **Operator inbox ✉**: agents reach the human with `send_message` to `operator`; messages land in a Deck panel with system notifications.
- **Awareness**: quota auto-resume (opt-in), "needs you" detection with clickable notifications, per-window activity journal 📜 with text export.
- **Help assistant "?" and resume digest 📋**: throwaway read-only `claude -p` invocations grounded in the live app state (digest sources are configured in the GLOBAL config only -- never per repo).
- **Templates**: hierarchical composer (lead top-center) to create/edit team recipes without spawning; applying never steals an existing crown.
- **Safety**: git checkpoint (`git stash create` + `refs/claude-peers/*`) before spawning into a dirty tree, and a first-use approval dialog for any project-provided `launchCommand`. Every agent prompt (supervisor, import, reviewer, dispatch, digest, help) is a code constant -- never operator/repo-configurable.

```bash
cd desktop && npm install && npm link      # one-time
cd /path/to/your/project && kory
```

Full features, usage, build and packaging: **[desktop/README.md](desktop/README.md)**.

## Two deployment modes

### Mode 1 -- Local broker (single PC)

Broker runs on the same PC as your Claude Code sessions. See [Quick start (local)](#quick-start-local).

### Mode 2 -- Remote broker via HTTP (multi-PC, LAN/Internet)

`server.ts` runs locally on each PC and connects directly to a remote broker over HTTP. Suited for multi-PC setups and contributors. See [Quick start (HTTP)](#quick-start-http).

---

## Quick start (local)

### 1. Install

```bash
git clone https://github.com/vocsap/koryphaios.git ~/koryphaios
cd ~/koryphaios
bun install
```

### 2. Register the MCP server

```bash
claude mcp add --scope user --transport stdio claude-peers -- bun ~/koryphaios/server.ts
```

### 3. Run Claude Code with the channel

```bash
claude --dangerously-load-development-channels server:claude-peers
```

Without `--dangerously-load-development-channels`, peer messages still work but you'll have to call `check_messages` manually.

The broker daemon auto-starts on first launch.

---

## Quick start (HTTP)

### 1. On the broker host -- expose the broker publicly

Add `CLAUDE_PEERS_BIND_HOST=0.0.0.0` (and optionally a bearer token) to the broker service:

```bash
cat >/etc/claude-peers/claude-peers.env <<'EOF'
CLAUDE_PEERS_DB=/var/lib/claude-peers/peers.db
CLAUDE_PEERS_BIND_HOST=0.0.0.0
CLAUDE_PEERS_BROKER_TOKEN=your-shared-secret
EOF
systemctl restart claude-peers-broker
curl http://127.0.0.1:7899/health   # still reachable on loopback too
```

Make sure your firewall allows TCP port 7899 from the outside.

### 2. On each PC client

```bash
git clone https://github.com/vocsap/koryphaios.git ~/koryphaios
cd ~/koryphaios
bun install
```

Set `broker_url` and `broker_token` in your settings file (`%APPDATA%\claude-peers\config.json` on Windows, `~/.config/claude-peers/config.json` on Linux/macOS):

```json
{
  "broker_url": "http://broker-host:7899",
  "broker_token": "your-shared-secret",
  "groups": { "mygroup": "group-secret" },
  "default_group": "mygroup"
}
```

Register the MCP server:

```bash
claude mcp add --scope user --transport stdio claude-peers -- bun ~/koryphaios/server.ts
```

Then launch Claude Code:

```bash
claude --dangerously-load-development-channels server:claude-peers
```

### 3. Test it

In one Claude session:

> Run whoami

You'll see your `peer_id`, current group, host, cwd, and `ws_connected: true`. Then:

> List peers

> Send a message to peer [peer_id]: what are you working on?

---

## Running

### Local-only (single PC, broker auto-spawned by server.ts)

`.mcp.json`:

```json
{
  "mcpServers": {
    "claude-peers": {
      "command": "bun",
      "args": ["./server.ts"]
    }
  }
}
```

### HTTP (broker daemon on LAN/Internet)

On the broker host (Docker, systemd unit, or directly):

```sh
CLAUDE_PEERS_BIND_HOST=0.0.0.0 CLAUDE_PEERS_BROKER_TOKEN=<secret> bun broker.ts
```

On each Claude Code client, in `~/.config/claude-peers/config.json`
(`%APPDATA%\claude-peers\config.json` on Windows):

```json
{
  "broker_url": "http://broker-host:7899",
  "broker_token": "<secret>"
}
```

`.mcp.json`:

```json
{
  "mcpServers": {
    "claude-peers": {
      "command": "bun",
      "args": ["./server.ts"]
    }
  }
}
```

### Auto-disconnect on session end

No setup needed. Cleanup happens through three independent paths:

1. **`server.ts` SIGTERM / stdin EOF**: when Claude Code shuts the MCP server down at session end, `server.ts` catches it and POSTs `/disconnect`. Immediate, cross-platform.
2. **`cleanStalePeers` (broker, 30s)**: for active peers registered on the broker's own host, probes the PID with `process.kill(pid, 0)`. Dead -> dormant. Also purges dormant peers older than `CLAUDE_PEERS_DORMANT_TTL_HOURS` (24h default). Cross-host peers are skipped here (the broker cannot test a foreign machine's process table).
3. **`sweepInactivePeers` (broker, 60s)**: any active peer without a `/heartbeat` for more than `CLAUDE_PEERS_ACTIVE_STALE_SEC` (120s default) is marked dormant. This is what catches crashed cross-host clients.

Worst case for a crashed cross-host client (kill -9, power loss, network partition): ~180s before the peer flips dormant (120s stale threshold + one 60s sweep tick).

---

## Groups

Groups isolate sessions on a shared broker. A group is identified by a 32-hex `group_id` derived from `sha256(group_secret).slice(0, 32)`. The secret never leaves your PC -- the broker only ever sees the hash.

### How a group is resolved (first wins)

0. Forced group via `CLAUDE_PEERS_FORCE_GROUP` / `CLAUDE_PEERS_FORCE_GROUP_FILE` (see below)
1. `.claude-peers.local.json` walking up from cwd to git_root
2. `.claude-peers.json` walking up from cwd to git_root
3. `default_group` from your user config
4. Env var `CLAUDE_PEERS_GROUP`
5. Sentinel `'default'` (open, no auth)

### Forced group (app-driven isolation)

A parent process (e.g. the Claude Peers Desk app) can pin every child session to an isolated group without writing any project file. When set, this takes precedence over all other sources above.

| Env var                          | Effect                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `CLAUDE_PEERS_FORCE_GROUP`       | The group secret, supplied directly. Highest priority.                                                   |
| `CLAUDE_PEERS_FORCE_GROUP_FILE`  | Path to a file (e.g. `chmod 600`) whose trimmed content is the group secret. Used only if the env var above is unset. `CLAUDE_PEERS_FORCE_GROUP` wins when both are set. |
| `CLAUDE_PEERS_FORCE_GROUP_NAME`  | Optional display name for the forced group. Defaults to `forced-<group_id first 8 chars>`.               |

The file transport keeps the secret out of the process environment (and out of `ps`/argv); the env var is the fallback when filesystem access fails. An empty-string env var or a missing/unreadable file is treated as unset and resolution falls through to the normal sources.

### User config -- where the secrets live

`$XDG_CONFIG_HOME/claude-peers/config.json` on Linux/macOS, `%APPDATA%\claude-peers\config.json` on Windows.

```json
{
  "groups": {
    "perso":  "secret-perso-aaaa",
    "work":   "secret-work-bbbb",
    "shared": "secret-shared-cccc"
  },
  "default_group": "perso"
}
```

### Project config -- which group this repo defaults to

`.claude-peers.json` at the repo root (commit this):

```json
{ "group": "work" }
```

`.claude-peers.local.json` at the repo root (gitignore this) for personal overrides:

```json
{ "group": "perso" }
```

The only allowed field is `group`. Any other key is rejected with a stderr warning.

### TOFU (Trust On First Use)

The first peer to register with a never-seen `group_id` plants the `secret_hash` in the broker. Every subsequent register against the same `group_id` is rejected with HTTP 401 unless its hash matches. You don't pre-create groups; the first connection does it for you.

### Switching groups mid-session

```text
> Use switch_group "work"
```

The current peer is parked as `dormant` (resume-able), and a fresh registration is made in the target group. The WebSocket reconnects to the new identity.

---

## What Claude can do (MCP tools)

| Tool             | What it does                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `list_peers`     | Find other Claude Code instances in your group -- scoped to `machine`, `directory`, or `repo` (cross-PC)      |
| `send_message`   | Send a message to another peer in your group by `peer_id` (push via WebSocket, fallback queues to poll)       |
| `set_summary`    | Describe what you're working on (visible to peers in your group)                                              |
| `check_messages` | Manual poll fallback (rarely needed; messages normally arrive via WS push)                                    |
| `whoami`         | Show your `peer_id`, host, cwd, current group, summary, and `ws_connected` status                             |
| `list_groups`    | Show available groups (from your user config) and how many active peers each has                              |
| `switch_group`   | Move this session to another group by name. Disconnects the current peer (kept dormant) and re-registers      |
| `set_id`         | Rename your `peer_id` within the current group. Refused with 409 on collision (active or dormant)             |
| `roadmap_list` / `roadmap_get` | Browse the project's shared backlog (filters: kind/status/priority/tag; unique id prefixes accepted) |
| `roadmap_add`    | Record a feature/bug/debt/idea/chore with MoSCoW priority, value/effort, tags, dependencies                   |
| `roadmap_update` / `roadmap_archive` | Keep item statuses current (`planned` → `in_progress` → `done`); archive is a reversible soft delete |

The `repo` scope matches across PCs by normalizing `git remote get-url origin`.

Two **reserved recipients** exist for `send_message`: `operator` reaches the
HUMAN in front of the desktop Deck (questions, results, blockers -- drained
into the Deck's inbox panel, no reply comes back through this channel), and
`deck` is the non-routable sender of Deck announcements (never a valid
target). `set_id` refuses the reserved names `deck`, `system` and `operator`.

---

## CLI

The CLI talks to the broker over loopback, so run it on the broker host:

```bash
cd /srv/claude-peers

bun cli.ts status                         # broker status, ws clients, all active peers
bun cli.ts peers [--include-dormant]      # list peers across all groups
bun cli.ts groups                         # active peer counts per group_id
bun cli.ts kill-broker                    # stop the broker (Linux/macOS only)
```

`bun cli.ts send` was removed in v0.3: the broker requires a valid `instance_token` for routing, which only registered Claude Code peers hold. Use the MCP `send_message` tool from a Claude session.

For a remote broker, just ssh into the host:

```bash
ssh user@broker-host "cd /srv/claude-peers && bun cli.ts peers"
```

---

## Auto-summary

On startup, each session generates a heuristic summary immediately, then asynchronously asks an LLM provider for a richer 1-2 sentence summary. If the LLM returns a usable response, it replaces the heuristic via `set_summary`.

Three providers are supported. Selection is automatic when `CLAUDE_PEERS_SUMMARY_PROVIDER=auto` (default):

1. If `CLAUDE_PEERS_SUMMARY_BASE_URL` is set -> **openai-compat**.
2. Else if `ANTHROPIC_API_KEY` (or `CLAUDE_PEERS_SUMMARY_API_KEY`) is set -> **anthropic**.
3. Else -> **none** (heuristic only).

### Anthropic direct

```bash
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_PEERS_SUMMARY_MODEL=claude-haiku-4-5-20251001   # default, override if needed
```

### OpenAI-compatible (LiteLLM, Ollama, OpenRouter, OpenAI, vLLM)

```bash
CLAUDE_PEERS_SUMMARY_PROVIDER=openai-compat
CLAUDE_PEERS_SUMMARY_BASE_URL=http://litellm-host:4000/v1
CLAUDE_PEERS_SUMMARY_API_KEY=sk-litellm-master-key
CLAUDE_PEERS_SUMMARY_MODEL=ollama_chat/qwen2.5:7b
```

Failure modes (no key, HTTP error, timeout, parse error) silently degrade to the heuristic.

---

## Configuration

Every setting can be provided via an environment variable or via a JSON settings file. Resolution order: **env var > settings file > default**.

### Settings file location

- **Linux/macOS**: `$XDG_CONFIG_HOME/claude-peers/config.json` (default `~/.config/claude-peers/config.json`)
- **Windows**: `%APPDATA%\claude-peers\config.json`

### Reference table

| Env var                              | Settings file key      | Default                              | Side                  | Description                                                            |
| ------------------------------------ | ---------------------- | ------------------------------------ | --------------------- | ---------------------------------------------------------------------- |
| `CLAUDE_PEERS_PORT`                  | `port`                 | `7899`                               | broker / server / cli | Broker HTTP port (loopback)                                            |
| `CLAUDE_PEERS_DB`                    | `db`                   | `/var/lib/claude-peers/peers.db` (Linux/macOS) or `~/.claude-peers.db` (Windows) | broker                | SQLite database path                                                   |
| `CLAUDE_PEERS_GROUP`                 | (n/a)                  | (none)                               | server                | Group name override; env-level fallback before the 'default' sentinel  |
| (n/a)                                | `groups`               | `{}`                                 | server                | Map of group name -> secret. Keep secrets out of the repo.             |
| (n/a)                                | `default_group`        | `null`                               | server                | Group name used when no project file overrides                         |
| `CLAUDE_PEERS_DORMANT_TTL_HOURS`     | (n/a)                  | `24`                                 | broker                | Hours after which dormant peers are purged                             |
| `CLAUDE_PEERS_ACTIVITY_TIMEOUT_SEC`  | (n/a)                  | `1800` (30 min)                      | broker                | Seconds of inactivity before a peer transitions from `active` to `sleep` in `list_peers` |
| `CLAUDE_PEERS_ACTIVE_STALE_SEC`      | (n/a)                  | `120`                                | broker                | Seconds without heartbeat before an active peer is swept to dormant    |
| `CLAUDE_PEERS_DORMANT_SWEEP_SEC`     | (n/a)                  | `60`                                 | broker                | Interval (seconds) between sweep-inactive-peers timer runs             |
| `CLAUDE_PEERS_CLEAN_INTERVAL_SEC`    | (n/a)                  | `30`                                 | broker                | Interval (seconds) between `cleanStalePeers` runs: same-host PID liveness check + dormant TTL purge. Cross-host peers (`peer.host != hostname()`) are skipped in the PID check and reaped by `CLAUDE_PEERS_ACTIVE_STALE_SEC` instead. |
| `CLAUDE_PEERS_FLUSH_MAX_COUNT`       | (n/a)                  | `20`                                 | broker                | v0.3.3: max number of pending messages replayed by `flushPendingForToken` on each WS auth. Prevents backlog avalanche at reconnect; `check_messages` still returns the full backlog. |
| `CLAUDE_PEERS_FLUSH_MAX_AGE_HOURS`   | (n/a)                  | `24`                                 | broker                | v0.3.3: max age (hours) of pending messages replayed by `flushPendingForToken`. Anything older stays in DB until purged or pulled explicitly. |
| `CLAUDE_PEERS_MESSAGE_TTL_DAYS`      | (n/a)                  | `7`                                  | broker                | v0.3.3: undelivered messages older than this are purged by `purgeOldMessages` (runs at boot + every `CLAUDE_PEERS_PURGE_INTERVAL_SEC`). Delivered messages are never purged. |
| `CLAUDE_PEERS_PURGE_INTERVAL_SEC`    | (n/a)                  | `3600` (1h)                          | broker                | v0.3.3: interval (seconds) between `purgeOldMessages` runs. Manual trigger via `GET /admin/purge-messages`. |
| `CLAUDE_PEERS_WS_IDLE_TIMEOUT_SEC`   | (n/a)                  | `600` (10 min)                       | broker                | Seconds of WebSocket silence before the broker closes the connection   |
| `CLAUDE_PEERS_POLL_FALLBACK_SEC`     | (n/a)                  | `5`                                  | server                | Seconds between fallback polls when the WebSocket is down (uses `/peek-messages`, never marks delivered) |
| `CLAUDE_PEERS_SUMMARY_PROVIDER`      | `summary_provider`     | `auto`                               | server                | `auto` / `anthropic` / `openai-compat` / `none`                        |
| `CLAUDE_PEERS_SUMMARY_BASE_URL`      | `summary_base_url`     | (none)                               | server                | Base URL for `openai-compat`                                           |
| `CLAUDE_PEERS_SUMMARY_API_KEY`       | `summary_api_key`      | (none)                               | server                | Bearer token for the summary provider                                  |
| `CLAUDE_PEERS_SUMMARY_MODEL`         | `summary_model`        | `claude-haiku-4-5-20251001`          | server                | Model name passed to the provider                                      |
| `ANTHROPIC_API_KEY`                  | (n/a)                  | (none)                               | server                | Anthropic API key. Used when provider=anthropic if `summary_api_key` is unset. |
| `CLAUDE_PEERS_ANTHROPIC_MODEL`       | `anthropic_model`      | (alias)                              | server                | Backward-compat alias of `summary_model`                               |
| `CLAUDE_PEERS_BROKER_URL`            | `broker_url`           | (none)                               | server                | HTTP mode: direct broker URL (e.g. `http://my-server:7899`). Overrides loopback. |
| `CLAUDE_PEERS_BROKER_TOKEN`          | `broker_token`         | (none)                               | broker + server       | Bearer token for broker auth. Broker requires it on all requests (except `/health`); server sends it on every call. |
| `CLAUDE_PEERS_BIND_HOST`             | `bind_host`            | `127.0.0.1`                          | broker                | Broker bind address. Set `0.0.0.0` to accept external connections.     |
| `CLAUDE_PEERS_STATUS_LINE_CACHE`     | (n/a)                  | (unset = off)                        | server                | Opt-in: when truthy (`1`, `true`, `yes`, `on`, case-insensitive), `server.ts` writes the active `peer_id` to `$HOME/.claude/peers/peer-id-<cwd_key>-<session_id>.txt` (per-session, from `CLAUDE_CODE_SESSION_ID`) on every register so a status-line script can read it; it falls back to the legacy `peer-id-<cwd_key>.txt` when the session id is unset. Any other value (or unset) disables the write. See [Status-line integration](#status-line-integration). |

### Example settings file (with groups)

Local mode (groups only):

```json
{
  "groups": {
    "perso":  "secret-perso-aaaa",
    "work":   "secret-work-bbbb",
    "shared": "secret-shared-cccc"
  },
  "default_group": "perso",
  "summary_provider": "auto",
  "summary_model": "claude-haiku-4-5-20251001"
}
```

HTTP mode (remote broker):

```json
{
  "broker_url": "http://broker-host:7899",
  "broker_token": "your-shared-secret",
  "groups": {
    "perso":  "secret-perso-aaaa",
    "work":   "secret-work-bbbb"
  },
  "default_group": "perso",
  "summary_provider": "auto",
  "summary_model": "claude-haiku-4-5-20251001"
}
```

---

## Troubleshooting

### `whoami` shows `ws_connected: false`

The fallback poll runs every 5s while the WebSocket is disconnected. It peeks at undelivered messages (without marking them delivered) and pushes them via `mcp.notification()`. Messages still arrive -- just with up to 5s latency instead of instant push. Common causes:

- Broker is not running. `curl http://127.0.0.1:7899/health`.
- The broker version is older than v0.3 -- the `/ws` endpoint didn't exist. Update the broker host.
- Bun's WebSocket client throws on the first connect; the backoff is 1s -> 2s -> ... -> 30s. Check `stderr` for `WebSocket closed; will retry`.

### `Group 'X' not in user config`

Either `.claude-peers.json` references a group name that's missing from the user config, or you used `switch_group` with an unknown name. Add the group + its secret in `~/.config/claude-peers/config.json` and restart the session.

### Two PCs see each other in `default` but not in their custom group

The `group_id` is derived from `sha256(secret).slice(0, 32)`. If the two PCs use different secret strings under the same group name, they end up in different `group_id`s. Either share the same secret across PCs, or check that the user config on both sides lists the same string (whitespace and case matter).

### "session_key collision" warning in broker logs

Two `bun server.ts` processes registered with the same `(host, cwd, group_id)` while both alive. The first kept the resume identity, the second got a fresh `peer_id` like `myhost-foo-2`. This usually means you launched two Claude Code sessions in the same directory simultaneously -- expected behavior.

---

## Status-line integration

If you run a Claude Code status-line script that wants to display the current `peer_id`, opt in with:

```bash
export CLAUDE_PEERS_STATUS_LINE_CACHE=1
```

(Or `true`, `yes`, `on` -- case-insensitive. Any other value, including `0`/`false`/unset, leaves the feature off.)

When enabled, `server.ts` writes the active `peer_id` to:

```
$HOME/.claude/peers/peer-id-<cwd_key>-<session_id>.txt   # Claude Code >= 2.x (CLAUDE_CODE_SESSION_ID set)
$HOME/.claude/peers/peer-id-<cwd_key>.txt                # legacy fallback (session id unset)
```

on every successful `/register` (initial registration and group switches). `<cwd_key>` is computed from `cwd` by replacing every non-alphanumeric character (except `-`) with `_` and keeping the last 40 characters. `<session_id>` is `CLAUDE_CODE_SESSION_ID` sanitized to `[A-Za-z0-9-]` (capped at 64 chars) -- this is what lets several sessions sharing the same cwd each keep their own `peer_id` file. When the session id is unset (older Claude Code, or exec outside a tool), the writer uses the legacy single-file layout.

A reference status-line lookup, in POSIX bash, that matches this convention -- it prefers the per-session file and falls back to the legacy one:

```bash
get_peer_id() {
    local sanitized cwd_key base session_file legacy_file len offset
    sanitized=$(printf '%s' "$CWD" | sed 's/[^a-zA-Z0-9-]/_/g')
    len=${#sanitized}
    # Explicit offset avoids the MSYS2 bash 5.2 quirk where ${str: -N}
    # returns empty when len(str) < N.
    offset=$(( len > 40 ? len - 40 : 0 ))
    cwd_key="${sanitized:$offset}"
    base="$HOME/.claude/peers/peer-id-${cwd_key}"
    # Per-session file first (CLAUDE_CODE_SESSION_ID), then the legacy fallback.
    session_file="${base}-${CLAUDE_CODE_SESSION_ID}.txt"
    legacy_file="${base}.txt"
    if [[ -n "$CLAUDE_CODE_SESSION_ID" && -f "$session_file" ]]; then
        cat "$session_file"
    elif [[ -f "$legacy_file" ]]; then
        cat "$legacy_file"
    else
        echo ""
    fi
}
```

The write is best-effort: a FS failure is swallowed and never breaks `/register`. The feature is off by default because the cache is only useful when a status-line script consumes it, and most users do not want `server.ts` to write under `$HOME`.

---

## Architecture

**Mode 1 -- Local** (single PC):

```
Claude Code --stdio--> server.ts --loopback--> broker.ts + peers.db
                       (auto-spawns broker)
```

**Mode 2 -- HTTP** (multi-PC, LAN/Internet):

```
Local PC                                      Broker host
+------------------------------+              +----------------------------+
| Claude Code                  |              |                            |
|     v stdio (MCP)            |  HTTP + WS   |                            |
| server.ts --(resolve group, <-------------> broker.ts (0.0.0.0:7899)    |
|   send Bearer token)         |              |     v                      |
+------------------------------+              | /var/lib/claude-peers/     |
                                              |   peers.db                 |
                                              +----------------------------+
```

In HTTP mode, `server.ts` runs locally and connects directly to `CLAUDE_PEERS_BROKER_URL`. No SSH is involved.

In local mode, `server.ts` auto-spawns a broker on loopback and resolves the group from the user config.

---

## Flags reference (Claude Code CLI)

| Flag                                                          | Purpose                                                                                                                  | Required?   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------- |
| `--dangerously-load-development-channels server:claude-peers` | Enables `claude/channel` push for the claude-peers MCP server. Without it, peers must call `check_messages` manually.    | Recommended |
| `--dangerously-skip-permissions`                              | Skips the per-tool approval prompt. Useful so that incoming peer messages don't require a click to respond.              | Optional    |

---

## Requirements

- [Bun](https://bun.sh) on every host involved (broker + clients).
- Claude Code v2.1.80+ on every PC client.
- claude.ai login (channels require it).
- For HTTP mode: network access from each client to the broker host on port 7899.

---

## Upgrading from v0.2

There is no migration. The v0.3 schema differs in incompatible ways (new `groups` and `peer_sessions` tables, `instance_token` PK, `from_token`/`to_token` on messages, `peer_id` decoupled from routing).

```bash
systemctl stop claude-peers-broker
rm /var/lib/claude-peers/peers.db
git pull
systemctl start claude-peers-broker
curl http://127.0.0.1:7899/health
```

Existing in-flight messages are dropped along with the DB. Sessions transparently re-register on first use.

## Repository rename (claude-peers-mcp -> koryphaios)

The GitHub repository was renamed to `vocsap/koryphaios` (and detached from the
original fork) when the desktop app became Koryphaios (v0.7). GitHub redirects
the old clone/fetch/push URLs, so existing clones keep working — but the
**shared roadmap is keyed by the normalized remote URL** (`project_key`), which
is read from each clone's `.git/config`, not from GitHub:

- a clone still pointing at `…/claude-peers-mcp.git` computes
  `github.com/vocsap/claude-peers-mcp`;
- a fresh clone (or one after `git remote set-url`) computes
  `github.com/vocsap/koryphaios`.

Mixed remotes therefore split the roadmap in two. To migrate once and for all,
update every clone's remote, then re-key the items on the broker host:

```bash
# each clone:
git remote set-url origin https://github.com/vocsap/koryphaios.git

# broker host (old key -> new key; old items stay behind as a backup):
bun cli.ts roadmap-export github.com/vocsap/claude-peers-mcp > roadmap-rename.json
bun cli.ts roadmap-import roadmap-rename.json --project-key github.com/vocsap/koryphaios
```

## Migration from upstream (OpenAI -> Anthropic)

Coming from `louislva/claude-peers-mcp`?

- The auto-summary now uses **Anthropic** (`claude-haiku-4-5-20251001`) by default, with an OpenAI-compatible alternative for LiteLLM/Ollama/etc. Replace `OPENAI_API_KEY` with `ANTHROPIC_API_KEY` in your env, or set the openai-compat variables.
