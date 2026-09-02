import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { startBroker, stopBroker, post, livePid, groupId, sha256Hex, type TestBroker } from "./_helper.ts";

let broker: TestBroker;

beforeAll(async () => {
  // Capped flush: 5 most recent within 12h, beyond which messages stay in DB
  // but are not replayed on WS reconnect.
  broker = await startBroker({
    CLAUDE_PEERS_FLUSH_MAX_COUNT: "5",
    CLAUDE_PEERS_FLUSH_MAX_AGE_HOURS: "12",
  });
});
afterAll(async () => { await stopBroker(broker); });

async function register(host: string, cwd: string) {
  return post<{ peer_id: string; instance_token: string }>(`${broker.url}/register`, {
    pid: livePid(), cwd, git_root: null, tty: null, summary: "", host, client_pid: 1,
    project_key: null, group_id: "default", group_secret_hash: null,
  });
}

function insertMessageAt(from_token: string, to_token: string, text: string, sentAtIso: string) {
  // Same DB file used by the broker process; WAL mode permits concurrent writers.
  const db = new Database(broker.dbPath);
  try {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 3000");
    const group_id = db.query("SELECT group_id FROM peers WHERE instance_token = ?").get(from_token) as { group_id: string };
    db.run(
      `INSERT INTO messages (from_token, to_token, group_id, text, sent_at, delivered)
       VALUES (?, ?, ?, ?, ?, 0)`,
      [from_token, to_token, group_id.group_id, text, sentAtIso]
    );
  } finally {
    db.close();
  }
}

async function registerInGroup(group_id: string, secret: string, host: string, cwd: string) {
  const group_secret_hash = await sha256Hex(secret);
  return post<{ peer_id: string; instance_token: string }>(`${broker.url}/register`, {
    pid: livePid(), cwd, git_root: null, tty: null, summary: "", host, client_pid: 1,
    project_key: null, group_id, group_secret_hash,
  });
}

async function openAuthedWs(token: string): Promise<{ ws: WebSocket; messages: any[] }> {
  const messages: any[] = [];
  const ws = new WebSocket(broker.wsUrl);
  ws.addEventListener("message", (ev) => {
    const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
    messages.push(JSON.parse(text));
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "auth", instance_token: token }));
      resolve();
    });
    ws.addEventListener("error", () => reject(new Error("ws err")));
    setTimeout(() => reject(new Error("open timeout")), 2000);
  });
  return { ws, messages };
}

test("flush WS limits to FLUSH_MAX_COUNT most-recent in FLUSH_MAX_AGE_HOURS window, ASC order", async () => {
  const x = await register("hcap1x", "/cap1x");
  const y = await register("hcap1y", "/cap1y");

  const now = Date.now();
  // 3 messages too old (> 12h) -- must be excluded by the age window
  for (let i = 0; i < 3; i++) {
    const t = new Date(now - (24 + i) * 3600 * 1000).toISOString();
    insertMessageAt(x.body.instance_token, y.body.instance_token, `OLD#${i}`, t);
  }
  // 10 messages in the window (< 12h), spaced 30 min apart back from now
  for (let i = 0; i < 10; i++) {
    const t = new Date(now - i * 30 * 60 * 1000).toISOString();
    insertMessageAt(x.body.instance_token, y.body.instance_token, `WIN#${i}`, t);
  }

  const { ws, messages } = await openAuthedWs(y.body.instance_token);
  // Wait for flush frames
  for (let i = 0; i < 30 && messages.length < 5; i++) await Bun.sleep(50);
  await Bun.sleep(150); // extra guard against late frames

  // Cap = 5 frames, none of them OLD#*, ordered ASC by sent_at
  expect(messages.length).toBe(5);
  expect(messages.every((m) => m.type === "message")).toBe(true);
  const texts = messages.map((m) => m.text as string);
  expect(texts.every((t) => t.startsWith("WIN#"))).toBe(true);
  // The 5 most-recent of WIN#0..WIN#9 are WIN#0..WIN#4 (since WIN#0 is now, WIN#9 is oldest).
  // Sorted ASC by sent_at means oldest of the kept ones first -> WIN#4, WIN#3, WIN#2, WIN#1, WIN#0.
  expect(texts).toEqual(["WIN#4", "WIN#3", "WIN#2", "WIN#1", "WIN#0"]);

  ws.close();
});

test("/poll-messages still returns the full backlog (cap only affects WS flush)", async () => {
  const x = await register("hcap2x", "/cap2x");
  const y = await register("hcap2y", "/cap2y");

  const now = Date.now();
  // 8 messages in the window (more than cap=5)
  for (let i = 0; i < 8; i++) {
    const t = new Date(now - i * 60 * 1000).toISOString();
    insertMessageAt(x.body.instance_token, y.body.instance_token, `M#${i}`, t);
  }
  // 2 older than 12h
  for (let i = 0; i < 2; i++) {
    const t = new Date(now - (15 + i) * 3600 * 1000).toISOString();
    insertMessageAt(x.body.instance_token, y.body.instance_token, `OLD#${i}`, t);
  }

  // Explicit pull must return ALL 10 (cap is only for WS flush)
  const poll = await post<{ messages: { text: string }[] }>(`${broker.url}/poll-messages`, {
    instance_token: y.body.instance_token,
  });
  expect(poll.status).toBe(200);
  expect(poll.body.messages.length).toBe(10);
});

test("/peek-messages also returns the full backlog without marking delivered", async () => {
  const x = await register("hcap3x", "/cap3x");
  const y = await register("hcap3y", "/cap3y");

  const now = Date.now();
  for (let i = 0; i < 7; i++) {
    const t = new Date(now - i * 60 * 1000).toISOString();
    insertMessageAt(x.body.instance_token, y.body.instance_token, `P#${i}`, t);
  }

  const peek = await post<{ messages: { text: string }[] }>(`${broker.url}/peek-messages`, {
    instance_token: y.body.instance_token,
  });
  expect(peek.status).toBe(200);
  expect(peek.body.messages.length).toBe(7);

  // delivered must still be 0 after peek
  const db = new Database(broker.dbPath, { readonly: true });
  try {
    const rows = db.query("SELECT delivered FROM messages WHERE to_token = ?").all(y.body.instance_token) as { delivered: number }[];
    expect(rows.length).toBe(7);
    expect(rows.every((r) => r.delivered === 0)).toBe(true);
  } finally {
    db.close();
  }
});

// The 'operator' token routes every group's /send-message to one shared
// sentinel tagged with the sender's group_id, so it legitimately accumulates
// rows across groups; selectUndeliveredCapped's group_id filter exists to keep
// those separated.
test("flush WS withholds a cross-group message and still delivers a same-group one (selectUndeliveredCapped group_id filter)", async () => {
  const seed = crypto.randomUUID();
  const groupA = await groupId(`${seed}-A`);
  const groupB = await groupId(`${seed}-B`);
  const x = await registerInGroup(groupA, `${seed}-A`, "hcap4x", "/cap4x");
  const y = await registerInGroup(groupB, `${seed}-B`, "hcap4y", "/cap4y");
  const z = await registerInGroup(groupB, `${seed}-B`, "hcap4z", "/cap4z");

  const now = Date.now();
  insertMessageAt(x.body.instance_token, y.body.instance_token, "CROSS-GROUP", new Date(now).toISOString());
  insertMessageAt(z.body.instance_token, y.body.instance_token, "SAME-GROUP", new Date(now).toISOString());

  const { ws, messages } = await openAuthedWs(y.body.instance_token);
  for (let i = 0; i < 30 && messages.length < 1; i++) await Bun.sleep(50);
  await Bun.sleep(150); // extra guard against late frames

  const texts = messages.map((m) => m.text as string);
  expect(texts).toContain("SAME-GROUP");
  expect(texts).not.toContain("CROSS-GROUP");
  ws.close();

  // The withheld row must still exist, undelivered -- proof it was correctly
  // scoped out, not silently dropped/deleted.
  const db = new Database(broker.dbPath, { readonly: true });
  try {
    const row = db
      .query("SELECT delivered FROM messages WHERE to_token = ? AND text = ?")
      .get(y.body.instance_token, "CROSS-GROUP") as { delivered: number } | null;
    expect(row).not.toBeNull();
    expect(row!.delivered).toBe(0);
  } finally {
    db.close();
  }
});
