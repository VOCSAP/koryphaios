// Card 3776ae19 (certificate half), end-to-end proof against the REAL
// 'selfsigned' package. Companion to tests/desktop-companion-cert.test.ts
// (pure, DI-only, stub generate()): this file is the one that actually
// closes the acceptance criterion the team-lead named as non-negotiable --
// "on a stateDir that already carries an OLD-format companion-cert.json,
// the certificate served after the fix is SHA-256 signed AND carries the
// LAN IP in its SAN". A test that only exercises a fresh/empty stateDir
// does not bite on that case, since the bug this card fixes IS the
// unconditional cache read on an existing file.
//
// 'selfsigned' is declared in desktop/package.json (production dependency,
// for companion-server.ts's own generateCert call) AND, for THIS file's
// benefit, also in the ROOT package.json devDependencies -- tests/ is a
// SIBLING of desktop/, not an ancestor of desktop/node_modules, so a bare
// `import ... from 'selfsigned'` in any tests/*.test.ts file cannot resolve
// via desktop/node_modules no matter which CI step runs it. Same pattern
// already used for react/react-dom/zustand/@happy-dom/global-registrator
// (desktop-build.yml's "Root install" step comment) -- NOT an entry in
// scripts/pure-module-partition.ts's EXEMPTIONS (an earlier version of this
// fix tried that, measured it did not actually resolve the import either,
// and reverted it). This file therefore runs in the fast, trusted
// "Bun tests (pure modules)" step like its sibling tests/desktop-companion-
// cert.test.ts, not in the "Bun tests (integration)" step.
//
// node:crypto's X509Certificate exposes .subjectAltName as a human-readable
// string but has NO public signatureAlgorithm getter (measured against
// Node 24.18 / bun 1.3.13 locally: Object.getOwnPropertyNames on its
// prototype lists ca/checkEmail/.../subjectAltName/toJSON/... with nothing
// naming the signature algorithm). The signature algorithm is instead
// asserted by scanning the certificate's raw DER bytes for the two mutually
// exclusive PKCS#1 OIDs: sha256WithRSAEncryption (1.2.840.113549.1.1.11)
// vs sha1WithRSAEncryption (1.2.840.113549.1.1.5) -- measured locally
// (scratch probe) to appear exactly once, and exactly the expected one,
// for a cert generated with algorithm:'sha256' vs one generated with no
// algorithm option at all (selfsigned's SHA-1 default).

import { test, expect } from 'bun:test'
import { X509Certificate } from 'node:crypto'
import { generate as generateCert } from 'selfsigned'
import { buildCertRequest, COMPANION_CERT_VERSION, loadOrCreateCert, type CertFs } from '../desktop/src/main/companion-cert.ts'

const SHA256_WITH_RSA_OID = Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b])
const SHA1_WITH_RSA_OID = Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x05])

function derBytes(pem: string): Buffer {
  return Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64')
}

/** In-memory CertFs seeded with an OLD-FORMAT cert (no `version` field at
 * all) -- exactly what a machine that ran a pre-card-3776ae19 build left
 * on disk. */
function legacyStateDirFs(): CertFs {
  const legacy = JSON.stringify({
    // Deliberately not a real cert -- loadOrCreateCert must never try to
    // serve it once it is recognized as stale; only its ABSENCE of a
    // `version` field matters for triggering regeneration.
    key: 'LEGACY-SHA1-KEY-PLACEHOLDER',
    cert: 'LEGACY-SHA1-CERT-PLACEHOLDER'
  })
  let contents: string | undefined = legacy
  return {
    existsSync: () => contents !== undefined,
    readFileSync: () => {
      if (contents === undefined) throw new Error('ENOENT')
      return contents
    },
    writeFileSync: (_path, data) => {
      contents = data
    }
  }
}

test('regenerating over a legacy stateDir with the real generateCert() yields a SHA-256 signed cert', async () => {
  const lanAddr = '192.168.1.77'
  const { attrs, options } = buildCertRequest(lanAddr)
  const fs = legacyStateDirFs()

  const { cert } = await loadOrCreateCert(
    '/state/companion-cert.json',
    async () => {
      const pems = await generateCert(attrs, options)
      return { key: pems.private, cert: pems.cert }
    },
    COMPANION_CERT_VERSION,
    lanAddr,
    fs,
    () => {}
  )

  expect(cert).not.toBe('LEGACY-SHA1-CERT-PLACEHOLDER')
  const der = derBytes(cert)
  expect(der.includes(SHA256_WITH_RSA_OID)).toBe(true)
  expect(der.includes(SHA1_WITH_RSA_OID)).toBe(false)
})

test('regenerating over a legacy stateDir with the real generateCert() yields a cert whose SAN carries the LAN IP', async () => {
  const lanAddr = '10.0.0.42'
  const { attrs, options } = buildCertRequest(lanAddr)
  const fs = legacyStateDirFs()

  const { cert } = await loadOrCreateCert(
    '/state/companion-cert.json',
    async () => {
      const pems = await generateCert(attrs, options)
      return { key: pems.private, cert: pems.cert }
    },
    COMPANION_CERT_VERSION,
    lanAddr,
    fs,
    () => {}
  )

  const x509 = new X509Certificate(cert)
  expect(x509.subjectAltName).toContain(`IP Address:${lanAddr}`)
})

// Review round (point 4): a cert cached for an OLDER LAN address must be
// regenerated for the NEW one, real selfsigned end to end -- a laptop that
// changes networks (or a DHCP lease renewal) must not keep serving a cert
// whose SAN carries an address the server no longer binds to.
test('a cert cached for an OLD LAN address is regenerated with the NEW address in its SAN when the address changes', async () => {
  const oldAddr = '192.168.1.10'
  const newAddr = '192.168.1.20'

  // Seed the stateDir with a REAL cert generated for the old address, at the
  // current version -- this is the "everything else matches, only the
  // address moved" case, distinct from the legacy/no-version fixtures above.
  const oldRequest = buildCertRequest(oldAddr)
  const seeded = await generateCert(oldRequest.attrs, oldRequest.options)
  let stored: string | undefined = JSON.stringify({
    key: seeded.private,
    cert: seeded.cert,
    version: COMPANION_CERT_VERSION,
    addr: oldAddr
  })
  const fs: CertFs = {
    existsSync: () => stored !== undefined,
    readFileSync: () => stored as string,
    writeFileSync: (_path, data) => {
      stored = data
    }
  }

  const { attrs, options } = buildCertRequest(newAddr)
  const { cert } = await loadOrCreateCert(
    '/state/companion-cert.json',
    async () => {
      const pems = await generateCert(attrs, options)
      return { key: pems.private, cert: pems.cert }
    },
    COMPANION_CERT_VERSION,
    newAddr,
    fs,
    () => {}
  )

  expect(cert).not.toBe(seeded.cert)
  const x509 = new X509Certificate(cert)
  expect(x509.subjectAltName).toContain(`IP Address:${newAddr}`)
  expect(x509.subjectAltName).not.toContain(`IP Address:${oldAddr}`)
})

// Negative control: proves the OID scan above actually discriminates, i.e.
// it is not vacuously true for any selfsigned-generated cert regardless of
// options. Without this, a scan that always found "sha256" (e.g. a bug in
// the OID bytes) would make the two tests above pass for the wrong reason.
test('control: a cert generated with selfsigned defaults (no algorithm option) is SHA-1, not SHA-256', async () => {
  const pems = await generateCert([{ name: 'commonName', value: 'control' }], { keySize: 2048 })
  const der = derBytes(pems.cert)
  expect(der.includes(SHA1_WITH_RSA_OID)).toBe(true)
  expect(der.includes(SHA256_WITH_RSA_OID)).toBe(false)
})

// Negative control for the SAN assertion: proves the pre-fix shape (no
// extensions option, CN !== 'localhost') really does omit any IP SAN --
// otherwise the positive assertion above would not be discriminating either.
test('control: a cert generated with selfsigned defaults and a non-localhost CN has no IP SAN at all', async () => {
  const pems = await generateCert([{ name: 'commonName', value: 'koryphaios-companion' }], { keySize: 2048 })
  const x509 = new X509Certificate(pems.cert)
  expect(x509.subjectAltName ?? '').not.toContain('IP Address:')
})
