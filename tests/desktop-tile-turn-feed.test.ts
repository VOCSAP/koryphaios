import { describe, expect, test } from 'bun:test'
import { createTileTurnFeed } from '../desktop/src/main/tile-turn-feed.ts'
import type { TurnSignalEvent } from '../desktop/src/main/turn-signal-server.ts'

const LIFE_A = {}
const LIFE_B = {}

let seq = 0
function complete(extra: { backgroundTasks?: number; agentId?: string }, generation: object = LIFE_A): TurnSignalEvent {
  return {
    type: 'signal',
    signal: { kind: 'turn.complete', seq: ++seq, turnId: `turn-${seq}`, reason: 'answer', isAborted: false, ...extra },
    loadId: 'load-1',
    generation
  }
}

function started(generation: object = LIFE_A): TurnSignalEvent {
  return { type: 'signal', signal: { kind: 'turn.start', seq: ++seq, turnId: `turn-${seq}` }, loadId: 'load-1', generation }
}

const newFeed = () => createTileTurnFeed(() => {})

describe('backgroundTasks', () => {
  test('is null until a main turn completes', () => {
    const feed = newFeed()
    expect(feed.backgroundTasks()).toBeNull()
    feed.feed(started())
    expect(feed.backgroundTasks()).toBeNull()
  })

  test('is the count of the last main turn.complete', () => {
    const feed = newFeed()
    feed.feed(complete({ backgroundTasks: 2 }))
    expect(feed.backgroundTasks()).toBe(2)
    feed.feed(started())
    expect(feed.backgroundTasks()).toBe(2)
    feed.feed(complete({ backgroundTasks: 0 }))
    expect(feed.backgroundTasks()).toBe(0)
  })

  test('is null again when a main turn.complete carries no count', () => {
    const feed = newFeed()
    feed.feed(complete({ backgroundTasks: 2 }))
    feed.feed(complete({}))
    expect(feed.backgroundTasks()).toBeNull()
  })

  test('ignores the turns of a sub-agent', () => {
    const feed = newFeed()
    feed.feed(complete({ agentId: 'agent-1', backgroundTasks: 3 }))
    expect(feed.backgroundTasks(), "no main turn seen yet").toBeNull()
    feed.feed(complete({ backgroundTasks: 0 }))
    feed.feed(complete({ agentId: 'agent-1', backgroundTasks: 3 }))
    expect(feed.backgroundTasks()).toBe(0)
  })

  test('goes back to null on an event of a new PTY generation, whatever its type', () => {
    const feed = newFeed()
    feed.feed(complete({ backgroundTasks: 2 }))
    feed.feed(started(LIFE_B))
    expect(feed.backgroundTasks()).toBeNull()
    feed.feed(complete({ backgroundTasks: 1 }, LIFE_B))
    expect(feed.backgroundTasks()).toBe(1)
    feed.feed({ type: 'source-changed', loadId: 'load-2', generation: LIFE_A })
    expect(feed.backgroundTasks()).toBeNull()
  })

  test('counts a main turn.complete of a new generation', () => {
    const feed = newFeed()
    feed.feed(complete({ backgroundTasks: 2 }))
    feed.feed(complete({ backgroundTasks: 4 }, LIFE_B))
    expect(feed.backgroundTasks()).toBe(4)
  })

  test('is already updated when a listener reads it', () => {
    const feed = newFeed()
    const seen: Array<number | null> = []
    feed.listen(() => seen.push(feed.backgroundTasks()))
    feed.feed(complete({ backgroundTasks: 2 }))
    feed.feed(complete({ backgroundTasks: 5 }, LIFE_B))
    expect(seen).toEqual([2, 5])
  })
})

describe('counts', () => {
  type Body =
    | { kind: 'subagent.start' | 'subagent.stop'; agentId: string }
    | { kind: 'turn.complete'; backgroundShells?: number; backgroundSubagents?: string[]; agentId?: string }
    | { kind: 'session.end' }
    | { kind: 'turn.start' }

  /** A feed with its own consecutive seq; `skip` leaves a hole before the signal, as a lost send does. */
  function counting() {
    const feed = newFeed()
    let next = 0
    return {
      feed,
      send(body: Body, options: { skip?: boolean; generation?: object } = {}): { subagents: number; shells: number } {
        next += options.skip ? 2 : 1
        const turn = { turnId: 't', reason: 'answer', isAborted: false } as const
        const signal =
          body.kind === 'turn.complete' ? { ...turn, ...body, seq: next }
          : body.kind === 'turn.start' ? { ...body, turnId: 't', seq: next }
          : body.kind === 'session.end' ? { ...body, reason: 'clear' as const, seq: next }
          : { ...body, seq: next }
        feed.feed({ type: 'signal', signal: signal as never, loadId: 'load-1', generation: options.generation ?? LIFE_A })
        return feed.counts()
      }
    }
  }

  const start = (agentId: string) => ({ kind: 'subagent.start', agentId }) as const
  const stop = (agentId: string) => ({ kind: 'subagent.stop', agentId }) as const
  const mainEnd = (backgroundShells?: number) => ({ kind: 'turn.complete', ...(backgroundShells === undefined ? {} : { backgroundShells }) }) as const
  const busy = () => {
    const c = counting()
    c.send(start('a'))
    c.send(mainEnd(2))
    expect(c.feed.counts()).toEqual({ subagents: 1, shells: 2 })
    return c
  }

  test('start at zero', () => {
    expect(newFeed().counts()).toEqual({ subagents: 0, shells: 0 })
  })

  test('two sub-agents count by id and leave one by one', () => {
    const c = counting()
    c.send(start('a'))
    expect(c.send(start('b')).subagents).toBe(2)
    expect(c.send(start('b')).subagents, 'a repeated start is the same sub-agent').toBe(2)
    expect(c.send(stop('unknown')).subagents).toBe(2)
    expect(c.send(stop('a')).subagents).toBe(1)
    expect(c.send(stop('b')).subagents).toBe(0)
  })

  test('the end of a sub-agent turn removes it even without a stop, and leaves the shells alone', () => {
    const c = busy()
    expect(c.send({ kind: 'turn.complete', agentId: 'a', backgroundShells: 7 })).toEqual({ subagents: 0, shells: 2 })
  })

  test('the shell count is replaced by each main Stop, and kept when a turn ends without one', () => {
    const c = counting()
    expect(c.send(mainEnd(2)).shells).toBe(2)
    expect(c.send(mainEnd(1)).shells, 'a snapshot, not a sum').toBe(1)
    expect(c.send(mainEnd()).shells, 'an interrupted turn has no Stop').toBe(1)
    expect(c.send({ kind: 'turn.start' }).shells).toBe(1)
    expect(c.send(mainEnd(0)).shells).toBe(0)
  })

  test('the sub-agent list of a main Stop replaces the running ids, and a turn without a list keeps them', () => {
    const c = counting()
    const listed = (...backgroundSubagents: string[]) => ({ kind: 'turn.complete', backgroundSubagents }) as const
    c.send(start('a'))
    c.send(start('b'))
    expect(c.send(mainEnd()).subagents, 'an interrupted turn lists nothing').toBe(2)
    expect(c.send({ kind: 'turn.complete', agentId: 'z', backgroundSubagents: [] }).subagents, 'a sub-agent turn lists nothing').toBe(2)
    expect(c.send(listed('b', 'c')).subagents).toBe(2)
    expect(c.send(stop('a')).subagents, "'a' was dropped by the list").toBe(2)
    expect(c.send(stop('c')).subagents, "'c' was added by the list").toBe(1)
    expect(c.send(listed()).subagents).toBe(0)
  })

  test('a main Stop that follows a lost signal restores the counts from its own lists', () => {
    const c = busy()
    expect(c.send({ kind: 'turn.complete', backgroundShells: 3, backgroundSubagents: ['x', 'y'] }, { skip: true })).toEqual({
      subagents: 2,
      shells: 3
    })
  })

  test('a lost signal forgets both counts, and counting resumes from that signal', () => {
    const c = busy()
    expect(c.send(start('b'), { skip: true })).toEqual({ subagents: 1, shells: 0 })
    expect(c.send(stop('a'))).toEqual({ subagents: 1, shells: 0 })
  })

  test('a session end forgets both counts', () => {
    expect(busy().send({ kind: 'session.end' })).toEqual({ subagents: 0, shells: 0 })
  })

  test('a foreign source or a refused signal forgets both counts', () => {
    for (const event of [
      { type: 'source-changed', loadId: 'load-2', generation: LIFE_A },
      { type: 'signal-refused', reason: 'bad-string', generation: LIFE_A }
    ] as const) {
      const c = busy()
      c.feed.feed(event)
      expect(c.feed.counts(), event.type).toEqual({ subagents: 0, shells: 0 })
    }
  })

  test('a new PTY generation starts from zero, whatever its first seq', () => {
    const c = busy()
    expect(c.send({ kind: 'turn.start' }, { generation: LIFE_B })).toEqual({ subagents: 0, shells: 0 })
  })

  test('are already updated when a listener reads them', () => {
    const c = counting()
    const seen: number[] = []
    c.feed.listen(() => seen.push(c.feed.counts().subagents))
    c.send(start('a'))
    expect(seen).toEqual([1])
  })
})

describe('listen', () => {
  test('serves every listener with each event, in order', () => {
    const feed = newFeed()
    const first: TurnSignalEvent[] = []
    const second: TurnSignalEvent[] = []
    feed.listen((event) => first.push(event))
    feed.listen((event) => second.push(event))
    const a = started()
    const b = complete({})
    feed.feed(a)
    feed.feed(b)
    expect(first).toEqual([a, b])
    expect(second).toEqual([a, b])
  })

  test('an unsubscribed listener is no longer called, the others still are', () => {
    const feed = newFeed()
    const first: TurnSignalEvent[] = []
    const second: TurnSignalEvent[] = []
    const stop = feed.listen((event) => first.push(event))
    feed.listen((event) => second.push(event))
    feed.feed(started())
    stop()
    feed.feed(started())
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(2)
  })

  test('the same function listened twice is two listeners with independent unsubscribes', () => {
    const feed = newFeed()
    let calls = 0
    const listener = (): void => void (calls += 1)
    const stop = feed.listen(listener)
    feed.listen(listener)
    feed.feed(started())
    expect(calls).toBe(2)
    stop()
    feed.feed(started())
    expect(calls).toBe(3)
  })

  test('a listener unsubscribed by an earlier listener of the same event is not called', () => {
    const feed = newFeed()
    const later: TurnSignalEvent[] = []
    let stopLater = (): void => {}
    feed.listen(() => stopLater())
    stopLater = feed.listen((event) => later.push(event))
    feed.feed(started())
    expect(later).toEqual([])
  })

  test('a throwing listener is reported once and does not stop the others or the count', () => {
    const errors: unknown[] = []
    const feed = createTileTurnFeed((error) => errors.push(error))
    const failure = new Error('listener failed')
    const served: TurnSignalEvent[] = []
    feed.listen(() => {
      throw failure
    })
    feed.listen((event) => served.push(event))
    feed.feed(complete({ backgroundTasks: 2 }))
    expect(errors).toEqual([failure])
    expect(served).toHaveLength(1)
    expect(feed.backgroundTasks()).toBe(2)
  })

  test('feeds nothing back to a listener added while an event is delivered', () => {
    const feed = newFeed()
    const added: TurnSignalEvent[] = []
    feed.listen(() => {
      feed.listen((event) => added.push(event))
    })
    feed.feed(started())
    expect(added).toEqual([])
  })
})
