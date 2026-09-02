// Turns a picked element's viewport-CSS-px rect plus a captured bitmap's
// dimensions into a source rect to crop, in the bitmap's own pixel space.
// The CSS->bitmap scale factor is derived empirically as capturedImageWidth /
// viewportCSSWidth, never from devicePixelRatio, since the webview can render
// on a non-primary display in a mixed-DPI setup.
// Fails closed to null on any degenerate input -- the pick itself already
// succeeded and is delivered regardless.

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
 * Returns null (fail closed) when any input is NaN/non-finite, when
 * viewportCssW or the image dimensions are <= 0, or when the padded, clamped
 * crop area is degenerate.
 * computeElementCropRect is a thin wrapper over this for the ElementPick shape;
 * every other precondition and the padding/scale/clamp body live here once,
 * shared by both callers.
 */
export function computeBoxCropRect(
  box: { x: number; y: number; width: number; height: number },
  imgW: number,
  imgH: number,
  viewportCssW: number
): ElementCropRect | null {
  if (!isFiniteNumber(box.x) || !isFiniteNumber(box.y)) return null
  if (!isFiniteNumber(box.width) || !isFiniteNumber(box.height)) return null
  if (!isFiniteNumber(imgW) || !isFiniteNumber(imgH)) return null
  if (!isFiniteNumber(viewportCssW) || viewportCssW <= 0) return null
  if (imgW <= 0 || imgH <= 0) return null
  // getBoundingClientRect (and strokeBounds's own outward-rounding) never
  // yields a negative width/height; a negative value here means a
  // malformed/hostile payload, not a legitimately off-screen box (x/y CAN
  // legitimately be negative -- a partially scrolled-off element or a stroke
  // started above/left of the viewport -- so only width/height are rejected
  // here, not position). Reject explicitly rather than let the padding math
  // below coincidentally net a positive size out of corrupted data.
  if (box.width < 0 || box.height < 0) return null

  // Empirical scale factor (subtlety (a) above): the capture is at bitmap
  // (device) resolution, the box at CSS resolution.
  const scale = imgW / viewportCssW

  const cssX = box.x - CROP_PADDING_CSS_PX
  const cssY = box.y - CROP_PADDING_CSS_PX
  const cssW = box.width + CROP_PADDING_CSS_PX * 2
  const cssH = box.height + CROP_PADDING_CSS_PX * 2

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

/**
 * `computeBoxCropRect` for an ElementPick, whose x/y are OPTIONAL (an older
 * pre-OD1 payload, or a non-web design-endpoint pick which never reaches this
 * path anyway since only the webview capture path calls it) -- null on
 * either being undefined, same fail-closed posture as every other guard
 * `computeBoxCropRect` itself applies.
 */
export function computeElementCropRect(
  pick: { x?: number; y?: number; width: number; height: number },
  imgW: number,
  imgH: number,
  viewportCssW: number
): ElementCropRect | null {
  if (!isFiniteNumber(pick.x) || !isFiniteNumber(pick.y)) return null
  return computeBoxCropRect(
    { x: pick.x, y: pick.y, width: pick.width, height: pick.height },
    imgW,
    imgH,
    viewportCssW
  )
}
