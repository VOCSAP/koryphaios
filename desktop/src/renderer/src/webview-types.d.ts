// Minimal typings for the Electron <webview> tag used by the Browser view
// (PLAN D1). The renderer tsconfig has no Electron types (it is plain web
// code), so the methods actually used are declared here by hand.

import 'react'

export interface WebviewTag extends HTMLElement {
  src: string
  loadURL(url: string): Promise<void>
  getURL(): string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  reloadIgnoringCache(): void
  stop(): void
  openDevTools(): void
  isDevToolsOpened(): boolean
  send(channel: string, ...args: unknown[]): void
  /** Id of the guest webContents (used by the main-side screenshot capture). */
  getWebContentsId(): number
}

/** `did-navigate` / `did-navigate-in-page` payload subset. */
export interface WebviewNavigateEvent extends Event {
  url: string
  isMainFrame?: boolean
}

/** `ipc-message` payload subset (guest preload -> host). */
export interface WebviewIpcMessageEvent extends Event {
  channel: string
  args: unknown[]
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string
        preload?: string
        partition?: string
        allowpopups?: string
        webpreferences?: string
      }
    }
  }
}
