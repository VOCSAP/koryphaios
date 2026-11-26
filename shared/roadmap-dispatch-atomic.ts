import { createHash } from "node:crypto";
import { composeAtomicDispatchText, type DispatchCardView } from "./roadmap-dispatch-message";
import { projectKeyCaseRefusal, validateProjectKey } from "./project-key";
import type {
  AtomicDispatchCapability,
  AtomicDispatchCard,
  AtomicDispatchDelivery,
  AtomicDispatchError,
  AtomicDispatchErrorCode,
  AtomicDispatchIntent,
  AtomicDispatchMember,
  AtomicDispatchOutcome,
  AtomicDispatchRefusal,
  RoadmapKind,
  RoadmapStatus,
} from "./types";

export const ATOMIC_DISPATCH_MAX_MEMBERS = 50;
export const ATOMIC_DISPATCH_MAX_OPERATION_MS = 10 * 60 * 1000;
export const ATOMIC_DISPATCH_REGISTRY_CAPACITY = 2000;

export function atomicDispatchCapability(brokerId: string): AtomicDispatchCapability {
  return {
    version: 1,
    broker_id: brokerId,
    max_operation_ms: ATOMIC_DISPATCH_MAX_OPERATION_MS,
    max_members: ATOMIC_DISPATCH_MAX_MEMBERS,
    registry_capacity: ATOMIC_DISPATCH_REGISTRY_CAPACITY,
  };
}

// rev, updated_at and sync_* are left out on purpose: the pull echo rewrites them with unchanged values.
export interface DispatchStateColumns {
  id: string;
  project_key: string;
  queue: number | null;
  lot_id: string | null;
  locked: number | boolean;
  locked_by: string | null;
  locked_group: string | null;
  locked_by_token: string | null;
  locked_at: string | null;
  lock_parked_by: string | null;
  lock_parked_at: string | null;
  lock_scope: string | null;
  lock_relay: string | null;
  lock_contested_by: string | null;
  lock_release_owner: string | null;
  sync_state: string;
}

/**
 * SHA-256 of the canonical state, so the lock owner's private token is
 * committed to without being returned. Not an authorization: a copied tag
 * never replaces the operator proof.
 */
export function dispatchStateTag(row: DispatchStateColumns, brokerId: string): string {
  const canonical = JSON.stringify([
    "dispatch-state-v2",
    brokerId,
    row.id,
    row.project_key,
    row.queue ?? null,
    row.lot_id ?? null,
    row.locked ? 1 : 0,
    row.locked_by ?? null,
    row.locked_group ?? null,
    row.locked_by_token ?? null,
    row.locked_at ?? null,
    row.lock_parked_by ?? null,
    row.lock_parked_at ?? null,
    row.lock_scope ?? null,
    row.lock_relay ?? null,
    row.lock_contested_by ?? null,
    row.lock_release_owner ?? null,
    row.sync_state,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

const OPERATION_ID = /^(\d{1,16}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const BROKER_ID = /^[A-Za-z0-9-]{8,64}$/;
const STATE_TAG = /^[0-9a-f]{64}$/;
const CARD_ID = /^[A-Za-z0-9-]{8,64}$/;
const GROUP_ID_MAX = 256;

export function parseOperationId(operationId: string): { deadlineMs: number } | null {
  const match = OPERATION_ID.exec(operationId);
  if (!match) return null;
  const deadlineMs = Number(match[1]);
  return Number.isSafeInteger(deadlineMs) ? { deadlineMs } : null;
}

/**
 * Hash of the business content only: neither the operation id (it is the
 * registry key), nor the action, nor any credential or nonce.
 */
export function atomicDispatchDigest(intent: AtomicDispatchIntent): string {
  const canonical = JSON.stringify([
    "dispatch-intent-v1",
    intent.broker_id,
    intent.project_key,
    intent.group_id,
    intent.mode,
    intent.target_kind,
    intent.to_peer_id,
    intent.members.map((m) => [m.id, m.expected_content_rev, m.expected_dispatch_state_tag]),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

const INTENT_KEYS = [
  "broker_id",
  "operation_id",
  "project_key",
  "group_id",
  "mode",
  "target_kind",
  "to_peer_id",
  "members",
] as const;
const MEMBER_KEYS = ["id", "expected_content_rev", "expected_dispatch_state_tag"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) return `unknown field '${key}'`;
  }
  for (const key of keys) {
    if (!(key in value)) return `missing field '${key}'`;
  }
  return null;
}

/**
 * Closed validation: the intent carries identity and tokens, never a wanted
 * status, rank, text or lock field, so an unknown key is refused rather than
 * ignored. `isPeerId` is the broker's own peer id grammar.
 */
export function validateAtomicDispatchIntent(
  raw: unknown,
  isPeerId: (value: string) => boolean
): { ok: true; intent: AtomicDispatchIntent } | { ok: false; error: string } {
  const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
  if (!isRecord(raw)) return fail("intent must be an object");
  const shape = hasExactKeys(raw, INTENT_KEYS);
  if (shape) return fail(`intent: ${shape}`);
  const { broker_id, operation_id, project_key, group_id, mode, target_kind, to_peer_id, members } = raw;
  if (typeof broker_id !== "string" || !BROKER_ID.test(broker_id)) return fail("broker_id is malformed");
  if (typeof operation_id !== "string" || parseOperationId(operation_id) === null) {
    return fail("operation_id must be <deadline_ms>:<uuid>");
  }
  if (typeof project_key !== "string") return fail("project_key must be a string");
  const keyCheck = validateProjectKey(project_key);
  if (!keyCheck.ok) return fail(`project_key is invalid (${keyCheck.reason})`);
  const caseRefusal = projectKeyCaseRefusal(project_key);
  if (caseRefusal) return fail(caseRefusal);
  if (typeof group_id !== "string" || group_id === "" || group_id.length > GROUP_ID_MAX) {
    return fail("group_id must be a non-empty string");
  }
  if (mode !== "wave" && mode !== "assign") return fail("mode must be wave or assign");
  if (target_kind !== "lead" && target_kind !== "sole-active-fallback" && target_kind !== "assignee") {
    return fail("target_kind is not recognised");
  }
  if (mode === "assign" ? target_kind !== "assignee" : target_kind === "assignee") {
    return fail(`target_kind '${target_kind}' does not match mode '${mode}'`);
  }
  if (typeof to_peer_id !== "string" || !isPeerId(to_peer_id)) return fail("to_peer_id is not a valid peer id");
  if (!Array.isArray(members) || members.length === 0) return fail("members must be a non-empty array");
  if (members.length > ATOMIC_DISPATCH_MAX_MEMBERS) {
    return fail(`members exceeds the maximum of ${ATOMIC_DISPATCH_MAX_MEMBERS}`);
  }
  if (mode === "assign" && members.length !== 1) return fail("assign takes exactly one member");
  const seen = new Set<string>();
  const parsed: AtomicDispatchMember[] = [];
  for (const entry of members) {
    if (!isRecord(entry)) return fail("each member must be an object");
    const memberShape = hasExactKeys(entry, MEMBER_KEYS);
    if (memberShape) return fail(`member: ${memberShape}`);
    const { id, expected_content_rev, expected_dispatch_state_tag } = entry;
    if (typeof id !== "string" || !CARD_ID.test(id)) return fail("member id is malformed");
    if (seen.has(id)) return fail(`member '${id}' is listed twice`);
    seen.add(id);
    if (typeof expected_content_rev !== "number" || !Number.isSafeInteger(expected_content_rev) || expected_content_rev < 0) {
      return fail("expected_content_rev must be a non-negative safe integer");
    }
    if (typeof expected_dispatch_state_tag !== "string" || !STATE_TAG.test(expected_dispatch_state_tag)) {
      return fail("expected_dispatch_state_tag must be a 64-character hex digest");
    }
    parsed.push({ id, expected_content_rev, expected_dispatch_state_tag });
  }
  return {
    ok: true,
    intent: { broker_id, operation_id, project_key, group_id, mode, target_kind, to_peer_id, members: parsed },
  };
}

export interface DispatchDb {
  run(sql: string, params?: unknown[]): unknown;
  query(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
  transaction<A extends unknown[], R>(fn: (...args: A) => R): { (...args: A): R; immediate(...args: A): R };
}

export const DISPATCH_OPERATIONS_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS roadmap_dispatch_operations (
    operator_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    project_key TEXT NOT NULL,
    group_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    target_peer_id TEXT NOT NULL,
    result_json TEXT NOT NULL,
    message_id INTEGER,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (operator_id, operation_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_roadmap_dispatch_operations_expires
     ON roadmap_dispatch_operations(expires_at)`,
];

export interface DispatchOperationRecord {
  operator_id: string;
  operation_id: string;
  request_digest: string;
  project_key: string;
  group_id: string;
  mode: string;
  target_peer_id: string;
  result_json: string;
  message_id: number | null;
  created_at: number;
  expires_at: number;
}

export function readDispatchOperation(
  db: DispatchDb,
  operatorId: string,
  operationId: string
): DispatchOperationRecord | null {
  return db
    .query("SELECT * FROM roadmap_dispatch_operations WHERE operator_id = ? AND operation_id = ?")
    .get(operatorId, operationId) as DispatchOperationRecord | null;
}

export function recordDispatchOperation(db: DispatchDb, record: DispatchOperationRecord): void {
  db.run(
    `INSERT INTO roadmap_dispatch_operations
       (operator_id, operation_id, request_digest, project_key, group_id, mode, target_peer_id,
        result_json, message_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.operator_id,
      record.operation_id,
      record.request_digest,
      record.project_key,
      record.group_id,
      record.mode,
      record.target_peer_id,
      record.result_json,
      record.message_id,
      record.created_at,
      record.expires_at,
    ]
  );
}

export function purgeExpiredDispatchOperations(db: DispatchDb, nowMs: number): void {
  db.run("DELETE FROM roadmap_dispatch_operations WHERE expires_at < ?", [nowMs]);
}

export function countLiveDispatchOperations(db: DispatchDb, nowMs: number): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM roadmap_dispatch_operations WHERE expires_at >= ?")
    .get(nowMs) as { n: number };
  return row.n;
}

export interface AtomicDispatchMemberRow {
  id: string;
  project_key: string;
  kind: RoadmapKind;
  status: RoadmapStatus;
  inactive: boolean;
  deleted_at: string | null;
  queue: number | null;
  content_rev: number;
  state_tag: string;
}

export interface AtomicDispatchPatch {
  queue: null;
  status: RoadmapStatus;
}

export type AtomicDispatchMemberWrite =
  | { ok: true; card: DispatchCardView & { kind: RoadmapKind } }
  | { ok: false; reason: "card-changed" | "ineligible" };

export interface AtomicDispatchDeps {
  db: DispatchDb;
  now: () => number;
  brokerId: string;
  isPeerId: (value: string) => boolean;
  /** The ACTIVE local peer of the group, or null. */
  findTarget: (groupId: string, peerId: string) => { token: string } | null;
  loadMember: (id: string) => AtomicDispatchMemberRow | null;
  /** Ids of the project's head wave in queue order, directives included: a queued directive is a changed queue. */
  headWaveIds: (projectKey: string) => string[];
  /** Writes one card through the roadmap upsert core; a throw rolls the whole operation back. */
  writeMember: (
    member: AtomicDispatchMemberRow,
    patch: AtomicDispatchPatch,
    expectedContentRev: number
  ) => AtomicDispatchMemberWrite;
  insertMessage: (targetToken: string, groupId: string, text: string, sentAt: string) => number;
  /** Runs only after the commit; a failure never changes the recorded outcome. */
  push: (frame: { token: string; messageId: number; text: string; sentAt: string }) => void;
  warn: (message: string, detail?: unknown) => void;
}

export interface AtomicDispatchHttp {
  status: number;
  body: AtomicDispatchDelivery | AtomicDispatchError;
}

class DispatchRefusal extends Error {
  constructor(
    readonly reason: AtomicDispatchRefusal,
    readonly cardIds: string[]
  ) {
    super(`atomic dispatch refused: ${reason}`);
  }
}

function errorResponse(status: number, code: AtomicDispatchErrorCode, error: string): AtomicDispatchHttp {
  return { status, body: { code, error } };
}

function outcomeResponse(outcome: AtomicDispatchOutcome): AtomicDispatchHttp {
  return { status: outcome.delivery === "sent" ? 200 : 409, body: outcome };
}

function isEligible(row: AtomicDispatchMemberRow): boolean {
  return (
    !row.inactive &&
    row.deleted_at === null &&
    row.status !== "done" &&
    row.status !== "archived" &&
    row.kind !== "directive"
  );
}

function sameOrderedIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function patchFor(mode: "wave" | "assign", row: AtomicDispatchMemberRow): AtomicDispatchPatch {
  if (mode === "assign") return { queue: null, status: "in_progress" };
  return { queue: null, status: row.status === "idea" ? "planned" : row.status };
}

function parseStored(deps: AtomicDispatchDeps, stored: DispatchOperationRecord): AtomicDispatchOutcome | null {
  try {
    const value = JSON.parse(stored.result_json) as AtomicDispatchOutcome;
    if (value && (value.delivery === "sent" || value.delivery === "not-sent")) return value;
  } catch (e) {
    deps.warn("atomic dispatch: stored result is not JSON", e);
    return null;
  }
  deps.warn("atomic dispatch: stored result has an unknown delivery");
  return null;
}

/**
 * `body` is the signed request minus its credentials. The operator id is the
 * one the broker verified, never a field of the body.
 */
export function runAtomicDispatch(
  deps: AtomicDispatchDeps,
  operatorId: string,
  body: { action?: unknown; intent?: unknown }
): AtomicDispatchHttp {
  if (body.action !== "execute" && body.action !== "resolve") {
    return errorResponse(400, "dispatch-invalid-request", "action must be execute or resolve");
  }
  const action = body.action;
  const checked = validateAtomicDispatchIntent(body.intent, deps.isPeerId);
  if (!checked.ok) return errorResponse(400, "dispatch-invalid-request", checked.error);
  const intent = checked.intent;
  if (intent.broker_id !== deps.brokerId) {
    return errorResponse(409, "dispatch-broker-mismatch", "this broker is not the one the operation was issued for");
  }
  const deadlineMs = parseOperationId(intent.operation_id)!.deadlineMs;
  const startedAt = deps.now();
  if (deadlineMs > startedAt + ATOMIC_DISPATCH_MAX_OPERATION_MS) {
    return errorResponse(400, "dispatch-invalid-request", "operation deadline is beyond the maximum operation lifetime");
  }

  const digest = atomicDispatchDigest(intent);
  const unknown = (reason: "expired" | "outcome-unavailable"): AtomicDispatchHttp => ({
    status: 200,
    body: { delivery: "unknown", operation_id: intent.operation_id, reason },
  });

  const record = (outcome: AtomicDispatchOutcome, nowMs: number): void => {
    recordDispatchOperation(deps.db, {
      operator_id: operatorId,
      operation_id: intent.operation_id,
      request_digest: digest,
      project_key: intent.project_key,
      group_id: intent.group_id,
      mode: intent.mode,
      target_peer_id: intent.to_peer_id,
      result_json: JSON.stringify(outcome),
      message_id: outcome.delivery === "sent" ? outcome.message_id : null,
      created_at: nowMs,
      expires_at: deadlineMs,
    });
  };
  const notSent = (reason: AtomicDispatchRefusal, cardIds: string[]): AtomicDispatchOutcome => ({
    delivery: "not-sent",
    operation_id: intent.operation_id,
    reason,
    card_ids: cardIds,
  });

  let pushFrame: { token: string; messageId: number; text: string; sentAt: string } | null = null;

  const transact = deps.db.transaction((): AtomicDispatchHttp => {
    const nowMs = deps.now();
    purgeExpiredDispatchOperations(deps.db, nowMs);

    const stored = readDispatchOperation(deps.db, operatorId, intent.operation_id);
    if (stored) {
      if (stored.request_digest !== digest) {
        return errorResponse(409, "dispatch-operation-mismatch", "this operation id was used for a different dispatch");
      }
      const outcome = parseStored(deps, stored);
      return outcome ? outcomeResponse(outcome) : unknown("outcome-unavailable");
    }

    if (nowMs > deadlineMs) {
      return action === "execute"
        ? errorResponse(409, "dispatch-operation-expired", "the operation deadline has passed")
        : unknown("expired");
    }
    if (countLiveDispatchOperations(deps.db, nowMs) >= ATOMIC_DISPATCH_REGISTRY_CAPACITY) {
      return action === "execute"
        ? errorResponse(503, "dispatch-capacity-exceeded", "the operation registry is full")
        : unknown("outcome-unavailable");
    }

    if (action === "resolve") {
      const cancelled = notSent("cancelled-before-execution", []);
      record(cancelled, nowMs);
      return outcomeResponse(cancelled);
    }

    const effects = deps.db.transaction((): AtomicDispatchOutcome => {
      const target = deps.findTarget(intent.group_id, intent.to_peer_id);
      if (!target) throw new DispatchRefusal("no-target", []);

      const rows: AtomicDispatchMemberRow[] = [];
      const unavailable: string[] = [];
      for (const member of intent.members) {
        const row = deps.loadMember(member.id);
        if (!row || row.project_key !== intent.project_key || !isEligible(row)) unavailable.push(member.id);
        else rows.push(row);
      }
      if (unavailable.length > 0) throw new DispatchRefusal("ineligible", unavailable);

      const changed = intent.members
        .filter((member, i) => {
          const row = rows[i]!;
          return (
            row.content_rev !== member.expected_content_rev || row.state_tag !== member.expected_dispatch_state_tag
          );
        })
        .map((member) => member.id);
      if (changed.length > 0) throw new DispatchRefusal("card-changed", changed);

      if (intent.mode === "wave" && !sameOrderedIds(deps.headWaveIds(intent.project_key), intent.members.map((m) => m.id))) {
        throw new DispatchRefusal(
          "queue-changed",
          intent.members.map((m) => m.id)
        );
      }

      const written: (DispatchCardView & { kind: RoadmapKind })[] = [];
      for (const [i, row] of rows.entries()) {
        const result = deps.writeMember(row, patchFor(intent.mode, row), intent.members[i]!.expected_content_rev);
        if (!result.ok) throw new DispatchRefusal(result.reason, [row.id]);
        written.push(result.card);
      }

      const text = composeAtomicDispatchText(intent.mode, intent.target_kind, written);
      const sentAt = new Date(nowMs).toISOString();
      const messageId = deps.insertMessage(target.token, intent.group_id, text, sentAt);

      const cards: AtomicDispatchCard[] = written.map((card) => ({ id: card.id, title: card.title, kind: card.kind }));
      const sent: AtomicDispatchOutcome = {
        delivery: "sent",
        operation_id: intent.operation_id,
        message_id: messageId,
        cards,
      };
      record(sent, nowMs);
      pushFrame = { token: target.token, messageId, text, sentAt };
      return sent;
    });

    try {
      return outcomeResponse(effects());
    } catch (e) {
      pushFrame = null;
      if (e instanceof DispatchRefusal) {
        const refused = notSent(e.reason, e.cardIds);
        record(refused, nowMs);
        return outcomeResponse(refused);
      }
      deps.warn("atomic dispatch rolled back after a failed effect", e);
      const failed = notSent(
        "write-failed",
        intent.members.map((m) => m.id)
      );
      record(failed, nowMs);
      return outcomeResponse(failed);
    }
  });

  const http = transact.immediate();
  const frame = pushFrame as { token: string; messageId: number; text: string; sentAt: string } | null;
  if (frame) {
    try {
      deps.push(frame);
    } catch (e) {
      deps.warn("atomic dispatch: push after commit failed, the message is stored and will be pulled", e);
    }
  }
  return http;
}
