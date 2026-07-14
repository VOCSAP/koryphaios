// PLAN-v0.4 C3-M3: the Deck's roadmap client (desktop/src/main/roadmap-service).
// Verifies the project-key mirror stays consistent with server.ts (same remote
// normalization, same local: fallback) and drives the real broker routes.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { startBroker, stopBroker, type TestBroker } from "./_helper.ts";
import {
  normalizeRemoteUrl,
  computeDeckProjectKey,
  listRoadmap,
  upsertRoadmap,
  archiveRoadmap
} from "../desktop/src/main/roadmap-service.ts";
import { normalizeRemoteUrl as coreNormalize } from "../shared/summarize.ts";

let broker: TestBroker;
const tmpDirs: string[] = [];

beforeAll(async () => {
  broker = await startBroker();
});

afterAll(async () => {
  await stopBroker(broker);
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cp-roadmap-"));
  tmpDirs.push(d);
  return d;
}

// ----- project key mirror -----

test("normalizeRemoteUrl mirrors the core implementation on the doc examples", () => {
  const cases = [
    "git@github.com:vocsap/claude-peers-mcp.git",
    "https://github.com/vocsap/claude-peers-mcp.git",
    "ssh://git@gitlab.com:2222/group/proj.git",
    "git://host/only",
    "plainstring"
  ];
  for (const c of cases) {
    expect(normalizeRemoteUrl(c)).toBe(coreNormalize(c));
  }
  expect(normalizeRemoteUrl("git@github.com:vocsap/claude-peers-mcp.git")).toBe(
    "github.com/vocsap/claude-peers-mcp"
  );
});

test("computeDeckProjectKey uses the normalized origin remote of a git dir", () => {
  const dir = tmpDir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widget.git"], { cwd: dir });
  expect(computeDeckProjectKey(dir)).toBe("github.com/acme/widget");
});

test("computeDeckProjectKey falls back to local:<hash of git root>, matching server.ts", () => {
  const dir = tmpDir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  // server.ts fallback: local: + sha256(gitRoot ?? cwd)[:16]. git may report a
  // symlink-resolved root (e.g. /private/var on macOS), so hash the same value
  // the service actually read.
  const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: dir,
    encoding: "utf-8"
  }).trim();
  const expected = `local:${createHash("sha256").update(gitRoot, "utf-8").digest("hex").slice(0, 16)}`;
  expect(computeDeckProjectKey(dir)).toBe(expected);
});

test("computeDeckProjectKey on a non-git dir hashes the dir itself", () => {
  const dir = tmpDir();
  const expected = `local:${createHash("sha256").update(dir, "utf-8").digest("hex").slice(0, 16)}`;
  expect(computeDeckProjectKey(dir)).toBe(expected);
});

// ----- broker round-trip (operator writes stamped by='deck') -----

test("list/upsert/archive round-trip against a live broker", async () => {
  const endpoint = { url: broker.url, token: null };
  const key = "github.com/acme/deck-test";

  const created = await upsertRoadmap(endpoint, key, {
    title: "From the Deck",
    kind: "idea",
    priority: "should"
  });
  expect(created.created_by).toBe("deck");
  expect(created.kind).toBe("idea");

  const items = await listRoadmap(endpoint, key, {});
  expect(items.map((i) => i.id)).toContain(created.id);

  const patched = await upsertRoadmap(endpoint, key, {
    id: created.id,
    status: "in_progress"
  });
  expect(patched.status).toBe("in_progress");
  expect(patched.title).toBe("From the Deck");

  const archived = await archiveRoadmap(endpoint, created.id);
  expect(archived.status).toBe("archived");
  const after = await listRoadmap(endpoint, key, {});
  expect(after.map((i) => i.id)).not.toContain(created.id);
  const withArchived = await listRoadmap(endpoint, key, { include_archived: true });
  expect(withArchived.map((i) => i.id)).toContain(created.id);
});

test("broker errors surface as thrown messages", async () => {
  const endpoint = { url: broker.url, token: null };
  await expect(upsertRoadmap(endpoint, "k", { title: "" })).rejects.toThrow(/title/);
  await expect(archiveRoadmap(endpoint, "unknown-id")).rejects.toThrow(/unknown/);
});
