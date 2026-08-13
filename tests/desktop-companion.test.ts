// PLAN MB1/MB2: companion protocol invariants (manifest coverage, channel
// uniqueness, tier completeness), the LAN-only guard, the frame parser, and
// the pairing/lockout lifecycle. All pure — no electron, no sockets.

import { test, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  // Renamed (review round, correction 8): this test's original name --
  // "REMOTE_BLOCKED_CHANNELS is complete" -- overclaimed. It cannot detect a
  // channel missing a CHANNEL_TIERS entry altogether (that's the new
  // regHandle-coverage test below); it only proves the DERIVATION mechanism
  // itself (companion.ts's union spread over Object.entries(CHANNEL_TIERS))
  // actually reads every tier>=3 entry instead of silently dropping some.
  //
  // CHANNEL_TIERS used to be purely declarative -- a channel could be tiered
  // 3 and still be missing from the hand-written deny-list, nothing failing
  // ('config:set', 'launch:set-global' were exactly that gap). This asserts
  // the derived union (companion.ts, after CHANNEL_TIERS) actually covers
  // the whole tier>=3 set, not just the channels someone remembered to list.
  for (const [channel, tier] of Object.entries(CHANNEL_TIERS)) {
    if (tier >= 3) expect(REMOTE_BLOCKED_CHANNELS.has(channel)).toBe(true)
  }
})

// companion-server.ts denies REMOTE_BLOCKED_CHANNELS then invokes -- a
// regHandle'd channel with NO CHANNEL_TIERS entry is neither tier>=3 nor in
// the explicit floor, so it is remotely invocable by DEFAULT (fail-open).
//
// Review round, second pass (reviewer measurement): a first version of this
// guard hardcoded ipc.ts as the only file to scan and required the channel's
// quote glued to the call's opening paren. Real domain was 112 registered
// channels (101 in ipc.ts + 11 in index.ts, companion:*/approvals:*), not
// the 99 that shape found -- 2 lost to multi-line `regHandle(\n  'chan',`
// calls (browser:demo-run, help:ask), 11 lost to never reading index.ts at
// all. Both gaps were SILENT: the guard read green while covering 99/112.
//
// Fixed two ways: (1) the file set is DISCOVERED by walking main/ for any
// file containing a call-shaped `regHandle(` (not `api-registry.ts`'s own
// `export function regHandle(channel: string, ...)` declaration -- the
// negative lookbehind excludes that one specifically), so a third file that
// starts calling regHandle tomorrow is picked up without editing this test.
// (2) the extractor is FAIL-CLOSED on ITS OWN reach: it counts every
// call-shaped `regHandle(` occurrence per file and compares that to how many
// it could parse a plain single-quoted first argument out of. A gap (a
// channel built via backtick, string concatenation, a double-quoted literal,
// or anything else this regex can't read) is a NAMED, LOUD failure -- not a
// silent undercount that still reads green because the rest of the domain
// happens to be clean.
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

// ask_operator lot (mutation review, trou 1): 'approvals:reply' and
// 'approvals:decline' render a HUMAN VERDICT that a stopped agent consumes
// and acts on directly -- unlike inbox:reply (a message; the recipient keeps
// judgement) a remote companion answering here MANUFACTURES the human
// consent that was the only thing stopping the agent (companion.ts's own
// comment above EXPLICIT_REMOTE_BLOCKED_CHANNELS, 'ask_operator lot' section).
// Both channels are tier 2 in CHANNEL_TIERS, BELOW the tier>=3 threshold that
// REMOTE_BLOCKED_CHANNELS auto-unions -- so nothing derives their presence on
// the floor; they are only blocked because EXPLICIT_REMOTE_BLOCKED_CHANNELS
// hand-lists them. Measured (mutation review): removing either from that
// list leaves desktop-companion.test.ts, desktop-approvals.test.ts and
// mobile-shell-approvals.test.ts all green (70/70) -- nothing else in the
// suite exercises this specific pair.
//
// This is a deliberately NAMED PAIR, not a derived rule: CHANNEL_TIERS has no
// field encoding "renders a human verdict an agent consumes" (only the
// numeric 0-3 sensitivity tier), and inventing one that doesn't exist in the
// code to make this "derivable" would be exactly the fabricated taxonomy
// this repo's conventions warn against. If a third channel gains this same
// property later, it must be added to EXPLICIT_REMOTE_BLOCKED_CHANNELS AND
// to this list by hand -- neither happens automatically.
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
  // The revoked credential can no longer resume — this is the lost-phone kill switch.
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
