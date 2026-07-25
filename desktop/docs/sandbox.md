# Sandbox mode (Docker)

Sandbox mode runs a project's agent sessions inside a **persistent
Docker/Podman container** instead of directly on the machine. The project
folder stays bind-mounted read-write at `/work` (the work lands on your disk,
diff/git/files views keep working), while the rest of the machine — your
credentials, other folders, the OS — is out of the agents' reach. The
**supervisor stays on the host** and keeps piloting the app.

The mental model is a disposable-but-persistent LXC: the container is created
on demand, **stopped** (never deleted) when the app closes, restarted in the
exact same state next time, and only removed when you explicitly say so in
the Docker view.

## Prerequisites

- Docker Desktop (Windows/macOS/Linux) or Podman. The view's mode card shows
  what was detected; if nothing is installed it points to
  `docs.docker.com/get-docker` / `podman-desktop.io`.
- The sandbox image, built once:

  ```bash
  docker build -t koryphaios-sandbox desktop/resources/sandbox
  ```

  It ships bash, git, bun and the Claude Code CLI under the container user
  `kory`. The image name can be changed in the `sandbox.json` app-state file.

## Enabling / disabling

The 🏺 **Docker** rail view carries the per-project toggle. Two rules:

- The switch is refused while any session is alive (main-side guard): a live
  terminal cannot be teleported across the boundary. Close the sessions first.
- Flipping the mode only affects **new** sessions.

The setting is per project and operator-owned (stored in the app state, never
in the repo — a cloned repository can not decide to leave the sandbox).

## First-run authentication

The container needs its own Claude login, stored in the shared
`kory-claude-auth` **volume** (mounted at `~/.claude` in every sandbox
container — one login covers all projects and survives container removal;
your host login is never copied in).

Agents are **blocked** until that login exists: spawning opens a modal —
*Next* starts a terminal inside the container running the CLI's standard
login flow (open the OAuth URL on your browser, paste the code back). The
Deck polls the credentials file; on success the modal closes itself and a
toast confirms. If the tokens expire later (e.g. weeks of downtime), the same
modal reappears on the next spawn. **Re-authenticate** in the Docker view
runs the same flow at any time.

## The Docker view

- **Mode card** — engine state/version, the project's container
  (`kory-sbx-<hash>`) and its state, image, published ports.
- **Authentication card** — volume status + Re-authenticate.
- **Containers list** — every `kory-sbx-*` container on the machine (all
  projects): start / stop / **rebuild** (recreate from the image — the
  anti-drift reset; current project only) / **remove** (confirm dialog;
  the auth volume and the project folder are never touched). Actions on the
  current project's container are refused while sessions run in it.

## How sessions run

Each spawn writes a small launch script into a Deck-owned run dir (mounted at
`/kory-run`) and the tile's PTY runs `docker exec -it <container> bash
/kory-run/cmd-<id>.sh`. Everything terminal-side (thinking detection, quota
auto-resume, attention, search) behaves exactly as before — the PTY does not
care what's at the other end.

Inside the container, sessions reach the host's claude-peers broker through
`host.docker.internal` (injected `CLAUDE_PEERS_BROKER_URL`), so peer
messaging, announcements, the operator inbox and the roadmap keep working.
The supervisor is exempt from sandboxing (it drives the app itself).

## Web dev servers

Ports listed in the project's sandbox settings (default 3000, 5173, 8080) are
published to `127.0.0.1` at container create, so a dev server started by a
sandboxed agent is reachable from the embedded Browser view at
`http://localhost:<port>` as usual. Changing the port list requires a
container **rebuild** (engine limitation: ports cannot be added to an
existing container).

## Limits (M1)

- Session **resume/fork across restarts** starts fresh in sandbox mode
  (transcripts live inside the container volume, not on the host).
- The operator's global Claude config (`~/.claude`: CLAUDE.md, agents,
  skills, hooks) is **not yet projected** into the container (planned M2 —
  by copy, never by mounting the host dir, which would be an escape vector).
- On a native Linux docker engine (not Docker Desktop), the broker bridge
  needs the broker bound beyond loopback (`CLAUDE_PEERS_BIND_HOST`) — see
  PLAN-SANDBOX §5.
