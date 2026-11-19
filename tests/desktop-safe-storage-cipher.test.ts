import { afterEach, describe, expect, test } from "bun:test";
import { onDeckError } from "../desktop/src/main/log.ts";
import { createSafeStorageCipher, type SafeStorageLike } from "../desktop/src/main/safe-storage-cipher.ts";

const WITNESS = "witness-value-123";

interface FakeOptions {
  ready?: boolean;
  syncRemoved?: boolean;
  failAsync?: boolean;
  failSync?: boolean;
}

function fakeStorage(options: FakeOptions = {}): SafeStorageLike {
  const seal = (plain: string): Buffer => Buffer.from(`v10:${Buffer.from(plain).toString("base64")}`);
  const open = (buf: Buffer): string => Buffer.from(buf.toString().slice(4), "base64").toString();
  const removed = (): never => {
    throw new Error("the sync safeStorage API was removed");
  };
  const asyncFailure = (): Promise<never> => Promise.reject(new Error("async boom"));
  return {
    isEncryptionAvailable: () => (options.syncRemoved ? removed() : options.ready !== false),
    encryptString: (plain) => (options.syncRemoved ? removed() : options.failSync ? removed() : seal(plain)),
    decryptString: (buf) => (options.syncRemoved ? removed() : options.failSync ? removed() : open(buf)),
    isAsyncEncryptionAvailable: () => (options.failAsync ? asyncFailure() : Promise.resolve(options.ready !== false)),
    encryptStringAsync: (plain) => (options.failAsync ? asyncFailure() : Promise.resolve(seal(plain))),
    decryptStringAsync: (buf) =>
      options.failAsync ? asyncFailure() : Promise.resolve({ result: open(buf), shouldReEncrypt: false })
  };
}

const traces: Array<{ scope: string; text: string }> = [];
function captureTraces(): void {
  traces.length = 0;
  onDeckError((scope, text) => traces.push({ scope, text }));
}
afterEach(() => onDeckError(() => {}));

describe("async codec", () => {
  test("round trips a value without touching the sync API", async () => {
    const cipher = createSafeStorageCipher(fakeStorage({ syncRemoved: true }));
    const sealed = await cipher.encryptAsync(WITNESS);
    expect(await cipher.decryptAsync(sealed)).toBe(WITNESS);
  });

  test("reads back a buffer produced by the sync path", async () => {
    const cipher = createSafeStorageCipher(fakeStorage());
    expect(await cipher.decryptAsync(cipher.encrypt(WITNESS))).toBe(WITNESS);
  });

  test("is not available before the app is ready, and is once it is", async () => {
    expect(await createSafeStorageCipher(fakeStorage({ ready: false })).isAvailableAsync()).toBe(false);
    expect(await createSafeStorageCipher(fakeStorage({ ready: true })).isAvailableAsync()).toBe(true);
  });

  test.each([
    ["isAvailableAsync", (c: ReturnType<typeof createSafeStorageCipher>) => c.isAvailableAsync(), "isAsyncEncryptionAvailable"],
    ["encryptAsync", (c: ReturnType<typeof createSafeStorageCipher>) => c.encryptAsync(WITNESS), "encryptStringAsync"],
    ["decryptAsync", (c: ReturnType<typeof createSafeStorageCipher>) => c.decryptAsync(Buffer.from("v10:x")), "decryptStringAsync"]
  ])("%s traces a failure once and rejects with the original error", async (_name, call, operation) => {
    captureTraces();
    const cipher = createSafeStorageCipher(fakeStorage({ failAsync: true }));
    await expect(call(cipher)).rejects.toThrow("async boom");
    expect(traces).toHaveLength(1);
    expect(traces[0]!.scope).toBe("secrets");
    expect(traces[0]!.text, "the trace names the operation and the error class, never the error message").toBe(
      `safeStorage ${operation} failed: Error`
    );
  });

  test("a synchronous throw inside the async storage call is traced and rejected too", async () => {
    captureTraces();
    const storage = { ...fakeStorage(), encryptStringAsync: () => { throw new Error("sync throw"); } } as SafeStorageLike;
    await expect(createSafeStorageCipher(storage).encryptAsync(WITNESS)).rejects.toThrow("sync throw");
    expect(traces).toHaveLength(1);
  });

  test("a success leaves no trace", async () => {
    captureTraces();
    const cipher = createSafeStorageCipher(fakeStorage());
    await cipher.decryptAsync(await cipher.encryptAsync(WITNESS));
    await cipher.isAvailableAsync();
    expect(traces).toEqual([]);
  });
});

describe("sync codec", () => {
  test("keeps delegating to the storage, and a failure propagates untouched and untraced", () => {
    captureTraces();
    const cipher = createSafeStorageCipher(fakeStorage());
    expect(cipher.isAvailable()).toBe(true);
    expect(cipher.decrypt(cipher.encrypt(WITNESS))).toBe(WITNESS);
    const failing = createSafeStorageCipher(fakeStorage({ failSync: true }));
    expect(() => failing.decrypt(Buffer.from("v10:x"))).toThrow("sync safeStorage API was removed");
    expect(traces).toEqual([]);
  });
});
