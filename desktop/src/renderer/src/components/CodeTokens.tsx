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
 * Inline spans separated by real newline text nodes, deliberately not one div
 * per line: the Files viewer derives the selected line span from
 * Range.toString(), which concatenates text nodes and synthesises nothing for
 * block boundaries.
 * Rendering block-level line breaks here would make selections silently
 * under-report (e.g. lines 3-4 reporting as 3-3) with no error anywhere.
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
