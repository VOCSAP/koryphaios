import { useEffect, useRef, useState } from 'react'
import type { AvatarViewApi, AvatarViewState } from '@shared/avatar-view'

// The whole drawn frame is a target; outside its rounded corners the window stays click-through.
export const AVATAR_HIT_SELECTOR = '.avatar-frame'
const AVATAR_CAPTURE_SELECTOR = '.avatar-root'

export type AvatarMoveMode = 'free' | 'locked' | 'dragging'

interface Gesture {
  pointerId: number
  element: Element
  grabX: number
  grabY: number
  last: { x: number; y: number } | null
  reported: boolean
}

interface Hover {
  sent: boolean | null
  blocked: boolean
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

/**
 * Main silently resets its pointer state on hide, re-preparation and a new
 * window, and publishes a newer view each time; the last sent value is
 * therefore forgotten on every newer view instead of being deduplicated
 * forever. Rejections are not classified: any one ends the gesture.
 */
export function usePointerGesture(api: AvatarViewApi, view: AvatarViewState | null): AvatarMoveMode {
  const viewRef = useRef(view)
  const hover = useRef<Hover>({ sent: null, blocked: false })
  const gesture = useRef<Gesture | null>(null)
  const [dragging, setDragging] = useState(false)

  const endGesture = (): void => {
    const current = gesture.current
    if (current === null) return
    gesture.current = null
    setDragging(false)
    try {
      if (current.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId)
    } catch (error) {
      if (current.reported) return
      current.reported = true
      api.reportError(`avatar pointer release failed: ${errorText(error)}`.slice(0, 2048))
    }
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
      if (event.button !== 0 || gesture.current !== null || !canMove(viewRef.current) || !onFace(event.target)) return
      // The face node is remounted on every face change, which would drop a capture held on it.
      const element = event.target.closest(AVATAR_CAPTURE_SELECTOR) ?? event.target
      try {
        element.setPointerCapture(event.pointerId)
      } catch (error) {
        api.reportError(`avatar pointer capture failed: ${errorText(error)}`.slice(0, 2048))
        return
      }
      event.preventDefault()
      gesture.current = { pointerId: event.pointerId, element, grabX: event.clientX, grabY: event.clientY, last: null, reported: false }
      setDragging(true)
    }
    const onPointerMove = (event: PointerEvent): void => {
      const current = gesture.current
      if (current === null || event.pointerId !== current.pointerId) return
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
      endGesture()
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
      gesture.current = null
    }
  }, [api])

  if (dragging) return 'dragging'
  return canMove(view) ? 'free' : 'locked'
}
