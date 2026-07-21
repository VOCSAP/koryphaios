// File explorer service (PLAN GX4): READ-ONLY directory listings and file
// reads for the 📁 rail view. Node builtins only (no electron, no @shared
// alias) so it is unit-testable under `bun test` on a throwaway tree, like
// diff-service.ts.
//
// SECURITY: `root` is validated upstream (ipc.ts checks it against the
// allowed set — project dir, worktrees, live session cwds — on EVERY call);
// this module's job is that `rel` can never escape `root`, symlinks
// included (both the lexical path and its realpath must stay inside).

import { promises as fsp } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/** Cap on the file content shipped to the renderer. */
export const EXPLORER_READ_MAX = 512 * 1024
/** Leading bytes sniffed for a NUL to classify a file as binary. */
export const EXPLORER_SNIFF_BYTES = 8 * 1024

export interface ExplorerEntry {
  name: string
  dir: boolean
  /** Byte size (0 for directories). */
  size: number
}

export interface ExplorerFile {
  /** UTF-8 content, '' for binary files, capped at EXPLORER_READ_MAX. */
  content: string
  truncated: boolean
  binary: boolean
  /** Full on-disk byte size. */
  size: number
}

/**
 * Resolve `rel` inside `root`, refusing any escape: lexical traversal
 * (`../`), absolute paths, NUL bytes, and symlinks whose target leaves the
 * root. Returns the real (symlink-resolved) absolute path.
 */
export async function resolveWithin(root: string, rel: string): Promise<string> {
  if (typeof rel !== 'string' || rel.includes('\0')) throw new Error('invalid path')
  const rootReal = await fsp.realpath(resolve(root))
  const lexical = resolve(rootReal, rel)
  if (lexical !== rootReal && !lexical.startsWith(rootReal + sep)) {
    throw new Error(`path escapes the root: ${rel}`)
  }
  const real = await fsp.realpath(lexical)
  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    throw new Error(`path escapes the root (symlink): ${rel}`)
  }
  return real
}

/**
 * Entries of one directory (no recursion — the tree loads lazily). Dirs
 * first, then files, alphabetical. `.git` is hidden; broken symlinks and
 * special files (sockets, fifos) are skipped.
 */
export async function listExplorerDir(root: string, rel: string): Promise<ExplorerEntry[]> {
  const dir = await resolveWithin(root, rel)
  const names = await fsp.readdir(dir)
  const entries: ExplorerEntry[] = []
  for (const name of names) {
    if (name === '.git') continue
    try {
      const st = await fsp.stat(join(dir, name)) // follows symlinks
      if (st.isDirectory()) entries.push({ name, dir: true, size: 0 })
      else if (st.isFile()) entries.push({ name, dir: false, size: st.size })
    } catch {
      // Broken symlink / vanished entry: skipping it IS the correct listing.
    }
  }
  return entries.sort((a, b) =>
    a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)
  )
}

/**
 * Read one file, capped: binary files (NUL in the first EXPLORER_SNIFF_BYTES)
 * return no content, text files at most EXPLORER_READ_MAX bytes.
 */
export async function readExplorerFile(root: string, rel: string): Promise<ExplorerFile> {
  const path = await resolveWithin(root, rel)
  const st = await fsp.stat(path)
  if (!st.isFile()) throw new Error(`not a file: ${rel}`)
  const handle = await fsp.open(path, 'r')
  try {
    const sniff = Buffer.alloc(Math.min(st.size, EXPLORER_SNIFF_BYTES))
    await handle.read(sniff, 0, sniff.length, 0)
    if (sniff.includes(0)) {
      return { content: '', truncated: false, binary: true, size: st.size }
    }
    const cap = Math.min(st.size, EXPLORER_READ_MAX)
    const buf = Buffer.alloc(cap)
    await handle.read(buf, 0, cap, 0)
    return {
      content: buf.toString('utf-8'),
      truncated: st.size > EXPLORER_READ_MAX,
      binary: false,
      size: st.size
    }
  } finally {
    await handle.close()
  }
}
