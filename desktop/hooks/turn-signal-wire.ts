export const TURN_SIGNAL_LIMITS = { bodyBytes: 4096, id: 128, command: 128, args: 256, label: 32, backgroundTasks: 1024 } as const;

export const TURN_COMPLETE_REASONS = ["answer", "aborted", "refusal", "error"] as const;
export const SESSION_END_REASONS = ["clear", "resume", "logout", "prompt_input_exit", "other"] as const;

export type TurnCompleteReason = (typeof TURN_COMPLETE_REASONS)[number];
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

export type TurnSignal =
  | { kind: "command.run:enter"; seq: number; command: string; args: string; origin: string }
  | { kind: "command.run:resolved"; seq: number; command: string }
  | { kind: "turn.start"; seq: number; turnId: string; agentId?: string; commandSeq?: number }
  | {
      kind: "turn.complete";
      seq: number;
      turnId: string;
      reason: TurnCompleteReason;
      isAborted: boolean;
      agentId?: string;
      backgroundTasks?: number;
    }
  | { kind: "session.compact:resolved"; seq: number }
  | { kind: "session.end"; seq: number; reason: SessionEndReason };

export type TurnSignalRefusal =
  | "body-too-large"
  | "not-json"
  | "not-an-object"
  | "unknown-kind"
  | "unknown-key"
  | "missing-key"
  | "bad-seq"
  | "bad-string"
  | "bad-flag"
  | "bad-count"
  | "bad-reason"
  | "aborted-mismatch";

export type ParsedTurnSignal = { ok: true; signal: TurnSignal } | { ok: false; reason: TurnSignalRefusal };

type Rule =
  | { type: "seq" }
  | { type: "bool" }
  | { type: "count"; max: number }
  | { type: "enum"; values: readonly string[] }
  | { type: "text"; max: number; empty?: true };

interface Shape {
  required: Readonly<Record<string, Rule>>;
  optional: Readonly<Record<string, Rule>>;
}

const SEQ: Rule = { type: "seq" };
const ID: Rule = { type: "text", max: TURN_SIGNAL_LIMITS.id };
const COMMAND: Rule = { type: "text", max: TURN_SIGNAL_LIMITS.command };
const LABEL: Rule = { type: "text", max: TURN_SIGNAL_LIMITS.label };
const ARGS: Rule = { type: "text", max: TURN_SIGNAL_LIMITS.args, empty: true };
const COUNT: Rule = { type: "count", max: TURN_SIGNAL_LIMITS.backgroundTasks };
const TURN_REASON: Rule = { type: "enum", values: TURN_COMPLETE_REASONS };
const END_REASON: Rule = { type: "enum", values: SESSION_END_REASONS };
const NONE = {} as const;

const SHAPES: Readonly<Record<TurnSignal["kind"], Shape>> = {
  "command.run:enter": { required: { seq: SEQ, command: COMMAND, args: ARGS, origin: LABEL }, optional: NONE },
  "command.run:resolved": { required: { seq: SEQ, command: COMMAND }, optional: NONE },
  "turn.start": { required: { seq: SEQ, turnId: ID }, optional: { agentId: ID, commandSeq: SEQ } },
  "turn.complete": {
    required: { seq: SEQ, turnId: ID, reason: TURN_REASON, isAborted: { type: "bool" } },
    optional: { agentId: ID, backgroundTasks: COUNT }
  },
  "session.compact:resolved": { required: { seq: SEQ }, optional: NONE },
  "session.end": { required: { seq: SEQ, reason: END_REASON }, optional: NONE }
};

const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/u;

function isSafeText(value: unknown, max: number): value is string {
  return typeof value === "string" && !UNSAFE_TEXT.test(value) && Array.from(value).length <= max;
}

/** True when the parser accepts `value` as a non-blank label of at most `max` characters. */
export function isWireText(value: unknown, max: number): value is string {
  return isSafeText(value, max) && value.trim().length > 0;
}

function refusalOf(value: unknown, rule: Rule): TurnSignalRefusal | null {
  if (rule.type === "seq") {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? null : "bad-seq";
  }
  if (rule.type === "bool") return typeof value === "boolean" ? null : "bad-flag";
  if (rule.type === "count") {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= rule.max ? null : "bad-count";
  }
  if (rule.type === "enum") return typeof value === "string" && rule.values.includes(value) ? null : "bad-reason";
  return (rule.empty === true ? isSafeText(value, rule.max) : isWireText(value, rule.max)) ? null : "bad-string";
}

const refuse = (reason: TurnSignalRefusal): ParsedTurnSignal => ({ ok: false, reason });

/**
 * The body comes from a local process: anything off the closed shapes is
 * refused, never repaired, and the refusal names a rule, never the body.
 * `agentId` is present only for a sub-agent turn. A lone surrogate matches
 * `\p{Cs}` under the `u` flag, which is how a malformed string is refused.
 */
export function parseTurnSignal(raw: string): ParsedTurnSignal {
  if (new TextEncoder().encode(raw).length > TURN_SIGNAL_LIMITS.bodyBytes) return refuse("body-too-large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return refuse("not-json");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return refuse("not-an-object");
  const body = parsed as Record<string, unknown>;
  const kind = body.kind;
  if (typeof kind !== "string" || !Object.hasOwn(SHAPES, kind)) return refuse("unknown-kind");
  const shape = SHAPES[kind as TurnSignal["kind"]];
  for (const key of Object.keys(body)) {
    if (key !== "kind" && !Object.hasOwn(shape.required, key) && !Object.hasOwn(shape.optional, key)) {
      return refuse("unknown-key");
    }
  }
  for (const [key, rule] of Object.entries(shape.required)) {
    if (!Object.hasOwn(body, key)) return refuse("missing-key");
    const refusal = refusalOf(body[key], rule);
    if (refusal) return refuse(refusal);
  }
  for (const [key, rule] of Object.entries(shape.optional)) {
    if (!Object.hasOwn(body, key)) continue;
    const refusal = refusalOf(body[key], rule);
    if (refusal) return refuse(refusal);
  }
  if (kind === "turn.complete" && body.isAborted !== (body.reason === "aborted")) return refuse("aborted-mismatch");
  return { ok: true, signal: body as TurnSignal };
}
