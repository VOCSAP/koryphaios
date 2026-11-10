# Installing claude-peers and Koryphaios

Audience: an operator installing the peers channel (and optionally the Deck)
on a machine. Commands are for Git Bash on Windows or a POSIX shell. For a
from-scratch toolchain checklist (Visual Studio Build Tools, Spectre libraries,
Android) see [BUILDING.md](BUILDING.md); this file does not repeat it.

## Contents

1. [How the pieces fit](#how-the-pieces-fit)
2. [Prerequisites](#prerequisites)
3. [Clone and install dependencies](#clone-and-install-dependencies)
4. [Build the relay and print the registration commands](#build-the-relay-and-print-the-registration-commands)
5. [Register the two MCP entries](#register-the-two-mcp-entries)
6. [Choose the mode: local, remote, replica](#choose-the-mode-local-remote-replica)
7. [Exposing a broker beyond loopback](#exposing-a-broker-beyond-loopback)
8. [The Deck (desktop app)](#the-deck-desktop-app)
9. [Sandbox sessions](#sandbox-sessions)
10. [Checking the setup](#checking-the-setup)
11. [Upgrading an existing install](#upgrading-an-existing-install)
12. [Rolling back](#rolling-back)

## How the pieces fit

Two MCP entries are registered in the user scope of Claude Code:

| Entry | Family served | Fallback when the daemon cannot serve it |
|---|---|---|
| `claude-peers` | peer tools (discovery, messaging, identity) | `bun server.ts` |
| `kory-roadmap` | the shared roadmap tools | `bun server-roadmap.ts` |

Each entry's `command` is the Rust relay (`claude-peers-relay`). The relay
copies the MCP traffic of the session to one shared MCP daemon per clone
(a bun process named `kory-mcp-daemon`), starting it when absent. If the
daemon cannot serve a family, the relay runs the `--fallback` script of the
clone instead, and `bun cli.ts mcp-daemon status` lists that session as a
fallback. Design: [docs/adr/008-shared-mcp-daemon.md](docs/adr/008-shared-mcp-daemon.md).

The daemon and the fallback both run from the clone the entries point to.
Do not delete or move that clone, and run `bun install` in it.

## Prerequisites

Required on every machine:

- git.
- [Bun](https://bun.sh). The core runs TypeScript directly.
- Claude Code v2.1.80 or later, logged in with claude.ai (channels require it).

Required to build the relay (step 4):

- A Rust toolchain with `cargo` ([rustup](https://rustup.rs)). On Linux the
  script builds the static musl target, so add it first:
  `rustup target add x86_64-unknown-linux-musl` (`aarch64-unknown-linux-musl`
  on arm64). Without cargo, or when the build fails, the script falls back to
  printing the `bun` form of the entries, which works without a relay but has
  no shared daemon.

Required only for the Deck: Node.js 20 or later with npm, and a C/C++
toolchain for `node-pty`. Both are detailed in [BUILDING.md](BUILDING.md).

For a remote broker, every client must reach the broker host on its port
(7899 by default).

## Clone and install dependencies

```bash
git clone https://github.com/vocsap/koryphaios.git ~/koryphaios
cd ~/koryphaios
bun install
```

Run `bun install` in the clone that the MCP entries will point to: the daemon
and the fallback both execute from it.

## Build the relay and print the registration commands

```bash
bun scripts/relay-setup.ts
```

What it does, from `scripts/relay-setup.ts`:

- Runs `cargo build --release --locked --bin claude-peers-relay` in `relay/`
  (with `--target <musl triple>` on Linux).
- Installs the binary at `bin/<platform>-<arch>/claude-peers-relay`
  (`.exe` on Windows), for example `bin/win32-x64/`. The `bin/*/` folders are
  git-ignored, never committed. If a binary is already installed it is
  renamed to `claude-peers-relay.exe.old` (or `.old1`, ...) first, because a
  running binary cannot be overwritten; close the Claude Code sessions that use
  it if the script reports it could not install.
- Prints a note about the build, then the two `claude mcp add` commands with
  absolute forward-slash paths, ready to paste into bash.
- Never writes the Claude Code configuration. It only prints.
- Exits non-zero when the build fails, and then prints the commands for the
  binary already installed, or the `bun` form when there is none.

Environment carried into the printed commands: the script reads the existing
user-scope `claude-peers` and `kory-roadmap` entries from `~/.claude.json`
(or `$CLAUDE_CONFIG_DIR/.claude.json`) and carries, per entry, only these
variables, and only when the value is plain (letters, digits and `_/:.@+=-`,
no URL credentials):

`CLAUDE_PEERS_BROKER_URL`, `CLAUDE_PEERS_GROUP`, `CLAUDE_PEERS_PORT`,
`CLAUDE_PEERS_LOG_DIR`, `CLAUDE_PEERS_ROLE`, `CLAUDE_PEERS_TOOLS`,
`CLAUDE_PEERS_POLL_FALLBACK_SEC`, `CLAUDE_PEERS_MCP_DAEMON_PORT`.

Anything else is refused on purpose. `CLAUDE_PEERS_FORCE_GROUP*` (it holds a
group secret) and the deposit capability are never carried, and neither is a
value with a space, `$`, `%`, a quote or credentials in a URL. For each
refusal it prints `<entry>: <NAME> not carried: add --env <NAME>=<value> by
hand.` without echoing the value; add it to the printed command yourself.

To reprint the commands without building (it picks the relay form only if the
binary is installed, and warns when the binary is older than `relay/`):

```bash
bun scripts/relay-setup.ts --print-only
```

Other arguments are rejected with `usage: bun scripts/relay-setup.ts [--print-only]`.

## Register the two MCP entries

Shape of the printed commands (the real ones carry your absolute paths and
carried `--env` pairs):

```bash
claude mcp add --scope user --transport stdio claude-peers [--env NAME=value ...] -- <clone>/bin/<platform>-<arch>/claude-peers-relay --family peers --fallback <clone>/server.ts
claude mcp add --scope user --transport stdio kory-roadmap [--env NAME=value ...] -- <clone>/bin/<platform>-<arch>/claude-peers-relay --family roadmap --fallback <clone>/server-roadmap.ts
```

Three rules:

1. **Remove the old entries first.** `claude mcp add` never replaces an
   existing key: it prints `already exists`, exits 1 and leaves the stored
   entry as is. Read where the old one lives, then remove it from that scope:

   ```bash
   claude mcp get claude-peers          # note the "Scope:" line
   claude mcp remove claude-peers --scope user
   claude mcp remove kory-roadmap --scope user
   ```

   `remove` only touches the scope it names (use `--scope local` or
   `--scope project` if `get` reported that scope). An entry left in another
   scope hides or is hidden by the new one. Save the `get` output (command,
   args, `Environment:`) outside the repository before removing, so that no
   `--env` is lost. If `claude mcp get kory-roadmap` finds an entry you did
   not create, stop: it is a collision for its owner to resolve.
2. **Paste into Git Bash, not PowerShell.** On Windows the npm `claude.ps1`
   shim strips the `--` separator, so the relay's own flags reach `claude`
   itself and fail with `error: unknown option '--family'`.
3. **The server name comes before `--env`.** `--env` is variadic and would
   swallow the name if it came first. The script prints them in the right
   order; keep it when you add variables by hand.

Then launch Claude Code with the channel so peer messages are pushed:

```bash
claude --dangerously-load-development-channels server:claude-peers
```

Without that flag peer messages still work but you must call `check_messages`.

## Choose the mode: local, remote, replica

The mode is not a flag on the MCP entry. It is resolved by every consumer
(`server.ts`, the daemon, the Deck, `cli.ts`) from the same two sources
(`shared/broker-config.ts`): the settings file, overridden by environment.

| Mode | Selected when | What the clients talk to |
|---|---|---|
| local | no `broker_url` | a loopback broker, started on first use |
| remote | `broker_url` set, `offline_replica` not true | the remote broker directly |
| replica | `broker_url` set and `offline_replica` true | a loopback broker, which replicates against `broker_url` as its upstream |

Settings file (`settingsFilePath`): `%APPDATA%\claude-peers\config.json` on
Windows; `$XDG_CONFIG_HOME/claude-peers/config.json` when set, else
`~/.config/claude-peers/config.json`, on Linux and macOS.

```json
{
  "broker_url": "http://broker-host:7899",
  "broker_token": "your-shared-secret",
  "offline_replica": true
}
```

Environment overrides, each taking precedence over the file:
`CLAUDE_PEERS_BROKER_URL`, `CLAUDE_PEERS_BROKER_TOKEN`,
`CLAUDE_PEERS_PORT` (default 7899), `CLAUDE_PEERS_OFFLINE_REPLICA`
(`1`, `true`, `yes`, `on` and their negatives). With `offline_replica: true`
a remote `broker_url` is turned into an upstream; without a `broker_url` the
flag has no effect and the mode is local.

Put `offline_replica` and `broker_token` in the shared settings file or the
user environment, never in one MCP entry's `env` only: Kory sessions,
standalone sessions and `cli.ts` must agree on the mode, or two brokers split
locks and messaging. Replica semantics, scope and the upstream role
(`serve_replicas`): [README.md](README.md#mode-3----replica-offline-capable)
and [docs/DESIGN-OFFLINE-REPLICA.md](docs/DESIGN-OFFLINE-REPLICA.md).

Groups (isolation between sessions, secrets in the settings file):
[README.md](README.md#groups).

## Exposing a broker beyond loopback

On the host that runs the shared broker:

```bash
CLAUDE_PEERS_BIND_HOST=0.0.0.0 CLAUDE_PEERS_BROKER_TOKEN=<secret> bun broker.ts
```

The token rule: a broker bound to anything other than loopback (`127.x.x.x`,
`localhost`, `::1`) without a token refuses to start. It logs
`CLAUDE_PEERS_BIND_HOST=<host> exposes the broker beyond loopback without a
broker token -- set CLAUDE_PEERS_BROKER_TOKEN (or broker_token), or bind
127.0.0.1` and exits (`bindHostRefusal` in `shared/config.ts`, called from
`broker.ts`). An empty `CLAUDE_PEERS_BIND_HOST` counts as non-loopback.

The upstream of replicas additionally needs `CLAUDE_PEERS_SERVE_REPLICAS=1`
and a token, or every replica reports it unreachable. Open the TCP port in the
firewall. Check with `curl http://127.0.0.1:7899/health`. Each client then
sets `broker_url` and the same `broker_token` as in the previous section, and
optionally its groups:

```json
{
  "broker_url": "http://broker-host:7899",
  "broker_token": "your-shared-secret",
  "groups": { "mygroup": "group-secret" },
  "default_group": "mygroup"
}
```

`serve_replicas` is read once at broker start, so changing it needs a broker
restart; confirm with `curl -s http://<upstream-host>:7899/health` and look for
`"serve_replicas":true`. Turn it on upstream before switching any client to
`offline_replica`.

Service-level deployment of a shared broker and the operator keys it trusts:
[runbooks/broker-db-migration.md](runbooks/broker-db-migration.md) and the
operator trust section below.

## The Deck (desktop app)

Skip this section if you only need the peers channel. Details:
[desktop/README.md](desktop/README.md), toolchain: [BUILDING.md](BUILDING.md).

From source (development launcher):

```bash
cd desktop
npm install        # also rebuilds node-pty for Electron
npm link           # exposes the `kory` bin
cd /path/to/your/project && kory
```

Or `npm run dev` in `desktop/` without linking. To package an installer, use
`npm run package` (current OS) or `package:win`, `package:mac`,
`package:linux`; the Windows build emits an NSIS installer and a portable zip
(`desktop/README.md`, "Package installers").

Windows tile job and `BREAKAWAY_OK`: on Windows each tile enters a job object
that kills the tile's process tree when it ends. The relay starts the shared
daemon with `CREATE_BREAKAWAY_FROM_JOB`, which only works if the tile's job
carries `BREAKAWAY_OK` (limit flags `0x2800` in `JOB_PREAMBLE_PS`,
`desktop/src/main/shell-command.ts`). Use a Deck built from a revision that
has it. With an older Deck the relay drops the option, starts the daemon
anyway and logs it, but a daemon started from a tile then dies with that
tile and another relay has to restart it
([docs/DESIGN-MCP-DAEMON.md](docs/DESIGN-MCP-DAEMON.md), section on the Kory
tile case). Only processes that ask to break away leave the job; ordinary
children still die with the tile.

Operator trust: the broker grants operator authority only to the Ed25519
public keys listed in `operator-trust.json`, next to `config.json` (same
folder as above). It is read once at broker start, so restart the broker after
a change. Provision it with:

```bash
bun cli.ts operator-trust export                       # public half of the Deck identity
bun cli.ts operator-trust init --public-key '<base64>' --label 'Personal Deck'
bun cli.ts operator-trust validate
bun cli.ts operator-trust fingerprints
```

Full procedure (personal replica, work PC, remote broker on a container,
rotation, compromise): [runbooks/operator-trust.md](runbooks/operator-trust.md)
(written in French).

## Sandbox sessions

Sandboxed tiles (Docker or Podman) do not inherit your host MCP entries. The
servers are registered with the container's own `claude`, in the user scope,
on the auth volume that every container shares, and the Docker view only
reports the state. The procedure, including why the tree used inside the
container must be a separate copy and never your host checkout, is in
[desktop/docs/sandbox.md](desktop/docs/sandbox.md), section "MCP servers
inside the sandbox". That section registers the `bun` form
(`bun CORE/server.ts`, `bun CORE/server-roadmap.ts`) and does not document
the relay form. Status: still to be validated after the daemon merge.

## Checking the setup

1. Entries and their scope:

   ```bash
   claude mcp list
   claude mcp get claude-peers      # expect "Scope: User config" and the relay as command
   claude mcp get kory-roadmap
   ```

2. In a Claude Code session started with the channel, ask it to run
   `whoami`: you should see your `peer_id`, group, host, cwd and
   `ws_connected: true`. Then `list_peers`.
3. The shared daemon, from the clone the entries point to:

   ```bash
   bun cli.ts mcp-daemon status
   ```

   It prints the code root of this clone, one line per candidate port (free,
   a live daemon with pid, version, session count and code root, a daemon of
   another clone, or no answer), and lists sessions that fell back to bun. A
   daemon of this clone that prints `daemon code is stale` runs old code (see
   the upgrade section).
4. The process: the daemon runs under the image name `kory-mcp-daemon`
   (`kory-mcp-daemon.exe` on Windows, a copy of bun placed under the peers
   directory's `bin/` folder), which tells it apart from other bun processes.
   If that copy cannot be made, the bun binary runs under its own name.
5. The broker: `bun cli.ts status` (local) or `curl <broker_url>/health`.

## Upgrading an existing install

Run from the clone the entries point to.

1. Close the Claude Code sessions and Kory tiles that use the relay, so the
   installed binary is not locked.
2. Stop the local broker. On Linux and macOS: `bun cli.ts kill-broker` (it is
   not available on Windows; there, stop the broker process by the PID you
   identify as listening on the broker port, not by image name). Broker
   hosted elsewhere: follow
   [runbooks/broker-db-migration.md](runbooks/broker-db-migration.md).
3. Back up the broker database, because the schema migrates when the broker
   starts and there is no downgrade:

   ```bash
   cp ~/.claude-peers.db ~/.claude-peers.db.bak
   ```

   (default path from `shared/config.ts`; `CLAUDE_PEERS_DB` overrides it.)
4. Update the code and dependencies:

   ```bash
   git fetch --all --prune
   git checkout <revision>        # or: git pull
   bun install
   ```

5. Rebuild the relay and reprint the commands:

   ```bash
   bun scripts/relay-setup.ts
   ```

   If the printed commands differ from your registered entries (new path, new
   env), remove and re-add them as in
   [Register the two MCP entries](#register-the-two-mcp-entries). If the
   entries already point at this binary and clone, they keep working.
6. Restart the daemon so it runs the new code. The shared daemon keeps the
   code it started with, so after any update of `mcp-daemon.ts` or `shared/`:

   ```bash
   bun cli.ts mcp-daemon status      # "daemon code is stale" means old code
   bun cli.ts mcp-daemon restart     # relays reconnect and start a daemon on the new code
   ```

7. Start a session and run the checks above.

Coming from the v0.2 schema there is no migration path: see "Upgrading from
v0.2" in [README.md](README.md#upgrading-from-v02).

## Rolling back

To return from the relay entries to the single-server `bun` form, or to an
earlier revision, follow
[runbooks/mcp-families-rollback.md](runbooks/mcp-families-rollback.md)
(written in French; its paths are those of the machine it was written on).
The order it prescribes is: close all sessions; check out the previous
revision in the clone; put the MCP entries back; restore the sandbox auth
volume entries; restart the broker so it takes the old code; recreate the
sessions.

The `bun` form of the entries, which `bun scripts/relay-setup.ts` prints when
no relay binary is installed, is:

```bash
claude mcp add --scope user --transport stdio claude-peers -- bun <clone>/server.ts
claude mcp add --scope user --transport stdio kory-roadmap -- bun <clone>/server-roadmap.ts
```

The same rules apply: remove the existing entry first, name before `--env`,
Git Bash. Note that the runbook rolls back to a revision where `claude-peers`
still served the roadmap tools and had no `kory-roadmap` entry; follow it
rather than this snippet when the target revision is that old.
