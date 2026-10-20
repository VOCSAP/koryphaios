export type Capability = 'layout'

export const CERTIFIED: Readonly<Record<string, readonly Capability[]>> = {
  '2.1.303': ['layout'],
}

export function isCertified(
  base: string | undefined,
  capability: Capability,
): boolean {
  return base !== undefined && !base.endsWith('-dev') && CERTIFIED[base]?.includes(capability) === true
}
