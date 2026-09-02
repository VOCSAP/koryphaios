// Pure test: no runtime import of 'selfsigned' or 'electron', no filesystem, so
// it runs before npm install in desktop/.
// Proves a stateDir carrying a pre-version companion-cert.json (no `version`
// field) triggers regeneration rather than being served forever.

import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildCertRequest, COMPANION_CERT_VERSION, loadOrCreateCert, type CertFs, type CertMaterial } from '../desktop/src/main/companion-cert.ts'

/** An in-memory CertFs: no real filesystem touched. */
function memFs(initial?: string): CertFs & { written: string[] } {
  let contents = initial
  const written: string[] = []
  return {
    existsSync: () => contents !== undefined,
    readFileSync: () => {
      if (contents === undefined) throw new Error('ENOENT')
      return contents
    },
    writeFileSync: (_path, data) => {
      contents = data
      written.push(data)
    },
    written
  }
}

const ADDR = '10.0.0.5'

test('fresh stateDir (no file): generate() is called and its result persisted with the current version + address', async () => {
  const fs = memFs(undefined)
  let calls = 0
  const generate = () => {
    calls++
    return { key: 'k1', cert: 'c1' } satisfies CertMaterial
  }
  const errors: unknown[] = []
  const result = await loadOrCreateCert('/x/companion-cert.json', generate, 7, ADDR, fs, (msg, err) => errors.push([msg, err]))

  expect(calls).toBe(1)
  expect(result).toEqual({ key: 'k1', cert: 'c1' })
  expect(errors).toEqual([])
  expect(fs.written).toHaveLength(1)
  expect(JSON.parse(fs.written[0]!)).toEqual({ key: 'k1', cert: 'c1', version: 7, addr: ADDR })
})

// This is the acceptance criterion's core: a legacy stateDir (a real machine
// that ran an OLDER build once) must NOT keep serving its stale cert.
test('legacy on-disk cert with NO version field is treated as stale and regenerated', async () => {
  const fs = memFs(JSON.stringify({ key: 'old-sha1-key', cert: 'old-sha1-cert' }))
  let calls = 0
  const generate = () => {
    calls++
    return { key: 'new-key', cert: 'new-cert' } satisfies CertMaterial
  }
  const result = await loadOrCreateCert('/x/companion-cert.json', generate, COMPANION_CERT_VERSION, ADDR, fs, () => {})

  expect(calls).toBe(1)
  expect(result).toEqual({ key: 'new-key', cert: 'new-cert' })
  // The stale material must be gone from what's returned -- not merged, not
  // preferred over the fresh one.
  expect(result.key).not.toBe('old-sha1-key')
})

test('on-disk cert with an OLDER (but present) version number is also regenerated', async () => {
  const fs = memFs(JSON.stringify({ key: 'v1-key', cert: 'v1-cert', version: 1, addr: ADDR }))
  let calls = 0
  const generate = () => {
    calls++
    return { key: 'v2-key', cert: 'v2-cert' } satisfies CertMaterial
  }
  const result = await loadOrCreateCert('/x/companion-cert.json', generate, 2, ADDR, fs, () => {})

  expect(calls).toBe(1)
  expect(result).toEqual({ key: 'v2-key', cert: 'v2-cert' })
})

// Review round: the address-invalidation half. A cert whose VERSION still
// matches but whose SAN was generated for a DIFFERENT LAN address (network
// change, DHCP renewal) is exactly as stale as a version mismatch -- the
// browser warning goes permanent again for the same reason. Same model as
// the version tests above.
test('on-disk cert with a matching version but a DIFFERENT stored address is regenerated', async () => {
  const fs = memFs(JSON.stringify({ key: 'old-addr-key', cert: 'old-addr-cert', version: 9, addr: '192.168.1.1' }))
  let calls = 0
  const generate = () => {
    calls++
    return { key: 'new-addr-key', cert: 'new-addr-cert' } satisfies CertMaterial
  }
  const result = await loadOrCreateCert('/x/companion-cert.json', generate, 9, '192.168.1.99', fs, () => {})

  expect(calls).toBe(1)
  expect(result).toEqual({ key: 'new-addr-key', cert: 'new-addr-cert' })
  expect(JSON.parse(fs.written[0]!)).toEqual({
    key: 'new-addr-key',
    cert: 'new-addr-cert',
    version: 9,
    addr: '192.168.1.99'
  })
})

// Legacy file with a version but no `addr` field at all (every cert this
// module ever wrote before this review round) is stale too -- same
// treatment as a missing `version`, not a special "addr optional" case.
test('on-disk cert with a matching version but NO stored address at all is regenerated', async () => {
  const fs = memFs(JSON.stringify({ key: 'no-addr-key', cert: 'no-addr-cert', version: 3 }))
  let calls = 0
  const generate = () => {
    calls++
    return { key: 'fresh-key', cert: 'fresh-cert' } satisfies CertMaterial
  }
  const result = await loadOrCreateCert('/x/companion-cert.json', generate, 3, ADDR, fs, () => {})

  expect(calls).toBe(1)
  expect(result).toEqual({ key: 'fresh-key', cert: 'fresh-cert' })
})

test('on-disk cert matching the current version AND address is served from cache: generate() is never called', async () => {
  const fs = memFs(JSON.stringify({ key: 'cached-key', cert: 'cached-cert', version: 5, addr: ADDR }))
  let calls = 0
  const generate = () => {
    calls++
    return { key: 'should-not-be-used', cert: 'should-not-be-used' } satisfies CertMaterial
  }
  const result = await loadOrCreateCert('/x/companion-cert.json', generate, 5, ADDR, fs, () => {})

  expect(calls).toBe(0)
  expect(result).toEqual({ key: 'cached-key', cert: 'cached-cert' })
  expect(fs.written).toEqual([])
})

test('corrupted JSON on disk falls through to generate(), reported via onError, not thrown', async () => {
  const fs = memFs('{not json')
  let calls = 0
  const generate = () => {
    calls++
    return { key: 'k', cert: 'c' } satisfies CertMaterial
  }
  const errors: string[] = []
  const result = await loadOrCreateCert('/x/companion-cert.json', generate, 1, ADDR, fs, (msg) => errors.push(msg))

  expect(calls).toBe(1)
  expect(result).toEqual({ key: 'k', cert: 'c' })
  expect(errors).toHaveLength(1)
  expect(errors[0]).toContain('unreadable')
})

test('writeFileSync failure after a successful regenerate is non-fatal: material is still returned, error routed to onError', async () => {
  const fs: CertFs = {
    existsSync: () => false,
    readFileSync: () => {
      throw new Error('should not be called')
    },
    writeFileSync: () => {
      throw new Error('disk full')
    }
  }
  const errors: string[] = []
  const result = await loadOrCreateCert(
    '/x/companion-cert.json',
    () => ({ key: 'k', cert: 'c' }),
    1,
    ADDR,
    fs,
    (msg) => errors.push(msg)
  )

  expect(result).toEqual({ key: 'k', cert: 'c' })
  expect(errors).toContain('cert persistence failed')
})

test('generate() rejecting propagates the rejection, no corrupt material is returned', async () => {
  const fs = memFs(undefined)
  const err = new Error('selfsigned exploded')
  await expect(
    loadOrCreateCert(
      '/x/companion-cert.json',
      async () => {
        throw err
      },
      1,
      ADDR,
      fs,
      () => {}
    )
  ).rejects.toThrow('selfsigned exploded')
  // Nothing was persisted for a failed generation.
  expect(fs.written).toEqual([])
})

// ----- buildCertRequest: the generation-parameter half of the acceptance
// criteria, proven structurally without ever calling the real selfsigned
// package (its own correctness is out of scope -- only OUR call-site
// discipline is under test here).

test('buildCertRequest always requests SHA-256, regardless of the LAN address', () => {
  for (const addr of ['192.168.1.50', '10.0.0.7', '172.16.9.9']) {
    const { options } = buildCertRequest(addr)
    expect(options.algorithm).toBe('sha256')
  }
})

test('buildCertRequest SAN always carries the given LAN IP as a type-7 (IP) altName', () => {
  const { options } = buildCertRequest('10.20.30.40')
  const san = options.extensions.find((e) => e.name === 'subjectAltName')
  expect(san).toBeDefined()
  if (san?.name !== 'subjectAltName') throw new Error('unreachable')
  expect(san.altNames.some((a) => a.type === 7 && a.ip === '10.20.30.40')).toBe(true)
})

// selfsigned's buildExtensions replaces the whole default extension set the
// moment a non-empty `extensions` array is supplied, so a subjectAltName-only
// array would silently drop basicConstraints/keyUsage/extKeyUsage; this asserts
// all four survive.
// Comparing (name, critical) pairs, not just names: a hand-copied extension
// with no `critical` field silently becomes critical=false, diverging from
// selfsigned's own per-extension defaults.
test('buildCertRequest replicates the full default extension set INCLUDING each extension\'s critical flag, matching selfsigned\'s own defaults exactly (selfsigned override trap)', () => {
  const { options } = buildCertRequest('192.168.1.1')
  const pairs = options.extensions
    .map((e) => [e.name, e.critical ?? false] as const)
    .sort(([a], [b]) => a.localeCompare(b))
  expect(pairs).toEqual([
    ['basicConstraints', true],
    ['extKeyUsage', false],
    ['keyUsage', true],
    ['subjectAltName', false]
  ])
})

test('buildCertRequest SAN also keeps a DNS entry for the commonName (unchanged from prior behaviour)', () => {
  const { attrs, options } = buildCertRequest('192.168.1.1')
  const cn = attrs.find((a) => a.name === 'commonName')?.value
  expect(cn).toBeDefined()
  const san = options.extensions.find((e) => e.name === 'subjectAltName')
  if (san?.name !== 'subjectAltName') throw new Error('unreachable')
  expect(san.altNames.some((a) => a.type === 2 && a.value === cn)).toBe(true)
})

// Weak guard: companion-server.ts pulls in electron transitively, so nothing
// here can import and exercise it directly. This only proves the wiring text is
// present at the real call site, not that it executes correctly.
// The source slice is bounded from the call expression to the next unique
// marker right after it, not to end of file: an unbounded slice-to-EOF stayed
// true even when the call site itself was mutated, because an unrelated later
// occurrence of the same substring kept it green.
// The measured property is extracted once so the guard test and its
// mutation-proof below check the exact same logic, so they cannot diverge and
// silently cancel out each other's blind spot.
function callSiteWired(companionServerSrc: string): boolean {
  const callStart = companionServerSrc.indexOf('await loadOrCreateCert(')
  if (callStart === -1) return false
  const callEnd = companionServerSrc.indexOf('this.fingerprint = certFingerprint(cert)', callStart)
  if (callEnd === -1) return false
  const call = companionServerSrc.slice(callStart, callEnd)
  return (
    call.includes("'companion-cert.json'") &&
    call.includes('generateCert(attrs, options)') &&
    call.includes('COMPANION_CERT_VERSION,') &&
    call.includes('lanAddr,') &&
    call.includes('{ existsSync, readFileSync, writeFileSync }')
  )
}

test('companion-server.ts source still wires buildCertRequest + loadOrCreateCert + COMPANION_CERT_VERSION at the actual call site (weak guard, see comment)', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'desktop', 'src', 'main', 'companion-server.ts'), 'utf8')
  expect(src).toContain("import { buildCertRequest, COMPANION_CERT_VERSION, loadOrCreateCert } from './companion-cert'")
  expect(src).toContain('const { attrs, options } = buildCertRequest(lanAddr)')
  expect(callSiteWired(src)).toBe(true)
})

// Mutation proof for the test above (CLAUDE.md: "is that probe in the
// diff?"): the review-round mutations -- COMPANION_CERT_VERSION swapped for
// a literal (disables version invalidation forever), the SHA-256/SAN
// options dropped (restores both original defects), existsSync stubbed to
// always report "no file" (breaks the persisted-cert / Android pinning
// reuse), lanAddr swapped for a literal string (disables address
// invalidation, card 3776ae19's second review round), the persisted file
// path swapped for an unrelated one (breaks on-disk caching, third review
// round) -- replayed through the SAME callSiteWired() the real guard test
// uses, and required to flip it to
// false. Before the call-site-scoped fix (this review round), the first
// three mutations left the old whole-file `src.toContain(...)` guard green.
test('mutation proof: the call-site-scoped wiring guard reddens on the review-round mutations', () => {
  const real = readFileSync(join(import.meta.dir, '..', 'desktop', 'src', 'main', 'companion-server.ts'), 'utf8')
  expect(callSiteWired(real)).toBe(true) // positive control: the real file passes

  // Mutating ONLY the call-scoped slice, not the whole file: `real.replace`
  // over the WHOLE file would hit the IMPORT line first for
  // 'COMPANION_CERT_VERSION,' (the import braces read "buildCertRequest,
  // COMPANION_CERT_VERSION, loadOrCreateCert", which contains that exact
  // substring) and leave the actual call site untouched -- reproducing,
  // inside this very mutation proof, the same whole-file blindness this
  // review round exists to close. Mutating the call-scoped text and
  // reassembling around it is what makes each mutation land where it claims to.
  const callStart = real.indexOf('await loadOrCreateCert(')
  const prefix = real.slice(0, callStart)
  const call = real.slice(callStart)
  const mutate = (from: string, to: string) => prefix + call.replace(from, to)

  const m1 = mutate('COMPANION_CERT_VERSION,', '1,')
  expect(callSiteWired(m1)).toBe(false)

  const m2 = mutate('generateCert(attrs, options)', 'generateCert(attrs, { keySize: 2048 })')
  expect(callSiteWired(m2)).toBe(false)

  const m3 = mutate(
    '{ existsSync, readFileSync, writeFileSync }',
    '{ existsSync: () => false, readFileSync, writeFileSync }'
  )
  expect(callSiteWired(m3)).toBe(false)

  // First occurrence within the call slice is the argument itself (verified
  // -- the only other 'lanAddr,' in this file is server.listen(0, lanAddr,
  // ...), further down and untouched by a first-match .replace()).
  const m4 = mutate('lanAddr,', "'0.0.0.0',")
  expect(callSiteWired(m4)).toBe(false)

  // M5 (third review round): the persisted file path swapped for an
  // unrelated one -- type-checks, silently breaks on-disk caching (see the
  // comment on callSiteWired above).
  const m5 = mutate(
    "join(this.deps.stateDir, 'companion-cert.json')",
    "join(require('node:os').tmpdir(), 'c.json')"
  )
  expect(callSiteWired(m5)).toBe(false)
})
