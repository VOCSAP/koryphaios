// Card c33a5968: an operator-only "park" flag (`roadmap_items.inactive`,
// NEVER a `status` enum value). A parked card stays VISIBLE and ordinary
// edits stay permitted, but every write path that would move it toward
// status='in_progress' or locked=true is refused (403) while it stays
// inactive. Toggling the flag itself (set OR clear) requires
// `author.operator_id` (a Deck-signed write), else 403 fail-closed.
//
// `broker-*` family (spawns a real broker daemon), deliberately EXEMPTED
// from the CI glob (tests/desktop-ci-glob-coverage.test.ts) -- local-only
// via `bun test`, same precedent as broker-roadmap-operator-id.test.ts.
//
// Every guard cell below was proven RED-then-GREEN by removing the guard
// from broker.ts (not by a parallel re-implementation), running this file,
// observing the failure, then restoring it -- see the developer's report to
// the team-lead for the exact removal/restore pairs and their transcripts.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, stopBroker, post, type TestBroker, deckAuthored, FIXTURE_OPERATOR_ID } from "./_helper.ts";
import type { RoadmapItem } from "../shared/types.ts";

let broker: TestBroker;

beforeAll(async () => {
  broker = await startBroker();
});

afterAll(async () => {
  await stopBroker(broker);
});

const PK = "github.com/vocsap/inactive-flag-repo";

type ItemRes = { item: RoadmapItem };
type ItemsRes = { items: RoadmapItem[] };
type ImportRes = { imported: number; skipped: string[] };
type ErrRes = { error: string };

async function listAll(): Promise<RoadmapItem[]> {
  const res = await post<ItemsRes>(`${broker.url}/roadmap/list`, { project_key: PK });
  return res.body.items;
}

// ---------------------------------------------------------------------------
// (a) stamping inactive on a VIRGIN row, re-read back
// ---------------------------------------------------------------------------

test("upsert-create: a deck-signed create can stamp inactive=true on a virgin row", async () => {
  const res = await post<ItemRes>(
    `${broker.url}/roadmap/upsert`,
    deckAuthored({ project_key: PK, title: "born parked", inactive: true })
  );
  expect(res.status).toBe(200);
  expect(res.body.item.inactive).toBe(true);
  expect(res.body.item.operator_id).toBe(FIXTURE_OPERATOR_ID);

  const after = (await listAll()).find((i) => i.id === res.body.item.id)!;
  expect(after.inactive).toBe(true);
});

test("upsert-create: a virgin row defaults inactive=false when unspecified", async () => {
  const res = await post<ItemRes>(
    `${broker.url}/roadmap/upsert`,
    deckAuthored({ project_key: PK, title: "born active" })
  );
  expect(res.status).toBe(200);
  expect(res.body.item.inactive).toBe(false);
});

// ---------------------------------------------------------------------------
// (b) an AUTHENTIC agent write (instance_token branch, no operator_id) is
// refused when it tries to TOGGLE inactive; (c) the SAME gesture signed by
// the Deck passes -- proves the guard DISCRIMINATES, not just refuses.
// ---------------------------------------------------------------------------

test("upsert-create: an unsigned agent cannot stamp inactive=true on a new row (403)", async () => {
  const res = await post<ErrRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: "plain-agent",
    title: "agent tries to self-park on create",
    inactive: true,
  });
  expect(res.status).toBe(403);
});

test("upsert-patch: an unsigned agent cannot toggle inactive on an existing row (403), the same gesture signed by the Deck passes (c)", async () => {
  const created = await post<ItemRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: "plain-agent",
    title: "toggle target",
  });
  const id = created.body.item.id;
  expect(created.body.item.inactive).toBe(false);

  const unsigned = await post<ErrRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    id,
    by: "plain-agent",
    inactive: true,
  });
  expect(unsigned.status).toBe(403);

  const stillActive = (await listAll()).find((i) => i.id === id)!;
  expect(stillActive.inactive).toBe(false);

  const signed = await post<ItemRes>(
    `${broker.url}/roadmap/upsert`,
    deckAuthored({ project_key: PK, id, inactive: true })
  );
  expect(signed.status).toBe(200);
  expect(signed.body.item.inactive).toBe(true);
});

// ---------------------------------------------------------------------------
// Arbitration guard: an inactive card cannot be moved to in_progress/locked,
// across all three write paths that can attempt it.
// ---------------------------------------------------------------------------

test("upsert-patch: an ordinary edit on an inactive card stays permitted (retitle, no status/locked change)", async () => {
  const created = await post<ItemRes>(
    `${broker.url}/roadmap/upsert`,
    deckAuthored({ project_key: PK, title: "parked, editable", inactive: true })
  );
  const id = created.body.item.id;

  const retitled = await post<ItemRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    id,
    by: "plain-agent",
    title: "parked, retitled",
    tags: ["x"],
  });
  expect(retitled.status).toBe(200);
  expect(retitled.body.item.title).toBe("parked, retitled");
  expect(retitled.body.item.inactive).toBe(true);
});

test("upsert-patch: claiming an inactive card (status=in_progress) is refused 403", async () => {
  const created = await post<ItemRes>(
    `${broker.url}/roadmap/upsert`,
    deckAuthored({ project_key: PK, title: "parked, claim attempt", inactive: true })
  );
  const id = created.body.item.id;

  const claimed = await post<ErrRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    id,
    by: "plain-agent",
    status: "in_progress",
  });
  expect(claimed.status).toBe(403);

  const after = (await listAll()).find((i) => i.id === id)!;
  expect(after.status).not.toBe("in_progress");
  expect(after.locked).toBe(false);
});

test("upsert-patch: same-request bypass is closed -- a signed write that clears inactive AND claims in one call is still refused", async () => {
  const created = await post<ItemRes>(
    `${broker.url}/roadmap/upsert`,
    deckAuthored({ project_key: PK, title: "parked, bypass attempt", inactive: true })
  );
  const id = created.body.item.id;

  const bypass = await post<ErrRes>(
    `${broker.url}/roadmap/upsert`,
    deckAuthored({ project_key: PK, id, inactive: false, status: "in_progress" })
  );
  expect(bypass.status).toBe(403);

  const after = (await listAll()).find((i) => i.id === id)!;
  expect(after.inactive).toBe(true);
  expect(after.status).not.toBe("in_progress");
});

test("upsert-patch: two-step unpark works -- clear inactive first (signed), then claim (unsigned)", async () => {
  const created = await post<ItemRes>(
    `${broker.url}/roadmap/upsert`,
    deckAuthored({ project_key: PK, title: "parked, two-step unpark", inactive: true })
  );
  const id = created.body.item.id;

  const cleared = await post<ItemRes>(
    `${broker.url}/roadmap/upsert`,
    deckAuthored({ project_key: PK, id, inactive: false })
  );
  expect(cleared.status).toBe(200);
  expect(cleared.body.item.inactive).toBe(false);

  const claimed = await post<ItemRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    id,
    by: "plain-agent",
    status: "in_progress",
  });
  expect(claimed.status).toBe(200);
  expect(claimed.body.item.status).toBe("in_progress");
});

test("upsert-create: creating a row inactive AND in_progress in the same call is refused 403", async () => {
  const res = await post<ErrRes>(
    `${broker.url}/roadmap/upsert`,
    deckAuthored({ project_key: PK, title: "born parked and claimed", inactive: true, status: "in_progress" })
  );
  expect(res.status).toBe(403);
});

test("import: a row that would claim an inactive card is skipped, not the whole batch", async () => {
  const created = await post<ItemRes>(
    `${broker.url}/roadmap/upsert`,
    deckAuthored({ project_key: PK, title: "parked, import claim attempt", inactive: true })
  );
  const parkedId = created.body.item.id;
  const otherId = crypto.randomUUID();

  const imported = await post<ImportRes>(`${broker.url}/roadmap/import`, {
    project_key: PK,
    by: "plain-agent",
    items: [
      { id: parkedId, kind: created.body.item.kind, title: "import claim", status: "in_progress" },
      { id: otherId, kind: "feature", title: "unrelated row imports fine" },
    ],
  });
  expect(imported.status).toBe(200);
  expect(imported.body.imported).toBe(1);
  expect(imported.body.skipped).toEqual([parkedId]);

  const items = await listAll();
  const parkedAfter = items.find((i) => i.id === parkedId)!;
  expect(parkedAfter.status).not.toBe("in_progress");
  expect(parkedAfter.inactive).toBe(true);
  const otherAfter = items.find((i) => i.id === otherId)!;
  expect(otherAfter).toBeDefined();
  expect(otherAfter.title).toBe("unrelated row imports fine");
});

test("import: an unsigned toggle of inactive is skipped (row-level, not batch-abort)", async () => {
  const created = await post<ItemRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: "plain-agent",
    title: "import toggle target",
  });
  const id = created.body.item.id;

  const imported = await post<ImportRes>(`${broker.url}/roadmap/import`, {
    project_key: PK,
    by: "plain-agent",
    items: [{ id, kind: created.body.item.kind, title: "unsigned import toggle", inactive: true }],
  });
  expect(imported.status).toBe(200);
  expect(imported.body.imported).toBe(0);
  expect(imported.body.skipped).toEqual([id]);

  const after = (await listAll()).find((i) => i.id === id)!;
  expect(after.inactive).toBe(false);
  expect(after.title).toBe("import toggle target");
});

test("import: a deck-signed import legitimately restores inactive=true from the file (state restoration)", async () => {
  const created = await post<ItemRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: "plain-agent",
    title: "import restore target",
  });
  const id = created.body.item.id;
  expect(created.body.item.inactive).toBe(false);

  const imported = await post<ImportRes>(
    `${broker.url}/roadmap/import`,
    deckAuthored({
      project_key: PK,
      items: [{ id, kind: created.body.item.kind, title: "restored parked", inactive: true }],
    })
  );
  expect(imported.status).toBe(200);
  expect(imported.body.imported).toBe(1);
  expect(imported.body.skipped).toEqual([]);

  const after = (await listAll()).find((i) => i.id === id)!;
  expect(after.inactive).toBe(true);
});

test("major 1 regression: a force:true, deck-signed re-import of a parked+in_progress+locked row is not silently dropped", async () => {
  const created = await post<ItemRes>(
    `${broker.url}/roadmap/upsert`,
    deckAuthored({ project_key: PK, title: "import round-trip target", status: "in_progress" })
  );
  const id = created.body.item.id;
  const parked = await post<ItemRes>(
    `${broker.url}/roadmap/upsert`,
    deckAuthored({ project_key: PK, id, inactive: true })
  );
  expect(parked.body.item.inactive).toBe(true);
  expect(parked.body.item.status).toBe("in_progress");

  // A faithful export/import round-trip re-carries the row's OWN stored
  // status/locked/inactive verbatim -- this must not be refused just because
  // it happens to equal the parked, claim-shaped state it already is in.
  const imported = await post<ImportRes>(
    `${broker.url}/roadmap/import`,
    deckAuthored({
      project_key: PK,
      force: true,
      items: [
        {
          id,
          kind: parked.body.item.kind,
          title: parked.body.item.title,
          status: "in_progress",
          locked: parked.body.item.locked,
          locked_by: parked.body.item.locked_by,
          inactive: true,
        },
      ],
    })
  );
  expect(imported.status).toBe(200);
  expect(imported.body.imported).toBe(1);
  expect(imported.body.skipped).toEqual([]);
});

test("major 3 regression: a deck-signed import cannot bypass the claim guard by clearing inactive and claiming in the same row", async () => {
  const created = await post<ItemRes>(
    `${broker.url}/roadmap/upsert`,
    deckAuthored({ project_key: PK, title: "import bypass target", inactive: true })
  );
  const id = created.body.item.id;
  expect(created.body.item.status).not.toBe("in_progress");

  const imported = await post<ImportRes>(
    `${broker.url}/roadmap/import`,
    deckAuthored({
      project_key: PK,
      items: [{ id, kind: created.body.item.kind, title: "import bypass attempt", status: "in_progress", inactive: false }],
    })
  );
  expect(imported.status).toBe(200);
  expect(imported.body.imported).toBe(0);
  expect(imported.body.skipped).toEqual([id]);

  const after = (await listAll()).find((i) => i.id === id)!;
  expect(after.inactive).toBe(true);
  expect(after.status).not.toBe("in_progress");
});

test("import: inactive must be a boolean when present (400)", async () => {
  const res = await post<ErrRes>(`${broker.url}/roadmap/import`, {
    project_key: PK,
    by: "plain-agent",
    items: [{ id: crypto.randomUUID(), kind: "feature", title: "bad inactive", inactive: "yes" }],
  });
  expect(res.status).toBe(400);
});

// ---------------------------------------------------------------------------
// Blocker 2 (team-lead review, 2026-08-12): refusesInactiveClaim's original
// ABSOLUTE form (`nextStatus === "in_progress"`) refused a write that claims
// NOTHING once the stored status is already 'in_progress' -- including the
// operator's own attempt to lift the park they just set. Reproduces the
// team-lead's exact 5-step transcript; steps 3 and 4 used to be 403.
// ---------------------------------------------------------------------------

test("blocker 2 regression: parking an already in_progress card does not lock the operator out of ordinary edits or of lifting the park", async () => {
  // 1. P1 create (deck, status in_progress): 200
  const created = await post<ItemRes>(
    `${broker.url}/roadmap/upsert`,
    deckAuthored({ project_key: PK, title: "blocker 2 target", status: "in_progress" })
  );
  expect(created.status).toBe(200);
  expect(created.body.item.status).toBe("in_progress");
  const id = created.body.item.id;

  // 2. P1 park (deck-signed, inactive:true): 200
  const parked = await post<ItemRes>(
    `${broker.url}/roadmap/upsert`,
    deckAuthored({ project_key: PK, id, inactive: true })
  );
  expect(parked.status).toBe(200);
  expect(parked.body.item.inactive).toBe(true);
  expect(parked.body.item.status).toBe("in_progress");

  // 3. P1 retitle (agent, edit ordinaire): must stay 200, not 403 -- no delta
  // on status/lock, so the delta-form guard must not fire on an unrelated field.
  const retitled = await post<ItemRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    id,
    by: "plain-agent",
    title: "blocker 2 target, retitled",
  });
  expect(retitled.status).toBe(200);
  expect(retitled.body.item.title).toBe("blocker 2 target, retitled");
  expect(retitled.body.item.inactive).toBe(true);

  // 4. P1 unpark operator {inactive:false}: must be 200, not 403 -- clearing
  // inactive on a card whose stored status is ALREADY in_progress is not an
  // upward claim (no delta on status/lock), so the operator must be able to
  // lift their own park without also having to change status in the same call.
  const unparked = await post<ItemRes>(
    `${broker.url}/roadmap/upsert`,
    deckAuthored({ project_key: PK, id, inactive: false })
  );
  expect(unparked.status).toBe(200);
  expect(unparked.body.item.inactive).toBe(false);
  expect(unparked.body.item.status).toBe("in_progress");
});

test("upsert: inactive must be a boolean when present (400)", async () => {
  const res = await post<ErrRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: "plain-agent",
    title: "bad inactive type",
    inactive: "yes",
  });
  expect(res.status).toBe(400);
});
