import { useEffect, useRef, useState } from 'react'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { TerminalTile } from './TerminalTile'

// Home view (PLAN C5): the SUPERVISOR session, full width. Spawned lazily on
// the first visit (never at app start); if the operator closes it, a manual
// start button is shown instead of auto-respawning in a loop. The view stays
// mounted in App (display:none) so the xterm scrollback survives view switches.

export function HomeView({ active }: { active: boolean }): React.JSX.Element {
  const t = useT()
  const sessions = useDeck((s) => s.sessions)
  const supervisor = sessions.find((s) => s.supervisor) ?? null

  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  // One auto-spawn per app run: after that, absence means the operator closed
  // it on purpose -> show the start button instead.
  const autoSpawned = useRef(false)

  const start = (): void => {
    setPending(true)
    setError(null)
    window.api.ensureSupervisor().then(
      () => setPending(false),
      (e) => {
        setPending(false)
        setError(e instanceof Error ? e.message : String(e))
      }
    )
  }

  useEffect(() => {
    if (!active || supervisor || pending || autoSpawned.current) return
    autoSpawned.current = true
    start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, supervisor, pending])

  return (
    <div className="home-view">
      {supervisor ? (
        <TerminalTile session={supervisor} hidden={!active} />
      ) : (
        <div className="home-empty">
          {pending ? (
            <p>{t('home.starting')}</p>
          ) : (
            <>
              {error && <p className="home-error">{t('home.error', { error })}</p>}
              <p>{t('home.body')}</p>
              <button className="primary" onClick={start}>
                {t('home.start')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
