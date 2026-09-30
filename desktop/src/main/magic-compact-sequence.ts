// The magic_compact sequence, run inside one turn of its tile. The host offers
// no injection that takes a turn: every command goes through the turn's own
// inject, so the sequence cannot wait on itself.

import { isMagicShimFailure, MAGIC_TIMEOUT_MS, parseMagicResume } from './magic-compact'
import type { MagicCompactMode } from './launch-config'
import type { DirectiveOutcome } from './session-service'
import type { InTurnInject } from './tile-injector'

export interface MagicCompactHost {
  serializeTile<T>(id: string, fn: (inject: InTurnInject) => Promise<T>): Promise<T>
  waitForOutput<T>(id: string, timeoutMs: number, test: (buf: string) => T | null): Promise<T | null>
}

/** Resolves with the outcome of the command that ends the sequence: /compact or /resume. */
export function runMagicCompactInTurn(
  host: MagicCompactHost,
  journal: (line: string) => void,
  tileId: string,
  peerId: string,
  useMagic: boolean,
  mode: MagicCompactMode
): Promise<DirectiveOutcome> {
  return host.serializeTile(tileId, async (inject) => {
    if (!useMagic) {
      const why = mode === 'off' ? 'disabled' : 'plugin absent'
      const o = await inject('/compact')
      journal(`magic_compact -> "${peerId}": ${why}, used /compact (${o})`)
      return o
    }
    // Inject FIRST, then arm the scanner, so it never captures output that
    // predates the command (a stale /resume banner) and the MAGIC_TIMEOUT_MS
    // budget starts at injection, not during the idle wait. The banner is a PTY
    // macrotask, so the waitForOutput() on the next line attaches before it.
    const injected = await inject('/magic-compact')
    if (injected !== 'written') {
      journal(`magic_compact -> "${peerId}": /magic-compact not injected (${injected})`)
      return injected
    }
    const res = await host.waitForOutput(tileId, MAGIC_TIMEOUT_MS, (buf) => {
      const id = parseMagicResume(buf)
      if (id) return { kind: 'resume' as const, id }
      if (isMagicShimFailure(buf)) return { kind: 'shim' as const }
      return null
    })
    if (res?.kind === 'resume') {
      // The id is a strict UUID from the agent's own terminal, typed behind the code-constant /resume prefix.
      const o = await inject(`/resume ${res.id}`)
      journal(`magic_compact -> "${peerId}": compacted, re-entered ${res.id.slice(0, 8)} (${o})`)
      return o
    }
    const o = await inject('/compact')
    const why = res?.kind === 'shim' ? 'plugin shim (not intercepted)' : 'no banner within timeout'
    journal(`magic_compact -> "${peerId}": ${why}, fell back to /compact (${o})`)
    return o
  })
}
