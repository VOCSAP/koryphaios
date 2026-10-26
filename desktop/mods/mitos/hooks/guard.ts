import type { FsStat } from 'claude-code'

import { encodeFileHref, EXECUTABLE_FLOOR, extensionOf, MAX_HREF, refusedSpelling, toAbsolute } from './linkify'

export type Stat = (path: string) => Promise<FsStat>

export type LinkContext = {
  cwd: string
  allowed: ReadonlySet<string>
  stat: Stat
}

function sameRoot(a: string, b: string): boolean {
  return /^[A-Za-z]:/.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b
}

type Kind = FsStat['kind']

function lastName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

// A name has an extension when a dot other than its first character is in it: `md` and `.md` have none.
function hasExtension(name: string): boolean {
  return name.lastIndexOf('.') > 0
}

// The spelling decides what the path may name: a file needs an allowed extension; a directory needs
// a root or a final separator and no extension, since a bundle (`Evil.app/`) runs when opened and a
// folder's href is the one a file swapped in before the click opens. A leading-dot name such as
// `.claude` stays a directory unless the rest is an executable extension (`.exe`).
function acceptedKinds(path: string, allowed: ReadonlySet<string>): ReadonlySet<Kind> {
  const kinds = new Set<Kind>()
  const name = lastName(path)
  if (hasExtension(name) && allowed.has(extensionOf(name))) kinds.add('file')
  const bareName = lastName(path.replace(/[\\/]$/, ''))
  const plainFolder = !hasExtension(bareName) && !(bareName.startsWith('.') && EXECUTABLE_FLOOR.has(extensionOf(bareName)))
  if (/^(?:[A-Za-z]:)?[\\/]|[\\/]$/.test(path) && plainFolder) kinds.add('dir')
  return kinds
}

// Stat'ing a path THROUGH a link to a network share makes the OS reach the share (an NTLM
// handshake on Windows), while stat'ing the link itself does not: so every component below
// the session's directory is stat'd on its own, and the walk stops at the first link.
async function reachesWithoutLinks(absolute: string, cwd: string, kinds: ReadonlySet<Kind>, stat: Stat, memo: Map<string, Promise<FsStat | undefined>>): Promise<boolean> {
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
    if (end === segments.length ? !kinds.has(found.kind) : found.kind !== 'dir') return false
  }
  return true
}

export async function resolveHrefs(paths: readonly string[], context: LinkContext, limit: number): Promise<Map<string, string>> {
  const hrefs = new Map<string, string>()
  const memo = new Map<string, Promise<FsStat | undefined>>()
  const eligible = [...new Set(paths)]
    .map(path => ({ path, kinds: acceptedKinds(path, context.allowed) }))
    .filter(({ path, kinds }) => kinds.size > 0 && refusedSpelling(path) === undefined)
  for (const { path, kinds } of eligible.slice(0, limit)) {
    const absolute = toAbsolute(path, context.cwd)
    if (absolute === undefined) continue
    const href = encodeFileHref(absolute)
    if (href.length > MAX_HREF) continue
    if (await reachesWithoutLinks(absolute, context.cwd, kinds, context.stat, memo)) hrefs.set(path, href)
  }
  return hrefs
}
