import { useEffect, useMemo, useState } from 'react'
import type { LaunchPreset, ModelOption } from '@shared/types'
import type { ProviderCatalog } from '@shared/models'
import { errorText, useDeck } from './store'
import { mergeCreateCatalogs } from './peer-options'

/** Refetches on `models:changed`, so an open form never keeps a stale provider list. */
export function useModelChoices(): {
  presets: LaunchPreset[]
  catalogs: ProviderCatalog[]
  sandboxOn: boolean
} {
  const [presets, setPresets] = useState<LaunchPreset[]>([])
  const [models, setModels] = useState<ModelOption[]>([])
  const [provided, setProvided] = useState<ProviderCatalog[]>([])
  // The bridge wrapper is a host binary: it cannot reach into a container.
  const sandboxOn = useDeck((s) => s.sandboxStatus)?.enabled === true

  useEffect(() => {
    let alive = true
    const fail = (what: string) => (e: unknown): void => {
      window.api.reportError('model-choices', `${what} failed: ${errorText(e)}`)
    }
    const load = (): void => {
      void window.api.getLaunchConfig().then((c) => {
        if (!alive) return
        setPresets(c.presets ?? [])
        setModels(c.models ?? [])
      }, fail('launch config'))
      void window.api.modelCatalogs().then((c) => {
        if (alive) setProvided(c)
      }, fail('model catalogs'))
    }
    load()
    const off = window.api.onModelsChanged(load)
    return () => {
      alive = false
      off()
    }
  }, [])

  const catalogs = useMemo(() => mergeCreateCatalogs(models, provided), [models, provided])
  return { presets, catalogs, sandboxOn }
}
