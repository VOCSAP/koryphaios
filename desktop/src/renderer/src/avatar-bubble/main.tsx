import { createRoot } from 'react-dom/client'
import '../styles.css'
import type { AvatarBubbleWindow } from './bubble-api'
import { BubbleApp } from './BubbleApp'

const api = (window as unknown as AvatarBubbleWindow).api

window.addEventListener('error', (event) => {
  api.reportError(`uncaught error: ${event.message} (${event.filename}:${event.lineno})`.slice(0, 2048))
})
window.addEventListener('unhandledrejection', (event) => {
  const reason: unknown = event.reason
  api.reportError(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`.slice(0, 2048))
})

const container = document.getElementById('avatar-bubble')
if (!container) throw new Error('#avatar-bubble not found')
createRoot(container).render(<BubbleApp api={api} />)
