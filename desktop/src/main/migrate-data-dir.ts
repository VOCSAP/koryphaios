// Migrations are numbered oldest-first but run newest-legacy-first, so the most
// recent state wins when both apply. Both copy without overwriting and record a
// per-migration completion sentinel, written only after a copy that actually
// succeeded and had something to copy — an absent/empty legacy folder, or a
// copy that throws, is retried at the next boot.
// Marking is per migration, not per file: a folder that handed over at least
// one file is marked, and content added to it afterward is not picked up.
// Everything is best-effort: any error is swallowed so a failed migration never
// blocks the app from launching with defaults.

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { reportError } from './log'

/** App-state files worth carrying over from the v0.1 userData folder. */
const MIGRATE_FILES = ['config.json', 'sessions.json'] as const

/**
 * Subfolder under userData where the app keeps its own state, kept separate
 * from the launch `config.json` that lives at the userData root. Single source
 * of truth shared by store.ts (writer) and the migration below.
 */
export const APP_STATE_SUBDIR = 'config'

/** Subfolder under userData holding one marker file per completed migration. */
export const MIGRATION_MARKER_SUBDIR = '.migrated'

/** Marker names, one per migration in runDataMigration. */
const MARKER_DESK_TO_KORYPHAIOS = 'desk-to-koryphaios'
const MARKER_DECK_USERDATA = 'deck-userdata'

/**
 * Has `name` already run against this userData dir? A read that throws answers
 * false, so the failure direction is "copy again", never "skip silently".
 */
function migrationDone(userDataDir: string, name: string): boolean {
  try {
    return existsSync(join(userDataDir, MIGRATION_MARKER_SUBDIR, name))
  } catch {
    return false
  }
}

/**
 * Called only after a copy that succeeded and actually had something to copy:
 * marking a no-op would freeze the migration for good, so a legacy root
 * refilled later (rollback, restore) would never be picked up.
 * migrationDone only tests for presence, so a truncated or empty marker still
 * reads as done — the timestamp inside is decorative, there for a human reading
 * the folder.
 */
function markMigrationDone(userDataDir: string, name: string): void {
  const file = join(userDataDir, MIGRATION_MARKER_SUBDIR, name)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${new Date().toISOString()}\n`, 'utf-8')
  } catch (err) {
    reportError(
      'migrate-data-dir',
      `could not write the "${name}" migration sentinel at ${file}; the migration will run again at the next launch and may restore files deleted since`,
      err
    )
  }
}

/**
 * Migration 1: copy legacy "claude-peers-deck" userData files into
 * <userDataDir>/config. No-op when the legacy folder is absent or when a
 * destination file already exists (idempotent).
 */
export function migrateUserDataDir(userDataDir: string): void {
  try {
    if (migrationDone(userDataDir, MARKER_DECK_USERDATA)) return
    const deckDir = join(dirname(userDataDir), 'claude-peers-deck')
    if (deckDir === userDataDir || !existsSync(deckDir)) return
    const destDir = join(userDataDir, APP_STATE_SUBDIR)
    let failed = false
    let seen = 0
    for (const name of MIGRATE_FILES) {
      const from = join(deckDir, name)
      const to = join(destDir, name)
      if (!existsSync(from)) continue
      // Counted as seen even when the destination already holds it: there was
      // something to migrate and there is nothing left to do. Only a legacy
      // folder that offered NOTHING leaves the migration unmarked.
      seen++
      if (existsSync(to)) continue
      try {
        mkdirSync(destDir, { recursive: true })
        copyFileSync(from, to)
      } catch (err) {
        // Skip a single unreadable/unwritable entry -- and leave the migration
        // unmarked so the next launch retries it.
        failed = true
        reportError('migrate-data-dir', `could not copy legacy ${name} into ${destDir}`, err)
      }
    }
    if (seen > 0 && !failed) markMigrationDone(userDataDir, MARKER_DECK_USERDATA)
  } catch (err) {
    // Migration must never break startup.
    reportError('migrate-data-dir', 'the claude-peers-deck userData migration failed', err)
  }
}

/**
 * Migration 2: populate the "koryphaios" root from the sibling legacy
 * "claude-peers-desk" root. Recursive copy that never overwrites (force:false)
 * so re-runs and mixed old/new usage stay safe.
 */
export function migrateDeskToKoryphaios(userDataDir: string): void {
  try {
    if (migrationDone(userDataDir, MARKER_DESK_TO_KORYPHAIOS)) return
    const deskDir = join(dirname(userDataDir), 'claude-peers-desk')
    if (deskDir === userDataDir || !existsSync(deskDir)) return
    // A legacy root that exists but is EMPTY has nothing to hand over, and
    // cpSync would happily succeed on it. Marking that would freeze the
    // migration and lose a rollback or a backup restored into it later.
    if (readdirSync(deskDir).length === 0) return
    cpSync(deskDir, userDataDir, { recursive: true, force: false, errorOnExist: false })
    markMigrationDone(userDataDir, MARKER_DESK_TO_KORYPHAIOS)
  } catch (err) {
    // Migration must never break startup. No sentinel: the next launch retries.
    reportError('migrate-data-dir', 'the claude-peers-desk root migration failed', err)
  }
}

/**
 * Order is load-bearing: the desk root is the more recent legacy, and both
 * migrations copy without overwriting, so whichever runs first wins the files
 * they share. Swapping these two lines silently hands the app the oldest state,
 * with no error anywhere.
 */
export function runDataMigration(opts: { userDataDir: string }): void {
  migrateDeskToKoryphaios(opts.userDataDir)
  migrateUserDataDir(opts.userDataDir)
}
