import { Fragment } from 'react'
import type { HlLine } from '../highlight'

// One highlighted line, rendered as styled spans (card 526665f7). Deliberately
// NOT `dangerouslySetInnerHTML` with Shiki's HTML output: the code shown here
// is arbitrary file content read off disk, and a renderer that injects it as
// markup would be handing the page to whatever the operator happens to open.
// Spans also keep the text nodes intact, which the Files viewer's selection
// capture counts on to derive line numbers.

export function CodeTokens({ line }: { line: HlLine }): React.JSX.Element {
  return (
    <>
      {line.map((tok, i) => (
        <span key={i} style={tok.style}>
          {tok.content}
        </span>
      ))}
    </>
  )
}

/**
 * A whole highlighted file, as INLINE spans separated by REAL newline text
 * nodes. The separator is the load-bearing part: the Files viewer derives the
 * selected line span from `Range.toString()`, which concatenates text nodes
 * and synthesises NOTHING for block boundaries. Render one `<div>` per line
 * here and every line break silently disappears from a selection, so
 * "lines 3-4" starts reporting "lines 3-3" with no error anywhere.
 * `tests/desktop-explorer-selection-dom.test.ts` replays exactly that gesture
 * on the real DOM and goes red if this structure changes.
 */
export function HighlightedLines({ lines }: { lines: HlLine[] }): React.JSX.Element {
  return (
    <>
      {lines.map((line, i) => (
        <Fragment key={i}>
          <CodeTokens line={line} />
          {i < lines.length - 1 ? '\n' : null}
        </Fragment>
      ))}
    </>
  )
}
