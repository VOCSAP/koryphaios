// Shared --out handling for the win-verify scripts.
// Default output directory is desktop/scripts/win-verify/out/, already
// covered by the `out/` rule in desktop/.gitignore -- captures land there
// without needing per-script ignore entries. A capture kept as a fixture is
// copied by hand into tests/pty-harness/fixtures/.

import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_OUT_DIR = join(HERE, 'out')

/** Parses `--out <dir>` out of argv; returns DEFAULT_OUT_DIR when absent. */
export function parseOutDir(argv: string[]): string {
  const i = argv.indexOf('--out')
  const dir = i !== -1 && argv[i + 1] ? (argv[i + 1] as string) : DEFAULT_OUT_DIR
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Parses `--<name> <value>`; returns `fallback` when the flag is absent. */
export function parseArg(argv: string[], name: string, fallback: string): string {
  const i = argv.indexOf(`--${name}`)
  return i !== -1 && argv[i + 1] !== undefined ? (argv[i + 1] as string) : fallback
}

/** Parses a boolean `--<name>` presence flag. */
export function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`)
}
