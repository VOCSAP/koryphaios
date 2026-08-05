// Roadmap card 39c40571, LAYER 1: the author of a roadmap write must be PROVEN,
// not declared.
//
// Measured before the fix: `by` is a free string read straight from the request
// body (broker.ts:1523 upsert, :1763 archive, :1802 reorder) and is never
// recouped against any token -- the request types carried none. Every agent
// holds the broker bearer token (shared/config.ts loadConfig), so any of them
// could write under another peer's identity, or pass by:'deck' / force:true to
// walk through the work-lock guard (broker.ts:1578-1579).
//
// SCOPE OF THIS LAYER, deliberately narrow. It closes the PEER-TO-PEER axis:
// claiming an author that matches an existing, non-sentinel peer row now
// requires that peer's instance_token. It does NOT close the deck axis --
// a bare by:'deck' stays accepted, because the Deck has no peer row and no
// instance_token, and giving it one means wiring the operator proof (layer 2,
// frozen pending an operator decision). What layer 1 does guarantee about that
// axis is that the escalation never becomes REACHABLE THROUGH A TOKEN: the
// sentinel values are PUBLIC exported constants (shared/types.ts:176,183), so
// presenting one must be refused outright.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startBroker, stopBroker, post, livePid, type TestBroker } from "./_helper.ts";
import * as sharedTypes from "../shared/types.ts";
import type { RegisterResponse, RoadmapItem } from "../shared/types.ts";
import { buildAuthProof, deriveOperatorId, deriveTokenId, generateCredential } from "../shared/approval.ts";

let broker: TestBroker;

beforeAll(async () => {
  broker = await startBroker();
});

afterAll(async () => {
  await stopBroker(broker);
});

const PK = "github.com/vocsap/author-auth-repo";

type UpsertRes = { item: RoadmapItem; error?: string };

interface Registered {
  peerId: string;
  token: string;
}

async function register(cwd: string): Promise<Registered> {
  const res = await post<RegisterResponse>(`${broker.url}/register`, {
    pid: livePid(),
    cwd,
    git_root: null,
    tty: null,
    summary: "",
    host: "test-host",
    client_pid: livePid(),
    project_key: PK,
    group_id: "default",
    group_secret_hash: null,
  });
  expect(res.status).toBe(200);
  return { peerId: res.body.peer_id, token: res.body.instance_token };
}

async function upsert(body: Record<string, unknown>) {
  return post<UpsertRes>(`${broker.url}/roadmap/upsert`, { project_key: PK, ...body });
}

/** Seed an item owned by nobody in particular (unregistered author, allowed). */
async function seed(title: string): Promise<RoadmapItem> {
  const res = await upsert({ by: "unregistered-fixture", title });
  expect(res.status).toBe(200);
  return res.body.item;
}

function isClientRefusal(status: number): boolean {
  return status >= 400 && status < 500;
}

// ---------------------------------------------------------------------------
// The impersonation the fix must close
// ---------------------------------------------------------------------------

test("a write claiming a REGISTERED peer's identity without its token is refused", async () => {
  const alice = await register("/work/alice");
  const item = await seed("alice's item");

  // No instance_token at all, but the author names a real peer row.
  const forged = await upsert({ id: item.id, by: alice.peerId, description: "forged" });

  expect(isClientRefusal(forged.status)).toBe(true);
  expect(String(forged.body.error ?? "")).toMatch(/token|author|prove|identit/i);
});

test("the persisted author comes from the token, not from the body's `by`", async () => {
  const alice = await register("/work/alice-2");
  const bob = await register("/work/bob-2");
  const item = await seed("attributed item");

  // Bob authenticates honestly but claims to be Alice.
  const res = await upsert({
    id: item.id,
    by: alice.peerId,
    instance_token: bob.token,
    description: "written by bob",
  });

  expect(res.status).toBe(200);
  expect(res.body.item.updated_by).toBe(bob.peerId);
  expect(res.body.item.updated_by).not.toBe(alice.peerId);
});

test("a sentinel instance_token is refused: the constants are PUBLIC", async () => {
  const item = await seed("sentinel target");

  for (const sentinel of [
    sharedTypes.DECK_INSTANCE_TOKEN,
    sharedTypes.OPERATOR_INSTANCE_TOKEN,
    "__anything__",
  ]) {
    const res = await upsert({
      id: item.id,
      by: "deck",
      instance_token: sentinel,
      description: `via ${sentinel}`,
    });
    expect(isClientRefusal(res.status)).toBe(true);
  }
});

test("a near-miss instance_token is refused rather than ignored", async () => {
  const dave = await register("/work/dave");
  const item = await seed("near-miss target");

  // Corrupt one character of a REAL token: proves the guard compares the whole
  // value instead of merely checking that the field is present and non-empty.
  const corrupted = `${dave.token.slice(0, -1)}${dave.token.endsWith("a") ? "b" : "a"}`;
  expect(corrupted).not.toBe(dave.token);

  const res = await upsert({
    id: item.id,
    by: dave.peerId,
    instance_token: corrupted,
    description: "x",
  });
  expect(isClientRefusal(res.status)).toBe(true);
});

test("force:true is refused without a proven caller", async () => {
  const alice = await register("/work/alice-force");
  const item = await seed("locked item");

  // Alice takes the work-lock, honestly.
  const lock = await upsert({
    id: item.id,
    by: alice.peerId,
    instance_token: alice.token,
    status: "in_progress",
  });
  expect(lock.status).toBe(200);
  expect(lock.body.item.locked).toBe(true);
  expect(lock.body.item.locked_by).toBe(alice.peerId);

  // An anonymous caller forces past the lock guard.
  const forced = await upsert({
    id: item.id,
    by: "drive-by",
    status: "planned",
    force: true,
  });
  expect(isClientRefusal(forced.status)).toBe(true);
});

test("archive is covered by the same rule as upsert", async () => {
  const alice = await register("/work/alice-archive");
  const item = await seed("archive target");

  const forged = await post<UpsertRes>(`${broker.url}/roadmap/archive`, {
    id: item.id,
    by: alice.peerId,
  });
  expect(isClientRefusal(forged.status)).toBe(true);
});

test("reorder is covered by the same rule as upsert", async () => {
  const alice = await register("/work/alice-reorder");
  const item = await seed("reorder target");

  const forged = await post<{ error?: string }>(`${broker.url}/roadmap/reorder`, {
    project_key: PK,
    by: alice.peerId,
    ids: [item.id],
  });
  expect(isClientRefusal(forged.status)).toBe(true);
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROLS -- what the fix must NOT break
// ---------------------------------------------------------------------------

test("an author matching no peer row stays accepted (cli.ts and fixtures)", async () => {
  const res = await upsert({ by: "some-unregistered-author", title: "still works" });
  expect(res.status).toBe(200);
  expect(res.body.item.created_by).toBe("some-unregistered-author");
});

// ---------------------------------------------------------------------------
// LAYER 2: the deck axis, the one author layer 1 still took on faith.
//
// 'deck' names the OPERATOR. Layer 1 let a bare claim through because the
// sentinel matches no peer row, so any holder of the shared bearer token could
// write as the human and, via `proven`, walk the work-lock guard with force.
// The claim must now carry an Ed25519 operator proof.
//
// DOMAIN. The routes below were not copied from the card: they are every call
// site of resolveRoadmapAuthor, enumerated with
//   grep -n "resolveRoadmapAuthor(" broker.ts
// which returns the definition plus four callers (upsert, archive, reorder,
// import). The card named upsert alone; a guard wired to the cited example
// rather than to the discovered domain is how three of the four stay open.
// ---------------------------------------------------------------------------

const DECK_WRITE_ROUTES = [
  { route: "/roadmap/upsert", body: (id: string) => ({ project_key: PK, id, description: "operator edit" }) },
  { route: "/roadmap/archive", body: (id: string) => ({ id }) },
  { route: "/roadmap/reorder", body: (id: string) => ({ project_key: PK, ids: [id] }) },
  {
    route: "/roadmap/import",
    body: (id: string) => ({
      project_key: PK,
      items: [{ id, kind: "feature", title: "imported by the deck" }],
    }),
  },
] as const;

function signedBody(
  payload: Record<string, unknown>,
  cred: { privateKey: string; publicKey: string }
): Record<string, unknown> {
  const body = { ...payload, by: "deck", public_key: cred.publicKey };
  return {
    ...body,
    auth: buildAuthProof(cred.privateKey, body, {
      kind: "operator",
      operator_id: deriveOperatorId(cred.publicKey),
    }),
  };
}

test("layer 2: an UNSIGNED by:'deck' write is refused on every route that resolves an author", async () => {
  for (const { route, body } of DECK_WRITE_ROUTES) {
    const item = await seed(`deck target for ${route}`);
    const res = await post<{ error?: string }>(`${broker.url}${route}`, {
      ...body(item.id),
      by: "deck",
    });
    expect({ route, status: res.status }).toEqual({ route, status: 401 });
    // The refusal must be readable enough to tell an ACTIVE guard from an
    // ABSENT one: a running broker can be hours older than this code, and a
    // silent 401 looks the same as a broker that never had the guard.
    expect(res.body.error ?? "").toContain("sign the write with the operator credential");
  }
});

test("layer 2: the SAME writes signed with the operator credential are accepted", async () => {
  // Positive control, and it is what makes the refusals above mean something:
  // only the proof differs, so a red here would say the routes are broken for
  // everyone rather than closed for the unsigned.
  const cred = generateCredential();
  for (const { route, body } of DECK_WRITE_ROUTES) {
    const item = await seed(`signed deck target for ${route}`);
    const res = await post<{ error?: string }>(
      `${broker.url}${route}`,
      signedBody(body(item.id), cred)
    );
    expect({ route, status: res.status }).toEqual({ route, status: 200 });
  }
});

test("layer 2: a SESSION credential may not sign a roadmap write", async () => {
  // roadmap-write is deliberately absent from SESSION_ALLOWED, so a sandboxed
  // agent holding a session token is refused by the operation table -- 403,
  // not 401: the signature is fine, the CREDENTIAL KIND is not.
  const opCred = generateCredential();
  const sessionCred = generateCredential();
  const operatorId = deriveOperatorId(opCred.publicKey);

  const mintBody = {
    session_public_key: sessionCred.publicKey,
    session_ref: "tile-layer2",
    public_key: opCred.publicKey,
  };
  const mint = await post<{ token_id: string }>(`${broker.url}/approval/token-mint`, {
    ...mintBody,
    auth: buildAuthProof(opCred.privateKey, mintBody, {
      kind: "operator",
      operator_id: operatorId,
    }),
  });
  expect(mint.status).toBe(200);

  const item = await seed("session-signed target");
  const payload = { project_key: PK, id: item.id, by: "deck", description: "agent edit" };
  const res = await post<{ error?: string }>(`${broker.url}/roadmap/upsert`, {
    ...payload,
    auth: buildAuthProof(sessionCred.privateKey, payload, {
      kind: "session",
      operator_id: operatorId,
      token_id: deriveTokenId(sessionCred.publicKey),
    }),
  });
  expect(res.status).toBe(403);
  expect(res.body.error ?? "").toContain("roadmap-write");
});

test("layer 2: a REPLAYED operator proof is refused, inherited from the nonce guard", async () => {
  const cred = generateCredential();
  const item = await seed("replay target");
  const body = signedBody({ project_key: PK, id: item.id, description: "first" }, cred);

  const first = await post<{ error?: string }>(`${broker.url}/roadmap/upsert`, body);
  expect(first.status).toBe(200);

  const replay = await post<{ error?: string }>(`${broker.url}/roadmap/upsert`, body);
  expect(replay.status).toBe(401);
  expect(replay.body.error ?? "").toContain("replayed-proof");
});

test("a peer writing with its own token and its own peer_id is accepted", async () => {
  const carol = await register("/work/carol");
  const res = await upsert({
    by: carol.peerId,
    instance_token: carol.token,
    title: "carol's own card",
  });
  expect(res.status).toBe(200);
  expect(res.body.item.created_by).toBe(carol.peerId);
});

// ---------------------------------------------------------------------------
// CALL PATH: cli.ts roadmap-add
//
// A new guard needs every call path enumerated, and this one would otherwise
// break silently: the documented scribe fallback posts the calling session's
// peer_id as `by` with no token, which the broker now refuses. Exempting the
// verb was not an option (any agent can run it, so the exemption WOULD BE the
// hole), so cli.ts stops claiming a proven identity instead.
// ---------------------------------------------------------------------------

test("cli.ts roadmap-add attributes its writes as unproven and drops any token", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "cli.ts"), "utf8");
  const start = cli.indexOf('case "roadmap-add"');
  expect(start).toBeGreaterThan(-1);
  // CRLF-safe block boundary, same reason as tests/cli-roadmap-add-no-token.ts:
  // a "\n"-only pattern never matches this file and would assert vacuously.
  const rel = cli.slice(start + 1).search(/\r?\n  (case "|default:)/);
  expect(rel).toBeGreaterThan(-1);
  const block = cli.slice(start, start + 1 + rel);

  expect(block).toContain("cli:");
  expect(block).toContain("instance_token");
});

test("an author carrying the cli: marker is accepted (the fallback keeps working)", async () => {
  const eve = await register("/work/eve");
  const res = await upsert({ by: `cli:${eve.peerId}`, title: "filed through the CLI" });
  expect(res.status).toBe(200);
  expect(res.body.item.created_by).toBe(`cli:${eve.peerId}`);
});

// ---------------------------------------------------------------------------
// COVERAGE OF THE SENTINEL PREDICATE ITSELF
//
// The guard recognises a sentinel by its SHAPE rather than by a retyped list,
// so a third sentinel added tomorrow is caught automatically. That only holds
// while every sentinel constant actually has the shape -- this asserts it, and
// goes red the day someone adds one that does not.
// ---------------------------------------------------------------------------

test("every exported *_INSTANCE_TOKEN constant matches the sentinel shape", () => {
  const names = Object.keys(sharedTypes).filter((k) => k.endsWith("_INSTANCE_TOKEN"));
  // Guard the guard: if the export naming convention changes, this must fail
  // loudly rather than silently assert over an empty set.
  expect(names.length).toBeGreaterThanOrEqual(2);
  for (const name of names) {
    const value = (sharedTypes as Record<string, unknown>)[name];
    expect(typeof value).toBe("string");
    expect(String(value)).toMatch(/^__.+__$/);
  }
});
