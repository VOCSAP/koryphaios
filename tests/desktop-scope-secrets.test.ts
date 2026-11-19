import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractParenBody } from "./_braced-body.ts";
import { onDeckError } from "../desktop/src/main/log.ts";

// scope-secrets.ts imports only node builtins (the Electron safeStorage cipher
// is injected), so it imports cleanly under bun. We inject a reversible fake
// cipher to cover the keying, fallback, and corrupt-file behaviour (D8).
import {
  type SecretCipher,
  rememberScopeSecret,
  recallScopeSecret,
  forgetScopeSecret,
} from "../desktop/src/main/scope-secrets.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  onDeckError(() => {});
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch (error) {
      console.warn(`cleanup of ${d} failed`, error);
    }
  }
});

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cp-secrets-"));
  tmpDirs.push(d);
  return d;
}

// Reversible fake: "encrypt" by reversing the string into a Buffer. Proves the
// stored blob is not the plaintext and that decrypt round-trips.
const fakeCipher: SecretCipher = {
  isAvailableAsync: async () => true,
  encryptAsync: async (plain) => Buffer.from([...plain].reverse().join(""), "utf8"),
  decryptAsync: async (buf) => [...buf.toString("utf8")].reverse().join(""),
};

const unavailableCipher: SecretCipher = {
  isAvailableAsync: async () => false,
  encryptAsync: async () => {
    throw new Error("must not be called");
  },
  decryptAsync: async () => {
    throw new Error("must not be called");
  },
};

test("remember then recall round-trips the secret, keyed by groupId", async () => {
  const dir = freshDir();
  expect(await rememberScopeSecret(dir, fakeCipher, "gid-A", "super-secret")).toBe(true);
  expect(await recallScopeSecret(dir, fakeCipher, "gid-A")).toBe("super-secret");
});

test("the plaintext secret is never written to disk", async () => {
  const dir = freshDir();
  await rememberScopeSecret(dir, fakeCipher, "gid-A", "super-secret");
  const raw = readFileSync(join(dir, "scope-secrets.json"), "utf8");
  expect(raw).not.toContain("super-secret");
});

test("recall returns null for an unknown groupId", async () => {
  const dir = freshDir();
  await rememberScopeSecret(dir, fakeCipher, "gid-A", "s");
  expect(await recallScopeSecret(dir, fakeCipher, "gid-OTHER")).toBeNull();
});

test("an unavailable cipher makes remember a no-op and recall null", async () => {
  const dir = freshDir();
  expect(await rememberScopeSecret(dir, unavailableCipher, "gid-A", "s")).toBe(false);
  expect(existsSync(join(dir, "scope-secrets.json"))).toBe(false);
  expect(await recallScopeSecret(dir, unavailableCipher, "gid-A")).toBeNull();
});

test("the store does nothing while the cipher is unavailable before ready, and works once it is", async () => {
  const dir = freshDir();
  let ready = false;
  const lateCipher: SecretCipher = { ...fakeCipher, isAvailableAsync: async () => ready };
  expect(await rememberScopeSecret(dir, lateCipher, "gid-A", "s")).toBe(false);
  expect(existsSync(join(dir, "scope-secrets.json"))).toBe(false);
  expect(await recallScopeSecret(dir, lateCipher, "gid-A")).toBeNull();
  ready = true;
  expect(await rememberScopeSecret(dir, lateCipher, "gid-A", "s")).toBe(true);
  expect(await recallScopeSecret(dir, lateCipher, "gid-A")).toBe("s");
});

test("a decrypt failure surfaces as null, not a throw, and is traced without any value", async () => {
  const dir = freshDir();
  const texts: string[] = [];
  onDeckError((_scope, text) => texts.push(text));
  const throwingDecrypt: SecretCipher = {
    isAvailableAsync: async () => true,
    encryptAsync: async (p) => Buffer.from(p, "utf8"),
    decryptAsync: async () => {
      throw new Error("OS key changed");
    },
  };
  await rememberScopeSecret(dir, throwingDecrypt, "gid-A", "s");
  expect(await recallScopeSecret(dir, throwingDecrypt, "gid-A")).toBeNull();
  expect(texts).toEqual(["a remembered scope secret could not be decrypted: Error"]);
});

test("a corrupt store file is treated as empty, never throws", async () => {
  const dir = freshDir();
  writeFileSync(join(dir, "scope-secrets.json"), "{ not valid json");
  expect(await recallScopeSecret(dir, fakeCipher, "gid-A")).toBeNull();
  // and a subsequent remember still works (overwrites the garbage)
  expect(await rememberScopeSecret(dir, fakeCipher, "gid-A", "s")).toBe(true);
  expect(await recallScopeSecret(dir, fakeCipher, "gid-A")).toBe("s");
});

test("forget drops a stored secret and is a no-op when absent", async () => {
  const dir = freshDir();
  await rememberScopeSecret(dir, fakeCipher, "gid-A", "s");
  await rememberScopeSecret(dir, fakeCipher, "gid-B", "t");
  forgetScopeSecret(dir, "gid-A");
  expect(await recallScopeSecret(dir, fakeCipher, "gid-A")).toBeNull();
  expect(await recallScopeSecret(dir, fakeCipher, "gid-B")).toBe("t");
  // no-op when absent
  forgetScopeSecret(dir, "gid-A");
  expect(await recallScopeSecret(dir, fakeCipher, "gid-B")).toBe("t");
});

test("index remembers the scope secret only inside the whenReady handler", () => {
  const source = readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "index.ts"), "utf8");
  const anchor = "app.whenReady().then(";
  const at = source.indexOf(anchor);
  expect(at, "index.ts must start the app from app.whenReady().then(").toBeGreaterThanOrEqual(0);
  const open = at + anchor.length - 1;
  const handler = extractParenBody(source, open, true);
  const call = "void rememberScopeSecret(";
  const callAt = handler.indexOf(call);
  expect(callAt, "the remember call lives in the ready handler, never awaited: startup must not wait on the cipher").toBeGreaterThanOrEqual(0);
  const args = extractParenBody(handler, callAt + call.length - 1, true);
  expect(
    handler.slice(callAt + call.length + args.length + 1).startsWith(".catch("),
    "a failure of the floating remember is traced"
  ).toBe(true);
  expect(source.slice(0, at), "no remember call before the ready handler: the cipher is unavailable then").not.toContain("rememberScopeSecret(");
  expect(source.slice(open + handler.length + 2)).not.toContain("rememberScopeSecret(");
  expect(source, "the scope resolution waits for the recall").toContain("await recallScopeSecret(");
});
