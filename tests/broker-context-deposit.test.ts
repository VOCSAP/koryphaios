import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { deckAuthored, groupId, livePid, sha256Hex, startBroker, stopBroker, type TestBroker } from "./_helper.ts";
import { buildAuthProof, deriveOperatorId, generateCredential } from "../shared/approval.ts";
import {
  CONTEXT_DEPOSIT_MAX_BODY_BYTES,
  CONTEXT_DEPOSIT_MAX_CHARS,
  CONTEXT_DEPOSITS_PER_OWNER,
  CONTEXT_RESUME_VERSION,
  hashCapability,
} from "../shared/context-buffer.ts";

// A refusal sent before the body is read must not poison the keep-alive
// connection; an HTTP proxy from the environment would hide that by owning
// the connection, so this file talks to the broker directly.
process.env.NO_PROXY = "127.0.0.1,localhost";

const HOST = hostname();
const CWD = "C:/work/shared-cwd";

interface Group {
  id: string;
  secretHash: string;
}

interface Peer {
  peer_id: string;
  instance_token: string;
}

interface Reply {
  status: number;
  text: string;
  body: Record<string, unknown>;
}

const newCapability = (): string => randomBytes(32).toString("hex");

async function makeGroup(): Promise<Group> {
  const secret = randomUUID();
  return { id: await groupId(secret), secretHash: await sha256Hex(secret) };
}

/** Every response text this file receives, scanned at the end for a leaked capability or hash. */
const seenResponses: string[] = [];

async function call(b: TestBroker, path: string, body: unknown, bearer?: string): Promise<Reply> {
  const res = await fetch(`${b.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  seenResponses.push(text);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON body kept as text */
  }
  return { status: res.status, text, body: parsed };
}

async function register(
  b: TestBroker,
  group: Group | "default",
  opts: {
    deskSession?: string;
    capability?: string | null;
    hash?: unknown;
    groupSecretHash?: string | null;
    pid?: number;
    bearer?: string;
    resume?: unknown;
  } = {}
): Promise<Peer> {
  const hash =
    "hash" in opts ? opts.hash : opts.capability === undefined || opts.capability === null ? undefined : hashCapability(opts.capability);
  const resume = "resume" in opts ? opts.resume : CONTEXT_RESUME_VERSION;
  const r = await call(
    b,
    "/register",
    {
      pid: opts.pid ?? livePid(),
      cwd: CWD,
      git_root: null,
      tty: null,
      summary: "",
      host: HOST,
      client_pid: 1,
      project_key: null,
      group_id: group === "default" ? "default" : group.id,
      group_secret_hash: group === "default" ? null : "groupSecretHash" in opts ? opts.groupSecretHash : group.secretHash,
      desk_session: opts.deskSession ?? randomUUID(),
      ...(hash === undefined ? {} : { deposit_capability_hash: hash }),
      ...(resume === undefined ? {} : { context_resume_version: resume }),
    },
    opts.bearer
  );
  if (r.status !== 200) throw new Error(`/register answered ${r.status}: ${r.text}`);
  return r.body as unknown as Peer;
}

function depositBody(capability: unknown, text: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { deposit_capability: capability, text, head: null, branch: null, git_root: null, ...extra };
}

async function deposit(
  b: TestBroker,
  capability: unknown,
  text: unknown = "next: rerun the tests",
  extra: Record<string, unknown> = {},
  bearer?: string
) {
  return call(b, "/context/deposit", depositBody(capability, text, extra), bearer);
}

function transactionBody(
  group: Group,
  targetPeerId: string,
  depositId: string,
  action: "reserve" | "release",
  attemptId?: string,
  cleared?: boolean
): Record<string, unknown> {
  return {
    group_id: group.id,
    group_secret_hash: group.secretHash,
    target_peer_id: targetPeerId,
    deposit_id: depositId,
    action,
    ...(attemptId ? { attempt_id: attemptId } : {}),
    ...(cleared === undefined ? {} : { cleared }),
  };
}

async function transaction(
  b: TestBroker,
  group: Group,
  targetPeerId: string,
  depositId: string,
  action: "reserve" | "release",
  attemptId?: string,
  operatorAuth = true,
  cleared?: boolean
): Promise<Reply> {
  const body = transactionBody(group, targetPeerId, depositId, action, attemptId, cleared);
  return call(b, "/context/transaction", operatorAuth ? deckAuthored(body) : body);
}

function withDb<T>(b: TestBroker, fn: (db: Database) => T): T {
  const db = new Database(b.dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function waitFor(what: string, ms: number, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

let broker: TestBroker;
let G: Group;

beforeAll(async () => {
  broker = await startBroker();
  G = await makeGroup();
});

afterAll(async () => {
  await stopBroker(broker);
});

describe("POST /context/deposit on a real broker", () => {
  test("a nominal deposit answers 200 with its metadata and never echoes the text", async () => {
    const cap = newCapability();
    const peer = await register(broker, G, { capability: cap });
    const r = await deposit(broker, cap, "witness-nominal", {
      head: "a".repeat(40),
      branch: "card/x",
      git_root: "C:/work",
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      owner_peer_id: peer.peer_id,
      chars: "witness-nominal".length,
      limit_chars: CONTEXT_DEPOSIT_MAX_CHARS,
      head_at_deposit: "a".repeat(40),
      branch: "card/x",
      state: "held",
    });
    expect(r.body.deposit_id).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof r.body.deposited_at).toBe("string");
    expect(r.body.held).toEqual([
      { deposit_id: r.body.deposit_id, chars: "witness-nominal".length, deposited_at: r.body.deposited_at },
    ]);
    expect(r.text).not.toContain("witness-nominal");
  });

  test("the cap is CONTEXT_DEPOSIT_MAX_CHARS code points: at the cap accepted, one over refused 413 with nothing stored", async () => {
    const cap = newCapability();
    await register(broker, G, { capability: cap });
    const atCap = await deposit(broker, cap, "\u{1F600}".repeat(CONTEXT_DEPOSIT_MAX_CHARS));
    expect(atCap.status).toBe(200);
    const over = await deposit(broker, cap, "\u{1F600}".repeat(CONTEXT_DEPOSIT_MAX_CHARS + 1));
    expect(over.status).toBe(413);
    expect(over.body).toMatchObject({ reason: "too_long", max_chars: CONTEXT_DEPOSIT_MAX_CHARS, got_chars: CONTEXT_DEPOSIT_MAX_CHARS + 1 });
    const next = await deposit(broker, cap, "small");
    expect((next.body.held as unknown[]).length).toBe(2);
  });

  test("refused contents answer 400 with a reason per class and store nothing", async () => {
    const cap = newCapability();
    await register(broker, G, { capability: cap });
    const cases: Array<[string, string]> = [
      ["   ", "empty_text"],
      ["a\uD800b", "ill_formed_text"],
      ["a\u0001b", "forbidden_characters"],
      ["a\u202Eb", "forbidden_characters"],
      ["a\u2028b", "forbidden_characters"],
    ];
    for (const [text, reason] of cases) {
      const r = await deposit(broker, cap, text);
      expect({ text: JSON.stringify(text), status: r.status, reason: r.body.reason }).toEqual({
        text: JSON.stringify(text),
        status: 400,
        reason,
      });
    }
    const ok = await deposit(broker, cap, "fine");
    expect((ok.body.held as unknown[]).length).toBe(1);
  });

  test("malformed bodies are refused before any lookup", async () => {
    const cap = newCapability();
    await register(broker, G, { capability: cap });
    expect((await deposit(broker, cap, 42)).body.reason).toBe("bad_body");
    expect((await deposit(broker, cap, "t", { head: "XYZ" })).body.reason).toBe("bad_git_fact");
    expect((await deposit(broker, cap, "t", { branch: "a\u0000b" })).body.reason).toBe("bad_git_fact");
    expect((await deposit(broker, cap, "t", { replace: "not-an-id" })).body.reason).toBe("bad_replace_id");
    const notJson = await fetch(`${broker.url}/context/deposit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"text": "json-canary`,
    });
    expect(notJson.status).toBe(400);
    expect(((await notJson.json()) as { reason: string }).reason).toBe("bad_body");

    const tooBig = await fetch(`${broker.url}/context/deposit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(depositBody(cap, "x".repeat(CONTEXT_DEPOSIT_MAX_BODY_BYTES))),
    });
    expect(tooBig.status).toBe(413);
    expect(((await tooBig.json()) as { reason: string }).reason).toBe("body_too_large");

    const encoded = new TextEncoder().encode(JSON.stringify(depositBody(cap, "streamed")));
    const chunked = await fetch(`${broker.url}/context/deposit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoded);
          controller.close();
        },
      }),
    });
    expect(chunked.status).toBe(400);
    expect(((await chunked.json()) as { reason: string }).reason).toBe("length_required");

    for (let i = 0; i < 3; i += 1) {
      expect((await deposit(broker, cap, `after the refusals ${i}`)).status).toBe(200);
    }
  });

  test("every invalid capability answers the same 401 and stores nothing", async () => {
    const unboundCap = newCapability();
    await register(broker, G);
    const dormantCap = newCapability();
    const dormant = await register(broker, G, { capability: dormantCap });
    expect((await deposit(broker, dormantCap)).status).toBe(200);
    await call(broker, "/disconnect", { instance_token: dormant.instance_token });
    const defaultCap = newCapability();
    await register(broker, "default", { capability: defaultCap });

    const refusals = [
      await call(broker, "/context/deposit", { text: "t", head: null, branch: null, git_root: null }),
      await deposit(broker, "not-hex"),
      await deposit(broker, "A".repeat(64)),
      await deposit(broker, newCapability()),
      await deposit(broker, unboundCap),
      await deposit(broker, dormantCap),
      await deposit(broker, defaultCap),
    ];
    for (const r of refusals) {
      expect({ status: r.status, body: r.body }).toEqual({
        status: 401,
        body: { error: refusals[0]!.body.error, reason: "capability" },
      });
    }
  });

  test("each of the four /register branches binds the hash to the token it returns", async () => {
    // Fresh registration.
    const desk = randomUUID();
    const capFresh = newCapability();
    const fresh = await register(broker, G, { deskSession: desk, capability: capFresh });
    expect((await deposit(broker, capFresh)).status).toBe(200);

    // Resurrection of a dormant row: same token, new launch.
    await call(broker, "/disconnect", { instance_token: fresh.instance_token });
    const capResurrect = newCapability();
    const resurrected = await register(broker, G, { deskSession: desk, capability: capResurrect });
    expect(resurrected.instance_token).toBe(fresh.instance_token);
    expect((await deposit(broker, capResurrect)).status).toBe(200);
    expect((await deposit(broker, capFresh)).status).toBe(401);

    // Reinsertion after the peer row was purged while its session row stayed.
    await call(broker, "/disconnect", { instance_token: fresh.instance_token });
    withDb(broker, (db) => db.run("DELETE FROM peers WHERE instance_token = ?", [fresh.instance_token]));
    const capReinsert = newCapability();
    const reinserted = await register(broker, G, { deskSession: desk, capability: capReinsert });
    expect(reinserted.instance_token).toBe(fresh.instance_token);
    expect((await deposit(broker, capReinsert)).status).toBe(200);

    // Active collision: a second live process on the same session key gets a fresh token.
    const capCollision = newCapability();
    const collided = await register(broker, G, { deskSession: desk, capability: capCollision });
    expect(collided.instance_token).not.toBe(fresh.instance_token);
    expect((await deposit(broker, capCollision)).body.owner_peer_id).toBe(collided.peer_id);
  });

  test("an absent or malformed hash on a later register drops the binding and the deposits", async () => {
    const desk = randomUUID();
    const cap = newCapability();
    const peer = await register(broker, G, { deskSession: desk, capability: cap });
    const first = await deposit(broker, cap, "will be dropped");
    expect(first.status).toBe(200);
    await call(broker, "/disconnect", { instance_token: peer.instance_token });
    await register(broker, G, { deskSession: desk, hash: "ZZ" });
    expect((await deposit(broker, cap)).status).toBe(401);

    await call(broker, "/disconnect", { instance_token: peer.instance_token });
    await register(broker, G, { deskSession: desk, capability: cap });
    const replaced = await deposit(broker, cap, "t", { replace: first.body.deposit_id });
    expect(replaced.status).toBe(404);
  });

  test("two tiles in one cwd and group are isolated: deposits, quotas and replace", async () => {
    const capA = newCapability();
    const capB = newCapability();
    await register(broker, G, { capability: capA });
    await register(broker, G, { capability: capB });
    const ids: string[] = [];
    for (let i = 0; i < CONTEXT_DEPOSITS_PER_OWNER; i += 1) {
      const r = await deposit(broker, capA, `a-${i}`);
      expect(r.status).toBe(200);
      ids.push(r.body.deposit_id as string);
    }
    const full = await deposit(broker, capA, "one too many");
    expect(full.status).toBe(429);
    expect(full.body.reason).toBe("quota_owner");
    expect((full.body.held_ids as string[]).sort()).toEqual([...ids].sort());

    const b = await deposit(broker, capB, "b-0");
    expect(b.status).toBe(200);
    expect((b.body.held as unknown[]).length).toBe(1);
    const stolen = await deposit(broker, capB, "steal", { replace: ids[0] });
    const unknown = await deposit(broker, capB, "steal", { replace: "0123456789abcdef" });
    expect(stolen.status).toBe(404);
    expect(stolen.body).toEqual(unknown.body);
    const mine = await deposit(broker, capA, "replaced", { replace: ids[0] });
    expect(mine.status).toBe(200);
    expect(mine.body.replaced).toBe(ids[0]);
  });

  test("two active peers behind one capability are contested until one leaves", async () => {
    const cap = newCapability();
    const desk = randomUUID();
    const tile = await register(broker, G, { deskSession: desk, capability: cap });
    const nested = await register(broker, G, { deskSession: desk, capability: cap });
    expect(nested.instance_token).not.toBe(tile.instance_token);
    const contested = await deposit(broker, cap, "nested");
    expect(contested.status).toBe(409);
    expect(contested.body.reason).toBe("contested");
    await call(broker, "/disconnect", { instance_token: nested.instance_token });
    const after = await deposit(broker, cap, "tile alone");
    expect(after.status).toBe(200);
    expect(after.body.owner_peer_id).toBe(tile.peer_id);
    expect((after.body.held as unknown[]).length).toBe(1);
  });

  test("set_id does not detach a deposit from its owner", async () => {
    const cap = newCapability();
    const peer = await register(broker, G, { capability: cap });
    const first = await deposit(broker, cap, "before rename");
    const renamed = `ren-${randomBytes(3).toString("hex")}`;
    const r = await call(broker, "/set-id", { instance_token: peer.instance_token, new_peer_id: renamed });
    expect(r.status).toBe(200);
    const second = await deposit(broker, cap, "after rename", { replace: first.body.deposit_id });
    expect(second.status).toBe(200);
    expect(second.body.owner_peer_id).toBe(renamed);
    expect(second.body.replaced).toBe(first.body.deposit_id);
  });

  test("a re-register of the same token, same capability or another, drops the earlier deposits", async () => {
    const desk = randomUUID();
    const cap = newCapability();
    const peer = await register(broker, G, { deskSession: desk, capability: cap });
    const first = await deposit(broker, cap, "first launch");
    await call(broker, "/disconnect", { instance_token: peer.instance_token });
    await register(broker, G, { deskSession: desk, capability: cap });
    const again = await deposit(broker, cap, "t", { replace: first.body.deposit_id });
    expect(again.status).toBe(404);
    const second = await deposit(broker, cap, "same launch, reconnected");
    expect((second.body.held as unknown[]).length).toBe(1);

    await call(broker, "/disconnect", { instance_token: peer.instance_token });
    const nextCap = newCapability();
    await register(broker, G, { deskSession: desk, capability: nextCap });
    expect((await deposit(broker, cap)).status).toBe(401);
    expect((await deposit(broker, nextCap, "t", { replace: second.body.deposit_id })).status).toBe(404);
  });

  test("/disconnect and /unregister refuse the capability at once", async () => {
    const capD = newCapability();
    const d = await register(broker, G, { capability: capD });
    expect((await deposit(broker, capD)).status).toBe(200);
    await call(broker, "/disconnect", { instance_token: d.instance_token });
    expect((await deposit(broker, capD)).status).toBe(401);

    const capU = newCapability();
    const u = await register(broker, G, { capability: capU });
    expect((await deposit(broker, capU)).status).toBe(200);
    await call(broker, "/unregister", { instance_token: u.instance_token });
    expect((await deposit(broker, capU)).status).toBe(401);
  });

  test("the deposit text never reaches the SQLite file or its WAL, while a summary does", async () => {
    const cap = newCapability();
    const peer = await register(broker, G, { capability: cap });
    const canary = `sqlite-canary-${randomUUID()}`;
    const control = `sqlite-control-${randomUUID()}`;
    expect((await deposit(broker, cap, canary)).status).toBe(200);
    await call(broker, "/set-summary", { instance_token: peer.instance_token, summary: control });
    const dump = [broker.dbPath, `${broker.dbPath}-wal`]
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p).toString("latin1"))
      .join("\n");
    expect(dump.includes(control)).toBe(true);
    expect(dump.includes(canary)).toBe(false);
    expect(dump.includes(hashCapability(cap))).toBe(false);
  });

  test("nothing is published: admin, health and group stats carry neither text nor capability", async () => {
    const cap = newCapability();
    await register(broker, G, { capability: cap });
    const canary = `publish-canary-${randomUUID()}`;
    expect((await deposit(broker, cap, canary)).status).toBe(200);
    for (const path of ["/admin/peers?include_dormant=1", "/health", "/group-stats"]) {
      const text = await (await fetch(`${broker.url}${path}`)).text();
      expect({ path, leaks: [canary, cap, hashCapability(cap)].filter((s) => text.includes(s)) }).toEqual({ path, leaks: [] });
    }
  });
});

describe("POST /context/transaction on a real broker", () => {
  test("an operator credential is required for reservation and release", async () => {
    const capA = newCapability();
    const capB = newCapability();
    const peerA = await register(broker, G, { capability: capA });
    await register(broker, G, { capability: capB });
    const deposited = await deposit(broker, capA, "operator-auth-canary");
    const depositId = deposited.body.deposit_id as string;

    expect(await transaction(broker, G, peerA.peer_id, depositId, "reserve", undefined, false)).toMatchObject({ status: 401 });
    const reserved = await transaction(broker, G, peerA.peer_id, depositId, "reserve");
    expect(reserved).toMatchObject({ status: 200, body: { ok: true, state: "reserved" } });
    const attemptId = reserved.body.attempt_id as string;
    expect(await transaction(broker, G, peerA.peer_id, depositId, "release", attemptId, false)).toMatchObject({ status: 401 });
    expect(await transaction(broker, G, peerA.peer_id, depositId, "release", attemptId)).toMatchObject({
      status: 200,
      body: { ok: true, state: "held", attempt_id: attemptId },
    });
  });

  test("a group whose broker row pins no secret cannot transact", async () => {
    const unpinned = await makeGroup();
    const cap = newCapability();
    const peer = await register(broker, unpinned, { capability: cap, groupSecretHash: null });
    const deposited = await deposit(broker, cap, "unpinned-group-canary");
    const body = transactionBody(unpinned, peer.peer_id, deposited.body.deposit_id as string, "reserve");
    body.group_secret_hash = null;

    const refusal = await call(broker, "/context/transaction", deckAuthored(body));
    expect(refusal).toMatchObject({ status: 403, body: { error: "context transaction group pins no secret on this broker" } });
  });

  test("a release rejects another group and a different attempt", async () => {
    const cap = newCapability();
    const peer = await register(broker, G, { capability: cap });
    const deposited = await deposit(broker, cap, "release-binding-canary");
    const depositId = deposited.body.deposit_id as string;
    const reserved = await transaction(broker, G, peer.peer_id, depositId, "reserve");
    const attemptId = reserved.body.attempt_id as string;
    const otherGroup = await makeGroup();
    const otherPeer = await register(broker, otherGroup, { capability: newCapability() });

    expect(await transaction(broker, otherGroup, otherPeer.peer_id, depositId, "release", attemptId)).toMatchObject({
      status: 409,
      body: { ok: false, reason: "unavailable" },
    });
    expect(await transaction(broker, G, peer.peer_id, depositId, "release", "f".repeat(32))).toMatchObject({
      status: 409,
      body: { ok: false, reason: "unavailable" },
    });
    expect(await transaction(broker, G, peer.peer_id, depositId, "release", attemptId)).toMatchObject({
      status: 200,
      body: { ok: true, state: "held", attempt_id: attemptId },
    });
  });

  test("a mismatched group secret cannot reserve a deposit", async () => {
    const cap = newCapability();
    const peer = await register(broker, G, { capability: cap });
    const deposited = await deposit(broker, cap, "secret-canary");
    const depositId = deposited.body.deposit_id as string;
    const wrongSecret = { ...G, secretHash: randomBytes(32).toString("hex") };

    expect(await transaction(broker, wrongSecret, peer.peer_id, depositId, "reserve")).toMatchObject({ status: 401 });
    expect(await transaction(broker, G, peer.peer_id, depositId, "reserve")).toMatchObject({
      status: 200,
      body: { ok: true, state: "reserved" },
    });
  });

  test("two reservations of one deposit return one reservation and one explicit refusal", async () => {
    const cap = newCapability();
    const peer = await register(broker, G, { capability: cap });
    const deposited = await deposit(broker, cap, "transaction-canary");
    const depositId = deposited.body.deposit_id as string;

    const [first, second] = await Promise.all([
      transaction(broker, G, peer.peer_id, depositId, "reserve"),
      transaction(broker, G, peer.peer_id, depositId, "reserve"),
    ]);
    const reserved = [first, second].find((reply) => reply.status === 200);
    const refused = [first, second].find((reply) => reply.status !== 200);
    if (!reserved || !refused) throw new Error("reservation outcomes missing");

    expect(reserved.body).toMatchObject({ ok: true, deposit_id: depositId, state: "reserved" });
    expect(reserved.body.attempt_id).toMatch(/^[0-9a-f]{32}$/);
    expect(reserved.text).not.toContain("transaction-canary");
    expect(refused).toMatchObject({ status: 409, body: { ok: false, reason: "unavailable" } });
  });

  test("a matching release is idempotent and restores --replace", async () => {
    const cap = newCapability();
    const peer = await register(broker, G, { capability: cap });
    const deposited = await deposit(broker, cap, "release-canary");
    const depositId = deposited.body.deposit_id as string;
    const reserved = await transaction(broker, G, peer.peer_id, depositId, "reserve");
    const attemptId = reserved.body.attempt_id as string;

    const released = await transaction(broker, G, peer.peer_id, depositId, "release", attemptId);
    const replay = await transaction(broker, G, peer.peer_id, depositId, "release", attemptId);
    expect(released).toMatchObject({ status: 200, body: { ok: true, deposit_id: depositId, state: "held", attempt_id: attemptId } });
    expect(replay).toEqual(released);
    expect((await deposit(broker, cap, "replacement", { replace: depositId })).status).toBe(200);
  });

  test("a cleared release resumes once, rejects contradiction, and lets only its owner acknowledge", async () => {
    const cap = newCapability();
    const peer = await register(broker, G, { capability: cap });
    const deposited = await deposit(broker, cap, "resume-http-witness");
    const depositId = deposited.body.deposit_id as string;
    const reserved = await transaction(broker, G, peer.peer_id, depositId, "reserve");
    const attemptId = reserved.body.attempt_id as string;

    const released = await transaction(broker, G, peer.peer_id, depositId, "release", attemptId, true, true);
    const duplicate = await transaction(broker, G, peer.peer_id, depositId, "release", attemptId, true, true);
    const contradictory = await transaction(broker, G, peer.peer_id, depositId, "release", attemptId, true, false);
    expect(released).toMatchObject({ status: 200, body: { ok: true, state: "resuming", attempt_id: attemptId, resume_delivery: "pending" } });
    expect(duplicate).toEqual(released);
    expect(contradictory).toMatchObject({ status: 409, body: { ok: false, reason: "contradictory" } });
    expect((await deposit(broker, cap, "replacement", { replace: depositId })).status).toBe(404);

    const wrongAttempt = await call(broker, "/context/ack", { instance_token: peer.instance_token, deposit_id: depositId, attempt_id: "f".repeat(32) });
    const other = await register(broker, G, { capability: newCapability() });
    const wrongOwner = await call(broker, "/context/ack", { instance_token: other.instance_token, deposit_id: depositId, attempt_id: attemptId });
    expect(wrongAttempt).toMatchObject({ status: 409, body: { ok: false, reason: "unavailable" } });
    expect(wrongOwner).toEqual(wrongAttempt);
    const malformed = await call(broker, "/context/transaction", deckAuthored({
      ...transactionBody(G, peer.peer_id, depositId, "release", attemptId),
      cleared: "yes",
    }));
    expect(malformed).toMatchObject({ status: 400, body: { error: "cleared must be a boolean" } });
    const accepted = await call(broker, "/context/ack", { instance_token: peer.instance_token, deposit_id: depositId, attempt_id: attemptId });
    expect(accepted).toEqual({ status: 200, text: '{"ok":true}', body: { ok: true } });
    expect(await call(broker, "/context/ack", { instance_token: peer.instance_token, deposit_id: depositId, attempt_id: attemptId })).toEqual(accepted);
  });

  test("absent, replaced, wrong-owner and stale-epoch reservations share the unavailable refusal", async () => {
    const capA = newCapability();
    const capB = newCapability();
    const deskA = randomUUID();
    const peerA = await register(broker, G, { deskSession: deskA, capability: capA });
    const peerB = await register(broker, G, { capability: capB });
    const owned = await deposit(broker, capA, "owner-canary");
    const depositId = owned.body.deposit_id as string;

    const wrongOwner = await transaction(broker, G, peerB.peer_id, depositId, "reserve");
    const absent = await transaction(broker, G, peerA.peer_id, "0123456789abcdef", "reserve");
    const replacement = await deposit(broker, capA, "replacement-canary", { replace: depositId });
    const replaced = await transaction(broker, G, peerA.peer_id, depositId, "reserve");
    const stale = await deposit(broker, capA, "stale-canary");
    await call(broker, "/disconnect", { instance_token: peerA.instance_token });
    const rebound = await register(broker, G, { deskSession: deskA, capability: capA });
    const staleEpoch = await transaction(broker, G, rebound.peer_id, stale.body.deposit_id as string, "reserve");

    expect(replacement.status).toBe(200);
    expect(wrongOwner).toMatchObject({ status: 409, body: { ok: false, reason: "unavailable" } });
    expect(absent).toEqual(wrongOwner);
    expect(replaced).toEqual(wrongOwner);
    expect(staleEpoch).toEqual(wrongOwner);
    expect(staleEpoch.text).not.toContain("owner-canary");
  });
});

/** The broker's own reported mode rides along, so a reply from a broker in another mode cannot satisfy a case. */
async function resumeAdvertisement(b: TestBroker): Promise<{ mode: unknown; version: unknown; type: string }> {
  const health = (await (await fetch(`${b.url}/health`)).json()) as Record<string, unknown>;
  return { mode: health.mode, version: health.context_resume_version, type: typeof health.context_resume_version };
}

describe("context resume compatibility", () => {
  let remote: TestBroker;

  beforeAll(async () => {
    remote = await startBroker({ CLAUDE_PEERS_BROKER_URL: "http://127.0.0.1:9" });
  });

  afterAll(async () => {
    await stopBroker(remote);
  });

  test("GET /health advertises the resume version as a number", async () => {
    expect(await resumeAdvertisement(broker)).toEqual({ mode: "local", version: CONTEXT_RESUME_VERSION, type: "number" });
  });

  test("GET /health of a remote-mode broker advertises the resume version as a number", async () => {
    expect(await resumeAdvertisement(remote)).toEqual({ mode: "remote", version: CONTEXT_RESUME_VERSION, type: "number" });
  });

  test("reserve refuses an owner whose server did not announce resume support, and any valid announcement lets it through", async () => {
    const invalid: unknown[] = [undefined, 0, -1, 1.5, "1", null, true, Number.MAX_SAFE_INTEGER + 2];
    for (const resume of invalid) {
      const cap = newCapability();
      const peer = await register(broker, G, { capability: cap, resume });
      const deposited = await deposit(broker, cap, "resume-lacking-canary");
      const reply = await transaction(broker, G, peer.peer_id, deposited.body.deposit_id as string, "reserve");
      expect({ resume, reply: { status: reply.status, body: reply.body } }).toEqual({
        resume,
        reply: { status: 409, body: { ok: false, reason: "owner_lacks_context_resume" } },
      });
      expect(reply.text).not.toContain("resume-lacking-canary");
    }
    for (const resume of [1, 2]) {
      const cap = newCapability();
      const peer = await register(broker, G, { capability: cap, resume });
      const deposited = await deposit(broker, cap, "resume-ok-canary");
      expect(await transaction(broker, G, peer.peer_id, deposited.body.deposit_id as string, "reserve")).toMatchObject({
        status: 200,
        body: { ok: true, state: "reserved" },
      });
    }
  });

  test("the compatibility refusal comes after the operator, secret and ownership guards, so it is no oracle", async () => {
    const capLacking = newCapability();
    const lacking = await register(broker, G, { capability: capLacking, resume: undefined });
    const other = await register(broker, G, { capability: newCapability() });
    const depositId = (await deposit(broker, capLacking, "oracle-canary")).body.deposit_id as string;

    expect(await transaction(broker, G, lacking.peer_id, depositId, "reserve", undefined, false)).toMatchObject({ status: 401 });
    const wrongSecret = { ...G, secretHash: randomBytes(32).toString("hex") };
    expect(await transaction(broker, wrongSecret, lacking.peer_id, depositId, "reserve")).toMatchObject({ status: 401 });
    const wrongOwner = await transaction(broker, G, other.peer_id, depositId, "reserve");
    const absent = await transaction(broker, G, lacking.peer_id, "0123456789abcdef", "reserve");
    expect(wrongOwner).toMatchObject({ status: 409, body: { ok: false, reason: "unavailable" } });
    expect(absent).toEqual(wrongOwner);
    expect(await transaction(broker, G, lacking.peer_id, depositId, "reserve")).toMatchObject({
      status: 409,
      body: { ok: false, reason: "owner_lacks_context_resume" },
    });
  });

  test("a re-register without the field withdraws an earlier announcement", async () => {
    const desk = randomUUID();
    const cap = newCapability();
    const first = await register(broker, G, { deskSession: desk, capability: cap });
    await call(broker, "/disconnect", { instance_token: first.instance_token });
    const again = await register(broker, G, { deskSession: desk, capability: cap, resume: undefined });
    const deposited = await deposit(broker, cap, "withdrawn-canary");
    expect(await transaction(broker, G, again.peer_id, deposited.body.deposit_id as string, "reserve")).toMatchObject({
      status: 409,
      body: { ok: false, reason: "owner_lacks_context_resume" },
    });
  });

  test("the announcement is never published: list_peers, admin and register answers do not carry it", async () => {
    const observer = await register(broker, G, { capability: newCapability() });
    const announcing = await register(broker, G, { capability: newCapability() });
    const listed = await call(broker, "/list-peers", { scope: "machine", instance_token: observer.instance_token, cwd: CWD, git_root: null });
    expect(listed.status).toBe(200);
    expect(listed.text).toContain(announcing.peer_id);
    expect(listed.text).not.toContain("context_resume");
    const admin = await (await fetch(`${broker.url}/admin/peers?include_dormant=1`)).text();
    expect(admin).not.toContain("context_resume");
    const registered = await call(broker, "/register", {
      pid: livePid(), cwd: CWD, git_root: null, tty: null, summary: "", host: HOST, client_pid: 1, project_key: null,
      group_id: G.id, group_secret_hash: G.secretHash, desk_session: randomUUID(),
      deposit_capability_hash: hashCapability(newCapability()), context_resume_version: CONTEXT_RESUME_VERSION,
    });
    expect(registered.text).not.toContain("context_resume");
  });
});

interface OwnerSocket {
  ws: WebSocket;
  frames: Record<string, unknown>[];
}

async function openOwnerSocket(b: TestBroker, token: string): Promise<OwnerSocket> {
  const frames: Record<string, unknown>[] = [];
  const ws = new WebSocket(b.wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
      frames.push(JSON.parse(text) as Record<string, unknown>);
    });
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "auth", instance_token: token }));
      resolve();
    });
    ws.addEventListener("error", () => reject(new Error("ws error")));
    setTimeout(() => reject(new Error("ws open timeout")), 2_000);
  });
  return { ws, frames };
}

async function resumeFrame(socket: OwnerSocket): Promise<Record<string, unknown>> {
  let found: Record<string, unknown> | undefined;
  await waitFor("a context_resume frame", 3_000, async () => {
    found = socket.frames.find((frame) => frame.type === "context_resume");
    return found !== undefined;
  });
  return found!;
}

async function toResuming(b: TestBroker, group: Group, peer: Peer, capability: string, text: string): Promise<{ depositId: string; attemptId: string }> {
  const deposited = await deposit(b, capability, text);
  const depositId = deposited.body.deposit_id as string;
  const reserved = await transaction(b, group, peer.peer_id, depositId, "reserve");
  const attemptId = reserved.body.attempt_id as string;
  const released = await transaction(b, group, peer.peer_id, depositId, "release", attemptId, true, true);
  expect(released).toMatchObject({ status: 200, body: { state: "resuming" } });
  return { depositId, attemptId };
}

function signedBy(key: { publicKey: string; privateKey: string }, payload: Record<string, unknown>): Record<string, unknown> {
  const body = { ...payload, by: "deck", public_key: key.publicKey };
  return {
    ...body,
    auth: buildAuthProof(key.privateKey, body, { kind: "operator", operator_id: deriveOperatorId(key.publicKey) }),
  };
}

describe("a key outside the operator trust policy cannot transact on a deposit", () => {
  test("a fresh key signing with the right group secret is refused on reserve and release, and the policy key still transacts", async () => {
    const cap = newCapability();
    const peer = await register(broker, G, { capability: cap });
    const depositId = (await deposit(broker, cap, "forged-key-witness")).body.deposit_id as string;
    const forger = generateCredential();

    const forgedReserve = await call(broker, "/context/transaction", signedBy(forger, transactionBody(G, peer.peer_id, depositId, "reserve")));
    expect({ status: forgedReserve.status, error: forgedReserve.body.error }).toEqual({ status: 403, error: "operator-not-trusted" });

    const reserved = await transaction(broker, G, peer.peer_id, depositId, "reserve");
    expect(reserved, "the refused reserve must leave the deposit free for the Deck").toMatchObject({ status: 200, body: { ok: true, state: "reserved" } });
    const attemptId = reserved.body.attempt_id as string;

    const forgedRelease = await call(broker, "/context/transaction", signedBy(forger, transactionBody(G, peer.peer_id, depositId, "release", attemptId, true)));
    expect({ status: forgedRelease.status, error: forgedRelease.body.error }).toEqual({ status: 403, error: "operator-not-trusted" });

    const released = await transaction(broker, G, peer.peer_id, depositId, "release", attemptId, true, false);
    expect(released, "the refused release must not have moved the deposit out of reserved").toMatchObject({
      status: 200,
      body: { ok: true, state: "held", attempt_id: attemptId },
    });
  });

  test("the same forged proof is accepted once the policy lists its key, so the refusal is the policy's and not a malformed proof", async () => {
    const forger = generateCredential();
    const b = await startBroker({}, { trustedOperators: [forger.publicKey] });
    try {
      const FG = await makeGroup();
      const cap = newCapability();
      const peer = await register(b, FG, { capability: cap });
      const depositId = (await deposit(b, cap, "listed-key-witness")).body.deposit_id as string;

      const reserve = await call(b, "/context/transaction", signedBy(forger, transactionBody(FG, peer.peer_id, depositId, "reserve")));
      expect(reserve).toMatchObject({ status: 200, body: { ok: true, state: "reserved" } });

      const release = await call(b, "/context/transaction", signedBy(forger, transactionBody(FG, peer.peer_id, depositId, "release", reserve.body.attempt_id as string, false)));
      expect(release).toMatchObject({ status: 200, body: { ok: true, state: "held", attempt_id: reserve.body.attempt_id } });

      const stranger = await transaction(b, FG, peer.peer_id, depositId, "reserve");
      expect({ status: stranger.status, error: stranger.body.error }, "the fixture key is not in this policy").toEqual({
        status: 403,
        error: "operator-not-trusted",
      });
    } finally {
      await stopBroker(b);
    }
  }, 30_000);
});

describe("a resuming deposit follows its owner's lifetime", () => {
  const ackOf = (b: TestBroker, token: string, ids: { depositId: string; attemptId: string }) =>
    call(b, "/context/ack", { instance_token: token, deposit_id: ids.depositId, attempt_id: ids.attemptId });

  test("an active owner can acknowledge its resuming deposit", async () => {
    const cap = newCapability();
    const peer = await register(broker, G, { capability: cap });
    const ids = await toResuming(broker, G, peer, cap, "alive-owner-witness");
    expect(await ackOf(broker, peer.instance_token, ids)).toMatchObject({ status: 200, body: { ok: true } });
  });

  for (const route of ["/disconnect", "/unregister"] as const) {
    test(`${route} of the owner purges its resuming deposit at once`, async () => {
      const cap = newCapability();
      const peer = await register(broker, G, { capability: cap });
      const ids = await toResuming(broker, G, peer, cap, `purge-${route}-witness`);

      await call(broker, route, { instance_token: peer.instance_token });

      expect(await ackOf(broker, peer.instance_token, ids)).toMatchObject({ status: 409, body: { ok: false, reason: "unavailable" } });
    });
  }

  test("a dormant owner revived under the same token finds no resuming deposit of its earlier life", async () => {
    const desk = randomUUID();
    const cap = newCapability();
    const peer = await register(broker, G, { deskSession: desk, capability: cap });
    const ids = await toResuming(broker, G, peer, cap, "epoch-witness");
    await call(broker, "/disconnect", { instance_token: peer.instance_token });

    const revived = await register(broker, G, { deskSession: desk, capability: cap });

    expect(revived.instance_token, "the control is only valid when the same token comes back").toBe(peer.instance_token);
    expect(await ackOf(broker, revived.instance_token, ids)).toMatchObject({ status: 409, body: { reason: "unavailable" } });
    const socket = await openOwnerSocket(broker, revived.instance_token);
    await Bun.sleep(200);
    expect(socket.frames.filter((frame) => frame.type === "context_resume")).toEqual([]);
    socket.ws.close();
  });

  test("an acknowledgement before any release is refused and the deposit is still reservable", async () => {
    const cap = newCapability();
    const peer = await register(broker, G, { capability: cap });
    const depositId = (await deposit(broker, cap, "ack-before-release-witness")).body.deposit_id as string;
    const reserved = await transaction(broker, G, peer.peer_id, depositId, "reserve");
    const attemptId = reserved.body.attempt_id as string;

    const early = await ackOf(broker, peer.instance_token, { depositId, attemptId });
    expect(early).toMatchObject({ status: 409, body: { ok: false, reason: "unavailable" } });

    const released = await transaction(broker, G, peer.peer_id, depositId, "release", attemptId, true, true);
    expect(released).toMatchObject({ status: 200, body: { state: "resuming" } });
    expect(await ackOf(broker, peer.instance_token, { depositId, attemptId })).toMatchObject({ status: 200, body: { ok: true } });
  });
});

describe("the resumed text stays on the owner's socket", () => {
  const logsOf = (b: TestBroker): string =>
    [join(b.tmpDir, "logs"), b.tmpDir]
      .filter((d) => existsSync(d))
      .flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".log")).map((f) => readFileSync(join(d, f), "utf8")))
      .join("\n");

  test("neither SQLite, its WAL, any answer the Deck can read, nor the broker logs carry a resumed deposit", async () => {
    const b = await startBroker();
    const CG = await makeGroup();
    try {
      const capLive = newCapability();
      const capPending = newCapability();
      const live = await register(b, CG, { capability: capLive });
      const pending = await register(b, CG, { capability: capPending });
      const canaryLive = `resume-canary-live-${randomUUID()}`;
      const canaryPending = `resume-canary-pending-${randomUUID()}`;
      const control = `resume-control-${randomUUID()}`;
      const answersFrom = seenResponses.length;

      const bystander = await register(b, CG, { capability: newCapability() });
      const socket = await openOwnerSocket(b, live.instance_token);
      const bystanderSocket = await openOwnerSocket(b, bystander.instance_token);
      const liveIds = await toResuming(b, CG, live, capLive, canaryLive);
      const pendingIds = await toResuming(b, CG, pending, capPending, canaryPending);
      const frame = await resumeFrame(socket);
      expect(frame.text, "the websocket is the one channel that must carry the text").toBe(canaryLive);
      await call(b, "/context/ack", { instance_token: live.instance_token, deposit_id: liveIds.depositId, attempt_id: liveIds.attemptId });
      await call(b, "/set-summary", { instance_token: live.instance_token, summary: control });

      const surfaces: Record<string, string> = {};
      for (const path of ["/admin/peers?include_dormant=1", "/health", "/group-stats"]) {
        surfaces[path] = await (await fetch(`${b.url}${path}`)).text();
      }
      surfaces["/list-peers"] = (await call(b, "/list-peers", { scope: "machine", instance_token: pending.instance_token, cwd: CWD, git_root: null })).text;
      surfaces["/poll-messages live"] = (await call(b, "/poll-messages", { instance_token: live.instance_token })).text;
      surfaces["/poll-messages pending"] = (await call(b, "/poll-messages", { instance_token: pending.instance_token })).text;
      surfaces["transaction and ack answers"] = seenResponses.slice(answersFrom).join("\n");
      expect(surfaces["/admin/peers?include_dormant=1"], "the surface scan must read real data").toContain(control);

      const forbidden = [canaryLive, canaryPending, capLive, capPending, hashCapability(capLive), hashCapability(capPending)];
      for (const [surface, text] of Object.entries(surfaces)) {
        expect({ surface, leaks: forbidden.filter((s) => text.includes(s)) }).toEqual({ surface, leaks: [] });
      }

      const dump = [b.dbPath, `${b.dbPath}-wal`]
        .filter((p) => existsSync(p))
        .map((p) => readFileSync(p).toString("latin1"))
        .join("\n");
      expect(dump.includes(control), "the SQLite dump must read real data").toBe(true);
      expect(forbidden.filter((s) => dump.includes(s))).toEqual([]);

      await Bun.sleep(150);
      const seenByBystander = JSON.stringify(bystanderSocket.frames);
      expect(
        [canaryLive, canaryPending].filter((s) => seenByBystander.includes(s)),
        "a connected socket of another peer in the same group must receive neither resumed text"
      ).toEqual([]);

      socket.ws.close();
      bystanderSocket.ws.close();
      b.proc.kill();
      await b.proc.exited;
      const logs = logsOf(b);
      expect(logs.length).toBeGreaterThan(0);
      expect(forbidden.filter((s) => logs.includes(s))).toEqual([]);
      expect(pendingIds.depositId).not.toBe(liveIds.depositId);
    } finally {
      await stopBroker(b);
    }
  }, 40_000);
});

describe("liveness sweeps", () => {
  let timed: TestBroker;
  let TG: Group;

  beforeAll(async () => {
    timed = await startBroker({
      CLAUDE_PEERS_CLEAN_INTERVAL_SEC: "1",
      CLAUDE_PEERS_ACTIVE_STALE_SEC: "2",
      CLAUDE_PEERS_DORMANT_SWEEP_SEC: "1",
    });
    TG = await makeGroup();
  });

  afterAll(async () => {
    await stopBroker(timed);
  });

  test("a dead PID and a stale heartbeat both turn the capability into a 401", async () => {
    const child = Bun.spawn(["bun", "-e", "setTimeout(() => {}, 60000)"], { stdio: ["ignore", "ignore", "ignore"] });
    const capPid = newCapability();
    await register(timed, TG, { capability: capPid, pid: child.pid });
    const capBeat = newCapability();
    const beating = await register(timed, TG, { capability: capBeat });
    expect((await deposit(timed, capPid)).status).toBe(200);
    expect((await deposit(timed, capBeat)).status).toBe(200);

    child.kill();
    await child.exited;
    await waitFor("dead pid swept", 10_000, async () => (await deposit(timed, capPid)).status === 401);
    await call(timed, "/heartbeat", { instance_token: beating.instance_token });
    await waitFor("stale heartbeat swept", 10_000, async () => (await deposit(timed, capBeat)).status === 401);
  }, 30_000);
});

describe("restart and logs", () => {
  test("a restarted broker holds no deposit and no binding, and nothing leaked to its logs", async () => {
    const first = await startBroker();
    const RG = await makeGroup();
    const cap = newCapability();
    await register(first, RG, { capability: cap });
    const canary = `log-canary-${randomUUID()}`;
    const kept = await deposit(first, cap, canary);
    expect(kept.status).toBe(200);
    await deposit(first, cap, `${canary}\u0001`);
    await deposit(first, cap, canary.repeat(CONTEXT_DEPOSIT_MAX_CHARS));
    await fetch(`${first.url}/context/deposit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"deposit_capability":"${cap}","text":"${canary}`,
    });
    first.proc.kill();
    await first.proc.exited;

    const logs = [join(first.tmpDir, "logs"), first.tmpDir]
      .filter((d) => existsSync(d))
      .flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".log")).map((f) => readFileSync(join(d, f), "utf8")))
      .join("\n");
    expect(logs.length).toBeGreaterThan(0);
    expect([canary, cap, hashCapability(cap)].filter((s) => logs.includes(s))).toEqual([]);

    const second = await startBroker({ CLAUDE_PEERS_DB: first.dbPath });
    try {
      expect((await deposit(second, cap)).status).toBe(401);
      const nextCap = newCapability();
      await register(second, RG, { capability: nextCap });
      const replaced = await deposit(second, nextCap, "t", { replace: kept.body.deposit_id });
      expect(replaced.status).toBe(404);
    } finally {
      await stopBroker(second);
      rmSync(first.tmpDir, { recursive: true, force: true });
    }
  }, 40_000);
});

describe("500 path", () => {
  test("a handler failure answers 500 with an error_id and logs neither the text nor the capability", async () => {
    const b = await startBroker();
    const LG = await makeGroup();
    const cap = newCapability();
    await register(b, LG, { capability: cap });
    // With the peers table renamed under it, the broker's owner lookup throws.
    const db = new Database(b.dbPath);
    db.run("PRAGMA busy_timeout = 5000");
    db.run("ALTER TABLE peers RENAME TO peers_hidden");
    const canary = `failure-canary-${randomUUID()}`;
    let failed: Reply;
    try {
      failed = await deposit(b, cap, canary);
    } finally {
      db.run("ALTER TABLE peers_hidden RENAME TO peers");
      db.close();
    }
    try {
      expect(failed.status).toBe(500);
      expect(failed.body.error_id).toMatch(/^[0-9a-f]{8}$/);
      expect(failed.text).not.toContain(canary);
      b.proc.kill();
      await b.proc.exited;
      const logs = [join(b.tmpDir, "logs"), b.tmpDir]
        .filter((d) => existsSync(d))
        .flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".log")).map((f) => readFileSync(join(d, f), "utf8")))
        .join("\n");
      expect(logs).toContain(`error_id=${failed.body.error_id}`);
      expect([canary, cap, hashCapability(cap)].filter((s) => logs.includes(s))).toEqual([]);
    } finally {
      await stopBroker(b);
    }
  }, 30_000);
});

describe("federation", () => {
  const BEARER = randomUUID();
  let upstream: TestBroker;
  let replica: TestBroker;
  let proxy: ReturnType<typeof Bun.serve>;
  const upstreamBodies: string[] = [];

  beforeAll(async () => {
    upstream = await startBroker({ CLAUDE_PEERS_BROKER_TOKEN: BEARER, CLAUDE_PEERS_SERVE_REPLICAS: "1" });
    proxy = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = req.method === "POST" ? await req.text() : undefined;
        if (body !== undefined) upstreamBodies.push(`${url.pathname} ${body}`);
        const headers: Record<string, string> = { "content-type": "application/json" };
        const auth = req.headers.get("authorization");
        if (auth) headers.authorization = auth;
        return fetch(`${upstream.url}${url.pathname}${url.search}`, { method: req.method, headers, body });
      },
    });
    replica = await startBroker({
      CLAUDE_PEERS_BROKER_URL: `http://127.0.0.1:${proxy.port}`,
      CLAUDE_PEERS_BROKER_TOKEN: BEARER,
      CLAUDE_PEERS_OFFLINE_REPLICA: "1",
      CLAUDE_PEERS_SYNC_TICK_MS: "150",
    });
  });

  afterAll(async () => {
    proxy.stop(true);
    await stopBroker(replica);
    await stopBroker(upstream);
  });

  test("GET /health of a replica advertises the resume version as a number", async () => {
    expect(await resumeAdvertisement(replica)).toEqual({ mode: "replica", version: CONTEXT_RESUME_VERSION, type: "number" });
  });

  test("a replica keeps the deposit local: no upstream call carries its text or hash", async () => {
    const FG = await makeGroup();
    const cap = newCapability();
    const peer = await register(replica, FG, { capability: cap, bearer: BEARER });
    const canary = `federation-canary-${randomUUID()}`;
    expect((await deposit(replica, cap, canary, {}, BEARER)).status).toBe(200);
    await waitFor("the replica relays its peer upstream", 15_000, async () =>
      upstreamBodies.some((b) => b.startsWith("/federation/sync ") && b.includes(peer.peer_id))
    );
    const relayedAt = upstreamBodies.length;
    await waitFor("one more sync pass", 15_000, async () => upstreamBodies.length > relayedAt);
    const all = upstreamBodies.join("\n");
    expect([canary, cap, hashCapability(cap)].filter((s) => all.includes(s))).toEqual([]);
  }, 40_000);

  test("a /federation/sync body carrying a capability hash binds nothing upstream", async () => {
    const FG = await makeGroup();
    const cap = newCapability();
    const r = await call(
      upstream,
      "/federation/sync",
      {
        replica_id: `replica-${randomUUID()}`,
        groups: [{ group_id: FG.id, group_secret_hash: FG.secretHash }],
        peers: [
          {
            relay_ref: randomBytes(16).toString("hex"),
            peer_id: "relayed-peer",
            group_id: FG.id,
            host: HOST,
            cwd: CWD,
            git_root: null,
            project_key: null,
            summary: "",
            role: null,
            last_activity_at: null,
            deposit_capability_hash: hashCapability(cap),
          },
        ],
        ack: [],
      },
      BEARER
    );
    expect(r.status).toBe(200);
    expect((await deposit(upstream, cap, "t", {}, BEARER)).status).toBe(401);
  });
});

test("no response received by this file contains a 64-hex value (a capability or its hash)", () => {
  const leaks = seenResponses.filter((t) => /(?:^|[^0-9a-f])[0-9a-f]{64}(?:[^0-9a-f]|$)/.test(t));
  expect(leaks).toEqual([]);
  expect(seenResponses.length).toBeGreaterThan(20);
});
