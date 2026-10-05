import { useEffect, useRef, useState } from 'react'
import type { AvatarViewApi, AvatarViewState } from '@shared/avatar-view'

export const AVATAR_HIT_SELECTOR = '.avatar-frame'
const AVATAR_CAPTURE_SELECTOR = '.avatar-root'
const DRAG_THRESHOLD_PX = 4
const DOUBLE_CLICK_DELAY_MS = 250

export type AvatarMoveMode = 'free' | 'locked' | 'dragging'

interface Gesture {
  pointerId: number
  element: Element
  grabX: number
  grabY: number
  last: { x: number; y: number } | null
  moved: boolean
  dragging: boolean
  reported: boolean
}

interface Hover {
  sent: boolean | null
  blocked: boolean
}

interface PendingClick {
  timer: ReturnType<typeof setTimeout> | null
}

function canMove(view: AvatarViewState | null): boolean {
  return view !== null && view.presentation.visible && !view.presentation.positionLocked
}

function onFace(target: EventTarget | null): target is Element {
  return target instanceof Element && target.closest(AVATAR_HIT_SELECTOR) !== null
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function usePointerGesture(api: AvatarViewApi, view: AvatarViewState | null): AvatarMoveMode {
  const viewRef = useRef(view)
  const hover = useRef<Hover>({ sent: null, blocked: false })
  const gesture = useRef<Gesture | null>(null)
  const pendingClick = useRef<PendingClick | null>(null)
  const [dragging, setDragging] = useState(false)

  const clearPendingClick = (): void => {
    const pending = pendingClick.current
    if (pending !== null && pending.timer !== null) clearTimeout(pending.timer)
    pendingClick.current = null
  }

  const sendGesture = (kind: 'single' | 'double'): void => {
    api.gesture(kind).catch((error: unknown) => {
      api.reportError(`avatar gesture rejected: ${errorText(error)}`.slice(0, 2048))
    })
  }

  const scheduleSingleClick = (): void => {
    const pending: PendingClick = { timer: null }
    pendingClick.current = pending
    queueMicrotask(() => {
      if (pendingClick.current !== pending) return
      pending.timer = setTimeout(() => {
        if (pendingClick.current !== pending) return
        pendingClick.current = null
        sendGesture('single')
      }, DOUBLE_CLICK_DELAY_MS)
    })
  }

  const endGesture = (): Gesture | null => {
    const current = gesture.current
    if (current === null) return null
    gesture.current = null
    setDragging(false)
    try {
      if (current.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId)
    } catch (error) {
      if (current.reported) return current
      current.reported = true
      api.reportError(`avatar pointer release failed: ${errorText(error)}`.slice(0, 2048))
    }
    return current
  }

  const sendHover = (target: EventTarget | null): void => {
    const current = viewRef.current
    if (current === null || !current.presentation.visible) return
    const state = hover.current
    const inside = onFace(target)
    if (state.blocked || state.sent === inside) return
    state.sent = inside
    api.setPointerInside(inside).catch((error: unknown) => {
      if (hover.current !== state) return
      state.sent = null
      state.blocked = true
      api.reportError(`avatar setPointerInside rejected: ${errorText(error)}`.slice(0, 2048))
    })
  }

  useEffect(() => {
    viewRef.current = view
    hover.current = { sent: null, blocked: false }
    if (view === null || !view.presentation.visible) clearPendingClick()
    if (gesture.current !== null && !canMove(view)) endGesture()
  }, [view])

  useEffect(() => {
    const doc = document

    const onMouseMove = (event: MouseEvent): void => {
      if (gesture.current !== null) return
      sendHover(event.target)
    }
    const onMouseLeave = (): void => {
      if (gesture.current !== null) return
      sendHover(null)
    }
    const onPointerDown = (event: PointerEvent): void => {
      const current = viewRef.current
      if (event.button !== 0 || gesture.current !== null || current === null || !current.presentation.visible || !onFace(event.target)) return
      const element = event.target.closest(AVATAR_CAPTURE_SELECTOR) ?? event.target
      try {
        element.setPointerCapture(event.pointerId)
      } catch (error) {
        api.reportError(`avatar pointer capture failed: ${errorText(error)}`.slice(0, 2048))
        return
      }
      event.preventDefault()
      gesture.current = {
        pointerId: event.pointerId,
        element,
        grabX: event.clientX,
        grabY: event.clientY,
        last: null,
        moved: false,
        dragging: false,
        reported: false
      }
    }
    const onPointerMove = (event: PointerEvent): void => {
      const current = gesture.current
      if (current === null || event.pointerId !== current.pointerId) return
      if (!current.moved) {
        const deltaX = event.clientX - current.grabX
        const deltaY = event.clientY - current.grabY
        if (deltaX * deltaX + deltaY * deltaY <= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return
        current.moved = true
        clearPendingClick()
        if (!canMove(viewRef.current)) return
        current.dragging = true
        setDragging(true)
      }
      if (!current.dragging) return
      const x = Math.round(event.screenX - current.grabX)
      const y = Math.round(event.screenY - current.grabY)
      if (current.last !== null && current.last.x === x && current.last.y === y) return
      current.last = { x, y }
      api.setPosition(x, y).catch((error: unknown) => {
        if (gesture.current === current) endGesture()
        if (current.reported) return
        current.reported = true
        api.reportError(`avatar setPosition rejected: ${errorText(error)}`.slice(0, 2048))
      })
    }
    const onPointerEnd = (event: PointerEvent): void => {
      const current = gesture.current
      if (current === null || event.pointerId !== current.pointerId) return
      const ended = endGesture()
      if (event.type === 'pointerup' && ended !== null && !ended.moved) {
        if (pendingClick.current === null) scheduleSingleClick()
        else {
          clearPendingClick()
          sendGesture('double')
        }
      } else {
        clearPendingClick()
      }
      sendHover(doc.elementFromPoint(event.clientX, event.clientY))
    }

    doc.addEventListener('mousemove', onMouseMove)
    doc.documentElement.addEventListener('mouseleave', onMouseLeave)
    doc.addEventListener('pointerdown', onPointerDown)
    doc.addEventListener('pointermove', onPointerMove)
    doc.addEventListener('pointerup', onPointerEnd)
    doc.addEventListener('pointercancel', onPointerEnd)
    doc.addEventListener('lostpointercapture', onPointerEnd)
    return () => {
      doc.removeEventListener('mousemove', onMouseMove)
      doc.documentElement.removeEventListener('mouseleave', onMouseLeave)
      doc.removeEventListener('pointerdown', onPointerDown)
      doc.removeEventListener('pointermove', onPointerMove)
      doc.removeEventListener('pointerup', onPointerEnd)
      doc.removeEventListener('pointercancel', onPointerEnd)
      doc.removeEventListener('lostpointercapture', onPointerEnd)
      clearPendingClick()
      gesture.current = null
    }
  }, [api])

  if (dragging) return 'dragging'
  return canMove(view) ? 'free' : 'locked'
}
