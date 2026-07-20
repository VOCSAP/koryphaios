// PLAN MB1/MB2: companion protocol invariants (manifest coverage, channel
// uniqueness, tier completeness), the LAN-only guard, the frame parser, and
// the pairing/lockout lifecycle. All pure — no electron, no sockets.

import { test, expect } from 'bun:test'
import {
  CHANNEL_TIERS,
  COMPANION_LOCKOUT_THRESHOLD,
  COMPANION_MANIFEST,
  CompanionAuth,
  isPrivateAddress,
  parseClientFrame,
  REMOTE_BLOCKED_CHANNELS
} from '../desktop/src/shared/companion.ts'

test('channels are unique within each transport kind', () => {
  // A channel MAY serve both an invoke and an event (e.g. broker:status,
  // workspace:current) — the frame type disambiguates. But two invokes, or
  // two events, on the same channel would collide on the bridge.
  for (const kind of ['invoke', 'send', 'event'] as const) {
    const channels = Object.values(COMPANION_MANIFEST)
      .filter((s) => s.kind === kind)
      .map((s) => s.channel)
    expect(new Set(channels).size).toBe(channels.length)
  }
})

test('every invoke/send channel carries a sensitivity tier', () => {
  for (const spec of Object.values(COMPANION_MANIFEST)) {
    if (spec.kind === 'event') continue
    expect(CHANNEL_TIERS[spec.channel]).toBeDefined()
  }
})

test('blocked channels all exist in the manifest', () => {
  const known = new Set(Object.values(COMPANION_MANIFEST).map((s) => s.channel))
  for (const ch of REMOTE_BLOCKED_CHANNELS) expect(known.has(ch)).toBe(true)
})

test('companion control + native dialogs are remote-blocked', () => {
  for (const ch of [
    'companion:start',
    'companion:stop',
    'companion:status',
    'dialog:pickDirectory',
    'browser:capture',
    'design:capture-window'
  ]) {
    expect(REMOTE_BLOCKED_CHANNELS.has(ch)).toBe(true)
  }
})

test('isPrivateAddress accepts LAN, rejects public', () => {
  for (const a of ['127.0.0.1', '10.0.0.5', '192.168.1.42', '172.16.9.9', '::1', 'fd00::1', '100.64.0.1']) {
    expect(isPrivateAddress(a)).toBe(true)
  }
  for (const a of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2600::1', '', 'garbage', '192.168.1']) {
    expect(isPrivateAddress(a)).toBe(false)
  }
})

test('IPv4-mapped IPv6 is unwrapped before the check', () => {
  expect(isPrivateAddress('::ffff:192.168.0.3')).toBe(true)
  expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false)
})

test('parseClientFrame validates shapes', () => {
  expect(parseClientFrame('{"t":"hello","token":"x"}')).toEqual({ t: 'hello', token: 'x', cred: undefined })
  expect(parseClientFrame('{"t":"req","id":1,"ch":"a","args":[]}')).toEqual({
    t: 'req',
    id: 1,
    ch: 'a',
    args: []
  })
  expect(parseClientFrame('{"t":"req","id":"x","ch":"a","args":[]}')).toBeNull()
  expect(parseClientFrame('{"t":"mode","mode":"nope"}')).toBeNull()
  expect(parseClientFrame('not json')).toBeNull()
  expect(parseClientFrame('{"t":"unknown"}')).toBeNull()
})

test('pairing token is single-use and mints a credential', () => {
  let n = 0
  const auth = new CompanionAuth(() => 0)
  auth.arm('secret-token')
  const first = auth.hello('10.0.0.2', { token: 'secret-token' }, () => `cred-${++n}`)
  expect(first.result).toBe('paired')
  const cred = first.result === 'paired' ? first.cred : ''
  // Token now dead.
  expect(auth.hello('10.0.0.2', { token: 'secret-token' }, () => 'x').result).toBe('denied')
  // But the minted credential resumes.
  expect(auth.hello('10.0.0.2', { cred }, () => 'x').result).toBe('resumed')
})

test('re-arming invalidates prior credentials', () => {
  const auth = new CompanionAuth(() => 0)
  auth.arm('t1')
  const v = auth.hello('10.0.0.2', { token: 't1' }, () => 'cred-1')
  const cred = v.result === 'paired' ? v.cred : ''
  auth.arm('t2') // new app-run token
  expect(auth.hello('10.0.0.2', { cred }, () => 'x').result).toBe('denied')
})

test('lockout after repeated failures', () => {
  let now = 0
  const auth = new CompanionAuth(() => now)
  auth.arm('good')
  for (let i = 0; i < COMPANION_LOCKOUT_THRESHOLD; i++) {
    expect(auth.hello('10.0.0.9', { token: 'bad' }, () => 'x').result).toBe('denied')
  }
  expect(auth.isLocked('10.0.0.9')).toBe(true)
  // Even the correct token is refused while locked.
  expect(auth.hello('10.0.0.9', { token: 'good' }, () => 'x').result).toBe('denied')
  now += 11 * 60_000
  expect(auth.isLocked('10.0.0.9')).toBe(false)
})
