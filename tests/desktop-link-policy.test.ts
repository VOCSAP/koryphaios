import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_LINK_EXCLUSIONS,
  DEFAULT_LINK_EXTENSIONS,
  LINK_LIST_MAX_ENTRIES,
  linkListsFromStored,
  linkPolicyOf,
  sanitizeLinkExclusions,
  sanitizeLinkExtensions,
  sanitizeLinkPatch
} from '../desktop/src/shared/link-policy'

describe('linkListsFromStored', () => {
  test('absent lists are the defaults, silently, and each call gets its own copy', () => {
    const reports: string[] = []
    const lists = linkListsFromStored({}, (m) => reports.push(m))
    expect(lists).toEqual({ linkOpenExtensions: [...DEFAULT_LINK_EXTENSIONS], linkOpenExclusions: [...DEFAULT_LINK_EXCLUSIONS] })
    expect(reports).toEqual([])
    lists.linkOpenExtensions.push('.exe')
    expect(linkListsFromStored({}, () => {}).linkOpenExtensions).not.toContain('.exe')
  })

  test('an unusable list falls back to its default with a trace naming the key, the other list is kept', () => {
    const reports: string[] = []
    const lists = linkListsFromStored({ linkOpenExtensions: 'png', linkOpenExclusions: ['/srv/a'] }, (m) => reports.push(m))
    expect(lists.linkOpenExtensions).toEqual([...DEFAULT_LINK_EXTENSIONS])
    expect(lists.linkOpenExclusions).toEqual(['/srv/a'])
    expect(reports).toHaveLength(1)
    expect(reports[0]).toContain('linkOpenExtensions')
  })

  test('a stored list naming a never-opened type is the default list, with a trace', () => {
    const reports: string[] = []
    const lists = linkListsFromStored({ linkOpenExtensions: ['.png', '.exe'] }, (m) => reports.push(m))
    expect(lists.linkOpenExtensions).toEqual([...DEFAULT_LINK_EXTENSIONS])
    expect(reports).toHaveLength(1)
  })

  test('a usable list is stored normalised', () => {
    expect(linkListsFromStored({ linkOpenExtensions: ['PNG', 'md'] }, () => {}).linkOpenExtensions).toEqual(['.png', '.md'])
  })
})

describe('sanitizeLinkPatch', () => {
  type Patch = { theme?: string; linkOpenExtensions?: unknown; linkOpenExclusions?: unknown }

  test('a usable list is normalised and the rest of the patch is untouched', () => {
    const patch: Patch = { theme: 'dark', linkOpenExtensions: ['PNG'] }
    expect(sanitizeLinkPatch(patch, () => {})).toEqual({ theme: 'dark', linkOpenExtensions: ['.png'] })
    expect(patch.linkOpenExtensions, 'the caller patch is not mutated').toEqual(['PNG'])
  })

  test('an unusable list is dropped from the patch with a trace, so the stored list stays', () => {
    const reports: string[] = []
    const patch: Patch = { theme: 'dark', linkOpenExclusions: ['relative/path'], linkOpenExtensions: ['.md'] }
    const out = sanitizeLinkPatch(patch, (m) => reports.push(m))
    expect(out).toEqual({ theme: 'dark', linkOpenExtensions: ['.md'] })
    expect('linkOpenExclusions' in out).toBe(false)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toContain('linkOpenExclusions')
  })

  test('a patch without the lists is returned as is', () => {
    const patch: Patch = { theme: 'light' }
    expect(sanitizeLinkPatch(patch, () => {})).toEqual({ theme: 'light' })
  })

  test.each([
    ['undefined', undefined],
    ['null', null]
  ])('a list key present with %s is dropped with a trace: spread over the stored config it would erase the list', (_label, value) => {
    const reports: string[] = []
    const out = sanitizeLinkPatch<Patch>({ theme: 'dark', linkOpenExtensions: value }, (m) => reports.push(m))
    expect('linkOpenExtensions' in out, 'the key itself must be gone, not only its value').toBe(false)
    expect({ ...{ linkOpenExtensions: ['.md'] }, ...out }.linkOpenExtensions).toEqual(['.md'])
    expect(reports).toHaveLength(1)
    expect(reports[0]).toContain('linkOpenExtensions')
  })
})

describe('linkPolicyOf', () => {
  test('each list lands in its own field, and every call hands out a copy of the config as it is then', () => {
    const cfg = { linkOpenExtensions: ['.md'], linkOpenExclusions: ['/srv/a'] }
    const first = linkPolicyOf(cfg)
    expect(first).toEqual({ extensions: ['.md'], exclusions: ['/srv/a'] })
    first.extensions.push('.exe')
    first.exclusions.length = 0
    expect(cfg, 'editing the result does not edit the config').toEqual({ linkOpenExtensions: ['.md'], linkOpenExclusions: ['/srv/a'] })
    cfg.linkOpenExtensions = ['.txt']
    expect(linkPolicyOf(cfg)).toEqual({ extensions: ['.txt'], exclusions: ['/srv/a'] })
  })
})

describe('sanitizeLinkExtensions', () => {
  test('the defaults are a valid list as they stand', () => {
    expect(sanitizeLinkExtensions([...DEFAULT_LINK_EXTENSIONS])).toEqual([...DEFAULT_LINK_EXTENSIONS])
  })

  test('entries are trimmed, dot-prefixed, lower-cased and deduplicated', () => {
    expect(sanitizeLinkExtensions([' PNG ', '.md', 'md', '.Json'])).toEqual(['.png', '.md', '.json'])
  })

  test.each(['exe', '.EXE', ' Sh ', '.js', 'html', '.svg', 'pdf', '.docm', '.lnk', 'py', 'desktop', '.app'])(
    'the never-opened type %s is refused, so the list that names it is unusable',
    (ext) => {
      expect(sanitizeLinkExtensions(['.png', ext])).toBeNull()
    }
  )

  test('a type next to a never-opened one in name only is accepted', () => {
    expect(sanitizeLinkExtensions(['.exes', '.shx', '.jsx'])).toEqual(['.exes', '.shx', '.jsx'])
  })

  test.each([
    ['not an array', 'png,md'],
    ['an empty list', []],
    ['a non-string entry', ['.png', 3]],
    ['an empty entry', ['.png', '']],
    ['a lone dot', ['.']],
    ['a glob', ['*.png']],
    ['a compound extension', ['.tar.gz']],
    ['a separator', ['.p/ng']],
    ['an overlong extension', ['.' + 'a'.repeat(17)]],
    ['too many entries', Array.from({ length: LINK_LIST_MAX_ENTRIES + 1 }, (_, i) => `.e${i}`)]
  ])('%s is unusable', (_label, raw) => {
    expect(sanitizeLinkExtensions(raw)).toBeNull()
  })
})

describe('sanitizeLinkExclusions', () => {
  test('the defaults are a valid list as they stand', () => {
    expect(sanitizeLinkExclusions([...DEFAULT_LINK_EXCLUSIONS])).toEqual([...DEFAULT_LINK_EXCLUSIONS])
  })

  test.each(['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.credentials.json', 'operator.json', 'companion-cert.json'])(
    'the default exclusions include %s',
    (name) => {
      expect(DEFAULT_LINK_EXCLUSIONS).toContain(name)
    }
  )

  test('.claude as a whole is not a default exclusion', () => {
    expect(DEFAULT_LINK_EXCLUSIONS).not.toContain('.claude')
  })

  test.each([['.ssh'], ['~/vault'], ['~\\vault'], ['/srv/private'], ['C:\\Users\\op\\vault'], ['D:/vault']])('%s is usable', (entry) => {
    expect(sanitizeLinkExclusions([entry])).toEqual([entry])
  })

  test('entries are trimmed and deduplicated', () => {
    expect(sanitizeLinkExclusions([' .ssh ', '.ssh', '/srv/a'])).toEqual(['.ssh', '/srv/a'])
  })

  test.each([
    ['not an array', '.ssh'],
    ['an empty list', []],
    ['a non-string entry', ['.ssh', null]],
    ['an empty entry', ['.ssh', '  ']],
    ['a relative path', ['vault/keys']],
    ['a dot segment', ['..']],
    ['the home directory itself', ['~']],
    ['a network path', ['\\\\host\\share']],
    ['a double-slash path', ['//host/share']],
    ['a control character', ['.ssh\u0000']],
    ['a comma inside a path, which the Settings field would split in two', ['/srv/vault,old']],
    ['a comma inside a bare name', ['a,b']],
    ['an overlong entry', ['/' + 'a'.repeat(260)]],
    ['too many entries', Array.from({ length: LINK_LIST_MAX_ENTRIES + 1 }, (_, i) => `.d${i}`)]
  ])('%s is unusable', (_label, raw) => {
    expect(sanitizeLinkExclusions(raw)).toBeNull()
  })
})
