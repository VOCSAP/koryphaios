// Atomic file write (M-LOG-1). A bare writeFileSync truncates the target before
// writing, so a crash / power-loss mid-write leaves a truncated file that the
// JSON readers then silently fall back on — wiping settings, encrypted provider
// keys, graph conversations or the operator inbox. Writing to a sibling temp
// file and renaming makes the replacement atomic on POSIX and Windows: a reader
// ever sees either the old complete file or the new complete one, never a torn
// one. Mirrors the pattern workspace-store.ts already uses.
//
// Node builtins only, so it stays unit-testable under bun.

import { renameSync, writeFileSync } from 'node:fs'

/** Write `data` to `file` atomically (temp file + rename). */
export function writeFileAtomic(file: string, data: string | Uint8Array): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, file)
}
