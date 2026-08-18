// WHAT DOES THE PRE-INJECTION ESCAPE ACTUALLY DO? (Vague 10 lot A1, card 5dbf3255)
//
// `SessionService.injectCommand` writes a bare ESC, waits DIRECTIVE_SETTLE_MS
// (120 ms), then writes its bracketed paste. The card records the ESC's PURPOSE
// as "close an eventual menu" and its effect as NOT MEASURED. This probe drives
// the real installed CLI through the tile states an injection can land in, and
// snapshots the SCREEN (via mini-screen.cjs) before and after each keystroke.
//
// It never spends an API turn: the only payload it ever submits is `/status`,
// which Claude Code renders locally.
//
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/.bin/electron \
//     tests/pty-harness/esc-role-probe.cjs
//
// Env: PROBE_SCENARIO (see SCENARIOS), PROBE_CLI, PROBE_CWD, PROBE_SETTLE_MS.
//
// PROBE_FIXTURE=<abs path> also RECORDS the raw byte stream as a
// tests/pty-harness/fixtures/*.json journal -- the same flat
// [{t, data}] shape as dialog-open-{no,with}-esc.json, with synthetic
// `########## ... ##########` chunks marking each phase. That is what lets a
// deterministic test replay the state OFFLINE, with no live CLI: the fixture
// carries the whole paint from spawn, so a screen model can reconstruct exactly
// what was displayed at each marker.
'use strict'
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
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

const ESC = '\x1b'
const paste = (s) => `\x1b[200~${s}\x1b[201~\r`
const PAYLOAD = '/status'
const DRAFT = 'brouillon operateur en cours de frappe'

// Each step: [waitMsBefore, bytesToWriteOrNull, snapshotLabelOrNull]
const SCENARIOS = {
  'nominal-esc': [
    [0, null, 'prompt'],
    [0, ESC, null],
    [1500, null, 'after-esc']
  ],
  'nominal-esc-x2': [
    [0, null, 'prompt'],
    [0, ESC, null],
    [1200, ESC, null],
    [1500, null, 'after-esc-x2']
  ],
  'draft-esc': [
    [0, DRAFT, null],
    [1200, null, 'draft-typed'],
    [0, ESC, null],
    [1500, null, 'after-esc']
  ],
  'draft-noesc-paste': [
    [0, DRAFT, null],
    [1200, null, 'draft-typed'],
    [0, paste(PAYLOAD), null],
    [4000, null, 'after-paste']
  ],
  'slash-esc': [
    [0, '/', null],
    [1800, null, 'menu-open'],
    [0, ESC, null],
    [1500, null, 'after-esc']
  ],
  'slash-noesc-paste': [
    [0, '/', null],
    [1800, null, 'menu-open'],
    [0, paste(PAYLOAD), null],
    [4000, null, 'after-paste']
  ],
  'nominal-noesc-paste': [
    [0, null, 'prompt'],
    [0, paste(PAYLOAD), null],
    [4000, null, 'after-paste']
  ],
  'nominal-esc-paste': [
    [0, null, 'prompt'],
    [0, ESC, null],
    [120, paste(PAYLOAD), null],
    [4000, null, 'after-paste']
  ]
}

const name = process.env.PROBE_SCENARIO || 'nominal-esc'
const steps = SCENARIOS[name]
if (!steps) {
  console.error('PROBE-UNAVAILABLE unknown scenario ' + name + ' (have: ' + Object.keys(SCENARIOS).join(', ') + ')')
  process.exit(2)
}

const CLI = process.env.PROBE_CLI || 'claude'
const CWD = process.env.PROBE_CWD || REPO
const SETTLE_MS = Number(process.env.PROBE_SETTLE_MS || 22000)

const childEnv = { ...process.env }
delete childEnv.ELECTRON_RUN_AS_NODE

const screen = makeScreen(120, 40)
let bytesSinceMark = 0
let eventsSinceMark = 0
let exited = null

const FIXTURE = process.env.PROBE_FIXTURE || ''
const journal = []
const t0 = Date.now()
const mark = (text) => { if (FIXTURE) journal.push({ t: Date.now() - t0, data: `\n########## ${text} ##########\n` }) }

const p = pty.spawn(CLI, [], { name: 'xterm-256color', cols: 120, rows: 40, cwd: CWD, env: childEnv })
p.onData((d) => {
  if (FIXTURE) journal.push({ t: Date.now() - t0, data: d })
  screen.feed(d); bytesSinceMark += d.length; eventsSinceMark++
})
p.onExit((e) => { exited = e; mark('pty exited ' + JSON.stringify(e)) })

function snap(label) {
  mark('SNAPSHOT ' + label)
  console.log('===== SNAPSHOT ' + label + ' (bytes_since_prev=' + bytesSinceMark + ' events=' + eventsSinceMark + ' exited=' + JSON.stringify(exited) + ')')
  console.log(screen.text())
  console.log('===== END ' + label)
  bytesSinceMark = 0
  eventsSinceMark = 0
}

async function run() {
  await new Promise((r) => setTimeout(r, SETTLE_MS))
  console.log('SCENARIO ' + name)
  for (const [wait, write, label] of steps) {
    if (wait) await new Promise((r) => setTimeout(r, wait))
    if (write !== null) {
      // Name the bytes in the journal, so a replay can split before/after
      // without guessing which chunk carried the keystroke.
      mark('WROTE ' + JSON.stringify(write).slice(0, 60))
      p.write(write)
    }
    if (label) snap(label)
  }
  console.log('FINAL_EXITED ' + JSON.stringify(exited))
  if (FIXTURE) {
    mark('end of capture')
    writeFileSync(FIXTURE, JSON.stringify(journal))
    const bytes = journal.reduce((a, c) => a + c.data.length, 0)
    console.log('FIXTURE_WRITTEN ' + FIXTURE + ' chunks=' + journal.length + ' bytes=' + bytes)
  }
  try { p.kill() } catch { /* already gone */ }
  setTimeout(() => process.exit(0), 400)
}

run()
