import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { globalConfigDir } from './launch-config'
import {
  PROJECT_SOURCES,
  isAbsentFileError,
  projectCreationPath,
  projectRootPath,
  traceInvalidFileOnce,
  traceScan
} from './project-files'
import type { SnippetSummary } from '../shared/types'

export type { SnippetSummary }

export const MAX_SNIPPET_BYTES = 64 * 1024

export function globalSnippetsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalConfigDir(env), 'snippets')
}

export function localSnippetsDir(projectDir: string): string {
  return projectCreationPath(projectDir, 'snippets')
}

export function localSnippetDirs(projectDir: string): string[] {
  return PROJECT_SOURCES.map((source) => join(projectRootPath(projectDir, source), 'snippets'))
}

function listDir(
  dir: string,
  source: 'global' | 'local',
  readDir: (dir: string) => string[]
): SnippetSummary[] {
  try {
    const scan = traceScan(dir)
    const out: SnippetSummary[] = []
    for (const f of [...readDir(dir)].sort()) {
      if (!f.toLowerCase().endsWith('.md')) continue
      const path = join(dir, f)
      try {
        if (statSync(path).size > MAX_SNIPPET_BYTES) continue
        const text = readFileSync(path, 'utf-8')
        if (!text.trim()) continue
        out.push({ path, name: f.replace(/\.md$/i, ''), source, text })
      } catch (error) {
        if (!isAbsentFileError(error)) scan.invalid(path, error)
      }
    }
    scan.done()
    return out.sort((a, b) => a.name.localeCompare(b.name))
  } catch (error) {
    if (!isAbsentFileError(error)) traceInvalidFileOnce(dir, error)
    return []
  }
}

export function listSnippets(
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
  readDir: (dir: string) => string[] = readdirSync
): SnippetSummary[] {
  const names = new Set<string>()
  const local: SnippetSummary[] = []
  for (const dir of localSnippetDirs(projectDir)) {
    for (const snippet of listDir(dir, 'local', readDir)) {
      if (names.has(snippet.name)) continue
      names.add(snippet.name)
      local.push(snippet)
    }
  }
  local.sort((a, b) => a.name.localeCompare(b.name))
  const global = listDir(globalSnippetsDir(env), 'global', readDir).filter((s) => !names.has(s.name))
  return [...local, ...global]
}

function safeBase(name: string): string {
  const b = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return b || 'snippet'
}

export function writeSnippet(dir: string, name: string, text: string): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${safeBase(name)}.md`)
  writeFileSync(file, text, 'utf-8')
  return file
}

export function deleteSnippet(
  path: string,
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  try {
    if (!path.toLowerCase().endsWith('.md')) return false
    const allowedDirs = [globalSnippetsDir(env), ...localSnippetDirs(projectDir)].map((dir) => resolve(dir))
    if (!allowedDirs.includes(resolve(dirname(path)))) return false
    if (!existsSync(path)) return false
    rmSync(path, { force: true })
    return true
  } catch {
    return false
  }
}
