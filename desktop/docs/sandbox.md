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
allow-list of **extra globs to copy in** (planning notes, local
fixtures — gitignored or not) — one glob per line in the Docker view. A hard deny-list always
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

## Protecting the mounted project itself (mount mode only)

Before this sub-policy existed, **mount** mode bind-mounted the operator's real
tree read-write at `/work` with no further restriction. A sandboxed agent --
which our doctrine assumes COMPROMISED -- could write `/work/.git/hooks/pre-commit`,
`.mcp.json` or `.claude/settings.json`. Those paths are then executed or
trusted by the HOST the next time the operator commits, or the Deck's own Git
view runs `git commit`. That is exactly the evasion class `copy-not-mount`
already closes for the operator's GLOBAL config (see above) -- mounting the
project itself reopened it at the project level.

**This is a deliberate exception to the mount-is-a-capability rule**, and it is
written here as one on purpose so a future reader does not mistake it for a
mistake and strip it out. Everywhere else in this app, anything MOUNTED into a
sandbox is a capability GRANTED to code assumed compromised (see CLAUDE.md's
"hostile inputs" table, item 5). Here the mount REMOVES a capability instead of
granting one: nested `:ro` binds make specific host-executed paths read-only
from inside the container, on top of the read-write project mount. No new READ
exposure is created either way -- these paths were already readable in mount
mode; only the write path is closed.

**The criterion, and the list is a dated instance of it.** The rule is: any
project path whose content is EXECUTED or INTERPRETED AS A COMMAND by the HOST
when the host opens or manipulates this project (git hooks, editor/MCP config,
a submodule's recorded fetch URL). The list of paths currently covered lives in
code (`PROTECTED_PATHS`, `desktop/src/main/sandbox-protect.ts`) -- it is not
reproduced here, since a duplicated list in the docs would drift from the one
in code. A future host-executed path belongs there, under the same test.

**Directories and files are treated differently**, for reasons measured
against Docker Desktop on Windows (server: Linux 29.6.2, 2026-08-13/14):

- a `:ro` bind nested under a read-write parent HOLDS: a write inside it is
  refused ("Read-only file system") and removing the mount point itself is
  refused ("Resource busy").
- Docker CREATES missing intermediate path components recursively for a bind,
  so a DIRECTORY bind can stay UNCONDITIONAL -- it never becomes fail-open as
  the set of protected directories grows.
- a bind on an ABSENT file instead fabricates a DIRECTORY of that name in the
  operator's real project -- corruption, not protection -- so file entries are
  bound only when they already exist as a file.
- `docker create` FAILS outright when a path component already exists as a
  FILE, which is the shape of a git worktree's or a submodule's `.git` (a file
  pointing elsewhere, not a directory). The guard against this is written on
  that STRUCTURAL shape, never on the intention "this is a worktree" -- a
  worktree and a submodule produce the same shape, and an intention-based guard
  would cover strictly less than the real domain.

**Three accepted costs**, each a choice, not an oversight:

- Docker creates the protected directories that were absent in the operator's
  real project. They land empty, invisible to git, owned by the operator at
  mode 755. Making this conditional on existence would reopen the fail-open
  case the day one of those directories is created for the first time.
- A read-only `.git/config` breaks `git push -u origin <branch>` and
  `git remote add`, the two most frequent of the SEVEN operations measured to
  write that file (the others: `git config --local`,
  `git branch --set-upstream-to`, `git lfs install`, `git sparse-checkout init`,
  `git maintenance start`). Measured NOT to write it: `commit`, `checkout -b`,
  `tag`, `stash`, `worktree add`, `gc`, `fetch` -- so an agent's daily loop
  (edit, add, commit, switch branch) never touches it. No escape hatch is
  provided, deliberately: a way to disarm the guard is not added ahead of a
  measured need. The notice below deliberately names only the two frequent
  ones to the agent: it aims at the common case, not at exhaustivity.
- Temporal residue: binds are fixed at container creation, so a PROTECTED FILE
  created AFTER that point is not covered until the next rebuild (directories
  do not have this gap, since their bind is unconditional). A placeholder-file
  approach was considered and dropped -- it would write an untracked file into
  the operator's real project, visible in `git status` and committable by
  accident. The residue is instead made VISIBLE to the operator, through the
  drift/rebuild signal in the Docker view (see below).

**Asymmetry between agent and operator, and it is a security rule, not an
ergonomics one.** The agent is told what IS protected, never what was skipped.
Only the operator sees what was skipped. Our doctrine assumes the agent is
compromised: a map of the gaps is useless for its legitimate work and useful
to an attacker mapping the remaining write surface.

**The notice is predictive, not reactive**, for a structural reason: nothing on
the host can observe a write refused INSIDE the container. The reference
`@anthropic-ai/sandbox-runtime` project can attach a block of violations to the
output of a command because it IS the launcher of every command the agent
runs; Koryphaios launches the CLI once and nothing more after that. The notice
is therefore delivered BEFORE the first prompt, through a composed prompt file
(see "How sessions run" above for the launch script mechanism). There is
deliberately no equivalent of an operator-side exclusion list for violations --
that would be a fail-open surface by construction.

**A container already running when this sub-policy shipped** carries no
protection bind at all, and stays that way until it is rebuilt. The Docker
view detects this and flags it as needing a rebuild. One associated trap: under
Docker Desktop on Windows, the Source field of a bind can come back in TWO
different forms for binds on the SAME container (a `C:\...` host path for one,
a `/run/desktop/mnt/host/c/...` path for another), so the comparison that
detects a stale container is done on Destination and RW only, never on Source.

## Isolation between projects and containers (the run/peers dirs)

Every sandboxed container needs a small host-side directory for two things
that never belong in the auth volume or the project mount: the per-session
launch script the PTY runs (`cmd-<sessionId>.sh`, mounted at `/kory-run`),
and the peer back-channel cache the container's `server.ts` writes into
(mounted at `~/.claude/peers`). Both are keyed by the container name
(`kory-sbx-<hash>`) under the app state dir — `sandbox-run/<containerName>`
and `sandbox-peers/<containerName>` — exactly like `sandbox-copies/<containerName>`,
the clone directory used in ephemeral-copy mode.

**Why keying matters here specifically.** The Deck has no single-instance
lock and opens exactly one window per process, so two windows on two
different projects are two separate processes resolving the *same*
per-operator app-state directory. Any path built under that root with no
distinguishing segment is therefore shared across every project the operator
runs, not just conceptually but in practice — every container binds it
read-write, and every container's agent runs as the same container user. The
rule this generalizes to: before writing a new directory under the app-state
root, ask what it is keyed by; if the answer is "nothing", it inherits that
sharing by default, whether or not the content it holds looks sensitive.

Before both dirs carried the container name, this is exactly what happened
to the run dir: one `sandbox-run` directory served every project, mounted
read-write into every container under the same uid. A compromised agent in
one container could overwrite another *session's* — potentially another
*project's* — `cmd-<sessionId>.sh`, and get its own code executed there at
that session's next launch. The peers dir had the identical construction
defect, with a smaller blast radius: it carries the peer-cache/back-channel
data the container's `server.ts` writes, not a script the PTY executes, so a
compromised write there does not by itself get code run.

**The keying grain is the container, not the session or the process, and
that is not an oversight.** Keying finer than the container would close
nothing further: inside one container, isolation between the sessions it
runs is already nil by construction — same user, same filesystem, no
container boundary between them. Two sessions of the same project therefore
still share their run dir and their peers dir; that sharing is a deliberate
consequence of the isolation boundary being the container, not a residual
gap.

**Purge is asymmetric between the two keyed dirs and the clone directory, on
purpose.** The container-name-keyed run and peers dirs are purged when their
container is removed or rebuilt: their content regenerates for free (launch
scripts are rewritten on every start, the peer cache repopulates on
connect), so deleting them costs nothing. The ephemeral-copy clone
(`sandbox-copies/<containerName>`) is never purged this way — it is kept
across a remove/rebuild specifically so the next container does not pay for
a re-clone. Purging both the same way would look like uniform hardening
while actually regressing the one directory whose persistence is the
feature, not a leftover.

**The purge itself is fail-closed against a live container from another
window.** A "remove" or "rebuild" action can target a container belonging to
a *different* project (the cross-project containers list), which another
Deck window may currently be running a session against — mid-flight,
executing exactly the script this purge would delete. The container is
always removed either way; only the directory purge is gated, and it is
skipped whenever the container was observed running immediately before the
removal.

**Detecting a container still on the old, shared run-dir mount.** A
container created before this keying shipped keeps its old shared bind
until it is rebuilt — the fix only changes what a *new* `docker create` is
given, never an existing container's live mount. The Docker view surfaces
this as one of two independent rebuild reasons carried on
`SandboxStatus.rebuildReasons` (`missing-protection-binds`, the mount-mode
`:ro` protection check described above, and `shared-run-dir`, this one),
rendered as two separate lines rather than folded into one generic "rebuild
needed" message. They are kept apart because a wrong cause is worse than no
signal at all: an operator reading the protection-binds wording during an
actual cross-project run-dir sharing incident would file it under routine
policy drift instead of the security incident it actually is.

The detection itself has a measured trap. `docker inspect` on a real
container can report the Source of two different binds in two different
path *representations* within the same call (a `C:\...` host path for one
mount, a `/run/desktop/mnt/host/c/...` path for another — measured live
against Docker Desktop on Windows, 2026-08-14), so no single expected string
can be built and compared by equality; the destination
(`/kory-run`) never changes and is not useful here either, since it is
identical whether the mount is shared or per-container. The check instead
tests that the bind's Source *contains* the container name as a substring:
`kory-sbx-<hash>` is a plain token with no separators, so it survives either
path representation unchanged, and containment is decided independent of
which form this engine/OS combination happens to produce.

**Three accepted residues**, each a choice with a stated cost, not a gap
discovered later:

- Per-session files inside a live project's run/peers dirs still accumulate
  over that project's lifetime — bounded now by *one project*, against the
  previous unbounded, whole-machine, lives-forever accumulation.
- Files left behind under the pre-fix flat directories (`sandbox-run` and
  `sandbox-peers` directly under the app state dir, with no container-name
  subdirectory) are not deleted automatically. Nothing mounts those flat
  paths any more, so they are inert, but erasing files inside the
  operator's application data to reclaim a few kilobytes is not a trade this
  fix makes on the operator's behalf — clear them by hand if you want the
  space back.
- The substring-containment detection is written generically enough to
  apply to podman, the other supported `SandboxEngine`, but it has only been
  measured against Docker Desktop on Windows; podman was not available on
  the machine used for this measurement. Treat podman coverage as an
  assumed, unverified extrapolation, not a tested guarantee.

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
- **Ephemeral copy card** (copy mode only) — clone path, the copy-globs
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
