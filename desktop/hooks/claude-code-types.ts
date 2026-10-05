export type SessionContextUsage = {
  tokens?: number
  window: number
  percent?: number
}

export type SessionRateLimit = {
  kind: string
  percentUsed: number
  resetsAt?: string
}

export type SessionCost = {
  usd: number
}

export type UsageUnit = 'context' | 'rateLimits' | 'cost'

export type SessionMeasureInput = {
  context: SessionContextUsage
  rateLimits: SessionRateLimit[]
  cost?: SessionCost
  changed: UsageUnit[]
}

export type SessionMeasureResult = {
  changed: UsageUnit[]
}

export type ToolResultSummary = {
  tool_use_id: string
  text: string
  isError: boolean
  result?: unknown
}

export type ToolUseSummary = {
  tool_use_id: string
  tool: string
  input: Record<string, unknown>
  result?: unknown
  text?: string
  isError?: true
}

export type SessionMessage = {
  role: 'user' | 'assistant'
  text: string
  toolUses: ToolUseSummary[]
  toolResults?: ToolResultSummary[]
  handle?: string
}

export type SessionCompactTrigger = 'manual' | 'auto' | 'plugin' | 'precompute'

export type SessionCompactInput = {
  trigger: SessionCompactTrigger
  agentId?: string
  messages: readonly SessionMessage[]
}

export type SessionCompacted = {
  messages: readonly SessionMessage[]
  tokensBefore?: number
  tokensAfter?: number
  skip?: undefined
}

export type SessionCompactSkipped = {
  skip: string
  messages?: undefined
}

export type SessionCompactResult = SessionCompacted | SessionCompactSkipped

type Frozen<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? { [K in keyof T]: Frozen<T[K]> }
    : T extends object
      ? { readonly [K in keyof T]: Frozen<T[K]> }
      : T

type Next<Input, Result> = {
  <Tool extends string>(event: Input & { readonly tool: Tool }): Promise<Result>
  (event: Input): Promise<Result>
}

type TelemetryPluginHost = {
  env: { get(name: string): Promise<string | undefined> }
  fs: {
    exists(path: string): Promise<boolean>
    read(path: string): Promise<string>
    write(path: string, text: string): Promise<void>
  }
  clock: { now(): Promise<number> }
  ui: { log(text: string, options?: { to: 'debug' }): void }
  session: { usage(): Promise<{ context: SessionContextUsage }> }
}

type SessionMeasureHook = (
  host: TelemetryPluginHost,
  event: Frozen<SessionMeasureInput>,
  next: Next<SessionMeasureInput, SessionMeasureResult>,
) => SessionMeasureResult | Promise<SessionMeasureResult>

type SessionCompactHook = (
  host: TelemetryPluginHost,
  event: Frozen<SessionCompactInput>,
  next: Next<SessionCompactInput, SessionCompactResult>,
) => SessionCompactResult | Promise<SessionCompactResult>

type EventName = 'session.measure' | 'session.compact'

type HookFor<Event extends EventName> = Event extends 'session.measure'
  ? SessionMeasureHook
  : SessionCompactHook

export type On = <Event extends EventName>(event: Event, hook: HookFor<Event>) => void
