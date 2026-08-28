// Card a2f61172: `role` is a PROPERTY OF THE LAUNCH, not persisted identity
// like peer_id/instance_token, per an operator-arbitrated design reversal
// (2026-08-24): the write-once semantics this file originally guarded were
// REMOVED. The rule is now the opposite -- on every /register, including a
// dormant-resume, the TRANSPORT's normalizeRole(body.role) value wins
// UNCONDITIONALLY, overwriting whatever was stored. An empty/absent transport
// role is a DECLARATION of absence (normalizes to NULL and is written as
// such), not "no information, keep the old value": the CLAUDE_PEERS_ROLE key
// is always emitted by the Deck (session-service.ts's sessionEnv, see
// tests/desktop-session-role-env.test.ts), so its absence in a body is itself
// meaningful.
//
// Same harness shape as broker-register-body.test.ts: real broker.ts + real
// server.ts children, real `peers` row read back from the broker's sqlite
// file. No mocking of the broker.
//
// History (for anyone diffing this file against an older revision): the
// first version of this file guarded the INVERSE rule (stored wins on
// dormant-resume) and its mutation pass (M1/M2/M5) proved that guard bit.
// That rule was deliberately reversed by the operator, not a regression --
// tests/role-domain-sweep.test.ts is the companion file for the NEW central
// guarantee ("no agent-reachable path may set/change a role"), which is a
// domain question this per-scenario file cannot answer.

import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { test, expect, afterAll } from "bun:test";
import { startBroker, stopBroker, type TestBroker } from "./_helper.ts";

interface JsonRpcResponse {
  id?: number;
  result?: { content?: Array<{ text?: string }>; isError?: boolean };
}

// Same shape as broker-register-body.test.ts's readUntil: line-delimited
// JSON-RPC over the child's stdout, matched by id.
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  wantedId: number,
  buffer: { text: string }
): Promise<JsonRpcResponse> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + 15_000;
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

const SERVER_PATH = resolve(import.meta.dir, "..", "server.ts");

const brokers: TestBroker[] = [];
const procs: ReturnType<typeof Bun.spawn>[] = [];
const tmpDirs: string[] = [];

afterAll(async () => {
  for (const p of procs) {
    try {
      p.kill();
      await p.exited;
    } catch {
      /* already gone */
    }
  }
  for (const b of brokers) await stopBroker(b);
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

interface PeerRoleRow {
  instance_token: string;
  peer_id: string;
  status: "active" | "dormant";
  pid: number;
  role: string | null;
}

// Spawns a real server.ts pointed at broker `b`, in `cwd`, with CLAUDE_PEERS_ROLE
// set to `role` (omitted entirely from env when `role` is undefined -- NOT set
// to the empty string, which is a different, already-normalized-elsewhere case).
function spawnServer(
  b: TestBroker,
  cwd: string,
  role: string | undefined,
  extraEnv: Record<string, string> = {}
): ReturnType<typeof Bun.spawn> {
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE_PEERS_"))
  ) as Record<string, string>;
  const env: Record<string, string> = {
    ...cleanEnv,
    CLAUDE_PEERS_BROKER_URL: b.url,
    CLAUDE_PEERS_PORT: String(b.port),
    ...extraEnv,
  };
  if (role !== undefined) env.CLAUDE_PEERS_ROLE = role;
  const proc = Bun.spawn(["bun", SERVER_PATH], {
    cwd,
    env,
    // stdin must stay an open pipe: an immediate EOF makes server.ts read it
    // as "Claude Code closed" and shut down right after registering, which
    // would flip the row dormant before the poll below observes it active
    // (broker-register-body.test.ts measured this the hard way). stdout is
    // piped too (unused by the DB-only tests, read by the whoami test below).
    stdio: ["pipe", "pipe", "ignore"],
  });
  procs.push(proc);
  return proc;
}

// `cwd` MUST be canonicalized (every caller below wraps its mkdtempSync in
// realpathSync) because this is the only place in tests/ that compares a path
// the test BUILT against a path an external process REPORTED: the row's `cwd`
// comes from server.ts's `myCwd = process.cwd()`, which resolves symlinks. On
// macOS `mkdtempSync(tmpdir())` yields `/var/folders/...` while the child
// reports `/private/var/folders/...`, so the equality below matched nothing and
// all seven tests died on this timeout (measured 2026-08-28, CI run
// 33170636054, macos job 98846649290). Linux CI cannot see it: its tmpdir is
// not symlinked.
async function pollForRow(
  db: Database,
  cwd: string,
  predicate: (row: PeerRoleRow) => boolean,
  timeoutMs = 10_000
): Promise<PeerRoleRow> {
  const deadline = Date.now() + timeoutMs;
  let last: PeerRoleRow | undefined;
  while (Date.now() < deadline) {
    last = db
      .query(
        "SELECT instance_token, peer_id, status, pid, role FROM peers WHERE cwd = ? AND status = 'active' ORDER BY registered_at DESC LIMIT 1"
      )
      .get(cwd) as PeerRoleRow | undefined;
    if (last && predicate(last)) return last;
    await Bun.sleep(100);
  }
  throw new Error(
    `timed out waiting for matching peers row (cwd=${cwd}); last seen: ${JSON.stringify(last)}`
  );
}

test(
  "fresh /register applies the CLAUDE_PEERS_ROLE body value (control for the transport-wins tests below)",
  async () => {
    const b = await startBroker();
    brokers.push(b);
    const sessionCwd = realpathSync(mkdtempSync(join(tmpdir(), "cp-register-role-fresh-")));
    tmpDirs.push(sessionCwd);

    spawnServer(b, sessionCwd, "lead");

    const db = new Database(b.dbPath);
    const row = await pollForRow(db, sessionCwd, () => true);
    db.close();

    expect(row.role).toBe("lead");
  },
  20_000
);

test(
  "dormant-resume /register with a DIFFERING non-empty body role OVERWRITES the stored role (transport wins, sense 1)",
  async () => {
    const b = await startBroker();
    brokers.push(b);
    const sessionCwd = realpathSync(mkdtempSync(join(tmpdir(), "cp-register-role-diff-")));
    tmpDirs.push(sessionCwd);

    const proc1 = spawnServer(b, sessionCwd, "lead");
    const db = new Database(b.dbPath);
    const first = await pollForRow(db, sessionCwd, () => true);
    expect(first.role).toBe("lead");

    // Kill the first process so the next /register on the same session_key
    // hits handleRegister's inline "pid is dead -> dormant -> resurrect"
    // path within a single call, not a background sweep race.
    proc1.kill();
    await proc1.exited;

    spawnServer(b, sessionCwd, "coder"); // different, non-empty body role
    const second = await pollForRow(
      db,
      sessionCwd,
      (row) => row.pid !== first.pid // wait for the NEW process's row, not the stale one
    );
    db.close();

    // Same instance_token proves this hit the dormant-RESUME branch, not a
    // fresh peer / active-collision branch (those would mint a new token).
    expect(second.instance_token).toBe(first.instance_token);
    expect(second.role).toBe("coder"); // transport wins, overwrites the stored "lead"
  },
  20_000
);

test(
  "dormant-resume /register with an EMPTY/absent body role CLEARS a non-empty stored role to NULL (transport wins, sense 2)",
  async () => {
    const b = await startBroker();
    brokers.push(b);
    const sessionCwd = realpathSync(mkdtempSync(join(tmpdir(), "cp-register-role-empty-")));
    tmpDirs.push(sessionCwd);

    const proc1 = spawnServer(b, sessionCwd, "lead");
    const db = new Database(b.dbPath);
    const first = await pollForRow(db, sessionCwd, () => true);
    expect(first.role).toBe("lead");

    proc1.kill();
    await proc1.exited;

    spawnServer(b, sessionCwd, undefined); // CLAUDE_PEERS_ROLE unset entirely
    const second = await pollForRow(
      db,
      sessionCwd,
      (row) => row.pid !== first.pid
    );
    db.close();

    expect(second.instance_token).toBe(first.instance_token);
    // The direction everyone forgets: absent transport is a DECLARATION of
    // absence and must clear a previously-stored role, not preserve it.
    expect(second.role).toBeNull();
  },
  20_000
);

test(
  "a MALFORMED CLAUDE_PEERS_ROLE (internal space, fails ROLE_REGEX after trim+lowercase) normalizes to NULL, and /register does NOT fail",
  async () => {
    const b = await startBroker();
    brokers.push(b);
    const sessionCwd = realpathSync(mkdtempSync(join(tmpdir(), "cp-register-role-malformed-")));
    tmpDirs.push(sessionCwd);

    // "team lead": trim() does nothing (no leading/trailing space), so this
    // is NOT caught by the "" == "" empty check -- it must be caught by
    // ROLE_REGEX itself, which rejects the internal space. Review finding
    // (2026-08-24): removing broker.ts:1385's `if (!ROLE_REGEX.test(...))`
    // line left every OTHER test in this suite green -- none of them ever
    // sent a value that is non-empty yet still regex-invalid.
    spawnServer(b, sessionCwd, "team lead");

    const db = new Database(b.dbPath);
    const row = await pollForRow(db, sessionCwd, () => true);
    db.close();

    expect(row.role).toBeNull();
    // The malformed value must not have taken /register down with it --
    // pollForRow already requires status = 'active' to resolve at all, so
    // reaching this line is itself part of the "did not fail" proof.
    expect(row.status).toBe("active");
  },
  20_000
);

test(
  "an EXPLICIT empty CLAUDE_PEERS_ROLE on a fresh registration normalizes to NULL, not ''",
  async () => {
    const b = await startBroker();
    brokers.push(b);
    const sessionCwd = realpathSync(mkdtempSync(join(tmpdir(), "cp-register-role-explicit-empty-")));
    tmpDirs.push(sessionCwd);

    spawnServer(b, sessionCwd, ""); // CLAUDE_PEERS_ROLE="" -- present but empty

    const db = new Database(b.dbPath);
    const row = await pollForRow(db, sessionCwd, () => true);
    db.close();

    expect(row.role).toBeNull();
  },
  20_000
);

test(
  "whoami's effective role after a dormant-resume with a DIFFERENT body role reports the NEW transport role, not the previously-stored one",
  async () => {
    const b = await startBroker();
    brokers.push(b);
    const sessionCwd = realpathSync(mkdtempSync(join(tmpdir(), "cp-register-role-whoami-")));
    tmpDirs.push(sessionCwd);

    const proc1 = spawnServer(b, sessionCwd, "lead");
    const db = new Database(b.dbPath);
    const first = await pollForRow(db, sessionCwd, () => true);
    expect(first.role).toBe("lead");

    proc1.kill();
    await proc1.exited;

    // Resurrect with a DIFFERENT body role -- the same mismatch as the
    // "sense 1" test above, but this time the assertion is on what whoami
    // (i.e. RegisterResponse.role, echoed by server.ts's myRole) reports to
    // the SESSION ITSELF, not just on the DB row. A response-layer bug could
    // in principle diverge from the DB layer (see the prior revision of this
    // file's M5 mutation, which proved exactly that split is independently
    // testable), so this stays its own test rather than folding into the
    // "sense 1" one above.
    const proc2 = spawnServer(b, sessionCwd, "coder");
    const second = await pollForRow(
      db,
      sessionCwd,
      (row) => row.pid !== first.pid
    );
    db.close();
    expect(second.instance_token).toBe(first.instance_token);
    expect(second.role).toBe("coder"); // DB-level guard (same as sense 1 above)

    const stdout = proc2.stdout.getReader();
    const rpcBuffer = { text: "" };
    const send = (msg: unknown): void => {
      proc2.stdin.write(JSON.stringify(msg) + "\n");
    };
    send({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: { roots: {}, elicitation: {} },
        clientInfo: { name: "test-harness", version: "0.0.1" },
      },
    });
    await readUntil(stdout, 0, rpcBuffer);

    send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } });
    const whoamiRes = await readUntil(stdout, 1, rpcBuffer);
    const whoamiJson = JSON.parse(whoamiRes.result?.content?.[0]?.text ?? "{}") as {
      role: string | null;
    };
    expect(whoamiJson.role).toBe("coder"); // NOT "lead": the response layer must not lag the DB layer
  },
  20_000
);

test(
  "switch_group's /register body ALSO carries the role (not just the boot site)",
  async () => {
    const b = await startBroker();
    brokers.push(b);
    const sessionCwd = realpathSync(mkdtempSync(join(tmpdir(), "cp-register-role-switchgroup-")));
    tmpDirs.push(sessionCwd);

    // A dedicated, isolated user config dir with a real named
    // group -- switch_group's request body ends up on a DIFFERENT session_key
    // (different group_id) than the boot registration, so unlike the dormant-
    // resume tests above, the resulting peers row is a FRESH insert whose
    // role comes straight from THIS call's own body -- write-once cannot mask
    // an omission here the way it does on a same-group switch_group("default").
    // NOT wrapped in realpathSync, unlike the seven sessionCwd above, and that
    // is deliberate: this path is never compared to anything -- it only serves
    // as the base of a join() and of a file read (server.ts reads
    // <base>/claude-peers/config.json), both of which traverse a symlink fine.
    const appDataDir = mkdtempSync(join(tmpdir(), "cp-register-role-appdata-"));
    tmpDirs.push(appDataDir);
    const cfgDir = join(appDataDir, "claude-peers");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, "config.json"),
      JSON.stringify({ groups: { other: "test-secret-for-role-switchgroup" } })
    );

    // BOTH keys, one directory: settingsFilePath() (shared/config.ts) reads
    // APPDATA only under process.platform === "win32" and XDG_CONFIG_HOME
    // otherwise, and both branches join the SAME subtree,
    // "claude-peers/config.json", onto their base -- so one temp dir serves the
    // three OSes. With APPDATA alone the file was never read off Windows,
    // config.groups was empty, and switch_group answered
    // "Group 'other' not in user config" with isError: true (measured
    // 2026-08-28, CI run 33170636054, ubuntu job 98846649135).
    const proc = spawnServer(b, sessionCwd, "lead", {
      APPDATA: appDataDir,
      XDG_CONFIG_HOME: appDataDir,
    });
    const db = new Database(b.dbPath);
    const first = await pollForRow(db, sessionCwd, () => true);
    expect(first.role).toBe("lead");

    const stdout = proc.stdout.getReader();
    const rpcBuffer = { text: "" };
    const send = (msg: unknown): void => {
      proc.stdin.write(JSON.stringify(msg) + "\n");
    };
    send({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: { roots: {}, elicitation: {} },
        clientInfo: { name: "test-harness", version: "0.0.1" },
      },
    });
    await readUntil(stdout, 0, rpcBuffer);

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "switch_group", arguments: { name: "other" } },
    });
    const switchRes = await readUntil(stdout, 1, rpcBuffer);
    expect(switchRes.result?.isError).not.toBe(true);

    // After switch_group, the OLD row is disconnected (dormant) and a NEW
    // active row exists for the SAME cwd in the new group -- pollForRow's
    // `status = 'active' AND cwd = ?` filter naturally lands on it once the
    // switch completes.
    const second = await pollForRow(
      db,
      sessionCwd,
      (row) => row.instance_token !== first.instance_token
    );
    db.close();

    expect(second.role).toBe("lead");
  },
  20_000
);
