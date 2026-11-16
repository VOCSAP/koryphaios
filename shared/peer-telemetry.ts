export const TELEMETRY_CAPABILITY_ENV = "CLAUDE_PEERS_TELEMETRY_CAPABILITY";

export const PEER_TELEMETRY_MODEL_MAX = 64;
export const PEER_TELEMETRY_MODEL_ID_MAX = 200;
export const PEER_TELEMETRY_CONTEXT_WINDOW_MAX = 10_000_000;

export interface PeerTelemetrySnapshot {
  model: string;
  modelId: string;
  contextPct: number | null;
  contextWindow: number | null;
  observedAt: number;
}

export interface TileTelemetryBaseRequest {
  run_ref: string;
  group_id: string;
  desk_session: string;
  launch_hash: string;
}

export interface TileTelemetryPublishRequest extends TileTelemetryBaseRequest {
  action: "publish";
  snapshot: PeerTelemetrySnapshot;
}

export interface TileTelemetryStopRequest extends TileTelemetryBaseRequest {
  action: "stop";
}

export type TileTelemetryRequest = TileTelemetryPublishRequest | TileTelemetryStopRequest;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

// Allow-lists (letters, numbers, small punctuation set), not deny-lists: these strings are
// rendered to agents, so control, separator, bidi and zero-width characters must be refused.
const MODEL_NAME_RE = /^[\p{L}\p{N} ._()[\]:/+·-]+$/u;
const MODEL_ID_RE = /^[\p{L}\p{N}._()[\]:/+@·-]+$/u;

function validModelName(value: unknown): value is string {
  return validString(value, PEER_TELEMETRY_MODEL_MAX) && MODEL_NAME_RE.test(value);
}

function validModelId(value: unknown): value is string {
  return validString(value, PEER_TELEMETRY_MODEL_ID_MAX) && MODEL_ID_RE.test(value);
}

function validNullablePct(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100);
}

function validNullableContextWindow(value: unknown): value is number | null {
  return value === null || (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= PEER_TELEMETRY_CONTEXT_WINDOW_MAX
  );
}

export function validatePeerTelemetrySnapshot(value: unknown): PeerTelemetrySnapshot | null {
  if (!isRecord(value)) return null;
  if (!validModelName(value.model)) return null;
  if (!validModelId(value.modelId)) return null;
  if (!validNullablePct(value.contextPct)) return null;
  if (!validNullableContextWindow(value.contextWindow)) return null;
  if (typeof value.observedAt !== "number" || !Number.isSafeInteger(value.observedAt) || value.observedAt < 0) return null;
  return {
    model: value.model,
    modelId: value.modelId,
    contextPct: value.contextPct,
    contextWindow: value.contextWindow,
    observedAt: value.observedAt,
  };
}

/** The sender's context fill frozen at send time, with the time of the source sample. */
export interface MessageContextSnapshot {
  contextPct: number;
  observedAt: number;
}

/** Where a message's context snapshot comes from; never read from a /send-message body. */
export type MessageContextSource =
  | { kind: "local" }
  | { kind: "federated"; snapshot: MessageContextSnapshot | null };

/** Fields a message carries on the wire: both present or both absent. */
export interface MessageContextWireFields {
  from_context_pct?: number;
  from_context_observed_at?: number;
}

// Not validNullablePct: a message pair is refused when out of range, never clamped.
export function validateMessageContextPair(pct: unknown, observedAt: unknown): MessageContextSnapshot | null {
  if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  if (typeof observedAt !== "number" || !Number.isSafeInteger(observedAt) || observedAt < 0) return null;
  return { contextPct: pct, observedAt };
}

export function messageContextFromTelemetry(
  telemetry: Pick<PeerTelemetrySnapshot, "contextPct" | "observedAt"> | null | undefined,
): MessageContextSnapshot | null {
  if (!telemetry) return null;
  return validateMessageContextPair(telemetry.contextPct, telemetry.observedAt);
}

export function messageContextWireFields(snapshot: MessageContextSnapshot | null): MessageContextWireFields {
  if (!snapshot) return {};
  return { from_context_pct: snapshot.contextPct, from_context_observed_at: snapshot.observedAt };
}

export function validateTileTelemetryRequest(value: unknown): TileTelemetryRequest | null {
  if (!isRecord(value)) return null;
  if (!validString(value.run_ref, 128)) return null;
  if (!validString(value.group_id, 128)) return null;
  if (!validString(value.desk_session, 128)) return null;
  if (typeof value.launch_hash !== "string" || !/^[0-9a-f]{64}$/.test(value.launch_hash)) return null;
  if (value.action === "stop") {
    if (Object.hasOwn(value, "snapshot")) return null;
    return {
      run_ref: value.run_ref,
      group_id: value.group_id,
      desk_session: value.desk_session,
      launch_hash: value.launch_hash,
      action: "stop",
    };
  }
  if (value.action !== "publish") return null;
  const snapshot = validatePeerTelemetrySnapshot(value.snapshot);
  if (!snapshot) return null;
  return {
    run_ref: value.run_ref,
    group_id: value.group_id,
    desk_session: value.desk_session,
    launch_hash: value.launch_hash,
    action: "publish",
    snapshot,
  };
}
