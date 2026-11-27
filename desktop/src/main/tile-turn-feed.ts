import type { SessionBackgroundCounts } from '../shared/types'
import type { TurnSignalEvent } from './turn-signal-server'

export interface TileTurnFeed {
  feed(event: TurnSignalEvent): void
  /** The background task count of the last main-turn turn.complete; null until one is seen and after a new PTY generation. */
  backgroundTasks(): number | null
  /** Both zero again whenever signals may have been lost: a new PTY generation, a seq break, a refused or foreign source, a session end. */
  counts(): SessionBackgroundCounts
  listen(listener: (event: TurnSignalEvent) => void): () => void
}

/** One feed per tile, fed by the tile's single turn-signal subscription. */
export function createTileTurnFeed(onListenerError: (error: unknown) => void): TileTurnFeed {
  const entries = new Set<{ listener: (event: TurnSignalEvent) => void }>()
  let generation: object | null = null
  let background: number | null = null
  const subagents = new Set<string>()
  let shells = 0
  let lastSeq: number | null = null

  const forgetCounts = (): void => {
    subagents.clear()
    shells = 0
  }

  /** The main Stop lists what still runs, so it replaces both counts, a stop signal that never arrived included. */
  const mainStop = (listedShells: number | undefined, listedSubagents: string[] | undefined): void => {
    if (listedShells !== undefined) shells = listedShells
    if (listedSubagents === undefined) return
    subagents.clear()
    for (const id of listedSubagents) subagents.add(id)
  }

  const count = (event: TurnSignalEvent): void => {
    if (event.type !== 'signal') return forgetCounts()
    const signal = event.signal
    if (lastSeq !== null && signal.seq !== lastSeq + 1) forgetCounts()
    lastSeq = signal.seq
    if (signal.kind === 'session.end') forgetCounts()
    else if (signal.kind === 'subagent.start') subagents.add(signal.agentId)
    else if (signal.kind === 'subagent.stop') subagents.delete(signal.agentId)
    else if (signal.kind === 'turn.complete') {
      // An interrupted sub-agent may end its turn without a stop signal.
      if (signal.agentId !== undefined) subagents.delete(signal.agentId)
      else mainStop(signal.backgroundShells, signal.backgroundSubagents)
    }
  }

  return {
    feed(event) {
      if (event.generation !== generation) {
        generation = event.generation
        background = null
        lastSeq = null
        forgetCounts()
      }
      if (event.type === 'signal' && event.signal.kind === 'turn.complete' && event.signal.agentId === undefined) {
        background = event.signal.backgroundTasks ?? null
      }
      count(event)
      for (const entry of [...entries]) {
        if (!entries.has(entry)) continue
        try {
          entry.listener(event)
        } catch (error) {
          onListenerError(error)
        }
      }
    },
    backgroundTasks: () => background,
    counts: () => ({ subagents: subagents.size, shells }),
    listen(listener) {
      const entry = { listener }
      entries.add(entry)
      return () => {
        entries.delete(entry)
      }
    }
  }
}
