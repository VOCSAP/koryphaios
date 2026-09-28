import { X509Certificate } from 'node:crypto'
import { Agent, request, type RequestOptions } from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { checkServerIdentity, type ConnectionOptions, type PeerCertificate } from 'node:tls'
import { WebSocket, type ClientOptions } from 'ws'
import type { AvatarRendezvous } from './avatar-registry'

const AVATAR_LOOPBACK_HOST = '127.0.0.1'

export function strictAvatarCheckServerIdentity(
  runFingerprint: string,
  host: string,
  certificate: PeerCertificate,
  checkHostname: typeof checkServerIdentity = checkServerIdentity
): Error | undefined {
  const hostnameError = checkHostname(host, certificate)
  if (hostnameError) return hostnameError
  return certificate.fingerprint256 === runFingerprint ? undefined : new Error('Avatar certificate mismatch')
}

function avatarTlsOptions(rendezvous: AvatarRendezvous): Pick<ConnectionOptions, 'ca' | 'rejectUnauthorized' | 'checkServerIdentity'> {
  const fingerprint = new X509Certificate(rendezvous.certPem).fingerprint256
  return {
    ca: rendezvous.certPem,
    rejectUnauthorized: true,
    checkServerIdentity: (host, certificate) => strictAvatarCheckServerIdentity(fingerprint, host, certificate)
  }
}

function strictAvatarPath(path: string): string {
  if (!path.startsWith('/') || path.includes('?') || path.includes('#')) {
    throw new Error('Avatar request path must not contain a query or fragment')
  }
  return path
}

export function avatarHttpsRequestOptions(rendezvous: AvatarRendezvous, path: string): RequestOptions {
  return {
    ...avatarTlsOptions(rendezvous),
    protocol: 'https:',
    hostname: AVATAR_LOOPBACK_HOST,
    port: rendezvous.port,
    path: strictAvatarPath(path),
    headers: { Authorization: `Bearer ${rendezvous.token}` }
  }
}

export function requestAvatarHttps(
  rendezvous: AvatarRendezvous,
  path: string,
  listener?: (response: IncomingMessage) => void
): ClientRequest {
  return request(avatarHttpsRequestOptions(rendezvous, path), listener)
}

export function avatarWssOptions(
  rendezvous: AvatarRendezvous,
  path: string
): { url: string; options: ClientOptions } {
  const tls = avatarTlsOptions(rendezvous)
  return {
    url: `wss://${AVATAR_LOOPBACK_HOST}:${rendezvous.port}${strictAvatarPath(path)}`,
    options: {
      agent: new Agent(tls),
      ca: tls.ca,
      rejectUnauthorized: true,
      headers: { Authorization: `Bearer ${rendezvous.token}` }
    }
  }
}

export function connectAvatarWss(rendezvous: AvatarRendezvous, path: string): WebSocket {
  const { url, options } = avatarWssOptions(rendezvous, path)
  return new WebSocket(url, options)
}
