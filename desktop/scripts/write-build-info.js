#!/usr/bin/env node
'use strict'

// Runs as the last step of `npm run build`: stamps the commit that produced
// this build, written only after the build succeeded so a failed build never
// leaves behind a stamp for code that was never actually written to disk.
//
// The stamp lives inside out/main (electron-vite's own outDir for the main
// process build, wiped by electron-vite's main build), not out/ itself:
// that is what makes a stale stamp impossible to outlive the code it
// describes, and lets `kory --version` degrade honestly instead of reporting
// a hash for a build that got superseded by a bare `electron-vite dev`.

const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

function tryRun(cmd) {
  try {
    return execSync(cmd, { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
      .toString()
      .trim()
  } catch {
    return null
  }
}

const commit = tryRun('git rev-parse --short=7 HEAD') || 'unknown'
const status = tryRun('git status --porcelain')
const dirty = status !== null && status.length > 0

try {
  const outMainDir = path.resolve(__dirname, '..', 'out', 'main')
  fs.mkdirSync(outMainDir, { recursive: true })
  fs.writeFileSync(
    path.join(outMainDir, 'build-info.json'),
    JSON.stringify({ commit, dirty, builtAt: new Date().toISOString() })
  )
} catch (err) {
  // A read-only out/ or a full disk must not fail the whole `build` script
  // (chained with &&): `--version` degrades to "build inconnu" instead.
  console.error(`[write-build-info] could not write build stamp: ${err.message}`)
}
