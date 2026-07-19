// Rolling main-process log + central error reporting (PLAN-observabilite O3).
//
// In a packaged Electron app there is no terminal: every console.error is lost.
// This module gives the main process an on-disk, size-bounded trail under
// app.getPath('logs') and a single reportError() entry point that fans out to
// the file, the console (dev runs) and the activity journal.
//
// Mirrors shared/logger.ts (repo root) with Node fs only -- duplicated rather
// than imported, like broker-client.ts mirrors shared/config.ts, because the
// desktop tsconfig/vite roots stop at desktop/src. No electron imports so it
// is unit-testable under `bun test`: index.ts injects the directory.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'info' | 'warn' | 'error'

export interface RollingLogger {
  info(message: string, context?: unknown): void
  warn(message: string, context?: unknown): void
  error(message: string, context?: unknown): void
  readonly file: string
}

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
export const DEFAULT_MAX_FILES = 3

function renderContext(context: unknown): string {
  if (context === undefined) return ''
  if (context instanceof Error) {
    return ' ' + (context.stack ?? `${context.name}: ${context.message}`)
  }
  try {
    return ' ' + JSON.stringify(context)
  } catch {
    return ' ' + String(context)
  }
}

export interface RollingLoggerOptions {
  dir: string
  name: string
  maxBytes?: number
  maxFiles?: number
  mirrorToConsole?: boolean
  now?: () => Date
}

export function createRollingLogger(options: RollingLoggerOptions): RollingLogger {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES)
  const mirror = options.mirrorToConsole ?? true
  const now = options.now ?? (() => new Date())
  const file = join(options.dir, `${options.name}.log`)

  let dirReady = false
  let warnedWriteFailure = false

  function ensureDir(): void {
    if (dirReady) return
    mkdirSync(options.dir, { recursive: true })
    for (const entry of readdirSync(options.dir)) {
      const match = entry.match(new RegExp(`^${options.name}\\.log\\.(\\d+)$`))
      if (match && parseInt(match[1]!, 10) >= maxFiles) {
        try {
          unlinkSync(join(options.dir, entry))
        } catch {
          // Best-effort trim; a leftover file is harmless.
        }
      }
    }
    dirReady = true
  }

  function rotateIfNeeded(): void {
    let size = 0
    try {
      size = statSync(file).size
    } catch {
      return
    }
    if (size < maxBytes) return
    const oldest = `${file}.${maxFiles - 1}`
    if (existsSync(oldest)) unlinkSync(oldest)
    for (let n = maxFiles - 2; n >= 1; n--) {
      const src = `${file}.${n}`
      if (existsSync(src)) renameSync(src, `${file}.${n + 1}`)
    }
    if (maxFiles > 1) renameSync(file, `${file}.1`)
    else unlinkSync(file)
  }

  function write(level: LogLevel, message: string, context?: unknown): void {
    const line =
      `${now().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}` +
      renderContext(context)
    if (mirror) (level === 'info' ? console.log : console.error)(line)
    try {
      ensureDir()
      rotateIfNeeded()
      appendFileSync(file, line + '\n', 'utf-8')
    } catch (e) {
      if (!warnedWriteFailure) {
        warnedWriteFailure = true
        console.error(`[log] cannot write ${file}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  return {
    file,
    info: (m, c) => write('info', m, c),
    warn: (m, c) => write('warn', m, c),
    error: (m, c) => write('error', m, c)
  }
}

// ----- Singleton wiring (index.ts initializes, everyone reports) -----

let current: RollingLogger | null = null
let errorListener: ((scope: string, text: string) => void) | null = null

/** Bind the main-process logger to a directory (app.getPath('logs')). */
export function initDeckLog(dir: string): RollingLogger {
  current = createRollingLogger({ dir, name: 'main' })
  return current
}

/**
 * Register the journal hook: every reportError() also lands as an 'error'
 * journal entry so the operator sees failures in the Journal view.
 */
export function onDeckError(listener: (scope: string, text: string) => void): void {
  errorListener = listener
}

export function logInfo(scope: string, message: string): void {
  current?.info(`[${scope}] ${message}`)
}

export function logWarn(scope: string, message: string, context?: unknown): void {
  if (current) current.warn(`[${scope}] ${message}`, context)
  else console.error(`[${scope}] ${message}`, context)
}

/**
 * Central error sink for the main process: file + console (dev) + journal.
 * Never throws. Use for every caught-but-previously-silent failure.
 */
export function reportError(scope: string, message: string, error?: unknown): void {
  try {
    if (current) current.error(`[${scope}] ${message}`, error)
    else console.error(`[${scope}] ${message}`, error)
    const detail =
      error === undefined
        ? ''
        : `: ${error instanceof Error ? error.message : String(error)}`
    errorListener?.(scope, `${message}${detail}`)
  } catch {
    // A reporting failure must never cascade.
  }
}

/**
 * Persist the activity journal at quit (PLAN O3): one journal-<date>.log per
 * run under the logs dir, pruned after keepDays so the footprint stays
 * bounded. Returns the written path (or null on failure -- best-effort, quit
 * must proceed).
 */
export function flushJournalSnapshot(
  dir: string,
  text: string,
  keepDays = 7,
  now: () => Date = () => new Date()
): string | null {
  try {
    mkdirSync(dir, { recursive: true })
    const cutoff = now().getTime() - keepDays * 24 * 3600 * 1000
    for (const entry of readdirSync(dir)) {
      if (!/^journal-.*\.log$/.test(entry)) continue
      try {
        if (statSync(join(dir, entry)).mtimeMs < cutoff) unlinkSync(join(dir, entry))
      } catch {
        // Best-effort prune.
      }
    }
    if (!text.trim()) return null
    const stamp = now().toISOString().replace(/[:.]/g, '-')
    const path = join(dir, `journal-${stamp}.log`)
    writeFileSync(path, text + '\n', 'utf-8')
    return path
  } catch {
    return null
  }
}
