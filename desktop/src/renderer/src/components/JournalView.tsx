import { useCallback, useEffect, useState } from 'react'
import type { JournalEntry, JournalKind } from '@shared/types'
import { useDeck } from '../store'
import { useT } from '../i18n'

// Activity journal view (PLAN C14): the window's chronological narration
// (spawns, exits, quota, attention, worktrees, announces, dispatches,
// checkpoints). In-memory ring buffer in the main process; text export.

const POLL_MS = 3_000

const KINDS: JournalKind[] = [
  'session',
  'quota',
  'attention',
  'worktree',
  'announce',
  'dispatch',
  'review',
  'checkpoint'
]

export function JournalView(): React.JSX.Element {
  const t = useT()
  const showToast = useDeck((s) => s.showToast)
  const [entries, setEntries] = useState<JournalEntry[]>([])
  const [kind, setKind] = useState<JournalKind | ''>('')
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setEntries(await window.api.journalList(kind || null))
    } finally {
      setLoaded(true)
    }
  }, [kind])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const exportText = async (): Promise<void> => {
    const path = await window.api.journalExport()
    if (path) showToast('toast.journalExported')
  }

  return (
    <div className="journal-view">
      <header className="journal-head">
        <h2>{t('journal.title')}</h2>
        <span className="roadmap-spacer" />
        <select value={kind} onChange={(e) => setKind(e.target.value as JournalKind | '')}>
          <option value="">{t('journal.allKinds')}</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`journal.kind.${k}`)}
            </option>
          ))}
        </select>
        <button onClick={() => void exportText()} disabled={entries.length === 0}>
          {t('journal.export')}
        </button>
      </header>

      <div className="journal-list">
        {loaded && entries.length === 0 && <p className="roadmap-empty">{t('journal.empty')}</p>}
        {[...entries].reverse().map((e) => (
          <div key={e.id} className="journal-row">
            <span className="journal-time">{new Date(e.at).toLocaleTimeString()}</span>
            <span className={`rm-badge journal-kind-${e.kind}`}>{t(`journal.kind.${e.kind}`)}</span>
            <span className="journal-text">{e.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
