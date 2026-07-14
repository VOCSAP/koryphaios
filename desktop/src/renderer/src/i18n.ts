// Renderer-side translation helper. The dictionary lives in the zustand store
// (fetched from main via window.api.getI18n on init and on every locale change);
// `useT` returns a `t` bound to it that re-renders consumers when it updates.

import { useCallback } from 'react'
import { useDeck } from './store'

/** Interpolate `{name}` placeholders; missing key -> key, missing param -> token. */
export function translate(
  dict: Record<string, string>,
  key: string,
  params?: Record<string, string | number>
): string {
  const template = dict[key] ?? key
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  )
}

export type TFn = (key: string, params?: Record<string, string | number>) => string

/** Locale-aware HH:MM for badges (quota resume time). */
export function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Hook returning a `t` whose identity changes when the active dict changes. */
export function useT(): TFn {
  const dict = useDeck((s) => s.dict)
  return useCallback<TFn>((key, params) => translate(dict, key, params), [dict])
}
