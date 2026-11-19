import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { homedir, platform } from 'node:os'
import type { HostRoadmapMcpStatus } from '../shared/types'
import { ROADMAP_MCP_SERVER, isRoadmapMcpRegistered } from './sandbox-command'
import { buildSpawnPlan } from './shell-command'

export const HOST_ROADMAP_PROBE_COMMAND = `claude mcp get ${ROADMAP_MCP_SERVER}`
/** `mcp get` starts the server for its health check, so a registered entry takes seconds. */
export const HOST_ROADMAP_PROBE_TIMEOUT_MS = 20_000

export interface HostRoadmapProbeRun {
  /** Exit code; null when the process never ran or was killed. */
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export function classifyHostRoadmapProbe(run: HostRoadmapProbeRun): HostRoadmapMcpStatus {
  if (run.timedOut) return 'unknown'
  const output = `${run.stdout}\n${run.stderr}`
  if (run.code === 0) {
    if (isRoadmapMcpRegistered(0, run.stdout)) return 'registered'
    return /^\s*Scope:/m.test(run.stdout) ? 'wrong-scope' : 'unknown'
  }
  if (run.code === 1 && output.includes('No MCP server named')) return 'missing'
  return 'unknown'
}

export interface HostProbeSpawnDeps {
  spawn: (file: string, args: string[], options: SpawnOptions) => ChildProcess
  platform: NodeJS.Platform
  /** POSIX only: signals the whole process group of a detached child. */
  killGroup: (pid: number) => void
}

const SYSTEM_SPAWN: HostProbeSpawnDeps = {
  spawn,
  platform: platform(),
  killGroup: (pid) => process.kill(-pid, 'SIGKILL')
}

const PROBE_OUTPUT_MAX_CHARS = 64 * 1024

/**
 * Runs the probe in the operator's home so a cloned repo's `.mcp.json` cannot
 * change the answer. The timeout kills the whole tree: win32 through the Job
 * Object `buildSpawnPlan` enters (the job dies with the shell), POSIX through
 * the process group of a detached child. `spawn` and not `execFile`, which
 * does not forward `detached`.
 */
export function runHostRoadmapProbe(
  shell: string,
  timeoutMs: number = HOST_ROADMAP_PROBE_TIMEOUT_MS,
  deps: HostProbeSpawnDeps = SYSTEM_SPAWN
): Promise<HostRoadmapProbeRun> {
  const plan = buildSpawnPlan({ command: HOST_ROADMAP_PROBE_COMMAND, shell, interactive: false }, undefined, deps.platform)
  const posix = deps.platform !== 'win32'
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let done = false
    const finish = (run: HostRoadmapProbeRun): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(run)
    }
    const child = deps.spawn(plan.invocation.file, plan.invocation.args, {
      env: plan.env,
      cwd: homedir(),
      windowsHide: true,
      detached: posix,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    // A decoder on the stream keeps a multibyte character split across two chunks whole.
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(0, PROBE_OUTPUT_MAX_CHARS)
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(0, PROBE_OUTPUT_MAX_CHARS)
    })
    child.once('error', (error: Error) => finish({ code: null, stdout, stderr: stderr || error.message, timedOut }))
    child.once('close', (code: number | null) => finish({ code, stdout, stderr, timedOut }))
    const timer = setTimeout(() => {
      timedOut = true
      if (posix && child.pid !== undefined) {
        try {
          deps.killGroup(child.pid)
          return
        } catch {
          // The group is already gone or unsignalable: fall through to the direct kill.
        }
      }
      child.kill('SIGKILL')
    }, timeoutMs)
  })
}

export interface HostRoadmapMcpProbe {
  /**
   * The verdict of the current probe. `force` asks for a probe that starts
   * after now: at once when none runs, else ONE probe chained behind the
   * running one, however many forced calls arrive meanwhile.
   */
  status(force?: boolean): Promise<HostRoadmapMcpStatus>
}

export interface HostRoadmapMcpProbeDeps {
  run: () => Promise<HostRoadmapProbeRun>
  report: (scope: string, message: string, error?: unknown) => void
  timeoutMs?: number
}

export function createHostRoadmapMcpProbe(deps: HostRoadmapMcpProbeDeps): HostRoadmapMcpProbe {
  const timeoutMs = deps.timeoutMs ?? HOST_ROADMAP_PROBE_TIMEOUT_MS
  let current: Promise<HostRoadmapMcpStatus> | null = null
  let running = false
  let queued = false

  // A hung MCP server can keep the child's pipes open past the shell's own
  // kill, so the bound lives here too, not only in the runner.
  const bounded = (): Promise<HostRoadmapProbeRun> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ code: null, stdout: '', stderr: '', timedOut: true }), timeoutMs)
      // Through a microtask so a synchronous throw of run() is a rejection handled below.
      Promise.resolve()
        .then(deps.run)
        .then(
          (run) => {
            clearTimeout(timer)
            resolve(run)
          },
          (error: unknown) => {
            clearTimeout(timer)
            deps.report('host-roadmap', 'the kory-roadmap probe could not run', error)
            resolve({ code: null, stdout: '', stderr: '', timedOut: false })
          }
        )
    })

  const start = (): Promise<HostRoadmapMcpStatus> => {
    running = true
    queued = false
    const probe = bounded().then((run) => {
      running = false
      const verdict = classifyHostRoadmapProbe(run)
      if (verdict === 'missing') {
        deps.report('host-roadmap', `${ROADMAP_MCP_SERVER} is not registered in the user scope of the host Claude CLI: host sessions have no roadmap tools`)
      } else if (verdict === 'wrong-scope') {
        deps.report('host-roadmap', `${ROADMAP_MCP_SERVER} is registered outside the user scope: only some host sessions have roadmap tools`)
      } else if (verdict === 'unknown') {
        const why = run.timedOut ? `no answer within ${timeoutMs} ms` : `exit ${run.code ?? 'none'}: ${run.stderr.trim().slice(0, 200)}`
        deps.report('host-roadmap', `could not tell whether ${ROADMAP_MCP_SERVER} is registered on the host (${why})`)
      }
      return verdict
    })
    current = probe
    return probe
  }

  return {
    status(force) {
      if (current === null) return start()
      if (force !== true) return current
      if (!running && !queued) return start()
      if (!queued) {
        queued = true
        current = current.then(() => start())
      }
      return current
    }
  }
}
