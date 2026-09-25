import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync
} from 'node:fs'
import { join } from 'node:path'
import { Journal, type JournalEntry } from './journal'

export type LogLevel = 'info' | 'warn' | 'error'

export interface RollingLogger {
  info(message: string, context?: unknown): void
  warn(message: string, context?: unknown): void
  error(message: string, context?: unknown): void
  readonly file: string
}

export interface JournalWriter {
  write(entry: JournalEntry): void
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
  onWriteFailure?: (file: string, error: unknown) => void
}

export interface JournalWriterOptions {
  dir: string
  keepDays?: number
  maxBytes?: number
  maxFiles?: number
  now?: () => Date
  onWriteFailure?: (file: string, error: unknown) => void
}

export interface PersistentJournalOptions extends JournalWriterOptions {
  cap?: number
  entryNow?: () => number
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
        if (options.onWriteFailure) {
          try {
            options.onWriteFailure(file, e)
          } catch {
            console.error(`[log] cannot write ${file}: ${e instanceof Error ? e.message : String(e)}`)
          }
        } else {
          console.error(`[log] cannot write ${file}: ${e instanceof Error ? e.message : String(e)}`)
        }
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

let current: RollingLogger | null = null
let errorListener: ((scope: string, text: string) => void) | null = null

export function initDeckLog(dir: string): RollingLogger {
  current = createRollingLogger({ dir, name: 'main' })
  return current
}

function journalLine(entry: JournalEntry): string {
  return `[${entry.kind}] ${entry.text}`
}

function pruneJournalFiles(dir: string, keepDays: number, now: () => Date): void {
  mkdirSync(dir, { recursive: true })
  const cutoff = now().getTime() - keepDays * 24 * 3600 * 1000
  for (const entry of readdirSync(dir)) {
    if (!/^journal-.*\.log(?:\.\d+)?$/.test(entry)) continue
    if (statSync(join(dir, entry)).mtimeMs < cutoff) unlinkSync(join(dir, entry))
  }
}

export function createJournalWriter(options: JournalWriterOptions): JournalWriter {
  const now = options.now ?? (() => new Date())
  const keepDays = options.keepDays ?? 7
  const stamp = now().toISOString().replace(/[:.]/g, '-')
  let warnedPruneFailure = false
  let warnedWriteFailure = false
  const emitFailure = (file: string, error: unknown): void => {
    try {
      if (options.onWriteFailure) options.onWriteFailure(file, error)
      else console.error(`[log] cannot write ${file}: ${error instanceof Error ? error.message : String(error)}`)
    } catch {
      console.error(`[log] cannot write ${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const reportPruneFailure = (file: string, error: unknown): void => {
    if (warnedPruneFailure) return
    warnedPruneFailure = true
    emitFailure(file, error)
  }
  const reportWriteFailure = (file: string, error: unknown): void => {
    if (warnedWriteFailure) return
    warnedWriteFailure = true
    emitFailure(file, error)
  }
  const logger = createRollingLogger({
    dir: options.dir,
    name: `journal-${stamp}-${randomUUID()}`,
    maxBytes: options.maxBytes,
    maxFiles: options.maxFiles,
    mirrorToConsole: false,
    now,
    onWriteFailure: reportWriteFailure
  })
  try {
    pruneJournalFiles(options.dir, keepDays, now)
  } catch (error) {
    reportPruneFailure(logger.file, error)
  }
  return { file: logger.file, write: (entry) => logger.info(journalLine(entry)) }
}

export function createPersistentJournal(options: PersistentJournalOptions): Journal {
  const writer = createJournalWriter(options)
  return new Journal(options.cap, options.entryNow, writer.write)
}

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
