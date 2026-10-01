import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveLocale, type SupportedLocale } from './i18n'
import { APP_STATE_SUBDIR } from './migrate-data-dir'

/** Takes the Deck userData captured before the Avatar redirects its own userData to a subdirectory. */
export function avatarDeckStateDir(deckUserData: string): string {
  return join(deckUserData, APP_STATE_SUBDIR)
}

export interface AvatarLocaleOptions {
  readFile?(file: string): string
  reportError(scope: string, message: string, error?: unknown): void
}

/** Read once at startup: a locale changed in the Deck shows after the Avatar restarts. */
export function readAvatarLocale(stateDir: string, osLocale: string, options: AvatarLocaleOptions): SupportedLocale {
  const file = join(stateDir, 'config.json')
  const read = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  let configured = ''
  try {
    const parsed: unknown = JSON.parse(read(file))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const locale = (parsed as { locale?: unknown }).locale
      if (typeof locale === 'string') configured = locale
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      options.reportError('avatar-locale', `cannot read the Deck locale from ${file}`, error)
    }
  }
  return resolveLocale(configured, osLocale)
}
