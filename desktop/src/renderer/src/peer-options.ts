// Relative shared imports, not `@shared/*`: the alias is unresolved under bun test.

import { CLODEX_PROVIDER_ID, type ProviderCatalog } from '../../shared/models'
import {
  CLODEX_CONTEXT_DEFAULT,
  CLODEX_CONTEXT_MAX,
  CLODEX_CONTEXT_MIN,
  isClodexContextTokens
} from '../../shared/clodex-context'
import { liftTemplateLaunchOptions } from '../../shared/template-launch-options'

/**
 * A captured template carries `--agent`/`--model` inside its free args. The
 * exact generated prefix moves into the structured fields; anything else stays
 * in `args` untouched.
 */
export function liftEntryLaunchOptions<T extends { args?: string; agent?: string; model?: string }>(
  entry: T
): T {
  const lifted = liftTemplateLaunchOptions(entry)
  if (lifted.agent === entry.agent && lifted.model === entry.model) return entry
  return { ...entry, agent: lifted.agent, model: lifted.model, args: lifted.args || undefined }
}

/**
 * Which flags the CURRENT args still name. Recomputed on every edit: a flag in
 * args outranks the picker at launch, so the picker must not offer a choice
 * while it is there. The placeholders only stop the lifting; the answer is
 * whether the flag family is present.
 */
export function launchFlagsInArgs(args: string | undefined): { agent: boolean; model: boolean } {
  const flags = liftTemplateLaunchOptions({ args, agent: '-', model: '-' })
  return { agent: flags.unresolvedAgent, model: flags.unresolvedModel }
}

/** Index 0 is Auto: no --effort flag. */
export const EFFORT_LEVELS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** Claude Code strips this suffix before calling the provider and uses the 1M window. */
export const EXTENDED_SUFFIX = '[1m]'

export function supports1mContext(id: string): boolean {
  const m = id.trim().toLowerCase()
  return m !== '' && !m.includes('haiku')
}

/**
 * Anthropic is forced available (agent sessions run the claude CLI); a bridge
 * keeps its own availability, its wrapper may be missing or its proxy idle.
 * Launch-config models come first, then frontier ids not already listed.
 */
export function mergeCreateCatalogs(
  models: ReadonlyArray<{ id: string; label?: string }>,
  catalogs: ProviderCatalog[]
): ProviderCatalog[] {
  const frontier = catalogs.find((c) => c.id === 'anthropic')
  const merged = [
    ...models.map((m) => ({ id: m.id, label: m.label })),
    ...(frontier?.models ?? []).filter((fm) => !models.some((m) => m.id === fm.id))
  ]
  return [
    {
      id: 'anthropic',
      name: frontier?.name ?? 'Anthropic',
      kind: 'frontier',
      cli: 'claude',
      available: true,
      models: merged
    },
    ...catalogs.filter((c) => c.kind === 'bridge')
  ]
}

/** The provider travels with the id: Anthropic and a bridge may list the same model id. */
export interface ModelPick {
  model: string
  providerId?: string
}

export function isBridgePick(pick: ModelPick): boolean {
  return pick.providerId === CLODEX_PROVIDER_ID
}

export function canExtendPick(pick: ModelPick): boolean {
  return !isBridgePick(pick) && supports1mContext(pick.model)
}

export function splitExtendedModel(model: string | undefined): { base: string; extended: boolean } {
  const trimmed = (model ?? '').trim()
  if (trimmed.toLowerCase().endsWith(EXTENDED_SUFFIX)) {
    return { base: trimmed.slice(0, -EXTENDED_SUFFIX.length), extended: true }
  }
  return { base: trimmed, extended: false }
}

/** `[1m]` is appended only where it applies; a bridged model never carries it. */
export function modelFieldsOf(
  pick: ModelPick,
  extended: boolean
): { model: string | undefined; bridge: 'clodex' | undefined } {
  const model = extended && canExtendPick(pick) ? `${pick.model}${EXTENDED_SUFFIX}` : pick.model
  return { model: model || undefined, bridge: isBridgePick(pick) ? 'clodex' : undefined }
}

export function modelStateOf(entry: { model?: string; bridge?: 'clodex' }): {
  pick: ModelPick
  extended: boolean
} {
  const { base, extended } = splitExtendedModel(entry.model)
  return {
    pick: entry.bridge === 'clodex' ? { model: base, providerId: CLODEX_PROVIDER_ID } : { model: base },
    extended
  }
}

export const CONTEXT_DEFAULT_TOKENS = CLODEX_CONTEXT_DEFAULT

/** Slider bounds in k tokens (1k = 1000 tokens). */
export const CONTEXT_SLIDER_MIN_K = CLODEX_CONTEXT_MIN / 1000
export const CONTEXT_SLIDER_MAX_K = CLODEX_CONTEXT_MAX / 1000

/** 200000 -> "200", 200500 -> "200.5". */
export function formatContextK(tokens: number): string {
  if (!Number.isFinite(tokens)) return ''
  const whole = Math.floor(tokens / 1000)
  const rest = tokens % 1000
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(3, '0').replace(/0+$/, '')}`
}

/**
 * Tokens for a k text ("250", "250.5", "250,5"), NaN when it is not a whole
 * token count inside the range. NaN is the invalid marker kept in the form
 * data, so `isContextInvalid` is the one check that gates create and save.
 */
export function parseContextK(text: string): number {
  const m = /^(\d{1,4})(?:[.,](\d{1,3}))?$/.exec(text.trim())
  if (!m) return Number.NaN
  const tokens = Number(m[1]) * 1000 + Number((m[2] ?? '').padEnd(3, '0') || '0')
  return isClodexContextTokens(tokens) ? tokens : Number.NaN
}

/** Whole-k slider position; an absent or invalid value parks on the default. */
export function sliderKOf(tokens: number | undefined): number {
  const value = isClodexContextTokens(tokens) ? tokens : CLODEX_CONTEXT_DEFAULT
  return Math.round(value / 1000)
}

export function isContextInvalid(tokens: number | undefined): boolean {
  return tokens !== undefined && !isClodexContextTokens(tokens)
}

export function entryHasInvalidContext(entry: {
  bridge?: 'clodex'
  clodexContextTokens?: number
}): boolean {
  return entry.bridge === 'clodex' && isContextInvalid(entry.clodexContextTokens)
}
