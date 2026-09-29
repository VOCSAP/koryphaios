import { expect, test } from 'bun:test'
import { connect, createServer } from 'node:net'
import {
  SOCKET_OWNER_TIMEOUT_MS,
  loopbackSocketOwner,
  parseNetstatOwner,
  runSocketOwnerHelper,
  type SocketOwnerRunOptions
} from '../desktop/src/main/avatar-socket-owner.ts'

const deckSide = { address: '127.0.0.1', port: 50_123 }
const avatarSide = { address: '127.0.0.1', port: 50_100 }

const NETSTAT = [
  '',
  'Connexions actives',
  '',
  '  Proto  Adresse locale         Adresse distante       État',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1180',
  '  TCP    127.0.0.1:50100        0.0.0.0:0              LISTENING       7777',
  '  TCP    127.0.0.1:50100        127.0.0.1:50123        ESTABLISHED     7777',
  '  TCP    127.0.0.1:50123        127.0.0.1:50100        ESTABLISHED     4242',
  '  TCP    [::1]:50123            [::1]:50100            ESTABLISHED     9999',
  ''
].join('\r\n')

test('the owner is read from the row whose local end is the Deck side, not from the Avatar side of the same pair', () => {
  expect(parseNetstatOwner(NETSTAT, deckSide, avatarSide)).toBe(4242)
  expect(parseNetstatOwner(NETSTAT, avatarSide, deckSide), 'the reversed pair is the Avatar itself').toBe(7777)
})

test('no owner when the pair is absent, only IPv6, or only a closed connection', () => {
  expect(parseNetstatOwner(NETSTAT, { address: '127.0.0.1', port: 50_124 }, avatarSide)).toBeNull()
  expect(parseNetstatOwner('', deckSide, avatarSide)).toBeNull()
  const timeWait = '  TCP    127.0.0.1:50123        127.0.0.1:50100        TIME_WAIT       0'
  expect(parseNetstatOwner(timeWait, deckSide, avatarSide)).toBeNull()
})

test('a state column in another language, or spelled in two words, does not change the owner', () => {
  const localized = '  TCP    127.0.0.1:50123        127.0.0.1:50100        ÉTABLIE PAR TEST     4242'
  expect(parseNetstatOwner(localized, deckSide, avatarSide)).toBe(4242)
})

test('an unreadable pid, or two rows that disagree, name no owner', () => {
  const garbled = '  TCP    127.0.0.1:50123        127.0.0.1:50100        ESTABLISHED     42x2'
  expect(parseNetstatOwner(garbled, deckSide, avatarSide)).toBeNull()
  const disagree = [
    '  TCP    127.0.0.1:50123        127.0.0.1:50100        ESTABLISHED     4242',
    '  TCP    127.0.0.1:50123        127.0.0.1:50100        ESTABLISHED     5151'
  ].join('\r\n')
  expect(parseNetstatOwner(disagree, deckSide, avatarSide)).toBeNull()
})

test('netstat is started from the absolute SystemRoot with a bounded wait, never by bare name', async () => {
  const runs: Array<{ command: string; args: string[]; options: SocketOwnerRunOptions }> = []
  const owner = await loopbackSocketOwner(deckSide, avatarSide, {
    env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\hostile-repo' },
    run: async (command, args, options) => {
      runs.push({ command, args, options })
      return NETSTAT
    }
  })
  expect(owner).toBe(4242)
  expect(runs).toEqual([
    {
      command: 'C:\\Windows\\System32\\NETSTAT.EXE',
      args: ['-ano', '-p', 'TCP'],
      options: { cwd: 'C:\\Windows\\System32', env: { SystemRoot: 'C:\\Windows' }, timeout: SOCKET_OWNER_TIMEOUT_MS, windowsHide: true }
    }
  ])
})

test('a SystemRoot the working directory could complete starts nothing and throws', async () => {
  for (const systemRoot of [undefined, '', 'rel', 'C:\\Windows\\..\\rel']) {
    let started = false
    await expect(
      loopbackSocketOwner(deckSide, avatarSide, {
        env: { SystemRoot: systemRoot },
        run: async () => {
          started = true
          return NETSTAT
        }
      }),
      String(systemRoot)
    ).rejects.toThrow(`refused to start netstat: SystemRoot is not an absolute path (${String(systemRoot)})`)
    expect(started).toBe(false)
  }
})

test('a failed or timed-out netstat is an error, never an owner', async () => {
  await expect(
    loopbackSocketOwner(deckSide, avatarSide, {
      env: { SystemRoot: 'C:\\Windows' },
      run: () => Promise.reject(new Error('Command failed: timed out'))
    })
  ).rejects.toThrow('timed out')
})

test.skipIf(process.platform !== 'win32')('the real netstat names this process as the owner of its own loopback connection', async () => {
  const server = createServer(() => {})
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const avatarPort = (server.address() as { port: number }).port
  const client = connect(avatarPort, '127.0.0.1')
  try {
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve())
      client.once('error', reject)
    })
    const owner = await loopbackSocketOwner(
      { address: '127.0.0.1', port: client.localPort! },
      { address: '127.0.0.1', port: avatarPort },
      { env: process.env, run: runSocketOwnerHelper }
    )
    expect(owner).toBe(process.pid)
  } finally {
    client.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
