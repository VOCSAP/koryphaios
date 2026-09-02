// End-to-end against the real selfsigned package: a stateDir already carrying
// an old-format cached certificate must be served one that is SHA-256 signed
// and carries the current LAN IP in its SAN; an empty stateDir would not
// exercise the cache-read path. selfsigned is also a root devDependency
// because tests/ is a sibling of the app directory, not an ancestor of its
// node_modules. The signature algorithm is asserted by scanning the raw DER
// bytes for the sha256WithRSAEncryption vs sha1WithRSAEncryption PKCS#1 OIDs,
// since node:crypto's X509Certificate exposes no signatureAlgorithm getter.

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

// A cert cached for an older LAN address must be regenerated for the new one: a
// laptop that changes networks, or renews its DHCP lease, must not keep serving
// a certificate whose SAN carries an address the server does not currently bind
// to.
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
