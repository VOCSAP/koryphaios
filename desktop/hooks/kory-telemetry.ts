import type { On } from './claude-code-types.ts'
import { encodeStatusFromMeasure, statusFileName, type MeasuredContext } from '../src/shared/session-status.ts'

export interface TelemetryHost {
  env: { get(name: string): Promise<string | undefined> }
  fs: {
    exists(path: string): Promise<boolean>
    read(path: string): Promise<string>
    write(path: string, text: string): Promise<void>
  }
  clock: { now(): Promise<number> }
  ui: { log(text: string, options?: { to: 'debug' }): void }
}

export function telemetryStatusPath(token: string | undefined, home: string | undefined): string | null {
  const name = statusFileName(token)
  if (!name || !home) return null
  return `${home.replace(/[\\/]$/, '')}/.claude/peers/${name}`
}

function logFailure($: TelemetryHost, err: unknown): void {
  $.ui.log(`Kory telemetry report failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
}

export async function reportMeasuredContext($: TelemetryHost, context: MeasuredContext): Promise<void> {
  try {
    const token = await $.env.get('CLAUDE_PEERS_DESK_SESSION')
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    const target = telemetryStatusPath(token, home)
    if (!target || !(await $.fs.exists(target))) return
    const raw = await $.fs.read(target)
    const encoded = encodeStatusFromMeasure(raw, context, await $.clock.now())
    if (encoded) await $.fs.write(target, encoded)
  } catch (err) {
    logFailure($, err)
  }
}

export function register(on: On): void {
  on('session.measure', async ($, e, next) => {
    await reportMeasuredContext($, e.context)
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if ('skip' in result) return result
    try {
      const usage = await $.session.usage()
      await reportMeasuredContext($, { window: usage.context.window })
    } catch (err) {
      logFailure($, err)
    }
    return result
  })
}
