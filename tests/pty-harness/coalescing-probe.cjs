// ConPTY write-coalescing probe (card 6168b7f4, flaky-repair follow-up).
// Prints a verdict and exits 0 only if BOTH halves of the measurement
// reproduce ON THIS TRIAL.
//
// What it measures, and why the fix in session-service.ts depends on it:
//   A. two back-to-back pty.write() calls arrive as ONE read on the child
//   B. the same two writes 120 ms apart arrive as TWO reads (the second: 1 byte)
// Combined with Claude Code's under-64-characters rule for promoting a control
// byte to its own token, (A) is why "write the text, then write '\r'" stopped
// submitting anything past ~64 bytes, and (B) is why a delay LOOKS like a fix
// while being a race.
//
// MEASURED (flaky-repair, this file's own header before the repair, and
// independently re-measured): phase A is a genuine, non-deterministic race --
// on this Windows build it coalesces ~87% of single trials and produces two
// separate reads ([239,1] instead of [240]) the other ~13%. Phase B is NOT
// racy: every trial measured separates cleanly. A caller that wants a claim
// robust to a single unlucky trial must retry phase A across several
// independent probe invocations while still treating any phase-B failure as
// a hard, non-retryable signal -- desktop-pty-coalescing.test.ts does exactly
// that. This file stays a SINGLE-TRIAL measurement on purpose: the retry
// policy belongs to the caller, not baked in here.
//
// Chunk attribution is by WALL-CLOCK ARRIVAL TIME relative to the phase-B
// write, not by array position. The previous position-based version
// (lens[0]/lens[1]/lens[2] read off one flat array) misattributed phase B as
// failed whenever phase A produced an extra chunk, because every index past
// the miss shifted by one -- a false accusation against the deterministic
// half of the measurement, caught 2026-08-19 (flaky-repair). classify() below
// takes the two phases as SEPARATE buffers so a phase-A miss can never shift
// phase B's reading.
//
// Run under Electron-as-Node so the Electron-ABI node-pty loads:
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/.bin/electron tests/pty-harness/coalescing-probe.cjs
// desktop-pty-coalescing.test.ts drives it that way, and skips VISIBLY when the
// platform or the build is not the one this behaviour belongs to.
const { join } = require('node:path')
const HERE = __dirname
const REPO = join(HERE, '..', '..')

// Pure, side-effect-free: parses the two phase buffers (each the concatenation
// of every pty onData chunk received while that phase was current) into chunk
// lengths and the two verdict flags. No pty, no timers, no I/O -- requirable
// and unit-testable on any platform without node-pty or Electron.
function classify(outA, outB) {
  const lensA = [...outA.matchAll(/CHUNK len=(\d+)/g)].map((m) => Number(m[1]))
  const lensB = [...outB.matchAll(/CHUNK len=(\d+)/g)].map((m) => Number(m[1]))
  return {
    lensA,
    lensB,
    coalesced: lensA.length === 1 && lensA[0] === 240,
    separated: lensB.length === 2 && lensB[0] === 240 && lensB[1] === 1
  }
}

module.exports = { classify }

// The live measurement is a side effect (spawns a real pty). Guarded so this
// file can be required from a unit test (for classify()) without spawning
// anything -- required, not just convention: an unguarded require() here
// would run the full 5.2s ConPTY measurement, and its node-pty load failure
// path below calls process.exit(2), which would kill the whole test runner
// process, not just this script.
if (require.main === module) {
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

  // Two SEPARATE buffers, chosen by wall-clock time against `boundaryAt`
  // (set the instant the phase-B write is issued, below) -- never by counting
  // or indexing chunks. Before boundaryAt is set (still 0) everything belongs
  // to phase A, since only phase A has written anything yet.
  let outA = ''
  let outB = ''
  let boundaryAt = 0
  p.onData((d) => {
    if (boundaryAt === 0 || Date.now() < boundaryAt) outA += d
    else outB += d
  })

  setTimeout(() => { p.write(TEXT); p.write('\r') }, 1200)              // A
  setTimeout(() => {
    boundaryAt = Date.now()
    p.write('B' + TEXT)
    setTimeout(() => p.write('\r'), 120)
  }, 3000) // B

  setTimeout(() => {
    p.kill()
    const { lensA, lensB, coalesced, separated } = classify(outA, outB)
    console.log('CHUNK_LENGTHS ' + JSON.stringify([...lensA, ...lensB]))
    console.log('PHASE_A_LENGTHS ' + JSON.stringify(lensA))
    console.log('PHASE_B_LENGTHS ' + JSON.stringify(lensB))
    console.log('COALESCED ' + coalesced)
    console.log('SEPARATED ' + separated)
    if (lensA.length === 0 && lensB.length === 0) {
      console.error('PROBE-MEASURED-NOTHING the child produced no CHUNK line at all')
      process.exit(3)
    }
    process.exit(coalesced && separated ? 0 : 1)
  }, 5200)
}
