import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { startBroker, stopBroker, post, get, livePid, type TestBroker } from "./_helper.ts";

let broker: TestBroker;

beforeAll(async () => {
  // MESSAGE_TTL_DAYS=1 means anything older than 24h is purged when /admin/purge-messages runs.
  // PURGE_INTERVAL_SEC at max (3600) keeps the test deterministic; tests trigger purge manually.
  broker = await startBroker({
    CLAUDE_PEERS_MESSAGE_TTL_DAYS: "1",
    CLAUDE_PEERS_GRAPH_DRAFT_TTL_DAYS: "1",
    CLAUDE_PEERS_PURGE_INTERVAL_SEC: "3600",
  });
});
afterAll(async () => { await stopBroker(broker); });

async function register(host: string, cwd: string, projectKey: string | null = null) {
  return post<{ peer_id: string; instance_token: string }>(`${broker.url}/register`, {
    pid: livePid(), cwd, git_root: null, tty: null, summary: "", host, client_pid: 1,
    project_key: projectKey, group_id: "default", group_secret_hash: null,
  });
}

function insertMessageAt(from_token: string, to_token: string, text: string, sentAtIso: string, delivered: 0 | 1 = 0) {
  const db = new Database(broker.dbPath);
  try {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 3000");
    const group_id = (db.query("SELECT group_id FROM peers WHERE instance_token = ?").get(from_token) as { group_id: string }).group_id;
    db.run(
      `INSERT INTO messages (from_token, to_token, group_id, text, sent_at, delivered)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [from_token, to_token, group_id, text, sentAtIso, delivered]
    );
  } finally {
    db.close();
  }
}

function countMessages(filter: string = "1=1", ...params: unknown[]): number {
  const db = new Database(broker.dbPath, { readonly: true });
  try {
    const r = db.query(`SELECT COUNT(*) AS c FROM messages WHERE ${filter}`).get(...(params as any[])) as { c: number };
    return r.c;
  } finally {
    db.close();
  }
}

test("purge supprime les messages non-livres plus vieux que MESSAGE_TTL_DAYS", async () => {
  const x = await register("httl1x", "/ttl1x");
  const y = await register("httl1y", "/ttl1y");

  const now = Date.now();
  // 5 anciens (>1j) non livres -- doivent etre purges
  for (let i = 0; i < 5; i++) {
    const t = new Date(now - (48 + i) * 3600 * 1000).toISOString();
    insertMessageAt(x.body.instance_token, y.body.instance_token, `OLD#${i}`, t, 0);
  }
  // 5 frais (<1j) non livres -- doivent rester
  for (let i = 0; i < 5; i++) {
    const t = new Date(now - i * 60 * 60 * 1000).toISOString();
    insertMessageAt(x.body.instance_token, y.body.instance_token, `FRESH#${i}`, t, 0);
  }

  expect(countMessages()).toBe(10);

  const purge = await get<{ purged: number; cutoff_days: number }>(`${broker.url}/admin/purge-messages`);
  expect(purge.status).toBe(200);
  expect(purge.body.cutoff_days).toBe(1);
  expect(purge.body.purged).toBe(5);

  const remaining = countMessages();
  expect(remaining).toBe(5);
  // Tous les restants doivent etre FRESH#*
  const db = new Database(broker.dbPath, { readonly: true });
  try {
    const texts = (db.query("SELECT text FROM messages ORDER BY sent_at DESC").all() as { text: string }[]).map((r) => r.text);
    expect(texts.every((t) => t.startsWith("FRESH#"))).toBe(true);
  } finally {
    db.close();
  }
});

test("purge ne touche PAS les messages delivered=1 meme s'ils sont anciens", async () => {
  const x = await register("httl2x", "/ttl2x");
  const y = await register("httl2y", "/ttl2y");

  const now = Date.now();
  // 3 anciens delivered=1 -- doivent rester (TTL ne concerne que les non-livres)
  for (let i = 0; i < 3; i++) {
    const t = new Date(now - (72 + i) * 3600 * 1000).toISOString();
    insertMessageAt(x.body.instance_token, y.body.instance_token, `DELIV-OLD#${i}`, t, 1);
  }
  // 2 anciens delivered=0 -- doivent etre purges
  for (let i = 0; i < 2; i++) {
    const t = new Date(now - (72 + i) * 3600 * 1000).toISOString();
    insertMessageAt(x.body.instance_token, y.body.instance_token, `PEND-OLD#${i}`, t, 0);
  }

  const purge = await get<{ purged: number }>(`${broker.url}/admin/purge-messages`);
  expect(purge.body.purged).toBe(2);

  // Les 3 delivered=1 ciblant Y du test courant sont toujours la, les 2 delivered=0 ont disparu
  expect(countMessages("to_token = ? AND delivered = 1", y.body.instance_token)).toBe(3);
  expect(countMessages("to_token = ? AND delivered = 0", y.body.instance_token)).toBe(0);
});

test("purge des graph drafts : opened au-dela du TTL supprime, pending jamais", async () => {
  // Card 3781b033: /graph-draft/add derives project_key/by from a proven
  // instance_token now, not from the body -- register a real peer first.
  const author = await register("httl-graph", "/ttl-graph", "github.com/vocsap/ttl-test");
  // Deux drafts via l'API, backdates directement en SQLite (comme les messages).
  const mk = async (title: string) => {
    const res = await post<{ draft: { id: string } }>(`${broker.url}/graph-draft/add`, {
      instance_token: author.body.instance_token,
      by: author.body.peer_id,
      title,
      prompt: "p",
    });
    expect(res.status).toBe(200);
    return res.body.draft.id;
  };
  const openedOld = await mk("opened-old");
  const pendingOld = await mk("pending-old");
  const openedFresh = await mk("opened-fresh");
  await get(`${broker.url}/admin/purge-messages`); // no-op baseline

  const old = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
  const db = new Database(broker.dbPath);
  try {
    db.run("PRAGMA busy_timeout = 3000");
    db.run("UPDATE graph_drafts SET status='opened', opened_at=? WHERE id=?", [old, openedOld]);
    db.run("UPDATE graph_drafts SET created_at=? WHERE id=?", [old, pendingOld]);
    db.run("UPDATE graph_drafts SET status='opened', opened_at=? WHERE id=?", [
      new Date().toISOString(),
      openedFresh,
    ]);
  } finally {
    db.close();
  }

  const purge = await get<{ purged_drafts: number; draft_cutoff_days: number }>(
    `${broker.url}/admin/purge-messages`
  );
  expect(purge.body.draft_cutoff_days).toBe(1);
  expect(purge.body.purged_drafts).toBe(1);

  const check = new Database(broker.dbPath, { readonly: true });
  try {
    const ids = (check.query("SELECT id FROM graph_drafts").all() as { id: string }[]).map((r) => r.id);
    expect(ids).not.toContain(openedOld); // opened + vieux -> purge
    expect(ids).toContain(pendingOld); // pending, meme tres vieux -> conserve
    expect(ids).toContain(openedFresh); // opened recent -> conserve
  } finally {
    check.close();
  }
});

test("purge run au boot du broker (initial call)", async () => {
  // Demarrer un broker dedie pour ce test : on ne peut pas insert AVANT le boot
  // (DB n'existe pas), donc on insert, on stop, puis on redemarre avec TTL=1.
  const b1 = await startBroker({ CLAUDE_PEERS_MESSAGE_TTL_DAYS: "1" });
  const reg = await post<{ instance_token: string }>(`${b1.url}/register`, {
    pid: livePid(), cwd: "/boot", git_root: null, tty: null, summary: "", host: "hboot",
    client_pid: 1, project_key: null, group_id: "default", group_secret_hash: null,
  });
  const reg2 = await post<{ instance_token: string }>(`${b1.url}/register`, {
    pid: livePid(), cwd: "/boot2", git_root: null, tty: null, summary: "", host: "hboot2",
    client_pid: 1, project_key: null, group_id: "default", group_secret_hash: null,
  });

  // Insert manuellement 2 anciens et 1 frais directement en SQLite
  const db = new Database(b1.dbPath);
  try {
    db.run("PRAGMA journal_mode = WAL");
    const gid = (db.query("SELECT group_id FROM peers WHERE instance_token = ?").get(reg.body.instance_token) as { group_id: string }).group_id;
    db.run(
      `INSERT INTO messages (from_token, to_token, group_id, text, sent_at, delivered)
       VALUES (?, ?, ?, 'OLD', datetime('now','-3 days'), 0),
              (?, ?, ?, 'OLD2', datetime('now','-2 days'), 0),
              (?, ?, ?, 'FRESH', datetime('now'), 0)`,
      [
        reg.body.instance_token, reg2.body.instance_token, gid,
        reg.body.instance_token, reg2.body.instance_token, gid,
        reg.body.instance_token, reg2.body.instance_token, gid,
      ]
    );
  } finally {
    db.close();
  }

  // Le call initial purgeOldMessages() au boot suit le meme code path que /admin/purge-messages,
  // donc on declenche manuellement pour valider que le mecanisme purge bien 2 anciens / garde 1 frais.
  const purge = await get<{ purged: number }>(`${b1.url}/admin/purge-messages`);
  expect(purge.body.purged).toBe(2);

  const db2 = new Database(b1.dbPath, { readonly: true });
  try {
    const remaining = (db2.query("SELECT text FROM messages").all() as { text: string }[]).map((r) => r.text);
    expect(remaining).toEqual(["FRESH"]);
  } finally {
    db2.close();
  }

  await stopBroker(b1);
});
