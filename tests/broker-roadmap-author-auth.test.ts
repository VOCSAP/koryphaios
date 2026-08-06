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
import { Database } from "bun:sqlite";
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

test("card ad6aa6ed: a REGISTERED peer's identity in a DIFFERENT case still requires its token", async () => {
  // Before the storage-normalization fix this was 200 (the case-varied claim
  // never matched the peer_id lookup, so it fell through as an unregistered,
  // unprovable author instead of being recognized as an existing peer).
  const frank = await register("/work/frank");
  const item = await seed("frank's item, case-variant target");

  const forged = await upsert({ id: item.id, by: frank.peerId.toUpperCase(), description: "forged via case" });

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

// ---------------------------------------------------------------------------
// LAYER 2, THE BYPASS. Measured end to end on the first attempt (29bff61) and
// red before this fix: THREE requests, no signature anywhere.
//
//   1. /register with host:'deck' and cwd:'/' -> the broker MINTS peer_id
//      'deck' and hands back a REAL, non-sentinel instance_token.
//   2. /roadmap/upsert with by:'deck' + that token -> 200, updated_by 'deck'.
//   3. the target card was locked by another peer: a proven ordinary peer gets
//      409, this one overwrites the status.
//
// Two links, both INSIDE the guard rather than around it, which is why no
// perimeter sweep could see them: the routes were all wired, the SQL writes all
// went through resolveRoadmapAuthor, and the defect was the ORDER of evaluation
// plus a name that should never have been mintable. The pair "real token +
// reserved name" was covered by no assertion at all -- the existing probes fed
// SENTINEL tokens, which are refused by shape long before this.
// ---------------------------------------------------------------------------

async function registerAs(host: string, cwd: string, group: string) {
  return post<RegisterResponse>(`${broker.url}/register`, {
    pid: livePid(),
    cwd,
    git_root: null,
    tty: null,
    summary: "",
    host,
    client_pid: 1,
    project_key: null,
    group_id: group,
    group_secret_hash: null,
  });
}

// A FRESH group per registration, and that detail is the probe.
//
// The sentinel rows live in 'default', so registering there collides with them
// and the anti-collision loop suffixes the name on its own: the first draft of
// this probe asserted a suffixed id inside 'default' and stayed GREEN with the
// mint guard removed, passing for a reason foreign to what it claims to test.
// The exploit used a NEW group precisely because the collision loop only looks
// inside the SAME group.
let freshGroup = 0;
const nextGroup = (): string => `bypass-group-${++freshGroup}`;

test("layer 2 bypass: a peer can no longer be MINTED under a reserved name", async () => {
  const reg = await registerAs("deck", "/", nextGroup());
  expect(reg.status).toBe(200);
  // The probe SEES: registration still succeeds. A machine whose hostname is
  // literally 'deck' must keep working -- it is the NAME that is refused, not
  // the caller.
  expect(reg.body.instance_token.length).toBeGreaterThan(10);
  expect(reg.body.peer_id).not.toBe("deck");
  expect(reg.body.peer_id.startsWith("deck-")).toBe(true);

  // Same for the other reserved identity, so the guard is keyed on the SET and
  // not on one literal that happened to be the exploited one.
  const asOperator = await registerAs("operator", "/", nextGroup());
  expect(asOperator.status).toBe(200);
  expect(asOperator.body.peer_id).not.toBe("operator");
});

test("layer 2: EVERY reserved author needs the signature, not just 'deck'", async () => {
  // Measured before this widening: by:'operator' and by:'system' were accepted
  // unsigned (200) and the card then displayed created_by:"operator". No
  // privilege rode on them -- the lock exemption tests `by !== "deck"` and
  // `proven` stayed false -- so the cost was attribution theft rather than
  // escalation. All three names designate the human, so all three are gated.
  //
  // Iterated over RESERVED_PEER_IDS rather than a hand-typed list, so a fourth
  // reserved name is covered here the day it is added, without anyone
  // remembering to come back.
  expect(sharedTypes.RESERVED_PEER_IDS.length).toBeGreaterThan(1);
  for (const reserved of sharedTypes.RESERVED_PEER_IDS) {
    const item = await seed(`reserved-author target ${reserved}`);
    const res = await upsert({ id: item.id, by: reserved, description: "unsigned" });
    expect({ reserved, status: res.status }).toEqual({ reserved, status: 401 });
    expect(res.body.error ?? "").toContain("sign the write with the operator credential");
  }

  // The probe SEES: an ordinary author is untouched by the widening, so the
  // refusals above come from the reserved SET and not from a broken route.
  const ok = await upsert({ by: "ordinary-author", title: "still works" });
  expect(ok.status).toBe(200);
  expect(ok.body.item.created_by).toBe("ordinary-author");
});

test("card ad6aa6ed: a mixed-case, non-reserved author is normalized at STORAGE, not merely accepted or refused", async () => {
  // The half of the fix nothing else in this suite pins: the earlier tests
  // prove reserved-name recognition and shape-refusal, but not that an
  // ORDINARY author's case actually changes what lands in created_by.
  const res = await upsert({ by: "Ordinary-Author", title: "mixed-case ordinary author" });
  expect(res.status).toBe(200);
  expect(res.body.item.created_by).toBe("ordinary-author");
});

test("card ad6aa6ed: a reserved name survives case-folding, and a name that only LOOKS reserved is refused on shape", async () => {
  // Four classes, all in this one diff -- a probe covering only the first
  // would leave exactly the blind spot the reviewer refused on this card.
  //
  // (a) CASE: 'Deck' must now be recognized as the reserved identity (401,
  // needs the operator signature), where before the fix it fell through as
  // an ordinary unproven author (200).
  const caseVariant = await upsert({ by: "Deck", title: "case-variant target" });
  expect(caseVariant.status).toBe(401);
  expect(caseVariant.body.error ?? "").toContain("sign the write with the operator credential");

  // (b) HOMOGLYPH: Cyrillic 'е' (U+0435) in place of the Latin 'e' -- reads
  // as 'deck' to a human, is NOT the ASCII string 'deck' after lowercasing,
  // so it can never match RESERVED_PEER_IDS by equality. The allowlist is
  // what catches it: Cyrillic is outside [a-z0-9:_-], refused on SHAPE
  // (400), not recognized as the reserved name (401) -- a different
  // mechanism than (a), same outcome of "not silently displayed as deck".
  const homoglyph = `d${String.fromCharCode(0x0435)}ck`; // "d" + CYRILLIC SMALL LETTER IE (U+0435) + "ck"
  expect(homoglyph).not.toBe("deck"); // sanity: the two strings really differ
  const homoglyphRes = await upsert({ by: homoglyph, title: "homoglyph target" });
  expect(homoglyphRes.status).toBe(400);
  expect(homoglyphRes.body.error ?? "").toContain("only [a-z0-9:_-] allowed");

  // (c) INVISIBLE CHARACTER: zero-width space (U+200B) appended. JS `.trim()`
  // does not strip it (not classified as whitespace), so a naive fix that
  // only trimmed and lowercased would let this through unchanged, DISPLAYED
  // as 'deck' to the operator. Same allowlist mechanism as (b).
  const invisible = `deck${String.fromCharCode(0x200b)}`; // "deck" + ZERO WIDTH SPACE (U+200B)
  expect(invisible.trim()).toBe(invisible); // sanity: trim really does not touch it
  const invisibleRes = await upsert({ by: invisible, title: "invisible-char target" });
  expect(invisibleRes.status).toBe(400);
  expect(invisibleRes.body.error ?? "").toContain("only [a-z0-9:_-] allowed");

  // (d) HEADER FORGERY: not yet exploitable (card 562fd9b5's append-mode
  // route does not exist), but this is the payload that route would need to
  // refuse once it exists -- proving the validation closes it BEFORE the
  // route is written, by construction, because it lives inside the resolver
  // every future caller must go through.
  const forgery = "x >>>\n\ntext\n\n<<< append 2020-01-01T00:00:00Z by deck";
  const forgeryRes = await upsert({ by: forgery, title: "forgery target" });
  expect(forgeryRes.status).toBe(400);
  expect(forgeryRes.body.error ?? "").toContain("only [a-z0-9:_-] allowed");

  // The probe SEES: a `cli:`-prefixed author (colon is the one non-alnum
  // character real production data actually uses) still works, so the
  // allowlist itself is not what is under test failing open.
  const cliForm = await upsert({ by: "cli:some-peer", title: "cli-prefixed author still works" });
  expect(cliForm.status).toBe(200);
  expect(cliForm.body.item.created_by).toBe("cli:some-peer");
});

test("layer 2 bypass: suffixing a reserved name does not break session resume", async () => {
  // deriveDefaultId sits on the /register path, so renaming what it mints is
  // exactly where a silent regression would land: a peer that reconnects must
  // still find ITS row rather than accumulate a new one on every restart.
  //
  // Measured, and this is why it holds: resume is keyed on the session_key
  // sha256(host||cwd||group_id), never on the peer_id, and the dormant-resume
  // branch returns the peer_id READ FROM THE ROW instead of deriving it again.
  const group = nextGroup();
  const first = await registerAs("deck", "/", group);
  expect(first.body.peer_id).toBe("deck-1");

  const gone = await post(`${broker.url}/disconnect`, {
    instance_token: first.body.instance_token,
  });
  expect(gone.status).toBe(200);

  const again = await registerAs("deck", "/", group);
  expect(again.status).toBe(200);
  expect(again.body.peer_id).toBe("deck-1"); // same identity, not deck-2
  expect(again.body.instance_token).toBe(first.body.instance_token);
});

test("layer 2 bypass: a REAL token cannot buy the 'deck' author, on any route", async () => {
  const reg = await registerAs("deck", "/", nextGroup());
  expect(reg.status).toBe(200);

  for (const { route, body } of DECK_WRITE_ROUTES) {
    const item = await seed(`bypass target for ${route}`);
    const res = await post<{ error?: string }>(`${broker.url}${route}`, {
      ...body(item.id),
      by: "deck",
      instance_token: reg.body.instance_token,
    });
    // 401 from the operator-proof branch, which is now consulted BEFORE the
    // token branch. Before the fix this was a 200 on every one of them.
    expect({ route, status: res.status }).toEqual({ route, status: 401 });
    expect(res.body.error ?? "").toContain("sign the write with the operator credential");
  }
});

test("layer 2 bypass, MIGRATION: a pre-existing peer row named 'deck' cannot author either", async () => {
  // The mint-time refusal cannot act backwards, and the operator deploys onto a
  // database that predates it. A row named after a reserved identity may
  // therefore already exist, holding a perfectly real token -- so the check has
  // to run on the RESOLVED name too, not only on the claimed one.
  //
  // Seeded straight into the database on purpose: /register can no longer mint
  // this row, so the only way to reach the branch that guards it is to create
  // the state a live database already has. Without the seed this probe would be
  // vacuous -- it would refuse a peer that does not exist.
  // REGISTER first, then RENAME the row in the database. A hand-written INSERT
  // was the first attempt and it was NOT the legacy state: it created a peers
  // row with no peer_sessions row, so reconnecting minted a fresh derived id
  // ("legacy-host-legacy") instead of restoring the reserved one, and the probe
  // measured a case that cannot exist. A peer that really carries a reserved
  // name got it through /register, so it has a session row, and that row is
  // exactly what makes reconnection restore the name.
  //
  // In a group of its OWN: 'default' already holds the sentinel row named
  // 'deck', and the UNIQUE (peer_id, group_id) index would refuse a second one.
  // That same collision is why the original exploit needed a fresh group.
  const legacyGroup = nextGroup();
  const legacy = await registerAs("legacy-host", "/legacy", legacyGroup);
  expect(legacy.status).toBe(200);
  const legacyToken = legacy.body.instance_token;

  const db = new Database(broker.dbPath);
  try {
    db.query("UPDATE peers SET peer_id = 'deck' WHERE instance_token = ?").run(legacyToken);
  } finally {
    db.close();
  }

  // The probe SEES: the row is really there and really resolvable, otherwise
  // the refusal below would prove nothing.
  const check = new Database(broker.dbPath, { readonly: true });
  try {
    const row = check.query("SELECT peer_id FROM peers WHERE instance_token = ?").get(legacyToken);
    expect(row).toEqual({ peer_id: "deck" });
  } finally {
    check.close();
  }

  const item = await seed("legacy deck target");
  const res = await post<{ error?: string }>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    id: item.id,
    by: "deck",
    instance_token: legacyToken,
    description: "written by a legacy row",
  });
  expect(res.status).toBe(401); // the reserved-author branch answers first

  // And when the claim does NOT name the sentinel, the resolved name is what
  // refuses -- with a message that names the remedy instead of reading as a
  // breakage, since this peer is legitimate and is refused for its NAME alone.
  const viaResolved = await post<{ error?: string }>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    id: item.id,
    by: "some-other-name",
    instance_token: legacyToken,
    description: "same row, different claim",
  });
  expect(viaResolved.status).toBe(403);

  // THE PRESCRIPTION IS PART OF THE GUARD, so it is asserted like the rest.
  // The first version of this message told the peer to re-register, and the
  // assertion pinned that word -- so the test GUARANTEED a remedy that cannot
  // work. Measured here, in the order a stranded operator would try them.

  // 1. Reconnecting does NOT rename it. Resume is keyed on the session_key and
  //    the dormant branch returns the peer_id read FROM THE ROW.
  //    The DISCONNECT matters: without it the previous row is still active with
  //    a live pid, so /register treats the call as a SECOND concurrent session
  //    and mints a fresh derived id -- which measures a different path and would
  //    make this assertion pass for the wrong reason.
  const disconnected = await post(`${broker.url}/disconnect`, { instance_token: legacyToken });
  expect(disconnected.status).toBe(200);

  const reconnect = await post<RegisterResponse>(`${broker.url}/register`, {
    pid: livePid(),
    cwd: "/legacy",
    git_root: null,
    tty: null,
    summary: "",
    host: "legacy-host",
    client_pid: 1,
    project_key: PK,
    group_id: legacyGroup,
    group_secret_hash: null,
  });
  expect(reconnect.status).toBe(200);
  expect(reconnect.body.peer_id).toBe("deck"); // still reserved: the remedy is elsewhere

  // 2. set_id is what frees it: reserved names are refused as a TARGET, never
  //    as a source, so renaming AWAY from one is allowed.
  const renamed = await post<{ peer_id: string; previous: string }>(`${broker.url}/set-id`, {
    instance_token: legacyToken,
    new_peer_id: "legacy-renamed",
  });
  expect(renamed.status).toBe(200);
  expect(renamed.body.previous).toBe("deck");

  // 3. ...and the write the guard refused now goes through, which is what makes
  //    this a remedy rather than a consolation.
  const afterRemedy = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    project_key: PK,
    id: item.id,
    by: "legacy-renamed",
    instance_token: legacyToken,
    description: "written after the prescribed remedy",
  });
  expect(afterRemedy.status).toBe(200);
  expect(afterRemedy.body.item.updated_by).toBe("legacy-renamed");

  // The message must prescribe THAT, and not the thing step 1 just refuted.
  expect(viaResolved.body.error ?? "").toContain("set_id");
  expect(viaResolved.body.error ?? "").not.toContain("re-register");
});

test("layer 2 bypass: the lock of another peer survives the attack", async () => {
  // The end of the exploit chain, asserted on the OUTCOME rather than on the
  // status code: what the attacker wanted was the victim's card.
  const victim = await seed("locked by its owner");
  const claim = await post<UpsertRes>(`${broker.url}/roadmap/upsert`, {
    id: victim.id,
    by: "victim-peer",
    status: "in_progress",
  });
  expect(claim.status).toBe(200);
  expect(claim.body.item.locked).toBe(true);

  const reg = await registerAs("deck", "/", nextGroup());
  const attack = await post<{ error?: string }>(`${broker.url}/roadmap/upsert`, {
    id: victim.id,
    by: "deck",
    instance_token: reg.body.instance_token,
    status: "done",
  });
  expect(attack.status).toBe(401);

  const after = await post<{ items: RoadmapItem[] }>(`${broker.url}/roadmap/list`, {
    project_key: PK,
  });
  const card = after.body.items.find((i) => i.id === victim.id)!;
  expect(card.status).toBe("in_progress");
  expect(card.locked).toBe(true);
  expect(card.locked_by).toBe("victim-peer");
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
