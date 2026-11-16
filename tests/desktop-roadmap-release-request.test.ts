import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractBracedBody } from "./_braced-body";
import { lockReleasePatch } from "../desktop/src/main/idle-lock.ts";
import { idleSweepRequest, operatorStopRequest } from "../desktop/src/main/roadmap-release-request.ts";
import { withoutChangeOrigin } from "../desktop/src/main/roadmap-service.ts";

const STATUSES = ["in_progress", "planned", "done", "archived", "idea"];

test("the idle sweep request of an in_progress card is the release patch plus the idle_lock_sweep marker", () => {
  const item = { id: "card-1", status: "in_progress" };
  expect(idleSweepRequest(item)).toEqual({ ...lockReleasePatch(item), change_origin: "idle_lock_sweep" });
});

test("the idle sweep request of any other status is the bare release patch, without the marker", () => {
  for (const status of STATUSES.filter((s) => s !== "in_progress")) {
    const item = { id: "card-1", status };
    const request = idleSweepRequest(item);
    expect([status, request]).toEqual([status, lockReleasePatch(item)]);
    expect([status, "change_origin" in request]).toEqual([status, false]);
  }
});

test("the operator stop request is the bare release patch, without any change_origin key", () => {
  for (const status of STATUSES) {
    const item = { id: "card-1", status };
    const request = operatorStopRequest(item);
    expect([status, request]).toEqual([status, lockReleasePatch(item)]);
    expect([status, "change_origin" in request]).toEqual([status, false]);
  }
});

test("only an in_progress card carries a status in either request", () => {
  expect(operatorStopRequest({ id: "a", status: "in_progress" })).toEqual({ id: "a", status: "planned", locked: false });
  expect(idleSweepRequest({ id: "a", status: "done" })).toEqual({ id: "a", locked: false });
});

test("withoutChangeOrigin drops the marker, keeps every other field and leaves its input untouched", () => {
  const input = { id: "a", status: "planned" as const, locked: false, change_origin: "idle_lock_sweep" as const };
  expect(withoutChangeOrigin(input)).toEqual({ id: "a", status: "planned", locked: false });
  expect(input.change_origin).toBe("idle_lock_sweep");
  expect(withoutChangeOrigin({ id: "a", title: "t" })).toEqual({ id: "a", title: "t" });
});

// ipc.ts imports electron, so the handler cannot run under bun; the probe is
// bounded to this one handler body.
test("the renderer-facing roadmap:upsert handler strips change_origin before the broker call", () => {
  const src = readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "ipc.ts"), "utf-8");
  const decl = /regHandle\(\s*'roadmap:upsert'\s*,\s*\([^)]*\)\s*=>\s*\{/.exec(src);
  expect(["roadmap:upsert handler declaration found", decl !== null]).toEqual([
    "roadmap:upsert handler declaration found",
    true,
  ]);
  const body = extractBracedBody(src, decl!.index + decl![0].length - 1);
  expect([
    "the handler sends withoutChangeOrigin(fields) to upsertRoadmap",
    /upsertRoadmap\(\s*endpoint\s*,\s*key\s*,\s*withoutChangeOrigin\(\s*fields\b/.test(body),
  ]).toEqual(["the handler sends withoutChangeOrigin(fields) to upsertRoadmap", true]);
});
