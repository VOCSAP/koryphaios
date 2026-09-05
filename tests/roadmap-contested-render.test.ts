// `lock_contested_by` is written upstream when a second broker relays a claim on
// a card this one already holds. Until now only the Deck rendered it, so an
// agent reading the roadmap over MCP saw a card as plainly locked and had no way
// to learn that the lock is disputed across machines.
// Both renderers are exercised as PURE functions: the guarantee is what an agent
// reads, and an end-to-end two-broker probe would test the relay, not the text.

import { test, expect } from "bun:test";
import {
  formatLockContestedBy,
  formatRoadmapItemLine,
  formatRoadmapUpsertAck,
} from "../server.ts";
import type { RoadmapItem } from "../shared/types.ts";

function item(patch: Partial<RoadmapItem> = {}): RoadmapItem {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    project_key: "github.com/vocsap/contested",
    kind: "feature",
    title: "a shared card",
    description: "",
    rationale: "",
    context: "",
    priority: "could",
    value: "medium",
    effort: "medium",
    status: "in_progress",
    tags: [],
    depends_on: [],
    created_by: "agent-a",
    updated_by: "agent-a",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    deleted_at: null,
    queue: null,
    directive: null,
    target_peer_ids: [],
    locked: true,
    locked_by: "agent-a",
    locked_at: "2026-09-01T08:30:00.000Z",
    locked_group: "default",
    locked_by_token: null,
    inactive: false,
    lock_parked_at: null,
    lock_parked_by: null,
    sync_state: "clean",
    lock_scope: null,
    lock_contested_by: [],
    ...patch,
  };
}

test("an uncontested card costs nothing: no list suffix, no ack line", () => {
  const line = formatRoadmapItemLine(item({ lock_contested_by: [] }));
  expect(
    line.includes("also held elsewhere"),
    "an empty lock_contested_by must add no characters at all to a list line"
  ).toBe(false);
  const ack = formatRoadmapUpsertAck({
    label: "updated",
    item: item({ lock_contested_by: [] }),
    args: { status: "in_progress" },
    domain: ["status"],
  });
  expect(
    ack.includes("also held elsewhere"),
    "an empty lock_contested_by must add no line to the roadmap_update ack"
  ).toBe(false);
});

test("a card whose lock is held on another broker says so, next to the lock marker", () => {
  const line = formatRoadmapItemLine(
    item({ lock_contested_by: ["agent-b@7f3a19c2", "agent-c@0d55ee81"] })
  );
  expect(
    line,
    "the list line names every contesting holder so an agent can ask the right peer"
  ).toContain("[also held elsewhere: agent-b@7f3a19c2, agent-c@0d55ee81]");
  expect(
    line.indexOf("also held elsewhere") > line.indexOf("agent-a"),
    "the suffix follows the lock marker it qualifies, not the title"
  ).toBe(true);
});

test("the roadmap_update ack names the contest on the card the broker actually wrote", () => {
  const ack = formatRoadmapUpsertAck({
    label: "updated",
    item: item({ lock_contested_by: ["agent-b@7f3a19c2"] }),
    args: { status: "in_progress" },
    domain: ["status"],
  });
  expect(
    ack,
    "an agent that just claimed a disputed card learns it from the ack, not from a later divergence"
  ).toContain("work-lock also held elsewhere: agent-b@7f3a19c2");
  expect(
    ack.split("\n").filter((l) => l.includes("also held elsewhere")).length,
    "the contest is reported once, as one extra line"
  ).toBe(1);
});

test("the rendered list is bounded: a runaway lock_contested_by is capped and counted", () => {
  // The list is written by OTHER brokers, so its length is not this process's
  // to bound; without a cap one card could inflate every line of a roadmap_list.
  const many = ["a@r1", "b@r2", "c@r3", "d@r4", "e@r5"];
  expect(
    formatLockContestedBy(many),
    "beyond the cap the holders are counted, never dropped silently"
  ).toBe("a@r1, b@r2, c@r3, +2 more");
  expect(
    formatRoadmapItemLine(item({ lock_contested_by: many })).includes("d@r4"),
    "a capped entry must not reach the line"
  ).toBe(false);
});

test("a field an older broker never sends renders exactly like an uncontested card", () => {
  // The MCP client tolerates a broker that predates the column: undefined must
  // read as 'nothing contests it', never as a crash or a stray suffix.
  expect(formatLockContestedBy(undefined)).toBe("");
  const older = item();
  delete (older as { lock_contested_by?: string[] }).lock_contested_by;
  expect(formatRoadmapItemLine(older)).toBe(formatRoadmapItemLine(item({ lock_contested_by: [] })));
});
