import { expect, test } from 'bun:test'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { RequestOptions } from 'node:https'
import type { PeerCertificate } from 'node:tls'
import { generate } from 'selfsigned'
import {
  avatarHttpsRequestOptions,
  avatarWssOptions,
  strictAvatarCheckServerIdentity
} from '../desktop/src/main/avatar-transport.ts'
import { generateAvatarRunCertificate } from '../desktop/src/main/avatar-certificate.ts'
import { AVATAR_REGISTRY_VERSION, type AvatarRendezvous } from '../desktop/src/main/avatar-registry.ts'

function rendezvous(certPem: string): AvatarRendezvous {
  return {
    version: AVATAR_REGISTRY_VERSION,
    avatarRunId: 'avatar-run-1',
    pid: process.pid,
    port: 43123,
    certPem,
    token: 'avatar-test-token'
  }
}

test('pins the run leaf and keeps its bearer out of Avatar URLs', async () => {
  const run = await generateAvatarRunCertificate()
  const signedLeaf = await generate(
    [{ name: 'commonName', value: 'kory-avatar-signed-leaf' }],
    {
      keySize: 2048,
      algorithm: 'sha256',
      ca: { key: run.keyPem, cert: run.certPem },
      extensions: [{ name: 'subjectAltName', critical: false, altNames: [{ type: 7, ip: '127.0.0.1' }] }]
    }
  )
  const runFingerprint = new X509Certificate(run.certPem).fingerprint256
  const signedLeafFingerprint = new X509Certificate(signedLeaf.cert).fingerprint256
  const sameHost = () => undefined

  expect(signedLeafFingerprint).not.toBe(runFingerprint)
  expect(strictAvatarCheckServerIdentity(runFingerprint, '127.0.0.1', {
    fingerprint256: runFingerprint
  } as PeerCertificate, sameHost)).toBeUndefined()
  expect(strictAvatarCheckServerIdentity(runFingerprint, '127.0.0.1', {
    fingerprint256: signedLeafFingerprint
  } as PeerCertificate, sameHost)).toBeInstanceOf(Error)

  const httpsOptions = avatarHttpsRequestOptions(rendezvous(run.certPem), '/')
  const wssOptions = avatarWssOptions(rendezvous(run.certPem), '/')
  const wssTlsOptions = wssOptions.options as unknown as RequestOptions
  expect(httpsOptions.protocol).toBe('https:')
  expect(httpsOptions.rejectUnauthorized).toBe(true)
  expect(httpsOptions.ca).toBe(run.certPem)
  expect(httpsOptions.headers).toEqual({ Authorization: 'Bearer avatar-test-token' })
  expect(wssOptions.url).toBe('wss://127.0.0.1:43123/')
  expect(wssOptions.options.rejectUnauthorized).toBe(true)
  expect(wssTlsOptions.ca).toBe(run.certPem)
  expect(wssOptions.options.headers).toEqual({ Authorization: 'Bearer avatar-test-token' })
  expect(() => avatarHttpsRequestOptions(rendezvous(run.certPem), '/?token=avatar-test-token')).toThrow(/query/)
  expect(() => avatarWssOptions(rendezvous(run.certPem), '/#token')).toThrow(/query/)
})

test('Electron rejects a run-key-signed leaf before either client delivers its bearer', async () => {
  const repo = join(import.meta.dir, '..')
  const bundleDir = mkdtempSync(join(tmpdir(), 'kory-avatar-transport-'))
  const require = createRequire(import.meta.url)
  const electron = require(join(repo, 'desktop', 'node_modules', 'electron')) as string
  const transportSource = join(repo, 'desktop', 'src', 'main', 'avatar-transport.ts')
  const certificateSource = join(repo, 'desktop', 'src', 'main', 'avatar-certificate.ts')
  const transportBundle = join(bundleDir, 'avatar-transport.cjs')
  const certificateBundle = join(bundleDir, 'avatar-certificate.cjs')

  try {
    const bundles: Array<[string, string]> = [
      [transportSource, transportBundle],
      [certificateSource, certificateBundle]
    ]
    for (const [source, output] of bundles) {
      const build = Bun.spawnSync([
        process.execPath,
        'build',
        '--target=node',
        '--format=cjs',
        `--outfile=${output}`,
        source
      ])
      expect(build.exitCode).toBe(0)
    }

    const child = Bun.spawn([
      electron,
      join(import.meta.dir, 'fixtures', 'avatar-transport-electron.cjs'),
      transportBundle,
      certificateBundle,
      join(repo, 'desktop', 'node_modules', 'ws'),
      join(repo, 'desktop', 'node_modules', 'selfsigned')
    ], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ])

    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toEqual({
      httpsBearer: true,
      signedLeafHttpsRejected: true,
      signedLeafHttpsRequests: 0,
      wssBearer: true,
      signedLeafWssRejected: true,
      signedLeafWssUpgrades: 0
    })
  } finally {
    rmSync(bundleDir, { recursive: true, force: true })
  }
})
