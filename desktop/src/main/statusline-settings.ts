// The settings file passed to Claude Code tiles as `--settings <file>`: it
// installs the Deck's statusLine script (hooks/desk-statusline.ts), which
// reports model + context fill and chains the operator's own status line.
// Pure node builtins, no electron import, so it is bun-testable.

import { createHash } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Seconds between idle statusLine runs; bounds how long a /model switch takes to show. */
export const STATUSLINE_REFRESH_S = 5

export const STATUSLINE_HOOK_FILE = 'desk-statusline.mjs'

export function statusLineHookPath(pluginDir: string): string {
  return join(pluginDir, 'hooks', STATUSLINE_HOOK_FILE)
}

/**
 * Characters that would break out of, or expand inside, the double-quoted path
 * in the statusLine command under either sh or cmd.
 */
const UNSAFE_PATH_CHARS = /["`$%!\r\n\0]/

/** True when `p` can sit inside double quotes on a command line without breaking out or expanding. */
export function isQuotableCommandPath(p: string): boolean {
  return p.length > 0 && !UNSAFE_PATH_CHARS.test(p)
}

/**
 * The settings JSON for a hook path, or null when the path cannot be quoted
 * safely into a shell command. win32 paths are turned to forward slashes,
 * which both bun and the shells accept, so no backslash reaches the command.
 */
export function buildStatusLineSettings(hookPath: string, plat: NodeJS.Platform = process.platform): string | null {
  const p = plat === 'win32' ? hookPath.replace(/\\/g, '/') : hookPath
  if (!isQuotableCommandPath(p)) return null
  return JSON.stringify({
    statusLine: { type: 'command', command: `bun "${p}"`, refreshInterval: STATUSLINE_REFRESH_S }
  })
}

/**
 * File name keyed by the content itself: the directory is shared by every
 * Deck window, and two builds (dev checkout, packaged app) point at different
 * hook paths, so one window can never rewrite the file another one launches.
 */
export function statusLineSettingsFileName(content: string): string {
  return `deck-statusline-${createHash('sha256').update(content).digest('hex').slice(0, 12)}.json`
}

/**
 * Write (atomically, temp + rename) the settings file for `hookPath` into
 * `dir` and return its path, or null when the hook path or the settings file's
 * own path (quoted into `--settings "<path>"`) is unusable. Throws on I/O
 * failure for the caller's error sink.
 */
export function writeStatusLineSettings(
  dir: string,
  hookPath: string,
  plat: NodeJS.Platform = process.platform
): string | null {
  const content = buildStatusLineSettings(hookPath, plat)
  if (!content) return null
  const file = join(dir, statusLineSettingsFileName(content))
  if (!isQuotableCommandPath(file)) return null
  mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, content, 'utf-8')
    renameSync(tmp, file)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
  return file
}
