import { test, expect } from "bun:test";

// Card c8ee5732 -- the pasteable `peer_id = role` roster. Pure module, no
// electron and no `@shared/*` value import, so it loads under bun test from
// the repo root. Named `desktop-*` so the CI glob of
// .github/workflows/desktop-build.yml collects it (it spawns no daemon).
import { formatPeerTable } from "../desktop/src/renderer/src/peer-table.ts";

const YOU = "(you)";

test("aligns the equals signs on the longest peer id", () => {
  const out = formatPeerTable(
    [
      { peerId: "desktop-7b2civn-koryphaios-2", name: "team-lead" },
      { peerId: "desktop-7b2civn-koryphaios-12", name: "reviewer" },
    ],
    YOU,
  );
  const [first, second] = out.split("\n");
  expect(first).toBe("desktop-7b2civn-koryphaios-2   = team-lead");
  expect(second).toBe("desktop-7b2civn-koryphaios-12  = reviewer");
  // The point of the padding: every row's `=` sits at the same column.
  expect(first!.indexOf("=")).toBe(second!.indexOf("="));
});

test("marks the lead row, and only that one", () => {
  const out = formatPeerTable(
    [
      { peerId: "peer-1", name: "team-lead", lead: true },
      { peerId: "peer-2", name: "dev1" },
      { peerId: "peer-3", name: "dev2", lead: false },
    ],
    YOU,
  );
  expect(out.split("\n")).toEqual([
    "peer-1  = team-lead (you)",
    "peer-2  = dev1",
    "peer-3  = dev2",
  ]);
});

test("uses the marker it is given, never a hardcoded one", () => {
  const out = formatPeerTable([{ peerId: "peer-1", name: "team-lead", lead: true }], "(toi)");
  expect(out).toBe("peer-1  = team-lead (toi)");
});

test("drops the supervisor even when the caller forgot to filter it", () => {
  // The sidebar already filters `!supervisor`; this second filter is what keeps
  // the table right if a future caller passes the unfiltered store list.
  const out = formatPeerTable(
    [
      { peerId: "peer-0", name: "supervisor", supervisor: true },
      { peerId: "peer-1", name: "dev1" },
    ],
    YOU,
  );
  expect(out).toBe("peer-1  = dev1");
});

test("drops sessions still booting instead of emitting an empty left column", () => {
  const out = formatPeerTable(
    [
      { peerId: null, name: "starting" },
      { peerId: "peer-1", name: "dev1" },
    ],
    YOU,
  );
  expect(out).toBe("peer-1  = dev1");
  // Width comes from the rows that survive, not from the raw input.
  expect(out.startsWith("peer-1  =")).toBe(true);
});

test("returns the empty string when nothing is copyable", () => {
  expect(formatPeerTable([], YOU)).toBe("");
  expect(formatPeerTable([{ peerId: null, name: "starting" }], YOU)).toBe("");
  expect(formatPeerTable([{ peerId: "peer-0", name: "sup", supervisor: true }], YOU)).toBe("");
});

test("preserves the order it is given", () => {
  const out = formatPeerTable(
    [
      { peerId: "c", name: "third" },
      { peerId: "a", name: "first" },
      { peerId: "b", name: "second" },
    ],
    YOU,
  );
  expect(out.split("\n").map((l) => l.split(" = ")[1])).toEqual(["third", "first", "second"]);
});
