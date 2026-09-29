import { app, dialog } from 'electron'
import { reportError } from './log'

export function installProcessFailureGuard(): void {
  const handleFatal = (kind: string) => (error: unknown) => {
    reportError('main', kind, error)
    if (!app.isReady()) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
      try {
        dialog.showErrorBox('Koryphaios', `Startup failure (${kind}):\n\n${message}`)
      } catch (dialogError) {
        reportError('main', `cannot show startup failure (${kind})`, dialogError)
      }
      process.exit(1)
    }
  }

  process.on('uncaughtException', handleFatal('uncaught exception'))
  process.on('unhandledRejection', handleFatal('unhandled rejection'))
}
