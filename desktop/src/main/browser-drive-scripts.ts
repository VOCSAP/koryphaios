// Pure builders for the JavaScript snippets browser-drive.ts injects into the
// embedded webview (executeJavaScript), plus the input-validation caps. Kept
// electron-free so escaping and shape are bun-testable: the SELECTOR and any
// text come from the demo-driver AGENT — hostile until proven otherwise, so
// they only ever enter a script through JSON.stringify (never string-glued).

/** Selector/text caps: beyond these the tool call is refused, not truncated. */
export const MAX_SELECTOR_CHARS = 500
export const MAX_TYPE_CHARS = 2000

/** Page-snapshot caps (demo_read): keep the agent's context small. */
export const READ_TEXT_CAP = 4000
export const READ_INTERACTIVE_CAP = 60

/** Only web pages: file:/devtools:/about: navigation is refused. */
export function isNavigableUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url)
}

export function validSelector(selector: string): boolean {
  return selector.length > 0 && selector.length <= MAX_SELECTOR_CHARS
}

/**
 * Find `selector`, scroll it into view (centered) and return its center in
 * viewport CSS px — the coordinates sendInputEvent needs for a real click.
 */
export function buildLocateScript(selector: string): string {
  return `(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return { found: false }
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const r = el.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return { found: false }
  return { found: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
})()`
}

/** Focus `selector` (inputs before typing); reports whether it matched. */
export function buildFocusScript(selector: string): string {
  return `(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return { found: false }
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  if (typeof el.focus === 'function') el.focus()
  return { found: true }
})()`
}

/** True when `selector` currently matches a visible element (demo_wait). */
export function buildExistsScript(selector: string): string {
  return `(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return false
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
})()`
}

/**
 * Structured page snapshot (demo_read): url/title, a text excerpt, and the
 * interactive elements with a usable selector each — data-testid/id/
 * aria-label first, structural nth-of-type path as the fallback. The
 * accessibility-tree-over-screenshots idea, minimally.
 */
export function buildReadScript(
  textCap: number = READ_TEXT_CAP,
  interactiveCap: number = READ_INTERACTIVE_CAP
): string {
  return `(() => {
  const sel = (el) => {
    const tid = el.getAttribute('data-testid')
    if (tid) return '[data-testid=' + JSON.stringify(tid) + ']'
    if (el.id) return '#' + CSS.escape(el.id)
    const aria = el.getAttribute('aria-label')
    if (aria) return el.tagName.toLowerCase() + '[aria-label=' + JSON.stringify(aria) + ']'
    const parts = []
    let node = el
    while (node && node.nodeType === 1 && parts.length < 5 && node !== document.body) {
      const tag = node.tagName.toLowerCase()
      const parent = node.parentElement
      if (!parent) { parts.unshift(tag); break }
      const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName)
      parts.unshift(same.length > 1 ? tag + ':nth-of-type(' + (same.indexOf(node) + 1) + ')' : tag)
      node = parent
    }
    return parts.join(' > ')
  }
  const interactive = []
  const nodes = document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"], [role="tab"]')
  for (const el of nodes) {
    if (interactive.length >= ${Math.floor(interactiveCap)}) break
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    const label = (el.getAttribute('aria-label') || el.value || el.placeholder || el.innerText || '')
      .trim().replace(/\\s+/g, ' ').slice(0, 80)
    interactive.push({ tag: el.tagName.toLowerCase(), text: label, selector: sel(el) })
  }
  return {
    url: location.href,
    title: document.title,
    text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, ${Math.floor(textCap)}),
    interactive
  }
})()`
}
