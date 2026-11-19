import { expect, test } from 'bun:test'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  classifyHostRoadmapProbe,
  createHostRoadmapMcpProbe,
  HOST_ROADMAP_PROBE_COMMAND,
  runHostRoadmapProbe,
  type HostProbeSpawnDeps,
  type HostRoadmapProbeRun
} from '../desktop/src/main/host-roadmap-mcp'
import { reachedWithin } from './_bounded-await'
import { extractParenBody } from './_braced-body'

const USER_SCOPE = 'kory-roadmap:\n  Scope: User config (available in all your projects)\n  Status: ✔ Connected\n  Type: stdio\n'
const LOCAL_SCOPE = 'kory-roadmap:\n  Scope: Local config (private to you in this project)\n  Status: ✔ Connected\n'
const ABSENT = 'No MCP server named "kory-roadmap". Configured servers: aidex, claude-peers, kleos'

function run(over: Partial<HostRoadmapProbeRun>): HostRoadmapProbeRun {
  return { code: 0, stdout: '', stderr: '', timedOut: false, ...over }
}

test('the probe asks the host CLI for the roadmap server by name', () => {
  expect(HOST_ROADMAP_PROBE_COMMAND).toBe('claude mcp get kory-roadmap')
})

test.each([
  ['a user-scope entry', run({ stdout: USER_SCOPE }), 'registered'],
  ['an entry in another scope', run({ stdout: LOCAL_SCOPE }), 'wrong-scope'],
  ['an absent entry reported on stderr', run({ code: 1, stderr: ABSENT }), 'missing'],
  ['an absent entry reported on stdout', run({ code: 1, stdout: ABSENT }), 'missing'],
  ['a successful exit without a Scope line', run({ stdout: 'something else entirely' }), 'unknown'],
  ['a failure that is not the absence message', run({ code: 1, stderr: 'claude: command not found' }), 'unknown'],
  ['an exit code other than 1 carrying the absence message', run({ code: 2, stderr: ABSENT }), 'unknown'],
  ['a process that never ran', run({ code: null, stderr: 'spawn failed' }), 'unknown'],
  ['a timeout that carries a registered entry', run({ stdout: USER_SCOPE, timedOut: true }), 'unknown'],
  ['a timeout that carries the absence message', run({ code: 1, stderr: ABSENT, timedOut: true }), 'unknown']
] as const)('classifies %s', (_name, probe, expected) => {
  expect(classifyHostRoadmapProbe(probe)).toBe(expected)
})

/** The probe starts run() through a microtask: let it start before counting or answering. */
async function tick(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

interface Harness {
  probe: ReturnType<typeof createHostRoadmapMcpProbe>
  runs: { count: number; release: (value: HostRoadmapProbeRun) => Promise<void> }
  reports: string[]
}

/** Each started probe waits on `release`, so a test decides when and with what it answers. */
function harness(timeoutMs?: number): Harness {
  const reports: string[] = []
  const pending: Array<(value: HostRoadmapProbeRun) => void> = []
  const runs = {
    count: 0,
    release: async (value: HostRoadmapProbeRun) => {
      await tick()
      const next = pending.pop()
      if (!next) throw new Error('no probe is waiting for an answer')
      next(value)
    }
  }
  const probe = createHostRoadmapMcpProbe({
    run: () => {
      runs.count++
      return new Promise((resolve) => pending.push(resolve))
    },
    report: (scope, message) => reports.push(`${scope}: ${message}`),
    timeoutMs
  })
  return { probe, runs, reports }
}

test('status() returns a pending promise at once and does not run the probe twice', async () => {
  const { probe, runs } = harness()
  const first = probe.status()
  const second = probe.status()

  await tick()
  expect(runs.count).toBe(1)
  expect(second).toBe(first)
  await runs.release(run({ stdout: USER_SCOPE }))
  expect(await reachedWithin(first, 'first verdict')).toBe('registered')
  expect(await reachedWithin(probe.status(), 'cached verdict')).toBe('registered')
  expect(runs.count).toBe(1)
})

test('a forced status() while a probe is running waits for it, then runs one fresh probe and answers with that one', async () => {
  const { probe, runs } = harness()
  const first = probe.status()
  const forced = probe.status(true)

  expect(forced, 'the forced call must not hand back the verdict already in flight').not.toBe(first)
  await tick()
  expect(runs.count, 'two concurrent probes would start two claude processes').toBe(1)
  await runs.release(run({ code: 1, stderr: ABSENT }))
  expect(await reachedWithin(first, 'first verdict')).toBe('missing')
  await tick()
  expect(runs.count).toBe(2)
  await runs.release(run({ stdout: USER_SCOPE }))
  expect(await reachedWithin(forced, 'forced verdict')).toBe('registered')
})

test('several forced calls during one probe chain a single fresh probe', async () => {
  const { probe, runs } = harness()
  const first = probe.status()
  const forcedA = probe.status(true)
  const forcedB = probe.status(true)

  expect(forcedB).toBe(forcedA)
  await runs.release(run({ code: 1, stderr: ABSENT }))
  await reachedWithin(first, 'first verdict')
  await tick()
  expect(runs.count).toBe(2)
  await runs.release(run({ stdout: USER_SCOPE }))
  expect(await reachedWithin(forcedB, 'forced verdict')).toBe('registered')
  await tick()
  expect(runs.count, 'the extra forced call must not queue a third probe').toBe(2)
})

test('a run() that throws synchronously is unknown and does not leave the probe stuck as running', async () => {
  const reports: string[] = []
  let calls = 0
  const probe = createHostRoadmapMcpProbe({
    run: () => {
      calls++
      if (calls === 1) throw new Error('sync boom')
      return Promise.resolve(run({ stdout: USER_SCOPE }))
    },
    report: (scope, message) => reports.push(`${scope}: ${message}`)
  })

  expect(await reachedWithin(probe.status(), 'failed verdict')).toBe('unknown')
  expect(reports.some((line) => line.includes('could not run'))).toBe(true)
  expect(await reachedWithin(probe.status(true), 'relaunched verdict')).toBe('registered')
  expect(calls).toBe(2)
})

test('a forced status() after the probe settled starts a new one and reports its verdict', async () => {
  const { probe, runs } = harness()
  const first = probe.status()
  await runs.release(run({ code: 1, stderr: ABSENT }))
  expect(await reachedWithin(first, 'first verdict')).toBe('missing')

  const forced = probe.status(true)
  await tick()
  expect(runs.count).toBe(2)
  await runs.release(run({ stdout: USER_SCOPE }))
  expect(await reachedWithin(forced, 'forced verdict')).toBe('registered')
  expect(await reachedWithin(probe.status(), 'cached verdict')).toBe('registered')
})

test('only the literal true forces: a truthy non-boolean reuses the cached verdict', async () => {
  const { probe, runs } = harness()
  const first = probe.status()
  await runs.release(run({ stdout: USER_SCOPE }))
  await reachedWithin(first, 'first verdict')

  expect(await reachedWithin(probe.status('yes' as unknown as boolean), 'cached verdict')).toBe('registered')
  expect(runs.count).toBe(1)
})

test('a probe that never answers resolves unknown within the bound, and a later forced call runs a fresh one', async () => {
  const { probe, runs, reports } = harness(10)

  expect(await reachedWithin(probe.status(), 'timed-out verdict')).toBe('unknown')
  expect(reports.join('\n')).toContain('no answer within 10 ms')

  const forced = probe.status(true)
  await tick()
  expect(runs.count).toBe(2)
  await runs.release(run({ stdout: USER_SCOPE }))
  expect(await reachedWithin(forced, 'forced verdict')).toBe('registered')
})

test('a probe that throws is unknown and leaves a trace', async () => {
  const reports: string[] = []
  const probe = createHostRoadmapMcpProbe({
    run: () => Promise.reject(new Error('spawn EACCES')),
    report: (scope, message) => reports.push(`${scope}: ${message}`)
  })

  expect(await reachedWithin(probe.status(), 'failed verdict')).toBe('unknown')
  expect(reports.some((line) => line.includes('could not run'))).toBe(true)
})

test.each([
  ['missing', run({ code: 1, stderr: ABSENT }), 'not registered in the user scope'],
  ['wrong-scope', run({ stdout: LOCAL_SCOPE }), 'outside the user scope'],
  ['unknown', run({ code: 127, stderr: 'claude: command not found' }), 'could not tell whether']
] as const)('a %s verdict leaves a journal trace naming it', async (_verdict, answer, wording) => {
  const { probe, runs, reports } = harness()
  const pending = probe.status()
  await runs.release(answer)
  await reachedWithin(pending, 'verdict')

  expect(reports.filter((line) => line.startsWith('host-roadmap: ') && line.includes(wording))).toHaveLength(1)
})

test('a registered entry leaves no trace', async () => {
  const { probe, runs, reports } = harness()
  const pending = probe.status()
  await runs.release(run({ stdout: USER_SCOPE }))
  await reachedWithin(pending, 'verdict')

  expect(reports).toEqual([])
})

/** Decodes like a real stream once setEncoding('utf8') is set, so a character split across chunks arrives whole. */
class FakeStream extends EventEmitter {
  private decoder: StringDecoder | null = null
  setEncoding(encoding: BufferEncoding): this {
    this.decoder = new StringDecoder(encoding)
    return this
  }
  push(bytes: Buffer): void {
    this.emit('data', this.decoder === null ? bytes : this.decoder.write(bytes))
  }
}

class FakeChild extends EventEmitter {
  pid = 4242
  stdout = new FakeStream()
  stderr = new FakeStream()
  killed: string[] = []
  /** Like a real kill: the child closes once signalled. */
  kill(signal?: string): boolean {
    this.killed.push(signal ?? 'SIGTERM')
    queueMicrotask(() => this.emit('close', null))
    return true
  }
}

interface SpawnHarness {
  deps: HostProbeSpawnDeps
  child: FakeChild
  spawned: { file: string; args: string[]; options: SpawnOptions }[]
  groups: number[]
}

function spawnHarness(plat: NodeJS.Platform, killGroup?: (pid: number) => void): SpawnHarness {
  const child = new FakeChild()
  const spawned: SpawnHarness['spawned'] = []
  const groups: number[] = []
  const deps: HostProbeSpawnDeps = {
    spawn: (file, args, options) => {
      spawned.push({ file, args, options })
      return child as unknown as ChildProcess
    },
    platform: plat,
    killGroup:
      killGroup ??
      ((pid) => {
        groups.push(pid)
        queueMicrotask(() => child.emit('close', null))
      })
  }
  return { deps, child, spawned, groups }
}

test('win32: the probe enters the Job Object and a timeout kills the shell, whose job takes the tree with it', async () => {
  const { deps, child, spawned, groups } = spawnHarness('win32')

  const result = await reachedWithin(runHostRoadmapProbe('', 10, deps), 'timed-out run')

  expect(result).toMatchObject({ code: null, timedOut: true })
  expect(spawned[0]!.options.env?.KORY_JOB_PS, 'the Job Object source rides in the environment').toBeTruthy()
  expect(spawned[0]!.args.join(' ')).toContain('KORY_JOB_PS')
  expect(spawned[0]!.options.detached).toBe(false)
  expect(child.killed).toEqual(['SIGKILL'])
  expect(groups).toEqual([])
})

test('POSIX: the child leads its own process group and a timeout signals the whole group', async () => {
  const { deps, child, spawned, groups } = spawnHarness('linux')

  const result = await reachedWithin(runHostRoadmapProbe('/bin/bash', 10, deps), 'timed-out run')

  expect(result).toMatchObject({ code: null, timedOut: true })
  expect(spawned[0]!.options.detached).toBe(true)
  expect(spawned[0]!.args.join(' '), 'no Job Object preamble outside win32').not.toContain('KORY_JOB_PS')
  expect(groups).toEqual([4242])
  expect(child.killed).toEqual([])
})

test('POSIX: a group that cannot be signalled falls back to killing the child itself', async () => {
  const { deps, child } = spawnHarness('linux', () => {
    throw new Error('ESRCH')
  })

  const result = await reachedWithin(runHostRoadmapProbe('/bin/bash', 10, deps), 'timed-out run')

  expect(result.timedOut).toBe(true)
  expect(child.killed).toEqual(['SIGKILL'])
})

test('the probe runs the fixed command from the home directory and returns the exit code with both streams', async () => {
  const { deps, child, spawned } = spawnHarness('linux')
  const pending = runHostRoadmapProbe('/bin/bash', 5000, deps)

  child.stdout.push(Buffer.from('kory-roadmap:\n  Scope: User'))
  child.stdout.push(Buffer.from(' config\n'))
  child.stderr.push(Buffer.from('warn'))
  child.emit('close', 0)

  expect(await reachedWithin(pending, 'run')).toEqual({ code: 0, stdout: 'kory-roadmap:\n  Scope: User config\n', stderr: 'warn', timedOut: false })
  expect(spawned[0]!.options.cwd).toBe(homedir())
  expect(spawned[0]!.args.join(' ')).toContain(HOST_ROADMAP_PROBE_COMMAND)
})

test('a multibyte character split between two chunks of either stream arrives whole', async () => {
  const { deps, child } = spawnHarness('linux')
  const pending = runHostRoadmapProbe('/bin/bash', 5000, deps)
  const accent = Buffer.from('é')

  child.stdout.push(Buffer.concat([Buffer.from('Status: '), accent.subarray(0, 1)]))
  child.stdout.push(accent.subarray(1))
  child.stderr.push(Buffer.concat([Buffer.from('No MCP server named '), accent.subarray(0, 1)]))
  child.stderr.push(accent.subarray(1))
  child.emit('close', 1)

  expect(await reachedWithin(pending, 'run')).toMatchObject({ stdout: 'Status: é', stderr: 'No MCP server named é' })
})

test('a spawn failure is a run that never started, not a verdict', async () => {
  const { deps, child } = spawnHarness('linux')
  const pending = runHostRoadmapProbe('/bin/bash', 5000, deps)

  child.emit('error', new Error('spawn /bin/bash ENOENT'))

  const result = await reachedWithin(pending, 'run')
  expect(result).toMatchObject({ code: null, timedOut: false })
  expect(result.stderr).toContain('ENOENT')
  expect(classifyHostRoadmapProbe(result)).toBe('unknown')
})

test('the Deck starts the probe without awaiting it in the whenReady handler', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'desktop', 'src', 'main', 'index.ts'), 'utf8')
  const head = 'app.whenReady().then('
  const start = source.indexOf(head)
  if (start === -1) throw new Error(`index.ts: missing ${head}`)
  const handler = extractParenBody(source, start + head.length - 1, true)

  expect(handler.split('void hostRoadmapMcp.status()').length - 1, 'the probe starts, unawaited, in the whenReady handler').toBe(1)
  expect(handler, 'the window must not wait on the probe').not.toMatch(/await[^\n]*hostRoadmapMcp/)
})
