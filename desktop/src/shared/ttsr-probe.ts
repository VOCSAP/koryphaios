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

import { spawn } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { TTSR_REGEX_BUDGET_MS, fieldCap } from './ttsr-rules'
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
 * Characters of each Unicode property a pattern names (`\\p{Lu}`,
 * `\\p{Script=Greek}` falls to the default): a run the property accepts is
 * what makes `\\p{Lu}{0,99}\\p{Lu}{0,99}` backtrack.
 */
const PROPERTY_SEEDS: Record<string, string[]> = {
  Lu: ['A'],
  Uppercase_Letter: ['A'],
  Lt: ['\u01c5'],
  Ll: ['a'],
  Lowercase_Letter: ['a'],
  L: ['a', 'A', '\u00e9'],
  Letter: ['a', 'A', '\u00e9'],
  Alphabetic: ['a', 'A', '\u00e9'],
  N: ['0'],
  Nd: ['0'],
  Number: ['0'],
  Decimal_Number: ['0'],
  P: ['.'],
  Punctuation: ['.'],
  S: ['+'],
  Symbol: ['+'],
  Z: [' '],
  Zs: [' '],
  White_Space: [' '],
  Extended_Pictographic: ['\u{1f600}'],
  Emoji: ['\u{1f600}'],
  Emoji_Presentation: ['\u{1f600}']
}
/** An unknown or negated property: a spread of scripts and classes. */
const PROPERTY_FALLBACK = ['a', 'A', '0', '.', ' ', '\u00e9', '\u03b1', '\u4e2d', '\u{1f600}']
/** Non-ASCII seeds added for a `u`-flag pattern: `.` and negated classes then match whole code points. */
const UNICODE_SEEDS = ['\u00e9', '\u{1f600}']

/**
 * The seeds the probe repeats into adversarial inputs: every character the
 * pattern can match literally or through a class (\w gives 'a', \s ' ', ...),
 * its literal runs ("git", "ab"), pairs of its first literal characters, and
 * a few defaults. A backtracking blow-up needs a long run of characters the
 * pattern keeps accepting; these are those characters.
 */
export function probeSeeds(pattern: string, flags = ''): string[] {
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
        const close = pattern[i + 1] === '{' ? pattern.indexOf('}', i) : -1
        const name = close > i ? pattern.slice(i + 2, close) : ''
        const known = n === 'p' ? PROPERTY_SEEDS[name.replace(/^General_Category=|^gc=/, '')] : undefined
        for (const c of known ?? PROPERTY_FALLBACK) add(c)
        endRun()
        if (close > i) i = close
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
  for (const d of ['a', 'A', ' ', 'x', '0', '\n']) add(d)
  if (flags.includes('u') || flags.includes('v')) for (const d of UNICODE_SEEDS) add(d)
  const pairs: string[] = []
  for (let i = 0; i < literal.length; i++) for (let j = i + 1; j < literal.length; j++) pairs.push(literal[i]! + literal[j]!)
  const seeds: string[] = []
  for (const s of [...chars.slice(0, 20), ...runs.slice(0, 6), ...pairs]) if (!seeds.includes(s)) seeds.push(s)
  return seeds
}

/**
 * Each seed repeated to `length` UTF-16 units (whole seeds, so no surrogate
 * pair is cut), then a character that ends any match attempt late.
 */
export function probeInputs(pattern: string, length: number = PROBE_INPUT_CHARS, flags = ''): string[] {
  return probeSeeds(pattern, flags).map((s) => s.repeat(Math.max(1, Math.floor(length / s.length))) + '\u0001')
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
  /** Time every rule again at its real field size under bun, the hook's runtime. Default true. */
  realSize?: boolean
  /** Command that starts bun; default 'bun', resolved on PATH like the hook's own command. */
  bunCommand?: string
  /** Told once when bun cannot start and the real-size stage runs under V8 instead. */
  onFallback?: (message: string) => void
}

type ProbeErrors = Array<[number, string]>

/**
 * Times every rule's pattern against its adversarial inputs, in one worker
 * restarted after any rule that hits the hard deadline, then times the rules
 * that passed again at their real field size under bun: V8 runs these patterns
 * 10 to 17 times faster than JavaScriptCore, and a quadratic pattern fast on
 * 4 Ki can take seconds on 256 Ki. Returns errors in the parseRulesFile format
 * (`rules[i] "id": pattern: ...`), empty when every pattern is fast. A runtime
 * that cannot run at all rejects the rules too: an unprobed pattern is not let
 * through.
 */
export async function probeRulesSpeed(rules: readonly TtsrRule[], opts: ProbeOptions = {}): Promise<string[]> {
  const deadlineMs = opts.deadlineMs ?? PROBE_RULE_DEADLINE_MS
  const onError = opts.onError ?? (() => undefined)
  const label = (i: number): string => `rules[${i}] "${rules[i]!.id}": pattern`
  const jobs: ProbeJob[] = rules.map((r, index) => ({
    index,
    pattern: r.pattern,
    flags: r.flags ?? '',
    inputs: probeInputs(r.pattern, opts.inputChars, r.flags ?? '')
  }))
  const errors = await probeInWorker(jobs, opts.slowMs ?? PROBE_SLOW_MS, deadlineMs, onError, label)
  if (opts.realSize !== false) {
    const rejected = new Set(errors.map(([i]) => i))
    const passed = rules.map((r, index) => ({ r, index })).filter(({ index }) => !rejected.has(index))
    errors.push(...(await probeRealSize(passed, deadlineMs, onError, label, opts)))
  }
  return errors.sort((a, b) => a[0] - b[0]).map(([, e]) => e)
}

async function probeInWorker(
  jobs: ProbeJob[],
  slowMs: number,
  deadlineMs: number,
  onError: WorkerErrorSink,
  label: (i: number) => string
): Promise<ProbeErrors> {
  const errors: ProbeErrors = []
  const done = new Set<number>()
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
  return errors
}

// Inputs are rebuilt here from seeds and a length: a 256 Ki input per seed
// and per rule would be hundreds of megabytes through a pipe. Writes are
// synchronous so a 'start' line is out before a regex that never returns.
const BUN_PROBE_SCRIPT = `
const { writeSync } = require('node:fs')
const say = (m) => writeSync(1, JSON.stringify(m) + '\\n')
let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => { raw += c })
process.stdin.on('end', () => {
  const { jobs, budgetMs } = JSON.parse(raw)
  for (const job of jobs) {
    say({ type: 'start', index: job.index })
    let slow = null
    let error = null
    try {
      const re = new RegExp(job.pattern, job.flags)
      for (const seed of job.seeds) {
        const s = seed.repeat(Math.max(1, Math.floor(job.length / seed.length))) + '\\u0001'
        const t0 = performance.now()
        re.test(s)
        const ms = performance.now() - t0
        if (ms > budgetMs) {
          slow = { ms: Math.round(ms), seed: JSON.stringify(seed.slice(0, 8)) }
          break
        }
      }
    } catch (e) {
      error = String(e && e.message ? e.message : e)
    }
    say({ type: 'done', index: job.index, slow, error })
  }
  say({ type: 'end' })
})
`

interface BunJob {
  index: number
  pattern: string
  flags: string
  seeds: string[]
  length: number
}

/** The real-size stage: under bun when it starts, else under V8 with the same inputs and budget. */
async function probeRealSize(
  passed: ReadonlyArray<{ r: TtsrRule; index: number }>,
  deadlineMs: number,
  onError: WorkerErrorSink,
  label: (i: number) => string,
  opts: ProbeOptions
): Promise<ProbeErrors> {
  if (passed.length === 0) return []
  const jobs: BunJob[] = passed.map(({ r, index }) => ({
    index,
    pattern: r.pattern,
    flags: r.flags ?? '',
    seeds: probeSeeds(r.pattern, r.flags ?? ''),
    length: fieldCap(r.field)
  }))
  const bun = await probeUnderBun(jobs, opts.bunCommand ?? 'bun', deadlineMs, label)
  if (!('unavailable' in bun)) return bun.errors
  opts.onFallback?.(
    `bun could not be started (${bun.unavailable}): the real-size timing check ran under V8, which runs patterns 10 to 17 times faster than the hook's bun`
  )
  const v8Jobs: ProbeJob[] = passed.map(({ r, index }) => ({
    index,
    pattern: r.pattern,
    flags: r.flags ?? '',
    inputs: probeInputs(r.pattern, fieldCap(r.field), r.flags ?? '')
  }))
  return probeInWorker(v8Jobs, TTSR_REGEX_BUDGET_MS, deadlineMs, onError, label)
}

type BunOutcome = { next: number } | { failed: string } | { unavailable: string }

async function probeUnderBun(
  jobs: BunJob[],
  command: string,
  deadlineMs: number,
  label: (i: number) => string
): Promise<{ errors: ProbeErrors } | { unavailable: string }> {
  const errors: ProbeErrors = []
  const done = new Set<number>()
  const lengthOf = (i: number): number => jobs.find((j) => j.index === i)?.length ?? 0
  let pending = jobs
  let started = false
  while (pending.length > 0) {
    const batch = pending
    const outcome = await new Promise<BunOutcome>((resolve) => {
      let settled = false
      let current = -1
      let buffer = ''
      const child = spawn(command, ['-e', BUN_PROBE_SCRIPT], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
      let timer = setTimeout(() => settle({ failed: 'the bun probe did not start' }), deadlineMs * 2)
      const settle = (r: BunOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.kill()
        resolve(r)
      }
      child.once('error', (e: NodeJS.ErrnoException) =>
        settle(!started && e.code === 'ENOENT' ? { unavailable: e.message } : { failed: e.message })
      )
      child.once('close', (code) => settle({ failed: `the bun probe exited early (code ${code})` }))
      child.stdin.on('error', () => undefined)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        started = true
        buffer += chunk
        let nl: number
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          let m: ProbeMessage
          try {
            m = JSON.parse(line) as ProbeMessage
          } catch {
            settle({ failed: `the bun probe printed an unreadable line: ${line.slice(0, 80)}` })
            return
          }
          if (m.type === 'start') {
            current = m.index
            clearTimeout(timer)
            timer = setTimeout(() => {
              done.add(current)
              errors.push([
                current,
                `${label(current)}: too slow under bun (the hook's runtime): one input of ${lengthOf(current)} chars did not finish within ${deadlineMs} ms`
              ])
              settle({ next: current + 1 })
            }, deadlineMs)
          } else if (m.type === 'done') {
            done.add(m.index)
            if (m.error !== null) errors.push([m.index, `${label(m.index)}: could not be timed under bun: ${m.error}`])
            else if (m.slow !== null)
              errors.push([
                m.index,
                `${label(m.index)}: too slow under bun (the hook's runtime): ${m.slow.ms} ms on a long run of ${m.slow.seed} at ${lengthOf(m.index)} chars (hook budget ${TTSR_REGEX_BUDGET_MS} ms); ` +
                  'repetitions that rescan the text grow with its length, bound them or anchor the pattern'
              ])
          } else settle({ next: Number.POSITIVE_INFINITY })
        }
      })
      child.stdin.end(JSON.stringify({ jobs: batch, budgetMs: TTSR_REGEX_BUDGET_MS }))
    })
    if ('unavailable' in outcome) return outcome
    if ('failed' in outcome) {
      for (const job of batch) {
        if (!done.has(job.index)) errors.push([job.index, `${label(job.index)}: could not be timed under bun: ${outcome.failed}`])
      }
      break
    }
    pending = batch.filter((j) => j.index >= outcome.next)
  }
  return { errors }
}
