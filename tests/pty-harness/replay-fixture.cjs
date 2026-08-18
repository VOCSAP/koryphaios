// OFFLINE REPLAY of a pty fixture -- no CLI, no node-pty, no Electron.
// spec_fec16658.
//
// This is the proof that a fixture under fixtures/ is worth anything: it feeds
// the recorded bytes through mini-screen.cjs and prints the reconstructed SCREEN
// at each `########## ... ##########` marker. If a state cannot be read back
// here, the fixture cannot pin a detector either.
//
//   node tests/pty-harness/replay-fixture.cjs fixtures/slash-menu-with-esc.json
//   bun  tests/pty-harness/replay-fixture.cjs <same>            (pure JS, both work)
//
// CONTRACT FOR CONSUMERS, and it bites: the marker chunks are SYNTHETIC. They
// were never emitted by the CLI. Feeding them to a screen model paints the
// literal hashes into the grid and corrupts the very screen you are trying to
// assert on. Filter them (`isMarker` below) before feeding, and use them only
// to know WHERE you are in the stream.
//
// The grid is fixed at 120x40 because that is the size the captures were
// recorded at; replaying them at another size does not fail, it silently
// reflows into a screen that never existed.
'use strict'
const { readFileSync } = require('node:fs')
const { resolve, isAbsolute, join } = require('node:path')
const { makeScreen } = require(join(__dirname, 'mini-screen.cjs'))

const arg = process.argv[2]
if (!arg) {
  console.error('usage: replay-fixture.cjs <fixture.json>')
  process.exit(2)
}
const path = isAbsolute(arg) ? arg : resolve(__dirname, arg)
const chunks = JSON.parse(readFileSync(path, 'utf-8'))

/** A synthetic phase marker inserted by the capture, not CLI output. */
const isMarker = (c) => c.data.startsWith('\n########## ')
const markerText = (c) => c.data.trim().replace(/^#+\s*|\s*#+$/g, '')

const screen = makeScreen(120, 40)
let realBytes = 0
let realChunks = 0

console.log('FIXTURE ' + path)
console.log('CHUNKS ' + chunks.length)
for (const c of chunks) {
  if (isMarker(c)) {
    console.log('\n===== ' + markerText(c) + '  (t=' + c.t + 'ms, real bytes so far=' + realBytes + ')')
    if (/^SNAPSHOT /.test(markerText(c))) console.log(screen.text())
    continue
  }
  realChunks++
  realBytes += c.data.length
  screen.feed(c.data)
}
console.log('\n===== FINAL SCREEN')
console.log(screen.text())
console.log('\nREAL_CHUNKS ' + realChunks + ' REAL_BYTES ' + realBytes)
