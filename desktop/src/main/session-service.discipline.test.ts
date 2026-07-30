import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// A `*Detector.on(...)` handler that mutates a RuntimeState field surfaced by
// toRuntime() but skips this.broadcast() leaves the renderer's snapshot
// stale (2026-07-30: the thinking badge froze this way). Guard the whole
// handler family textually, not just the one that broke.
test('every Detector.on handler mutating RuntimeState calls this.broadcast()', () => {
  const src = readFileSync(join(__dirname, 'session-service.ts'), 'utf8')
  const guarded = ['thinking', 'rateLimited', 'resumeAt', 'needsAttention']
  const re = /\w+Detector\.on\(\s*'[^']+',\s*\(\{[^}]*\}[^)]*\)\s*=>\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let depth = 1
    let i = m.index + m[0].length
    while (depth > 0 && i < src.length) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') depth--
      i++
    }
    const body = src.slice(m.index + m[0].length, i)
    if (guarded.some((f) => new RegExp(`\\br\\.${f}\\s*=`).test(body))) {
      assert.ok(body.includes('this.broadcast()'), `handler missing this.broadcast(): ${m[0]}`)
    }
  }
})
