import { useDeck } from '../store'
import { useT } from '../i18n'

// Terminal key bar (PLAN MB3 — EXPLORATION §4 "Agents"): the keys a mobile
// virtual keyboard cannot produce, Termux/ttyd style, docked above the
// keyboard. Sequences go straight to the selected session's PTY.
const KEYS: { label: string; seq: string }[] = [
  { label: 'Esc', seq: '\x1b' },
  { label: 'Tab', seq: '\t' },
  { label: '^C', seq: '\x03' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '←', seq: '\x1b[D' },
  { label: '→', seq: '\x1b[C' }
]

export function KeyBar({ sessionId }: { sessionId: string | null }): React.JSX.Element | null {
  const t = useT()
  if (!sessionId) return null
  const send = (seq: string): void => window.api.ptyInput(sessionId, seq)
  const paste = async (): Promise<void> => {
    try {
      const text = await navigator.clipboard.readText()
      // Bracketed paste, like TerminalTile's clipboard path.
      if (text) send(`\x1b[200~${text}\x1b[201~`)
    } catch {
      useDeck.getState().showToast('mobile.pasteDenied', 'info')
    }
  }
  return (
    <div className="keybar">
      {KEYS.map((k) => (
        // preventDefault on pointerdown keeps the virtual keyboard open (the
        // button never steals focus from the terminal).
        <button
          key={k.label}
          className="keybar-btn"
          onPointerDown={(e) => {
            e.preventDefault()
            send(k.seq)
          }}
        >
          {k.label}
        </button>
      ))}
      <button
        className="keybar-btn"
        title={t('mobile.paste')}
        onPointerDown={(e) => {
          e.preventDefault()
          void paste()
        }}
      >
        📋
      </button>
    </div>
  )
}
