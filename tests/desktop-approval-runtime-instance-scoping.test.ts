import { test, expect, describe, afterAll, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalRuntime, approvalCredFileName, mandateBridge } from "../desktop/src/main/approval-runtime.ts";
import type { ApprovalRuntimeOptions, ReadyRootPreparation } from "../desktop/src/main/approval-runtime.ts";
import type { SecretCipher } from "../desktop/src/main/scope-secrets.ts";
import { teamLeadInstanceToken } from "../desktop/src/main/team-lead-mcp-sweep.ts";
import { deriveTokenId, generateCredential } from "../desktop/src/main/approval-auth.ts";
import { createOperatorIdentity } from "../desktop/src/main/operator-identity.ts";
import { onDeckError } from "../desktop/src/main/log.ts";
import { reachedWithin } from "./_bounded-await.ts";
import { withOperatorTrustBroker } from "./_operator-trust-broker.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cp-approval-instance-scoping-"));
  dirs.push(d);
  return d;
}

const fakeCipher: SecretCipher = {
  isAvailable: () => true,
  encrypt: (s: string) => Buffer.from(`X${s}`, "utf8"),
  decrypt: (b: Buffer) => b.toString("utf8").slice(1),
};

const originalFetch = globalThis.fetch;

interface CredFile {
  tokenId: string;
  sessionRef: string;
  privateKey: string;
}

function readCred(path: string): CredFile {
  return JSON.parse(readFileSync(path, "utf8"));
}

function directoryContents(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? directoryContents(path) : [readFileSync(path, "utf8")];
  });
}

function hasFreshRunWiring(source: string): boolean {
  const runId = source.indexOf("const approvalRunId = randomUUID()");
  const runtime = source.indexOf("const approvals = new ApprovalRuntime({", runId);
  const configEnd = source.indexOf("\n})", runtime);
  if (runId === -1 || runtime === -1 || configEnd === -1) return false;
  const config = source.slice(runtime, configEnd);
  return config.includes("runId: approvalRunId") && !config.includes("sessionRef:");
}

describe("ApprovalRuntime instance scoping", () => {
  test("the main process creates a fresh run ID for the approval runtime", () => {
    const source = readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "index.ts"), "utf8");
    expect(hasFreshRunWiring(source)).toBe(true);
    expect(hasFreshRunWiring(source.replace("runId: approvalRunId", "runId: activeScope.groupId.slice(0, 12)"))).toBe(false);
  });

  test("a failed credential publication revokes the minted token before another arm", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = withOperatorTrustBroker((async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ path, body });
      return new Response(JSON.stringify(path === "/approval/token-revoke" ? { error: "broker unavailable" } : { token_id: "ignored", expires_at: "2030-01-02T00:00:00.000Z", capabilities: { inbox_provenance: 1 } }), {
        status: path === "/approval/token-revoke" ? 503 : 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch);

    try {
      const stateDir = tmp();
      const projectKey = "github.com/vocsap/koryphaios";
      const runId = "run-publication-failure";
      mkdirSync(join(stateDir, `${approvalCredFileName(projectKey, runId, "g-instance")}.prepared-1`));
      const runtime = new ApprovalRuntime({
        stateDir,
        cipher: fakeCipher,
        endpoint: () => ({ url: "http://broker.local", token: "" }),
        runId,
        host: "test-host",
        projectKey: () => projectKey,
        groupId: () => "g-instance",
      });

      expect(await runtime.arm()).toBe(false);
      const minted = requests.find((request) => request.path === "/approval/token-mint")!;
      const tokenId = deriveTokenId(minted.body.session_public_key as string);
      expect(requests.filter((request) => request.path === "/approval/token-revoke")).toEqual([
        expect.objectContaining({ body: expect.objectContaining({ token_id: tokenId }) }),
      ]);

      expect(await runtime.arm()).toBe(false);
      expect(requests.filter((request) => request.path === "/approval/token-mint")).toHaveLength(1);
      expect(requests.filter((request) => request.path === "/approval/token-revoke")).toEqual([
        expect.objectContaining({ body: expect.objectContaining({ token_id: tokenId }) }),
        expect.objectContaining({ body: expect.objectContaining({ token_id: tokenId }) }),
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("disarm removes its credential when remote revocation fails without touching legacy credentials", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = withOperatorTrustBroker((async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ path, body });
      return new Response(JSON.stringify(path === "/approval/token-revoke" ? { error: "broker unavailable" } : { token_id: deriveTokenId(body.session_public_key as string), expires_at: "2030-01-01T00:00:00.000Z", capabilities: { inbox_provenance: 1 } }), {
        status: path === "/approval/token-revoke" ? 503 : 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch);

    try {
      const stateDir = tmp();
      const projectKey = "github.com/vocsap/koryphaios";
      const legacyPath = join(stateDir, "session-approval.json");
      const legacyContent = JSON.stringify({ privateKey: "legacy-secret-marker" });
      const legacyProjectPath = join(stateDir, `${teamLeadInstanceToken(projectKey)}-session-approval.json`);
      const legacyProjectContent = JSON.stringify({ privateKey: "legacy-project-secret-marker" });
      writeFileSync(legacyPath, legacyContent);
      writeFileSync(legacyProjectPath, legacyProjectContent);
      const runtime = new ApprovalRuntime({
        stateDir,
        cipher: fakeCipher,
        endpoint: () => ({ url: "http://broker.local", token: "" }),
        runId: "run-revoke-failure",
        host: "test-host",
        projectKey: () => projectKey,
        groupId: () => "g-instance",
      });

      expect(await runtime.arm()).toBe(true);
      const path = join(stateDir, approvalCredFileName(projectKey, "run-revoke-failure", "g-instance"));
      const cred = readCred(path);
      await runtime.disarm();

      expect(directoryContents(stateDir).some((content) => content.includes(cred.privateKey))).toBe(false);
      expect(readFileSync(legacyPath, "utf8")).toBe(legacyContent);
      expect(readFileSync(legacyProjectPath, "utf8")).toBe(legacyProjectContent);
      expect(requests.filter((request) => request.path === "/approval/token-revoke")).toEqual([
        expect.objectContaining({ body: expect.objectContaining({ token_id: cred.tokenId }) }),
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("two concurrent arms share one minted credential", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = withOperatorTrustBroker((async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ path: new URL(String(input)).pathname, body });
      const tokenId = typeof body.session_public_key === "string" ? deriveTokenId(body.session_public_key) : "ignored";
      return new Response(JSON.stringify({ token_id: tokenId, capabilities: { inbox_provenance: 1 }, expires_at: "2030-01-01T00:00:00.000Z" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch);

    try {
      const stateDir = tmp();
      const projectKey = "github.com/vocsap/koryphaios";
      const runtime = new ApprovalRuntime({
        stateDir,
        cipher: fakeCipher,
        endpoint: () => ({ url: "http://broker.local", token: "" }),
        runId: "run-concurrent-arms",
        host: "test-host",
        projectKey: () => projectKey,
        groupId: () => "g-instance",
      });

      expect(await Promise.all([runtime.arm(), runtime.arm()])).toEqual([true, true]);
      const path = join(stateDir, approvalCredFileName(projectKey, "run-concurrent-arms", "g-instance"));
      const cred = readCred(path);
      expect(requests.filter((request) => request.path === "/approval/token-mint")).toHaveLength(1);

      await runtime.disarm();

      expect(requests.filter((request) => request.path === "/approval/token-revoke")).toEqual([
        expect.objectContaining({ body: expect.objectContaining({ token_id: cred.tokenId }) }),
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("close invalidates a mint in flight and prevents later arming", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    let resolveMint = (_response: Response): void => {};
    const mintResponse = new Promise<Response>((resolve) => {
      resolveMint = resolve;
    });
    let signalMintStarted = (): void => {};
    const mintStarted = new Promise<void>((resolve) => {
      signalMintStarted = resolve;
    });
    globalThis.fetch = withOperatorTrustBroker((async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ path, body });
      if (path === "/approval/token-mint") {
        signalMintStarted();
        return mintResponse;
      }
      return new Response(JSON.stringify({ revoked: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch);

    try {
      const stateDir = tmp();
      const projectKey = "github.com/vocsap/koryphaios";
      const runtime = new ApprovalRuntime({
        stateDir,
        cipher: fakeCipher,
        endpoint: () => ({ url: "http://broker.local", token: "" }),
        runId: "run-close-during-mint",
        host: "test-host",
        projectKey: () => projectKey,
        groupId: () => "g-instance",
      });

      const arming = runtime.arm();
      const firstEvent = await reachedWithin(
        Promise.race([mintStarted.then(() => "mint-started" as const), arming.then(() => "arm-settled" as const)]),
        "arm() sends its token-mint request",
      );
      expect(firstEvent, "arm() settled before the token-mint request, so there is no in-flight mint for close() to invalidate").toBe("mint-started");
      const closing = runtime.close();
      resolveMint(new Response(JSON.stringify({ token_id: deriveTokenId(requests.find((request) => request.path === "/approval/token-mint")!.body.session_public_key as string), expires_at: "2030-01-01T00:00:00.000Z", capabilities: { inbox_provenance: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

      expect(await reachedWithin(arming, "arm() settles once the in-flight mint resolves")).toBe(false);
      await reachedWithin(closing, "close() settles once the in-flight mint resolves");
      const minted = requests.find((request) => request.path === "/approval/token-mint")!;
      const tokenId = deriveTokenId(minted.body.session_public_key as string);
      expect(requests.filter((request) => request.path === "/approval/token-revoke")).toEqual([
        expect.objectContaining({ body: expect.objectContaining({ token_id: tokenId }) }),
      ]);
      expect(existsSync(join(stateDir, approvalCredFileName(projectKey, "run-close-during-mint", "g-instance")))).toBe(false);
      expect(await runtime.arm()).toBe(false);
      expect(requests.filter((request) => request.path === "/approval/token-mint")).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("disarm permits a later arm while close does not", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = withOperatorTrustBroker((async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ path: new URL(String(input)).pathname, body });
      const tokenId = typeof body.session_public_key === "string" ? deriveTokenId(body.session_public_key) : "ignored";
      return new Response(JSON.stringify({ token_id: tokenId, capabilities: { inbox_provenance: 1 }, expires_at: "2030-01-01T00:00:00.000Z" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch);

    try {
      const stateDir = tmp();
      const projectKey = "github.com/vocsap/koryphaios";
      const runtime = new ApprovalRuntime({
        stateDir,
        cipher: fakeCipher,
        endpoint: () => ({ url: "http://broker.local", token: "" }),
        runId: "run-disarm-rearm",
        host: "test-host",
        projectKey: () => projectKey,
        groupId: () => "g-instance",
      });

      expect(await runtime.arm()).toBe(true);
      await runtime.disarm();
      expect(await runtime.arm()).toBe(true);
      await runtime.close();
      expect(await runtime.arm()).toBe(false);
      expect(requests.filter((request) => request.path === "/approval/token-mint")).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("two runs of one project keep distinct credentials and disarm only their own token", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = withOperatorTrustBroker((async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ path: new URL(String(input)).pathname, body });
      const tokenId = typeof body.session_public_key === "string" ? deriveTokenId(body.session_public_key) : "ignored";
      return new Response(JSON.stringify({ token_id: tokenId, capabilities: { inbox_provenance: 1 }, expires_at: "2030-01-01T00:00:00.000Z" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch);

    try {
      const stateDir = tmp();
      const projectKey = "github.com/vocsap/koryphaios";
      const legacyPath = join(stateDir, "session-approval.json");
      const legacyContent = JSON.stringify({ privateKey: "legacy-secret-marker" });
      const legacyProjectPath = join(stateDir, `${teamLeadInstanceToken(projectKey)}-session-approval.json`);
      const legacyProjectContent = JSON.stringify({ privateKey: "legacy-project-secret-marker" });
      writeFileSync(legacyPath, legacyContent);
      writeFileSync(legacyProjectPath, legacyProjectContent);

      const runtimeA = new ApprovalRuntime({
        stateDir,
        cipher: fakeCipher,
        endpoint: () => ({ url: "http://broker.local", token: "" }),
        runId: "run-a",
        host: "test-host",
        projectKey: () => projectKey,
        groupId: () => "g-instance",
      });
      const runtimeB = new ApprovalRuntime({
        stateDir,
        cipher: fakeCipher,
        endpoint: () => ({ url: "http://broker.local", token: "" }),
        runId: "run-b",
        host: "test-host",
        projectKey: () => projectKey,
        groupId: () => "g-instance",
      });

      expect(await runtimeA.arm()).toBe(true);
      expect(await runtimeB.arm()).toBe(true);

      const pathA = join(stateDir, approvalCredFileName(projectKey, "run-a", "g-instance"));
      const pathB = join(stateDir, approvalCredFileName(projectKey, "run-b", "g-instance"));
      expect(pathA).not.toBe(pathB);

      const credA = readCred(pathA);
      const credB = readCred(pathB);
      expect(credA.tokenId).not.toBe(credB.tokenId);
      expect(credA.sessionRef).toBe("window-run-a");
      expect(credB.sessionRef).toBe("window-run-b");
      expect(readFileSync(legacyPath, "utf8")).toBe(legacyContent);
      expect(readFileSync(legacyProjectPath, "utf8")).toBe(legacyProjectContent);

      await runtimeA.disarm();

      expect(readCred(pathB)).toEqual(credB);
      expect(readFileSync(legacyPath, "utf8")).toBe(legacyContent);
      expect(readFileSync(legacyProjectPath, "utf8")).toBe(legacyProjectContent);
      expect(directoryContents(stateDir).some((content) => content.includes(credA.privateKey))).toBe(false);
      expect(directoryContents(stateDir).some((content) => content.includes(credB.privateKey))).toBe(true);
      expect(requests.filter((request) => request.path === "/approval/token-revoke")).toEqual([
        expect.objectContaining({ body: expect.objectContaining({ token_id: credA.tokenId }) }),
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("mandateBridge", () => {
  test("reaches the runtime registry", () => {
    const calls: string[] = [];
    const bridge = mandateBridge({
      requestMandate: (ref, authority) => calls.push(`request:${ref}:${authority}`),
      releaseMandate: (ref) => calls.push(`release:${ref}`),
    });
    bridge.request("lead-1", "lead");
    bridge.release("lead-1");
    expect(calls).toEqual(["request:lead-1:lead", "release:lead-1"]);
  });
});

describe("ApprovalRuntime run credential per group", () => {
  const projectKey = "github.com/vocsap/koryphaios";
  const runId = "3f1c2a4e-9b7d-4c1e-8a2b-5d6e7f809a1b";
  const credFile = (stateDir: string, groupId = "g-one") => join(stateDir, approvalCredFileName(projectKey, runId, groupId));

  interface Recorded {
    path: string;
    body: Record<string, unknown>;
  }

  function scriptedBroker(opts: {
    revokeStatus?: () => number;
    mint?: (body: Record<string, unknown>) => Promise<Response> | Response;
  } = {}): Recorded[] {
    const requests: Recorded[] = [];
    globalThis.fetch = withOperatorTrustBroker((async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ path, body });
      if (path === "/approval/token-revoke") {
        const status = opts.revokeStatus?.() ?? 200;
        return new Response(JSON.stringify(status === 200 ? { revoked: 1 } : { error: "broker unavailable" }), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      if (opts.mint) return opts.mint(body);
      return new Response(
        JSON.stringify({ token_id: deriveTokenId(body.session_public_key as string), expires_at: "2030-01-02T00:00:00.000Z", capabilities: { renew_only: true, inbox_provenance: 1 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch);
    return requests;
  }

  function runtimeFor(stateDir: string, group: { current: string }): ApprovalRuntime {
    return new ApprovalRuntime({
      stateDir,
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId,
      host: "test-host",
      projectKey: () => projectKey,
      groupId: () => group.current,
    });
  }

  const mints = (requests: Recorded[]) => requests.filter((r) => r.path === "/approval/token-mint");

  test("credential paths isolate two groups of the same project run", () => {
    const first = approvalCredFileName(projectKey, runId, "g-one");
    const second = approvalCredFileName(projectKey, runId, "g-two");

    expect(first).toContain("g-one");
    expect(second).toContain("g-two");
    expect(first).not.toBe(second);
  });

  test("arm mints a run credential bound to this run and the active group, with a v1 proof", async () => {
    const requests = scriptedBroker();
    try {
      const stateDir = tmp();
      const runtime = runtimeFor(stateDir, { current: "g-one" });
      expect(await runtime.arm()).toBe(true);
      const [mint] = mints(requests);
      expect(mint!.body.inbox).toEqual({ version: 1, kind: "run", run_ref: runId, group_id: "g-one" });
      expect((mint!.body.auth as { v?: number }).v, "an Inbox mint must carry a v1 proof").toBe(1);
      expect(runtime.inboxRun()).toEqual({ runRef: runId, groupId: "g-one" });
      expect(JSON.parse(readFileSync(credFile(stateDir), "utf8")).inbox).toEqual({ version: 1, run_ref: runId, group_id: "g-one" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a broker that does not attest Inbox provenance gets no credential, and the token it minted is revoked", async () => {
    const requests = scriptedBroker({
      mint: () => new Response(JSON.stringify({ token_id: "minted", expires_at: "2030-01-02T00:00:00.000Z", capabilities: { renew_only: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    try {
      const stateDir = tmp();
      const runtime = runtimeFor(stateDir, { current: "g-one" });
      expect(await runtime.arm()).toBe(false);
      const tokenId = deriveTokenId(mints(requests)[0]!.body.session_public_key as string);
      expect(requests.filter((r) => r.path === "/approval/token-revoke").map((r) => r.body.token_id)).toEqual([tokenId]);
      expect(mints(requests), "no legacy mint follows the refused Inbox mint").toHaveLength(1);
      expect(existsSync(credFile(stateDir))).toBe(false);
      expect(runtime.inboxRun()).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("preparing a target scope keeps its root private until publish", async () => {
    scriptedBroker();
    try {
      const stateDir = tmp();
      const runtime = runtimeFor(stateDir, { current: "g-one" });
      runtime.requestMandate("lead-1", "lead");
      const preparation = await runtime.prepareScope({ projectKey, groupId: "g-two" });

      expect(preparation.state).toBe("ready");
      expect(runtime.inboxRun()).toBeNull();
      expect(runtime.env().CLAUDE_PEERS_APPROVAL_FILE).toBe("");
      expect(runtime.mandateState("lead-1")).toEqual({ state: "pending" });
      expect(existsSync(credFile(stateDir, "g-two"))).toBe(false);

      if (preparation.state === "ready") {
        const installed = preparation.install();
        expect(installed.state).toBe("ready");
        expect(runtime.inboxRun()).toBeNull();
        expect(runtime.env().CLAUDE_PEERS_APPROVAL_FILE).toBe("");
        await preparation.abandon();
      }
      expect(existsSync(credFile(stateDir, "g-two"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a second target waits for confirmed revocation of the prepared root", async () => {
    let revocations = 0;
    const requests = scriptedBroker({ revokeStatus: () => {
      revocations += 1;
      return 503;
    } });
    try {
      const stateDir = tmp();
      const runtime = runtimeFor(stateDir, { current: "g-one" });
      const first = await runtime.prepareScope({ projectKey, groupId: "g-one" });
      expect(first.state).toBe("ready");
      if (first.state === "ready") await first.abandon();

      const second = await runtime.prepareScope({ projectKey, groupId: "g-two" });
      expect(second).toMatchObject({ state: "refused", cause: "mint-refused" });
      expect(revocations).toBeGreaterThan(0);
      expect(mints(requests)).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a synchronous reservation lets only one concurrent target mint", async () => {
    const requests = scriptedBroker();
    try {
      const runtime = runtimeFor(tmp(), { current: "g-one" });
      const [first, second] = await Promise.all([
        runtime.prepareScope({ projectKey, groupId: "g-one" }, 0),
        runtime.prepareScope({ projectKey, groupId: "g-two" }, 0),
      ]);

      expect([first.state, second.state].filter((state) => state === "ready")).toHaveLength(1);
      expect(mints(requests)).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("preparation snapshots its target and endpoint before network waits", async () => {
    const target = { projectKey, groupId: "g-one" };
    let endpoint = { url: "http://broker.initial", token: "initial" };
    scriptedBroker({ mint: (body) => {
      target.groupId = "g-two";
      endpoint = { url: "http://broker.changed", token: "changed" };
      return new Response(JSON.stringify({ token_id: deriveTokenId(body.session_public_key as string), expires_at: "2030-01-02T00:00:00.000Z", capabilities: { renew_only: true, inbox_provenance: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } });
    try {
      const stateDir = tmp();
      const runtime = new ApprovalRuntime({
        stateDir,
        cipher: fakeCipher,
        endpoint: () => endpoint,
        runId,
        host: "test-host",
        projectKey: () => projectKey,
        groupId: () => "g-one",
      });
      const preparation = await runtime.prepareScope(target);

      expect(preparation).toMatchObject({ state: "ready", target: { projectKey, groupId: "g-one" } });
      if (preparation.state === "ready") {
        const installed = preparation.install();
        expect(installed.state).toBe("ready");
        installed.publish();
      }
      expect(JSON.parse(readFileSync(credFile(stateDir, "g-one"), "utf8"))).toMatchObject({ brokerUrl: "http://broker.initial", brokerToken: "initial" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a renewable root without a token identity and expiry is never ready", async () => {
    scriptedBroker({ mint: () => new Response(JSON.stringify({ capabilities: { renew_only: true, inbox_provenance: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }) });
    try {
      const runtime = runtimeFor(tmp(), { current: "g-one" });
      expect(await runtime.prepareScope({ projectKey, groupId: "g-one" })).toMatchObject({ state: "refused", cause: "mint-refused" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a prepared root cannot publish after close", async () => {
    scriptedBroker();
    try {
      const stateDir = tmp();
      const runtime = runtimeFor(stateDir, { current: "g-one" });
      const preparation = await runtime.prepareScope({ projectKey, groupId: "g-one" });
      expect(preparation.state).toBe("ready");
      if (preparation.state === "ready") {
        expect(preparation.install().state).toBe("ready");
        const closing = runtime.close();
        expect(() => preparation.publish()).toThrow("prepared root is no longer publishable");
        await closing;
      }
      expect(runtime.env().CLAUDE_PEERS_APPROVAL_FILE).toBe("");
      expect(runtime.inboxRun()).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("ApprovalRuntime prepared root lifecycle", () => {
  const projectKey = "github.com/vocsap/koryphaios";
  const runId = "0b6d1f3a-5c2e-4a7b-9d8e-1f2a3b4c5d6e";
  const target = { projectKey, groupId: "g-one" };
  const publishRefusal = "prepared root is no longer publishable";
  const publicFile = (stateDir: string, scope = target) => join(stateDir, approvalCredFileName(scope.projectKey, runId, scope.groupId));

  interface Wire {
    path: string;
    url: string;
    body: Record<string, any>;
  }

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const validMint = (body: Record<string, any>): Response =>
    json({ token_id: deriveTokenId(body.session_public_key), expires_at: "2030-01-02T00:00:00.000Z", capabilities: { renew_only: true, inbox_provenance: 1 } });

  function wireBroker(opts: {
    mint?: (body: Record<string, any>, nth: number) => Promise<Response> | Response;
    revoke?: (body: Record<string, any>, nth: number) => Response;
    trustGate?: Promise<void>;
    trustAsked?: () => void;
  } = {}): Wire[] {
    const wire: Wire[] = [];
    let mintCount = 0;
    let revokeCount = 0;
    const trusted = withOperatorTrustBroker((async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      wire.push({ path, url: String(input), body });
      if (path === "/approval/token-revoke") return (opts.revoke ?? (() => json({ revoked: 1 })))(body, ++revokeCount);
      return (opts.mint ?? validMint)(body, ++mintCount);
    }) as typeof fetch);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (opts.trustGate && String(input).endsWith("/operator/check")) {
        opts.trustAsked?.();
        await opts.trustGate;
      }
      return trusted(input, init);
    }) as typeof fetch;
    return wire;
  }

  const mints = (wire: Wire[]) => wire.filter((w) => w.path === "/approval/token-mint");
  const revokes = (wire: Wire[]) => wire.filter((w) => w.path === "/approval/token-revoke");
  const firstToken = (wire: Wire[]) => deriveTokenId(mints(wire)[0]!.body.session_public_key as string);
  const revokedTokens = (wire: Wire[]) => revokes(wire).map((w) => w.body.token_id);
  const credentialEntries = (stateDir: string) =>
    readdirSync(stateDir).filter((name) => name.includes(".prepared") || name.endsWith("session-approval.json"));

  async function until(cond: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 50 && !cond(); i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(cond(), what).toBe(true);
  }

  function runtimeWith(stateDir: string, extra: Partial<ApprovalRuntimeOptions> = {}): ApprovalRuntime {
    return new ApprovalRuntime({
      stateDir,
      cipher: fakeCipher,
      endpoint: () => ({ url: "http://broker.local", token: "" }),
      runId,
      host: "test-host",
      projectKey: () => projectKey,
      groupId: () => "g-one",
      ...extra,
    });
  }

  async function readyOf(runtime: ApprovalRuntime, scope = target): Promise<ReadyRootPreparation> {
    const preparation = await runtime.prepareScope(scope);
    if (preparation.state !== "ready") throw new Error(`preparation refused: ${preparation.cause}`);
    return preparation;
  }

  function installedOf(preparation: ReadyRootPreparation): ReadyRootPreparation {
    const installed = preparation.install();
    if (installed.state !== "ready") throw new Error(`install refused: ${installed.cause}`);
    return installed;
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
    onDeckError(() => {});
  });

  test("a held ready preparation refuses a second target without minting or revoking", async () => {
    const wire = wireBroker();
    const runtime = runtimeWith(tmp());
    const first = await readyOf(runtime);

    expect((await runtime.prepareScope({ projectKey, groupId: "g-two" })).state).toBe("refused");
    expect(mints(wire)).toHaveLength(1);
    expect(revokes(wire), "refusing the second target must leave the held root untouched").toHaveLength(0);
    await first.abandon();
  });

  test("abandoning a published root leaves its credential, Inbox and token in place", async () => {
    const wire = wireBroker();
    const stateDir = tmp();
    const runtime = runtimeWith(stateDir);
    const prepared = installedOf(await readyOf(runtime));
    prepared.publish();

    await prepared.abandon();

    expect(existsSync(publicFile(stateDir))).toBe(true);
    expect(runtime.env().CLAUDE_PEERS_APPROVAL_FILE).toBe(publicFile(stateDir));
    expect(runtime.inboxRun()).toEqual({ runRef: runId, groupId: "g-one" });
    expect(revokes(wire)).toHaveLength(0);
    await runtime.disarm();
  });

  test("a refused target leaves an in-flight and a ready preparation installable", async () => {
    let releaseMint = (): void => {};
    const mintGate = new Promise<void>((resolve) => {
      releaseMint = resolve;
    });
    let signalMint = (): void => {};
    const mintStarted = new Promise<void>((resolve) => {
      signalMint = resolve;
    });
    const wire = wireBroker({
      mint: async (body) => {
        signalMint();
        await mintGate;
        return validMint(body);
      },
    });
    const runtime = runtimeWith(tmp());

    const preparing = runtime.prepareScope(target);
    await reachedWithin(mintStarted, "the first preparation reaches its mint");
    expect(await runtime.prepareScope({ projectKey, groupId: "g-two" })).toMatchObject({ state: "refused", cause: "busy" });
    releaseMint();
    const ready = await reachedWithin(preparing, "the first preparation becomes ready");
    expect(ready.state).toBe("ready");
    expect(await runtime.prepareScope({ projectKey, groupId: "g-two" })).toMatchObject({ state: "refused", cause: "busy" });
    if (ready.state === "ready") {
      expect(ready.install().state).toBe("ready");
      await ready.abandon();
    }
    expect(mints(wire)).toHaveLength(1);
  });

  test("non-credential admission refusals preserve their own causes", async () => {
    wireBroker();
    const busyRuntime = runtimeWith(tmp());
    const held = await readyOf(busyRuntime);
    expect(await busyRuntime.prepareScope({ projectKey, groupId: "g-two" })).toMatchObject({ state: "refused", cause: "busy" });
    await held.abandon();

    const disarmingRuntime = runtimeWith(tmp());
    const disarming = disarmingRuntime.disarm();
    expect(await disarmingRuntime.prepareScope(target)).toMatchObject({ state: "refused", cause: "busy" });
    await disarming;

    const closedRuntime = runtimeWith(tmp());
    await closedRuntime.close();
    expect(await closedRuntime.prepareScope(target)).toMatchObject({ state: "refused", cause: "closed" });

    const invalidRuntime = runtimeWith(tmp());
    expect(await invalidRuntime.prepareScope({ projectKey, groupId: "" })).toMatchObject({ state: "refused", cause: "invalid-target" });
    expect(await invalidRuntime.prepareScope({ projectKey: "", groupId: "g-two" })).toMatchObject({ state: "refused", cause: "invalid-target" });
  });

  test("a prepared root cannot publish before it is installed, and the refused publish revokes it", async () => {
    const wire = wireBroker();
    const stateDir = tmp();
    const runtime = runtimeWith(stateDir);
    const prepared = await readyOf(runtime);

    expect(() => prepared.publish()).toThrow(publishRefusal);
    expect(runtime.inboxRun()).toBeNull();
    expect(runtime.env().CLAUDE_PEERS_APPROVAL_FILE).toBe("");
    await until(() => revokes(wire).length === 1, "the refused publish revokes the prepared token");
    expect(revokedTokens(wire)).toEqual([firstToken(wire)]);
    expect(credentialEntries(stateDir)).toEqual([]);
  });

  test("a prepared root cannot publish after its ticket was abandoned", async () => {
    wireBroker();
    const stateDir = tmp();
    const runtime = runtimeWith(stateDir);
    const installed = installedOf(await readyOf(runtime));
    expect(existsSync(publicFile(stateDir))).toBe(true);

    await installed.abandon();
    expect(() => installed.publish()).toThrow(publishRefusal);
    expect(runtime.inboxRun()).toBeNull();
    expect(runtime.env().CLAUDE_PEERS_APPROVAL_FILE).toBe("");
    expect(existsSync(publicFile(stateDir))).toBe(false);
  });

  test("a prepared root cannot publish once a disarm has begun", async () => {
    wireBroker();
    const runtime = runtimeWith(tmp());
    const installed = installedOf(await readyOf(runtime));

    const disarming = runtime.disarm();
    expect(() => installed.publish()).toThrow(publishRefusal);
    await disarming;
    expect(runtime.inboxRun()).toBeNull();
  });

  test("a prepared root cannot publish at or past its expiry, and the refused publish revokes it", async () => {
    const wire = wireBroker();
    const stateDir = tmp();
    let now = Date.parse("2030-01-01T00:00:00.000Z");
    const runtime = runtimeWith(stateDir, { now: () => now });
    const installed = installedOf(await readyOf(runtime));

    now = Date.parse("2030-01-02T00:00:00.000Z");
    expect(() => installed.publish()).toThrow(publishRefusal);
    expect(runtime.inboxRun()).toBeNull();
    await until(() => revokes(wire).length === 1, "the expired root is revoked");
    expect(revokedTokens(wire)).toEqual([firstToken(wire)]);
    expect(existsSync(publicFile(stateDir))).toBe(false);
  });

  test("installing a second time after publish is refused and leaves the live credential in place", async () => {
    const wire = wireBroker();
    const stateDir = tmp();
    const runtime = runtimeWith(stateDir);
    const prepared = await readyOf(runtime);
    installedOf(prepared).publish();
    expect(existsSync(publicFile(stateDir))).toBe(true);

    expect(prepared.install().state).toBe("refused");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(existsSync(publicFile(stateDir)), "a stale ticket must not remove the published credential").toBe(true);
    expect(runtime.inboxRun()).toEqual({ runRef: runId, groupId: "g-one" });
    expect(revokes(wire)).toHaveLength(0);
    await runtime.disarm();
  });

  test("installing is refused once a disarm has begun", async () => {
    wireBroker();
    const stateDir = tmp();
    const runtime = runtimeWith(stateDir);
    const prepared = await readyOf(runtime);

    const disarming = runtime.disarm();
    expect(prepared.install().state).toBe("refused");
    await disarming;
    expect(existsSync(publicFile(stateDir))).toBe(false);
  });

  test("an install that cannot write the credential path is refused as local-file, leaves nothing and revokes", async () => {
    const wire = wireBroker();
    const stateDir = tmp();
    const runtime = runtimeWith(stateDir);
    const prepared = await readyOf(runtime);
    mkdirSync(publicFile(stateDir));
    writeFileSync(join(publicFile(stateDir), "occupied"), "x");

    expect(prepared.install()).toMatchObject({ state: "refused", cause: "local-file" });
    expect(runtime.inboxRun()).toBeNull();
    expect(runtime.env().CLAUDE_PEERS_APPROVAL_FILE).toBe("");
    await until(() => revokes(wire).length === 1, "the failed install revokes the prepared token");
    expect(revokedTokens(wire)).toEqual([firstToken(wire)]);
    expect(readdirSync(stateDir).filter((name) => name.includes(".prepared"))).toEqual([]);
  });

  test("abandoning an uninstalled preparation removes its private file and revokes its token at once", async () => {
    const wire = wireBroker();
    const stateDir = tmp();
    const runtime = runtimeWith(stateDir);
    const prepared = await readyOf(runtime);
    expect(credentialEntries(stateDir), "the prepared credential is on disk before the abandon").toHaveLength(1);

    await prepared.abandon();
    expect(credentialEntries(stateDir)).toEqual([]);
    expect(revokedTokens(wire)).toEqual([firstToken(wire)]);
  });

  test("close removes the installed credential of a preparation that was never published", async () => {
    const wire = wireBroker();
    const stateDir = tmp();
    const runtime = runtimeWith(stateDir);
    installedOf(await readyOf(runtime));
    expect(existsSync(publicFile(stateDir))).toBe(true);

    await runtime.close();
    expect(existsSync(publicFile(stateDir))).toBe(false);
    expect(credentialEntries(stateDir)).toEqual([]);
    expect(revokedTokens(wire)).toEqual([firstToken(wire)]);
  });

  test("a close during an unanswered mint revokes the token at once and again when the mint lands, and nothing becomes ready", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalAsked = (): void => {};
    const asked = new Promise<void>((resolve) => {
      signalAsked = resolve;
    });
    let answered = false;
    const wire = wireBroker({
      mint: async (body) => {
        signalAsked();
        await gate;
        answered = true;
        return validMint(body);
      },
      revoke: () => json({ revoked: answered ? 1 : 0 }),
    });
    const stateDir = tmp();
    const runtime = runtimeWith(stateDir);

    const preparing = runtime.prepareScope(target);
    await reachedWithin(asked, "the token-mint request reaches the broker");
    await reachedWithin(runtime.close(), "close() settles while the mint is unanswered");
    const token = firstToken(wire);
    expect(revokedTokens(wire), "the token derived before the mint must be revoked by close()").toEqual([token]);

    release();
    const result = await reachedWithin(preparing, "the preparation settles once the mint lands");
    expect(result.state).toBe("refused");
    expect(revokedTokens(wire), "a mint landing after the close is revoked again").toEqual([token, token]);
    expect(credentialEntries(stateDir)).toEqual([]);
  });

  test("a close during the operator trust check refuses the preparation before any mint", async () => {
    let release = (): void => {};
    const trustGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalAsked = (): void => {};
    const asked = new Promise<void>((resolve) => {
      signalAsked = resolve;
    });
    const wire = wireBroker({ trustGate, trustAsked: signalAsked });
    const runtime = runtimeWith(tmp());

    const preparing = runtime.prepareScope(target);
    await reachedWithin(asked, "the operator trust check reaches the broker");
    await reachedWithin(runtime.close(), "close() settles while the trust check is unanswered");
    release();
    expect(await reachedWithin(preparing, "the preparation settles once the trust check answers")).toMatchObject({ state: "refused", cause: "trust" });
    expect(mints(wire), "no token may be minted for a run that closed during the trust check").toHaveLength(0);
  });

  const mintFailures: Array<{ label: string; respond: () => Response; keepsDebt: boolean }> = [
    { label: "a 400 answer", respond: () => json({ error: "rejected" }, 400), keepsDebt: false },
    { label: "a 409 answer", respond: () => json({ error: "conflict" }, 409), keepsDebt: false },
    { label: "a 500 answer", respond: () => json({ error: "broker failure" }, 500), keepsDebt: true },
    { label: "a 503 answer", respond: () => json({ error: "broker unavailable" }, 503), keepsDebt: true },
    { label: "a connection failure", respond: () => { throw new TypeError("connection reset"); }, keepsDebt: true },
  ];
  for (const failure of mintFailures) {
    test(`a mint ending in ${failure.label} ${failure.keepsDebt ? "keeps" : "releases"} the token debt for the next preparation`, async () => {
      const wire = wireBroker({ mint: (body, nth) => (nth === 1 ? failure.respond() : validMint(body)) });
      const runtime = runtimeWith(tmp());

      expect(await runtime.prepareScope(target)).toMatchObject({ state: "refused", cause: "mint-refused" });
      const failedToken = firstToken(wire);
      const second = await runtime.prepareScope(target);
      expect(second.state).toBe("ready");

      const order = wire
        .filter((w) => w.path === "/approval/token-mint" || w.path === "/approval/token-revoke")
        .map((w) => (w.path === "/approval/token-mint" ? "mint" : `revoke:${w.body.token_id}`));
      expect(order).toEqual(failure.keepsDebt ? ["mint", `revoke:${failedToken}`, "mint"] : ["mint", "mint"]);
      if (second.state === "ready") await second.abandon();
    });
  }

  const UNCONFIRMED_DEBT_TEXT = "La réponse de création du credential n'est pas confirmée. Tout nouveau credential reste bloqué jusqu'à confirmation de la révocation.";
  for (const failure of mintFailures) {
    test(`a mint ending in ${failure.label} ${failure.keepsDebt ? "journals" : "does not journal"} the unconfirmed-credential debt in the operator's words`, async () => {
      wireBroker({ mint: (body, nth) => (nth === 1 ? failure.respond() : validMint(body)) });
      const errors: string[] = [];
      onDeckError((_scope, text) => errors.push(text));
      const runtime = runtimeWith(tmp());

      expect(await runtime.prepareScope(target)).toMatchObject({ state: "refused", cause: "mint-refused" });
      expect(errors.filter((text) => text.startsWith(`${UNCONFIRMED_DEBT_TEXT}: `))).toHaveLength(failure.keepsDebt ? 1 : 0);
    });
  }

  test("a revocation answered with zero keeps the debt and blocks the next mint", async () => {
    const wire = wireBroker({ revoke: () => json({ revoked: 0 }) });
    const runtime = runtimeWith(tmp());
    await (await readyOf(runtime)).abandon();

    expect(await runtime.prepareScope({ projectKey, groupId: "g-two" })).toMatchObject({ state: "refused", cause: "mint-refused" });
    expect(mints(wire)).toHaveLength(1);
  });

  test("a prepared root takes its project, group and endpoint from the ticket, not from the runtime resolvers", async () => {
    let endpoint = { url: "http://broker.initial", token: "initial" };
    const wire = wireBroker({
      mint: (body) => {
        endpoint = { url: "http://broker.changed", token: "changed" };
        return validMint(body);
      },
    });
    const stateDir = tmp();
    const runtime = runtimeWith(stateDir, {
      endpoint: () => endpoint,
      projectKey: () => "github.com/vocsap/resolver-project",
      groupId: () => "g-resolver",
    });
    const ticket = { projectKey: "github.com/vocsap/ticket-project", groupId: "g-ticket" };

    installedOf(await readyOf(runtime, ticket)).publish();
    const credential = JSON.parse(readFileSync(publicFile(stateDir, ticket), "utf8"));
    expect(credential.inbox).toEqual({ version: 1, run_ref: runId, group_id: "g-ticket" });
    expect(credential.origin.project_key).toBe(ticket.projectKey);
    expect(mints(wire)[0]!.body).toMatchObject({ project_key: ticket.projectKey, inbox: { group_id: "g-ticket" } });
    expect(runtime.inboxRun()).toEqual({ runRef: runId, groupId: "g-ticket" });

    await runtime.disarm();
    expect(revokes(wire)[0]!.url, "the revocation goes to the endpoint the mint was sent to").toStartWith("http://broker.initial");
  });

  test("a mint response without a token id is refused as mint-refused and its token revoked", async () => {
    const wire = wireBroker({ mint: () => json({ expires_at: "2030-01-02T00:00:00.000Z", capabilities: { renew_only: true, inbox_provenance: 1 } }) });
    const stateDir = tmp();
    const runtime = runtimeWith(stateDir);

    expect(await runtime.prepareScope(target)).toMatchObject({ state: "refused", cause: "mint-refused" });
    expect(revokedTokens(wire)).toEqual([firstToken(wire)]);
    expect(credentialEntries(stateDir)).toEqual([]);
  });

  test("a mint response without the Inbox provenance capability is refused as capability", async () => {
    const wire = wireBroker({
      mint: (body) => json({ token_id: deriveTokenId(body.session_public_key), expires_at: "2030-01-02T00:00:00.000Z", capabilities: { renew_only: true } }),
    });
    const runtime = runtimeWith(tmp());

    expect(await runtime.prepareScope(target)).toMatchObject({ state: "refused", cause: "capability" });
    expect(revokedTokens(wire)).toEqual([firstToken(wire)]);
  });

  test("a credential file that cannot be written is refused as local-file and its token revoked", async () => {
    const wire = wireBroker();
    const stateDir = tmp();
    for (let generation = 0; generation < 8; generation++) mkdirSync(`${publicFile(stateDir)}.prepared-${generation}`);
    const runtime = runtimeWith(stateDir);

    expect(await runtime.prepareScope(target)).toMatchObject({ state: "refused", cause: "local-file" });
    expect(revokedTokens(wire)).toEqual([firstToken(wire)]);
    expect(runtime.env().CLAUDE_PEERS_APPROVAL_FILE).toBe("");
  });

  test("an operator identity the keychain cannot read is refused as identity before any request", async () => {
    const wire = wireBroker();
    const stateDir = tmp();
    createOperatorIdentity(stateDir, fakeCipher, generateCredential());
    const unavailableCipher: SecretCipher = {
      isAvailable: () => false,
      encrypt: () => {
        throw new Error("keychain unavailable");
      },
      decrypt: () => {
        throw new Error("keychain unavailable");
      },
    };
    const runtime = runtimeWith(stateDir, { cipher: unavailableCipher });

    expect(await runtime.prepareScope(target)).toMatchObject({ state: "refused", cause: "identity" });
    expect(wire).toHaveLength(0);
  });

  test("a broker without the operator trust handshake is refused as trust before any mint", async () => {
    const asked: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      asked.push(String(input));
      return json({ status: "ok" });
    }) as typeof fetch;
    const runtime = runtimeWith(tmp());

    expect(await runtime.prepareScope(target)).toMatchObject({ state: "refused", cause: "trust" });
    expect(asked).toEqual(["http://broker.local/health"]);
  });

  test("an unreachable broker is refused as trust", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("broker down");
    }) as typeof fetch;
    const runtime = runtimeWith(tmp());

    expect(await runtime.prepareScope(target)).toMatchObject({ state: "refused", cause: "trust" });
  });

  test("an endpoint resolver that throws refuses the preparation as trust, traced, with nothing sent", async () => {
    const wire = wireBroker();
    const errors: string[] = [];
    onDeckError((_scope, text) => errors.push(text));
    let failing = true;
    const runtime = runtimeWith(tmp(), {
      endpoint: () => {
        if (failing) throw new Error("endpoint unavailable");
        return { url: "http://broker.local", token: "" };
      },
    });

    expect(await runtime.prepareScope(target)).toMatchObject({ state: "refused", cause: "trust" });
    expect(errors.some((text) => text.includes("could not resolve the broker endpoint"))).toBe(true);
    expect(wire).toHaveLength(0);

    failing = false;
    const second = await runtime.prepareScope(target);
    expect(second.state, "a refused endpoint resolution must release the reservation").toBe("ready");
    if (second.state === "ready") await second.abandon();
  });

  test("preparing a new target withdraws the published root locally and revokes it before minting", async () => {
    const wire = wireBroker();
    const stateDir = tmp();
    const runtime = runtimeWith(stateDir);
    expect(await runtime.arm()).toBe(true);
    const publishedToken = firstToken(wire);
    expect(runtime.inboxRun(), "the root is published before the preparation starts").not.toBeNull();

    const next = await readyOf(runtime, { projectKey, groupId: "g-two" });
    expect(runtime.inboxRun()).toBeNull();
    expect(runtime.env().CLAUDE_PEERS_APPROVAL_FILE).toBe("");
    expect(existsSync(publicFile(stateDir))).toBe(false);
    const order = wire
      .filter((w) => w.path === "/approval/token-mint" || w.path === "/approval/token-revoke")
      .map((w) => (w.path === "/approval/token-mint" ? "mint" : `revoke:${w.body.token_id}`));
    expect(order).toEqual(["mint", `revoke:${publishedToken}`, "mint"]);
    await next.abandon();
  });

  test("the endpoint resolved when a preparation starts serves its mint even if the resolver changes while the previous token is revoked", async () => {
    let endpoint = { url: "http://broker.initial", token: "initial" };
    const wire = wireBroker({
      mint: (body, nth) => (nth === 1 ? json({ error: "broker unavailable" }, 503) : validMint(body)),
      revoke: () => {
        endpoint = { url: "http://broker.changed", token: "changed" };
        return json({ revoked: 1 });
      },
    });
    const runtime = runtimeWith(tmp(), { endpoint: () => endpoint });

    expect((await runtime.prepareScope(target)).state).toBe("refused");
    const second = await runtime.prepareScope(target);
    expect(second.state).toBe("ready");
    expect(mints(wire)[1]!.url).toStartWith("http://broker.initial");
    if (second.state === "ready") await second.abandon();
  });

  test("a ticket with an empty group id is refused before any request", async () => {
    const wire = wireBroker();

    expect(await runtimeWith(tmp()).prepareScope({ projectKey, groupId: "" })).toMatchObject({ state: "refused" });
    expect(wire).toHaveLength(0);
  });
});
