export type LaunchModPlan =
  | {
      attemptId: string
      mode: 'host'
      modDirs: readonly string[]
      copies: readonly LaunchModCopy[]
      diagnostics: readonly { plugin: string; reason: string }[]
    }
  | {
      attemptId: string
      mode: 'sandbox'
      engine: 'docker' | 'podman'
      containerId: string
      modDirs: readonly string[]
      diagnostics: readonly { plugin: string; reason: string }[]
    }
  | {
      attemptId: string
      mode: 'sandbox'
      modDirs: readonly []
      diagnostics: readonly { plugin: string; reason: string }[]
    }
  | { attemptId: string; refused: string }

export interface LaunchModCopy {
  plugin: string
  fingerprint: string
  hostDir: string
}

export function hasEnabledMods(enabled: unknown): boolean {
  return typeof enabled === 'object' && enabled !== null && !Array.isArray(enabled) && Object.values(enabled).some((value) => value === true)
}

export interface LaunchModDeps<Config, Lock> {
  enabledModsFromLock(config: Config, lock: Lock): readonly string[]
  ensureModWorkingCopy(input: { plugin: string; lock: Lock; workRoot: string; distDir: string }): Promise<
    | { ok: true; dir: string }
    | { ok: false; reason: string }
  >
  prepareMods?(input: { attemptId: string; copies: readonly LaunchModCopy[]; signal: AbortSignal; verifyHostCopy: (copy: LaunchModCopy) => { ok: true } | { ok: false; reason: string } }): Promise<
    | { ok: true; engine: 'docker' | 'podman'; containerId: string; references: readonly { plugin: string; containerDir: string }[]; diagnostics: { omitted: readonly { plugin: string; reason: string }[] } }
    | { ok: false; reason: string }
  >
  verifyHostCopy(copy: LaunchModCopy): { ok: true } | { ok: false; reason: string }
}

export async function prepareLaunchModPlan<Config extends { enabledMods?: unknown }, Lock>(
  deps: LaunchModDeps<Config, Lock>,
  input: { sandboxed: boolean; config: Config; loadLock: () => Lock; workRoot: string; distDir: string; signal: AbortSignal; attemptId: string }
): Promise<LaunchModPlan> {
  const refused = (reason: string): LaunchModPlan => ({ attemptId: input.attemptId, refused: reason })
  if (!hasEnabledMods(input.config.enabledMods)) {
    return input.sandboxed
      ? { attemptId: input.attemptId, mode: 'sandbox', modDirs: [], diagnostics: [] }
      : { attemptId: input.attemptId, mode: 'host', modDirs: [], copies: [], diagnostics: [] }
  }
  const lock = input.loadLock?.() ?? (input as unknown as { lock: Lock }).lock
  const plugins = deps.enabledModsFromLock(input.config, lock)
  if (plugins.length === 0) {
    return input.sandboxed
      ? { attemptId: input.attemptId, mode: 'sandbox', modDirs: [], diagnostics: [] }
      : { attemptId: input.attemptId, mode: 'host', modDirs: [], copies: [], diagnostics: [] }
  }
  const copies: LaunchModCopy[] = []
  const diagnostics: { plugin: string; reason: string }[] = []
  for (const plugin of plugins) {
    if (input.signal.aborted) return refused('aborted')
    const copy = await deps.ensureModWorkingCopy({ plugin, lock, workRoot: input.workRoot, distDir: input.distDir })
    if (input.signal.aborted) return refused('aborted')
    if (!copy.ok) {
      diagnostics.push({ plugin, reason: copy.reason })
      continue
    }
    const fingerprint = lock instanceof Map ? lock.get(plugin) : undefined
    if (!fingerprint) return refused('missing-fingerprint')
    copies.push({ plugin, fingerprint, hostDir: copy.dir })
  }
  if (!input.sandboxed) return { attemptId: input.attemptId, mode: 'host', modDirs: copies.map((copy) => copy.hostDir), copies, diagnostics }
  if (!deps.prepareMods) return refused('sandbox-preparation-unavailable')
  const prepared = await deps.prepareMods({ attemptId: input.attemptId, copies, signal: input.signal, verifyHostCopy: deps.verifyHostCopy })
  if (input.signal.aborted) return refused('aborted')
  if (!prepared.ok) return refused(prepared.reason)
  return {
    attemptId: input.attemptId,
    mode: 'sandbox',
    engine: prepared.engine,
    containerId: prepared.containerId,
    modDirs: prepared.references.map((reference) => reference.containerDir),
    diagnostics: [...diagnostics, ...prepared.diagnostics.omitted]
  }
}

export type RestorePlansResult =
  | { ok: true; plans: ReadonlyMap<string, LaunchModPlan> }
  | { ok: false; reason: 'superseded' | 'aborted' }

export async function prepareRestorePlans<Def extends { id: string; supervisor?: boolean }>(
  registry: LaunchAttemptRegistry,
  prepare: (attempt: { attemptId: string; signal: AbortSignal }, input: { supervisor: boolean }) => Promise<LaunchModPlan>,
  modeOf: (def: Def) => boolean,
  defs: ReadonlyArray<Def>,
  signal: AbortSignal
): Promise<RestorePlansResult> {
  const cancel = () => {
    for (const def of defs) registry.cancel(def.id)
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const modes = new Map<string, boolean>()
    const grouped = new Map<boolean, Def[]>()
    for (const def of defs) {
      const sandboxed = modeOf(def)
      modes.set(def.id, sandboxed)
      const group = grouped.get(sandboxed)
      if (group) group.push(def)
      else grouped.set(sandboxed, [def])
    }
    const modePlans = new Map<boolean, LaunchModPlan>()
    for (const [sandboxed, group] of grouped) {
      if (signal.aborted) return { ok: false, reason: 'aborted' }
      const first = group[0]!
      const attempt = registry.begin(first.id)
      registry.share(attempt.attemptId, new Set(group.map((def) => def.id)))
      if (signal.aborted) {
        registry.cancel(first.id)
        return { ok: false, reason: 'aborted' }
      }
      const plan = await prepare(attempt, { supervisor: !sandboxed })
      if (signal.aborted) return { ok: false, reason: 'aborted' }
      if (!registry.isCurrent(attempt.attemptId)) return { ok: false, reason: 'superseded' }
      modePlans.set(sandboxed, plan)
    }
    return { ok: true, plans: new Map(defs.map((def) => [def.id, modePlans.get(modes.get(def.id)!)!])) }
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

type LaunchAttempt = { attemptId: string; controller: AbortController; targetKeys?: ReadonlySet<string>; completed?: Set<string>; joined?: Promise<unknown> }

export class LaunchAttemptRegistry {
  private readonly attempts = new Map<string, LaunchAttempt>()
  private next = 0

  begin(targetKey: string): { attemptId: string; signal: AbortSignal } {
    this.cancel(targetKey)
    const controller = new AbortController()
    const attemptId = `${++this.next}`
    this.attempts.set(targetKey, { attemptId, controller })
    return { attemptId, signal: controller.signal }
  }

  isCurrent(attemptId: string): boolean {
    return [...this.attempts.values()].some((attempt) => attempt.attemptId === attemptId && !attempt.controller.signal.aborted)
  }

  cancel(targetKey: string): void {
    const attempt = this.attempts.get(targetKey)
    if (!attempt) return
    attempt.controller.abort()
    for (const [key, candidate] of this.attempts) {
      if (candidate === attempt) this.attempts.delete(key)
    }
  }

  cancelAll(): void {
    for (const key of this.attempts.keys()) this.cancel(key)
  }

  cancelAllExcept(attemptIds: ReadonlySet<string>): void {
    const seen = new Set<LaunchAttempt>()
    for (const [key, attempt] of this.attempts) {
      if (seen.has(attempt)) continue
      seen.add(attempt)
      if (!attemptIds.has(attempt.attemptId)) this.cancel(key)
    }
  }

  share(attemptId: string, targetKeys: ReadonlySet<string>): void {
    for (const attempt of this.attempts.values()) {
      if (attempt.attemptId !== attemptId) continue
      attempt.targetKeys = targetKeys
      attempt.completed = new Set()
      for (const targetKey of targetKeys) this.attempts.set(targetKey, attempt)
      return
    }
  }

  complete(targetKey: string, attemptId: string): void {
    const attempt = this.attempts.get(targetKey)
    if (!attempt || attempt.attemptId !== attemptId) return
    if (!attempt.targetKeys) {
      this.attempts.delete(targetKey)
      return
    }
    if (attempt.completed?.has(targetKey)) return
    attempt.completed?.add(targetKey)
    if (attempt.completed?.size !== attempt.targetKeys.size) return
    for (const key of attempt.targetKeys) this.attempts.delete(key)
  }

  join<T>(targetKey: string, prepare: () => Promise<T>): Promise<T> {
    const existing = this.attempts.get(targetKey)?.joined as Promise<T> | undefined
    if (existing) return existing
    const joined = prepare().finally(() => {
      const attempt = this.attempts.get(targetKey)
      if (attempt?.joined === joined) attempt.joined = undefined
    })
    const attempt = this.attempts.get(targetKey)
    if (attempt) attempt.joined = joined
    return joined
  }
}
