import { afterAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  FIXTURE_OPERATOR_ID,
  groupId,
  mintRunCredential,
  openBrokerDb,
  scrubEnv,
  sha256Hex,
  startBroker,
  stopBroker,
  type TestBroker,
} from "./_helper.ts";
import { deriveInstanceRef } from "../shared/approval.ts";
import { readSessionIdentityFile, sessionIdentityFileName } from "../shared/peer-cache.ts";
import { OPERATOR_INSTANCE_TOKEN } from "../shared/types.ts";
import { reachedWithin } from "./_bounded-await.ts";
import { CONTEXT_RESUME_VERSION, DEPOSIT_CAPABILITY_ENV, depositCapabilityHashFromEnv, hashCapability } from "../shared/context-buffer.ts";

const SERVER_PATH = resolve(import.meta.dir, "..", "server.ts");

const brokers: TestBroker[] = [];
const procs: ReturnType<typeof Bun.spawn>[] = [];
const dirs: string[] = [];
const launched: Session[] = [];
const proxies: Array<ReturnType<typeof Bun.serve>> = [];

afterAll(async () => {
  for (const p of procs) {
    try {
      p.kill();
      await p.exited;
    } catch {
      /* already gone */
    }
  }
  for (const p of proxies) p.stop(true);
  for (const b of brokers) await stopBroker(b);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("the /register field is the sha256 of a well-formed capability, and absent otherwise", () => {
  const cap = randomBytes(32).toString("hex");
  expect(depositCapabilityHashFromEnv({ [DEPOSIT_CAPABILITY_ENV]: cap })).toBe(hashCapability(cap));
  expect(depositCapabilityHashFromEnv({ [DEPOSIT_CAPABILITY_ENV]: "" })).toBeUndefined();
  expect(depositCapabilityHashFromEnv({})).toBeUndefined();
  expect(depositCapabilityHashFromEnv({ [DEPOSIT_CAPABILITY_ENV]: cap.toUpperCase() })).toBeUndefined();
  expect(depositCapabilityHashFromEnv({ [DEPOSIT_CAPABILITY_ENV]: `${cap}0` })).toBeUndefined();
  const body = JSON.parse(JSON.stringify({ a: 1, deposit_capability_hash: depositCapabilityHashFromEnv({}) }));
  expect(Object.keys(body)).toEqual(["a"]);
});

interface Session {
  proc: ReturnType<typeof Bun.spawn>;
  stderr: { text: string };
  stdout: { text: string };
  settled: Promise<unknown>;
  send: (msg: unknown) => void;
  read: (id: number) => Promise<{ result?: { content?: Array<{ text?: string }>; isError?: boolean } }>;
}

async function launchServer(
  brokerUrl: string,
  settingsDir: string,
  capability: string,
  logDir: string,
  extraEnv: Record<string, string> = {}
): Promise<Session> {
  const proc = Bun.spawn(["bun", SERVER_PATH], {
    cwd: settingsDir,
    env: scrubEnv(settingsDir, {
      CLAUDE_PEERS_BROKER_URL: brokerUrl,
      CLAUDE_PEERS_DESK_SESSION: randomUUID(),
      CLAUDE_PEERS_LOG_DIR: logDir,
      [DEPOSIT_CAPABILITY_ENV]: capability,
      ...extraEnv,
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  procs.push(proc);
  const stderr = { text: "" };
  const stderrPump = (async () => {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      stderr.text += decoder.decode(value, { stream: true });
    }
  })();
  const [protocolStream, captureStream] = (proc.stdout as ReadableStream<Uint8Array>).tee();
  const stdout = { text: "" };
  const stdoutPump = (async () => {
    const capture = captureStream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await capture.read();
      if (done) return;
      stdout.text += decoder.decode(value, { stream: true });
    }
  })();
  const reader = protocolStream.getReader();
  const buffer = { text: "" };
  const send = (msg: unknown): void => {
    (proc.stdin as import("bun").FileSink).write(JSON.stringify(msg) + "\n");
  };
  const read = async (wantedId: number) => {
    const decoder = new TextDecoder();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      let idx: number;
      while ((idx = buffer.text.indexOf("\n")) >= 0) {
        const line = buffer.text.slice(0, idx).trim();
        buffer.text = buffer.text.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: number };
          if (msg.id === wantedId) return msg as { result?: { content?: Array<{ text?: string }>; isError?: boolean } };
        } catch {
          /* not a complete JSON line yet */
        }
      }
      const { value, done } = await reader.read();
      if (done) break;
      buffer.text += decoder.decode(value, { stream: true });
    }
    throw new Error(`no JSON-RPC response with id ${wantedId}`);
  };
  const session: Session = { proc, stderr, stdout, settled: Promise.all([stderrPump, stdoutPump]), send, read };
  launched.push(session);
  return session;
}

async function deposit(b: TestBroker, capability: string, text: string, replace?: string) {
  const res = await fetch(`${b.url}/context/deposit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deposit_capability: capability, text, head: null, branch: null, git_root: null, replace }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test(
  "both /register sites of server.ts carry the capability hash, never the raw value, and switch_group rebinds",
  async () => {
    const b = await startBroker();
    brokers.push(b);
    const registerBodies: Array<Record<string, unknown>> = [];
    const wire: string[] = [];
    const proxy = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = req.method === "POST" ? await req.text() : undefined;
        if (body !== undefined) {
          wire.push(body);
          if (url.pathname === "/register") registerBodies.push(JSON.parse(body) as Record<string, unknown>);
        }
        return fetch(`${b.url}${url.pathname}${url.search}`, {
          method: req.method,
          headers: { "content-type": "application/json" },
          body,
        });
      },
    });
    proxies.push(proxy);

    const settingsDir = mkdtempSync(join(tmpdir(), "cp-deposit-cap-"));
    dirs.push(settingsDir);
    mkdirSync(join(settingsDir, "claude-peers"), { recursive: true });
    writeFileSync(
      join(settingsDir, "claude-peers", "config.json"),
      JSON.stringify({ groups: { alpha: randomUUID(), beta: randomUUID() }, default_group: "alpha" })
    );
    const logDir = join(settingsDir, "logs");
    const cap = randomBytes(32).toString("hex");
    const session = await launchServer(`http://127.0.0.1:${proxy.port}`, settingsDir, cap, logDir, { CLAUDE_PEERS_DESK_SESSION: "" });
    session.send({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: { roots: {}, elicitation: {} },
        clientInfo: { name: "test-harness", version: "0.0.1" },
      },
    });
    await session.read(0);

    const deadline = Date.now() + 10_000;
    let booted = await deposit(b, cap, "after boot");
    while (booted.status !== 200 && Date.now() < deadline) {
      await Bun.sleep(100);
      booted = await deposit(b, cap, "after boot");
    }
    expect(booted.status).toBe(200);

    session.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "switch_group", arguments: { name: "beta" } } });
    const switched = await session.read(1);
    expect(switched.result?.isError ?? false).toBe(false);

    const afterSwitch = await deposit(b, cap, "after switch");
    expect(afterSwitch.status).toBe(200);
    expect((afterSwitch.body.held as unknown[]).length).toBe(1);
    expect((await deposit(b, cap, "t", booted.body.deposit_id as string)).status).toBe(404);

    expect(registerBodies).toHaveLength(2);
    for (const body of registerBodies) expect(body.deposit_capability_hash).toBe(hashCapability(cap));
    for (const body of registerBodies) expect(body.context_resume_version).toBe(CONTEXT_RESUME_VERSION);
    const [boot, sw] = registerBodies.map((body) => new Set(Object.keys(body)));
    const onlyOne = [...boot!].filter((k) => !sw!.has(k)).concat([...sw!].filter((k) => !boot!.has(k)));
    expect(onlyOne.sort()).toEqual(["claude_cli_pid"]);
    expect(wire.length).toBeGreaterThanOrEqual(2);
    expect(wire.filter((w) => w.includes(cap))).toEqual([]);

    session.proc.kill();
    await session.proc.exited;
    const logs =
      session.stderr.text +
      (existsSync(logDir) ? readdirSync(logDir).map((f) => readFileSync(join(logDir, f), "utf8")).join("\n") : "");
    expect([cap, hashCapability(cap)].filter((s) => logs.includes(s))).toEqual([]);
  },
  40_000
);

test(
  "a Kory session stops after a signed register response without its Inbox binding acknowledgement",
  async () => {
    const b = await startBroker();
    brokers.push(b);
    const seen: Array<Record<string, unknown>> = [];
    const proxy = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = req.method === "POST" ? await req.text() : undefined;
        if (url.pathname === "/register" && body) seen.push(JSON.parse(body) as Record<string, unknown>);
        const forwarded = await fetch(`${b.url}${url.pathname}${url.search}`, {
          method: req.method,
          headers: { "content-type": "application/json" },
          body,
        });
        if (url.pathname !== "/register") return forwarded;
        const reply = await forwarded.json() as Record<string, unknown>;
        delete reply.inbox_binding;
        return Response.json(reply, { status: forwarded.status });
      },
    });
    proxies.push(proxy);

    const settingsDir = mkdtempSync(join(tmpdir(), "cp-run-missing-ack-"));
    dirs.push(settingsDir);
    mkdirSync(join(settingsDir, "claude-peers"), { recursive: true });
    const groupSecret = randomUUID();
    writeFileSync(join(settingsDir, "claude-peers", "config.json"), JSON.stringify({ groups: { alpha: groupSecret }, default_group: "alpha" }));
    const run = await mintRunCredential(b, { id: await groupId(groupSecret), hash: await sha256Hex(groupSecret) });
    const credFile = join(settingsDir, "run-credential.json");
    writeFileSync(credFile, JSON.stringify({
      brokerUrl: `http://127.0.0.1:${proxy.port}`,
      operatorId: FIXTURE_OPERATOR_ID,
      tokenId: run.tokenId,
      sessionRef: `window-${run.run}`,
      privateKey: run.cred.privateKey,
      publicKey: run.cred.publicKey,
      osUserHash: "hash",
      inbox: { version: 1, run_ref: run.run, group_id: run.group },
    }));
    const deskSession = randomUUID();
    const session = await launchServer(
      `http://127.0.0.1:${proxy.port}`,
      settingsDir,
      "",
      join(settingsDir, "logs"),
      { CLAUDE_PEERS_APPROVAL_FILE: credFile, CLAUDE_PEERS_DESK_SESSION: deskSession },
    );

    await reachedWithin(session.proc.exited, "the session stops when the broker omits the Inbox binding acknowledgement");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.auth).toBeDefined();
    expect(await readSessionIdentityFile(deskSession, settingsDir)).toBeNull();
    expect(session.stderr.text).toContain("Inbox registration was not confirmed");
  },
  30_000,
);

test(
  "a Deck session registers and deposits with its run credential, resumes its own instance by proof, and cannot leave the run's group",
  async () => {
    const b = await startBroker();
    brokers.push(b);
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    let onMissingCredentialRegister: (() => void) | null = null;
    const faults = new Map<string, "refuse" | "lose">();
    const afterForward = new Map<string, () => void>();
    const proxy = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = req.method === "POST" ? await req.text() : undefined;
        if (body !== undefined) {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          requests.push({ path: url.pathname, body: parsed });
          if (url.pathname === "/register") onMissingCredentialRegister?.();
        }
        const fault = faults.get(url.pathname);
        faults.delete(url.pathname);
        if (fault === "refuse") return new Response("injected refusal", { status: 503 });
        const forwarded = await fetch(`${b.url}${url.pathname}${url.search}`, {
          method: req.method,
          headers: { "content-type": "application/json" },
          body,
        });
        const hook = afterForward.get(url.pathname);
        afterForward.delete(url.pathname);
        hook?.();
        if (fault === "lose") return new Response("answer lost", { status: 502 });
        return forwarded;
      },
    });
    proxies.push(proxy);

    const settingsDir = mkdtempSync(join(tmpdir(), "cp-run-attest-"));
    dirs.push(settingsDir);
    mkdirSync(join(settingsDir, "claude-peers"), { recursive: true });
    const alpha = randomUUID();
    writeFileSync(
      join(settingsDir, "claude-peers", "config.json"),
      JSON.stringify({ groups: { alpha, beta: randomUUID() }, default_group: "alpha" })
    );
    const run = await mintRunCredential(b, { id: await groupId(alpha), hash: await sha256Hex(alpha) });
    const credFile = join(settingsDir, "run-credential.json");
    writeFileSync(
      credFile,
      JSON.stringify({
        brokerUrl: `http://127.0.0.1:${proxy.port}`,
        operatorId: FIXTURE_OPERATOR_ID,
        tokenId: run.tokenId,
        sessionRef: `window-${run.run}`,
        privateKey: run.cred.privateKey,
        publicKey: run.cred.publicKey,
        osUserHash: "hash",
        inbox: { version: 1, run_ref: run.run, group_id: run.group },
      }),
      { mode: 0o600 }
    );
    const deskSession = randomUUID();
    const logDir = join(settingsDir, "logs");
    const env = { CLAUDE_PEERS_APPROVAL_FILE: credFile, CLAUDE_PEERS_DESK_SESSION: deskSession };
    const brokerUrl = `http://127.0.0.1:${proxy.port}`;
    const initialize = async (s: Session) => {
      s.send({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test-harness", version: "0.0.1" } },
      });
      await s.read(0);
    };
    const registers = () => requests.filter((r) => r.path === "/register");
    const until = async (cond: () => boolean, what: string) => {
      const deadline = Date.now() + 10_000;
      while (!cond() && Date.now() < deadline) await Bun.sleep(50);
      expect(cond(), what).toBe(true);
    };
    const identity = async () => readSessionIdentityFile(deskSession, settingsDir);
    const peerStatus = (token: string): string | null => {
      const db = openBrokerDb(b.dbPath, { readonly: true });
      try {
        return (db.query("SELECT status FROM peers WHERE instance_token = ?").get(token) as { status: string } | null)?.status ?? null;
      } finally {
        db.close();
      }
    };

    const first = await launchServer(brokerUrl, settingsDir, "", logDir, env);
    await initialize(first);
    await until(() => registers().length === 1, "the boot /register reaches the broker");
    const boot = registers()[0]!.body;
    expect(boot.inbox_operation).toBe("register");
    expect((boot.auth as { v?: number }).v, "a v1 proof of the run credential").toBe(1);
    expect("resume_instance_token" in boot, "no previous identity file, no resume").toBe(false);
    let firstIdentity = await identity();
    for (let i = 0; i < 100 && !firstIdentity; i++) {
      await Bun.sleep(50);
      firstIdentity = await identity();
    }
    const firstToken = firstIdentity!.instanceToken;

    first.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: { to_peer_id: "operator", message: "attested note" } } });
    expect((await first.read(1)).result?.isError ?? false).toBe(false);
    const deposit = requests.find((r) => r.path === "/send-message")!;
    expect((deposit.body.auth as { v?: number }).v, "the operator deposit is signed").toBe(1);
    const db = openBrokerDb(b.dbPath, { readonly: true });
    const stored = db
      .query("SELECT author_instance_ref, inbox_run_ref FROM messages WHERE to_token = ? AND text = ?")
      .get(OPERATOR_INSTANCE_TOKEN, "attested note") as { author_instance_ref: string; inbox_run_ref: string } | null;
    db.close();
    expect(stored).toEqual({ author_instance_ref: deriveInstanceRef(firstToken), inbox_run_ref: run.run });

    const disconnectsBefore = requests.filter((r) => r.path === "/disconnect").length;
    first.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "switch_group", arguments: { name: "beta" } } });
    const refused = await first.read(2);
    expect(refused.result?.isError).toBe(true);
    expect(refused.result?.content?.[0]?.text ?? "").toContain("run credential covers only the Deck's group");
    expect(requests.filter((r) => r.path === "/disconnect").length, "the refusal is judged before /disconnect").toBe(disconnectsBefore);
    expect(peerStatus(firstToken), "the peer stays connected").toBe("active");

    faults.set("/disconnect", "refuse");
    first.send({ jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "switch_group", arguments: { name: "alpha" } } });
    expect((await first.read(30)).result?.isError).toBe(true);
    expect((await identity())?.inboxBinding, "a failed disconnect restores the readiness snapshot").not.toBeNull();
    const depositsBeforeDisconnectFailure = requests.filter((r) => r.path === "/send-message").length;
    first.send({ jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "send_message", arguments: { to_peer_id: "operator", message: "after disconnect failure" } } });
    expect((await first.read(31)).result?.isError ?? false).toBe(false);
    expect(requests.filter((r) => r.path === "/send-message").length).toBe(depositsBeforeDisconnectFailure + 1);

    const vanished = `${credFile}.vanished`;
    let snapshotPresentAfterDisconnect: boolean | null = null;
    afterForward.set("/disconnect", () => {
      snapshotPresentAfterDisconnect = existsSync(join(settingsDir, ".claude", "peers", sessionIdentityFileName(deskSession)));
      renameSync(credFile, vanished);
    });
    first.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "switch_group", arguments: { name: "alpha" } } });
    expect((await first.read(3)).result?.isError ?? false).toBe(false);
    await until(() => registers().length === 2, "the switch_group /register reaches the broker");
    expect(snapshotPresentAfterDisconnect, "the ready snapshot is gone before /disconnect returns").toBe(false);
    expect(existsSync(credFile), "the credential was gone while the session re-registered").toBe(false);
    renameSync(vanished, credFile);
    expect((registers()[1]!.body.auth as { v?: number } | undefined)?.v, "the switch_group site signs its body, without reading the file again").toBe(1);
    expect(registers()[1]!.body.resume_instance_token, "and proves the instance it leaves").toBe(firstToken);
    const liveToken = (await identity())!.instanceToken;
    expect(liveToken, "a switch within the run's group keeps the instance").toBe(firstToken);

    for (const fault of ["refuse", "lose"] as const) {
      const switchDesk = randomUUID();
      const switching = await launchServer(brokerUrl, settingsDir, "", logDir, { ...env, CLAUDE_PEERS_DESK_SESSION: switchDesk });
      await initialize(switching);
      await until(() => registers().some((r) => r.body.desk_session === switchDesk), `${fault}: boot /register reaches the broker`);
      expect(await readSessionIdentityFile(switchDesk, settingsDir), `${fault}: boot snapshot is ready`).not.toBeNull();

      faults.set("/register", fault);
      switching.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "switch_group", arguments: { name: "alpha" } } });
      expect((await switching.read(1)).result?.isError, `${fault}: re-register fails after /disconnect`).toBe(true);
      expect(await readSessionIdentityFile(switchDesk, settingsDir), `${fault}: no ready snapshot remains between disconnect and a new acknowledgement`).toBeNull();

      const depositsBeforeFailedSwitch = requests.filter((r) => r.path === "/send-message").length;
      switching.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "send_message", arguments: { to_peer_id: "operator", message: `after-${fault}` } } });
      const refusedAfterSwitch = await switching.read(2);
      expect(refusedAfterSwitch.result?.isError, `${fault}: the stale tuple is refused locally`).toBe(true);
      expect(requests.filter((r) => r.path === "/send-message").length, `${fault}: no deposit follows a failed switch`).toBe(depositsBeforeFailedSwitch);
      faults.delete("/register");
      switching.proc.kill();
      await switching.proc.exited;
    }

    const parked = `${credFile}.parked`;
    renameSync(credFile, parked);
    const disconnectsBeforeSameGroup = requests.filter((r) => r.path === "/disconnect").length;
    first.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "switch_group", arguments: { name: "alpha" } } });
    const sameGroupRefused = await first.read(4);
    expect(sameGroupRefused.result?.isError, "an unreadable credential refuses even the same group").toBe(true);
    expect(requests.filter((r) => r.path === "/disconnect").length).toBe(disconnectsBeforeSameGroup);
    expect(peerStatus(liveToken)).toBe("active");
    renameSync(parked, credFile);

    faults.set("/send-message", "refuse");
    first.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "send_message", arguments: { to_peer_id: "operator", message: "refused note" } } });
    expect((await first.read(5)).result?.isError).toBe(true);
    await until(() => first.stderr.text.includes("send_message failed"), "the failed signed deposit is logged");
    const refusedDeposit = requests.filter((r) => r.path === "/send-message").at(-1)!;
    expect(first.stderr.text.includes((refusedDeposit.body.auth as { sig: string }).sig), "no signed body in the log").toBe(false);

    first.proc.kill("SIGKILL");
    await first.proc.exited;
    const second = await launchServer(brokerUrl, settingsDir, "", logDir, env);
    await initialize(second);
    const mainRegisters = () => registers().filter((r) => r.body.desk_session === deskSession);
    await until(() => mainRegisters().length === 3, "the second boot /register reaches the broker");
    expect(mainRegisters().at(-1)!.body.resume_instance_token, "the previous token travels inside the signed body").toBe(liveToken);
    let resumed = await identity();
    for (let i = 0; i < 100 && resumed?.instanceToken !== liveToken; i++) {
      await Bun.sleep(50);
      resumed = await identity();
    }
    expect(resumed?.instanceToken, "the same instance is resumed").toBe(liveToken);

    const missingCredentialDesk = randomUUID();
    let sawMissingCredentialRegister!: () => void;
    const missingCredentialRegister = new Promise<"register">((resolve) => {
      sawMissingCredentialRegister = () => resolve("register");
    });
    onMissingCredentialRegister = sawMissingCredentialRegister;
    const missingCredential = await launchServer(brokerUrl, settingsDir, "", logDir, {
      CLAUDE_PEERS_DESK_SESSION: missingCredentialDesk,
      CLAUDE_PEERS_APPROVAL_FILE: "",
    });
    const missingCredentialOutcome = await reachedWithin(
      Promise.race([missingCredential.proc.exited.then(() => "exit" as const), missingCredentialRegister]),
      "a Deck session without its credential exits or reaches the register proxy",
    );
    expect(missingCredentialOutcome).toBe("exit");
    expect(registers().filter((r) => r.body.desk_session === missingCredentialDesk)).toEqual([]);
    onMissingCredentialRegister = null;

    const bareDir = mkdtempSync(join(tmpdir(), "cp-run-bare-"));
    dirs.push(bareDir);
    mkdirSync(join(bareDir, "claude-peers"), { recursive: true });
    writeFileSync(join(bareDir, "claude-peers", "config.json"), JSON.stringify({ groups: { alpha }, default_group: "alpha" }));
    const bare = await launchServer(brokerUrl, bareDir, "", join(bareDir, "logs"), { CLAUDE_PEERS_DESK_SESSION: "" });
    await initialize(bare);
    await until(() => registers().some((r) => r.body.desk_session === ""), "the bare /register reaches the broker");
    const sendsBefore = requests.filter((r) => r.path === "/send-message").length;
    bare.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: { to_peer_id: "operator", message: "bare note" } } });
    const bareRefused = await bare.read(1);
    expect(bareRefused.result?.isError).toBe(true);
    expect(bareRefused.result?.content?.[0]?.text ?? "").toContain("run credential is unavailable");
    expect(requests.filter((r) => r.path === "/send-message").length, "nothing reaches the broker").toBe(sendsBefore);

    const peerRows = (): number => {
      const rdb = openBrokerDb(b.dbPath, { readonly: true });
      try {
        return (rdb.query("SELECT COUNT(*) AS n FROM peers").get() as { n: number }).n;
      } finally {
        rdb.close();
      }
    };
    for (const fault of ["refuse", "lose"] as const) {
      const faultDesk = randomUUID();
      const before = peerRows();
      faults.set("/register", fault);
      const faulty = await launchServer(brokerUrl, settingsDir, "", logDir, { ...env, CLAUDE_PEERS_DESK_SESSION: faultDesk });
      await reachedWithin(faulty.proc.exited, `the session stops after a signed register it could not complete (${fault})`);
      const sent = registers().filter((r) => r.body.desk_session === faultDesk);
      expect(sent.map((r) => r.body.auth !== undefined), `${fault}: one signed register, no bare retry`).toEqual([true]);
      expect(peerRows() - before, `${fault}: no second identity`).toBe(fault === "lose" ? 1 : 0);
    }

    second.proc.kill();
    await second.proc.exited;
    bare.proc.kill();
    await bare.proc.exited;
    const logs =
      first.stderr.text +
      second.stderr.text +
      (existsSync(logDir) ? readdirSync(logDir).map((f) => readFileSync(join(logDir, f), "utf8")).join("\n") : "");
    expect([firstToken, liveToken].filter((t) => logs.includes(t)), "an instance token is never logged").toEqual([]);

    await reachedWithin(Promise.all(launched.map((s) => s.settled)), "every launched session's stdout and stderr pipes are drained");
    const canaries = [...new Set([firstToken, liveToken])];
    expect(
      requests.some((r) => r.body.resume_instance_token === liveToken),
      "positive control: the old token is a live canary, it travels in a signed resume body"
    ).toBe(true);
    expect(first.stdout.text, "positive control: stdout capture holds the tool responses").toContain('"jsonrpc"');
    expect(second.stderr.text.length, "positive control: the resumed session wrote to stderr").toBeGreaterThan(0);
    const logFiles = existsSync(logDir) ? readdirSync(logDir).map((f) => ({ sink: `log file ${f}`, text: readFileSync(join(logDir, f), "utf8") })) : [];
    expect(logFiles.length > 0 && logFiles.every((f) => f.text.length > 0), "positive control: the rolling log holds lines").toBe(true);
    const sinks = [
      ...launched.flatMap((s, i) => [
        { sink: `session ${i} stderr`, text: s.stderr.text },
        { sink: `session ${i} stdout`, text: s.stdout.text },
      ]),
      ...logFiles,
    ];
    const leaks = sinks.filter(({ text }) => canaries.some((c) => text.includes(c))).map(({ sink }) => sink);
    expect(leaks, "the previous instance token reaches no stdout, stderr or log file").toEqual([]);
  },
  60_000
);
