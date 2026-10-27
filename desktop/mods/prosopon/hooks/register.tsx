import type { EngineInterface, Register, RenderViewport } from 'claude-code'

import {
  classifyAssistantBlock,
  GUARD_SAFE_BORDER,
  isRenderableText,
  MIN_FRAME_COLUMNS,
  resolveFrameConfiguration,
  SHORT_NOTE_BULLET,
  turnRule,
} from './layout'
import { computeRuns, type Run, runSummary, toolUseIds } from './runs'
import { isSupported } from './versions'

type Sized = { surface: string; viewport?: RenderViewport }

function columnsOf(e: Sized): number {
  return e.viewport?.columns ?? 80
}

function wideEnough(e: Sized): boolean {
  const columns = columnsOf(e)
  return Number.isFinite(columns) && columns >= MIN_FRAME_COLUMNS
}

function stockAfter($: EngineInterface, error: unknown): void {
  $.ui.log(`prosopon: stock render after ${String(error)}`, { to: 'debug' })
}

async function layoutSupported($: EngineInterface): Promise<boolean> {
  try {
    const version = await $.session.version()
    return isSupported(version.base, 'layout')
  } catch (error) {
    stockAfter($, error)
    return false
  }
}

function frame(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0],
  title: string,
  color: string,
  body: unknown,
) {
  const { Box, Text } = $.ui.resolve(e)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="column" borderStyle={GUARD_SAFE_BORDER} borderColor={color} paddingX={1}>
        {body as never}
      </Box>
      <Box position="absolute" top={0} left={2} right={2}>
        <Text color={color} bold wrap="truncate-end">
          {` ${title} `}
        </Text>
      </Box>
    </Box>
  )
}

const MAX_TOOL_HEADER_ARGUMENT_LENGTH = 300
const MAX_TOOL_HEADER_CONTINUATIONS = 4

type ToolHeader = { title: string; detail: string }

// The collapsed native row of each tool: its title, then the one input field it shows. Skill hides
// its args, WebFetch its prompt and WebSearch its domain filters there.
const ARGUMENT_TOOL_HEADERS = new Map([
  ['Bash', { title: 'Bash', field: 'command', quote: '' }],
  ['Skill', { title: 'Skill', field: 'skill', quote: '' }],
  ['WebFetch', { title: 'Fetch', field: 'url', quote: '' }],
  ['WebSearch', { title: 'Web Search', field: 'query', quote: '"' }],
  ['Agent', { title: 'Agent', field: 'description', quote: '' }],
])

function hasSafeToolHeaderArgument(value: string): boolean {
  if (value.length === 0) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code > 0x7e) return false
  }
  return true
}

function toolHeader(tool: string, input: unknown): ToolHeader | undefined {
  const shape = ARGUMENT_TOOL_HEADERS.get(tool)
  if (shape === undefined || typeof input !== 'object' || input === null) return undefined
  const fields = input as Record<string, unknown>
  // A typed agent is titled with its type, and agents launched together share one group row.
  if (tool === 'Agent') {
    const agentType = fields.subagent_type
    if (agentType !== undefined && agentType !== 'general-purpose') return undefined
  }
  const value = fields[shape.field]
  if (typeof value !== 'string' || value.length > MAX_TOOL_HEADER_ARGUMENT_LENGTH || !hasSafeToolHeaderArgument(value)) {
    return undefined
  }
  // The native Skill row drops a leading slash from the name.
  if (tool === 'Skill' && value.startsWith('/')) return undefined
  return { title: shape.title, detail: `(${shape.quote}${value}${shape.quote})` }
}

const MAX_FILE_TOOL_PATH_LENGTH = 40
const FILE_TOOL_TITLES = new Map([
  ['Edit', 'Update'],
  ['Write', 'Write'],
])

// The native header shows a file under the session directory relative to it, normalized and with
// the platform separator, and any other file as given. Only a path that needs no normalization is
// rebuilt here; every other one, and a drive letter cased differently, is left to next(e).
function relativeToolPath(filePath: string, cwd: string): string | undefined {
  const windows = /^[A-Za-z]:[\\/]/.test(cwd)
  if (!windows && !cwd.startsWith('/')) return undefined
  if (filePath.length > cwd.length + 1 + MAX_FILE_TOOL_PATH_LENGTH) return undefined
  const separators = windows ? /[\\/]/ : /\//
  const base = cwd.split(separators)
  if (base.at(-1) === '') base.pop()
  const parts = filePath.split(separators)
  if (parts.length <= base.length || base.some((segment, index) => parts[index] !== segment)) return undefined
  const rest = parts.slice(base.length)
  if (rest.some(segment => segment === '' || segment === '.' || segment === '..')) return undefined
  const relative = rest.join(windows ? '\\' : '/')
  return relative.length <= MAX_FILE_TOOL_PATH_LENGTH && hasSafeToolHeaderArgument(relative) ? relative : undefined
}

async function fileToolHeader(
  $: EngineInterface,
  title: string,
  input: unknown,
  columns: number,
): Promise<ToolHeader | undefined> {
  if (typeof input !== 'object' || input === null) return undefined
  const filePath = (input as { file_path?: unknown }).file_path
  if (typeof filePath !== 'string') return undefined
  let cwd: string
  try {
    cwd = await $.session.cwd()
  } catch (error) {
    stockAfter($, error)
    return undefined
  }
  const relative = relativeToolPath(filePath, cwd)
  if (relative === undefined) return undefined
  const detail = `(${relative})`
  return title.length + detail.length <= columns - SHORT_NOTE_BULLET.length ? { title, detail } : undefined
}

// The native row draws the title beside a detail column that wraps under itself, after the two-cell
// bullet; printable ASCII aligns string indexes with terminal cells.
function continuationIndent(header: ToolHeader): number {
  return SHORT_NOTE_BULLET.length + header.title.length
}

function detailLines(header: ToolHeader, columns: number): string[] | undefined {
  const width = columns - continuationIndent(header)
  const lines: string[] = []
  let rest = header.detail
  while (rest.length > width) {
    const splitAt = rest.lastIndexOf(' ', width)
    if (splitAt <= 0 || lines.length === MAX_TOOL_HEADER_CONTINUATIONS) return undefined
    lines.push(rest.slice(0, splitAt))
    rest = rest.slice(splitAt).trimStart()
  }
  lines.push(rest)
  return lines
}

function dimToolHeader(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0],
  header: ToolHeader,
  lines: string[],
) {
  const { Box, Text } = $.ui.resolve(e)
  const first = `${header.title}${lines[0]}`
  const continuation = lines.slice(1).join('\n')
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color="success">{SHORT_NOTE_BULLET}</Text>
        <Text dimColor>{first}</Text>
      </Box>
      {continuation !== '' && (
        <Box paddingLeft={continuationIndent(header)}>
          <Text dimColor>{continuation}</Text>
        </Box>
      )}
    </Box>
  )
}

const TOOL_RESULT_PREFIX = `${String.fromCodePoint(0x23bf)} `
const MAX_TOOL_RESULT_SUMMARY_LENGTH = 64
const MAX_EDIT_PATCH_LINES = 10_000

type ToolResultOutput = Record<string, unknown>

function stringOutputField(output: unknown, field: string): string | undefined {
  if (typeof output !== 'object' || output === null) return undefined
  const value = (output as ToolResultOutput)[field]
  return typeof value === 'string' ? value : undefined
}

function lineCount(value: string): number {
  return value === '' ? 0 : value.split('\n').length
}

function lastPrintableLine(value: string): string {
  const tail = value.slice(-MAX_TOOL_RESULT_SUMMARY_LENGTH)
  const line = tail.slice(tail.lastIndexOf('\n') + 1)
  let printable = ''
  for (let index = 0; index < line.length && printable.length < MAX_TOOL_RESULT_SUMMARY_LENGTH; index += 1) {
    const code = line.charCodeAt(index)
    if (code >= 0x20 && code <= 0x7e) printable += line[index]
  }
  return printable
}

function editPatchSummary(output: unknown): string | undefined {
  if (typeof output !== 'object' || output === null) return undefined
  const structuredPatch = (output as ToolResultOutput).structuredPatch
  if (!Array.isArray(structuredPatch)) return undefined
  let added = 0
  let removed = 0
  let total = 0
  for (const hunk of structuredPatch) {
    if (typeof hunk !== 'object' || hunk === null) return undefined
    const lines = (hunk as ToolResultOutput).lines
    if (!Array.isArray(lines)) return undefined
    for (const line of lines) {
      if (typeof line !== 'string' || ++total > MAX_EDIT_PATCH_LINES) return undefined
      if (line.startsWith('+')) added += 1
      if (line.startsWith('-')) removed += 1
    }
  }
  return `+${added} -${removed}`
}

function toolResultSummary(tool: string, output: unknown): string | undefined {
  if (tool === 'Bash') {
    const interpretation = stringOutputField(output, 'returnCodeInterpretation')
    const summary = interpretation === '' || interpretation === undefined
      ? stringOutputField(output, 'stdout')
      : interpretation
    if (summary === undefined) return undefined
    const detail = lastPrintableLine(summary)
    return detail === '' ? undefined : detail
  }
  if (tool === 'Write') {
    const content = stringOutputField(output, 'content')
    return content === undefined ? undefined : `Wrote ${lineCount(content)} lines`
  }
  if (tool === 'Edit' || tool === 'Update') return editPatchSummary(output)
  return undefined
}

function dimToolResult(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0],
  summary: string,
) {
  const { Box, Text } = $.ui.resolve(e)
  return <Box><Text dimColor wrap="truncate-end">{`${TOOL_RESULT_PREFIX}${summary}`}</Text></Box>
}

type RunIndex = { generation: number; runOf: Map<string, Run>; signature: string }

function runsSignature(runOf: Map<string, Run>): string {
  const heads: string[] = []
  for (const [id, run] of runOf) if (run.ids[0] === id) heads.push(`${id}=${run.ids.length}:${runSummary(run)}`)
  return heads.join('\n')
}

function runHead(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0],
  run: Run,
) {
  const { Box, Text } = $.ui.resolve(e)
  return (
    <Box flexDirection="row" marginTop={1}>
      <Text color="success">{SHORT_NOTE_BULLET}</Text>
      <Text dimColor wrap="truncate-end">{runSummary(run)}</Text>
    </Box>
  )
}

function emptyRow($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0]) {
  const { Box } = $.ui.resolve(e)
  return <Box />
}

function composeBelow(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0],
  head: ReturnType<typeof runHead>,
  native: unknown,
) {
  try {
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {head}
        {native as never}
      </Box>
    )
  } catch (error) {
    stockAfter($, error)
    return native as ReturnType<typeof runHead>
  }
}

// One index of the main conversation's runs per generation, a generation being one row appended to it.
// A render never waits for it: it reads the last index, possibly stale, and the fetch's resolution
// asks every render hook again when a run changed.
type RunState = { generation: number; requested: number; index: RunIndex | undefined; live: Set<string> }

async function fetchRuns($: EngineInterface, state: RunState, wanted: number): Promise<void> {
  let runOf = new Map<string, Run>()
  const before = [...state.live]
  try {
    const version = await $.session.version()
    if (isSupported(version.base, 'runs')) {
      const messages = await $.session.messages({ as: 'api' })
      runOf = computeRuns(messages, state.live)
      if (state.generation === wanted) {
        const present = toolUseIds(messages)
        for (const id of before) if (!present.has(id)) state.live.delete(id)
      }
    } else {
      state.live.clear()
    }
  } catch (error) {
    stockAfter($, error)
  }
  if (state.index !== undefined && state.index.generation > wanted) return
  const signature = runsSignature(runOf)
  const changed = signature !== (state.index?.signature ?? '')
  state.index = { generation: wanted, runOf, signature }
  if (!changed) return
  try {
    $.ui.invalidate('ui.render')
  } catch (error) {
    stockAfter($, error)
  }
}

function runOfCall($: EngineInterface, state: RunState, id: unknown): Run | undefined {
  const { generation, index } = state
  if ((index === undefined || index.generation !== generation) && state.requested !== generation) {
    state.requested = generation
    void fetchRuns($, state, generation)
  }
  const run = typeof id === 'string' ? index?.runOf.get(id) : undefined
  return run !== undefined && run.ids.length > 1 ? run : undefined
}

// Only a call appended while this process runs joins a run: a resumed session's history keeps the
// rows it was printed with.
function recordAppend(state: RunState, message: unknown, door: unknown): void {
  state.generation += 1
  if (door !== 'response' || typeof message !== 'object' || message === null) return
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const { type, id } = block as { type?: unknown; id?: unknown }
    if (type === 'tool_use' && typeof id === 'string') state.live.add(id)
  }
}

export const register: Register = (on, options) => {
  const configuration = resolveFrameConfiguration(options)
  const runs: RunState = { generation: 0, requested: -1, index: undefined, live: new Set() }

  on('session.append', async ($, e, next) => {
    const result = await next(e)
    try {
      if (e.agentId === undefined) recordAppend(runs, e.message, e.door)
    } catch (error) {
      stockAfter($, error)
    }
    return result
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const { text, origin } = e.props
    if (
      e.surface !== 'terminal' ||
      typeof text !== 'string' ||
      text.trim() === '' ||
      !isRenderableText(text) ||
      (origin as { kind?: unknown } | null | undefined)?.kind !== 'composer' ||
      !wideEnough(e)
    ) {
      return next(e)
    }
    if (!(await layoutSupported($))) return next(e)
    try {
      const { Text } = $.ui.resolve(e)
      return frame($, e, configuration.userLabel, configuration.userColor, <Text>{text.trim()}</Text>)
    } catch (error) {
      stockAfter($, error)
      return next(e)
    }
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const { tool_use_id, tool, input, isRunning, isErrored, isInterrupted, isExpanded } = e.props
    if (e.surface === 'terminal' && isExpanded !== true && wideEnough(e)) {
      const failed = isErrored || isInterrupted
      let run: Run | undefined
      let drawn: ReturnType<typeof runHead> | undefined
      try {
        run = runOfCall($, runs, tool_use_id)
        if (run !== undefined && run.ids[0] === tool_use_id) drawn = runHead($, e, run)
        else if (run !== undefined && !failed) drawn = emptyRow($, e)
      } catch (error) {
        stockAfter($, error)
        return next(e)
      }
      if (run !== undefined) {
        if (drawn === undefined) return next(e)
        if (!failed || run.ids[0] !== tool_use_id) return drawn
        return composeBelow($, e, drawn, await next(e))
      }
    }
    if (
      e.surface !== 'terminal' ||
      isRunning ||
      isErrored ||
      isInterrupted ||
      isExpanded === true ||
      !wideEnough(e)
    ) {
      return next(e)
    }
    let drawn: ReturnType<typeof dimToolHeader> | undefined
    try {
      const columns = columnsOf(e)
      const fileTitle = FILE_TOOL_TITLES.get(tool)
      let header: ToolHeader | undefined
      let lines: string[] | undefined
      if (fileTitle !== undefined) {
        header = (await layoutSupported($)) ? await fileToolHeader($, fileTitle, input, columns) : undefined
        lines = header === undefined ? undefined : [header.detail]
      } else {
        header = toolHeader(tool, input)
        lines = header === undefined ? undefined : detailLines(header, columns)
        if (lines !== undefined && !(await layoutSupported($))) lines = undefined
      }
      if (header !== undefined && lines !== undefined) drawn = dimToolHeader($, e, header, lines)
    } catch (error) {
      stockAfter($, error)
      return next(e)
    }
    return drawn === undefined ? next(e) : drawn
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const { tool_use_id, tool, output, isErrored, isExpanded } = e.props
    if (e.surface === 'terminal' && isExpanded === false && !isErrored && wideEnough(e)) {
      try {
        if (runOfCall($, runs, tool_use_id) !== undefined) return emptyRow($, e)
      } catch (error) {
        stockAfter($, error)
        return next(e)
      }
    }
    if (
      e.surface !== 'terminal' ||
      configuration.toolResults === 'full' ||
      isErrored ||
      isExpanded !== false ||
      !wideEnough(e) ||
      (tool !== 'Bash' && tool !== 'Write' && tool !== 'Edit' && tool !== 'Update')
    ) {
      return next(e)
    }
    if (configuration.toolResults === 'header') {
      try {
        const { Box } = $.ui.resolve(e)
        return <Box />
      } catch (error) {
        stockAfter($, error)
        return next(e)
      }
    }
    try {
      const summary = toolResultSummary(tool, output)
      if (summary === undefined) return next(e)
      return dimToolResult($, e, summary)
    } catch (error) {
      stockAfter($, error)
      return next(e)
    }
  })

  // The engine folds reads and searches into a group line of its own; inside a run that line is the
  // head or a follower. A group holding anything but calls keeps its line, the head drawn above it.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const { calls, isExpanded, isCallsOnly } = e.props
    if (e.surface !== 'terminal' || isExpanded !== false || !wideEnough(e)) return next(e)
    let drawn: ReturnType<typeof runHead> | undefined
    try {
      const first = Array.isArray(calls) ? (calls[0] as { tool_use_id?: unknown } | undefined)?.tool_use_id : undefined
      const run = runOfCall($, runs, first)
      if (run !== undefined && run.ids[0] === first) drawn = runHead($, e, run)
      else if (run !== undefined && isCallsOnly === true) drawn = emptyRow($, e)
    } catch (error) {
      stockAfter($, error)
      return next(e)
    }
    if (drawn === undefined) return next(e)
    return isCallsOnly === true ? drawn : composeBelow($, e, drawn, await next(e))
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const { text, isSummary } = e.props
    if (
      e.surface !== 'terminal' ||
      typeof text !== 'string' ||
      (isSummary !== undefined && typeof isSummary !== 'boolean') ||
      !wideEnough(e)
    ) {
      return next(e)
    }
    if (!(await layoutSupported($))) return next(e)
    const normalized = text.trim()
    const block = classifyAssistantBlock(normalized, isSummary === true)
    if (block === 'stock' || (block === 'dim' && !isRenderableText(text))) return next(e)
    if (block === 'dim') {
      try {
        const { Box, Markdown, Text } = $.ui.resolve(e)
        return (
          <Box flexDirection="row" marginTop={1}>
            <Text dimColor>{SHORT_NOTE_BULLET}</Text>
            <Markdown text={normalized} dimColor />
          </Box>
        )
      } catch (error) {
        stockAfter($, error)
        return next(e)
      }
    }

    const drawn = await next(e)
    try {
      return frame($, e, configuration.assistantLabel, configuration.assistantColor, drawn)
    } catch (error) {
      stockAfter($, error)
      return drawn
    }
  })

  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const { word, durationMs, waitingFor, isExpanded } = e.props
    if (
      e.surface !== 'terminal' ||
      typeof word !== 'string' ||
      word.trim() === '' ||
      typeof durationMs !== 'number' ||
      !Number.isFinite(durationMs) ||
      durationMs < 0 ||
      waitingFor !== undefined ||
      isExpanded === true ||
      !wideEnough(e)
    ) {
      return next(e)
    }
    if (!(await layoutSupported($))) return next(e)
    try {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box marginTop={1}>
          <Text dimColor wrap="truncate-end">
            {turnRule(word, durationMs, columnsOf(e))}
          </Text>
        </Box>
      )
    } catch (error) {
      stockAfter($, error)
      return next(e)
    }
  })
}
