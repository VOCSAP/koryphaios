export type Capability = 'layout'

export const MIN_SUPPORTED: Readonly<Record<Capability, string>> = {
  layout: '2.1.303',
}

const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function parseRelease(base: string): [number, number, number] | undefined {
  const match = RELEASE.exec(base)
  if (!match) return undefined
  const parts: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])]
  return parts.every(Number.isSafeInteger) ? parts : undefined
}

// A development build's base is spelled '2.1.303-dev', not as a release, so it stays stock.
export function isSupported(base: string | undefined, capability: Capability): boolean {
  if (base === undefined) return false
  const current = parseRelease(base)
  const minimum = parseRelease(MIN_SUPPORTED[capability])
  if (current === undefined || minimum === undefined) return false
  for (let i = 0; i < 3; i++) {
    if (current[i] !== minimum[i]) return current[i]! > minimum[i]!
  }
  return true
}
