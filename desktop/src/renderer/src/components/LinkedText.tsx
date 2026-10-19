import { Fragment, useMemo } from 'react'
import { detectLinks } from '../../../shared/link-detect'
import { useT } from '../i18n'
import { useDeck } from '../store'
import { sessionLinkDeps } from '../terminal-link-deps'
import { activateLink, WEB_URL_RE } from '../terminal-links'

export type TextSegment = { kind: 'text'; text: string } | { kind: 'link'; text: string; target: string }

const MAX_LINKS = 200
const FORMAT_CHAR_RE = /\p{Cf}/u
const NON_PRINTABLE_ASCII_RE = /[^\x20-\x7e]/
const AUTHORITY_RE = /^https?:\/\/([^/]*)/i

/** A match that reads as one place and leads to another: invisible characters, userinfo before the host, a non-ASCII host. */
function isDecoy(text: string, target: string): boolean {
  if (FORMAT_CHAR_RE.test(text)) return true
  if (!WEB_URL_RE.test(target)) return false
  const authority = AUTHORITY_RE.exec(target)?.[1] ?? ''
  return authority.includes('@') || NON_PRINTABLE_ASCII_RE.test(authority)
}

/**
 * Splits agent-written text around the URLs and absolute paths in it; the
 * segments rejoin to `text`. A decoy, and every match past the cap, stays text.
 */
export function segmentLinkedText(text: string): TextSegment[] {
  const segments: TextSegment[] = []
  let at = 0
  let links = 0
  for (const match of detectLinks(text)) {
    if (links >= MAX_LINKS) break
    const matched = text.slice(match.start, match.end)
    if (isDecoy(matched, match.target)) continue
    if (match.start > at) segments.push({ kind: 'text', text: text.slice(at, match.start) })
    segments.push({ kind: 'link', text: matched, target: match.target })
    at = match.end
    links++
  }
  if (at < text.length) segments.push({ kind: 'text', text: text.slice(at) })
  return segments
}

/** True while the operator has text selected in the link: the click that ends a selection must not open it. */
function selectionInside(link: HTMLElement): boolean {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed) return false
  return link.contains(selection.anchorNode) || link.contains(selection.focusNode)
}

/** The URL a native anchor may carry, else null. Depth guard: detectLinks already yields http(s) only, and openLink is blocked remotely. */
function webHref(target: string): string | null {
  try {
    const url = new URL(target)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

/**
 * Agent-written text with its URLs and absolute paths made clickable. On the
 * Deck a click goes through the terminal's link path (main re-validates every
 * target); on a remote companion only http(s) URLs become anchors, opened by
 * the phone's own browser, and paths stay text. A link is a focusable span, not
 * a button, so its text stays selectable and copyable.
 */
export function LinkedText({ text }: { text: string }): React.JSX.Element {
  const t = useT()
  const remote = useDeck((s) => s.remote)
  const segments = useMemo(() => segmentLinkedText(text), [text])
  const deps = sessionLinkDeps()
  const fileLinks = deps.fileLinks()

  return (
    <>
      {segments.map((segment, i) => {
        if (segment.kind === 'text') return <Fragment key={i}>{segment.text}</Fragment>
        const isWeb = WEB_URL_RE.test(segment.target)
        if (remote) {
          const href = isWeb ? webHref(segment.target) : null
          if (href === null) return <Fragment key={i}>{segment.text}</Fragment>
          return (
            <a key={i} className="text-link" href={href} target="_blank" rel="noopener noreferrer" title={t('inbox.linkWebTitle')}>
              {segment.text}
            </a>
          )
        }
        if (!isWeb && !fileLinks) return <Fragment key={i}>{segment.text}</Fragment>
        return (
          <span
            key={i}
            role="link"
            tabIndex={0}
            className="text-link"
            title={t(isWeb ? 'inbox.linkWebTitle' : 'inbox.linkFileTitle')}
            onClick={(ev) => {
              if (!selectionInside(ev.currentTarget)) activateLink(deps, segment.target, ev)
            }}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter') activateLink(deps, segment.target, { button: 0, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey })
            }}
          >
            {segment.text}
          </span>
        )
      })}
    </>
  )
}
