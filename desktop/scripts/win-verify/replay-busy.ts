// M2 replay: feed a captured PTY fixture through the real busy/quota/attention
// detectors and report, per chunk, whether each one currently reads the tile
// as busy -- the same detectors Deck main wires in session-service.ts, run
// here standalone so a fixture captured on Windows can be checked without the
// full Electron app.
//
// Usage (from the repo root, cross-platform):
//   bun desktop/scripts/win-verify/replay-busy.ts <fixture.json> [--out <dir>]
//
// Exit code is 0 regardless of the verdict -- this is a report tool, not a
// pass/fail gate; read the printed summary (or the --out JSON) to judge M2.

import { readFileSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createBusyCue } from '../../src/main/detect/busy'
import { QuotaDetector } from '../../src/main/quota'
import { AttentionDetector } from '../../src/main/attention'
import { isFixture, type Fixture } from './fixture-types'
import { parseOutDir } from './out-dir'

const [, , fixturePath] = process.argv
if (!fixturePath) {
  console.error('usage: bun replay-busy.ts <fixture.json> [--out <dir>]')
  process.exit(2)
}

const raw = JSON.parse(readFileSync(fixturePath, 'utf-8'))
if (!isFixture(raw)) {
  console.error(`${fixturePath} does not match the [{t, data}] fixture shape`)
  process.exit(2)
}
const fixture: Fixture = raw

const ID = 'replay'
const busy = createBusyCue({ title: true })
const quota = new QuotaDetector()
const attention = new AttentionDetector()

let quotaLimited = false
let attentionWaiting = false
quota.on('limit', () => {
  quotaLimited = true
})
quota.on('clear', () => {
  quotaLimited = false
})
attention.on('attention', (e: { waiting: boolean }) => {
  attentionWaiting = e.waiting
})

interface Row {
  i: number
  t: number
  len: number
  busy: boolean
  quotaLimited: boolean
  attentionWaiting: boolean
}

const rows: Row[] = []
let busyChunks = 0
for (let i = 0; i < fixture.length; i++) {
  const chunk = fixture[i] as { t: number; data: string }
  const isBusy = busy.feed(chunk.data)
  quota.feed(ID, chunk.data)
  attention.feed(ID, chunk.data)
  if (isBusy) busyChunks++
  rows.push({ i, t: chunk.t, len: chunk.data.length, busy: isBusy, quotaLimited, attentionWaiting })
}

const summary = {
  fixture: basename(fixturePath),
  chunks: fixture.length,
  busyChunks,
  everBusy: busyChunks > 0,
  endedQuotaLimited: quotaLimited,
  endedAttentionWaiting: attentionWaiting
}

console.log(`fixture: ${summary.fixture} (${summary.chunks} chunks)`)
console.log(`  busy cue fired on ${busyChunks}/${summary.chunks} chunks (everBusy=${summary.everBusy})`)
console.log(`  quota detector at end: limited=${summary.endedQuotaLimited}`)
console.log(`  attention detector at end: waiting=${summary.endedAttentionWaiting}`)
console.log('  -- last 5 chunks --')
for (const r of rows.slice(-5)) {
  console.log(
    `    #${r.i} t=${r.t}ms len=${r.len} busy=${r.busy} quotaLimited=${r.quotaLimited} attentionWaiting=${r.attentionWaiting}`
  )
}

const outDir = parseOutDir(process.argv)
const outFile = join(outDir, `replay-busy.${basename(fixturePath)}`)
writeFileSync(outFile, JSON.stringify({ summary, rows }, null, 2))
console.log(`\nfull per-chunk report: ${outFile}`)
