import type { FsStat } from 'claude-code'

import { encodeFileHref, extensionOf, MAX_HREF, refusedSpelling, toAbsolute } from './linkify'

export type Stat = (path: string) => Promise<FsStat>

export type LinkContext = {
  cwd: string
  allowed: ReadonlySet<string>
  stat: Stat
}

function sameRoot(a: string, b: string): boolean {
  return /^[A-Za-z]:/.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b
}

// Stat'ing a path THROUGH a link to a network share makes the OS reach the share (an NTLM
// handshake on Windows), while stat'ing the link itself does not: so every component below
// the session's directory is stat'd on its own, and the walk stops at the first link.
async function reachesWithoutLinks(absolute: string, cwd: string, stat: Stat, memo: Map<string, Promise<FsStat | undefined>>): Promise<boolean> {
  const segments = absolute.split('/')
  const cwdAbsolute = toAbsolute('.', cwd)
  let first = 2
  if (cwdAbsolute !== undefined) {
    const cwdSegments = cwdAbsolute.split('/').filter((segment, i) => i === 0 || segment !== '')
    const under = cwdSegments.length < segments.length && cwdSegments.every((segment, i) => sameRoot(segment, segments[i]!))
    if (under) first = cwdSegments.length + 1
  }
  for (let end = first; end <= segments.length; end++) {
    const prefix = segments.slice(0, end).join('/')
    if (!memo.has(prefix)) memo.set(prefix, stat(prefix).then(found => found, () => undefined))
    const found = await memo.get(prefix)!
    if (found === undefined || found.isLink) return false
    if (found.kind !== (end === segments.length ? 'file' : 'dir')) return false
  }
  return true
}

export async function resolveHrefs(paths: readonly string[], context: LinkContext, limit: number): Promise<Map<string, string>> {
  const hrefs = new Map<string, string>()
  const memo = new Map<string, Promise<FsStat | undefined>>()
  const eligible = [...new Set(paths)].filter(path => context.allowed.has(extensionOf(path)) && refusedSpelling(path) === undefined)
  for (const path of eligible.slice(0, limit)) {
    const absolute = toAbsolute(path, context.cwd)
    if (absolute === undefined) continue
    const href = encodeFileHref(absolute)
    if (href.length > MAX_HREF) continue
    if (await reachesWithoutLinks(absolute, context.cwd, context.stat, memo)) hrefs.set(path, href)
  }
  return hrefs
}
