#!/usr/bin/env node
'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { formatVersionLine } = require('./version-line.js')

if (process.argv[2] === '--version' || process.argv[2] === '-v') {
  printVersion()
  process.exitCode = 0
} else {
  main()
}

function printVersion() {
  const pkg = require('../package.json')
  // out/main is the electron-vite outDir wiped by electron-vite's main
  // build (its parent out/ is never touched by vite): a stale stamp there
  // cannot outlive the main process build it describes.
  const buildInfoPath = path.resolve(__dirname, '..', 'out', 'main', 'build-info.json')
  let build = null
  try {
    build = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'))
  } catch {
    // Not built yet, or the last build failed before writing the stamp:
    // degrade to an explicit marker rather than a stale or wrong hash.
  }
  console.log(formatVersionLine(pkg.version, build))
}

function main() {
  const projectDir = process.cwd()

  const avatar = process.argv[2] === '--avatar'
  const scopeId = avatar ? undefined : process.argv[2]

  // `require('electron')` resolves to the path of the locally-installed electron
  // binary (a string export when required outside the Electron runtime).
  let electron
  try {
    electron = require('electron')
  } catch {
    console.error(
      '[koryphaios] electron is not installed. Run `npm install` in the desktop/ package, then `npm run build`.'
    )
    process.exit(1)
  }

  const appRoot = path.resolve(__dirname, '..')

  const env = { ...process.env, CLAUDE_PEERS_DESK_PROJECT_DIR: projectDir }
  if (scopeId && scopeId.trim().length > 0) {
    env.CLAUDE_PEERS_DESK_SCOPE_ID = scopeId.trim()
  }

  const child = spawn(electron, avatar ? [appRoot, '--avatar'] : [appRoot], { stdio: 'inherit', env })

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 0)
  })

  child.on('error', (err) => {
    console.error('[koryphaios] failed to launch electron:', err.message)
    process.exit(1)
  })
}
