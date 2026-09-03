// PLAN MB1/MB2: companion protocol invariants (manifest coverage, channel
// uniqueness, tier completeness), the LAN-only guard, the frame parser, and
// the pairing/lockout lifecycle. All pure — no electron, no sockets, no
// desktop/node_modules dependency (this file runs in CI before desktop
// deps are installed, see the source-scan test near the bottom for why).

import { test, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CHANNEL_TIERS,
  COMPANION_LOCKOUT_THRESHOLD,
  COMPANION_MANIFEST,
  COMPANION_MAX_PAYLOAD_BYTES,
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
  // Positive side-effect (review round, correction 8): because
  // REMOTE_BLOCKED_CHANNELS is the union of EXPLICIT_REMOTE_BLOCKED_CHANNELS
  // and every tier>=3 CHANNEL_TIERS entry, this loop transitively forces
  // every tier>=3 channel into the manifest too, not just the hand-picked
  // explicit floor -- a tier>=3 channel with no manifest entry fails HERE,
  // not just in the regHandle-coverage test below.
  const known = new Set(Object.values(COMPANION_MANIFEST).map((s) => s.channel))
  for (const ch of REMOTE_BLOCKED_CHANNELS) expect(known.has(ch)).toBe(true)
})

test('REMOTE_BLOCKED_CHANNELS derivation actually unions every tier>=3 CHANNEL_TIERS entry, not just the explicit floor', () => {
  // Proves the derivation mechanism itself -- the union spread over
  // Object.entries(CHANNEL_TIERS) -- actually reads every tier>=3 entry instead
  // of silently dropping some; it cannot detect a channel missing a
  // CHANNEL_TIERS entry altogether.
  for (const [channel, tier] of Object.entries(CHANNEL_TIERS)) {
    if (tier >= 3) expect(REMOTE_BLOCKED_CHANNELS.has(channel)).toBe(true)
  }
})

// A regHandle'd channel with no CHANNEL_TIERS entry is neither tier>=3 nor on
// the explicit floor, so by default it is remotely invocable (fail-open).
// The file set is discovered by walking main/ for any file containing a
// call-shaped `regHandle(`, excluding api-registry.ts's own declaration, so a
// new caller file is picked up automatically.
// The extractor is fail-closed on its own reach: it counts every call-shaped
// `regHandle(` occurrence and compares that to how many it could parse a plain
// single-quoted first argument out of, so an unparseable form (backtick,
// concatenation, double quotes) is a loud failure, not a silent undercount.
const MAIN_DIR = join(import.meta.dir, '..', 'desktop', 'src', 'main')

/** Call-shaped `regHandle(`, excluding api-registry.ts's own declaration. */
function rawCallRe(): RegExp {
  return /(?<!function )regHandle\(/g
}

/** Same call shape, additionally requiring a parseable single-quoted first arg. */
function literalCallRe(): RegExp {
  return /(?<!function )regHandle\(\s*'([^']+)'/g
}

function discoverHandlerFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => {
    if (!f.endsWith('.ts')) return false
    const src = readFileSync(join(dir, f), 'utf8')
    return rawCallRe().test(src)
  })
}

function scanFile(path: string): { channels: string[]; unparsedCount: number } {
  const src = readFileSync(path, 'utf8')
  const rawCount = [...src.matchAll(rawCallRe())].length
  const channels = [...src.matchAll(literalCallRe())].map((m) => m[1] as string)
  return { channels, unparsedCount: rawCount - channels.length }
}

test('regHandle domain is discovered across main/ (not hardcoded), and unparseable call sites fail loudly instead of undercounting silently (review round, second pass)', () => {
  const files = discoverHandlerFiles(MAIN_DIR)
  expect(files.length).toBeGreaterThan(0)
  const allChannels: string[] = []
  const unparsedByFile: Record<string, number> = {}
  for (const f of files) {
    const { channels, unparsedCount } = scanFile(join(MAIN_DIR, f))
    allChannels.push(...channels)
    if (unparsedCount > 0) unparsedByFile[f] = unparsedCount
  }
  expect(unparsedByFile).toEqual({})

  const manifestChannels = new Set(Object.values(COMPANION_MANIFEST).map((s) => s.channel))
  const untiered = allChannels.filter((ch) => !(ch in CHANNEL_TIERS))
  const unmanifested = allChannels.filter((ch) => !manifestChannels.has(ch))
  expect(untiered).toEqual([])
  expect(unmanifested).toEqual([])
})

test('agents:stop (trust-changing) is remote-blocked; agents:stop-state (read) is not', () => {
  expect(CHANNEL_TIERS['agents:stop']).toBe(3)
  expect(REMOTE_BLOCKED_CHANNELS.has('agents:stop')).toBe(true)
  expect(CHANNEL_TIERS['agents:stop-state']).toBe(0)
  expect(REMOTE_BLOCKED_CHANNELS.has('agents:stop-state')).toBe(false)
})

// approvals:reply and approvals:decline render a human verdict a stopped agent
// consumes directly, unlike inbox:reply where the recipient keeps judgement --
// a remote companion answering here manufactures the consent that was the only
// thing stopping the agent.
// Both are tier 2, below the tier>=3 threshold REMOTE_BLOCKED_CHANNELS
// auto-unions, so they are blocked only because
// EXPLICIT_REMOTE_BLOCKED_CHANNELS hand-lists them; a third channel with this
// property must be added to both by hand.
test('approvals:reply and approvals:decline (render a human verdict a stopped agent consumes) stay on the remote-block floor', () => {
  expect(REMOTE_BLOCKED_CHANNELS.has('approvals:reply')).toBe(true)
  expect(REMOTE_BLOCKED_CHANNELS.has('approvals:decline')).toBe(true)
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

// Card 45c1999e: an unauthenticated attacker who NEVER sends a well-formed
// hello (only garbage the server can't parse) must still trip the same
// lockout — recordFailure() is the counter companion-server.ts's message
// handler calls on an unparsable frame from an unauthenticated socket. If
// this test only asserted CompanionAuth's shape, it would miss a parallel
// counter; asserting it shares the budget with hello()'s denied path is
// what proves there is no separate, unbounded path.
test('unparsable frames alone (never a hello) trip the same lockout as bad hellos', () => {
  const auth = new CompanionAuth(() => 0)
  for (let i = 0; i < COMPANION_LOCKOUT_THRESHOLD - 1; i++) {
    auth.recordFailure('10.0.0.7')
  }
  expect(auth.isLocked('10.0.0.7')).toBe(false) // one short of the threshold
  auth.recordFailure('10.0.0.7')
  expect(auth.isLocked('10.0.0.7')).toBe(true)
})

test('recordFailure and a bad hello share one counter, not two', () => {
  const auth = new CompanionAuth(() => 0)
  auth.arm('good')
  for (let i = 0; i < COMPANION_LOCKOUT_THRESHOLD - 1; i++) {
    auth.recordFailure('10.0.0.8')
  }
  expect(auth.isLocked('10.0.0.8')).toBe(false)
  // The threshold-th failure via the OTHER path (a rejected hello) still
  // locks — proving both paths increment the same budget.
  expect(auth.hello('10.0.0.8', { token: 'bad' }, () => 'x').result).toBe('denied')
  expect(auth.isLocked('10.0.0.8')).toBe(true)
})

test('COMPANION_MAX_PAYLOAD_BYTES is pinned to 1 MiB', () => {
  expect(COMPANION_MAX_PAYLOAD_BYTES).toBe(1024 * 1024)
})

// Card 45c1999e review round: neither the maxPayload option value nor the
// recordFailure() call live in a module this suite can import (companion-
// server.ts pulls in electron transitively via api-registry.ts), so nothing
// here proves those CALL SITES exist — only that CompanionAuth/the exported
// constant behave correctly in isolation, which the tests above already
// cover. This is the weakest guard tier (CLAUDE.md's "source scan" case):
// it bites pure deletion and constant-renaming, NOTHING ELSE — it does not
// prove the option's value is actually consumed by the WebSocketServer
// instance, nor that recordFailure's return value or side effect is used
// correctly. Do not read a pass here as proof of wiring.
test('companion-server.ts source still wires maxPayload and recordFailure (weak guard, see comment)', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'desktop', 'src', 'main', 'companion-server.ts'), 'utf8')
  expect(src).toContain('maxPayload: COMPANION_MAX_PAYLOAD_BYTES')
  expect(src).toContain('this.auth.recordFailure(addr)')
})

// ----- Lot 2: device list + revoke -----

// Pairing is single-use per arm and re-arming wipes prior creds, so at most one
// device is paired at a time in the current model — the list/revoke API stays
// general (supports N) but is exercised here against that reality.
test('listDevices exposes the paired device with a non-secret id; resume updates lastSeen', () => {
  let now = 100
  const auth = new CompanionAuth(() => now)
  auth.arm('tok-a')
  const a = auth.hello('10.0.0.2', { token: 'tok-a' }, () => 'cred-1')
  const credA = a.result === 'paired' ? a.cred : ''

  const devices = auth.listDevices()
  expect(devices).toHaveLength(1)
  // The id is non-secret and never equal to the credential.
  expect(devices[0].id).not.toBe(credA)
  expect(/^d\d+$/.test(devices[0].id)).toBe(true)
  expect(devices[0].addr).toBe('10.0.0.2')
  expect(devices[0].pairedAt).toBe(100)

  // Resume bumps lastSeenAt and updates the address without adding a device.
  now = 300
  expect(auth.hello('10.0.0.9', { cred: credA }, () => 'x').result).toBe('resumed')
  const again = auth.listDevices()
  expect(again).toHaveLength(1)
  expect(again[0].lastSeenAt).toBe(300)
  expect(again[0].addr).toBe('10.0.0.9')
})

test('revoke removes the device and returns its credential; the cred then fails to resume', () => {
  const auth = new CompanionAuth(() => 0)
  auth.arm('tok')
  const v = auth.hello('10.0.0.2', { token: 'tok' }, () => 'cred-1')
  const cred = v.result === 'paired' ? v.cred : ''
  const id = auth.listDevices()[0].id

  expect(auth.revoke(id)).toBe(cred)
  expect(auth.credCount).toBe(0)
  // The revoked credential cannot resume — this is the lost-phone kill switch.
  expect(auth.hello('10.0.0.2', { cred }, () => 'x').result).toBe('denied')
  // Revoking an unknown id is a no-op.
  expect(auth.revoke('nope')).toBeNull()
})

test('revokeAll clears the device set and returns the revoked credentials', () => {
  const auth = new CompanionAuth(() => 0)
  auth.arm('t1')
  const a = auth.hello('10.0.0.2', { token: 't1' }, () => 'cred-1')
  const cred = a.result === 'paired' ? a.cred : ''
  expect(auth.revokeAll()).toEqual([cred])
  expect(auth.credCount).toBe(0)
  expect(auth.listDevices()).toEqual([])
})
