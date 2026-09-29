// The roadmap title bound at the broker's direct write doors: upsert create,
// upsert update and import. The replication doors are covered with their own
// suites (sync push, replica pull).
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { startBroker, stopBroker, post } from "./_helper.ts";
import { ROADMAP_TITLE_MAX } from "../shared/roadmap-title.ts";
import type { RoadmapItem } from "../shared/types.ts";

const PK = "github.com/vocsap/title-bound-repo";
const AT_BOUND = "t".repeat(ROADMAP_TITLE_MAX);
const OVER_BOUND = "t".repeat(ROADMAP_TITLE_MAX + 1);

type UpsertRes = { item: RoadmapItem };

function countRows(dbPath: string, id?: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = id
      ? (db.query("SELECT COUNT(*) AS n FROM roadmap_items WHERE id = ?").get(id) as { n: number })
      : (db.query("SELECT COUNT(*) AS n FROM roadmap_items").get() as { n: number });
    return row.n;
  } finally {
    db.close();
  }
}

test("roadmap/upsert (create): a title at the bound is stored, one character more is refused with 400", async () => {
  const b = await startBroker();
  try {
    const atBound = await post<UpsertRes>(`${b.url}/roadmap/upsert`, { project_key: PK, by: "l0-author", title: AT_BOUND });
    expect(atBound.status).toBe(200);
    expect(atBound.body.item.title).toBe(AT_BOUND);

    const over = await post<{ error: string }>(`${b.url}/roadmap/upsert`, { project_key: PK, by: "l0-author", title: OVER_BOUND });
    expect(over.status).toBe(400);
    expect(over.body.error).toContain(`${ROADMAP_TITLE_MAX} UTF-16 code units`);
    expect(countRows(b.dbPath), "only the card at the bound exists").toBe(1);
  } finally {
    await stopBroker(b);
  }
});

test("roadmap/upsert (create): the bound applies after trim", async () => {
  const b = await startBroker();
  try {
    const padded = await post<UpsertRes>(`${b.url}/roadmap/upsert`, {
      project_key: PK,
      by: "l0-author",
      title: `  ${AT_BOUND}  `,
    });
    expect(padded.status).toBe(200);
    expect(padded.body.item.title).toBe(AT_BOUND);
  } finally {
    await stopBroker(b);
  }
});

test("roadmap/upsert (update): a new title over the bound is refused and the stored title kept; at the bound it is written", async () => {
  const b = await startBroker();
  try {
    const created = await post<UpsertRes>(`${b.url}/roadmap/upsert`, { project_key: PK, by: "l0-author", title: "short" });
    expect(created.status).toBe(200);
    const id = created.body.item.id;

    const over = await post<{ error: string }>(`${b.url}/roadmap/upsert`, { id, project_key: PK, by: "l0-author", title: OVER_BOUND });
    expect(over.status).toBe(400);
    expect(over.body.error).toContain(String(ROADMAP_TITLE_MAX));
    const list = await post<{ items: RoadmapItem[] }>(`${b.url}/roadmap/list`, { project_key: PK });
    expect(list.body.items.find((i) => i.id === id)?.title).toBe("short");

    const atBound = await post<UpsertRes>(`${b.url}/roadmap/upsert`, { id, project_key: PK, by: "l0-author", title: AT_BOUND });
    expect(atBound.status).toBe(200);
    expect(atBound.body.item.title).toBe(AT_BOUND);

    const untouched = await post<UpsertRes>(`${b.url}/roadmap/upsert`, { id, project_key: PK, by: "l0-author", status: "planned" });
    expect(untouched.status, "an update without a title keeps the stored one").toBe(200);
  } finally {
    await stopBroker(b);
  }
});

test("roadmap/import: one title over the bound refuses the whole batch; at the bound the batch lands", async () => {
  const b = await startBroker();
  try {
    const item = (id: string, title: string) => ({
      id, kind: "feature", title, priority: "could", value: "medium", effort: "medium", status: "idea",
    });
    const okId = crypto.randomUUID();
    const badId = crypto.randomUUID();
    const refused = await post<{ error: string }>(`${b.url}/roadmap/import`, {
      project_key: PK, by: "l0-importer", items: [item(okId, "fine"), item(badId, OVER_BOUND)],
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain(String(ROADMAP_TITLE_MAX));
    expect(countRows(b.dbPath), "nothing from the refused batch").toBe(0);

    const landed = await post<{ imported: number }>(`${b.url}/roadmap/import`, {
      project_key: PK, by: "l0-importer", items: [item(okId, "fine"), item(badId, AT_BOUND)],
    });
    expect(landed.status).toBe(200);
    expect(countRows(b.dbPath, badId)).toBe(1);
  } finally {
    await stopBroker(b);
  }
});
