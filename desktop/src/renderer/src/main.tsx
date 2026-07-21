import React from 'react'
import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { App } from './components/App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { connectRemoteApi } from './remote-api'

// Window-level nets (PLAN O4): uncaught renderer errors and promise rejections
// (e.g. un-awaited IPC calls) are invisible in a packaged app once DevTools is
// closed -- forward them to main.log + the journal.
window.addEventListener('error', (e) => {
  window.api?.reportError('window', `uncaught error: ${e.message} (${e.filename}:${e.lineno})`)
})
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason instanceof Error ? (e.reason.stack ?? e.reason.message) : String(e.reason)
  window.api?.reportError('window', `unhandled rejection: ${reason}`)
})

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')
const root = createRoot(container)

/** Companion boot failure (PLAN MB1): no i18n yet (needs the bridge), so the
 * text is hardcoded bilingual like the App bootstrap splash. */
function RemoteBootError(): React.JSX.Element {
  const fr = (navigator.language || '').toLowerCase().startsWith('fr')
  return (
    <div className="loading loading-error" role="alert">
      <h2>{fr ? 'Hôte inaccessible' : 'Host unreachable'}</h2>
      <p className="error-boundary-detail">
        {fr
          ? 'Relance « Compagnon » sur le PC et scanne le nouveau QR code.'
          : 'Restart “Companion” on the PC and scan the fresh QR code.'}
      </p>
      <button className="primary" onClick={() => window.location.reload()}>
        {fr ? 'Réessayer' : 'Retry'}
      </button>
    </div>
  )
}

async function boot(): Promise<void> {
  // Companion mode (PLAN MB1): no Electron preload -> install the WebSocket
  // shim as window.api before anything renders. The desktop window skips this
  // entirely (window.api is already there).
  if (!window.api) {
    try {
      await connectRemoteApi()
    } catch {
      root.render(<RemoteBootError />)
      return
    }
  }
  root.render(
    <React.StrictMode>
      <ErrorBoundary scope="root">
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  )
}

void boot()
