import { test, expect, describe, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalRuntime, approvalCredFileName } from "../desktop/src/main/approval-runtime.ts";
import type { SecretCipher } from "../desktop/src/main/scope-secrets.ts";
import { teamLeadInstanceToken } from "../desktop/src/main/team-lead-mcp-sweep.ts";
import { deriveTokenId } from "../desktop/src/main/approval-auth.ts";

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
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ path, body });
      return new Response(JSON.stringify(path === "/approval/token-revoke" ? { error: "broker unavailable" } : { token_id: "ignored" }), {
        status: path === "/approval/token-revoke" ? 503 : 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const stateDir = tmp();
      const projectKey = "github.com/vocsap/koryphaios";
      const runId = "run-publication-failure";
      mkdirSync(join(stateDir, approvalCredFileName(projectKey, runId)));
      const runtime = new ApprovalRuntime({
        stateDir,
        cipher: fakeCipher,
        endpoint: () => ({ url: "http://broker.local", token: "" }),
        runId,
        host: "test-host",
        projectKey: () => projectKey,
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
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify(path === "/approval/token-revoke" ? { error: "broker unavailable" } : { token_id: "ignored" }), {
        status: path === "/approval/token-revoke" ? 503 : 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

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
      });

      expect(await runtime.arm()).toBe(true);
      const path = join(stateDir, approvalCredFileName(projectKey, "run-revoke-failure"));
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
    globalThis.fetch = (async (input, init) => {
      requests.push({
        path: new URL(String(input)).pathname,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ token_id: "ignored", expires_at: "2030-01-01T00:00:00.000Z" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

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
      });

      expect(await Promise.all([runtime.arm(), runtime.arm()])).toEqual([true, true]);
      const path = join(stateDir, approvalCredFileName(projectKey, "run-concurrent-arms"));
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
    globalThis.fetch = (async (input, init) => {
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
    }) as typeof fetch;

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
      });

      const arming = runtime.arm();
      await mintStarted;
      const closing = runtime.close();
      resolveMint(new Response(JSON.stringify({ token_id: "ignored" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

      expect(await arming).toBe(false);
      await closing;
      const minted = requests.find((request) => request.path === "/approval/token-mint")!;
      const tokenId = deriveTokenId(minted.body.session_public_key as string);
      expect(requests.filter((request) => request.path === "/approval/token-revoke")).toEqual([
        expect.objectContaining({ body: expect.objectContaining({ token_id: tokenId }) }),
      ]);
      expect(existsSync(join(stateDir, approvalCredFileName(projectKey, "run-close-during-mint")))).toBe(false);
      expect(await runtime.arm()).toBe(false);
      expect(requests.filter((request) => request.path === "/approval/token-mint")).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("disarm permits a later arm while close does not", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({
        path: new URL(String(input)).pathname,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ token_id: "ignored", expires_at: "2030-01-01T00:00:00.000Z" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

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
    globalThis.fetch = (async (input, init) => {
      requests.push({
        path: new URL(String(input)).pathname,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ token_id: "ignored", expires_at: "2030-01-01T00:00:00.000Z" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

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
      });
      const runtimeB = new ApprovalRuntime({
        stateDir,
        cipher: fakeCipher,
        endpoint: () => ({ url: "http://broker.local", token: "" }),
        runId: "run-b",
        host: "test-host",
        projectKey: () => projectKey,
      });

      expect(await runtimeA.arm()).toBe(true);
      expect(await runtimeB.arm()).toBe(true);

      const pathA = join(stateDir, approvalCredFileName(projectKey, "run-a"));
      const pathB = join(stateDir, approvalCredFileName(projectKey, "run-b"));
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
