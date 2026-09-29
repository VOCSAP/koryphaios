// Upper bound of a roadmap card title, shared by every broker door that writes
// one. Pure module, no I/O.

/**
 * UTF-16 code units (String.length) after trim. A title above the bound is refused,
 * never truncated: a truncated title is not the one its author wrote.
 */
export const ROADMAP_TITLE_MAX = 300;

/** The refusal message for an already-trimmed title, or null when it fits. */
export function roadmapTitleRefusal(title: string): string | null {
  return title.length > ROADMAP_TITLE_MAX
    ? `title exceeds ${ROADMAP_TITLE_MAX} UTF-16 code units (${title.length})`
    : null;
}
