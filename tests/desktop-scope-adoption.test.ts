import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveTokenId } from "../desktop/src/main/approval-auth.ts";
import { ApprovalRuntime, approvalCredFileName } from "../desktop/src/main/approval-runtime.ts";
import type { RootPreparation, ScopeTarget } from "../desktop/src/main/approval-runtime.ts";
import { ScopeAdoption, ScopeCommitInvariantError } from "../desktop/src/main/scope-adoption.ts";
import type { SecretCipher } from "../desktop/src/main/scope-secrets.ts";
import { reachedWithin } from "./_bounded-await.ts";
import { withOperatorTrustBroker } from "./_operator-trust-broker.ts";

const projectKey = "github.com/vocsap/koryphaios";
const published: ScopeTarget = { projectKey, groupId: "scope-published" };
const target: ScopeTarget = { projectKey, groupId: "scope-target" };
const dirs: string[] = [];
const originalFetch = globalThis.fetch;

const cipher: SecretCipher = {
  isAvailable: () => true,
  encrypt: (value: string) => Buffer.from(`X${value}`, "utf8"),
  decrypt: (value: Buffer) => value.toString("utf8").slice(1),
};

interface Gate {
  promise: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "cp-scope-adoption-"));
  dirs.push(dir);
  return dir;
}

function validMint(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify({
    token_id: deriveTokenId(body.session_public_key as string),
    expires_at: "2030-01-02T00:00:00.000Z",
    capabilities: { inbox_provenance: 1 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function wireBroker(opts: { mint?: (body: Record<string, unknown>) => Promise<Response> | Response; revoke?: () => void } = {}): Array<{ path: string }> {
  const requests: Array<{ path: string }> = [];
  globalThis.fetch = withOperatorTrustBroker((async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ path });
    if (path === "/approval/token-revoke") {
      opts.revoke?.();
      return new Response(JSON.stringify({ revoked: 1 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (path === "/approval/token-mint") return opts.mint ? opts.mint(body) : validMint(body);
    throw new Error(`unexpected request ${path}`);
  }) as typeof fetch);
  return requests;
}

function runtime(stateDir: string): ApprovalRuntime {
  return new ApprovalRuntime({
    stateDir,
    cipher,
    endpoint: () => ({ url: "http://broker.local", token: "" }),
    runId: "scope-adoption-run",
    host: "test-host",
    projectKey: () => projectKey,
    groupId: () => published.groupId,
  });
}

function adoption(approvals: ApprovalRuntime, deadline: Gate, now: () => number = () => 0): ScopeAdoption {
  return new ScopeAdoption({
    approvals,
    publishedScope: published,
    now,
    waitUntil: () => deadline.promise,
    onCleanupError: () => {},
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("ScopeAdoption", () => {
  test("a spawn that dies still abandons a target scope preparation", async () => {
    const mint = gate();
    const mintStarted = gate();
    const revoked = gate();
    wireBroker({
      mint: async (body) => {
        mintStarted.open();
        await mint.promise;
        return validMint(body);
      },
      revoke: revoked.open,
    });
    const runtimeInstance = runtime(tmp());
    const deadline = gate();
    const coordinator = adoption(runtimeInstance, deadline);
    let ownCalls = 0;

    const pending = coordinator.adopt(target, () => {
      ownCalls += 1;
      return true;
    });
    await reachedWithin(mintStarted.promise, "the target preparation reaches mint");
    expect(coordinator.captureSpawnContext()).toEqual(published);
    mint.open();

    await expect(reachedWithin(pending, "the spawn invalidates the preparation")).resolves.toEqual({ state: "superseded" });
    expect(ownCalls).toBe(0);
    expect(coordinator.scope()).toEqual(published);
    expect(runtimeInstance.env().CLAUDE_PEERS_APPROVAL_FILE).toBe("");
    await reachedWithin(revoked.promise, "the cancelled credential is revoked");
  });

  test("a deadline abandons an in-flight credential before acquisition", async () => {
    const mint = gate();
    const mintStarted = gate();
    const revoked = gate();
    wireBroker({
      mint: async (body) => {
        mintStarted.open();
        await mint.promise;
        return validMint(body);
      },
      revoke: revoked.open,
    });
    const runtimeInstance = runtime(tmp());
    const deadline = gate();
    const coordinator = adoption(runtimeInstance, deadline);
    let ownCalls = 0;

    const pending = coordinator.adopt(target, () => {
      ownCalls += 1;
      return true;
    });
    await reachedWithin(mintStarted.promise, "the preparation reaches mint before deadline");
    deadline.open();

    await expect(reachedWithin(pending, "the deadline ends the adoption")).resolves.toEqual({ state: "credential-timed-out" });
    expect(ownCalls).toBe(0);
    expect(coordinator.scope()).toEqual(published);
    expect(runtimeInstance.env().CLAUDE_PEERS_APPROVAL_FILE).toBe("");
    mint.open();
    await reachedWithin(revoked.promise, "the timed-out credential is revoked");
  });

  test("a credential ready after the deadline cannot commit", async () => {
    let now = 0;
    const mint = gate();
    const revoked = gate();
    wireBroker({
      mint: async (body) => {
        await mint.promise;
        now = 5_000;
        return validMint(body);
      },
      revoke: revoked.open,
    });
    const runtimeInstance = runtime(tmp());
    const deadline = gate();
    const coordinator = adoption(runtimeInstance, deadline, () => now);
    let ownCalls = 0;

    const pending = coordinator.adopt(target, () => {
      ownCalls += 1;
      return true;
    });
    mint.open();

    await expect(reachedWithin(pending, "the late ready credential is refused")).resolves.toEqual({ state: "credential-timed-out" });
    expect(ownCalls).toBe(0);
    expect(coordinator.scope()).toEqual(published);
    expect(runtimeInstance.env().CLAUDE_PEERS_APPROVAL_FILE).toBe("");
    await reachedWithin(revoked.promise, "the late credential is revoked");
  });

  test("an explicit preparation refusal is unavailable without waiting for the deadline", async () => {
    wireBroker({
      mint: (body) => new Response(JSON.stringify({
        token_id: deriveTokenId(body.session_public_key as string),
        expires_at: "2030-01-02T00:00:00.000Z",
        capabilities: {},
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    const runtimeInstance = runtime(tmp());
    const deadline = gate();
    const coordinator = adoption(runtimeInstance, deadline);
    let ownCalls = 0;

    await expect(reachedWithin(coordinator.adopt(target, () => {
      ownCalls += 1;
      return true;
    }), "the explicit refusal ends the adoption")).resolves.toEqual({ state: "credential-unavailable", cause: "capability" });

    expect(ownCalls).toBe(0);
    expect(coordinator.scope()).toEqual(published);
  });

  test("a cancelled adoption releases the ticket for the next target after cleanup", async () => {
    const mint = gate();
    const mintStarted = gate();
    const revoked = gate();
    let mintCount = 0;
    wireBroker({
      mint: async (body) => {
        mintCount += 1;
        if (mintCount === 1) {
          mintStarted.open();
          await mint.promise;
        }
        return validMint(body);
      },
      revoke: revoked.open,
    });
    const runtimeInstance = runtime(tmp());
    const deadline = gate();
    const coordinator = adoption(runtimeInstance, deadline);

    const first = coordinator.adopt(target, () => true);
    await reachedWithin(mintStarted.promise, "the first target starts minting");
    coordinator.cancel();
    mint.open();
    await expect(reachedWithin(first, "the first target becomes superseded")).resolves.toEqual({ state: "superseded" });
    await reachedWithin(revoked.promise, "the cancelled credential is revoked");

    await expect(coordinator.adopt({ projectKey, groupId: "scope-next" }, () => true)).resolves.toEqual({
      state: "published",
      scope: { projectKey, groupId: "scope-next" },
    });
    expect(coordinator.scope()).toEqual({ projectKey, groupId: "scope-next" });
  });

  test("a failed local installation abandons before own", async () => {
    const stateDir = tmp();
    wireBroker();
    const runtimeInstance = runtime(stateDir);
    const deadline = gate();
    const coordinator = adoption(runtimeInstance, deadline);
    mkdirSync(join(stateDir, approvalCredFileName(projectKey, "scope-adoption-run", target.groupId)));
    let ownCalls = 0;

    await expect(coordinator.adopt(target, () => {
      ownCalls += 1;
      return true;
    })).resolves.toEqual({ state: "credential-unavailable", cause: "local-file" });

    expect(ownCalls).toBe(0);
    expect(coordinator.scope()).toEqual(published);
  });

  test("a lock race removes the installed credential without publishing it", async () => {
    const stateDir = tmp();
    wireBroker();
    const runtimeInstance = runtime(stateDir);
    const deadline = gate();
    const coordinator = adoption(runtimeInstance, deadline);
    const credential = join(stateDir, approvalCredFileName(projectKey, "scope-adoption-run", target.groupId));
    let ownCalls = 0;

    await expect(coordinator.adopt(target, () => {
      ownCalls += 1;
      return false;
    })).resolves.toEqual({ state: "lock-race" });

    expect(ownCalls).toBe(1);
    expect(existsSync(credential)).toBe(false);
    expect(runtimeInstance.env().CLAUDE_PEERS_APPROVAL_FILE).toBe("");
    expect(coordinator.scope()).toEqual(published);
  });

  test("a rejected scope recovers the published root after confirmed cleanup", async () => {
    wireBroker();
    const runtimeInstance = runtime(tmp());
    expect(await runtimeInstance.arm()).toBe(true);
    const coordinator = adoption(runtimeInstance, gate());

    await expect(coordinator.adopt(target, () => false)).resolves.toEqual({ state: "lock-race" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(runtimeInstance.publishedRootStatus(published)).toBe("ready");
  });

  test("a second adoption stays busy until the active ticket ends", async () => {
    const mint = gate();
    const mintStarted = gate();
    const revoked = gate();
    wireBroker({
      mint: async (body) => {
        mintStarted.open();
        await mint.promise;
        return validMint(body);
      },
      revoke: revoked.open,
    });
    const runtimeInstance = runtime(tmp());
    const deadline = gate();
    const coordinator = adoption(runtimeInstance, deadline);

    const first = coordinator.adopt(target, () => true);
    await reachedWithin(mintStarted.promise, "the active ticket reaches mint");
    await expect(coordinator.adopt({ projectKey, groupId: "scope-next" }, () => true)).resolves.toEqual({ state: "busy" });
    coordinator.cancel();
    mint.open();
    await reachedWithin(first, "the active ticket ends after cancellation");
    await reachedWithin(revoked.promise, "the cancelled active credential is revoked");
  });

  test("an unchanged scope waits for its in-flight root instead of preparing it twice", async () => {
    const settled = gate();
    let status: "ready" | "pending" | "missing" = "pending";
    let prepareCalls = 0;
    const coordinator = new ScopeAdoption({
      approvals: {
        prepareScope: async () => {
          prepareCalls += 1;
          return { state: "refused", cause: "busy", abandon: async () => {} };
        },
        publishedRootStatus: () => status,
        whenPreparationSettled: () => settled.promise,
      },
      publishedScope: published,
      waitUntil: () => gate().promise,
      onCleanupError: () => {},
    });

    const adoption = coordinator.adopt(published, () => true);
    await Promise.resolve();
    expect(prepareCalls).toBe(0);
    status = "ready";
    settled.open();

    await expect(reachedWithin(adoption, "the published root ends the unchanged adoption")).resolves.toEqual({ state: "published", scope: published });
  });

  test("a rejected in-flight root waiter is traced and releases the ticket", async () => {
    const failure = new Error("waiter failed");
    const errors: unknown[] = [];
    const coordinator = new ScopeAdoption({
      approvals: {
        prepareScope: async () => ({ state: "refused", cause: "busy", abandon: async () => {} }),
        publishedRootStatus: () => "pending",
        whenPreparationSettled: async () => { throw failure; },
      },
      publishedScope: published,
      waitUntil: () => gate().promise,
      onCleanupError: (error) => errors.push(error),
    });

    await expect(coordinator.adopt(published, () => true)).resolves.toEqual({ state: "credential-unavailable", cause: "mint-refused" });
    expect(errors).toEqual([failure]);
    await expect(coordinator.adopt(published, () => true)).resolves.toEqual({ state: "credential-unavailable", cause: "mint-refused" });
  });

  test("an unchanged scope prepares once after its in-flight root refuses", async () => {
    const settled = gate();
    let status: "pending" | "missing" = "pending";
    let prepareCalls = 0;
    const coordinator = new ScopeAdoption({
      approvals: {
        prepareScope: async () => {
          prepareCalls += 1;
          return { state: "refused", cause: "capability", abandon: async () => {} };
        },
        publishedRootStatus: () => status,
        whenPreparationSettled: () => settled.promise,
      },
      publishedScope: published,
      waitUntil: () => gate().promise,
      onCleanupError: () => {},
    });

    const adoption = coordinator.adopt(published, () => true);
    await Promise.resolve();
    expect(prepareCalls).toBe(0);
    status = "missing";
    settled.open();

    await expect(reachedWithin(adoption, "the refused root permits one replacement preparation")).resolves.toEqual({ state: "credential-unavailable", cause: "capability" });
    expect(prepareCalls).toBe(1);
  });

  test("an unchanged scope times out while its root preparation remains in flight", async () => {
    const settled = gate();
    const deadline = gate();
    let prepareCalls = 0;
    const coordinator = new ScopeAdoption({
      approvals: {
        prepareScope: async () => {
          prepareCalls += 1;
          return { state: "refused", cause: "busy", abandon: async () => {} };
        },
        publishedRootStatus: () => "pending",
        whenPreparationSettled: () => settled.promise,
      },
      publishedScope: published,
      waitUntil: () => deadline.promise,
      onCleanupError: () => {},
    });

    const adoption = coordinator.adopt(published, () => true);
    deadline.open();

    await expect(reachedWithin(adoption, "the in-flight root reaches the adoption deadline")).resolves.toEqual({ state: "credential-timed-out" });
    expect(prepareCalls).toBe(0);
  });

  test("a never-settling revocation does not delay the cancelled adoption result", async () => {
    const mint = gate();
    const mintStarted = gate();
    wireBroker({
      mint: async (body) => {
        mintStarted.open();
        await mint.promise;
        return validMint(body);
      },
      revoke: () => {},
    });
    const coordinator = adoption(runtime(tmp()), gate());

    const pending = coordinator.adopt(target, () => true);
    await reachedWithin(mintStarted.promise, "the preparation reaches mint before cancellation");
    coordinator.cancel();
    mint.open();

    await expect(reachedWithin(pending, "the cancelled adoption returns before revocation settles")).resolves.toEqual({ state: "superseded" });
    expect(coordinator.scope()).toEqual(published);
  });

  test("a thrown preparation is traced and releases its adoption ticket", async () => {
    const thrown = new Error("prepare failed");
    const errors: unknown[] = [];
    let calls = 0;
    const coordinator = new ScopeAdoption({
      approvals: {
        prepareScope: async () => {
          calls += 1;
          if (calls === 1) throw thrown;
          return { state: "refused", cause: "mint-refused", abandon: async () => {} };
        },
        whenPreparationSettled: async () => {},
      },
      publishedScope: published,
      onCleanupError: (error) => errors.push(error),
    });

    await expect(coordinator.adopt(target, () => true)).rejects.toBe(thrown);
    await Promise.resolve();
    expect(errors).toEqual([thrown]);
    await expect(coordinator.adopt(target, () => true)).resolves.toEqual({ state: "credential-unavailable", cause: "mint-refused" });
  });

  test("a publish failure traces the invariant violation after workspace acquisition", async () => {
    const publishedError = new Error("publish failed");
    const errors: unknown[] = [];
    let abandoned = 0;
    const preparation = {
      state: "ready" as const,
      target,
      canPublish: () => true,
      install: () => preparation,
      publish: () => { throw publishedError; },
      abandon: async () => { abandoned += 1; },
    };
    const coordinator = new ScopeAdoption({
      approvals: {
        prepareScope: async () => preparation,
        whenPreparationSettled: async () => {},
      },
      publishedScope: published,
      onCleanupError: (error) => errors.push(error),
    });

    await expect(coordinator.adopt(target, () => true)).rejects.toEqual(new ScopeCommitInvariantError(publishedError));
    expect(errors).toEqual([publishedError]);
    expect(abandoned).toBe(1);
    expect(coordinator.scope()).toEqual(published);
  });

  test("an unchanged scope still requires and publishes a credential", async () => {
    wireBroker();
    const runtimeInstance = runtime(tmp());
    const deadline = gate();
    const coordinator = adoption(runtimeInstance, deadline);
    let ownCalls = 0;

    await expect(coordinator.adopt(published, () => {
      ownCalls += 1;
      return true;
    })).resolves.toEqual({ state: "published", scope: published });

    expect(ownCalls).toBe(1);
    expect(runtimeInstance.env().CLAUDE_PEERS_APPROVAL_FILE).not.toBe("");
    expect(coordinator.scope()).toEqual(published);
  });

  test("an unchanged scope reuses its published credential without broker traffic", async () => {
    const requests = wireBroker();
    const runtimeInstance = runtime(tmp());
    expect(await runtimeInstance.arm()).toBe(true);
    requests.length = 0;
    const deadline = gate();
    const coordinator = adoption(runtimeInstance, deadline);

    await expect(coordinator.adopt(published, () => true)).resolves.toEqual({ state: "published", scope: published });

    expect(requests).toEqual([]);
  });

  test("live sessions retain the published root instead of preparing a different scope", async () => {
    wireBroker();
    const stateDir = tmp();
    const runtimeInstance = runtime(stateDir);
    expect(await runtimeInstance.arm()).toBe(true);
    const credential = join(stateDir, approvalCredFileName(projectKey, "scope-adoption-run", published.groupId));
    const coordinator = new ScopeAdoption({
      approvals: runtimeInstance,
      publishedScope: published,
      mayChangeScope: () => false,
      waitUntil: () => gate().promise,
      onCleanupError: () => {},
    });
    let ownCalls = 0;

    await expect(coordinator.adopt(target, () => {
      ownCalls += 1;
      return true;
    })).resolves.toEqual({ state: "published", scope: published });

    expect(ownCalls).toBe(1);
    expect(runtimeInstance.publishedRootStatus(published)).toBe("ready");
    expect(existsSync(credential)).toBe(true);
  });

  test("close prevents a late credential from publishing", async () => {
    const mint = gate();
    const mintStarted = gate();
    const revoked = gate();
    wireBroker({
      mint: async (body) => {
        mintStarted.open();
        await mint.promise;
        return validMint(body);
      },
      revoke: revoked.open,
    });
    const runtimeInstance = runtime(tmp());
    const deadline = gate();
    const coordinator = adoption(runtimeInstance, deadline);

    const pending = coordinator.adopt(target, () => true);
    await reachedWithin(mintStarted.promise, "the preparation reaches mint before close");
    coordinator.close();
    mint.open();

    await expect(reachedWithin(pending, "close ends the adoption")).resolves.toEqual({ state: "closed" });
    expect(coordinator.scope()).toEqual(published);
    expect(runtimeInstance.env().CLAUDE_PEERS_APPROVAL_FILE).toBe("");
    await reachedWithin(revoked.promise, "the closed credential is revoked");
  });
});

type RootStatus = "ready" | "pending" | "missing";

interface ReadyStub {
  state: "ready";
  target: ScopeTarget;
  canPublish(): boolean;
  install(): ReadyStub;
  publish(): void;
  abandon(): Promise<void>;
}

interface ReadyHooks {
  canPublish?: () => boolean;
  install?: () => void;
  publish?: () => void;
  abandon?: () => Promise<void>;
  onFirstStateRead?: () => void;
}

function readyPreparation(hooks: ReadyHooks = {}): { preparation: ReadyStub; calls: { install: number; publish: number; abandon: number } } {
  const calls = { install: 0, publish: 0, abandon: 0 };
  let stateRead = false;
  const preparation: ReadyStub = {
    get state(): "ready" {
      if (!stateRead) {
        stateRead = true;
        hooks.onFirstStateRead?.();
      }
      return "ready";
    },
    target,
    canPublish: hooks.canPublish ?? (() => true),
    install: () => {
      calls.install += 1;
      hooks.install?.();
      return preparation;
    },
    publish: () => {
      calls.publish += 1;
      hooks.publish?.();
    },
    abandon: async () => {
      calls.abandon += 1;
      await hooks.abandon?.();
    },
  };
  return { preparation, calls };
}

interface StubbedOptions {
  status?: () => RootStatus;
  waiter?: () => Promise<void>;
  prepare?: (scopeTarget: ScopeTarget) => unknown;
  mayChangeScope?: () => boolean;
  now?: () => number;
  deadline?: Gate;
}

interface Stubbed {
  coordinator: ScopeAdoption;
  prepareCalls(): number;
  waiterCalls(): number;
  signals: AbortSignal[];
  errors: unknown[];
}

function stubbed(options: StubbedOptions = {}): Stubbed {
  const signals: AbortSignal[] = [];
  const errors: unknown[] = [];
  let prepareCalls = 0;
  let waiterCalls = 0;
  const deadline = options.deadline ?? gate();
  const coordinator = new ScopeAdoption({
    approvals: {
      prepareScope: (scopeTarget) => {
        prepareCalls += 1;
        const prepare = options.prepare ?? (() => Promise.resolve({ state: "refused", cause: "busy", abandon: async () => {} }));
        return prepare(scopeTarget) as Promise<RootPreparation>;
      },
      publishedRootStatus: options.status ?? (() => "missing"),
      whenPreparationSettled: (signal) => {
        waiterCalls += 1;
        if (signal) signals.push(signal);
        return (options.waiter ?? (() => Promise.resolve()))();
      },
    },
    publishedScope: published,
    mayChangeScope: options.mayChangeScope,
    now: options.now ?? (() => 0),
    waitUntil: () => deadline.promise,
    onCleanupError: (error) => errors.push(error),
  });
  return { coordinator, prepareCalls: () => prepareCalls, waiterCalls: () => waiterCalls, signals, errors };
}

const neverSettles = (): Promise<void> => new Promise<void>(() => {});

describe("ScopeAdoption admission, rechecks and tracing", () => {
  test("an adoption after close is refused without preparing", async () => {
    const stub = stubbed();
    stub.coordinator.close();

    await expect(stub.coordinator.adopt(target, () => true)).resolves.toEqual({ state: "closed" });
    expect(stub.prepareCalls()).toBe(0);
  });

  test("a ready root is published only when own succeeds", async () => {
    const stub = stubbed({ status: () => "ready" });
    let ownCalls = 0;

    await expect(stub.coordinator.adopt(published, () => {
      ownCalls += 1;
      return false;
    })).resolves.toEqual({ state: "lock-race" });
    expect(ownCalls).toBe(1);
    await expect(stub.coordinator.adopt(published, () => {
      ownCalls += 1;
      return true;
    })).resolves.toEqual({ state: "published", scope: published });
    expect(ownCalls).toBe(2);
    expect(stub.prepareCalls()).toBe(0);
  });

  test("a ready root of another scope still goes through preparation", async () => {
    const stub = stubbed({ status: () => "ready" });
    let ownCalls = 0;

    await expect(stub.coordinator.adopt(target, () => {
      ownCalls += 1;
      return true;
    })).resolves.toEqual({ state: "credential-unavailable", cause: "busy" });
    expect(stub.prepareCalls()).toBe(1);
    expect(ownCalls).toBe(0);
  });

  test("a different target never waits for the in-flight root", async () => {
    const stub = stubbed({ status: () => "pending", waiter: neverSettles });

    await expect(reachedWithin(stub.coordinator.adopt(target, () => true), "the other target prepares at once")).resolves.toEqual({
      state: "credential-unavailable",
      cause: "busy",
    });
    expect(stub.waiterCalls()).toBe(0);
  });

  test("cancelling aborts the observer of the in-flight root", async () => {
    const stub = stubbed({ status: () => "pending", waiter: neverSettles });

    const pending = stub.coordinator.adopt(published, () => true);
    expect(stub.signals).toHaveLength(1);
    expect(stub.signals[0]!.aborted).toBe(false);
    stub.coordinator.cancel();

    await expect(reachedWithin(pending, "the cancelled wait ends")).resolves.toEqual({ state: "superseded" });
    expect(stub.signals[0]!.aborted).toBe(true);
  });

  test("the deadline aborts the observer of the in-flight root", async () => {
    const deadline = gate();
    const stub = stubbed({ status: () => "pending", waiter: neverSettles, deadline });

    const pending = stub.coordinator.adopt(published, () => true);
    deadline.open();

    await expect(reachedWithin(pending, "the deadline ends the wait")).resolves.toEqual({ state: "credential-timed-out" });
    expect(stub.signals[0]!.aborted).toBe(true);
  });

  test("close ends the wait on the in-flight root as closed", async () => {
    const stub = stubbed({ status: () => "pending", waiter: neverSettles });

    const pending = stub.coordinator.adopt(published, () => true);
    stub.coordinator.close();

    await expect(reachedWithin(pending, "close ends the wait")).resolves.toEqual({ state: "closed" });
    expect(stub.prepareCalls()).toBe(0);
  });

  test("close ends a preparation that never answers as closed", async () => {
    const stub = stubbed({ prepare: () => new Promise(() => {}) });

    const pending = stub.coordinator.adopt(target, () => true);
    stub.coordinator.close();

    await expect(reachedWithin(pending, "close ends the unanswered preparation")).resolves.toEqual({ state: "closed" });
  });

  test("a root that settles after the deadline is not replaced", async () => {
    const settled = gate();
    let now = 0;
    let status: RootStatus = "pending";
    const stub = stubbed({ status: () => status, waiter: () => settled.promise, now: () => now });

    const pending = stub.coordinator.adopt(published, () => true);
    status = "missing";
    now = 5_000;
    settled.open();

    await expect(reachedWithin(pending, "the late settlement is refused")).resolves.toEqual({ state: "credential-timed-out" });
    expect(stub.prepareCalls()).toBe(0);
  });

  test("a root that settles ready is published only when own succeeds", async () => {
    const settled = gate();
    let status: RootStatus = "pending";
    const stub = stubbed({ status: () => status, waiter: () => settled.promise });
    let ownCalls = 0;

    const pending = stub.coordinator.adopt(published, () => {
      ownCalls += 1;
      return false;
    });
    status = "ready";
    settled.open();

    await expect(reachedWithin(pending, "the settled root meets the lock")).resolves.toEqual({ state: "lock-race" });
    expect(ownCalls).toBe(1);
    expect(stub.prepareCalls()).toBe(0);
  });

  test("a root still pending after the wait is refused without a second preparation", async () => {
    const stub = stubbed({ status: () => "pending" });

    await expect(reachedWithin(stub.coordinator.adopt(published, () => true), "the still pending root is refused")).resolves.toEqual({
      state: "credential-unavailable",
      cause: "mint-refused",
    });
    expect(stub.prepareCalls()).toBe(0);
  });

  test("a spawn during a wait on the same scope leaves the adoption alive", async () => {
    const settled = gate();
    let status: RootStatus = "pending";
    const stub = stubbed({ status: () => status, waiter: () => settled.promise });

    const pending = stub.coordinator.adopt(published, () => true);
    expect(stub.coordinator.captureSpawnContext()).toEqual(published);
    status = "ready";
    settled.open();

    await expect(reachedWithin(pending, "the spawn leaves the same scope adoption alive")).resolves.toEqual({ state: "published", scope: published });
  });

  test("a preparation that becomes ready after a cancellation is abandoned without installing", async () => {
    const holder: { coordinator?: ScopeAdoption } = {};
    const { preparation, calls } = readyPreparation({ onFirstStateRead: () => holder.coordinator?.cancel() });
    const stub = stubbed({ prepare: async () => preparation });
    holder.coordinator = stub.coordinator;
    let ownCalls = 0;

    await expect(stub.coordinator.adopt(target, () => {
      ownCalls += 1;
      return true;
    })).resolves.toEqual({ state: "superseded" });

    expect(calls).toEqual({ install: 0, publish: 0, abandon: 1 });
    expect(ownCalls).toBe(0);
  });

  test("a preparation that can no longer publish is abandoned without installing", async () => {
    const { preparation, calls } = readyPreparation({ canPublish: () => false });
    const stub = stubbed({ prepare: async () => preparation });
    let ownCalls = 0;

    await expect(stub.coordinator.adopt(target, () => {
      ownCalls += 1;
      return true;
    })).resolves.toEqual({ state: "credential-unavailable", cause: "mint-refused" });

    expect(calls).toEqual({ install: 0, publish: 0, abandon: 1 });
    expect(ownCalls).toBe(0);
  });

  test("a session appearing before installation supersedes the candidate", async () => {
    let live = false;
    const { preparation, calls } = readyPreparation({ onFirstStateRead: () => { live = true; } });
    const stub = stubbed({ prepare: async () => preparation, mayChangeScope: () => !live });
    let ownCalls = 0;

    await expect(stub.coordinator.adopt(target, () => {
      ownCalls += 1;
      return true;
    })).resolves.toEqual({ state: "superseded" });

    expect(calls).toEqual({ install: 0, publish: 0, abandon: 1 });
    expect(ownCalls).toBe(0);
  });

  test("a deadline reached while installing prevents own and abandons", async () => {
    let now = 0;
    const { preparation, calls } = readyPreparation({ install: () => { now = 5_000; } });
    const stub = stubbed({ prepare: async () => preparation, now: () => now });
    let ownCalls = 0;

    await expect(stub.coordinator.adopt(target, () => {
      ownCalls += 1;
      return true;
    })).resolves.toEqual({ state: "credential-timed-out" });

    expect(calls).toEqual({ install: 1, publish: 0, abandon: 1 });
    expect(ownCalls).toBe(0);
  });

  test("an abandon that rejects is traced and does not change the result", async () => {
    const failure = new Error("revoke failed");
    const { preparation } = readyPreparation({ canPublish: () => false, abandon: async () => { throw failure; } });
    const stub = stubbed({ prepare: async () => preparation });

    await expect(stub.coordinator.adopt(target, () => true)).resolves.toEqual({ state: "credential-unavailable", cause: "mint-refused" });
    await Promise.resolve();

    expect(stub.errors).toEqual([failure]);
  });

  test("an abandon that never settles does not delay the result", async () => {
    const { preparation, calls } = readyPreparation({ canPublish: () => false, abandon: neverSettles });
    const stub = stubbed({ prepare: async () => preparation });

    await expect(reachedWithin(stub.coordinator.adopt(target, () => true), "the result does not wait for the revocation")).resolves.toEqual({
      state: "credential-unavailable",
      cause: "mint-refused",
    });
    expect(calls.abandon).toBe(1);
  });

  test("a preparation that arrives after a cancellation is abandoned once", async () => {
    const holder: { coordinator?: ScopeAdoption } = {};
    const { preparation, calls } = readyPreparation();
    const stub = stubbed({
      prepare: () => ({
        then: (onReady: (value: ReadyStub) => unknown, onFail: (reason: unknown) => unknown) => {
          holder.coordinator?.cancel();
          return Promise.resolve(preparation).then(onReady, onFail);
        },
      }),
    });
    holder.coordinator = stub.coordinator;

    await expect(reachedWithin(stub.coordinator.adopt(target, () => true), "the cancelled adoption ends")).resolves.toEqual({ state: "superseded" });

    expect(calls.abandon).toBe(1);
  });

  test("a published adoption releases the ticket for the next one", async () => {
    const next = { projectKey, groupId: "scope-next" };
    const stub = stubbed({ prepare: async () => readyPreparation().preparation });

    await expect(stub.coordinator.adopt(target, () => true)).resolves.toEqual({ state: "published", scope: target });
    await expect(stub.coordinator.adopt(next, () => true)).resolves.toEqual({ state: "published", scope: next });
  });

  test("a publish failure releases the ticket for the next adoption", async () => {
    let calls = 0;
    const broken = readyPreparation({ publish: () => { throw new Error("publish failed"); } }).preparation;
    const stub = stubbed({
      prepare: async () => {
        calls += 1;
        return calls === 1 ? broken : { state: "refused", cause: "capability", abandon: async () => {} };
      },
    });

    await expect(stub.coordinator.adopt(target, () => true)).rejects.toBeInstanceOf(ScopeCommitInvariantError);
    await expect(stub.coordinator.adopt(target, () => true)).resolves.toEqual({ state: "credential-unavailable", cause: "capability" });
  });

  test("the adopted scope does not follow later edits of the caller's target", async () => {
    const edited = { projectKey, groupId: "scope-edited" };
    const stub = stubbed({ prepare: async () => readyPreparation().preparation });

    const pending = stub.coordinator.adopt(edited, () => true);
    edited.groupId = "scope-mutated";

    await expect(pending).resolves.toEqual({ state: "published", scope: { projectKey, groupId: "scope-edited" } });
    expect(stub.coordinator.scope()).toEqual({ projectKey, groupId: "scope-edited" });
  });

  test("scope hands out a copy the caller cannot use to move the published scope", () => {
    const stub = stubbed();

    const copy = stub.coordinator.scope();
    copy.groupId = "scope-leaked";

    expect(stub.coordinator.scope()).toEqual(published);
  });
});
