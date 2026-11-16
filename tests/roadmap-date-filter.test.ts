import { expect, test } from "bun:test";
import { resolveRoadmapDateFilter } from "../shared/roadmap-date-filter.ts";

const NOW = new Date("2026-11-16T12:00:00.000Z");

function window(raw: unknown, now: Date = NOW) {
  const res = resolveRoadmapDateFilter(raw, now);
  if (!res.ok) throw new Error(`expected a window, got: ${res.error}`);
  return res.window;
}

function refusal(raw: unknown, now: Date = NOW): string {
  const res = resolveRoadmapDateFilter(raw, now);
  if (res.ok) throw new Error(`expected a refusal, got ${JSON.stringify(res.window)}`);
  return res.error;
}

test("each axis reads its own column, never updated_at", () => {
  expect(window({ field: "created", since: "2026-01-01T00:00:00Z" }).column).toBe("created_at");
  expect(window({ field: "updated", since: "2026-01-01T00:00:00Z" }).column).toBe("content_updated_at");
});

test("an absolute bound with Z or an explicit offset becomes a UTC instant", () => {
  expect(window({ field: "created", since: "2026-11-16T12:00:00Z" }).sinceIso).toBe("2026-11-16T12:00:00.000Z");
  expect(window({ field: "created", since: "2026-11-16T12:00:00+02:00" }).sinceIso).toBe("2026-11-16T10:00:00.000Z");
  expect(window({ field: "created", since: "2026-11-16T12:00:00-05:30" }).sinceIso).toBe("2026-11-16T17:30:00.000Z");
  expect(window({ field: "created", since: "2026-11-16T12:00Z" }).sinceIso).toBe("2026-11-16T12:00:00.000Z");
  expect(window({ field: "created", since: "2026-11-16T12:00:00.250Z" }).sinceIso).toBe("2026-11-16T12:00:00.250Z");
  expect(window({ field: "created", before: "2024-02-29T00:00:00Z" }).beforeIso).toBe("2024-02-29T00:00:00.000Z");
});

test("a bound without a time zone, or not a real instant, is refused", () => {
  const bad = [
    "2026-11-16",
    "2026-11-16T12:00:00",
    "2026-11-16 12:00:00Z",
    "2026-11-16T12:00:00+0200",
    "2026-02-30T00:00:00Z",
    "2025-02-29T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-00-10T00:00:00Z",
    "2026-11-00T00:00:00Z",
    "2026-11-16T24:00:00Z",
    "2026-11-16T12:60:00Z",
    "2026-11-16T12:00:60Z",
    "2026-11-16T12:00:00+24:00",
    "2026-11-16T12:00:00+01:60",
    "0000-01-01T00:00:00Z",
    "yesterday",
    "NaN",
    "Infinity",
  ];
  for (const since of bad) expect(() => window({ field: "created", since }), `refused: ${since}`).toThrow();
});

test("relative bounds count back from the injected clock", () => {
  expect(window({ field: "created", since: "24h" }).sinceIso).toBe("2026-11-15T12:00:00.000Z");
  expect(window({ field: "created", since: "7d" }).sinceIso).toBe("2026-11-09T12:00:00.000Z");
  expect(window({ field: "created", since: "2w" }).sinceIso).toBe("2026-11-02T12:00:00.000Z");
  expect(window({ field: "created", since: "1h" }).sinceIso).toBe("2026-11-16T11:00:00.000Z");
});

test("a relative bound that is zero, fractional, signed, in another unit or out of range is refused", () => {
  for (const since of ["0h", "-1d", "+1d", "1.5h", "5m", "1e3h", "10d ", " 10d", "999999999w", "10000000000h", "d", "h1"]) {
    expect(() => window({ field: "created", since }), `refused: ${since}`).toThrow();
  }
});

test("both relative bounds come from ONE read of the clock", () => {
  let reads = 0;
  const base = NOW.getTime();
  const ticking = { getTime: () => base + 1000 * reads++ } as unknown as Date;
  const w = window({ field: "created", since: "2d", before: "1d" }, ticking);
  expect(Date.parse(w.beforeIso!) - Date.parse(w.sinceIso!)).toBe(86_400_000);
  expect(reads).toBe(1);
});

test("an interval needs at least one bound, and since must come strictly before before", () => {
  expect(refusal({ field: "created" })).toContain("at least one");
  expect(window({ field: "created", before: "2026-11-16T12:00:00Z" })).toEqual({
    column: "created_at",
    sinceIso: null,
    beforeIso: "2026-11-16T12:00:00.000Z",
  });
  expect(refusal({ field: "created", since: "2026-11-16T12:00:00Z", before: "2026-11-16T12:00:00Z" })).toContain("earlier");
  expect(refusal({ field: "created", since: "2026-11-17T00:00:00Z", before: "2026-11-16T00:00:00Z" })).toContain("earlier");
  expect(refusal({ field: "created", since: "1d", before: "2d" })).toContain("earlier");
  expect(refusal({ field: "created", since: "2026-11-16T14:00:00+02:00", before: "2026-11-16T12:00:00Z" })).toContain("earlier");
  expect(window({ field: "created", since: "2026-11-16T00:00:00Z", before: "2026-11-16T00:00:00.001Z" }).sinceIso).toBe(
    "2026-11-16T00:00:00.000Z"
  );
});

test("a malformed object, axis or bound type is refused", () => {
  const bad: unknown[] = [
    undefined,
    null,
    "created",
    42,
    [],
    [{ field: "created", since: "1d" }],
    {},
    { since: "1d" },
    { field: "updated_at", since: "1d" },
    { field: "toString", since: "1d" },
    { field: "constructor", since: "1d" },
    { field: "__proto__", since: "1d" },
    { field: 1, since: "1d" },
    { field: "created", since: 5 },
    { field: "created", since: null },
    { field: "created", since: "" },
    { field: "created", since: ["1d"] },
    { field: "created", since: NaN },
    { field: "created", before: Number.POSITIVE_INFINITY },
    { field: "created", since: "1d", until: "2d" },
  ];
  for (const raw of bad) expect(() => window(raw), `refused: ${JSON.stringify(raw)}`).toThrow();
});
