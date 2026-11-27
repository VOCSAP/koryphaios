// Pure module: who may process a named lot under execution. The broker resolves
// the proofs and reads the clock; nothing here reads a request body.

export type LotExecutionState = "running" | "interrupted" | "closed";

export type LotInterruptionReason = "run-ended" | "controller-gone" | "controller-silent";

export interface LotExecution {
  project_key: string;
  lot_id: string;
  /** Counted from 1 per lot: a lot processed again takes the next one. */
  epoch: number;
  /** `interrupted` never returns to `running`. */
  state: LotExecutionState;
  operator_id: string;
  group_id: string;
  run_ref: string;
  /** Digest of the controlling instance's token, never the token. */
  controller_ref: string;
  controller_peer_id: string;
  started_at: string;
  interrupted_at: string | null;
  interrupted_reason: LotInterruptionReason | null;
}

/** An agent session whose binding to a Kory run the broker verified. */
export interface LotInstanceSubject {
  kind: "instance";
  operator_id: string;
  group_id: string;
  run_ref: string;
  project_key: string;
  instance_ref: string;
}

export interface LotRunWindow {
  run_ref: string;
  group_id: string;
}

export type LotExecutionSubject =
  | LotInstanceSubject
  /** A write signed with the operator key; `window` is the run and group that signature names. */
  | { kind: "operator"; operator_id: string; window: LotRunWindow | null }
  | { kind: "unproven" };

/**
 * `claim` moves a card toward work or takes its lock; `change` is any other
 * guarded write; `restructure` moves a card in or out of the lot, ranks it or
 * replaces it, which nobody does under execution; `grant` mandates a worker.
 * `start` opens an execution, `dispatch` sends more work to the open one,
 * `resume` hands an interrupted one to a controller, `close` ends it and
 * `settle` sets one of its sends aside. `epoch` is the execution the operator
 * read; a start signs `after`, the lot's last closed epoch, to be compared with
 * `lastClosed`. A session the broker cannot prove is null.
 */
export type LotExecutionAct =
  | { kind: "claim" }
  | { kind: "change" }
  | { kind: "restructure" }
  | { kind: "grant"; grantee: LotInstanceSubject | null }
  | { kind: "start"; controller: LotInstanceSubject | null; after: number; lastClosed: number }
  | { kind: "dispatch"; target: LotInstanceSubject | null; epoch: number }
  | { kind: "resume"; controller: LotInstanceSubject | null; epoch: number }
  | { kind: "close"; epoch: number }
  | { kind: "settle"; epoch: number };

export type LotExecutionRefusal =
  | "lot_execution_held"
  | "lot_execution_interrupted"
  | "lot_execution_not_started"
  | "lot_execution_unproven"
  | "lot_execution_grantee"
  | "lot_execution_controller"
  | "lot_execution_stale"
  | "lot_execution_replica";

export type LotExecutionVerdict =
  | { ok: true; effect: "pass" | "continue" | "start" | "resume" | "close" }
  | { ok: false; code: LotExecutionRefusal };

export interface LotExecutionRequest {
  /** Project of the lot being judged. */
  project_key: string;
  /** The lot's execution that is not closed, or null. */
  execution: LotExecution | null;
  subject: LotExecutionSubject;
  act: LotExecutionAct;
  /** Instance digests the controller granted for this execution. */
  participants: ReadonlySet<string>;
  replica: boolean;
}

const refuse = (code: LotExecutionRefusal): LotExecutionVerdict => ({ ok: false, code });

const signsRunOf = (window: LotRunWindow | null, holder: LotRunWindow): boolean =>
  window !== null && window.run_ref === holder.run_ref && window.group_id === holder.group_id;

/** An operator names as controller only its own proven session, in this project and in the run it signs. */
const isSignedController = (
  operator: Extract<LotExecutionSubject, { kind: "operator" }>,
  controller: LotInstanceSubject | null,
  projectKey: string
): boolean =>
  controller !== null &&
  controller.operator_id === operator.operator_id &&
  controller.project_key === projectKey &&
  signsRunOf(operator.window, controller);

export function judgeLotExecution(request: LotExecutionRequest): LotExecutionVerdict {
  const { subject, act } = request;
  const execution = request.execution?.state === "closed" ? null : request.execution;
  if (request.replica && act.kind !== "change" && act.kind !== "restructure") return refuse("lot_execution_replica");
  // Only a proven writer holding nothing learns a lot is interrupted, except on restructure (import, lot move, sync).
  const blocked = (code: "lot_execution_held" | "lot_execution_unproven"): LotExecutionVerdict =>
    refuse(subject.kind !== "unproven" && execution?.state === "interrupted" ? "lot_execution_interrupted" : code);
  if (act.kind === "start") {
    // Only an operator dispatch starts an execution.
    if (subject.kind !== "operator") return blocked("lot_execution_unproven");
    if (execution !== null) return blocked("lot_execution_held");
    // A start signed before a close would reopen the lot the operator ended.
    if (act.after !== act.lastClosed) return refuse("lot_execution_stale");
    return isSignedController(subject, act.controller, request.project_key)
      ? { ok: true, effect: "start" }
      : refuse("lot_execution_controller");
  }
  // A lot nobody processes is being prepared: changing and restructuring need no execution.
  if (execution === null) {
    return act.kind === "change" || act.kind === "restructure"
      ? { ok: true, effect: "pass" }
      : refuse("lot_execution_not_started");
  }
  if (act.kind === "restructure") {
    return refuse(execution.state === "interrupted" ? "lot_execution_interrupted" : "lot_execution_held");
  }
  if (subject.kind === "unproven") return refuse("lot_execution_unproven");
  const ofTheRun = (instance: LotInstanceSubject): boolean =>
    instance.operator_id === execution.operator_id &&
    instance.group_id === execution.group_id &&
    instance.run_ref === execution.run_ref &&
    instance.project_key === execution.project_key;
  const isController = (instance: LotInstanceSubject): boolean =>
    ofTheRun(instance) && instance.instance_ref === execution.controller_ref;
  if (act.kind === "dispatch") {
    if (subject.kind !== "operator") return blocked("lot_execution_unproven");
    if (execution.state === "interrupted") return refuse("lot_execution_interrupted");
    if (subject.operator_id !== execution.operator_id || !signsRunOf(subject.window, execution)) {
      return refuse("lot_execution_held");
    }
    if (act.epoch !== execution.epoch) return refuse("lot_execution_stale");
    // Orders of a lot go to its controller alone.
    if (act.target === null || !isController(act.target)) return refuse("lot_execution_held");
    return { ok: true, effect: "continue" };
  }
  if (act.kind === "resume") {
    if (subject.kind !== "operator") return blocked("lot_execution_unproven");
    if (subject.operator_id !== execution.operator_id) return blocked("lot_execution_held");
    if (act.epoch !== execution.epoch) return refuse("lot_execution_stale");
    if (execution.state !== "interrupted") return refuse("lot_execution_held");
    return isSignedController(subject, act.controller, request.project_key)
      ? { ok: true, effect: "resume" }
      : refuse("lot_execution_controller");
  }
  if (act.kind === "close" || act.kind === "settle") {
    if (subject.kind !== "operator") return blocked("lot_execution_unproven");
    if (subject.operator_id !== execution.operator_id) return blocked("lot_execution_held");
    if (act.epoch !== execution.epoch) return refuse("lot_execution_stale");
    return { ok: true, effect: act.kind === "close" ? "close" : "continue" };
  }
  if (act.kind === "grant") {
    if (subject.kind !== "instance" || !isController(subject)) return blocked("lot_execution_held");
    if (execution.state === "interrupted") return refuse("lot_execution_interrupted");
    if (act.grantee === null || !ofTheRun(act.grantee)) return refuse("lot_execution_grantee");
    return { ok: true, effect: "continue" };
  }
  const interruptedClaim = act.kind === "claim" && execution.state === "interrupted";
  if (subject.kind === "operator") {
    if (subject.operator_id !== execution.operator_id) return blocked("lot_execution_held");
    // The operator may stop or close from any window; taking a card is the holding window's act.
    if (act.kind === "claim" && !signsRunOf(subject.window, execution)) return blocked("lot_execution_held");
  } else {
    const holds =
      ofTheRun(subject) &&
      (subject.instance_ref === execution.controller_ref || request.participants.has(subject.instance_ref));
    if (!holds) return blocked("lot_execution_held");
  }
  return interruptedClaim ? refuse("lot_execution_interrupted") : { ok: true, effect: "continue" };
}

export interface LotExecutionPresence {
  runCredentialLive: boolean;
  /** The controller's peer row in the holding group; null once it is gone. */
  controller: { active: boolean; lastSeenMs: number } | null;
}

/** Why a running execution is interrupted now, or null while its holder is present. */
export function lotExecutionInterruption(
  presence: LotExecutionPresence,
  nowMs: number,
  ttlMs: number
): LotInterruptionReason | null {
  if (!presence.runCredentialLive) return "run-ended";
  if (presence.controller === null) return "controller-gone";
  if (presence.controller.active) return null;
  // An unreadable date compares false, so it counts as silence.
  return nowMs - presence.controller.lastSeenMs < ttlMs ? null : "controller-silent";
}

export function lotExecutionRefusalStatus(code: LotExecutionRefusal): 403 | 409 {
  return code === "lot_execution_unproven" ||
    code === "lot_execution_grantee" ||
    code === "lot_execution_controller" ||
    code === "lot_execution_replica"
    ? 403
    : 409;
}

/** The text reaches agents: it names the lot and the controlling peer, never a run or an instance digest. */
export function formatLotExecutionRefusal(
  code: LotExecutionRefusal,
  lotName: string,
  controllerPeerId: string | null
): string {
  const lot = `lot ${JSON.stringify(lotName)}`;
  const detail: Record<LotExecutionRefusal, string> = {
    lot_execution_held: `Workflow en cours, pas touche : ${lot} is processed by '${controllerPeerId}'`,
    lot_execution_interrupted: `${lot} is interrupted: its execution must be resumed by the operator`,
    lot_execution_not_started: `${lot} is not being processed: only an operator dispatch starts it`,
    lot_execution_unproven: `${lot} is processed by '${controllerPeerId}' and this write proves no Kory run`,
    lot_execution_grantee: `${lot} takes a worker only from the Kory run that processes it: the named peer is no such session`,
    lot_execution_controller: `${lot} takes a controller only from the Kory run that signs the request: the named peer is no such session`,
    lot_execution_stale: `${lot} changed execution since it was read: read it again`,
    lot_execution_replica: `${lot} cannot be processed on a replica broker`,
  };
  return `${code}: ${detail[code]}`;
}
