import { expect, test } from 'bun:test'
import { register as registerModule } from '../desktop/hooks/kory-module.ts'
import type { TurnsHost } from '../desktop/hooks/kory-turns.ts'
import { parseTurnSignal } from '../desktop/hooks/turn-signal-wire.ts'
import { startSequence, stepArgs } from '../desktop/src/main/session-turn-sequence.ts'

const SERVER_URL = 'http://127.0.0.1:4242/signal'
const LOAD_ID = /^[A-Za-z0-9_-]{8,64}$/

type Sent = { url: string; headers: Record<string, string>; body: string }
type Handler = (...args: unknown[]) => Promise<unknown>
type ModuleHost = TurnsHost & {
  fs: { exists(): Promise<boolean>; read(): Promise<string>; write(): Promise<void> }
  session: { usage(): Promise<{ context: { window: number } }>; model(): Promise<string> }
  clock: { now(): Promise<number>; sleep(ms: number): Promise<void> }
}
type Probe = { value: ModuleHost; sent: Sent[]; logs: string[] }

function host(options: { url?: string; reply?: (call: number) => Promise<{ status: number }>; sleep?: (ms: number) => Promise<void> } = {}): Probe {
  const sent: Sent[] = []
  const logs: string[] = []
  let calls = 0
  const url = 'url' in options ? options.url : SERVER_URL
  return {
    sent,
    logs,
    value: {
      env: {
        async get(name) {
          if (name === 'KORY_STATUS_FALLBACK') return '1'
          return name === 'KORY_TURN_SIGNAL_URL' ? url : undefined
        }
      },
      fs: {
        async exists() {
          return false
        },
        async read() {
          return ''
        },
        async write() {}
      },
      session: {
        async usage() {
          return { context: { window: 1 } }
        },
        async model() {
          return 'model'
        }
      },
      clock: {
        async now() {
          return 1
        },
        sleep(ms) {
          return options.sleep ? options.sleep(ms) : new Promise<void>(() => {})
        }
      },
      http: {
        async fetch(target, init) {
          calls += 1
          sent.push({ url: target, headers: init.headers, body: init.body })
          return options.reply ? options.reply(calls) : { status: 204 }
        }
      },
      ui: {
        log(text) {
          logs.push(text)
        }
      }
    }
  }
}

function handlers(): Map<string, Handler> {
  const found = new Map<string, Handler>()
  registerModule(((event: string, handler: Handler) => found.set(event, handler)) as never)
  return found
}

/** Every host call resolves in microtasks, so a fixed number of turns drains the send chain. */
async function idle(): Promise<void> {
  for (let turn = 0; turn < 200; turn++) await Promise.resolve()
}

const answer = (result: unknown = {}) => async () => result

function bodies(probe: Probe): Array<Record<string, unknown>> {
  return probe.sent.map((request) => JSON.parse(request.body) as Record<string, unknown>)
}

async function skillTurn(h: Map<string, Handler>, probe: Probe, background?: unknown[]): Promise<void> {
  const $ = probe.value
  await h.get('command.run')!($, { command: 'turnspy:probe', args: 'plan N1', origin: { kind: 'composer' } }, answer({ text: '' }))
  await h.get('turn.start')!($, { turnId: 't1' }, answer({ text: '' }))
  await h.get('classic.Stop')!($, background === undefined ? {} : { background_tasks: background }, answer({}))
  await h.get('turn.complete')!($, { turnId: 't1', reason: 'answer', isAborted: false }, answer({ text: 'done' }))
}

test('a skill turn is sent in the wire shapes the Deck parser accepts, with consecutive seq', async () => {
  const probe = host()
  await skillTurn(handlers(), probe, [])
  await idle()

  expect(bodies(probe)).toEqual([
    { kind: 'command.run:enter', seq: 1, command: 'turnspy:probe', args: 'plan N1', origin: 'composer' },
    { kind: 'command.run:resolved', seq: 2, command: 'turnspy:probe' },
    { kind: 'turn.start', seq: 3, turnId: 't1', commandSeq: 1 },
    { kind: 'turn.complete', seq: 4, turnId: 't1', reason: 'answer', isAborted: false, backgroundTasks: 0 }
  ])
  for (const request of probe.sent) {
    const parsed = parseTurnSignal(request.body)
    expect(parsed.ok, `the Deck parser must accept ${request.body}`).toBe(true)
  }
  expect(probe.sent.every((request) => request.url === SERVER_URL)).toBe(true)
  expect(probe.sent.every((request) => request.headers['Content-Type'] === 'application/json')).toBe(true)
})

test('one X-Kory-Load id, valid for the server, is drawn per module load and sent with every request', async () => {
  const first = host()
  const firstHandlers = handlers()
  await skillTurn(firstHandlers, first)
  await skillTurn(firstHandlers, first)
  await idle()
  const second = host()
  await skillTurn(handlers(), second)
  await idle()

  const ids = new Set(first.sent.map((request) => request.headers['X-Kory-Load']))
  expect(first.sent.length).toBe(8)
  expect(ids.size, 'a module load keeps one id for all of its requests').toBe(1)
  expect([...ids][0]).toMatch(LOAD_ID)
  expect(second.sent[0]!.headers['X-Kory-Load'], 'another module load draws another id').not.toBe([...ids][0])
})

test('turn.start claims the seq of the command.run:enter, not the resolved one, and only once', async () => {
  const probe = host()
  const h = handlers()
  const $ = probe.value
  await h.get('command.run')!($, { command: 'turnspy:probe', args: 'a', origin: { kind: 'composer' } }, answer())
  await h.get('turn.start')!($, { turnId: 't1' }, answer())
  await h.get('turn.start')!($, { turnId: 't2' }, answer())
  await idle()

  const starts = bodies(probe).filter((body) => body.kind === 'turn.start')
  expect(starts[0]!.commandSeq, 'the enter was seq 1 and the resolved seq 2').toBe(1)
  expect('commandSeq' in starts[1]!, 'a turn no command started carries none').toBe(false)
})

test('a sub-agent turn neither carries nor claims the command seq', async () => {
  const probe = host()
  const h = handlers()
  const $ = probe.value
  await h.get('command.run')!($, { command: 'turnspy:probe', args: 'a', origin: { kind: 'composer' } }, answer())
  await h.get('turn.start')!($, { turnId: 'sub', agentId: 'agent-1' }, answer())
  await h.get('turn.start')!($, { turnId: 'main' }, answer())
  await idle()

  const starts = bodies(probe).filter((body) => body.kind === 'turn.start')
  expect(starts[0]).toEqual({ kind: 'turn.start', seq: 3, turnId: 'sub', agentId: 'agent-1' })
  expect(starts[1]!.commandSeq).toBe(1)
})

test('turn.complete carries the background count of its own turn only', async () => {
  const probe = host()
  const h = handlers()
  await skillTurn(h, probe, [{ id: 'a' }, { id: 'b' }])
  await skillTurn(h, probe, undefined)
  const $ = probe.value
  await h.get('classic.Stop')!($, { background_tasks: [{ id: 'c' }] }, answer())
  await h.get('turn.start')!($, { turnId: 't3' }, answer())
  await h.get('turn.complete')!($, { turnId: 't3', reason: 'aborted', isAborted: true }, answer())
  await idle()

  const completes = bodies(probe).filter((body) => body.kind === 'turn.complete')
  expect(completes[0]!.backgroundTasks, 'two tasks in the Stop of the turn').toBe(2)
  expect('backgroundTasks' in completes[1]!, 'a Stop without a task list is unknown, not zero').toBe(false)
  expect('backgroundTasks' in completes[2]!, 'an aborted turn has no Stop: the count of the previous turn must not carry over').toBe(false)
})

test('a Stop count is used by one turn.complete only', async () => {
  const probe = host()
  const h = handlers()
  const $ = probe.value
  await h.get('classic.Stop')!($, { background_tasks: [{ id: 'a' }] }, answer())
  await h.get('turn.complete')!($, { turnId: 't1', reason: 'answer', isAborted: false }, answer())
  await h.get('turn.complete')!($, { turnId: 't1', reason: 'answer', isAborted: false }, answer())
  await idle()

  const [first, second] = bodies(probe)
  expect(first!.backgroundTasks).toBe(1)
  expect('backgroundTasks' in second!).toBe(false)
})

test('a sub-agent turn.complete carries its agentId, no count, and leaves the main count alone', async () => {
  const probe = host()
  const h = handlers()
  const $ = probe.value
  await h.get('classic.Stop')!($, { background_tasks: [{ id: 'a' }] }, answer())
  await h.get('turn.complete')!($, { turnId: 'sub', agentId: 'agent-1', reason: 'answer', isAborted: false }, answer())
  await h.get('turn.complete')!($, { turnId: 'main', reason: 'answer', isAborted: false }, answer())
  await idle()

  const [sub, main] = bodies(probe)
  expect(sub).toEqual({ kind: 'turn.complete', seq: 1, turnId: 'sub', reason: 'answer', isAborted: false, agentId: 'agent-1' })
  expect(main!.backgroundTasks).toBe(1)
})

test('no prompt or answer text leaves the module', async () => {
  const probe = host()
  const h = handlers()
  const $ = probe.value
  await h.get('turn.start')!($, { turnId: 't1', text: 'SECRET-PROMPT', origin: { kind: 'composer' } }, answer())
  await h.get('turn.complete')!($, { turnId: 't1', reason: 'answer', isAborted: false, answer: 'SECRET-ANSWER', usage: { tokens: 1 } }, answer())
  await idle()

  expect(probe.sent).toHaveLength(2)
  for (const request of probe.sent) {
    expect(request.body).not.toContain('SECRET')
    expect(parseTurnSignal(request.body).ok).toBe(true)
  }
})

test('an empty URL sends nothing and breaks nothing', async () => {
  const probe = host({ url: '' })
  const h = handlers()
  const result = await h.get('command.run')!(probe.value, { command: 'clear', args: '', origin: { kind: 'composer' } }, answer({ text: 'kept' }))
  await idle()

  expect(result).toEqual({ text: 'kept' })
  expect(probe.sent).toEqual([])
  expect(probe.logs).toEqual([])
})

test('a failed send is logged and swallowed, and its seq is still taken', async () => {
  const probe = host({
    reply: async (call) => {
      if (call === 1) throw new Error('connect refused')
      return { status: 204 }
    }
  })
  const h = handlers()
  const $ = probe.value
  const result = await h.get('turn.start')!($, { turnId: 't1' }, answer({ text: 'kept' }))
  await h.get('turn.complete')!($, { turnId: 't1', reason: 'answer', isAborted: false }, answer())
  await idle()

  expect(result).toEqual({ text: 'kept' })
  expect(probe.logs).toEqual(['Kory turn signal send failed (1 so far): connect refused'])
  expect(bodies(probe).map((body) => body.seq), 'the signal after a lost one is 2, so the Deck sees a gap').toEqual([1, 2])
})

test('a refused status is logged as a failure', async () => {
  const probe = host({ reply: async () => ({ status: 403 }) })
  await handlers().get('session.end')!(probe.value, { reason: 'other' }, answer())
  await idle()

  expect(probe.logs).toEqual(['Kory turn signal send failed (1 so far): status 403'])
})

test('sends leave in event order even when an earlier one is slow', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const probe = host({
    reply: async (call) => {
      if (call === 1) await gate
      return { status: 204 }
    }
  })
  const h = handlers()
  const $ = probe.value
  await h.get('turn.start')!($, { turnId: 't1' }, answer())
  await h.get('turn.complete')!($, { turnId: 't1', reason: 'answer', isAborted: false }, answer())
  await idle()
  expect(bodies(probe).map((body) => body.seq), 'the second waits for the first').toEqual([1])

  release()
  await idle()
  expect(bodies(probe).map((body) => body.seq)).toEqual([1, 2])
})

test('a fetch that never answers is counted as a failure after 10 s and the next signal still leaves', async () => {
  const waits: Array<{ ms: number; expire: () => void }> = []
  const probe = host({
    reply: (call) => (call === 1 ? new Promise<{ status: number }>(() => {}) : Promise.resolve({ status: 204 })),
    sleep: (ms) => new Promise<void>((resolve) => waits.push({ ms, expire: resolve }))
  })
  const h = handlers()
  const $ = probe.value
  await h.get('turn.start')!($, { turnId: 't1' }, answer())
  await h.get('turn.complete')!($, { turnId: 't1', reason: 'answer', isAborted: false }, answer())
  await idle()

  expect(bodies(probe).map((body) => body.seq), 'the second waits while the first has no answer').toEqual([1])
  expect(waits.map((wait) => wait.ms), 'the first send is given 10 s').toEqual([10_000])

  waits[0]!.expire()
  await idle()
  expect(bodies(probe).map((body) => body.seq), 'the first timed out and freed the chain').toEqual([1, 2])
  expect(probe.logs).toEqual(['Kory turn signal send failed (1 so far): no answer in 10 s'])
})

test('a compact that was skipped is not reported as compacted', async () => {
  const probe = host()
  const h = handlers()
  const $ = probe.value
  await h.get('session.compact')!($, { trigger: 'manual' }, answer({ skip: 'nothing to compact' }))
  expect(await idle().then(() => probe.sent)).toEqual([])

  const done = await h.get('session.compact')!($, { trigger: 'manual' }, answer({ messages: [] }))
  await idle()
  expect(done).toEqual({ messages: [] })
  expect(bodies(probe)).toEqual([{ kind: 'session.compact:resolved', seq: 1 }])
})

test('session.end keeps a known reason and files an unknown one under other', async () => {
  const probe = host()
  const h = handlers()
  await h.get('session.end')!(probe.value, { reason: 'clear' }, answer({ sessionId: 'old' }))
  await h.get('session.end')!(probe.value, { reason: 'exit' }, answer({ sessionId: 'old' }))
  await idle()

  expect(bodies(probe).map((body) => body.reason)).toEqual(['clear', 'other'])
  for (const request of probe.sent) expect(parseTurnSignal(request.body).ok).toBe(true)
})

const NEXT_RESULT = { text: 'ran' }

/** Plays one command.run through the module and records what the engine's next() was given. */
async function runCommand(args: string) {
  const probe = host()
  const event = { command: 'turnspy:probe', args, origin: { kind: 'composer' } }
  const forwarded: Array<{ args: string }> = []
  const result = await handlers().get('command.run')!(probe.value, event, async (given: { args: string }) => {
    forwarded.push(given)
    return NEXT_RESULT
  })
  await idle()
  return { probe, event, forwarded, result }
}

/** The args the Deck types for a skill step, built by the Deck's own function. */
const deckArgs = (base: string, nonce: string): string => stepArgs({ command: 'turnspy:probe', args: base, nonce })

/** Whether the Deck would accept this nonce on a skill step. */
function deckAcceptsNonce(nonce: string): boolean {
  const plan = { steps: [{ command: 'kory-session-start', nonce }], table: { 'kory-session-start': 'skill' }, startQuiet: true } as const
  return startSequence(plan).state.status !== 'refused'
}

const NONCE = 'a1b2c3d4e5f60718'
const TOKEN_PREFIX = deckArgs('', NONCE).slice(0, -NONCE.length)

test('the command.run signal keeps the original args, token included, so the Deck can read the nonce', async () => {
  for (const base of ['plan N1', '']) {
    const { probe } = await runCommand(deckArgs(base, NONCE))
    expect(bodies(probe)[0], `base ${JSON.stringify(base)}`).toMatchObject({ kind: 'command.run:enter', args: deckArgs(base, NONCE) })
  }
})

test('a skill never sees the token the Deck appended to its arguments, nor the space before it', async () => {
  for (const base of ['plan N1', '', 'two  words', 'ends with a space ']) {
    const { event, forwarded } = await runCommand(deckArgs(base, NONCE))
    expect(forwarded, `base ${JSON.stringify(base)}`).toHaveLength(1)
    expect(forwarded[0]).toEqual({ ...event, args: base })
  }
})

test('the token is removed for every nonce the Deck accepts and kept for every one it refuses', async () => {
  const nonces = Array.from({ length: 40 }, (_, at) => '0123456789abcdef'.repeat(3).slice(0, at + 1))
  nonces.push('ABCDEF0123456789', 'aBcdef0123456789', 'g'.repeat(16), 'a1b2c3d4-e5f60718')
  const accepted = nonces.filter(deckAcceptsNonce)
  expect(accepted.length, 'the oracle must accept some nonces').toBeGreaterThan(0)
  expect(accepted.length, 'the oracle must refuse some nonces').toBeLessThan(nonces.length)
  for (const nonce of nonces) {
    const args = deckArgs('soft', nonce)
    const { event, forwarded } = await runCommand(args)
    if (deckAcceptsNonce(nonce)) expect(forwarded[0]!.args, `nonce ${nonce}`).toBe('soft')
    else expect(forwarded[0], `nonce ${nonce}`).toBe(event)
  }
})

test('text that is not the Deck tail reaches the skill untouched', async () => {
  const tail = `${TOKEN_PREFIX}${NONCE}`
  for (const args of [`${tail} plan`, `plan ${tail} `, `plan\t${tail}`, `plan${tail}`, `plan ${TOKEN_PREFIX}`, `plan ${TOKEN_PREFIX}xyz`]) {
    const { event, forwarded } = await runCommand(args)
    expect(forwarded[0], JSON.stringify(args)).toBe(event)
  }
})

test('only the last of two tokens is removed', async () => {
  const first = `${TOKEN_PREFIX}${NONCE}`
  const { forwarded } = await runCommand(`plan ${first} ${TOKEN_PREFIX}00ff00ff00ff00ff`)
  expect(forwarded[0]!.args).toBe(`plan ${first}`)
})

test('a command without a token passes the very same event to next and returns its result', async () => {
  const { probe, event, forwarded, result } = await runCommand('plan N1')
  expect(forwarded).toHaveLength(1)
  expect(forwarded[0]).toBe(event)
  expect(result).toBe(NEXT_RESULT)
  expect(bodies(probe).map((body) => body.kind)).toEqual(['command.run:enter', 'command.run:resolved'])
})

test('a command with a token still returns the result of next and sends the resolved signal', async () => {
  const { probe, result } = await runCommand(deckArgs('plan N1', NONCE))
  expect(result).toBe(NEXT_RESULT)
  expect(bodies(probe).map((body) => body.kind)).toEqual(['command.run:enter', 'command.run:resolved'])
})

test('the Kory module registers each turn event, and no event twice', () => {
  const events: string[] = []
  registerModule(((event: string) => events.push(event)) as never)

  for (const event of ['command.run', 'turn.start', 'turn.complete', 'classic.Stop', 'session.compact', 'session.end']) {
    expect(events, `kory-module.ts must register ${event}`).toContain(event)
  }
  expect(events.filter((event, at) => events.indexOf(event) !== at), 'the Claude Code loader refuses a second registration of an event').toEqual([])
})
