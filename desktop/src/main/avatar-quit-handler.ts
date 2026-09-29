import { createBeforeQuitHandler, type QuitErrorSink } from './before-quit'

export interface AvatarQuitHandlerPlan {
  disposeTray(): void
  release(): Promise<unknown>
  quit(): void
  report: QuitErrorSink
}

export interface AvatarBeforeQuitEvent {
  preventDefault(): void
}

export function createAvatarQuitHandler(plan: AvatarQuitHandlerPlan): (event: AvatarBeforeQuitEvent) => void {
  const handleQuit = createBeforeQuitHandler({
    effects: [{ label: 'Avatar Tray', run: plan.disposeTray }],
    release: plan.release,
    quit: plan.quit,
    onError: plan.report
  })
  return (event) => handleQuit(() => event.preventDefault())
}
