// Proves the fix is a derivation, not documentation: the verb computes its own
// project_key from its own cwd's git remote and refuses, before any network
// call, a payload whose declared project_key disagrees with that derivation.
// Spawns the real `bun cli.ts roadmap-add` subprocess against a fixture git
// repo with a known fake remote and inspects the actual HTTP body sent, rather
// than source-scanning cli.ts (which would pass on a call that is present but
// discarded).
// Uses a minimal Bun.serve() stub to capture the POST body instead of a real
// broker: broker-side validation of that body is covered elsewhere.

import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fixed, fake remote. Only `git remote get-url origin` is ever invoked
// against it (never fetched/cloned), so no network reaches github.com. Its
// normalized form is asserted directly against normalizeRemoteUrl's own
// documented behaviour (shared/project-key.ts) rather than re-derived here:
// SCP-like form, .git suffix stripped, whole key lowercased (host AND path).
const REMOTE_URL = "git@github.com:Acme/Widget-Repo.git";
const DERIVED_PROJECT_KEY = "github.com/acme/widget-repo";

const CLI_ROOT = join(import.meta.dir, "..");

let repoDir: string;
let mockServer: ReturnType<typeof Bun.serve>;
let mockUrl: string;
let receivedBodies: Record<string, unknown>[];

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), "cp-cli-pk-"));
  const init = Bun.spawnSync(["git", "init", "-q"], { cwd: repoDir });
  if (init.exitCode !== 0) {
    throw new Error(`git init failed in test fixture: ${init.stderr?.toString()}`);
  }
  const remote = Bun.spawnSync(["git", "remote", "add", "origin", REMOTE_URL], { cwd: repoDir });
  if (remote.exitCode !== 0) {
    throw new Error(`git remote add failed in test fixture: ${remote.stderr?.toString()}`);
  }

  // Minimal stub, not a real broker: only /roadmap/upsert is ever hit by
  // this verb, and only the received body matters here.
  mockServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/roadmap/upsert") {
        const body = (await req.json()) as Record<string, unknown>;
        receivedBodies.push(body);
        return Response.json({
          item: { id: "stub-id", project_key: body.project_key, title: body.title },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  mockUrl = `http://127.0.0.1:${mockServer.port}`;
});

afterAll(() => {
  mockServer.stop(true);
  rmSync(repoDir, { recursive: true, force: true });
});

beforeEach(() => {
  receivedBodies = [];
});

function scrubbedEnv(extra: Record<string, string>): Record<string, string> {
  // Own the broker config entirely through explicit overrides, never
  // inherit a developer's real CLAUDE_PEERS_BROKER_URL/TOKEN from the
  // ambient shell.
  const scrubbed = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE_PEERS_"))
  ) as Record<string, string>;
  return { ...scrubbed, ...extra };
}

async function runRoadmapAdd(
  payload: Record<string, unknown>
): Promise<{ code: number; stdout: string; stderr: string }> {
  const payloadFile = join(repoDir, `payload-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(payloadFile, JSON.stringify(payload));
  const proc = Bun.spawn(["bun", join(CLI_ROOT, "cli.ts"), "roadmap-add", "--input", payloadFile], {
    cwd: repoDir,
    env: scrubbedEnv({ CLAUDE_PEERS_BROKER_URL: mockUrl }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

test("roadmap-add derives project_key from its own cwd's git remote when the payload omits it", async () => {
  const res = await runRoadmapAdd({ by: "tester", title: "derived key card" });
  expect(res.code).toBe(0);
  expect(receivedBodies.length).toBe(1);
  expect(receivedBodies[0]?.project_key).toBe(DERIVED_PROJECT_KEY);
});

test("roadmap-add accepts a payload project_key that matches the derived one (no-op)", async () => {
  const res = await runRoadmapAdd({
    by: "tester",
    title: "matching key card",
    project_key: DERIVED_PROJECT_KEY,
  });
  expect(res.code).toBe(0);
  expect(receivedBodies.length).toBe(1);
  expect(receivedBodies[0]?.project_key).toBe(DERIVED_PROJECT_KEY);
});

test("roadmap-add REFUSES a payload project_key that disagrees with the derived one, before any network call", async () => {
  const res = await runRoadmapAdd({
    by: "tester",
    title: "mismatched key card",
    project_key: "github.com/someone/else",
  });
  expect(res.code).not.toBe(0);
  expect(res.stderr).toContain("does not match");
  // Refused client-side: the mock never saw a request for this call.
  expect(receivedBodies.length).toBe(0);
});

test("roadmap-add catches a mismatch that differs only by CASE (the exact incident this closes)", async () => {
  const uppercasedKey = "github.com/Acme/Widget-Repo"; // same repo, wrong casing
  const res = await runRoadmapAdd({
    by: "tester",
    title: "wrongly-cased key card",
    project_key: uppercasedKey,
  });
  expect(res.code).not.toBe(0);
  expect(res.stderr).toContain("does not match");
  expect(receivedBodies.length).toBe(0);
});
