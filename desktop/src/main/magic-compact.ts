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
// Anchored to a "magic compact" mention so a generic "installed and enabled"
// line elsewhere in the output can't be mistaken for the shim.
const MAGIC_SHIM_RE =
  /magic[- ]?compact[\s\S]{0,200}?(hook failed to intercept|is installed and enabled)/i

/**
 * Strip ANSI escape sequences so terminal styling can't break a match. Every
 * pattern is ANCHORED to the ESC byte (\x1b): stripping bare `[`/`(` runs would
 * eat legitimate text like "[link]" or "(2 messages)". A final pass drops any
 * orphan ESC left by a partial sequence.
 *
 * Card 1aa69066 (H2) review, blocker F5: without an OSC pass, an OSC
 * sequence's leading ESC fell through to the LAST, catch-all
 * "orphan ESC" pass -- which strips ONLY that one byte, leaving the rest
 * of the OSC payload (title/progress/notify text, plus its BEL/ST
 * terminator) sitting in the output as ordinary VISIBLE text, worse than
 * doing nothing: `stripAnsi("A" + ESC + "]0;* Claude is working" + BEL +
 * "B")` measured `"A]0;* Claude is workingB"` before this pass existed --
 * the escape marker itself gone, the payload now indistinguishable from
 * real transcript content that `parseMagicResume`/`isMagicShimFailure`
 * then match against. Added as its OWN pass (not borrowed from
 * attention.ts/quota.ts/startup-ack.ts's shared ANSI_RE) deliberately: this
 * file already runs three sequential passes for reasons specific to THIS
 * parser (charset designation, orphan-ESC cleanup) that a wholesale swap to
 * another module's regex would risk losing. Class EXCLUDES ESC (not just
 * BEL) -- that exclusion, not the `{0,4096}` bound alongside it, is what
 * prevents the same quadratic blowup measured on attention.ts/quota.ts/
 * startup-ack.ts's own ANSI_RE (corrected false pointer, card 1aa69066
 * review round 3 T5 -- see attention.ts's ANSI_RE comment for the full
 * measurement; tests/desktop-osc-perf.test.ts pins both properties here
 * too, separately).
 */
export function stripAnsi(s: string): string {
  return (
    s
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI (colours, cursor moves)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[()][0-9A-Za-z]/g, '') // charset designation (ESC ( B ...)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b\n]{0,4096}(?:\x07|\x1b\\)/g, '') // OSC (title, progress, notify)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b/g, '') // any orphan ESC from a partial sequence
  )
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
 * Best-effort: is a Magic Compact plugin installed under <claudeConfigDir>/plugins?
 * `claudeConfigDir` is the resolved Claude config root (honors CLAUDE_CONFIG_DIR
 * upstream, so a relocated ~/.claude is still found). The exact on-disk layout
 * is not contractual, so this scans a few levels for any path segment matching
 * magic-compact. A false negative only means 'auto' mode falls back to /compact
 * (safe); 'on' mode attempts regardless.
 */
export function magicCompactPluginPresent(claudeConfigDir: string): boolean {
  return dirHasMagic(join(claudeConfigDir, 'plugins'), 3)
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
