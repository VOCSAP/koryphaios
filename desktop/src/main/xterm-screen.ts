import headless from '@xterm/headless'

export type XtermScreenUnavailableReason =
  | 'disposed'
  | 'resize-pending'
  | 'screen-fault'
  | 'screen-pending'
  | 'sequence-incomplete'

export type XtermScreenSnapshot = {
  revision: number
  cols: number
  rows: number
  lines: string[]
  cursor: { x: number; y: number }
}

export type XtermScreenRead =
  | { state: 'ready'; snapshot: XtermScreenSnapshot }
  | { state: 'unavailable'; reason: XtermScreenUnavailableReason }

type TerminalOptions = {
  cols: number
  rows: number
  scrollback: number
  allowProposedApi: boolean
}

type BufferLine = {
  translateToString(trimRight?: boolean): string
}

type HeadlessTerminal = {
  write(data: string, callback?: () => void): void
  resize(cols: number, rows: number): void
  dispose(): void
  readonly buffer: {
    active: {
      baseY: number
      cursorX: number
      cursorY: number
      getLine(y: number): BufferLine | undefined
    }
  }
}

type BudgetOptions = {
  pendingCodeUnits: number
  pendingChunks: number
  unsettledCodeUnits: number
  cells: number
}

export type XtermScreenOptions = {
  cols: number
  rows: number
  reportError(scope: string, message: string, error?: unknown): void
  budgets?: Partial<BudgetOptions>
  terminalFactory?: (options: TerminalOptions) => HeadlessTerminal
}

export type XtermScreen = {
  feed(data: string): void
  resize(cols: number, rows: number): void
  read(): XtermScreenRead
  drain(): Promise<void>
  dispose(): void
}

const DEFAULT_BUDGETS: BudgetOptions = {
  pendingCodeUnits: 1024 * 1024,
  pendingChunks: 4096,
  unsettledCodeUnits: 1024 * 1024,
  cells: 1024 * 1024
}

const validPositiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0

const resolveBudgets = (overrides: Partial<BudgetOptions> | undefined): BudgetOptions => {
  const budgets = { ...DEFAULT_BUDGETS, ...overrides }
  for (const value of Object.values(budgets)) {
    if (!validPositiveInteger(value)) throw new RangeError('xterm screen budget must be a positive safe integer')
  }
  return budgets
}

const assertDimensions = (cols: number, rows: number, cells: number): void => {
  if (!validPositiveInteger(cols) || !validPositiveInteger(rows) || cols * rows > cells) {
    throw new RangeError('xterm screen dimensions exceed the configured limit')
  }
}

export function createXtermScreen(options: XtermScreenOptions): XtermScreen {
  const budgets = resolveBudgets(options.budgets)
  assertDimensions(options.cols, options.rows, budgets.cells)

  let cols = options.cols
  let rows = options.rows
  let terminal: HeadlessTerminal | null = null
  let submitted = 0
  let applied = 0
  let pendingCodeUnits = 0
  let pendingChunks = 0
  let unsettledCodeUnits = 0
  let resizeSubmitted: number | null = null
  let disposed = false
  let faulted = false
  let cache: XtermScreenSnapshot | null = null
  const drainWaiters: Array<() => void> = []

  const settleDrain = (): void => {
    if (pendingChunks !== 0) return
    for (const resolve of drainWaiters.splice(0)) resolve()
  }

  const abandonPending = (): void => {
    const owner = terminal
    terminal = null
    pendingCodeUnits = 0
    pendingChunks = 0
    unsettledCodeUnits = 0
    settleDrain()
    try {
      owner?.dispose()
    } catch (error) {
      options.reportError('screen', 'xterm screen dispose failed', error)
    }
  }

  const fault = (message: string, error?: unknown): void => {
    if (faulted || disposed) return
    faulted = true
    cache = null
    options.reportError('screen', message, error)
    abandonPending()
  }

  const terminalOptions = (): TerminalOptions => ({ cols, rows, scrollback: 0, allowProposedApi: true })
  try {
    terminal = options.terminalFactory?.(terminalOptions()) ?? new headless.Terminal(terminalOptions())
  } catch (error) {
    fault('failed to create the xterm screen', error)
  }

  const parserIsAtRest = (): boolean | null => {
    if (!terminal) return null
    const inputHandler = (terminal as unknown as {
      _core?: {
        _inputHandler?: {
          _parser?: { currentState?: unknown }
          _stringDecoder?: { _interim?: unknown }
        }
      }
    })._core?._inputHandler
    const parserState = inputHandler?._parser?.currentState
    const decoderInterim = inputHandler?._stringDecoder?._interim
    if (!Number.isSafeInteger(parserState) || !Number.isSafeInteger(decoderInterim)) {
      fault('xterm private parser state has an unsupported shape')
      return null
    }
    return parserState === 0 && decoderInterim === 0
  }

  const snapshot = (): XtermScreenSnapshot | null => {
    if (!terminal) return null
    const active = terminal.buffer.active
    if (!Number.isSafeInteger(active.baseY) || !Number.isSafeInteger(active.cursorX) || !Number.isSafeInteger(active.cursorY)) {
      fault('xterm active buffer has an unsupported shape')
      return null
    }
    const lines: string[] = []
    for (let y = 0; y < rows; y++) {
      const line = active.getLine(active.baseY + y)
      if (!line) {
        fault('xterm active buffer line is unavailable')
        return null
      }
      lines.push(line.translateToString(true))
    }
    return { revision: submitted, cols, rows, lines, cursor: { x: active.cursorX, y: active.cursorY } }
  }

  const feed = (data: string): void => {
    if (disposed || faulted || data.length === 0) return
    if (
      data.length > budgets.pendingCodeUnits ||
      pendingCodeUnits + data.length > budgets.pendingCodeUnits ||
      pendingChunks + 1 > budgets.pendingChunks ||
      unsettledCodeUnits + data.length > budgets.unsettledCodeUnits
    ) {
      fault('xterm screen input budget exceeded')
      return
    }

    const owner = terminal
    if (!owner) {
      fault('xterm screen is unavailable')
      return
    }
    cache = null
    submitted++
    pendingChunks++
    pendingCodeUnits += data.length
    unsettledCodeUnits += data.length
    try {
      owner.write(data, () => {
        try {
          if (disposed || terminal !== owner || faulted) return
          applied++
          pendingChunks--
          pendingCodeUnits -= data.length
          if (parserIsAtRest()) unsettledCodeUnits = 0
          settleDrain()
        } catch (error) {
          fault('xterm screen callback failed', error)
        }
      })
    } catch (error) {
      fault('xterm screen write failed', error)
    }
  }

  const resize = (nextCols: number, nextRows: number): void => {
    if (disposed || faulted || (nextCols === cols && nextRows === rows)) return
    try {
      assertDimensions(nextCols, nextRows, budgets.cells)
      const owner = terminal
      if (!owner) {
        fault('xterm screen is unavailable')
        return
      }
      cache = null
      resizeSubmitted = submitted
      cols = nextCols
      rows = nextRows
      owner.resize(cols, rows)
    } catch (error) {
      fault('xterm screen resize failed', error)
    }
  }

  const read = (): XtermScreenRead => {
    try {
      if (disposed) return { state: 'unavailable', reason: 'disposed' }
      if (faulted || !terminal) return { state: 'unavailable', reason: 'screen-fault' }
      if (pendingChunks !== 0 || applied !== submitted) return { state: 'unavailable', reason: 'screen-pending' }
      if (resizeSubmitted !== null && submitted <= resizeSubmitted) return { state: 'unavailable', reason: 'resize-pending' }
      const atRest = parserIsAtRest()
      if (atRest === null) return { state: 'unavailable', reason: 'screen-fault' }
      if (!atRest) return { state: 'unavailable', reason: 'sequence-incomplete' }
      if (resizeSubmitted !== null) resizeSubmitted = null
      cache ??= snapshot()
      return cache ? { state: 'ready', snapshot: cache } : { state: 'unavailable', reason: 'screen-fault' }
    } catch (error) {
      fault('xterm screen read failed', error)
      return { state: 'unavailable', reason: 'screen-fault' }
    }
  }

  const drain = (): Promise<void> => {
    if (pendingChunks === 0 || disposed || faulted) return Promise.resolve()
    return new Promise((resolve) => drainWaiters.push(resolve))
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    cache = null
    abandonPending()
  }

  return { feed, resize, read, drain, dispose }
}
