// CT3: directive card pure helpers (desktop/src/main/directive) — command
// mapping, enum re-validation, and target resolution against live sessions.

import { test, expect } from "bun:test";
import {
  DIRECTIVE_KEYS,
  directiveKeys,
  isDirectiveCommand,
  resolveDirectiveTargets
} from "../desktop/src/main/directive.ts";
import type { SessionRuntime } from "../desktop/src/shared/types";

function sess(over: Partial<SessionRuntime>): SessionRuntime {
  return {
    id: over.id ?? "tile-x",
    peerId: over.peerId ?? null,
    status: over.status ?? "running",
    ...over
  } as SessionRuntime;
}

test("directiveKeys maps each command to its code-constant keystroke", () => {
  expect(directiveKeys("clear")).toBe("/clear");
  expect(directiveKeys("compact")).toBe("/compact");
  expect(directiveKeys("magic_compact")).toBe("/magic-compact");
  expect(Object.keys(DIRECTIVE_KEYS).sort()).toEqual(["clear", "compact", "magic_compact"]);
});

test("isDirectiveCommand re-validates a broker-provided value", () => {
  expect(isDirectiveCommand("clear")).toBe(true);
  expect(isDirectiveCommand("magic_compact")).toBe(true);
  expect(isDirectiveCommand("wipe")).toBe(false);
  expect(isDirectiveCommand(null)).toBe(false);
  expect(isDirectiveCommand(undefined)).toBe(false);
  expect(isDirectiveCommand(42)).toBe(false);
});

test("resolveDirectiveTargets matches live peers and lists the rest as missing", () => {
  const sessions = [
    sess({ id: "t1", peerId: "host-dev", status: "running" }),
    sess({ id: "t2", peerId: "host-reviewer", status: "running" }),
    sess({ id: "t3", peerId: "host-gone", status: "exited" }), // exited -> not live
    sess({ id: "t4", peerId: null, status: "running" }) // unresolved peer
  ];
  const { matched, missing } = resolveDirectiveTargets(
    ["host-dev", "host-reviewer", "host-gone", "host-absent"],
    sessions
  );
  expect(matched).toEqual([
    { id: "t1", peerId: "host-dev" },
    { id: "t2", peerId: "host-reviewer" }
  ]);
  // exited peer + absent peer are both unreachable.
  expect(missing.sort()).toEqual(["host-absent", "host-gone"]);
});

test("resolveDirectiveTargets drops malformed ids into missing (no silent drop)", () => {
  const sessions = [sess({ id: "t1", peerId: "good-peer", status: "running" })];
  const { matched, missing } = resolveDirectiveTargets(
    ["good-peer", "Bad Peer!", "", "good-peer"], // malformed + blank + dup
    sessions
  );
  expect(matched).toEqual([{ id: "t1", peerId: "good-peer" }]);
  expect(missing).toContain("Bad Peer!");
});

test("resolveDirectiveTargets returns no matches when nothing is live", () => {
  const { matched, missing } = resolveDirectiveTargets(["host-dev"], []);
  expect(matched).toEqual([]);
  expect(missing).toEqual(["host-dev"]);
});
