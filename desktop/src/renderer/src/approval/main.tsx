import { createRoot } from 'react-dom/client'
import '../styles.css'
import type { ApprovalWindowApi } from '../../../shared/approval-window'
import { ApprovalReader } from './ApprovalReader'

const api = (window as unknown as { api: ApprovalWindowApi }).api

window.addEventListener('error', (event) => {
  api.reportError(`uncaught error: ${event.message} (${event.filename}:${event.lineno})`)
})
window.addEventListener('unhandledrejection', (event) => {
  const reason: unknown = event.reason
  api.reportError(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`)
})

// The main process drives prefers-color-scheme through nativeTheme.themeSource, so the Deck theme reaches this window without IPC.
const dark = window.matchMedia('(prefers-color-scheme: dark)')
const applyTheme = (): void => {
  document.documentElement.dataset.theme = dark.matches ? 'dark' : 'light'
}
applyTheme()
dark.addEventListener('change', applyTheme)

const container = document.getElementById('approval')
if (!container) throw new Error('#approval not found')
createRoot(container).render(<ApprovalReader api={api} closeWindow={() => window.close()} />)
