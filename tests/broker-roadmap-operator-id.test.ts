// Card edefff05: `resolveRoadmapAuthor`'s reserved-peer-name branch proves an
// operator's Ed25519 signature (`resolveApprovalAuth`) but used to discard
// `auth.operator_id`. This file proves the digest actually survives on
// roadmap_items.operator_id across every write path that can touch it.
//
// `broker-*` family (spawns a real broker daemon), deliberately EXEMPTED from
// the CI glob (tests/desktop-ci-glob-coverage.test.ts) -- local-only via
// `bun test`. All six cells need a live broker (each hits an HTTP write
// route), so a single file is correct here; none of them is a pure
// PRAGMA-vs-constant comparison like card aad5e954's guard, which is why
// there is no companion `roadmap-*.test.ts` for this card.
//
// One test PER WRITE PATH, not one end-to-end test: upsert-create,
// upsert-patch, archive, context-append, import, reorder-does-not-erase.

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

const PK = "github.com/vocsap/operator-id-repo";

type ItemRes = { item: RoadmapItem };
type ItemsRes = { items: RoadmapItem[] };
type ImportRes = { imported: number; skipped: string[] };

async function listAll(): Promise<RoadmapItem[]> {
  const res = await post<ItemsRes>(`${broker.url}/roadmap/list`, { project_key: PK });
  return res.body.items;
}

// ----- cell 1: upsert CREATE -----

test("upsert-create: a deck-signed create stamps operator_id with the signer's digest", async () => {
  const res = await post<ItemRes>(
    `${broker.url}/roadmap/upsert`,
    deckAuthored({ project_key: PK, title: "create cell" })
  );
  expect(res.status).toBe(200);
  expect(res.body.item.operator_id).toBe(FIXTURE_OPERATOR_ID);
});

test("upsert-create: an ordinary (unsigned) agent create leaves operator_id unset", async () => {
  const res = await post<ItemRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: "plain-agent",
    title: "unsigned create",
  });
  expect(res.status).toBe(200);
  expect(res.body.item.operator_id).toBeUndefined();
});

// ----- cell 2: upsert PATCH -----

test("upsert-patch: a deck-signed patch stamps operator_id on a row that had none", async () => {
  const created = await post<ItemRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: "plain-agent",
    title: "unsigned then signed patch",
  });
  const id = created.body.item.id;
  expect(created.body.item.operator_id).toBeUndefined();

  const patched = await post<ItemRes>(
    `${broker.url}/roadmap/upsert`,
    deckAuthored({ project_key: PK, id, title: "renamed by signed patch" })
  );
  expect(patched.status).toBe(200);
  expect(patched.body.item.operator_id).toBe(FIXTURE_OPERATOR_ID);
});

test("upsert-patch: an unsigned patch preserves the previously signed operator_id (COALESCE)", async () => {
  const created = await post<ItemRes>(
    `${broker.url}/roadmap/upsert`,
    deckAuthored({ project_key: PK, title: "patch cell" })
  );
  const id = created.body.item.id;
  expect(created.body.item.operator_id).toBe(FIXTURE_OPERATOR_ID);

  const patched = await post<ItemRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    id,
    by: "plain-agent",
    title: "renamed by unsigned patch",
  });
  expect(patched.status).toBe(200);
  expect(patched.body.item.title).toBe("renamed by unsigned patch");
  expect(patched.body.item.operator_id).toBe(FIXTURE_OPERATOR_ID);
});

// ----- cell 3: archive -----

test("archive: a deck-signed archive stamps operator_id on a row that had none", async () => {
  const created = await post<ItemRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: "plain-agent",
    title: "unsigned then signed archive",
  });
  const id = created.body.item.id;
  expect(created.body.item.operator_id).toBeUndefined();

  const archived = await post<ItemRes>(
    `${broker.url}/roadmap/archive`,
    deckAuthored({ id })
  );
  expect(archived.status).toBe(200);
  expect(archived.body.item.operator_id).toBe(FIXTURE_OPERATOR_ID);
});

test("archive: an unsigned archive preserves the previously signed operator_id", async () => {
  const created = await post<ItemRes>(
    `${broker.url}/roadmap/upsert`,
    deckAuthored({ project_key: PK, title: "archive cell" })
  );
  const id = created.body.item.id;

  const archived = await post<ItemRes>(`${broker.url}/roadmap/archive`, {
    id,
    by: "plain-agent",
  });
  expect(archived.status).toBe(200);
  expect(archived.body.item.deleted_at).not.toBeNull();
  expect(archived.body.item.operator_id).toBe(FIXTURE_OPERATOR_ID);
});

// ----- cell 4: context-append -----

test("context-append: a deck-signed append stamps operator_id on a card that had none", async () => {
  const created = await post<ItemRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: "plain-agent",
    title: "append cell",
  });
  const id = created.body.item.id;
  expect(created.body.item.operator_id).toBeUndefined();

  const appended = await post<ItemRes>(
    `${broker.url}/roadmap/append-context`,
    deckAuthored({ project_key: PK, id, text: "signed note" })
  );
  expect(appended.status).toBe(200);
  expect(appended.body.item.context).toContain("signed note");
  expect(appended.body.item.operator_id).toBe(FIXTURE_OPERATOR_ID);
});

// ----- cell 5: import -----

test("import: an unsigned import preserves the existing signed operator_id", async () => {
  const created = await post<ItemRes>(
    `${broker.url}/roadmap/upsert`,
    deckAuthored({ project_key: PK, title: "import preserve cell" })
  );
  const card = created.body.item;
  expect(card.operator_id).toBe(FIXTURE_OPERATOR_ID);

  const imported = await post<ImportRes>(`${broker.url}/roadmap/import`, {
    project_key: PK,
    by: "plain-agent",
    items: [
      {
        id: card.id,
        kind: card.kind,
        title: "renamed by unsigned import",
      },
    ],
  });
  expect(imported.status).toBe(200);
  expect(imported.body.imported).toBe(1);

  const after = (await listAll()).find((i) => i.id === card.id)!;
  expect(after.title).toBe("renamed by unsigned import");
  expect(after.operator_id).toBe(FIXTURE_OPERATOR_ID);
});

test("import: a deck-signed import stamps operator_id on a brand-new row", async () => {
  const newId = crypto.randomUUID();
  const res = await post<ImportRes>(
    `${broker.url}/roadmap/import`,
    deckAuthored({
      project_key: PK,
      items: [{ id: newId, kind: "feature", title: "signed import new row" }],
    })
  );
  expect(res.status).toBe(200);
  expect(res.body.imported).toBe(1);

  const after = (await listAll()).find((i) => i.id === newId)!;
  expect(after).toBeDefined();
  expect(after.operator_id).toBe(FIXTURE_OPERATOR_ID);
});

// ----- cell 6: reorder -----
//
// This cell guards the ERASURE case only, not a stamping case: reorder is
// deliberately excluded from writing operator_id at all (queue write on N
// rows at once, not an authorship event on one card -- see the comment above
// handleRoadmapReorder's transaction in broker.ts). There is therefore no
// "signed reorder stamps operator_id" cell to pair with this one. Proven by
// regression injection (a temporary `operator_id = NULL` added to the
// per-id UPDATE during this card's development made this assertion fail),
// not by removal, since production has nothing to remove here.

test("reorder: rewriting the queue does not erase a previously signed operator_id (reorder itself never stamps one)", async () => {
  const created = await post<ItemRes>(
    `${broker.url}/roadmap/upsert`,
    deckAuthored({ project_key: PK, title: "reorder cell" })
  );
  const id = created.body.item.id;
  expect(created.body.item.operator_id).toBe(FIXTURE_OPERATOR_ID);

  const reordered = await post<ItemsRes>(
    `${broker.url}/roadmap/reorder`,
    deckAuthored({ project_key: PK, ids: [id] })
  );
  expect(reordered.status).toBe(200);
  const after = reordered.body.items.find((i) => i.id === id)!;
  expect(after.queue).toBe(1);
  expect(after.operator_id).toBe(FIXTURE_OPERATOR_ID);
});
