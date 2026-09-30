import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import { reportError } from './log'
import { system32Dir } from './windows-system-root'

export const ALLOW_FOREGROUND_TIMEOUT_MS = 5_000
const MAX_POWERSHELL_INT = 0x7fffffff

/** A pure .NET P/Invoke: any cmdlet invocation triggers command discovery, which is slow under the reduced env. */
export const ALLOW_FOREGROUND_SCRIPT = [
  "$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('KoryAvatar'), 'Run')",
  "$type = $assembly.DefineDynamicModule('KoryAvatar').DefineType('Foreground', 'Public,Class')",
  "$method = $type.DefinePInvokeMethod('AllowSetForegroundWindow', 'user32.dll', 'Public,Static,PinvokeImpl', [Reflection.CallingConventions]::Standard, [bool], [Type[]]@([int]), [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Auto)",
  '$method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)',
  '$foreground = $type.CreateType()',
  '$foreground::AllowSetForegroundWindow([int]$env:KORY_FOCUS_PID)'
].join('; ')

const QUOTED_TEXT = /'(?:[^']|'')*'/g
const VERB_NOUN = /\b[A-Za-z]+-[A-Za-z]+\b/g

/**
 * Lists Verb-Noun names, pipelines, call operators and statements not starting with a variable or a type.
 * Blind to a non Verb-Noun command inside an expression, such as `$x = iex ...` or `$(...)`.
 */
export function powerShellCommandInvocations(script: string): string[] {
  const code = script.replace(QUOTED_TEXT, "''")
  const found = [...code.matchAll(VERB_NOUN)].map((match) => match[0])
  for (const statement of code.split(';').map((part) => part.trim()).filter(Boolean)) {
    if (!/^[$[]/.test(statement)) found.push(statement.split(/\s+/)[0]!)
  }
  for (const operator of code.match(/[|&]/g) ?? []) found.push(operator)
  return found
}

export interface ForegroundRunOptions {
  cwd: string
  env: Record<string, string>
  timeout: number
  windowsHide: true
}

export interface AllowForegroundDeps {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  run(command: string, args: string[], options: ForegroundRunOptions): Promise<string>
  report?: typeof reportError
}

export function runForegroundHelper(command: string, args: string[], options: ForegroundRunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout) => (error ? reject(error) : resolve(String(stdout))))
  })
}

export function isForegroundPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0 && pid <= MAX_POWERSHELL_INT
}

/** Null unless SystemRoot is an absolute drive path: a bare name would let the cwd supply powershell.exe. */
export function windowsPowerShellPath(systemRoot: string | undefined): { system32: string; powershell: string } | null {
  const system32 = system32Dir(systemRoot)
  if (!system32.ok) return null
  return { system32: system32.dir, powershell: win32.join(system32.dir, 'WindowsPowerShell', 'v1.0', 'powershell.exe') }
}

/**
 * Cedes the Windows foreground right to a Deck process; a no-op returning false elsewhere.
 * The pid is the one the Deck declared at attach: it is validated and must be alive, but it is not
 * proven to belong to that Deck, nor to the same user.
 */
export async function allowForegroundWindow(pid: number, deps: AllowForegroundDeps): Promise<boolean> {
  const report = deps.report ?? reportError
  if (deps.platform !== 'win32') return false
  if (!isForegroundPid(pid)) {
    report('avatar-focus', `refused to cede the foreground to an invalid pid ${String(pid)}`)
    return false
  }
  const systemRoot = deps.env.SystemRoot
  const paths = windowsPowerShellPath(systemRoot)
  if (!paths || !systemRoot) {
    report('avatar-focus', `refused to start PowerShell: SystemRoot is not an absolute path (${String(systemRoot)})`)
    return false
  }
  try {
    const output = await deps.run(paths.powershell, ['-NoProfile', '-NonInteractive', '-Command', ALLOW_FOREGROUND_SCRIPT], {
      cwd: paths.system32,
      env: { SystemRoot: systemRoot, KORY_FOCUS_PID: String(pid) },
      timeout: ALLOW_FOREGROUND_TIMEOUT_MS,
      windowsHide: true
    })
    return output.trim() === 'True'
  } catch (error) {
    report('avatar-focus', 'AllowSetForegroundWindow helper failed', error)
    return false
  }
}
