// TEMPORARY CI diagnostic, card 7ce18c06: delete this file and its step in
// .github/workflows/desktop-build.yml once the avatar foreground helper hang on windows-latest is settled.
import { execFile } from "node:child_process";
import { win32 } from "node:path";

const VARIANT_TIMEOUT_MS = 60_000;
const WATCHDOG_GRACE_MS = 5_000;

const systemRoot = process.env.SystemRoot ?? "";
const system32 = win32.join(systemRoot, "System32");
const powershell = win32.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe");
const whoami = win32.join(system32, "whoami.exe");

const ADD_TYPE = [
  "Add-Type -Namespace KoryAvatar -Name Foreground -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool AllowSetForegroundWindow(int dwProcessId);'",
  "[KoryAvatar.Foreground]::AllowSetForegroundWindow([int]$env:KORY_FOCUS_PID)"
].join("; ");

const NO_OP = "[bool]$env:KORY_FOCUS_PID";

const REFLECTION_EMIT = [
  "$a=[AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName 'K'),'Run')",
  "$m=$a.DefineDynamicModule('K')",
  "$t=$m.DefineType('F','Public,Class')",
  "$pm=$t.DefinePInvokeMethod('AllowSetForegroundWindow','user32.dll','Public,Static,PinvokeImpl',[Reflection.CallingConventions]::Standard,[bool],[Type[]]@([int]),[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Auto)",
  "$pm.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)",
  "$f=$t.CreateType()",
  "$f::AllowSetForegroundWindow([int]$env:KORY_FOCUS_PID)"
].join("; ");

interface Outcome {
  ms: number
  exitCode: string
  killed: boolean
  signal: string
  stdout: string
  stderr: string
  note: string
}

function run(command: string, args: string[], env: Record<string, string>): Promise<Outcome> {
  const started = Date.now()
  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome: Omit<Outcome, "ms">): void => {
      if (settled) return
      settled = true
      clearTimeout(watchdog)
      resolve({ ms: Date.now() - started, ...outcome })
    }
    const watchdog = setTimeout(
      () => finish({ exitCode: "n/a", killed: false, signal: "n/a", stdout: "", stderr: "", note: "WATCHDOG: execFile callback never fired after the kill" }),
      VARIANT_TIMEOUT_MS + WATCHDOG_GRACE_MS
    )
    execFile(command, args, { cwd: system32, env, timeout: VARIANT_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      const failure = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: number | string | null }) | null
      finish({
        exitCode: failure ? String(failure.code ?? "null") : "0",
        killed: failure?.killed === true,
        signal: String(failure?.signal ?? "null"),
        stdout: String(stdout).trim(),
        stderr: String(stderr).trim(),
        note: failure ? `error: ${failure.message}` : ""
      })
    })
  })
}

function report(label: string, outcome: Outcome): void {
  console.log(`--- ${label}`)
  console.log(`duration_ms=${outcome.ms} exit_code=${outcome.exitCode} killed=${String(outcome.killed)} signal=${outcome.signal}`)
  if (outcome.note) console.log(`note: ${outcome.note}`)
  console.log(`stdout: ${JSON.stringify(outcome.stdout)}`)
  console.log(`stderr: ${JSON.stringify(outcome.stderr)}`)
}

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    console.log("not windows, nothing to diagnose")
    return
  }
  console.log(`SystemRoot=${JSON.stringify(systemRoot)} powershell=${powershell}`)
  console.log(`bun=${process.versions.bun ?? "n/a"} focus_pid=${process.pid}`)

  report("whoami /user", await run(whoami, ["/user"], { SystemRoot: systemRoot }))

  const focusPid = String(process.pid)
  const reduced = { SystemRoot: systemRoot, KORY_FOCUS_PID: focusPid }
  const full = { ...process.env, KORY_FOCUS_PID: focusPid } as Record<string, string>
  const psArgs = (script: string): string[] => ["-NoProfile", "-NonInteractive", "-Command", script]

  report("(a) no-op, reduced env", await run(powershell, psArgs(NO_OP), reduced))
  report("(b) Add-Type, reduced env (product command)", await run(powershell, psArgs(ADD_TYPE), reduced))
  report("(c) Add-Type, full env", await run(powershell, psArgs(ADD_TYPE), full))
  report("(d) Reflection.Emit P/Invoke, reduced env", await run(powershell, psArgs(REFLECTION_EMIT), reduced))
}

main().catch((error: unknown) => {
  console.log(`diagnostic script itself failed: ${error instanceof Error ? error.stack : String(error)}`)
})
