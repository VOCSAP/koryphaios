# Koryphaios

> **Koryphaios** (Κορυφαῖος) — the leader of the chorus in Greek theatre: the
> one who sets the rhythm, coordinates the chorus and speaks on its behalf.
> Formerly **Claude Peers Deck** (≤ v0.6); the first run after upgrading
> migrates the app data from the old `claude-peers-desk` folder automatically
> (copy, never overwrite — a rollback keeps working). The `kory` bin replaces
> `claude-peers-desk`, which remains as an alias.

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
- **Remote approvals (opt-in).** When a session stops and waits for you, the
  question can reach your phone over Telegram or Discord, and your answer comes
  back to the agent — free text, not just yes/no. Enrolment is a Connect button
  in `Settings > Notifications` (scan a QR for Telegram; for Discord the app
  builds the bot invite URL for you). Answering anywhere settles it everywhere.
  It never freezes a session: one that is waiting was already waiting.
- **Shared roadmap.** A navigation rail (Agents | Roadmap) exposes the
  project's persistent backlog (features, bugs, debt, ideas), stored in the
  claude-peers broker and shared with every Claude session working on the same
  repository -- agents read/write it through their `roadmap_*` MCP tools, the
  operator through the Roadmap view (MoSCoW groups, value/effort badges,
  filters, archive/restore). "Launch an agent" on an item spawns a session
  pre-briefed with it and flags it in progress.
- **Worktree sessions.** The advanced create menu can spawn a session in a
  fresh git worktree (`.worktrees/<name>`, new branch), so parallel agents on
  the same repo each get their own working dir + branch. Closing the tile
  offers to remove the worktree (branch always kept; git's dirty-tree refusal
  is respected). Optional `worktreeInit` command in the launch config (e.g.
  `bun install`) runs in each fresh worktree. Add `.worktrees/` to your
  project's `.gitignore`.
- **Supervisor session (Home).** The Home rail view hosts a Claude session
  that pilots the window instead of coding: tell it "resume work on this
  repo" and it reads the roadmap, picks agent profiles (your
  `.claude/agents`), spawns briefed tiles (optionally one worktree each) and
  coordinates them via peer messages. It is the only session bridged to the
  app (private `deck_*` MCP tools, per-launch token); destructive actions only
  work on what it created, and spawns are capped. Its role definition is fixed
  by the application (code constants, re-anchored at system-prompt level on
  every spawn) -- deliberately NOT operator- or repo-configurable, so a cloned
  repository can never silently repurpose the session that pilots the app.
- **Floating "?" help assistant.** Ask about the app or about what's on
  screen ("which roadmap item should I tackle next?"): each question is a
  one-shot `claude -p` call carrying the active view's context, technically
  read-only (no MCP, no mutating tools) -- an advisor, never an actor.
  Right-click the button to hide it or switch the model (Haiku by default).
  Questions about the app itself are grounded in the shipped reference
  documentation ([`docs/`](docs/README.md)), which the supervisor is pointed
  at too.
- **Team-lead 👑.** Designate ONE session per window as the team-lead (create
  checkbox -- suggested by the configurable `leadPattern` -- or the sidebar
  right-click). Targeted Deck notices (queue dispatch, review reports,
  integration notes) go to it via a targeted announce.
- **Worktrees view (⎇ rail).** Every worktree of the repo with its branch,
  dirty count, last commit and attached session. Orphans (left by a closed
  tile) can be resumed into a new session or removed -- never forced, branch
  always kept.
- **Roadmap extras.** "Import a plan…" hands a plan file (e.g. a `PLAN*.md`)
  to a one-shot agent that converts it into deduplicated roadmap items. A
  **dispatch queue** (⏳) sends queued items one by one to the team-lead --
  full item + "keep the status current" contract -- and auto-dispatches the
  next one when a dispatched item turns `done`.
- **Diff / review.** A diff panel (per worktree from the Worktrees view, per
  session from the sidebar right-click) shows uncommitted changes plus the
  branch's commits vs main; "Have an agent review this" spawns a one-shot
  reviewer that reports to the team-lead.
- **Operator inbox ✉.** Agents write to the human with `send_message` to the
  reserved `operator` peer; the Deck drains the broker inbox every 10 s into
  a panel (unread bubble on the rail) with a system notification per batch.
  Read-only: you answer through the megaphone.
- **"Needs you" detection.** When a session hits a permission/question screen
  the tile shows a ⏸ badge and a clickable system notification brings it into
  view (toggle in Settings).
- **Activity journal 📜.** A per-window ring buffer narrates spawns, exits,
  quota episodes, waits, worktree operations, announces, dispatches and
  checkpoints; filterable rail view with plain-text export.
- **Resume digest 📋.** One click in the help popup produces a "where things
  stand / in flight / what's next" briefing from the live app state plus
  configurable sources (plan files, `git log`, commands run in the project
  dir). Sources come from the GLOBAL config only -- never from a repo-carried
  config.
- **Template composer.** Create/edit/duplicate team templates without
  spawning anything: per-entry agent/model/effort/args/prompt/worktree/
  announce/colour and a single-lead crown, rendered hierarchically (lead
  top-center). Applying a template only crowns its lead when the window has
  none.
- **Sandbox mode (🏺 Docker rail view).** Per-project switch that runs NEW
  sessions inside a persistent Docker/Podman container (`kory-sbx-<hash>`)
  instead of on the machine. Two work modes: *mount* (the project itself is
  bind-mounted at `/work` -- the sandbox protects the rest of the machine) or
  *ephemeral copy* (a throwaway `git clone --local` is mounted instead, plus
  an operator allow-list of gitignored globs; secrets and `node_modules` are
  never copied). The container's Claude login lives in a shared
  `kory-claude-auth` volume -- one blocking first-run modal with an embedded
  login terminal, and agents stay blocked until it succeeds, so the prompt
  never appears per tile. Your global `CLAUDE.md`/agents/skills/plugins/
  settings are COPIED in at each start (never mounted: a mounted
  `settings.json` would let a sandboxed agent plant a hook that runs on the
  host), with a `~/.claude/sandbox-overrides/` overlay for Windows-only
  hooks. The broker bridge is probed for real from inside the container, dev
  ports are published to `127.0.0.1`, transcripts live in the volume (so
  resume survives a rebuild), and containers are stopped -- never removed --
  on app close. The supervisor stays on the host and gains
  `deck_sandbox_exec`. Full guide: [docs/sandbox.md](docs/sandbox.md).
- **Safety nets.** Before an agent spawns into a dirty working tree, the Deck
  anchors a `git stash create` snapshot under `refs/claude-peers/` (restore
  command in the journal; auto-purged after 7 days). A `launchCommand` coming
  from a project's config triggers a one-time approval dialog (sha256
  remembered per project; refusal falls back to the global command).
- **English / French UI**, switchable live.

---

## Quick start

From the directory you want the peers to work in:

```bash
# one-time, from this repo:
cd desktop
npm install            # also rebuilds node-pty for Electron (see Develop)
npm link               # exposes the `kory` bin globally

# then, in any project:
cd /path/to/your/project
kory            # opens a window scoped to this directory
kory my-team    # optional: join/create a named (custom) shared group
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
- **Cross-session search** (🔍 in the top bar, or `Ctrl+Shift+F`): searches the
  scrollback of every open terminal, grouped by session. Double-click a result
  to focus its tile and scroll the terminal to the match (highlighted via
  selection). Scope is the live scrollback (last 8000 lines per session), not
  the full transcript history; repeated TUI repaint frames of the same line are
  collapsed into one result.

### Browser view (🌐, experimental)

An embedded web browser for web-front work, opened two ways:

- **Rail entry `🌐 Browser`** -- full-width browser (URL bar, back/forward,
  reload -- Shift-click bypasses the cache --, page DevTools, open-in-system-
  browser). The last URL is remembered (`http://localhost:3000` by default).
- **`🌐` button on an agent tile** -- the same browser with that agent's
  terminal **docked on the left** (resizable split): the classic "agent on one
  side, live site on the other" web-design loop. The docked terminal is a
  second view of the same PTY -- the original tile in the Agents view keeps its
  scrollback, and a resize nudge makes Claude's TUI repaint into the dock.
- **Element picker (`⌖`)** -- click it, then click any element in the page: a
  description (tag, size, best selector -- `data-testid`-style attributes are
  preferred over structural CSS paths -- and visible text) is pasted into the
  docked agent's prompt (bracketed paste, nothing auto-submitted): complete the
  sentence and press Enter. With no docked agent the description is copied to
  the clipboard. `Esc` cancels.
- **Viewport presets** -- render the page at a device size (iPhone SE, iPad,
  laptop…) centred in the pane. The active preset is appended to every element
  and annotation prompt (`[viewport: 375x667 – iPhone SE]`), so the agent knows
  which breakpoint you were looking at when you complained about the layout.
- **Draw mode (`✏`)** -- sketch freehand over the page (red strokes on a canvas
  overlay), then `📸`: the page screenshot is composited with your strokes,
  saved as a PNG under app state (pruned after 7 days), and its file path is
  pasted into the docked agent's prompt -- the agent `Read`s the image and sees
  exactly what you circled. `⌫` clears the sketch, `Esc` exits. Covers the
  feedback the element picker can't express ("this whole block is misaligned").
- **Window mirror (`🪟`)** -- the same pane can mirror **any OS window** (still
  capture via `desktopCapturer`, `⟳` refreshes): pick a window, annotate the
  capture with `✏`, send with `📸`. Design feedback on NATIVE apps -- the Deck
  itself, a Tauri build, anything -- with zero integration in the target.
  Element picking stays web-only; the sketch + the agent's multimodal `Read`
  answer the "which element" question for native targets. The embedded web
  page keeps its state while you're in window mode.

#### Design mode inside external apps (Tauri, Electron…) — experimental

Any webview-based app can join the element-picking loop **without being
embedded** in the Deck:

1. At launch the Deck starts a **loopback design endpoint** (127.0.0.1, random
   port, Bearer token minted per launch -- same security model as the
   supervisor's deck-control) and injects `CLAUDE_DECK_DESIGN_URL` /
   `CLAUDE_DECK_DESIGN_TOKEN` into **every session terminal it spawns**. The
   claude-peers broker is never involved: picks are a strictly local loop, so a
   remote/headless broker deployment changes nothing.
2. Add the client script (`deck-plugin/design/deck-design.js`, built by
   `npm run build:design`) to your app's **dev build** and hand it the pair.
   Tauri example (`src-tauri`, dev only):

   ```rust
   let url = std::env::var("CLAUDE_DECK_DESIGN_URL").unwrap_or_default();
   let token = std::env::var("CLAUDE_DECK_DESIGN_TOKEN").unwrap_or_default();
   builder.initialization_script(&format!(
       "window.__DECK_DESIGN__={{url:'{url}',token:'{token}',source:'my-app'}};{script}",
       script = include_str!("../deck-design.js")
   ));
   ```

   Plain web page alternative: `<meta name="deck-design-url" …>` +
   `<meta name="deck-design-token" …>` + a `<script src="deck-design.js">` tag.
3. Launch the app **from a session terminal inside the Deck** (it inherits the
   env pair), press `Ctrl+Shift+D` in the app, pick an element: its description
   lands in the docked (else selected) agent's prompt, exactly like a pick from
   the embedded browser. The script stays inert when the env pair is absent --
   safe to leave in a dev build launched outside the Deck.

Pages load in an isolated `persist:deck-browser` partition; `window.open` /
`target=_blank` links open in the system browser, never in new Electron
windows.

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
  -> global config (`%APPDATA%\kory` / XDG) -> default
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

> Fresh machine? The consolidated prerequisites checklist (per-OS toolchains,
> Bun + Node, the Windows Spectre-libs component) is
> [`BUILDING.md`](../BUILDING.md) at the repo root.

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

On Windows the build emits, in `dist/`, both `Koryphaios Setup <v>.exe`
(NSIS installer) and `Koryphaios-<v>-win.zip` (portable). The binary is
named **`kory.exe`** (no spaces, via `executableName`) while the
display name stays "Koryphaios".

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
Start-Process kory     # or just double-click the exe
```

**A `kory` command, scoped to the current directory.** Copy
[`bin/kory.cmd.example`](bin/kory.cmd.example) to a
folder on your PATH (e.g. `%USERPROFILE%\.cargo\bin\kory.cmd`), set
`APP_DIR` inside it to the folder containing `kory.exe`, and use:

```bat
kory            :: ephemeral group, sessions scoped to the cwd
kory my-team    :: custom (shared) group; the arg is the secret
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
    sandbox-command.ts    pure sandbox builders (naming, path/env mapping, engine argv)
    sandbox-service.ts    container lifecycle, auth/image/bridge probes, config projection
    sandbox-store.ts      per-project sandbox settings (app state, never the repo)
    sandbox-copy.ts       ephemeral-clone file selection (globs + hard deny list)
    sandbox-projection.ts operator ~/.claude allow-list + host-only hook detection
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
    browser-inspect.ts     guest preload of the browser <webview> (element picker)
  renderer/               React UI
    components/            Sidebar, CreateMenu, MessageBar, TileArea, TerminalTile,
                           BrowserView, DisplayModeBar, SettingsDialog, WorkspacesDialog, ...
    i18n.ts                renderer t() bound to the main-served dict
    store.ts               zustand store
  shared/types.ts         types shared across processes
  shared/announce.ts      compose the join / operator announce text
locales/                  en.json, fr.json
docs/                     reference documentation (operator + built-in assistants)
bin/
  launch.js               dev CLI launcher (npm link) -> spawns electron
  kory.cmd.example  wrapper template for a packaged build on PATH
bin/launch.js             the `kory` launcher
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
