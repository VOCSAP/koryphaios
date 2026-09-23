import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { startBroker, stopBroker, post, type TestBroker } from "./_helper.ts";
import {
  buildRoadmapAppendHeader,
  planRoadmapContextAppend,
  ROADMAP_APPEND_RESULT_MAX_CHARS,
} from "../shared/roadmap-append.ts";
import {
  createSqliteRoadmapContextDocumentCasStore,
  isValidRoadmapContextDocumentText,
  runRoadmapContextDocumentDeportCas,
} from "../shared/roadmap-context-document-cas.ts";
import type { RoadmapContextDocument, RoadmapItem } from "../shared/types.ts";

let broker: TestBroker;

beforeAll(async () => {
  broker = await startBroker();
});

afterAll(async () => {
  await stopBroker(broker);
});

const PK = "github.com/vocsap/context-documents-repo";
const OTHER_PK = "github.com/vocsap/another-context-documents-repo";

type UpsertResponse = { item: RoadmapItem };
type DocumentResponse = { item: RoadmapItem; document: RoadmapContextDocument };
type DocumentGetResponse = { document: RoadmapContextDocument };
type ErrorResponse = { error: string };

async function seed(body: Record<string, unknown> = {}): Promise<RoadmapItem> {
  const res = await post<UpsertResponse>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    by: "fixture-author",
    title: "context document target",
    ...body,
  });
  expect(res.status).toBe(200);
  return res.body.item;
}

function deport(body: Record<string, unknown>) {
  return post<DocumentResponse | ErrorResponse>(`${broker.url}/roadmap/context-document/deport`, {
    project_key: PK,
    ...body,
  });
}

function getDocument(body: Record<string, unknown>) {
  return post<DocumentGetResponse | ErrorResponse>(`${broker.url}/roadmap/context-document/get`, {
    project_key: PK,
    ...body,
  });
}

test("deportation stores an immutable document, rewrites context, and links the two", async () => {
  const item = await seed({ context: "body context" });
  const res = await deport({
    id: item.id,
    by: "cli:test-host:test-user",
    targets: ["body"],
  });

  expect(res.status).toBe(200);
  const created = res.body as DocumentResponse;
  expect(created.document).toMatchObject({
    roadmap_item_id: item.id,
    project_key: PK,
    created_by: "cli:test-host:test-user",
  });
  expect(created.document.units).toEqual([
    expect.objectContaining({ source_target: "body", raw: "body context", position: 0 }),
  ]);
  expect(created.item.context).toContain(`Context document ${created.document.id}`);
  expect(created.item.context).not.toContain("body context");

  const persisted = await getDocument({ id: item.id, document_id: created.document.id });
  expect(persisted.status).toBe(200);
  expect((persisted.body as DocumentGetResponse).document).toEqual(created.document);

  const db = new Database(broker.dbPath, { readonly: true });
  try {
    const count = db
      .query("SELECT COUNT(*) AS count FROM roadmap_context_document_units WHERE document_id = ?")
      .get(created.document.id) as { count: number };
    expect(count.count).toBe(1);
  } finally {
    db.close();
  }
});

test("a document cannot be read through another project or another card", async () => {
  const item = await seed({ context: "private context" });
  const created = await deport({ id: item.id, by: "fixture-author", targets: ["body"] });
  expect(created.status).toBe(200);
  const documentId = (created.body as DocumentResponse).document.id;

  const deniedProject = await getDocument({
    id: item.id,
    project_key: OTHER_PK,
    document_id: documentId,
  });
  expect(deniedProject.status).toBe(404);
  expect((deniedProject.body as ErrorResponse).error).toContain("this project");

  const other = await seed();
  const deniedCard = await getDocument({ id: other.id, document_id: documentId });
  expect(deniedCard.status).toBe(404);
  expect((deniedCard.body as ErrorResponse).error).toContain("unknown context document");
});

test("deportation accepts only current complete context units", async () => {
  const target = "2026-09-23T08:00:00.000Z";
  const item = await seed({
    context: `body context${buildRoadmapAppendHeader(target, "append-author")}appended context`,
  });

  const created = await deport({ id: item.id, by: "fixture-author", targets: [target] });
  expect(created.status).toBe(200);
  const document = (created.body as DocumentResponse).document;
  expect(document.units).toEqual([
    expect.objectContaining({
      source_target: target,
      raw: `${buildRoadmapAppendHeader(target, "append-author")}appended context`,
    }),
  ]);
  expect((created.body as DocumentResponse).item.context).toContain("body context");
  expect((created.body as DocumentResponse).item.context).not.toContain("appended context");

  const forged = await deport({ id: item.id, by: "fixture-author", targets: ["forged-target"] });
  expect(forged.status).toBe(400);
  expect((forged.body as ErrorResponse).error).toContain("does not exist");
});

test("deportation refuses a selected unit that supersedes an unselected unit", async () => {
  const target = "2026-09-23T09:00:00.000Z";
  const planned = planRoadmapContextAppend({
    existingContext: "expired body",
    text: "replacement context",
    author: "append-author",
    nowIso: target,
    supersedes: ["body"],
  });
  if (!planned.ok) throw new Error(planned.message);
  const item = await seed({ context: planned.result });

  const refused = await deport({ id: item.id, by: "fixture-author", targets: [target] });
  expect(refused.status).toBe(400);
  expect((refused.body as ErrorResponse).error).toContain("supersedes a unit that remains");

  const db = new Database(broker.dbPath, { readonly: true });
  try {
    const row = db.query("SELECT context FROM roadmap_items WHERE id = ?").get(item.id) as { context: string };
    expect(row.context).toBe(planned.result);
  } finally {
    db.close();
  }
});

test("deportation refuses a selected multi-target supersession that leaves one target", async () => {
  const firstTarget = "2026-09-23T09:00:00.000Z";
  const secondTarget = "2026-09-23T09:00:01.000Z";
  const first = planRoadmapContextAppend({
    existingContext: "expired body",
    text: "first replacement",
    author: "append-author",
    nowIso: firstTarget,
  });
  if (!first.ok) throw new Error(first.message);
  const second = planRoadmapContextAppend({
    existingContext: first.result,
    text: "second replacement",
    author: "append-author",
    nowIso: secondTarget,
    supersedes: ["body", firstTarget],
  });
  if (!second.ok) throw new Error(second.message);
  const item = await seed({ context: second.result });

  const refused = await deport({
    id: item.id,
    by: "fixture-author",
    targets: [firstTarget, secondTarget],
  });
  expect(refused.status).toBe(400);
  expect((refused.body as ErrorResponse).error).toContain(secondTarget);
  expect((refused.body as ErrorResponse).error).toContain("supersedes a unit that remains");
});

test("deportation refuses a document link that would exceed the living-context cap", async () => {
  const target = "2026-09-23T09:00:02.000Z";
  const item = await seed({
    context: `${"x".repeat(ROADMAP_APPEND_RESULT_MAX_CHARS)}${buildRoadmapAppendHeader(target, "append-author")}append`,
  });

  const refused = await deport({ id: item.id, by: "fixture-author", targets: [target] });
  expect(refused.status).toBe(400);
  expect((refused.body as ErrorResponse).error).toContain(`${ROADMAP_APPEND_RESULT_MAX_CHARS}-char living-context cap`);
});

test("deportation measures the context cap from living units rather than raw context", async () => {
  const firstTarget = "2026-09-23T09:00:03.000Z";
  const secondTarget = "2026-09-23T09:00:04.000Z";
  const first = planRoadmapContextAppend({
    existingContext: "x".repeat(ROADMAP_APPEND_RESULT_MAX_CHARS + 1),
    text: "living replacement",
    author: "append-author",
    nowIso: firstTarget,
    supersedes: ["body"],
  });
  if (!first.ok) throw new Error(first.message);
  const second = planRoadmapContextAppend({
    existingContext: first.result,
    text: "documentable append",
    author: "append-author",
    nowIso: secondTarget,
  });
  if (!second.ok) throw new Error(second.message);
  const item = await seed({ context: second.result });

  const created = await deport({ id: item.id, by: "fixture-author", targets: [secondTarget] });
  expect(created.status).toBe(200);
  expect((created.body as DocumentResponse).item.context).toContain("Context document");
});

test("NUL and malformed UTF-16 text cannot become document units", async () => {
  expect(isValidRoadmapContextDocumentText(`before${String.fromCharCode(0)}after`)).toBe(false);
  expect(isValidRoadmapContextDocumentText(String.fromCharCode(0xd800))).toBe(false);

  const item = await seed({ context: `before${String.fromCharCode(0)}after` });
  const refused = await deport({ id: item.id, by: "fixture-author", targets: ["body"] });
  expect(refused.status).toBe(400);
  expect((refused.body as ErrorResponse).error).toContain("NUL byte");
});

test("duplicate, stale, and already-deported targets are refused", async () => {
  const item = await seed({ context: "one documentable unit" });

  const duplicate = await deport({ id: item.id, by: "fixture-author", targets: ["body", "body"] });
  expect(duplicate.status).toBe(400);
  expect((duplicate.body as ErrorResponse).error).toContain("repeated");

  const first = await deport({ id: item.id, by: "fixture-author", targets: ["body"] });
  expect(first.status).toBe(200);

  const second = await deport({ id: item.id, by: "fixture-author", targets: ["body"] });
  expect(second.status).toBe(400);
  expect((second.body as ErrorResponse).error).toContain("does not exist");
});

test("CAS retries after a concurrent content revision and uses the current unit", () => {
  let row = { context: "original context", contentRev: 1 };
  let writes = 0;
  let persisted: RoadmapContextDocument | undefined;
  let next = 0;

  const result = runRoadmapContextDocumentDeportCas({
    id: "item",
    projectKey: PK,
    targets: ["body"],
    author: "fixture-author",
    now: () => "2026-09-23T08:00:00.000Z",
    nextId: () => `id-${next++}`,
    store: {
      read: () => ({ ...row }),
      replace: (write) => {
        writes += 1;
        if (writes === 1) {
          row = { context: "intervening context", contentRev: 2 };
          return false;
        }
        row = { context: write.context, contentRev: row.contentRev + 1 };
        persisted = write.document;
        return true;
      },
    },
  });

  expect(result).toMatchObject({ ok: true });
  expect(writes).toBe(2);
  expect(persisted).toMatchObject({
    roadmap_item_id: "item",
    project_key: PK,
    units: [expect.objectContaining({ raw: "intervening context" })],
  });
  expect(row.context).toContain("Context document id-0");
});

test("SQLite document CAS rejects stale revisions and rolls back a failed unit insert", () => {
  const db = new Database(":memory:");
  try {
    db.run("CREATE TABLE roadmap_items (id TEXT PRIMARY KEY, context TEXT, content_rev INTEGER, operator_id TEXT)");
    db.run(
      "CREATE TABLE roadmap_context_documents (id TEXT PRIMARY KEY, roadmap_item_id TEXT, project_key TEXT, created_by TEXT, created_at TEXT)",
    );
    db.run(
      "CREATE TABLE roadmap_context_document_units (id TEXT PRIMARY KEY, document_id TEXT, source_target TEXT, raw TEXT, deported_at TEXT, position INTEGER, UNIQUE(document_id, source_target))",
    );
    db.run("INSERT INTO roadmap_items VALUES (?, ?, ?, ?)", ["item", "original context", 2, null]);
    const store = createSqliteRoadmapContextDocumentCasStore(db);
    const baseDocument: RoadmapContextDocument = {
      id: "document-a",
      roadmap_item_id: "item",
      project_key: PK,
      created_by: "fixture-author",
      created_at: "2026-09-23T10:00:00.000Z",
      units: [
        {
          id: "unit-a",
          source_target: "body",
          raw: "original context",
          deported_at: "2026-09-23T10:00:00.000Z",
          position: 0,
        },
      ],
    };

    const stale = store.replace({
      id: "item",
      expectedContentRev: 1,
      context: "stale replacement",
      operatorId: null,
      document: baseDocument,
    });
    expect(stale).toBe(false);
    expect((db.query("SELECT COUNT(*) AS count FROM roadmap_context_documents").get() as { count: number }).count).toBe(0);

    const duplicateUnitDocument: RoadmapContextDocument = {
      ...baseDocument,
      units: [
        ...baseDocument.units,
        {
          id: "unit-a",
          source_target: "2026-09-23T10:00:01.000Z",
          raw: "another unit",
          deported_at: "2026-09-23T10:00:00.000Z",
          position: 1,
        },
      ],
    };
    expect(() =>
      store.replace({
        id: "item",
        expectedContentRev: 2,
        context: "replacement context",
        operatorId: null,
        document: duplicateUnitDocument,
      }),
    ).toThrow();
    const item = db.query("SELECT context FROM roadmap_items WHERE id = ?").get("item") as { context: string };
    expect(item.context).toBe("original context");
    expect((db.query("SELECT COUNT(*) AS count FROM roadmap_context_documents").get() as { count: number }).count).toBe(0);
  } finally {
    db.close();
  }
});

test("archiving and restoring a card preserves its context document and link", async () => {
  const item = await seed({ context: "restorable context" });
  const created = await deport({ id: item.id, by: "fixture-author", targets: ["body"] });
  expect(created.status).toBe(200);
  const document = (created.body as DocumentResponse).document;
  const linkedContext = (created.body as DocumentResponse).item.context;

  const archived = await post<UpsertResponse>(`${broker.url}/roadmap/archive`, {
    id: item.id,
    by: "fixture-author",
  });
  expect(archived.status).toBe(200);
  expect(archived.body.item.status).toBe("archived");

  const whileArchived = await getDocument({ id: item.id, document_id: document.id });
  expect(whileArchived.status).toBe(200);
  expect((whileArchived.body as DocumentGetResponse).document).toEqual(document);

  const restored = await post<UpsertResponse>(`${broker.url}/roadmap/upsert`, {
    id: item.id,
    project_key: PK,
    by: "fixture-author",
    status: "planned",
  });
  expect(restored.status).toBe(200);
  expect(restored.body.item.context).toBe(linkedContext);

  const afterRestore = await getDocument({ id: item.id, document_id: document.id });
  expect(afterRestore.status).toBe(200);
  expect((afterRestore.body as DocumentGetResponse).document).toEqual(document);
});
