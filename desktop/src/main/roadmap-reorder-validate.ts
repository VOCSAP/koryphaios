// Workflow lane waves (roadmap card 42edc88b phase 1): main-side re-validation
// of the OPTIONAL `waves` IPC argument to `roadmap:reorder`, before it ever
// reaches roadmap-service.ts / the broker.
//
// roadmap:reorder is exposed to the companion/MCP surface at tier 1
// (desktop/src/shared/companion.ts CHANNEL_TIERS) -- a tier is a declaration,
// not an access gate (see CLAUDE.md's five-hostile-inputs convention). The
// broker performs its own full validation (shape, flat(waves) === ids,
// singleton-wave directives) and remains the source of truth for what is
// actually persisted; this module exists so a malformed payload from an
// agent-facing tool never leaves the Deck process in the first place.
//
// No electron imports so it is unit-testable under `bun test`.

export interface ValidateReorderWavesOptions {
  /** Cap on the number of waves a single reorder may submit. */
  maxWaves?: number
  /** Cap on the number of ids a single wave may contain. */
  maxWaveSize?: number
}

export type ValidateReorderWavesResult =
  | { ok: true; waves: string[][] }
  | { ok: false; error: string }

const DEFAULT_MAX_WAVES = 500
const DEFAULT_MAX_WAVE_SIZE = 500

/**
 * Validate an untrusted `waves` IPC argument against the `ids` the same call
 * is reordering. Rejects (does not silently repair) anything malformed:
 * wrong shape, a duplicate id across waves, an empty wave, or either cap
 * exceeded. Returns the narrowed `string[][]` on success.
 */
export function validateReorderWaves(
  ids: string[],
  waves: unknown,
  opts: ValidateReorderWavesOptions = {}
): ValidateReorderWavesResult {
  const maxWaves = opts.maxWaves ?? DEFAULT_MAX_WAVES
  const maxWaveSize = opts.maxWaveSize ?? DEFAULT_MAX_WAVE_SIZE

  if (!Array.isArray(waves)) return { ok: false, error: 'waves must be an array of arrays of ids' }
  if (waves.length > maxWaves) return { ok: false, error: `waves exceeds the ${maxWaves}-wave cap` }

  const seen = new Set<string>()
  const out: string[][] = []
  for (const wave of waves) {
    if (!Array.isArray(wave) || wave.length === 0) {
      return { ok: false, error: 'each wave must be a non-empty array of ids' }
    }
    if (wave.length > maxWaveSize) {
      return { ok: false, error: `a wave exceeds the ${maxWaveSize}-item cap` }
    }
    const clean: string[] = []
    for (const id of wave) {
      if (typeof id !== 'string' || id.trim() === '') {
        return { ok: false, error: 'wave ids must be non-empty strings' }
      }
      const trimmed = id.trim()
      if (seen.has(trimmed)) {
        return { ok: false, error: `id '${trimmed}' appears more than once across waves` }
      }
      seen.add(trimmed)
      clean.push(trimmed)
    }
    out.push(clean)
  }

  const flat = out.flat()
  if (flat.length !== ids.length || flat.some((id, i) => id !== ids[i])) {
    return { ok: false, error: 'waves must flatten to exactly ids, in the same order' }
  }

  return { ok: true, waves: out }
}
