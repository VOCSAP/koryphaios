import { test, expect, beforeAll, afterAll } from "bun:test";
import { hostname } from "node:os";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { startBroker, stopBroker, post, livePid, type TestBroker, openBrokerDb } from "./_helper.ts";
import {
  buildAuthProof,
  buildInboxProof,
  deriveInstanceRef,
  deriveOperatorId,
  generateCredential,
  INBOX_GATES,
  type ApprovalCredential,
  type InboxGate,
} from "../shared/approval.ts";

let broker: TestBroker;
const brokers: TestBroker[] = [];

// One operator trusted at boot mints every run credential of this file.
const INBOX_OPERATOR = (() => {
  const cred = generateCredential();
  return { cred, id: deriveOperatorId(cred.publicKey) };
})();

beforeAll(async () => {
  broker = await startBroker({}, { trustedOperators: [INBOX_OPERATOR.cred.publicKey] });
});
afterAll(async () => {
  await stopBroker(broker);
  for (const b of brokers) { await stopBroker(b); }
});

/** Card 3d121a74 lot L3-a: the two new OPTIONAL identity fields. */
interface RegisterExtras {
  desk_session?: string;
  cc_session_id?: string;
  pid?: number;
  pid_generation?: string;
}

async function register(
  host: string,
  cwd: string,
  pid: number = livePid(),
  extras: RegisterExtras = {}
) {
  return post<{ peer_id: string; instance_token: string }>(`${broker.url}/register`, {
    pid, cwd, git_root: null, tty: null, summary: "", host, client_pid: 1,
    project_key: null, group_id: "default", group_secret_hash: null,
    ...extras,
  });
}

async function disconnect(token: string): Promise<void> {
  await post(`${broker.url}/disconnect`, { instance_token: token });
}

function sessionRows(host: string, cwd: string): { session_key: string; instance_token: string; cc_session_id: string }[] {
  const db = openBrokerDb(broker.dbPath, { readonly: true });
  const rows = db.query(
    "SELECT session_key, instance_token, cc_session_id FROM peer_sessions WHERE host = ? AND cwd = ? ORDER BY session_key"
  ).all(host, cwd) as { session_key: string; instance_token: string; cc_session_id: string }[];
  db.close();
  return rows;
}

test("re-register after /disconnect resurrects the same instance_token and peer_id", async () => {
  const a = await register("hostR", "/p1");
  const tok1 = a.body.instance_token;
  const id1 = a.body.peer_id;

  await post(`${broker.url}/disconnect`, { instance_token: tok1 });

  const a2 = await register("hostR", "/p1");
  expect(a2.body.instance_token).toBe(tok1);
  expect(a2.body.peer_id).toBe(id1);
});

test("dead-pid registration on the same (host, cwd) is treated as resurrect", async () => {
  // The post-crash dead-pid optimization is scoped to same-host peers (the
  // broker can only probe its own machine's process table). The same-host
  // scenario uses hostname() of the test runner, which equals BROKER_HOST.
  const myHost = hostname();
  const deadPid = 999_999_999;
  const a = await register(myHost, "/dp", deadPid);
  const tok1 = a.body.instance_token;
  const id1 = a.body.peer_id;

  // Re-register with a live pid; broker should detect dead pid -> resurrect.
  const a2 = await register(myHost, "/dp", livePid());
  expect(a2.body.instance_token).toBe(tok1);
  expect(a2.body.peer_id).toBe(id1);
});

test("different (host, cwd, group) yields distinct peers", async () => {
  const a = await register("h1", "/c1");
  const b = await register("h2", "/c1"); // different host
  const c = await register("h1", "/c2"); // different cwd
  expect(a.body.instance_token).not.toBe(b.body.instance_token);
  expect(a.body.instance_token).not.toBe(c.body.instance_token);
});

test("resume preserves claude_cli_pid through dormant cycle", async () => {
  const b = await startBroker();
  brokers.push(b);

  const first = await post<{ instance_token: string; peer_id: string }>(
    `${b.url}/register`,
    {
      pid: livePid(), cwd: "/tmp/resume-pid", git_root: null, tty: null,
      summary: "", host: "host-resume", client_pid: livePid(),
      claude_cli_pid: 91234, project_key: null,
      group_id: "default", group_secret_hash: null,
    }
  );
  expect(first.status).toBe(200);

  // Move to dormant.
  await post(`${b.url}/disconnect`, { instance_token: first.body.instance_token });

  // Re-register with the same (host, cwd, group_id) -> resume the dormant peer with a new claude_cli_pid.
  const second = await post<{ instance_token: string; peer_id: string }>(
    `${b.url}/register`,
    {
      pid: livePid(), cwd: "/tmp/resume-pid", git_root: null, tty: null,
      summary: "", host: "host-resume", client_pid: livePid(),
      claude_cli_pid: 99999, project_key: null,
      group_id: "default", group_secret_hash: null,
    }
  );
  expect(second.status).toBe(200);
  expect(second.body.instance_token).toBe(first.body.instance_token);

  const db = openBrokerDb(b.dbPath, { readonly: true });
  const row = db.query(
    "SELECT claude_cli_pid FROM peers WHERE instance_token = ?"
  ).get(first.body.instance_token) as { claude_cli_pid: number };
  db.close();
  expect(row.claude_cli_pid).toBe(99999);
});

// ----- Card 3d121a74 lot L3-a: per-tile identity key -----
//
// The measured defect these close: one peer_sessions row per DIRECTORY while a
// team puts N agents in one, so in the dormant window a DIFFERENT CC session
// opened there inherited the previous occupant's instance_token -- hence its
// undelivered mail, `messages` being keyed by to_token.

test("a peer_sessions row written under the LEGACY key is still resurrected by a register with NO discriminant", async () => {
  // Proves at database level that a peer_sessions row written under the
  // pre-widening hash algorithm is still found by a register call carrying no
  // discriminant -- the property that matters for every non-Deck CLI caller,
  // since they never send one.
  // The hash is recomputed here from its documented definition, independently
  // of sessionKey's current implementation, since no test run can otherwise
  // produce a value written by a binary that predates the widening: every fresh
  // run shares whatever algorithm is current.
  // Do not delete this as redundant with the resume tests nearby -- the failure
  // mode it simulates only exists across a binary boundary, and this is one of
  // only two ways a test can cross that boundary; the other downgrades a real
  // database instead.
  const host = "hostLegacy";
  const cwd = "/legacy-key";
  const a = await register(host, cwd);

  const legacy = createHash("sha256")
    .update(host).update("\0")
    .update(cwd).update("\0")
    .update("default")
    .digest("hex");

  const rows = sessionRows(host, cwd);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.session_key).toBe(legacy);

  // ... and it still resurrects through a dormant cycle.
  await disconnect(a.body.instance_token);
  const a2 = await register(host, cwd);
  expect(a2.body.instance_token).toBe(a.body.instance_token);
  expect(a2.body.peer_id).toBe(a.body.peer_id);
});

test("two tiles sharing one directory own DISTINCT rows and never share an instance_token", async () => {
  const host = "hostTiles";
  const cwd = "/shared-dir";
  const t1 = await register(host, cwd, livePid(), { desk_session: "tile-token-1" });
  const t2 = await register(host, cwd, livePid(), { desk_session: "tile-token-2" });

  expect(t2.body.instance_token).not.toBe(t1.body.instance_token);
  // Two ROWS, not one row fought over: this is the whole point of the lot.
  const rows = sessionRows(host, cwd);
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((r) => r.instance_token)).size).toBe(2);
});

test("the same tile token resurrects its OWN row through a dormant cycle", async () => {
  const host = "hostTileResume";
  const cwd = "/tile-resume";
  const t1 = await register(host, cwd, livePid(), { desk_session: "stable-tile" });
  await disconnect(t1.body.instance_token);
  const again = await register(host, cwd, livePid(), { desk_session: "stable-tile" });
  expect(again.body.instance_token).toBe(t1.body.instance_token);
});

test("Restore gesture: a NEW tile token with the SAME cc_session_id reclaims the row", async () => {
  // fromWorkspaceSessions mints a fresh tile id (randomUUID) while preserving
  // the CC session id, so the widened key legitimately misses on a session
  // that IS continuing. The secondary lookup is what keeps the operator's
  // rule 3 ("Restore gives back the old id") true.
  const host = "hostRestore";
  const cwd = "/restore-me";
  const before = await register(host, cwd, livePid(), {
    desk_session: "tile-before-restore",
    cc_session_id: "cc-session-kept",
  });
  await disconnect(before.body.instance_token);

  const after = await register(host, cwd, livePid(), {
    desk_session: "tile-AFTER-restore", // new tile, minted by the restore
    cc_session_id: "cc-session-kept",    // same CC session
  });
  expect(after.body.instance_token).toBe(before.body.instance_token);
  expect(after.body.peer_id).toBe(before.body.peer_id);
});

test("the secondary cc_session_id lookup is SCOPED -- a DORMANT row from another cwd is never reclaimed", async () => {
  // cc_session_id is DECLARED by the caller and never proven, so without the
  // (group_id, host, cwd) scoping anyone who knows a CC id reclaims the row of
  // a tile in ANOTHER directory -- its token and its mail. That is this
  // card's own defect, entered by the other door.
  const cc = "cc-scope-probe";
  const owner = await register("hostScope", "/scope-a", livePid(), {
    desk_session: "tile-scope-a",
    cc_session_id: cc
  });
  // The victim must be DORMANT: while it is active the collision branch mints
  // a fresh peer anyway and masks an unscoped lookup entirely.
  await disconnect(owner.body.instance_token);
  const stranger = await register("hostScope", "/scope-b", livePid(), {
    desk_session: "tile-scope-b",
    cc_session_id: cc
  });
  expect(stranger.body.instance_token).not.toBe(owner.body.instance_token);
  const rows = sessionRows("hostScope", "/scope-a");
  expect(rows).toHaveLength(1);
  expect(rows[0]?.instance_token).toBe(owner.body.instance_token);
});

test("an EMPTY cc_session_id never reclaims a legacy row (the empty string is not an identity)", async () => {
  // cc_session_id defaults to '' for every legacy row, so an unguarded
  // secondary lookup would match ALL of them and hand this caller someone
  // else's line -- token and undelivered mail included, which is exactly the
  // defect this lot closes. Remove the `&& ccSessionId` guard and this goes red.
  const host = "hostEmptyCc";
  const cwd = "/empty-cc";
  const legacyPeer = await register(host, cwd); // no discriminant, no cc -> cc_session_id ''
  await disconnect(legacyPeer.body.instance_token);

  const newTile = await register(host, cwd, livePid(), { desk_session: "some-other-tile" });
  expect(newTile.body.instance_token).not.toBe(legacyPeer.body.instance_token);
});

test("two rows sharing one cc_session_id FAIL CLOSED: a third tile gets a fresh identity, never one of the two", async () => {
  // This state is reached by restoring the same CC session twice: restore
  // resurrects the row under the new tile's key while the pre-restore row
  // survives, so both end up sharing one cc_session_id.
  // Two simultaneously live tiles do not reproduce this: the second register
  // hits the active-collision branch and mints a derived id instead.
  const host = "hostAmbiguous";
  const cwd = "/ambiguous-cc";
  const one = await register(host, cwd, livePid(), { desk_session: "tile-A", cc_session_id: "cc-dup" });
  await disconnect(one.body.instance_token);

  const restored = await register(host, cwd, livePid(), { desk_session: "tile-B", cc_session_id: "cc-dup" });
  expect(restored.body.instance_token).toBe(one.body.instance_token); // reclaimed, as designed
  await disconnect(restored.body.instance_token);

  // Premise asserted, not assumed: two rows now carry the same cc_session_id.
  const dupRows = sessionRows(host, cwd).filter((r) => r.cc_session_id === "cc-dup");
  expect(dupRows).toHaveLength(2);

  const third = await register(host, cwd, livePid(), { desk_session: "tile-C", cc_session_id: "cc-dup" });
  expect(third.body.instance_token).not.toBe(one.body.instance_token);
  expect(third.body.instance_token).not.toBe(restored.body.instance_token);
});

const INBOX_PROJECT = "github.com/vocsap/koryphaios";
const INBOX_SECRET = "a".repeat(64);

interface RunCredential {
  cred: ApprovalCredential;
  tokenId: string;
  run: string;
  group: string;
}

async function mintRunCredential(group: string): Promise<RunCredential> {
  const cred = generateCredential();
  const run = crypto.randomUUID();
  const body = {
    session_public_key: cred.publicKey,
    session_ref: `window-${run}`,
    project_key: INBOX_PROJECT,
    inbox: { version: 1, kind: "run", run_ref: run, group_id: group },
    public_key: INBOX_OPERATOR.cred.publicKey,
  };
  const auth = buildInboxProof(INBOX_OPERATOR.cred.privateKey, body, INBOX_GATES.mint, {
    kind: "operator",
    operator_id: INBOX_OPERATOR.id,
  });
  const res = await post<{ token_id: string }>(`${broker.url}/approval/token-mint`, { ...body, auth });
  expect(res.status).toBe(200);
  return { cred, tokenId: res.body.token_id, run, group };
}

interface RegisterReply {
  peer_id: string;
  instance_token: string;
  inbox_binding?: { version: number; run_ref: string; group_id: string } | null;
  resumed?: "token" | false;
  error?: string;
}

function registerBody(group: string, host: string, cwd: string, extras: RegisterExtras): Record<string, unknown> {
  return {
    pid: livePid(), cwd, git_root: null, tty: null, summary: "", host, client_pid: 1,
    project_key: null, group_id: group, group_secret_hash: INBOX_SECRET,
    ...extras,
  };
}

function registerBare(group: string, host: string, cwd: string, extras: RegisterExtras = {}) {
  return post<RegisterReply>(`${broker.url}/register`, registerBody(group, host, cwd, extras));
}

function registerAttested(
  run: RunCredential,
  host: string,
  cwd: string,
  options: RegisterExtras & { resume?: string; gate?: InboxGate; credential?: ApprovalCredential; group?: string } = {}
) {
  const { resume, gate, credential, group, ...extras } = options;
  const body = {
    ...registerBody(group ?? run.group, host, cwd, extras),
    inbox_operation: "register",
    ...(resume ? { resume_instance_token: resume } : {}),
  };
  const auth = buildInboxProof((credential ?? run.cred).privateKey, body, gate ?? INBOX_GATES.register, {
    kind: "session",
    operator_id: INBOX_OPERATOR.id,
    token_id: run.tokenId,
  });
  return post<RegisterReply>(`${broker.url}/register`, { ...body, auth });
}

function bindingOf(instanceToken: string): Record<string, unknown> | null {
  const db = openBrokerDb(broker.dbPath, { readonly: true });
  try {
    return db
      .query("SELECT operator_id, run_ref, group_id, project_key FROM inbox_instance_bindings WHERE author_instance_ref = ?")
      .get(deriveInstanceRef(instanceToken)) as Record<string, unknown> | null;
  } finally {
    db.close();
  }
}

function peerCount(host: string, cwd: string): number {
  const db = openBrokerDb(broker.dbPath, { readonly: true });
  try {
    return (db.query("SELECT COUNT(*) AS n FROM peers WHERE host = ? AND cwd = ?").get(host, cwd) as { n: number }).n;
  } finally {
    db.close();
  }
}

function dropRows(sql: string, ...params: string[]): void {
  const db = openBrokerDb(broker.dbPath);
  try {
    db.run(sql, params);
  } finally {
    db.close();
  }
}

const canonicalOf = (host: string, cwd: string): string[] => sessionRows(host, cwd).map((r) => r.instance_token);

test("an attested register binds the instance to the credential's scope, and the binding outlives its peer row and association", async () => {
  const run = await mintRunCredential("g-inbox-bind");
  const a = await registerAttested(run, "hostBind", "/bind");

  expect(a.status).toBe(200);
  expect(bindingOf(a.body.instance_token)).toEqual({
    operator_id: INBOX_OPERATOR.id,
    run_ref: run.run,
    group_id: run.group,
    project_key: INBOX_PROJECT,
  });
  dropRows("DELETE FROM peers WHERE instance_token = ?", a.body.instance_token);
  dropRows("DELETE FROM peer_sessions WHERE instance_token = ?", a.body.instance_token);
  expect(bindingOf(a.body.instance_token), "the marker must outlive both rows").not.toBeNull();
});

test("a register response acknowledges the returned instance's Inbox binding", async () => {
  const run = await mintRunCredential("g-inbox-register-ack");
  const attested = await registerAttested(run, "hostAck", "/ack");
  const bare = await registerBare(run.group, "hostBareAck", "/bare-ack");

  expect(attested.status).toBe(200);
  expect(attested.body.inbox_binding).toEqual({ version: 1, run_ref: run.run, group_id: run.group });
  expect(bare.status).toBe(200);
  expect(bare.body.inbox_binding).toBeNull();
});

test("a bare client never takes over a bound dormant candidate, and its owner gets the identity back only with its own proof", async () => {
  const run = await mintRunCredential("g-inbox-dormant");
  const opts = { desk_session: "tile-1" };
  const b = await registerAttested(run, "hostDorm", "/dorm", opts);
  await disconnect(b.body.instance_token);

  const bare = await registerBare(run.group, "hostDorm", "/dorm", opts);
  expect(bare.body.instance_token).not.toBe(b.body.instance_token);
  expect(bare.body.peer_id).not.toBe(b.body.peer_id);
  expect(canonicalOf("hostDorm", "/dorm"), "the canonical association is not rewritten").toEqual([b.body.instance_token]);

  const signedWithoutProof = await registerAttested(run, "hostDorm", "/dorm", opts);
  expect(signedWithoutProof.body.instance_token).not.toBe(b.body.instance_token);
  expect(canonicalOf("hostDorm", "/dorm")).toEqual([b.body.instance_token]);

  const back = await registerAttested(run, "hostDorm", "/dorm", { ...opts, resume: b.body.instance_token });
  expect(back.body.instance_token).toBe(b.body.instance_token);
  expect(back.body.peer_id).toBe(b.body.peer_id);
  expect(back.body.inbox_binding).toEqual({ version: 1, run_ref: run.run, group_id: run.group });
});

test("a bound candidate whose peer row was purged is not reinserted for a bare client, but is for its owner", async () => {
  const run = await mintRunCredential("g-inbox-purged");
  const opts = { desk_session: "tile-1" };
  const b = await registerAttested(run, "hostPurged", "/purged", opts);
  dropRows("DELETE FROM peers WHERE instance_token = ?", b.body.instance_token);

  const bare = await registerBare(run.group, "hostPurged", "/purged", opts);
  expect(bare.body.instance_token).not.toBe(b.body.instance_token);
  expect(canonicalOf("hostPurged", "/purged"), "the association stays on the purged bound token").toEqual([b.body.instance_token]);
  expect(bindingOf(b.body.instance_token), "the marker is still there after the purge").not.toBeNull();

  const back = await registerAttested(run, "hostPurged", "/purged", { ...opts, resume: b.body.instance_token });
  expect(back.body.instance_token).toBe(b.body.instance_token);
  expect(back.body.inbox_binding).toEqual({ version: 1, run_ref: run.run, group_id: run.group });
  expect(peerCount("hostPurged", "/purged")).toBe(2);
});

test("a bound candidate reached through cc_session_id is not resumed either, and its owner's key is not touched", async () => {
  const run = await mintRunCredential("g-inbox-cc");
  const b = await registerAttested(run, "hostCc", "/cc", { desk_session: "tile-B", cc_session_id: "cc-bound" });
  await disconnect(b.body.instance_token);

  const other = await registerBare(run.group, "hostCc", "/cc", { desk_session: "tile-A", cc_session_id: "cc-bound" });
  expect(other.body.instance_token).not.toBe(b.body.instance_token);
  const rows = sessionRows("hostCc", "/cc");
  expect(rows.map((r) => r.instance_token).sort()).toEqual([b.body.instance_token, other.body.instance_token].sort());
});

test("the proof of an instance resumed by token takes the session key from a dormant holder and never hands out its identity", async () => {
  const run = await mintRunCredential("g-inbox-cost");
  const opts = { desk_session: "tile-1" };
  const b = await registerAttested(run, "hostCost", "/cost", opts);
  await disconnect(b.body.instance_token);
  const a = await registerAttested(run, "hostCost", "/cost", opts);
  expect(a.body.instance_token).not.toBe(b.body.instance_token);

  const aAgain = await registerAttested(run, "hostCost", "/cost", { ...opts, resume: a.body.instance_token });
  expect([aAgain.body.resumed, aAgain.body.instance_token], "A is found by its own token, not through the key B holds").toEqual([
    "token",
    a.body.instance_token,
  ]);
  expect(aAgain.body.instance_token, "and a proof of A never hands out B's identity").not.toBe(b.body.instance_token);
  expect(canonicalOf("hostCost", "/cost"), "B is dormant on a host the broker cannot probe: it no longer holds the key").toEqual([
    a.body.instance_token,
  ]);

  const activeRun = await mintRunCredential("g-inbox-cost-active");
  const activeB = await registerAttested(activeRun, "hostCostActive", "/cost-active", opts);
  const activeA = await registerAttested(activeRun, "hostCostActive", "/cost-active", opts);
  expect(activeA.body.instance_token, "precondition: the second instance is a newcomer beside the active B").not.toBe(
    activeB.body.instance_token
  );
  const activeAAgain = await registerAttested(activeRun, "hostCostActive", "/cost-active", { ...opts, resume: activeA.body.instance_token });
  expect(activeAAgain.body.resumed).toBe("token");
  expect(canonicalOf("hostCostActive", "/cost-active"), "B is ACTIVE on a host the broker cannot probe: it keeps the key").toEqual([
    activeB.body.instance_token,
  ]);
});

test("a proven bound candidate that is still running under another pid is not taken over: the newcomer is a new bound instance", async () => {
  const run = await mintRunCredential("g-inbox-collision");
  const opts = { desk_session: "tile-1" };
  const b = await registerAttested(run, "hostCol", "/col", opts);

  const second = await registerAttested(run, "hostCol", "/col", { ...opts, pid: broker.proc.pid, resume: b.body.instance_token });

  expect(second.status).toBe(200);
  expect(second.body.instance_token).not.toBe(b.body.instance_token);
  expect(second.body.resumed).toBe(false);
  expect(bindingOf(second.body.instance_token), "the newcomer is bound to the run like any attested instance").toMatchObject({
    run_ref: run.run,
  });
  expect(second.body.inbox_binding).toEqual({ version: 1, run_ref: run.run, group_id: run.group });
  expect(canonicalOf("hostCol", "/col")).toEqual([b.body.instance_token]);
});

test("a proven bound candidate presented again by the same relay pid is resumed in place, and a bare presenter never resumes it", async () => {
  const run = await mintRunCredential("g-inbox-same-pid");
  const opts = { desk_session: "tile-1" };
  const b = await registerAttested(run, "hostSame", "/same", opts);

  const bare = await registerBare(run.group, "hostSame", "/same", { ...opts, resume_instance_token: b.body.instance_token } as RegisterExtras);
  expect(bare.status).toBe(200);
  expect({ resumed: bare.body.resumed, token: bare.body.instance_token === b.body.instance_token }).toEqual({ resumed: false, token: false });
  expect(bindingOf(bare.body.instance_token), "a bare presenter gets no binding").toBeNull();
  expect(brokerLogs()).toContain("resume by token refused (bound_unproven)");

  const again = await registerAttested(run, "hostSame", "/same", { ...opts, resume: b.body.instance_token });
  expect(again.status).toBe(200);
  expect(again.body.resumed).toBe("token");
  expect(again.body.instance_token).toBe(b.body.instance_token);
  expect(again.body.peer_id).toBe(b.body.peer_id);
  expect(again.body.inbox_binding).toEqual({ version: 1, run_ref: run.run, group_id: run.group });
  expect(canonicalOf("hostSame", "/same")).toEqual([b.body.instance_token]);
});

test("a proof from another run does not resume a bound candidate", async () => {
  const run1 = await mintRunCredential("g-inbox-two-runs");
  const run2 = await mintRunCredential("g-inbox-two-runs");
  const opts = { desk_session: "tile-1" };
  const first = await registerAttested(run1, "hostTwo", "/two", opts);
  await disconnect(first.body.instance_token);

  const stolen = await registerAttested(run2, "hostTwo", "/two", { ...opts, resume: first.body.instance_token });
  expect(stolen.body.instance_token).not.toBe(first.body.instance_token);
  expect(bindingOf(stolen.body.instance_token)).toMatchObject({ run_ref: run2.run });
  expect(canonicalOf("hostTwo", "/two")).toEqual([first.body.instance_token]);
  const rightful = await registerAttested(run1, "hostTwo", "/two", { ...opts, resume: first.body.instance_token });
  expect(rightful.body.instance_token).toBe(first.body.instance_token);
});

test("an attested instance never converts a legacy row: a new bound identity, and it takes the key only when no live legacy process holds it", async () => {
  const run = await mintRunCredential("g-inbox-legacy");
  const dormantLegacy = await registerBare(run.group, "hostLeg", "/leg-dormant");
  await disconnect(dormantLegacy.body.instance_token);
  const attested = await registerAttested(run, "hostLeg", "/leg-dormant");
  expect(attested.body.instance_token).not.toBe(dormantLegacy.body.instance_token);
  expect(bindingOf(dormantLegacy.body.instance_token), "the legacy token is never promoted").toBeNull();
  expect(canonicalOf("hostLeg", "/leg-dormant")).toEqual([attested.body.instance_token]);

  const liveLegacy = await registerBare(run.group, "hostLeg", "/leg-live");
  const alongside = await registerAttested(run, "hostLeg", "/leg-live");
  expect(alongside.body.instance_token).not.toBe(liveLegacy.body.instance_token);
  expect(bindingOf(alongside.body.instance_token)).not.toBeNull();
  expect(canonicalOf("hostLeg", "/leg-live")).toEqual([liveLegacy.body.instance_token]);
});

test("a proof that is present but invalid is a refusal, never a bare registration", async () => {
  const run = await mintRunCredential("g-inbox-refuse");
  const expectRefused = async (reply: Promise<{ status: number; body: RegisterReply }>, status: number, host: string, cwd: string) => {
    const res = await reply;
    expect({ status: res.status, peers: peerCount(host, cwd) }).toEqual({ status, peers: 0 });
  };

  await expectRefused(registerAttested(run, "hostRef1", "/r1", { gate: INBOX_GATES.deposit }), 401, "hostRef1", "/r1");
  await expectRefused(registerAttested(run, "hostRef2", "/r2", { credential: generateCredential() }), 401, "hostRef2", "/r2");

  const legacyProof = await (async () => {
    const body = { ...registerBody(run.group, "hostRef3", "/r3", {}), inbox_operation: "register" };
    const auth = buildAuthProof(run.cred.privateKey, body, { kind: "session", operator_id: INBOX_OPERATOR.id, token_id: run.tokenId });
    return post<RegisterReply>(`${broker.url}/register`, { ...body, auth });
  })();
  expect({ status: legacyProof.status, error: legacyProof.body.error, peers: peerCount("hostRef3", "/r3") }).toEqual({
    status: 401,
    error: "not-v1",
    peers: 0,
  });

  await expectRefused(registerAttested(run, "hostRef4", "/r4", { group: "g-inbox-elsewhere" }), 403, "hostRef4", "/r4");
  const db = openBrokerDb(broker.dbPath, { readonly: true });
  const pinned = db.query("SELECT 1 FROM groups WHERE group_id = 'g-inbox-elsewhere'").get();
  db.close();
  expect(pinned, "a refused attested register must not pin a group").toBeNull();
});

test("an inbox operation without its proof is a 400, a bare resume token is ignored, and a revoked run credential is a 401", async () => {
  const run = await mintRunCredential("g-inbox-fields");
  const withResume = await registerBare(run.group, "hostFld", "/fld", {
    resume_instance_token: "x",
  } as RegisterExtras);
  const withOperation = await registerBare(run.group, "hostFld", "/fld2", {
    inbox_operation: "register",
  } as RegisterExtras);
  expect([withResume.status, withOperation.status]).toEqual([200, 400]);
  expect(withResume.body.resumed).toBe(false);

  const revoke = {
    session_ref: `window-${run.run}`,
    public_key: INBOX_OPERATOR.cred.publicKey,
  };
  const revokeAuth = buildAuthProof(INBOX_OPERATOR.cred.privateKey, revoke, { kind: "operator", operator_id: INBOX_OPERATOR.id });
  expect((await post(`${broker.url}/approval/token-revoke`, { ...revoke, auth: revokeAuth })).status).toBe(200);
  const afterRevoke = await registerAttested(run, "hostFld", "/fld3");
  expect({ status: afterRevoke.status, peers: peerCount("hostFld", "/fld3") }).toEqual({ status: 401, peers: 0 });
});

test("the binding is written with the peer in one transaction: a failing binding publishes neither the peer nor the association", async () => {
  const run = await mintRunCredential("g-inbox-atomic");
  const db = openBrokerDb(broker.dbPath);
  db.run("CREATE TRIGGER zz_binding_abort BEFORE INSERT ON inbox_instance_bindings BEGIN SELECT RAISE(ABORT, 'forced'); END");
  try {
    const res = await registerAttested(run, "hostAtomic", "/atomic");
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(peerCount("hostAtomic", "/atomic")).toBe(0);
    expect(sessionRows("hostAtomic", "/atomic")).toEqual([]);
  } finally {
    db.run("DROP TRIGGER zz_binding_abort");
    db.close();
  }
  const after = await registerAttested(run, "hostAtomic", "/atomic");
  expect(after.status).toBe(200);
});

// Resume by presented token, and the liveness of a relay pid. The rows live on
// the broker's own host so that its pid probe applies; a second live pid is
// the broker's own.
const HERE = hostname();
const relayA = (): number => livePid();
const relayB = (): number => broker.proc.pid;

function registerRelay(group: string, host: string, cwd: string, pid: number, extras: Record<string, unknown> = {}) {
  return post<RegisterReply>(`${broker.url}/register`, { ...registerBody(group, host, cwd, {}), pid, ...extras });
}

/** Every line the broker has logged so far. */
function brokerLogs(): string {
  return [join(broker.tmpDir, "logs"), broker.tmpDir]
    .filter((d) => existsSync(d))
    .flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".log")).map((f) => readFileSync(join(d, f), "utf8")))
    .join("\n");
}

function rowOf(token: string): { status: string; pid_generation: string | null; group_id: string; cwd: string } | null {
  const db = openBrokerDb(broker.dbPath, { readonly: true });
  try {
    return db.query("SELECT status, pid_generation, group_id, cwd FROM peers WHERE instance_token = ?").get(token) as {
      status: string;
      pid_generation: string | null;
      group_id: string;
      cwd: string;
    } | null;
  } finally {
    db.close();
  }
}

test("two peers sharing host, cwd and group each get their own identity back by token, whatever the order", async () => {
  const a = await registerRelay("default", HERE, "/rt-two", relayA());
  const b = await registerRelay("default", HERE, "/rt-two", relayB());
  expect(b.body.peer_id, "precondition: the second relay got a suffixed identity").not.toBe(a.body.peer_id);

  const bAgain = await registerRelay("default", HERE, "/rt-two", relayB(), { resume_instance_token: b.body.instance_token });
  expect(canonicalOf(HERE, "/rt-two"), "the resume of B leaves the session key with A, whose pid is alive").toEqual([a.body.instance_token]);
  const aAgain = await registerRelay("default", HERE, "/rt-two", relayA(), { resume_instance_token: a.body.instance_token });

  expect({
    a: [aAgain.status, aAgain.body.resumed, aAgain.body.instance_token, aAgain.body.peer_id],
    b: [bAgain.status, bAgain.body.resumed, bAgain.body.instance_token, bAgain.body.peer_id],
    rows: peerCount(HERE, "/rt-two"),
  }).toEqual({
    a: [200, "token", a.body.instance_token, a.body.peer_id],
    b: [200, "token", b.body.instance_token, b.body.peer_id],
    rows: 2,
  });
});

test("a resume that breaks a rule is ignored: ordinary registration, resumed false, nothing taken from the row", async () => {
  interface Attempt {
    name: string;
    token?: string;
    host?: string;
    group?: string;
    rowPid?: number;
    pid?: number;
    rowGeneration?: string;
    generation?: string;
    relayed?: boolean;
  }
  const attempts: Attempt[] = [
    { name: "unknown token", token: crypto.randomUUID() },
    { name: "another relay pid", pid: relayB() },
    { name: "another group", group: "g-resume-other" },
    { name: "another host", host: "hostResumeOther" },
    { name: "dead pid", rowPid: 999_999_999, pid: 999_999_999 },
    { name: "generation differs", rowGeneration: "gen-1", generation: "gen-2" },
    { name: "generation omitted", rowGeneration: "gen-1" },
    { name: "relayed row", relayed: true },
    // The seeded sentinel rows are local, in group default, with host "" and pid 0: only the shape guard refuses them.
    { name: "operator sentinel row", token: "__operator__", host: "", pid: 0 },
    { name: "deck sentinel row", token: "__deck__", host: "", pid: 0 },
    { name: "sentinel-shaped", token: "__anything__" },
  ];
  const outcomes: unknown[] = [];
  const presented: string[] = [];
  for (const [i, attempt] of attempts.entries()) {
    const cwd = `/rt-refused-${i}`;
    const rowPid = attempt.rowPid ?? relayA();
    const row = await registerRelay("default", HERE, cwd, rowPid, attempt.rowGeneration ? { pid_generation: attempt.rowGeneration } : {});
    if (attempt.relayed) dropRows("UPDATE peers SET relay_id = 'relay-test' WHERE instance_token = ?", row.body.instance_token);
    const token = attempt.token ?? row.body.instance_token;
    presented.push(token);
    const res = await registerRelay(attempt.group ?? "default", attempt.host ?? HERE, cwd, attempt.pid ?? rowPid, {
      resume_instance_token: token,
      ...(attempt.generation ? { pid_generation: attempt.generation } : {}),
    });
    outcomes.push({
      name: attempt.name,
      status: res.status,
      resumed: res.body.resumed,
      reused: res.body.instance_token === row.body.instance_token,
      group: rowOf(row.body.instance_token)?.group_id,
    });
  }
  expect(outcomes).toEqual(
    attempts.map((a) => ({ name: a.name, status: 200, resumed: false, reused: a.name === "dead pid", group: "default" }))
  );

  const logs = brokerLogs();
  const refusalCodes = ["unknown_token", "pid", "group", "host", "pid_dead", "generation", "not_local", "sentinel"];
  expect(
    refusalCodes.filter((code) => !logs.includes(`resume by token refused (${code})`)),
    "every refusal code of this table is traced"
  ).toEqual([]);
  const levelOf = (code: string): string[] =>
    logs.split("\n").filter((line) => line.includes(`refused (${code})`)).map((line) => line.trim().split(/\s+/)[1] ?? "");
  expect(
    { pid: new Set(levelOf("pid")), group: new Set(levelOf("group")) },
    "the pid code is the ordinary flow of a relaunched tile (info), the other codes warn"
  ).toEqual({ pid: new Set(["INFO"]), group: new Set(["WARN"]) });
  expect(
    presented
      .filter((token) => /^[0-9a-f-]{36}$/.test(token))
      .filter((token) => logs.includes(token) || logs.includes(token.slice(0, 8))),
    "no presented token, nor its prefix, reaches the log"
  ).toEqual([]);
});

test("a resume field of the wrong type is a 400 that registers nothing", async () => {
  const bad: Array<[string, unknown]> = [
    ["resume_instance_token", 5],
    ["resume_instance_token", ""],
    ["resume_instance_token", "x".repeat(257)],
    ["pid_generation", 5],
    ["pid_generation", null],
    ["pid_generation", ""],
    ["pid_generation", "x".repeat(257)],
  ];
  const statuses: number[] = [];
  for (const [field, value] of bad) {
    statuses.push((await registerRelay("default", HERE, "/rt-bad", relayA(), { [field]: value })).status);
  }
  expect({ statuses, rows: peerCount(HERE, "/rt-bad") }).toEqual({ statuses: bad.map(() => 400), rows: 0 });
});

test("a token whose row was purged is ignored with a 200, never a conflict", async () => {
  const a = await registerRelay("default", HERE, "/rt-purged", relayA());
  await post(`${broker.url}/unregister`, { instance_token: a.body.instance_token });
  expect(rowOf(a.body.instance_token)).toBeNull();

  const res = await registerRelay("default", HERE, "/rt-purged", relayA(), { resume_instance_token: a.body.instance_token });
  expect(res.status).toBe(200);
  expect(res.body.resumed).toBe(false);
  expect(res.body.instance_token).not.toBe(a.body.instance_token);
});

test("a dormant row is resumed in place, and a row that carries a generation refuses a resume without it", async () => {
  const a = await registerRelay("default", HERE, "/rt-gen", relayA());
  expect(rowOf(a.body.instance_token)?.pid_generation, "a client without a generation stores none").toBeNull();
  await disconnect(a.body.instance_token);

  const first = await registerRelay("default", HERE, "/rt-gen", relayA(), {
    resume_instance_token: a.body.instance_token,
    pid_generation: "gen-1",
  });
  expect(first.body.resumed).toBe("token");
  expect(first.body.peer_id).toBe(a.body.peer_id);
  expect(rowOf(a.body.instance_token)).toMatchObject({ status: "active", pid_generation: "gen-1" });

  const omitted = await registerRelay("default", HERE, "/rt-gen", relayA(), { resume_instance_token: a.body.instance_token });
  expect(omitted.body.resumed, "the row holds gen-1, a claim without a generation cannot skip the comparison").toBe(false);
  const same = await registerRelay("default", HERE, "/rt-gen", relayA(), {
    resume_instance_token: a.body.instance_token,
    pid_generation: "gen-1",
  });
  expect(same.body.resumed).toBe("token");
});

test("a dormant row whose relay pid is alive is not resurrected by another process of the same folder", async () => {
  const a = await registerRelay("default", HERE, "/rs-live", relayA());
  await disconnect(a.body.instance_token);

  const other = await registerRelay("default", HERE, "/rs-live", relayB());
  expect({
    token: other.body.instance_token === a.body.instance_token,
    id: other.body.peer_id === a.body.peer_id,
    key: canonicalOf(HERE, "/rs-live"),
  }).toEqual({ token: false, id: false, key: [a.body.instance_token] });

  const otherAgain = await registerRelay("default", HERE, "/rs-live", relayB(), { resume_instance_token: other.body.instance_token });
  expect(otherAgain.body.resumed).toBe("token");
  expect(canonicalOf(HERE, "/rs-live"), "a dormant holder whose pid is alive keeps the session key").toEqual([a.body.instance_token]);

  const back = await registerRelay("default", HERE, "/rs-live", relayA());
  expect(back.body.instance_token, "the relay that owns the row gets it back").toBe(a.body.instance_token);
});

test("an attested register never resumes an unbound row in place: it gets a new bound identity", async () => {
  const run = await mintRunCredential("g-inbox-unbound-resume");
  const legacy = await registerBare(run.group, "hostUnb", "/unb", { desk_session: "tile-1" });
  const attested = await registerAttested(run, "hostUnb", "/unb", { desk_session: "tile-2", resume: legacy.body.instance_token });

  expect(attested.status).toBe(200);
  expect(attested.body.resumed).toBe(false);
  expect(attested.body.instance_token).not.toBe(legacy.body.instance_token);
  expect(bindingOf(legacy.body.instance_token), "the legacy token is never promoted").toBeNull();
  expect(bindingOf(attested.body.instance_token)).not.toBeNull();
  expect(brokerLogs()).toContain("resume by token refused (attested_over_unbound)");
});

test("pid 0 is not alive at the two register-time probes: a legacy row of pid 0 holds no key and is resurrected", async () => {
  const run = await mintRunCredential("g-inbox-pid-zero");
  const legacy = await registerRelay(run.group, HERE, "/pz-key", 0, { desk_session: "tile-1" });
  const attested = await registerAttested(run, HERE, "/pz-key", { desk_session: "tile-1" });
  expect(attested.body.instance_token).not.toBe(legacy.body.instance_token);
  expect(canonicalOf(HERE, "/pz-key"), "an attested instance takes the key from a pid 0 legacy row").toEqual([attested.body.instance_token]);

  const first = await registerRelay("default", HERE, "/pz-active", 0);
  const second = await registerRelay("default", HERE, "/pz-active", relayA());
  expect(second.body.instance_token, "an active row of pid 0 is read as dormant and resurrected, not as a collision").toBe(first.body.instance_token);
});

test("a register without pid_generation keeps the stored one for the same pid and clears it when the pid changes", async () => {
  const first = await registerRelay("default", "hostGenKeep", "/gen-keep", relayA(), { pid_generation: "gen-1" });
  await disconnect(first.body.instance_token);
  const same = await registerRelay("default", "hostGenKeep", "/gen-keep", relayA());
  expect(same.body.instance_token).toBe(first.body.instance_token);
  expect(rowOf(first.body.instance_token)?.pid_generation, "same pid: the stored generation still describes it").toBe("gen-1");

  await disconnect(first.body.instance_token);
  const moved = await registerRelay("default", "hostGenKeep", "/gen-keep", relayB());
  expect(moved.body.instance_token).toBe(first.body.instance_token);
  expect(rowOf(first.body.instance_token)?.pid_generation, "another pid: the old generation describes a process that is gone").toBeNull();
});

test("a dormant row whose relay pid is dead is still resurrected by session key", async () => {
  const dead = 999_999_999;
  const a = await registerRelay("default", HERE, "/rs-dead", dead);
  await disconnect(a.body.instance_token);
  const next = await registerRelay("default", HERE, "/rs-dead", relayB());
  expect(next.body.instance_token).toBe(a.body.instance_token);
});

test("a process that leaves a group and comes back to it gets its own identity back", async () => {
  const first = await registerRelay("default", HERE, "/rs-switch", relayA());
  await disconnect(first.body.instance_token);
  const away = await registerRelay("g-resume-switch", HERE, "/rs-switch", relayA());
  await disconnect(away.body.instance_token);

  const back = await registerRelay("default", HERE, "/rs-switch", relayA());
  expect([back.body.instance_token, back.body.peer_id]).toEqual([first.body.instance_token, first.body.peer_id]);
});
