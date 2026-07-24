# Building Koryphaios from source

Everything needed to go from a fresh machine to (a) a working **claude-peers**
MCP channel and (b) a standalone **Koryphaios desktop** binary (`kory`). This
file is the from-scratch checklist; the deep dives stay where they live —
[`README.md`](README.md) for the peers channel and broker modes,
[`desktop/README.md`](desktop/README.md) for the Deck's develop/package
details.

The repo builds **two products**:

| Product | Toolchain | Native code? |
| --- | --- | --- |
| `claude-peers` core (repo root: `server.ts`, `broker.ts`, `cli.ts`) | **Bun** only — TypeScript is run directly, nothing to compile | no |
| Koryphaios desktop (`desktop/`) | **Node.js + npm** (electron-vite / electron-builder) + **Bun** (bundles the deck-plugin assets) | yes — `node-pty`, rebuilt for Electron |

## 1. Common prerequisites (all platforms)

- **git**
- **[Bun](https://bun.sh)** ≥ 1.1 — runs the core, the test suite, and the
  `build:hook` / `build:mcp` / `build:design` steps that every desktop build
  (`npm run dev` / `build` / `package`) executes first. Yes, you need Bun even
  if you only build the desktop app.
- **Node.js ≥ 20 + npm** — the desktop app builds with electron-vite/npm, not
  Bun (native module constraint; see `BUN.md` for the rationale).
- A **C/C++ toolchain** for `node-pty` (next section). Every session tile is a
  real PTY: this dependency is not optional.

## 2. Native toolchain for node-pty, per OS

`desktop/npm install` triggers `electron-rebuild -f -w node-pty` (postinstall).
If no toolchain is present the postinstall is absorbed with a warning — the
app then fails at runtime when opening a tile — so install the toolchain
first, or run `npm run rebuild` afterwards.

### Windows

1. **Visual Studio 2022 Build Tools** (or full VS) with the **“Desktop
   development with C++”** workload — includes MSVC and the Windows SDK
   (“Desktop C++ Apps” components are the ones needed).
2. **Spectre-mitigated libraries** — the precise gotcha: `node-pty` hardcodes
   `SpectreMitigation=Spectre` in its `binding.gyp`, so the MSVC toolset you
   build with **must** have the matching Spectre-mitigated libs, or the build
   fails with **`error MSB8040: Spectre-mitigated libraries are required for
   this project`**. Install: Visual Studio Installer → *Modify* → *Individual
   components* → search **“Spectre”** → check **“MSVC v143 – VS 2022 C++
   x64/x86 Spectre-mitigated libs (Latest)”** (pick the v14x line matching
   your installed toolset; with VS 2019 that's a v142 variant).
3. **Python 3** (node-gyp requirement; the VS installer can provide it).
4. If node-gyp keeps picking a phantom/wrong Visual Studio (some apps register
   ghost instances that `vswhere` reports), pin the year:
   `$env:npm_config_msvs_version = "2022"` (or `"2019"`), or persist
   `msvs_version=2022` in a local, git-ignored `desktop/.npmrc`.
5. Run native builds from **PowerShell / cmd**, not git-bash (node-gyp's
   shell-outs assume cmd.exe).

### macOS

- **Xcode Command Line Tools**: `xcode-select --install` (the full Xcode from
  the App Store also works).

### Linux (Debian/Ubuntu)

```bash
sudo apt install -y make python3 build-essential
```

## 3. Build the desktop app

```bash
cd desktop
npm install          # deps + electron-rebuild of node-pty for Electron
npm run rebuild      # only if the postinstall rebuild was skipped/failed
npm run typecheck    # tsc main/preload + renderer (sanity check)
npm run dev          # dev mode with renderer HMR — no packaging needed
```

Development launcher without packaging (the usual way to run it):

```bash
npm link             # one-time: exposes the `kory` bin globally
cd /path/to/your/project && kory
```

Standalone installers (electron-builder, output in `desktop/dist/`):

```bash
npm run package          # current OS
npm run package:win      # NSIS installer + portable zip (binary: kory.exe)
npm run package:mac      # dmg
npm run package:linux    # AppImage
```

> First **Windows** packaging only: electron-builder extracts `winCodeSign`
> (which contains macOS symlinks). If it fails with `Sub items Errors: 2`,
> enable **Windows Developer Mode** (Settings → Privacy & Security → For
> developers) or run the command from an elevated PowerShell, then retry.
> Details and more platform notes: [`desktop/README.md`](desktop/README.md).

> Since Electron 42 the Electron **binary downloads at first launch**, not at
> `npm install`. Behind a restrictive proxy that download can 403 — allow
> `github.com`/`objects.githubusercontent.com`, or point `ELECTRON_MIRROR` at
> a reachable mirror.

## 4. Enable the claude-peers MCP channel

The core needs no build — Bun runs the TypeScript directly:

```bash
cd <repo root>
bun install
bun test            # optional sanity check
```

Register the channel with Claude Code (single-PC local mode; the broker
auto-spawns on first use):

```bash
claude mcp add --scope user --transport stdio claude-peers -- bun /absolute/path/to/koryphaios/server.ts
claude --dangerously-load-development-channels server:claude-peers
```

Without `--dangerously-load-development-channels`, messages still flow but
peers must poll with `check_messages` instead of being pushed.

For the **multi-PC / HTTP broker** mode (shared broker on a LAN or the
Internet: `broker_url` + `broker_token` in the user config,
`CLAUDE_PEERS_BIND_HOST` / `CLAUDE_PEERS_BROKER_TOKEN` on the broker host),
follow [`README.md` → Quick start (HTTP)](README.md#quick-start-http).

The **desktop app needs no extra MCP setup**: each tile it spawns gets the
channel through the bundled deck-plugin, and the supervisor/demo bridges
(`deck-control-mcp.mjs`, `demo-browser-mcp.mjs`) are generated by the build
(`npm run build:mcp`, part of `dev`/`build`/`package`).

## 5. Troubleshooting quick table

| Symptom | Cause / fix |
| --- | --- |
| `error MSB8040: Spectre-mitigated libraries are required` | Install the Spectre-mitigated libs component matching your MSVC toolset (§2 Windows) |
| node-gyp picks a Visual Studio that isn't installed | Pin `msvs_version` (§2 Windows step 4) |
| `npm install` succeeded but tiles die instantly / `node-pty` load error | Postinstall rebuild was skipped: install the toolchain, then `npm run rebuild` |
| Electron binary 403/timeout at first launch | Proxy blocks the download: allowlist GitHub or set `ELECTRON_MIRROR` (§3) |
| `winCodeSign` / `Sub items Errors: 2` on `package:win` | Enable Windows Developer Mode or use an elevated PowerShell (§3) |
| `deck-control MCP script missing -- run \`npm run build:mcp\`` | The deck-plugin bundles weren't built (Bun missing?): run `npm run build:mcp` |
| Peers see each other but messages arrive late | Channel flag missing: launch with `--dangerously-load-development-channels server:claude-peers` (§4) |
