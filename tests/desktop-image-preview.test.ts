import { describe, expect, test } from 'bun:test'
import { constants, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reachedWithin } from './_bounded-await'
import {
  createImagePreviewService,
  MAX_PREVIEW_BYTES,
  nodePreviewFs,
  previewHandler,
  readImageHeader,
  type ImagePreviewDeps,
  type ImagePreviewService,
  type PreviewHandle
} from '../desktop/src/main/image-preview-service'

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  return out
}

function png(width = 1, height = 1, opts: { apng?: boolean; noData?: boolean } = {}): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const parts = [SIGNATURE, chunk('IHDR', ihdr)]
  if (opts.apng) parts.push(chunk('acTL', Buffer.alloc(8)))
  if (!opts.noData) parts.push(chunk('IDAT', Buffer.alloc(4)))
  parts.push(chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(parts)
}

function jpeg(width: number, height: number, opts: { sofAfter?: number } = {}): Buffer {
  const sof = Buffer.alloc(19)
  sof.writeUInt16BE(0xffc0, 0)
  sof.writeUInt16BE(17, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  sof[9] = 3
  const body = opts.sofAfter
    ? Buffer.concat([Buffer.from([0xff, 0xfe]), u16(opts.sofAfter + 2), Buffer.alloc(opts.sofAfter)])
    : Buffer.alloc(0)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), body, sof, Buffer.from([0xff, 0xd9])])
}

const u16 = (n: number): Buffer => {
  const out = Buffer.alloc(2)
  out.writeUInt16BE(n, 0)
  return out
}

interface Calls {
  resolve: number
  opens: string[]
  closes: number
  reads: number
  requested: number
  reports: string[]
}

function harness(
  source: Buffer | ((position: number, length: number) => Buffer),
  opts: {
    path?: string
    sandbox?: boolean
    hold?: boolean
    mismatch?: boolean
    notFile?: boolean
    refusal?: string
    openFails?: boolean
    /** Read at every open: the code of the error thrown, changed between two hovers. */
    openError?: { code: string }
  } = {}
): { service: ReturnType<typeof createImagePreviewService>; calls: Calls; release: () => void } {
  const calls: Calls = { resolve: 0, opens: [], closes: 0, reads: 0, requested: 0, reports: [] }
  let release: () => void = () => {}
  const held = opts.hold ? new Promise<void>((resolve) => (release = resolve)) : undefined
  const handle: PreviewHandle = {
    stat: async () => ({ dev: 1n, ino: 2n, isFile: () => !opts.notFile }),
    read: async (buffer, offset, length, position) => {
      await held
      calls.reads++
      calls.requested += length
      const bytes = typeof source === 'function' ? source(position, length) : source.subarray(position, position + length)
      bytes.copy(buffer, offset)
      return { bytesRead: bytes.length }
    },
    close: async () => void calls.closes++
  }
  const deps: ImagePreviewDeps = {
    resolveTarget: async (target) => {
      calls.resolve++
      return opts.refusal ? { ok: false, reason: opts.refusal } : { ok: true, path: opts.path ?? String(target) }
    },
    sandboxEnabled: () => opts.sandbox ?? false,
    fs: {
      open: async (entry) => {
        calls.opens.push(entry)
        if (opts.openFails) throw new Error('EACCES')
        if (opts.openError) throw Object.assign(new Error(opts.openError.code), { code: opts.openError.code })
        return handle
      },
      stat: async () => ({ dev: opts.mismatch ? 3n : 1n, ino: 2n, isFile: () => true })
    },
    reportError: (_scope, message) => void calls.reports.push(message)
  }
  return { service: createImagePreviewService(deps), calls, release: () => release() }
}

test('a PNG becomes a data URL carrying the dimensions of its header', async () => {
  const bytes = png(320, 240)
  const { service, calls } = harness(bytes)

  expect(await service.preview(1, '/work/picture.png')).toEqual({
    ok: true,
    dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
    width: 320,
    height: 240
  })
  expect(calls).toMatchObject({ resolve: 1, opens: ['/work/picture.png'], closes: 1, reports: [] })
})

test('a JPEG is read through its frame header, found after a comment segment', async () => {
  const bytes = jpeg(640, 480, { sofAfter: 300 })
  const { service } = harness(bytes, { path: '/work/photo.JPEG' })

  expect(await service.preview(1, '/work/photo.JPEG')).toEqual({
    ok: true,
    dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`,
    width: 640,
    height: 480
  })
})

test.each([
  ['an APNG', png(1, 1, { apng: true }), '/work/a.png'],
  ['a PNG cut before its image data', png(1, 1, { noData: true }), '/work/a.png'],
  ['a PNG whose bytes are a JPEG', jpeg(8, 8), '/work/a.png'],
  ['a JPEG whose bytes are a PNG', png(), '/work/a.jpg'],
  ['a file with another extension', png(), '/work/a.gif'],
  ['a PNG wider than 4096', png(4097, 10), '/work/a.png'],
  ['a PNG taller than 4096', png(10, 4097), '/work/a.png'],
  ['a PNG over 8 megapixels', png(4096, 4096), '/work/a.png'],
  ['a PNG with a zero axis', png(0, 10), '/work/a.png'],
  ['a JPEG over 4096 on one axis', jpeg(5000, 10), '/work/a.jpg'],
  ['a truncated JPEG', jpeg(8, 8).subarray(0, 6), '/work/a.jpg']
])('%s is unavailable, traced, and its descriptor is closed', async (_name, bytes, path) => {
  const { service, calls } = harness(bytes, { path })

  expect(await service.preview(1, path)).toEqual({ ok: false, reason: 'unavailable' })
  expect(calls.closes).toBe(1)
  expect(calls.reports).toHaveLength(1)
})

test('a valid PNG one byte over the limit is refused for its size, not for its header', async () => {
  const head = png(10, 10)
  const { service, calls } = harness(Buffer.concat([head, Buffer.alloc(MAX_PREVIEW_BYTES + 1 - head.length)]))

  expect(await service.preview(1, '/work/a.png')).toEqual({ ok: false, reason: 'unavailable' })
  expect(calls.reports[0]).toContain('over')
})

test('a signature damaged on an otherwise valid PNG or JPEG is refused', async () => {
  const damagedPng = png(10, 10)
  damagedPng[0] = 0
  const damagedJpeg = jpeg(10, 10)
  damagedJpeg[0] = 0
  for (const [bytes, path] of [
    [damagedPng, '/work/a.png'],
    [damagedJpeg, '/work/a.jpg']
  ] as const) {
    const { service } = harness(bytes, { path })
    expect(await service.preview(1, path), path).toEqual({ ok: false, reason: 'unavailable' })
  }
})

test('the pixel cap accepts 8 000 000 pixels and refuses one row more', () => {
  expect(readImageHeader(png(4000, 2000), '/a.png')).toMatchObject({ ok: true, width: 4000, height: 2000 })
  expect(readImageHeader(png(4096, 1953), '/a.png')).toMatchObject({ ok: true })
  expect(readImageHeader(png(4096, 1954), '/a.png')).toMatchObject({ ok: false })
})

test('a file that keeps growing is cut at one byte over the limit and never returned', async () => {
  const { service, calls } = harness(
    (position, length) => {
      if (position > MAX_PREVIEW_BYTES) throw new Error('read past the limit')
      return Buffer.alloc(length, 1)
    },
    { path: '/work/a.png' }
  )

  expect(await service.preview(1, '/work/a.png')).toEqual({ ok: false, reason: 'unavailable' })
  expect(calls.requested, 'the read stops at MAX + 1 bytes however long the file is').toBe(MAX_PREVIEW_BYTES + 1)
  expect(calls.reports[0], 'refused for its size, not because a read blew up').toContain('over')
  expect(calls.closes).toBe(1)
})

test('a file of exactly the limit is accepted when its header is valid', async () => {
  const head = png(10, 10)
  const bytes = Buffer.concat([head, Buffer.alloc(MAX_PREVIEW_BYTES - head.length)])
  const { service } = harness(bytes)

  expect(await service.preview(1, '/work/a.png')).toMatchObject({ ok: true, width: 10, height: 10 })
})

test('a sandbox project is unavailable before target resolution or any file access', async () => {
  const { service, calls } = harness(png(), { sandbox: true })

  expect(await service.preview(1, '/work/picture.png')).toEqual({ ok: false, reason: 'unavailable' })
  expect(calls).toMatchObject({ resolve: 0, opens: [], reads: 0, reports: [] })
})

test('a refusal from the target guards opens nothing and adds no trace of its own: the resolver traces what it refuses', async () => {
  for (const refusal of ['not-allowed', 'not-found', 'network-path', 'failed', 'invalid']) {
    const { service, calls } = harness(png(), { refusal })
    expect(await service.preview(1, '/outside/a.png')).toEqual({ ok: false, reason: 'unavailable' })
    expect(calls.opens, refusal).toEqual([])
    expect(calls.reports, refusal).toEqual([])
  }
})

test.each([
  ['an open that fails', { openFails: true }, png(), '/work/a.png'],
  ['a descriptor that is not a regular file', { notFile: true }, png(), '/work/a.png'],
  ['a path that names another file than the descriptor', { mismatch: true }, png(), '/work/a.png'],
  ['a source over the limit', {}, Buffer.alloc(MAX_PREVIEW_BYTES + 1), '/work/a.png'],
  ['a refused header', {}, png(1, 1, { apng: true }), '/work/a.png']
] as const)('%s is traced once however often the file is hovered', async (_name, opts, bytes, path) => {
  const { service, calls } = harness(bytes as Buffer, { ...opts, path })
  for (let i = 0; i < 3; i++) expect(await service.preview(1, path)).toEqual({ ok: false, reason: 'unavailable' })
  expect(calls.reports).toHaveLength(1)
})

test('each file is traced on its own: two files failing to open give two traces', async () => {
  const { service, calls } = harness(png(), { openFails: true })
  await service.preview(1, '/work/a.png')
  await service.preview(1, '/work/b.png')
  expect(calls.reports).toHaveLength(2)
})

test('a new cause on the same file is traced, the same cause again is not', async () => {
  const openError = { code: 'EACCES' }
  const { service, calls } = harness(png(), { openError })
  for (const code of ['EACCES', 'EACCES', 'EMFILE', 'EIO', 'EIO']) {
    openError.code = code
    await service.preview(1, '/work/a.png')
  }
  expect(calls.reports).toHaveLength(3)
  expect(calls.reports.map((m) => m.includes('/work/a.png'))).toEqual([true, true, true])
})

test('the memory of traced failures is bounded: a file hovered long ago is traced again', async () => {
  const { service, calls } = harness(png(), { openFails: true })
  for (let i = 0; i < 300; i++) await service.preview(1, `/work/f${i}.png`)
  await service.preview(1, '/work/f0.png')
  expect(calls.reports).toHaveLength(301)
})

async function flagsOf(platform: NodeJS.Platform): Promise<number> {
  let flags = -1
  const handle = { stat: async () => ({}), read: async () => ({ bytesRead: 0 }), close: async () => {} }
  await nodePreviewFs(platform, async (_path, given) => ((flags = given), handle as never)).open('/a.png')
  return flags
}

test('the production adapter opens read-only, and on Windows with no flag beyond that', async () => {
  expect(await flagsOf('win32')).toBe(constants.O_RDONLY)
  expect((await flagsOf('linux')) & (constants.O_WRONLY | constants.O_RDWR), 'never writable').toBe(0)
})

// O_NONBLOCK is undefined in Node's constants on Windows, so the flag itself can only be observed elsewhere.
test.skipIf(process.platform === 'win32')('off Windows the adapter opens with O_NONBLOCK, which a FIFO would otherwise turn into a hang', async () => {
  for (const platform of ['linux', 'darwin'] as const) {
    expect((await flagsOf(platform)) & constants.O_NONBLOCK, platform).toBe(constants.O_NONBLOCK)
  }
})

test.skipIf(process.platform === 'win32')('a FIFO named x.png is refused without blocking, and the window takes the next preview', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kory-fifo-'))
  try {
    const fifo = join(dir, 'x.png')
    expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0)
    const real = join(dir, 'real.png')
    writeFileSync(real, png(3, 3))
    const reported: string[] = []
    const service = createImagePreviewService({
      resolveTarget: async (target) => ({ ok: true, path: String(target) }),
      sandboxEnabled: () => false,
      fs: nodePreviewFs(),
      reportError: (_scope, message) => void reported.push(message)
    })
    expect(await reachedWithin(service.preview(1, fifo), 'the preview of a FIFO', 3000)).toEqual({ ok: false, reason: 'unavailable' })
    expect(await reachedWithin(service.preview(1, real), 'the next preview of the window', 3000)).toMatchObject({ ok: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('previewHandler', () => {
  const recorder = (): { service: ImagePreviewService; asked: [number, unknown][] } => {
    const asked: [number, unknown][] = []
    return { asked, service: { preview: async (id, target) => (asked.push([id, target]), { ok: true, dataUrl: 'd', width: 1, height: 1 }) } }
  }

  test('a local event reaches the service with the id of its sender', async () => {
    const { service, asked } = recorder()
    expect(await previewHandler(service, () => true)({ sender: { id: 7 } }, '/a.png')).toMatchObject({ ok: true })
    expect(asked).toEqual([[7, '/a.png']])
  })

  test('an event the predicate does not call local, or one without a numeric sender id, is refused and never reaches the service', async () => {
    const { service, asked } = recorder()
    expect(await previewHandler(service, () => false)({ sender: { id: 7 } }, '/a.png')).toEqual({ ok: false, reason: 'unavailable' })
    expect(await previewHandler(service, () => true)({ sender: {} }, '/a.png')).toEqual({ ok: false, reason: 'unavailable' })
    expect(await previewHandler(service, () => true)({}, '/a.png')).toEqual({ ok: false, reason: 'unavailable' })
    expect(asked).toEqual([])
  })
})

test('a path that names another file than the descriptor is unavailable and traced', async () => {
  const { service, calls } = harness(png(), { mismatch: true })

  expect(await service.preview(1, '/work/picture.png')).toEqual({ ok: false, reason: 'unavailable' })
  expect(calls.reads, 'nothing is read from a descriptor that is not the checked file').toBe(0)
  expect(calls.closes).toBe(1)
  expect(calls.reports[0]).toContain('changed after opening')
})

test('a descriptor that is not a regular file is unavailable, closed, and never read', async () => {
  const { service, calls } = harness(png(), { notFile: true })

  expect(await service.preview(1, '/work/picture.png')).toEqual({ ok: false, reason: 'unavailable' })
  expect(calls.reads, 'a directory, a FIFO or a device is not read').toBe(0)
  expect(calls.closes).toBe(1)
  expect(calls.reports).toHaveLength(1)
})

test('an open that fails is traced with its path and answered as unavailable', async () => {
  const { service, calls } = harness(png(), { openFails: true })

  expect(await service.preview(1, '/work/picture.png')).toEqual({ ok: false, reason: 'unavailable' })
  expect(calls.reports[0]).toContain('/work/picture.png')
})

test('the production adapter reads a real file: its descriptor and its path name the same file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kory-preview-'))
  try {
    const path = join(dir, 'real.png')
    writeFileSync(path, png(12, 7))
    const reported: string[] = []
    const service = createImagePreviewService({
      resolveTarget: async () => ({ ok: true, path }),
      sandboxEnabled: () => false,
      fs: nodePreviewFs(),
      reportError: (_scope, message) => void reported.push(message)
    })

    expect(await service.preview(1, path)).toMatchObject({ ok: true, width: 12, height: 7 })
    expect(reported).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a second preview from the same webContents is busy while the first is read, another webContents is not', async () => {
  const { service, release } = harness(png(), { hold: true })
  const first = service.preview(1, '/work/first.png')

  expect(await reachedWithin(service.preview(1, '/work/second.png'), 'the second preview of a busy webContents', 1000)).toEqual({
    ok: false,
    reason: 'busy'
  })
  const other = service.preview(2, '/work/third.png')
  release()
  expect(await first).toMatchObject({ ok: true })
  expect(await other).toMatchObject({ ok: true })
  expect(await service.preview(1, '/work/fourth.png'), 'the slot is free again once the read ended').toMatchObject({ ok: true })
})
