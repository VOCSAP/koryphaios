// C29 hardening: local-provider API keys encrypted at rest
// (desktop/src/main/provider-secrets) — fake cipher, scope-secrets pattern.

import { test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyProviderKeyPatch,
  decryptProviders,
  applySealedProviderPatch,
  hasPlainProviderKey,
  sanitizeProviders
} from "../desktop/src/main/provider-secrets.ts";
import { onDeckError } from "../desktop/src/main/log.ts";
import type { SecretCipher } from "../desktop/src/main/scope-secrets.ts";
import type { LocalProviderConfig } from "../desktop/src/shared/models.ts";
import { extractParenBody } from "./_braced-body.ts";

afterEach(() => onDeckError(() => {}));

/** Reversible fake cipher: "encryption" = byte-reversed string. */
const fakeCipher: SecretCipher = {
  isAvailable: () => true,
  encrypt: (plain) => Buffer.from([...plain].reverse().join("")),
  decrypt: (buf) => [...buf.toString()].reverse().join(""),
  isAvailableAsync: async () => true,
  encryptAsync: async (plain) => Buffer.from([...plain].reverse().join("")),
  decryptAsync: async (buf) => [...buf.toString()].reverse().join("")
};

const deadCipher: SecretCipher = {
  isAvailable: () => false,
  encrypt: () => {
    throw new Error("unavailable");
  },
  decrypt: () => {
    throw new Error("unavailable");
  },
  isAvailableAsync: async () => false,
  encryptAsync: async () => {
    throw new Error("unavailable");
  },
  decryptAsync: async () => {
    throw new Error("unavailable");
  }
};

function p(id: string, extra: Partial<LocalProviderConfig> = {}): LocalProviderConfig {
  return { id, name: id, baseUrl: `http://${id}`, ...extra };
}

test("a freshly typed key is encrypted at rest, never stored in clear", async () => {
  const stored = await applyProviderKeyPatch([], [p("a", { apiKey: "sk-secret" })], fakeCipher);
  expect(stored[0].apiKey).toBeUndefined();
  expect(stored[0].apiKeyEnc).toStartWith("enc:");
  expect(stored[0].apiKeyEnc).not.toContain("sk-secret");
  expect(JSON.stringify(stored)).not.toContain("sk-secret");
});

test("an untouched provider carries its previous blob; '' clears it", async () => {
  const prev = await applyProviderKeyPatch([], [p("a", { apiKey: "k1" }), p("b", { apiKey: "k2" })], fakeCipher);
  // Renderer round-trip: no apiKey field at all (sanitized shape).
  const untouched = await applyProviderKeyPatch(prev, [p("a"), p("b", { apiKey: "" })], fakeCipher);
  expect(untouched[0].apiKeyEnc).toBe(prev[0].apiKeyEnc);
  expect(untouched[1].apiKeyEnc).toBeUndefined();
});

test("retyping replaces the blob; transient renderer fields are stripped", async () => {
  const prev = await applyProviderKeyPatch([], [p("a", { apiKey: "old" })], fakeCipher);
  const next = await applyProviderKeyPatch(
    prev,
    [p("a", { apiKey: "new", hasKey: true })],
    fakeCipher
  );
  expect(next[0].apiKeyEnc).not.toBe(prev[0].apiKeyEnc);
  expect(next[0].hasKey).toBeUndefined();
  expect((await decryptProviders(next, fakeCipher))[0].apiKey).toBe("new");
});

test("without OS encryption the fallback is explicit ('plain:'), not silent loss", async () => {
  const stored = await applyProviderKeyPatch([], [p("a", { apiKey: "k" })], deadCipher);
  expect(stored[0].apiKeyEnc).toBe("plain:k");
  // decrypt path reads the plain fallback without touching the dead cipher
  expect((await decryptProviders(stored, deadCipher))[0].apiKey).toBe("k");
});

test("sanitizeProviders exposes only hasKey — no secret reaches the renderer", async () => {
  const stored = await applyProviderKeyPatch(
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

test("decryptProviders round-trips, and a corrupt blob degrades to 'no key' with a trace", async () => {
  const stored = await applyProviderKeyPatch([], [p("a", { apiKey: "sk-x" })], fakeCipher);
  expect((await decryptProviders(stored, fakeCipher))[0].apiKey).toBe("sk-x");
  const corrupt = [p("a", { apiKeyEnc: "enc:%%%not-base64" })];
  const throwingCipher: SecretCipher = {
    ...fakeCipher,
    decryptAsync: async () => {
      throw new Error("os key changed");
    }
  };
  const texts: string[] = [];
  onDeckError((_scope, text) => texts.push(text));
  const out = await decryptProviders(corrupt, throwingCipher);
  expect(out[0].apiKey).toBeUndefined();
  expect(out[0].apiKeyEnc).toBeUndefined(); // blob never propagates in memory shape
  expect(texts.some((text) => text.includes("stored provider key could not be decrypted")), "the failure is traced").toBe(true);
});

test("the keys go through the async cipher only", async () => {
  const removed = (): never => {
    throw new Error("the sync cipher must not be used");
  };
  const asyncOnly: SecretCipher = { ...fakeCipher, isAvailable: removed, encrypt: removed, decrypt: removed };
  const stored = await applyProviderKeyPatch([], [p("a", { apiKey: "sk-x" })], asyncOnly);
  expect((await decryptProviders(stored, asyncOnly))[0].apiKey).toBe("sk-x");
});

test("applySealedProviderPatch seals the provider keys and leaves every other field alone", async () => {
  let applied: { theme: string; localProviders?: LocalProviderConfig[] } | null = null;
  await applySealedProviderPatch(
    { theme: "dark", localProviders: [p("a", { apiKey: "sk-secret" })] },
    fakeCipher,
    () => [],
    (patch) => (applied = patch)
  );
  expect(applied!.theme).toBe("dark");
  expect(applied!.localProviders![0].apiKeyEnc).toStartWith("enc:");
  expect(hasPlainProviderKey(applied!.localProviders!)).toBe(false);
  expect(JSON.stringify(applied)).not.toContain("sk-secret");

  const untouched = { theme: "light" };
  expect(await applySealedProviderPatch(untouched, fakeCipher, () => [], (patch) => patch)).toBe(untouched);
});

test("a cipher failure while sealing rejects and applies nothing", async () => {
  const failing: SecretCipher = {
    ...fakeCipher,
    encryptAsync: async () => {
      throw new Error("encrypt failed");
    }
  };
  let calls = 0;
  await expect(
    applySealedProviderPatch({ localProviders: [p("a", { apiKey: "sk-x" })] }, failing, () => [], () => ++calls)
  ).rejects.toThrow("encrypt failed");
  expect(calls).toBe(0);
});

test("the stored providers are read and the patch applied in one synchronous step", async () => {
  let yielded = false;
  let yieldedAtApply: boolean | null = null;
  await applySealedProviderPatch(
    { localProviders: [p("a", { apiKey: "sk-x" })] },
    fakeCipher,
    () => {
      queueMicrotask(() => {
        yielded = true;
      });
      return [];
    },
    () => {
      yieldedAtApply = yielded;
    }
  );
  expect(yieldedAtApply, "no await may sit between the read of the stored providers and the apply").toBe(false);
});

test("two concurrent provider patches keep each other's new key, whichever seals slower", async () => {
  let stored: LocalProviderConfig[] = await applyProviderKeyPatch(
    [],
    [p("a", { apiKey: "ka0" }), p("b", { apiKey: "kb0" })],
    fakeCipher
  );
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow: SecretCipher = {
    ...fakeCipher,
    encryptAsync: async (plain) => {
      await gate;
      return fakeCipher.encryptAsync(plain);
    }
  };
  const apply = (patch: { localProviders?: LocalProviderConfig[] }): void => {
    stored = patch.localProviders!;
  };
  const read = (): LocalProviderConfig[] => stored;

  const first = applySealedProviderPatch({ localProviders: [p("a", { apiKey: "ka1" }), p("b")] }, slow, read, apply);
  const second = applySealedProviderPatch({ localProviders: [p("a"), p("b", { apiKey: "kb1" })] }, fakeCipher, read, apply);
  await second;
  release();
  await first;

  const keys = Object.fromEntries((await decryptProviders(stored, fakeCipher)).map((q) => [q.id, q.apiKey]));
  expect(keys).toEqual({ a: "ka1", b: "kb1" });
});

test("hasPlainProviderKey flags a transient apiKey, '' included, and nothing else", () => {
  expect(hasPlainProviderKey([p("a", { apiKey: "sk-x" })])).toBe(true);
  expect(hasPlainProviderKey([p("a", { apiKey: "" })])).toBe(true);
  expect(hasPlainProviderKey([p("a", { apiKeyEnc: "enc:AAAA" }), p("b")])).toBe(false);
  expect(hasPlainProviderKey([])).toBe(false);
});

test("config:set hands the sealing helper the live provider read and setConfig, and nothing else applies the patch", () => {
  const source = readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "ipc.ts"), "utf8").replace(/\r\n/g, "\n");
  const anchor = "regHandle('config:set'";
  const at = source.indexOf(anchor);
  expect(at, "ipc.ts must register config:set").toBeGreaterThanOrEqual(0);
  const handler = extractParenBody(source, at + "regHandle".length, true);
  const call = "await applySealedProviderPatch(";
  const callAt = handler.indexOf(call);
  expect(callAt, "the handler awaits the sealing helper").toBeGreaterThanOrEqual(0);
  const args = extractParenBody(handler, callAt + call.length - 1, true).replace(/\s+/g, " ");
  expect(args, "the stored providers are read live, inside the helper's synchronous step").toContain(
    "() => getConfig().localProviders ?? []"
  );
  expect(args.endsWith(", setConfig"), "the helper applies the patch through setConfig").toBe(true);
  expect(handler.replace(call, "").split("setConfig(").length - 1, "no other call applies a patch").toBe(0);
});
