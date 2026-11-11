import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  startBroker,
  stopBroker,
  post,
  livePid,
  sha256Hex,
  groupId,
  mintRunCredential,
  operatorInboxProof,
  registerAttestedInstance,
  runInboxProof,
  FIXTURE_OPERATOR,
  FIXTURE_OPERATOR_ID,
  type RunCredential,
  type TestBroker,
  openBrokerDb,
} from "./_helper.ts";
import { extractBracedBody } from "./_braced-body.ts";
import { buildAuthProof, INBOX_GATES } from "../shared/approval.ts";
import { fetchTilePeers, TILE_PEERS_TIMEOUT_MS } from "../desktop/src/main/broker-client.ts";
import { PEER_POLL_MS, TilePeerPoller, type TilePeerBinding } from "../desktop/src/main/peer-state.ts";

const GROUP_PASSPHRASE = randomUUID();
const DECK_HOST = hostname();
const DECK_CWD = "C:\\work\\repo";

let broker: TestBroker;
let GROUP = "";
let PASSPHRASE_HASH = "";

beforeAll(async () => {
  broker = await startBroker({ CLAUDE_PEERS_CLEAN_INTERVAL_SEC: "1", CLAUDE_PEERS_DORMANT_SWEEP_SEC: "1" });
  GROUP = await groupId(GROUP_PASSPHRASE);
  PASSPHRASE_HASH = await sha256Hex(GROUP_PASSPHRASE);
});
afterAll(async () => {
  await stopBroker(broker);
});

async function register(deskSession: string, opts: { host?: string; cwd?: string } = {}) {
  const res = await post<{ peer_id: string; instance_token: string }>(`${broker.url}/register`, {
    pid: livePid(),
    cwd: opts.cwd ?? DECK_CWD,
    git_root: null,
    tty: null,
    summary: "",
    host: opts.host ?? DECK_HOST,
    client_pid: 1,
    project_key: null,
    group_id: GROUP,
    group_secret_hash: PASSPHRASE_HASH,
    desk_session: deskSession,
  });
  expect(res.status).toBe(200);
  return res.body;
}

async function tilePeers(deskSessions: unknown[], overrides: Record<string, unknown> = {}) {
  return post<{ peers?: unknown[]; error?: string }>(`${broker.url}/tile-peers`, {
    group_id: GROUP,
    group_secret_hash: PASSPHRASE_HASH,
    tiles: deskSessions.map((d) => (typeof d === "string" ? { desk_session: d } : d)),
    ...overrides,
  });
}

function withDb<T>(fn: (db: Database) => T): T {
  const db = openBrokerDb(broker.dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function fakeResponse(body: unknown, status = 200): typeof fetch {
  return (async () => Response.json(body, { status })) as unknown as typeof fetch;
}

/** A broker call that never settles must fail the test, not hang the run. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<"settled" | "hung"> {
  return Promise.race([
    p.then(
      () => "settled" as const,
      () => "settled" as const
    ),
    Bun.sleep(ms).then(() => "hung" as const),
  ]);
}

const QUERY = { groupId: "g", secret: "s" };
const ENDPOINT = { endpoint: { url: "http://127.0.0.1:1", token: null } };

describe("/tile-peers resolves a tile to its own registration", () => {
  test("a child registered with the tile's token does not take the tile's place", async () => {
    const tile = await register("tile-child");
    const child = await register("tile-child");
    expect(child.peer_id).not.toBe(tile.peer_id);

    const res = await tilePeers(["tile-child"]);
    expect(res.status).toBe(200);
    expect(res.body.peers).toEqual([{ peer_id: tile.peer_id, status: "active" }]);
  });

  test("a tile that disconnects and registers again keeps its peer_id", async () => {
    const first = await register("tile-restart");
    await post(`${broker.url}/disconnect`, { instance_token: first.instance_token });
    const second = await register("tile-restart");
    expect(second.peer_id).toBe(first.peer_id);

    const res = await tilePeers(["tile-restart"]);
    expect(res.body.peers).toEqual([{ peer_id: first.peer_id, status: "active" }]);
  });

  test("a dormant tile keeps its peer_id, reported as dormant", async () => {
    const tile = await register("tile-dormant");
    await post(`${broker.url}/disconnect`, { instance_token: tile.instance_token });

    const res = await tilePeers(["tile-dormant"]);
    expect(res.body.peers).toEqual([{ peer_id: tile.peer_id, status: "dormant" }]);
  });

  test("a sandboxed tile, registered under the container's host and cwd, resolves by its token", async () => {
    const tile = await register("tile-sandbox", { host: "0f3c9a1b2d4e", cwd: "/workspace" });

    const res = await tilePeers(["tile-sandbox"]);
    expect(res.body.peers).toEqual([{ peer_id: tile.peer_id, status: "active" }]);
  });

  test("known limit: a tile registered without a token hash resolves to null until it registers again", async () => {
    const tile = await register("tile-hashless", { host: "0f3c9a1b2d4e", cwd: "/workspace" });
    withDb((db) => db.run("UPDATE peer_sessions SET desk_session_hash = '' WHERE instance_token = ?", [tile.instance_token]));

    expect(
      (await tilePeers(["tile-hashless"])).body.peers,
      "a broker updated under a running Deck blanks this tile until the Deck restarts it"
    ).toEqual([null]);

    await post(`${broker.url}/disconnect`, { instance_token: tile.instance_token });
    const again = await register("tile-hashless", { host: "0f3c9a1b2d4e", cwd: "/workspace" });
    expect(again.peer_id).toBe(tile.peer_id);
    expect((await tilePeers(["tile-hashless"])).body.peers).toEqual([{ peer_id: tile.peer_id, status: "active" }]);
  });

  test("a sandboxed tile restarted while its previous server.ts is still active resolves to that previous peer", async () => {
    const previous = await register("tile-sandbox-restart", { host: "0f3c9a1b2d4e", cwd: "/workspace" });
    const restarted = await register("tile-sandbox-restart", { host: "0f3c9a1b2d4e", cwd: "/workspace" });
    expect(restarted.peer_id).not.toBe(previous.peer_id);

    expect(
      (await tilePeers(["tile-sandbox-restart"])).body.peers,
      "the broker cannot tell a restart from a child without a per-spawn marker"
    ).toEqual([{ peer_id: previous.peer_id, status: "active" }]);
  });

  test("one token bound to two different peers resolves to null rather than to either", async () => {
    const a = await register("tile-twice", { cwd: "C:\\one" });
    const b = await register("tile-twice", { cwd: "C:\\two" });
    expect(b.instance_token).not.toBe(a.instance_token);

    expect((await tilePeers(["tile-twice"])).body.peers).toEqual([null]);
  });

  test("a dormant tile purged past its TTL is replaced by its next registration's id", async () => {
    const old = await register("tile-purged");
    await register("tile-purged-occupant");
    await post(`${broker.url}/disconnect`, { instance_token: old.instance_token });
    withDb((db) => db.run("UPDATE peers SET last_seen = '2000-01-01 00:00:00' WHERE instance_token = ?", [old.instance_token]));
    const present = () => withDb((db) => db.query("SELECT 1 FROM peers WHERE instance_token = ?").get(old.instance_token));
    for (let i = 0; i < 60 && present() != null; i++) await Bun.sleep(100);
    expect(present(), "the cleanup tick purged the dormant row").toBeNull();

    const fresh = await register("tile-purged");
    expect(fresh.instance_token).not.toBe(old.instance_token);
    const res = await tilePeers(["tile-purged"]);
    expect(res.body.peers).toEqual([{ peer_id: fresh.peer_id, status: "active" }]);
  });

  test("an unknown token, or a malformed entry, resolves to null in place", async () => {
    const tile = await register("tile-known");
    const res = await tilePeers(["never-registered", { desk_session: 42 }, null, "tile-known"]);
    expect(res.status).toBe(200);
    expect(res.body.peers).toEqual([null, null, null, { peer_id: tile.peer_id, status: "active" }]);
  });

  test("the response carries the peer and its status, never a token or a hash", async () => {
    await register("tile-shape");
    const res = await tilePeers(["tile-shape"]);
    expect(Object.keys(res.body).sort()).toEqual(["peers"]);
    expect(res.body.peers).toHaveLength(1);
    for (const entry of res.body.peers ?? []) {
      expect(entry, "every resolved entry is an object").not.toBeNull();
      expect(Object.keys(entry as object).sort(), "no instance_token, desk_session or hash leaves the broker").toEqual([
        "peer_id",
        "status",
      ]);
    }
  });

  test("the Deck client reads the same binding the route returns", async () => {
    const tile = await register("tile-client");
    await register("tile-client");
    const peers = await fetchTilePeers(
      { groupId: GROUP, secret: GROUP_PASSPHRASE, deskSessions: ["tile-client"] },
      { endpoint: { url: broker.url, token: null } }
    );
    expect(peers).toEqual([{ peer_id: tile.peer_id, status: "active" }]);
  });
});

describe("peer telemetry stays bound to one attested launch", () => {
  const TELEMETRY = {
    model: "Claude Opus 4.6",
    modelId: "claude-opus-4-6",
    contextPct: 42,
    contextWindow: 200_000,
    observedAt: 1_731_234_567_890,
  };
  const DEAD_PID = 999_999_999;
  let tileSeq = 0;

  interface Tile {
    run: RunCredential;
    desk: string;
    cap: string;
    cwd: string;
    token: string;
    peerId: string;
  }
  type ListedPeer = Record<string, unknown> & { peer_id: string; telemetry?: Record<string, unknown> };

  async function newTelemetryRun(): Promise<RunCredential> {
    await register("telemetry-group-seed");
    return mintRunCredential(broker, { id: GROUP, hash: PASSPHRASE_HASH });
  }

  async function launchTile(run: RunCredential, over: { desk?: string; cap?: string; cwd?: string } = {}): Promise<Tile> {
    const n = ++tileSeq;
    const tile = {
      run,
      desk: over.desk ?? `telemetry-desk-${n}`,
      cap: over.cap ?? n.toString(16).padStart(64, "0"),
      cwd: over.cwd ?? `C:\\telemetry\\tile-${n}`,
    };
    const res = await registerAttestedInstance(broker, run, DECK_HOST, tile.cwd, {
      desk_session: tile.desk,
      telemetry_capability_hash: tile.cap,
    });
    expect(res.status).toBe(200);
    return { ...tile, token: res.body.instance_token, peerId: res.body.peer_id };
  }

  async function reregister(tile: Tile, extras: Record<string, unknown> = {}) {
    const res = await registerAttestedInstance(broker, tile.run, DECK_HOST, tile.cwd, {
      desk_session: tile.desk,
      telemetry_capability_hash: tile.cap,
      resume_instance_token: tile.token,
      ...extras,
    });
    expect(res.status).toBe(200);
    return res.body;
  }

  function telemetryCall(tile: Tile, action: "publish" | "stop", over: Record<string, unknown> = {}) {
    const payload = {
      run_ref: tile.run.run,
      group_id: tile.run.group,
      desk_session: tile.desk,
      launch_hash: tile.cap,
      action,
      ...(action === "publish" ? { snapshot: TELEMETRY } : {}),
      ...over,
    };
    return post<{ outcome?: string; ok?: boolean }>(`${broker.url}/tile-telemetry`, {
      ...payload,
      auth: operatorInboxProof(payload, INBOX_GATES.tileTelemetry),
    });
  }

  async function newObserver(): Promise<string> {
    return (await register(`telemetry-observer-${++tileSeq}`)).instance_token;
  }

  async function listedPeer(observer: string, peerId: string): Promise<ListedPeer | undefined> {
    const res = await post<ListedPeer[]>(`${broker.url}/list-peers`, {
      instance_token: observer,
      scope: "machine",
      cwd: "",
      git_root: null,
    });
    expect(res.status).toBe(200);
    return res.body.find((p) => p.peer_id === peerId);
  }

  async function publishedAndVisible(tile: Tile, observer: string, snapshot = TELEMETRY): Promise<void> {
    expect((await telemetryCall(tile, "publish", { snapshot })).body).toEqual({ outcome: "updated" });
    expect((await listedPeer(observer, tile.peerId))?.telemetry, "the snapshot is listed before the purge").toEqual(snapshot);
  }

  async function expectRevivedWithoutSnapshot(tile: Tile, observer: string, why: string): Promise<void> {
    const entry = await listedPeer(observer, tile.peerId);
    expect(entry, `${why}: the revived peer is listed again, so an absent snapshot is not an absent peer`).toBeDefined();
    expect(entry?.telemetry, `${why}: the old snapshot must not come back with the identity`).toBeUndefined();
    expect(
      (await telemetryCall(tile, "publish")).body,
      `${why}: the registry kept no memory of the old observation, so the same sample is new`
    ).toEqual({ outcome: "updated" });
  }

  async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, what: string, timeoutMs = 8000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last = await read();
    while (!done(last)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last=${JSON.stringify(last)}`);
      await Bun.sleep(50);
      last = await read();
    }
    return last;
  }

  test("a collision removes the first snapshot instead of selecting one peer", async () => {
    await register("telemetry-group-seed");
    const run = await mintRunCredential(broker, { id: GROUP, hash: PASSPHRASE_HASH });
    const capabilityHash = "a".repeat(64);
    const first = await registerAttestedInstance(broker, run, DECK_HOST, "C:\\telemetry", {
      desk_session: "telemetry-tile",
      telemetry_capability_hash: capabilityHash,
    });
    expect(first.status).toBe(200);
    const payload = {
      run_ref: run.run,
      group_id: run.group,
      desk_session: "telemetry-tile",
      launch_hash: capabilityHash,
      action: "publish" as const,
      snapshot: {
        model: "Claude Opus 4.6",
        modelId: "claude-opus-4-6",
        contextPct: 42,
        contextWindow: 200_000,
        observedAt: 1_731_234_567_890,
      },
    };
    const published = await post<{ outcome: string }>(`${broker.url}/tile-telemetry`, {
      ...payload,
      auth: operatorInboxProof(payload, INBOX_GATES.tileTelemetry),
    });
    expect(published).toEqual({ status: 200, body: { outcome: "updated" } });

    const second = await registerAttestedInstance(broker, run, DECK_HOST, "C:\\telemetry", {
      desk_session: "telemetry-tile",
      telemetry_capability_hash: capabilityHash,
    });
    expect(second.status).toBe(200);
    const peers = await (await fetch(`${broker.url}/admin/peers`)).json() as Array<Record<string, unknown>>;
    for (const peerId of [first.body.peer_id, second.body.peer_id]) {
      expect(peers.find((peer) => peer.peer_id === peerId)?.telemetry, peerId).toBeUndefined();
    }
  });

  test("/unregister forgets the owner in the telemetry registry", () => {
    const src = readFileSync(join(import.meta.dir, "..", "broker.ts"), "utf-8").replace(/\r\n/g, "\n");
    const anchor = src.indexOf('case "/unregister": {');
    expect(anchor, "the /unregister case exists in broker.ts").toBeGreaterThan(-1);
    const body = extractBracedBody(src, src.indexOf("{", anchor));
    expect(
      body,
      "/unregister must call peerTelemetryRegistry.forgetOwner or the owner's link and snapshot outlive the peer"
    ).toContain("peerTelemetryRegistry.forgetOwner(");
  });

  test("refuses legacy, run-key and expired-run telemetry proofs", async () => {
    await register("telemetry-proof-seed");
    const run = await mintRunCredential(broker, { id: GROUP, hash: PASSPHRASE_HASH });
    const payload = {
      run_ref: run.run,
      group_id: run.group,
      desk_session: "proof-tile",
      launch_hash: "b".repeat(64),
      action: "stop" as const,
    };
    const legacy = await post(`${broker.url}/tile-telemetry`, {
      ...payload,
      auth: buildAuthProof(FIXTURE_OPERATOR.privateKey, payload, {
        kind: "operator",
        operator_id: FIXTURE_OPERATOR_ID,
      }),
    });
    expect(legacy.status).toBe(401);
    const asRun = await post(`${broker.url}/tile-telemetry`, {
      ...payload,
      auth: runInboxProof(run, payload, INBOX_GATES.tileTelemetry),
    });
    expect(asRun.status).toBe(403);
    const noRun = { ...payload, run_ref: randomUUID() };
    const expired = await post(`${broker.url}/tile-telemetry`, {
      ...noRun,
      auth: operatorInboxProof(noRun, INBOX_GATES.tileTelemetry),
    });
    expect(expired.status).toBe(403);
  });

  test("a publication naming another group than the run's is refused for want of a live credential", async () => {
    const run = await newTelemetryRun();
    const tile = await launchTile(run);
    const observer = await newObserver();
    const foreign = await telemetryCall(tile, "publish", { group_id: await groupId(randomUUID()) });
    expect(foreign.status, "the run credential is live in its own group only").toBe(403);
    expect((await listedPeer(observer, tile.peerId))?.telemetry).toBeUndefined();
    await publishedAndVisible(tile, observer);
  });

  test("a disconnect drops the snapshot, so the peer resumed by its token starts without one", async () => {
    const tile = await launchTile(await newTelemetryRun());
    const observer = await newObserver();
    await publishedAndVisible(tile, observer);

    await post(`${broker.url}/disconnect`, { instance_token: tile.token });
    const back = await reregister(tile);
    expect(back.instance_token, "the resume gives the same identity back").toBe(tile.token);
    await expectRevivedWithoutSnapshot(tile, observer, "disconnect");
  });

  test("a heartbeat sweep that makes a peer dormant drops its snapshot", async () => {
    const tile = await launchTile(await newTelemetryRun());
    const observer = await newObserver();
    await publishedAndVisible(tile, observer);

    withDb((db) =>
      db.run("UPDATE peers SET last_seen = ? WHERE instance_token = ?", [new Date(Date.now() - 3_600_000).toISOString(), tile.token])
    );
    const status = () =>
      withDb((db) => (db.query("SELECT status FROM peers WHERE instance_token = ?").get(tile.token) as { status: string }).status);
    await until(status, (s) => s === "dormant", "the sweep to make the silent peer dormant");

    await reregister(tile);
    await expectRevivedWithoutSnapshot(tile, observer, "sweep");
  }, 15_000);

  test("registering over a peer whose process died drops its snapshot before reviving it", async () => {
    const tile = await launchTile(await newTelemetryRun());
    const observer = await newObserver();
    await publishedAndVisible(tile, observer);

    withDb((db) => db.run("UPDATE peers SET pid = ? WHERE instance_token = ?", [DEAD_PID, tile.token]));
    const back = await reregister(tile);
    expect(back.instance_token, "the dead peer's own row is revived").toBe(tile.token);
    await expectRevivedWithoutSnapshot(tile, observer, "dead pid");
  });

  test("a cleanup tick that finds a peer's process dead drops its snapshot", async () => {
    const tile = await launchTile(await newTelemetryRun());
    const observer = await newObserver();
    await publishedAndVisible(tile, observer);

    withDb((db) => db.run("UPDATE peers SET pid = ? WHERE instance_token = ?", [DEAD_PID, tile.token]));
    const status = () =>
      withDb((db) => (db.query("SELECT status FROM peers WHERE instance_token = ?").get(tile.token) as { status: string }).status);
    await until(status, (s) => s === "dormant", "the cleanup tick to make the peer with a dead process dormant");

    await reregister(tile);
    await expectRevivedWithoutSnapshot(tile, observer, "cleanup tick");
  }, 15_000);

  test("a dormant peer whose process died is revived by its session key without its snapshot", async () => {
    const tile = await launchTile(await newTelemetryRun());
    const observer = await newObserver();
    await publishedAndVisible(tile, observer);

    await post(`${broker.url}/disconnect`, { instance_token: tile.token });
    withDb((db) => db.run("UPDATE peers SET pid = ? WHERE instance_token = ?", [DEAD_PID, tile.token]));
    const back = await reregister(tile);
    expect(back.instance_token, "the dormant row is resurrected, not replaced").toBe(tile.token);
    await expectRevivedWithoutSnapshot(tile, observer, "dormant resurrection");
  });

  test("a resume by token of a live peer keeps the snapshot it already published", async () => {
    const tile = await launchTile(await newTelemetryRun());
    const observer = await newObserver();
    await publishedAndVisible(tile, observer);

    const back = await reregister(tile);
    expect(back.instance_token).toBe(tile.token);
    expect((await listedPeer(observer, tile.peerId))?.telemetry, "re-registering the same token is not a new launch").toEqual(TELEMETRY);
    expect((await telemetryCall(tile, "publish")).body).toEqual({ outcome: "unchanged" });
  });

  test("a registration that collides with a live launch silences both peers", async () => {
    const run = await newTelemetryRun();
    const first = await launchTile(run);
    const observer = await newObserver();
    await publishedAndVisible(first, observer);

    const second = await registerAttestedInstance(broker, run, DECK_HOST, first.cwd, {
      desk_session: first.desk,
      telemetry_capability_hash: first.cap,
      resume_instance_token: first.token,
      pid: broker.proc.pid,
    });
    expect(second.status).toBe(200);
    expect(second.body.instance_token, "the live holder of the session key is not taken over").not.toBe(first.token);

    for (const [who, peerId] of [["first", first.peerId], ["second", second.body.peer_id]] as const) {
      const entry = await listedPeer(observer, peerId);
      expect(entry, `${who} peer is listed`).toBeDefined();
      expect(entry?.telemetry, `${who} peer: two live peers of one launch cannot be told apart`).toBeUndefined();
    }

    await post(`${broker.url}/disconnect`, { instance_token: second.body.instance_token });
    const alone = await listedPeer(observer, first.peerId);
    expect(alone, "the first peer is the only live one of its launch again").toBeDefined();
    expect(alone?.telemetry, "the observation the collision dropped is not restored by the other peer leaving").toBeUndefined();
  });

  test("a stop drops the snapshot and a later register or publish recreates nothing", async () => {
    const tile = await launchTile(await newTelemetryRun());
    const observer = await newObserver();
    await publishedAndVisible(tile, observer);

    expect((await telemetryCall(tile, "stop")).body).toEqual({ ok: true });
    expect((await listedPeer(observer, tile.peerId))?.telemetry).toBeUndefined();

    await reregister(tile);
    expect((await telemetryCall(tile, "publish")).body, "the closed launch refuses a late publication").toEqual({ outcome: "closed" });
    expect((await listedPeer(observer, tile.peerId))?.telemetry).toBeUndefined();
  });

  test("a stop for one tile leaves the sibling tiles of the same run publishing", async () => {
    const run = await newTelemetryRun();
    const closing = await launchTile(run);
    const sibling = await launchTile(run);
    const observer = await newObserver();
    await publishedAndVisible(closing, observer);
    await publishedAndVisible(sibling, observer);

    expect((await telemetryCall(closing, "stop")).body).toEqual({ ok: true });

    expect((await listedPeer(observer, sibling.peerId))?.telemetry, "the sibling tile never asked to stop").toEqual(TELEMETRY);
    const next = { ...TELEMETRY, observedAt: TELEMETRY.observedAt + 1, contextPct: 43 };
    expect((await telemetryCall(sibling, "publish", { snapshot: next })).body, "the sibling still publishes").toEqual({
      outcome: "updated",
    });
  });

  test("a run whose credential lapsed loses the snapshots of its tiles while they stay active", async () => {
    const run = await newTelemetryRun();
    const tile = await launchTile(run);
    const observer = await newObserver();
    await publishedAndVisible(tile, observer);

    withDb((db) => db.run("UPDATE approval_session_tokens SET revoked_at = ? WHERE token_id = ?", [new Date().toISOString(), run.tokenId]));
    const entry = await until(
      () => listedPeer(observer, tile.peerId),
      (e) => e !== undefined && e.telemetry === undefined,
      "the lapsed run to lose its telemetry"
    );
    expect(entry?.status, "the peer itself is still listed as active").toBe("active");
  }, 15_000);

  test("a publication refused for a lapsed credential drops the run's snapshots on the spot", async () => {
    const run = await newTelemetryRun();
    const tile = await launchTile(run);
    const observer = await newObserver();
    await publishedAndVisible(tile, observer);

    withDb((db) => db.run("UPDATE approval_session_tokens SET revoked_at = ? WHERE token_id = ?", [new Date().toISOString(), run.tokenId]));
    expect((await telemetryCall(tile, "publish")).status).toBe(403);
    expect((await listedPeer(observer, tile.peerId))?.telemetry).toBeUndefined();
  });

  test("the listed telemetry holds exactly the five public fields and nothing private reaches the peer entry", async () => {
    const tile = await launchTile(await newTelemetryRun());
    const observer = await newObserver();
    const sent = { ...TELEMETRY, instance_token: "wire-extra-token", run_ref: "wire-extra-run" };
    expect((await telemetryCall(tile, "publish", { snapshot: sent })).body).toEqual({ outcome: "updated" });

    const entry = await listedPeer(observer, tile.peerId);
    expect(entry?.telemetry, "the snapshot is listed").toBeDefined();
    expect(Object.keys(entry!.telemetry!).sort(), "telemetry carries these five keys and no wire extra").toEqual([
      "contextPct",
      "contextWindow",
      "model",
      "modelId",
      "observedAt",
    ]);
    expect(entry!.telemetry).toEqual(TELEMETRY);

    const text = JSON.stringify(entry);
    const privateValues: Record<string, string> = {
      "instance token": tile.token,
      "run_ref": tile.run.run,
      "operator_id": FIXTURE_OPERATOR_ID,
      "launch capability hash": tile.cap,
      "desk session": tile.desk,
      "desk session hash": await sha256Hex(tile.desk),
      "wire-extra token": "wire-extra-token",
      "wire-extra run": "wire-extra-run",
    };
    for (const [what, value] of Object.entries(privateValues)) {
      expect(text.includes(value), `the ${what} must not appear anywhere in the listed peer`).toBe(false);
    }
    const names: string[] = [];
    const collect = (value: unknown): void => {
      if (typeof value !== "object" || value === null) return;
      for (const [key, inner] of Object.entries(value)) {
        names.push(key);
        collect(inner);
      }
    };
    collect(entry);
    expect(
      names.filter((n) => /hash|token|run_ref|operator|capability|desk/i.test(n)),
      "no private field name appears in the listed peer"
    ).toEqual([]);
  });

  test.each([
    ["both context fields", { contextPct: null, contextWindow: null }],
    ["the percentage alone", { contextPct: null, contextWindow: 200_000 }],
    ["the window alone", { contextPct: 42, contextWindow: null }],
  ] as const)("an unknown context stays null in the listed telemetry: %s", async (_label, context) => {
    const tile = await launchTile(await newTelemetryRun());
    const observer = await newObserver();
    const snapshot = { ...TELEMETRY, ...context };
    expect((await telemetryCall(tile, "publish", { snapshot })).body).toEqual({ outcome: "updated" });

    const listed = (await listedPeer(observer, tile.peerId))?.telemetry;
    expect(listed, "the snapshot is listed").toBeDefined();
    expect(listed!.contextPct, "an unknown percentage is null, never 0 and never absent").toBe(context.contextPct);
    expect(listed!.contextWindow, "an unknown window is null, never 0 and never absent").toBe(context.contextWindow);
    expect(listed, "the other fields of the snapshot are untouched").toEqual(snapshot);
  });

  test.each([
    ["distinct tile ids", false],
    ["one tile id restarted under another launch hash", true],
  ] as const)("two tiles in one cwd do not share telemetry (%s)", async (_label, sameDesk) => {
    const run = await newTelemetryRun();
    const cwd = `C:\\telemetry\\shared-cwd-${++tileSeq}`;
    const a = await launchTile(run, { cwd, desk: `telemetry-shared-desk-${tileSeq}` });
    const b = await launchTile(run, { cwd, desk: sameDesk ? a.desk : `telemetry-other-desk-${tileSeq}` });
    expect(b.token).not.toBe(a.token);
    const observer = await newObserver();

    const mine = { ...TELEMETRY, contextPct: 10 };
    const theirs = { ...TELEMETRY, contextPct: 90, modelId: "claude-sonnet-4-6" };
    expect((await telemetryCall(a, "publish", { snapshot: mine })).body).toEqual({ outcome: "updated" });
    expect((await listedPeer(observer, a.peerId))?.telemetry, "tile A lists its own sample").toEqual(mine);
    expect((await listedPeer(observer, b.peerId))?.telemetry, "tile B has published nothing").toBeUndefined();

    expect((await telemetryCall(b, "publish", { snapshot: theirs })).body).toEqual({ outcome: "updated" });
    expect((await listedPeer(observer, a.peerId))?.telemetry, "tile A keeps its own sample").toEqual(mine);
    expect((await listedPeer(observer, b.peerId))?.telemetry, "tile B lists its own sample").toEqual(theirs);
  });
});

describe("/tile-peers refuses a caller that cannot prove the group", () => {
  test("a wrong group secret is refused", async () => {
    const res = await tilePeers(["tile-child"], { group_secret_hash: await sha256Hex(randomUUID()) });
    expect(res.status).toBe(401);
    expect(res.body.peers).toBeUndefined();
  });

  test("a secret-less group and an unknown group are refused", async () => {
    const def = await tilePeers(["x"], { group_id: "default", group_secret_hash: null });
    expect(def.status).toBe(403);
    const unknown = await tilePeers(["x"], { group_id: await groupId(randomUUID()) });
    expect(unknown.status).toBe(403);
  });

  test("a body that is not a JSON object is refused as a bad request", async () => {
    for (const body of [null, "tiles", 42, true]) {
      const res = await post<{ error?: string }>(`${broker.url}/tile-peers`, body);
      expect(res.status, `body ${JSON.stringify(body)}`).toBe(400);
    }
  });

  test("a tiles field that is not a bounded array is refused", async () => {
    expect((await tilePeers([], { tiles: "x" })).status).toBe(400);
    expect((await tilePeers([], { tiles: Array.from({ length: 65 }, () => ({ desk_session: "t" })) })).status).toBe(400);
  });

  test("a missing or wrong broker token is refused before any lookup", async () => {
    const brokerKey = randomUUID();
    const guarded = await startBroker({ CLAUDE_PEERS_BROKER_TOKEN: brokerKey });
    try {
      const body = JSON.stringify({ group_id: GROUP, group_secret_hash: PASSPHRASE_HASH, tiles: [] });
      const call = (auth?: string) =>
        fetch(`${guarded.url}/tile-peers`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
          body,
        });
      expect((await call()).status).toBe(401);
      expect((await call(`Bearer ${randomUUID()}`)).status).toBe(401);
      await expect(
        fetchTilePeers(
          { groupId: GROUP, secret: GROUP_PASSPHRASE, deskSessions: [] },
          { endpoint: { url: guarded.url, token: randomUUID() } }
        )
      ).rejects.toThrow("tile-peers failed: 401");
    } finally {
      await stopBroker(guarded);
    }
  });
});

describe("the Deck client trusts only a well-formed binding", () => {
  test("a broker older than the Deck is named as the cause, not reported as a generic failure", async () => {
    const call = fetchTilePeers(
      { ...QUERY, deskSessions: ["t"] },
      { ...ENDPOINT, fetchFn: fakeResponse({ error: "not found" }, 404) }
    );
    await expect(call).rejects.toThrow(/older than the Deck\. Quit the Deck \(it owns and relaunches the broker\)/);
  });

  test("an entry with an extra key is rebuilt as a {peer_id, status} pick-list", async () => {
    const peers = await fetchTilePeers(
      { ...QUERY, deskSessions: ["a", "b"] },
      {
        ...ENDPOINT,
        fetchFn: fakeResponse({ peers: [{ peer_id: "p-1", status: "active", instance_token: "leak" }, null] }),
      }
    );
    expect(peers).toEqual([{ peer_id: "p-1", status: "active" }, null]);
    expect(Object.keys(peers[0] as object).sort()).toEqual(["peer_id", "status"]);
  });

  test("a response of the right length but a hostile shape is refused as a whole", async () => {
    const hostile: unknown[] = [
      { peer_id: 7, status: "active" },
      { peer_id: "p-1", status: "zombie" },
      { status: "active" },
      { peer_id: "", status: "active" },
      "p-1",
    ];
    for (const entry of hostile) {
      await expect(
        fetchTilePeers({ ...QUERY, deskSessions: ["a"] }, { ...ENDPOINT, fetchFn: fakeResponse({ peers: [entry] }) }),
        `entry ${JSON.stringify(entry)} must not be believed`
      ).rejects.toThrow("tile-peers: entry 0 is neither null nor a {peer_id, status} binding");
    }
  });

  test("a broker that never answers is aborted before the next poll tick", async () => {
    expect(TILE_PEERS_TIMEOUT_MS).toBeLessThan(PEER_POLL_MS);
    const hangs = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const call = fetchTilePeers({ ...QUERY, deskSessions: ["a"], timeoutMs: 50 }, { ...ENDPOINT, fetchFn: hangs });
    expect(await settlesWithin(call, 1000), "the request is aborted, not left hanging").toBe("settled");
    await expect(call).rejects.toThrow();
  });
});

interface FakeDeck {
  poller: TilePeerPoller;
  peers: Map<string, string | null>;
  statuses: Map<string, "active" | "dormant" | null>;
  alive: Set<string>;
  fetches: string[][];
  reports: unknown[];
  changes: { id: string; next: string | null; previous: string | null }[];
}

function fakeDeck(fetchImpl: (deskSessions: string[]) => Promise<(TilePeerBinding | null)[]>): FakeDeck {
  const deck: Omit<FakeDeck, "poller"> = {
    peers: new Map(),
    statuses: new Map(),
    alive: new Set(),
    fetches: [],
    reports: [],
    changes: [],
  };
  const poller = new TilePeerPoller({
    tileIds: () => [...deck.peers.keys()],
    isAlive: (id) => deck.alive.has(id),
    currentPeer: (id) => (deck.peers.has(id) ? deck.peers.get(id)! : undefined),
    fetch: (deskSessions) => {
      deck.fetches.push(deskSessions);
      return fetchImpl(deskSessions);
    },
    setPeer: (id, next, previous) => {
      deck.changes.push({ id, next, previous });
      deck.peers.set(id, next);
    },
    currentStatus: (id) => deck.statuses.get(id) ?? null,
    setStatus: (id, next) => {
      deck.statuses.set(id, next);
    },
    report: (e) => deck.reports.push(e),
  });
  return { ...deck, poller };
}

describe("the peer poll tick", () => {
  test("a tick never overlaps the one still waiting on the broker", async () => {
    let release: (v: (TilePeerBinding | null)[]) => void = () => {};
    const deck = fakeDeck(() => new Promise((resolve) => (release = resolve)));
    deck.peers.set("t1", null);
    deck.alive.add("t1");

    const first = deck.poller.tick();
    expect(await deck.poller.tick(), "the overlapping tick is skipped").toBe(false);
    expect(deck.fetches).toHaveLength(1);
    release([{ peer_id: "p-1", status: "active" }]);
    expect(await first).toBe(true);
    expect(deck.peers.get("t1")).toBe("p-1");
  });

  test("an aborted round keeps the last ids, reports, and the next tick asks again", async () => {
    let hang = true;
    const deck = fakeDeck((deskSessions) =>
      hang
        ? fetchTilePeers(
            { ...QUERY, deskSessions, timeoutMs: 30 },
            {
              ...ENDPOINT,
              fetchFn: ((_u: string, init: RequestInit) =>
                new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as unknown as typeof fetch,
            }
          )
        : Promise.resolve([{ peer_id: "p-2", status: "active" }])
    );
    deck.peers.set("t1", "p-1");
    deck.alive.add("t1");

    const aborted = deck.poller.tick();
    expect(await settlesWithin(aborted, 1000), "the hung round is aborted").toBe("settled");
    expect(await aborted).toBe(false);
    expect(deck.peers.get("t1"), "a failed round blanks nothing").toBe("p-1");
    expect(deck.reports).toHaveLength(1);

    hang = false;
    expect(await deck.poller.tick()).toBe(true);
    expect(deck.fetches).toHaveLength(2);
    expect(deck.peers.get("t1")).toBe("p-2");
  });

  test("a null binding clears the tile's id, and a dead pty loses it without asking", async () => {
    const deck = fakeDeck(async (deskSessions) => deskSessions.map(() => null));
    deck.peers.set("t1", "p-1").set("t2", "p-2");
    deck.alive.add("t1");

    expect(await deck.poller.tick()).toBe(true);
    expect(deck.fetches).toEqual([["t1"]]);
    expect(deck.peers.get("t1")).toBeNull();
    expect(deck.peers.get("t2")).toBeNull();
    expect(deck.changes).toEqual([
      { id: "t1", next: null, previous: "p-1" },
      { id: "t2", next: null, previous: "p-2" },
    ]);
  });

  test("a failure episode is reported once, and a new episode after a success again", async () => {
    let fail = true;
    const deck = fakeDeck(async () => {
      if (fail) throw new Error("broker down");
      return [{ peer_id: "p-1", status: "active" }];
    });
    deck.peers.set("t1", null);
    deck.alive.add("t1");

    await deck.poller.tick();
    await deck.poller.tick();
    expect(deck.reports).toHaveLength(1);
    fail = false;
    await deck.poller.tick();
    fail = true;
    await deck.poller.tick();
    expect(deck.reports).toHaveLength(2);
  });
});

describe("the peer poll tick carries the broker status", () => {
  test("a dormant binding reaches the tile and an active one clears it, each reported as a change", async () => {
    let status: "active" | "dormant" = "dormant";
    const deck = fakeDeck(async () => [{ peer_id: "p-1", status }]);
    deck.peers.set("t1", "p-1");
    deck.alive.add("t1");

    expect(await deck.poller.tick(), "the status alone changed").toBe(true);
    expect(deck.statuses.get("t1")).toBe("dormant");
    expect(deck.changes, "the peer id did not move").toEqual([]);

    status = "active";
    expect(await deck.poller.tick()).toBe(true);
    expect(deck.statuses.get("t1")).toBe("active");
  });

  test("an unchanged status and peer id report no change", async () => {
    const deck = fakeDeck(async () => [{ peer_id: "p-1", status: "dormant" }]);
    deck.peers.set("t1", "p-1");
    deck.alive.add("t1");

    expect(await deck.poller.tick()).toBe(true);
    expect(await deck.poller.tick(), "a second identical answer is not a change").toBe(false);
  });

  test("a failed round keeps the last status, and a null binding or a dead pty clears it", async () => {
    let mode: "fail" | "unbound" = "fail";
    const deck = fakeDeck(async (deskSessions) => {
      if (mode === "fail") throw new Error("broker down");
      return deskSessions.map(() => null);
    });
    deck.peers.set("t1", "p-1").set("t2", "p-2");
    deck.statuses.set("t1", "dormant").set("t2", "dormant");
    deck.alive.add("t1");

    await deck.poller.tick();
    expect(deck.statuses.get("t1"), "a failed round blanks nothing").toBe("dormant");

    mode = "unbound";
    await deck.poller.tick();
    expect(deck.statuses.get("t1"), "no binding means no status").toBeNull();
    expect(deck.statuses.get("t2"), "a dead pty has no status").toBeNull();
  });
});

describe("source scan, not execution: the Deck's peer poll is wired to the broker, not to the cache files", () => {
  const main = join(import.meta.dir, "..", "desktop", "src", "main");
  const service = readFileSync(join(main, "session-service.ts"), "utf-8").replace(/\r\n/g, "\n");
  const index = readFileSync(join(main, "index.ts"), "utf-8").replace(/\r\n/g, "\n");

  function methodBody(src: string, signature: string): string {
    const start = src.indexOf(signature);
    expect(start, `${signature} exists`).toBeGreaterThan(-1);
    const end = src.indexOf("\n  }\n", start);
    return src.slice(start, end);
  }

  test("the poll timer drives refreshPeerIds, which asks /tile-peers and applies through applyPeerId", () => {
    expect(methodBody(service, "  start(): void {")).toContain("setInterval(() => this.pollPeerIds(), PEER_POLL_MS)");
    expect(methodBody(service, "  private pollPeerIds(): void {")).toContain("void this.refreshPeerIds()");
    const refresh = methodBody(service, "  private async refreshPeerIds(): Promise<void> {");
    for (const wire of [
      "new TilePeerPoller(",
      "fetchTilePeers({ groupId, secret, deskSessions }, { endpoint })",
      "setPeer: (id, next) => this.applyPeerId(id, next)",
      "setStatus: (id, next) => {",
      "currentStatus: (id) => this.runtime.get(id)?.peerStatus ?? null",
      "reportError(",
      "await this.peerPoller.tick()",
    ]) {
      expect(refresh, `refreshPeerIds wires ${wire}`).toContain(wire);
    }
    expect(service, "no production path reads the peer-id cache files").not.toContain("resolvePeerIdAmong");
  });

  test("index.ts hands SessionService the scope the query needs", () => {
    const ctor = index.slice(index.indexOf("const service = new SessionService("), index.indexOf("\n)\n", index.indexOf("const service = new SessionService(")));
    expect(ctor).toContain("groupId: activeScope.groupId,");
    expect(ctor).toContain("secret: activeScope.secret,");
    expect(ctor).toContain("endpoint: resolveBrokerEndpoint()");
  });
});
