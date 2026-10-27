import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalRuntime, approvalCredFileName } from "../desktop/src/main/approval-runtime.ts";
import { deriveTokenId } from "../desktop/src/main/approval-auth.ts";
import { onDeckError } from "../desktop/src/main/log.ts";
import type { SecretCipher } from "../desktop/src/main/scope-secrets.ts";
import { reachedWithin } from "./_bounded-await.ts";
import { withOperatorTrustBroker } from "./_operator-trust-broker.ts";

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
    groupId: () => "g-renewal",
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
    globalThis.fetch = withOperatorTrustBroker((async (input) => {
      const path = new URL(String(input)).pathname;
      expect(path).toBe("/approval/token-mint");
      return response({ token_id: "token-old-broker", expires_at: "2030-01-02T00:00:00.000Z", capabilities: { inbox_provenance: 1 } });
    }) as typeof fetch);
    const dir = stateDir();
    const instance = runtime(dir, "old-broker", timing);

    expect(await instance.arm()).toBe(true);
    expect(existsSync(join(dir, approvalCredFileName(projectKey, "old-broker", "g-renewal")))).toBe(true);
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
    globalThis.fetch = withOperatorTrustBroker((async (input, init) => {
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
          capabilities: { renew_only: true, inbox_provenance: 1 }
        });
      }
      return response({ revoked: 1 });
    }) as typeof fetch);
    const dir = stateDir();
    const instance = runtime(dir, "renewing", timing);

    expect(await instance.arm()).toBe(true);
    const credential = join(dir, approvalCredFileName(projectKey, "renewing", "g-renewal"));
    const before = readFileSync(credential, "utf8");
    expect(timing.planned).toEqual([expect.objectContaining({ delayMs: renewalDelayMs, cleared: false })]);

    timing.planned[0]!.callback();
    await reachedWithin(renewalStarted, "the renewal request reaches the broker");
    timing.planned[0]!.callback();
    expect(renewRequests).toBe(1);
    expect(readFileSync(credential, "utf8")).toBe(before);

    resolveRenewal(response({
      token_id: "token-renewing",
      expires_at: "2030-01-03T00:00:00.000Z",
      capabilities: { renew_only: true, inbox_provenance: 1 }
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
    globalThis.fetch = withOperatorTrustBroker((async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (path === "/approval/token-mint" && body.renew_only === true) {
        return new Response(JSON.stringify({ error: "broker unavailable" }), { status: 503 });
      }
      if (path === "/approval/token-mint") {
        return response({
          token_id: "token-retry",
          expires_at: "2030-01-02T00:00:00.000Z",
          capabilities: { renew_only: true, inbox_provenance: 1 }
        });
      }
      return response({ revoked: 1 });
    }) as typeof fetch);
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
    globalThis.fetch = withOperatorTrustBroker((async (input, init) => {
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
          capabilities: { renew_only: true, inbox_provenance: 1 }
        });
      }
      return response({ revoked: 1 });
    }) as typeof fetch);
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
    globalThis.fetch = withOperatorTrustBroker((async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (path === "/approval/token-mint" && body.renew_only === true) {
        renewalProjectKeys.push(body.project_key);
        return response({
          token_id: "token-frozen-project",
          expires_at: "2030-01-03T00:00:00.000Z",
          capabilities: { renew_only: true, inbox_provenance: 1 }
        });
      }
      if (path === "/approval/token-mint") {
        return response({
          token_id: "token-frozen-project",
          expires_at: "2030-01-02T00:00:00.000Z",
          capabilities: { renew_only: true, inbox_provenance: 1 }
        });
      }
      return response({ revoked: 1 });
    }) as typeof fetch);
    const instance = runtime(stateDir(), "frozen-project", timing, () => currentProjectKey);

    expect(await instance.arm()).toBe(true);
    currentProjectKey = "github.com/vocsap/changed-project";
    timing.planned[0]!.callback();
    await nextTurn();
    expect(renewalProjectKeys).toEqual([projectKey]);
    await instance.disarm();
  });

  test("a renewal of a prepared root keeps the project of its ticket, not the runtime resolver", async () => {
    const timing = clock();
    const ticketProject = "github.com/vocsap/ticket-project";
    const renewalProjectKeys: unknown[] = [];
    globalThis.fetch = withOperatorTrustBroker((async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (path === "/approval/token-mint" && body.renew_only === true) {
        renewalProjectKeys.push(body.project_key);
        return response({
          token_id: "token-ticket-project",
          expires_at: "2030-01-03T00:00:00.000Z",
          capabilities: { renew_only: true, inbox_provenance: 1 }
        });
      }
      if (path === "/approval/token-mint") {
        return response({
          token_id: "token-ticket-project",
          expires_at: "2030-01-02T00:00:00.000Z",
          capabilities: { renew_only: true, inbox_provenance: 1 }
        });
      }
      return response({ revoked: 1 });
    }) as typeof fetch);
    const instance = runtime(stateDir(), "ticket-project", timing, () => "github.com/vocsap/resolver-project");

    const prepared = await instance.prepareScope({ projectKey: ticketProject, groupId: "g-renewal" });
    if (prepared.state !== "ready") throw new Error(`preparation refused: ${prepared.cause}`);
    const installed = prepared.install();
    if (installed.state !== "ready") throw new Error(`install refused: ${installed.cause}`);
    installed.publish();

    expect(timing.planned, "publishing a renewable root schedules its renewal").toHaveLength(1);
    timing.planned[0]!.callback();
    await nextTurn();
    expect(renewalProjectKeys).toEqual([ticketProject]);
    await instance.disarm();
  });

  test("an invalid initial renewal expiry refuses the credential", async () => {
    const timing = clock();
    const errors: string[] = [];
    onDeckError((_scope, text) => errors.push(text));
    for (const [index, expiresAt] of [undefined, 7, "not-an-iso-date", "2030-01-02T00:00:00Z", "2029-12-31T23:59:59.999Z"].entries()) {
      globalThis.fetch = withOperatorTrustBroker((async (_input) => response({
        token_id: "token-invalid-initial-expiry",
        expires_at: expiresAt,
        capabilities: { renew_only: true, inbox_provenance: 1 }
      })) as typeof fetch);
      const instance = runtime(stateDir(), `invalid-initial-${index}`, timing);

      expect(await instance.arm()).toBe(false);
      expect(timing.planned).toHaveLength(0);
    }
    expect(errors).toEqual([
      "broker did not return a valid session token identity and expiry; prepared scope is unavailable",
      "broker did not return a valid session token identity and expiry; prepared scope is unavailable",
      "broker did not return a valid session token identity and expiry; prepared scope is unavailable",
      "broker did not return a valid session token identity and expiry; prepared scope is unavailable",
      "broker did not return a valid session token identity and expiry; prepared scope is unavailable"
    ]);
  });

  test("an invalid renewed expiry stops scheduling and traces the broker response", async () => {
    const timing = clock();
    const errors: string[] = [];
    onDeckError((_scope, text) => errors.push(text));
    globalThis.fetch = withOperatorTrustBroker((async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (path === "/approval/token-mint" && body.renew_only === true) {
        return response({ token_id: "token-invalid-renewal-expiry", expires_at: "not-an-iso-date" });
      }
      if (path === "/approval/token-mint") {
        return response({
          token_id: "token-invalid-renewal-expiry",
          expires_at: "2030-01-02T00:00:00.000Z",
          capabilities: { renew_only: true, inbox_provenance: 1 }
        });
      }
      return response({ revoked: 1 });
    }) as typeof fetch);
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
    globalThis.fetch = withOperatorTrustBroker((async (input, init) => {
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
          capabilities: { renew_only: true, inbox_provenance: 1 }
        });
      }
      if (path === "/approval/token-mint") {
        return response({
          token_id: "token-rearmed",
          expires_at: "2030-01-02T00:00:00.000Z",
          capabilities: { renew_only: true, inbox_provenance: 1 }
        });
      }
      return response({ revoked: 1 });
    }) as typeof fetch);
    const dir = stateDir();
    const instance = runtime(dir, "rearm", timing);

    expect(await instance.arm()).toBe(true);
    expect(timing.planned).toHaveLength(1);
    const staleTimer = timing.planned[0]!;
    staleTimer.callback();
    await reachedWithin(renewalStarted, "the renewal request reaches the broker");
    const disarming = instance.disarm();
    resolveRenewal(response({
      token_id: "token-rearmed",
      expires_at: "2030-01-03T00:00:00.000Z",
      capabilities: { renew_only: true, inbox_provenance: 1 }
    }));
    await reachedWithin(disarming, "disarm settles once the in-flight renewal resolves");
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
    globalThis.fetch = withOperatorTrustBroker((async (input, init) => {
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
          capabilities: { renew_only: true, inbox_provenance: 1 }
        });
      }
      if (path === "/approval/token-mint") {
        return response({
          token_id: "token-after-hung-renewal",
          expires_at: "2030-01-02T00:00:00.000Z",
          capabilities: { renew_only: true, inbox_provenance: 1 }
        });
      }
      return response({ revoked: 1 });
    }) as typeof fetch);
    const dir = stateDir();
    const instance = runtime(dir, "hung-renewal", timing);

    expect(await instance.arm()).toBe(true);
    timing.planned[0]!.callback();
    await reachedWithin(renewalStarted, "the renewal request reaches the broker");
    await Promise.race([
      instance.disarm(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("disarm timed out")), 50))
    ]);
    expect(renewalSignal?.aborted).toBe(true);
    expect(existsSync(join(dir, approvalCredFileName(projectKey, "hung-renewal", "g-renewal")))).toBe(false);

    expect(await instance.arm()).toBe(true);
    timing.planned[1]!.callback();
    await nextTurn();
    expect(renewRequests).toBe(2);
    await instance.disarm();
  });
});

describe("ApprovalRuntime run mandates", () => {
  interface Recorded {
    path: string;
    body: Record<string, unknown>;
  }

  function mandateBroker(opts: {
    holdMandateMint?: Promise<void>;
    failMandateRenewal?: boolean;
    failFirstMandateMint?: boolean;
    hungRenewalSignals?: Array<AbortSignal | undefined>;
    hungRenewalCaller?: string;
  } = {}): Recorded[] {
    const requests: Recorded[] = [];
    let mandateMintCount = 0;
    globalThis.fetch = withOperatorTrustBroker((async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ path, body });
      if (path !== "/approval/token-mint") return response({ revoked: 1 });
      const inbox = body.inbox as { kind?: string; caller_ref?: string } | undefined;
      if (inbox?.kind === "mandate") {
        if (body.renew_only === true) {
          if (opts.hungRenewalSignals && (opts.hungRenewalCaller === undefined || inbox.caller_ref === opts.hungRenewalCaller)) {
            opts.hungRenewalSignals.push(init?.signal ?? undefined);
            return new Promise<Response>(() => {});
          }
          if (opts.failMandateRenewal) return new Response(JSON.stringify({ error: "not renewable" }), { status: 409 });
          return response({ token_id: "m", expires_at: "2030-01-03T00:00:00.000Z", capabilities: { renew_only: true, inbox_provenance: 1 } });
        }
        mandateMintCount += 1;
        if (opts.failFirstMandateMint && mandateMintCount === 1) {
          return new Response(JSON.stringify({ error: "mandate parent is not a live run token" }), { status: 409 });
        }
        if (opts.holdMandateMint) await opts.holdMandateMint;
        return response({ token_id: "m", expires_at: "2030-01-02T00:00:00.000Z", capabilities: { renew_only: true, inbox_provenance: 1 } });
      }
      return response({
        token_id: "root",
        expires_at: body.renew_only === true ? "2030-01-03T00:00:00.000Z" : "2030-01-02T00:00:00.000Z",
        capabilities: { renew_only: true, inbox_provenance: 1 }
      });
    }) as typeof fetch);
    return requests;
  }

  const rootMints = (r: Recorded[]) =>
    r.filter((x) => x.path === "/approval/token-mint" && (x.body.inbox as { kind?: string }).kind === "run" && x.body.renew_only !== true);
  const mandateMints = (r: Recorded[]) =>
    r.filter((x) => x.path === "/approval/token-mint" && (x.body.inbox as { kind?: string }).kind === "mandate" && x.body.renew_only !== true);
  const mandateRenewals = (r: Recorded[]) =>
    r.filter((x) => x.path === "/approval/token-mint" && (x.body.inbox as { kind?: string }).kind === "mandate" && x.body.renew_only === true);

  async function until(cond: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 50 && !cond(); i++) await nextTurn();
    expect(cond(), what).toBe(true);
  }

  test("a mandate requested before the run credential is minted under it, with the provisioned authority", async () => {
    const requests = mandateBroker();
    const instance = runtime(stateDir(), "mandate-ready", clock());
    instance.requestMandate("team-lead-ab12", "lead");
    expect(instance.mandateState("team-lead-ab12")).toEqual({ state: "pending" });

    expect(await instance.arm()).toBe(true);
    await until(() => instance.mandateState("team-lead-ab12")?.state === "ready", "the mandate becomes ready");
    const rootToken = deriveTokenId(rootMints(requests)[0]!.body.session_public_key as string);
    expect(mandateMints(requests)[0]!.body.inbox).toEqual({
      version: 1,
      kind: "mandate",
      parent_token_id: rootToken,
      caller_ref: "team-lead-ab12",
      authority: "lead"
    });
    await instance.disarm();
  });

  test("a mandate released while its mint is in flight is revoked on arrival and never becomes ready", async () => {
    let release = (): void => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requests = mandateBroker({ holdMandateMint: hold });
    const instance = runtime(stateDir(), "mandate-late", clock());
    expect(await instance.arm()).toBe(true);
    instance.requestMandate("caller-1", "author");
    await until(() => mandateMints(requests).length === 1, "the mandate mint reaches the broker");

    instance.releaseMandate("caller-1");
    release();
    const lateToken = deriveTokenId(mandateMints(requests)[0]!.body.session_public_key as string);
    await until(
      () => requests.some((r) => r.path === "/approval/token-revoke" && r.body.token_id === lateToken),
      "the late mandate token is revoked"
    );
    expect(instance.mandateState("caller-1")).toBeNull();
    await instance.disarm();
  });

  test("a mandate whose mint is in flight when the run credential is dropped is revoked on arrival and stays pending", async () => {
    let release = (): void => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requests = mandateBroker({ holdMandateMint: hold });
    const instance = runtime(stateDir(), "mandate-dropped-in-flight", clock());
    expect(await instance.arm()).toBe(true);
    instance.requestMandate("caller-d", "author");
    await until(() => mandateMints(requests).length === 1, "the mandate mint reaches the broker");

    await instance.disarm();
    release();
    const lateToken = deriveTokenId(mandateMints(requests)[0]!.body.session_public_key as string);
    await until(
      () => requests.some((r) => r.path === "/approval/token-revoke" && r.body.token_id === lateToken),
      "the late mandate token is revoked"
    );
    expect(instance.mandateState("caller-d")).toEqual({ state: "pending" });
  });

  test("a renewal of the run credential renews each ready mandate with its unchanged scope", async () => {
    const timing = clock();
    const requests = mandateBroker();
    const instance = runtime(stateDir(), "mandate-renew", timing);
    instance.requestMandate("supervisor", "supervisor");
    expect(await instance.arm()).toBe(true);
    await until(() => instance.mandateState("supervisor")?.state === "ready", "the mandate becomes ready");
    const minted = mandateMints(requests)[0]!;

    timing.planned[0]!.callback();
    await until(() => mandateRenewals(requests).length === 1, "the mandate is renewed after its parent");
    const renewal = mandateRenewals(requests)[0]!;
    expect(renewal.body.session_public_key).toBe(minted.body.session_public_key);
    expect(renewal.body.session_ref).toBe(minted.body.session_ref);
    expect(renewal.body.inbox).toEqual(minted.body.inbox);
    await until(
      () => (instance.mandateState("supervisor") as { expiresAt?: string }).expiresAt === "2030-01-03T00:00:00.000Z",
      "the renewed expiry is kept"
    );
    await instance.disarm();
  });

  test("a mandate whose renewal fails keeps its previous expiry and the failure is traced", async () => {
    const timing = clock();
    const errors: string[] = [];
    onDeckError((_scope, text) => errors.push(text));
    const requests = mandateBroker({ failMandateRenewal: true });
    const instance = runtime(stateDir(), "mandate-renew-fail", timing);
    instance.requestMandate("supervisor", "supervisor");
    expect(await instance.arm()).toBe(true);
    await until(() => instance.mandateState("supervisor")?.state === "ready", "the mandate becomes ready");

    timing.planned[0]!.callback();
    await until(() => mandateRenewals(requests).length === 1, "the mandate renewal is attempted");
    await until(() => errors.some((e) => e.includes("could not renew the mandate of supervisor")), "the failure is traced");
    expect((instance.mandateState("supervisor") as { expiresAt?: string }).expiresAt).toBe("2030-01-02T00:00:00.000Z");
    timing.setNow(Date.parse("2030-01-02T00:00:00.000Z"));
    expect(instance.mandateState("supervisor"), "past its own expiry the mandate is no longer usable").toEqual({ state: "refused" });
    await instance.disarm();
  });

  test("releasing a ready mandate revokes its own token at the broker", async () => {
    const requests = mandateBroker();
    const instance = runtime(stateDir(), "mandate-release-ready", clock());
    instance.requestMandate("caller-rel", "author");
    expect(await instance.arm()).toBe(true);
    await until(() => instance.mandateState("caller-rel")?.state === "ready", "the mandate becomes ready");
    const tokenId = (instance.mandateState("caller-rel") as { tokenId: string }).tokenId;
    expect(tokenId).toBe(deriveTokenId(mandateMints(requests)[0]!.body.session_public_key as string));

    instance.releaseMandate("caller-rel");
    await until(
      () => requests.some((r) => r.path === "/approval/token-revoke" && r.body.token_id === tokenId),
      "the released mandate's token is revoked"
    );
    await instance.disarm();
  });

  test("a disarm sends every mandate back to pending: nothing stays ready without its run credential", async () => {
    mandateBroker();
    const instance = runtime(stateDir(), "mandate-drop", clock());
    instance.requestMandate("caller-drop", "lead");
    expect(await instance.arm()).toBe(true);
    await until(() => instance.mandateState("caller-drop")?.state === "ready", "the mandate becomes ready");
    await instance.disarm();
    expect(instance.mandateState("caller-drop")).toEqual({ state: "pending" });
  });

  test("a silent broker on a mandate renewal neither holds the next parent renewal nor survives a disarm", async () => {
    const timing = clock();
    const signals: Array<AbortSignal | undefined> = [];
    const requests = mandateBroker({ hungRenewalSignals: signals });
    const instance = runtime(stateDir(), "mandate-hung", timing);
    instance.requestMandate("supervisor", "supervisor");
    expect(await instance.arm()).toBe(true);
    await until(() => instance.mandateState("supervisor")?.state === "ready", "the mandate becomes ready");

    timing.planned[0]!.callback();
    await until(() => signals.length === 1, "the mandate renewal reaches the silent broker");
    await until(() => timing.planned.length === 2, "the parent renewal completed and scheduled its successor");
    timing.planned[1]!.callback();
    await until(
      () => requests.filter((r) => (r.body.inbox as { kind?: string }).kind === "run" && r.body.renew_only === true).length === 2,
      "the next parent renewal is not held by the hung mandate"
    );
    await until(() => signals.length === 2, "the second mandate renewal reaches the silent broker");
    expect(signals[1]?.aborted).toBe(false);

    await reachedWithin(instance.disarm(), "disarm does not wait on the silent broker");
    expect(signals[1]?.aborted, "the hung mandate renewal is aborted by the disarm").toBe(true);
  });

  test("a blocked mandate renewal does not prevent its sibling from renewing", async () => {
    const timing = clock();
    const signals: Array<AbortSignal | undefined> = [];
    const requests = mandateBroker({ hungRenewalSignals: signals, hungRenewalCaller: "blocked" });
    const instance = runtime(stateDir(), "mandate-parallel", timing);
    instance.requestMandate("blocked", "author");
    instance.requestMandate("ready", "lead");
    expect(await instance.arm()).toBe(true);
    await until(() => instance.mandateState("blocked")?.state === "ready" && instance.mandateState("ready")?.state === "ready", "both mandates become ready");

    timing.planned[0]!.callback();
    await until(() => signals.length === 1, "the first renewal is blocked");
    await until(() => mandateRenewals(requests).some((request) => (request.body.inbox as { caller_ref?: string }).caller_ref === "ready"), "the sibling renewal reaches the broker");
    await until(() => (instance.mandateState("ready") as { expiresAt?: string }).expiresAt === "2030-01-03T00:00:00.000Z", "the sibling renewal succeeds");
    await instance.disarm();
  });

  test("a mandate refused at mint is minted again at the next renewal", async () => {
    const timing = clock();
    const requests = mandateBroker({ failFirstMandateMint: true });
    const instance = runtime(stateDir(), "mandate-retry", timing);
    instance.requestMandate("caller-retry", "author");
    expect(await instance.arm()).toBe(true);
    await until(() => instance.mandateState("caller-retry")?.state === "refused", "the first mint is refused");

    timing.planned[0]!.callback();
    await until(() => mandateMints(requests).length === 2, "the renewal mints the mandate again");
    await until(() => instance.mandateState("caller-retry")?.state === "ready", "the new mandate becomes ready");
    await instance.disarm();
  });
});
