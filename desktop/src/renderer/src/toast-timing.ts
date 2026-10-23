export type ToastVariant = 'success' | 'info' | 'error'

export const TOAST_ACTION_MS = 10_000

/**
 * An error toast reports a direct action that did NOT happen (a blocked Save
 * leaves the draft untouched), so it must outlast a glance away from the
 * screen; a confirmation only needs to be noticed.
 */
export const TOAST_MS: Readonly<Record<ToastVariant, number>> = {
  success: 3000,
  info: 3000,
  error: 8000
}
