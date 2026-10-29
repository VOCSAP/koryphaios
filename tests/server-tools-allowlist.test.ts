import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { startBroker, stopBroker, scrubEnv, type TestBroker } from "./_helper.ts";
import { TOOLS } from "../server.ts";
import { ROADMAP_INSTRUCTIONS } from "../shared/roadmap-mcp.ts";
import { ROADMAP_TOOLS } from "../shared/roadmap-tools.ts";
import {
  globalSessionIdentityFileName,
  readGlobalSessionIdentityFile,
  writeGlobalSessionIdentityFile,
  type SessionIdentity,
  type WriterGeneration,
} from "../shared/peer-cache.ts";
import { computeGroupId } from "../shared/config.ts";
import { measureWriterGeneration } from "../shared/process-generation.ts";
import { reachedWithin } from "./_bounded-await.ts";

const brokers: TestBroker[] = [];
const procs: ReturnType<typeof Bun.spawn>[] = [];
const homes: string[] = [];
const stoppers: Array<() => void> = [];

afterAll(async () => {
  for (const stop of stoppers.splice(0)) stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  for (const p of procs) {
    try {
      p.kill();
      await p.exited;
    } catch {
      /* already gone */
    }
  }
  for (const b of brokers) await stopBroker(b);
});

interface JsonRpcResponse {
  id?: number;
  result?: {
    content?: Array<{ text?: string }>;
    isError?: boolean;
    tools?: Array<{ name: string; inputSchema?: unknown; description?: string }>;
    capabilities?: { experimental?: Record<string, unknown> };
    instructions?: string;
  };
  error?: { code?: number; message?: string };
}

/** Read stdout until a JSON-RPC message with the wanted id shows up. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  wantedId: number,
  buffer: { text: string }
): Promise<JsonRpcResponse> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    let idx: number;
    while ((idx = buffer.text.indexOf("\n")) >= 0) {
      const line = buffer.text.slice(0, idx).trim();
      buffer.text = buffer.text.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (msg.id === wantedId) return msg;
      } catch {
        /* not a complete JSON line yet */
      }
    }
    const { value, done } = await reader.read();
    if (done) break;
    buffer.text += decoder.decode(value, { stream: true });
  }
  throw new Error(`no JSON-RPC response with id ${wantedId}`);
}

const NO_MEASURABLE_GENERATION = process.platform === "darwin";
const NEEDS_GENERATION = "needs a measurable process generation, refused on darwin";

type BrokerEndpoint = Pick<TestBroker, "url" | "port" | "tmpDir">;

interface Harness {
  b: BrokerEndpoint;
  proc: ReturnType<typeof Bun.spawn>;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  buffer: { text: string };
  send: (msg: unknown) => void;
}

async function spawnServer(
  toolsEnv: string | undefined,
  entrypoint = "server.ts",
  options: { broker?: BrokerEndpoint; env?: Record<string, string> } = {}
): Promise<Harness> {
  let b: BrokerEndpoint;
  if (options.broker) b = options.broker;
  else {
    const started = await startBroker();
    brokers.push(started);
    b = started;
  }

  const extra: Record<string, string> = {
    CLAUDE_PEERS_BROKER_URL: b.url,
    CLAUDE_PEERS_PORT: String(b.port),
    ...options.env,
  };
  if (toolsEnv !== undefined) extra.CLAUDE_PEERS_TOOLS = toolsEnv;
  const proc = Bun.spawn(["bun", entrypoint], {
    env: scrubEnv(b.tmpDir, extra),
    stdio: ["pipe", "pipe", "pipe"],
  });
  procs.push(proc);
  const reader = proc.stdout.getReader();
  const buffer = { text: "" };
  const send = (msg: unknown): void => {
    proc.stdin.write(JSON.stringify(msg) + "\n");
  };

  return { b, proc, reader, buffer, send };
}

const INITIALIZE_REQUEST = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: { roots: {}, elicitation: {} },
    clientInfo: { name: "test-harness", version: "0.0.1" },
  },
});

async function boot(toolsEnv: string | undefined): Promise<Harness> {
  const h = await spawnServer(toolsEnv);
  h.send(INITIALIZE_REQUEST(0));
  await readUntil(h.reader, 0, h.buffer);
  return h;
}

describe("CLAUDE_PEERS_TOOLS: server.ts's tool allow-list", () => {
  test("legacy roadmap registry has the exact shared schemas", () => {
    expect(TOOLS.filter((tool) => tool.name.startsWith("roadmap_"))).toEqual(ROADMAP_TOOLS);
  });

  test("unset: every tool listed, unrestricted (zero regression for a session launched outside Kory)", async () => {
    const h = await boot(undefined);
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const res = await readUntil(h.reader, 1, h.buffer);
    const names = (res.result?.tools ?? []).map((t) => t.name);
    // A real cross-section of the tool set, not just one name -- proves the
    // full array passed through, not a coincidental single survivor.
    expect(names).toContain("list_peers");
    expect(names).toContain("send_message");
    expect(names.filter((name) => name.startsWith("roadmap_")).sort()).toEqual(ROADMAP_TOOLS.map((tool) => tool.name).sort());
    // Set equality against the source of truth, not a count: a count stays
    // green when the filter drops the WRONG tools, as long as the total
    // lands right.
    expect(new Set<string>(names)).toEqual(new Set(TOOLS.map((t) => t.name)));
    expect(names.length).toBe(TOOLS.length);
  }, 60_000);

  test("set, non-empty: tools/list returns exactly the named subset, dropping an unlisted name and a typo'd one", async () => {
    const h = await boot("whoami, set_summary ,not-a-real-tool");
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const res = await readUntil(h.reader, 1, h.buffer);
    const names = (res.result?.tools ?? []).map((t) => t.name);
    // Exact set: the allow-list can only shrink TOOLS, never grow it -- the
    // stale/typo'd name in the env var must not appear as a phantom tool.
    expect(names.sort()).toEqual(["set_summary", "whoami"]);
  }, 60_000);

  test("set and empty: zero tools listed, distinct from unset", async () => {
    const h = await boot("");
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const res = await readUntil(h.reader, 1, h.buffer);
    expect(res.result?.tools ?? []).toEqual([]);
  }, 60_000);

  test("tools/call refuses a tool excluded by the allow-list, BEFORE it reaches the tool's own logic", async () => {
    const h = await boot("whoami");
    // list_peers is excluded; if the guard did not short-circuit before the
    // switch, this would instead hit list_peers' own broker-registration
    // check and return a different error ("Not registered with broker yet").
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_peers", arguments: { scope: "machine" } },
    });
    const res = await readUntil(h.reader, 1, h.buffer);
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content?.[0]?.text).toBe("Error: tool not available: list_peers");
  }, 60_000);

  test("tools/call still accepts a tool included by the allow-list", async () => {
    const h = await boot("whoami");
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "whoami", arguments: {} },
    });
    const res = await readUntil(h.reader, 1, h.buffer);
    // Registration completes before mcp.connect in main(), so by the time
    // this responds the guard has let it through to whoami's own logic --
    // proven by NOT getting the allow-list's refusal text.
    expect(res.result?.content?.[0]?.text).not.toBe("Error: tool not available: whoami");
  }, 60_000);

  test("a genuinely unknown tool name still hits the pre-existing 'Unknown tool' path, unaffected by the allow-list guard", async () => {
    const h = await boot(undefined);
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "not-a-real-tool", arguments: {} },
    });
    // The SDK converts the handler's thrown default-case Error into a
    // JSON-RPC protocol error (`error`, not `result`) -- distinct from the
    // allow-list guard's own isError-tool-RESULT shape asserted above, and
    // proof the guard did not swallow this pre-existing path.
    const res = await readUntil(h.reader, 1, h.buffer);
    expect(res.result).toBeUndefined();
    expect(res.error?.message ?? "").toContain("Unknown tool: not-a-real-tool");
  }, 60_000);
});

describe("kory-roadmap", () => {
  test("serves ROADMAP_INSTRUCTIONS on initialize and lists the exact shared roadmap registry", async () => {
    const h = await spawnServer(undefined, "server-roadmap.ts");
    h.send(INITIALIZE_REQUEST(0));
    const init = await readUntil(h.reader, 0, h.buffer);
    expect(init.result?.instructions, "server-roadmap.ts initialize reply does not carry ROADMAP_INSTRUCTIONS").toBe(
      ROADMAP_INSTRUCTIONS
    );
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const res = await readUntil(h.reader, 1, h.buffer);
    expect(res.result?.tools).toEqual(ROADMAP_TOOLS);
  }, 60_000);

  test("refuses every call when the global identity is absent", async () => {
    const h = await spawnServer(undefined, "server-roadmap.ts");
    h.send(INITIALIZE_REQUEST(0));
    await readUntil(h.reader, 0, h.buffer);
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "roadmap_list", arguments: {} },
    });
    const res = await readUntil(h.reader, 1, h.buffer);
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content?.[0]?.text).toBe("Roadmap companion identity is unavailable");
  }, 60_000);

  test.skipIf(NO_MEASURABLE_GENERATION)(`formats a real roadmap call through the companion like the legacy server (${NEEDS_GENERATION})`, async () => {
    const b = await startBroker();
    brokers.push(b);
    const socket = "roadmap-companion-test-socket";
    const core = await spawnServer(undefined, "server.ts", { broker: b, env: { CLAUDE_CODE_MESSAGING_SOCKET: socket } });
    core.send(INITIALIZE_REQUEST(0));
    await readUntil(core.reader, 0, core.buffer);

    const companion = await spawnServer(undefined, "server-roadmap.ts", {
      broker: b,
      env: { CLAUDE_CODE_MESSAGING_SOCKET: socket },
    });
    companion.send(INITIALIZE_REQUEST(0));
    await readUntil(companion.reader, 0, companion.buffer);
    companion.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "roadmap_list", arguments: {} } });

    const res = await readUntil(companion.reader, 1, companion.buffer);
    expect(res.result?.content?.[0]?.text).toBe(
      "The roadmap is empty (for these filters). Use roadmap_add to record features, bugs, debt or ideas."
    );
  }, 60_000);
});

interface CountingBroker extends BrokerEndpoint {
  requests: Array<{ path: string; authorization: string | null; body: Record<string, unknown> }>;
}

function startCountingBroker(requireBearer: string | null = null): CountingBroker {
  const tmpDir = mkdtempSync(join(tmpdir(), "cp-roadmap-companion-"));
  homes.push(tmpDir);
  const broker: CountingBroker = { url: "", port: 0, tmpDir, requests: [] };
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const authorization = req.headers.get("authorization");
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      broker.requests.push({ path, authorization, body });
      if (requireBearer !== null && authorization !== `Bearer ${requireBearer}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (path === "/roadmap/list") return Response.json({ items: [] });
      return Response.json({ error: `unexpected route ${path}` }, { status: 404 });
    },
  });
  stoppers.push(() => srv.stop(true));
  broker.url = `http://127.0.0.1:${srv.port}`;
  broker.port = srv.port as number;
  return broker;
}

const COMPANION_SOCKET = "roadmap-companion-refusal-socket";
const COMPANION_PROJECT_KEY = "github.com/example/companion-project";
const COMPANION_IDENTITY_REFUSAL = "Roadmap companion identity is unavailable";

let ownGeneration: WriterGeneration;
beforeAll(async () => {
  if (NO_MEASURABLE_GENERATION) return;
  const measured = await measureWriterGeneration(process.pid);
  if (!measured) throw new Error("this platform cannot measure a process generation: the companion fixtures cannot be built");
  ownGeneration = measured;
});

function snapshotPath(home: string, socket = COMPANION_SOCKET): string {
  return join(home, ".claude", "peers", globalSessionIdentityFileName(socket));
}

async function writeSnapshot(
  broker: CountingBroker,
  generation: WriterGeneration,
  brokerUrl = new URL(broker.url).toString()
): Promise<void> {
  await writeGlobalSessionIdentityFile(
    COMPANION_SOCKET,
    "writer-peer",
    "writer-group",
    `tok-${crypto.randomUUID()}`,
    COMPANION_PROJECT_KEY,
    broker.tmpDir,
    generation,
    brokerUrl
  );
}

function rewriteSnapshot(home: string, edit: (snapshot: Record<string, unknown>) => void): void {
  const path = snapshotPath(home);
  const snapshot = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  edit(snapshot);
  writeFileSync(path, JSON.stringify(snapshot));
}

function callRoadmapList(h: Harness, id: number): Promise<JsonRpcResponse> {
  h.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "roadmap_list", arguments: {} } });
  return readUntil(h.reader, id, h.buffer);
}

async function startCompanion(
  broker: CountingBroker,
  env: Record<string, string> = {},
  toolsEnv: string | undefined = undefined
): Promise<Harness> {
  const h = await spawnServer(toolsEnv, "server-roadmap.ts", {
    broker,
    env: { CLAUDE_CODE_MESSAGING_SOCKET: COMPANION_SOCKET, ...env },
  });
  h.send(INITIALIZE_REQUEST(0));
  await readUntil(h.reader, 0, h.buffer);
  return h;
}

describe.skipIf(NO_MEASURABLE_GENERATION)(`kory-roadmap fails closed without touching the broker (${NEEDS_GENERATION})`, () => {
  let broker: CountingBroker;
  let companion: Harness;
  let nextId = 1;

  beforeAll(async () => {
    broker = startCountingBroker();
    companion = await startCompanion(broker);
  }, 60_000);

  async function expectRefusedWithoutBrokerTraffic(why: string): Promise<void> {
    const before = broker.requests.length;
    const res = await callRoadmapList(companion, nextId++);
    expect(res.result?.isError, `${why}: the call must be refused`).toBe(true);
    expect(res.result?.content?.[0]?.text, `${why}: refusal text`).toBe(COMPANION_IDENTITY_REFUSAL);
    expect(
      broker.requests.slice(before).map((r) => r.path),
      `${why}: the companion reached the broker (no request, and above all no /register, may follow a refusal)`
    ).toEqual([]);
  }

  test("a valid snapshot is served with the snapshot's project key (control for the refusals below)", async () => {
    await writeSnapshot(broker, ownGeneration);
    const before = broker.requests.length;
    const res = await callRoadmapList(companion, nextId++);
    expect(res.result?.isError).toBeFalsy();
    expect(res.result?.content?.[0]?.text).toBe(
      "The roadmap is empty (for these filters). Use roadmap_add to record features, bugs, debt or ideas."
    );
    const sent = broker.requests.slice(before);
    expect(sent.map((r) => r.path)).toEqual(["/roadmap/list"]);
    expect(sent[0]!.body.project_key, "the project key must come from the snapshot").toBe(COMPANION_PROJECT_KEY);
  }, 60_000);

  test("snapshot file absent while the messaging socket is set", async () => {
    rmSync(snapshotPath(broker.tmpDir), { force: true });
    await expectRefusedWithoutBrokerTraffic("no snapshot");
  }, 60_000);

  test("snapshot without a project key", async () => {
    await writeSnapshot(broker, ownGeneration);
    rewriteSnapshot(broker.tmpDir, (snapshot) => {
      delete snapshot.project_key;
    });
    await expectRefusedWithoutBrokerTraffic("no project_key");
  }, 60_000);

  test("snapshot of a reused PID: same pid, different process generation", async () => {
    const reused: WriterGeneration =
      ownGeneration.platform === "win32"
        ? { ...ownGeneration, creationUtc: "2000-01-01T00:00:00.0000000Z" }
        : { ...ownGeneration, startToken: "1" };
    await writeSnapshot(broker, reused);
    await expectRefusedWithoutBrokerTraffic("stale generation");
  }, 60_000);

  test("snapshot whose writer process no longer exists", async () => {
    await writeSnapshot(broker, { ...ownGeneration, pid: 2_147_483_000 });
    await expectRefusedWithoutBrokerTraffic("dead writer");
  }, 60_000);

  test("snapshot with no recorded writer generation", async () => {
    await writeSnapshot(broker, ownGeneration);
    rewriteSnapshot(broker.tmpDir, (snapshot) => {
      delete snapshot.writer_generation;
    });
    await expectRefusedWithoutBrokerTraffic("no writer_generation");
  }, 60_000);

  test("snapshot published for another broker: its token is never sent to this one", async () => {
    await writeSnapshot(broker, ownGeneration, "http://127.0.0.1:1/");
    await expectRefusedWithoutBrokerTraffic("snapshot of another broker");
  }, 60_000);

  test("snapshot with no broker url", async () => {
    await writeSnapshot(broker, ownGeneration);
    rewriteSnapshot(broker.tmpDir, (snapshot) => {
      delete snapshot.broker_url;
    });
    await expectRefusedWithoutBrokerTraffic("no broker_url");
  }, 60_000);

  test("messaging socket unset, even with a valid snapshot on disk", async () => {
    await writeSnapshot(broker, ownGeneration);
    const bare = await spawnServer(undefined, "server-roadmap.ts", { broker });
    bare.send(INITIALIZE_REQUEST(0));
    await readUntil(bare.reader, 0, bare.buffer);
    const before = broker.requests.length;
    const res = await callRoadmapList(bare, 1);
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content?.[0]?.text).toBe(COMPANION_IDENTITY_REFUSAL);
    expect(broker.requests.slice(before)).toEqual([]);
  }, 60_000);
});

describe.skipIf(NO_MEASURABLE_GENERATION)(`kory-roadmap honors CLAUDE_PEERS_TOOLS (${NEEDS_GENERATION})`, () => {
  const ROADMAP_NAMES = ROADMAP_TOOLS.map((tool) => tool.name);

  async function listNames(h: Harness): Promise<string[]> {
    h.send({ jsonrpc: "2.0", id: 90, method: "tools/list", params: {} });
    const res = await readUntil(h.reader, 90, h.buffer);
    return (res.result?.tools ?? []).map((tool) => tool.name);
  }

  async function callNamed(h: Harness, id: number, name: string): Promise<JsonRpcResponse> {
    h.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });
    return readUntil(h.reader, id, h.buffer);
  }

  test("unset: every roadmap tool is listed and callable", async () => {
    const broker = startCountingBroker();
    const companion = await startCompanion(broker);
    await writeSnapshot(broker, ownGeneration);

    expect(await listNames(companion)).toEqual(ROADMAP_NAMES);
    expect((await callNamed(companion, 1, "roadmap_list")).result?.isError).toBeFalsy();
  }, 60_000);

  test("set and empty: nothing is listed and every roadmap call is refused before the broker", async () => {
    const broker = startCountingBroker();
    const companion = await startCompanion(broker, {}, "");
    await writeSnapshot(broker, ownGeneration);

    expect(await listNames(companion)).toEqual([]);
    for (const [index, name] of ROADMAP_NAMES.entries()) {
      const res = await callNamed(companion, index + 1, name);
      expect(res.result?.isError, `${name} was callable under an empty allow-list`).toBe(true);
      expect(res.result?.content?.[0]?.text).toBe(`Error: tool not available: ${name}`);
    }
    expect(broker.requests, "a refused roadmap call reached the broker").toEqual([]);
  }, 60_000);

  test("set and non-empty: only the intersection with the registry is listed and callable", async () => {
    const broker = startCountingBroker();
    const companion = await startCompanion(broker, {}, "roadmap_list, roadmap_get ,whoami,not-a-tool");
    await writeSnapshot(broker, ownGeneration);

    expect(await listNames(companion), "a name outside the registry became a tool, or an allowed one was dropped").toEqual(
      ROADMAP_NAMES.filter((name) => name === "roadmap_list" || name === "roadmap_get")
    );
    const denied = await callNamed(companion, 1, "roadmap_add");
    expect(denied.result?.isError).toBe(true);
    expect(denied.result?.content?.[0]?.text).toBe("Error: tool not available: roadmap_add");
    expect(broker.requests, "a denied roadmap call reached the broker").toEqual([]);

    const served = await callNamed(companion, 2, "roadmap_list");
    expect(served.result?.isError).toBeFalsy();
    expect(broker.requests.map((request) => request.path)).toEqual(["/roadmap/list"]);
  }, 60_000);
});

describe.skipIf(NO_MEASURABLE_GENERATION)(`kory-roadmap authenticates to a broker that requires a token (${NEEDS_GENERATION})`, () => {
  test("sends Authorization: Bearer with the configured broker token", async () => {
    const brokerToken = `bt-${crypto.randomUUID()}`;
    const broker = startCountingBroker(brokerToken);
    const companion = await startCompanion(broker, { CLAUDE_PEERS_BROKER_TOKEN: brokerToken });
    await writeSnapshot(broker, ownGeneration);

    const res = await callRoadmapList(companion, 1);

    expect(res.result?.isError, `the broker refused the companion: ${res.result?.content?.[0]?.text}`).toBeFalsy();
    expect(broker.requests.map((r) => r.authorization)).toEqual([`Bearer ${brokerToken}`]);
  }, 60_000);

  test("sends no Authorization header when no broker token is configured", async () => {
    const broker = startCountingBroker();
    const companion = await startCompanion(broker);
    await writeSnapshot(broker, ownGeneration);

    await callRoadmapList(companion, 1);

    expect(broker.requests.map((r) => r.authorization)).toEqual([null]);
  }, 60_000);
});

describe.skipIf(NO_MEASURABLE_GENERATION)(`the legacy server.ts and kory-roadmap render the same roadmap text (${NEEDS_GENERATION})`, () => {
  let legacy: Harness;
  let companion: Harness;
  let nextId = 1;

  beforeAll(async () => {
    const b = await startBroker();
    brokers.push(b);
    const env = { CLAUDE_CODE_MESSAGING_SOCKET: "roadmap-parity-socket" };
    legacy = await spawnServer(undefined, "server.ts", { broker: b, env });
    legacy.send(INITIALIZE_REQUEST(0));
    await readUntil(legacy.reader, 0, legacy.buffer);
    companion = await spawnServer(undefined, "server-roadmap.ts", { broker: b, env });
    companion.send(INITIALIZE_REQUEST(0));
    await readUntil(companion.reader, 0, companion.buffer);
  }, 120_000);

  const call = async (h: Harness, name: string, args: Record<string, unknown>) => {
    const id = nextId++;
    h.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const res = await readUntil(h.reader, id, h.buffer);
    return { isError: res.result?.isError === true, text: res.result?.content?.[0]?.text ?? "" };
  };
  const bothServers = async (name: string, args: Record<string, unknown>) => {
    const viaLegacy = await call(legacy, name, args);
    expect(viaLegacy.text, `${name} is not served by server.ts`).not.toContain("tool not available");
    const viaCompanion = await call(companion, name, args);
    expect(viaCompanion, `${name}: kory-roadmap renders differently from server.ts`).toEqual(viaLegacy);
    return viaLegacy;
  };

  test("a request the broker refuses is rendered the same way", async () => {
    const refused = await bothServers("roadmap_add", {});
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("title is required");
  }, 60_000);

  test("each of the six roadmap tools gives the same result through either server", async () => {
    expect((await bothServers("roadmap_list", {})).text).toContain("The roadmap is empty");

    const added = await call(legacy, "roadmap_add", { title: "Parity probe", kind: "bug" });
    expect(added.isError, added.text).toBe(false);
    const listed = await bothServers("roadmap_list", {});
    expect(listed.text, "the card added through server.ts is invisible to the list").toContain("Parity probe");
    const cardId = /\[([0-9a-f]{8})\]/.exec(listed.text)?.[1];
    expect(cardId, "the list shows no card id").toBeDefined();
    expect((await bothServers("roadmap_get", { id: cardId! })).text).toContain("Parity probe");

    const unknown = "ffffffff";
    const refusals: Array<[string, Record<string, unknown>]> = [
      ["roadmap_get", { id: unknown }],
      ["roadmap_update", { id: unknown, status: "done" }],
      ["roadmap_archive", { id: unknown }],
      ["roadmap_append_context", { id: unknown, text: "note" }],
    ];
    for (const [name, args] of refusals) {
      const refused = await bothServers(name, args);
      expect(refused.isError, `${name} on a bad argument must be an error: ${refused.text}`).toBe(true);
    }
  }, 120_000);
});

interface FaultProxy extends BrokerEndpoint {
  refuse: Set<string>;
}

function startFaultProxy(target: string, tmpDir: string): FaultProxy {
  const proxy: FaultProxy = { url: "", port: 0, tmpDir, refuse: new Set() };
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (proxy.refuse.has(url.pathname)) return Response.json({ error: "refused by the test" }, { status: 503 });
      const raw = req.method === "GET" ? undefined : await req.text();
      return fetch(`${target}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body: raw });
    },
  });
  stoppers.push(() => srv.stop(true));
  proxy.url = `http://127.0.0.1:${srv.port}`;
  proxy.port = srv.port as number;
  return proxy;
}

const SWITCH_SOCKET = "roadmap-switch-socket";

interface SwitchableSession {
  home: string;
  proxy: FaultProxy;
  legacy: Harness;
  companion: Harness;
  betaGroupId: string;
  before: SessionIdentity;
  snapshot: () => Promise<SessionIdentity | null>;
  call: (h: Harness, name: string, args: Record<string, unknown>) => Promise<JsonRpcResponse>;
}

async function startSwitchableSession(): Promise<SwitchableSession> {
  const b = await startBroker();
  brokers.push(b);
  const home = mkdtempSync(join(tmpdir(), "cp-roadmap-switch-"));
  homes.push(home);
  const betaSecret = `beta-${crypto.randomUUID()}`;
  mkdirSync(join(home, "claude-peers"), { recursive: true });
  writeFileSync(
    join(home, "claude-peers", "config.json"),
    JSON.stringify({ groups: { alpha: `alpha-${crypto.randomUUID()}`, beta: betaSecret }, default_group: "alpha" })
  );
  const proxy = startFaultProxy(b.url, home);
  const env = { CLAUDE_CODE_MESSAGING_SOCKET: SWITCH_SOCKET };
  const legacy = await spawnServer(undefined, "server.ts", { broker: proxy, env });
  legacy.send(INITIALIZE_REQUEST(0));
  await readUntil(legacy.reader, 0, legacy.buffer);
  const companion = await spawnServer(undefined, "server-roadmap.ts", { broker: proxy, env });
  companion.send(INITIALIZE_REQUEST(0));
  await readUntil(companion.reader, 0, companion.buffer);

  const snapshot = () => readGlobalSessionIdentityFile(SWITCH_SOCKET, home);
  let before: SessionIdentity | null = null;
  for (let attempt = 0; attempt < 100 && before === null; attempt++) {
    before = await snapshot();
    if (before === null) await Bun.sleep(50);
  }
  if (before === null) throw new Error("server.ts never published its global snapshot: the switch fixtures prove nothing");

  let nextId = 1;
  const call = (h: Harness, name: string, args: Record<string, unknown>) => {
    const id = nextId++;
    h.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    return readUntil(h.reader, id, h.buffer);
  };
  return { home, proxy, legacy, companion, betaGroupId: computeGroupId(betaSecret), before, snapshot, call };
}

describe.skipIf(NO_MEASURABLE_GENERATION)(`kory-roadmap never serves the identity a session left behind (${NEEDS_GENERATION})`, () => {
  const EMPTY_ROADMAP = "The roadmap is empty (for these filters). Use roadmap_add to record features, bugs, debt or ideas.";

  async function expectCompanionRefuses(s: SwitchableSession, why: string): Promise<void> {
    expect(await s.snapshot(), `${why}: a snapshot is still on disk`).toBeNull();
    const res = await s.call(s.companion, "roadmap_list", {});
    expect(res.result?.isError, `${why}: the companion served a call`).toBe(true);
    expect(res.result?.content?.[0]?.text).toBe(COMPANION_IDENTITY_REFUSAL);
  }

  test("after switch_group the snapshot is the new identity and the companion serves it", async () => {
    const s = await startSwitchableSession();
    expect((await s.call(s.companion, "roadmap_list", {})).result?.content?.[0]?.text, "control before the switch").toBe(EMPTY_ROADMAP);

    const switched = await s.call(s.legacy, "switch_group", { name: "beta" });
    expect(switched.result?.isError ?? false, switched.result?.content?.[0]?.text).toBe(false);

    const after = await s.snapshot();
    expect(after?.groupId, "the snapshot still names the group the session left").toBe(s.betaGroupId);
    expect(after?.instanceToken, "the snapshot still holds the instance the session left").not.toBe(s.before.instanceToken);
    expect((await s.call(s.companion, "roadmap_list", {})).result?.content?.[0]?.text).toBe(EMPTY_ROADMAP);
  }, 120_000);

  test("a re-register refused after /disconnect leaves no snapshot, so the companion refuses", async () => {
    const s = await startSwitchableSession();
    s.proxy.refuse.add("/register");

    const switched = await s.call(s.legacy, "switch_group", { name: "beta" });

    expect(switched.result?.isError, "the switch must fail when the re-register is refused").toBe(true);
    await expectCompanionRefuses(s, "re-register refused");
  }, 120_000);

  test("a switch refused at /disconnect keeps the old identity published and the companion serves it", async () => {
    const s = await startSwitchableSession();
    s.proxy.refuse.add("/disconnect");

    const switched = await s.call(s.legacy, "switch_group", { name: "beta" });

    expect(switched.result?.isError, "the switch must fail when /disconnect is refused").toBe(true);
    const kept = await s.snapshot();
    expect(kept?.peerId, "the snapshot no longer names the peer the session still is").toBe(s.before.peerId);
    expect(kept?.instanceToken, "the snapshot no longer holds the instance the session still is").toBe(s.before.instanceToken);
    expect(kept?.groupId, "the snapshot names another group than the one the session stayed in").toBe(s.before.groupId);
    const served = await s.call(s.companion, "roadmap_list", {});
    expect(served.result?.isError ?? false, `the companion refused a session that never left: ${served.result?.content?.[0]?.text}`).toBe(false);
    expect(served.result?.content?.[0]?.text).toBe(EMPTY_ROADMAP);
  }, 120_000);

  test("a new snapshot that cannot be written leaves no snapshot, so the companion refuses", async () => {
    const s = await startSwitchableSession();
    mkdirSync(`${snapshotPath(s.home, SWITCH_SOCKET)}.${s.legacy.proc.pid}.tmp`);

    const switched = await s.call(s.legacy, "switch_group", { name: "beta" });

    expect(switched.result?.isError ?? false, switched.result?.content?.[0]?.text).toBe(false);
    await expectCompanionRefuses(s, "snapshot write failed");
  }, 120_000);

  test("a set_id whose new snapshot cannot be written leaves no snapshot, so the companion refuses", async () => {
    const s = await startSwitchableSession();
    mkdirSync(`${snapshotPath(s.home, SWITCH_SOCKET)}.${s.legacy.proc.pid}.tmp`);

    const renamed = await s.call(s.legacy, "set_id", { new_id: "renamed-peer" });

    expect(renamed.result?.isError ?? false, renamed.result?.content?.[0]?.text).toBe(false);
    await expectCompanionRefuses(s, "set_id snapshot write failed");
  }, 120_000);
});

describe("kory-roadmap import graph", () => {
  const REPO = resolve(import.meta.dir, "..");
  const SERVER_ONLY_SYMBOL = "writeGlobalCompanionIdentity";

  test("server-roadmap.ts never reaches server.ts, directly or through a shared module", async () => {
    const result = await Bun.build({ entrypoints: [join(REPO, "server-roadmap.ts")], root: REPO, target: "bun", metafile: true });
    expect(result.success, result.logs.map((log) => log.message).join("\n")).toBe(true);
    const companion = {
      inputs: Object.keys(result.metafile!.inputs).map((input) =>
        relative(REPO, isAbsolute(input) ? input : resolve(process.cwd(), input)).replaceAll("\\", "/")
      ),
      code: await result.outputs[0]!.text(),
    };
    expect(companion.inputs, "the build did not walk the companion's own imports").toEqual(
      expect.arrayContaining(["server-roadmap.ts", "shared/roadmap-mcp.ts", "shared/peer-cache.ts"])
    );
    expect(
      companion.inputs.filter((input) => ["server.ts", "server-deck.ts", "broker.ts"].includes(input)),
      "a core entry point is in the companion's import graph: importing it would run its registration"
    ).toEqual([]);
    expect(companion.code, `${SERVER_ONLY_SYMBOL} is code of server.ts and must not be bundled into the companion`).not.toContain(
      SERVER_ONLY_SYMBOL
    );
  }, 60_000);

  test("the server-only symbol is still defined by server.ts, so its absence above means something", () => {
    const source = readFileSync(join(REPO, "server.ts"), "utf-8");
    expect(source).toContain(`function ${SERVER_ONLY_SYMBOL}(`);
  });
});

// Claude Code sends server/discover before initialize. A success reply moves the
// connection to the modern protocol era, where it drops channel notifications
// without an error, so the push of every peer message silently stops.
describe("MCP handshake: the channel stays on the legacy protocol era", () => {
  test("server/discover before initialize is refused with -32601 and initialize still advertises claude/channel", async () => {
    const h = await spawnServer(undefined);
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
    });
    const discover = await reachedWithin(readUntil(h.reader, 1, h.buffer), "server/discover reply", 10_000);
    expect(discover.result).toBeUndefined();
    expect(discover.error?.code).toBe(-32601);

    h.send(INITIALIZE_REQUEST(2));
    const init = await reachedWithin(readUntil(h.reader, 2, h.buffer), "initialize reply", 10_000);
    expect(init.result?.capabilities?.experimental?.["claude/channel"]).toEqual({});
  }, 60_000);
});
