// Pure module with no runtime import of 'selfsigned' or 'electron', so bun can
// collect it before `npm install` runs in desktop/.
// COMPANION_CERT_VERSION is the invalidation lever: loadOrCreateCert only
// regenerates when it is bumped, otherwise an existing cert is served
// unconditionally forever.

// Type-only import (erased at transpile -- verified below and in this
// module's own header claim): pulls the extension/altName/attrs shapes from
// selfsigned's OWN .d.ts instead of hand-copying them, so a future selfsigned
// upgrade that adds/renames a field is a compile error here rather than a
// silent divergence (review round, card 3776ae19: a hand-copied CertAltName
// is what let a missing `critical` field go unnoticed -- see buildCertRequest
// below). selfsigned/index.d.ts declares these without an explicit `export`
// keyword ahead of its own `export declare function generate`, which reads
// as module-private -- but they resolve cleanly under this project's
// `moduleResolution: bundler` (measured: `npm run typecheck:node` reports no
// TS2305/TS2307 for this import, only the ordinary "unused" diagnostic
// before these names were referenced below).
import type { CertificateExtension, CertificateField, SelfsignedOptions, SubjectAltNameEntry } from 'selfsigned'

/**
 * Bump whenever buildCertRequest's output, or generation parameters in general,
 * change in a way that must invalidate an already-persisted cert.
 */
export const COMPANION_CERT_VERSION = 2

export interface CertMaterial {
  key: string
  cert: string
}

interface StoredCert extends CertMaterial {
  /**
   * Absent on every cert generated before this field existed; treated the same
   * as an explicit stale version.
   */
  version?: number
  /** The LAN address the cert's SAN was generated for. Review round: a cert
   * whose version still matches but whose SAN carries an address the server
   * no longer binds to (LAN change, DHCP renewal) is just as stale as a
   * version mismatch -- both leave the browser warning permanent, which is
   * this whole card's point. Absent on every cert generated before this
   * field existed, same treatment as a missing `version`. */
  addr?: string
}

/** The subset of node:fs this module needs, injected so callers can stub it
 * in tests without touching the real filesystem (or pass the real module). */
export interface CertFs {
  existsSync: (path: string) => boolean
  readFileSync: (path: string, encoding: 'utf8') => string
  writeFileSync: (path: string, data: string, options: { mode: number }) => void
}

/**
 * Regenerates when the file is absent, unreadable, or its stored
 * version/address does not match the current one; required params have no
 * defaults since this is a security-relevant gate.
 * Non-fatal: an unreadable or corrupt stored file falls through to generation
 * (reported via onError), and a persistence failure after successful generation
 * still returns the fresh material.
 * A generate() rejection is not caught here; it propagates rather than
 * returning corrupt material.
 */
export async function loadOrCreateCert(
  file: string,
  generate: () => Promise<CertMaterial> | CertMaterial,
  currentVersion: number,
  currentAddr: string,
  fs: CertFs,
  onError: (msg: string, err: unknown) => void
): Promise<CertMaterial> {
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredCert
      if (parsed.key && parsed.cert && parsed.version === currentVersion && parsed.addr === currentAddr) {
        return { key: parsed.key, cert: parsed.cert }
      }
    }
  } catch (err) {
    onError('persisted cert unreadable — regenerating', err)
  }
  const material = await generate()
  const stored: StoredCert = { ...material, version: currentVersion, addr: currentAddr }
  try {
    fs.writeFileSync(file, JSON.stringify(stored), { mode: 0o600 })
  } catch (err) {
    // Non-fatal: the server still runs with the freshly generated material,
    // the browser warning (or the next launch's regeneration cost) just
    // repeats. Traced (no-silent-errors rule), never thrown.
    onError('cert persistence failed', err)
  }
  return material
}

export type CertAttr = CertificateField
export type CertAltName = SubjectAltNameEntry
export type CertExtension = CertificateExtension

export interface CertGenerateOptions extends SelfsignedOptions {
  keySize: number
  algorithm: 'sha256'
  extensions: CertExtension[]
}

/**
 * A non-empty user `extensions` array replaces selfsigned's own defaults
 * wholesale rather than merging with them, so this replicates the full default
 * set explicitly (basicConstraints/keyUsage/extKeyUsage) and adds the IP SAN
 * entry unconditionally.
 * selfsigned also marks basicConstraints and keyUsage critical by default and
 * the other two not; every entry below states its `critical` value explicitly
 * rather than relying on the field's own default.
 */
export function buildCertRequest(lanAddr: string): { attrs: CertAttr[]; options: CertGenerateOptions } {
  const commonName = 'koryphaios-companion'
  return {
    attrs: [{ name: 'commonName', value: commonName }],
    options: {
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true, clientAuth: true, critical: false },
        {
          name: 'subjectAltName',
          critical: false,
          altNames: [
            { type: 2, value: commonName },
            { type: 7, ip: lanAddr }
          ]
        }
      ]
    }
  }
}
