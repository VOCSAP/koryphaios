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
