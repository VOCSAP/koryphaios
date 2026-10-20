import { contextBridge, ipcRenderer } from 'electron'

import { APPROVAL_WINDOW_CHANNELS, type ApprovalWindowApi, type ApprovalWindowSnapshot } from '../shared/approval-window'

const api: ApprovalWindowApi = {
  getState: () => ipcRenderer.invoke(APPROVAL_WINDOW_CHANNELS.getState) as Promise<ApprovalWindowSnapshot>,
  read: (intent) => ipcRenderer.invoke(APPROVAL_WINDOW_CHANNELS.read, intent) as Promise<void>,
  verdict: (intent) => ipcRenderer.invoke(APPROVAL_WINDOW_CHANNELS.verdict, intent) as Promise<void>,
  reportError(message) {
    void ipcRenderer.invoke(APPROVAL_WINDOW_CHANNELS.reportError, message)
  }
}

contextBridge.exposeInMainWorld('api', api)
