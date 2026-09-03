// A provider is only offered when its CLI is installed. Frontier model lists
// are curated code constants, since the OAuth CLIs expose no 'list models'
// command and the vendor APIs need an API key the operator may not have.
// Local endpoints discover their models dynamically instead: /v1/models
// (OpenAI-compatible: LiteLLM/vLLM/Ollama) with an /api/tags fallback for
// native Ollama.

import { execFile } from 'node:child_process'
import { platform } from 'node:os'
import { buildShellInvocation } from './shell-command'
import {
  buildCatalogs,
  type LocalProviderConfig,
  type ModelEntry,
  type ProviderCatalog
} from '../shared/models'
import type { GraphCli } from '../shared/graph'

/** Binaries probed for frontier providers (login shell, like session spawns). */
export const FRONTIER_BINS: { cli: Exclude<GraphCli, 'local'>; bin: string }[] = [
  { cli: 'claude', bin: 'claude' },
  { cli: 'codex', bin: 'codex' },
  { cli: 'gemini', bin: 'gemini' },
  { cli: 'antigravity', bin: 'agy' }
]

/** Cross-shell "is this binary on PATH?" probe (exit 0 = present). */
export function buildDetectCommand(bin: string, plat: NodeJS.Platform = platform()): string {
  const safe = bin.replace(/[^A-Za-z0-9._-]/g, '')
  if (plat === 'win32') return `Get-Command ${safe} -ErrorAction Stop | Out-Null`
  return `command -v ${safe}`
}

const DETECT_TIMEOUT_MS = 15_000

function probeBin(bin: string, shell: string): Promise<boolean> {
  const inv = buildShellInvocation({
    command: buildDetectCommand(bin),
    shell,
    interactive: false
  })
  return new Promise((resolve) => {
    execFile(inv.file, inv.args, { timeout: DETECT_TIMEOUT_MS }, (err) => resolve(!err))
  })
}

/** Session-lifetime cache: PATH changes are rare, probes spawn login shells. */
let detectCache: Record<GraphCli, boolean> | null = null

export async function detectClis(
  shell: string,
  opts: { refresh?: boolean; probe?: (bin: string, shell: string) => Promise<boolean> } = {}
): Promise<Record<GraphCli, boolean>> {
  if (detectCache && !opts.refresh) return detectCache
  const probe = opts.probe ?? probeBin
  const results = await Promise.all(FRONTIER_BINS.map(({ bin }) => probe(bin, shell)))
  const detected = {
    claude: false,
    codex: false,
    gemini: false,
    antigravity: false,
    local: true
  } as Record<GraphCli, boolean>
  FRONTIER_BINS.forEach(({ cli }, i) => (detected[cli] = !!results[i]))
  detectCache = detected
  return detected
}

// ---------------------------------------------------------------------------
// Local provider discovery

/** Candidate model-list URLs for a base URL (first that answers wins). */
export function modelsUrlCandidates(baseUrl: string): string[] {
  const base = baseUrl.replace(/\/+$/, '')
  if (/\/v1$/.test(base)) {
    // ".../v1" configured: OpenAI-compatible list, then native Ollama on the root.
    return [`${base}/models`, `${base.slice(0, -3)}/api/tags`]
  }
  return [`${base}/v1/models`, `${base}/api/tags`]
}

/** Parse an OpenAI-compatible GET /v1/models payload. */
export function parseOpenAiModels(json: unknown): ModelEntry[] {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data)) return []
  return data
    .map((m) => (m && typeof m === 'object' ? (m as { id?: unknown }).id : null))
    .filter((id): id is string => typeof id === 'string' && !!id)
    .map((id) => ({ id }))
}

/** Parse a native Ollama GET /api/tags payload. */
export function parseOllamaTags(json: unknown): ModelEntry[] {
  const models = (json as { models?: unknown })?.models
  if (!Array.isArray(models)) return []
  return models
    .map((m) => (m && typeof m === 'object' ? (m as { name?: unknown }).name : null))
    .filter((name): name is string => typeof name === 'string' && !!name)
    .map((name) => ({ id: name }))
}

const DISCOVER_TIMEOUT_MS = 4000
const MAX_LOCAL_MODELS = 200

/**
 * Model list of one configured endpoint. Any failure (endpoint down, auth,
 * garbage payload) degrades to [] — the picker then shows the provider as
 * unavailable instead of erroring.
 */
export async function discoverLocalModels(
  provider: LocalProviderConfig,
  fetchImpl: typeof fetch = fetch
): Promise<ModelEntry[]> {
  const headers: Record<string, string> = {}
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`
  for (const url of modelsUrlCandidates(provider.baseUrl)) {
    try {
      const res = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS)
      })
      if (!res.ok) continue
      const json = (await res.json()) as unknown
      const models = url.endsWith('/api/tags') ? parseOllamaTags(json) : parseOpenAiModels(json)
      if (models.length > 0) return models.slice(0, MAX_LOCAL_MODELS)
    } catch {
      /* try the next candidate */
    }
  }
  return []
}

/**
 * Full picker catalog: frontier detection (cached) + parallel discovery of
 * every configured local provider.
 */
export async function getCatalogs(
  locals: LocalProviderConfig[],
  shell: string,
  opts: { refresh?: boolean; fetchImpl?: typeof fetch } = {}
): Promise<ProviderCatalog[]> {
  const [detected, discovered] = await Promise.all([
    detectClis(shell, { refresh: opts.refresh }),
    Promise.all(
      (locals ?? [])
        .filter((p) => p && p.id && p.baseUrl)
        .map(async (provider) => ({
          provider,
          models: await discoverLocalModels(provider, opts.fetchImpl ?? fetch)
        }))
    )
  ])
  return buildCatalogs(detected, discovered)
}

/** Test hook: reset the detection cache. */
export function resetDetectCache(): void {
  detectCache = null
}
