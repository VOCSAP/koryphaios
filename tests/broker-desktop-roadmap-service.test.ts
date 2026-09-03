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
  configureRoadmapSigner,
  resetRoadmapSigner,
  listRoadmap,
  upsertRoadmap,
  archiveRoadmap,
  reorderRoadmap
} from "../desktop/src/main/roadmap-service.ts";
import { normalizeRemoteUrl as coreNormalize } from "../shared/summarize.ts";
import { buildAuthProof, deriveOperatorId, generateCredential } from "../shared/approval.ts";

let broker: TestBroker;
const tmpDirs: string[] = [];

// Card 39c40571 layer 2: these writes are authored by 'deck', so the broker
// demands an operator signature. Configuring the loader here exercises the same
// seam index.ts uses in the app, end to end against a real broker: a green
// round-trip below proves the Deck half and the broker half agree on the proof.
const deckOperator = generateCredential();

beforeAll(async () => {
  broker = await startBroker();
  configureRoadmapSigner(() => (payload) => {
    const signed = { ...payload, public_key: deckOperator.publicKey };
    return {
      public_key: deckOperator.publicKey,
      auth: buildAuthProof(deckOperator.privateKey, signed, {
        kind: "operator",
        operator_id: deriveOperatorId(deckOperator.publicKey)
      })
    };
  });
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

// upsertRoadmap relies on `...fields` spread to carry inactive onto the wire; a
// pick-list there would silently drop the field with no type or runtime error,
// so only a real round trip proves it survives.
test("upsertRoadmap threads `inactive` through to the broker, same call shape as toggleInactive", async () => {
  const endpoint = { url: broker.url, token: null };
  const key = "github.com/acme/deck-inactive-test";

  const created = await upsertRoadmap(endpoint, key, { title: "parked from the Deck" });
  expect(created.inactive).toBe(false);

  // Exactly the shape RoadmapView.tsx's toggleInactive() sends: only `id`
  // and `inactive`, nothing else.
  const parked = await upsertRoadmap(endpoint, key, { id: created.id, inactive: true });
  expect(parked.inactive).toBe(true);
  expect(parked.title).toBe("parked from the Deck"); // untouched field survives too

  const reactivated = await upsertRoadmap(endpoint, key, { id: created.id, inactive: false });
  expect(reactivated.inactive).toBe(false);

  // Belt-and-suspenders: re-read through the OTHER read path (listRoadmap),
  // so a bug that only affected the upsert response's own echo, not the
  // stored row, would not hide behind it.
  const parkedAgain = await upsertRoadmap(endpoint, key, { id: created.id, inactive: true });
  expect(parkedAgain.inactive).toBe(true);
  const items = await listRoadmap(endpoint, key, {});
  const stored = items.find((i) => i.id === created.id);
  expect(stored?.inactive).toBe(true);
});

test("broker errors surface as thrown messages", async () => {
  const endpoint = { url: broker.url, token: null };
  await expect(upsertRoadmap(endpoint, "k", { title: "" })).rejects.toThrow(/title/);
  await expect(archiveRoadmap(endpoint, "unknown-id")).rejects.toThrow(/unknown/);
});

// Waves (roadmap card 42edc88b phase 1): the optional param threads through
// end to end, and omitting it stays byte-identical (no `waves` key on the
// wire) to the pre-phase-1 request shape.
test("reorderRoadmap threads an optional waves param through to the broker", async () => {
  const endpoint = { url: broker.url, token: null };
  const key = "github.com/acme/deck-waves-test";

  const a = await upsertRoadmap(endpoint, key, { title: "wave a" });
  const b = await upsertRoadmap(endpoint, key, { title: "wave b" });

  const items = await reorderRoadmap(endpoint, key, [a.id, b.id], [[a.id, b.id]]);
  const byId = new Map(items.map((i) => [i.id, i]));
  expect(byId.get(a.id)?.queue).toBe(1);
  expect(byId.get(b.id)?.queue).toBe(1);

  // Omitting waves keeps the flat 1..N stamping.
  const flat = await reorderRoadmap(endpoint, key, [a.id, b.id]);
  const flatById = new Map(flat.map((i) => [i.id, i]));
  expect(flatById.get(a.id)?.queue).toBe(1);
  expect(flatById.get(b.id)?.queue).toBe(2);
});

// Card 39c40571 layer 2, DECK-SIDE negative control.
//
// Every test above passes BECAUSE a signer is configured, which means they
// cannot tell a working signature from a broker that stopped asking. Removing
// the signer must therefore turn the very same call into a refusal, and the
// message must be specific enough for a reader to tell an ACTIVE guard from an
// ABSENT one -- the two are indistinguishable from the outside otherwise, and
// a broker process can be hours older than the code it was started from.
test("with no signer configured, an operator-authored write is refused, loudly", async () => {
  const endpoint = { url: broker.url, token: null };
  const key = "github.com/acme/deck-unsigned-test";

  // First prove the probe SEES: signed, this exact call works.
  const ok = await upsertRoadmap(endpoint, key, { title: "signed write" });
  expect(ok.id.length).toBeGreaterThan(10);

  resetRoadmapSigner();
  try {
    await expect(
      upsertRoadmap(endpoint, key, { title: "unsigned write" })
    ).rejects.toThrow(/sign the write with the operator credential/);
  } finally {
    configureRoadmapSigner(() => (payload) => {
      const signed = { ...payload, public_key: deckOperator.publicKey };
      return {
        public_key: deckOperator.publicKey,
        auth: buildAuthProof(deckOperator.privateKey, signed, {
          kind: "operator",
          operator_id: deriveOperatorId(deckOperator.publicKey)
        })
      };
    });
  }
});
