import { test, expect } from "bun:test";

// Pure module (no @xterm/xterm import -- structural buffer types), imports
// cleanly under bun. Covers wrapped-line joining, offset -> (row, col) mapping,
// repaint dedupe, and the jump-time closest-match relocation.
import {
  searchBuffer,
  findClosestMatch,
  MIN_QUERY_LENGTH,
  type BufferLike,
} from "../desktop/src/renderer/src/search-core.ts";

/** Build a BufferLike from physical rows. `wrapped` marks a continuation row. */
function fakeBuffer(rows: { text: string; wrapped?: boolean }[]): BufferLike {
  return {
    length: rows.length,
    getLine(y: number) {
      const r = rows[y];
      if (!r) return undefined;
      return {
        isWrapped: r.wrapped === true,
        translateToString(trimRight?: boolean) {
          return trimRight ? r.text.replace(/\s+$/, "") : r.text;
        },
      };
    },
  };
}

// ----- basic matching -----

test("finds a match on a single row with correct position", () => {
  const buf = fakeBuffer([{ text: "hello peers world" }]);
  const hits = searchBuffer(buf, "peers");
  expect(hits).toHaveLength(1);
  expect(hits[0]).toMatchObject({ row: 0, col: 6, length: 5, lineText: "hello peers world", matchIndex: 6 });
});

test("matching is case-insensitive", () => {
  const buf = fakeBuffer([{ text: "Hello PEERS" }]);
  expect(searchBuffer(buf, "peers")).toHaveLength(1);
  expect(searchBuffer(buf, "HELLO")).toHaveLength(1);
});

test("query shorter than MIN_QUERY_LENGTH returns nothing", () => {
  const buf = fakeBuffer([{ text: "aaaa" }]);
  expect(MIN_QUERY_LENGTH).toBe(2);
  expect(searchBuffer(buf, "a")).toHaveLength(0);
  expect(searchBuffer(buf, " a ")).toHaveLength(0); // trimmed length counts
});

test("multiple matches within one logical line are all reported", () => {
  const buf = fakeBuffer([{ text: "foo bar foo baz foo" }]);
  const hits = searchBuffer(buf, "foo");
  expect(hits.map((h) => h.col)).toEqual([0, 8, 16]);
});

test("matchIndex is relative to the trimmed line text", () => {
  const buf = fakeBuffer([{ text: "    indented foo" }]);
  const hits = searchBuffer(buf, "foo");
  expect(hits[0]!.lineText).toBe("indented foo");
  expect(hits[0]!.matchIndex).toBe(9);
  expect(hits[0]!.col).toBe(13); // buffer column still counts the indent
});

// ----- wrapped-line joining -----

test("finds a phrase spanning a wrap boundary", () => {
  // Logical line "hello wonderful peers" wrapped after 10 cols.
  const buf = fakeBuffer([
    { text: "hello wond" },
    { text: "erful peer", wrapped: true },
    { text: "s of code", wrapped: true },
  ]);
  const hits = searchBuffer(buf, "wonderful peers");
  expect(hits).toHaveLength(1);
  expect(hits[0]!.row).toBe(0);
  expect(hits[0]!.col).toBe(6);
  expect(hits[0]!.lineText).toBe("hello wonderful peers of code");
});

test("a match inside a continuation row maps to that physical row", () => {
  const buf = fakeBuffer([
    { text: "0123456789" },
    { text: "abcdEFGHij", wrapped: true },
  ]);
  const hits = searchBuffer(buf, "efgh");
  expect(hits).toHaveLength(1);
  expect(hits[0]!.row).toBe(1);
  expect(hits[0]!.col).toBe(4);
});

test("non-final wrapped rows keep trailing blanks so columns stay aligned", () => {
  // Row 0 ends with spaces that are part of the logical line's cell grid.
  const buf = fakeBuffer([
    { text: "padded    " },
    { text: "target", wrapped: true },
  ]);
  const hits = searchBuffer(buf, "target");
  expect(hits).toHaveLength(1);
  expect(hits[0]!.row).toBe(1);
  expect(hits[0]!.col).toBe(0);
});

// ----- repaint dedupe -----

test("dedupes a line identical to the previous hit's line (TUI repaints)", () => {
  const rows = [
    { text: "✓ build passed" },
    { text: "✓ build passed" },
    { text: "✓ build passed" },
    { text: "something else passed" },
  ];
  const hits = searchBuffer(fakeBuffer(rows), "passed");
  expect(hits).toHaveLength(2);
  expect(hits[0]!.row).toBe(0);
  expect(hits[1]!.row).toBe(3);
});

test("dedupe can be disabled", () => {
  const rows = [{ text: "same hit" }, { text: "same hit" }];
  expect(searchBuffer(fakeBuffer(rows), "hit", { dedupe: false })).toHaveLength(2);
});

test("distinct interleaved lines are not deduped", () => {
  const rows = [{ text: "alpha hit" }, { text: "beta hit" }, { text: "alpha hit" }];
  // Only strictly-consecutive identical hit lines collapse.
  expect(searchBuffer(fakeBuffer(rows), "hit")).toHaveLength(3);
});

// ----- caps -----

test("maxMatches caps the result count", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ text: `line ${i} hit` }));
  expect(searchBuffer(fakeBuffer(rows), "hit", { maxMatches: 7 })).toHaveLength(7);
});

// ----- findClosestMatch -----

test("findClosestMatch picks the occurrence nearest the remembered row", () => {
  const rows = [
    { text: "needle" },
    { text: "filler" },
    { text: "filler" },
    { text: "needle" },
    { text: "filler" },
    { text: "needle" },
  ];
  const buf = fakeBuffer(rows);
  expect(findClosestMatch(buf, "needle", 4)?.row).toBe(3);
  expect(findClosestMatch(buf, "needle", 0)?.row).toBe(0);
  expect(findClosestMatch(buf, "needle", 99)?.row).toBe(5);
});

test("findClosestMatch returns null when the text is gone", () => {
  expect(findClosestMatch(fakeBuffer([{ text: "nothing here" }]), "needle", 0)).toBeNull();
});
