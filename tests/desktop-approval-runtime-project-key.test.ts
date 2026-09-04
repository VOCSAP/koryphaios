import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalRuntime, approvalCredFileName } from "../desktop/src/main/approval-runtime.ts";
import type { SecretCipher } from "../desktop/src/main/scope-secrets.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cp-approval-runtime-projectkey-"));
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

function readCredentialOrigin(stateDir: string, projectKey: string): Record<string, unknown> {
  const raw = readFileSync(join(stateDir, approvalCredFileName(projectKey)), "utf8");
  return (JSON.parse(raw) as { origin: Record<string, unknown> }).origin;
}

describe("ApprovalRuntime.arm() writes origin.project_key", () => {
  test("a supplied projectKey() is written into origin.project_key", async () => {
    stubMintSuccess();
    try {
      const stateDir = tmp();
      const runtime = new ApprovalRuntime({
        stateDir,
        cipher: fakeCipher,
        endpoint: () => ({ url: "http://broker.local", token: "" }),
        sessionRef: "window-test",
        host: "test-host",
        projectKey: () => "local:deadbeefcafebabe",
      });
      const armed = await runtime.arm();
      expect(armed).toBe(true);
      const origin = readCredentialOrigin(stateDir, "local:deadbeefcafebabe");
      expect(origin.project_key).toBe("local:deadbeefcafebabe");
      // Purely additive, per team-lead ruling: everything the identity path
      // writes stays exactly as before.
      expect(origin.host).toBe("test-host");
      expect(typeof origin.os_user_hash).toBe("string");
      expect((origin.os_user_hash as string).length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("omitting projectKey() entirely (existing callers/tests) degrades to an empty project_key, not a crash", async () => {
    stubMintSuccess();
    try {
      const stateDir = tmp();
      const runtime = new ApprovalRuntime({
        stateDir,
        cipher: fakeCipher,
        endpoint: () => ({ url: "http://broker.local", token: "" }),
        sessionRef: "window-test",
        host: "test-host",
        // projectKey intentionally omitted.
      });
      const armed = await runtime.arm();
      expect(armed).toBe(true);
      const origin = readCredentialOrigin(stateDir, "");
      expect(origin.project_key).toBe("");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a THROWING projectKey() degrades to an empty project_key -- never fails arm(), never touches identity", async () => {
    stubMintSuccess();
    try {
      const stateDir = tmp();
      const runtime = new ApprovalRuntime({
        stateDir,
        cipher: fakeCipher,
        endpoint: () => ({ url: "http://broker.local", token: "" }),
        sessionRef: "window-test",
        host: "test-host",
        projectKey: () => {
          throw new Error("git shelled out and failed");
        },
      });
      const armed = await runtime.arm();
      expect(armed).toBe(true);
      expect(runtime.operator?.operatorId).toMatch(/^[0-9a-f]{16}$/);
      const origin = readCredentialOrigin(stateDir, "");
      expect(origin.project_key).toBe("");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
