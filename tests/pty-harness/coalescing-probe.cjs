// ConPTY write-coalescing probe (card 6168b7f4). Prints a verdict and exits
// 0 only if BOTH halves of the measurement reproduce.
//
// What it measures, and why the fix in session-service.ts depends on it:
//   A. two back-to-back pty.write() calls arrive as ONE read on the child
//   B. the same two writes 120 ms apart arrive as TWO reads (the second: 1 byte)
// Combined with Claude Code's under-64-characters rule for promoting a control
// byte to its own token, (A) is why "write the text, then write '\r'" stopped
// submitting anything past ~64 bytes, and (B) is why a delay LOOKS like a fix
// while being a race.
//
// Run under Electron-as-Node so the Electron-ABI node-pty loads:
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/.bin/electron tests/pty-harness/coalescing-probe.cjs
// desktop-pty-coalescing.test.ts drives it that way, and skips VISIBLY when the
// platform or the build is not the one this behaviour belongs to.
const { join } = require('node:path')
const HERE = __dirname
const REPO = join(HERE, '..', '..')

let pty
try {
  pty = require(join(REPO, 'desktop', 'node_modules', 'node-pty'))
} catch (e) {
  console.error('PROBE-UNAVAILABLE node-pty could not be loaded:', e && e.message)
  process.exit(2)
}

// The child must be a runtime that works as a plain console process INSIDE the
// pty. Electron-as-Node is NOT one: spawned that way it produces no output at
// all in a ConPTY (measured -- the probe then reports PROBE-MEASURED-NOTHING
// rather than a false green). The caller passes its own runtime through
// PROBE_NODE (desktop-pty-coalescing.test.ts passes bun's own binary); `node`
// is the fallback for a hand run.
const NODE = process.env.PROBE_NODE || 'node'
const CHILD = join(HERE, 'echo-child.cjs')
const TEXT = 'x'.repeat(239)

const childEnv = { ...process.env }
delete childEnv.ELECTRON_RUN_AS_NODE

const p = pty.spawn(NODE, [CHILD], {
  name: 'xterm-color',
  cols: 120,
  rows: 30,
  cwd: HERE,
  env: childEnv
})

let out = ''
p.onData((d) => { out += d })

setTimeout(() => { p.write(TEXT); p.write('\r') }, 1200)              // A
setTimeout(() => { p.write('B' + TEXT); setTimeout(() => p.write('\r'), 120) }, 3000) // B

setTimeout(() => {
  p.kill()
  const lens = [...out.matchAll(/CHUNK len=(\d+)/g)].map((m) => Number(m[1]))
  const coalesced = lens[0] === 240
  const separated = lens[1] === 240 && lens[2] === 1
  console.log('CHUNK_LENGTHS ' + JSON.stringify(lens))
  console.log('COALESCED ' + coalesced)
  console.log('SEPARATED ' + separated)
  if (lens.length === 0) {
    console.error('PROBE-MEASURED-NOTHING the child produced no CHUNK line at all')
    process.exit(3)
  }
  process.exit(coalesced && separated ? 0 : 1)
}, 5200)
