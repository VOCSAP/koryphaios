---
paths:
  - "desktop/electron-builder.yml"
  - "desktop/electron.vite.config.ts"
  - "desktop/package.json"
  - "package.json"
---

# Electron build and packaging

- Never let electron-builder write `desktop/dist`; package a check to a scratch directory: `electron-builder --dir --publish=never -c.directories.output=<scratch> -c.npmRebuild=false`.
  Why: the operator's Deck may be running from `desktop/dist/win-unpacked`; the builder empties it first, fails on a locked file and leaves a half-deleted install that still starts.
- Run `electron-vite build` with the working directory set to `desktop/`, including from a mirror.
  Why: electron-vite picks the main output format from the `package.json` of `process.cwd()`; the root one is `"type": "module"`, so a build from the root emits ESM that Electron cannot load, without an error.
- Read an asar only with `asar extract <asar> <absolute scratch dir>`, never `asar extract-file`.
  Why: `extract-file` writes into the shell's working directory and overwrote the tracked root `package.json`.
- Launch a packaged build for a check with `--user-data-dir=<scratch>` and stop it by the PID you started.
  Why: without the flag it reads and writes the operator's real Deck profile.
