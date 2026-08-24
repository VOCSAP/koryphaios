// Element-pick screenshot crop math (Chantier OD4, DESIGN-ORCA-DOOP-ADOPTION.md
// §3.3). Pure, no DOM: turns a picked element's viewport-CSS-px rect (OD1's
// ElementPick.x/y/width/height) plus a captured bitmap's dimensions into a
// source rect to crop, in the bitmap's own pixel space. Kept import-free
// (only plain numbers in/out) so it stays bun-testable without Electron.
//
// Two subtleties ported from orca's browser-grab-screenshot.ts (MIT), cited
// in the design brief:
//   (a) the CSS->bitmap scale factor is derived EMPIRICALLY as
//       capturedImageWidth / viewportCSSWidth, never from the primary
//       display's devicePixelRatio -- wrong on mixed-DPI multi-monitor
//       setups, since the webview can be rendered on a non-primary display.
//   (b) fail closed to null ("no screenshot") on any degenerate input rather
//       than emit an oversized or malformed crop -- the pick itself already
//       succeeded and is delivered regardless (see BrowserView.tsx).

/** Source rectangle to crop out of the captured bitmap, in bitmap px. */
export interface ElementCropRect {
  sx: number
  sy: number
  sw: number
  sh: number
}

/** Context padding around the element rect, in CSS px (helps the agent see surroundings). */
const CROP_PADDING_CSS_PX = 8

/**
 * Hard budget on the saved screenshot PNG's byte size (same order of
 * magnitude as orca's GRAB_BUDGET.screenshotMaxBytes). The caller compares
 * this against a data: URL's base64 payload length, not raw bytes -- base64
 * inflates by 4/3 (3 raw bytes -> 4 base64 chars), so the string-length cap
 * derived from this constant must multiply by 4/3 (see BrowserView.tsx).
 */
export const PICK_SHOT_MAX_BYTES = 2 * 1024 * 1024

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

/**
 * Map a picked element's viewport-CSS-px rect onto a captured bitmap's pixel
 * space, padded for context and clamped to the bitmap bounds. Returns null
 * (no screenshot, fail closed) when:
 *   - the element rect is missing (pick.x or pick.y undefined -- an older
 *     pre-OD1 payload, or a non-web design-endpoint pick which never reaches
 *     this path anyway since only the webview capture path calls it),
 *   - any input is NaN/non-finite (never trust a rect and image dimensions
 *     computed from an untrusted page or a raced/torn-down capture),
 *   - viewportCssW or the image dimensions are <= 0,
 *   - the padded, clamped crop area is degenerate (sw or sh <= 0) -- the
 *     element rect was entirely outside the image, or its reported size was
 *     itself negative/zero beyond what the padding can absorb.
 */
export function computeElementCropRect(
  pick: { x?: number; y?: number; width: number; height: number },
  imgW: number,
  imgH: number,
  viewportCssW: number
): ElementCropRect | null {
  if (!isFiniteNumber(pick.x) || !isFiniteNumber(pick.y)) return null
  if (!isFiniteNumber(pick.width) || !isFiniteNumber(pick.height)) return null
  if (!isFiniteNumber(imgW) || !isFiniteNumber(imgH)) return null
  if (!isFiniteNumber(viewportCssW) || viewportCssW <= 0) return null
  if (imgW <= 0 || imgH <= 0) return null
  // getBoundingClientRect never yields a negative width/height; a negative
  // value here means a malformed/hostile payload, not a legitimately
  // off-screen element (x/y CAN legitimately be negative -- a partially
  // scrolled-off element -- so only width/height are rejected here, not
  // position). Reject explicitly rather than let the padding math below
  // coincidentally net a positive size out of corrupted data.
  if (pick.width < 0 || pick.height < 0) return null

  // Empirical scale factor (subtlety (a) above): the capture is at bitmap
  // (device) resolution, the pick rect at CSS resolution.
  const scale = imgW / viewportCssW

  const cssX = pick.x - CROP_PADDING_CSS_PX
  const cssY = pick.y - CROP_PADDING_CSS_PX
  const cssW = pick.width + CROP_PADDING_CSS_PX * 2
  const cssH = pick.height + CROP_PADDING_CSS_PX * 2

  const rawSx = cssX * scale
  const rawSy = cssY * scale
  const rawEndX = (cssX + cssW) * scale
  const rawEndY = (cssY + cssH) * scale

  const sx = Math.max(0, Math.round(rawSx))
  const sy = Math.max(0, Math.round(rawSy))
  const ex = Math.min(imgW, Math.round(rawEndX))
  const ey = Math.min(imgH, Math.round(rawEndY))
  const sw = ex - sx
  const sh = ey - sy

  if (sw <= 0 || sh <= 0) return null
  return { sx, sy, sw, sh }
}
