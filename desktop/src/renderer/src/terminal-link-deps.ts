import { translate } from './i18n'
import { useDeck } from './store'
import type { LinkNotice, TerminalLinkDeps } from './terminal-links'

const NOTICE_TOAST: Record<LinkNotice, string> = {
  invalid: 'toast.linkInvalid',
  'network-path': 'toast.linkNetworkPath',
  'not-found': 'toast.linkNotFound',
  'not-allowed': 'toast.linkNotAllowed',
  failed: 'toast.linkFailed',
  sandbox: 'toast.linkSandbox'
}

/**
 * What a session terminal needs to act on a link, wired to the preload API and
 * the toast. The sandbox flag is the project's, not the tile's, and is closed
 * until the first status arrives: a file link must never be offered on a
 * sandbox tile because the status was not hydrated yet.
 */
export function sessionLinkDeps(): TerminalLinkDeps {
  return {
    open: (target, intent) => window.api.openLink(target, intent),
    preview: (target) => window.api.previewImage(target),
    onRefused: (reason) => useDeck.getState().showToast(NOTICE_TOAST[reason], 'error'),
    report: (message) => window.api.reportError('terminal', message),
    fileLinks: () => useDeck.getState().sandboxStatus?.enabled === false,
    label: (key) => translate(useDeck.getState().dict, key)
  }
}
