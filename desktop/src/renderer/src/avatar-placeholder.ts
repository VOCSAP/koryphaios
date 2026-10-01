import type { AvatarViewApi, AvatarViewState } from '@shared/avatar-view'

const api = window.api as unknown as AvatarViewApi
const rootElement = document.querySelector<HTMLElement>('#avatar')
if (!rootElement) throw new Error('Avatar renderer root is missing')
const root: HTMLElement = rootElement

let latest: AvatarViewState | null = null

function render(state: AvatarViewState): void {
  if (latest && (state.generation < latest.generation || state.revision < latest.revision)) return
  latest = state
  root.textContent = state.summary.face
  root.setAttribute('aria-label', state.summary.face)
}

const unsubscribe = api.onState(render)
window.addEventListener('beforeunload', unsubscribe, { once: true })

void api.getState().then(render).catch((error: unknown) => {
  api.reportError(error instanceof Error ? error.message : String(error))
})
