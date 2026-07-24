// Browser driver (REC scripted-scenario lot): executes the demo-control
// tools against the embedded browser's WebContents. Clicks and keystrokes go
// through sendInputEvent (REAL input events — hover/active states and focus
// behave like a human hand, which is what the recording should show), element
// location and page snapshots through executeJavaScript with the pure script
// builders of browser-drive-scripts.ts (agent-supplied strings only enter a
// script JSON-encoded).
//
// The driver implements DemoControlDeps (demo-control.ts); every method
// throws a readable error — the MCP bridge relays it to the agent, which can
// re-read the page and adapt.

import type { WebContents } from 'electron'
import type { DemoControlDeps } from './demo-control'
import {
  buildExistsScript,
  buildFocusScript,
  buildLocateScript,
  buildReadScript,
  isNavigableUrl,
  MAX_TYPE_CHARS,
  validSelector
} from './browser-drive-scripts'

/** Element lookups poll this long before failing (SPAs render late). */
const LOCATE_TIMEOUT_MS = 5_000
const LOCATE_POLL_MS = 250

/** demo_wait bounds. */
const WAIT_MS_CAP = 15_000
const WAIT_SELECTOR_TIMEOUT_MS = 15_000

/** Keystroke pacing: visible typing on the recording, not paste-speed. */
const TYPE_DELAY_MS = 45

const NAVIGATE_TIMEOUT_MS = 20_000

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function createBrowserDriver(wc: WebContents): DemoControlDeps {
  function gone(): boolean {
    return wc.isDestroyed()
  }

  async function exec<T>(script: string): Promise<T> {
    if (gone()) throw new Error('the embedded browser is gone')
    return (await wc.executeJavaScript(script, true)) as T
  }

  /** Poll for a selector's clickable center until LOCATE_TIMEOUT_MS. */
  async function locate(selector: string): Promise<{ x: number; y: number }> {
    if (!validSelector(selector)) throw new Error('invalid selector (empty or too long)')
    const deadline = Date.now() + LOCATE_TIMEOUT_MS
    for (;;) {
      const res = await exec<{ found: boolean; x?: number; y?: number }>(
        buildLocateScript(selector)
      )
      if (res.found && typeof res.x === 'number' && typeof res.y === 'number') return { x: res.x, y: res.y }
      if (Date.now() >= deadline) {
        throw new Error(`no visible element matches ${JSON.stringify(selector)} — demo_read the page and adjust`)
      }
      await sleep(LOCATE_POLL_MS)
    }
  }

  return {
    async navigate(url: string) {
      if (!isNavigableUrl(url)) throw new Error('only http(s) URLs can be loaded')
      if (gone()) throw new Error('the embedded browser is gone')
      const settled = new Promise<void>((resolve) => {
        const done = (): void => {
          wc.removeListener('did-stop-loading', done)
          resolve()
        }
        wc.on('did-stop-loading', done)
        setTimeout(done, NAVIGATE_TIMEOUT_MS)
      })
      await wc.loadURL(url).catch((e) => {
        // ERR_ABORTED (-3) is in-page navigation noise, not a failure.
        if (!String(e).includes('ERR_ABORTED')) throw new Error(`navigation failed: ${String(e)}`)
      })
      await settled
      await sleep(300) // let first paints land before the agent reads/acts
      return { url: wc.getURL(), title: wc.getTitle() }
    },

    async click(selector: string) {
      const { x, y } = await locate(selector)
      await sleep(120) // post-scroll settle: the click lands where located
      wc.sendInputEvent({ type: 'mouseMove', x, y })
      await sleep(80)
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      await sleep(60)
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
      await sleep(150)
      return { clicked: true, x, y }
    },

    async type(text: string, opts: { selector?: string; pressEnter?: boolean }) {
      if (text.length > MAX_TYPE_CHARS) throw new Error(`text too long (max ${MAX_TYPE_CHARS})`)
      if (opts.selector) {
        if (!validSelector(opts.selector)) throw new Error('invalid selector (empty or too long)')
        const res = await exec<{ found: boolean }>(buildFocusScript(opts.selector))
        if (!res.found) {
          throw new Error(`no element matches ${JSON.stringify(opts.selector)} — demo_read the page and adjust`)
        }
        await sleep(120)
      }
      for (const ch of text) {
        if (gone()) throw new Error('the embedded browser is gone')
        // keyDown+char+keyUp per character: fires the full event chain
        // (keydown/keypress/input) that controlled inputs listen to.
        wc.sendInputEvent({ type: 'keyDown', keyCode: ch })
        wc.sendInputEvent({ type: 'char', keyCode: ch })
        wc.sendInputEvent({ type: 'keyUp', keyCode: ch })
        await sleep(TYPE_DELAY_MS)
      }
      if (opts.pressEnter) {
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
        wc.sendInputEvent({ type: 'char', keyCode: 'Enter' })
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
        await sleep(150)
      }
      return { typed: true, chars: text.length }
    },

    async read() {
      return exec(buildReadScript())
    },

    async wait(opts: { ms?: number; selector?: string }) {
      if (opts.ms !== undefined) {
        const ms = Math.max(0, Math.min(WAIT_MS_CAP, Math.floor(opts.ms)))
        await sleep(ms)
        return { waited_ms: ms }
      }
      const selector = opts.selector ?? ''
      if (!validSelector(selector)) throw new Error('invalid selector (empty or too long)')
      const deadline = Date.now() + WAIT_SELECTOR_TIMEOUT_MS
      for (;;) {
        if (await exec<boolean>(buildExistsScript(selector))) return { appeared: true }
        if (Date.now() >= deadline) {
          throw new Error(`${JSON.stringify(selector)} did not appear within ${WAIT_SELECTOR_TIMEOUT_MS / 1000}s`)
        }
        await sleep(LOCATE_POLL_MS)
      }
    }
  }
}
