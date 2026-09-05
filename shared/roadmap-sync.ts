/**
 * Pure helpers for the roadmap replication (no bun/node imports): the content
 * snapshot the replica stores as its merge base, the comparison that decides
 * whether two sides diverged, and the three-way merge behind the
 * `merge_reopen` resolution.
 */

import {
  ROADMAP_SYNC_CONTENT_FIELDS,
  type RoadmapSyncContent,
  type RoadmapSyncContentField,
  type RoadmapStatus,
} from "./types.ts";

/**
 * Explicit object literal, not a loop over ROADMAP_SYNC_CONTENT_FIELDS: the
 * literal is checked against RoadmapSyncContent, so a field added to the
 * content contract is a COMPILE error here rather than a snapshot that
 * silently stops carrying it (and a column that is not content can never slip
 * in through a spread).
 */
export function pickSyncContent(item: RoadmapSyncContent): RoadmapSyncContent {
  return {
    kind: item.kind,
    title: item.title,
    description: item.description,
    rationale: item.rationale,
    context: item.context,
    priority: item.priority,
    value: item.value,
    effort: item.effort,
    status: item.status,
    tags: [...item.tags],
    depends_on: [...item.depends_on],
    deleted_at: item.deleted_at,
    directive: item.directive,
    target_peer_ids: [...item.target_peer_ids],
    inactive: item.inactive,
  };
}

/** Order-sensitive list equality; tags/depends_on/target_peer_ids are stored as ordered JSON arrays. */
function listEquals(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function fieldEquals(
  field: RoadmapSyncContentField,
  a: RoadmapSyncContent,
  b: RoadmapSyncContent
): boolean {
  switch (field) {
    case "tags":
      return listEquals(a.tags, b.tags);
    case "depends_on":
      return listEquals(a.depends_on, b.depends_on);
    case "target_peer_ids":
      return listEquals(a.target_peer_ids, b.target_peer_ids);
    default:
      return a[field] === b[field];
  }
}

export function contentEquals(a: RoadmapSyncContent, b: RoadmapSyncContent): boolean {
  return ROADMAP_SYNC_CONTENT_FIELDS.every((f) => fieldEquals(f, a, b));
}

/**
 * Three-way merge, field by field: the side that moved away from the base
 * wins, and when BOTH moved the local side wins (the operator asking for this
 * resolution sits on the replica). A null base means the card has no common
 * ancestor, so every field counts as locally changed.
 *
 * The reopen half is deliberate and not field-wise: a card closed on one side
 * and enriched on the other is exactly the case this resolution exists for, so
 * the merged card comes back OPEN -- 'in_progress' if either side was working
 * on it, 'planned' otherwise -- and its archive stamp is cleared.
 */
export function mergeReopen(
  base: RoadmapSyncContent | null,
  local: RoadmapSyncContent,
  remote: RoadmapSyncContent
): RoadmapSyncContent {
  const merged = pickSyncContent(local);
  for (const field of ROADMAP_SYNC_CONTENT_FIELDS) {
    const localChanged = base === null || !fieldEquals(field, local, base);
    if (!localChanged) {
      // Assigning through a narrowed union member at a computed key is the one
      // place TS cannot follow the field-to-value pairing; the pick above
      // guarantees both sides carry exactly the same shape.
      (merged as Record<string, unknown>)[field] = (remote as Record<string, unknown>)[field];
    }
  }
  const reopened: RoadmapStatus =
    local.status === "in_progress" || remote.status === "in_progress" ? "in_progress" : "planned";
  merged.status = reopened;
  merged.deleted_at = null;
  return merged;
}

/**
 * Parse a stored `sync_base`/`sync_remote` JSON blob back into a content
 * snapshot. Returns null on anything that is not a complete snapshot rather
 * than a partially-filled object: a half-read base would make mergeReopen
 * compare against fields that were never written.
 */
export function parseSyncContent(raw: string | null): RoadmapSyncContent | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  for (const field of ROADMAP_SYNC_CONTENT_FIELDS) {
    if (!(field in record)) return null;
  }
  // The three list fields are checked for shape, not just presence: pickSyncContent
  // copies them with a spread, which throws on a non-iterable.
  for (const field of ["tags", "depends_on", "target_peer_ids"] as const) {
    if (!Array.isArray(record[field])) return null;
  }
  return pickSyncContent(record as unknown as RoadmapSyncContent);
}
