import { generate } from 'selfsigned'

export interface AvatarRunCertificate {
  certPem: string
  keyPem: string
}

export async function generateAvatarRunCertificate(): Promise<AvatarRunCertificate> {
  const certificate = await generate(
    [{ name: 'commonName', value: 'kory-avatar-run' }],
    {
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
        { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true, critical: false },
        { name: 'subjectAltName', critical: false, altNames: [{ type: 7, ip: '127.0.0.1' }] }
      ]
    }
  )
  return { certPem: certificate.cert, keyPem: certificate.private }
}
