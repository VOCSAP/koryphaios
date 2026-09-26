// Regex runs isolated in a worker_threads Worker, killed at a deadline: an
// arbitrary pattern has no execution bound of its own, so it never runs on a
// thread that matters (Electron main, the CLI's own) before it has been
// timed here.
//
// probeRulesSpeed is the adversarial timing gate a global or repo rules file
// passes before it can be compiled into a tile's rules, approved, or reported
// valid by `kory-rules check`. parseRulesFile stays synchronous (the hook
// calls it on every tool call); this is the additional, asynchronous gate.
//
// Node builtins only, no electron: imported by Deck main and the rules CLI.
// The worker body is an inline CommonJS string (worker_threads `eval`), so it
// needs no separate bundle entry.

import { Worker } from 'node:worker_threads'
import type { TtsrRule } from './ttsr-types'

/** Hard deadline of one isolated match, compile included. */
export const TTSR_TEST_TIMEOUT_MS = 500
/** Length of each adversarial probe input. */
export const PROBE_INPUT_CHARS = 4096
/**
 * Budget of one probe input. A linear or quadratic pattern takes well under
 * 20 ms on 4 Ki characters; a cubic one takes seconds, an exponential one
 * never ends (or, under JavaScriptCore, gives up after ~0.6 s).
 */
export const PROBE_SLOW_MS = 100
/** Hard deadline of one rule's whole probe, worker start included. */
export const PROBE_RULE_DEADLINE_MS = 2000

export type IsolatedMatchResult =
  | { timedOut: true }
  | { timedOut: false; error: string }
  | { timedOut: false; matches: ({ index: number; text: string } | null)[] }

/** Where a worker that failed to terminate is reported. */
export type WorkerErrorSink = (message: string, error: unknown) => void

const MATCH_WORKER = `
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

function terminate(worker: Worker, onError: WorkerErrorSink): void {
  worker.terminate().catch((e: unknown) => onError('regex worker did not terminate', e))
}

/**
 * First match of `pattern` in each of `texts`, computed in a worker killed
 * after `timeoutMs`. Never rejects: a worker failure comes back as `error`.
 */
export function matchIsolated(
  pattern: string,
  flags: string,
  texts: readonly string[],
  timeoutMs: number,
  onError: WorkerErrorSink
): Promise<IsolatedMatchResult> {
  return new Promise((resolve) => {
    let settled = false
    const worker = new Worker(MATCH_WORKER, { eval: true, workerData: { pattern, flags, texts: [...texts] } })
    const settle = (r: IsolatedMatchResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      terminate(worker, onError)
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

const CLASS_ESCAPES: Record<string, string> = { w: 'a', W: '-', d: '0', D: 'a', s: ' ', S: 'a', n: '\n', t: '\t', r: '\r' }

/**
 * The seeds the probe repeats into adversarial inputs: every character the
 * pattern can match literally or through a class (\w gives 'a', \s ' ', ...),
 * its literal runs ("git", "ab"), pairs of its first literal characters, and
 * a few defaults. A backtracking blow-up needs a long run of characters the
 * pattern keeps accepting; these are those characters.
 */
export function probeSeeds(pattern: string): string[] {
  const chars: string[] = []
  const runs: string[] = []
  let run = ''
  const add = (c: string): void => {
    if (!chars.includes(c)) chars.push(c)
  }
  const endRun = (): void => {
    if (run.length >= 2 && !runs.includes(run)) runs.push(run)
    run = ''
  }
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '\\') {
      const n = pattern[++i] ?? ''
      const hex = n === 'x' ? 2 : n === 'u' ? 4 : 0
      if (hex > 0 && /^[0-9a-fA-F]+$/.test(pattern.slice(i + 1, i + 1 + hex))) {
        const ch = String.fromCharCode(parseInt(pattern.slice(i + 1, i + 1 + hex), 16))
        add(ch)
        run += ch
        i += hex
      } else if (n === 'p' || n === 'P') {
        add('a')
        endRun()
        if (pattern[i + 1] === '{') i = Math.max(i, pattern.indexOf('}', i))
      } else if (CLASS_ESCAPES[n] !== undefined) {
        add(CLASS_ESCAPES[n]!)
        endRun()
      } else if (/[bBk0-9]/.test(n)) endRun()
      else {
        add(n)
        run += n
      }
      continue
    }
    if (c === '{') {
      const q = /^\{\d+(?:,\d*)?\}/.exec(pattern.slice(i))
      if (q) {
        i += q[0].length - 1
        endRun()
        continue
      }
    }
    if (c === '(' && pattern[i + 1] === '?') {
      const g = /^\(\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/.exec(pattern.slice(i))
      if (g) i += g[0].length - 1
      endRun()
      continue
    }
    if ('()[]{}|*+?^$.'.includes(c)) {
      if (c === '.') add('a')
      endRun()
      continue
    }
    add(c)
    run += c
  }
  endRun()
  const literal = chars.slice(0, 4)
  for (const d of ['a', ' ', 'x', '0', '\n']) add(d)
  const pairs: string[] = []
  for (let i = 0; i < literal.length; i++) for (let j = i + 1; j < literal.length; j++) pairs.push(literal[i]! + literal[j]!)
  const seeds: string[] = []
  for (const s of [...chars.slice(0, 12), ...runs.slice(0, 6), ...pairs]) if (!seeds.includes(s)) seeds.push(s)
  return seeds
}

/** Each seed repeated to PROBE_INPUT_CHARS, then a character that ends any match attempt late. */
export function probeInputs(pattern: string, length: number = PROBE_INPUT_CHARS): string[] {
  return probeSeeds(pattern).map((s) => s.repeat(Math.ceil(length / s.length)).slice(0, length) + '\u0001')
}

const PROBE_WORKER = `
const { parentPort, workerData } = require('node:worker_threads')
for (const job of workerData.jobs) {
  parentPort.postMessage({ type: 'start', index: job.index })
  let slow = null
  let error = null
  try {
    const re = new RegExp(job.pattern, job.flags)
    for (const s of job.inputs) {
      const t0 = performance.now()
      re.test(s)
      const ms = performance.now() - t0
      if (ms > workerData.slowMs) {
        slow = { ms: Math.round(ms), seed: JSON.stringify(s.slice(0, 8)) }
        break
      }
    }
  } catch (e) {
    error = String(e && e.message ? e.message : e)
  }
  parentPort.postMessage({ type: 'done', index: job.index, slow, error })
}
parentPort.postMessage({ type: 'end' })
`

interface ProbeJob {
  index: number
  pattern: string
  flags: string
  inputs: string[]
}

type ProbeMessage =
  | { type: 'start'; index: number }
  | { type: 'done'; index: number; slow: { ms: number; seed: string } | null; error: string | null }
  | { type: 'end' }

export interface ProbeOptions {
  slowMs?: number
  deadlineMs?: number
  inputChars?: number
  onError?: WorkerErrorSink
}

/**
 * Times every rule's pattern against its adversarial inputs, in one worker
 * restarted after any rule that hits the hard deadline. Returns errors in the
 * parseRulesFile format (`rules[i] "id": pattern: ...`), empty when every
 * pattern is fast. A worker that cannot run at all rejects the rules too: an
 * unprobed pattern is not let through.
 */
export async function probeRulesSpeed(rules: readonly TtsrRule[], opts: ProbeOptions = {}): Promise<string[]> {
  const slowMs = opts.slowMs ?? PROBE_SLOW_MS
  const deadlineMs = opts.deadlineMs ?? PROBE_RULE_DEADLINE_MS
  const onError = opts.onError ?? (() => undefined)
  const errors: Array<[number, string]> = []
  const done = new Set<number>()
  const label = (i: number): string => `rules[${i}] "${rules[i]!.id}": pattern`
  const jobs: ProbeJob[] = rules.map((r, index) => ({
    index,
    pattern: r.pattern,
    flags: r.flags ?? '',
    inputs: probeInputs(r.pattern, opts.inputChars)
  }))
  let pending = jobs
  while (pending.length > 0) {
    const batch = pending
    const outcome = await new Promise<{ next: number } | { failed: string }>((resolve) => {
      let settled = false
      let current = -1
      const worker = new Worker(PROBE_WORKER, { eval: true, workerData: { jobs: batch, slowMs } })
      let timer = setTimeout(() => settle({ failed: 'the probe worker did not start' }), deadlineMs * 2)
      const settle = (r: { next: number } | { failed: string }): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        terminate(worker, onError)
        resolve(r)
      }
      worker.on('message', (m: ProbeMessage) => {
        if (m.type === 'start') {
          current = m.index
          clearTimeout(timer)
          timer = setTimeout(() => {
            done.add(current)
            errors.push([current, `${label(current)}: too slow: one input did not finish within ${deadlineMs} ms (catastrophic backtracking)`])
            settle({ next: current + 1 })
          }, deadlineMs)
        } else if (m.type === 'done') {
          done.add(m.index)
          if (m.error !== null) errors.push([m.index, `${label(m.index)}: could not be timed: ${m.error}`])
          else if (m.slow !== null)
            errors.push([
              m.index,
              `${label(m.index)}: too slow: ${m.slow.ms} ms on a long run of ${m.slow.seed} (budget ${slowMs} ms); ` +
                'nested or adjacent repetitions backtrack, bound them or anchor the pattern'
            ])
        } else settle({ next: Number.POSITIVE_INFINITY })
      })
      worker.once('error', (e: Error) => settle({ failed: e.message }))
      worker.once('exit', (code) => settle({ failed: `the probe worker exited early (code ${code})` }))
    })
    if ('failed' in outcome) {
      for (const job of batch) {
        if (!done.has(job.index)) errors.push([job.index, `${label(job.index)}: could not be timed: ${outcome.failed}`])
      }
      break
    }
    pending = batch.filter((j) => j.index >= outcome.next)
  }
  return errors.sort((a, b) => a[0] - b[0]).map(([, e]) => e)
}
