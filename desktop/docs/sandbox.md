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

The volume covers `~/.claude`, but the CLI keeps its **onboarding state** (the
account, "login done") in `.claude.json`, which by default sits *beside* that
directory in `$HOME` — outside the volume. Both the container and every session
therefore export **`CLAUDE_CONFIG_DIR=/home/kory/.claude`**, which moves that
file onto the volume with the credentials. Without it, a login done in the
throwaway container dies with it and the agent greets you with "Select login
method" while the Docker view rightly reports the volume as connected.

Because that volume is app-wide, **every operation on it runs in a throwaway
`--rm` container that mounts nothing else** — not `/work`, not the run dir, not
the published ports. Signing in therefore needs **no project container at all**:
an engine, the image and the volume are the whole prerequisite list, and
`volume create` is how the volume first comes into existence. (Auth used to be
a `docker exec` into *this project's* container, which coupled an app-wide
credential store to per-project state and made "sign in" impossible until a
project container had been created — and made **Disconnect** contradict its own
guard, since it required the container up while the guard required no sessions.)
The **image** stays required: it is what carries the `claude` CLI, and no
container can run the login without it. It is global too, built once for every
project — so with no image, **Re-authenticate** builds it first and opens the
login by itself when the build succeeds, rather than refusing.

The rail's 🏺 glyph fills **amber** whenever sandbox mode is on and that
volume holds no credentials — the state in which nothing can spawn — so the
Deck says it before you try. Any other case (mode off, signed in, image not
built so the state is unknown) draws the jar plain.

Agents are **blocked** until that login exists: spawning opens a modal —
*Next* starts a terminal running the CLI's standard login flow. The dialog
lifts the sign-in URL **out of the PTY stream** (`oauth-url.ts`) and offers
*Open the sign-in link* / *Copy the link*, because two things conspire against
copying it by hand: the CLI's own "Copied!" writes to the CONTAINER's
clipboard, which never reaches the host, and the CLI **hard-wraps** the URL to
the terminal width with a real newline, mid-token — so a naive read of the
stream (or an xterm selection, or clicking the link) yields a truncated URL and
OAuth answers *missing redirect_uri*. `extractAuthUrl` rejoins the continuation
rows: a match that ends exactly at the end of its row was wrapped, and the rows
that follow are full-width and whitespace-free until the short last one.
Opening goes through `openExternal`, which accepts **http(s) only**
(`external-url.ts`) — these links come from code we assume is compromised, and
`shell.openExternal` launches any registered protocol handler.
The Deck polls the credentials file; on success the modal closes itself and a
toast confirms. If the tokens expire later (e.g. weeks of downtime), the same
modal reappears on the next spawn. **Re-authenticate** runs the flow at any
time; **Disconnect** wipes the credentials from the volume (refused while a
session is running — that guard is about not pulling the rug from under a
working agent, and is now the only condition).

## Your global Claude config inside the sandbox

The Deck **copies** your operator config into the container's `~/.claude`:
global `CLAUDE.md`, `agents/`, `skills/`, `plugins/` and `settings.json`. The
Docker view reports exactly what was projected.

Two details that were bugs before they were features. The copy uses
`docker cp -L`, i.e. it FOLLOWS symlinks: keeping `~/.claude/CLAUDE.md` as a
link into a config repo is common, and copying the link instead of its target
left the container with a dangling pointer to a host path, so your global
config was silently absent from every agent. And the copy no longer runs on
every spawn — it runs when the container is new or when a fingerprint of those
entries changes (`projectionSignature`, which walks them and folds in sizes and
mtimes). Re-copying whole trees on each spawn cost about fifteen silent
seconds per new agent; the fingerprint keeps an edit to your global `CLAUDE.md`
picked up on the very next one.

It is a copy, never a mount, and the reason matters: `settings.json` carries
hooks that run on the **host** in your non-sandboxed sessions. A read-write
mount would let a sandboxed agent write a hook and have it execute outside the
sandbox — a clean escape. The agent may wreck its copy; it dies with the
container. Nothing else travels: `.credentials.json`, transcripts, todos and
telemetry stay on the host.

**Windows hooks.** A hook calling PowerShell, `cmd`, a `.ps1/.bat/.exe`, a
`C:\…` path or a Windows-only environment variable (`$USERPROFILE`,
`%APPDATA%`…) cannot run in the Linux container. The Docker view lists those
it detected. Supply Linux equivalents by dropping same-named files in
`~/.claude/sandbox-overrides/` — an entry there wins over the base one
(`sandbox-overrides/settings.json` replaces `settings.json`). Files in that
folder that are not projectable are reported too, so a misplaced file is not
silently ignored.

**Generate sandbox config** (Docker view, projection card) writes that
overlay for you: your host `settings.json` minus every host-only hook, with
the removed commands listed. It refuses to overwrite an existing overlay
without confirmation. Removal, not translation, is deliberate: a mechanical
`$USERPROFILE` → `$HOME` rewrite would make hook SCRIPTS start inside the
container and then fail on their host-side dependencies (Windows binaries,
host credential stores), and a failing PreToolUse hook BLOCKS the sandboxed
agent's edits. A hook you want inside the container is an explicit decision:
put its Linux dependencies in the custom image and its Linux version in the
overlay.

**Remove** (same card) is the opposite decision: do not carry the global
config into the container at all. It persists the opt-out per project,
scrubs what earlier starts projected (right away on a running container,
at the next start otherwise -- `docker exec` cannot reach a stopped one),
and leaves `~/.claude/sandbox-overrides/` untouched on the host. Refused
while sessions are live: the agents are using that config. "Generate
sandbox config" is the way back in -- it re-enables the projection along
with writing the overlay.

## Isolation limits

A sandboxed session is meant to feel like your machine, not to BE it. It
shares: the global config projected above, and the Claude login (the shared
auth volume). It deliberately does NOT share:

- **Hooks that point at host paths or host binaries**: detected and listed
  in the Docker view, stripped by the generated overlay.
- **Host credential stores and CLIs** (`cred`, `kleos-cli`, corporate
  tooling): the container never sees them. If an agent workflow depends on
  one, bake a Linux equivalent into the custom image — consciously.
- **MCP servers and services running on the host**: loopback inside the
  container is the container. Only the claude-peers broker is bridged, and
  the Docker view's bridge probe reports it.

These are properties of the isolation, not gaps in it: every one of them is a
capability the sandbox would otherwise hand to code assumed compromised.

## The Docker view

- **Mode card** — engine state/version, the on/off toggle, the work mode, the
  project's container (`kory-sbx-<hash>`) and its state, published ports, the
  broker-bridge verdict, and a drift badge when the image was rebuilt after
  this container was created (Rebuild to pick it up — everything installed by
  hand inside is lost).
- **Ephemeral copy card** (copy mode only) — clone path, the gitignored-globs
  editor, unmatched globs, Reset clone.
- **Image card** — image name, presence badge, and one action that follows the
  state: **Build image** while it is missing, **Remove image** once it exists
  (removal is unforced, so the engine refuses while any container — even a
  stopped one — still references it; your sign-in volume is untouched).
  Deleting a CONTAINER never deletes the IMAGE: they are separate Docker
  objects, which is why the badge can read "present" right after a container
  removal. A build can be **hidden** and keeps running: the card then shows a
  spinner and *Show log* to bring the terminal back.
- **Authentication card** — volume status, Re-authenticate, Disconnect.
- **Operator config projected** — what travelled, plus hook warnings.
- **Containers list** — every `kory-sbx-*` container on the machine (all
  projects): start / stop / **rebuild** (recreate from the image) / **remove**
  (confirm dialog; the auth volume and your project folder are never touched).
  Actions on the current project's container are refused while sessions run.

The Deck also recreates the container by itself when its `/work` mount no
longer matches the work mode — switching to *ephemeral copy* can never leave
agents writing the real tree because a stale container was reused.

## How sessions run

Each spawn writes a small launch script into a Deck-owned run dir (mounted at
`/kory-run`) and the tile's PTY runs `docker exec -it <container> bash
/kory-run/cmd-<id>.sh`. Everything terminal-side (thinking detection, quota
auto-resume, attention, search) behaves exactly as before — the PTY does not
care what is at the other end.

**Isolation of the peer back-channel.** Containers get a Deck-owned peers
directory, never the host `~/.claude/peers`. The Deck reads the session-id
back-channel of sandboxed sessions from there, and validates the value before
using it — a sandboxed agent must not be able to influence what a
non-sandboxed tile resumes.

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
5173, 8080, editable in the Docker view) are published to `127.0.0.1` at
container create, so a dev server started by a sandboxed agent is reachable
from the embedded Browser view at `http://localhost:<port>` as usual. Changing
the list requires a container **rebuild** (engine limitation: ports cannot be
added to a live container).

Those defaults are the same for **every** project, so a second sandboxed
project cannot publish them too — its container fails to start on an
already-allocated port. Give it different ports, or clear the field (an empty
list publishes nothing).

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
