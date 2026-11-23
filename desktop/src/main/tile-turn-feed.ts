import type { TurnSignalEvent } from './turn-signal-server'

export interface TileTurnFeed {
  feed(event: TurnSignalEvent): void
  /** The background task count of the last main-turn turn.complete; null until one is seen and after a new PTY generation. */
  backgroundTasks(): number | null
  listen(listener: (event: TurnSignalEvent) => void): () => void
}

/** One feed per tile, fed by the tile's single turn-signal subscription. */
export function createTileTurnFeed(onListenerError: (error: unknown) => void): TileTurnFeed {
  const entries = new Set<{ listener: (event: TurnSignalEvent) => void }>()
  let generation: object | null = null
  let background: number | null = null

  return {
    feed(event) {
      if (event.generation !== generation) {
        generation = event.generation
        background = null
      }
      if (event.type === 'signal' && event.signal.kind === 'turn.complete' && event.signal.agentId === undefined) {
        background = event.signal.backgroundTasks ?? null
      }
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
    listen(listener) {
      const entry = { listener }
      entries.add(entry)
      return () => {
        entries.delete(entry)
      }
    }
  }
}
