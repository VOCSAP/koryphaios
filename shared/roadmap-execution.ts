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
 * replaces it, which nobody does under execution; `grant` mandates a worker,
 * null when the named peer is no session the broker can prove.
 */
export type LotExecutionAct =
  | { kind: "claim" }
  | { kind: "change" }
  | { kind: "restructure" }
  | { kind: "grant"; grantee: LotInstanceSubject | null }
  | { kind: "start"; controller: LotInstanceSubject };

export type LotExecutionRefusal =
  | "lot_execution_held"
  | "lot_execution_interrupted"
  | "lot_execution_not_started"
  | "lot_execution_unproven"
  | "lot_execution_grantee"
  | "lot_execution_replica";

export type LotExecutionVerdict =
  | { ok: true; effect: "pass" | "continue" | "start" }
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

export function judgeLotExecution(request: LotExecutionRequest): LotExecutionVerdict {
  const { subject, act } = request;
  const execution = request.execution?.state === "closed" ? null : request.execution;
  if (request.replica && act.kind !== "change" && act.kind !== "restructure") return refuse("lot_execution_replica");
  if (act.kind === "start") {
    // Only an operator dispatch starts an execution, and it names a controller of the same operator.
    if (
      subject.kind !== "operator" ||
      act.controller.operator_id !== subject.operator_id ||
      act.controller.project_key !== request.project_key
    ) {
      return refuse("lot_execution_unproven");
    }
    if (execution === null) return { ok: true, effect: "start" };
    return refuse(execution.state === "interrupted" ? "lot_execution_interrupted" : "lot_execution_held");
  }
  // A lot nobody processes is being prepared: only taking a card or mandating a worker needs an execution.
  if (execution === null) {
    return act.kind === "claim" || act.kind === "grant"
      ? refuse("lot_execution_not_started")
      : { ok: true, effect: "pass" };
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
  if (act.kind === "grant") {
    if (subject.kind !== "instance" || !ofTheRun(subject) || subject.instance_ref !== execution.controller_ref) {
      return refuse("lot_execution_held");
    }
    if (execution.state === "interrupted") return refuse("lot_execution_interrupted");
    if (act.grantee === null || !ofTheRun(act.grantee)) return refuse("lot_execution_grantee");
    return { ok: true, effect: "continue" };
  }
  const interruptedClaim = act.kind === "claim" && execution.state === "interrupted";
  if (subject.kind === "operator") {
    if (subject.operator_id !== execution.operator_id) return refuse("lot_execution_held");
    // The operator may stop or close from any window; taking a card is the holding window's act.
    if (
      act.kind === "claim" &&
      (subject.window === null ||
        subject.window.group_id !== execution.group_id ||
        subject.window.run_ref !== execution.run_ref)
    ) {
      return refuse("lot_execution_held");
    }
  } else {
    const holds =
      ofTheRun(subject) &&
      (subject.instance_ref === execution.controller_ref || request.participants.has(subject.instance_ref));
    if (!holds) return refuse("lot_execution_held");
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
  return code === "lot_execution_unproven" || code === "lot_execution_grantee" || code === "lot_execution_replica"
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
    lot_execution_replica: `${lot} cannot be processed on a replica broker`,
  };
  return `${code}: ${detail[code]}`;
}
