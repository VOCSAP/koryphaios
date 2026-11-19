// PLAN-v0.4 C3-M3: the Deck's roadmap client (desktop/src/main/roadmap-service).
// Verifies the project-key mirror stays consistent with server.ts (same remote
// normalization, same local: fallback) and drives the real broker routes.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import {
  groupId,
  livePid,
  openBrokerDb,
  post,
  scrubEnv,
  sha256Hex,
  startBroker,
  stopBroker,
  type TestBroker
} from "./_helper.ts";
import { fetchAtomicDispatchCapability } from "../desktop/src/main/broker-client.ts";
import {
  atomicOperationId,
  dispatchWave,
  runAssign,
  settleUnconfirmed,
  type AssignDeps,
  type AtomicPort,
  type AtomicWaveDeps
} from "../desktop/src/main/dispatch.ts";
import { queuedItems, wavesOf } from "../desktop/src/shared/workflow.ts";
import type { AtomicDispatchIntent } from "../shared/types.ts";
import {
  normalizeRemoteUrl,
  appendRoadmapContext,
  computeDeckProjectKey,
  configureRoadmapSigner,
  resetRoadmapSigner,
  listRoadmap,
  postAtomicDispatch,
  upsertRoadmap,
  archiveRoadmap,
  reorderRoadmap,
  RoadmapRequestError
} from "../desktop/src/main/roadmap-service.ts";
import { idleSweepRequest, operatorStopRequest } from "../desktop/src/main/roadmap-release-request.ts";
import {
  assignInProgress,
  markDirectiveDone,
  requestOperatorStop,
  unqueueDispatched,
  type GuardedWriteIo,
  type GuardedWriteResult
} from "../desktop/src/main/roadmap-guarded-write.ts";
import type { RoadmapItem, RoadmapUpsertFields } from "../desktop/src/shared/types";
import { isRoadmapStaleSaveError } from "../shared/roadmap-append.ts";
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
  broker = await startBroker({}, { trustedOperators: [deckOperator.publicKey] });
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
  execFileSync("git", ["init", "-q"], { cwd: dir, env: scrubEnv(dir) });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widget.git"], { cwd: dir, env: scrubEnv(dir) });
  expect(computeDeckProjectKey(dir)).toBe("github.com/acme/widget");
});

test("computeDeckProjectKey falls back to local:<hash of git root>, matching server.ts", () => {
  const dir = tmpDir();
  execFileSync("git", ["init", "-q"], { cwd: dir, env: scrubEnv(dir) });
  // server.ts fallback: local: + sha256(gitRoot ?? cwd)[:16]. git may report a
  // symlink-resolved root (e.g. /private/var on macOS), so hash the same value
  // the service actually read.
  const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: dir,
    encoding: "utf-8",
    env: scrubEnv(dir)
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

test("the idle sweep keeps a card's content date, the operator stop and the dispatch writes move it", async () => {
  const endpoint = { url: broker.url, token: null };
  const key = "github.com/acme/deck-content-date";
  const dateOf = async (id: string): Promise<string | null> =>
    (await listRoadmap(endpoint, key, {})).find((i) => i.id === id)!.content_updated_at;

  const created = await upsertRoadmap(endpoint, key, { title: "Content date", kind: "idea", status: "idea" });
  expect(typeof created.content_updated_at).toBe("string");

  const planned = await upsertRoadmap(endpoint, key, { id: created.id, queue: null, status: "planned" });
  expect(planned.content_updated_at).not.toBe(created.content_updated_at);
  const dequeued = await upsertRoadmap(endpoint, key, { id: created.id, queue: null, status: "planned" });
  expect(dequeued.content_updated_at).toBe(planned.content_updated_at);

  const assigned = await upsertRoadmap(endpoint, key, { id: created.id, status: "in_progress", queue: null });
  expect(assigned.content_updated_at).not.toBe(planned.content_updated_at);

  const locked = await upsertRoadmap(endpoint, key, { id: created.id, locked: true });
  expect(locked.locked).toBe(true);
  const swept = await upsertRoadmap(endpoint, key, idleSweepRequest(locked));
  expect(swept.status).toBe("planned");
  expect(swept.content_updated_at).toBe(assigned.content_updated_at);
  expect(await dateOf(created.id)).toBe(assigned.content_updated_at);

  const reassigned = await upsertRoadmap(endpoint, key, { id: created.id, status: "in_progress", queue: null });
  const stopped = await upsertRoadmap(endpoint, key, operatorStopRequest(reassigned));
  expect(stopped.status).toBe("planned");
  expect(stopped.content_updated_at).not.toBe(reassigned.content_updated_at);

  const appended = await appendRoadmapContext(endpoint, created.id, "directive report");
  expect(appended.content_updated_at).not.toBe(stopped.content_updated_at);

  await upsertRoadmap(endpoint, key, { id: created.id, queue: 1 });
  const done = await upsertRoadmap(endpoint, key, { id: created.id, queue: null, status: "done" });
  expect(done.status).toBe("done");
  expect(done.content_updated_at).not.toBe(appended.content_updated_at);
});

// upsertRoadmap relies on `...fields` spread to carry inactive onto the wire; a
// pick-list there would silently drop the field with no type or runtime error,
// so only a real round trip proves it survives.
test("appendRoadmapContext signs and persists a Deck-authored context note", async () => {
  const endpoint = { url: broker.url, token: null };
  const key = "github.com/acme/deck-context-append";
  const created = await upsertRoadmap(endpoint, key, { title: "context target" });

  const appended = await appendRoadmapContext(endpoint, created.id, "unresolved directive target");
  expect(appended.context).toContain("unresolved directive target");
  expect(appended.updated_by).toBe("deck");

  const stored = (await listRoadmap(endpoint, key, {})).find((item) => item.id === created.id);
  expect(stored?.context).toContain("unresolved directive target");
});

test("a Deck Save carrying a revision an append moved is rejected as a stale save the renderer recognizes", async () => {
  const endpoint = { url: broker.url, token: null };
  const key = "github.com/acme/deck-stale-save";
  const opened = await upsertRoadmap(endpoint, key, { title: "stale save target", context: "operator context" });
  expect(opened.content_rev).toBeNumber();

  await appendRoadmapContext(endpoint, opened.id, "concurrent agent fact");
  const rejection = await upsertRoadmap(endpoint, key, {
    id: opened.id,
    context: "operator context, edited",
    expected_content_rev: opened.content_rev
  }).then(
    () => null,
    (e: unknown) => e
  );

  expect(rejection).toBeInstanceOf(RoadmapRequestError);
  expect((rejection as RoadmapRequestError).status).toBe(409);
  expect(isRoadmapStaleSaveError(String(rejection))).toBe(true);
  const stored = (await listRoadmap(endpoint, key, {})).find((item) => item.id === opened.id);
  expect(stored?.context).toContain("concurrent agent fact");
  expect(stored?.context).not.toContain("edited");
});

test("a Deck Save merged onto an agent's claim keeps the agent's lock", async () => {
  const endpoint = { url: broker.url, token: null };
  const key = "github.com/acme/deck-save-after-claim";
  const opened = await upsertRoadmap(endpoint, key, { title: "claimed meanwhile", status: "planned" });

  const claim = await post<{ item?: { locked: boolean; locked_by: string | null } }>(`${broker.url}/roadmap/upsert`, {
    id: opened.id,
    by: "agent-x",
    status: "in_progress",
  });
  expect(claim.status).toBe(200);
  const claimed = (await listRoadmap(endpoint, key, {})).find((item) => item.id === opened.id)!;
  expect({ locked: claimed.locked, locked_by: claimed.locked_by }).toEqual({ locked: true, locked_by: "agent-x" });

  const saved = await upsertRoadmap(endpoint, key, {
    id: opened.id,
    title: "title edited by the operator",
    status: "in_progress",
    expected_content_rev: claimed.content_rev,
  });

  expect(saved.title).toBe("title edited by the operator");
  expect({ locked: saved.locked, locked_by: saved.locked_by }).toEqual({ locked: true, locked_by: "agent-x" });
});

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
// to the broker, byte-identical wire shape (no `waves` key) when omitted --
// but the broker requires the field, so omitting it is refused.
test("reorderRoadmap threads an optional waves param through to the broker", async () => {
  const endpoint = { url: broker.url, token: null };
  const key = "github.com/acme/deck-waves-test";

  const a = await upsertRoadmap(endpoint, key, { title: "wave a" });
  const b = await upsertRoadmap(endpoint, key, { title: "wave b" });

  const items = await reorderRoadmap(endpoint, key, [a.id, b.id], [[a.id, b.id]]);
  const byId = new Map(items.map((i) => [i.id, i]));
  expect(byId.get(a.id)?.queue).toBe(1);
  expect(byId.get(b.id)?.queue).toBe(1);

  // Omitting waves is refused by the broker (D1), not silently flattened.
  await expect(reorderRoadmap(endpoint, key, [a.id, b.id])).rejects.toThrow(/waves/);
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

const deckSigner = (payload: Record<string, unknown>) => {
  const signed = { ...payload, public_key: deckOperator.publicKey };
  return {
    public_key: deckOperator.publicKey,
    auth: buildAuthProof(deckOperator.privateKey, signed, {
      kind: "operator",
      operator_id: deriveOperatorId(deckOperator.publicKey)
    })
  };
};

async function withSignerLoader(loader: Parameters<typeof configureRoadmapSigner>[0], run: () => Promise<void>): Promise<void> {
  configureRoadmapSigner(loader);
  try {
    await run();
  } finally {
    configureRoadmapSigner(() => deckSigner);
  }
}

test("an async signer loader signs the write: the request waits for the signature", async () => {
  const endpoint = { url: broker.url, token: null };
  const key = "github.com/acme/deck-async-signer-test";
  await withSignerLoader(
    async () => {
      await Promise.resolve();
      return deckSigner;
    },
    async () => {
      expect((await upsertRoadmap(endpoint, key, { title: "async signed" })).id.length).toBeGreaterThan(10);
    }
  );
});

test("two concurrent first signatures share one load of the signer", async () => {
  const endpoint = { url: broker.url, token: null };
  const key = "github.com/acme/deck-concurrent-signer-test";
  let loads = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await withSignerLoader(
    async () => {
      loads += 1;
      await gate;
      return deckSigner;
    },
    async () => {
      const pending = [
        upsertRoadmap(endpoint, key, { title: "first" }),
        upsertRoadmap(endpoint, key, { title: "second" })
      ];
      release();
      const both = await Promise.all(pending);
      expect(both.map((item) => item.title).sort()).toEqual(["first", "second"]);
      expect(loads).toBe(1);
      await upsertRoadmap(endpoint, key, { title: "third" });
      expect(loads, "a loaded signer is cached for the next writes").toBe(1);
    }
  );
});

test("a loader that has no signer yet is asked again on the next write", async () => {
  const endpoint = { url: broker.url, token: null };
  const key = "github.com/acme/deck-retry-signer-test";
  let loads = 0;
  await withSignerLoader(
    async () => {
      loads += 1;
      return loads === 1 ? null : deckSigner;
    },
    async () => {
      await expect(upsertRoadmap(endpoint, key, { title: "too early" })).rejects.toThrow(/sign the write with the operator credential/);
      expect((await upsertRoadmap(endpoint, key, { title: "retried" })).id.length).toBeGreaterThan(10);
      expect(loads).toBe(2);
    }
  );
});

type GuardedSite = {
  name: string;
  create: RoadmapUpsertFields;
  run: (snapshot: RoadmapItem, io: GuardedWriteIo) => Promise<GuardedWriteResult>;
  applied: Partial<RoadmapItem>;
};

const GUARDED_SITES: GuardedSite[] = [
  {
    name: "directive done-write",
    create: { kind: "directive", directive: "clear", status: "planned", queue: 1 },
    run: markDirectiveDone,
    applied: { status: "done", queue: null }
  },
  { name: "dispatch unqueue", create: { status: "idea", queue: 1 }, run: unqueueDispatched, applied: { status: "planned", queue: null } },
  { name: "assignment", create: { status: "planned", queue: 1 }, run: assignInProgress, applied: { status: "in_progress", queue: null } },
  { name: "operator stop", create: { status: "in_progress" }, run: requestOperatorStop, applied: { status: "planned" } }
];

for (const site of GUARDED_SITES) {
  const setup = async (concurrent: (endpoint: { url: string; token: null }, id: string) => Promise<unknown>) => {
    const endpoint = { url: broker.url, token: null };
    const key = "github.com/acme/guarded-" + site.name.replace(/\W+/g, "-") + "-" + Math.random().toString(36).slice(2, 8);
    const created = await upsertRoadmap(endpoint, key, { title: "guarded target", ...site.create });
    const snapshot = (await listRoadmap(endpoint, key, {})).find((i) => i.id === created.id)!;
    await concurrent(endpoint, created.id);
    const traces: string[] = [];
    const io: GuardedWriteIo = {
      read: async (id) => (await listRoadmap(endpoint, key, {})).find((i) => i.id === id) ?? null,
      write: (fields) => upsertRoadmap(endpoint, key, fields),
      trace: (line) => traces.push(line)
    };
    const result = await site.run(snapshot, io);
    const stored = (await listRoadmap(endpoint, key, { include_archived: true })).find((i) => i.id === created.id)!;
    return { result, stored, traces };
  };

  test(`${site.name}: a card done between the read and the write stays done`, async () => {
    const { result, stored, traces } = await setup((endpoint, id) => upsertRoadmap(endpoint, "ignored", { id, status: "done" }));
    expect(result).toEqual({ written: false, reason: "ineligible" });
    expect(stored.status).toBe("done");
    expect(traces).toHaveLength(1);
  });

  test(`${site.name}: a card archived between the read and the write stays archived`, async () => {
    const { result, stored } = await setup((endpoint, id) => archiveRoadmap(endpoint, id));
    expect(result).toEqual({ written: false, reason: "gone" });
    expect(stored.status).toBe("archived");
  });

  test(`${site.name}: a title edited between the read and the write still gets the decision, once`, async () => {
    const { result, stored } = await setup((endpoint, id) => upsertRoadmap(endpoint, "ignored", { id, title: "renamed meanwhile" }));
    expect(result.written).toBe(true);
    expect(stored).toMatchObject({ title: "renamed meanwhile", ...site.applied });
  });
}

let atomicSeq = 0;

type PostWrap = (
  real: AtomicPort["post"],
  action: "execute" | "resolve",
  intent: AtomicDispatchIntent,
  n: number
) => ReturnType<AtomicPort["post"]>;

async function atomicScenario() {
  atomicSeq += 1;
  const secret = `lot-i-${atomicSeq}-${broker.port}`;
  const group = { id: await groupId(secret), hash: await sha256Hex(secret) };
  const register = async (name: string) =>
    (
      await post<{ peer_id: string; instance_token: string }>(`${broker.url}/register`, {
        pid: livePid(),
        cwd: `/lot-i/${name}${atomicSeq}`,
        git_root: null,
        tty: null,
        summary: "",
        host: `h${name}${atomicSeq}`,
        client_pid: 1,
        project_key: null,
        group_id: group.id,
        group_secret_hash: group.hash
      })
    ).body;
  const lead = await register("lead");
  const worker = await register("worker");
  const endpoint = { url: broker.url, token: null };
  const project = `github.com/vocsap/lot-i-${atomicSeq}`;
  const capability = (await fetchAtomicDispatchCapability(endpoint))!;
  const posted: { action: string; operationId: string }[] = [];
  const portWith = (wrap?: PostWrap): AtomicPort => ({
    capability,
    projectKey: project,
    groupId: group.id,
    newOperationId: () => atomicOperationId(Date.now(), randomUUID(), capability),
    post: (action, intent) => {
      posted.push({ action, operationId: intent.operation_id });
      const real: AtomicPort["post"] = (a, i) => postAtomicDispatch(endpoint, { action: a, intent: i, groupSecretHash: group.hash });
      return wrap ? wrap(real, action, intent, posted.length) : real(action, intent);
    }
  });
  const queued = async (count: number): Promise<RoadmapItem[]> => {
    for (let n = 0; n < count; n++) {
      await upsertRoadmap(endpoint, project, { title: `lot I card ${atomicSeq}.${n}`, status: "planned", queue: 1 });
    }
    return queuedItems(await listRoadmap(endpoint, project, {}));
  };
  const reread = async (): Promise<RoadmapItem[]> => {
    const items = await listRoadmap(endpoint, project, {});
    const ids = wavesOf(queuedItems(items))[0] ?? [];
    return ids.map((id) => items.find((i) => i.id === id)!).filter((i) => i.kind !== "directive");
  };
  const messagesTo = (token: string): { id: number; text: string }[] => {
    const db = openBrokerDb(broker.dbPath, { readonly: true });
    try {
      return db.query("SELECT id, text FROM messages WHERE to_token = ? ORDER BY id").all(token) as { id: number; text: string }[];
    } finally {
      db.close();
    }
  };
  const waveDeps = (port: AtomicPort): AtomicWaveDeps => ({
    port,
    target: () => ({ peerId: lead.peer_id, kind: "lead" }),
    reread,
    journal: () => {},
    warn: () => {}
  });
  const legacyMustNotRun = {
    announce: async (): Promise<number> => {
      throw new Error("legacy announce must not run");
    },
    upsert: async (): Promise<void> => {
      throw new Error("legacy upsert must not run");
    },
    warn: (): void => {}
  };
  const assignDeps = (port: AtomicPort): AssignDeps => ({
    atomic: port,
    read: async (id) => (await listRoadmap(endpoint, project, {})).find((i) => i.id === id) ?? null,
    announce: async () => {
      throw new Error("legacy announce must not run");
    },
    write: async () => {
      throw new Error("legacy write must not run");
    },
    journal: () => {},
    warn: () => {},
    reportError: () => {}
  });
  return { endpoint, project, lead, worker, posted, portWith, queued, messagesTo, waveDeps, legacyMustNotRun, assignDeps };
}

test("a wave goes through the route: cards written and one message stored for the lead in one dispatch", async () => {
  const s = await atomicScenario();
  const items = await s.queued(2);
  const out = await dispatchWave(items, { atomic: s.waveDeps(s.portWith()), legacy: s.legacyMustNotRun, trace: () => {} });
  expect(out.result).toMatchObject({ sent: true, delivery: "sent", count: 2 });
  expect(out.dispatched.map((i) => i.id)).toEqual(items.map((i) => i.id));
  const after = await listRoadmap(s.endpoint, s.project, {});
  expect(after.map((i) => [i.status, i.queue])).toEqual([["planned", null], ["planned", null]]);
  expect(s.messagesTo(s.lead.instance_token)).toHaveLength(1);
  expect(s.messagesTo(s.worker.instance_token)).toHaveLength(0);
});

test("a card closed between the read and the execute is never announced and nothing moves", async () => {
  const s = await atomicScenario();
  const items = await s.queued(2);
  await upsertRoadmap(s.endpoint, s.project, { id: items[1]!.id, status: "done", queue: null });
  const out = await dispatchWave(items, { atomic: s.waveDeps(s.portWith()), legacy: s.legacyMustNotRun, trace: () => {} });
  expect(out.result).toMatchObject({ sent: false, delivery: "not-sent", reason: "ineligible" });
  expect(out.result.notSent?.map((m) => m.id)).toEqual([items[1]!.id]);
  expect(out.dispatched).toEqual([]);
  expect(s.messagesTo(s.lead.instance_token)).toHaveLength(0);
  const first = (await listRoadmap(s.endpoint, s.project, {})).find((i) => i.id === items[0]!.id)!;
  expect([first.status, first.queue]).toEqual(["planned", 1]);
});

test("a card edited between the read and the execute: one re-read, a new operation id, then the wave is sent", async () => {
  const s = await atomicScenario();
  const items = await s.queued(2);
  await upsertRoadmap(s.endpoint, s.project, { id: items[0]!.id, title: "renamed meanwhile" });
  const out = await dispatchWave(items, { atomic: s.waveDeps(s.portWith()), legacy: s.legacyMustNotRun, trace: () => {} });
  expect(out.result).toMatchObject({ sent: true, delivery: "sent", count: 2 });
  expect(s.posted.map((p) => p.action)).toEqual(["execute", "execute"]);
  expect(s.posted[1]!.operationId).not.toBe(s.posted[0]!.operationId);
  expect(s.messagesTo(s.lead.instance_token)).toHaveLength(1);
});

test("a lost execute answer is settled by resolve under the same operation id and yields ONE message", async () => {
  const s = await atomicScenario();
  const items = await s.queued(2);
  const port = s.portWith(async (real, action, intent, n) => {
    const answer = await real(action, intent);
    return n === 1 ? { delivery: "unknown", operation_id: intent.operation_id, reason: "transport" } : answer;
  });
  const out = await dispatchWave(items, { atomic: s.waveDeps(port), legacy: s.legacyMustNotRun, trace: () => {} });
  expect(s.posted.map((p) => p.action)).toEqual(["execute", "resolve"]);
  expect(s.posted[1]!.operationId).toBe(s.posted[0]!.operationId);
  expect(out.result).toMatchObject({ sent: true, delivery: "sent", count: 2 });
  expect(out.dispatched).toHaveLength(2);
  expect(s.messagesTo(s.lead.instance_token)).toHaveLength(1);
});

test("a delivery that stays unknown is not resent: no second message, the operation is kept, a later resolve settles it", async () => {
  const s = await atomicScenario();
  const items = await s.queued(1);
  const lostAlways = s.portWith(async (real, action, intent, n) => {
    if (n === 1) await real(action, intent);
    return { delivery: "unknown", operation_id: intent.operation_id, reason: "transport" };
  });
  const out = await dispatchWave(items, { atomic: s.waveDeps(lostAlways), legacy: s.legacyMustNotRun, trace: () => {} });
  expect(out.result).toMatchObject({ sent: false, delivery: "unknown", reason: "unconfirmed" });
  expect(out.dispatched).toEqual([]);
  expect(s.messagesTo(s.lead.instance_token)).toHaveLength(1);
  const settled = await settleUnconfirmed(out.pending!, s.portWith(), false);
  expect(settled).toMatchObject({ state: "sent", members: [{ id: items[0]!.id }] });
  expect(s.messagesTo(s.lead.instance_token)).toHaveLength(1);
});

test("an assignment goes through the route: the chosen peer, not the lead, hears it and the card moves to in_progress", async () => {
  const s = await atomicScenario();
  const [item] = await s.queued(1);
  const result = await runAssign(item!.id, s.worker.peer_id, s.assignDeps(s.portWith()));
  expect(result).toEqual({ sent: true, delivery: "sent" });
  const after = (await listRoadmap(s.endpoint, s.project, {})).find((i) => i.id === item!.id)!;
  expect([after.status, after.queue]).toEqual(["in_progress", null]);
  expect(s.messagesTo(s.worker.instance_token)).toHaveLength(1);
  expect(s.messagesTo(s.lead.instance_token)).toHaveLength(0);
});

test("an assignment of a card closed since the read announces nothing", async () => {
  const s = await atomicScenario();
  const [item] = await s.queued(1);
  const deps = s.assignDeps(s.portWith());
  const read = deps.read;
  let first = true;
  deps.read = async (id) => {
    const seen = await read(id);
    if (first) {
      first = false;
      await upsertRoadmap(s.endpoint, s.project, { id, status: "done", queue: null });
    }
    return seen;
  };
  expect(await runAssign(item!.id, s.worker.peer_id, deps)).toEqual({ sent: false, delivery: "not-sent", reason: "ineligible" });
  expect(s.messagesTo(s.worker.instance_token)).toHaveLength(0);
});

test("the broker capability is read from /health: served, absent on an old broker, and an unreachable broker rejects", async () => {
  const served = await fetchAtomicDispatchCapability({ url: broker.url, token: null });
  expect(served).toMatchObject({ version: 1, max_members: expect.any(Number) });
  const old = Bun.serve({ port: 0, fetch: () => Response.json({ status: "ok" }) });
  try {
    expect(await fetchAtomicDispatchCapability({ url: `http://127.0.0.1:${old.port}`, token: null })).toBeNull();
  } finally {
    old.stop(true);
  }
  const closed = Bun.serve({ port: 0, fetch: () => new Response("x") });
  const closedUrl = `http://127.0.0.1:${closed.port}`;
  closed.stop(true);
  await expect(fetchAtomicDispatchCapability({ url: closedUrl, token: null })).rejects.toThrow();
});

const POST_OP = "1000:00000000-0000-4000-8000-000000000001";
const POST_INTENT: AtomicDispatchIntent = {
  broker_id: "11111111-aaaa-bbbb-cccc-222222222222",
  operation_id: POST_OP,
  project_key: "github.com/vocsap/post-atomic",
  group_id: "group-1",
  mode: "wave",
  target_kind: "lead",
  to_peer_id: "lead-1",
  members: [{ id: "aaaaaaaa-0000-0000-0000-00000000000a", expected_content_rev: 1, expected_dispatch_state_tag: "a".repeat(64) }]
};

async function postAgainst(
  respond: () => Response,
  action: "execute" | "resolve" = "execute"
): Promise<{ answer: unknown; sent: Record<string, unknown> | null }> {
  let sent: Record<string, unknown> | null = null;
  const stub = Bun.serve({
    port: 0,
    fetch: async (req) => {
      sent = (await req.json()) as Record<string, unknown>;
      return respond();
    }
  });
  try {
    const answer = await postAtomicDispatch({ url: `http://127.0.0.1:${stub.port}`, token: null }, { action, intent: POST_INTENT, groupSecretHash: "h".repeat(8) }).catch(
      (e: Error) => e
    );
    return { answer, sent };
  } finally {
    stub.stop(true);
  }
}

const json = (status: number, body: unknown): Response => Response.json(body, { status });
const sentCards = () => POST_INTENT.members.map((m) => ({ id: m.id, title: "A", kind: "feature" }));
const unknownAnswer = (reason: string) => ({ delivery: "unknown", operation_id: POST_OP, reason });

test("postAtomicDispatch signs the request as the operator with the intent and the group hash", async () => {
  const { sent } = await postAgainst(() => json(200, { delivery: "sent", operation_id: POST_OP, message_id: 3, cards: [] }), "resolve");
  expect(sent).toMatchObject({ by: "deck", action: "resolve", group_secret_hash: "hhhhhhhh", intent: { operation_id: POST_OP } });
  expect(typeof (sent as { auth?: unknown }).auth).toBe("object");
});

test("postAtomicDispatch returns the broker's recorded outcome, sent or not-sent", async () => {
  const sentBody = { delivery: "sent", operation_id: POST_OP, message_id: 3, cards: [{ id: POST_INTENT.members[0]!.id, title: "A", kind: "feature" }] };
  expect((await postAgainst(() => json(200, sentBody))).answer).toEqual(sentBody);
  const refused = { delivery: "not-sent", operation_id: POST_OP, reason: "card-changed", card_ids: ["a"] };
  expect((await postAgainst(() => json(409, refused))).answer).toEqual(refused);
});

test.each<[string, () => Response, ReturnType<typeof unknownAnswer>]>([
  ["a broker that is not the one asked", () => json(409, { code: "dispatch-broker-mismatch", error: "x" }), unknownAnswer("broker-mismatch")],
  ["an operation past its deadline", () => json(409, { code: "dispatch-operation-expired", error: "x" }), unknownAnswer("expired")],
  ["a resolve whose result was purged", () => json(200, unknownAnswer("expired")), unknownAnswer("expired")],
  ["a broker error with a body", () => json(500, { error: "boom" }), unknownAnswer("transport")],
  ["a broker error with no JSON", () => new Response("<html>bad gateway</html>", { status: 502 }), unknownAnswer("transport")],
  ["a success with no JSON", () => new Response("ok", { status: 200 }), unknownAnswer("invalid-response")],
  ["an outcome for another operation", () => json(200, { delivery: "sent", operation_id: "9999:other", message_id: 1, cards: [] }), unknownAnswer("invalid-response")],
  ["a sent outcome with a card missing", () => json(200, { delivery: "sent", operation_id: POST_OP, message_id: 1, cards: [] }), unknownAnswer("invalid-response")],
  [
    "a sent outcome with a card too many",
    () => json(200, { delivery: "sent", operation_id: POST_OP, message_id: 1, cards: [...sentCards(), { id: "eeeeeeee-0000-0000-0000-00000000000e", title: "S", kind: "feature" }] }),
    unknownAnswer("invalid-response")
  ],
  [
    "a sent outcome with a card listed twice",
    () => json(200, { delivery: "sent", operation_id: POST_OP, message_id: 1, cards: [...sentCards(), ...sentCards()] }),
    unknownAnswer("invalid-response")
  ]
])("postAtomicDispatch reads %s as unknown, never as a refusal", async (_name, respond, expected) => {
  expect((await postAgainst(respond)).answer).toEqual(expected);
});

test("postAtomicDispatch reads a lost connection as unknown transport", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new TypeError("connection refused"))) as unknown as typeof fetch;
  try {
    const answer = await postAtomicDispatch({ url: "http://127.0.0.1:1", token: null }, { action: "execute", intent: POST_INTENT, groupSecretHash: null });
    expect(answer as unknown).toEqual(unknownAnswer("transport"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test.each<[string, () => Response, number, string]>([
  ["a same-id different-intent mismatch", () => json(409, { code: "dispatch-operation-mismatch", error: "other intent" }), 409, "other intent"],
  ["an invalid request", () => json(400, { code: "dispatch-invalid-request", error: "bad intent" }), 400, "bad intent"],
  ["a full registry", () => json(503, { code: "dispatch-capacity-exceeded", error: "registry full" }), 503, "registry full"],
  ["an unsigned write", () => json(401, { error: "sign the write" }), 401, "sign the write"],
  ["a refusal with no JSON", () => new Response("denied", { status: 403 }), 403, "roadmap request failed: 403"]
])("postAtomicDispatch throws on %s, since nothing was executed", async (_name, respond, status, message) => {
  const { answer } = await postAgainst(respond);
  expect(answer).toBeInstanceOf(RoadmapRequestError);
  expect([(answer as RoadmapRequestError).status, (answer as Error).message]).toEqual([status, message]);
});
