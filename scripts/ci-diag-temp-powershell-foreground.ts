// TEMPORARY CI diagnostic, card 7ce18c06: delete this file and its step in
// .github/workflows/desktop-build.yml once the avatar foreground helper hang on windows-latest is settled.
import { execFile } from "node:child_process"
import { win32 } from "node:path"

const VARIANT_TIMEOUT_MS = 60_000
const WATCHDOG_GRACE_MS = 5_000
const LAUNCH_DEADLINE_MS = 13 * 60_000

const systemRoot = process.env.SystemRoot ?? ""
const system32 = win32.join(systemRoot, "System32")
const powershell = win32.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe")
const whoami = win32.join(system32, "whoami.exe")
const minimalModulePath = win32.join(system32, "WindowsPowerShell", "v1.0", "Modules")

const ADD_TYPE = [
  "Add-Type -Namespace KoryAvatar -Name Foreground -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool AllowSetForegroundWindow(int dwProcessId);'",
  "[KoryAvatar.Foreground]::AllowSetForegroundWindow([int]$env:KORY_FOCUS_PID)"
].join("; ")

const EMIT_NO_CMDLET = [
  "$a=[AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('K'),'Run')",
  "$m=$a.DefineDynamicModule('K')",
  "$t=$m.DefineType('F','Public,Class')",
  "$pm=$t.DefinePInvokeMethod('AllowSetForegroundWindow','user32.dll','Public,Static,PinvokeImpl',[Reflection.CallingConventions]::Standard,[bool],[Type[]]@([int]),[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Auto)",
  "$pm.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)",
  "$f=$t.CreateType()",
  "$f::AllowSetForegroundWindow([int]$env:KORY_FOCUS_PID)"
].join("; ")

const PROBE_PREFIX = [
  "$sw=[Diagnostics.Stopwatch]::StartNew()",
  "$null=Get-Command Add-Type",
  "'getcommand_ms=' + $sw.ElapsedMilliseconds",
  "'modules=' + ((Get-Module | % Name) -join ',')",
  "'psmodulepath=' + $env:PSModulePath",
  "'localappdata_folder=' + [Environment]::GetFolderPath('LocalApplicationData')"
].join("; ")

const PROBE_PREFIX_NO_CMDLET = ["'psmodulepath=' + $env:PSModulePath", "'localappdata_folder=' + [Environment]::GetFolderPath('LocalApplicationData')"].join("; ")

const PRODUCT_WITH_PROBE = `${PROBE_PREFIX}; ${ADD_TYPE}`
const EMIT_WITH_PROBE = `${PROBE_PREFIX_NO_CMDLET}; ${EMIT_NO_CMDLET}`

const GROUPS: Array<{ label: string; keys: string[] }> = [
  { label: "LOCALAPPDATA", keys: ["LOCALAPPDATA"] },
  { label: "APPDATA", keys: ["APPDATA"] },
  { label: "USERPROFILE", keys: ["USERPROFILE"] },
  { label: "TEMP+TMP", keys: ["TEMP", "TMP"] },
  { label: "ProgramFiles family", keys: ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432"] },
  { label: "PSModulePath (inherited)", keys: ["PSModulePath"] },
  { label: "ProgramData", keys: ["ProgramData"] }
]

type Env = Record<string, string>

interface Variant {
  label: string
  env: Env
  script: string
  skipReason?: string
}

interface Outcome {
  ms: number
  exitCode: string
  killed: boolean
  signal: string
  stdout: string
  stderr: string
  note: string
}

function inherited(key: string): string | undefined {
  const wanted = key.toLowerCase()
  for (const [name, value] of Object.entries(process.env)) {
    if (name.toLowerCase() === wanted && value !== undefined) return value
  }
  return undefined
}

function withoutKeys(env: Env, keys: string[]): Env {
  const drop = new Set(keys.map((key) => key.toLowerCase()))
  return Object.fromEntries(Object.entries(env).filter(([name]) => !drop.has(name.toLowerCase())))
}

function buildVariants(focusPid: string): Variant[] {
  const reduced: Env = { SystemRoot: systemRoot, KORY_FOCUS_PID: focusPid }
  const full = { ...process.env, KORY_FOCUS_PID: focusPid } as Env
  const variants: Variant[] = [
    { label: "R0 witness: reduced env, product script, no probe", env: reduced, script: ADD_TYPE },
    { label: "R0p reduced env, product script, with probe", env: reduced, script: PRODUCT_WITH_PROBE },
    { label: "R1 reduced env, Emit without any cmdlet, with cmdlet-free probe", env: reduced, script: EMIT_WITH_PROBE },
    { label: "R2 reduced env + minimal PSModulePath, product script, with probe", env: { ...reduced, PSModulePath: minimalModulePath }, script: PRODUCT_WITH_PROBE }
  ]
  for (const group of GROUPS) {
    const added: Env = {}
    for (const key of group.keys) {
      const value = inherited(key)
      if (value !== undefined) added[key] = value
    }
    variants.push({
      label: `ADD ${group.label}: reduced env + group, product script, with probe (${Object.entries(added).map(([k, v]) => `${k}=${v}`).join(" ; ") || "no value"})`,
      env: { ...reduced, ...added },
      script: PRODUCT_WITH_PROBE,
      skipReason: Object.keys(added).length === 0 ? `none of ${group.keys.join(",")} is set on this runner` : undefined
    })
  }
  for (const group of GROUPS) {
    variants.push({
      label: `REMOVE ${group.label}: full env minus group, product script, with probe`,
      env: withoutKeys(full, group.keys),
      script: PRODUCT_WITH_PROBE
    })
  }
  return variants
}

function run(command: string, args: string[], env: Env): Promise<Outcome> {
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
  console.log("stdout:")
  for (const line of outcome.stdout.split(/\r?\n/)) console.log(`  ${line}`)
  console.log(`stderr: ${JSON.stringify(outcome.stderr)}`)
}

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    console.log("not windows, nothing to diagnose")
    return
  }
  const started = Date.now()
  console.log(`SystemRoot=${JSON.stringify(systemRoot)} powershell=${powershell}`)
  console.log(`bun=${process.versions.bun ?? "n/a"} focus_pid=${process.pid}`)

  report("whoami /user", await run(whoami, ["/user"], { SystemRoot: systemRoot }))

  for (const variant of buildVariants(String(process.pid))) {
    if (variant.skipReason) {
      console.log(`--- ${variant.label}\nSKIPPED: ${variant.skipReason}`)
      continue
    }
    if (Date.now() - started > LAUNCH_DEADLINE_MS) {
      console.log(`--- ${variant.label}\nSKIPPED: launch deadline of ${LAUNCH_DEADLINE_MS} ms reached, the step budget would be exceeded`)
      continue
    }
    report(variant.label, await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", variant.script], variant.env))
  }
}

main().catch((error: unknown) => {
  console.log(`diagnostic script itself failed: ${error instanceof Error ? error.stack : String(error)}`)
})
