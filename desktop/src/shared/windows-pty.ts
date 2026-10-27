export interface WindowsPtyInfo {
  backend: 'conpty' | 'winpty'
  buildNumber?: number
}

// node-pty's own threshold: it runs the PTY under ConPTY from this build on.
const CONPTY_MIN_BUILD = 18309

/** Host PTY backend a terminal must emulate, from `process.platform` and `os.release()` ("10.0.26300"). */
export function windowsPtyFor(platform: string, osRelease: string): WindowsPtyInfo | null {
  if (platform !== 'win32') return null
  const build = /^\d+\.\d+\.(\d+)(?:\.|$)/.exec(osRelease)?.[1]
  const buildNumber = build === undefined ? NaN : Number(build)
  if (!Number.isSafeInteger(buildNumber) || buildNumber <= 0) return { backend: 'conpty' }
  return { backend: buildNumber >= CONPTY_MIN_BUILD ? 'conpty' : 'winpty', buildNumber }
}
