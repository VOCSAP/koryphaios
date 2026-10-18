export type CloseOutcome = 'exit' | 'interrupt' | 'sigterm' | 'modal' | 'forced' | 'deadline'

export interface GracefulCloseOpts {
  write: (data: string) => void
  isAlive: () => boolean
  kill: () => void
  delay: (ms: number) => Promise<void>
  exitGraceMs?: number
  interruptGraceMs?: number
  pollMs?: number
  isModal?: () => boolean
  isClosingForced?: () => boolean
  cleanup?: () => void
  absoluteDeadlineMs?: number
}

const EXIT = '/exit\n'
const ESC = '\x1b'
const CTRL_C = '\x03'

type WaitResult = 'dead' | 'alive' | 'forced'
async function waitOut(
  opts: Pick<GracefulCloseOpts, 'isAlive' | 'isClosingForced' | 'delay'>,
  budgetMs: number,
  pollMs: number
): Promise<WaitResult> {
  let elapsed = 0
  for (;;) {
    if (opts.isClosingForced?.()) return 'forced'
    if (!opts.isAlive()) return 'dead'
    if (elapsed >= budgetMs) return 'alive'
    const step = Math.min(pollMs, budgetMs - elapsed)
    await opts.delay(step)
    elapsed += step
  }
}

async function escalate(opts: GracefulCloseOpts): Promise<CloseOutcome> {
  const exitGraceMs = opts.exitGraceMs ?? 1500
  const interruptGraceMs = opts.interruptGraceMs ?? 1500
  const pollMs = opts.pollMs ?? 100

  if (!opts.isAlive()) return 'exit'

  const writeIfClear = (data: string): boolean => {
    if (opts.isModal?.()) {
      opts.kill()
      return false
    }
    opts.write(data)
    return true
  }

  if (!writeIfClear(EXIT)) return 'modal'
  let r = await waitOut(opts, exitGraceMs, pollMs)
  if (r === 'forced') {
    opts.kill()
    return 'forced'
  }
  if (r === 'dead') return 'exit'

  if (!writeIfClear(ESC)) return 'modal'
  if (!writeIfClear(CTRL_C)) return 'modal'
  if (!writeIfClear(EXIT)) return 'modal'
  r = await waitOut(opts, interruptGraceMs, pollMs)
  if (r === 'forced') {
    opts.kill()
    return 'forced'
  }
  if (r === 'dead') return 'interrupt'

  opts.kill()
  return 'sigterm'
}

export async function gracefulClose(opts: GracefulCloseOpts): Promise<CloseOutcome> {
  const run = async (): Promise<CloseOutcome> => {
    try {
      return await escalate(opts)
    } catch {
      opts.kill()
      return 'sigterm'
    } finally {
      opts.cleanup?.()
    }
  }

  if (opts.absoluteDeadlineMs === undefined) return run()

  return new Promise<CloseOutcome>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      opts.kill()
      opts.cleanup?.()
      resolve('deadline')
    }, opts.absoluteDeadlineMs)
    void run().then((outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    })
  })
}
