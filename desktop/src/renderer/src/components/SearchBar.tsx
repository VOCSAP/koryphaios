import { useEffect, useRef, useState } from 'react'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { getTerminal } from '../terminal-registry'
import { searchBuffer, findClosestMatch, MIN_QUERY_LENGTH, type BufferMatch } from '../search-core'

interface SessionHit extends BufferMatch {
  sessionId: string
}

const MAX_PER_SESSION = 50
/** Context kept around the match in a result row (chars before / after). */
const CONTEXT_BEFORE = 48
const CONTEXT_AFTER = 120

function HighlightedLine({
  text,
  index,
  length
}: {
  text: string
  index: number
  length: number
}): React.JSX.Element {
  let pre = text.slice(0, index)
  if (pre.length > CONTEXT_BEFORE) pre = '…' + pre.slice(pre.length - CONTEXT_BEFORE)
  const mid = text.slice(index, index + length)
  let post = text.slice(index + length)
  if (post.length > CONTEXT_AFTER) post = post.slice(0, CONTEXT_AFTER) + '…'
  return (
    <span className="search-line">
      {pre}
      <mark>{mid}</mark>
      {post}
    </span>
  )
}

/**
 * Cross-session search panel (Ctrl+Shift+F / the modebar 🔍 toggle). Scans the
 * scrollback of every open terminal; double-clicking a hit selects the tile
 * and scrolls its terminal to the match, which is highlighted via selection.
 */
export function SearchBar(): React.JSX.Element | null {
  const t = useT()
  const searchOpen = useDeck((s) => s.searchOpen)
  const openSearch = useDeck((s) => s.openSearch)
  const sessions = useDeck((s) => s.sessions)
  const setSelected = useDeck((s) => s.setSelected)
  const maximizedId = useDeck((s) => s.maximizedId)
  const setMaximized = useDeck((s) => s.setMaximized)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SessionHit[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (searchOpen) inputRef.current?.focus()
  }, [searchOpen])

  // Debounced scan of every registered terminal buffer.
  useEffect(() => {
    if (!searchOpen) return
    const timer = setTimeout(() => {
      if (query.trim().length < MIN_QUERY_LENGTH) {
        setHits([])
        return
      }
      const found: SessionHit[] = []
      for (const s of sessions) {
        const term = getTerminal(s.id)
        if (!term) continue
        for (const m of searchBuffer(term.buffer.active, query, { maxMatches: MAX_PER_SESSION })) {
          found.push({ ...m, sessionId: s.id })
        }
      }
      setHits(found)
    }, 150)
    return () => clearTimeout(timer)
  }, [query, searchOpen, sessions])

  if (!searchOpen) return null

  function jumpTo(hit: SessionHit): void {
    setSelected(hit.sessionId)
    if (maximizedId && maximizedId !== hit.sessionId) setMaximized(hit.sessionId)
    // Wait one beat: unhiding the tile triggers a refit (possible reflow), and
    // the buffer may have moved since the scan -- re-locate before scrolling.
    setTimeout(() => {
      const term = getTerminal(hit.sessionId)
      if (!term) return
      document
        .querySelector(`.tile[data-session-id="${CSS.escape(hit.sessionId)}"]`)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      const m = findClosestMatch(term.buffer.active, query, hit.row) ?? hit
      term.clearSelection()
      term.select(m.col, m.row, m.length)
      term.scrollToLine(Math.max(0, m.row - Math.floor(term.rows / 2)))
      term.focus()
    }, 90)
  }

  const active = query.trim().length >= MIN_QUERY_LENGTH
  const bySession = sessions
    .map((s) => ({ session: s, hits: hits.filter((h) => h.sessionId === s.id) }))
    .filter((g) => g.hits.length > 0)

  return (
    <div className="search-panel">
      <div className="search-head">
        <input
          ref={inputRef}
          className="search-input"
          type="text"
          placeholder={t('search.placeholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') openSearch(false)
          }}
        />
        {active && (
          <span className="search-count">
            {t(hits.length === 1 ? 'search.countOne' : 'search.countOther', { n: hits.length })}
          </span>
        )}
        <button
          type="button"
          className="tile-btn"
          title={t('common.close')}
          onClick={() => openSearch(false)}
        >
          ✕
        </button>
      </div>
      {active && (
        <div className="search-results">
          {bySession.length === 0 && <div className="search-empty">{t('search.noResults')}</div>}
          {bySession.map(({ session, hits: hs }) => (
            <div key={session.id} className="search-group">
              <div className="search-group-head" style={{ color: session.color || undefined }}>
                {session.name}
                {session.peerId && <span className="search-group-peer">{session.peerId}</span>}
              </div>
              {hs.map((h, i) => (
                <div
                  key={`${h.row}:${h.col}:${i}`}
                  className="search-hit"
                  title={t('search.jumpTitle')}
                  onDoubleClick={() => jumpTo(h)}
                >
                  <HighlightedLine text={h.lineText} index={h.matchIndex} length={h.length} />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="search-hint">{t('search.hint')}</div>
    </div>
  )
}
