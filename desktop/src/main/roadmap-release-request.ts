import type { RoadmapUpsertFields } from '../shared/types'
import { lockReleasePatch } from './idle-lock'

export function operatorStopRequest(item: { id: string; status: string }): RoadmapUpsertFields {
  return lockReleasePatch(item)
}

// The broker honours the marker only on a status change to planned, so a card
// that is not in_progress sends its bare lock release.
export function idleSweepRequest(item: { id: string; status: string }): RoadmapUpsertFields {
  const patch = lockReleasePatch(item)
  return item.status === 'in_progress' ? { ...patch, change_origin: 'idle_lock_sweep' } : patch
}
