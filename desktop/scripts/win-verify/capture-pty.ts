// M2 capture: spawn a real `claude` under node-pty (the same engine
// desktop/src/main/pty-manager.ts uses -- ConPTY on win32) with or without a
// Deck-style statusLine, run one short prompt, and dump the raw PTY chunks as
// a fixture in the same [{t, data}] shape as tests/pty-harness/fixtures/*.json.
//
// node-pty is loaded from desktop/node_modules, which on win32 needs a
// native build matching the Node ABI this script runs under -- either the
// prebuilt win32-x64/win32-arm64 binding node-pty ships (used automatically)
// or `npm run rebuild` in desktop/ if that binding is missing or mismatched.
// This is plain `bun`/`node`, not Electron-as-node: no ELECTRON_RUN_AS_NODE
// trick needed, unlike the .cjs probes in tests/pty-harness/.
//
// Usage (PowerShell or Git Bash, from the repo root):
//   bun desktop/scripts/win-verify/capture-pty.ts --with-statusline --model haiku --out desktop/scripts/win-verify/out
//   bun desktop/scripts/win-verify/capture-pty.ts --without --model haiku --out desktop/scripts/win-verify/out
//
// Flags:
//   --with-statusline   launch with --settings pointing at a statusLine settings
//                        file (same shape statusline-settings.ts builds), so the
//                        footer hides "esc to interrupt" the way a real Deck
//                        tile does.
//   --without           launch with no --settings at all (baseline, hint visible).
//   --model <id>         forwarded as `claude --model <id>` (default: haiku).
//   --prompt <text>      the one turn to run (default: a `sleep 4` prompt, chosen
//                         so the turn visibly takes a few seconds without
//                         spending a real tool call worth caring about).
//   --cwd <dir>           working directory for the spawned CLI (default: a
//                         fresh temp dir -- must already be a TRUSTED directory
//                         or the trust dialog eats the capture; pass a cwd you
//                         have already opened Claude Code in once).
//   --settle-ms <n>       time to let the startup frame settle before sending
//                         the prompt (default 3000).
//   --timeout-ms <n>      hard cap on the whole capture (default 30000).
//   --out <dir>           output directory (default desktop/scripts/win-verify/out/).
//
// Exactly one of --with-statusline / --without must be given.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseOutDir, parseArg, hasFlag } from './out-dir'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_DESKTOP = join(HERE, '..', '..')

async function loadPty(): Promise<typeof import('node-pty')> {
  const path = join(REPO_DESKTOP, 'node_modules', 'node-pty')
  try {
    return (await import(path)) as typeof import('node-pty')
  } catch (e) {
    console.error(`node-pty could not be loaded from ${path}.`)
    console.error('On Windows: run `cd desktop && npm install` (pulls the prebuilt win32 binding), or')
    console.error('`npm run rebuild` if the ABI does not match this runtime.')
    console.error(String((e as Error)?.message ?? e))
    process.exit(2)
  }
}

const argv = process.argv
const withStatusLine = hasFlag(argv, 'with-statusline')
const without = hasFlag(argv, 'without')
if (withStatusLine === without) {
  console.error('pass exactly one of --with-statusline or --without')
  process.exit(2)
}
const model = parseArg(argv, 'model', 'haiku')
const prompt = parseArg(
  argv,
  'prompt',
  "Execute exactement cette commande bash et rien d'autre: sleep 4. N'utilise aucun autre outil, puis reponds juste FINI."
)
const cwd = parseArg(argv, 'cwd', mkdtempSync(join(tmpdir(), 'win-verify-capture-')))
const settleMs = Number(parseArg(argv, 'settle-ms', '3000'))
const timeoutMs = Number(parseArg(argv, 'timeout-ms', '30000'))
const outDir = parseOutDir(argv)

function buildStatusLineSettingsFile(dir: string): string {
  // Same shape statusline-settings.ts produces for a Deck tile: statusLine
  // only, refreshInterval 5s. The command itself does not need to be the
  // real desk-statusline hook for M2 -- what matters is that a statusLine IS
  // configured, so Claude Code hides the "esc to interrupt" footer hint.
  const settingsPath = join(dir, 'win-verify-statusline-settings.json')
  const settings = {
    statusLine: {
      type: 'command',
      command: process.platform === 'win32' ? 'echo win-verify' : 'echo win-verify',
      padding: 0,
      refreshInterval: 5
    }
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  return settingsPath
}

async function main(): Promise<void> {
  mkdirSync(cwd, { recursive: true })
  const pty = await loadPty()

  const args: string[] = ['--model', model]
  let settingsPath: string | null = null
  if (withStatusLine) {
    settingsPath = buildStatusLineSettingsFile(outDir)
    args.push('--settings', settingsPath)
  }

  const childEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) childEnv[k] = v

  console.log(`spawning: claude ${args.join(' ')}`)
  console.log(`cwd: ${cwd}`)
  console.log(`platform: ${process.platform}`)

  const chunks: { t: number; data: string }[] = []
  const t0 = Date.now()
  const proc = pty.spawn('claude', args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd,
    env: childEnv
  })

  proc.onData((data: string) => {
    chunks.push({ t: Date.now() - t0, data })
  })

  let exited: { exitCode: number } | null = null
  proc.onExit((e: { exitCode: number }) => {
    exited = e
  })

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  await sleep(settleMs)
  proc.write(prompt)
  await sleep(200)
  proc.write('\r')

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && exited === null) {
    await sleep(250)
  }

  try {
    proc.kill()
  } catch (e) {
    console.error('proc.kill() failed (already exited, most likely):', e)
  }
  await sleep(300)

  const label = withStatusLine ? 'with-statusline' : 'without-statusline'
  const outFile = join(outDir, `capture-${label}-${Date.now()}.json`)
  writeFileSync(outFile, JSON.stringify(chunks))
  console.log(`\ncaptured ${chunks.length} chunks (exited=${exited !== null})`)
  console.log(`fixture written: ${outFile}`)
  if (chunks.length === 0) {
    console.error('CAPTURE-EMPTY: node-pty produced no data at all -- claude may not be on PATH or the trust dialog blocked it')
    process.exit(3)
  }
  console.log(`\nreplay it with:\n  bun desktop/scripts/win-verify/replay-busy.ts ${outFile}`)
}

void main()
