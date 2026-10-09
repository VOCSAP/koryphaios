export const DELEGATION_POLICY_DEFAULTS = {
  max_rearms: 3,
  lead_silence_sec: 300,
  max_deadline_sec: 14_400,
} as const;

export const DELEGATION_POLICY_BOUNDS = {
  max_rearms: { min: 0, max: 10 },
  lead_silence_sec: { min: 15, max: 3_600 },
  max_deadline_sec: { min: 1, max: 86_400 },
} as const;

export const MAX_OPEN_DELEGATED_TASKS = 100;
export const MAX_TASK_LABEL_CODE_POINTS = 30;

export type DelegationPolicyKey = keyof typeof DELEGATION_POLICY_DEFAULTS;
export type DelegationPolicy = { [K in DelegationPolicyKey]: number };
export type DelegationPolicySource = "env" | "file" | "default";
export type DelegationTaskStatus = "armed" | "overdue" | "escalated" | "orphaned" | "delivery_failed" | "closed";
export type DelegationTaskAction = "close";

export interface DelegationPolicyValue {
  value: number;
  source: DelegationPolicySource;
}

export interface DelegationPolicyState {
  available: boolean;
  values: DelegationPolicy;
  sources: { [K in DelegationPolicyKey]: DelegationPolicySource };
  bounds: typeof DELEGATION_POLICY_BOUNDS;
  diagnostics: string[];
  config_path_fingerprint: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function validateDelegationPolicyValue(
  key: DelegationPolicyKey,
  value: unknown
): ValidationResult<number> {
  const bounds = DELEGATION_POLICY_BOUNDS[key];
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value)) {
    return { ok: false, error: `${key} must be a finite safe integer` };
  }
  if (value < bounds.min || value > bounds.max) {
    return { ok: false, error: `${key} must be between ${bounds.min} and ${bounds.max}` };
  }
  return { ok: true, value };
}

export function parseDelegationPolicyEnvironment(
  key: DelegationPolicyKey,
  value: string
): ValidationResult<number> {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    return { ok: false, error: `${key} environment value must be an unsigned decimal integer` };
  }
  return validateDelegationPolicyValue(key, Number(value));
}

export function validateDeadlineSec(value: unknown, policy: DelegationPolicy): ValidationResult<number> {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value)) {
    return { ok: false, error: "deadline_sec must be a finite safe integer" };
  }
  if (value < 1 || value > policy.max_deadline_sec) {
    return { ok: false, error: `deadline_sec must be between 1 and ${policy.max_deadline_sec}` };
  }
  return { ok: true, value };
}

export function isDelegationTaskId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isDelegationTaskAction(value: unknown): value is DelegationTaskAction {
  return value === "close";
}

export function taskLabelFromText(text: string): string {
  const compact = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/\s+/gu, " ").trim();
  const points = Array.from(compact);
  return points.length > MAX_TASK_LABEL_CODE_POINTS
    ? `${points.slice(0, MAX_TASK_LABEL_CODE_POINTS - 1).join("")}…`
    : compact;
}

export function validateTaskLabel(value: unknown): ValidationResult<string> {
  if (typeof value !== "string") return { ok: false, error: "task_label must be a string" };
  const normalized = taskLabelFromText(value);
  if (!normalized) return { ok: false, error: "task_label must contain visible text" };
  if (normalized !== value) return { ok: false, error: "task_label must be normalized and at most 30 code points" };
  return { ok: true, value };
}
