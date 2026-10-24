// ApprovalScope is not compiler-enforced (plain object spreads/casts compile);
// the real guarantee is a WeakMap keyed on object identity, so a scope obtained
// any other way throws in approvalWhere at runtime.
// No handler that touches pending_approvals ever holds a bare operator_id --
// only authorizeTarget/authorizeQuery/authorizeCreate's scopes can address that
// table.
// Does not close: raw SQL against pending_approvals written outside this
// module, or any future neighbouring table such as approval notes or history.

import {
  deriveInstanceRef,
  INBOX_GATES,
  INBOX_OPERATIONS,
  isOperationAllowed,
  isPurposeOperationAllowed,
  parseTokenPurpose,
  verifyAuthProof,
  verifyInboxProof,
  type ApprovalOperation,
  type ApprovalTokenPurpose,
  type InboxGate,
} from "./approval.ts";
import type { ApprovalAuthProof } from "./types.ts";

/** Uniform refusal shape, identical to what the broker's routes already return. */
export interface AuthError {
  error: string;
  status: number;
}

export type AuthResult<T> = T | AuthError;

export function isAuthError(v: unknown): v is AuthError {
  return typeof v === "object" && v !== null && "error" in v;
}

/**
 * The raw result of authentication: WHO is calling, nothing more.
 *
 * Deliberately a plain, readable object: the six non-approval call sites need
 * `operator_id` as a business key. What makes the design work is not that this
 * is hidden, it is that it is USELESS against `pending_approvals` -- there is no
 * function here that turns one into a scope.
 */
export interface ApprovalIdentity {
  readonly operator_id: string;
  readonly kind: "operator" | "session";
  /** Set for a session credential: the ONLY session_ref it may act on. */
  readonly session_ref: string | null;
  /** Set for a session credential: the project its Deck window minted it for. */
  readonly project_key: string | null;
  readonly token_id: string | null;
  /** Set for a session credential: read from the stored row, never from the body. */
  readonly purpose: ApprovalTokenPurpose | null;
  readonly inbox: InboxTokenScope | null;
}

export interface InboxTokenScope {
  readonly run_ref: string;
  readonly group_id: string;
  readonly parent_token_id: string | null;
  readonly authority: string | null;
  readonly caller_ref: string | null;
}

declare const SCOPE_BRAND: unique symbol;
declare const STAMP_BRAND: unique symbol;

/**
 * An authorization to act on `pending_approvals`, already narrowed to every
 * dimension in force. OPAQUE: a handler can hold one and pass it back, and can
 * do nothing else with it. Adding a fourth dimension tomorrow
 * (`deck_session_id`) changes this file and nothing else, because no other site
 * holds the pieces -- so no other site can forget one.
 */
export interface ApprovalScope {
  readonly [SCOPE_BRAND]: "pending_approvals";
}

/**
 * The credential-derived columns of a NEW approval. Opaque for the same reason:
 * `handleApprovalAdd` must be unable to read `project_key` and then decide to
 * use the body's value instead, which is precisely the defect being closed.
 */
export interface OriginStamp {
  readonly [STAMP_BRAND]: "pending_approvals";
}

interface ScopeFields {
  operator_id: string;
  /**
   * Always a string, never null or absent. The empty string is an ordinary
   * value, not a wildcard -- rows predating project scoping carry '' and are
   * migrated to `abandoned` explicitly rather than left silently unreachable.
   */
  project_key: string;
  /** Non-null only for a session credential, which may act on its own tile. */
  session_ref: string | null;
}

// Module-private, and THIS is the enforcement -- not the brand on the type.
// Nothing outside this file can reach a scope's contents or add an entry, so a
// forged or copied object simply has no entry: `approvalWhere` throws on it
// rather than composing a shorter clause. Keyed on OBJECT IDENTITY, which is
// what makes `{...real}` and `Object.assign({}, real)` fail even though they
// carry every visible property and compile without complaint.
const scopeFields = new WeakMap<object, ScopeFields>();
const stampFields = new WeakMap<object, ScopeFields>();

function mintScope(f: ScopeFields): ApprovalScope {
  // A FRESH object per mint, and the freshness is load-bearing rather than
  // incidental: the field store is keyed on OBJECT IDENTITY, so returning a
  // shared instance would alias every scope in the process and let the last
  // mint answer for all of them. Review measured that exact mutation leaving
  // the pure suite, the broker suite and the reply suite entirely green; the
  // guard is now the "two scopes are two OBJECTS" test.
  const s = Object.freeze({}) as ApprovalScope;
  scopeFields.set(s, f);
  return s;
}

function mintStamp(f: ScopeFields): OriginStamp {
  const s = Object.freeze({}) as OriginStamp;
  stampFields.set(s, f);
  return s;
}

/**
 * THE SINGLE PRODUCER of the caller-scoped identity clause on
 * `pending_approvals`.
 *
 * NO OPTIONAL PARAMETER, EVER (docs/DESIGN-APPROVAL-SCOPE.md D2, classed Fatal). An
 * optional dimension would let a caller omit it and receive a SHORTER clause
 * with no error -- fail-open and silent. A new dimension is added INSIDE this
 * function and applies to every caller at once.
 */
export function approvalWhere(scope: ApprovalScope): { sql: string; params: unknown[] } {
  const f = scopeFields.get(scope);
  // Unreachable through the public surface: a scope can only come from a mint
  // in this file. Kept as a throw rather than a silent empty clause, because an
  // empty clause is the fail-OPEN direction and would be invisible.
  if (!f) throw new Error("approvalWhere: not a scope minted by this module");
  const sql = ["operator_id = ?", "project_key = ?"];
  const params: unknown[] = [f.operator_id, f.project_key];
  if (f.session_ref !== null) {
    sql.push("session_ref = ?");
    params.push(f.session_ref);
  }
  return { sql: sql.join(" AND "), params };
}

/**
 * THE SINGLE PRODUCER of the tile identity clause: operator_id AND
 * project_key only, deliberately WITHOUT session_ref, so a hook's SESSION
 * credential and the Deck fallback's OPERATOR credential see the SAME rows of
 * a tile whichever posts first. Its callers, all in /approval/add
 * (handleApprovalAdd): the de-duplication SELECT a question merges through;
 * the closing UPDATE that marks a tile's older permissions 'abandoned' when a
 * new one is raised, the one call that WRITES to rows another credential
 * created; the UPDATE that marks the tile's questions as having absorbed
 * a permission; and the UPDATE that marks the reused pending question as
 * tile-only, which writes to such a row too. Not an optional parameter on
 * approvalWhere (D2, classed Fatal, just above) -- a second NAMED mint so its
 * callers stay greppable instead of a flag any caller could flip.
 */
export function approvalTileWhere(scope: ApprovalScope): { sql: string; params: unknown[] } {
  const f = scopeFields.get(scope);
  if (!f) throw new Error("approvalTileWhere: not a scope minted by this module");
  return { sql: "operator_id = ? AND project_key = ?", params: [f.operator_id, f.project_key] };
}

/**
 * The credential-derived columns of an INSERT, as columns and values the caller
 * splices into its own statement without ever seeing them.
 */
export function stampInsert(stamp: OriginStamp): { columns: string[]; values: string[] } {
  const f = stampFields.get(stamp);
  if (!f) throw new Error("stampInsert: not a stamp minted by this module");
  return {
    columns: ["operator_id", "project_key", "session_ref"],
    values: [f.operator_id, f.project_key, f.session_ref ?? ""],
  };
}

/** Everything this module needs from the broker, so it imports no database. */
export interface ApprovalAuthDeps {
  queryOne<T>(sql: string, params: unknown[]): T | null;
  queryAll<T>(sql: string, params: unknown[]): T[];
  run(sql: string, params: unknown[]): void;
  resolveTrustedOperator(operatorId: string): AuthResult<string>;
  onTrustRefused?: (refusal: AuthError) => void;
  /** The broker owns the bounded replay cache; skew alone would not stop one. */
  rememberNonce(nonce: string, nowSec: number): boolean;
  /**
   * Resolves an author instance by the DIGEST of its token (never the token
   * itself) to the run it was bound to. Absent = no binding is knowable, so an
   * author proof is refused.
   */
  resolveInstanceBinding?(instanceRef: string): InboxInstanceBinding | null;
}

export interface InboxInstanceBinding {
  operator_id: string;
  run_ref: string;
  group_id: string;
  project_key: string;
}

type Body = { auth?: ApprovalAuthProof } & Record<string, unknown>;

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

// A total mapping prevents a new proof gate from accepting an operation by omission.
const GATE_OPERATIONS = {
  [INBOX_GATES.register]: ["inbox-register"],
  [INBOX_GATES.deposit]: ["inbox-deposit"],
  [INBOX_GATES.channel]: ["inbox-deposit"],
  [INBOX_GATES.mint]: ["mint-token"],
  [INBOX_GATES.authorList]: ["inbox-author-proof"],
  [INBOX_GATES.authorClose]: ["inbox-author-proof"],
  [INBOX_GATES.mandateList]: ["inbox-list"],
  [INBOX_GATES.mandateClose]: ["inbox-close"],
} as const satisfies Record<InboxGate, readonly ApprovalOperation[]>;

const INBOX_OPERATION_SET: ReadonlySet<ApprovalOperation> = new Set<ApprovalOperation>(INBOX_OPERATIONS);

declare const ACTOR_BRAND: unique symbol;

/**
 * A verified Inbox actor, opaque for the same reason as ApprovalScope: only
 * verifyInboxAction can mint one, so a copied or hand-built object has no
 * entry in the module-private store and is refused by authorizeInboxEntry.
 */
export interface InboxActor {
  readonly [ACTOR_BRAND]: "inbox";
}

interface ActorFields {
  operator_id: string;
  run_ref: string;
  group_id: string;
  project_key: string;
  authority: "author" | "lead" | "supervisor";
  authorInstanceRef: string | null;
}

const actorFields = new WeakMap<object, ActorFields>();

function mintActor(f: ActorFields): InboxActor {
  const a = Object.freeze({}) as InboxActor;
  actorFields.set(a, f);
  return a;
}

/** The provenance stamped on an entry at deposit; a NULL member never matches. */
export interface InboxEntryProvenance {
  operator_id: string | null;
  run_ref: string | null;
  group_id: string | null;
  project_key: string | null;
  author_instance_ref: string | null;
}

/**
 * Object first, then actor: the entry's own scope must equal the actor's
 * verified scope, and only then does the actor's authority count. An elevated
 * mandate acts inside its run; an author acts only on entries stamped with the
 * digest of the instance it proved. An entry without an author digest can
 * never satisfy the author branch.
 */
export function authorizeInboxEntry(actor: InboxActor, entry: InboxEntryProvenance): boolean {
  const a = actorFields.get(actor);
  if (!a) return false;
  const sameScope =
    entry.operator_id === a.operator_id &&
    entry.run_ref === a.run_ref &&
    entry.group_id === a.group_id &&
    entry.project_key === a.project_key;
  if (!sameScope) return false;
  if (a.authority === "lead" || a.authority === "supervisor") return true;
  return (
    a.authorInstanceRef !== null &&
    entry.author_instance_ref !== null &&
    a.authorInstanceRef === entry.author_instance_ref
  );
}

export type InboxActionOperation = "inbox-list" | "inbox-close";

export interface ApprovalAuth {
  authenticateOperator(body: Body, op: ApprovalOperation): AuthResult<ApprovalIdentity>;
  /** Same checks as authenticateOperator, but the proof must be a v1 proof for exactly `gate`. */
  authenticateInbox(body: Body, op: ApprovalOperation, gate: InboxGate): AuthResult<ApprovalIdentity>;
  /**
   * Verifies a mandate envelope and, when present, the author's own proof
   * carried inside it. Returns an actor for authorizeInboxEntry; it exposes no
   * route and mutates nothing.
   */
  verifyInboxAction(body: Body, op: InboxActionOperation): AuthResult<InboxActor>;
  authorizeTarget<R>(
    body: Body,
    op: ApprovalOperation,
    ids: string[]
  ): AuthResult<{ scope: ApprovalScope; rows: R[] }>;
  authorizeQuery(body: Body, op: ApprovalOperation): AuthResult<{ scope: ApprovalScope }>;
  authorizeCreate(body: Body): AuthResult<{ scope: ApprovalScope; stamp: OriginStamp }>;
  scopeForAnsweredRow<R extends { operator_id: string; project_key: string }>(
    approvalId: string
  ): { scope: ApprovalScope; row: R } | null;
}

export function createApprovalAuth(deps: ApprovalAuthDeps): ApprovalAuth {
  /**
   * Signature, nonce and operation table. This is the ONLY place a credential
   * is verified, so the six non-approval sites inherit the replay guard and the
   * operation table by construction rather than by re-typing a rule.
   */
  function authenticateOperator(body: Body, op: ApprovalOperation): AuthResult<ApprovalIdentity> {
    return authenticate(body, op, undefined);
  }

  function authenticateInbox(body: Body, op: ApprovalOperation, gate: InboxGate): AuthResult<ApprovalIdentity> {
    return authenticate(body, op, gate);
  }

  const TOKEN_COLUMNS = `public_key, operator_id, session_ref, project_key, revoked_at, expires_at,
           inbox_purpose, run_ref, group_id, parent_token_id, authority, caller_ref`;

  /** A mandate is only as live as its run parent: revoked, expired or foreign parent = unusable. */
  function mandateParentRefusal(row: TokenRow): AuthError | null {
    const parent = row.parent_token_id
      ? deps.queryOne<TokenRow>(
          `SELECT ${TOKEN_COLUMNS} FROM approval_session_tokens WHERE token_id = ?`,
          [row.parent_token_id]
        )
      : null;
    if (!parent) return { error: "mandate parent not found", status: 401 };
    if (parent.revoked_at) return { error: "mandate parent revoked", status: 401 };
    if (new Date(parent.expires_at).getTime() < Date.now()) return { error: "mandate parent expired", status: 401 };
    if (
      parseTokenPurpose(parent.inbox_purpose) !== "run" ||
      parent.operator_id !== row.operator_id ||
      parent.run_ref !== row.run_ref ||
      parent.group_id !== row.group_id ||
      parent.project_key !== row.project_key
    ) {
      return { error: "mandate parent mismatch", status: 401 };
    }
    return null;
  }

  function authenticate(body: Body, op: ApprovalOperation, gate: InboxGate | undefined): AuthResult<ApprovalIdentity> {
    // The proof format is decided by the OPERATION, not by whether a caller
    // happened to pass a gate: an Inbox operation has no legacy form, so a
    // legacy proof can never carry one, and a gate carries only its own
    // operations.
    if (gate === undefined && INBOX_OPERATION_SET.has(op)) {
      return { error: `${op} requires a v1 proof`, status: 403 };
    }
    if (
      gate !== undefined &&
      (!Object.hasOwn(GATE_OPERATIONS, gate) || !(GATE_OPERATIONS[gate] as readonly ApprovalOperation[]).includes(op))
    ) {
      return { error: `${op} is not carried by this gate`, status: 403 };
    }
    const proof = body.auth;
    if (!proof || typeof proof !== "object") return { error: "auth proof required", status: 401 };
    if (proof.kind !== "operator" && proof.kind !== "session") {
      return { error: "unknown credential kind", status: 401 };
    }
    if (!isOperationAllowed(proof.kind, op)) {
      // The sandbox guard: a session credential asking to claim lands here.
      return { error: `credential may not ${op}`, status: 403 };
    }

    const publicKey = typeof body.public_key === "string" ? body.public_key : "";
    const { auth: _auth, ...payload } = body;
    const nowSec = Math.floor(Date.now() / 1000);

    let knownKey: string | null = null;
    let sessionRef: string | null = null;
    let tokenProjectKey: string | null = null;
    let tokenRow: TokenRow | null = null;

    if (proof.kind === "operator") {
      const trusted = deps.resolveTrustedOperator(proof.operator_id);
      if (isAuthError(trusted)) return trusted;
      if (publicKey && publicKey !== trusted) return { error: "operator-key-mismatch", status: 403 };
      knownKey = trusted;
    } else {
      if (!proof.token_id) return { error: "token_id required", status: 401 };
      const row = deps.queryOne<TokenRow>(
        `SELECT ${TOKEN_COLUMNS}
           FROM approval_session_tokens WHERE token_id = ?`,
        [proof.token_id]
      );
      if (!row) return { error: "unknown session token", status: 401 };
      if (row.revoked_at) return { error: "session token revoked", status: 401 };
      if (new Date(row.expires_at).getTime() < Date.now()) {
        return { error: "session token expired", status: 401 };
      }
      if (row.operator_id !== proof.operator_id) return { error: "token/operator mismatch", status: 401 };
      const trusted = deps.resolveTrustedOperator(row.operator_id);
      if (isAuthError(trusted)) return trusted;
      if (parseTokenPurpose(row.inbox_purpose) === "mandate") {
        const refusal = mandateParentRefusal(row);
        if (refusal) return refusal;
      }
      knownKey = row.public_key;
      sessionRef = row.session_ref;
      tokenRow = row;
      // Kept as '' rather than normalized to null: a token minted without
      // project scoping carries '' here, and the refusal that names the cause
      // lives at the point of use, not here.
      // The two values mean different things downstream.
      tokenProjectKey = typeof row.project_key === "string" ? row.project_key : "";
    }

    const verdict = gate === undefined
      ? verifyAuthProof(knownKey, payload, proof)
      : verifyInboxProof(knownKey, payload, proof, gate);
    if (!verdict.ok) return { error: verdict.reason, status: 401 };
    if (!deps.rememberNonce(proof.nonce, nowSec)) return { error: "replayed-proof", status: 401 };

    // Second authority, behind the kind check above and after the signature so
    // an unauthenticated caller learns nothing about a token's purpose. It is
    // the purpose STORED for this token_id that decides, never one the body claims.
    let purpose: ApprovalTokenPurpose | null = null;
    let inbox: InboxTokenScope | null = null;
    if (tokenRow) {
      purpose = parseTokenPurpose(tokenRow.inbox_purpose);
      if (purpose === null) return { error: "unknown token purpose", status: 403 };
      if (!isPurposeOperationAllowed(purpose, op)) return { error: `credential may not ${op}`, status: 403 };
      if (purpose !== "legacy") {
        if (!tokenRow.run_ref || !tokenRow.group_id) return { error: "inbox token scope is incomplete", status: 401 };
        inbox = {
          run_ref: tokenRow.run_ref,
          group_id: tokenRow.group_id,
          parent_token_id: tokenRow.parent_token_id ?? null,
          authority: tokenRow.authority ?? null,
          caller_ref: tokenRow.caller_ref ?? null,
        };
      }
    }

    if (proof.kind === "operator") {
      const at = new Date().toISOString();
      deps.run(
        `INSERT INTO approval_operators (operator_id, public_key, label, created_at, last_seen_at)
         VALUES (?, ?, '', ?, ?)
         ON CONFLICT(operator_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
        [proof.operator_id, knownKey, at, at]
      );
    }
    return {
      operator_id: proof.operator_id,
      kind: proof.kind,
      session_ref: sessionRef,
      project_key: tokenProjectKey,
      token_id: tokenRow ? (proof.token_id ?? null) : null,
      purpose,
      inbox,
    };
  }

  /**
   * The envelope is signed by a mandate under its own gate; the optional
   * `author` member is a SECOND proof, signed by the run root under the
   * author gate. Nothing in the body is an authority: the scope and the
   * authority come from the stored mandate, the author digest from a proof
   * whose root must be that mandate's parent and whose payload must repeat
   * the envelope's operation, entry and reason.
   */
  function verifyInboxAction(body: Body, op: InboxActionOperation): AuthResult<InboxActor> {
    const isList = op === "inbox-list";
    const id = authenticate(body, op, isList ? INBOX_GATES.mandateList : INBOX_GATES.mandateClose);
    if (isAuthError(id)) return id;
    if (id.kind !== "session" || id.purpose !== "mandate" || !id.inbox || !id.token_id) {
      return { error: "a mandate is required", status: 403 };
    }
    const authority = id.inbox.authority;
    if (authority !== "author" && authority !== "lead" && authority !== "supervisor") {
      return { error: "mandate authority is unknown", status: 403 };
    }
    if (body.inbox_operation !== (isList ? "list" : "close")) {
      return { error: "inbox_operation does not match the route", status: 400 };
    }
    const projectKey = id.project_key ?? "";

    let authorInstanceRef: string | null = null;
    if (body.author !== undefined) {
      const author = body.author;
      if (
        typeof author !== "object" || author === null ||
        typeof (author as { payload?: unknown }).payload !== "object" ||
        (author as { payload?: unknown }).payload === null ||
        typeof (author as { auth?: unknown }).auth !== "object" ||
        (author as { auth?: unknown }).auth === null
      ) {
        return { error: "author proof is malformed", status: 400 };
      }
      const payload = (author as { payload: Record<string, unknown> }).payload;
      const authorBody: Body = { ...payload, auth: (author as { auth: ApprovalAuthProof }).auth };
      const authorId = authenticate(
        authorBody,
        "inbox-author-proof",
        isList ? INBOX_GATES.authorList : INBOX_GATES.authorClose
      );
      if (isAuthError(authorId)) return authorId;
      if (
        authorId.kind !== "session" ||
        authorId.token_id !== id.inbox.parent_token_id ||
        authorId.operator_id !== id.operator_id
      ) {
        return { error: "author proof root is not the mandate's parent", status: 403 };
      }
      if (
        payload.inbox_operation !== body.inbox_operation ||
        (payload.entry_id ?? null) !== (body.entry_id ?? null) ||
        (payload.reason ?? null) !== (body.reason ?? null)
      ) {
        return { error: "author proof does not match the envelope", status: 403 };
      }
      const token = payload.instance_token;
      if (typeof token !== "string" || token.length === 0) {
        return { error: "author proof carries no instance", status: 400 };
      }
      const ref = deriveInstanceRef(token);
      const binding = deps.resolveInstanceBinding?.(ref) ?? null;
      if (
        !binding ||
        binding.operator_id !== id.operator_id ||
        binding.run_ref !== id.inbox.run_ref ||
        binding.group_id !== id.inbox.group_id ||
        binding.project_key !== projectKey
      ) {
        return { error: "author instance is not bound to this run", status: 403 };
      }
      authorInstanceRef = ref;
    }

    return mintActor({
      operator_id: id.operator_id,
      run_ref: id.inbox.run_ref,
      group_id: id.inbox.group_id,
      project_key: projectKey,
      authority,
      authorInstanceRef,
    });
  }

  /**
   * Where a scope's project_key comes from differs by credential.
   * Session credential: always from the token, never the body -- a sandboxed
   * agent must not choose which project its own question is filed under; a
   * token carrying '' for project_key is refused here, naming the cause.
   * Operator credential: must be declared in the body, since one operator_id
   * can own several projects and without a declaration there is no project
   * dimension to scope on.
   */
  function resolveProjectKey(id: ApprovalIdentity, body: Body): AuthResult<string> {
    if (id.kind === "session") {
      if (!id.project_key) {
        return {
          error: "this session token predates project scoping; restart the session to mint a new one",
          status: 400,
        };
      }
      return id.project_key;
    }
    const declared = typeof body.project_key === "string" ? body.project_key : "";
    if (!declared) return { error: "project_key is required", status: 400 };
    return declared;
  }

  function scopeFor(body: Body, op: ApprovalOperation): AuthResult<{ scope: ApprovalScope; id: ApprovalIdentity }> {
    const id = authenticateOperator(body, op);
    if (isAuthError(id)) return id;
    const pk = resolveProjectKey(id, body);
    if (typeof pk !== "string") return pk;
    return {
      scope: mintScope({ operator_id: id.operator_id, project_key: pk, session_ref: id.session_ref }),
      id,
    };
  }

  return {
    authenticateOperator,
    authenticateInbox,
    verifyInboxAction,

    /**
     * Returns the already-scoped rows directly so callers never have to
     * re-query the table after authorizing.
     * A row outside the caller's scope is indistinguishable from one that never
     * existed -- both simply do not come back, deliberately, since confirming
     * another operator's approval exists would itself be a leak.
     */
    authorizeTarget<R>(body: Body, op: ApprovalOperation, ids: string[]): AuthResult<{ scope: ApprovalScope; rows: R[] }> {
      const got = scopeFor(body, op);
      if (isAuthError(got)) return got;
      if (ids.length === 0) return { scope: got.scope, rows: [] };
      const where = approvalWhere(got.scope);
      const placeholders = ids.map(() => "?").join(",");
      const rows = deps.queryAll<R>(
        `SELECT * FROM pending_approvals WHERE id IN (${placeholders}) AND ${where.sql}`,
        [...ids, ...where.params]
      );
      return { scope: got.scope, rows };
    },

    authorizeQuery(body: Body, op: ApprovalOperation): AuthResult<{ scope: ApprovalScope }> {
      const got = scopeFor(body, op);
      if (isAuthError(got)) return got;
      return { scope: got.scope };
    },

    authorizeCreate(body: Body): AuthResult<{ scope: ApprovalScope; stamp: OriginStamp }> {
      const got = scopeFor(body, "add");
      if (isAuthError(got)) return got;
      const f = scopeFields.get(got.scope);
      if (!f) throw new Error("authorizeCreate: scope lost its fields");
      return { scope: got.scope, stamp: mintStamp({ ...f }) };
    },

    /**
     * The one scope not derived from a credential: an answer arriving on a
     * notification gateway is authenticated by channel pairing, not a
     * signature.
     * Reads the row itself rather than taking it as an argument, so provenance
     * is guaranteed by construction rather than a comment a caller could
     * ignore; also returns the row so the pairing check runs against the same
     * read.
     * session_ref is deliberately absent: the operator answers from their
     * phone, and pinning the tile's session would refuse the case this exists
     * for.
     */
    scopeForAnsweredRow<R extends { operator_id: string; project_key: string }>(
      approvalId: string
    ): { scope: ApprovalScope; row: R } | null {
      const row = deps.queryOne<R>("SELECT * FROM pending_approvals WHERE id = ?", [approvalId]);
      if (!row) return null;
      const trust = deps.resolveTrustedOperator(row.operator_id);
      if (isAuthError(trust)) {
        deps.onTrustRefused?.(trust);
        return null;
      }
      return {
        scope: mintScope({
          operator_id: row.operator_id,
          project_key: typeof row.project_key === "string" ? row.project_key : "",
          session_ref: null,
        }),
        row,
      };
    },
  };
}

/**
 * A session credential is pinned to its own session_ref and can neither
 * impersonate another tile nor emit anonymously; an operator credential pins
 * nothing here since it has no session.
 * declared must be the value after validateApprovalDraft normalised it --
 * comparing against the raw body would refuse a caller whose only sin was a
 * trailing space.
 */
export function assertStampSessionRef(stamp: OriginStamp, declared: string): AuthError | null {
  const f = stampFields.get(stamp);
  if (!f) throw new Error("assertStampSessionRef: not a stamp minted by this module");
  if (f.session_ref === null) return null;
  if (declared && declared !== f.session_ref) {
    return { error: "session_ref does not match credential", status: 403 };
  }
  return null;
}
