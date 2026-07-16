// Unified model catalog for the model pickers (EXPLORATION-graph-chat C29):
// graph chat targets, judge, and the agents' advanced create menu share one
// mechanism — providers → models, favorites pinned by the operator.
//
// Two provider kinds (decision D10):
// - FRONTIER (Anthropic / OpenAI / Gemini): executed through their CLIs
//   (claude / codex / gemini). No reliable dynamic listing exists without an
//   API key (the CLIs authenticate via OAuth and expose no `list models`
//   command), so the catalog below is CURATED IN CODE — one constant to bump
//   when a new frontier model ships. A frontier provider is only shown when
//   its CLI is detected on the machine (decision D11).
// - LOCAL (Ollama, LiteLLM, vLLM, any OpenAI-compatible endpoint): configured
//   in Settings (name + base URL + optional API key) and their model list IS
//   discovered dynamically (`/v1/models`, Ollama `/api/tags` fallback).
//
// Pure module (no node/electron imports): shared by main and renderer,
// unit-testable under bun.

import type { GraphCli } from './graph'

/** Frontier provider ids double as favorite-key prefixes: keep them stable. */
export type FrontierProviderId = 'anthropic' | 'openai' | 'gemini'

export interface ModelEntry {
  /** Value passed to the CLI's --model / the endpoint's `model` field. */
  id: string
  /** Display label; defaults to the id. */
  label?: string
}

/**
 * One OpenAI-compatible local endpoint configured in Settings. The API key
 * has three shapes, one per trust zone (main/provider-secrets.ts):
 * renderer -> main carries transient `apiKey` (only when just typed, '' =
 * forget), the config file stores `apiKeyEnc` (safeStorage blob), and the
 * renderer only ever sees the `hasKey` marker.
 */
export interface LocalProviderConfig {
  /** Stable id (generated once), used in favorite keys and node metadata. */
  id: string
  /** Display name ("Ollama", "LiteLLM bureau"…). */
  name: string
  /** Base URL (port included), e.g. http://localhost:11434 or http://litellm:4000/v1. */
  baseUrl: string
  /**
   * Plaintext Bearer token. TRANSIENT: set renderer->main when the operator
   * (re)types a key ('' = clear), and in-memory main-side after decryption.
   * Never persisted, never sent back to the renderer.
   */
  apiKey?: string
  /** Encrypted-at-rest key ('enc:<base64>' or explicit 'plain:<key>' fallback). Main only. */
  apiKeyEnc?: string
  /** Renderer-facing marker: a key is stored for this provider. */
  hasKey?: boolean
}

/** A provider section of the picker, models resolved and ready to render. */
export interface ProviderCatalog {
  id: string // FrontierProviderId or a LocalProviderConfig.id
  name: string
  kind: 'frontier' | 'local'
  /** Frontier: the CLI that executes it. Local providers run over HTTP. */
  cli: GraphCli
  /** Frontier: CLI detected on this machine. Local: endpoint reachable. */
  available: boolean
  models: ModelEntry[]
}

/**
 * Curated frontier catalog (D10). Aliases first (stable across releases),
 * then the current concrete frontier ids. THIS IS THE ONE PLACE TO EDIT when
 * a new frontier model ships.
 */
export const FRONTIER_CATALOG: Record<
  FrontierProviderId,
  { name: string; cli: GraphCli; models: ModelEntry[] }
> = {
  anthropic: {
    name: 'Anthropic',
    cli: 'claude',
    models: [
      { id: 'opus', label: 'Opus (alias)' },
      { id: 'sonnet', label: 'Sonnet (alias)' },
      { id: 'haiku', label: 'Haiku (alias)' },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' }
    ]
  },
  openai: {
    name: 'OpenAI',
    cli: 'codex',
    models: [
      { id: '', label: 'Codex default' },
      { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex' },
      { id: 'gpt-5.1', label: 'GPT-5.1' },
      { id: 'gpt-5-codex', label: 'GPT-5 Codex' }
    ]
  },
  gemini: {
    name: 'Gemini',
    cli: 'gemini',
    models: [
      { id: '', label: 'Gemini default' },
      { id: 'gemini-3-pro', label: 'Gemini 3 Pro' },
      { id: 'gemini-3-flash', label: 'Gemini 3 Flash' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' }
    ]
  }
}

export const FRONTIER_IDS: FrontierProviderId[] = ['anthropic', 'openai', 'gemini']

// ---------------------------------------------------------------------------
// Favorite keys: `${providerId}:${modelId}` (modelId may itself contain ':',
// e.g. Ollama tags — always split on the FIRST separator only).

export function favKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`
}

export function parseFavKey(key: string): { providerId: string; modelId: string } | null {
  const i = key.indexOf(':')
  if (i <= 0) return null
  return { providerId: key.slice(0, i), modelId: key.slice(i + 1) }
}

/** Toggle a favorite key in an operator's list (pure; order = pin order). */
export function toggleFavorite(favorites: string[], key: string): string[] {
  return favorites.includes(key) ? favorites.filter((f) => f !== key) : [...favorites, key]
}

// ---------------------------------------------------------------------------
// Catalog assembly

/**
 * Build the picker's provider sections. Frontier providers whose CLI is not
 * detected are marked unavailable (the pickers hide them, D11); local
 * providers carry whatever their discovery returned (empty = unreachable).
 */
export function buildCatalogs(
  detected: Record<GraphCli, boolean>,
  locals: { provider: LocalProviderConfig; models: ModelEntry[] }[]
): ProviderCatalog[] {
  const out: ProviderCatalog[] = FRONTIER_IDS.map((id) => {
    const f = FRONTIER_CATALOG[id]
    return {
      id,
      name: f.name,
      kind: 'frontier' as const,
      cli: f.cli,
      available: !!detected[f.cli],
      models: f.models
    }
  })
  for (const { provider, models } of locals) {
    out.push({
      id: provider.id,
      name: provider.name || provider.baseUrl,
      kind: 'local',
      cli: 'local',
      available: models.length > 0,
      models
    })
  }
  return out
}

/**
 * Resolve the operator's favorite keys against the available catalogs, in pin
 * order. Favorites of vanished providers/models are silently skipped (they
 * stay in the config and come back when the provider does).
 */
export function resolveFavorites(
  catalogs: ProviderCatalog[],
  favorites: string[]
): { key: string; catalog: ProviderCatalog; model: ModelEntry }[] {
  const byId = new Map(catalogs.map((c) => [c.id, c]))
  const out: { key: string; catalog: ProviderCatalog; model: ModelEntry }[] = []
  for (const key of favorites) {
    const parsed = parseFavKey(key)
    if (!parsed) continue
    const catalog = byId.get(parsed.providerId)
    if (!catalog || !catalog.available) continue
    const model = catalog.models.find((m) => m.id === parsed.modelId)
    if (model) out.push({ key, catalog, model })
  }
  return out
}
