// IDLE REDRAW-RATE probe (Vague 10 lot A1, cards 63ca372f / 5dbf3255).
//
// Question it answers, and nothing else: when a Claude Code tile is AT REST
// (prompt displayed, no turn running), how often does the CLI write bytes to
// the pty? That number decides whether ANY silence-based idle predicate
// (a quiescence net, a threshold on `outputAt`) can ever observe an idle tile,
// or whether it would simply block every injection until the 120 s deadline.
//
// It measures four things over a fixed window, and prints them raw:
//   EVENTS      pty 'data' events in the window
//   BYTES       bytes carried by them
//   MAXGAP_MS   longest silence between two consecutive data events  <-- decisive
//   GAPS        the full sorted gap list (ms), so a threshold can be read off it
//
// Nothing here submits anything to the model: the CLI is spawned, left alone,
// and killed. No API turn is spent.
//
// Run under Electron-as-Node so the Electron-ABI node-pty loads:
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/.bin/electron tests/pty-harness/idle-redraw-probe.cjs
//
// Env knobs: PROBE_CLI (default 'claude'), PROBE_CWD (default a temp dir),
// PROBE_SETTLE_MS (default 12000, startup paint excluded from the window),
// PROBE_WINDOW_MS (default 30000).
const { join } = require('node:path')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const HERE = __dirname
const REPO = join(HERE, '..', '..')

let pty
try {
  pty = require(join(REPO, 'desktop', 'node_modules', 'node-pty'))
} catch (e) {
  console.error('PROBE-UNAVAILABLE node-pty could not be loaded:', e && e.message)
  process.exit(2)
}

const CLI = process.env.PROBE_CLI || 'claude'
const CWD = process.env.PROBE_CWD || mkdtempSync(join(tmpdir(), 'idle-probe-'))
const SETTLE_MS = Number(process.env.PROBE_SETTLE_MS || 12000)
const WINDOW_MS = Number(process.env.PROBE_WINDOW_MS || 30000)
const DUMP = process.env.PROBE_DUMP || ''

const childEnv = { ...process.env }
delete childEnv.ELECTRON_RUN_AS_NODE

const p = pty.spawn(CLI, [], {
  name: 'xterm-256color',
  cols: 120,
  rows: 30,
  cwd: CWD,
  env: childEnv
})

let phase = 'settle'
let events = 0
let bytes = 0
let last = 0
const gaps = []
let settleEvents = 0
let settleBytes = 0
let transcript = ''

p.onData((d) => {
  if (DUMP) transcript += d
  if (phase === 'settle') { settleEvents++; settleBytes += d.length; return }
  if (phase !== 'measure') return
  const now = Date.now()
  if (last) gaps.push(now - last)
  last = now
  events++
  bytes += d.length
})

setTimeout(() => { phase = 'measure'; last = Date.now() }, SETTLE_MS)

setTimeout(() => {
  phase = 'done'
  const windowSec = WINDOW_MS / 1000
  const maxGap = gaps.length ? Math.max(...gaps) : WINDOW_MS
  console.log('CLI ' + CLI)
  console.log('SETTLE_EVENTS ' + settleEvents + ' SETTLE_BYTES ' + settleBytes)
  console.log('WINDOW_MS ' + WINDOW_MS)
  console.log('EVENTS ' + events + ' (' + (events / windowSec).toFixed(2) + '/s)')
  console.log('BYTES ' + bytes + ' (' + (bytes / windowSec).toFixed(1) + ' B/s)')
  console.log('MAXGAP_MS ' + maxGap)
  console.log('GAPS ' + JSON.stringify(gaps.slice().sort((a, b) => b - a).slice(0, 20)))
  if (settleEvents === 0 && events === 0) {
    console.error('PROBE-MEASURED-NOTHING the CLI produced no output at all')
    p.kill()
    process.exit(3)
  }
  if (DUMP) writeFileSync(DUMP, transcript)
  p.kill()
  setTimeout(() => process.exit(0), 400)
}, SETTLE_MS + WINDOW_MS)
