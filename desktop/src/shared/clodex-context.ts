export const CLODEX_CONTEXT_ENV = 'CLAUDE_CODE_MAX_CONTEXT_TOKENS'
export const CLODEX_CONTEXT_MIN = 200_000
export const CLODEX_CONTEXT_MAX = 872_000
export const CLODEX_CONTEXT_DEFAULT = 200_000

export function isClodexContextTokens(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= CLODEX_CONTEXT_MIN &&
    value <= CLODEX_CONTEXT_MAX
  )
}

/** Absent is valid (the default applies); null, strings, NaN and fractions are refused, never coerced. */
export function isValidClodexContextInput(value: unknown): value is number | undefined {
  return value === undefined || isClodexContextTokens(value)
}

export function assertClodexContextInput(value: unknown): void {
  if (!isValidClodexContextInput(value)) {
    throw new Error(
      `clodexContextTokens must be an integer between ${CLODEX_CONTEXT_MIN} and ${CLODEX_CONTEXT_MAX} tokens`
    )
  }
}

export function effectiveClodexContextTokens(value: unknown): number {
  return isClodexContextTokens(value) ? value : CLODEX_CONTEXT_DEFAULT
}

/** Child-only env of a tile that really launches through the wrapper; empty for every other tile. */
export function clodexContextEnv(
  tile: { bridge?: unknown; clodexContextTokens?: unknown },
  launchesThroughWrapper: boolean
): Record<string, string> {
  if (tile.bridge !== 'clodex' || !launchesThroughWrapper) return {}
  return { [CLODEX_CONTEXT_ENV]: String(effectiveClodexContextTokens(tile.clodexContextTokens)) }
}
