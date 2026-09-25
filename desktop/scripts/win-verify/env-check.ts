// M1: does the statusLine PROCESS actually inherit CLAUDE_PEERS_DESK_SESSION
// when Claude Code spawns it? pty-manager.ts's spawn() sets it in the child
// PTY's env (extraEnv from scope.ts merged over process.env), and Claude Code
// itself then spawns the statusLine command as a grandchild of that PTY
// process on its own refresh timer -- this checks that the env var survives
// that second hop, which is the one no test in this repo can reach (no real
// `claude` process is ever spawned from a bun test).
//
// Two steps, because the thing under test is Claude Code itself launching a
// statusLine, which this script cannot do headlessly -- it only prepares the
// probe and reads back what Claude Code did.
//
// Usage (from the repo root):
//   bun desktop/scripts/win-verify/env-check.ts setup --out desktop/scripts/win-verify/out
//     -> prints the exact `claude --settings <file>` invocation to run by hand,
//        with CLAUDE_PEERS_DESK_SESSION set in that same shell first.
//   bun desktop/scripts/win-verify/env-check.ts check --shell bash|powershell --out desktop/scripts/win-verify/out
//     -> reads the dump file the probe statusLine wrote and reports whether
//        CLAUDE_PEERS_DESK_SESSION was present and what value it carried, for
//        THAT shell only: a dump written by the other shell, or a stale dump
//        left from a previous run, is not a PASS for this one. Deletes the
//        dump file after reading it, so a second `check` with no new run in
//        between correctly reports "no dump file" rather than replaying the
//        previous verdict.

import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { parseOutDir } from './out-dir'

const SENTINEL = 'win-verify-m1-desk-session'
const outDir = parseOutDir(process.argv)
const dumpFile = join(outDir, 'env-check-dump.json')
const probeScriptSh = join(outDir, 'env-check-probe.sh')
const probeScriptPs1 = join(outDir, 'env-check-probe.ps1')
// Written by setup(), read by check(): the dump must be NEWER than this, or
// it is a leftover from a previous run (a previous shell's dump the user
// forgot to `check` before switching settings files, or a dump the probe
// never overwrote because the statusLine failed to fire at all) rather than
// evidence this run's statusLine actually executed.
const setupMarkerFile = join(outDir, 'env-check-setup-at.txt')
// Two settings files, one per shell: Claude Code's own choice of Git Bash vs
// PowerShell (chainShellFor()'s own logic) cannot be forced from here, so
// both statusLine commands are exercised explicitly, one file per run,
// rather than relying on a single file to happen to hit both paths.
const settingsFileBash = join(outDir, 'env-check-settings-bash.json')
const settingsFilePs1 = join(outDir, 'env-check-settings-ps1.json')
const settingsFileSh = join(outDir, 'env-check-settings.json')

function setup(): void {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(setupMarkerFile, String(Date.now()))

  // A statusLine command that dumps its own env to dumpFile, cross-platform:
  // two probe scripts, Claude Code picks its shell the same way
  // chainShellFor() does (Git Bash first on win32, else PowerShell).
  writeFileSync(
    probeScriptSh,
    `#!/bin/sh\n` +
      `# env-check probe (M1): dumps CLAUDE_PEERS_DESK_SESSION and a few\n` +
      `# neighbours to ${JSON.stringify(dumpFile)} so this session can read it back.\n` +
      `printf '{"shell":"sh","CLAUDE_PEERS_DESK_SESSION":%s,"HOME":%s,"pid":%s}\\n' \\\n` +
      `  "\\"\${CLAUDE_PEERS_DESK_SESSION:-__absent__}\\"" "\\"\${HOME:-__absent__}\\"" "\\"$$\\"" > ${JSON.stringify(dumpFile)}\n` +
      `echo "env-check ok"\n`,
    { mode: 0o755 }
  )
  writeFileSync(
    probeScriptPs1,
    `# env-check probe (M1): dumps CLAUDE_PEERS_DESK_SESSION to a file so this\n` +
      `# session can read it back.\n` +
      `$v = if ($env:CLAUDE_PEERS_DESK_SESSION) { $env:CLAUDE_PEERS_DESK_SESSION } else { '__absent__' }\n` +
      `$obj = @{ shell = 'powershell'; CLAUDE_PEERS_DESK_SESSION = $v; USERPROFILE = $env:USERPROFILE; pid = $PID }\n` +
      `$obj | ConvertTo-Json | Set-Content -Path ${JSON.stringify(dumpFile)} -Encoding utf8\n` +
      `Write-Output 'env-check ok'\n`
  )

  // On win32, Claude Code may run the statusLine command through either Git
  // Bash or PowerShell (chainShellFor()'s own choice, not picked here), so
  // this writes one settings file per shell -- the .sh probe invoked as
  // `bash <path>.sh` with forward slashes (the form Git Bash takes without
  // MSYS path translation surprises), the .ps1 one invoked as
  // `powershell -NoProfile -File <path>.ps1` -- and both must be run in turn
  // (M1 below is PASS only once both shells have been exercised). refreshInterval
  // lives INSIDE statusLine (Claude Code's settings schema), not at the
  // top level, mirroring statusline-settings.ts.
  const bashCommand = `bash "${probeScriptSh.replace(/\\/g, '/')}"`
  // -ExecutionPolicy Bypass: the default Windows client policy (Restricted)
  // blocks an unsigned -File script outright, which would make `check` see
  // no dump and correctly FAIL -- but a machine with a looser default policy
  // (RemoteSigned, Unrestricted) would silently mask that this command line
  // omitted the flag Koryphaios' own generated statusLine settings must carry.
  const ps1Command = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${probeScriptPs1}"`
  writeFileSync(
    settingsFileBash,
    JSON.stringify({ statusLine: { type: 'command', command: bashCommand, refreshInterval: 5 } }, null, 2)
  )
  writeFileSync(
    settingsFilePs1,
    JSON.stringify({ statusLine: { type: 'command', command: ps1Command, refreshInterval: 5 } }, null, 2)
  )
  // Non-win32 reference run (this repo's own smoke check): plain sh.
  writeFileSync(
    settingsFileSh,
    JSON.stringify({ statusLine: { type: 'command', command: `sh ${probeScriptSh}`, refreshInterval: 5 } }, null, 2)
  )

  console.log('Probe scripts written:')
  console.log(`  ${probeScriptSh}  (Git Bash)`)
  console.log(`  ${probeScriptPs1}  (PowerShell)`)
  console.log('Settings files:')
  console.log(`  ${settingsFileBash}  (forces the Git Bash probe)`)
  console.log(`  ${settingsFilePs1}  (forces the PowerShell probe)`)
  console.log('\nRun BOTH, one at a time, in the SAME shell that sets the sentinel:')
  console.log('\nGit Bash settings file, from PowerShell or Git Bash:')
  console.log(`  $env:CLAUDE_PEERS_DESK_SESSION = "${SENTINEL}"`)
  console.log(`  claude --settings "${settingsFileBash}"`)
  console.log('  (or, from Git Bash: CLAUDE_PEERS_DESK_SESSION="' + SENTINEL + '" claude --settings "' + settingsFileBash + '")')
  console.log('\nPowerShell settings file:')
  console.log(`  $env:CLAUDE_PEERS_DESK_SESSION = "${SENTINEL}"`)
  console.log(`  claude --settings "${settingsFilePs1}"`)
  console.log('\nFor each run: let the statusLine fire at least once (wait ~5s after the prompt')
  console.log('appears), then Ctrl-C out of claude and run, for the shell just exercised:')
  console.log(`  bun desktop/scripts/win-verify/env-check.ts check --shell bash --out ${outDir}`)
  console.log(`  bun desktop/scripts/win-verify/env-check.ts check --shell powershell --out ${outDir}`)
  console.log('check deletes the dump file after reading it, so run each shell and its matching')
  console.log('`check --shell ...` in turn -- never both shells before either check.')
}

function parseShellArg(argv: string[]): 'bash' | 'powershell' {
  const i = argv.indexOf('--shell')
  const v = i >= 0 ? argv[i + 1] : undefined
  if (v !== 'bash' && v !== 'powershell') {
    console.error(`usage: bun env-check.ts check --shell bash|powershell [--out <dir>]`)
    console.error(`  (required: which probe's dump this check verdict is for -- a dump`)
    console.error(`  file carries a "shell" field the probe itself wrote, and this must`)
    console.error(`  match, or a PowerShell run reading a leftover Git Bash dump -- or`)
    console.error(`  vice versa -- would report a false PASS)`)
    process.exit(2)
  }
  return v
}

function check(): void {
  const wantShell = parseShellArg(process.argv)
  const expectedProbeShell = wantShell === 'bash' ? 'sh' : 'powershell'

  if (!existsSync(dumpFile)) {
    console.error(`no dump file at ${dumpFile} -- did the statusLine ever fire? run 'setup' first, then launch claude.`)
    console.log(`\nM1 (${wantShell}) verdict: FAIL -- no dump file.`)
    process.exit(2)
  }

  let setupAt = 0
  if (existsSync(setupMarkerFile)) {
    setupAt = Number(readFileSync(setupMarkerFile, 'utf-8').trim()) || 0
  }
  const dumpMtimeMs = statSync(dumpFile).mtimeMs
  const isFresh = setupAt > 0 && dumpMtimeMs > setupAt

  const raw = readFileSync(dumpFile, 'utf-8')
  // The dump is read once: whatever the verdict, it must not be replayed by a
  // later `check` with no new statusLine run in between.
  try {
    unlinkSync(dumpFile)
  } catch (e) {
    console.error(`warning: could not delete ${dumpFile} after reading it: ${String(e)}`)
  }

  let parsed: Record<string, unknown>
  try {
    // Windows PowerShell 5.1 `Set-Content -Encoding utf8` writes a BOM that JSON.parse rejects.
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch (e) {
    console.error(`dump file is not valid JSON: ${String(e)}`)
    console.error(raw)
    console.log(`\nM1 (${wantShell}) verdict: FAIL -- dump unreadable.`)
    process.exit(2)
  }

  const seen = parsed['CLAUDE_PEERS_DESK_SESSION']
  const inherited = seen === SENTINEL
  const seenShell = parsed['shell']
  const shellMatches = seenShell === expectedProbeShell

  console.log(`dump file: ${dumpFile} (deleted after this read)`)
  console.log(`content: ${JSON.stringify(parsed, null, 2)}`)
  console.log(`\nCLAUDE_PEERS_DESK_SESSION inherited by the statusLine process: ${inherited ? 'YES' : 'NO'}`)
  if (!inherited) console.log(`  expected "${SENTINEL}", got ${JSON.stringify(seen)}`)
  console.log(`shell field matches --shell ${wantShell} (expected "${expectedProbeShell}"): ${shellMatches ? 'YES' : 'NO'} -- got ${JSON.stringify(seenShell)}`)
  console.log(`dump is newer than 'setup' (not a leftover from a previous run): ${isFresh ? 'YES' : 'NO'}`)
  if (!isFresh) {
    console.log(`  setup marker: ${setupAt || 'missing -- rerun setup'}, dump mtime: ${dumpMtimeMs}`)
  }

  const pass = inherited && shellMatches && isFresh
  console.log(`\nM1 (${wantShell}) verdict: ${pass ? 'PASS' : 'FAIL'} -- record this whole block in the Resultats section.`)
  if (!pass) process.exit(1)
}

const cmd = process.argv[2]
if (cmd === 'setup') setup()
else if (cmd === 'check') check()
else {
  console.error('usage: bun env-check.ts <setup|check --shell bash|powershell> [--out <dir>]')
  process.exit(2)
}
