import { contentEquals } from "./roadmap-sync.ts";
import { ROADMAP_CHANGE_ORIGINS, type RoadmapChangeOrigin, type RoadmapSyncContent } from "./types.ts";

/**
 * Only the exact `toISOString()` form of a real instant is trusted. The round
 * trip is what rejects an impossible day, which `Date` accepts by rolling it
 * over into the next month.
 */
export function readContentDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString() === raw ? raw : null;
}

/** Compares the RESULT of a write, never which body keys were present. */
export function contentDateAfterWrite(
  before: RoadmapSyncContent,
  after: RoadmapSyncContent,
  kept: string | null,
  now: string
): string | null {
  return contentEquals(before, after) ? kept : now;
}

/**
 * The date that travels with content taken from another broker: the local one
 * when the content is unchanged here (a carried date on identical content
 * would move the date without any work), else the carried one, null when the
 * wire had none. Never `now`.
 */
export function adoptedContentDate(carried: string | null, sameContent: boolean, local: string | null): string | null {
  return sameContent ? local : carried;
}

// `auth` and `public_key` are the fields the Deck's operator signature adds;
// `project_key` is ignored by a patch, and the Deck sends it on every upsert.
const CHANGE_ORIGIN_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "id",
  "project_key",
  "by",
  "status",
  "locked",
  "change_origin",
  "auth",
  "public_key",
]);

/**
 * Null when the body has no marker or carries it legitimately: operator-signed,
 * naming a card, releasing its lock and moving status at most to planned. Any
 * other key is a content edit that the marker must not be able to hide.
 */
export function changeOriginRefusal(body: Record<string, unknown>, operatorProven: boolean): string | null {
  if (body.change_origin === undefined) return null;
  if (!ROADMAP_CHANGE_ORIGINS.includes(body.change_origin as RoadmapChangeOrigin)) {
    return `invalid change_origin (${ROADMAP_CHANGE_ORIGINS.join("|")})`;
  }
  if (!operatorProven) return "change_origin requires an operator-signed write";
  if (typeof body.id !== "string" || body.id === "") return "change_origin requires an existing card id";
  for (const key of Object.keys(body)) {
    if (!CHANGE_ORIGIN_ALLOWED_KEYS.has(key)) {
      return `change_origin only accompanies a lock release: '${key}' is not allowed with it`;
    }
  }
  if (body.locked !== false) return "change_origin requires locked: false";
  if (body.status !== "planned") return "change_origin only accompanies a release to planned";
  return null;
}
