# Sandbox mode (Docker)

Sandbox mode runs a project's agent sessions inside a **persistent
Docker/Podman container** instead of directly on the machine. The **supervisor
stays on the host** and keeps piloting the app — including installing things
inside the container for you.

The mental model is a disposable-but-persistent LXC: the container is created
on demand, **stopped** (never deleted) when the app closes, restarted in the
exact same state next time, and only removed when you explicitly say so in the
🏺 **Docker** rail view.

## What it protects (and what it does not)

Two work modes, chosen per project in the Docker view:

| Mode | What is mounted at `/work` | Your real project folder |
|------|---------------------------|--------------------------|
| **Mount the project** (default) | the project itself | agents edit it directly — work lands on your disk as usual |
| **Ephemeral copy** | a throwaway `git clone --local` of it | untouchable; work leaves through git |

In **mount** mode the sandbox protects *the rest of the machine*: your
credentials, other folders, the OS. In **ephemeral copy** mode the project is
protected too — agents commit in the clone and push the branch back to your
repo (the clone's `origin` IS your local repo, so `git push origin
<branch>` from a session lands the work; pushing the checked-out branch is
refused by git, so work on a branch). "Reset clone" throws the copy away.

Because a clone only carries *tracked* files, copy mode also takes an
allow-list of **gitignored globs to copy in** (planning notes, local
fixtures) — one glob per line in the Docker view. A hard deny-list always
wins over whatever you list: `.env*`, keys/certificates, `.ssh`, `.aws`,
`node_modules`, `.venv`, `.git`. Globs that matched nothing are reported so a
typo is visible instead of silent.

## Prerequisites

- Docker Desktop (Windows/macOS/Linux) or Podman — the mode card shows what
  was detected and links to the installers when nothing is.
- The sandbox image. The Docker view's **Build image** button runs the
  Dockerfile shipped with Koryphaios in a real terminal (a few minutes on the
  first run: Debian base + git + bun + the Claude CLI). Equivalent by hand:

  ```bash
  docker build -t koryphaios-sandbox desktop/resources/sandbox
  ```

  The image name is editable if you maintain your own.

## Enabling / disabling

The Docker view carries the per-project toggle. Two rules:

- Any sandbox setting (mode on/off, work mode, image) is refused while a
  session is alive: a live terminal cannot be teleported across the boundary.
  Close the sessions first.
- Changes only affect **new** sessions.

Settings are per project and operator-owned (app state, never the repo — a
cloned repository cannot decide to leave the sandbox).

## First-run authentication

The container needs its own Claude login, stored in the shared
`kory-claude-auth` **volume** (mounted at `~/.claude` in every sandbox
container — one login covers all your projects and survives container
removal; your host login is never copied in).

Agents are **blocked** until that login exists: spawning opens a modal —
*Next* starts a terminal inside the container running the CLI's standard login
flow (open the OAuth URL in your browser, paste the code back). The Deck polls
the credentials file; on success the modal closes itself and a toast confirms.
If the tokens expire later (e.g. weeks of downtime), the same modal reappears
on the next spawn. **Re-authenticate** runs the flow at any time;
**Disconnect** wipes the credentials from the volume (refused while a sandbox
container is running).

## Your global Claude config inside the sandbox

At each container start the Deck **copies** your operator config into the
container's `~/.claude`: global `CLAUDE.md`, `agents/`, `skills/`, `plugins/`
and `settings.json`. The Docker view reports exactly what was projected.

It is a copy, never a mount, and the reason matters: `settings.json` carries
hooks that run on the **host** in your non-sandboxed sessions. A read-write
mount would let a sandboxed agent write a hook and have it execute outside the
sandbox — a clean escape. The agent may wreck its copy; it dies with the
container. Nothing else travels: `.credentials.json`, transcripts, todos and
telemetry stay on the host.

**Windows hooks.** A hook calling PowerShell, `cmd`, a `.ps1/.bat/.exe` or a
`C:\…` path cannot run in the Linux container. The Docker view lists those it
detected. Supply Linux equivalents by dropping same-named files in
`~/.claude/sandbox-overrides/` — an entry there wins over the base one
(`sandbox-overrides/settings.json` replaces `settings.json`). Files in that
folder that are not projectable are reported too, so a misplaced file is not
silently ignored.

## The Docker view

- **Mode card** — engine state/version, the on/off toggle, the work mode, the
  project's container (`kory-sbx-<hash>`) and its state, published ports, the
  broker-bridge verdict, and a drift badge when the image was rebuilt after
  this container was created (Rebuild to pick it up — everything installed by
  hand inside is lost).
- **Ephemeral copy card** (copy mode only) — clone path, the gitignored-globs
  editor, unmatched globs, Reset clone.
- **Image card** — image name, presence badge, Build image.
- **Authentication card** — volume status, Re-authenticate, Disconnect.
- **Operator config projected** — what travelled, plus hook warnings.
- **Containers list** — every `kory-sbx-*` container on the machine (all
  projects): start / stop / **rebuild** (recreate from the image) / **remove**
  (confirm dialog; the auth volume and your project folder are never touched).
  Actions on the current project's container are refused while sessions run.

## How sessions run

Each spawn writes a small launch script into a Deck-owned run dir (mounted at
`/kory-run`) and the tile's PTY runs `docker exec -it <container> bash
/kory-run/cmd-<id>.sh`. Everything terminal-side (thinking detection, quota
auto-resume, attention, search) behaves exactly as before — the PTY does not
care what is at the other end.

**Peer messaging.** Sessions inside reach the host's claude-peers broker
through `host.docker.internal` (injected `CLAUDE_PEERS_BROKER_URL`), so
messaging, announcements, the operator inbox and the roadmap keep working. The
Docker view *tests this for real* (a `curl /health` from inside the container)
instead of guessing: with Docker Desktop it resolves natively; on a **native
Linux engine** you must also bind the broker beyond loopback
(`CLAUDE_PEERS_BIND_HOST=0.0.0.0`, ideally with a `broker_token`) or the badge
turns "unreachable".

**Resume.** Transcripts live in the auth volume
(`~/.claude/projects/…` inside the container), so sessions fork-resume across
app restarts and even across a container rebuild. The Deck reads them
container-side; the host's own transcripts are ignored while the sandbox owns
the project.

**Dev servers.** Ports listed in the project's sandbox settings (default 3000,
5173, 8080) are published to `127.0.0.1` at container create, so a dev server
started by a sandboxed agent is reachable from the embedded Browser view at
`http://localhost:<port>` as usual. Changing the port list requires a
container **rebuild** (engine limitation: ports cannot be added to a live
container).

The supervisor is **exempt** from sandboxing: it pilots the app itself, and
its MCP bridge points at the host Electron binary and a loopback control port
that do not exist inside a container.

## Asking the supervisor to manage the environment

With sandbox mode on, the supervisor gains `deck_sandbox_exec`: ask it
*"install ripgrep in the sandbox"* or *"add zod to the instance"* and it runs
the command inside this project's container, in `/work`, as the container
user. Output is returned (clipped), the call is journaled, and it is refused
when sandbox mode is off. The command is handed to the container's shell as a
single argument — it never reaches a shell on your machine.

## Limits

- Sessions always run in a LOCAL container. Running them on a remote host
  (SSH, a Proxmox LXC) was considered and **dropped**: the local engine
  covers the need, and a remote backend would lose the bind mount that makes
  the Deck's git/diff/explorer views work.
- Long-lived containers accumulate hand-installed state that no Dockerfile
  records. That is the point of the persistence, but the drift badge and
  Rebuild are there when you want reproducibility back.
- Bind-mount throughput on Windows (`C:\…` into a Linux container) goes
  through the WSL2 filesystem bridge and is noticeably slower than native on
  large repos; keeping the project inside the WSL2 filesystem avoids it.
