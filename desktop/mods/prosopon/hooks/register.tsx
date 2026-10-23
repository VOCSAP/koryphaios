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
