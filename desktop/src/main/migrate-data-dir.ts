// App-data migrations. They are NUMBERED oldest-first below but RUN
// newest-legacy-first (see runDataMigration at the bottom), which is what makes
// the most recent state win. The app-data root followed the app's names over
// time:
//
//   "claude-peers-deck"  (v0.1, the npm package name)     — userData only
//   "claude-peers-desk"  (v0.3+, harmonized with the launch-config dir)
//   "koryphaios"         (v0.7 rename: the app became Koryphaios)
//
// Migration 1 (deck -> desk era, kept for very old installs): copy the app
// state files (config.json + sessions.json) from "claude-peers-deck" into
// <userData>/config, never overwriting.
//
// Migration 2 (desk -> koryphaios): recursive, no-overwrite copy of the WHOLE
// legacy "claude-peers-desk" root into the new userData dir — launch config at
// the root, templates/, config/ app state, approvals… A copy (not a rename) so
// a rollback to an older build keeps working; encrypted scope secrets copy
// fine (safeStorage is machine-keyed, not folder-keyed).
//
// Everything is best-effort: any error is swallowed so a failed migration can
// never stop the app from launching with defaults.
//
// Both migrations copy WITHOUT overwriting, which makes them idempotent against
// an overwrite -- and, before the sentinel below, a permanent RE-SEED against a
// DELETION. runDataMigration runs at every app start (index.ts, top level), so
// any file the operator deleted was simply "missing at the destination" and was
// copied back at the next launch: deleting a template looked successful and the
// template was back after a relaunch (card eda86400). Each migration therefore
// records a completion sentinel under <userData>/.migrated/<name> and returns
// early when it is present. The sentinel is written only after a copy that
// actually succeeded AND actually had something to copy: a legacy folder that
// is absent or empty, and a copy that throws, are all still retried at the next
// boot. Both directions matter -- over-marking fails CLOSED (a rollback is
// never picked up) and is just as silent as the resurrection it replaced -- so
// each is pinned by a test.
//
// The marker is per MIGRATION, not per FILE, so a legacy folder that handed
// over AT LEAST ONE file is marked, and content added to it afterwards is NOT
// picked up. Deliberate: requiring every file (seen === MIGRATE_FILES.length)
// would leave the migration unmarked forever on any install holding only one of
// the two, which brings the resurrection straight back. Same residual family as
// the truncated destination below.
//
// Known residual, out of scope here: a destination file left TRUNCATED by an
// interrupted copy still satisfies `existsSync(to)`, so it is skipped and the
// sentinel then freezes it. Pre-existing, carded separately.
//
// Pure node builtins only (no electron) so it stays unit-testable under bun,
// like launch-config.ts and template-store.ts. ./log is electron-free for the
// same reason, so reporting a sentinel failure keeps that property.

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
 * Record `name` as done. Called ONLY after a copy that succeeded AND actually
 * had something to copy: marking a NO-OP would freeze the migration for good,
 * so a legacy root that gave nothing and is refilled later (rollback, backup
 * restore) would never be picked up. That mirror defect fails CLOSED and just
 * as silently, which is why both directions are pinned by tests. A root that
 * gave at least one file IS marked -- see the per-migration caveat in the file
 * header.
 *
 * The timestamp written inside is decorative: `migrationDone` only tests for
 * PRESENCE, so a truncated or empty marker still reads as done. That is
 * deliberate -- the marker is written after the copy completed, so its mere
 * existence carries the whole meaning; the date is there for a human reading
 * the folder.
 *
 * Best-effort, but never silent: losing the sentinel means the migration runs
 * again and can resurrect deleted files, which is exactly the defect this guard
 * exists for, so it has to leave a trace.
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
 * Run the full app-data consolidation. ORDER IS LOAD-BEARING: the desk root is
 * the more recent legacy, and both migrations copy without overwriting, so
 * whichever runs first wins the files they share (`<userData>/config/config.json`
 * above all). Swapping these two lines silently hands the app the OLDEST state,
 * with no error anywhere -- pinned by "the desk state wins over the deck state
 * when both legacy roots exist" in tests/desktop-data-migration.test.ts.
 */
export function runDataMigration(opts: { userDataDir: string }): void {
  migrateDeskToKoryphaios(opts.userDataDir)
  migrateUserDataDir(opts.userDataDir)
}
