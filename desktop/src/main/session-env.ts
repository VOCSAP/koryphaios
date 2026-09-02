// Pure env-construction helpers for session-service.ts, split out into their
// own dependency-free module (no electron/node-pty imports, same convention
// as session-command.ts/shell-command.ts/peer-state.ts) so they are directly
// unit-testable under `bun test` without pulling in SessionService's own
// hardcoded PtyManager -- which is not dependency-injected, so a genuinely
// behavioral test cannot instantiate the class itself (see
// tests/desktop-session-role-env.test.ts's own header on this exact limit).

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
