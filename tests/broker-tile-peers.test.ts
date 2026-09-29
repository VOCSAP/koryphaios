import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { startBroker, stopBroker, post, livePid, sha256Hex, groupId, type TestBroker } from "./_helper.ts";
import { fetchTilePeers, TILE_PEERS_TIMEOUT_MS } from "../desktop/src/main/broker-client.ts";
import { PEER_POLL_MS, TilePeerPoller, type TilePeerBinding } from "../desktop/src/main/peer-state.ts";

const GROUP_PASSPHRASE = randomUUID();
const DECK_HOST = hostname();
const DECK_CWD = "C:\\work\\repo";

let broker: TestBroker;
let GROUP = "";
let PASSPHRASE_HASH = "";

beforeAll(async () => {
  broker = await startBroker({ CLAUDE_PEERS_CLEAN_INTERVAL_SEC: "1" });
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
  const db = new Database(broker.dbPath);
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

  test("known limit (card 2327907c): a sandboxed tile restarted while its previous server.ts is still active resolves to that previous peer", async () => {
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
  alive: Set<string>;
  fetches: string[][];
  reports: unknown[];
  changes: { id: string; next: string | null; previous: string | null }[];
}

function fakeDeck(fetchImpl: (deskSessions: string[]) => Promise<(TilePeerBinding | null)[]>): FakeDeck {
  const deck: Omit<FakeDeck, "poller"> = {
    peers: new Map(),
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
