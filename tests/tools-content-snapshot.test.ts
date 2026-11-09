// The allow-list mechanism test's own set-equality assertion (served names
// vs TOOLS.map(name)) is structurally blind to a removal: both sides are
// derived from the same in-process TOOLS array in the same run, so a dropped
// tool disappears from both sides at once and the equality stays green.
// This file anchors on a committed snapshot instead -- a side that does not
// move when TOOLS does -- and symmetric-diffs it against the live array, so
// a removal fails by naming the missing tool and a legitimate addition fails
// by naming the fixture that needs a deliberate, reviewed update.

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOLS } from "../shared/peers-session.ts";

const snapshotNames: string[] = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "server-tools-snapshot.json"), "utf-8")
);

describe("server.ts TOOLS content vs its committed snapshot fixture", () => {
  test("a tool in the snapshot but absent from live TOOLS is a silent removal -- fails by name", () => {
    // Guards this test itself: an emptied snapshot would make `missing`
    // trivially [] and pass without asserting anything.
    expect(snapshotNames.length).toBeGreaterThan(0);
    const live = new Set(TOOLS.map((t) => t.name));
    const missing = snapshotNames.filter((n) => !live.has(n));
    expect(missing).toEqual([]);
  });

  test("a tool in live TOOLS but absent from the snapshot needs a deliberate snapshot update -- fails by name", () => {
    // Guards this test itself: an emptied live TOOLS would make `extra`
    // trivially [] and pass without asserting anything.
    expect(TOOLS.length).toBeGreaterThan(0);
    const snapshotSet = new Set(snapshotNames);
    const extra = TOOLS.map((t) => t.name).filter((n) => !snapshotSet.has(n));
    expect(extra).toEqual([]);
  });

  // A duplicate does not mask a real diff -- the missing/extra checks above
  // are symmetric and still bite via the OTHER side on a rename. This guards
  // readability instead: a human skim of this fixture's line count must not
  // be lied to about how many distinct tools it actually lists.
  test("the snapshot carries no duplicate name, so its entry count reads honestly", () => {
    const dupes = snapshotNames.filter((n, i) => snapshotNames.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });

  test("live TOOLS carries no duplicate name -- a duplicate would serve the same MCP tool twice over the wire", () => {
    expect(TOOLS.length).toBeGreaterThan(0);
    const liveNames = TOOLS.map((t) => t.name);
    const dupes = liveNames.filter((n, i) => liveNames.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });
});
