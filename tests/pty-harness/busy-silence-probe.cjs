// IS PTY SILENCE AN HONEST "IDLE" SIGNAL? (Vague 10 lot A1)
//
// The idle probe next door measures the AT-REST rate. This one measures the
// other half, the one that decides whether `silence => idle` is sound: during a
// LONG, OUTPUT-LESS TOOL CALL (a `sleep`), does the CLI keep painting?
//
// If it does, silence really does imply "no turn running" and a quiescence
// threshold is well-founded. If the stream goes quiet while a tool runs, the
// same threshold declares a busy tile idle, and any injection gated on it lands
// mid-turn.
//
// It spends ONE cheap turn (a `sleep`) in an EMPTY throwaway cwd, never in the
// repo -- the agent it wakes has nothing to touch there.
//
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/.bin/electron \
//     tests/pty-harness/busy-silence-probe.cjs
//
// Env: PROBE_CLI, PROBE_CWD (must already be TRUSTED, else the trust dialog
// eats the run), PROBE_SETTLE_MS, PROBE_RUN_MS, PROBE_SLEEP_S.
'use strict'
const { join } = require('node:path')
const HERE = __dirname
const REPO = join(HERE, '..', '..')
const { makeScreen } = require(join(HERE, 'mini-screen.cjs'))

let pty
try {
  pty = require(join(REPO, 'desktop', 'node_modules', 'node-pty'))
} catch (e) {
  console.error('PROBE-UNAVAILABLE node-pty could not be loaded:', e && e.message)
  process.exit(2)
}

const CLI = process.env.PROBE_CLI || 'claude'
const CWD = process.env.PROBE_CWD || REPO
const SETTLE_MS = Number(process.env.PROBE_SETTLE_MS || 20000)
const RUN_MS = Number(process.env.PROBE_RUN_MS || 120000)
const SLEEP_S = Number(process.env.PROBE_SLEEP_S || 60)
const PROMPT = process.env.PROBE_PROMPT || `Execute exactement cette commande bash et rien d'autre: sleep ${SLEEP_S}. N'utilise aucun autre outil, ne lis aucun fichier, puis reponds juste FINI.`

const childEnv = { ...process.env }
delete childEnv.ELECTRON_RUN_AS_NODE

const screen = makeScreen(120, 40)
const stamps = []
let t0 = 0
let approved = false
let exited = null

// PROBE_ARGS forwards CLI flags (space-separated) -- e.g.
// "--permission-mode default --model haiku" to reach the TOOL-PERMISSION prompt,
// which auto mode never shows. Flags only: nothing here writes operator config.
const ARGS = (process.env.PROBE_ARGS || '').split(' ').filter(Boolean)
const p = pty.spawn(CLI, ARGS, { name: 'xterm-256color', cols: 120, rows: 40, cwd: CWD, env: childEnv })
p.onData((d) => { screen.feed(d); if (t0) stamps.push(Date.now() - t0) })
p.onExit((e) => { exited = e })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function snap(label) {
  console.log('===== SNAPSHOT ' + label + ' t=' + (t0 ? Date.now() - t0 : 0) + 'ms')
  console.log(screen.text())
  console.log('===== END ' + label)
}

async function run() {
  await sleep(SETTLE_MS)
  snap('before-prompt')
  t0 = Date.now()
  if (process.env.PROBE_MODE === 'bang') {
    // `!` puts Claude Code in bash mode: the command runs LOCALLY, with no API
    // turn at all. That is the cheapest way to reach the exact state the idle
    // predicate has to survive -- a tool running for a long time and printing
    // nothing -- without paying for (or waiting on) an inference.
    p.write('!')
    await sleep(600)
    p.write(`sleep ${SLEEP_S}`)
    await sleep(400)
    p.write('\r')
  } else {
    p.write(`\x1b[200~${PROMPT}\x1b[201~\r`)
  }
  const step = 5000
  for (let elapsed = 0; elapsed < RUN_MS; elapsed += step) {
    await sleep(step)
    const txt = screen.text()
    // auto-approve a tool-permission prompt exactly once; the default option is
    // the affirmative one and the only tool asked for is `sleep`.
    if (!approved && /Do you want|Voulez-vous|allow this|Yes, and|1\. Yes/.test(txt)) {
      snap('permission-prompt')
      p.write('\r')
      approved = true
    }
    if (elapsed % 20000 === 0) snap('t' + (elapsed / 1000) + 's')
  }
  snap('final')

  // timeline: one bucket per second, count of data events
  const secs = Math.ceil(RUN_MS / 1000)
  const buckets = new Array(secs).fill(0)
  for (const s of stamps) { const i = Math.floor(s / 1000); if (i < secs) buckets[i]++ }
  const gaps = []
  for (let i = 1; i < stamps.length; i++) gaps.push(stamps[i] - stamps[i - 1])
  console.log('TOTAL_EVENTS ' + stamps.length)
  console.log('MAXGAP_MS ' + (gaps.length ? Math.max(...gaps) : RUN_MS))
  console.log('TOP_GAPS ' + JSON.stringify(gaps.slice().sort((a, b) => b - a).slice(0, 12)))
  console.log('EVENTS_PER_SECOND ' + JSON.stringify(buckets))
  console.log('SILENT_SECONDS ' + buckets.filter((b) => b === 0).length + '/' + secs)
  console.log('FINAL_EXITED ' + JSON.stringify(exited))
  try { p.kill() } catch { /* already gone */ }
  setTimeout(() => process.exit(0), 400)
}

run()
