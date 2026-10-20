import type { EngineInterface, Register, RenderInput } from 'claude-code'

import {
  classifyAssistantBlock,
  GUARD_SAFE_BORDER,
  MIN_FRAME_COLUMNS,
  type BlockKind,
} from './layout'
import { isCertified } from './versions'

export async function classifyAssistant(
  $: unknown,
  e: RenderInput<'AssistantMessage'>,
): Promise<BlockKind> {
  void $
  return classifyAssistantBlock(e.props.text, e.props.isSummary === true)
}

function assertNever(kind: never): never {
  throw new Error(`prosopon: unknown block kind ${String(kind)}`)
}

function draw(
  $: EngineInterface,
  e: RenderInput<'AssistantMessage'>,
  kind: BlockKind,
  text: string,
) {
  switch (kind) {
    case 'stock':
    case 'dim':
      return undefined
    case 'frame': {
      const { Box, Markdown } = $.ui.resolve(e)
      return (
        <Box borderStyle={GUARD_SAFE_BORDER} flexDirection="column">
          <Markdown text={text} />
        </Box>
      )
    }
    default:
      return assertNever(kind)
  }
}

export const register: Register = on => {
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const { text, isSummary } = e.props
    const columns = e.viewport?.columns ?? 80
    if (
      e.surface !== 'terminal' ||
      typeof text !== 'string' ||
      (isSummary !== undefined && typeof isSummary !== 'boolean') ||
      !Number.isFinite(columns) ||
      columns < MIN_FRAME_COLUMNS
    ) {
      return next(e)
    }

    let tree: ReturnType<typeof draw>
    try {
      const version = await $.session.version()
      const kind = isCertified(version.base, 'layout') ? await classifyAssistant($, e) : 'stock'
      tree = draw($, e, kind, text)
    } catch (error) {
      $.ui.log(`prosopon: stock render after ${String(error)}`, { to: 'debug' })
      return next(e)
    }
    return tree ?? next(e)
  })
}
