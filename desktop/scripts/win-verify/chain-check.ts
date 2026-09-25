// M3: run the built statusLine hook (deck-plugin/hooks/desk-statusline.mjs)
// with a synthetic Status payload on stdin and a temporary CLAUDE_CONFIG_DIR
// whose global settings.json carries an operator statusLine command loaded
// with the characters that break naive shell quoting: embedded double
// quotes, an embedded single quote, `~`, and a `$(...)` command
// substitution. Also prints what chainShellFor() itself decides for the
// current platform/env, so a PowerShell-vs-Git-Bash choice can be read
// without spawning anything.
//
// Prerequisite: from desktop/, `npm run build:hook` (or just the
// desk-statusline target) must have produced deck-plugin/hooks/desk-statusline.mjs.
// Falls back to running hooks/desk-statusline.ts directly under bun if the
// built .mjs is missing, which is fine for the pure-logic checks but not a
// faithful stand-in for what Claude Code itself launches (Claude Code always
// runs the built plugin hook).
//
// Usage (from the repo root):
//   bun desktop/scripts/win-verify/chain-check.ts [--out <dir>]
//   bun desktop/scripts/win-verify/chain-check.ts --hide-git-bash
//   bun desktop/scripts/win-verify/chain-check.ts --git-bash-path "C:\Program Files\Git\bin\bash.exe"
//
// `--hide-git-bash` strips every PATH entry that contains "git" anywhere in
// its own text (case-insensitive), not just entries literally named "git" --
// same coarse filter the code below applies -- so gitBashFromPath() finds
// nothing, forcing the PowerShell branch on win32. It has no effect on
// non-win32 (chainShellFor always returns /bin/sh there).

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { chainShellFor, GIT_BASH_ENV } from '../../hooks/desk-statusline'
import { decodeStatusFile } from '../../src/shared/session-status'
import { parseOutDir, parseArg, hasFlag } from './out-dir'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_DESKTOP = join(HERE, '..', '..')
const BUILT_HOOK = join(REPO_DESKTOP, 'deck-plugin', 'hooks', 'desk-statusline.mjs')
const SOURCE_HOOK = join(REPO_DESKTOP, 'hooks', 'desk-statusline.ts')

const argv = process.argv.slice(2)
const outDir = parseOutDir(process.argv)
const hideGitBash = hasFlag(argv, 'hide-git-bash')
const explicitGitBashPath = parseArg(argv, 'git-bash-path', '')

// The tricky-quoting operator command: double quotes wrapping a string that
// itself contains a single quote, a literal `~`, and a `$(...)` substitution
// the shell must expand (not print literally).
const OPERATOR_COMMAND = 'echo "operator\'s line ~ $(pwd)"'

const PAYLOAD = JSON.stringify({
  hook_event_name: 'Status',
  session_id: 'win-verify-m3',
  model: { id: 'claude-3-5-haiku-20241022', display_name: 'Haiku' },
  context_window: { context_window_size: 200000, used_percentage: 3.5 }
})

function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  if (hideGitBash) {
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
    const kept = (env[pathKey] ?? '')
      .split(process.platform === 'win32' ? ';' : ':')
      .filter((seg) => !/git/i.test(seg))
    env[pathKey] = kept.join(process.platform === 'win32' ? ';' : ':')
    delete env[GIT_BASH_ENV]
  }
  if (explicitGitBashPath) env[GIT_BASH_ENV] = explicitGitBashPath
  return env
}

function reportChainShellDecision(env: Record<string, string>): void {
  const exists = (p: string): boolean => {
    try {
      return existsSync(p)
    } catch (e) {
      console.error(`existsSync(${p}) failed, treating as absent:`, e)
      return false
    }
  }
  const decision = chainShellFor(process.platform, env, exists, OPERATOR_COMMAND)
  console.log('chainShellFor() decision on this platform/env:')
  console.log(`  file: ${decision.file}`)
  console.log(`  args: ${JSON.stringify(decision.args)}`)
}

async function main(): Promise<void> {
  const env = buildEnv()
  reportChainShellDecision(env)

  const home = mkdtempSync(join(tmpdir(), 'kory-chain-check-'))
  const cfgDir = join(home, 'cfg')
  const logsDir = join(home, 'logs')
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(join(cfgDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: OPERATOR_COMMAND } }))

  const hookPath = existsSync(BUILT_HOOK) ? BUILT_HOOK : SOURCE_HOOK
  const usingBuilt = hookPath === BUILT_HOOK
  console.log(`\nrunning hook: ${hookPath} (built=${usingBuilt})`)

  const { stdout, stderr, exitCode } = await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (resolve, reject) => {
      const child = spawn('bun', [hookPath], {
        env: {
          ...env,
          HOME: home,
          USERPROFILE: home,
          CLAUDE_CONFIG_DIR: cfgDir,
          CLAUDE_PEERS_LOG_DIR: logsDir,
          CLAUDE_PEERS_DESK_SESSION: 'win-verify-m3-tile'
        }
      })
      const out: Buffer[] = []
      const err: Buffer[] = []
      child.stdout.on('data', (c: Buffer) => out.push(c))
      child.stderr.on('data', (c: Buffer) => err.push(c))
      child.on('error', reject)
      child.on('close', (code) => {
        resolve({ stdout: Buffer.concat(out).toString('utf-8'), stderr: Buffer.concat(err).toString('utf-8'), exitCode: code ?? -1 })
      })
      child.stdin.end(PAYLOAD)
    }
  )

  const statusFile = join(home, '.claude', 'peers', 'desk-status-win-verify-m3-tile.json')
  const statusRaw = existsSync(statusFile) ? readFileSync(statusFile, 'utf-8') : null
  const decoded = statusRaw ? decodeStatusFile(statusRaw) : null

  const result = {
    hookPath,
    usingBuilt,
    hideGitBash,
    explicitGitBashPath: explicitGitBashPath || null,
    operatorCommand: OPERATOR_COMMAND,
    exitCode,
    stdout,
    stderr,
    statusFileExists: statusRaw !== null,
    statusFileDecoded: decoded
  }

  console.log(`\nexit code: ${exitCode}`)
  console.log(`stdout: ${JSON.stringify(stdout)}`)
  if (stderr.trim()) console.log(`stderr: ${stderr.trim()}`)
  console.log(`status file (${statusFile}): ${statusRaw !== null ? 'written' : 'MISSING'}`)
  if (decoded) console.log(`  decoded: ${JSON.stringify(decoded)}`)

  const outFile = join(outDir, `chain-check-${Date.now()}.json`)
  writeFileSync(outFile, JSON.stringify(result, null, 2))
  console.log(`\nfull report: ${outFile}`)

  rmSync(home, { recursive: true, force: true })
}

void main()
