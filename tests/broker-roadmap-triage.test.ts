// The triage role as a CARD FIELD rather than a tag: what the broker accepts,
// what it refuses, what a card born before the column becomes, and the one
// property that makes the role travel between two brokers instead of staying
// local to each -- a content write versions the card and marks it dirty.
// The tag vocabulary it replaces was validated by nothing, so every guard here
// exists because its absence was the previous state of the world.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBroker, stopBroker, post, type TestBroker } from "./_helper.ts";
import type { RoadmapItem, RoadmapListResponse } from "../shared/types.ts";

const PK = "github.com/vocsap/triage-repo";

type UpsertRes = { item: RoadmapItem };

function openDb(b: TestBroker): Database {
  const db = new Database(b.dbPath);
  db.run("PRAGMA busy_timeout = 3000");
  return db;
}

async function createCard(
  b: TestBroker,
  fields: Record<string, unknown>
): Promise<{ status: number; body: UpsertRes & { error?: string } }> {
  return post<UpsertRes & { error?: string }>(`${b.url}/roadmap/upsert`, {
    project_key: PK,
    by: "agent-triage",
    title: "triage fixture",
    ...fields,
  });
}

test("a role outside the vocabulary is refused, including the near-misses", async () => {
  const b = await startBroker();
  try {
    // Each of these is a way the field could quietly become something the rest
    // of the code switches on: a role that does not exist, one differing only
    // by case, the empty string, and a non-string.
    for (const bad of ["ready", "Wontfix", "", 3, ["needs-info"]]) {
      const res = await createCard(b, { triage: bad });
      expect([`triage ${JSON.stringify(bad)} must be refused`, res.status]).toEqual([
        `triage ${JSON.stringify(bad)} must be refused`,
        400,
      ]);
    }
    const ok = await createCard(b, { triage: "ready-for-agent" });
    expect(ok.status).toBe(200);
    expect(ok.body.item.triage).toBe("ready-for-agent");
  } finally {
    await stopBroker(b);
  }
});

test("an absent role is untriaged, and an explicit null clears one that was set", async () => {
  const b = await startBroker();
  try {
    const created = await createCard(b, {});
    expect(created.body.item.triage).toBeNull();
    const id = created.body.item.id;

    const set = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      id,
      by: "agent-triage",
      triage: "needs-info",
    });
    expect(set.body.item.triage).toBe("needs-info");

    // A patch that never names the field leaves it alone: this is what an old
    // client, or any write about something else, must do.
    const untouched = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      id,
      by: "agent-triage",
      description: "unrelated edit",
    });
    expect(untouched.body.item.triage).toBe("needs-info");

    const cleared = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      id,
      by: "agent-triage",
      triage: null,
    });
    expect(cleared.body.item.triage).toBeNull();
  } finally {
    await stopBroker(b);
  }
});

test("'wontfix' and priority 'wont' cannot contradict each other, on create or on patch", async () => {
  const b = await startBroker();
  try {
    const refusedOnCreate = await createCard(b, { triage: "wontfix", priority: "must" });
    expect(refusedOnCreate.status).toBe(400);
    expect(refusedOnCreate.body.error).toContain("wontfix");

    const accepted = await createCard(b, { triage: "wontfix", priority: "wont" });
    expect(accepted.status).toBe(200);
    const id = accepted.body.item.id;

    // The check reads the RESULTING card: this patch names only the priority,
    // and the contradiction it creates comes from the STORED triage.
    const refusedOnPatch = await post<UpsertRes & { error?: string }>(`${b.url}/roadmap/upsert`, {
      id,
      by: "agent-triage",
      priority: "should",
    });
    expect(refusedOnPatch.status).toBe(400);

    // The same move is legal when the same write also drops the role.
    const reopened = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      id,
      by: "agent-triage",
      priority: "should",
      triage: "needs-triage",
    });
    expect(reopened.status).toBe(200);
    expect(reopened.body.item.priority).toBe("should");
  } finally {
    await stopBroker(b);
  }
});

test("a 'wont' card nobody has triaged stays writable: untriaged is a state, not a violation", async () => {
  const b = await startBroker();
  try {
    const created = await createCard(b, { priority: "wont" });
    expect(created.status).toBe(200);
    expect(created.body.item.triage).toBeNull();
    const edited = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      id: created.body.item.id,
      by: "agent-triage",
      description: "still editable",
    });
    expect(edited.status).toBe(200);
  } finally {
    await stopBroker(b);
  }
});

test("roadmap_list filters by role, and refuses an unknown one instead of answering empty", async () => {
  const b = await startBroker();
  try {
    await createCard(b, { title: "agent ready", triage: "ready-for-agent" });
    await createCard(b, { title: "human ready", triage: "ready-for-human" });
    await createCard(b, { title: "never triaged" });

    const filtered = await post<RoadmapListResponse>(`${b.url}/roadmap/list`, {
      project_key: PK,
      triages: ["ready-for-agent"],
    });
    expect(filtered.status).toBe(200);
    expect(filtered.body.items.map((i) => i.title)).toEqual(["agent ready"]);

    // A typo that reads back as "no such card" is the failure this refuses:
    // an empty list is indistinguishable from a real answer.
    const typo = await post<{ error: string }>(`${b.url}/roadmap/list`, {
      project_key: PK,
      triages: ["ready-for-agents"],
    });
    expect(typo.status).toBe(400);
  } finally {
    await stopBroker(b);
  }
});

test("a triage-only edit versions the card and marks it dirty, so the role can travel", async () => {
  const b = await startBroker();
  const db = openDb(b);
  try {
    const created = await createCard(b, {});
    const id = created.body.item.id;
    const before = db
      .query("SELECT rev, content_rev, sync_dirty FROM roadmap_items WHERE id = ?")
      .get(id) as { rev: number; content_rev: number; sync_dirty: number };

    await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      id,
      by: "agent-triage",
      triage: "ready-for-agent",
    });

    const after = db
      .query("SELECT rev, content_rev, sync_dirty FROM roadmap_items WHERE id = ?")
      .get(id) as { rev: number; content_rev: number; sync_dirty: number };
    // content_rev is what the replication compares; sync_dirty is what makes
    // the push pass pick the card up. A role that moved neither would be
    // written locally and never leave this broker.
    expect([
      "a triage change must version the content and mark the card pending",
      after.content_rev > before.content_rev,
      after.sync_dirty,
    ]).toEqual(["a triage change must version the content and mark the card pending", true, 1]);
  } finally {
    db.close();
    await stopBroker(b);
  }
});

test("the startup migration promotes a role tag into the column, once, and resolves a double tag", async () => {
  const b = await startBroker();
  const db = openDb(b);
  // The database must OUTLIVE the broker that seeded it: stopBroker deletes
  // its whole sandbox, so a restart pointed inside it would open an empty file
  // and the migration would be measured on zero rows -- green for the wrong
  // reason. `VACUUM INTO` takes the copy once the writer is gone, WAL
  // contents included.
  const carried = mkdtempSync(join(tmpdir(), "triage-migration-"));
  const dbPath = join(carried, "peers.db");
  const reopen = (): Database => {
    const handle = new Database(dbPath);
    handle.run("PRAGMA busy_timeout = 3000");
    return handle;
  };
  try {
    // Cards as they existed before the column: the role lives in the free-text
    // tag list, alongside ordinary tags that must survive untouched.
    const single = await createCard(b, { title: "tagged single", tags: ["infra"] });
    const double = await createCard(b, { title: "tagged double", tags: ["infra"] });
    db.run("UPDATE roadmap_items SET triage = NULL, tags = ? WHERE id = ?", [
      JSON.stringify(["infra", "ready-for-agent"]),
      single.body.item.id,
    ]);
    // Two roles on one card: the promotion must be deterministic, not
    // whichever the JSON happens to list first.
    db.run("UPDATE roadmap_items SET triage = NULL, tags = ? WHERE id = ?", [
      JSON.stringify(["ready-for-agent", "needs-info", "infra"]),
      double.body.item.id,
    ]);
    db.close();
    b.proc.kill();
    await b.proc.exited;
    const source = openDb(b);
    source.run("VACUUM INTO ?", [dbPath]);
    source.close();
    await stopBroker(b);

    const restarted = await startBroker({ CLAUDE_PEERS_DB: dbPath });
    const db2 = reopen();
    try {
      const readCard = (id: string) =>
        db2.query("SELECT triage, tags FROM roadmap_items WHERE id = ?").get(id) as {
          triage: string | null;
          tags: string;
        };
      const promotedSingle = readCard(single.body.item.id);
      expect([
        "the role moves to the column and leaves the ordinary tags alone",
        promotedSingle.triage,
        JSON.parse(promotedSingle.tags),
      ]).toEqual([
        "the role moves to the column and leaves the ordinary tags alone",
        "ready-for-agent",
        ["infra"],
      ]);

      const promotedDouble = readCard(double.body.item.id);
      expect([
        "waiting on information outranks being ready for anyone",
        promotedDouble.triage,
        JSON.parse(promotedDouble.tags),
      ]).toEqual(["waiting on information outranks being ready for anyone", "needs-info", ["infra"]]);

      // Idempotence measured as a NO-OP, not just as a stable value: a
      // migration that rewrites the same row on every startup would version
      // the card again and again, and every replica would keep pulling it.
      const revBefore = db2
        .query("SELECT content_rev FROM roadmap_items WHERE id = ?")
        .get(single.body.item.id) as { content_rev: number };
      db2.close();
      await stopBroker(restarted);

      const third = await startBroker({ CLAUDE_PEERS_DB: dbPath });
      const db3 = reopen();
      try {
        const after = db3
          .query("SELECT triage, content_rev FROM roadmap_items WHERE id = ?")
          .get(single.body.item.id) as { triage: string; content_rev: number };
        expect([
          "the second startup changes nothing at all",
          after.triage,
          after.content_rev === revBefore.content_rev,
        ]).toEqual(["the second startup changes nothing at all", "ready-for-agent", true]);
      } finally {
        db3.close();
        await stopBroker(third);
      }
    } catch (e) {
      await stopBroker(restarted);
      throw e;
    }
  } catch (e) {
    await stopBroker(b);
    throw e;
  } finally {
    rmSync(carried, { recursive: true, force: true });
  }
});
