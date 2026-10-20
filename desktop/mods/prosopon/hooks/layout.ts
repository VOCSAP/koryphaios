export type BlockKind = 'frame' | 'dim' | 'stock'

export const MIN_FRAME_COLUMNS = 40
export const GUARD_SAFE_BORDER = 'single'

// Over-matching only leaves a short message unframed; under-matching splits a
// limit message across frame rows, which the quota detector cannot read across.
const STOCK_VOCABULARY = /limit|reset|quota|overloaded|usage/i
const STOCK_MAX_CHARS = 400
const STOCK_MAX_LINES = 3

function mustStayStock(text: string): boolean {
  return (
    text.length <= STOCK_MAX_CHARS &&
    text.split('\n').length <= STOCK_MAX_LINES &&
    STOCK_VOCABULARY.test(text)
  )
}

export function classifyAssistantBlock(text: string, isSummary: boolean): BlockKind {
  if (mustStayStock(text)) return 'stock'
  return isSummary ? 'dim' : 'frame'
}
