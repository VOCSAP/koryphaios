// Every route that releases a roadmap work-lock must leave the same lock
// columns behind. A release path that forgets one leaves a residue the next
// reader takes for live state (locked_group routes the abandonment event).

import { test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { startBroker, stopBroker, deckAuthored, type TestBroker } from "./_helper.ts";

const AUTH = "lock-release-columns-marker";
const PK = "github.com/vocsap/lock-release-columns-repo";

let broker: TestBroker;
let sweeper: TestBroker;

beforeAll(async () => {
  [broker, sweeper] = await Promise.all([
    startBroker({ CLAUDE_PEERS_BROKER_TOKEN: AUTH, CLAUDE_PEERS_SERVE_REPLICAS: "1" }),
    startBroker({
      CLAUDE_PEERS_BROKER_TOKEN: AUTH,
      CLAUDE_PEERS_LOCK_TTL_SEC: "2",
      CLAUDE_PEERS_LOCK_GRACE_SEC: "3600",
      CLAUDE_PEERS_LOCK_SWEEP_SEC: "1",
    }),
  ]);
});

afterAll(async () => {
  await Promise.all([stopBroker(broker), stopBroker(sweeper)]);
});

async function postTo<T>(b: TestBroker, path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${b.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${AUTH}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function createCard(b: TestBroker, title: string): Promise<string> {
  const res = await postTo<{ item: { id: string } }>(b, "/roadmap/upsert", { project_key: PK, by: "test-peer", title });
  expect(res.status).toBe(200);
  return res.body.item.id;
}

function lockFully(b: TestBroker, id: string, holder: string, extraSet: string, extraParams: string[]): void {
  const db = new Database(b.dbPath);
  db.run(
    `UPDATE roadmap_items SET locked = 1, locked_by = ?, locked_group = 'grp-held', locked_by_token = 'tok-held',
       locked_at = datetime('now'), status = 'in_progress'${extraSet} WHERE id = ?`,
    [holder, ...extraParams, id]
  );
  db.close();
}

function lockColumns(b: TestBroker, id: string): Record<string, unknown> {
  const db = new Database(b.dbPath);
  const row = db
    .query("SELECT locked, locked_by, locked_group, locked_by_token, locked_at FROM roadmap_items WHERE id = ?")
    .get(id) as Record<string, unknown>;
  db.close();
  return row;
}

const RELEASED = { locked: 0, locked_by: null, locked_group: null, locked_by_token: null, locked_at: null };

type ReleasePath = {
  name: string;
  holder: string;
  broker: () => TestBroker;
  extraSet?: string;
  extraParams?: string[];
  release: (id: string) => Promise<void>;
};

const PATHS: ReleasePath[] = [
  {
    name: "/roadmap/lock-release",
    holder: "holder-lock-release",
    broker: () => broker,
    release: async () => {
      const res = await postTo<{ released?: string[] }>(
        broker,
        "/roadmap/lock-release",
        deckAuthored({ project_key: PK, peer_ids: ["holder-lock-release"] })
      );
      expect(res.body.released).toEqual(["holder-lock-release"]);
    },
  },
  {
    name: "/roadmap/archive",
    holder: "holder-archive",
    broker: () => broker,
    release: async (id) => {
      expect((await postTo(broker, "/roadmap/archive", deckAuthored({ id }))).status).toBe(200);
    },
  },
  {
    name: "/roadmap/upsert leaving in_progress",
    holder: "holder-upsert",
    broker: () => broker,
    release: async (id) => {
      expect((await postTo(broker, "/roadmap/upsert", deckAuthored({ id, status: "done" }))).status).toBe(200);
    },
  },
  {
    name: "/roadmap/sync/lock release by the relaying replica",
    holder: "holder-sync-lock",
    broker: () => broker,
    extraSet: ", lock_relay = ?, lock_relay_seen = datetime('now')",
    extraParams: ["replica-held"],
    release: async (id) => {
      const res = await postTo<{ released?: boolean }>(broker, "/roadmap/sync/lock", {
        replica_id: "replica-held",
        id,
        action: "release",
        owner: { peer_id: "holder-sync-lock", group_id: null },
      });
      expect(res.status).toBe(200);
      expect(res.body.released).toBe(true);
    },
  },
  {
    name: "/roadmap/import force locked:false",
    holder: "holder-import",
    broker: () => broker,
    release: async (id) => {
      const res = await postTo<{ imported?: number }>(broker, "/roadmap/import", {
        project_key: PK,
        by: "test-peer",
        force: true,
        items: [{ id, kind: "feature", title: "release via import", locked: false }],
      });
      expect(res.body.imported).toBe(1);
    },
  },
  {
    name: "stale-lock sweep",
    holder: "holder-sweep",
    broker: () => sweeper,
    extraSet: ", updated_at = datetime('now', '-60 seconds')",
    release: async (id) => {
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        if (lockColumns(sweeper, id).locked === 0) return;
        await Bun.sleep(200);
      }
      throw new Error("the sweep never released the card within 12 s");
    },
  },
];

for (const path of PATHS) {
  test(`${path.name} clears every lock column`, async () => {
    const b = path.broker();
    const id = await createCard(b, `release via ${path.name}`);
    lockFully(b, id, path.holder, path.extraSet ?? "", path.extraParams ?? []);
    expect(lockColumns(b, id).locked_group).toBe("grp-held");
    await path.release(id);
    expect([path.name, lockColumns(b, id)]).toEqual([path.name, RELEASED]);
  }, 20_000);
}

test("broker.ts writes 'locked = 0,' only inside the shared CLEAR_LOCK_SET fragment", () => {
  const source = readFileSync(join(import.meta.dir, "..", "broker.ts"), "utf8");
  const definition = source.match(/const CLEAR_LOCK_SET =\s*"([^"]*)"/);
  expect(definition?.[1]).toBe(
    "locked = 0, locked_by = NULL, locked_group = NULL, locked_by_token = NULL, locked_at = NULL"
  );
  const handWritten = [...source.matchAll(/\blocked\s*=\s*0\s*,/g)].length - 1;
  expect(["hand-written lock releases outside CLEAR_LOCK_SET", handWritten]).toEqual([
    "hand-written lock releases outside CLEAR_LOCK_SET",
    0,
  ]);
});
