// ApprovalRuntime stays Electron-free so its identity and trust behavior is testable under Bun.
import { test, expect, describe, afterAll, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalRuntime, armApprovalsAtStartup } from "../desktop/src/main/approval-runtime.ts";
import {
  createOperatorIdentity,
  ensureOperatorIdentity,
  loadOperatorIdentity,
  publishFirstIdentity,
} from "../desktop/src/main/operator-identity.ts";
import { deriveOperatorId, generateCredential } from "../shared/approval.ts";
import { publicKeyFingerprint } from "../shared/operator-trust.ts";
import type { SecretCipher } from "../desktop/src/main/scope-secrets.ts";

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

test("operator trust status publishes the shared fingerprint", () => {
  const indexSource = readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "index.ts"), "utf8");
  expect(indexSource).toContain("import { publicKeyFingerprint } from '../../../shared/operator-trust'");
  expect(indexSource).not.toContain("function publicKeyFingerprint(");

  const events: unknown[] = [];
  const setStatus = registerOperatorTrustStatusSetter(
    (_channel, status) => events.push(status),
    () => {},
  );
  const publicKey = generateCredential().publicKey;

  setStatus("not-trusted", publicKey);
  expect(events).toEqual([{ state: "not-trusted", fingerprint: publicKeyFingerprint(publicKey) }]);
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
    return new Response(JSON.stringify({ token_id: "tok_test", expires_at: new Date(Date.now() + 3600_000).toISOString() }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("armApprovalsAtStartup()", () => {
  beforeEach(() => stubMintSuccess());

  test("arms successfully with no mobile transport ever configured or reachable", async () => {
    const stateDir = tmp();
    const runtime = new ApprovalRuntime({
      stateDir,
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host",
    });

    const armed = await armApprovalsAtStartup(runtime);

    expect(armed).toBe(true);
    expect(runtime.deps()).not.toBeNull();
    expect(runtime.operator?.operatorId).toMatch(/^[0-9a-f]{16}$/);
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
      host: "test-host",
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
      host: "test-host",
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
      host: "test-host",
      onTrustStatus: (state: string) => states.push(state),
    });

    expect(await runtime.arm()).toBe(false);
    expect(requests).toEqual(["http://broker.local/health"]);
    expect(states).toEqual(["incompatible"]);
  });

  test("reports an unconfigured broker without signing a check", async () => {
    const requests: string[] = [];
    const states: string[] = [];
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
      host: "test-host",
      onTrustStatus: (state: string) => states.push(state),
    });

    expect(await runtime.arm()).toBe(false);
    expect(requests).toEqual(["http://broker.local/health"]);
    expect(states).toEqual(["unconfigured"]);
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
      host: "test-host",
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
      host: "test-host",
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
      host: "test-host",
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
      host: "test-host",
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
      host: "test-host",
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
      host: "test-host",
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
      host: "test-host",
    });

    expect(await runtime.arm()).toBe(true);
    await runtime.disarm();
    expect(runtime.deps()).toBeNull();
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
      return new Response(JSON.stringify({ token_id: "tok_test", expires_at: new Date(Date.now() + 3600_000).toISOString() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const runtime = new ApprovalRuntime({
      stateDir: tmp(),
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host",
    });

    expect(await runtime.arm()).toBe(true);
    failRevoke = true;
    await runtime.disarm();
    failRevoke = false;
    requests.length = 0;

    expect(await runtime.arm()).toBe(true);
    expect(requests[0]).toBe("http://broker.local/approval/token-revoke");
  });

  test("reports an unreachable broker without claiming incompatibility", async () => {
    const stateDir = tmp();
    const states: string[] = [];
    const runtime = new ApprovalRuntime({
      stateDir,
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId: "run-test",
      host: "test-host",
      onTrustStatus: (state: string) => states.push(state),
    });

    expect(await runtime.arm()).toBe(true);
    await runtime.disarm();
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    expect(await runtime.arm()).toBe(false);
    expect(states).toEqual(["compatible", "unreachable"]);
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
      host: "test-host",
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
      host: "test-host",
    });

    expect(await runtime.arm()).toBe(false);
    expect(runtime.deps()).toBeNull();
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readdirSync(stateDir).filter((entry) => entry.includes(".bak-"))).toHaveLength(0);
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
      host: "test-host",
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
