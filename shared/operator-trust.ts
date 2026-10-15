import { createHash, createPublicKey } from "node:crypto";
import { deriveOperatorId } from "./approval.ts";

export const OPERATOR_TRUST_VERSION = 1;
export const OPERATOR_TRUST_LABEL_MAX_LENGTH = 120;

function labelRange(first: number, last: number): string {
  return `${String.fromCodePoint(first)}-${String.fromCodePoint(last)}`;
}

const FORBIDDEN_LABEL_CHARACTERS = new RegExp(
  `[${labelRange(0, 0x1f)}${labelRange(0x7f, 0x9f)}${String.fromCodePoint(0x061c)}${labelRange(0x200e, 0x200f)}${labelRange(0x2028, 0x2029)}${labelRange(0x202a, 0x202e)}${labelRange(0x2066, 0x2069)}]`,
  "u"
);

export interface TrustedOperator {
  operatorId: string;
  publicKey: string;
  label?: string;
}

export interface OperatorTrust {
  trustedOperator(operatorId: string): TrustedOperator | null;
  trustedOperators(): readonly TrustedOperator[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: readonly string[], at: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${at} unknown field ${key}`);
  }
}

function requireEd25519PublicKey(value: unknown, at: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${at}.public_key must be a non-empty Ed25519 SPKI public key`);
  }

  const keyBytes = Buffer.from(value, "base64");
  if (keyBytes.length === 0 || keyBytes.toString("base64") !== value) {
    throw new Error(`${at}.public_key must be a valid Ed25519 SPKI public key`);
  }

  try {
    const publicKey = createPublicKey({ key: keyBytes, format: "der", type: "spki" });
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new Error("unexpected key type");
    }
    const canonical = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    if (canonical !== value) {
      throw new Error("non-canonical key encoding");
    }
  } catch {
    throw new Error(`${at}.public_key must be a valid Ed25519 SPKI public key`);
  }

  return value;
}

export function publicKeyFingerprint(publicKey: string): string {
  const key = requireEd25519PublicKey(publicKey, "public key");
  return createHash("sha256").update(Buffer.from(key, "base64")).digest("hex");
}

export function parseOperatorTrust(raw: string): OperatorTrust {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("operator trust policy must be valid JSON");
  }
  if (!isRecord(value)) {
    throw new Error("operator trust policy must be an object");
  }
  rejectUnknownFields(value, ["version", "operators"], "operator trust policy");
  if (value.version !== OPERATOR_TRUST_VERSION) {
    throw new Error(`operator trust policy version must be ${OPERATOR_TRUST_VERSION}`);
  }
  if (!Array.isArray(value.operators)) {
    throw new Error("operator trust policy operators must be an array");
  }

  const byId = new Map<string, TrustedOperator>();
  for (const [index, entry] of value.operators.entries()) {
    const at = `operators[${index}]`;
    if (!isRecord(entry)) {
      throw new Error(`${at} must be an object`);
    }
    rejectUnknownFields(entry, ["public_key", "label"], at);
    if (
      entry.label !== undefined &&
      (typeof entry.label !== "string" ||
        entry.label.length === 0 ||
        entry.label.length > OPERATOR_TRUST_LABEL_MAX_LENGTH ||
        FORBIDDEN_LABEL_CHARACTERS.test(entry.label))
    ) {
      throw new Error(`${at}.label must be a safe non-empty string within the maximum length`);
    }
    const publicKey = requireEd25519PublicKey(entry.public_key, at);
    const operatorId = deriveOperatorId(publicKey);
    if (byId.has(operatorId)) {
      throw new Error(`duplicate operator_id ${operatorId}`);
    }
    byId.set(operatorId, entry.label === undefined
      ? { operatorId, publicKey }
      : { operatorId, publicKey, label: entry.label });
  }

  const operators = [...byId.values()];
  return {
    trustedOperator(operatorId) {
      return byId.get(operatorId) ?? null;
    },
    trustedOperators() {
      return operators;
    },
  };
}
