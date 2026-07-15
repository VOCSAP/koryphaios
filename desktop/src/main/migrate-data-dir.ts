// App-data migrations, chained oldest-first. The app-data root followed the
// app's names over time:
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
// Everything is best-effort and idempotent: any error is swallowed so a failed
// migration can never stop the app from launching with defaults.
//
// Pure node builtins only (no electron) so it stays unit-testable under bun,
// like launch-config.ts and template-store.ts.

import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** App-state files worth carrying over from the v0.1 userData folder. */
const MIGRATE_FILES = ['config.json', 'sessions.json'] as const

/**
 * Subfolder under userData where the app keeps its own state, kept separate
 * from the launch `config.json` that lives at the userData root. Single source
 * of truth shared by store.ts (writer) and the migration below.
 */
export const APP_STATE_SUBDIR = 'config'

/**
 * Migration 1: copy legacy "claude-peers-deck" userData files into
 * <userDataDir>/config. No-op when the legacy folder is absent or when a
 * destination file already exists (idempotent).
 */
export function migrateUserDataDir(userDataDir: string): void {
  try {
    const deckDir = join(dirname(userDataDir), 'claude-peers-deck')
    if (deckDir === userDataDir || !existsSync(deckDir)) return
    const destDir = join(userDataDir, APP_STATE_SUBDIR)
    for (const name of MIGRATE_FILES) {
      const from = join(deckDir, name)
      const to = join(destDir, name)
      if (!existsSync(from) || existsSync(to)) continue
      try {
        mkdirSync(destDir, { recursive: true })
        copyFileSync(from, to)
      } catch {
        // Skip a single unreadable/unwritable entry.
      }
    }
  } catch {
    // Migration must never break startup.
  }
}

/**
 * Migration 2: populate the "koryphaios" root from the sibling legacy
 * "claude-peers-desk" root. Recursive copy that never overwrites (force:false)
 * so re-runs and mixed old/new usage stay safe.
 */
export function migrateDeskToKoryphaios(userDataDir: string): void {
  try {
    const deskDir = join(dirname(userDataDir), 'claude-peers-desk')
    if (deskDir === userDataDir || !existsSync(deskDir)) return
    cpSync(deskDir, userDataDir, { recursive: true, force: false, errorOnExist: false })
  } catch {
    // Migration must never break startup.
  }
}

/** Run the full app-data consolidation, oldest migration first. */
export function runDataMigration(opts: { userDataDir: string }): void {
  migrateDeskToKoryphaios(opts.userDataDir)
  migrateUserDataDir(opts.userDataDir)
}
