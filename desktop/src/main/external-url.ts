// Gate for every URL the Deck hands to the operating system via
// shell.openExternal.
//
// This is hostile-input #4 territory (CLAUDE.md): the links that reach here are
// printed by a CLI running INSIDE a sandbox container, or by a page in the
// embedded browser -- code we assume can be compromised. shell.openExternal
// launches whatever the OS has registered for a scheme, so an unvalidated call
// is a "make the host run this handler" primitive. Only the two schemes a
// sign-in link can legitimately use are allowed; `file:`, `about:` and any
// custom protocol are refused, loudly.
//
// Node builtins only: bun-testable without an Electron runtime.

const ALLOWED = new Set(['http:', 'https:'])

/**
 * The URL if it is safe to open externally, else null. Callers must treat null
 * as an error worth journaling, never as a silent no-op.
 */
export function safeExternalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8192) return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    // Relative or malformed: there is no sane host-level meaning for it.
    return null
  }
  if (!ALLOWED.has(parsed.protocol)) return null
  return parsed.toString()
}
