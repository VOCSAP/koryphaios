import { constants } from 'node:fs'
import { open, stat, type FileHandle } from 'node:fs/promises'
import { extname } from 'node:path'
import type { ImagePreviewResult } from '../shared/types'

// The bytes go to the renderer as a data URL and are decoded there, never here.

export const MAX_PREVIEW_BYTES = 4 * 1024 * 1024
const MAX_AXIS = 4096
const MAX_PIXELS = 8_000_000
const JPEG_SCAN_BYTES = 64 * 1024
const READ_CHUNK = 64 * 1024
const MAX_TRACED_MESSAGES = 256
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

type Identity = { dev: bigint; ino: bigint; isFile(): boolean }

export interface PreviewHandle {
  stat(): Promise<Identity>
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  close(): Promise<void>
}

export interface ImagePreviewDeps {
  /** The canonical local path of a target inside a work dir, or the refusal. */
  resolveTarget(target: unknown): Promise<{ ok: true; path: string } | { ok: false; reason: string }>
  sandboxEnabled(): boolean
  fs: {
    open(path: string): Promise<PreviewHandle>
    stat(path: string): Promise<Identity>
  }
  reportError(scope: string, message: string, err?: unknown): void
}

export interface ImagePreviewService {
  preview(senderId: number, target: unknown): Promise<ImagePreviewResult>
}

/** A FIFO named x.png would hold open() until a writer shows up: without O_NONBLOCK the window stays busy, and fstat then refuses what was opened. */
export function nodePreviewFs(
  platform: NodeJS.Platform = process.platform,
  openFile: (path: string, flags: number) => Promise<FileHandle> = open
): ImagePreviewDeps['fs'] {
  const flags = platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NONBLOCK
  return {
    open: async (path) => {
      const handle = await openFile(path, flags)
      return {
        stat: () => handle.stat({ bigint: true }),
        read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
        close: () => handle.close()
      }
    },
    stat: (path) => stat(path, { bigint: true })
  }
}

type Header = { ok: true; mime: 'image/png' | 'image/jpeg'; width: number; height: number } | { ok: false; reason: string }

function pngHeader(bytes: Buffer): Header {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return { ok: false, reason: 'not a PNG' }
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    return { ok: false, reason: 'PNG without a leading IHDR' }
  }
  // Animation control precedes the first IDAT, so the chunks are walked up to it.
  for (let offset = 33; offset + 12 <= bytes.length; ) {
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    if (type === 'acTL') return { ok: false, reason: 'animated PNG' }
    if (type === 'IDAT') return { ok: true, mime: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    offset += 12 + bytes.readUInt32BE(offset)
  }
  return { ok: false, reason: 'PNG without image data' }
}

function jpegHeader(bytes: Buffer): Header {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    return { ok: false, reason: 'not a JPEG' }
  }
  const end = Math.min(bytes.length, JPEG_SCAN_BYTES)
  for (let i = 2; i + 4 <= end; ) {
    if (bytes[i] !== 0xff) return { ok: false, reason: 'JPEG marker expected' }
    const marker = bytes[i + 1]!
    if (marker === 0xff) {
      i++
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return { ok: false, reason: 'JPEG without a frame header' }
    if (JPEG_SOF.has(marker)) {
      if (i + 9 > end) break
      return { ok: true, mime: 'image/jpeg', height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) }
    }
    i += marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8) ? 2 : 2 + bytes.readUInt16BE(i + 2)
  }
  return { ok: false, reason: 'JPEG frame header not found' }
}

/** Format by extension AND signature, then dimensions by the header alone. */
export function readImageHeader(bytes: Buffer, path: string): Header {
  const extension = extname(path).toLowerCase()
  const header = extension === '.png' ? pngHeader(bytes) : extension === '.jpg' || extension === '.jpeg' ? jpegHeader(bytes) : null
  if (header === null) return { ok: false, reason: `unsupported extension ${extension}` }
  if (!header.ok) return header
  const { width, height } = header
  if (width < 1 || height < 1 || width > MAX_AXIS || height > MAX_AXIS || width * height > MAX_PIXELS) {
    return { ok: false, reason: `dimensions ${width}x${height} out of bounds` }
  }
  return header
}

const unavailable: ImagePreviewResult = { ok: false, reason: 'unavailable' }

/** The handler of the preview channel: only a genuine local event reaches the service. */
export function previewHandler(
  service: ImagePreviewService,
  isLocal: (event: unknown) => boolean
): (event: { sender?: { id?: unknown } }, target: unknown) => Promise<ImagePreviewResult> | ImagePreviewResult {
  return (event, target) => {
    const id = event.sender?.id
    return isLocal(event) && typeof id === 'number' ? service.preview(id, target) : unavailable
  }
}

export function createImagePreviewService(deps: ImagePreviewDeps): ImagePreviewService {
  const active = new Set<number>()

  // A hover repeats on the same file: each failure is traced once per cause, and the memory of it is bounded.
  const traced = new Set<string>()
  function trace(message: string, err?: unknown): void {
    const key = `${message}|${(err as NodeJS.ErrnoException | undefined)?.code ?? ''}`
    if (traced.has(key)) return
    if (traced.size >= MAX_TRACED_MESSAGES) traced.clear()
    traced.add(key)
    deps.reportError('image-preview', message, err)
  }

  async function readBounded(handle: PreviewHandle): Promise<Buffer | null> {
    const chunks: Buffer[] = []
    let total = 0
    while (total <= MAX_PREVIEW_BYTES) {
      const want = Math.min(READ_CHUNK, MAX_PREVIEW_BYTES + 1 - total)
      const chunk = Buffer.alloc(want)
      const { bytesRead } = await handle.read(chunk, 0, want, total)
      if (bytesRead === 0) break
      chunks.push(chunk.subarray(0, bytesRead))
      total += bytesRead
    }
    return total > MAX_PREVIEW_BYTES ? null : Buffer.concat(chunks)
  }

  async function load(target: unknown): Promise<ImagePreviewResult> {
    const resolved = await deps.resolveTarget(target)
    // The resolver traces what it refuses, once per path; a target outside the work dirs or absent is a policy answer, not a fault.
    if (!resolved.ok) return unavailable
    const { path } = resolved
    let handle: PreviewHandle
    try {
      handle = await deps.fs.open(path)
    } catch (e) {
      trace(`preview open failed: ${path.slice(0, 200)}`, e)
      return unavailable
    }
    try {
      const opened = await handle.stat()
      const named = await deps.fs.stat(path)
      if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) {
        trace(`preview file changed after opening: ${path.slice(0, 200)}`)
        return unavailable
      }
      const bytes = await readBounded(handle)
      if (bytes === null) {
        trace(`preview source over ${MAX_PREVIEW_BYTES} bytes: ${path.slice(0, 200)}`)
        return unavailable
      }
      const header = readImageHeader(bytes, path)
      if (!header.ok) {
        trace(`preview refused (${header.reason}): ${path.slice(0, 200)}`)
        return unavailable
      }
      return {
        ok: true,
        dataUrl: `data:${header.mime};base64,${bytes.toString('base64')}`,
        width: header.width,
        height: header.height
      }
    } catch (e) {
      trace(`preview read failed: ${path.slice(0, 200)}`, e)
      return unavailable
    } finally {
      await handle.close().catch((e: unknown) => deps.reportError('image-preview', 'preview close failed', e))
    }
  }

  async function preview(senderId: number, target: unknown): Promise<ImagePreviewResult> {
    if (deps.sandboxEnabled()) return unavailable
    if (active.has(senderId)) return { ok: false, reason: 'busy' }
    active.add(senderId)
    try {
      return await load(target)
    } finally {
      active.delete(senderId)
    }
  }

  return { preview }
}
