import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { isAbsolute } from 'node:path'

export type ServeEnv = Record<string, string>

export interface LoginEnvRequest {
  readonly shell: string
  readonly cwd: string
  readonly seed: ServeEnv
  readonly timeoutMs: number
}

/** A profile loading nvm, conda or pyenv routinely takes more than the 3 s given to system commands. */
export const LOGIN_ENV_CAPTURE_TIMEOUT_MS = 10_000
export const FALLBACK_LOGIN_SHELL = '/bin/sh'

const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

/** The operator's shell only when it is an absolute path that `/etc/shells` lists. */
export function loginShell(candidate: string | undefined, etcShells: string): string {
  if (candidate === undefined || !isAbsolute(candidate)) return FALLBACK_LOGIN_SHELL
  const listed = etcShells.split('\n').map((line) => line.trim())
  return listed.includes(candidate) ? candidate : FALLBACK_LOGIN_SHELL
}
const SEED_NAMES = new Set(['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR'])

/**
 * What a login session starts from before its profile runs. The Deck's own
 * environment is never the seed: the profile would inherit it, and every Deck
 * variable would reach a server that `inheritEnv` did not ask for.
 */
export function loginEnvSeed(source: Readonly<Record<string, string | undefined>>): ServeEnv {
  const seed: ServeEnv = { PATH: SYSTEM_PATH }
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (SEED_NAMES.has(name) || name.startsWith('LC_')) seed[name] = value
  }
  return seed
}

function markers(nonce: string): { begin: string; end: string } {
  return { begin: `__KORY_SERVE_ENV_BEGIN_${nonce}__`, end: `__KORY_SERVE_ENV_END_${nonce}__` }
}

/**
 * Script for `$SHELL -l -c`. The newline printed ahead of BEGIN detaches it
 * from a profile banner that ends without one; `/usr/bin/env` by path escapes
 * an `env` alias or function the profile may define.
 */
export function loginEnvScript(nonce: string): string {
  const { begin, end } = markers(nonce)
  return `printf '\\n%s\\n' '${begin}'; /usr/bin/env -0 || exit 1; printf '%s\\n' '${end}'`
}

/** @throws when a marker is missing, a record has no `NAME=` prefix or no PATH came back: a partial environment is never returned. */
export function parseLoginEnv(stdout: string, nonce: string): ServeEnv {
  const { begin, end } = markers(nonce)
  const opening = `\n${begin}\n`
  const start = stdout.indexOf(opening)
  if (start < 0) throw new Error('login shell environment capture printed no start marker')
  const from = start + opening.length
  const stop = stdout.indexOf(end, from)
  if (stop < 0) throw new Error('login shell environment capture printed no end marker')
  const body = stdout.slice(from, stop)
  if (body.length === 0) throw new Error('login shell environment capture is empty')
  if (!body.endsWith('\0')) throw new Error('login shell environment capture is truncated')
  const env: ServeEnv = {}
  for (const record of body.split('\0').slice(0, -1)) {
    const equals = record.indexOf('=')
    if (equals <= 0) throw new Error('login shell environment capture holds a record without a name')
    env[record.slice(0, equals)] = record.slice(equals + 1)
  }
  if (env.PATH === undefined) throw new Error('login shell environment capture has no PATH')
  return env
}

/** Rejects on a non-zero exit, a timeout or unreadable output; the profile's stderr is ignored. */
export function captureLoginEnv(request: LoginEnvRequest): Promise<ServeEnv> {
  const nonce = randomBytes(8).toString('hex')
  return new Promise((resolve, reject) => {
    execFile(
      request.shell,
      ['-l', '-c', loginEnvScript(nonce)],
      { cwd: request.cwd, env: request.seed, timeout: request.timeoutMs, encoding: 'utf-8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(new Error(`login shell environment capture failed: ${error.message}`))
          return
        }
        try {
          resolve(parseLoginEnv(String(stdout), nonce))
        } catch (parseError) {
          reject(parseError)
        }
      }
    )
  })
}
