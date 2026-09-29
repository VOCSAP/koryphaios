import { expect, test } from 'bun:test'
import { win32 } from 'node:path'
import {
  ALLOW_FOREGROUND_SCRIPT,
  allowForegroundWindow,
  runForegroundHelper,
  windowsPowerShellPath,
  type AllowForegroundDeps,
  type ForegroundRunOptions
} from '../desktop/src/main/avatar-foreground.ts'

const { isAbsolute, join } = win32
const POWERSHELL_SUFFIX = join('System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

function deps(output: () => Promise<string>, overrides: Partial<AllowForegroundDeps> = {}) {
  const runs: Array<{ command: string; args: string[]; options: ForegroundRunOptions }> = []
  const reports: string[] = []
  const value: AllowForegroundDeps = {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\hostile-repo', PSModulePath: 'C:\\hostile-repo\\modules' },
    run: (command, args, options) => {
      runs.push({ command, args, options })
      return output()
    },
    report: (_scope, message) => reports.push(message),
    ...overrides
  }
  return { value, runs, reports }
}

test('starts PowerShell from the absolute SystemRoot, never by bare name, with System32 as cwd', async () => {
  const { value, runs } = deps(async () => 'True\r\n')
  expect(await allowForegroundWindow(4242, value)).toBe(true)
  expect(runs).toHaveLength(1)
  const [run] = runs
  expect(isAbsolute(run!.command), 'the PowerShell command must be an absolute path, not a bare name').toBe(true)
  expect(run!.command.endsWith(POWERSHELL_SUFFIX), `the PowerShell command must end with ${POWERSHELL_SUFFIX}`).toBe(true)
  expect(run!.command).toBe(join('C:\\Windows', POWERSHELL_SUFFIX))
  expect(run!.options.cwd).toBe(join('C:\\Windows', 'System32'))
  expect(run!.args).toEqual(['-NoProfile', '-NonInteractive', '-Command', ALLOW_FOREGROUND_SCRIPT])
  expect(run!.args.join(' ')).not.toContain('4242')
  expect(ALLOW_FOREGROUND_SCRIPT).toContain('AllowSetForegroundWindow([int]$env:KORY_FOCUS_PID)')
})

test('hands PowerShell a minimal env: SystemRoot and the pid, nothing inherited', async () => {
  const { value, runs } = deps(async () => 'True')
  await allowForegroundWindow(4242, value)
  expect(runs[0]!.options).toEqual({
    cwd: join('C:\\Windows', 'System32'),
    env: { SystemRoot: 'C:\\Windows', KORY_FOCUS_PID: '4242' },
    timeout: 5_000,
    windowsHide: true
  })
})

test('refuses and traces a missing, relative or dot-dot SystemRoot without starting anything', async () => {
  for (const systemRoot of [undefined, '', 'Windows', '.\\Windows', 'C:\\Windows\\..\\hostile']) {
    const { value, runs, reports } = deps(async () => 'True', { env: { SystemRoot: systemRoot } })
    expect(await allowForegroundWindow(4242, value)).toBe(false)
    expect(runs).toEqual([])
    expect(reports).toEqual([`refused to start PowerShell: SystemRoot is not an absolute path (${String(systemRoot)})`])
  }
  expect(windowsPowerShellPath('D:/Win')).toEqual({
    system32: join('D:/Win', 'System32'),
    powershell: join('D:/Win', POWERSHELL_SUFFIX)
  })
})

test('reports false for any answer other than True', async () => {
  for (const output of ['False', '', 'True but not quite']) {
    const { value } = deps(async () => output)
    expect(await allowForegroundWindow(4242, value)).toBe(false)
  }
})

test('refuses and traces a pid PowerShell [int] cannot hold, without starting PowerShell', async () => {
  for (const pid of [0, -1, 1.5, Number.NaN, 0x8000_0000, 0x1_0000_0000]) {
    const { value, runs, reports } = deps(async () => 'True')
    expect(await allowForegroundWindow(pid, value)).toBe(false)
    expect(runs).toEqual([])
    expect(reports).toEqual([`refused to cede the foreground to an invalid pid ${String(pid)}`])
  }
  const { value, runs } = deps(async () => 'True')
  expect(await allowForegroundWindow(0x7fff_ffff, value)).toBe(true)
  expect(runs).toHaveLength(1)
})

test('does nothing outside Windows', async () => {
  const { value, runs, reports } = deps(async () => 'True', { platform: 'linux' })
  expect(await allowForegroundWindow(4242, value)).toBe(false)
  expect(runs).toEqual([])
  expect(reports).toEqual([])
})

test('traces a failing helper and reports false', async () => {
  const { value, reports } = deps(() => Promise.reject(new Error('spawn ENOENT')))
  expect(await allowForegroundWindow(4242, value)).toBe(false)
  expect(reports).toEqual(['AllowSetForegroundWindow helper failed'])
})

test.skipIf(process.platform !== 'win32')('the real PowerShell helper prints a boolean', async () => {
  const outputs: string[] = []
  const result = await allowForegroundWindow(process.pid, {
    platform: 'win32',
    env: process.env,
    run: async (command, args, options) => {
      const output = await runForegroundHelper(command, args, { ...options, timeout: 15_000 })
      outputs.push(output.trim())
      return output
    },
    report: (_scope, message) => outputs.push(`report: ${message}`)
  })
  expect(typeof result).toBe('boolean')
  expect(outputs).toHaveLength(1)
  expect(['True', 'False']).toContain(outputs[0])
}, 20_000)
