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
import { Database } from "bun:sqlite";
import { startBroker, stopBroker, post, livePid, type TestBroker , deckAuthored } from "./_helper.ts";
import {
  ROADMAP_IMPORT_COLUMNS,
  findUncoveredRoadmapColumns,
  type RoadmapItem,
} from "../shared/types.ts";

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
  // Signed (card 39c40571 layer 2): the point of this test is that even a
  // PROVEN deck author gets no lock exemption on import, so the signature must
  // be real -- an unsigned 401 would make it pass for the wrong reason.
  const res = await post<ImportRes>(
    `${broker.url}/roadmap/import`,
    deckAuthored({ project_key: PK, items: [importItem(card)] })
  );
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

// ----- card ad6aa6ed (review finding): locked_by is FILE content, must be
// normalized/validated like `by`, not taken raw -----
//
// created_by/updated_by on this route already go through resolveRoadmapAuthor
// (defect 3 below). locked_by does not -- it never reaches that resolver --
// but it lands in the same identity-shaped column and is DISPLAYED verbatim
// by roadmap_get's "locked: by X since ..." line, so an unnormalized/
// out-of-charset value here is the same forgery surface the `by`-claim fix
// closed on a different field.

test("locked_by outside [a-z0-9:_-] refuses the WHOLE import, not just that row", async () => {
  const id = crypto.randomUUID();
  const res = await post<ImportErr>(`${broker.url}/roadmap/import`, {
    project_key: PK,
    by: "trusted-importer",
    items: [
      {
        id, kind: "feature", title: "bad locked_by charset", priority: "could",
        value: "medium", effort: "medium", status: "idea",
        locked: true, locked_by: "Deck Impersonator", locked_at: new Date().toISOString(),
      },
    ],
  });
  expect(res.status).toBe(400);
  expect(res.body.error).toContain("locked_by");
  expect(res.body.error).toContain("disallowed character");

  // The proof that matters: nothing landed, not even a partial write.
  expect((await listAll()).find((i) => i.id === id)).toBeUndefined();
});

test("a legitimate mixed-case locked_by is normalized to lowercase at storage, not rejected or kept raw", async () => {
  const id = crypto.randomUUID();
  const res = await post<ImportRes>(`${broker.url}/roadmap/import`, {
    project_key: PK,
    by: "trusted-importer",
    items: [
      {
        id, kind: "feature", title: "mixed-case locked_by", priority: "could",
        value: "medium", effort: "medium", status: "idea",
        locked: true, locked_by: "Mixed-Case-Peer", locked_at: new Date().toISOString(),
      },
    ],
  });
  expect(res.status).toBe(200);
  expect(res.body.imported).toBe(1);

  const after = (await listAll()).find((i) => i.id === id)!;
  expect(after.locked_by).toBe("mixed-case-peer");
});

test("locked_by as an empty string is refused (review delta: an empty owner defeats by !== existing.locked_by forever)", async () => {
  const id = crypto.randomUUID();
  const res = await post<ImportErr>(`${broker.url}/roadmap/import`, {
    project_key: PK,
    by: "trusted-importer",
    items: [
      {
        id, kind: "feature", title: "empty locked_by", priority: "could",
        value: "medium", effort: "medium", status: "idea",
        locked: true, locked_by: "", locked_at: new Date().toISOString(),
      },
    ],
  });
  expect(res.status).toBe(400);
  expect(res.body.error).toContain("locked_by");
  expect((await listAll()).find((i) => i.id === id)).toBeUndefined();
});

test("an unparsable locked_at refuses the whole import -- a lock the sweep could never release", async () => {
  // SQLite datetime() on an unparsable string returns NULL, which never
  // satisfies releaseStaleLocks's WHERE comparison: without this check an
  // import like this one would create a permanently stuck lock.
  const id = crypto.randomUUID();
  const res = await post<ImportErr>(`${broker.url}/roadmap/import`, {
    project_key: PK,
    by: "trusted-importer",
    items: [
      {
        id, kind: "feature", title: "unparsable locked_at", priority: "could",
        value: "medium", effort: "medium", status: "idea",
        locked: true, locked_by: "some-peer", locked_at: "nope", updated_at: "nope",
      },
    ],
  });
  expect(res.status).toBe(400);
  expect(res.body.error).toContain("timestamp");
  // The proof that matters: nothing landed, not a partially-applied write.
  expect((await listAll()).find((i) => i.id === id)).toBeUndefined();
});

test("a valid ISO timestamp still imports (positive control for the parseability check)", async () => {
  const id = crypto.randomUUID();
  const validIso = "2026-01-01T00:00:00.000Z";
  const res = await post<ImportRes>(`${broker.url}/roadmap/import`, {
    project_key: PK,
    by: "trusted-importer",
    items: [
      {
        id, kind: "feature", title: "valid timestamps", priority: "could",
        value: "medium", effort: "medium", status: "idea",
        created_at: validIso, updated_at: validIso,
      },
    ],
  });
  expect(res.status).toBe(200);
  expect(res.body.imported).toBe(1);
  const after = (await listAll()).find((i) => i.id === id)!;
  expect(after.created_at).toBe(validIso);
  expect(after.updated_at).toBe(validIso);
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

// ----- card 8c1effca: a PARTIAL import file must not erase what it omits -----
//
// Same shape as card 40ddf1f5's second defect, but coming from the FILE instead
// of the TABLE: there the INSERT forgot three columns of the schema, so SQLite
// reset them to their DEFAULT; here the column list is complete but the VALUE
// fell back to a literal whenever the file was silent, so real content was
// overwritten with emptiness. Invisible on an export/import round trip, and it
// only bites on the partial file an operator hand-writes for a targeted fix.
//
// Arbitration (a): a key PRESENT wins, including an explicit null; a key truly
// ABSENT falls back to the existing row; only a brand-new row falls back to the
// table default.

async function seedRichCard(by: string): Promise<RoadmapItem> {
  const res = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by,
    title: "rich card",
    kind: "bug",
    description: "the description that must survive",
    rationale: "the rationale that must survive",
    context: "the context that must survive",
    tags: ["alpha", "beta"],
    depends_on: ["some-other-id"],
    priority: "must",
    value: "high",
    effort: "high",
    queue: 3,
  });
  expect(res.status).toBe(200);
  const card = res.body.item;
  // The probe is worthless if the seed did not take: prove the fields are
  // really there BEFORE the import, so a red below means "erased", never
  // "never written".
  expect(card.description).toBe("the description that must survive");
  expect(card.rationale).toBe("the rationale that must survive");
  expect(card.context).toBe("the context that must survive");
  expect(card.tags).toEqual(["alpha", "beta"]);
  expect(card.queue).toBe(3);
  expect(card.locked).toBe(false); // not locked -> the skip guard cannot answer for us
  return card;
}

test("card 8c1effca: a partial import (id/kind/title only) preserves description, rationale, context, tags, depends_on and queue", async () => {
  const card = await seedRichCard("partial-seed-author");

  const res = await post<ImportRes>(`${broker.url}/roadmap/import`, {
    project_key: PK,
    by: "partial-importer",
    items: [{ id: card.id, kind: card.kind, title: "renamed by partial import" }],
  });
  // Red for the RIGHT reason: the import must have been ACCEPTED. If the lock
  // guard or the author check answered instead, imported would be 0 and the
  // assertions below would pass or fail for a foreign reason.
  expect(res.status).toBe(200);
  expect(res.body.imported).toBe(1);
  expect(res.body.skipped).toEqual([]);

  const after = (await listAll()).find((i) => i.id === card.id)!;
  expect(after.title).toBe("renamed by partial import"); // the write DID go through
  expect(after.description).toBe("the description that must survive");
  expect(after.rationale).toBe("the rationale that must survive");
  expect(after.context).toBe("the context that must survive");
  expect(after.tags).toEqual(["alpha", "beta"]);
  expect(after.depends_on).toEqual(["some-other-id"]);
  expect(after.queue).toBe(3);
  expect(after.priority).toBe("must");
  expect(after.value).toBe("high");
  expect(after.effort).toBe("high");
});

test("card 8c1effca: an explicit empty value in the file still takes effect (present wins over the existing row)", async () => {
  const card = await seedRichCard("explicit-clear-author");

  const res = await post<ImportRes>(`${broker.url}/roadmap/import`, {
    project_key: PK,
    by: "explicit-clearer",
    items: [
      {
        id: card.id,
        kind: card.kind,
        title: card.title,
        description: "", // present and empty: a genuine clear, not an omission
        tags: [],
        queue: null,
      },
    ],
  });
  expect(res.status).toBe(200);
  expect(res.body.imported).toBe(1);

  const after = (await listAll()).find((i) => i.id === card.id)!;
  expect(after.description).toBe("");
  expect(after.tags).toEqual([]);
  expect(after.queue).toBeNull();
  // ...while what the file stayed silent about is still untouched.
  expect(after.rationale).toBe("the rationale that must survive");
  expect(after.context).toBe("the context that must survive");
});

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

// INSERT OR REPLACE deletes the row before reinserting it, so any column
// missing from this statement silently reverts to its table default on every
// import.

test("card aad5e954: the import writes every column the live roadmap_items schema has", () => {
  const db = new Database(broker.dbPath, { readonly: true });
  try {
    const schemaColumns = (
      db.query("PRAGMA table_info(roadmap_items)").all() as { name: string }[]
    ).map((c) => c.name);

    // The probe must SEE the schema before its silence can mean anything: an
    // empty PRAGMA (wrong table name, wrong database) would make every
    // comparison below trivially true.
    expect(schemaColumns.length).toBeGreaterThan(10);
    expect(schemaColumns).toContain("locked_at"); // the column card 40ddf1f5 lost

    const { missing, extra } = findUncoveredRoadmapColumns(
      schemaColumns,
      ROADMAP_IMPORT_COLUMNS
    );
    expect(missing).toEqual([]); // a column the table has and the import resets
    expect(extra).toEqual([]); // a column written but no longer in the table
  } finally {
    db.close();
  }
});

test("card aad5e954: the comparison NAMES an uncovered column (negative control)", () => {
  // The synthetic column name must be one that can never become a real column:
  // a name that later became a real column left the comparison finding nothing
  // missing, with no error.
  const grown = [...ROADMAP_IMPORT_COLUMNS, "__never_a_real_column__"];
  const uncovered = findUncoveredRoadmapColumns(grown, ROADMAP_IMPORT_COLUMNS);
  expect(uncovered.missing).toEqual(["__never_a_real_column__"]);
  expect(uncovered.extra).toEqual([]);

  // ...and the mirror mistake, a column dropped from the table but still
  // written, which would make the prepared statement throw at runtime.
  const shrunk = ROADMAP_IMPORT_COLUMNS.filter((c) => c !== "queue");
  const dangling = findUncoveredRoadmapColumns(shrunk, ROADMAP_IMPORT_COLUMNS);
  expect(dangling.missing).toEqual([]);
  expect(dangling.extra).toEqual(["queue"]);
});
