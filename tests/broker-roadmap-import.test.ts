// Card 40ddf1f5: /roadmap/import had three defects sharing one handler --
// no lock guard at all, an INSERT OR REPLACE column list that silently
// erased locked/locked_by/locked_at on every write, and no resolveRoadmapAuthor
// call (created_by/updated_by taken straight from untrusted file content).
//
// The lock guard on THIS route cannot compare a declared `by` against
// locked_by like upsert does: card 39c40571's arbitration exempts the CLI
// import path from a proven-author requirement (it already runs on the
// broker's own host holding the bearer token), so `by` here is a DECLARED
// string an attacker could set to the lock owner's own peer_id. Every locked
// card is therefore skipped unconditionally, with a hand-typed `force:true`
// as the only override -- see the negative control below.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, stopBroker, post, livePid, type TestBroker } from "./_helper.ts";
import type { RoadmapItem } from "../shared/types.ts";

let broker: TestBroker;

beforeAll(async () => {
  broker = await startBroker();
});

afterAll(async () => {
  await stopBroker(broker);
});

const PK = "github.com/vocsap/import-repo";

type UpsertRes = { item: RoadmapItem };
type ImportRes = { imported: number; skipped: string[] };
type ImportErr = { error: string };

async function listAll(): Promise<RoadmapItem[]> {
  const res = await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/list`, {
    project_key: PK,
  });
  return res.body.items;
}

async function lockedCard(owner: string): Promise<RoadmapItem> {
  const res = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: owner,
    title: "held card",
    status: "in_progress", // non-'deck' author writing in_progress claims the lock
  });
  expect(res.status).toBe(200);
  expect(res.body.item.locked).toBe(true);
  expect(res.body.item.locked_by).toBe(owner);
  return res.body.item;
}

function importItem(card: RoadmapItem, overrides: Record<string, unknown> = {}) {
  return {
    id: card.id,
    kind: card.kind,
    title: "renamed by import",
    priority: card.priority,
    value: card.value,
    effort: card.effort,
    status: card.status,
    created_at: card.created_at,
    updated_at: card.updated_at,
    ...overrides,
  };
}

// ----- defect 1: unconditional skip, no author-ownership comparison -----

test("import of a locked card is skipped even when `by` declares the lock owner (negative control)", async () => {
  const card = await lockedCard("owner-peer");
  const res = await post<ImportRes>(`${broker.url}/roadmap/import`, {
    project_key: PK,
    by: "owner-peer", // an attacker (or a compromised script) can declare ANY name here
    items: [importItem(card)],
  });
  expect(res.status).toBe(200);
  expect(res.body.imported).toBe(0);
  expect(res.body.skipped).toEqual([card.id]);

  // Proves the skip, not just an empty-looking response: the card's title is
  // still the pre-import one, not "renamed by import".
  const after = (await listAll()).find((i) => i.id === card.id)!;
  expect(after.title).toBe("held card");
  expect(after.locked).toBe(true);
  expect(after.locked_by).toBe("owner-peer");
});

test("import of a locked card is skipped even when `by` is 'deck' (no exemption on an unproven route)", async () => {
  const card = await lockedCard("owner-peer-2");
  const res = await post<ImportRes>(`${broker.url}/roadmap/import`, {
    project_key: PK,
    by: "deck",
    items: [importItem(card)],
  });
  expect(res.status).toBe(200);
  expect(res.body.imported).toBe(0);
  expect(res.body.skipped).toEqual([card.id]);
});

test("--force overrides the skip for the whole batch", async () => {
  const card = await lockedCard("owner-peer-3");
  const res = await post<ImportRes>(`${broker.url}/roadmap/import`, {
    project_key: PK,
    by: "owner-peer-3",
    force: true,
    items: [importItem(card)],
  });
  expect(res.status).toBe(200);
  expect(res.body.imported).toBe(1);
  expect(res.body.skipped).toEqual([]);

  const after = (await listAll()).find((i) => i.id === card.id)!;
  expect(after.title).toBe("renamed by import");
});

// ----- defect 2: INSERT OR REPLACE must not erase locked/locked_by/locked_at -----
//
// This can only be observed on a LOCKED row (an unlocked row already has
// locked_by=null/locked_at=null by construction -- upsert's own unlock path
// unconditionally nulls both, see broker.ts's `if (!locked) lockedBy = null`),
// so the only reachable path to this defect, once defect 1 is fixed, is
// through the force:true escape hatch. That is still "legitimate" in the
// sense the card asked for: a conscious, hand-typed operator override, not an
// accidental or remotely-declared one.

test("force-importing a locked card with no lock fields in the file preserves locked/locked_by/locked_at (attacks the INSERT directly)", async () => {
  const card = await lockedCard("owner-peer-4");
  const originalLockedAt = card.locked_at;

  const item = importItem(card); // deliberately carries no locked/locked_by/locked_at
  expect("locked" in item).toBe(false);
  expect("locked_by" in item).toBe(false);
  expect("locked_at" in item).toBe(false);

  const res = await post<ImportRes>(`${broker.url}/roadmap/import`, {
    project_key: PK,
    by: "owner-peer-4",
    force: true,
    items: [item],
  });
  expect(res.status).toBe(200);
  expect(res.body.imported).toBe(1);

  const after = (await listAll()).find((i) => i.id === card.id)!;
  expect(after.title).toBe("renamed by import"); // the import DID write through
  expect(after.locked).toBe(true); // ...but did not reset the lock columns
  expect(after.locked_by).toBe("owner-peer-4");
  expect(after.locked_at).toBe(originalLockedAt);
});

test("a brand-new imported item with no lock fields defaults to unlocked (not the row that doesn't exist yet)", async () => {
  const id = crypto.randomUUID();
  const res = await post<ImportRes>(`${broker.url}/roadmap/import`, {
    project_key: PK,
    by: "importer",
    items: [
      {
        id,
        kind: "feature",
        title: "brand new",
        priority: "could",
        value: "medium",
        effort: "medium",
        status: "idea",
      },
    ],
  });
  expect(res.status).toBe(200);
  expect(res.body.imported).toBe(1);
  const after = (await listAll()).find((i) => i.id === id)!;
  expect(after.locked).toBe(false);
  expect(after.locked_by).toBeNull();
});

// ----- defect 3: created_by/updated_by come from the resolved author, not the file -----

test("created_by/updated_by are stamped from the resolved author, ignoring the file's own claim", async () => {
  const id = crypto.randomUUID();
  const res = await post<ImportRes>(`${broker.url}/roadmap/import`, {
    project_key: PK,
    by: "trusted-importer",
    items: [
      {
        id,
        kind: "feature",
        title: "spoofed authorship",
        priority: "could",
        value: "medium",
        effort: "medium",
        status: "idea",
        created_by: "attacker-fake-name",
        updated_by: "attacker-fake-name",
      },
    ],
  });
  expect(res.status).toBe(200);
  const after = (await listAll()).find((i) => i.id === id)!;
  expect(after.created_by).toBe("trusted-importer");
  expect(after.updated_by).toBe("trusted-importer");
});

test("re-importing an existing card preserves its original created_by (immutable attribution)", async () => {
  const created = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: "original-author",
    title: "keep my creator",
  });
  const card = created.body.item;
  expect(card.created_by).toBe("original-author");

  const res = await post<ImportRes>(`${broker.url}/roadmap/import`, {
    project_key: PK,
    by: "re-importer",
    items: [importItem(card, { created_by: "someone-else" })],
  });
  expect(res.status).toBe(200);
  expect(res.body.imported).toBe(1);
  const after = (await listAll()).find((i) => i.id === card.id)!;
  expect(after.created_by).toBe("original-author"); // untouched
  expect(after.updated_by).toBe("re-importer"); // stamped from the resolved author
});

test("an unproven `by` impersonating a real registered peer refuses the whole batch before any write", async () => {
  const reg = await post<{ instance_token: string; peer_id: string }>(`${broker.url}/register`, {
    pid: livePid(), cwd: "/tmp/import-real-peer", git_root: null, tty: null,
    summary: "", host: "h-import", client_pid: livePid(), claude_cli_pid: 1,
    project_key: PK, group_id: "default", group_secret_hash: null,
  });
  expect(reg.status).toBe(200);

  const id = crypto.randomUUID();
  const res = await post<ImportErr>(`${broker.url}/roadmap/import`, {
    project_key: PK,
    by: reg.body.peer_id, // real, registered peer_id -- but no instance_token to prove it
    items: [
      {
        id, kind: "feature", title: "should never land",
        priority: "could", value: "medium", effort: "medium", status: "idea",
      },
    ],
  });
  expect(res.status).toBe(401);
  expect(res.body.error).toContain("registered peer");

  const after = (await listAll()).find((i) => i.id === id);
  expect(after).toBeUndefined();
});

// ----- duplicate id within one import file -----
//
// Answers team-lead's coverage question: yes it can happen (an untrusted
// file), and the later entry wins UNLESS an earlier entry in the SAME batch
// left the card locked -- there is no special-cased duplicate handling, this
// falls out of re-reading the row fresh (inside the same transaction) before
// every item's skip-check.

test("a duplicate id in one import: the later entry wins, unless an earlier entry in the batch locked it", async () => {
  const id = crypto.randomUUID();
  const res = await post<ImportRes>(`${broker.url}/roadmap/import`, {
    project_key: PK,
    by: "batch-importer",
    items: [
      {
        id, kind: "feature", title: "first pass", priority: "could",
        value: "medium", effort: "medium", status: "idea",
        locked: true, locked_by: "batch-importer", locked_at: new Date().toISOString(),
      },
      {
        id, kind: "feature", title: "second pass (should be skipped, not applied)",
        priority: "could", value: "medium", effort: "medium", status: "idea",
      },
    ],
  });
  expect(res.status).toBe(200);
  expect(res.body.imported).toBe(1);
  expect(res.body.skipped).toEqual([id]);

  const after = (await listAll()).find((i) => i.id === id)!;
  expect(after.title).toBe("first pass"); // the second entry was skipped, not applied
  expect(after.locked).toBe(true);
});
