import type { RoadmapDateField } from "./types.ts";

const COLUMNS: Readonly<Record<RoadmapDateField, "created_at" | "content_updated_at">> = {
  created: "created_at",
  updated: "content_updated_at",
};

export type RoadmapDateWindow = {
  column: "created_at" | "content_updated_at";
  sinceIso: string | null;
  beforeIso: string | null;
};

export type RoadmapDateResolution = { ok: true; window: RoadmapDateWindow } | { ok: false; error: string };

const MIN_MS = Date.parse("0001-01-01T00:00:00.000Z");
const MAX_MS = Date.parse("9999-12-31T23:59:59.999Z");
const UNIT_MS = { h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;
const RELATIVE = /^(\d{1,9})([hdw])$/;
const ABSOLUTE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-](\d{2}):(\d{2}))$/;

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  return [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

// Relative bounds share one injected clock read.
function resolveBound(raw: string, name: string, nowMs: number): { ms: number } | { error: string } {
  const relative = RELATIVE.exec(raw);
  if (relative) {
    const count = Number(relative[1]);
    const ms = nowMs - count * UNIT_MS[relative[2] as keyof typeof UNIT_MS];
    if (count < 1 || !Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS) {
      return { error: `${name} is a relative duration out of range` };
    }
    return { ms };
  }
  const absolute = ABSOLUTE.exec(raw);
  if (!absolute) {
    return { error: `${name} must be an ISO date with Z or an explicit offset, or a relative Nh/Nd/Nw` };
  }
  const [, y, mo, d, h, mi, s, , offH, offM] = absolute;
  const year = Number(y);
  const month = Number(mo);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    Number(d) < 1 ||
    Number(d) > daysInMonth(year, month) ||
    Number(h) > 23 ||
    Number(mi) > 59 ||
    (s !== undefined && Number(s) > 59) ||
    (offH !== undefined && (Number(offH) > 23 || Number(offM) > 59))
  ) {
    return { error: `${name} is not a valid calendar date` };
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS) {
    return { error: `${name} is out of the representable range` };
  }
  return { ms };
}

// The closed map keeps column names out of caller control.
export function resolveRoadmapDateFilter(raw: unknown, now: Date): RoadmapDateResolution {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "date must be an object { field, since?, before? }" };
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "field" && key !== "since" && key !== "before") {
      return { ok: false, error: `date has an unknown key '${key}'` };
    }
  }
  const field = record.field;
  if (typeof field !== "string" || !Object.hasOwn(COLUMNS, field)) {
    return { ok: false, error: "date.field must be 'created' or 'updated'" };
  }
  const nowMs = now.getTime();
  const bounds: Record<"since" | "before", number | null> = { since: null, before: null };
  for (const name of ["since", "before"] as const) {
    const value = record[name];
    if (value === undefined) continue;
    if (typeof value !== "string") return { ok: false, error: `date.${name} must be a string` };
    const resolved = resolveBound(value, `date.${name}`, nowMs);
    if ("error" in resolved) return { ok: false, error: resolved.error };
    bounds[name] = resolved.ms;
  }
  if (bounds.since === null && bounds.before === null) {
    return { ok: false, error: "date needs at least one of since or before" };
  }
  if (bounds.since !== null && bounds.before !== null && bounds.since >= bounds.before) {
    return { ok: false, error: "date.since must be earlier than date.before" };
  }
  return {
    ok: true,
    window: {
      column: COLUMNS[field as RoadmapDateField],
      sinceIso: bounds.since === null ? null : new Date(bounds.since).toISOString(),
      beforeIso: bounds.before === null ? null : new Date(bounds.before).toISOString(),
    },
  };
}
