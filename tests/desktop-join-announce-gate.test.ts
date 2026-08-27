// Card 8cb54a0f: joinAnnounceTargets (shared/announce.ts) is the PURE decision
// behind the three-level join-announce gate ('off' | 'lead' | 'all', default
// 'off'). It imports cleanly under bun (no electron/node-pty -- see its own
// module header), so this file exercises the REAL function directly, no
// slicing needed. What this file does NOT prove: that the wiring at the
// index.ts call site (sendJoinAnnounce/service.on('peer-resolved', ...)) is
// unchanged and still reachable -- see tests/desktop-index-join-announce-
// wiring.test.ts for the slice-based behavioural proof of that half.
//
// Two properties the team-lead's review flagged BY NAME, both pinned here:
//   1. the 'lead' resolution is `filter`, never `find`/`get` -- TWO active
//      team-leads is a valid state and BOTH must be addressed, not one.
//   2. an empty recipient pool at 'lead' is SILENT, never a broadcast
//      fallback -- the whole point of the gate is to remove exactly that
//      noise, so falling back would reintroduce the bug this card fixes.

import { test, expect } from "bun:test";
import { joinAnnounceTargets } from "../desktop/src/shared/announce.ts";
import type { SessionRuntime } from "../desktop/src/shared/types.ts";

function sess(over: Partial<SessionRuntime>): SessionRuntime {
  return {
    id: over.id ?? "tile-x",
    name: over.name ?? "tile",
    cwd: over.cwd ?? "/repo",
    command: over.command ?? "",
    args: over.args ?? "",
    sessionId: over.sessionId ?? "",
    color: over.color ?? "#000000",
    createdAt: over.createdAt ?? 0,
    status: over.status ?? "running",
    exitCode: over.exitCode ?? null,
    pid: over.pid ?? 1234,
    peerId: over.peerId ?? null,
    activity: over.activity ?? "unknown",
    expired: over.expired ?? false,
    rateLimited: over.rateLimited ?? false,
    resumeAt: over.resumeAt ?? null,
    needsAttention: over.needsAttention ?? false,
    claudeLaunch: over.claudeLaunch ?? true,
    ...over
  } as SessionRuntime;
}

test("'off' is silent regardless of who is live, including team-leads", () => {
  const sessions = [sess({ id: "s1", role: "team-lead", peerId: "p1" })];
  expect(joinAnnounceTargets("off", sessions)).toEqual({ kind: "silent" });
  expect(joinAnnounceTargets("off", [])).toEqual({ kind: "silent" });
});

test("'all' keeps the historical broadcast regardless of who is live", () => {
  expect(joinAnnounceTargets("all", [])).toEqual({ kind: "broadcast" });
  expect(
    joinAnnounceTargets("all", [sess({ id: "s1", role: "team-lead", peerId: "p1" })])
  ).toEqual({ kind: "broadcast" });
});

test("'lead' with TWO active team-leads addresses BOTH -- filter, not find/get", () => {
  const sessions = [
    sess({ id: "s1", role: "team-lead", peerId: "lead-a", status: "running" }),
    sess({ id: "s2", role: "team-lead", peerId: "lead-b", status: "running" }),
    sess({ id: "s3", role: "developer", peerId: "dev-c", status: "running" })
  ];
  const decision = joinAnnounceTargets("lead", sessions);
  expect(decision.kind).toBe("targets");
  if (decision.kind === "targets") {
    expect([...decision.peerIds].sort()).toEqual(["lead-a", "lead-b"]);
  }
});

test("'lead' with zero team-lead and zero supervisor is SILENT, never a broadcast fallback", () => {
  const sessions = [sess({ id: "s1", role: "developer", peerId: "dev-c", status: "running" })];
  expect(joinAnnounceTargets("lead", sessions)).toEqual({ kind: "silent" });
  expect(joinAnnounceTargets("lead", [])).toEqual({ kind: "silent" });
});

test("'lead' falls back to active supervisors only when the team-lead pool is empty", () => {
  const sessions = [
    sess({ id: "s1", supervisor: true, peerId: "sup-a", status: "running" }),
    sess({ id: "s2", role: "developer", peerId: "dev-c", status: "running" })
  ];
  expect(joinAnnounceTargets("lead", sessions)).toEqual({ kind: "targets", peerIds: ["sup-a"] });
});

test("'lead' prefers the team-lead pool over supervisors when both are live", () => {
  const sessions = [
    sess({ id: "s1", supervisor: true, peerId: "sup-a", status: "running" }),
    sess({ id: "s2", role: "team-lead", peerId: "lead-a", status: "running" })
  ];
  expect(joinAnnounceTargets("lead", sessions)).toEqual({ kind: "targets", peerIds: ["lead-a"] });
});

test("'lead' excludes an exited or peerId-less team-lead from the pool", () => {
  const sessions = [
    sess({ id: "s1", role: "team-lead", peerId: "lead-a", status: "exited" }),
    sess({ id: "s2", role: "team-lead", peerId: null, status: "running" })
  ];
  // Both team-leads are inactive by the active() predicate (exited, or no
  // peerId yet) -- falls through to the (empty) supervisor pool -> silent.
  expect(joinAnnounceTargets("lead", sessions)).toEqual({ kind: "silent" });
});

test("the joiner is never re-addressed as its own target (mirrors sendJoinAnnounce's own exclusion at the 'targets' branch)", () => {
  // joinAnnounceTargets itself does not know which session is "the joiner" --
  // that exclusion is applied by its caller (sendJoinAnnounce, index.ts:782).
  // This test pins the CONTRACT: peerIds returned are exactly the resolved
  // pool, unfiltered by any joiner identity, so a caller-side regression that
  // stops excluding the joiner cannot hide behind this function silently
  // doing it instead.
  const sessions = [sess({ id: "s1", role: "team-lead", peerId: "lead-a", status: "running" })];
  const decision = joinAnnounceTargets("lead", sessions);
  expect(decision).toEqual({ kind: "targets", peerIds: ["lead-a"] });
});
