// Card a76d8b4a: two ApprovalRuntime instances sharing the same stateDir
// (the real-world case -- two Kory processes, no requestSingleInstanceLock,
// same userData) must not collide on one credential file, or any tile in
// EITHER window ends up reading whichever operator/session/token the OTHER
// window's arm() last wrote -- a full credential impersonation, not just a
// mislabeled project_key.

import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalRuntime, approvalCredFileName } from "../desktop/src/main/approval-runtime.ts";
import type { SecretCipher } from "../desktop/src/main/scope-secrets.ts";

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
function stubMintSuccess(): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ token_id: "tok_test", expires_at: new Date(Date.now() + 3600_000).toISOString() }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

interface CredFile {
  operatorId: string;
  tokenId: string;
  sessionRef: string;
  origin: { project_key?: string };
}

function readCred(stateDir: string, projectKey: string): CredFile {
  return JSON.parse(readFileSync(join(stateDir, approvalCredFileName(projectKey)), "utf8"));
}

describe("ApprovalRuntime instance scoping (card a76d8b4a)", () => {
  test("PREDICTION: two runtimes armed with different projectDir-derived keys write to DIFFERENT paths, each carrying its OWN project_key", async () => {
    stubMintSuccess();
    try {
      const stateDir = tmp();
      const runtimeA = new ApprovalRuntime({
        stateDir,
        cipher: fakeCipher,
        endpoint: () => ({ url: "http://broker.local", token: "" }),
        sessionRef: "window-AAAAAAAAAAAA",
        host: "test-host",
        projectKey: () => "github.com/vocsap/koryphaios",
      });
      const runtimeB = new ApprovalRuntime({
        stateDir,
        cipher: fakeCipher,
        endpoint: () => ({ url: "http://broker.local", token: "" }),
        sessionRef: "window-BBBBBBBBBBBB",
        host: "test-host",
        projectKey: () => "github.com/vocsap/kerdoos",
      });

      expect(await runtimeA.arm()).toBe(true);
      expect(await runtimeB.arm()).toBe(true);

      const pathA = join(stateDir, approvalCredFileName("github.com/vocsap/koryphaios"));
      const pathB = join(stateDir, approvalCredFileName("github.com/vocsap/kerdoos"));
      expect(pathA).not.toBe(pathB);

      const credA = readCred(stateDir, "github.com/vocsap/koryphaios");
      const credB = readCred(stateDir, "github.com/vocsap/kerdoos");
      expect(credA.origin.project_key).toBe("github.com/vocsap/koryphaios");
      expect(credB.origin.project_key).toBe("github.com/vocsap/kerdoos");

      // The real defect this closes: not a mislabeled project_key, a full
      // credential swap. Both files must retain THEIR OWN tokenId and
      // sessionRef, neither overwritten by the other's arm().
      expect(credA.tokenId).not.toBe(credB.tokenId);
      expect(credA.sessionRef).toBe("window-AAAAAAAAAAAA");
      expect(credB.sessionRef).toBe("window-BBBBBBBBBBBB");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("an unprefixed file pre-existing at boot is removed after a successful arm(), never left behind with the secret in plaintext", async () => {
    stubMintSuccess();
    try {
      const stateDir = tmp();
      const { writeFileSync, mkdirSync } = await import("node:fs");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, "session-approval.json"), JSON.stringify({ privateKey: "legacy-secret-marker" }));

      const runtime = new ApprovalRuntime({
        stateDir,
        cipher: fakeCipher,
        endpoint: () => ({ url: "http://broker.local", token: "" }),
        sessionRef: "window-test",
        host: "test-host",
        projectKey: () => "github.com/vocsap/koryphaios",
      });
      expect(await runtime.arm()).toBe(true);

      // Scanned across the WHOLE directory: a rename to a neighboring name
      // would satisfy a single-path access() check while leaving the secret
      // in plaintext elsewhere (same masking pattern proven by mutation on
      // Card c9269fef lot L3).
      for (const f of readdirSync(stateDir)) {
        const content = readFileSync(join(stateDir, f), "utf-8");
        expect(content).not.toContain("legacy-secret-marker");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  function legacyFileContent(projectKey: string, marker: string): string {
    return JSON.stringify({
      brokerUrl: "http://broker.local",
      operatorId: "op-legacy",
      tokenId: "tok-legacy",
      sessionRef: "window-legacy",
      privateKey: marker,
      publicKey: "pub-legacy",
      osUserHash: "hash-legacy",
      origin: { host: "other-host", os_user_hash: "hash-legacy", project_key: projectKey },
    });
  }

  test("MAJOR1 PREDICTION: a legacy file scoped to a DIFFERENT window's project SURVIVES arm() (version cohabitation)", async () => {
    stubMintSuccess();
    try {
      const stateDir = tmp();
      const { writeFileSync, mkdirSync } = await import("node:fs");
      mkdirSync(stateDir, { recursive: true });
      const legacyPath = join(stateDir, "session-approval.json");
      writeFileSync(legacyPath, legacyFileContent("github.com/vocsap/kerdoos", "other-window-secret-marker"));

      const runtime = new ApprovalRuntime({
        stateDir,
        cipher: fakeCipher,
        endpoint: () => ({ url: "http://broker.local", token: "" }),
        sessionRef: "window-test",
        host: "test-host",
        projectKey: () => "github.com/vocsap/koryphaios",
      });
      expect(await runtime.arm()).toBe(true);

      expect(readFileSync(legacyPath, "utf-8")).toContain("other-window-secret-marker");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("MAJOR1 NEGATIVE CONTROL: a legacy file scoped to THIS window's own project is removed, and an empty project_key is treated as removable too", async () => {
    stubMintSuccess();
    try {
      const stateDirOwn = tmp();
      const { writeFileSync, mkdirSync } = await import("node:fs");
      mkdirSync(stateDirOwn, { recursive: true });
      const legacyPathOwn = join(stateDirOwn, "session-approval.json");
      writeFileSync(legacyPathOwn, legacyFileContent("github.com/vocsap/koryphaios", "own-window-secret-marker"));
      const runtimeOwn = new ApprovalRuntime({
        stateDir: stateDirOwn,
        cipher: fakeCipher,
        endpoint: () => ({ url: "http://broker.local", token: "" }),
        sessionRef: "window-test",
        host: "test-host",
        projectKey: () => "github.com/vocsap/koryphaios",
      });
      expect(await runtimeOwn.arm()).toBe(true);
      for (const f of readdirSync(stateDirOwn)) {
        expect(readFileSync(join(stateDirOwn, f), "utf-8")).not.toContain("own-window-secret-marker");
      }

      const stateDirEmpty = tmp();
      mkdirSync(stateDirEmpty, { recursive: true });
      const legacyPathEmpty = join(stateDirEmpty, "session-approval.json");
      writeFileSync(legacyPathEmpty, legacyFileContent("", "empty-project-key-secret-marker"));
      const runtimeEmpty = new ApprovalRuntime({
        stateDir: stateDirEmpty,
        cipher: fakeCipher,
        endpoint: () => ({ url: "http://broker.local", token: "" }),
        sessionRef: "window-test",
        host: "test-host",
        projectKey: () => "github.com/vocsap/koryphaios",
      });
      expect(await runtimeEmpty.arm()).toBe(true);
      for (const f of readdirSync(stateDirEmpty)) {
        expect(readFileSync(join(stateDirEmpty, f), "utf-8")).not.toContain("empty-project-key-secret-marker");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
