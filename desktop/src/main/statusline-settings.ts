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

export function buildTileSettings(statusLineSettings?: string): string {
  return JSON.stringify({
    tui: 'default',
    env: { CLAUDE_CODE_NO_FLICKER: '0' },
    ...(statusLineSettings ? JSON.parse(statusLineSettings) : {})
  })
}

export function tileSettingsFileName(content: string): string {
  return `deck-tile-${createHash('sha256').update(content).digest('hex').slice(0, 12)}.json`
}

export function writeTileSettings(dir: string, content: string): string | null {
  const file = join(dir, tileSettingsFileName(content))
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
