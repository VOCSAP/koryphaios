import type { On } from './claude-code-types.ts'
import { FRONTIER_CATALOG } from '../src/shared/models.ts'
import { decodeStatusFile, encodeStatusFromMeasure, encodeStatusFromModelIdentity, statusFileName, type MeasuredContext } from '../src/shared/session-status.ts'

export interface TelemetryHost {
  env: { get(name: string): Promise<string | undefined> }
  fs: {
    exists(path: string): Promise<boolean>
    read(path: string): Promise<string>
    write(path: string, text: string): Promise<void>
  }
  session: { model(): Promise<string> }
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

function modelDisplayName(modelId: string): string {
  return FRONTIER_CATALOG.anthropic.models.find((model) => model.id === modelId)?.label ?? modelId
}

async function hasValidStatus($: TelemetryHost, target: string): Promise<boolean> {
  return (await $.fs.exists(target)) && decodeStatusFile(await $.fs.read(target)) !== null
}

export async function seedModelIdentity($: TelemetryHost): Promise<void> {
  try {
    if (await $.env.get('KORY_STATUS_FALLBACK') === '1') return
    const token = await $.env.get('CLAUDE_PEERS_DESK_SESSION')
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    const target = telemetryStatusPath(token, home)
    if (!target || (await hasValidStatus($, target))) return
    const modelId = await $.session.model()
    const encoded = encodeStatusFromModelIdentity(modelId, modelDisplayName(modelId), await $.clock.now())
    if (!encoded || (await hasValidStatus($, target))) return
    await $.fs.write(target, encoded)
  } catch (err) {
    logFailure($, err)
  }
}

export async function reportMeasuredContext($: TelemetryHost, context: MeasuredContext): Promise<void> {
  try {
    if (await $.env.get('KORY_STATUS_FALLBACK') === '1') return
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
  on('session.start', async ($, e, next) => {
    await seedModelIdentity($)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await reportMeasuredContext($, e.context)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await reportMeasuredContext($, {})
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
