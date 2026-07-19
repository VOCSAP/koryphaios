import React from 'react'
import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { App } from './components/App'
import { ErrorBoundary } from './components/ErrorBoundary'

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

createRoot(container).render(
  <React.StrictMode>
    <ErrorBoundary scope="root">
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
