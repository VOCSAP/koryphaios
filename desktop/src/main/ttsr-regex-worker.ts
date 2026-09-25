// Runs an operator-supplied regex against sample text OFF the main thread.
// JS regexes have no execution deadline, and one catastrophic pattern on the
// Electron main process would freeze every tile at once: the match runs in a
// throwaway worker that is terminated when the deadline passes.
//
// The worker body is an inline CommonJS string (worker_threads `eval`), so it
// needs no separate bundle entry; it only compiles the pattern and reports the
// first match of each text.

import { Worker } from 'node:worker_threads'
import { reportError } from './log'

/** Hard deadline of one isolated match, compile included. */
export const TTSR_TEST_TIMEOUT_MS = 500

export type IsolatedMatchResult =
  | { timedOut: true }
  | { timedOut: false; error: string }
  | { timedOut: false; matches: ({ index: number; text: string } | null)[] }

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
let out
try {
  const re = new RegExp(workerData.pattern, workerData.flags)
  out = {
    matches: workerData.texts.map((s) => {
      re.lastIndex = 0
      const m = re.exec(s)
      return m ? { index: m.index, text: m[0].slice(0, 200) } : null
    })
  }
} catch (e) {
  out = { error: String(e && e.message ? e.message : e) }
}
parentPort.postMessage(out)
`

/**
 * First match of `pattern` in each of `texts`, computed in a worker killed
 * after `timeoutMs`. Never rejects: a worker failure comes back as `error`.
 */
export function matchIsolated(
  pattern: string,
  flags: string,
  texts: readonly string[],
  timeoutMs: number = TTSR_TEST_TIMEOUT_MS
): Promise<IsolatedMatchResult> {
  return new Promise((resolve) => {
    let settled = false
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { pattern, flags, texts: [...texts] } })
    const settle = (r: IsolatedMatchResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // The result is already decided: a failed terminate only leaves a trace.
      worker.terminate().catch((e: unknown) => reportError('ttsr', 'rule test worker did not terminate', e))
      resolve(r)
    }
    const timer = setTimeout(() => settle({ timedOut: true }), timeoutMs)
    worker.once('message', (m: { error?: string; matches?: ({ index: number; text: string } | null)[] }) => {
      if (typeof m.error === 'string') settle({ timedOut: false, error: m.error })
      else settle({ timedOut: false, matches: m.matches ?? [] })
    })
    worker.once('error', (e: Error) => settle({ timedOut: false, error: e.message }))
    worker.once('exit', (code) => settle({ timedOut: false, error: `worker exited early (code ${code})` }))
  })
}
