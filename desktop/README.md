# Claude Peers Deck

A desktop app that **docks multiple Claude Code peer sessions into a single
window**, so you stop juggling a dozen floating terminals. Every tile is a real
terminal running a real Claude Code session; the app adds layout, an isolated
peer group, and save / restore on top.

Built with Electron + [xterm.js](https://xtermjs.org) + `node-pty` (the same
terminal stack as VS Code), and the `claude-peers` MCP channel for peer
discovery.

> Part of the [claude-peers](../README.md) project. This README covers the
> desktop app; the root README covers the MCP server, broker and CLI.

---

## What it does

- **Dock N Claude sessions in one window**, each in a true PTY, so OAuth in the
  browser, the full TUI, colours and key handling all behave exactly as in a
  normal terminal.
- **Isolated peer group per window.** Every session the window spawns shares one
  private claude-peers group, so `list_peers` inside a tile shows only this
  window's sessions, not your other Claude instances. The group secret never
  touches the repo or `ps` (a chmod-600 temp file by default).
- **Save & restore workspaces.** Close the app and reopen it; restore the
  previous session set and each tile resumes its Claude conversation -- even
  after an in-session `/clear`, since each tile's current session id is tracked
  across rotations (via an embedded plugin hook), so restore never reopens a
  stale pre-`/clear` state.
- **Outbound megaphone.** The window can broadcast one-way, no-reply system
  messages to its group: an automatic join announcement when a tile's `peer_id`
  resolves, plus free-text operator broadcasts typed into the sidebar message
  bar. Peers receive them framed as "informational only -- do not reply"; the
  Deck never reads inbound peer traffic.
- **Quota auto-resume (opt-in).** When a session hits Claude's usage limit, the
  Deck can wait for the reset time printed on screen and submit `continue`
  automatically (one shot per episode). Off by default -- enable it in
  Settings > General, or per session via the sidebar right-click menu. The
  status dot turns orange with an "auto-resume at HH:MM" badge while waiting.
- **Shared roadmap.** A navigation rail (Agents | Roadmap) exposes the
  project's persistent backlog (features, bugs, debt, ideas), stored in the
  claude-peers broker and shared with every Claude session working on the same
  repository -- agents read/write it through their `roadmap_*` MCP tools, the
  operator through the Roadmap view (MoSCoW groups, value/effort badges,
  filters, archive/restore). "Launch an agent" on an item spawns a session
  pre-briefed with it and flags it in progress.
- **English / French UI**, switchable live.

---

## Quick start

From the directory you want the peers to work in:

```bash
# one-time, from this repo:
cd desktop
npm install            # also rebuilds node-pty for Electron (see Develop)
npm link               # exposes the `claude-peers-desk` bin globally

# then, in any project:
cd /path/to/your/project
claude-peers-desk            # opens a window scoped to this directory
claude-peers-desk my-team    # optional: join/create a named (custom) shared group
```

- **No argument** -> an *ephemeral* private group (a fresh random secret each
  launch). Perfect for "just dock my sessions together on this machine".
- **A positional argument** (`my-team`) -> a *custom* group: anyone who launches
  with the same argument joins the same shared group (across PCs sharing a
  broker). The argument is the secret; choose something unguessable for real
  sharing.

You can also run it straight from the repo without linking:

```bash
cd desktop && npm run dev        # dev mode (renderer HMR)
```

> The above (`npm link` / `npm run dev`) is the **development** launcher. For a
> standalone build to share or install, see [Package installers](#package-installers)
> and [Running a packaged build](#running-a-packaged-build).

---

## Using the app

### Sidebar (left)

- **`＋ Add peer`** -- start a new session in the window's project directory.
- **`▾` (advanced create)** -- a popover to pick a sub-agent (scanned from
  `.claude/agents` and `~/.claude/agents`), pick a model, toggle **Extended
  context (1M)** (appends the `[1m]` suffix; Opus/Sonnet only, not Haiku), add
  free launch args (e.g. `--model opus`), apply a preset, choose a custom colour,
  and (under **Advanced**) run the peer in a **different working folder**. A peer launched
  in another folder still joins this window's group; only its cwd changes -- use
  with care, it can act on that folder.
- Each row shows a **colour swatch**, a **status dot** (starting / running /
  exited, with a thinking pulse), the **name** (double-click to rename) and the
  live **`peer_id`** (or `Session <id>` until it resolves).
- Per-row **maximize** and **remove** (with a confirm dialog). Drag the right
  edge to **resize** the sidebar.
- **Message bar** (bottom) -- type a line and broadcast it as a one-way,
  no-reply announcement to every peer in this window's group (the outbound
  megaphone). Per-peer targeting is not wired yet; a broadcast reaches all
  active peers.
- Header buttons: **🗂 Workspaces** and **⚙ Settings**.

### Tile area (right)

- **Display modes** (top bar): `1x1` carousel, `1x2`, `2x2`, or a custom
  `X x Y` grid. Overflow scrolls.
- **Maximize / restore** a tile (button, double-click its header, or
  `Ctrl+Shift+M` on the selected tile).
- The empty state offers **`＋ Add peer terminal`** and, when a previous
  workspace exists, **`Restore previous session`**.

### Workspaces (🗂) -- save & restore

A *workspace* is a restorable snapshot of the window: its session set (names,
colours, args, cwd), display mode, and the group **identity** (a `groupId`
hash -- **never the secret**). Stored in-repo at
`<project>/.claude/claude-peers/workspaces/<id>.json` (git-ignored by default).

- The live workspace **auto-saves** continuously while you work.
- **Save As** gives it a name and pins it (kept, not pruned).
- **Restore** swaps the window to a saved workspace: it adopts that workspace's
  scope and reopens its sessions. Restore is blocked when another live app owns
  that workspace's lock.
- **Restore semantics:** a session that had real activity (a transcript on disk)
  is **resumed** with its Claude context; a session that was only opened but
  never used has nothing to resume and simply **starts fresh** -- you always get
  a working terminal, never a stuck "expired" tile.

### Settings (⚙ / Edit > Settings… / Ctrl+,)

A full-window settings page, VS Code-style: a category tree on the left, the
selected category's fields on the right. Opened from the sidebar gear, the
**Edit > Settings…** menu item, or `Ctrl/Cmd+,`. Changes apply live (no Save
button): discrete inputs on change, free-text inputs on blur.

- **General** -- **language** (Auto + the languages present as `locales/*.json`,
  labelled in their native name), re-open-on-launch, remember scope secrets.
- **Appearance** -- theme (dark / light), font size, display mode, session colour palette.
- **Terminal** -- project directory, launch command (global), shell override, interactive shell.

---

## How it works

### Launch model

Each tile spawns the resolved launch command in a real pseudo-terminal:

- **Command resolution** (first wins): `<project>/.claude/claude-peers/config.json`
  -> global config (`%APPDATA%\claude-peers-desk` / XDG) -> default
  `claude --dangerously-load-development-channels server:claude-peers`.
- **Shell wrapping (default = login, non-interactive):** `"$SHELL" -l -c "<cmd>"`
  (Unix) / `powershell -NoLogo -NoProfile -Command "<cmd>"` (Windows). This keeps
  rc / profile noise out of the terminal.
- **Interactive opt-in** (`interactiveShell`): adds `-i` (Unix) / loads the
  profile (Windows) for users whose launch command is a shell alias; a unique
  start marker is emitted and output before it is stripped.

### Peer scope / group isolation

The window computes one scope (`secret`, `groupId`, display `name`) and pins
every spawned session into it via the claude-peers forced-group env
(`CLAUDE_PEERS_FORCE_GROUP[_FILE]` + `..._NAME`), fed only to the child PTY. The
secret lives in memory and a chmod-600 temp file; only the `groupId` hash is ever
persisted. An empty (freshly launched) window can **adopt** a restored
workspace's scope without relaunching.

### Sessions, ids and restore

- A new session launches with `--session-id <uuid>`; a restore forks the stored
  id (`--resume <id> --fork-session`).
- **How the real id is learned (deterministic back-channel).** Claude Code mints
  its own session id when run interactively with an MCP loaded, so the launch
  `--session-id` is not the id it ends up using. The Deck injects a unique
  per-tile token (`CLAUDE_PEERS_DESK_SESSION`) into each PTY; the claude-peers
  core `server.ts`, at `/register`, writes the **real** minted
  `CLAUDE_CODE_SESSION_ID` to `~/.claude/peers/desk-session-<token>.txt`
  (`shared/peer-cache.ts:writeDeskSessionId`). The Deck reads that file
  (`src/main/desk-session.ts`) to map a tile to its exact id with **no
  transcript-diff guessing** -- deterministic even when several tiles boot in the
  same cwd at once. The token file is cleared before each (re)spawn so a stale id
  is never picked up.
- **Fallback:** against an older core that does not write the back-channel file,
  the Deck still **discovers the id in the background** (newest new transcript
  under `~/.claude/projects/<encoded-cwd>/`) and persists it; on restore it
  resumes only when a transcript exists (else starts fresh). Spawning is always
  **instant and parallel** -- neither the back-channel read nor transcript
  discovery ever blocks a terminal from appearing.

### Peer id display

The app spawns terminals with `CLAUDE_PEERS_STATUS_LINE_CACHE=1`, which makes
`server.ts` write the active `peer_id` to
`~/.claude/peers/peer-id-<cwd_key>[-<session_id>].txt`. The Deck reads those
files to badge each tile with its live `peer_id`.

### i18n

UI text lives in external `locales/en.json` + `locales/fr.json` (committed,
user-editable, with an embedded English fallback). The main process resolves the
locale (config or OS) and serves the dictionary to the renderer; `t(key, params)`
interpolates `{placeholder}` tokens. Changing the language re-renders live. The
Settings language picker is derived from the locale files actually present
(`availableLocales`), each shown under its native name.

---

## Develop

```bash
cd desktop
npm install          # also runs electron-rebuild for node-pty
npm run dev          # launch in dev mode (renderer HMR)
```

If the post-install rebuild was skipped (no toolchain at install time), run it
once tools are available:

```bash
npm run rebuild      # electron-rebuild -f -w node-pty
```

> `node-pty` is a native module. Building it needs a C/C++ toolchain:
> **Windows** -- "Desktop development with C++" (Visual Studio Build Tools);
> **macOS** -- Xcode Command Line Tools; **Linux** -- `build-essential` + `python3`.

### Windows build gotchas

`node-pty` hardcodes `SpectreMitigation=Spectre` in its `binding.gyp`, so the
Visual Studio toolset you build with **must** have the matching
**"MSVC ... C++ x64/x86 Spectre-mitigated libs (Latest)"** component installed
(Visual Studio Installer -> Individual components -> search "Spectre"). Without it
the build fails with `error MSB8040`.

If `node-gyp` keeps picking the wrong toolchain (some apps register phantom
Visual Studio instances that `vswhere` reports), pin the year explicitly:

```powershell
$env:npm_config_msvs_version = "2019"   # or "2022", matching your VS
npm run rebuild
```

or persist it for this clone in a local, git-ignored `desktop/.npmrc`:

```
msvs_version=2019
```

(`.npmrc` is git-ignored on purpose: the right value is machine-specific and a
committed pin would break clones with a different Visual Studio.) Run native
builds from **PowerShell / cmd**, not git-bash (node-gyp's shell-outs assume
cmd.exe).

## Type-check, test & build

```bash
npm run typecheck    # tsc for main/preload + renderer
npm run build        # electron-vite production build into out/

# the pure main modules are unit-tested from the repo root:
cd .. && bun test tests/desktop-*.test.ts
```

## Package installers

```bash
npm run package          # current OS
npm run package:win      # NSIS installer
npm run package:mac      # dmg
npm run package:linux    # AppImage
```

On Windows the build emits, in `dist/`, both `Claude Peers Deck Setup <v>.exe`
(NSIS installer) and `Claude Peers Deck-<v>-win.zip` (portable). The binary is
named **`claude-peers-desk.exe`** (no spaces, via `executableName`) while the
display name stays "Claude Peers Deck".

> First Windows build only: electron-builder extracts `winCodeSign` (which holds
> macOS symlinks). If it fails with `Sub items Errors: 2`, enable **Windows
> Developer Mode** (free, Settings > Privacy & Security > For developers) or run
> `npm run package:win` from an **elevated** PowerShell, then retry. The build
> is **unsigned**, so SmartScreen shows "unknown publisher" on first run.

## Running a packaged build

An Electron app exe is **not standalone**: keep the whole folder (the
`.exe` plus `icudtl.dat`, the `.dll`s, `resources/`, `locales/`). Install with
the NSIS installer, or unzip the portable build and run the app **from inside
its folder**. Do not move the `.exe` out on its own.

**Launch it detached.** Running the GUI exe directly attached to a console
(typing it in PowerShell) can fail with `Invalid file descriptor to ICU data
received` and open no window. Launch it detached instead:

```powershell
Start-Process claude-peers-desk     # or just double-click the exe
```

**A `claude-peers-desk` command, scoped to the current directory.** Copy
[`bin/claude-peers-desk.cmd.example`](bin/claude-peers-desk.cmd.example) to a
folder on your PATH (e.g. `%USERPROFILE%\.cargo\bin\claude-peers-desk.cmd`), set
`APP_DIR` inside it to the folder containing `claude-peers-desk.exe`, and use:

```bat
claude-peers-desk            :: ephemeral group, sessions scoped to the cwd
claude-peers-desk my-team    :: custom (shared) group; the arg is the secret
```

The wrapper uses `start` (detached, no ICU error) and forwards the current
directory (`CLAUDE_PEERS_DESK_PROJECT_DIR`) and optional scope. Put the wrapper
`.cmd` on PATH rather than the exe's folder, so the command goes through it.

**Runtime requirement.** The build bundles the app, node-pty and the locales,
but **not Claude Code**. Each machine needs the `claude` CLI and the launch
command (`claudepeers` by default, editable in Settings > Launch command);
otherwise terminals open but the command fails.

## Releases (CI)

`.github/workflows/desktop-release.yml` builds win/mac/linux and attaches the
installers + portable zips to a GitHub Release when a `desktop-v*` tag is
pushed (the branch must already be pushed):

```bash
git tag desktop-v0.1.0
git push origin desktop-v0.1.0
```

`electron-builder.yml` ships two things outside the asar archive:

- **`asarUnpack: node_modules/node-pty/**`** -- the native `.node` binary must
  stay on disk so it can be `dlopen`-ed at runtime.
- **`extraResources: locales/ -> locales`** -- the locale dictionaries are read
  at runtime from `process.resourcesPath/locales` when packaged (see
  `ipc.ts` `buildI18n`). Without this a packaged app silently falls back to the
  embedded English base for `fr`.

`electron` and `node-pty` are **pinned to exact versions** (no `^`). Every
Electron bump changes the V8/ABI and forces a node-pty rebuild; a floating
range would let an install drift onto an ABI the committed binary was not built
for. Bump both deliberately and re-run `npm run rebuild`.

### macOS arch matching

The `.node` is architecture-specific. Build on (or for) the arch you ship:
an **arm64** runner produces an arm64 binary that will not load on an **x64**
host, and vice versa. For a universal artifact, build each arch on its matching
runner (or cross-compile with the matching `--arch`), don't reuse one arch's
unpacked `node-pty` for the other.

### Per-OS CI

`.github/workflows/desktop-build.yml` builds on a `windows-latest` /
`macos-latest` / `ubuntu-latest` matrix: it runs the pure-module bun tests,
then `npm install`, then the **strict** `npm run rebuild` (the ABI gate that
fails loudly when a runner's native toolchain is incomplete -- notably the
Windows Spectre-libs gap above), then `electron-vite build`.

---

## Project layout

```
src/
  main/                 Electron main process
    index.ts              app lifecycle, window, scope adoption, auto-save wiring
    cli-context.ts        parse argv (project cwd + optional scope id)
    scope.ts              group secret + groupId + child env (forced-group)
    launch-config.ts      resolve the launch command (project > global > default)
    agents.ts             scan .claude/agents for the create menu
    pty-manager.ts        node-pty spawn/kill, OS-aware shell wrapping
    session-command.ts    pure builder for the per-session claude command line
    shell-command.ts      pure shell-invocation builder (login vs interactive)
    session-service.ts    session list, runtime state, spawn + background id discovery
    session-transcript.ts encode cwd -> projects dir, transcript existence + discovery
    desk-session.ts       read/clear the deterministic per-tile session-id back-channel
    open-id-registry.ts   guard against resuming the same id twice
    peer-state.ts         resolve peer_id from the status-line cache
    broker-client.ts      resolve broker endpoint + POST /announce (outbound megaphone)
    migrate-data-dir.ts   harmonize the %APPDATA% deck/desk folders (app state under config/)
    workspace-store.ts    in-repo workspace JSON (save/list/load/delete)
    workspace-lock.ts     sidecar <id>.lock liveness (heartbeat / pid)
    workspace-session-map.ts  SessionDef <-> persisted WorkspaceSession
    session-close.ts      graceful close routine (/exit -> Ctrl+C -> SIGTERM)
    workspace-service.ts  orchestrates store + lock + auto-save + restore
    i18n.ts               load locales, t(key, params)
    menu.ts               tailored application menu
    store.ts              app config + sessions persistence (userData JSON)
    ipc.ts                IPC handlers + event forwarding
  preload/                contextBridge -> window.api (typed DeckApi)
  renderer/               React UI
    components/            Sidebar, CreateMenu, MessageBar, TileArea, TerminalTile,
                           DisplayModeBar, SettingsDialog, WorkspacesDialog, ...
    i18n.ts                renderer t() bound to the main-served dict
    store.ts               zustand store
  shared/types.ts         types shared across processes
  shared/announce.ts      compose the join / operator announce text
locales/                  en.json, fr.json
bin/
  launch.js               dev CLI launcher (npm link) -> spawns electron
  claude-peers-desk.cmd.example  wrapper template for a packaged build on PATH
bin/launch.js             the `claude-peers-desk` launcher
```

---

## Known limitations

Tile <-> conversation attribution in the **same folder** is now handled by the
deterministic per-tile back-channel (see [Sessions, ids and restore](#sessions-ids-and-restore)):
each tile learns its exact session id from `server.ts`, so labels no longer get
permuted when many sessions are restored at once. The transcript-diff path
remains only as a fallback for an older core that does not write the back-channel
file -- in that degraded case the historical caveat still applies (every
conversation comes back, but a label may map to a different one).
