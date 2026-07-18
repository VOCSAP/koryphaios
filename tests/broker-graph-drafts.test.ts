// Graph drafts: agent-escalated questions parked durably on the broker until
// the operator opens them in the Deck's graph view. Covers create/list/open,
// validation, project_key isolation, and the durability guarantee that
// motivated a dedicated table: listing is NON-destructive (no drain — a Deck
// crash between two polls loses nothing), only /graph-draft/open flips status.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, stopBroker, post, type TestBroker } from "./_helper.ts";
import type { GraphDraft } from "../shared/types.ts";
import { GRAPH_DRAFT_PROMPT_MAX } from "../shared/graph-draft.ts";

let broker: TestBroker;

beforeAll(async () => {
  broker = await startBroker();
});

afterAll(async () => {
  await stopBroker(broker);
});

const PK = "github.com/vocsap/claude-peers-mcp";
const OTHER_PK = "github.com/vocsap/other-repo";

type AddRes = { draft: GraphDraft };
type ListRes = { drafts: GraphDraft[] };

async function add(fields: Record<string, unknown>): Promise<GraphDraft> {
  const res = await post<AddRes>(`${broker.url}/graph-draft/add`, {
    project_key: PK,
    by: "coder-1",
    title: "Choix d'architecture",
    prompt: "## Question\nQuelle approche ?",
    ...fields,
  });
  expect(res.status).toBe(200);
  return res.body.draft;
}

test("add creates a pending draft with author snapshot and timestamps", async () => {
  const draft = await add({});
  expect(draft.id.length).toBeGreaterThan(10);
  expect(draft.project_key).toBe(PK);
  expect(draft.from_peer).toBe("coder-1");
  expect(draft.status).toBe("pending");
  expect(draft.created_at).toBeTruthy();
  expect(draft.opened_at).toBeNull();
});

test("add rejects missing project_key / title / prompt and oversized prompt", async () => {
  const noPk = await post(`${broker.url}/graph-draft/add`, { title: "t", prompt: "p" });
  expect(noPk.status).toBe(400);
  const noTitle = await post(`${broker.url}/graph-draft/add`, { project_key: PK, prompt: "p" });
  expect(noTitle.status).toBe(400);
  const noPrompt = await post(`${broker.url}/graph-draft/add`, { project_key: PK, title: "t" });
  expect(noPrompt.status).toBe(400);
  const tooLong = await post(`${broker.url}/graph-draft/add`, {
    project_key: PK,
    title: "t",
    prompt: "x".repeat(GRAPH_DRAFT_PROMPT_MAX + 1),
  });
  expect(tooLong.status).toBe(400);
});

test("list is non-destructive and isolated by project_key", async () => {
  const mine = await add({ title: "draft A" });
  await post(`${broker.url}/graph-draft/add`, {
    project_key: OTHER_PK,
    by: "coder-2",
    title: "other project",
    prompt: "p",
  });

  const first = await post<ListRes>(`${broker.url}/graph-draft/list`, { project_key: PK });
  expect(first.status).toBe(200);
  const ids = first.body.drafts.map((d) => d.id);
  expect(ids).toContain(mine.id);
  expect(first.body.drafts.every((d) => d.project_key === PK)).toBe(true);

  // The whole point vs the messages drain: listing again returns the SAME
  // pending drafts (a Deck crash between polls loses nothing).
  const second = await post<ListRes>(`${broker.url}/graph-draft/list`, { project_key: PK });
  expect(second.body.drafts.map((d) => d.id)).toEqual(ids);
});

test("open flips to opened exactly once and drops it from the default list", async () => {
  const draft = await add({ title: "to open" });
  const opened = await post<AddRes>(`${broker.url}/graph-draft/open`, { id: draft.id });
  expect(opened.status).toBe(200);
  expect(opened.body.draft.status).toBe("opened");
  expect(opened.body.draft.opened_at).toBeTruthy();

  // Idempotent: reopening keeps the original opened_at.
  const again = await post<AddRes>(`${broker.url}/graph-draft/open`, { id: draft.id });
  expect(again.body.draft.opened_at).toBe(opened.body.draft.opened_at);

  const pending = await post<ListRes>(`${broker.url}/graph-draft/list`, { project_key: PK });
  expect(pending.body.drafts.some((d) => d.id === draft.id)).toBe(false);
  const all = await post<ListRes>(`${broker.url}/graph-draft/list`, {
    project_key: PK,
    include_opened: true,
  });
  expect(all.body.drafts.some((d) => d.id === draft.id)).toBe(true);
});

test("open rejects an unknown id", async () => {
  const res = await post(`${broker.url}/graph-draft/open`, { id: "nope" });
  expect(res.status).toBe(404);
});
