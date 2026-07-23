// Magic Compact chain (CT4): detection + output parsing for the aerovato
// Magic-compact plugin. The plugin intercepts /magic-compact (UserPromptSubmit
// hook), compacts the transcript deterministically (no LLM), writes a NEW
// session and prints "To enter the compacted session, run: /resume <id>". The
// Deck captures that id and re-enters in place (option A), or falls back to
// /compact on the shim-failure message or a timeout.
//
// Pure parsing + a best-effort fs probe (no electron); regexes are unit-tested.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Hook timeout is 150 s; give the capture a little more headroom (CT4). */
export const MAGIC_TIMEOUT_MS = 160_000

// The success banner. ANSI is stripped before matching, so we only tolerate a
// bounded gap between the sentence and the /resume line (the plugin prints them
// on adjacent lines). The id is a strict UUID.
const MAGIC_RESUME_RE =
  /to enter the compacted session[\s\S]{0,240}?\/resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
// The shim fires when the hook did NOT intercept (plugin missing/disabled).
const MAGIC_SHIM_RE = /magic compact hook failed to intercept|plugin is installed and enabled/i

/** Strip common ANSI escape sequences so terminal styling can't break a match. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[()][0-9A-Za-z]/g, '')
}

/** The compacted session id from the plugin's success banner, or null. */
export function parseMagicResume(buf: string): string | null {
  const m = stripAnsi(buf).match(MAGIC_RESUME_RE)
  return m ? m[1]! : null
}

/** True when the buffer shows the shim (the plugin did not intercept). */
export function isMagicShimFailure(buf: string): boolean {
  return MAGIC_SHIM_RE.test(stripAnsi(buf))
}

/**
 * Best-effort: is a Magic Compact plugin installed under ~/.claude/plugins? The
 * exact on-disk layout is not contractual, so this scans a few levels for any
 * path segment matching magic-compact. A false negative only means 'auto' mode
 * falls back to /compact (safe); 'on' mode attempts regardless.
 */
export function magicCompactPluginPresent(home: string): boolean {
  return dirHasMagic(join(home, '.claude', 'plugins'), 3)
}

function dirHasMagic(dir: string, depth: number): boolean {
  if (depth < 0 || !existsSync(dir)) return false
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return false
  }
  for (const e of entries) {
    if (/magic-?compact/i.test(e)) return true
  }
  for (const e of entries) {
    const child = join(dir, e)
    try {
      if (statSync(child).isDirectory() && dirHasMagic(child, depth - 1)) return true
    } catch {
      // unreadable entry -> skip
    }
  }
  return false
}
