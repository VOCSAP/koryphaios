import { contextBridge, ipcRenderer } from 'electron'
import { AVATAR_VIEW_CHANNELS, type AvatarViewApi, type AvatarViewState } from '../shared/avatar-view'

const api: AvatarViewApi = {
  getState: () => ipcRenderer.invoke(AVATAR_VIEW_CHANNELS.getState) as Promise<AvatarViewState>,
  onState(callback) {
    const listener = (_event: Electron.IpcRendererEvent, state: AvatarViewState): void => {
      callback(state)
    }
    ipcRenderer.on(AVATAR_VIEW_CHANNELS.state, listener)
    return () => { ipcRenderer.removeListener(AVATAR_VIEW_CHANNELS.state, listener) }
  },
  setPosition: (x, y) => ipcRenderer.invoke(AVATAR_VIEW_CHANNELS.setPosition, x, y) as Promise<void>,
  setPointerInside: (inside) => ipcRenderer.invoke(AVATAR_VIEW_CHANNELS.setPointerInside, inside) as Promise<void>,
  gesture: (kind) => ipcRenderer.invoke(AVATAR_VIEW_CHANNELS.gesture, kind) as Promise<void>,
  reportError(message) {
    void ipcRenderer.invoke(AVATAR_VIEW_CHANNELS.reportError, message)
  }
}

contextBridge.exposeInMainWorld('api', api)
