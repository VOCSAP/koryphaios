// Hold-to-draw modifier watcher (embedded browser rework, docs/
// browser-design.md's "Draw mode" section): tracks whether the platform's
// "draw" key (Cmd on macOS, Ctrl elsewhere -- same Ctrl/Cmd convention as
// menu.ts's `isMac`) is currently held, without owning any UI itself.
//
// TWO independent installs consume this, and both are required:
//   - the guest preload (preload/browser-inspect.ts), watching the PAGE's own
//     `document` -- key events over an Electron <webview> guest never reach
//     the HOST window at all (it is a separate webContents/renderer process),
//     so a host-only listener would miss every hold that started with the
//     pointer over the page;
//   - BrowserView.tsx itself, watching the HOST `window` -- once the draw
//     canvas overlay is up it covers the guest, so a hold that continues (or
//     starts) with focus over the toolbar/canvas is host-side only.
// BrowserView merges both signals (its own comment explains how); this
// module makes no assumption about which target it is given, by design.
//
// Injectable `target` (Window | Document -- anything shaped like one) so this
// stays plain-DOM bun-testable under happy-dom, same convention as
// shared/element-pick.ts's `createInspectMode`.

export type DrawModifierPlatform = 'mac' | 'other'

/** Minimal Window|Document surface this module actually calls. */
export interface DrawModifierTarget {
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): void
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions
  ): void
}

/** Meta (Cmd) on macOS, Control everywhere else. */
export function isDrawModifierKey(e: { key: string }, platform: DrawModifierPlatform): boolean {
  return platform === 'mac' ? e.key === 'Meta' : e.key === 'Control'
}

/**
 * Installs keydown/keyup listeners in the CAPTURE phase (so the watcher sees
 * the key even if the page/app stops propagation on it) plus a `blur`
 * fallback that forces `held=false` -- the keyup for a hold released while
 * focus moved elsewhere (devtools, an OS-level Cmd+Tab, a click that shifted
 * focus to a different window) is not guaranteed to ever reach this
 * listener, and blur is the only reliable backstop for that case.
 *
 * Auto-repeat keydowns (`e.repeat`) are ignored outright, and `onChange` only
 * ever fires on an actual TRANSITION of the held state (a second keydown for
 * an already-held key, or a keyup/blur when not held, is a silent no-op) --
 * so a consumer can treat every call as "the state just changed", never as
 * "the key is still down".
 *
 * Returns a dispose function that removes all three listeners; safe to call
 * more than once (repeated `removeEventListener` calls are no-ops).
 */
export function createDrawModifierWatcher(
  target: DrawModifierTarget,
  platform: DrawModifierPlatform,
  onChange: (held: boolean) => void
): () => void {
  let held = false

  function setHeld(next: boolean): void {
    if (next === held) return
    held = next
    onChange(held)
  }

  function onKeyDown(e: Event): void {
    const ke = e as KeyboardEvent
    if (ke.repeat) return
    if (isDrawModifierKey(ke, platform)) setHeld(true)
  }

  function onKeyUp(e: Event): void {
    if (isDrawModifierKey(e as KeyboardEvent, platform)) setHeld(false)
  }

  function onBlur(): void {
    setHeld(false)
  }

  target.addEventListener('keydown', onKeyDown, true)
  target.addEventListener('keyup', onKeyUp, true)
  target.addEventListener('blur', onBlur, true)

  return () => {
    target.removeEventListener('keydown', onKeyDown, true)
    target.removeEventListener('keyup', onKeyUp, true)
    target.removeEventListener('blur', onBlur, true)
  }
}
