import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mockStore, storeMockStubs } from './_store-mock'
import type { LinkNotice } from '../desktop/src/renderer/src/terminal-links'

interface FakeState {
  sandboxStatus: { enabled: boolean } | null
  showToast(key: string, kind: string): void
}

const toasts: [string, string][] = []
const state: FakeState = { sandboxStatus: null, showToast: (key, kind) => void toasts.push([key, kind]) }
mockStore({ useDeck: Object.assign(() => state, { getState: () => state }), ...storeMockStubs } as never)

const { sessionLinkDeps } = await import('../desktop/src/renderer/src/terminal-link-deps')

const apiCalls: { openLink: unknown[][]; reportError: unknown[][] } = { openLink: [], reportError: [] }
const windowBefore = Object.getOwnPropertyDescriptor(globalThis, 'window')
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  writable: true,
  value: {
    api: {
      openLink: async (...args: unknown[]) => (apiCalls.openLink.push(args), { ok: true }),
      reportError: (...args: unknown[]) => void apiCalls.reportError.push(args)
    }
  }
})
afterAll(() => {
  if (windowBefore) Object.defineProperty(globalThis, 'window', windowBefore)
  else delete (globalThis as { window?: unknown }).window
})

beforeEach(() => {
  toasts.length = 0
  apiCalls.openLink.length = 0
  apiCalls.reportError.length = 0
  state.sandboxStatus = null
})

describe('sessionLinkDeps', () => {
  test('file links are offered only once the project is known not to be sandboxed', () => {
    const deps = sessionLinkDeps()
    state.sandboxStatus = null
    expect(deps.fileLinks(), 'before the first status arrives the guard stays closed').toBe(false)
    state.sandboxStatus = { enabled: true }
    expect(deps.fileLinks()).toBe(false)
    state.sandboxStatus = { enabled: false }
    expect(deps.fileLinks()).toBe(true)
  })

  test('open hands the target then the intent to the preload API, in that order', async () => {
    await sessionLinkDeps().open('/work/a.md', 'open')
    expect(apiCalls.openLink).toEqual([['/work/a.md', 'open']])
  })

  test('report goes to the terminal scope of the error log', () => {
    sessionLinkDeps().report('boom')
    expect(apiCalls.reportError).toEqual([['terminal', 'boom']])
  })

  test('every refusal reason has its own toast key, defined in both locales', () => {
    const reasons: Record<LinkNotice, true> = {
      invalid: true,
      'network-path': true,
      'not-found': true,
      'not-allowed': true,
      failed: true,
      sandbox: true
    }
    const dict = (name: string): Record<string, string> =>
      JSON.parse(readFileSync(join(import.meta.dir, '..', 'desktop', 'locales', `${name}.json`), 'utf8'))
    const [en, fr] = [dict('en'), dict('fr')]
    const deps = sessionLinkDeps()
    for (const reason of Object.keys(reasons) as LinkNotice[]) deps.onRefused(reason)
    const keys = toasts.map(([key]) => key)
    expect(new Set(keys).size, 'two reasons sharing a toast would hide which refusal happened').toBe(keys.length)
    for (const [key, kind] of toasts) {
      expect(en[key], `${key} is missing from en.json`).toBeString()
      expect(fr[key], `${key} is missing from fr.json`).toBeString()
      expect(kind).toBe('error')
    }
  })
})
