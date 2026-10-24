// project_key for a session credential is always derived from the token, even
// when the request body declares a different one.
// Everything decidable without a database is proved here; what needs a live
// broker stays in the broker-prefixed suites.

import { test, expect, describe } from "bun:test";
import {
  createApprovalAuth,
  approvalWhere,
  authorizeInboxEntry,
  stampInsert,
  assertStampSessionRef,
  isAuthError,
  type ApprovalAuthDeps,
  type ApprovalScope,
  type InboxActor,
  type InboxEntryProvenance,
  type InboxInstanceBinding,
} from "../shared/approval-scope.ts";
import {
  buildAuthProof,
  buildInboxProof,
  deriveInstanceRef,
  deriveOperatorId,
  generateCredential,
  INBOX_GATES,
  INBOX_OPERATIONS,
  type ApprovalCredential,
  type InboxGate,
} from "../shared/approval.ts";

interface TokenRow {
  public_key: string;
  operator_id: string;
  session_ref: string;
  project_key: string;
  revoked_at: string | null;
  expires_at: string;
  inbox_purpose?: string | null;
  run_ref?: string | null;
  group_id?: string | null;
  parent_token_id?: string | null;
  authority?: string | null;
  caller_ref?: string | null;
}

/**
 * A database that answers the two SELECTs this module makes and records the one
 * INSERT. Deliberately dumb: the point is to exercise the DECISION, and a real
 * SQLite here would only re-test SQLite while dragging in a file handle.
 */
function fakeDb(seed: {
  operators?: Record<string, string>;
  tokens?: Record<string, TokenRow>;
  trustedOperators?: Record<string, string>;
  bindings?: Record<string, InboxInstanceBinding>;
} = {}): {
  deps: ApprovalAuthDeps;
  nonces: string[];
} {
  const operators = seed.operators ?? {};
  const tokens = seed.tokens ?? {};
  const trustedOperators = seed.trustedOperators ?? operators;
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
    resolveTrustedOperator(operatorId: string) {
      const publicKey = trustedOperators[operatorId];
      return publicKey ?? { error: "operator-not-trusted", status: 403 };
    },
    rememberNonce(nonce: string): boolean {
      if (nonces.includes(nonce)) return false;
      nonces.push(nonce);
      return true;
    },
    resolveInstanceBinding(instanceRef: string): InboxInstanceBinding | null {
      return seed.bindings?.[instanceRef] ?? null;
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
    // An empty project_key must travel as an ordinary bound parameter, never a
    // wildcard, or it becomes a cross-project leak.
    // Both credential paths refuse an empty string, so this is exercised on the
    // row path, where a legacy row's '' actually arrives.
    const legacyRow = { id: "ap-old", operator_id: "op-1", project_key: "" };
    const auth = createApprovalAuth({
      queryOne: <T,>(): T => legacyRow as T,
      queryAll: <T,>(): T[] => [],
      run: (): void => {},
      resolveTrustedOperator: (): string => "trusted",
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
    // docs/DESIGN-APPROVAL-SCOPE.md §4 forbids this in terms: falling back would be
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
  test("an operator absent from the trust policy is refused even with a valid self-derived id", () => {
    const trusted = newOperator();
    const untrusted = newOperator();
    const { deps } = fakeDb({ trustedOperators: { [trusted.id]: trusted.cred.publicKey } });
    const auth = createApprovalAuth(deps);

    const accepted = auth.authorizeQuery(signed({ project_key: "repo-a" }, trusted), "list");
    expect(isAuthError(accepted)).toBe(false);

    const refused = auth.authorizeQuery(signed({ project_key: "repo-a" }, untrusted), "list");
    expect(isAuthError(refused)).toBe(true);
    if (isAuthError(refused)) {
      expect(refused.status).toBe(403);
      expect(refused.error).toBe("operator-not-trusted");
    }
  });

  test("an operator proof may not replace policy key material", () => {
    const setup = operatorSetup();
    const other = newOperator();
    const body = { project_key: "repo-a", public_key: other.cred.publicKey };
    const auth = buildAuthProof(setup.op.cred.privateKey, body, {
      kind: "operator",
      operator_id: setup.op.id,
    });

    const refused = setup.auth.authorizeQuery({ ...body, auth }, "list");
    expect(isAuthError(refused)).toBe(true);
    if (isAuthError(refused)) {
      expect(refused.status).toBe(403);
      expect(refused.error).toBe("operator-key-mismatch");
    }
  });

  test("a session token is refused when its owner is no longer trusted", () => {
    const op = newOperator();
    const sess = generateCredential();
    const { deps } = fakeDb({
      trustedOperators: {},
      tokens: {
        "tok-1": {
          public_key: sess.publicKey,
          operator_id: op.id,
          session_ref: "tile-7",
          project_key: "repo-owned",
          revoked_at: null,
          expires_at: FUTURE,
        },
      },
    });
    const auth = createApprovalAuth(deps);
    const body = signed({}, { cred: sess, id: op.id, token_id: "tok-1", kind: "session" });

    const refused = auth.authorizeCreate(body);
    expect(isAuthError(refused)).toBe(true);
    if (isAuthError(refused)) {
      expect(refused.status).toBe(403);
      expect(refused.error).toBe("operator-not-trusted");
    }
  });

  test("a session credential may not use operator-check", () => {
    const s = sessionSetup("repo-owned");
    const body = signed({}, { cred: s.sess, id: s.op.id, token_id: s.tokenId, kind: "session" });
    const refused = s.auth.authenticateOperator(body, "operator-check");

    expect(isAuthError(refused)).toBe(true);
    if (isAuthError(refused)) expect(refused.status).toBe(403);
  });

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
  function withRow(
    row: { id: string; operator_id: string; project_key: string },
    trusted = true
  ): ReturnType<typeof createApprovalAuth> {
    const deps: ApprovalAuthDeps = {
      queryOne<T>(sql: string, params: unknown[]): T | null {
        if (!sql.includes("pending_approvals")) throw new Error(`unexpected: ${sql}`);
        return String(params[0]) === row.id ? (row as T) : null;
      },
      queryAll: <T,>(): T[] => [],
      run: (): void => {},
      resolveTrustedOperator: (): string | { error: string; status: number } =>
        trusted ? "trusted" : { error: "operator-not-trusted", status: 403 },
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

  test("a gateway cannot obtain a scope for an operator removed from trust", () => {
    const auth = withRow({ id: "ap-1", operator_id: "op-removed", project_key: "repo-a" }, false);
    expect(auth.scopeForAnsweredRow("ap-1")).toBeNull();
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

const INBOX_RUN = "11111111-1111-4111-8111-111111111111";
const INBOX_GROUP = "group-a";
const INBOX_PROJECT = "github.com/vocsap/koryphaios";
const INSTANCE_A = "instance-token-A";
const INSTANCE_B = "instance-token-B";

/**
 * One operator, one live run root, three mandates hanging from it and two bound
 * author instances. `tokens` is the fake store BY REFERENCE: a test mutates a
 * row (revokes the root, moves a run_ref) and the very next call sees it.
 */
function inboxWorld() {
  const op = newOperator();
  const rootCred = generateCredential();
  const creds = { lead: generateCredential(), author: generateCredential(), supervisor: generateCredential() };
  const base = (cred: ApprovalCredential, over: Partial<TokenRow>): TokenRow => ({
    public_key: cred.publicKey,
    operator_id: op.id,
    session_ref: "window-run",
    project_key: INBOX_PROJECT,
    revoked_at: null,
    expires_at: FUTURE,
    ...over,
  });
  const mandate = (cred: ApprovalCredential, authority: string): TokenRow =>
    base(cred, {
      session_ref: `caller-${authority}`,
      inbox_purpose: "mandate",
      run_ref: INBOX_RUN,
      group_id: INBOX_GROUP,
      parent_token_id: "root",
      authority,
      caller_ref: `${authority}-1`,
    });
  const tokens: Record<string, TokenRow> = {
    root: base(rootCred, { inbox_purpose: "run", run_ref: INBOX_RUN, group_id: INBOX_GROUP }),
    "m-lead": mandate(creds.lead, "lead"),
    "m-author": mandate(creds.author, "author"),
    "m-supervisor": mandate(creds.supervisor, "supervisor"),
  };
  const binding = { operator_id: op.id, run_ref: INBOX_RUN, group_id: INBOX_GROUP, project_key: INBOX_PROJECT };
  const bindings: Record<string, InboxInstanceBinding> = {
    [deriveInstanceRef(INSTANCE_A)]: { ...binding },
    [deriveInstanceRef(INSTANCE_B)]: { ...binding },
  };
  const { deps } = fakeDb({ operators: { [op.id]: op.cred.publicKey }, tokens, bindings });
  const auth = createApprovalAuth(deps);
  const sign = (payload: Record<string, unknown>, cred: ApprovalCredential, tokenId: string, gate: InboxGate) => ({
    ...payload,
    auth: buildInboxProof(cred.privateKey, payload, gate, { kind: "session", operator_id: op.id, token_id: tokenId }),
  });
  const entry = (over: Partial<InboxEntryProvenance> = {}): InboxEntryProvenance => ({
    operator_id: op.id,
    run_ref: INBOX_RUN,
    group_id: INBOX_GROUP,
    project_key: INBOX_PROJECT,
    author_instance_ref: deriveInstanceRef(INSTANCE_A),
    ...over,
  });

  interface EnvelopeOptions {
    mandate?: "lead" | "author" | "supervisor";
    operation?: "list" | "close";
    entryId?: string;
    reason?: string;
    instance?: string | null;
    authorCred?: ApprovalCredential;
    authorTokenId?: string;
    authorGate?: InboxGate;
    mandateGate?: InboxGate;
    authorPayloadOver?: Record<string, unknown>;
  }
  /** A mandate envelope, optionally carrying the author's own proof, as the main would assemble it. */
  function envelope(o: EnvelopeOptions = {}): Record<string, unknown> {
    const kind = o.mandate ?? "lead";
    const operation = o.operation ?? "close";
    const isList = operation === "list";
    const core: Record<string, unknown> = { inbox_operation: operation, entry_id: o.entryId ?? "e1", reason: o.reason ?? "done" };
    const instance = o.instance === undefined ? null : o.instance;
    if (instance !== null) {
      const authorPayload = { ...core, instance_token: instance, ...o.authorPayloadOver };
      const authorProof = buildInboxProof(
        (o.authorCred ?? rootCred).privateKey,
        authorPayload,
        o.authorGate ?? (isList ? INBOX_GATES.authorList : INBOX_GATES.authorClose),
        { kind: "session", operator_id: op.id, token_id: o.authorTokenId ?? "root" }
      );
      core.author = { payload: authorPayload, auth: authorProof };
    }
    return sign(core, creds[kind], `m-${kind}`, o.mandateGate ?? (isList ? INBOX_GATES.mandateList : INBOX_GATES.mandateClose));
  }
  const verify = (o: EnvelopeOptions = {}, operation: "inbox-list" | "inbox-close" = "inbox-close") =>
    auth.verifyInboxAction(envelope(o) as never, operation);
  const actor = (o: EnvelopeOptions = {}): InboxActor => {
    const got = verify(o);
    if (isAuthError(got)) throw new Error(`actor refused: ${got.error}`);
    return got;
  };
  return { op, rootCred, creds, tokens, bindings, auth, sign, entry, envelope, verify, actor };
}

describe("Inbox token purpose is read from the stored row", () => {
  test("a mandate cannot add even when the body claims another purpose", () => {
    const w = inboxWorld();
    const body = signed({ kind: "permission", title: "t", question: "q", purpose: "run", inbox_purpose: "run" }, {
      cred: w.creds.lead,
      id: w.op.id,
      token_id: "m-lead",
      kind: "session",
    });
    expect(w.auth.authorizeCreate(body as never)).toEqual({ error: "credential may not add", status: 403 });
  });

  test("a run root and a legacy token can still add (positive control)", () => {
    const w = inboxWorld();
    w.tokens["legacy"] = {
      public_key: w.rootCred.publicKey,
      operator_id: w.op.id,
      session_ref: "tile-1",
      project_key: INBOX_PROJECT,
      revoked_at: null,
      expires_at: FUTURE,
    };
    for (const tokenId of ["root", "legacy"]) {
      const body = signed({ kind: "permission", title: "t", question: "q" }, {
        cred: w.rootCred,
        id: w.op.id,
        token_id: tokenId,
        kind: "session",
      });
      expect({ tokenId, refused: isAuthError(w.auth.authorizeCreate(body as never)) }).toEqual({ tokenId, refused: false });
    }
  });

  test("an unknown stored purpose is refused, not mapped to a permissive class", () => {
    const w = inboxWorld();
    w.tokens["root"]!.inbox_purpose = "bogus";
    const body = signed({ kind: "permission", title: "t", question: "q" }, {
      cred: w.rootCred,
      id: w.op.id,
      token_id: "root",
      kind: "session",
    });
    expect(w.auth.authorizeCreate(body as never)).toEqual({ error: "unknown token purpose", status: 403 });
  });

  test("a legacy token holds no Inbox operation, a run root holds register", () => {
    const w = inboxWorld();
    w.tokens["legacy"] = { ...w.tokens["root"]!, inbox_purpose: null, run_ref: null, group_id: null };
    const asLegacy = w.sign({ x: 1 }, w.rootCred, "legacy", INBOX_GATES.register);
    expect(w.auth.authenticateInbox(asLegacy as never, "inbox-register", INBOX_GATES.register)).toEqual({
      error: "credential may not inbox-register",
      status: 403,
    });
    const asRun = w.auth.authenticateInbox(w.sign({ x: 1 }, w.rootCred, "root", INBOX_GATES.register) as never, "inbox-register", INBOX_GATES.register);
    expect(isAuthError(asRun)).toBe(false);
    if (isAuthError(asRun)) return;
    expect(asRun.purpose).toBe("run");
    expect(asRun.inbox).toEqual({ run_ref: INBOX_RUN, group_id: INBOX_GROUP, parent_token_id: null, authority: null, caller_ref: null });
  });

  test("a v1 proof is accepted only at its own gate and a legacy proof is not accepted as v1", () => {
    const w = inboxWorld();
    const wrongGate = w.sign({ x: 1 }, w.rootCred, "root", INBOX_GATES.deposit);
    expect(w.auth.authenticateInbox(wrongGate as never, "inbox-register", INBOX_GATES.register)).toEqual({
      error: "bad-signature",
      status: 401,
    });
    const legacyProof = signed({ x: 1 }, { cred: w.rootCred, id: w.op.id, token_id: "root", kind: "session" });
    expect(w.auth.authenticateInbox(legacyProof as never, "inbox-register", INBOX_GATES.register)).toEqual({
      error: "not-v1",
      status: 401,
    });
  });

  test("an Inbox token row without its run scope is refused", () => {
    const w = inboxWorld();
    w.tokens["root"]!.run_ref = null;
    const got = w.auth.authenticateInbox(w.sign({ x: 1 }, w.rootCred, "root", INBOX_GATES.register) as never, "inbox-register", INBOX_GATES.register);
    expect(got).toEqual({ error: "inbox token scope is incomplete", status: 401 });
  });
});

describe("an Inbox operation has no legacy form, and a door carries only its own operations", () => {
  test("a legacy proof never carries an Inbox operation, whichever token signs it", () => {
    const w = inboxWorld();
    const asRoot = signed({ x: 1 }, { cred: w.rootCred, id: w.op.id, token_id: "root", kind: "session" });
    for (const op of INBOX_OPERATIONS) {
      expect({ op, got: w.auth.authenticateOperator(asRoot as never, op) }).toEqual({
        op,
        got: { error: `${op} requires a v1 proof`, status: 403 },
      });
    }
    const asMandate = signed({ x: 1 }, { cred: w.creds.lead, id: w.op.id, token_id: "m-lead", kind: "session" });
    expect(w.auth.authenticateOperator(asMandate as never, "inbox-close")).toEqual({
      error: "inbox-close requires a v1 proof",
      status: 403,
    });
    expect(w.auth.authorizeQuery(asRoot as never, "inbox-deposit")).toEqual({
      error: "inbox-deposit requires a v1 proof",
      status: 403,
    });
  });

  test("a valid v1 proof is refused under a door that does not carry the operation", () => {
    const w = inboxWorld();
    const refused = { error: expect.stringContaining("is not carried by this gate"), status: 403 };
    const asRoot = (gate: InboxGate, op: Parameters<typeof w.auth.authenticateInbox>[1]) =>
      w.auth.authenticateInbox(w.sign({ x: 1 }, w.rootCred, "root", gate) as never, op, gate);
    const asMandate = (gate: InboxGate, op: Parameters<typeof w.auth.authenticateInbox>[1]) =>
      w.auth.authenticateInbox(w.sign({ x: 1 }, w.creds.lead, "m-lead", gate) as never, op, gate);

    for (const [gate, op] of [
      [INBOX_GATES.deposit, "inbox-register"],
      [INBOX_GATES.register, "inbox-deposit"],
      [INBOX_GATES.channel, "inbox-register"],
      [INBOX_GATES.authorList, "inbox-register"],
      [INBOX_GATES.register, "add"],
    ] as const) {
      expect({ gate, op, got: asRoot(gate, op) }).toEqual({ gate, op, got: refused });
    }
    for (const [gate, op] of [
      [INBOX_GATES.mandateList, "inbox-close"],
      [INBOX_GATES.mandateClose, "inbox-list"],
      [INBOX_GATES.mandateList, "inbox-author-proof"],
    ] as const) {
      expect({ gate, op, got: asMandate(gate, op) }).toEqual({ gate, op, got: refused });
    }
    const operatorProof = buildInboxProof(w.op.cred.privateKey, { x: 1 }, INBOX_GATES.mint, {
      kind: "operator",
      operator_id: w.op.id,
    });
    expect(w.auth.authenticateInbox({ x: 1, auth: operatorProof } as never, "claim", INBOX_GATES.mint)).toEqual(refused);
  });

  test("an unknown door or an inherited property name is a refusal, never an exception", () => {
    const w = inboxWorld();
    for (const gate of ["POST /nowhere", "constructor", "__proto__", "toString"]) {
      const body = w.sign({ x: 1 }, w.rootCred, "root", INBOX_GATES.register);
      expect({ gate, got: w.auth.authenticateInbox(body as never, "inbox-register", gate as never) }).toEqual({
        gate,
        got: { error: "inbox-register is not carried by this gate", status: 403 },
      });
    }
  });

  test("each door still carries its own operation", () => {
    const w = inboxWorld();
    for (const [gate, op] of [
      [INBOX_GATES.register, "inbox-register"],
      [INBOX_GATES.deposit, "inbox-deposit"],
      [INBOX_GATES.channel, "inbox-deposit"],
      [INBOX_GATES.authorList, "inbox-author-proof"],
      [INBOX_GATES.authorClose, "inbox-author-proof"],
    ] as const) {
      const got = w.auth.authenticateInbox(w.sign({ x: 1 }, w.rootCred, "root", gate) as never, op, gate);
      expect({ gate, op, refused: isAuthError(got) }).toEqual({ gate, op, refused: false });
    }
    const list = w.auth.authenticateInbox(w.sign({ x: 1 }, w.creds.lead, "m-lead", INBOX_GATES.mandateList) as never, "inbox-list", INBOX_GATES.mandateList);
    expect(isAuthError(list)).toBe(false);
  });
});

describe("a mandate is only as live as its run parent", () => {
  const useMandate = (w: ReturnType<typeof inboxWorld>) =>
    w.auth.authenticateInbox(w.sign({ x: 1 }, w.creds.lead, "m-lead", INBOX_GATES.mandateList) as never, "inbox-list", INBOX_GATES.mandateList);

  test("live parent: usable", () => {
    expect(isAuthError(useMandate(inboxWorld()))).toBe(false);
  });

  test("revoked parent: refused although the mandate row itself is untouched", () => {
    const w = inboxWorld();
    w.tokens["root"]!.revoked_at = new Date().toISOString();
    expect(useMandate(w)).toEqual({ error: "mandate parent revoked", status: 401 });
  });

  test("expired parent: refused", () => {
    const w = inboxWorld();
    w.tokens["root"]!.expires_at = new Date(Date.now() - 1000).toISOString();
    expect(useMandate(w)).toEqual({ error: "mandate parent expired", status: 401 });
  });

  test("a parent of another run, group, project or operator is refused", () => {
    for (const [field, value] of [
      ["run_ref", "22222222-2222-4222-8222-222222222222"],
      ["group_id", "group-b"],
      ["project_key", "github.com/other/repo"],
      ["operator_id", "someone-else"],
    ] as const) {
      const w = inboxWorld();
      w.tokens["root"]![field] = value;
      expect({ field, got: useMandate(w) }).toEqual({ field, got: { error: "mandate parent mismatch", status: 401 } });
    }
  });

  test("a mandate whose parent is itself a mandate is refused (no chain)", () => {
    const w = inboxWorld();
    w.tokens["m-lead"]!.parent_token_id = "m-author";
    expect(useMandate(w)).toEqual({ error: "mandate parent mismatch", status: 401 });
  });

  test("a mandate with no parent is refused", () => {
    const w = inboxWorld();
    w.tokens["m-lead"]!.parent_token_id = null;
    expect(useMandate(w)).toEqual({ error: "mandate parent not found", status: 401 });
  });
});

describe("verifyInboxAction: object first, then actor", () => {
  test("a lead and a supervisor mandate yield an actor without any author proof", () => {
    const w = inboxWorld();
    for (const mandate of ["lead", "supervisor"] as const) {
      expect({ mandate, refused: isAuthError(w.verify({ mandate })) }).toEqual({ mandate, refused: false });
    }
  });

  test("the scope and the authority come from the stored mandate, never from the body", () => {
    const w = inboxWorld();
    const lead = w.actor({ mandate: "lead" });
    expect(authorizeInboxEntry(lead, w.entry({ author_instance_ref: null }))).toBe(true);
    // A body that declares a bigger role or another run changes nothing: it is signed over, and ignored.
    const forged = w.sign(
      { inbox_operation: "close", entry_id: "e1", reason: "x", authority: "supervisor", run_ref: "other", group_id: "group-b" },
      w.creds.author,
      "m-author",
      INBOX_GATES.mandateClose
    );
    const got = w.auth.verifyInboxAction(forged as never, "inbox-close");
    expect(isAuthError(got)).toBe(false);
    if (isAuthError(got)) return;
    expect(authorizeInboxEntry(got, w.entry())).toBe(false);
  });

  test("an elevated mandate acts on its own run only, along every scope dimension", () => {
    const w = inboxWorld();
    const lead = w.actor({ mandate: "lead" });
    expect(authorizeInboxEntry(lead, w.entry())).toBe(true);
    for (const over of [
      { operator_id: "someone-else" },
      { run_ref: "22222222-2222-4222-8222-222222222222" },
      { group_id: "group-b" },
      { project_key: "github.com/other/repo" },
      { run_ref: null },
      { group_id: null },
    ] as Array<Partial<InboxEntryProvenance>>) {
      expect({ over, ok: authorizeInboxEntry(lead, w.entry(over)) }).toEqual({ over, ok: false });
    }
  });

  test("an author mandate without its own proof acts on nothing", () => {
    const w = inboxWorld();
    const author = w.actor({ mandate: "author" });
    expect(authorizeInboxEntry(author, w.entry())).toBe(false);
    expect(authorizeInboxEntry(author, w.entry({ author_instance_ref: null }))).toBe(false);
  });

  test("an author acts on the entries of the instance it proved and on no other", () => {
    const w = inboxWorld();
    const author = w.actor({ mandate: "author", instance: INSTANCE_A });
    expect(authorizeInboxEntry(author, w.entry({ author_instance_ref: deriveInstanceRef(INSTANCE_A) }))).toBe(true);
    expect(authorizeInboxEntry(author, w.entry({ author_instance_ref: deriveInstanceRef(INSTANCE_B) }))).toBe(false);
    expect(authorizeInboxEntry(author, w.entry({ author_instance_ref: null }))).toBe(false);
    expect(authorizeInboxEntry(author, w.entry({ run_ref: "22222222-2222-4222-8222-222222222222" }))).toBe(false);
  });

  test("a lead may act on an entry that carries no author proof", () => {
    const w = inboxWorld();
    expect(authorizeInboxEntry(w.actor({ mandate: "lead", instance: INSTANCE_A }), w.entry({ author_instance_ref: null }))).toBe(true);
  });

  test("a copied or hand-built actor is refused", () => {
    const w = inboxWorld();
    const real = w.actor({ mandate: "lead" });
    expect(authorizeInboxEntry({ ...real } as InboxActor, w.entry())).toBe(false);
    expect(authorizeInboxEntry(Object.assign({}, real), w.entry())).toBe(false);
    expect(authorizeInboxEntry({} as InboxActor, w.entry())).toBe(false);
  });

  test("two actors are two objects, one scope cannot answer for another", () => {
    const w = inboxWorld();
    const a = w.actor({ mandate: "author", instance: INSTANCE_A });
    const b = w.actor({ mandate: "author", instance: INSTANCE_B });
    expect(a).not.toBe(b);
    expect(authorizeInboxEntry(a, w.entry({ author_instance_ref: deriveInstanceRef(INSTANCE_B) }))).toBe(false);
    expect(authorizeInboxEntry(b, w.entry({ author_instance_ref: deriveInstanceRef(INSTANCE_B) }))).toBe(true);
  });
});

describe("verifyInboxAction: the author proof inside the envelope", () => {
  test("an invalid author proof is refused even in front of an elevated mandate", () => {
    const w = inboxWorld();
    const env = w.envelope({ mandate: "lead", instance: INSTANCE_A }) as { author: { auth: { sig: string } } };
    env.author.auth.sig = env.author.auth.sig.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    // The mandate envelope signed the author member too, so tampering it breaks the outer proof first.
    expect(isAuthError(w.auth.verifyInboxAction(env as never, "inbox-close"))).toBe(true);
    const badInner = w.envelope({ mandate: "lead", instance: INSTANCE_A, authorCred: generateCredential() });
    expect(w.auth.verifyInboxAction(badInner as never, "inbox-close")).toEqual({ error: "bad-signature", status: 401 });
  });

  test("an author root that is not the mandate's parent is refused", () => {
    const w = inboxWorld();
    const otherRoot = generateCredential();
    w.tokens["other-root"] = { ...w.tokens["root"]!, public_key: otherRoot.publicKey };
    const got = w.verify({ mandate: "lead", instance: INSTANCE_A, authorCred: otherRoot, authorTokenId: "other-root" });
    expect(got).toEqual({ error: "author proof root is not the mandate's parent", status: 403 });
  });

  test("an author proof signed by a mandate, not a run root, is refused", () => {
    const w = inboxWorld();
    const got = w.verify({ mandate: "lead", instance: INSTANCE_A, authorCred: w.creds.lead, authorTokenId: "m-lead" });
    expect(got).toEqual({ error: "credential may not inbox-author-proof", status: 403 });
  });

  test("the author payload must repeat the envelope's entry, reason and operation", () => {
    const w = inboxWorld();
    for (const over of [{ entry_id: "e2" }, { reason: "another reason" }, { inbox_operation: "list" }]) {
      const got = w.verify({ mandate: "lead", instance: INSTANCE_A, authorPayloadOver: over });
      expect({ over, got }).toEqual({ over, got: { error: "author proof does not match the envelope", status: 403 } });
    }
  });

  test("an author proof signed for the list gate cannot close", () => {
    const w = inboxWorld();
    const got = w.verify({ mandate: "lead", instance: INSTANCE_A, authorGate: INBOX_GATES.authorList });
    expect(got).toEqual({ error: "bad-signature", status: 401 });
  });

  test("an instance that is not bound, or bound to another run, is refused", () => {
    const w = inboxWorld();
    expect(w.verify({ mandate: "lead", instance: "instance-never-registered" })).toEqual({
      error: "author instance is not bound to this run",
      status: 403,
    });
    for (const [field, value] of [
      ["run_ref", "22222222-2222-4222-8222-222222222222"],
      ["group_id", "group-b"],
      ["project_key", "github.com/other/repo"],
      ["operator_id", "someone-else"],
    ] as const) {
      const other = inboxWorld();
      other.bindings[deriveInstanceRef(INSTANCE_A)]![field] = value;
      expect({ field, got: other.verify({ mandate: "lead", instance: INSTANCE_A }) }).toEqual({
        field,
        got: { error: "author instance is not bound to this run", status: 403 },
      });
    }
  });

  test("without any binding source an author proof is refused", () => {
    const w = inboxWorld();
    const { deps } = fakeDb({ operators: { [w.op.id]: w.op.cred.publicKey }, tokens: w.tokens });
    const bare = createApprovalAuth({ ...deps, resolveInstanceBinding: undefined });
    expect(bare.verifyInboxAction(w.envelope({ mandate: "lead", instance: INSTANCE_A }) as never, "inbox-close")).toEqual({
      error: "author instance is not bound to this run",
      status: 403,
    });
  });

  test("the outer proof covers the author member", () => {
    const w = inboxWorld();
    const env = w.envelope({ mandate: "lead", instance: INSTANCE_A }) as { author: { payload: { instance_token: string } } };
    env.author.payload.instance_token = INSTANCE_B;
    expect(w.auth.verifyInboxAction(env as never, "inbox-close")).toEqual({ error: "bad-signature", status: 401 });
  });

  test("a run root cannot close, and a mandate envelope is single use", () => {
    const w = inboxWorld();
    const asRoot = w.sign({ inbox_operation: "close", entry_id: "e1" }, w.rootCred, "root", INBOX_GATES.mandateClose);
    expect(w.auth.verifyInboxAction(asRoot as never, "inbox-close")).toEqual({ error: "credential may not inbox-close", status: 403 });
    const env = w.envelope({ mandate: "lead" });
    expect(isAuthError(w.auth.verifyInboxAction(env as never, "inbox-close"))).toBe(false);
    expect(w.auth.verifyInboxAction(env as never, "inbox-close")).toEqual({ error: "replayed-proof", status: 401 });
  });

  test("the operation of the envelope must match the route, and an unknown authority is refused", () => {
    const w = inboxWorld();
    expect(w.verify({ mandate: "lead", operation: "list", mandateGate: INBOX_GATES.mandateClose })).toEqual({
      error: "inbox_operation does not match the route",
      status: 400,
    });
    w.tokens["m-lead"]!.authority = "owner";
    expect(w.verify({ mandate: "lead" })).toEqual({ error: "mandate authority is unknown", status: 403 });
  });

  test("a revoked run root ends its mandates at use", () => {
    const w = inboxWorld();
    w.tokens["root"]!.revoked_at = new Date().toISOString();
    expect(w.verify({ mandate: "lead" })).toEqual({ error: "mandate parent revoked", status: 401 });
  });
});
