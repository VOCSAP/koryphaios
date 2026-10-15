import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { deriveOperatorId, generateCredential } from "../shared/approval.ts";
import { operatorTrustFilePath } from "../shared/config.ts";
import {
  OPERATOR_TRUST_LABEL_MAX_LENGTH,
  OPERATOR_TRUST_VERSION,
  parseOperatorTrust,
  publicKeyFingerprint,
} from "../shared/operator-trust.ts";

function policy(operators: unknown): string {
  return JSON.stringify({ version: OPERATOR_TRUST_VERSION, operators });
}

describe("operator trust policy", () => {
  test("places the policy beside the injected global broker config", () => {
    const configPath = join("profile", "claude-peers", "config.json");
    expect(operatorTrustFilePath(configPath))
      .toBe(join("profile", "claude-peers", "operator-trust.json"));
  });

  test("indexes a valid Ed25519 public key by its derived operator id", () => {
    const credential = generateCredential();
    const parsed = parseOperatorTrust(policy([{ public_key: credential.publicKey, label: "personal Deck" }]));
    const operatorId = deriveOperatorId(credential.publicKey);

    expect(parsed.trustedOperator(operatorId)).toEqual({
      operatorId,
      publicKey: credential.publicKey,
      label: "personal Deck",
    });
    expect(publicKeyFingerprint(credential.publicKey)).toHaveLength(64);
    expect(parsed.trustedOperator("unknown")).toBeNull();
  });

  test("rejects an empty policy file", () => {
    expect(() => parseOperatorTrust("")).toThrow("valid JSON");
  });

  test("allows an empty list without trusting any operator", () => {
    const parsed = parseOperatorTrust(policy([]));

    expect(parsed.trustedOperator("anything")).toBeNull();
  });

  test("rejects unknown root fields", () => {
    const credential = generateCredential();
    const document = JSON.stringify({
      version: OPERATOR_TRUST_VERSION,
      operators: [{ public_key: credential.publicKey }],
      disabled: true,
    });

    expect(() => parseOperatorTrust(document)).toThrow("unknown field");
  });

  test("rejects unknown operator entry fields", () => {
    const credential = generateCredential();

    expect(() => parseOperatorTrust(policy([{ public_key: credential.publicKey, revoked: true }]))).toThrow("unknown field");
  });

  test("rejects an unsupported policy version", () => {
    const credential = generateCredential();

    expect(() => parseOperatorTrust(JSON.stringify({
      version: 2,
      operators: [{ public_key: credential.publicKey }],
    }))).toThrow("version");
  });

  test("rejects a nonnumeric policy version", () => {
    const credential = generateCredential();

    expect(() => parseOperatorTrust(JSON.stringify({
      version: "1",
      operators: [{ public_key: credential.publicKey }],
    }))).toThrow("version");
  });

  test("rejects noncanonical base64 for an otherwise valid Ed25519 key", () => {
    const credential = generateCredential();
    const noncanonical = credential.publicKey.slice(0, -1);

    expect(() => parseOperatorTrust(policy([{ public_key: noncanonical }]))).toThrow("Ed25519");
  });

  test("rejects an Ed25519 SPKI with trailing noncanonical DER data", () => {
    const credential = generateCredential();
    const noncanonical = Buffer.concat([
      Buffer.from(credential.publicKey, "base64"),
      Buffer.from([0]),
    ]).toString("base64");

    expect(() => parseOperatorTrust(policy([{ public_key: noncanonical }]))).toThrow("Ed25519");
  });

  test("rejects labels that can forge fingerprint output", () => {
    const credential = generateCredential();

    for (const label of [
      "line\nbreak",
      `escape${String.fromCodePoint(0x1b)}[31m`,
      `separator${String.fromCodePoint(0x2028)}`,
      `paragraph${String.fromCodePoint(0x2029)}`,
      `bidi${String.fromCodePoint(0x202e)}`,
    ]) {
      expect(() => parseOperatorTrust(policy([{ public_key: credential.publicKey, label }]))).toThrow("label");
    }
  });

  test("rejects labels longer than the named policy bound", () => {
    const credential = generateCredential();
    const label = "x".repeat(OPERATOR_TRUST_LABEL_MAX_LENGTH + 1);

    expect(() => parseOperatorTrust(policy([{ public_key: credential.publicKey, label }]))).toThrow("label");
  });

  test("rejects malformed public key material", () => {
    expect(() => parseOperatorTrust(policy([{ public_key: "not-a-key" }]))).toThrow("Ed25519");
  });

  test("rejects public keys of an unexpected cryptographic type", () => {
    const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64");

    expect(() => parseOperatorTrust(policy([{ public_key: key }]))).toThrow("Ed25519");
  });

  test("rejects duplicate operator entries", () => {
    const credential = generateCredential();

    expect(() => parseOperatorTrust(policy([
      { public_key: credential.publicKey },
      { public_key: credential.publicKey },
    ]))).toThrow("duplicate operator_id");
  });

  test("rejects the whole policy when one entry is invalid", () => {
    const credential = generateCredential();

    expect(() => parseOperatorTrust(policy([
      { public_key: credential.publicKey },
      { public_key: "not-a-key" },
    ]))).toThrow("operators[1]");
  });
});
