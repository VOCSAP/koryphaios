import { useState } from 'react'
import type { ModelTarget } from '@shared/graph'
import type { ProviderCatalog } from '@shared/models'
import { favKey, resolveFavorites, toggleFavorite } from '@shared/models'
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

/** Icon for a provider section (locals get a house). */
export function providerIcon(catalog: ProviderCatalog): React.JSX.Element {
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
  onPick(key: string, target: ModelTarget): void
}

/** Resolve a catalog+model into the ModelTarget the engine consumes. */
function toTarget(catalog: ProviderCatalog, modelId: string): ModelTarget {
  return {
    cli: catalog.cli,
    model: modelId,
    ...(catalog.kind === 'local' ? { providerId: catalog.id } : {})
  }
}

export function ModelPicker({
  catalogs,
  selected,
  multi,
  onlyProviders,
  onPick
}: ModelPickerProps): React.JSX.Element {
  const t = useT()
  const config = useDeck((s) => s.config!)
  const updateConfig = useDeck((s) => s.updateConfig)
  const [open, setOpen] = useState<Record<string, boolean>>({})

  const favorites = config.modelFavorites ?? []
  const visible = catalogs.filter(
    (c) => c.available && (!onlyProviders || onlyProviders.includes(c.id))
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
      {visible.map((c) => (
        <div key={c.id} className="mp-provider">
          <div
            className="mp-provider-head"
            onClick={() => setOpen((o) => ({ ...o, [c.id]: !o[c.id] }))}
          >
            <span className="mp-provider-icon">{providerIcon(c)}</span>
            <span className="mp-provider-name">{c.name}</span>
            {c.kind === 'local' && <span className="mp-provider-kind">{t('models.local')}</span>}
            <span className={`mp-arrow${open[c.id] ? ' is-open' : ''}`}>›</span>
          </div>
          {open[c.id] && (
            <div className="mp-models">
              {c.models.map((m) => row(c, m.id, m.label ?? m.id))}
            </div>
          )}
        </div>
      ))}
      <div className="mp-separator" />
      {pinned.length === 0 && <div className="mp-empty">{t('models.noFavorites')}</div>}
      {pinned.map((f) => row(f.catalog, f.model.id, f.model.label ?? f.model.id))}
    </div>
  )
}
