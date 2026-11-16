import { expect, test } from "bun:test";
import {
  adoptedContentDate,
  changeOriginRefusal,
  contentDateAfterWrite,
  readContentDate,
} from "../shared/roadmap-content-date.ts";
import { pickSyncContent } from "../shared/roadmap-sync.ts";
import type { RoadmapSyncContent } from "../shared/types.ts";

const CONTENT: RoadmapSyncContent = {
  kind: "feature",
  title: "a card",
  description: "",
  rationale: "",
  context: "",
  priority: "could",
  value: "medium",
  effort: "medium",
  status: "planned",
  triage: null,
  tags: ["x"],
  depends_on: [],
  deleted_at: null,
  directive: null,
  target_peer_ids: [],
  inactive: false,
};
const KEPT = "2026-01-02T03:04:05.006Z";
const NOW = "2026-02-03T04:05:06.007Z";

test("readContentDate trusts only the exact ISO form of a real instant", () => {
  expect(readContentDate("2026-03-04T05:06:07.089Z")).toBe("2026-03-04T05:06:07.089Z");
  for (const bad of [
    "2026-02-30T00:00:00.000Z",
    "2026-03-04 05:06:07",
    "2026-03-04T05:06:07Z",
    "2026-03-04T05:06:07.089+01:00",
    "not a date",
    "",
    null,
    undefined,
    12345,
    {},
  ]) {
    expect(readContentDate(bad), `${JSON.stringify(bad)} is not a trusted date`).toBeNull();
  }
});

test("contentDateAfterWrite dates a content change and keeps the date for an identical result", () => {
  expect(contentDateAfterWrite(CONTENT, { ...CONTENT, title: "renamed" }, KEPT, NOW)).toBe(NOW);
  expect(contentDateAfterWrite(CONTENT, { ...CONTENT, tags: ["x", "y"] }, KEPT, NOW)).toBe(NOW);
  expect(contentDateAfterWrite(CONTENT, { ...CONTENT, status: "in_progress" }, null, NOW)).toBe(NOW);
  expect(contentDateAfterWrite(CONTENT, pickSyncContent(CONTENT), KEPT, NOW)).toBe(KEPT);
  expect(contentDateAfterWrite(CONTENT, pickSyncContent(CONTENT), null, NOW)).toBeNull();
});

test("adoptedContentDate keeps the local date on identical content and carries the wire date otherwise", () => {
  expect(adoptedContentDate(NOW, true, KEPT)).toBe(KEPT);
  expect(adoptedContentDate(null, true, KEPT)).toBe(KEPT);
  expect(adoptedContentDate(NOW, false, KEPT)).toBe(NOW);
  expect(adoptedContentDate(null, false, KEPT)).toBeNull();
});

const RELEASE = { id: "c1", by: "deck", status: "planned", locked: false, change_origin: "idle_lock_sweep" };

test("changeOriginRefusal accepts the strict lock-release shape and nothing else", () => {
  expect(changeOriginRefusal({ id: "c1", by: "deck", title: "x" }, false)).toBeNull();
  expect(changeOriginRefusal(RELEASE, true)).toBeNull();
  expect(
    changeOriginRefusal({ ...RELEASE, project_key: "p", public_key: "k", auth: { sig: "s" } }, true)
  ).toBeNull();

  const refused: [string, Record<string, unknown>, boolean][] = [
    ["no operator proof", RELEASE, false],
    ["unknown origin", { ...RELEASE, change_origin: "anything" }, true],
    ["a content field", { ...RELEASE, title: "renamed" }, true],
    ["a context edit", { ...RELEASE, context: "more" }, true],
    ["a qualification edit", { ...RELEASE, priority: "must" }, true],
    ["a tag edit", { ...RELEASE, tags: ["t"] }, true],
    ["the force flag", { ...RELEASE, force: true }, true],
    ["a queue move", { ...RELEASE, queue: 3 }, true],
    ["the release flag", { ...RELEASE, release: true }, true],
    ["a status other than planned", { ...RELEASE, status: "in_progress" }, true],
    ["no status", { id: "c1", by: "deck", locked: false, change_origin: "idle_lock_sweep" }, true],
    ["a lock claim", { ...RELEASE, locked: true }, true],
    ["no locked field", { id: "c1", by: "deck", status: "planned", change_origin: "idle_lock_sweep" }, true],
    ["no card id", { by: "deck", locked: false, change_origin: "idle_lock_sweep" }, true],
  ];
  for (const [what, body, proven] of refused) {
    expect(changeOriginRefusal(body, proven), `refused: ${what}`).not.toBeNull();
  }
});
