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

const MAX_CUSTOM_BASH_COMMAND_LENGTH = 300
const TOOL_HEADER_CONTINUATION_INDENT = 6

type ToolInput = { command?: unknown }

function hasSafeToolHeaderArgument(value: string): boolean {
  if (value.length === 0) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code > 0x7e) return false
  }
  return true
}

function toolHeader(tool: string, input: unknown): string | undefined {
  if (tool !== 'Bash' || typeof input !== 'object' || input === null) return undefined
  const toolInput = input as ToolInput
  if (
    typeof toolInput.command !== 'string' ||
    toolInput.command.length > MAX_CUSTOM_BASH_COMMAND_LENGTH ||
    !hasSafeToolHeaderArgument(toolInput.command)
  ) {
    return undefined
  }
  return `Bash(${toolInput.command})`
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
): Promise<string | undefined> {
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
  const header = `${title}(${relative})`
  return header.length <= columns - SHORT_NOTE_BULLET.length ? header : undefined
}

// The fixed bullet is two cells, and printable ASCII aligns string indexes with terminal cells.
function wrapToolHeader(header: string, columns: number): [string, string] {
  const firstWidth = columns - SHORT_NOTE_BULLET.length
  if (header.length <= firstWidth) return [header, '']
  const splitAt = header.lastIndexOf(' ', firstWidth)
  const end = splitAt > 0 ? splitAt : firstWidth
  const first = header.slice(0, end)
  const remainder = header.slice(end).trimStart()
  const continuationWidth = columns - TOOL_HEADER_CONTINUATION_INDENT
  const continuations: string[] = []
  let rest = remainder
  while (rest.length > continuationWidth) {
    const lineBreak = rest.lastIndexOf(' ', continuationWidth)
    const continuationEnd = lineBreak > 0 ? lineBreak : continuationWidth
    continuations.push(rest.slice(0, continuationEnd))
    rest = rest.slice(continuationEnd).trimStart()
  }
  continuations.push(rest)
  return [first, continuations.join('\n')]
}

function needsMidWordWrap(header: string, columns: number): boolean {
  let rest = header
  let width = columns - SHORT_NOTE_BULLET.length
  while (rest.length > width) {
    const splitAt = rest.lastIndexOf(' ', width)
    if (splitAt <= 0) return true
    rest = rest.slice(splitAt).trimStart()
    width = columns - TOOL_HEADER_CONTINUATION_INDENT
  }
  return false
}

function fitsNativeBashHeader(header: string, columns: number): boolean {
  const [, continuation] = wrapToolHeader(header, columns)
  return continuation === '' || continuation.split('\n').length <= 4
}

function dimToolHeader(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0],
  header: string,
) {
  const { Box, Text } = $.ui.resolve(e)
  const [first, continuation] = wrapToolHeader(header, columnsOf(e))
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color="success">{SHORT_NOTE_BULLET}</Text>
        <Text dimColor>{first}</Text>
      </Box>
      {continuation !== '' && (
        <Box paddingLeft={TOOL_HEADER_CONTINUATION_INDENT}>
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

export const register: Register = (on, options) => {
  const configuration = resolveFrameConfiguration(options)

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
    const { tool, input, isRunning, isErrored, isInterrupted, isExpanded } = e.props
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
    const columns = columnsOf(e)
    const fileTitle = FILE_TOOL_TITLES.get(tool)
    let header: string | undefined
    if (fileTitle !== undefined) {
      header = (await layoutSupported($)) ? await fileToolHeader($, fileTitle, input, columns) : undefined
    } else {
      header = toolHeader(tool, input)
      if (header !== undefined && (needsMidWordWrap(header, columns) || !fitsNativeBashHeader(header, columns) || !(await layoutSupported($)))) {
        header = undefined
      }
    }
    if (header === undefined) return next(e)
    try {
      return dimToolHeader($, e, header)
    } catch (error) {
      stockAfter($, error)
      return next(e)
    }
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const { tool, output, isErrored, isExpanded } = e.props
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
