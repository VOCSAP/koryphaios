// Sandbox mode (PLAN-SANDBOX SBX1): pure builders for everything the Docker/
// Podman integration interpolates into a command line — container naming,
// host→container path mapping, engine CLI argument vectors, the per-session
// launch script and the `exec` wrapper. Node builtins only (no electron, no
// child_process) so the whole quoting/mapping surface is bun-testable.
//
// SECURITY (CLAUDE.md hostile inputs #3/#4): every consumer passes container
// names through isSandboxContainerName() before they reach the engine CLI, and
// the launch script is written to a Deck-owned run dir — the session command
// itself never travels through a PowerShell→bash quoting boundary (the script
// file IS the boundary).

import { createHash } from 'node:crypto'
import { platform } from 'node:os'
import { encodeProjectDir } from './session-transcript'

export type SandboxEngine = 'docker' | 'podman'

/** Named volume carrying ~/.claude (credentials + CLI state) across containers. */
export const SANDBOX_AUTH_VOLUME = 'kory-claude-auth'
/** Image the operator builds from desktop/resources/sandbox/Dockerfile. */
export const SANDBOX_IMAGE_DEFAULT = 'koryphaios-sandbox'
/** Mount point of the project dir inside the container. */
export const SANDBOX_WORK_DIR = '/work'
/** Mount point of the Deck-owned run dir (launch scripts) inside the container. */
export const SANDBOX_RUN_DIR = '/kory-run'
/** Home of the container user (Dockerfile: `kory`). */
export const SANDBOX_HOME = '/home/kory'
/** Credentials file probed to decide "authenticated" (revalidate on CLI bumps). */
export const SANDBOX_CREDENTIALS_FILE = `${SANDBOX_HOME}/.claude/.credentials.json`
// Re-exported so main-side consumers keep one import; the renderer reads it
// from @shared/types (this module is main-only). Relative import: this file
// must stay loadable by bun tests, which do not resolve the @shared alias.
export { SANDBOX_AUTH_PTY_ID, SANDBOX_BUILD_PTY_ID } from '../shared/types'
/** Dev-server ports published (127.0.0.1 only) when none are configured. */
export const DEFAULT_SANDBOX_PORTS = [3000, 5173, 8080]

const NAME_PREFIX = 'kory-sbx-'
const NAME_RE = /^kory-sbx-[0-9a-f]{12}$/

/**
 * Canonical slash form of an ABSOLUTE path (the Deck only ever hands absolute
 * dirs here): backslashes → `/`, duplicate and trailing separators collapsed.
 * Deliberately NOT node's resolve(): that would inject the HOST platform's
 * cwd/sep semantics and break the win32 mapping when computed elsewhere.
 */
function canonPath(p: string): string {
  const c = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  return c || '/'
}

/**
 * Normalize a project dir so the SAME project always hashes to the SAME
 * container regardless of trailing separators or Windows drive-letter casing.
 */
export function normalizeProjectDir(dir: string, plat: NodeJS.Platform = platform()): string {
  const c = canonPath(dir)
  return plat === 'win32' ? c.toLowerCase() : c
}

/** Deterministic per-project container name: kory-sbx-<sha256(projectDir)[0..12]>. */
export function containerNameFor(projectDir: string, plat: NodeJS.Platform = platform()): string {
  const hash = createHash('sha256').update(normalizeProjectDir(projectDir, plat)).digest('hex')
  return NAME_PREFIX + hash.slice(0, 12)
}

/** Only strings of the exact generated shape may reach the engine CLI. */
export function isSandboxContainerName(name: unknown): name is string {
  return typeof name === 'string' && NAME_RE.test(name)
}

/**
 * Map a host path to its container equivalent, or **null** when it is not
 * inside the mounted tree (worktrees are: `<project>/.worktrees/x` stays under
 * the mount by construction).
 *
 * null rather than a `/work` fallback ON PURPOSE: falling back means running
 * the agent in a DIFFERENT directory than the operator asked for, silently.
 * That happened for real — a symlinked project prefix (macOS `/var`) made
 * worktree paths canonical while the mount source was not, so every worktree
 * session landed in the project root. The caller now refuses the spawn with a
 * trace instead (session-service marks the tile exited).
 */
export function mapHostPathToContainer(
  hostPath: string,
  projectDir: string,
  plat: NodeJS.Platform = platform()
): string | null {
  const rootKept = canonPath(projectDir)
  const targetKept = canonPath(hostPath)
  const fold = (p: string): string => (plat === 'win32' ? p.toLowerCase() : p)
  const root = fold(rootKept)
  const target = fold(targetKept)
  if (target === root) return SANDBOX_WORK_DIR
  if (!target.startsWith(root + '/')) return null
  // Tail from the case-KEPT form so container paths keep their casing.
  return SANDBOX_WORK_DIR + targetKept.slice(rootKept.length)
}

/** POSIX single-quote escaping for values embedded in the launch script. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Rewrite a host-loopback URL so the container reaches the HOST's loopback. */
export function rewriteLoopbackForContainer(url: string): string {
  return url.replace(/\/\/(127\.0\.0\.1|localhost|\[::1\])(?=[:/]|$)/, '//host.docker.internal')
}

export interface SandboxCreateSpec {
  name: string
  image: string
  /** Host project dir — the kory.project label (identity, not the mount). */
  projectDir: string
  /**
   * Host dir actually bind-mounted at /work: the project itself in `mount`
   * mode, the ephemeral clone in `copy` mode (M3). Defaults to projectDir.
   */
  workSource?: string
  /** Host dir holding the generated launch scripts (bind-mounted at /kory-run). */
  runDirHost: string
  /**
   * DECK-OWNED peers dir (app state), bind-mounted where the container's
   * server.ts writes the peer cache + desk-session back-channel. The Deck reads
   * sandboxed sessions' back-channel from here.
   *
   * SECURITY (CLAUDE.md hostile input #5): this is deliberately NOT the host
   * `~/.claude/peers`. Mounting that one read-write let a sandboxed agent
   * rewrite the back-channel file of a NON-sandboxed tile, whose id the Deck
   * then adopts and passes to `--resume` on the host shell — a sandbox escape.
   * Sandboxed containers now share only a dir of their own; host tiles are out
   * of reach. (desk-session.ts validates the value and session-command.ts
   * quotes it: three locks, because one of them will eventually be wrong.)
   */
  peersDirHost?: string
  /** Dev-server ports published as 127.0.0.1:p:p (webview reaches them as localhost). */
  ports: number[]
}

/**
 * `docker/podman create` argument vector. The container idles on
 * `sleep infinity`; every session/action is an `exec` into it. `--add-host`
 * covers native-Linux engines where host.docker.internal is not built in
 * (Docker Desktop Win/mac resolves it natively and ignores the extra entry).
 */
export function buildCreateArgs(spec: SandboxCreateSpec): string[] {
  const ports = [...new Set(spec.ports.filter((p) => Number.isInteger(p) && p > 0 && p < 65536))]
  return [
    'create',
    '--name',
    spec.name,
    '--label',
    'kory.sandbox=1',
    '--label',
    `kory.project=${spec.projectDir}`,
    '--add-host',
    'host.docker.internal:host-gateway',
    '-v',
    `${spec.workSource || spec.projectDir}:${SANDBOX_WORK_DIR}`,
    '-v',
    `${SANDBOX_AUTH_VOLUME}:${SANDBOX_HOME}/.claude`,
    '-v',
    `${spec.runDirHost}:${SANDBOX_RUN_DIR}`,
    ...(spec.peersDirHost ? ['-v', `${spec.peersDirHost}:${SANDBOX_HOME}/.claude/peers`] : []),
    ...ports.flatMap((p) => ['-p', `127.0.0.1:${p}:${p}`]),
    spec.image,
    'sleep',
    'infinity'
  ]
}

export interface SandboxLaunchScriptSpec {
  /** Full session command line (claude --session-id … — already composed). */
  command: string
  /** Container-side cwd (a /work/… path from mapHostPathToContainer). */
  cwd: string
  /**
   * Env exported at the top of the script. The caller has already translated
   * host-only values (FORCE_GROUP file→inline, loopback URLs→host.docker.internal)
   * via sandboxifyEnv().
   */
  env: Record<string, string>
}

/**
 * The per-session launch script written to the run dir. A script — not `-e`
 * flags or an inline `bash -lc '…'` — because the outer command already
 * crosses `powershell -Command` on Windows (shell-command.ts) and a second
 * quoting layer over an arbitrary session command line is exactly the kind of
 * string-gluing the SBX plan forbids. `-l` keeps the image user's login PATH
 * (bun, claude in ~/.local/bin).
 */
export function buildLaunchScript(spec: SandboxLaunchScriptSpec): string {
  const lines = ['#!/bin/bash -l']
  for (const [key, value] of Object.entries(spec.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue // never script-inject via a key
    lines.push(`export ${key}=${shQuote(value)}`)
  }
  lines.push(`cd ${shQuote(spec.cwd)} || exit 1`)
  lines.push(`exec ${spec.command}`)
  return lines.join('\n') + '\n'
}

/**
 * Translate the host session env for container use:
 *  - the chmod-600 FORCE_GROUP *file* transport (scope.ts) becomes the inline
 *    value (the host path does not exist container-side) — `readSecretFile`
 *    is injected so this stays pure;
 *  - loopback URLs (design endpoint) are rewritten to host.docker.internal;
 *  - everything else passes through untouched.
 */
export function sandboxifyEnv(
  env: Record<string, string>,
  readSecretFile: (path: string) => string | null
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (key === 'CLAUDE_PEERS_FORCE_GROUP_FILE') {
      if (value) {
        const secret = readSecretFile(value)
        if (secret !== null) out.CLAUDE_PEERS_FORCE_GROUP = secret
      }
      continue
    }
    if (key === 'CLAUDE_PEERS_FORCE_GROUP' && !value && env.CLAUDE_PEERS_FORCE_GROUP_FILE) {
      continue // superseded by the file translation above
    }
    if (key === 'CLAUDE_DECK_DESIGN_URL' && value) {
      out[key] = rewriteLoopbackForContainer(value)
      continue
    }
    out[key] = value
  }
  return out
}

/** Container-side path of a launch script written to the host run dir. */
export function scriptContainerPath(sessionId: string): string {
  return `${SANDBOX_RUN_DIR}/cmd-${sessionId}.sh`
}

/** Host-side file name of the same script (joined onto the run dir by the caller). */
export function scriptFileName(sessionId: string): string {
  return `cmd-${sessionId}.sh`
}

/** The PTY command that runs a sandboxed session: exec into the idling container. */
export function buildExecCommand(engine: SandboxEngine, name: string, sessionId: string): string {
  return `${engine} exec -it ${name} bash ${scriptContainerPath(sessionId)}`
}

/**
 * The auth terminal command (SBX3): plain `claude` in the container — the CLI
 * detects the missing login and walks the operator through the OAuth flow.
 * The Deck polls the credentials file and kills this PTY on success.
 */
export function buildAuthCommand(engine: SandboxEngine, name: string): string {
  return `${engine} exec -it ${name} bash -lc claude`
}

/** Arg vector probing the credentials file (exit 0 = logged in). */
export function buildAuthProbeArgs(name: string): string[] {
  return ['exec', name, 'test', '-s', SANDBOX_CREDENTIALS_FILE]
}

/** Arg vector wiping the credentials file ("disconnect", guarded upstream). */
export function buildAuthPurgeArgs(name: string): string[] {
  return ['exec', name, 'rm', '-f', SANDBOX_CREDENTIALS_FILE]
}

/**
 * Container-side transcript dir for a host cwd (M2 resume): Claude writes
 * `~/.claude/projects/<encoded cwd>/<id>.jsonl`, and inside the sandbox the
 * cwd is the CONTAINER path — so the encoding must run on the mapped path,
 * not the host one. `~/.claude` is the auth volume, so these transcripts
 * survive a container rebuild.
 */
export function containerTranscriptDir(
  cwdHost: string,
  projectDir: string,
  plat: NodeJS.Platform = platform()
): string | null {
  const containerCwd = mapHostPathToContainer(cwdHost, projectDir, plat)
  // Outside the mount there is no container-side transcript dir to look in —
  // null so the caller reports "unknown", never an empty (= "no transcript")
  // answer that would silently downgrade a resume to a fresh session.
  if (containerCwd === null) return null
  return `${SANDBOX_HOME}/.claude/projects/${encodeProjectDir(containerCwd)}`
}

/**
 * Arg vector listing a transcript dir as `<name>\t<mtime seconds>` rows.
 * GNU find (debian base image); a missing dir exits non-zero → empty list.
 */
export function buildTranscriptListArgs(name: string, dir: string): string[] {
  return ['exec', name, 'find', dir, '-maxdepth', '1', '-name', '*.jsonl', '-printf', '%f\\t%T@\\n']
}

/** Parse `buildTranscriptListArgs` stdout into transcript entries. */
export function parseTranscriptList(stdout: string): { id: string; mtimeMs: number }[] {
  const out: { id: string; mtimeMs: number }[] = []
  for (const line of stdout.split('\n')) {
    const [file, stamp] = line.split('\t')
    if (!file || !file.endsWith('.jsonl')) continue
    const seconds = Number.parseFloat(stamp ?? '')
    out.push({
      id: file.slice(0, -'.jsonl'.length),
      mtimeMs: Number.isFinite(seconds) ? seconds * 1000 : 0
    })
  }
  return out
}

/** `docker cp <hostPath> <container>:<containerPath>` (config projection, M2). */
export function buildCopyIntoArgs(name: string, hostPath: string, containerPath: string): string[] {
  return ['cp', hostPath, `${name}:${containerPath}`]
}

/** `docker build -t <image> <contextDir>` — the PTY command of the image build. */
export function buildImageBuildCommand(
  engine: SandboxEngine,
  image: string,
  contextDir: string
): string {
  return `${engine} build -t ${shQuote(image)} ${shQuote(contextDir)}`
}

/** Arg vector testing that the image exists locally. */
export function buildImageProbeArgs(image: string): string[] {
  return ['image', 'inspect', '--format', '{{.Created}}', image]
}

/**
 * Arg vector probing the broker bridge FROM INSIDE the container: the only
 * honest test of `host.docker.internal` reachability (it resolves natively on
 * Docker Desktop, needs --add-host + a non-loopback broker bind elsewhere).
 */
export function buildBrokerProbeArgs(name: string, brokerUrl: string): string[] {
  return ['exec', name, 'curl', '-sf', '-m', '4', '-o', '/dev/null', `${brokerUrl}/health`]
}

/**
 * Supervisor-driven exec (M2 `deck_sandbox_exec`): the agent's command line is
 * ONE argv element handed to the container's bash — it never touches a HOST
 * shell (hostile input #4). `-lc` gives it the image user's login PATH.
 */
export function buildSupervisorExecArgs(name: string, command: string): string[] {
  return ['exec', '-w', SANDBOX_WORK_DIR, name, 'bash', '-lc', command]
}
