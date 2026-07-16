// C29 hardening: local-provider API keys encrypted at rest
// (desktop/src/main/provider-secrets) — fake cipher, scope-secrets pattern.

import { test, expect } from "bun:test";
import {
  applyProviderKeyPatch,
  decryptProviders,
  sanitizeProviders
} from "../desktop/src/main/provider-secrets.ts";
import type { SecretCipher } from "../desktop/src/main/scope-secrets.ts";
import type { LocalProviderConfig } from "../desktop/src/shared/models.ts";

/** Reversible fake cipher: "encryption" = byte-reversed string. */
const fakeCipher: SecretCipher = {
  isAvailable: () => true,
  encrypt: (plain) => Buffer.from([...plain].reverse().join("")),
  decrypt: (buf) => [...buf.toString()].reverse().join("")
};

const deadCipher: SecretCipher = {
  isAvailable: () => false,
  encrypt: () => {
    throw new Error("unavailable");
  },
  decrypt: () => {
    throw new Error("unavailable");
  }
};

function p(id: string, extra: Partial<LocalProviderConfig> = {}): LocalProviderConfig {
  return { id, name: id, baseUrl: `http://${id}`, ...extra };
}

test("a freshly typed key is encrypted at rest, never stored in clear", () => {
  const stored = applyProviderKeyPatch([], [p("a", { apiKey: "sk-secret" })], fakeCipher);
  expect(stored[0].apiKey).toBeUndefined();
  expect(stored[0].apiKeyEnc).toStartWith("enc:");
  expect(stored[0].apiKeyEnc).not.toContain("sk-secret");
  expect(JSON.stringify(stored)).not.toContain("sk-secret");
});

test("an untouched provider carries its previous blob; '' clears it", () => {
  const prev = applyProviderKeyPatch([], [p("a", { apiKey: "k1" }), p("b", { apiKey: "k2" })], fakeCipher);
  // Renderer round-trip: no apiKey field at all (sanitized shape).
  const untouched = applyProviderKeyPatch(prev, [p("a"), p("b", { apiKey: "" })], fakeCipher);
  expect(untouched[0].apiKeyEnc).toBe(prev[0].apiKeyEnc);
  expect(untouched[1].apiKeyEnc).toBeUndefined();
});

test("retyping replaces the blob; transient renderer fields are stripped", () => {
  const prev = applyProviderKeyPatch([], [p("a", { apiKey: "old" })], fakeCipher);
  const next = applyProviderKeyPatch(
    prev,
    [p("a", { apiKey: "new", hasKey: true })],
    fakeCipher
  );
  expect(next[0].apiKeyEnc).not.toBe(prev[0].apiKeyEnc);
  expect(next[0].hasKey).toBeUndefined();
  expect(decryptProviders(next, fakeCipher)[0].apiKey).toBe("new");
});

test("without OS encryption the fallback is explicit ('plain:'), not silent loss", () => {
  const stored = applyProviderKeyPatch([], [p("a", { apiKey: "k" })], deadCipher);
  expect(stored[0].apiKeyEnc).toBe("plain:k");
  // decrypt path reads the plain fallback without touching the dead cipher
  expect(decryptProviders(stored, deadCipher)[0].apiKey).toBe("k");
});

test("sanitizeProviders exposes only hasKey — no secret reaches the renderer", () => {
  const stored = applyProviderKeyPatch(
    [],
    [p("a", { apiKey: "sk-secret" }), p("b")],
    fakeCipher
  );
  const sane = sanitizeProviders(stored);
  expect(sane[0]).toEqual({ id: "a", name: "a", baseUrl: "http://a", hasKey: true });
  expect(sane[1].hasKey).toBe(false);
  expect(JSON.stringify(sane)).not.toContain("sk-secret");
  expect(JSON.stringify(sane)).not.toContain("apiKeyEnc");
});

test("decryptProviders round-trips, and a corrupt blob degrades to 'no key'", () => {
  const stored = applyProviderKeyPatch([], [p("a", { apiKey: "sk-x" })], fakeCipher);
  expect(decryptProviders(stored, fakeCipher)[0].apiKey).toBe("sk-x");
  const corrupt = [p("a", { apiKeyEnc: "enc:%%%not-base64" })];
  const throwingCipher: SecretCipher = {
    ...fakeCipher,
    decrypt: () => {
      throw new Error("os key changed");
    }
  };
  const out = decryptProviders(corrupt, throwingCipher);
  expect(out[0].apiKey).toBeUndefined();
  expect(out[0].apiKeyEnc).toBeUndefined(); // blob never propagates in memory shape
});
