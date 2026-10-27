// ApprovalRuntime stays Electron-free so its identity and trust behavior is testable under Bun.
import { test, expect, describe, afterAll, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEventListeners } from "node:events";
import { ApprovalRuntime, armApprovalsAtStartup, retryOperatorTrust } from "../desktop/src/main/approval-runtime.ts";
import { onDeckError } from "../desktop/src/main/log.ts";
import {
  createOperatorIdentity,
  ensureOperatorIdentity,
  loadOperatorIdentity,
  publishFirstIdentity,
} from "../desktop/src/main/operator-identity.ts";
import { deriveOperatorId, generateCredential } from "../shared/approval.ts";
import { publicKeyFingerprint } from "../shared/operator-trust.ts";
import type { SecretCipher } from "../desktop/src/main/scope-secrets.ts";
import { reachedWithin } from "./_bounded-await.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cp-approval-runtime-"));
  dirs.push(d);
  return d;
}

const fakeCipher: SecretCipher = {
  isAvailable: () => true,
  encrypt: (s: string) => Buffer.from(`X${s}`, "utf8"),
  decrypt: (b: Buffer) => b.toString("utf8").slice(1),
};

/**
 * Simulates a corrupted or re-keyed operator identity file: cannot decrypt what
 * fakeCipher encrypted.
 */
const hostileCipher: SecretCipher = {
  isAvailable: () => true,
  encrypt: () => Buffer.from(""),
  decrypt: () => {
    throw new Error("keychain changed");
  },
};

/** Models a keychain that is DOWN right now (locked, mid OS migration) -- the
 * exact same observable failure as real corruption from inside decrypt(),
 * which is precisely why isAvailable() (not the decrypt failure itself) has
 * to be the signal that tells the two apart. */
const unavailableCipher: SecretCipher = {
  isAvailable: () => false,
  encrypt: () => Buffer.from(""),
  decrypt: () => {
    throw new Error("keychain locked");
  },
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  onDeckError(() => {});
});

function registerOperatorTrustStatusSetter(
  broadcast: (channel: string, status: unknown) => void,
  reportError: (scope: string, message: string, error: unknown) => void,
): (state: string, publicKey?: string) => void {
  const source = readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "index.ts"), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("function setOperatorTrustStatus(");
  const end = source.indexOf("\nconst approvals =", start);
  if (start < 0 || end < 0) throw new Error("setOperatorTrustStatus source slice is unavailable");
  const body = source
    .slice(start, end)
    .replace(
      "function setOperatorTrustStatus(state: OperatorTrustStatusEvent['state'], publicKey?: string): void {",
      "function setOperatorTrustStatus(state, publicKey) {",
    );
  return new Function("publicKeyFingerprint", "reportError", "broadcast", `${body}\nreturn setOperatorTrustStatus;`)(
    publicKeyFingerprint,
    reportError,
    broadcast,
  ) as (state: string, publicKey?: string) => void;
}

function retryOperatorTrustHandler(
  approvals: ApprovalRuntime,
  operatorTrustStatus: { state: string },
): () => Promise<{ state: string }> {
  const source = readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "index.ts"), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("    retryOperatorTrust: ");
  const end = source.indexOf(",\n", start);
  if (start < 0 || end < 0) throw new Error("index.ts: retry operator trust callback is unavailable");
  const callback = source.slice(start + "    retryOperatorTrust: ".length, end);
  return new Function("retryOperatorTrust", "approvals", "operatorTrustStatus", `return (${callback});`)(
    retryOperatorTrust,
    approvals,
    operatorTrustStatus,
  ) as () => Promise<{ state: string }>;
}

function registerRoadmapSigner(
  ensureIdentity: () => { state: string },
  configure: (loader: () => unknown) => void,
): void {
  const source = readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "index.ts"), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("configureRoadmapSigner(() => {");
  const end = source.indexOf("\n\n/** Global switch", start);
  if (start < 0 || end < 0) throw new Error("configureRoadmapSigner source slice is unavailable");
  new Function(
    "configureRoadmapSigner",
    "join",
    "app",
    "APP_STATE_SUBDIR",
    "ensureOperatorIdentity",
    "secretCipher",
    "buildAuthProof",
    source.slice(start, end),
  )(
    configure,
    join,
    { getPath: () => "state" },
    "approvals",
    ensureIdentity,
    fakeCipher,
    () => ({}),
  );
}

test("roadmap signing is disabled when the operator identity is unavailable", () => {
  let loader: (() => unknown) | null = null;
  registerRoadmapSigner(
    () => ({ state: "identity-unreadable" }),
    (registered) => { loader = registered; },
  );

  expect(loader).not.toBeNull();
  expect(loader!()).toBeNull();
});

test.each(["compatible", "unconfigured", "not-trusted", "incompatible", "invalid", "unreachable"])("operator trust status publishes the shared fingerprint for %s", (state) => {
  const indexSource = readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "index.ts"), "utf8");
  expect(indexSource).toContain("import { publicKeyFingerprint } from '../../../shared/operator-trust'");
  expect(indexSource).not.toContain("function publicKeyFingerprint(");

  const events: unknown[] = [];
  const setStatus = registerOperatorTrustStatusSetter(
    (_channel, status) => events.push(status),
    () => {},
  );
  const publicKey = generateCredential().publicKey;

  setStatus(state, publicKey);
  expect(events).toEqual([{ state, fingerprint: publicKeyFingerprint(publicKey) }]);
});

test("operator trust status reports and contains malformed public keys", () => {
  const events: unknown[] = [];
  const errors: unknown[] = [];
  const setStatus = registerOperatorTrustStatusSetter(
    (_channel, status) => events.push(status),
    (_scope, _message, error) => errors.push(error),
  );

  setStatus("not-trusted", "not-a-valid-ed25519-public-key");

  expect(events).toEqual([{ state: "not-trusted" }]);
  expect(errors).toHaveLength(1);
});

/** A trusted broker accepts the diagnostic handshake before it mints a token. */
function stubMintSuccess(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return new Response(JSON.stringify({ operator_trust_version: 1, operator_trust_state: "ready" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/operator/check")) {
      const body = JSON.parse(String(init?.body)) as { public_key: string };
      return new Response(JSON.stringify({ operator_id: deriveOperatorId(body.public_key), protocol_version: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ token_id: "tok_test", capabilities: { inbox_provenance: 1 }, expires_at: new Date(Date.now() + 3600_000).toISOString() }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("ApprovalRuntime.whenPreparationSettled()", () => {
  test("waits until a ready preparation is abandoned", async () => {
    stubMintSuccess();
    const runtime = new ApprovalRuntime({
      stateDir: tmp(),
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host",
      groupId: () => "g-runtime",
    });

    const preparation = await runtime.prepareScope({ projectKey: "project", groupId: "g-target" });
    expect(preparation.state).toBe("ready");
    const settled = runtime.whenPreparationSettled();
    let waiting = true;
    void settled.then(() => { waiting = false; });
    await Promise.resolve();
    expect(waiting).toBe(true);
    if (preparation.state === "ready") await preparation.abandon();

    await expect(reachedWithin(settled, "the abandoned preparation settles its waiters")).resolves.toBeUndefined();
  });

  test("settles after an in-flight preparation refuses", async () => {
    let releaseMint!: (response: Response) => void;
    let mintStarted!: () => void;
    const started = new Promise<void>((resolve) => { mintStarted = resolve; });
    const response = new Promise<Response>((resolve) => { releaseMint = resolve; });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/health")) return new Response(JSON.stringify({ operator_trust_version: 1, operator_trust_state: "ready" }), { status: 200 });
      if (url.endsWith("/operator/check")) {
        const body = JSON.parse(String(init?.body)) as { public_key: string };
        return new Response(JSON.stringify({ operator_id: deriveOperatorId(body.public_key), protocol_version: 1 }), { status: 200 });
      }
      if (url.endsWith("/approval/token-mint")) {
        mintStarted();
        return response;
      }
      return new Response(JSON.stringify({ revoked: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const runtime = new ApprovalRuntime({
      stateDir: tmp(),
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host",
      groupId: () => "g-runtime",
    });

    const preparing = runtime.prepareScope({ projectKey: "project", groupId: "g-target" });
    await reachedWithin(started, "the preparation reaches mint");
    const settled = runtime.whenPreparationSettled();
    releaseMint(new Response(JSON.stringify({ token_id: "tok_test", capabilities: {}, expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 200 }));

    await expect(preparing).resolves.toMatchObject({ state: "refused", cause: "capability" });
    await expect(reachedWithin(settled, "the refused preparation settles its waiters")).resolves.toBeUndefined();
  });

  test("aborting an observer does not abandon its preparation", async () => {
    stubMintSuccess();
    const runtime = new ApprovalRuntime({
      stateDir: tmp(),
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host",
      groupId: () => "g-runtime",
    });
    const preparation = await runtime.prepareScope({ projectKey: "project", groupId: "g-target" });
    const controller = new AbortController();
    const settled = runtime.whenPreparationSettled(controller.signal);
    controller.abort();

    await expect(reachedWithin(settled, "the aborted observer resolves")).resolves.toBeUndefined();
    expect(runtime.publishedRootStatus({ projectKey: "project", groupId: "g-target" })).toBe("pending");
    if (preparation.state === "ready") await preparation.abandon();
  });

  test("disarming settles an observer while mint remains in flight", async () => {
    let releaseMint!: (response: Response) => void;
    let mintStarted!: () => void;
    const started = new Promise<void>((resolve) => { mintStarted = resolve; });
    const response = new Promise<Response>((resolve) => { releaseMint = resolve; });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/health")) return new Response(JSON.stringify({ operator_trust_version: 1, operator_trust_state: "ready" }), { status: 200 });
      if (url.endsWith("/operator/check")) {
        const body = JSON.parse(String(init?.body)) as { public_key: string };
        return new Response(JSON.stringify({ operator_id: deriveOperatorId(body.public_key), protocol_version: 1 }), { status: 200 });
      }
      if (url.endsWith("/approval/token-mint")) {
        mintStarted();
        return response;
      }
      return new Response(JSON.stringify({ revoked: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const runtime = new ApprovalRuntime({
      stateDir: tmp(),
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host",
      groupId: () => "g-runtime",
    });

    const preparing = runtime.prepareScope({ projectKey: "project", groupId: "g-target" });
    await reachedWithin(started, "the preparation reaches mint before disarm");
    const settled = runtime.whenPreparationSettled();
    const disarming = runtime.disarm();

    await expect(reachedWithin(settled, "disarm settles the observer before mint returns")).resolves.toBeUndefined();
    releaseMint(new Response(JSON.stringify({ token_id: "tok_test", capabilities: { inbox_provenance: 1 }, expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 200 }));
    await preparing;
    await disarming;
  });

  function newRuntime(): ApprovalRuntime {
    return new ApprovalRuntime({
      stateDir: tmp(),
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host",
      groupId: () => "g-runtime",
    });
  }

  function holdMint(): { started: Promise<void>; release(): void } {
    let respond!: (response: Response) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const response = new Promise<Response>((resolve) => { respond = resolve; });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/health")) return new Response(JSON.stringify({ operator_trust_version: 1, operator_trust_state: "ready" }), { status: 200 });
      if (url.endsWith("/operator/check")) {
        const body = JSON.parse(String(init?.body)) as { public_key: string };
        return new Response(JSON.stringify({ operator_id: deriveOperatorId(body.public_key), protocol_version: 1 }), { status: 200 });
      }
      if (url.endsWith("/approval/token-mint")) {
        markStarted();
        return response;
      }
      return new Response(JSON.stringify({ revoked: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    return {
      started,
      release: () => respond(new Response(JSON.stringify({ token_id: "tok_test", capabilities: { inbox_provenance: 1 }, expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 200 })),
    };
  }

  test("an already aborted signal settles at once while a preparation is held", async () => {
    stubMintSuccess();
    const runtime = newRuntime();
    const preparation = await runtime.prepareScope({ projectKey: "project", groupId: "g-target" });
    expect(preparation.state).toBe("ready");
    const controller = new AbortController();
    controller.abort();

    await expect(reachedWithin(runtime.whenPreparationSettled(controller.signal), "an aborted signal settles its observer")).resolves.toBeUndefined();
    if (preparation.state === "ready") await preparation.abandon();
  });

  test("an observer registered after disarm began settles before the in-flight mint returns", async () => {
    const mint = holdMint();
    const runtime = newRuntime();
    const preparing = runtime.prepareScope({ projectKey: "project", groupId: "g-target" });
    await reachedWithin(mint.started, "the preparation reaches mint before disarm");
    const disarming = runtime.disarm();

    await expect(reachedWithin(runtime.whenPreparationSettled(), "a disarming runtime settles a late observer")).resolves.toBeUndefined();
    mint.release();
    await preparing;
    await disarming;
  });

  test("an observer registered during mint stays pending while the ready preparation is held", async () => {
    const mint = holdMint();
    const runtime = newRuntime();
    const preparing = runtime.prepareScope({ projectKey: "project", groupId: "g-target" });
    await reachedWithin(mint.started, "the preparation reaches mint");
    const settled = runtime.whenPreparationSettled();
    let waiting = true;
    void settled.then(() => { waiting = false; });
    mint.release();
    const preparation = await reachedWithin(preparing, "the preparation becomes ready");
    expect(preparation.state).toBe("ready");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(waiting).toBe(true);
    if (preparation.state === "ready") await preparation.abandon();

    await expect(reachedWithin(settled, "abandoning the held preparation settles the observer")).resolves.toBeUndefined();
  });

  test("settles when the held preparation is published", async () => {
    stubMintSuccess();
    const runtime = newRuntime();
    const preparation = await runtime.prepareScope({ projectKey: "project", groupId: "g-target" });
    if (preparation.state !== "ready") throw new Error(`preparation refused: ${preparation.cause}`);
    const settled = runtime.whenPreparationSettled();
    let waiting = true;
    void settled.then(() => { waiting = false; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(waiting).toBe(true);
    const installed = preparation.install();
    if (installed.state !== "ready") throw new Error(`install refused: ${installed.cause}`);
    installed.publish();

    await expect(reachedWithin(settled, "publishing settles the observer")).resolves.toBeUndefined();
    await runtime.disarm();
  });

  test("an observer detaches its abort listener once settled", async () => {
    stubMintSuccess();
    const runtime = newRuntime();
    const preparation = await runtime.prepareScope({ projectKey: "project", groupId: "g-target" });
    const controller = new AbortController();
    const settled = runtime.whenPreparationSettled(controller.signal);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    if (preparation.state === "ready") await preparation.abandon();
    await reachedWithin(settled, "abandoning settles the observer");

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});

describe("armApprovalsAtStartup()", () => {
  beforeEach(() => stubMintSuccess());

  test("arms successfully with no mobile transport ever configured or reachable", async () => {
    const stateDir = tmp();
    const runtime = new ApprovalRuntime({
      stateDir,
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host", groupId: () => "g-runtime",
    });

    const armed = await armApprovalsAtStartup(runtime);

    expect(armed).toBe(true);
    expect(runtime.deps()).not.toBeNull();
    expect(runtime.operator?.operatorId).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("retryOperatorTrust()", () => {
  beforeEach(() => stubMintSuccess());

  test("rechecks an armed runtime after the broker removes then restores its operator key", async () => {
    let trusted = true;
    const statuses: { state: string }[] = [];
    const current = { state: "unknown" };
    const runtime = new ApprovalRuntime({
      stateDir: tmp(),
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host", groupId: () => "g-runtime",
      onTrustStatus: (state) => {
        current.state = state;
        statuses.push({ state });
      },
    });
    const retry = retryOperatorTrustHandler(runtime, current);

    expect(await runtime.arm()).toBe(true);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/health")) {
        return new Response(JSON.stringify({ operator_trust_version: 1, operator_trust_state: "ready" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (!trusted) {
        return new Response(JSON.stringify({ error: "operator-not-trusted" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      const body = JSON.parse(String(init?.body)) as { public_key: string };
      return new Response(JSON.stringify({ operator_id: deriveOperatorId(body.public_key), protocol_version: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    trusted = false;
    expect(await retry()).toEqual({ state: "not-trusted" });
    expect(runtime.operator).not.toBeNull();

    trusted = true;
    expect(await retry()).toEqual({ state: "compatible" });
    expect(statuses.map((status) => status.state)).toEqual(["compatible", "not-trusted", "compatible"]);
  });

  test("publishes unreachable instead of throwing when an armed retry cannot reach the broker", async () => {
    const statuses: string[] = [];
    const current = { state: "unknown" };
    const runtime = new ApprovalRuntime({
      stateDir: tmp(),
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host", groupId: () => "g-runtime",
      onTrustStatus: (state) => {
        current.state = state;
        statuses.push(state);
      },
    });
    const retry = retryOperatorTrustHandler(runtime, current);
    expect(await runtime.arm()).toBe(true);
    globalThis.fetch = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;

    expect(await retry()).toEqual({ state: "unreachable" });
    expect(statuses).toEqual(["compatible", "unreachable"]);
  });

  test("shares one in-flight handshake across concurrent retries", async () => {
    const current = { state: "unknown" };
    const runtime = new ApprovalRuntime({
      stateDir: tmp(),
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host", groupId: () => "g-runtime",
      onTrustStatus: (state) => { current.state = state; },
    });
    const retry = retryOperatorTrustHandler(runtime, current);
    expect(await runtime.arm()).toBe(true);

    let releaseHealth!: (response: Response) => void;
    let signalHealth!: () => void;
    const healthStarted = new Promise<void>((resolve) => { signalHealth = resolve; });
    const healthResponse = new Promise<Response>((resolve) => { releaseHealth = resolve; });
    let requests = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests += 1;
      if (String(input).endsWith("/health")) {
        signalHealth();
        return healthResponse;
      }
      const body = JSON.parse(String(init?.body)) as { public_key: string };
      return new Response(JSON.stringify({ operator_id: deriveOperatorId(body.public_key), protocol_version: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const first = retry();
    const second = retry();
    let healthTimeout: ReturnType<typeof setTimeout> | null = null;
    const started = await Promise.race([
      healthStarted.then(() => "started" as const),
      new Promise<"timed-out">((resolve) => { healthTimeout = setTimeout(() => resolve("timed-out"), 50); }),
    ]);
    if (healthTimeout) clearTimeout(healthTimeout);
    expect(started).toBe("started");
    expect(requests).toBe(1);
    releaseHealth(new Response(JSON.stringify({ operator_trust_version: 1, operator_trust_state: "ready" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await expect(Promise.all([first, second])).resolves.toEqual([{ state: "compatible" }, { state: "compatible" }]);
  });

  test("returns the prior status without publishing after the runtime closes", async () => {
    const statuses: string[] = [];
    const runtime = new ApprovalRuntime({
      stateDir: tmp(),
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host", groupId: () => "g-runtime",
      onTrustStatus: (state) => statuses.push(state),
    });
    const prior = { state: "not-trusted" };
    const retry = retryOperatorTrustHandler(runtime, prior);

    await runtime.close();

    expect(await retry()).toBe(prior);
    expect(statuses).toEqual([]);
  });

  test("returns the prior status without publishing while disarming", async () => {
    const statuses: string[] = [];
    const current = { state: "unknown" };
    const runtime = new ApprovalRuntime({
      stateDir: tmp(),
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host", groupId: () => "g-runtime",
      onTrustStatus: (state) => {
        current.state = state;
        statuses.push(state);
      },
    });
    const retry = retryOperatorTrustHandler(runtime, current);
    expect(await runtime.arm()).toBe(true);

    let beginRevoke!: () => void;
    let finishRevoke!: (response: Response) => void;
    const revokeStarted = new Promise<void>((resolve) => { beginRevoke = resolve; });
    const revokeResponse = new Promise<Response>((resolve) => { finishRevoke = resolve; });
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/approval/token-revoke")) {
        beginRevoke();
        return revokeResponse;
      }
      throw new Error(`unexpected request: ${String(input)}`);
    }) as unknown as typeof fetch;

    const disarming = runtime.disarm();
    const prior = current;
    const publicationCount = statuses.length;

    expect(await retry()).toBe(prior);
    expect(statuses).toHaveLength(publicationCount);

    await revokeStarted;
    finishRevoke(new Response("{}", { status: 200 }));
    await disarming;
  });

  test("does not publish a late retry after disarming begins", async () => {
    const statuses: string[] = [];
    const current = { state: "unknown" };
    const runtime = new ApprovalRuntime({
      stateDir: tmp(),
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host", groupId: () => "g-runtime",
      onTrustStatus: (state) => {
        current.state = state;
        statuses.push(state);
      },
    });
    const retry = retryOperatorTrustHandler(runtime, current);
    expect(await runtime.arm()).toBe(true);

    let releaseHealth!: (response: Response) => void;
    let signalHealth!: () => void;
    let releaseRevoke!: (response: Response) => void;
    let signalRevoke!: () => void;
    const healthStarted = new Promise<void>((resolve) => { signalHealth = resolve; });
    const healthResponse = new Promise<Response>((resolve) => { releaseHealth = resolve; });
    const revokeStarted = new Promise<void>((resolve) => { signalRevoke = resolve; });
    const revokeResponse = new Promise<Response>((resolve) => { releaseRevoke = resolve; });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/health")) {
        signalHealth();
        return healthResponse;
      }
      if (String(input).endsWith("/approval/token-revoke")) {
        signalRevoke();
        return revokeResponse;
      }
      const body = JSON.parse(String(init?.body)) as { public_key: string };
      return new Response(JSON.stringify({ operator_id: deriveOperatorId(body.public_key), protocol_version: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const retrying = retry();
    let healthTimeout: ReturnType<typeof setTimeout> | null = null;
    const started = await Promise.race([
      healthStarted.then(() => "started" as const),
      new Promise<"timed-out">((resolve) => { healthTimeout = setTimeout(() => resolve("timed-out"), 50); }),
    ]);
    if (healthTimeout) clearTimeout(healthTimeout);
    expect(started).toBe("started");
    const disarming = runtime.disarm();
    await revokeStarted;
    const publicationCount = statuses.length;
    releaseHealth(new Response(JSON.stringify({ operator_trust_version: 1, operator_trust_state: "ready" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    expect(await retrying).toBe(current);
    expect(statuses).toHaveLength(publicationCount);
    releaseRevoke(new Response("{}", { status: 200 }));
    await disarming;
  });
});

type TrustOutcome = "compatible" | "unconfigured" | "invalid" | "not-trusted" | "incompatible";

function trustBroker(outcome: () => TrustOutcome): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const current = outcome();
    if (url.endsWith("/health")) {
      if (current === "incompatible") return json({ status: "ok" });
      const state = current === "unconfigured" || current === "invalid" ? current : "ready";
      return json({ operator_trust_version: 1, operator_trust_state: state });
    }
    if (url.endsWith("/operator/check")) {
      if (current === "not-trusted") return json({ error: "operator-not-trusted" }, 403);
      const body = JSON.parse(String(init?.body)) as { public_key: string };
      return json({ operator_id: deriveOperatorId(body.public_key), protocol_version: 1 });
    }
    return json({ token_id: "tok_test", capabilities: { inbox_provenance: 1 }, expires_at: new Date(Date.now() + 3600_000).toISOString() });
  }) as unknown as typeof fetch;
}

describe("operator trust refusals reach the Deck error channel", () => {
  test.each(["unconfigured", "invalid", "not-trusted", "incompatible"] as const)(
    "arming refused as %s is reported once, without the key or the state dir",
    async (refusal) => {
      const errors: { scope: string; text: string }[] = [];
      onDeckError((scope, text) => errors.push({ scope, text }));
      globalThis.fetch = trustBroker(() => refusal);
      const stateDir = tmp();
      let publicKey: string | undefined;
      const runtime = new ApprovalRuntime({
        stateDir,
        cipher: fakeCipher,
        endpoint: () => ({ url: "http://broker.local", token: "" }),
        runId: "run-test",
        host: "test-host", groupId: () => "g-runtime",
        onTrustStatus: (_state, key) => { publicKey = key; },
      });

      expect(await runtime.arm()).toBe(false);
      expect(await runtime.retryTrust()).toBe(false);

      expect(errors).toHaveLength(1);
      expect(errors[0]!.scope).toBe("approvals");
      expect(errors[0]!.text).toContain(refusal);
      expect(publicKey).toEqual(expect.any(String));
      expect(errors[0]!.text).not.toContain(publicKey!);
      expect(errors[0]!.text).not.toContain(stateDir);
    },
  );

  test("a retry on an armed runtime reports each new refusal, not a repeated one", async () => {
    const errors: string[] = [];
    onDeckError((_scope, text) => {
      if (text.includes("refused operator trust")) errors.push(text);
    });
    let outcome: TrustOutcome = "compatible";
    globalThis.fetch = trustBroker(() => outcome);
    const runtime = new ApprovalRuntime({
      stateDir: tmp(),
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host", groupId: () => "g-runtime",
    });
    expect(await runtime.arm()).toBe(true);
    expect(errors).toEqual([]);

    outcome = "not-trusted";
    expect(await runtime.retryTrust()).toBe(true);
    expect(await runtime.retryTrust()).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("not-trusted");

    outcome = "invalid";
    expect(await runtime.retryTrust()).toBe(true);
    expect(errors).toHaveLength(2);
    expect(errors[1]).toContain("invalid");

    outcome = "compatible";
    expect(await runtime.retryTrust()).toBe(true);
    outcome = "invalid";
    expect(await runtime.retryTrust()).toBe(true);
    expect(errors).toHaveLength(3);
  });

  test("a refusal after disarm and rearm is reported again with the same state", async () => {
    const errors: string[] = [];
    onDeckError((_scope, text) => {
      if (text.includes("refused operator trust")) errors.push(text);
    });
    globalThis.fetch = trustBroker(() => "not-trusted");
    const runtime = new ApprovalRuntime({
      stateDir: tmp(),
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host", groupId: () => "g-runtime",
    });

    expect(await runtime.arm()).toBe(false);
    await runtime.disarm();
    expect(await runtime.arm()).toBe(false);
    expect(errors).toHaveLength(2);
  });

  test("a compatible check between two refusals lets the second one be reported", async () => {
    const errors: string[] = [];
    onDeckError((_scope, text) => {
      if (text.includes("refused operator trust")) errors.push(text);
    });
    let outcome: TrustOutcome = "compatible";
    globalThis.fetch = trustBroker(() => outcome);
    const runtime = new ApprovalRuntime({
      stateDir: tmp(),
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host", groupId: () => "g-runtime",
    });
    expect(await runtime.arm()).toBe(true);

    outcome = "not-trusted";
    expect(await runtime.retryTrust()).toBe(true);
    outcome = "compatible";
    expect(await runtime.checkTrustNow()).toBe("compatible");
    outcome = "not-trusted";
    expect(await runtime.retryTrust()).toBe(true);
    expect(errors).toHaveLength(2);
  });
});

describe("ApprovalRuntime.arm() without any mobile transport configured", () => {
  beforeEach(() => stubMintSuccess());

  test("succeeds on a machine that never enrolled (no identity file at all)", async () => {
    const stateDir = tmp();
    const runtime = new ApprovalRuntime({
      stateDir,
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host", groupId: () => "g-runtime",
    });
    const armed = await runtime.arm();
    expect(armed).toBe(true);
    expect(runtime.deps()).not.toBeNull();
    expect(runtime.operator?.operatorId).toMatch(/^[0-9a-f]{16}$/);
  });

  test("returns false when the broker refuses minting with 503", async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ operator_trust_version: 1, operator_trust_state: "ready" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/operator/check")) {
        const body = JSON.parse(String(init?.body)) as { public_key: string };
        return new Response(JSON.stringify({ operator_id: deriveOperatorId(body.public_key), protocol_version: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "operator-trust-unconfigured" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const runtime = new ApprovalRuntime({
      stateDir: tmp(),
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host", groupId: () => "g-runtime",
    });

    expect(await runtime.arm()).toBe(false);
  });

  test("refuses a broker that does not advertise the operator trust handshake", async () => {
    const requests: string[] = [];
    const states: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const runtime = new ApprovalRuntime({
      stateDir: tmp(),
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host", groupId: () => "g-runtime",
      onTrustStatus: (state: string) => states.push(state),
    });

    expect(await runtime.arm()).toBe(false);
    expect(requests).toEqual(["http://broker.local/health"]);
    expect(states).toEqual(["incompatible"]);
  });

  test("reports an unconfigured broker with its local public key without signing a check", async () => {
    const requests: string[] = [];
    const states: string[] = [];
    let reportedPublicKey: string | undefined;
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ operator_trust_version: 1, operator_trust_state: "unconfigured" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const runtime = new ApprovalRuntime({
      stateDir: tmp(),
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host", groupId: () => "g-runtime",
      onTrustStatus: (state: string, publicKey?: string) => {
        states.push(state);
        reportedPublicKey = publicKey;
      },
    });

    expect(await runtime.arm()).toBe(false);
    expect(requests).toEqual(["http://broker.local/health"]);
    expect(states).toEqual(["unconfigured"]);
    expect(reportedPublicKey).toEqual(expect.any(String));
  });

  test("reports an untrusted operator after the signed check", async () => {
    const requests: string[] = [];
    const states: string[] = [];
    let reportedPublicKey: string | undefined;
    let checkBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ operator_trust_version: 1, operator_trust_state: "ready" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      checkBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ error: "operator-not-trusted" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const runtime = new ApprovalRuntime({
      stateDir: tmp(),
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host", groupId: () => "g-runtime",
      onTrustStatus: (state: string, publicKey?: string) => {
        states.push(state);
        reportedPublicKey = publicKey;
      },
    });

    expect(await runtime.arm()).toBe(false);
    expect(requests).toEqual(["http://broker.local/health", "http://broker.local/operator/check"]);
    const observedCheckBody = checkBody as Record<string, unknown> | null;
    expect(observedCheckBody?.public_key).toEqual(expect.any(String));
    expect(reportedPublicKey).toBe(observedCheckBody?.public_key as string);
    expect(observedCheckBody?.auth).toEqual(expect.any(Object));
    expect(states).toEqual(["not-trusted"]);
  });

  test("reports an invalid trust policy from health", async () => {
    const states: string[] = [];
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ operator_trust_version: 1, operator_trust_state: "invalid" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const runtime = new ApprovalRuntime({
      stateDir: tmp(),
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host", groupId: () => "g-runtime",
      onTrustStatus: (state: string) => states.push(state),
    });

    expect(await runtime.arm()).toBe(false);
    expect(states).toEqual(["invalid"]);
    expect(runtime.deps()).toBeNull();
  });

  test("reports an invalid trust policy from the signed check", async () => {
    const states: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/health")) {
        return new Response(JSON.stringify({ operator_trust_version: 1, operator_trust_state: "ready" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "operator-trust-invalid" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const runtime = new ApprovalRuntime({
      stateDir: tmp(),
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host", groupId: () => "g-runtime",
      onTrustStatus: (state: string) => states.push(state),
    });

    expect(await runtime.arm()).toBe(false);
    expect(states).toEqual(["invalid"]);
    expect(runtime.deps()).toBeNull();
  });

  test.each(["a mismatched operator id", "an unsupported protocol version"])("reports incompatible for %s", async (caseName) => {
    const states: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/health")) {
        return new Response(JSON.stringify({ operator_trust_version: 1, operator_trust_state: "ready" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const publicKey = (JSON.parse(String(init?.body)) as { public_key: string }).public_key;
      const checkResponse = caseName === "a mismatched operator id"
        ? { operator_id: "other-operator", protocol_version: 1 }
        : { operator_id: deriveOperatorId(publicKey), protocol_version: 2 };
      return new Response(JSON.stringify(checkResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const runtime = new ApprovalRuntime({
      stateDir: tmp(),
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host", groupId: () => "g-runtime",
      onTrustStatus: (state: string) => states.push(state),
    });

    expect(await runtime.arm()).toBe(false);
    expect(states).toEqual(["incompatible"]);
    expect(runtime.deps()).toBeNull();
  });

  test.each([
    [401, { error: "unauthorized" }],
    [500, { error: "unexpected" }],
  ])("never reports compatible when the signed check returns %i", async (status, body) => {
    const states: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/health")) {
        return new Response(JSON.stringify({ operator_trust_version: 1, operator_trust_state: "ready" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const runtime = new ApprovalRuntime({
      stateDir: tmp(),
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host", groupId: () => "g-runtime",
      onTrustStatus: (state: string) => states.push(state),
    });

    expect(await runtime.arm()).toBe(false);
    expect(states).toEqual(["incompatible"]);
    expect(runtime.deps()).toBeNull();
  });

  test("drops the prior signer after enrolment is refused", async () => {
    const stateDir = tmp();
    const states: string[] = [];
    const runtime = new ApprovalRuntime({
      stateDir,
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host", groupId: () => "g-runtime",
      onTrustStatus: (state: string) => states.push(state),
    });

    expect(await runtime.arm()).toBe(true);
    const firstId = runtime.operator?.operatorId;
    await runtime.disarm();
    const enrolled = createOperatorIdentity(stateDir, fakeCipher, generateCredential());
    expect(enrolled.operatorId).not.toBe(firstId);

    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/health")) {
        return new Response(JSON.stringify({ operator_trust_version: 1, operator_trust_state: "ready" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "operator-not-trusted" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    expect(await runtime.arm()).toBe(false);
    expect(states).toEqual(["compatible", "not-trusted"]);
    expect(runtime.deps()).toBeNull();
  });

  test("clears the signer when disarmed", async () => {
    const runtime = new ApprovalRuntime({
      stateDir: tmp(),
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host", groupId: () => "g-runtime",
    });

    expect(await runtime.arm()).toBe(true);
    await runtime.disarm();
    expect(runtime.deps()).toBeNull();
  });

  test("does not expose a credential path after disarm begins", async () => {
    const runtime = new ApprovalRuntime({
      stateDir: tmp(),
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host", groupId: () => "g-runtime",
    });

    expect(await runtime.arm()).toBe(true);
    const disarming = runtime.disarm();

    expect(runtime.env().CLAUDE_PEERS_APPROVAL_FILE).toBe("");
    await disarming;
  });

  test("rearms after a failed revoke with the retained token dependencies", async () => {
    const requests: string[] = [];
    let failRevoke = false;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ operator_trust_version: 1, operator_trust_state: "ready" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/operator/check")) {
        const body = JSON.parse(String(init?.body)) as { public_key: string };
        return new Response(JSON.stringify({ operator_id: deriveOperatorId(body.public_key), protocol_version: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/approval/token-revoke")) {
        if (failRevoke) throw new Error("connection refused");
        return new Response(JSON.stringify({ revoked: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ token_id: "tok_test", capabilities: { inbox_provenance: 1 }, expires_at: new Date(Date.now() + 3600_000).toISOString() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const runtime = new ApprovalRuntime({
      stateDir: tmp(),
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host", groupId: () => "g-runtime",
    });

    expect(await runtime.arm()).toBe(true);
    failRevoke = true;
    await runtime.disarm();
    failRevoke = false;
    requests.length = 0;

    expect(await runtime.arm()).toBe(true);
    expect(requests[0]).toBe("http://broker.local/approval/token-revoke");
  });

  test("does not recover a published scope while a failed mint leaves revocation debt", async () => {
    let mints = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ operator_trust_version: 1, operator_trust_state: "ready" }), { status: 200 });
      }
      if (url.endsWith("/operator/check")) {
        const body = JSON.parse(String(init?.body)) as { public_key: string };
        return new Response(JSON.stringify({ operator_id: deriveOperatorId(body.public_key), protocol_version: 1 }), { status: 200 });
      }
      if (url.endsWith("/approval/token-revoke")) return new Response(JSON.stringify({ revoked: 1 }), { status: 200 });
      mints += 1;
      if (mints === 2) throw new TypeError("network failure");
      return new Response(JSON.stringify({ token_id: "tok_test", capabilities: { inbox_provenance: 1 }, expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 200 });
    }) as unknown as typeof fetch;
    const runtime = new ApprovalRuntime({
      stateDir: tmp(),
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host", groupId: () => "g-runtime",
    });

    expect(await runtime.arm()).toBe(true);
    await expect(runtime.prepareScope({ projectKey: "project", groupId: "g-candidate" })).resolves.toMatchObject({ state: "refused", cause: "mint-refused" });
    expect(await runtime.recoverPublishedScope({ projectKey: "project", groupId: "g-runtime" })).toBe(false);
    expect(mints).toBe(2);
  });

  test("reports an unreachable broker with its local public key without claiming incompatibility", async () => {
    const stateDir = tmp();
    const states: { state: string; publicKey?: string }[] = [];
    const runtime = new ApprovalRuntime({
      stateDir,
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host", groupId: () => "g-runtime",
      onTrustStatus: (state: string, publicKey?: string) => states.push({ state, publicKey }),
    });

    expect(await runtime.arm()).toBe(true);
    const publicKey = runtime.operator!.publicKey;
    await runtime.disarm();
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    expect(await runtime.arm()).toBe(false);
    expect(states).toEqual([
      { state: "compatible", publicKey },
      { state: "unreachable", publicKey },
    ]);
    expect(runtime.deps()).toBeNull();
  });

  test("refuses an undecryptable persisted identity without replacing it", async () => {
    const stateDir = tmp();
    createOperatorIdentity(stateDir, fakeCipher, generateCredential());
    const file = join(stateDir, "operator.json");
    const before = readFileSync(file, "utf8");
    const runtime = new ApprovalRuntime({
      stateDir,
      cipher: hostileCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host", groupId: () => "g-runtime",
    });

    expect(await runtime.arm()).toBe(false);
    expect(runtime.deps()).toBeNull();
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readdirSync(stateDir).filter((entry) => entry.includes(".bak-"))).toHaveLength(0);
  });

  test("refuses a malformed persisted identity without replacing it", async () => {
    const stateDir = tmp();
    const file = join(stateDir, "operator.json");
    writeFileSync(file, "{ not json");
    const before = readFileSync(file, "utf8");
    const runtime = new ApprovalRuntime({
      stateDir,
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host", groupId: () => "g-runtime",
    });

    expect(await runtime.arm()).toBe(false);
    expect(runtime.deps()).toBeNull();
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readdirSync(stateDir).filter((entry) => entry.includes(".bak-"))).toHaveLength(0);
  });
});

describe("ApprovalRuntime.checkTrustNow()", () => {
  beforeEach(() => stubMintSuccess());

  function runtimeWith(states: { state: string; publicKey?: string }[]): ApprovalRuntime {
    return new ApprovalRuntime({
      stateDir: tmp(),
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host", groupId: () => "g-runtime",
      onTrustStatus: (state: string, publicKey?: string) => states.push({ state, publicKey }),
    });
  }

  test("asks the broker answering now, not the verdict reached when arming", async () => {
    const states: { state: string; publicKey?: string }[] = [];
    const runtime = runtimeWith(states);
    expect(await runtime.arm()).toBe(true);

    // A broker respawned or adopted after an outage, older than the trust handshake.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    expect(await runtime.checkTrustNow()).toBe("incompatible");
    expect(runtime.operator).not.toBeNull();
    expect(states.map((s) => s.state)).toEqual(["compatible", "incompatible"]);
  });

  test("publishes the public key of an operator the broker no longer trusts", async () => {
    const states: { state: string; publicKey?: string }[] = [];
    const runtime = runtimeWith(states);
    expect(await runtime.arm()).toBe(true);

    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/health")) {
        return new Response(JSON.stringify({ operator_trust_version: 1, operator_trust_state: "ready" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "operator-not-trusted" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    expect(await runtime.checkTrustNow()).toBe("not-trusted");
    expect(states.at(-1)).toEqual({ state: "not-trusted", publicKey: runtime.operator!.publicKey });
  });

  test("an unreachable broker rejects the check without publishing a banner state", async () => {
    const states: { state: string; publicKey?: string }[] = [];
    const runtime = runtimeWith(states);
    expect(await runtime.arm()).toBe(true);

    const failure = new Error("connect ECONNREFUSED");
    globalThis.fetch = (async () => {
      throw failure;
    }) as unknown as typeof fetch;

    await expect(runtime.checkTrustNow()).rejects.toBe(failure);
    expect(states.map((s) => s.state)).toEqual(["compatible"]);
  });

  test("refuses before any request when no operator identity was armed", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests.push(String(input));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const runtime = runtimeWith([]);

    await expect(runtime.checkTrustNow()).rejects.toThrow("operator identity is unavailable for the operator trust check");
    expect(requests).toEqual([]);
  });
});

describe("ApprovalRuntime.arm() when the keychain is merely unavailable (not corrupt)", () => {
  beforeEach(() => stubMintSuccess());

  test("gives up arming this run WITHOUT touching the existing identity", async () => {
    const stateDir = tmp();
    const original = createOperatorIdentity(stateDir, fakeCipher, generateCredential());
    const file = join(stateDir, "operator.json");
    const before = readFileSync(file, "utf8");

    const runtime = new ApprovalRuntime({
      stateDir,
      cipher: unavailableCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host", groupId: () => "g-runtime",
    });
    const armed = await runtime.arm();

    expect(armed).toBe(false);
    expect(runtime.deps()).toBeNull();

    // Byte-for-byte unchanged -- not merely "some identity exists", but THIS
    // exact identity, encrypted private key included.
    expect(readFileSync(file, "utf8")).toBe(before);

    // Nothing was even attempted to be backed up, because nothing was ever
    // written.
    const entries = readdirSync(stateDir);
    expect(entries.filter((f) => f.includes(".bak-"))).toHaveLength(0);
    expect(entries).toContain("operator.json");

    // Reloading with a WORKING cipher afterwards recovers the SAME identity
    // -- proof the outage, not the identity, was the problem.
    const recovered = loadOperatorIdentity(stateDir, fakeCipher);
    expect(recovered?.operatorId).toBe(original.operatorId);
    expect(recovered?.privateKey).toBe(original.privateKey);
  });
});

describe("ensureOperatorIdentity()", () => {
  test("publishes only the first completed identity content", () => {
    const stateDir = tmp();
    const file = join(stateDir, "operator.json");

    publishFirstIdentity(file, "first identity");
    const firstContent = readFileSync(file, "utf8");
    publishFirstIdentity(file, "second identity");

    expect(readFileSync(file, "utf8")).toBe(firstContent);
    expect(readdirSync(stateDir)).toEqual(["operator.json"]);
  });

  test("leaves a completed first identity unchanged on a second resolution", () => {
    const stateDir = tmp();

    const first = ensureOperatorIdentity(stateDir, fakeCipher);
    const file = join(stateDir, "operator.json");
    const firstContent = readFileSync(file, "utf8");
    const second = ensureOperatorIdentity(stateDir, fakeCipher);

    expect(first.state).toBe("ready");
    expect(second.state).toBe("ready");
    if (first.state !== "ready" || second.state !== "ready") throw new Error("identity unavailable");
    expect(second.identity.operatorId).toBe(first.identity.operatorId);
    expect(readFileSync(file, "utf8")).toBe(firstContent);
    expect(readdirSync(stateDir)).toEqual(["operator.json"]);
  });

  test("uses atomic first publication without replacing an existing identity", () => {
    const stateDir = tmp();
    const original = createOperatorIdentity(stateDir, fakeCipher, generateCredential());
    const file = join(stateDir, "operator.json");
    const before = readFileSync(file, "utf8");
    const resolved = ensureOperatorIdentity(stateDir, fakeCipher);
    const source = readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "operator-identity.ts"), "utf8").replace(/\r\n/g, "\n");
    const start = source.indexOf("export function ensureOperatorIdentity(");
    const end = source.indexOf("\n}\n\n/** Writes an explicitly supplied credential", start);
    if (start < 0 || end < 0) throw new Error("ensureOperatorIdentity source slice is unavailable");

    expect(source.slice(start, end)).toContain("publishFirstIdentity(file, JSON.stringify(stored, null, 2))");
    expect(resolved).toMatchObject({ state: "ready", identity: { operatorId: original.operatorId } });
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readdirSync(stateDir).filter((entry) => entry.includes(".tmp-"))).toHaveLength(0);
  });
});

describe("createOperatorIdentity() backup-before-overwrite", () => {
  // Explicit replacement retains the existing private key as a backup.
  test("never destroys the previous identity: it survives as a .bak sibling", () => {
    const stateDir = tmp();
    const v1 = createOperatorIdentity(stateDir, fakeCipher, generateCredential());
    const v2 = createOperatorIdentity(stateDir, fakeCipher, generateCredential());

    expect(v2.operatorId).not.toBe(v1.operatorId);

    const backups = readdirSync(stateDir).filter((f) => f.includes(".bak-"));
    expect(backups).toHaveLength(1);
    const backedUp = JSON.parse(readFileSync(join(stateDir, backups[0]!), "utf8"));
    expect(deriveOperatorId(backedUp.publicKey)).toBe(v1.operatorId);

    // The live file is v2, not v1.
    const live = loadOperatorIdentity(stateDir, fakeCipher);
    expect(live?.operatorId).toBe(v2.operatorId);
  });

  // D1 (team-lead, card 469f3176 review): a timestamp alone is not enough --
  // two backups computed in the SAME millisecond must not collide. Forcing
  // the actual millisecond to repeat (rather than hoping two fast calls land
  // in the same one) is the only way to prove the collision-handling branch
  // fires, not just that it happened not to be needed.
  test("two backups computed in the SAME millisecond do not clobber each other", () => {
    const stateDir = tmp();
    const v1 = createOperatorIdentity(stateDir, fakeCipher, generateCredential());
    const file = join(stateDir, "operator.json");

    const RealDate = globalThis.Date;
    const FIXED_ISO = "2026-01-01T00:00:00.000Z";
    class FrozenDate {
      toISOString(): string {
        return FIXED_ISO;
      }
    }
    // @ts-expect-error -- test-only global patch, restored in finally. Only
    // `new Date().toISOString()` (uniqueBackupPath's sole use of Date) is
    // exercised while this is installed.
    globalThis.Date = FrozenDate;
    try {
      const stamp = FIXED_ISO.replace(/[:.]/g, "-");
      // Pre-seed the EXACT path uniqueBackupPath will compute first, forcing
      // its existsSync/increment loop to actually run.
      writeFileSync(`${file}.bak-${stamp}`, "unrelated pre-existing file, must survive untouched");

      const v2 = createOperatorIdentity(stateDir, fakeCipher, generateCredential());

      expect(readFileSync(`${file}.bak-${stamp}`, "utf8")).toBe(
        "unrelated pre-existing file, must survive untouched"
      );
      // v1 (the real prior identity, renamed by this call) landed at the
      // suffixed sibling instead of clobbering the pre-seeded file above.
      expect(existsSync(`${file}.bak-${stamp}-1`)).toBe(true);
      const v1Backup = JSON.parse(readFileSync(`${file}.bak-${stamp}-1`, "utf8"));
      expect(deriveOperatorId(v1Backup.publicKey)).toBe(v1.operatorId);
      expect(v2.operatorId).not.toBe(v1.operatorId);
    } finally {
      globalThis.Date = RealDate;
    }
  });
});
