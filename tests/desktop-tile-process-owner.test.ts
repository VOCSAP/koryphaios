import { describe, expect, test } from 'bun:test'
import {
  CONNECTION_CLOCK_SLACK_MS,
  judgeTileClaude,
  listWin32Processes,
  parseProcessListing,
  PROCESS_LIST_TIMEOUT_MS,
  tileOfClaude,
  type ProcessRow
} from '../desktop/src/main/tile-process-owner.ts'

const SHELL = 100
const row = (pid: number, ppid: number, name: string, createdAt: number): ProcessRow => ({ pid, ppid, name, createdAt })

/** The chain measured on a Windows npm install: the shell, a node.exe, a cmd.exe shim, then claude.exe. */
const npmChain = (): ProcessRow[] => [
  row(1, 0, 'koryphaios.exe', 1000),
  row(SHELL, 1, 'powershell.exe', 2000),
  row(101, SHELL, 'node.exe', 3000),
  row(102, 101, 'cmd.exe', 4000),
  row(103, 102, 'claude.exe', 5000)
]

describe('judgeTileClaude', () => {
  test('accepts the claude.exe under the npm shim chain, whatever its depth', () => {
    expect(judgeTileClaude(npmChain(), 103, SHELL)).toEqual({ ok: true })
    const native = [row(SHELL, 1, 'powershell.exe', 2000), row(110, SHELL, 'claude.exe', 3000)]
    expect(judgeTileClaude(native, 110, SHELL)).toEqual({ ok: true })
    const deep = [row(SHELL, 1, 'powershell.exe', 10)]
    for (let pid = 200; pid < 220; pid++) deep.push(row(pid, pid === 200 ? SHELL : pid - 1, 'cmd.exe', pid))
    deep.push(row(300, 219, 'claude.exe', 1000))
    expect(judgeTileClaude(deep, 300, SHELL)).toEqual({ ok: true })
  })

  test('accepts a claude.exe that is the PTY process itself', () => {
    expect(judgeTileClaude([row(SHELL, 1, 'claude.exe', 2000)], SHELL, SHELL)).toEqual({ ok: true })
  })

  test('the image name is claude.exe whatever its case, and nothing else', () => {
    for (const name of ['claude.exe', 'Claude.EXE', 'CLAUDE.EXE']) {
      const rows = npmChain().map((r) => (r.pid === 103 ? { ...r, name } : r))
      expect(judgeTileClaude(rows, 103, SHELL), name).toEqual({ ok: true })
    }
    for (const name of ['node.exe', 'claude', 'claude.exe.bak', 'myclaude.exe', 'claude.exe ', '']) {
      const rows = npmChain().map((r) => (r.pid === 103 ? { ...r, name } : r))
      expect(judgeTileClaude(rows, 103, SHELL), JSON.stringify(name)).toEqual({ ok: false, reason: 'not-claude' })
    }
  })

  test('a process that is not in the table is refused', () => {
    expect(judgeTileClaude(npmChain(), 999, SHELL)).toEqual({ ok: false, reason: 'unknown-process' })
  })

  test('a claude.exe under another shell, a missing parent or a cycle never reaches the shell', () => {
    const elsewhere = [...npmChain(), row(400, 1, 'powershell.exe', 2500), row(401, 400, 'claude.exe', 6000)]
    expect(judgeTileClaude(elsewhere, 401, SHELL)).toEqual({ ok: false, reason: 'no-parent-chain' })

    const orphan = [row(SHELL, 1, 'powershell.exe', 2000), row(500, 777, 'claude.exe', 3000)]
    expect(judgeTileClaude(orphan, 500, SHELL)).toEqual({ ok: false, reason: 'no-parent-chain' })

    const cycle = [row(SHELL, 1, 'powershell.exe', 2000), row(600, 601, 'cmd.exe', 3000), row(601, 600, 'cmd.exe', 3000), row(602, 600, 'claude.exe', 3000)]
    expect(judgeTileClaude(cycle, 602, SHELL)).toEqual({ ok: false, reason: 'no-parent-chain' })

    const tooDeep = [row(SHELL, 1, 'powershell.exe', 10)]
    for (let pid = 700; pid < 800; pid++) tooDeep.push(row(pid, pid === 700 ? SHELL : pid - 1, 'cmd.exe', pid))
    tooDeep.push(row(900, 799, 'claude.exe', 5000))
    expect(judgeTileClaude(tooDeep, 900, SHELL), 'a hundred links reach the shell, past the depth cap').toEqual({
      ok: false,
      reason: 'no-parent-chain'
    })
  })

  test('another claude.exe between the candidate and the shell disqualifies it, a claude -p of the model included', () => {
    const rows = [
      ...npmChain(),
      row(110, 103, 'bash.exe', 6000),
      row(111, 110, 'node.exe', 7000),
      row(112, 111, 'claude.exe', 8000)
    ]
    expect(judgeTileClaude(rows, 103, SHELL), 'the tile claude itself is still fine').toEqual({ ok: true })
    expect(judgeTileClaude(rows, 112, SHELL)).toEqual({ ok: false, reason: 'foreign-claude' })
  })

  test('a link created before its parent is a reused pid and is refused, an equal date is not', () => {
    const olderThanShell = [row(SHELL, 1, 'powershell.exe', 2000), row(120, SHELL, 'claude.exe', 1999)]
    expect(judgeTileClaude(olderThanShell, 120, SHELL)).toEqual({ ok: false, reason: 'created-before-parent' })

    const middle = npmChain().map((r) => (r.pid === 102 ? { ...r, createdAt: 2500 } : r))
    expect(judgeTileClaude(middle, 103, SHELL), 'cmd.exe older than its parent node.exe').toEqual({
      ok: false,
      reason: 'created-before-parent'
    })

    const sameMillisecond = [row(SHELL, 1, 'powershell.exe', 2000), row(121, SHELL, 'claude.exe', 2000)]
    expect(judgeTileClaude(sameMillisecond, 121, SHELL)).toEqual({ ok: true })
  })
})

describe('judgeTileClaude and the moment of the connection', () => {
  const accepted = 10_000

  test('a claude.exe created after the connection was accepted cannot be its owner', () => {
    const rows = npmChain().map((r) => (r.pid === 103 ? { ...r, createdAt: accepted + CONNECTION_CLOCK_SLACK_MS + 1 } : r))
    expect(judgeTileClaude(rows, 103, SHELL, accepted)).toEqual({ ok: false, reason: 'created-after-connection' })
  })

  test('a creation within the clock slack of the connection is still accepted, and so is any earlier one', () => {
    for (const createdAt of [accepted + CONNECTION_CLOCK_SLACK_MS, accepted, 5000]) {
      const rows = npmChain().map((r) => (r.pid === 103 ? { ...r, createdAt } : r))
      expect(judgeTileClaude(rows, 103, SHELL, accepted), String(createdAt)).toEqual({ ok: true })
    }
  })

  test('without a connection time nothing is compared, and tileOfClaude passes it to every tile it judges', () => {
    const late = npmChain().map((r) => (r.pid === 103 ? { ...r, createdAt: 99_999 } : r))
    expect(judgeTileClaude(late, 103, SHELL)).toEqual({ ok: true })
    expect(tileOfClaude(late, 103, [{ id: 'tile-a', ptyPid: SHELL }])).toBe('tile-a')
    expect(tileOfClaude(late, 103, [{ id: 'tile-a', ptyPid: SHELL }], accepted)).toBeNull()
  })
})

describe('tileOfClaude', () => {
  test('names the one tile whose shell the claude.exe descends from', () => {
    const rows = [
      ...npmChain(),
      row(200, 1, 'powershell.exe', 2000),
      row(201, 200, 'claude.exe', 3000)
    ]
    const tiles = [
      { id: 'tile-a', ptyPid: SHELL },
      { id: 'tile-b', ptyPid: 200 }
    ]
    expect(tileOfClaude(rows, 103, tiles)).toBe('tile-a')
    expect(tileOfClaude(rows, 201, tiles)).toBe('tile-b')
  })

  test('no tile, or two tiles that both accept the process, name none', () => {
    expect(tileOfClaude(npmChain(), 103, [{ id: 'tile-z', ptyPid: 5000 }])).toBeNull()
    expect(tileOfClaude(npmChain(), 103, [])).toBeNull()
    expect(
      tileOfClaude(npmChain(), 103, [
        { id: 'tile-a', ptyPid: SHELL },
        { id: 'tile-twin', ptyPid: SHELL }
      ])
    ).toBeNull()
  })
})

describe('the process listing', () => {
  test('reads one row per line: pids, name and a creation date in milliseconds', () => {
    const rows = parseProcessListing(
      ['4242|100|2026-11-20T16:00:00.1234567Z|claude.exe', '', '7|0|2026-11-20T16:00:01Z|My Tool.exe\r'].join('\r\n')
    )
    expect(rows).toEqual([
      { pid: 4242, ppid: 100, name: 'claude.exe', createdAt: Date.parse('2026-11-20T16:00:00.123Z') },
      { pid: 7, ppid: 0, name: 'My Tool.exe', createdAt: Date.parse('2026-11-20T16:00:01Z') }
    ])
  })

  test('a line it cannot read refuses the whole listing, without echoing the line', () => {
    for (const bad of ['garbage', '1|2|not-a-date|x.exe', 'x|2|2026-11-20T16:00:00Z|a.exe', '1|2|2026-11-20T16:00:00Z|']) {
      expect(() => parseProcessListing(`1|0|2026-11-20T16:00:00Z|ok.exe\n${bad}`), bad).toThrow('unreadable process listing line')
    }
  })

  test('PowerShell is named from an absolute SystemRoot and runs with its environment reduced to it', async () => {
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = []
    const rows = await listWin32Processes({
      env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Users\\someone\\repo' },
      run: async (command, args, options) => {
        calls.push({ command, args, options: { ...options } })
        return '5|1|2026-11-20T16:00:00Z|claude.exe\n'
      }
    })
    expect(rows).toHaveLength(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.command).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(calls[0]!.args).toContain('-NoProfile')
    expect(calls[0]!.args.join(' ')).toContain('Win32_Process')
    expect(calls[0]!.options).toEqual({
      cwd: 'C:\\Windows\\System32',
      env: { SystemRoot: 'C:\\Windows', PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules' },
      timeout: PROCESS_LIST_TIMEOUT_MS,
      windowsHide: true
    })
  })

  test('a SystemRoot that is not an absolute path starts nothing', async () => {
    for (const systemRoot of [undefined, '', 'Windows', '.\\Windows', 'C:\\..\\Windows']) {
      let started = false
      await expect(
        listWin32Processes({
          env: { SystemRoot: systemRoot },
          run: async () => {
            started = true
            return ''
          }
        }),
        String(systemRoot)
      ).rejects.toThrow('refused to start powershell')
      expect(started, String(systemRoot)).toBe(false)
    }
  })
})
