import { contextBridge, ipcRenderer } from 'electron'

import {
  AVATAR_BUBBLE_CHANNELS,
  avatarBubbleReadApi,
  type AvatarBubbleActOutcome,
  type AvatarBubbleApi,
  type AvatarBubbleState
} from '../shared/avatar-bubble-view'

const api: AvatarBubbleApi = {
  getState: () => ipcRenderer.invoke(AVATAR_BUBBLE_CHANNELS.getState) as Promise<AvatarBubbleState>,
  onState(callback) {
    const listener = (_event: Electron.IpcRendererEvent, state: AvatarBubbleState): void => {
      callback(state)
    }
    ipcRenderer.on(AVATAR_BUBBLE_CHANNELS.state, listener)
    return () => {
      ipcRenderer.removeListener(AVATAR_BUBBLE_CHANNELS.state, listener)
    }
  },
  act: (intent) => ipcRenderer.invoke(AVATAR_BUBBLE_CHANNELS.act, intent) as Promise<{ outcome: AvatarBubbleActOutcome; reason?: string }>,
  ...avatarBubbleReadApi(ipcRenderer.invoke.bind(ipcRenderer)),
  focusDeck: (intent) => ipcRenderer.invoke(AVATAR_BUBBLE_CHANNELS.focusDeck, intent) as Promise<void>,
  setExpanded: (intent) => ipcRenderer.invoke(AVATAR_BUBBLE_CHANNELS.setExpanded, intent) as Promise<void>,
  close: () => ipcRenderer.invoke(AVATAR_BUBBLE_CHANNELS.close) as Promise<void>,
  reportError(message) {
    void ipcRenderer.invoke(AVATAR_BUBBLE_CHANNELS.reportError, message)
  }
}

contextBridge.exposeInMainWorld('api', api)
