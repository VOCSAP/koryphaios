import { realpath as realpathCallback } from 'node:fs'
import { lstat, readlink, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { promisify } from 'node:util'
import { NEVER_OPENED_EXTENSIONS } from '../shared/link-policy'
import type { LinkIntent, LinkOutcome, LinkRefusal } from '../shared/types'
import { safeExternalUrl } from './external-url'

// A link target is text an agent wrote: nothing the renderer says is trusted, so every check is repeated here.

const MAX_TARGET_LENGTH = 8192
const MAX_LINK_HOPS = 16
const MAX_READLINKS = 64
const SCHEME_RE = /^([A-Za-z][A-Za-z0-9+.-]*):/

export interface LinkOpenerDeps {
  shell: {
    openExternal(url: string): Promise<void>
    showItemInFolder(path: string): void
    /** Electron's contract: '' on success, else the error text. */
    openPath(path: string): Promise<string>
  }
  fs: {
    realpath(path: string): Promise<string>
    isDirectory(path: string): Promise<boolean>
    /** Target of the symlink at `path`, null when it is not one; rejects when `path` does not exist. */
    readlink(path: string): Promise<string | null>
  }
  /** Read at every call: the operator edits both lists in Settings while the app runs. */
  policy(): { extensions: readonly string[]; exclusions: readonly string[] }
  home: string
  platform: NodeJS.Platform
  reportError(scope: string, message: string, err?: unknown): void
}

export interface LinkOpener {
  open(target: unknown, intent: unknown): Promise<LinkOutcome>
}

/** The production filesystem adapter: `realpath` is libuv's native one, which expands Windows 8.3 names. */
export function nodeLinkFs(): LinkOpenerDeps['fs'] {
  return {
    realpath: promisify(realpathCallback.native),
    isDirectory: async (path) => (await stat(path)).isDirectory(),
    readlink: async (path) => ((await lstat(path)).isSymbolicLink() ? readlink(path) : null)
  }
}

type Parsed = { kind: 'url'; url: string } | { kind: 'path'; path: string } | { kind: 'refused'; reason: LinkRefusal }

export function createLinkOpener(deps: LinkOpenerDeps): LinkOpener {
  const p = deps.platform === 'win32' ? win32 : posix
  const sameCase = (s: string): string => (deps.platform === 'win32' ? s.toLowerCase() : s)

  // `\\host\share`, `//host/x`, `\\?\`, `\\.\`: a stat on any of them can open
  // an SMB session to a host the agent chose.
  const isNetworkOrDevicePath = (s: string): boolean => /^[\\/]{2}/.test(s)

  function parse(target: string): Parsed {
    const scheme = SCHEME_RE.exec(target)?.[1]
    if (scheme !== undefined && scheme.length > 1) {
      const lower = scheme.toLowerCase()
      if (lower === 'http' || lower === 'https') {
        const url = safeExternalUrl(target)
        return url === null ? { kind: 'refused', reason: 'invalid' } : { kind: 'url', url }
      }
      if (lower !== 'file') return { kind: 'refused', reason: 'invalid' }
      let url: URL
      try {
        url = new URL(target)
      } catch {
        return { kind: 'refused', reason: 'invalid' }
      }
      if (url.host !== '' && url.host !== 'localhost') return { kind: 'refused', reason: 'network-path' }
      let decoded: string
      try {
        decoded = decodeURIComponent(url.pathname)
      } catch {
        return { kind: 'refused', reason: 'invalid' }
      }
      if (decoded.includes('\0')) return { kind: 'refused', reason: 'invalid' }
      return finishPath(deps.platform === 'win32' ? decoded.replace(/^\/(?=[A-Za-z]:)/, '') : decoded)
    }
    if (target.includes('\0')) return { kind: 'refused', reason: 'invalid' }
    if (target === '~' || target.startsWith('~/') || target.startsWith('~\\')) {
      return finishPath(p.join(deps.home, target.slice(1)))
    }
    return finishPath(target)
  }

  function finishPath(path: string): Parsed {
    if (isNetworkOrDevicePath(path)) return { kind: 'refused', reason: 'network-path' }
    if (!p.isAbsolute(path) || (deps.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(path))) {
      return { kind: 'refused', reason: 'invalid' }
    }
    return { kind: 'path', path: p.normalize(path) }
  }

  const within = (path: string, root: string): boolean => {
    const a = sameCase(path)
    const b = sameCase(root)
    return a === b || a.startsWith(b.endsWith(p.sep) ? b : b + p.sep)
  }

  // `C:\a.png:stream` is an alternate data stream: a different object under the same name.
  const hasStreamSuffix = (path: string): boolean => deps.platform === 'win32' && path.slice(2).includes(':')

  const expandHome = (entry: string): string =>
    entry.startsWith('~/') || entry.startsWith('~\\') ? p.join(deps.home, entry.slice(1)) : entry

  // The entry itself may be a link (a dotfile directory symlinked elsewhere), so both the written and the resolved form are compared.
  async function isExcluded(real: string, exclusions: readonly string[]): Promise<boolean> {
    for (const entry of exclusions) {
      if (!/[\\/]/.test(entry)) {
        if (real.split(/[\\/]/).some((segment) => sameCase(segment) === sameCase(entry))) return true
        continue
      }
      const written = p.normalize(expandHome(entry))
      if (within(real, written)) return true
      try {
        if (within(real, await deps.fs.realpath(written))) return true
      } catch (e) {
        const code = (e as NodeJS.ErrnoException | undefined)?.code
        if (code === 'ENOENT' || code === 'ENOTDIR') continue
        deps.reportError('links', `exclusion entry unreadable: ${entry.slice(0, 200)}`, e)
        return true
      }
    }
    return false
  }

  // `realpath` follows a symlink onto a UNC target by itself, so every component is read first.
  // A read that fails for a reason other than "not there" cannot prove the path is local.
  // A prefix is skipped once it and the link it holds are fully followed: targets sharing a long parent would otherwise exhaust the read budget.
  async function linkRefusal(path: string): Promise<LinkRefusal | null> {
    const budget = { reads: 0 }
    const followed = new Set<string>()
    async function walk(current: string, hops: number): Promise<LinkRefusal | null> {
      if (hops > MAX_LINK_HOPS) return 'network-path'
      const prefixes: string[] = []
      for (let dir = current; ; ) {
        prefixes.unshift(dir)
        const parent = p.dirname(dir)
        if (parent === dir) break
        dir = parent
      }
      for (const prefix of prefixes) {
        if (followed.has(sameCase(prefix))) continue
        if (++budget.reads > MAX_READLINKS) return 'network-path'
        let target: string | null
        try {
          target = await deps.fs.readlink(prefix)
        } catch (e) {
          const code = (e as NodeJS.ErrnoException | undefined)?.code
          if (code === 'ENOENT' || code === 'ENOTDIR') return null
          deps.reportError('links', `readlink failed: ${prefix.slice(0, 200)}`, e)
          return 'failed'
        }
        if (target !== null) {
          if (isNetworkOrDevicePath(target)) return 'network-path'
          const nested = await walk(p.resolve(p.dirname(prefix), target), hops + 1)
          if (nested !== null) return nested
        }
        followed.add(sameCase(prefix))
      }
      return null
    }
    return walk(path, 0)
  }

  function refuse(reason: LinkRefusal, target: string): LinkOutcome {
    deps.reportError('links', `link refused (${reason}): ${target.slice(0, 200)}`)
    return { ok: false, reason }
  }

  async function open(rawTarget: unknown, rawIntent: unknown): Promise<LinkOutcome> {
    if (typeof rawTarget !== 'string' || rawTarget.length === 0 || rawTarget.length > MAX_TARGET_LENGTH) {
      return refuse('invalid', String(rawTarget).slice(0, 200))
    }
    if (rawIntent !== 'reveal' && rawIntent !== 'open') return refuse('invalid', rawTarget)
    const intent: LinkIntent = rawIntent
    const parsed = parse(rawTarget)
    if (parsed.kind === 'refused') return refuse(parsed.reason, rawTarget)
    if (parsed.kind === 'url') {
      try {
        await deps.shell.openExternal(parsed.url)
        return { ok: true }
      } catch (e) {
        deps.reportError('links', `openExternal failed: ${parsed.url.slice(0, 200)}`, e)
        return { ok: false, reason: 'failed' }
      }
    }

    if (hasStreamSuffix(parsed.path)) return refuse('invalid', parsed.path)

    try {
      return await openLocal(parsed.path, intent)
    } catch (e) {
      deps.reportError('links', `link open failed: ${parsed.path.slice(0, 200)}`, e)
      return { ok: false, reason: 'failed' }
    }
  }

  async function openLocal(path: string, intent: LinkIntent): Promise<LinkOutcome> {
    const linkProblem = await linkRefusal(path)
    if (linkProblem !== null) return refuse(linkProblem, path)

    let real: string
    try {
      real = await deps.fs.realpath(path)
    } catch {
      return refuse('not-found', path)
    }
    // A junction or a mapped drive can resolve onto a network path.
    if (isNetworkOrDevicePath(real)) return refuse('network-path', path)
    if (hasStreamSuffix(real)) return refuse('invalid', path)

    // A directory is only ever shown: it can become a file named x.exe between this check and a launch, and a .app folder launches on macOS.
    if (await deps.fs.isDirectory(real)) {
      deps.shell.showItemInFolder(real)
      return { ok: true }
    }
    if (intent === 'reveal') {
      // Revealing returns no data to the agent, so any existing local path may be shown, work dir or not.
      deps.shell.showItemInFolder(real)
      return { ok: true }
    }
    const { extensions, exclusions } = deps.policy()
    const extension = p.extname(real).toLowerCase()
    const neverOpened = NEVER_OPENED_EXTENSIONS.has(extension)
    if ((!neverOpened && !extensions.includes(extension)) || (await isExcluded(real, exclusions))) {
      return refuse('not-allowed', path)
    }
    if (neverOpened) {
      deps.shell.showItemInFolder(real)
      return { ok: true }
    }
    const failure = await deps.shell.openPath(real)
    if (failure !== '') {
      deps.reportError('links', `openPath failed: ${failure}`)
      return { ok: false, reason: 'failed' }
    }
    return { ok: true }
  }

  return { open }
}
