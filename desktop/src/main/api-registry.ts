// DeckApi handler registry (PLAN MB1): every ipcMain.handle/on registration in
// ipc.ts goes through here so the SAME handler table serves two transports —
// Electron IPC (the desktop window) and the companion WebSocket bridge
// (remote clients). Event emission mirrors this: `broadcast` fans a STATE
// event out to the window and every companion sink, while window-only events
// (menu:*, design:pick, session:focus, inbox:open) keep using
// mainWindow.webContents.send directly at their call sites.

import { ipcMain } from 'electron'

// The registered handlers keep their precise (event, ...typed args) shapes at
// their call sites; here we only need to store and re-dispatch them, so the
// stored type is deliberately loose (the Electron event is ignored by all of
// them, and the bridge validates channels before calling).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (event: any, ...args: any[]) => any

const invokeHandlers = new Map<string, AnyHandler>()
const sendHandlers = new Map<string, AnyHandler>()

/** Marker event passed to handlers invoked from the companion bridge (the
 * registered handlers all ignore their Electron event argument). */
const REMOTE_EVENT = Object.freeze({ remote: true })

export function regHandle(channel: string, fn: AnyHandler): void {
  invokeHandlers.set(channel, fn)
  ipcMain.handle(channel, fn)
}

export function regOn(channel: string, fn: AnyHandler): void {
  sendHandlers.set(channel, fn)
  ipcMain.on(channel, fn)
}

export function hasInvokeHandler(channel: string): boolean {
  return invokeHandlers.has(channel)
}

/** Invoke a handler on behalf of a remote client. Throws on unknown channel. */
export async function invokeRemote(channel: string, args: unknown[]): Promise<unknown> {
  const fn = invokeHandlers.get(channel)
  if (!fn) throw new Error(`unknown channel: ${channel}`)
  return await fn(REMOTE_EVENT, ...args)
}

/** Fire-and-forget from a remote client (pty:input & friends). */
export function sendRemote(channel: string, args: unknown[]): void {
  const fn = sendHandlers.get(channel)
  if (fn) void fn(REMOTE_EVENT, ...args)
}

// ----- state-event fan-out -----

export type EventSink = (channel: string, payload: unknown) => void

const sinks = new Set<EventSink>()

/** Register a delivery sink (the window, each companion client). */
export function addEventSink(sink: EventSink): () => void {
  sinks.add(sink)
  return () => {
    sinks.delete(sink)
  }
}

/** Emit a STATE event to every connected surface (window + remote clients). */
export function broadcast(channel: string, payload?: unknown): void {
  for (const sink of sinks) {
    try {
      sink(channel, payload)
    } catch {
      // One dead sink (closing socket, tearing window) must not break the
      // others; sinks own their error reporting.
    }
  }
}
