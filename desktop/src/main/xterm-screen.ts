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
  | { status: 'ready'; snapshot: XtermScreenSnapshot }
  | { status: 'unavailable'; reason: XtermScreenUnavailableReason }

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
  reservePending?(codeUnits: number, chunks: number): boolean
  releasePending?(codeUnits: number, chunks: number): void
}

export type ScreenGuardOptions = {
  globalBudgets?: { pendingCodeUnits?: number; pendingChunks?: number }
  screenOptions?: Pick<XtermScreenOptions, 'budgets' | 'terminalFactory'>
}

export type XtermScreen = {
  feed(data: string): void
  resize(cols: number, rows: number): void
  read(): XtermScreenRead
  drain(): Promise<void>
  invalidate(message: string, error?: unknown): void
  dispose(): void
}

export type InjectGuardState = 'clear' | 'modal'
export type InjectGuardRule = 'empty-grid' | 'picker' | 'dialog' | 'composer-geometry'
export type InjectGuardInspection =
  | { state: 'clear' }
  | { state: 'modal'; rule: InjectGuardRule; line?: number }

const DEFAULT_BUDGETS: BudgetOptions = {
  pendingCodeUnits: 1024 * 1024,
  pendingChunks: 4096,
  unsettledCodeUnits: 1024 * 1024,
  cells: 1024 * 1024
}

const DEFAULT_GLOBAL_BUDGETS = {
  pendingCodeUnits: 8 * 1024 * 1024,
  pendingChunks: 8 * 4096
}

const validPositiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0

const resolveBudgets = (overrides: Partial<BudgetOptions> | undefined): BudgetOptions => {
  const budgets = { ...DEFAULT_BUDGETS, ...overrides }
  for (const value of Object.values(budgets)) {
    if (!validPositiveInteger(value)) throw new RangeError('xterm screen budget must be a positive safe integer')
  }
  return budgets
}

const resolveGlobalBudgets = (overrides: ScreenGuardOptions['globalBudgets']) => {
  const budgets = { ...DEFAULT_GLOBAL_BUDGETS, ...overrides }
  if (!validPositiveInteger(budgets.pendingCodeUnits) || !validPositiveInteger(budgets.pendingChunks)) {
    throw new RangeError('xterm screen global budget must be a positive safe integer')
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
    const releasedCodeUnits = pendingCodeUnits
    const releasedChunks = pendingChunks
    terminal = null
    pendingCodeUnits = 0
    pendingChunks = 0
    unsettledCodeUnits = 0
    options.releasePending?.(releasedCodeUnits, releasedChunks)
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
      lines.push(line.translateToString(true).replace(/\s+$/, ''))
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
    if (options.reservePending && !options.reservePending(data.length, 1)) {
      fault('xterm screen global input budget exceeded')
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
          options.releasePending?.(data.length, 1)
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
      if (disposed) return { status: 'unavailable', reason: 'disposed' }
      if (faulted || !terminal) return { status: 'unavailable', reason: 'screen-fault' }
      if (pendingChunks !== 0 || applied !== submitted) return { status: 'unavailable', reason: 'screen-pending' }
      if (resizeSubmitted !== null && submitted <= resizeSubmitted) return { status: 'unavailable', reason: 'resize-pending' }
      const atRest = parserIsAtRest()
      if (atRest === null) return { status: 'unavailable', reason: 'screen-fault' }
      if (!atRest) return { status: 'unavailable', reason: 'sequence-incomplete' }
      if (resizeSubmitted !== null) resizeSubmitted = null
      cache ??= snapshot()
      return cache ? { status: 'ready', snapshot: cache } : { status: 'unavailable', reason: 'screen-fault' }
    } catch (error) {
      fault('xterm screen read failed', error)
      return { status: 'unavailable', reason: 'screen-fault' }
    }
  }

  const drain = (): Promise<void> => {
    if (pendingChunks === 0 || disposed || faulted) return Promise.resolve()
    return new Promise((resolve) => drainWaiters.push(resolve))
  }

  const invalidate = (message: string, error?: unknown): void => {
    fault(message, error)
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    cache = null
    abandonPending()
  }

  return { feed, resize, read, drain, invalidate, dispose }
}

export function inspectInjectGuard(snapshot: XtermScreenSnapshot): InjectGuardInspection {
  const horizontal = String.fromCodePoint(0x2500)
  const chevron = String.fromCodePoint(0x276f)
  const dialogTopLeft = String.fromCodePoint(0x256d)
  const dialogTopRight = String.fromCodePoint(0x256e)
  const dialogBottomLeft = String.fromCodePoint(0x2570)
  const dialogBottomRight = String.fromCodePoint(0x256f)
  const { lines, cols, cursor } = snapshot
  const isPureBorder = (line: string): boolean => [...line].length === cols && [...line].every((character) => character === horizontal)
  const isTopBorder = (line: string): boolean => {
    if ([...line].length !== cols) return false
    const labelStart = line.indexOf(' ')
    if (labelStart < 0) return isPureBorder(line)
    const labelEnd = line.lastIndexOf(' ')
    const beforeLabel = line.slice(0, labelStart)
    const label = line.slice(labelStart + 1, labelEnd)
    const afterLabel = line.slice(labelEnd + 1)
    return (
      beforeLabel.length > 0 &&
      afterLabel.length > 0 &&
      label.length > 0 &&
      label.trim() === label &&
      !label.includes(horizontal) &&
      [...beforeLabel].every((character) => character === horizontal) &&
      [...afterLabel].every((character) => character === horizontal)
    )
  }
  const isPicker = (line: string): boolean => new RegExp(`^\\s*${chevron}\\s+\\d+\\.`).test(line)
  const isDialogTop = (line: string): boolean => line.trimStart().startsWith(dialogTopLeft) && line.trimEnd().endsWith(dialogTopRight)
  const isDialogBottom = (line: string): boolean =>
    line.trimStart().startsWith(dialogBottomLeft) && line.trimEnd().endsWith(dialogBottomRight)

  if (lines.every((line) => line.length === 0)) return { state: 'modal', rule: 'empty-grid' }

  const pickerLine = lines.findIndex(isPicker)
  if (pickerLine >= 0) return { state: 'modal', rule: 'picker', line: pickerLine + 1 }

  const dialogTopLine = lines.findIndex(isDialogTop)
  if (dialogTopLine >= 0 && lines.some(isDialogBottom)) return { state: 'modal', rule: 'dialog', line: dialogTopLine + 1 }

  const top = lines[cursor.y - 1]
  const composer = lines[cursor.y]
  const bottom = lines[cursor.y + 1]
  if (
    top !== undefined &&
    composer !== undefined &&
    bottom !== undefined &&
    isTopBorder(top) &&
    composer.trimStart().startsWith(chevron) &&
    isPureBorder(bottom)
  ) {
    return { state: 'clear' }
  }

  return { state: 'modal', rule: 'composer-geometry', line: cursor.y + 1 }
}

export function classifyInjectGuard(snapshot: XtermScreenSnapshot): InjectGuardState {
  return inspectInjectGuard(snapshot).state
}

export class ScreenGuard {
  private screens = new Map<string, XtermScreen>()
  private pendingCodeUnits = 0
  private pendingChunks = 0
  private readonly globalBudgets
  private readonly screenOptions

  constructor(
    private readonly reportError: XtermScreenOptions['reportError'],
    options: ScreenGuardOptions = {}
  ) {
    this.globalBudgets = resolveGlobalBudgets(options.globalBudgets)
    this.screenOptions = options.screenOptions
  }

  start(id: string, cols: number, rows: number): void {
    this.clear(id)
    this.screens.set(
      id,
      createXtermScreen({
        cols,
        rows,
        reportError: this.reportError,
        ...this.screenOptions,
        reservePending: (codeUnits, chunks) => this.reservePending(codeUnits, chunks),
        releasePending: (codeUnits, chunks) => this.releasePending(codeUnits, chunks)
      })
    )
  }

  feed(id: string, data: string): void {
    this.screens.get(id)?.feed(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.screens.get(id)?.resize(cols, rows)
  }

  invalidate(id: string, message: string, error?: unknown): void {
    this.screens.get(id)?.invalidate(message, error)
  }

  private reservePending(codeUnits: number, chunks: number): boolean {
    if (
      this.pendingCodeUnits + codeUnits > this.globalBudgets.pendingCodeUnits ||
      this.pendingChunks + chunks > this.globalBudgets.pendingChunks
    ) {
      return false
    }
    this.pendingCodeUnits += codeUnits
    this.pendingChunks += chunks
    return true
  }

  private releasePending(codeUnits: number, chunks: number): void {
    this.pendingCodeUnits -= codeUnits
    this.pendingChunks -= chunks
  }

  read(id: string): XtermScreenRead {
    return this.screens.get(id)?.read() ?? { status: 'unavailable', reason: 'disposed' }
  }

  clear(id: string): void {
    const screen = this.screens.get(id)
    this.screens.delete(id)
    screen?.dispose()
  }

  stop(): void {
    for (const screen of this.screens.values()) screen.dispose()
    this.screens.clear()
  }
}
