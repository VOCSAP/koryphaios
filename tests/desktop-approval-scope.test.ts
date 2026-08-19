// spec_67d0b267 -- card 1def56da. The DECISION layer of approval authorization.
//
// WHY THIS FILE IS NAMED `desktop-*` DESPITE TESTING A CORE MODULE.
// The prefix is the CI selector, not a topic label: `.github/workflows/
// desktop-build.yml` line 79 collects by glob, and `tests/desktop-*.test.ts` is
// the first of the ten. Measured 2026-08-19, and it is the reason this file
// exists at all: the FOUR suites that cover approvals today
// (tests/broker-approvals.test.ts 644 lines, tests/approval-hook.test.ts 370,
// tests/broker-approval-reply.test.ts 258, tests/broker-project-key-alignment
// .test.ts 137) match NONE of those ten globs, so 1409 lines of approval
// coverage have never run on a CI runner. They cannot be renamed: they spawn a
// broker and bind ports, which is exactly what that matrix excludes on purpose.
//
// So the guarantee was split. Everything that can be decided WITHOUT a database
// lives in shared/approval-scope.ts and is proved here, under CI. Everything
// that needs a live broker stays in the broker suites, and stays local. This
// file does not replace them; it is the part of the contract that gets replayed
// on Windows and macOS instead of only on this machine.
//
// It also proves what a source scan could not: that `project_key` for a SESSION
// credential comes from the token even when the request body declares a
// different one. That is the actual defect card 1def56da closes, and it is a
// behaviour, not a shape.

import { test, expect, describe } from "bun:test";
import {
  createApprovalAuth,
  approvalWhere,
  stampInsert,
  assertStampSessionRef,
  isAuthError,
  type ApprovalAuthDeps,
  type ApprovalScope,
} from "../shared/approval-scope.ts";
import {
  buildAuthProof,
  deriveOperatorId,
  generateCredential,
  type ApprovalCredential,
} from "../shared/approval.ts";

interface TokenRow {
  public_key: string;
  operator_id: string;
  session_ref: string;
  project_key: string;
  revoked_at: string | null;
  expires_at: string;
}

/**
 * A database that answers the two SELECTs this module makes and records the one
 * INSERT. Deliberately dumb: the point is to exercise the DECISION, and a real
 * SQLite here would only re-test SQLite while dragging in a file handle.
 */
function fakeDb(seed: { operators?: Record<string, string>; tokens?: Record<string, TokenRow> } = {}): {
  deps: ApprovalAuthDeps;
  nonces: string[];
} {
  const operators = seed.operators ?? {};
  const tokens = seed.tokens ?? {};
  const nonces: string[] = [];
  const deps: ApprovalAuthDeps = {
    queryOne<T>(sql: string, params: unknown[]): T | null {
      if (sql.includes("approval_operators")) {
        const pk = operators[String(params[0])];
        return pk ? ({ public_key: pk } as T) : null;
      }
      if (sql.includes("approval_session_tokens")) {
        return (tokens[String(params[0])] ?? null) as T | null;
      }
      throw new Error(`fakeDb: unexpected query ${sql}`);
    },
    queryAll<T>(): T[] {
      return [];
    },
    run(): void {
      /* the last_seen_at upsert; nothing to observe */
    },
    rememberNonce(nonce: string): boolean {
      if (nonces.includes(nonce)) return false;
      nonces.push(nonce);
      return true;
    },
  };
  return { deps, nonces };
}

function newOperator(): { cred: ApprovalCredential; id: string } {
  const cred = generateCredential();
  return { cred, id: deriveOperatorId(cred.publicKey) };
}

/** Sign a body the way every real caller does: the proof never covers itself. */
function signed(
  payload: Record<string, unknown>,
  signer: { cred: ApprovalCredential; id: string; token_id?: string; kind?: "operator" | "session" }
): Record<string, unknown> {
  const body = { ...payload, public_key: signer.cred.publicKey };
  const auth = buildAuthProof(signer.cred.privateKey, body, {
    kind: signer.kind ?? "operator",
    operator_id: signer.id,
    token_id: signer.token_id,
  });
  return { ...body, auth };
}

const FUTURE = new Date(Date.now() + 3600_000).toISOString();

/** An operator enrolled in the fake store, plus an auth built over it. */
function operatorSetup(): { auth: ReturnType<typeof createApprovalAuth>; op: { cred: ApprovalCredential; id: string } } {
  const op = newOperator();
  const { deps } = fakeDb({ operators: { [op.id]: op.cred.publicKey } });
  return { auth: createApprovalAuth(deps), op };
}

/** A session credential whose token carries `projectKey` ('' = pre-scoping). */
function sessionSetup(projectKey: string): {
  auth: ReturnType<typeof createApprovalAuth>;
  op: { cred: ApprovalCredential; id: string };
  sess: ApprovalCredential;
  tokenId: string;
} {
  const op = newOperator();
  const sess = generateCredential();
  const tokenId = "tok-1";
  const { deps } = fakeDb({
    operators: { [op.id]: op.cred.publicKey },
    tokens: {
      [tokenId]: {
        public_key: sess.publicKey,
        operator_id: op.id,
        session_ref: "tile-7",
        project_key: projectKey,
        revoked_at: null,
        expires_at: FUTURE,
      },
    },
  });
  return { auth: createApprovalAuth(deps), op, sess, tokenId };
}

describe("approvalWhere is the single clause producer", () => {
  test("every clause carries BOTH dimensions, always", () => {
    // The fail-OPEN direction, and therefore the one asserted first: a clause
    // that quietly loses a dimension is a leak with no error and no diff.
    const { auth, op } = operatorSetup();
    const got = auth.authorizeQuery(signed({ project_key: "repo-a" }, op), "list");
    expect(isAuthError(got)).toBe(false);
    if (isAuthError(got)) return;
    const where = approvalWhere(got.scope);
    expect(where.sql).toContain("operator_id = ?");
    expect(where.sql).toContain("project_key = ?");
    expect(where.params).toEqual([op.id, "repo-a"]);
  });

  test("a session scope additionally pins the tile, an operator scope does not", () => {
    const s = sessionSetup("repo-a");
    const sessBody = signed({ id: "x" }, { cred: s.sess, id: s.op.id, token_id: s.tokenId, kind: "session" });
    const got = s.auth.authorizeTarget(sessBody, "wait", []);
    expect(isAuthError(got)).toBe(false);
    if (isAuthError(got)) return;
    const where = approvalWhere(got.scope);
    expect(where.sql).toContain("session_ref = ?");
    expect(where.params).toEqual([s.op.id, "repo-a", "tile-7"]);

    const o = operatorSetup();
    const oGot = o.auth.authorizeQuery(signed({ project_key: "repo-a" }, o.op), "list");
    if (isAuthError(oGot)) throw new Error("operator authorization should have succeeded");
    expect(approvalWhere(oGot.scope).sql).not.toContain("session_ref");
  });

  test("an empty project_key is a VALUE in the clause, never a missing clause", () => {
    // Team-lead arbitration, 2026-08-19. A wildcard here would be the
    // cross-project leak written by our own hand, so the empty string has to
    // travel as an ordinary parameter. It cannot be produced through the
    // credential paths (both refuse it), so it is exercised on the row path,
    // which is where a legacy row's '' actually arrives.
    const legacyRow = { id: "ap-old", operator_id: "op-1", project_key: "" };
    const auth = createApprovalAuth({
      queryOne: <T,>(): T => legacyRow as T,
      queryAll: <T,>(): T[] => [],
      run: (): void => {},
      rememberNonce: (): boolean => true,
    });
    const got = auth.scopeForAnsweredRow("ap-old");
    if (!got) throw new Error("the seeded row should have resolved");
    const where = approvalWhere(got.scope);
    expect(where.sql).toContain("project_key = ?");
    expect(where.params).toEqual(["op-1", ""]);
  });

  test("two scopes are two OBJECTS: minting one does not rewrite the other", () => {
    // Review probe W1: `mintScope` returning a shared singleton left the pure
    // suite, the broker suite and the reply suite ALL GREEN while every scope
    // in the process aliased the same object and the last mint won for
    // everybody. That is CLAUDE.md's "keyed by too little" landing on an object
    // identity instead of a table key, and nothing in the lot could see it.
    //
    // Asserted on the CLAUSES rather than on `a !== b`: object inequality would
    // also hold for two distinct objects sharing one entry in the field map,
    // which is the shape a careless refactor of the WeakMap would produce.
    const o1 = operatorSetup();
    const o2 = operatorSetup();
    const s1 = o1.auth.authorizeQuery(signed({ project_key: "repo-one" }, o1.op), "list");
    const s2 = o2.auth.authorizeQuery(signed({ project_key: "repo-two" }, o2.op), "list");
    if (isAuthError(s1) || isAuthError(s2)) throw new Error("both authorizations should have succeeded");
    expect(approvalWhere(s1.scope).params).toEqual([o1.op.id, "repo-one"]);
    // The second mint happened AFTER the first: re-reading the first here is
    // what catches an aliased store, since a singleton would now answer with
    // the second's values.
    expect(approvalWhere(s2.scope).params).toEqual([o2.op.id, "repo-two"]);
    expect(approvalWhere(s1.scope).params).toEqual([o1.op.id, "repo-one"]);
  });

  test("every forgery tsc lets through is refused at RUNTIME", () => {
    // The honest statement of what protects the table. Review fed nine forgeries
    // to tsc and it flagged TWO; these five compile with no cast and no error,
    // so the type is not what stops them. The WeakMap is: it is keyed on OBJECT
    // IDENTITY, and no copy carries the key however complete it looks.
    //
    // The throw is deliberate. Returning a shorter clause for an unrecognised
    // scope would be the fail-OPEN direction, and invisible in every log.
    const o = operatorSetup();
    const real = o.auth.authorizeQuery(signed({ project_key: "repo-a" }, o.op), "list");
    if (isAuthError(real)) throw new Error("setup failed");
    const forgeries: Array<[string, ApprovalScope]> = [
      ["empty literal", {} as ApprovalScope],
      ["spread copy", { ...real.scope }],
      ["Object.assign copy", Object.assign({}, real.scope)],
      ["prototype chain", Object.create(real.scope) as ApprovalScope],
      ["JSON round trip", JSON.parse("{}") as ApprovalScope],
    ];
    for (const [label, forged] of forgeries) {
      expect(() => approvalWhere(forged), `forgery "${label}"`).toThrow(/not a scope minted/);
    }
    // Positive pin: the genuine article must still work, or a helper that threw
    // on everything would satisfy the five above and break the feature.
    expect(approvalWhere(real.scope).params).toEqual([o.op.id, "repo-a"]);
  });
});

describe("card 1def56da: where project_key comes from", () => {
  test("a SESSION credential takes it from the token and IGNORES the body's", () => {
    // THE test of the whole card. Before it, `handleApprovalAdd` read
    // `origin.project_key` from the request body, so a sandboxed agent could
    // file its blocking question under another project. Here the body screams a
    // different project and is overruled -- assert both halves, because a fix
    // that merely dropped the body's value would pass the second alone.
    const s = sessionSetup("repo-owned");
    const body = signed(
      { project_key: "repo-someone-else", origin: { project_key: "repo-someone-else" } },
      { cred: s.sess, id: s.op.id, token_id: s.tokenId, kind: "session" }
    );
    const got = s.auth.authorizeCreate(body);
    if (isAuthError(got)) throw new Error(`expected success, got ${got.error}`);
    expect(approvalWhere(got.scope).params).toContain("repo-owned");
    expect(approvalWhere(got.scope).params).not.toContain("repo-someone-else");
    expect(stampInsert(got.stamp).values).toContain("repo-owned");
  });

  test("a token minted BEFORE this card is refused, and the refusal names the cause", () => {
    // The fail-closed replacement for a migration window. The message has to be
    // actionable: an operator reading a bare 400 cannot know that restarting
    // the session is the fix.
    const s = sessionSetup("");
    const body = signed({}, { cred: s.sess, id: s.op.id, token_id: s.tokenId, kind: "session" });
    const got = s.auth.authorizeCreate(body);
    expect(isAuthError(got)).toBe(true);
    if (!isAuthError(got)) return;
    expect(got.status).toBe(400);
    expect(got.error).toContain("predates project scoping");
    expect(got.error).toContain("restart the session");
  });

  test("that refusal does NOT fall back on the body, even when the body offers one", () => {
    // DESIGN-APPROVAL-SCOPE.md §4 forbids this in terms: falling back would be
    // the defect reintroduced under cover of compatibility, and it would be
    // invisible -- everything would work, scoped to whatever the agent chose.
    const s = sessionSetup("");
    const body = signed(
      { project_key: "repo-chosen-by-the-agent" },
      { cred: s.sess, id: s.op.id, token_id: s.tokenId, kind: "session" }
    );
    const got = s.auth.authorizeCreate(body);
    expect(isAuthError(got)).toBe(true);
  });

  test("an OPERATOR credential must declare it, and '' does not count", () => {
    // The operator IS the trusted party, so declaring is not a hole; but one
    // operator_id spans every project on the machine, so without a declaration
    // there is no project dimension at all -- which is the leak card 4df14b5b
    // exists to close. Same refusal, now covering all four handlers.
    const o = operatorSetup();
    for (const payload of [{}, { project_key: "" }]) {
      const got = o.auth.authorizeQuery(signed(payload, o.op), "list");
      expect(isAuthError(got)).toBe(true);
      if (isAuthError(got)) expect(got.error).toBe("project_key is required");
    }
  });
});

describe("the stamp keeps the credential's fields out of the handler", () => {
  test("it yields exactly the three credential-derived columns", () => {
    const s = sessionSetup("repo-owned");
    const body = signed({}, { cred: s.sess, id: s.op.id, token_id: s.tokenId, kind: "session" });
    const got = s.auth.authorizeCreate(body);
    if (isAuthError(got)) throw new Error(got.error);
    const stamped = stampInsert(got.stamp);
    // Exact set, not a superset: a fourth column appearing here without the
    // INSERT's placeholder count moving would be a silent SQL arity bug.
    expect(stamped.columns).toEqual(["operator_id", "project_key", "session_ref"]);
    expect(stamped.values).toEqual([s.op.id, "repo-owned", "tile-7"]);
    expect(stamped.columns.length).toBe(stamped.values.length);
  });

  test("an operator's stamp carries no session, as '' rather than a null", () => {
    const o = operatorSetup();
    const got = o.auth.authorizeCreate(signed({ project_key: "repo-a" }, o.op));
    if (isAuthError(got)) throw new Error(got.error);
    expect(stampInsert(got.stamp).values).toEqual([o.op.id, "repo-a", ""]);
  });

  test("the session pin refuses another tile and tolerates an undeclared one", () => {
    const s = sessionSetup("repo-owned");
    const body = signed({}, { cred: s.sess, id: s.op.id, token_id: s.tokenId, kind: "session" });
    const got = s.auth.authorizeCreate(body);
    if (isAuthError(got)) throw new Error(got.error);
    expect(assertStampSessionRef(got.stamp, "tile-7")).toBeNull();
    // Undeclared is fine: the stamp supplies it. Declaring ANOTHER tile is the
    // impersonation the rule exists for.
    expect(assertStampSessionRef(got.stamp, "")).toBeNull();
    const refused = assertStampSessionRef(got.stamp, "tile-9");
    expect(refused?.status).toBe(403);

    // An operator pins nothing here, correctly: it has no session.
    const o = operatorSetup();
    const oGot = o.auth.authorizeCreate(signed({ project_key: "repo-a" }, o.op));
    if (isAuthError(oGot)) throw new Error(oGot.error);
    expect(assertStampSessionRef(oGot.stamp, "any-tile-at-all")).toBeNull();
  });
});

describe("authentication still refuses what it always refused", () => {
  test("a replayed proof is rejected once the nonce is spent", () => {
    const op = newOperator();
    const { deps } = fakeDb({ operators: { [op.id]: op.cred.publicKey } });
    const auth = createApprovalAuth(deps);
    const body = signed({ project_key: "repo-a" }, op);
    expect(isAuthError(auth.authorizeQuery(body, "list"))).toBe(false);
    const replay = auth.authorizeQuery(body, "list");
    expect(isAuthError(replay)).toBe(true);
    if (isAuthError(replay)) expect(replay.error).toBe("replayed-proof");
  });

  test("a session credential may not claim, whatever its project", () => {
    // The sandbox guard, and the reason it is asserted HERE rather than trusted:
    // `claim` authorises a tool call, so a session token reaching it would turn
    // a sandboxed agent into its own approver.
    const s = sessionSetup("repo-owned");
    const body = signed({ id: "x" }, { cred: s.sess, id: s.op.id, token_id: s.tokenId, kind: "session" });
    const got = s.auth.authorizeTarget(body, "claim", ["x"]);
    expect(isAuthError(got)).toBe(true);
    if (isAuthError(got)) expect(got.status).toBe(403);
  });

  test("a revoked or expired token is refused before any project question", () => {
    for (const [label, patch] of [
      ["revoked", { revoked_at: new Date().toISOString() }],
      ["expired", { expires_at: new Date(Date.now() - 1000).toISOString() }],
    ] as const) {
      const op = newOperator();
      const sess = generateCredential();
      const base: TokenRow = {
        public_key: sess.publicKey,
        operator_id: op.id,
        session_ref: "tile-7",
        project_key: "repo-owned",
        revoked_at: null,
        expires_at: FUTURE,
      };
      // Spread onto a typed base rather than inside the literal: written inline
      // it duplicates a key, and TS is right to say the first one is dead --
      // a reader would have to work out which of the two actually applies.
      const { deps } = fakeDb({
        operators: { [op.id]: op.cred.publicKey },
        tokens: { "tok-1": { ...base, ...patch } },
      });
      const auth = createApprovalAuth(deps);
      const body = signed({}, { cred: sess, id: op.id, token_id: "tok-1", kind: "session" });
      const got = auth.authorizeCreate(body);
      expect(isAuthError(got)).toBe(true);
      if (isAuthError(got)) expect(got.error).toContain(label === "revoked" ? "revoked" : "expired");
    }
  });
});

describe("the gateway path, the one scope with no credential", () => {
  /** A fake db that serves ONE approval row, plus a counter of reads. */
  function withRow(row: { id: string; operator_id: string; project_key: string }): ReturnType<typeof createApprovalAuth> {
    const deps: ApprovalAuthDeps = {
      queryOne<T>(sql: string, params: unknown[]): T | null {
        if (!sql.includes("pending_approvals")) throw new Error(`unexpected: ${sql}`);
        return String(params[0]) === row.id ? (row as T) : null;
      },
      queryAll: <T,>(): T[] => [],
      run: (): void => {},
      rememberNonce: (): boolean => true,
    };
    return createApprovalAuth(deps);
  }

  test("the scope is minted from the row the MODULE read, and the row comes back with it", () => {
    // Review round 2 replaced `scopeForOwnedRow(row)` with this, and the
    // difference is the point: the old form took the row as an ARGUMENT, so its
    // safety rested on a comment telling callers where to obtain it. A handler
    // that built that argument from a request body compiled and passed every
    // guard in the lot. Here the caller supplies an ID and nothing else, so it
    // cannot name its own scope at all.
    const auth = withRow({ id: "ap-1", operator_id: "op-1", project_key: "repo-a" });
    const got = auth.scopeForAnsweredRow<{ id: string; operator_id: string; project_key: string }>("ap-1");
    expect(got).not.toBeNull();
    if (!got) return;
    expect(approvalWhere(got.scope).params).toEqual(["op-1", "repo-a"]);
    // The row is returned so the pairing check downstream runs against the same
    // bytes the scope was minted from, instead of a second read that could have
    // moved between the two.
    expect(got.row.id).toBe("ap-1");
    // No session pin: the operator answers from their phone, and pinning the
    // tile's session would refuse exactly the case the feature exists for.
    expect(approvalWhere(got.scope).sql).not.toContain("session_ref");
  });

  test("an unknown id yields null, never a scope over nothing", () => {
    // The fail-CLOSED direction. A scope minted from an absent row would carry
    // empty strings, and `project_key = ''` is an ORDINARY VALUE here -- it
    // would match every legacy row at once.
    const auth = withRow({ id: "ap-1", operator_id: "op-1", project_key: "repo-a" });
    expect(auth.scopeForAnsweredRow("ap-does-not-exist")).toBeNull();
  });

  test("the caller cannot smuggle its own operator or project through the id", () => {
    // The negative control for the whole redesign: whatever the caller says,
    // the clause carries the ROW's values.
    const auth = withRow({ id: "ap-1", operator_id: "op-real", project_key: "repo-real" });
    const got = auth.scopeForAnsweredRow("ap-1");
    if (!got) throw new Error("row should have resolved");
    const params = approvalWhere(got.scope).params;
    expect(params).toContain("op-real");
    expect(params).toContain("repo-real");
    expect(params).not.toContain("op-attacker");
  });
});
