export interface PendingHydrationIo<A> {
  list(): Promise<A[]>
  apply(list: A[]): void
  takeDeepLink(): string | null
  open(approvalId: string): void
  report(text: string, err: unknown): void
}

/**
 * Reads the pending approvals once, then opens the Courrier on a deep-linked
 * request. The seed is set only AFTER the list: the Courrier consumes a seed
 * on its first render, so a seed that arrives before its row selects nothing.
 * A failed read still opens the Courrier, without a selection.
 */
export async function hydratePendingApprovals<A>(io: PendingHydrationIo<A>): Promise<void> {
  try {
    io.apply(await io.list())
  } catch (e) {
    io.report('pending approvals read failed: the Courrier waits for the next change', e)
  }
  const approvalId = io.takeDeepLink()
  if (approvalId) io.open(approvalId)
}
