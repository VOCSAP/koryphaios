import type { AvatarScreenPosition, AvatarSize, AvatarWorkArea } from './avatar-appearance'

export interface AvatarDisplay {
  id: string
  workArea: AvatarWorkArea
}

export interface AvatarWindowSize {
  width: number
  height: number
}

export const AVATAR_WINDOW_SIZES: Readonly<Record<AvatarSize, AvatarWindowSize>> = {
  s: { width: 120, height: 120 },
  m: { width: 160, height: 160 },
  l: { width: 220, height: 220 }
}

export interface AvatarPlacement extends AvatarWindowSize {
  x: number
  y: number
}

export interface RestoredAvatarPlacement extends AvatarPlacement {
  screenId: string
}

export function clampAvatarPlacement(
  position: { x: number; y: number },
  workArea: AvatarWorkArea,
  requestedSize: AvatarWindowSize
): AvatarPlacement {
  const width = Math.min(requestedSize.width, workArea.width)
  const height = Math.min(requestedSize.height, workArea.height)
  const maxX = workArea.x + workArea.width - width
  const maxY = workArea.y + workArea.height - height
  return {
    x: Math.min(Math.max(position.x, workArea.x), maxX),
    y: Math.min(Math.max(position.y, workArea.y), maxY),
    width,
    height
  }
}

function centerIn(workArea: AvatarWorkArea, size: AvatarWindowSize): { x: number; y: number } {
  return {
    x: workArea.x + (workArea.width - size.width) / 2,
    y: workArea.y + (workArea.height - size.height) / 2
  }
}

export function restoreAvatarPlacement(
  displays: readonly AvatarDisplay[],
  positions: Readonly<Record<string, AvatarScreenPosition>>,
  requestedSize: AvatarWindowSize
): RestoredAvatarPlacement {
  const selected = displays.find((display) => positions[display.id] !== undefined) ?? displays[0]
  if (!selected) throw new Error('Avatar placement requires an available display')
  const saved = positions[selected.id]
  const position = saved ? { x: saved.x, y: saved.y } : centerIn(selected.workArea, requestedSize)
  return { screenId: selected.id, ...clampAvatarPlacement(position, selected.workArea, requestedSize) }
}
