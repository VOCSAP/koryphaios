# Building Koryphaios from source

Everything needed to go from a fresh machine to (a) a working **claude-peers**
MCP channel, (b) a standalone **Koryphaios desktop** binary (`kory`), and (c)
the **Parastatès** Android app. This file is the from-scratch checklist; the
deep dives stay where they live — [`README.md`](README.md) for the peers
channel and broker modes, [`desktop/README.md`](desktop/README.md) for the
Deck's develop/package details, and
[`desktop/mobile-shell/README.md`](desktop/mobile-shell/README.md) for what the
phone app actually does.

The repo builds **three products**:

| Product | Toolchain | Native code? |
| --- | --- | --- |
| `claude-peers` core (repo root: `server.ts`, `broker.ts`, `cli.ts`) | **Bun** only — TypeScript is run directly, nothing to compile | no |
| Koryphaios desktop (`desktop/`) | **Node.js + npm** (electron-vite / electron-builder) + **Bun** (bundles the deck-plugin assets) | yes — `node-pty`, rebuilt for Electron |
| Parastatès, the Android app (`desktop/mobile-shell/`) | **JDK 17 + Android SDK** (Capacitor / Gradle) + **Bun** (bundles the shell's web assets) | yes — Kotlin, §5 |

Only the first two are built by CI. **The Android app is not**, and that is a
deliberate consequence rather than an oversight: no CI runner here carries an
Android SDK, so its Kotlin is reviewed but never compiled. Everything that
*decides* anything therefore lives in TypeScript under `bun test` — see §5.

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

## 5. Build the Android app (Parastatès)

Optional: the app is only needed to use the phone as a companion screen or as
an approval channel. Nothing else in the repo depends on it.

### 5.1 What you need beyond §1

| Tool | Why | Notes |
| --- | --- | --- |
| **JDK 17** | the Android Gradle Plugin 8.x requires it — 11 is too old, 21 is not yet supported by every AGP 8.x | Android Studio ships a bundled JBR 17; with a CLI-only setup install a JDK 17 and set `JAVA_HOME` |
| **Android SDK** | compiles and packages the app | Easiest via **Android Studio**; otherwise the standalone *command-line tools* |
| **SDK Platform API 34** | Capacitor 6 compiles and targets 34 (`minSdk` 22) | `sdkmanager "platforms;android-34"` |
| **SDK Build-Tools 34** | dexing and packaging | `sdkmanager "build-tools;34.0.0"` |
| **Platform-Tools** (`adb`) | installs onto the device/emulator | `sdkmanager "platform-tools"` |
| **`ANDROID_HOME`** | how Capacitor and Gradle find the SDK | e.g. `~/Android/Sdk` (Linux), `~/Library/Android/sdk` (macOS), `%LOCALAPPDATA%\Android\Sdk` (Windows) |

**Gradle itself is not installed by hand**: `npx cap add android` generates a
Gradle *wrapper* (`./gradlew`) that fetches the right version.

Versions move. Treat the table as the floor and check
[capacitorjs.com → Environment Setup](https://capacitorjs.com/docs/getting-started/environment-setup)
if a fresh Capacitor disagrees with it.

A **physical device** needs USB debugging on (Settings → Developer options).
An **emulator** works for the UI but not for the parts that matter most here:
Doze behaviour and OEM battery-killing are exactly what an emulator will not
reproduce (`BACKLOG.md` §3.2).

### 5.2 Build

```bash
cd desktop/mobile-shell
npm install                       # Capacitor CLI + plugins
npm run build                     # Bun bundles src/ -> www/dist/app.js
npx cap add android               # generates android/ (gitignored: it IS a build artefact)

cp -r android-src/java/* android/app/src/main/java/
# merge android-src/AndroidManifest-additions.xml into
# android/app/src/main/AndroidManifest.xml (every block is annotated)
# and add the two libraries below to android/app/build.gradle

npx cap sync
npx cap run android               # builds, installs and launches on the selected target
```

**The two Gradle dependencies are not optional.** Capacitor brings
`androidx.core` and neither of these, so a build without them fails on
unresolved references — in `android/app/build.gradle`:

```gradle
dependencies {
    // MainActivity: the biometric gate on resume.
    implementation "androidx.biometric:biometric:1.1.0"
    // CompanionWebView: addDocumentStartJavaScript, the only API that
    // guarantees the resume credential is in place before the page's script.
    implementation "androidx.webkit:webkit:1.11.0"
}
```

### 5.3 Why `android/` is copied into rather than committed

`npx cap add android` *generates* the Gradle project, so it is a build artefact
and is gitignored. What the repo keeps is the part Capacitor cannot generate —
`android-src/` — which is copied in afterwards. The trade is that a Capacitor
upgrade regenerates a clean project and the copy step is repeated, instead of a
generated tree rotting in git.

### 5.4 Verifying without an Android SDK

The app's decision logic is deliberately in TypeScript so it can be checked on
any machine, including CI:

```bash
bun test tests/mobile-shell-*.test.ts                    # no device needed
cd desktop/mobile-shell && bunx tsc --noEmit -p tsconfig.json
cd desktop/mobile-shell && npm run build                 # proves the bundle builds
```

What this does **not** cover is every line of `android-src/`. The first real
build is where an `androidx` signature change or a missing dependency shows up;
`BACKLOG.md` §3.2 lists what to expect and the field checks that need a phone.

### 5.5 A shareable APK

`npx cap run android` produces a **debug** build — fine for your own device,
not for handing to someone else (debug-signed, and it will not upgrade over a
release-signed install). A release APK needs a signing config in
`android/app/build.gradle` and a keystore you generate with `keytool`; there is
no signing setup in this repo yet, and no store listing (`BACKLOG.md` §3.2).

## 6. Troubleshooting quick table

| Symptom | Cause / fix |
| --- | --- |
| `error MSB8040: Spectre-mitigated libraries are required` | Install the Spectre-mitigated libs component matching your MSVC toolset (§2 Windows) |
| node-gyp picks a Visual Studio that isn't installed | Pin `msvs_version` (§2 Windows step 4) |
| `npm install` succeeded but tiles die instantly / `node-pty` load error | Postinstall rebuild was skipped: install the toolchain, then `npm run rebuild` |
| Electron binary 403/timeout at first launch | Proxy blocks the download: allowlist GitHub or set `ELECTRON_MIRROR` (§3) |
| `winCodeSign` / `Sub items Errors: 2` on `package:win` | Enable Windows Developer Mode or use an elevated PowerShell (§3) |
| `deck-control MCP script missing -- run \`npm run build:mcp\`` | The deck-plugin bundles weren't built (Bun missing?): run `npm run build:mcp` |
| Peers see each other but messages arrive late | Channel flag missing: launch with `--dangerously-load-development-channels server:claude-peers` (§4) |
| Android build: `Unresolved reference: biometric` / `webkit` | The two Gradle dependencies were not added (§5.2) |
| Android build: `Unsupported class file major version` / AGP refuses the JDK | Wrong JDK — AGP 8.x wants **17** (§5.1) |
| `cap add android` or Gradle cannot find the SDK | `ANDROID_HOME` unset, or the API 34 platform not installed (§5.1) |
| `npx cap run android` finds no target | Device without USB debugging, or no AVD created |
| The app runs but the QR scanner opens a text prompt | `@capacitor/barcode-scanner` not installed / not synced: `npm install` then `npx cap sync` |
