// Live xterm instances by session id, registered by TerminalTile on mount.
// Lets the cross-session search bar scan every open buffer and drive the
// scroll/selection of the target terminal without threading refs through React.

import type { Terminal } from '@xterm/xterm'

const terminals = new Map<string, Terminal>()

export function registerTerminal(id: string, term: Terminal): void {
  terminals.set(id, term)
}

/** Unregister only if `term` is still the registered instance (StrictMode remounts). */
export function unregisterTerminal(id: string, term: Terminal): void {
  if (terminals.get(id) === term) terminals.delete(id)
}

export function getTerminal(id: string): Terminal | undefined {
  return terminals.get(id)
}
