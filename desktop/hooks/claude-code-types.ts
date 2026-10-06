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

/** `clear` is the only sign of a /clear: no session.start or session.measure follows it. */
export type SessionEndInput = {
  reason: string
}

export type SessionEndResult = {
  sessionId: string
}

type Frozen<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? { [K in keyof T]: Frozen<T[K]> }
    : T extends object
      ? { readonly [K in keyof T]: Frozen<T[K]> }
      : T

export type ToolCheckDecision = 'allow' | 'ask' | 'deny'

export type ToolCheckInput = {
  tool: string
  input: unknown
  tool_use_id?: string
  agentId?: string
  ceiling?: ToolCheckDecision
}

export type ToolCheckResult = {
  decision: ToolCheckDecision
  reason?: string
  rule?: string
  hook?: string
  ceiling?: ToolCheckDecision
}

/** The tool's own arguments ride flat beside `tool` (`e.questions`, `e.command`), unlike `tool.check`'s `e.input`. */
export type ToolCallInput = {
  tool: string
  tool_use_id: string
  agentId?: string
  [argument: string]: unknown
}

export type ToolCallResult =
  | {
      deny: string
      result?: undefined
      context?: undefined
      ref?: undefined
      text?: undefined
      isError?: undefined
      isReadOnly?: undefined
    }
  | {
      result: unknown
      context?: readonly string[]
      ref?: number
      text?: string
      isReadOnly?: true
      isError?: undefined
      deny?: undefined
    }
  | {
      isError: true
      result: unknown
      text?: string
      ref?: number
      context?: readonly string[]
      isReadOnly?: true
      deny?: undefined
    }

export type ProcessRunInit = {
  cwd?: string
  env?: Record<string, string>
  stdin?: string
  timeoutMs?: number
}

export type ProcessRunResult = {
  exitCode: number
  stdout: string
  stderr: string
  isStdoutTruncated: boolean
  isStderrTruncated: boolean
}

type Next<Input, Result> = {
  <Tool extends string>(event: Input & { readonly tool: Tool }): Promise<Result>
  (event: Input): Promise<Result>
  readonly signal: AbortSignal
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
  session: {
    usage(): Promise<{ context: SessionContextUsage }>
    model(): Promise<string>
  }
  process: {
    /** No shell; the child inherits the session's env and cwd; timeout 30 s by default. */
    run(argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult>
  }
  plugin: {
    name: string
    /** Absolute: a relative helper path fails to start. */
    root: string
  }
}

type RenderSurface = 'terminal' | 'desktop' | 'mobile' | 'vscode'

type SessionStartInput = {
  cwd: string
  surface: RenderSurface | null
  isInteractive: boolean
}

type SessionStartResult = {
  cwd: string
}

type SessionStartHook = (
  host: TelemetryPluginHost,
  event: Frozen<SessionStartInput>,
  next: Next<SessionStartInput, SessionStartResult>,
) => SessionStartResult | Promise<SessionStartResult>

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

type SessionEndHook = (
  host: TelemetryPluginHost,
  event: Frozen<SessionEndInput>,
  next: Next<SessionEndInput, SessionEndResult>,
) => SessionEndResult | Promise<SessionEndResult>

type ToolCheckHook = (
  host: TelemetryPluginHost,
  event: Frozen<ToolCheckInput>,
  next: Next<ToolCheckInput, ToolCheckResult>,
) => ToolCheckResult | Promise<ToolCheckResult>

type ToolCallHook = (
  host: TelemetryPluginHost,
  event: Frozen<ToolCallInput>,
  next: Next<ToolCallInput, ToolCallResult>,
) => ToolCallResult | Promise<ToolCallResult>

type EventName = 'session.start' | 'session.measure' | 'session.compact' | 'session.end' | 'tool.check' | 'tool.call'

type HookFor<Event extends EventName> = Event extends 'session.start'
  ? SessionStartHook
  : Event extends 'session.measure'
    ? SessionMeasureHook
    : Event extends 'session.compact'
      ? SessionCompactHook
      : Event extends 'session.end'
        ? SessionEndHook
        : Event extends 'tool.check'
          ? ToolCheckHook
          : ToolCallHook

export type On = <Event extends EventName>(event: Event, hook: HookFor<Event>) => void
