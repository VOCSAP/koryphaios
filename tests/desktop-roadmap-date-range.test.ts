import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// A civil day is only distinguishable from "24 hours" under a zone with DST,
// so the whole file runs under Europe/Paris whatever the host zone is.
const previousTz = process.env.TZ;
process.env.TZ = "Europe/Paris";

const {
  classifyDateFilter,
  customDateFilter,
  parseLocalDay,
  presetDateFilter,
  todayRange,
} = await import("../desktop/src/renderer/src/roadmap-date-range.ts");

beforeAll(() => {
  process.env.TZ = "Europe/Paris";
});

afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
});

describe("todayRange: the civil day, never the last 24 hours", () => {
  test("the zone really is Europe/Paris (otherwise every case below proves nothing)", () => {
    expect(new Date("2026-07-01T12:00:00Z").getTimezoneOffset()).toBe(-120);
    expect(new Date("2026-01-01T12:00:00Z").getTimezoneOffset()).toBe(-60);
  });

  test("an ordinary day runs from local midnight to the next local midnight", () => {
    const now = new Date("2026-11-16T13:45:00Z");
    expect(todayRange(now)).toEqual({
      since: "2026-11-15T23:00:00.000Z",
      before: "2026-11-16T23:00:00.000Z",
    });
  });

  test("just after local midnight still names the new day, not a window reaching into yesterday", () => {
    const now = new Date("2026-11-15T23:05:00Z");
    expect(todayRange(now).since).toBe("2026-11-15T23:00:00.000Z");
  });

  test("the spring-forward day lasts 23 hours", () => {
    const r = todayRange(new Date("2026-03-29T10:00:00Z"));
    expect(r).toEqual({ since: "2026-03-28T23:00:00.000Z", before: "2026-03-29T22:00:00.000Z" });
  });

  test("the fall-back day lasts 25 hours", () => {
    const r = todayRange(new Date("2026-10-25T10:00:00Z"));
    expect(r).toEqual({ since: "2026-10-24T22:00:00.000Z", before: "2026-10-25T23:00:00.000Z" });
  });
});

describe("presetDateFilter", () => {
  test("Today pins the civil day on the chosen field", () => {
    const f = presetDateFilter("created", "today", new Date("2026-11-16T13:45:00Z"));
    expect(f).toEqual({ field: "created", since: "2026-11-15T23:00:00.000Z", before: "2026-11-16T23:00:00.000Z" });
  });

  test("rolling presets are relative durations on the chosen field, with no upper bound", () => {
    expect(presetDateFilter("updated", "7d", new Date())).toEqual({ field: "updated", since: "7d" });
    expect(presetDateFilter("created", "30d", new Date())).toEqual({ field: "created", since: "30d" });
  });
});

describe("parseLocalDay", () => {
  test("refuses text that is not a calendar day", () => {
    for (const bad of ["", "2026-2-03", "16/11/2026", "2026-13-01", "2026-02-30", "2026-04-31", "2026-11-16T00:00"]) {
      expect(parseLocalDay(bad)).toBeNull();
    }
  });

  test("accepts a leap day and returns its local midnight", () => {
    expect(parseLocalDay("2028-02-29")?.toISOString()).toBe("2028-02-28T23:00:00.000Z");
  });
});

describe("customDateFilter: the last day is included", () => {
  test("a one-day range ends at the next local midnight, across a DST change", () => {
    const r = customDateFilter("updated", "2026-10-25", "2026-10-25");
    expect(r).toEqual({
      ok: true,
      filter: { field: "updated", since: "2026-10-24T22:00:00.000Z", before: "2026-10-25T23:00:00.000Z" },
    });
  });

  test("one bound alone gives a one-sided filter", () => {
    expect(customDateFilter("created", "2026-11-01", "")).toEqual({
      ok: true,
      filter: { field: "created", since: "2026-10-31T23:00:00.000Z" },
    });
    expect(customDateFilter("created", "", "2026-11-01")).toEqual({
      ok: true,
      filter: { field: "created", before: "2026-11-01T23:00:00.000Z" },
    });
  });

  test("refuses an empty, malformed or reversed range", () => {
    expect(customDateFilter("created", " ", "")).toEqual({ ok: false, reason: "empty" });
    expect(customDateFilter("created", "2026-02-30", "")).toEqual({ ok: false, reason: "format" });
    expect(customDateFilter("created", "2026-11-10", "2026-11-09")).toEqual({ ok: false, reason: "order" });
  });
});

describe("classifyDateFilter", () => {
  const now = new Date("2026-11-16T13:45:00Z");

  test("recognises each preset", () => {
    expect(classifyDateFilter(presetDateFilter("created", "today", now), now)).toEqual({ kind: "preset", preset: "today" });
    expect(classifyDateFilter({ field: "created", since: "7d" }, now)).toEqual({ kind: "preset", preset: "7d" });
    expect(classifyDateFilter({ field: "updated", since: "30d" }, now)).toEqual({ kind: "preset", preset: "30d" });
  });

  test("a Today applied yesterday reads as its explicit day", () => {
    const yesterday = presetDateFilter("created", "today", new Date("2026-11-15T13:45:00Z"));
    expect(classifyDateFilter(yesterday, now)).toEqual({ kind: "range", from: "2026-11-15", through: "2026-11-15" });
  });

  test("a custom range reads back as the days that were typed", () => {
    const r = customDateFilter("created", "2026-03-01", "2026-03-29");
    if (!r.ok) throw new Error("fixture range refused");
    expect(classifyDateFilter(r.filter, now)).toEqual({ kind: "range", from: "2026-03-01", through: "2026-03-29" });
  });
});
