// Screen-recording helpers for the browser view's REC feature (pure logic,
// bun-testable — the MediaRecorder/getDisplayMedia wiring stays in the
// renderer, the file write in ipc.ts).

/** What the recording captures. */
export type RecordingScope = 'window' | 'browser'

/**
 * Container formats we can ask MediaRecorder for, best first: MP4 (h264) when
 * the Chromium build muxes it (plays everywhere, embeds in a GitHub README),
 * else WebM. The generic fallbacks let the encoder pick its default codec.
 */
const MIME_CANDIDATES: ReadonlyArray<{ mime: string; ext: 'mp4' | 'webm' }> = [
  { mime: 'video/mp4;codecs=avc1', ext: 'mp4' },
  { mime: 'video/mp4', ext: 'mp4' },
  { mime: 'video/webm;codecs=vp9', ext: 'webm' },
  { mime: 'video/webm', ext: 'webm' }
]

/** Pick the best supported container, or null when none is (no recording). */
export function pickRecorderMime(
  isSupported: (mime: string) => boolean
): { mime: string; ext: 'mp4' | 'webm' } | null {
  for (const c of MIME_CANDIDATES) if (isSupported(c.mime)) return { ...c }
  return null
}

/** Source rectangle to crop out of the captured window frame, in video px. */
export interface CropRect {
  sx: number
  sy: number
  sw: number
  sh: number
}

/**
 * Map a DOM rect (CSS px, relative to the viewport) onto the captured window
 * frame (video px). The capture may include OS chrome above the web contents
 * (title bar): width is assumed to map 1:1 onto the client area (frameless
 * sides), and the height surplus is attributed to top chrome. The rect is
 * clamped inside the frame so a mid-resize never yields out-of-bounds reads.
 */
export function computeCropRect(
  videoW: number,
  videoH: number,
  innerW: number,
  innerH: number,
  rect: { left: number; top: number; width: number; height: number }
): CropRect | null {
  if (videoW <= 0 || videoH <= 0 || innerW <= 0 || innerH <= 0) return null
  if (rect.width <= 0 || rect.height <= 0) return null
  const scale = videoW / innerW
  const chromeH = Math.max(0, videoH - innerH * scale)
  const sx = Math.max(0, rect.left * scale)
  const sy = Math.max(0, chromeH + rect.top * scale)
  if (sx >= videoW || sy >= videoH) return null
  const sw = Math.min(videoW - sx, rect.width * scale)
  const sh = Math.min(videoH - sy, rect.height * scale)
  if (sw < 1 || sh < 1) return null
  return { sx, sy, sw, sh }
}

/** `recording-2026-07-23T14-05-12.webm` — same stamp style as annotations. */
export function recordingFileName(ext: 'mp4' | 'webm', now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `recording-${stamp}.${ext}`
}

/** Elapsed `m:ss` label for the toolbar timer. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
