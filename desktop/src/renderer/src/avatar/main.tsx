import { createRoot } from 'react-dom/client'
import '../styles.css'
import type { AvatarWindow } from './avatar-api'
import { AvatarApp } from './AvatarApp'

const api = (window as unknown as AvatarWindow).api

window.addEventListener('error', (event) => {
  api.reportError(`uncaught error: ${event.message} (${event.filename}:${event.lineno})`.slice(0, 2048))
})
window.addEventListener('unhandledrejection', (event) => {
  const reason: unknown = event.reason
  api.reportError(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`.slice(0, 2048))
})

const container = document.getElementById('avatar')
if (!container) throw new Error('#avatar not found')
createRoot(container).render(<AvatarApp api={api} reducedMotion={window.matchMedia('(prefers-reduced-motion: reduce)')} />)
