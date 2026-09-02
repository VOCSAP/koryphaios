// Two independent installs consume this: the guest preload watches the page's
// own document, since key events over an Electron webview guest never reach the
// host window (separate webContents/process).
// BrowserView.tsx watches the host window, since once the draw canvas overlay
// is up it covers the guest.
// Injectable target so this stays plain-DOM bun-testable under happy-dom.

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
 * Listens in the capture phase so the watcher sees the key even if the page
 * stops propagation, plus a blur fallback: a keyup released while focus moved
 * elsewhere (devtools, OS Cmd+Tab) is not guaranteed to reach this listener.
 * Auto-repeat keydowns are ignored; onChange only fires on an actual transition
 * of the held state, so a consumer can treat every call as a state change,
 * never as "still down".
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
