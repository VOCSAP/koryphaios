import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLinkOpener, nodeLinkFs, type LinkOpenerDeps } from '../desktop/src/main/link-opener'
import { DEFAULT_LINK_EXCLUSIONS, DEFAULT_LINK_EXTENSIONS } from '../desktop/src/shared/link-policy'

interface Calls {
  external: string[]
  shown: string[]
  opened: string[]
  realpaths: string[]
  readlinks: string[]
  reports: string[]
}

const errno = (code: string): Error => Object.assign(new Error(code), { code })

function harness(
  platform: NodeJS.Platform,
  opts: {
    existing?: Record<string, string>
    dirs?: string[]
    links?: Record<string, string>
    /** Paths whose readlink or realpath rejects with this errno code. */
    readlinkErrors?: Record<string, string>
    realpathErrors?: Record<string, string>
    openPathResult?: string
    statFails?: boolean
    policy?: { extensions: string[]; exclusions: string[] }
  } = {}
): { opener: ReturnType<typeof createLinkOpener>; calls: Calls; policy: { extensions: string[]; exclusions: string[] } } {
  const calls: Calls = { external: [], shown: [], opened: [], realpaths: [], readlinks: [], reports: [] }
  const home = platform === 'win32' ? 'C:\\Users\\op' : '/home/op'
  const policy = opts.policy ?? { extensions: [...DEFAULT_LINK_EXTENSIONS], exclusions: [...DEFAULT_LINK_EXCLUSIONS] }
  const deps: LinkOpenerDeps = {
    shell: {
      openExternal: async (url) => void calls.external.push(url),
      showItemInFolder: (path) => void calls.shown.push(path),
      openPath: async (path) => {
        calls.opened.push(path)
        return opts.openPathResult ?? ''
      }
    },
    fs: {
      realpath: async (path) => {
        calls.realpaths.push(path)
        const code = opts.realpathErrors?.[path]
        if (code !== undefined) throw errno(code)
        const real = opts.existing?.[path]
        if (real === undefined) throw errno('ENOENT')
        return real
      },
      isDirectory: async (path) => {
        if (opts.statFails) throw new Error('EACCES')
        return opts.dirs?.includes(path) ?? false
      },
      readlink: async (path) => {
        calls.readlinks.push(path)
        const code = opts.readlinkErrors?.[path]
        if (code !== undefined) throw errno(code)
        return opts.links?.[path] ?? null
      }
    },
    policy: () => ({ ...policy }),
    home,
    platform,
    reportError: (_scope, message) => void calls.reports.push(message)
  }
  return { opener: createLinkOpener(deps), calls, policy }
}

describe('link-opener: schemes', () => {
  test('http(s) goes to the browser and never touches the filesystem', async () => {
    const { opener, calls } = harness('linux')
    expect(await opener.open('https://example.com/a?b=1', 'reveal')).toEqual({ ok: true })
    expect(calls.external).toEqual(['https://example.com/a?b=1'])
    expect(calls.realpaths).toEqual([])
  })

  test.each(['javascript:alert(1)', 'ftp://host/x', 'vscode://file/x', 'data:text/html,hi', 'about:blank'])(
    'scheme %s is refused as invalid before any fs or shell call',
    async (target) => {
      const { opener, calls } = harness('linux')
      expect(await opener.open(target, 'open')).toEqual({ ok: false, reason: 'invalid' })
      expect([calls.external, calls.shown, calls.opened, calls.realpaths]).toEqual([[], [], [], []])
    }
  )
})

describe('link-opener: network and device paths are refused before any fs call', () => {
  test.each([
    ['win32', '\\\\attacker\\share\\a.png'],
    ['win32', '//attacker/share/a.png'],
    ['win32', '\\\\?\\C:\\a.png'],
    ['win32', '\\\\.\\PhysicalDrive0'],
    ['win32', 'file://attacker/share/a.png'],
    ['linux', '//attacker/share/a.png'],
    ['linux', 'file://attacker/share/a.png']
  ] as const)('%s %s', async (platform, target) => {
    const { opener, calls } = harness(platform)
    expect(await opener.open(target, 'reveal')).toEqual({ ok: false, reason: 'network-path' })
    expect(calls.realpaths, 'a stat or realpath on a UNC path opens an SMB session to the agent-chosen host').toEqual([])
  })

  test('a path whose realpath lands on a UNC share is refused', async () => {
    const { opener, calls } = harness('win32', { existing: { 'Z:\\mapped\\a.png': '\\\\server\\share\\a.png' } })
    expect(await opener.open('Z:\\mapped\\a.png', 'reveal')).toEqual({ ok: false, reason: 'network-path' })
    expect(calls.shown).toEqual([])
  })

  test('a symlink component whose target is a network path is refused before realpath follows it', async () => {
    const { opener, calls } = harness('win32', {
      links: { 'C:\\work\\link': '\\\\127.0.0.1\\share\\x' },
      existing: { 'C:\\work\\link\\a.png': 'C:\\work\\link\\a.png' }
    })
    expect(await opener.open('C:\\work\\link\\a.png', 'reveal')).toEqual({ ok: false, reason: 'network-path' })
    expect(calls.realpaths, 'realpath on a symlink to a UNC share opens the SMB session itself').toEqual([])
  })

  test('a chain of symlinks is followed hop by hop and a loop is refused', async () => {
    const chain = harness('linux', {
      links: { '/w/a': '/w/b', '/w/b': '//host/share' },
      existing: { '/w/a/x.png': '/w/a/x.png' }
    })
    expect(await chain.opener.open('/w/a/x.png', 'reveal')).toEqual({ ok: false, reason: 'network-path' })
    const loop = harness('linux', { links: { '/w/a': '/w/b', '/w/b': '/w/a' }, existing: { '/w/a/x.png': '/w/a/x.png' } })
    expect(await loop.opener.open('/w/a/x.png', 'reveal')).toEqual({ ok: false, reason: 'network-path' })
  })

  test('a symlink to a local target is not a refusal', async () => {
    const { opener, calls } = harness('linux', { links: { '/w/a': '/elsewhere' }, existing: { '/w/a/x.png': '/elsewhere/x.png' } })
    expect(await opener.open('/w/a/x.png', 'reveal')).toEqual({ ok: true })
    expect(calls.shown).toEqual(['/elsewhere/x.png'])
  })
})

describe('link-opener: parsing', () => {
  test('file:///C:/... with an encoded space resolves to a Windows path', async () => {
    const { opener, calls } = harness('win32', { existing: { 'C:\\proj\\my file.md': 'C:\\proj\\my file.md' } })
    expect(await opener.open('file:///C:/proj/my%20file.md', 'reveal')).toEqual({ ok: true })
    expect(calls.realpaths).toEqual(['C:\\proj\\my file.md'])
  })

  test('~/ expands against the injected home, ~\\ too, and ~user is not a home reference', async () => {
    const win = harness('win32', { existing: { 'C:\\Users\\op\\.claude\\plugins': 'C:\\Users\\op\\.claude\\plugins' }, dirs: ['C:\\Users\\op\\.claude\\plugins'] })
    expect(await win.opener.open('~/.claude/plugins', 'reveal')).toEqual({ ok: true })
    expect(await win.opener.open('~\\.claude\\plugins', 'reveal')).toEqual({ ok: true })
    expect(win.calls.shown).toEqual(['C:\\Users\\op\\.claude\\plugins', 'C:\\Users\\op\\.claude\\plugins'])
    const posix = harness('linux')
    expect(await posix.opener.open('~root/x', 'reveal')).toEqual({ ok: false, reason: 'invalid' })
  })

  test.each([
    [42, 'reveal'],
    ['', 'reveal'],
    ['relative/path.md', 'reveal'],
    ['C:relative.md', 'reveal'],
    ['/a/b\0c', 'reveal'],
    ['x'.repeat(8193), 'reveal'],
    ['/a/b', 'delete'],
    ['/a/b', undefined],
    ['C:\\work\\a.png:stream', 'reveal']
  ] as const)('%p with intent %p is invalid', async (target, intent) => {
    const { opener, calls } = harness('win32')
    expect(await opener.open(target, intent)).toEqual({ ok: false, reason: 'invalid' })
    expect(calls.realpaths).toEqual([])
  })

  test('an absolute path over the length cap is invalid, not looked up', async () => {
    const { opener, calls } = harness('linux')
    expect(await opener.open('/' + 'x'.repeat(8193), 'reveal')).toEqual({ ok: false, reason: 'invalid' })
    expect(calls.realpaths).toEqual([])
  })

  test('a drive-less absolute path is invalid on Windows even when the filesystem would resolve it', async () => {
    const { opener, calls } = harness('win32', { existing: { '\\ab\\c': 'C:\\ab\\c', '\\a\\b': 'C:\\a\\b' } })
    expect(await opener.open('/ab/c', 'reveal')).toEqual({ ok: false, reason: 'invalid' })
    expect(await opener.open('\\a\\b', 'reveal')).toEqual({ ok: false, reason: 'invalid' })
    expect(calls.shown).toEqual([])
  })

  test('an intent other than reveal or open is invalid for an existing path on any platform', async () => {
    const { opener, calls } = harness('linux', { existing: { '/work/a.png': '/work/a.png' } })
    expect(await opener.open('/work/a.png', 'delete')).toEqual({ ok: false, reason: 'invalid' })
    expect([calls.shown, calls.opened]).toEqual([[], []])
  })

  test('a realpath that lands on an alternate data stream is invalid', async () => {
    const { opener, calls } = harness('win32', { existing: { 'C:\\work\\a.png': 'C:\\work\\a.png:evil.exe' } })
    expect(await opener.open('C:\\work\\a.png', 'reveal')).toEqual({ ok: false, reason: 'invalid' })
    expect(calls.shown).toEqual([])
  })

  test('a drive colon alone is not an alternate data stream', async () => {
    const { opener } = harness('win32', { existing: { 'C:\\work\\a.png': 'C:\\work\\a.png' } })
    expect(await opener.open('C:\\work\\a.png', 'reveal')).toEqual({ ok: true })
  })

  test('a missing path is not-found', async () => {
    const { opener } = harness('linux')
    expect(await opener.open('/no/such/file.md', 'reveal')).toEqual({ ok: false, reason: 'not-found' })
  })
})

describe('link-opener: a Git Bash /x/... path on Windows is its drive path', () => {
  test('/d/x.md is revealed as D:\\x.md, spaces included', async () => {
    const exe = 'D:\\Jeux\\GOG Galaxy\\REDprelauncher.exe'
    const { opener, calls } = harness('win32', { existing: { 'D:\\x.md': 'D:\\x.md', [exe]: exe } })
    expect(await opener.open('/d/x.md', 'reveal')).toEqual({ ok: true })
    expect(await opener.open('/d/Jeux/GOG Galaxy/REDprelauncher.exe', 'reveal')).toEqual({ ok: true })
    expect(calls.shown).toEqual(['D:\\x.md', exe])
  })

  test('the translated path meets the same guards as its drive form: a symlink component onto a share is refused before realpath', async () => {
    const opts = { links: { 'C:\\work\\link': '\\\\127.0.0.1\\share\\x' }, existing: { 'C:\\work\\link\\a.png': 'C:\\work\\link\\a.png' } }
    for (const target of ['/c/work/link/a.png', 'C:\\work\\link\\a.png']) {
      const { opener, calls } = harness('win32', opts)
      expect(await opener.open(target, 'reveal'), target).toEqual({ ok: false, reason: 'network-path' })
      expect(calls.readlinks, target).toContain('C:\\work\\link')
      expect(calls.realpaths, target).toEqual([])
    }
  })

  test('a translated executable is only shown on Ctrl+click, even when the allow-list names its type', async () => {
    const exe = 'D:\\x y\\z.exe'
    const { opener, calls } = harness('win32', { existing: { [exe]: exe }, policy: { extensions: ['.exe'], exclusions: [] } })
    expect(await opener.open('/d/x y/z.exe', 'open')).toEqual({ ok: true })
    expect(calls.shown).toEqual([exe])
    expect(calls.opened).toEqual([])
  })

  test('the translated path meets the alternate data stream guard of its drive form', async () => {
    const { opener, calls } = harness('win32', { existing: { 'C:\\work\\a.png': 'C:\\work\\a.png' } })
    expect(await opener.open('/c/work/a.png:stream', 'reveal')).toEqual({ ok: false, reason: 'invalid' })
    expect(calls.realpaths).toEqual([])
    expect(await opener.open('/c/work/a.png', 'reveal'), 'the same path without the stream is translated and revealed').toEqual({ ok: true })
  })

  test.each([
    ['//host/share/a.png', 'network-path'],
    ['/d', 'invalid'],
    ['/dd/x.md', 'invalid']
  ] as const)('%s is not translated: %s', async (target, reason) => {
    const { opener, calls } = harness('win32', { existing: { 'D:\\': 'D:\\', 'D:\\x.md': 'D:\\x.md' } })
    expect(await opener.open(target, 'reveal')).toEqual({ ok: false, reason })
    expect(calls.realpaths).toEqual([])
  })

  test('outside Windows /d/x.md stays a POSIX path', async () => {
    const { opener, calls } = harness('linux', { existing: { '/d/x.md': '/d/x.md' } })
    expect(await opener.open('/d/x.md', 'reveal')).toEqual({ ok: true })
    expect(calls.shown).toEqual(['/d/x.md'])
  })
})

describe('link-opener: a WSL /mnt/<letter>/ path on Windows is its drive path', () => {
  test('/mnt/c/Users/op/a.md is revealed as C:\\Users\\op\\a.md before the existing guards', async () => {
    const target = 'C:\\Users\\op\\a.md'
    const { opener, calls } = harness('win32', { existing: { [target]: target } })
    expect(await opener.open('/mnt/c/Users/op/a.md', 'reveal')).toEqual({ ok: true })
    expect(calls.shown).toEqual([target])
  })

  test('/mnt/c/Users/op/.ssh/x.json meets the default exclusion exactly as C:\\Users\\op\\.ssh\\x.json does', async () => {
    const excluded = 'C:\\Users\\op\\.ssh\\x.json'
    const open = 'C:\\Users\\op\\x.json'
    const { opener, calls } = harness('win32', { existing: { [excluded]: excluded, [open]: open } })
    expect(await opener.open(excluded, 'open')).toEqual({ ok: false, reason: 'not-allowed' })
    expect(await opener.open('/mnt/c/Users/op/.ssh/x.json', 'open')).toEqual({ ok: false, reason: 'not-allowed' })
    expect(await opener.open('/mnt/c/Users/op/x.json', 'open'), 'the same file outside .ssh opens').toEqual({ ok: true })
    expect(calls.opened).toEqual([open])
  })

  test.each(['/mnt/cc/Users/op/a.md', '/mnt/1/Users/op/a.md', '/mnt/c'])('%s is not translated as a WSL drive path', async (target) => {
    const { opener, calls } = harness('win32')
    expect(await opener.open(target, 'reveal')).toEqual({ ok: false, reason: 'invalid' })
    expect(calls.realpaths).toEqual([])
  })

  test.each(['linux', 'darwin'] as const)('outside Windows /mnt/c/a.md stays a POSIX path on %s', async (platform) => {
    const { opener, calls } = harness(platform, { existing: { '/mnt/c/a.md': '/mnt/c/a.md' } })
    expect(await opener.open('/mnt/c/a.md', 'reveal')).toEqual({ ok: true })
    expect(calls.shown).toEqual(['/mnt/c/a.md'])
  })
})

describe('link-opener: reveal', () => {
  test('any existing local path is revealed, even one an open would refuse', async () => {
    const { opener, calls } = harness('linux', {
      existing: { '/home/op/.ssh/id_ed25519': '/home/op/.ssh/id_ed25519' }
    })
    expect(await opener.open('/home/op/.ssh/id_ed25519', 'reveal')).toEqual({ ok: true })
    expect(calls.shown).toEqual(['/home/op/.ssh/id_ed25519'])
    expect(calls.opened).toEqual([])
  })

  test('a directory reached through a link is shown by its real path', async () => {
    const { opener, calls } = harness('linux', {
      existing: { '/w/linked-dir': '/data/real-dir' },
      dirs: ['/data/real-dir']
    })
    expect(await opener.open('/w/linked-dir', 'reveal')).toEqual({ ok: true })
    expect(calls.shown).toEqual(['/data/real-dir'])
  })

  test('the real path is what is shown, not the path the agent wrote', async () => {
    const { opener, calls } = harness('linux', { existing: { '/a/link.md': '/b/real.md' } })
    expect(await opener.open('/a/link.md', 'reveal')).toEqual({ ok: true })
    expect(calls.shown).toEqual(['/b/real.md'])
  })

  test.each(['reveal', 'open'] as const)(
    'a directory is only shown, never launched, even one named like an executable (%s)',
    async (intent) => {
      const { opener, calls } = harness('linux', {
        existing: { '/work/x.exe': '/work/x.exe', '/work/App.app': '/work/App.app' },
        dirs: ['/work/x.exe', '/work/App.app']
      })
      expect(await opener.open('/work/x.exe', intent)).toEqual({ ok: true })
      expect(await opener.open('/work/App.app', intent)).toEqual({ ok: true })
      expect(calls.shown).toEqual(['/work/x.exe', '/work/App.app'])
      expect(calls.opened, 'openPath on a directory that turns into a file would execute it').toEqual([])
    }
  )

  test('a throwing stat is a traced failure value, never a rejection', async () => {
    const stat = harness('linux', { existing: { '/work/a.png': '/work/a.png' }, statFails: true })
    expect(await stat.opener.open('/work/a.png', 'reveal')).toEqual({ ok: false, reason: 'failed' })
    expect(stat.calls.reports.join('\n')).toContain('/work/a.png')
  })
})

describe('link-opener: open follows the configured extension and exclusion lists', () => {
  const same = (...paths: string[]): Record<string, string> => Object.fromEntries(paths.map((p) => [p, p]))

  test('an allow-listed file is opened by its real path wherever it is, work dir or not', async () => {
    const { opener, calls } = harness('linux', { existing: same('/work/a.png', '/home/op/.claude/agent-forge/scratch/r.md') })
    expect(await opener.open('/work/a.png', 'open')).toEqual({ ok: true })
    expect(await opener.open('/home/op/.claude/agent-forge/scratch/r.md', 'open'), '.claude is not excluded as a whole').toEqual({ ok: true })
    expect(calls.opened).toEqual(['/work/a.png', '/home/op/.claude/agent-forge/scratch/r.md'])
  })

  test.each(['/work/noext', '/work/data.csv'])('%s is not on the default extension list', async (target) => {
    const { opener, calls } = harness('linux', { existing: same(target) })
    expect(await opener.open(target, 'open')).toEqual({ ok: false, reason: 'not-allowed' })
    expect(calls.opened).toEqual([])
  })

  test.each(['/work/run.EXE', '/work/p.svg', '/work/p.html', '/work/p.pdf', '/work/x.sh', '/work/m.docm', '/work/s.lnk', '/work/a.py', '/work/Tool.app', '/work/x.desktop', '/work/w.appref-ms'])(
    'a Ctrl+click on %s only shows it in its folder, whether or not the operator list names its type',
    async (target) => {
      const extension = target.slice(target.lastIndexOf('.')).toLowerCase()
      for (const extensions of [[extension], [...DEFAULT_LINK_EXTENSIONS]]) {
        const { opener, calls } = harness('linux', { existing: same(target), policy: { extensions, exclusions: [] } })
        expect(await opener.open(target, 'open')).toEqual({ ok: true })
        expect(calls.shown).toEqual([target])
        expect(calls.opened, 'a never-opened type does not reach openPath').toEqual([])
      }
    }
  )

  test('a never-opened type under an excluded location keeps the refusal instead of being shown', async () => {
    const { opener, calls } = harness('linux', { existing: same('/home/op/.ssh/run.sh') })
    expect(await opener.open('/home/op/.ssh/run.sh', 'open')).toEqual({ ok: false, reason: 'not-allowed' })
    expect([calls.shown, calls.opened]).toEqual([[], []])
  })

  test('the last extension decides: report.pdf.png is opened, report.png.exe is only shown', async () => {
    const { opener, calls } = harness('linux', { existing: same('/work/report.pdf.png', '/work/report.png.exe') })
    expect(await opener.open('/work/report.pdf.png', 'open')).toEqual({ ok: true })
    expect(await opener.open('/work/report.png.exe', 'open')).toEqual({ ok: true })
    expect(calls.opened).toEqual(['/work/report.pdf.png'])
    expect(calls.shown).toEqual(['/work/report.png.exe'])
  })

  test('the extension is compared in lower case and the real path is what is launched', async () => {
    const { opener, calls } = harness('linux', { existing: { '/work/A.PNG': '/work/A.PNG', '/work/link.md': '/work/real.md' } })
    expect(await opener.open('/work/A.PNG', 'open')).toEqual({ ok: true })
    expect(await opener.open('/work/link.md', 'open')).toEqual({ ok: true })
    expect(calls.opened).toEqual(['/work/A.PNG', '/work/real.md'])
  })

  test('the extension that counts is the real file, not the name of the link', async () => {
    const { opener, calls } = harness('linux', { existing: { '/work/innocent.md': '/work/payload.exe', '/work/pic.png': '/work/data.csv' } })
    expect(await opener.open('/work/innocent.md', 'open')).toEqual({ ok: true })
    expect(calls.shown, 'the real executable is shown, never launched').toEqual(['/work/payload.exe'])
    expect(await opener.open('/work/pic.png', 'open')).toEqual({ ok: false, reason: 'not-allowed' })
    expect(calls.opened).toEqual([])
  })

  test('openPath reporting an error is a failure, traced', async () => {
    const { opener, calls } = harness('linux', { existing: same('/work/a.png'), openPathResult: 'no handler' })
    expect(await opener.open('/work/a.png', 'open')).toEqual({ ok: false, reason: 'failed' })
    expect(calls.reports.join('\n')).toContain('no handler')
  })

  test.each([
    '/home/op/.ssh/known.json',
    '/work/sub/.ssh/known.json',
    '/work/.aws/c.log',
    '/work/.gnupg/a.txt',
    '/home/op/.kube/config.json',
    '/work/.docker/config.json',
    '/home/op/.claude/.credentials.json',
    '/elsewhere/claude-config/.credentials.json',
    '/home/op/.koryphaios/operator.json',
    '/home/op/.koryphaios/companion-cert.json'
  ])('%s is excluded by default but still revealable', async (target) => {
    const { opener, calls } = harness('linux', { existing: same(target) })
    expect(await opener.open(target, 'open')).toEqual({ ok: false, reason: 'not-allowed' })
    expect(await opener.open(target, 'reveal')).toEqual({ ok: true })
    expect(calls.opened).toEqual([])
  })

  test('the exclusion applies to the real path: a link in an open place onto an excluded one is refused', async () => {
    const { opener, calls } = harness('linux', { existing: { '/work/notes.md': '/home/op/.ssh/key.md' } })
    expect(await opener.open('/work/notes.md', 'open')).toEqual({ ok: false, reason: 'not-allowed' })
    expect(calls.opened).toEqual([])
  })

  test('a bare name matches a whole path segment, not a part of one', async () => {
    const { opener } = harness('linux', { existing: same('/work/.sshfs/a.md', '/work/my.ssh/a.md', '/work/x.ssh.md') })
    expect(await opener.open('/work/.sshfs/a.md', 'open')).toEqual({ ok: true })
    expect(await opener.open('/work/my.ssh/a.md', 'open')).toEqual({ ok: true })
    expect(await opener.open('/work/x.ssh.md', 'open')).toEqual({ ok: true })
  })

  test('a path entry covers that folder and what is under it, not a sibling sharing its prefix', async () => {
    const { opener } = harness('linux', {
      policy: { extensions: ['.md'], exclusions: ['/srv/private', '~/vault'] },
      existing: same('/srv/private/a.md', '/srv/privateer/a.md', '/home/op/vault/sub/a.md', '/home/op/vaults/a.md')
    })
    expect(await opener.open('/srv/private/a.md', 'open')).toEqual({ ok: false, reason: 'not-allowed' })
    expect(await opener.open('/srv/privateer/a.md', 'open')).toEqual({ ok: true })
    expect(await opener.open('/home/op/vault/sub/a.md', 'open'), '~/ is the injected home').toEqual({ ok: false, reason: 'not-allowed' })
    expect(await opener.open('/home/op/vaults/a.md', 'open')).toEqual({ ok: true })
  })

  test('an entry that is itself a link is compared by where it leads too', async () => {
    const { opener } = harness('linux', {
      policy: { extensions: ['.md'], exclusions: ['~/vault'] },
      existing: { '/home/op/vault': '/data/vault', '/data/vault/a.md': '/data/vault/a.md' }
    })
    expect(await opener.open('/data/vault/a.md', 'open')).toEqual({ ok: false, reason: 'not-allowed' })
  })

  test('an exclusion entry that cannot be read refuses the open, traced, instead of skipping the entry', async () => {
    const { opener, calls } = harness('linux', {
      policy: { extensions: ['.md'], exclusions: ['/srv/private'] },
      existing: same('/srv/other/a.md'),
      realpathErrors: { '/srv/private': 'EACCES' }
    })
    expect(await opener.open('/srv/other/a.md', 'open')).toEqual({ ok: false, reason: 'not-allowed' })
    expect(calls.reports.join('\n')).toContain('/srv/private')
    expect(calls.opened).toEqual([])
  })

  test('an entry that does not exist is skipped without a trace', async () => {
    const { opener, calls } = harness('linux', { existing: same('/work/a.md') })
    expect(await opener.open('/work/a.md', 'open')).toEqual({ ok: true })
    expect(calls.reports).toEqual([])
  })

  test('both lists are read at every call', async () => {
    const { opener, policy, calls } = harness('linux', { existing: same('/work/a.png', '/work/b.txt') })
    expect(await opener.open('/work/a.png', 'open')).toEqual({ ok: true })
    policy.extensions = ['.txt']
    expect(await opener.open('/work/a.png', 'open')).toEqual({ ok: false, reason: 'not-allowed' })
    expect(await opener.open('/work/b.txt', 'open')).toEqual({ ok: true })
    policy.exclusions = ['work']
    expect(await opener.open('/work/b.txt', 'open')).toEqual({ ok: false, reason: 'not-allowed' })
    expect(calls.opened).toEqual(['/work/a.png', '/work/b.txt'])
  })

  test('segment names and extensions are matched without regard to case on Windows', async () => {
    const { opener } = harness('win32', { existing: same('C:\\Work\\.SSH\\a.json', 'C:\\Work\\Shot.PNG') })
    expect(await opener.open('C:\\Work\\.SSH\\a.json', 'open')).toEqual({ ok: false, reason: 'not-allowed' })
    expect(await opener.open('C:\\Work\\Shot.PNG', 'open')).toEqual({ ok: true })
  })

  test('a path entry is matched without regard to case on Windows, ~\\ included', async () => {
    const { opener } = harness('win32', {
      policy: { extensions: ['.json'], exclusions: ['~\\.claude\\.credentials.json'] },
      existing: same('c:\\USERS\\OP\\.claude\\.credentials.json')
    })
    expect(await opener.open('c:\\USERS\\OP\\.claude\\.credentials.json', 'open')).toEqual({ ok: false, reason: 'not-allowed' })
  })

  test('no executable or script extension is in the default list', () => {
    for (const ext of ['.exe', '.bat', '.cmd', '.ps1', '.sh', '.js', '.lnk', '.msi', '.svg', '.html', '.pdf', '.csv']) {
      expect(DEFAULT_LINK_EXTENSIONS.includes(ext), ext).toBe(false)
    }
  })
})

describe('link-opener: links are read before anything follows them', () => {
  test.each(['EACCES', 'EPERM', 'EIO'])('a link that cannot be read (%s) refuses the open, traced, before realpath', async (code) => {
    const { opener, calls } = harness('linux', {
      existing: { '/w/a/x.md': '/w/a/x.md' },
      readlinkErrors: { '/w/a': code }
    })
    expect(await opener.open('/w/a/x.md', 'open')).toEqual({ ok: false, reason: 'failed' })
    expect(await opener.open('/w/a/x.md', 'reveal')).toEqual({ ok: false, reason: 'failed' })
    expect(calls.realpaths).toEqual([])
    expect(calls.reports.join('\n'), 'the unreadable component itself is traced, not only the refusal').toContain('readlink failed: /w/a')
    expect(calls.opened).toEqual([])
  })

  test.each(['ENOENT', 'ENOTDIR'])('a component that is not there (%s) is not a refusal by itself', async (code) => {
    const { opener } = harness('linux', { existing: { '/w/a/x.md': '/w/a/x.md' }, readlinkErrors: { '/w/a/x.md': code } })
    expect(await opener.open('/w/a/x.md', 'open')).toEqual({ ok: true })
  })

  test('the number of links read in total is bounded, however shallow the chain of links is', async () => {
    const { opener, calls } = harness('linux', {
      links: { '/w/l1': `/${'a/'.repeat(40)}t`, '/w/l1/l2': `/${'b/'.repeat(40)}t` },
      existing: { '/w/l1/l2/x.md': '/w/l1/l2/x.md' }
    })
    expect(await opener.open('/w/l1/l2/x.md', 'open')).toEqual({ ok: false, reason: 'network-path' })
    expect(calls.readlinks, 'two hops deep, stopped by the total and not by the depth').toHaveLength(64)
    expect(calls.realpaths).toEqual([])
  })

  test('a long parent shared by the targets of a chain of links is read once, not once per link', async () => {
    const base = `/${'d/'.repeat(13)}d`
    const { opener, calls } = harness('linux', {
      links: { [`${base}/l1`]: `${base}/l2`, [`${base}/l2`]: `${base}/l3`, [`${base}/l3`]: `${base}/l4`, [`${base}/l4`]: `${base}/real` },
      existing: { [`${base}/l1/x.md`]: `${base}/real/x.md` }
    })
    expect(await opener.open(`${base}/l1/x.md`, 'open')).toEqual({ ok: true })
    expect(new Set(calls.readlinks).size, 'no component is read twice').toBe(calls.readlinks.length)
  })
})

describe('link-opener: refusals leave a trace', () => {
  test('every refusal is reported with its reason', async () => {
    const { opener, calls } = harness('linux')
    await opener.open('javascript:1', 'open')
    await opener.open('/no/such/x.md', 'reveal')
    expect(calls.reports).toHaveLength(2)
    expect(calls.reports[0]).toContain('invalid')
    expect(calls.reports[1]).toContain('not-found')
  })
})

describe('link-opener on a real filesystem', () => {
  const base = mkdtempSync(join(tmpdir(), 'kory-links-'))
  const work = join(base, 'work')
  const outside = join(base, 'outside')
  mkdirSync(work)
  mkdirSync(outside)
  mkdirSync(join(outside, '.ssh'))
  writeFileSync(join(outside, 'secret.png'), 'x')
  writeFileSync(join(outside, '.ssh', 'key.png'), 'x')
  writeFileSync(join(work, 'ok.png'), 'x')
  symlinkSync(outside, join(work, 'link'), 'junction')
  symlinkSync(join(outside, '.ssh'), join(work, 'keys'), 'junction')
  // Creating a symlink needs a privilege on some Windows hosts; without it the test below is skipped, not passed.
  let canLinkToNetwork = true
  try {
    symlinkSync(process.platform === 'win32' ? '\\\\127.0.0.1\\share\\x' : '//127.0.0.1/share/x', join(work, 'unc'), 'dir')
  } catch {
    canLinkToNetwork = false
  }
  afterAll(() => rmSync(base, { recursive: true, force: true }))

  // The production adapter itself, observed through a spy that forwards every call.
  function real(): {
    opener: ReturnType<typeof createLinkOpener>
    opened: string[]
    realpaths: string[]
    readlinks: (string | null)[]
  } {
    const opened: string[] = []
    const realpaths: string[] = []
    const readlinks: (string | null)[] = []
    const fs = nodeLinkFs()
    const { realpath: resolveNative } = fs
    const opener = createLinkOpener({
      shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async (p) => (opened.push(p), '') },
      fs: {
        ...fs,
        realpath: (p) => (realpaths.push(p), resolveNative(p)),
        readlink: async (p) => {
          const target = await fs.readlink(p)
          readlinks.push(target)
          return target
        }
      },
      policy: () => ({ extensions: [...DEFAULT_LINK_EXTENSIONS], exclusions: [...DEFAULT_LINK_EXCLUSIONS] }),
      home: base,
      platform: process.platform,
      reportError: () => {}
    })
    return { opener, opened, realpaths, readlinks }
  }

  test('a junction onto an excluded folder does not make its files openable', async () => {
    const { opener, opened } = real()
    expect(await opener.open(join(work, 'keys', 'key.png'), 'open')).toEqual({ ok: false, reason: 'not-allowed' })
    expect(opened).toEqual([])
  })

  test('a junction pointing outside the folder it sits in still opens an allowed file', async () => {
    const { opener, opened } = real()
    expect(await opener.open(join(work, 'link', 'secret.png'), 'open')).toEqual({ ok: true })
    expect(opened).toHaveLength(1)
  })

  test.skipIf(!canLinkToNetwork)('a symlink to a UNC share is refused as a network path, and realpath is never asked about it', async () => {
    const { opener, opened, realpaths, readlinks } = real()
    expect(await opener.open(join(work, 'unc', 'a.png'), 'open')).toEqual({ ok: false, reason: 'network-path' })
    expect(await opener.open(join(work, 'unc'), 'reveal')).toEqual({ ok: false, reason: 'network-path' })
    expect(opened).toEqual([])
    expect(realpaths, 'realpath on such a link opens the SMB session itself').toEqual([])
    expect(readlinks.filter((t) => t !== null && /^[\\/]{2}/.test(t)), 'the form readlink hands back for the UNC link').not.toEqual([])
  })

  test('a regular file is opened', async () => {
    const { opener, opened } = real()
    expect(await opener.open(join(work, 'ok.png'), 'open')).toEqual({ ok: true })
    expect(opened).toHaveLength(1)
  })
})

describe('nodeLinkFs', () => {
  const base = mkdtempSync(join(tmpdir(), 'kory-linkfs-'))
  writeFileSync(join(base, 'plain.txt'), 'x')
  afterAll(() => rmSync(base, { recursive: true, force: true }))

  test('readlink is null on a regular file and rejects with the errno code on a missing path', async () => {
    const fs = nodeLinkFs()
    expect(await fs.readlink(join(base, 'plain.txt'))).toBeNull()
    expect(((await fs.readlink(join(base, 'missing')).catch((e: unknown) => e)) as NodeJS.ErrnoException).code).toBe('ENOENT')
  })

  test('realpath agrees with fs/promises on an existing path and rejects with ENOENT on a missing one', async () => {
    const { realpath: resolveNative } = nodeLinkFs()
    expect(await resolveNative(join(base, 'plain.txt'))).toBe(await realpath(join(base, 'plain.txt')))
    expect(((await resolveNative(join(base, 'missing')).catch((e: unknown) => e)) as NodeJS.ErrnoException).code).toBe('ENOENT')
  })

  test('isDirectory tells a directory from a file', async () => {
    const fs = nodeLinkFs()
    expect(await fs.isDirectory(base)).toBe(true)
    expect(await fs.isDirectory(join(base, 'plain.txt'))).toBe(false)
  })

  test.skipIf(process.platform !== 'win32' || !existsSync('C:\\PROGRA~1'))('realpath is the native one: it expands a Windows 8.3 short name', async () => {
    const { realpath: resolveNative } = nodeLinkFs()
    expect(await resolveNative('C:\\PROGRA~1')).not.toContain('~')
  })
})
