# Changelog

## v0.3.5 (desktop) -- 2026-07-14

### Added
- **Quota auto-resume (opt-in).** When a tile hits Claude's usage limit, the
  Deck now detects the rate-limit screen in the PTY stream (rolling
  ANSI-stripped buffer; old "limit reached ∙ resets 2pm", new "You've hit your
  limit · resets 10pm (TZ)" and "resets Nm" formats, plus conservative
  fallbacks), parses the printed reset time (local clock; >1h past rolls to
  tomorrow; unknown time retries every 15 min), and once it passes injects
  `Escape` → `continue` → `Enter` — one shot per episode, exactly what a human
  would type. Off by default: global toggle in Settings > General
  (`autoResumeQuota`), overridable per session from the sidebar right-click
  menu (`SessionDef.autoResume`). The tile/sidebar dot turns orange while
  limited, with an "auto-resume at HH:MM" badge and a toast on injection
  (`session:quota` IPC event). New `desktop/src/main/quota.ts` +
  `tests/desktop-quota.test.ts` (PLAN-v0.4 C1).
- **Initial prompt at spawn.** A session can now be created with a prompt that
  is submitted to Claude as its positional argument on the fresh launch —
  never re-played on resume (`--resume` restores the conversation). New
  "Initial prompt" field in the advanced create menu; launch presets'
  `prompt` field (declared since M5, previously unwired) now pre-fills it.
  Quoting is platform-aware (POSIX `'\''` vs PowerShell `''`), covered in
  `tests/desktop-launch.test.ts`. Groundwork for roadmap→agent and the
  supervisor (PLAN-v0.4 C2).

## v0.3.4 -- 2026-06-03

### Added
- **Deck outbound announcements (`POST /announce`).** The desktop Deck can now
  broadcast one-way, fire-and-forget system messages to every active peer in a
  group: an automatic join announcement (with the newcomer's `peer_id` and its
  agent/model/effort) when a session's peer_id resolves, and free-text operator
  messages from a sidebar message bar (Send button). Both go through a single
  `/announce` endpoint.
- **Reserved system sender.** Announcements are stored from a non-routable
  sentinel (`from_token = '__deck__'`, `from_peer_id = 'deck'`), backed by one
  permanently-dormant reserved peer row so the `messages.from_token` FK resolves.
  The reserved row never appears in `list_peers`/`group-stats` and is exempt from
  the dormant TTL purge.
- **No-reply guarantee.** `server.ts` renders any `from_peer_id == 'deck'` message
  with an English "informational only -- do not reply" framing (WS push, fallback
  poll and `check_messages`), neutralising the channel's default reply nudge.
  Replies are also impossible: `send_message` toward `deck` finds no active
  target. `set_id` refuses the reserved names `deck` / `system`.

## v0.3.2.1 -- 2026-05-16

### Fixed
- **Broker crash-loop on dormant-peer purge (FK violation).** `cleanStalePeers`
  and `handleUnregister` deleted a peer row without first clearing the rows in
  `messages` that referenced it via `from_token`. Both `messages.from_token`
  and `messages.to_token` are FKs to `peers.instance_token`, so any peer that
  had sent at least one message would crash the `DELETE FROM peers` with
  `SQLiteError: FOREIGN KEY constraint failed` (errno 787). On a long-running
  broker this surfaced as a restart loop once the first dormant-with-history
  peer hit the TTL cutoff. Both DELETE paths now run
  `DELETE FROM messages WHERE from_token = ? OR to_token = ?` before deleting
  the peer (previously only `to_token = ? AND delivered = 0` was cleared, which
  covered neither `from_token` nor delivered receive-side history).
- Semantic change to be aware of: a purged peer's message history is now
  removed in full (both sent and received, regardless of `delivered`). This is
  required by the FK and is consistent with the v0.3.x model where messages
  have no lifetime independent of their peers.
- Regression covered by `tests/broker-fk-cleanup.test.ts` (sender purge via
  TTL, and direct `/unregister` of a peer with sent messages).

## v0.3.2 -- 2026-05-15

### Added
- New opt-in env var `CLAUDE_PEERS_STATUS_LINE_CACHE` (default off). When set to
  `1`/`true`/`yes`/`on` (case-insensitive), `server.ts` writes the active
  `peer_id` to `$HOME/.claude/peers/peer-id-<cwd_key>.txt` after every
  successful `/register` (initial and on group switch). This is the file
  consumed by status-line scripts such as `~/.claude/status-line.sh:get_peer_id`.
  Off by default because the cache is only useful for users who wire a
  status-line and most users will not want `server.ts` to litter `$HOME`.
- New module `shared/peer-cache.ts` exposing `computeCwdKey()`,
  `isPeerIdCacheEnabled()`, and `writePeerIdCache()`. The key derivation matches
  the bash logic exactly: non-alphanumeric (and non-hyphen) chars replaced with
  `_`, last 40 chars kept, with an explicit offset to avoid the MSYS2 bash 5.2
  `${str: -N}` quirk. Best-effort writes (FS failures do not break `/register`).

### Removed
- **SessionEnd bash hook** (`hook-session-end-peers.sh`), its installer
  (`install-hook.ts` + `--uninstall` flag), and the now-unused broker endpoint
  `POST /disconnect-by-cli-pid` (and its `DisconnectByCliPidRequest`/`Response`
  types). Rationale: the hook never fired at a useful moment on Windows
  (Claude Code detaches the hook so `$PPID = 1`, never matched a real peer),
  and on Linux/macOS it only duplicated the work that `server.ts`'s
  SIGTERM/stdin EOF handler already does. The broker-side safety nets
  (`cleanStalePeers` every 30s for same-host PIDs, `sweepInactivePeers` every
  60s for stale heartbeats >120s) cover every realistic crash scenario. Worst
  case for a crashed cross-host peer: ~180s before it flips dormant.
- Test files dropped along with the hook: `tests/hook-session-end.test.ts`,
  `tests/install-hook.test.ts`, `tests/broker-list-peers-by-host.test.ts` (the
  latter was a v0.3.2-internal experiment that never shipped to main).

### Note on upgrade

If a previous v0.3.1 install registered the hook in your `~/.claude/settings.json`
under `hooks.SessionEnd`, that entry now points at a non-existent script and
will be a silent no-op. To clean it up, remove the entry and delete
`~/.claude/hooks/session-end-peers.sh` (or `hook-session-end-peers.sh` depending
on how it was installed). No data loss, no DB migration.

### Fixed
- **Bug C -- status-line `peer_id` segment empty or stale.** Previously,
  `~/.claude/status-line.sh:get_peer_id` read a cache that only the deleted v0.2
  SSH client (`client.ts`) used to write, so on v0.3+ status-lines either showed
  nothing (fresh cwd) or a stale id from a v0.2 session. Users who set
  `CLAUDE_PEERS_STATUS_LINE_CACHE=1` now get a fresh cache file refreshed on
  every `/register`.

## v0.3.1 -- 2026-05-14

### Added
- Auto-disconnect on Claude Code session end via three mechanisms:
  - SessionEnd hook (`hook-session-end-peers.sh`) POSTs `/disconnect-by-cli-pid`.
  - `server.ts` self-shutdown on stdin EOF.
  - Broker `sweepInactivePeers` safety net (60s timer, 120s stale threshold).
- New env vars: `CLAUDE_PEERS_ACTIVE_STALE_SEC` (default 120), `CLAUDE_PEERS_DORMANT_SWEEP_SEC` (default 60).
- New broker endpoint: `POST /disconnect-by-cli-pid`.
- New DB column: `peers.claude_cli_pid INTEGER`.
- Installer: `bun install-hook.ts` (idempotent, supports `--uninstall`).

### Changed
- Hook script is now bash (.sh), installed under `~/.claude/hooks/session-end-peers.sh`
  for consistency with other Claude Code hooks (kleos pattern). The installer
  (`bun install-hook.ts`) copies it from the repo to the user's hooks directory and
  registers a `bash <path>` command in settings.json.

### Removed
- SSH deployment mode and `client.ts` (use HTTP mode or local-only).
- `CLAUDE_PEERS_REMOTE` env var.
- `tests/server-handshake.test.ts`, `tests/client-config.test.ts`.

### Fixed
- Windows: `server.ts` `BROKER_SCRIPT` path resolution via `fileURLToPath` (local-only mode now works on Windows).
- Cross-host peers no longer flap to `dormant`: `cleanStalePeers` now restricts its `process.kill(pid, 0)` liveness check to peers whose `host` matches the broker's `os.hostname()`. Foreign peers (HTTP mode, client on another machine) are reaped via the heartbeat sweep instead. Previously, all remote peers were flipped dormant on every 30s tick because their Windows/macOS PIDs were probed against the Linux broker's process table.
- New env var `CLAUDE_PEERS_CLEAN_INTERVAL_SEC` (default 30) to tune the `cleanStalePeers` interval.
