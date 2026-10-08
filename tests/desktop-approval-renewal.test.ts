import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalRuntime, approvalCredFileName } from "../desktop/src/main/approval-runtime.ts";
import { onDeckError } from "../desktop/src/main/log.ts";
import type { SecretCipher } from "../desktop/src/main/scope-secrets.ts";

const dirs: string[] = [];
const originalFetch = globalThis.fetch;
const projectKey = "github.com/vocsap/koryphaios";
const renewalDelayMs = 6 * 3600_000;

const cipher: SecretCipher = {
  isAvailable: () => true,
  encrypt: (value: string) => Buffer.from(value),
  decrypt: (value: Buffer) => value.toString()
};

interface PlannedTimer {
  callback: () => void;
  delayMs: number;
  cleared: boolean;
}

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cp-approval-renewal-"));
  dirs.push(dir);
  return dir;
}

function clock() {
  const planned: PlannedTimer[] = [];
  let now = Date.parse("2030-01-01T00:00:00.000Z");
  return {
    planned,
    setNow(value: number): void {
      now = value;
    },
    options: {
      renewalIntervalMs: renewalDelayMs,
      now: () => now,
      setTimeout(callback: () => void, delayMs: number): PlannedTimer {
        const timer = { callback, delayMs, cleared: false };
        planned.push(timer);
        return timer;
      },
      clearTimeout(timer: unknown): void {
        (timer as PlannedTimer).cleared = true;
      }
    }
  };
}

function runtime(
  stateDir: string,
  runId: string,
  timing: ReturnType<typeof clock>,
  resolveProjectKey: () => string = () => projectKey
): ApprovalRuntime {
  return new ApprovalRuntime({
    stateDir,
    cipher,
    endpoint: () => ({ url: "http://broker.local", token: "" }),
    runId,
    host: "test-host",
    projectKey: resolveProjectKey,
    ...timing.options
  });
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  onDeckError(() => {});
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("ApprovalRuntime token renewal", () => {
  test("a broker without renew_only capability arms once without scheduling renewal", async () => {
    const timing = clock();
    const errors: string[] = [];
    onDeckError((_scope, text) => errors.push(text));
    globalThis.fetch = (async (input) => {
      const path = new URL(String(input)).pathname;
      expect(path).toBe("/approval/token-mint");
      return response({ token_id: "token-old-broker", expires_at: "2030-01-02T00:00:00.000Z" });
    }) as typeof fetch;
    const dir = stateDir();
    const instance = runtime(dir, "old-broker", timing);

    expect(await instance.arm()).toBe(true);
    expect(existsSync(join(dir, approvalCredFileName(projectKey, "old-broker")))).toBe(true);
    expect(timing.planned).toHaveLength(0);
    expect(errors).toEqual(["broker does not support approval token renewal; renewal is disabled for this run"]);
  });

  test("one scheduled renewal keeps the credential file unchanged and schedules its successor", async () => {
    const timing = clock();
    let renewRequests = 0;
    let signalRenewalStarted = (): void => {};
    const renewalStarted = new Promise<void>((resolve) => {
      signalRenewalStarted = resolve;
    });
    let resolveRenewal = (_value: Response): void => {};
    const renewalResponse = new Promise<Response>((resolve) => {
      resolveRenewal = resolve;
    });
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (path === "/approval/token-mint" && body.renew_only === true) {
        renewRequests += 1;
        signalRenewalStarted();
        return renewalResponse;
      }
      if (path === "/approval/token-mint") {
        return response({
          token_id: "token-renewing",
          expires_at: "2030-01-02T00:00:00.000Z",
          capabilities: { renew_only: true }
        });
      }
      return response({ revoked: 1 });
    }) as typeof fetch;
    const dir = stateDir();
    const instance = runtime(dir, "renewing", timing);

    expect(await instance.arm()).toBe(true);
    const credential = join(dir, approvalCredFileName(projectKey, "renewing"));
    const before = readFileSync(credential, "utf8");
    expect(timing.planned).toEqual([expect.objectContaining({ delayMs: renewalDelayMs, cleared: false })]);

    timing.planned[0]!.callback();
    await renewalStarted;
    timing.planned[0]!.callback();
    expect(renewRequests).toBe(1);
    expect(readFileSync(credential, "utf8")).toBe(before);

    resolveRenewal(response({
      token_id: "token-renewing",
      expires_at: "2030-01-03T00:00:00.000Z",
      capabilities: { renew_only: true }
    }));
    await nextTurn();
    expect(timing.planned).toEqual([
      expect.objectContaining({ delayMs: renewalDelayMs, cleared: false }),
      expect.objectContaining({ delayMs: renewalDelayMs, cleared: false })
    ]);

    const successor = timing.planned[1]!;
    await instance.disarm();
    expect(successor.cleared).toBe(true);
  });

  test("a failed renewal is traced and retried before the token expires", async () => {
    const timing = clock();
    const errors: string[] = [];
    onDeckError((_scope, text) => errors.push(text));
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (path === "/approval/token-mint" && body.renew_only === true) {
        return new Response(JSON.stringify({ error: "broker unavailable" }), { status: 503 });
      }
      if (path === "/approval/token-mint") {
        return response({
          token_id: "token-retry",
          expires_at: "2030-01-02T00:00:00.000Z",
          capabilities: { renew_only: true }
        });
      }
      return response({ revoked: 1 });
    }) as typeof fetch;
    const instance = runtime(stateDir(), "retry", timing);

    expect(await instance.arm()).toBe(true);
    timing.planned[0]!.callback();
    await nextTurn();
    expect(errors).toEqual([
      "could not renew the session credential: /approval/token-mint failed: broker unavailable: 503"
    ]);
    expect(timing.planned).toEqual([
      expect.objectContaining({ cleared: false }),
      expect.objectContaining({ delayMs: renewalDelayMs, cleared: false })
    ]);

    const retry = timing.planned[1]!;
    await instance.disarm();
    expect(retry.cleared).toBe(true);
  });

  test("a renewal retry stops at expiry and keeps the same session public key", async () => {
    const timing = clock();
    const renewalPublicKeys: unknown[] = [];
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (path === "/approval/token-mint" && body.renew_only === true) {
        renewalPublicKeys.push(body.session_public_key);
        return new Response(JSON.stringify({ error: "broker unavailable" }), { status: 503 });
      }
      if (path === "/approval/token-mint") {
        return response({
          token_id: "token-expired-retry",
          expires_at: "2030-01-02T00:00:00.000Z",
          capabilities: { renew_only: true }
        });
      }
      return response({ revoked: 1 });
    }) as typeof fetch;
    const instance = runtime(stateDir(), "expired-retry", timing);

    expect(await instance.arm()).toBe(true);
    timing.planned[0]!.callback();
    await nextTurn();
    timing.planned[1]!.callback();
    await nextTurn();
    expect(renewalPublicKeys).toHaveLength(2);
    expect(renewalPublicKeys[0]).toEqual(expect.any(String));
    expect(renewalPublicKeys[1]).toBe(renewalPublicKeys[0]);

    timing.setNow(Date.parse("2030-01-02T00:00:00.000Z"));
    timing.planned[2]!.callback();
    await nextTurn();
    expect(renewalPublicKeys).toHaveLength(2);
    expect(timing.planned).toHaveLength(3);
    await instance.disarm();
  });

  test("a renewal keeps the project scope selected at arm time", async () => {
    const timing = clock();
    let currentProjectKey = projectKey;
    const renewalProjectKeys: unknown[] = [];
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (path === "/approval/token-mint" && body.renew_only === true) {
        renewalProjectKeys.push(body.project_key);
        return response({
          token_id: "token-frozen-project",
          expires_at: "2030-01-03T00:00:00.000Z",
          capabilities: { renew_only: true }
        });
      }
      if (path === "/approval/token-mint") {
        return response({
          token_id: "token-frozen-project",
          expires_at: "2030-01-02T00:00:00.000Z",
          capabilities: { renew_only: true }
        });
      }
      return response({ revoked: 1 });
    }) as typeof fetch;
    const instance = runtime(stateDir(), "frozen-project", timing, () => currentProjectKey);

    expect(await instance.arm()).toBe(true);
    currentProjectKey = "github.com/vocsap/changed-project";
    timing.planned[0]!.callback();
    await nextTurn();
    expect(renewalProjectKeys).toEqual([projectKey]);
    await instance.disarm();
  });

  test("an invalid initial renewal expiry keeps the credential armed without a timer", async () => {
    const timing = clock();
    const errors: string[] = [];
    onDeckError((_scope, text) => errors.push(text));
    for (const [index, expiresAt] of [undefined, 7, "not-an-iso-date", "2030-01-02T00:00:00Z", "2029-12-31T23:59:59.999Z"].entries()) {
      globalThis.fetch = (async (_input) => response({
        token_id: "token-invalid-initial-expiry",
        expires_at: expiresAt,
        capabilities: { renew_only: true }
      })) as typeof fetch;
      const instance = runtime(stateDir(), `invalid-initial-${index}`, timing);

      expect(await instance.arm()).toBe(true);
      expect(timing.planned).toHaveLength(0);
    }
    expect(errors).toEqual([
      "broker returned an invalid approval token expiry; renewal is disabled for this run",
      "broker returned an invalid approval token expiry; renewal is disabled for this run",
      "broker returned an invalid approval token expiry; renewal is disabled for this run",
      "broker returned an invalid approval token expiry; renewal is disabled for this run",
      "broker returned an invalid approval token expiry; renewal is disabled for this run"
    ]);
  });

  test("an invalid renewed expiry stops scheduling and traces the broker response", async () => {
    const timing = clock();
    const errors: string[] = [];
    onDeckError((_scope, text) => errors.push(text));
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (path === "/approval/token-mint" && body.renew_only === true) {
        return response({ token_id: "token-invalid-renewal-expiry", expires_at: "not-an-iso-date" });
      }
      if (path === "/approval/token-mint") {
        return response({
          token_id: "token-invalid-renewal-expiry",
          expires_at: "2030-01-02T00:00:00.000Z",
          capabilities: { renew_only: true }
        });
      }
      return response({ revoked: 1 });
    }) as typeof fetch;
    const instance = runtime(stateDir(), "invalid-renewal-expiry", timing);

    expect(await instance.arm()).toBe(true);
    timing.planned[0]!.callback();
    await nextTurn();
    expect(timing.planned).toHaveLength(1);
    expect(errors).toEqual(["broker returned an invalid approval token expiry; renewal is disabled for this run"]);
    await instance.disarm();
  });

  test("disarm invalidates an in-flight renewal and clears its timer before a re-arm", async () => {
    const timing = clock();
    let renewRequests = 0;
    let signalRenewalStarted = (): void => {};
    const renewalStarted = new Promise<void>((resolve) => {
      signalRenewalStarted = resolve;
    });
    let resolveRenewal = (_value: Response): void => {};
    const renewalResponse = new Promise<Response>((resolve) => {
      resolveRenewal = resolve;
    });
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (path === "/approval/token-mint" && body.renew_only === true) {
        renewRequests += 1;
        if (renewRequests === 1) {
          signalRenewalStarted();
          return renewalResponse;
        }
        return response({
          token_id: "token-rearmed",
          expires_at: "2030-01-03T00:00:00.000Z",
          capabilities: { renew_only: true }
        });
      }
      if (path === "/approval/token-mint") {
        return response({
          token_id: "token-rearmed",
          expires_at: "2030-01-02T00:00:00.000Z",
          capabilities: { renew_only: true }
        });
      }
      return response({ revoked: 1 });
    }) as typeof fetch;
    const dir = stateDir();
    const instance = runtime(dir, "rearm", timing);

    expect(await instance.arm()).toBe(true);
    expect(timing.planned).toHaveLength(1);
    const staleTimer = timing.planned[0]!;
    staleTimer.callback();
    await renewalStarted;
    const disarming = instance.disarm();
    resolveRenewal(response({
      token_id: "token-rearmed",
      expires_at: "2030-01-03T00:00:00.000Z",
      capabilities: { renew_only: true }
    }));
    await disarming;
    expect(timing.planned).toHaveLength(1);

    expect(await instance.arm()).toBe(true);
    expect(timing.planned).toHaveLength(2);
    const freshTimer = timing.planned[1]!;
    staleTimer.callback();
    expect(renewRequests).toBe(1);

    await instance.close();
    expect(freshTimer.cleared).toBe(true);
  });

  test("disarm aborts a hung renewal before removing its credential", async () => {
    const timing = clock();
    let renewRequests = 0;
    let renewalSignal: AbortSignal | undefined;
    let signalRenewalStarted = (): void => {};
    const renewalStarted = new Promise<void>((resolve) => {
      signalRenewalStarted = resolve;
    });
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (path === "/approval/token-mint" && body.renew_only === true) {
        renewRequests += 1;
        if (renewRequests === 1) {
          renewalSignal = init?.signal ?? undefined;
          signalRenewalStarted();
          return new Promise<Response>(() => {});
        }
        return response({
          token_id: "token-after-hung-renewal",
          expires_at: "2030-01-03T00:00:00.000Z",
          capabilities: { renew_only: true }
        });
      }
      if (path === "/approval/token-mint") {
        return response({
          token_id: "token-after-hung-renewal",
          expires_at: "2030-01-02T00:00:00.000Z",
          capabilities: { renew_only: true }
        });
      }
      return response({ revoked: 1 });
    }) as typeof fetch;
    const dir = stateDir();
    const instance = runtime(dir, "hung-renewal", timing);

    expect(await instance.arm()).toBe(true);
    timing.planned[0]!.callback();
    await renewalStarted;
    await Promise.race([
      instance.disarm(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("disarm timed out")), 50))
    ]);
    expect(renewalSignal?.aborted).toBe(true);
    expect(existsSync(join(dir, approvalCredFileName(projectKey, "hung-renewal")))).toBe(false);

    expect(await instance.arm()).toBe(true);
    timing.planned[1]!.callback();
    await nextTurn();
    expect(renewRequests).toBe(2);
    await instance.disarm();
  });
});
