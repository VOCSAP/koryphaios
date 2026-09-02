// A stroke is the operator's raw pointer trail in CSS px: 'freehand' an
// arbitrary polyline, 'circle' an ellipse inscribed in the bounding box of the
// drag's first and last point only -- intermediate points and the live preview
// never affect a circle's own geometry.
// paintStroke takes a CanvasRenderingContext2D-shaped parameter, not the real
// DOM type, so this module stays DOM-free and bun-testable.

export type DrawTool = 'freehand' | 'circle'

export interface DrawPoint {
  x: number
  y: number
}

export interface DrawStroke {
  tool: DrawTool
  points: DrawPoint[]
}

/** A stroke's bounding box, in CSS px (width/height always >= 1). */
export interface StrokeBounds {
  x: number
  y: number
  width: number
  height: number
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

function isFinitePoint(p: DrawPoint | undefined): p is DrawPoint {
  return !!p && isFiniteNumber(p.x) && isFiniteNumber(p.y)
}

/** The subset of a stroke's points that determine its bounds: first+last for 'circle', every point for 'freehand'. */
function boundingPoints(stroke: DrawStroke): DrawPoint[] {
  if (stroke.tool !== 'circle') return stroke.points
  const first = stroke.points[0]
  const last = stroke.points[stroke.points.length - 1]
  return first && last ? [first, last] : []
}

/**
 * Returns null when there are fewer than 2 points or any bounding point is
 * non-finite -- a pointer-event-derived stream is never trusted blindly.
 * Width/height round outward (floor the min corner, ceil the max) then floor at
 * 1, so a sub-pixel or perfectly straight drag still yields a paintable,
 * croppable rect.
 */
export function strokeBounds(stroke: DrawStroke): StrokeBounds | null {
  if (!stroke || !Array.isArray(stroke.points) || stroke.points.length < 2) return null
  const pts = boundingPoints(stroke)
  if (pts.length < 2) return null
  for (const p of pts) if (!isFinitePoint(p)) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }

  const x = Math.floor(minX)
  const y = Math.floor(minY)
  const width = Math.max(1, Math.ceil(maxX) - x)
  const height = Math.max(1, Math.ceil(maxY) - y)
  return { x, y, width, height }
}

export interface StrokeStyle {
  color: string
  lineWidth: number
}

/// <reference lib="dom" />
// The reference above is TYPE-ONLY (this file imports nothing DOM-shaped and
// runs fine without it -- see shared/element-pick.ts for the same pattern):
// `strokeStyle`'s real DOM type is `string | CanvasGradient | CanvasPattern`,
// wider than the plain `string` this module ever assigns, so DrawableContext
// below has to admit that full union or `paintStroke(realCtx, ...)` fails to
// typecheck under tsconfig.node.json (src/shared/** is in ITS program too,
// with no DOM lib of its own -- the reference directive is what supplies
// CanvasGradient/CanvasPattern there without adding a real import).

/**
 * The CanvasRenderingContext2D surface this module actually calls -- kept
 * minimal and structural (not `CanvasRenderingContext2D` itself) so a plain
 * call-recording fake object satisfies it in tests, with zero dependency on
 * an actual DOM being present at runtime.
 */
export interface DrawableContext {
  strokeStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
  lineCap: string
  lineJoin: string
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  stroke(): void
  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number
  ): void
}

/**
 * Paint a stroke into `ctx`, coordinates multiplied by `scale` (1 for the
 * live preview canvas, drawn 1:1; imgW/viewportCssW when burning the stroke
 * onto a captured-bitmap crop -- see BrowserView.tsx's captureRegionShot).
 * 'freehand' replays the recorded polyline verbatim, round caps/joins so
 * short segments show no visible seam. 'circle' draws exactly ONE ellipse
 * inscribed in the bbox of the first and last point -- the SAME two points
 * `strokeBounds` uses -- so the burned-in crop matches what the operator saw
 * live, not a re-fit of the whole gesture. No-op on fewer than 2 points, the
 * same floor `strokeBounds` applies, so a caller that already checked
 * `strokeBounds` for null never needs a second guard here.
 */
export function paintStroke(
  ctx: DrawableContext,
  stroke: DrawStroke,
  scale: number,
  style: StrokeStyle
): void {
  if (!stroke || !Array.isArray(stroke.points) || stroke.points.length < 2) return
  ctx.strokeStyle = style.color
  ctx.lineWidth = style.lineWidth
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  if (stroke.tool === 'circle') {
    const first = stroke.points[0]!
    const last = stroke.points[stroke.points.length - 1]!
    const cx = ((first.x + last.x) / 2) * scale
    const cy = ((first.y + last.y) / 2) * scale
    const rx = (Math.abs(last.x - first.x) / 2) * scale
    const ry = (Math.abs(last.y - first.y) / 2) * scale
    ctx.beginPath()
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
    ctx.stroke()
    return
  }

  ctx.beginPath()
  const p0 = stroke.points[0]!
  ctx.moveTo(p0.x * scale, p0.y * scale)
  for (let i = 1; i < stroke.points.length; i++) {
    const p = stroke.points[i]!
    ctx.lineTo(p.x * scale, p.y * scale)
  }
  ctx.stroke()
}

/**
 * Intersects bounds with the visible box, or null if nothing is visible. A
 * stroke's raw bounds can carry negative x/y (pointer capture keeps delivering
 * moves once a drag began off-canvas) -- fine for the crop math, but the
 * persisted PickRegion validator rejects negative coordinates.
 * Callers persist the clamped region and keep feeding the raw bounds to the
 * capture path.
 */
export function clampBoundsToBox(
  bounds: StrokeBounds,
  boxW: number,
  boxH: number
): StrokeBounds | null {
  if (!Number.isFinite(boxW) || !Number.isFinite(boxH) || boxW <= 0 || boxH <= 0) return null
  const x0 = Math.max(0, bounds.x)
  const y0 = Math.max(0, bounds.y)
  const x1 = Math.min(boxW, bounds.x + bounds.width)
  const y1 = Math.min(boxH, bounds.y + bounds.height)
  if (!(x1 > x0) || !(y1 > y0)) return null
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}
