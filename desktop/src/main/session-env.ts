/**
 * Card 3c085f1a: the CLAUDE_PEERS_TOOLS env value for a session's peerTools
 * allow-list. undefined `peerTools` (no embedded profile, or a profile that
 * sets no list) returns undefined -- the caller must then leave the key OFF
 * the session env entirely, never set it to ''. Server.ts's own three-state
 * contract treats "absent" (full surface) and "present but empty" (zero
 * tools) as opposites, so collapsing undefined to '' here would silently
 * mute every session launched outside Kory (or by a profile with no list)
 * instead of leaving it unrestricted. A defined-but-empty array therefore
 * still returns the (falsy but DEFINED) string '', not undefined.
 */
export function peerToolsEnvValue(peerTools: string[] | undefined): string | undefined {
  return peerTools === undefined ? undefined : peerTools.join(',')
}
