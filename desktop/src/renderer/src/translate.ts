// Store-free, so a window without the Deck store (the Avatar bubble) translates too.

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
