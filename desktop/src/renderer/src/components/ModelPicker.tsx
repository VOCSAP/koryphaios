import { useState } from 'react'
import type { ModelTarget } from '@shared/graph'
import type { ProviderCatalog } from '@shared/models'
import { CLODEX_PROVIDER_ID, favKey, resolveFavorites, toggleFavorite } from '@shared/models'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { GLYPH_BADGES, GLYPH_PROVIDERS } from './icons'

// Unified model picker (EXPLORATION-graph-chat C29), shared by the graph
// chat's target selection and the agents' advanced create menu:
//
//   <icon> Provider            ›     ← expandable section per provider
//   ─────────────────────────
//   <pinned favorites>         ★     ← operator favorites, pin order
//
// Providers whose CLI is not detected are hidden (D11); local providers
// (Ollama / LiteLLM) appear with their dynamically discovered models. The
// star pins a model into the favorites list (persisted in AppConfig).
// A bridge provider is hidden while its wrapper is absent, and shown greyed
// (models unreachable) when the wrapper is installed but its proxy is idle:
// the operator has something to fix, unlike a CLI they never installed.

/** Icon for a provider section (locals get a house). */
export function providerIcon(catalog: ProviderCatalog): React.JSX.Element {
  // The clodex bridge serves OpenAI models through the claude CLI: OpenAI's
  // sigil names what answers, not the binary that carries it.
  if (catalog.id === CLODEX_PROVIDER_ID) return GLYPH_PROVIDERS.openai
  return (
    GLYPH_PROVIDERS[catalog.id as keyof typeof GLYPH_PROVIDERS] ??
    (catalog.kind === 'local' ? GLYPH_PROVIDERS.local : GLYPH_PROVIDERS.other)
  )
}

export interface ModelPickerProps {
  catalogs: ProviderCatalog[]
  /** Selected favorite-style keys (`providerId:modelId`). */
  selected: string[]
  /** Multi = toggle targets (graph fan-out); single = replace (create menu). */
  multi: boolean
  /** Restrict to these provider ids (create menu: ['anthropic']). */
  onlyProviders?: string[]
  /** Drop whole provider kinds the caller cannot execute (headless: 'bridge'). */
  excludeKinds?: ProviderCatalog['kind'][]
  onPick(key: string, target: ModelTarget): void
}

/**
 * Resolve a catalog+model into the ModelTarget the engine consumes. Locals and
 * bridges both carry their provider id: their models are only meaningful
 * through the provider that listed them, and the id is what keys the picker.
 */
function toTarget(catalog: ProviderCatalog, modelId: string): ModelTarget {
  return {
    cli: catalog.cli,
    model: modelId,
    ...(catalog.kind === 'local' || catalog.kind === 'bridge' ? { providerId: catalog.id } : {})
  }
}

export function ModelPicker({
  catalogs,
  selected,
  multi,
  onlyProviders,
  excludeKinds,
  onPick
}: ModelPickerProps): React.JSX.Element {
  const t = useT()
  const config = useDeck((s) => s.config!)
  const updateConfig = useDeck((s) => s.updateConfig)
  const [open, setOpen] = useState<Record<string, boolean>>({})

  const favorites = config.modelFavorites ?? []
  // An idle bridge keeps its section (greyed, with the command to run); every
  // other unavailable provider is simply absent. resolveFavorites drops the
  // unavailable ones on its own, so a pin on an idle bridge stays unlisted.
  const visible = catalogs.filter(
    (c) =>
      (!onlyProviders || onlyProviders.includes(c.id)) &&
      !excludeKinds?.includes(c.kind) &&
      (c.kind === 'bridge' ? c.bridge?.installed === true : c.available)
  )
  const pinned = resolveFavorites(visible, favorites)

  const star = (key: string): void => {
    void updateConfig({ modelFavorites: toggleFavorite(favorites, key) })
  }

  const row = (catalog: ProviderCatalog, modelId: string, label: string): React.JSX.Element => {
    const key = favKey(catalog.id, modelId)
    const isSelected = selected.includes(key)
    const isFav = favorites.includes(key)
    return (
      <div
        key={key}
        className={`mp-model${isSelected ? ' is-selected' : ''}`}
        onClick={() => onPick(key, toTarget(catalog, modelId))}
      >
        {multi && (
          <span className="mp-check">
            {isSelected ? GLYPH_BADGES.checkboxOn : GLYPH_BADGES.checkboxOff}
          </span>
        )}
        <span className="mp-model-name">{label}</span>
        <button
          className={`mp-star${isFav ? ' is-fav' : ''}`}
          title={isFav ? t('models.unpin') : t('models.pin')}
          onClick={(e) => {
            e.stopPropagation()
            star(key)
          }}
        >
          {isFav ? GLYPH_BADGES.starFilled : GLYPH_BADGES.star}
        </button>
      </div>
    )
  }

  return (
    <div className="model-picker">
      {visible.length === 0 && <div className="mp-empty">{t('models.none')}</div>}
      {visible.map((c) => {
        const idle = c.kind === 'bridge' && !c.available
        const patchWarn =
          c.kind === 'bridge' && (c.bridge?.patch === 'stale' || c.bridge?.patch === 'none')
        return (
          <div key={c.id} className="mp-provider">
            <div
              className={`mp-provider-head${idle ? ' is-disabled' : ''}`}
              aria-disabled={idle || undefined}
              onClick={idle ? undefined : () => setOpen((o) => ({ ...o, [c.id]: !o[c.id] }))}
            >
              <span className="mp-provider-icon">{providerIcon(c)}</span>
              <span className="mp-provider-name">{c.name}</span>
              {c.kind === 'local' && <span className="mp-provider-kind">{t('models.local')}</span>}
              {c.kind === 'bridge' && <span className="mp-provider-kind">{t('models.bridge')}</span>}
              {patchWarn && (
                <span className="mp-provider-warn" title={t('models.bridgePatchStale')}>
                  {GLYPH_BADGES.warning}
                </span>
              )}
              {!idle && <span className={`mp-arrow${open[c.id] ? ' is-open' : ''}`}>›</span>}
            </div>
            {idle && <div className="mp-provider-hint">{t('models.bridgeServerDown')}</div>}
            {!idle && open[c.id] && (
              <div className="mp-models">
                {c.models.map((m) => row(c, m.id, m.label ?? m.id))}
              </div>
            )}
          </div>
        )
      })}
      <div className="mp-separator" />
      {pinned.length === 0 && <div className="mp-empty">{t('models.noFavorites')}</div>}
      {pinned.map((f) => row(f.catalog, f.model.id, f.model.label ?? f.model.id))}
    </div>
  )
}
