import type { EngineInterface, Register, RenderViewport } from 'claude-code'

import {
  classifyAssistantBlock,
  GUARD_SAFE_BORDER,
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

export const register: Register = (on, options) => {
  const configuration = resolveFrameConfiguration(options)

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const { text, origin } = e.props
    if (
      e.surface !== 'terminal' ||
      typeof text !== 'string' ||
      text.trim() === '' ||
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
    const header = toolHeader(tool, input)
    if (header === undefined || (tool === 'Bash' && (needsMidWordWrap(header, columnsOf(e)) || !fitsNativeBashHeader(header, columnsOf(e)))) || !(await layoutSupported($))) return next(e)
    try {
      return dimToolHeader($, e, header)
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
    if (block === 'stock') return next(e)
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
