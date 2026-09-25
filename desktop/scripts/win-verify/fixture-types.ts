// Shared fixture types for the win-verify scripts.
// A fixture is the same JSON shape as tests/pty-harness/fixtures/*.json:
// a flat array of raw PTY chunks in arrival order, `t` a millisecond
// timestamp relative to the start of the capture (not wall clock), `data`
// the decoded UTF-8 string node-pty's onData handed us for that chunk.
// No other file in this directory may redefine this shape -- import it.

export interface FixtureChunk {
  t: number
  data: string
}

export type Fixture = FixtureChunk[]

export function isFixture(v: unknown): v is Fixture {
  return (
    Array.isArray(v) &&
    v.every(
      (c) =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as Record<string, unknown>).t === 'number' &&
        typeof (c as Record<string, unknown>).data === 'string'
    )
  )
}
