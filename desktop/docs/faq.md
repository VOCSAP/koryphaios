# Troubleshooting & FAQ

## Sessions & terminals

**A terminal opens but the command fails immediately.**
The machine needs the `claude` CLI (and whatever the launch command invokes).
Check `Settings > Terminal > Launch command`. If the command is a shell
alias, enable *Interactive shell* so rc/profile files load.

**A tile shows "Session expired — start new".**
The persisted Claude session id has no transcript on disk any more (expired
or pruned), so there is nothing to resume. *Start new* relaunches with the
same setup.

**The tile label doesn't match the conversation after a restore.**
Should not happen with a current claude-peers core (the deterministic
per-tile back-channel maps each tile to its exact session id). Against an
older core the app falls back to transcript discovery, where a label can map
to a different conversation when many sessions share one folder.

**A session sits paused with a ⏸ badge.**
It is waiting for the operator (permission or question screen). Click the
notification (or the tile) and answer in the terminal. Toggle the
notification in `Settings > General`.

**A session stopped with "usage limit reached".**
Claude's quota. Enable auto-resume globally (`Settings > General`) or per
session (right-click menu) and the app submits `continue` when the printed
reset time passes; otherwise resume manually.

## Groups & messaging

**`list_peers` inside a tile shows sessions that aren't in this window / none at all.**
Each window pins its sessions into its own private group. Sessions launched
*outside* the window are not in it. If a peer sees nothing, check the broker
banner (broker down = no registry).

**Red "Broker unreachable" banner.**
The claude-peers broker daemon is down or unreachable. Terminals keep
working; roadmap, inbox, announces and peer lists pause. Retry once the
broker is back (it usually auto-spawns with the first session in local mode).

**Do peers reply to megaphone messages?**
No — megaphone broadcasts and other Deck announcements are one-way,
framed "informational only, do not reply". Agents answer the operator via
`send_message` to `operator` (the Inbox).

## Roadmap

**"No team-lead" when dispatching.**
The dispatch queue targets the team-lead: designate one (👑 checkbox at
create, or sidebar right-click).

**An item is locked and can't be edited.**
An agent is actively working on it. Wait, or use ⏹ Stop to notify agents,
unlock and return it to planned.

**Two windows on the same repo see the same roadmap — bug?**
By design: the roadmap is per *project*, shared through the broker across
windows and agents.

## Workspaces & worktrees

**Restore is greyed out / "in use".**
Another live app instance holds that workspace's lock.

**Restoring a shared-group workspace lost the group.**
The secret is never persisted. Launch with the same argument
(`kory my-team`) or enable `Settings > General > Remember shared scope
secrets` beforehand.

**Removing a worktree failed.**
Git refuses to remove a worktree with uncommitted changes — commit or stash
first. The branch is always kept in any case.

## Assist features

**The help assistant answers "I cannot do that".**
By design: it is technically read-only (no MCP, no mutating tools). Do the
action in the UI, or ask the supervisor (Home view) to do it.

**The help assistant / digest fails with a CLI error.**
Its model target is a CLI that must be installed (`claude` by default —
Haiku). Switch the target in `Settings > Models`, or check the CLI login.
Local endpoints must be reachable and expose `/v1/chat/completions`.

**The supervisor refuses to spawn agents.**
The consent rule: it only spawns on an explicit operator instruction in the
conversation. Ask it directly ("spawn these agents"). Also check the trust
mode (`Settings > General > Supervisor agent spawns`) — a pending recap or
per-agent dialog may be waiting.

**The browser view can't load my app.**
Check the URL/port (dev server running?). Shift-click reload to bypass the
cache. `window.open` links deliberately open in the system browser.

## Mobile companion

**The phone can't reach the QR URL.**
Same Wi-Fi network required; the access is LAN-only, HTTPS with a
self-signed certificate (accept the browser warning). The QR token is
one-time: restart mobile access to pair again.

## Sandbox (Docker)

**Every session asks me to log in to Claude.**
It should not: the login happens once, in a dedicated modal, and agents are
blocked until it succeeds. If you see the prompt inside agent tiles instead,
the sandbox was likely enabled while sessions were already running — close
them and reopen. The credentials live in the shared `kory-claude-auth`
volume; "Disconnect" in the Docker view clears them deliberately.

**The Docker view says the broker bridge is unreachable.**
Peer messaging, the roadmap and the operator inbox go through the host
broker. With Docker Desktop it works out of the box; on a native Linux
engine the broker also has to listen beyond loopback
(`CLAUDE_PEERS_BIND_HOST=0.0.0.0`, plus a `broker_token`).

**My gitignored planning notes are missing in ephemeral-copy mode.**
The clone only carries tracked files. List the notes as globs in the Docker
view ("Extra files to copy in"). Secrets (`.env*`, keys, `.ssh`,
`.aws`) and bulk (`node_modules`, `.venv`) are never copied whatever you
list — that is deliberate.

**My hooks don't fire inside the sandbox.**
A PowerShell / `.ps1` / `C:\…` hook cannot run in the Linux container; the
Docker view lists the ones it detected. Put Linux equivalents in
`~/.claude/sandbox-overrides/` (a same-named file there replaces the base
one when projecting).

**I installed something in the container and it vanished.**
Rebuild recreates the container from the image, dropping hand-installed
state. Use it when you want reproducibility; otherwise just stop/start (the
app stops the container on close and never deletes it).

## Packaged builds (Windows)

**Double-clicking the exe does nothing / ICU error in a console.**
Launch it detached (`Start-Process koryphaios` or double-click), keep the
exe inside its folder, and prefer the `kory` wrapper `.cmd` on PATH — see
the desktop README, "Running a packaged build".
