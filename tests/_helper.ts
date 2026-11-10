import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import {
  buildAuthProof,
  buildInboxProof,
  deriveOperatorId,
  generateCredential,
  INBOX_GATES,
  type ApprovalCredential,
  type ApprovalAuthProof,
  type InboxGate,
} from "../shared/approval.ts";
import { operatorTrustFilePath } from "../shared/config.ts";
import { OPERATOR_TRUST_VERSION } from "../shared/operator-trust.ts";
import { reachedWithin } from "./_bounded-await.ts";
export { scrubEnv } from "./_scrub-env.ts";
import { scrubEnv } from "./_scrub-env.ts";

export interface TestBroker {
  url: string;
  wsUrl: string;
  port: number;
  proc: ReturnType<typeof Bun.spawn>;
  dbPath: string;
  tmpDir: string;
  /** The exact env this broker's process was spawned with (not reconstructed). */
  env: Record<string, string>;
}

// Ask the OS for a free ephemeral port instead of guessing inside a fixed
// window (17900 + random(5000)). The old scheme let two concurrent test
// runs draw the same port, so one run's broker answered health checks meant
// for the other's -- the settle/liveness check below caught it, but only
// after burning the SETTLE_MS budget on a doomed attempt. Binding with
// port 0 lets the kernel hand out a currently-unused port; closing
// immediately frees it for the broker we are about to spawn. A TOCTOU gap
// remains between that close and the broker's own bind (another process
// could grab the exact same port in between), but it is now the rare case
// instead of the common one, and is still covered by the settle/liveness
// check as a safety net.
async function reserveEphemeralPort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
  const port = probe.port;
  probe.stop(true);
  return port;
}

export interface StartBrokerOptions {
  /**
   * argv to spawn in place of `bun broker.ts`; it must serve /health on CLAUDE_PEERS_PORT and, once
   * bound, append `listening on <host>:<port>` to broker.log in CLAUDE_PEERS_LOG_DIR.
   */
  command?: string[];
  /** Wall-clock budget shared by every attempt. */
  budgetMs?: number;
  /** Port of the first attempt, in place of the one the OS hands out; later attempts reserve a fresh one. */
  port?: number;
  /** null leaves the policy absent; [] writes a valid policy with no trusted operators. */
  trustedOperators?: readonly string[] | null;
}

function provisionTestOperatorTrust(tmpDir: string, trustedOperators: readonly string[] | null | undefined): void {
  if (trustedOperators === null) return;
  const policyPath = operatorTrustFilePath(join(tmpDir, "claude-peers", "config.json"));
  mkdirSync(dirname(policyPath), { recursive: true });
  const publicKeys = trustedOperators ?? [FIXTURE_OPERATOR.publicKey];
  writeFileSync(
    policyPath,
    JSON.stringify({
      version: OPERATOR_TRUST_VERSION,
      operators: publicKeys.map((public_key) => ({ public_key })),
    }),
    { mode: 0o600 }
  );
}

// Shared by every attempt and kept under the integration step's 30 s
// `--timeout`, so a broker that never comes up fails this helper with its
// diagnostic instead of being killed by bun's timeout with none.
const BOOT_BUDGET_MS = 20_000;
const STDERR_TAIL_CHARS = 2000;

async function readTail(path: string, chars: number): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) return "<absent>";
  const text = await file.text();
  return text.length > 0 ? text.slice(-chars) : "<empty>";
}

const BROKER_LOG_NAME = "broker.log";

// Only the process that owns the bind writes this line (broker.ts, right after
// Bun.serve), so seeing it in THIS attempt's log, for THIS attempt's port, is
// what ties a 200 on /health to the process we spawned. `fromByte` skips what
// an earlier attempt left in the same file.
export function ownListeningLine(logPath: string, fromByte: number, port: number): boolean {
  if (!existsSync(logPath)) return false;
  const fresh = readFileSync(logPath).subarray(fromByte).toString("utf8");
  return new RegExp(`listening on \\S+:${port}\\b`).test(fresh);
}

// The first timestamped line says when a broker first executed at all, the
// last one how far its boot got.
async function readLogEnds(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) return "<absent>";
  const lines = (await file.text()).split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return "<empty>";
  return `first: ${lines[0]} | last: ${lines[lines.length - 1]}`;
}

export async function startBroker(
  envOverrides: Record<string, string> = {},
  options: StartBrokerOptions = {}
): Promise<TestBroker> {
  const tmpDir = mkdtempSync(join(tmpdir(), "cp-test-"));
  provisionTestOperatorTrust(tmpDir, options.trustedOperators);
  const dbPath = join(tmpDir, "peers.db");
  const command = options.command ?? ["bun", "broker.ts"];
  const deadline = Date.now() + (options.budgetMs ?? BOOT_BUDGET_MS);
  const failures: string[] = [];

  // A retry only follows a process that EXITED (lost the TOCTOU port race,
  // crashed at boot). A live broker that has not answered yet is still
  // booting: killing it to try another port throws that boot away, which is
  // how a slow runner turned into three killed brokers in a row.
  for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt++) {
    const port = attempt === 0 && options.port !== undefined ? options.port : await reserveEphemeralPort();
    const env = scrubEnv(tmpDir, {
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: dbPath,
      // Keep the rolling log inside the test sandbox (cleaned with it).
      CLAUDE_PEERS_LOG_DIR: join(tmpDir, "logs"),
      CLAUDE_PEERS_DORMANT_TTL_HOURS: "24",
      ...envOverrides,
    });
    // A file, never an unread pipe: a pipe nobody drains can block the child.
    const stderrPath = join(tmpDir, `broker-stderr-${attempt}.log`);
    const logPath = join(env.CLAUDE_PEERS_LOG_DIR ?? join(tmpDir, "logs"), BROKER_LOG_NAME);
    const logOffset = existsSync(logPath) ? statSync(logPath).size : 0;
    const proc = Bun.spawn(command, {
      env,
      stdio: ["ignore", "ignore", Bun.file(stderrPath)],
    });

    // A 200 on /health only proves that SOMEBODY listens on this port. When
    // two callers are handed the same port, the neighbour answers while ours
    // is still failing to bind: a booting broker stays alive ~600 ms before it
    // dies on EADDRINUSE, longer than any settle window. Readiness therefore
    // also requires our own `listening on` line for this port, which only the
    // process that owns the bind can have written. SETTLE_MS keeps the boot
    // time callers have always seen. A dead process breaks out at once so the
    // `attempt` loop moves on to the next port.
    const SETTLE_MS = 250;
    const spawnedAt = Date.now();
    let ready = false;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null || proc.signalCode !== null) break;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(500),
        });
        if (
          res.ok &&
          Date.now() - spawnedAt >= SETTLE_MS &&
          proc.exitCode === null &&
          ownListeningLine(logPath, logOffset, port)
        ) {
          ready = true;
          break;
        }
      } catch { /* retry */ }
      await Bun.sleep(50);
    }
    if (ready) {
      return {
        url: `http://127.0.0.1:${port}`,
        wsUrl: `ws://127.0.0.1:${port}/ws`,
        port,
        proc,
        dbPath,
        tmpDir,
        env,
      };
    }
    const exitedOnItsOwn = proc.exitCode !== null || proc.signalCode !== null;
    try { proc.kill(); await proc.exited; } catch { /* */ }
    failures.push(
      `attempt ${attempt} port ${port}: ${exitedOnItsOwn ? "exited" : "alive but silent, killed at the budget"}` +
        ` exitCode=${proc.exitCode} signalCode=${proc.signalCode} after ${Date.now() - spawnedAt}ms` +
        `\n  own 'listening on' line for port ${port}: ${ownListeningLine(logPath, logOffset, port) ? "seen" : "absent"}` +
        `\n  broker.log (shared by all attempts) ${await readLogEnds(logPath)}` +
        `\n  stderr tail: ${await readTail(stderrPath, STDERR_TAIL_CHARS)}`
    );
    if (!exitedOnItsOwn) break;
  }
  rmSync(tmpDir, { recursive: true, force: true });
  throw new Error(
    `could not start broker on any port (${command.join(" ")}, ${failures.length} attempt(s)):\n${failures.join("\n")}`
  );
}

/**
 * Upper bound a test connection waits for the broker's writer lock. bun:sqlite
 * opens with no busy handler, so a second connection on a running broker's WAL
 * database fails at once with "database is locked" whenever the broker is mid
 * write.
 */
export const BROKER_DB_BUSY_TIMEOUT_MS = 5000;

/** The only way a test opens the database file of a broker that may be running. */
export function openBrokerDb(dbPath: string, options: { readonly?: boolean } = {}): Database {
  const db = options.readonly ? new Database(dbPath, { readonly: true }) : new Database(dbPath);
  db.run(`PRAGMA busy_timeout = ${BROKER_DB_BUSY_TIMEOUT_MS}`);
  return db;
}

export async function stopBroker(b: TestBroker): Promise<void> {
  try {
    b.proc.kill();
    await b.proc.exited;
  } catch { /* */ }
  // Best-effort cleanup; on Windows the SQLite file lingers a bit.
  for (let i = 0; i < 10; i++) {
    try { rmSync(b.tmpDir, { recursive: true, force: true }); break; } catch { await Bun.sleep(50); }
  }
}

export async function post<T = unknown>(
  url: string,
  body: unknown
): Promise<{ status: number; body: T }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json()) as T;
  return { status: res.status, body: parsed };
}

export async function get<T = unknown>(url: string): Promise<{ status: number; body: T }> {
  const res = await fetch(url);
  const parsed = (await res.json()) as T;
  return { status: res.status, body: parsed };
}

/**
 * Find this Bun process's PID as seen by the broker -- used as a "guaranteed live"
 * pid in registration payloads. The broker checks `process.kill(pid, 0)` to detect
 * dead processes, so we need a pid the broker *can* signal.
 *
 * The current Bun test runner is a sibling process to the broker and can be
 * signalled, so process.pid works here.
 */
export function livePid(): number {
  return process.pid;
}

/**
 * sha256 hex helper for test fixtures (mimics the client's group_secret_hash).
 */
export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function groupId(secret: string): Promise<string> {
  return (await sha256Hex(secret)).slice(0, 32);
}

/**
 * by: 'deck' names the human operator and requires an Ed25519 proof; tests that
 * need only some author should pass a plain name instead (unproven, accepted).
 * One credential per test process: operator_id is the digest of the public key,
 * so every fixture in a run speaks as the same operator.
 */
export const FIXTURE_OPERATOR = generateCredential();

/**
 * The operator_id digest `deckAuthored` writes stamp on a card (card
 * edefff05). Exported so tests can assert the exact value a signed write
 * persisted, not just that some truthy string landed.
 */
export const FIXTURE_OPERATOR_ID = deriveOperatorId(FIXTURE_OPERATOR.publicKey);

/**
 * Body fragment for a `/approval/list` request (card 4df14b5b: project_key
 * is now mandatory broker-side, or the request is refused with a 400).
 * Centralised so a future mandatory field on this endpoint is one edit
 * across five test files, not sixteen hand-copied call sites (the exact
 * debt card 230ffb02 already documents on this repo).
 */
export function approvalListBody(
  projectKey: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { project_key: projectKey, ...extra };
}

export function deckAuthored(payload: Record<string, unknown>): Record<string, unknown> {
  const body = { ...payload, by: "deck", public_key: FIXTURE_OPERATOR.publicKey };
  return {
    ...body,
    auth: buildAuthProof(FIXTURE_OPERATOR.privateKey, body, {
      kind: "operator",
      operator_id: deriveOperatorId(FIXTURE_OPERATOR.publicKey),
    }),
  };
}

export const INBOX_TEST_PROJECT = "github.com/vocsap/koryphaios";

export interface RunCredential {
  cred: ApprovalCredential;
  tokenId: string;
  run: string;
  group: string;
  secretHash: string;
}

export function operatorInboxProof(body: Record<string, unknown>, gate: InboxGate): ApprovalAuthProof {
  return buildInboxProof(FIXTURE_OPERATOR.privateKey, body, gate, { kind: "operator", operator_id: FIXTURE_OPERATOR_ID });
}

export function runInboxProof(run: RunCredential, body: Record<string, unknown>, gate: InboxGate): ApprovalAuthProof {
  return buildInboxProof(run.cred.privateKey, body, gate, {
    kind: "session",
    operator_id: FIXTURE_OPERATOR_ID,
    token_id: run.tokenId,
  });
}

export type PostFn = <T = unknown>(url: string, body: unknown) => Promise<{ status: number; body: T }>;

export async function mintRunCredential(
  b: TestBroker,
  group: { id: string; hash: string },
  project: string = INBOX_TEST_PROJECT,
  send: PostFn = post
): Promise<RunCredential> {
  const cred = generateCredential();
  const run = crypto.randomUUID();
  const body = {
    session_public_key: cred.publicKey,
    session_ref: `window-${run}`,
    project_key: project,
    inbox: { version: 1, kind: "run", run_ref: run, group_id: group.id },
    public_key: FIXTURE_OPERATOR.publicKey,
  };
  const res = await send<{ token_id: string }>(`${b.url}/approval/token-mint`, {
    ...body,
    auth: operatorInboxProof(body, INBOX_GATES.mint),
  });
  if (res.status !== 200) throw new Error(`run credential mint refused: ${res.status} ${JSON.stringify(res.body)}`);
  return { cred, tokenId: res.body.token_id, run, group: group.id, secretHash: group.hash };
}

export function registerAttestedInstance(
  b: TestBroker,
  run: RunCredential,
  host: string,
  cwd: string,
  extras: Record<string, unknown> = {},
  send: PostFn = post
) {
  const body = {
    pid: livePid(),
    cwd,
    git_root: null,
    tty: null,
    summary: "",
    host,
    client_pid: 1,
    project_key: null,
    group_id: run.group,
    group_secret_hash: run.secretHash,
    inbox_operation: "register",
    ...extras,
  };
  return send<{ peer_id: string; instance_token: string }>(`${b.url}/register`, {
    ...body,
    auth: runInboxProof(run, body, INBOX_GATES.register),
  });
}

export function depositToOperator(
  b: TestBroker,
  fromToken: string,
  text: string,
  signedBy?: RunCredential,
  extras: Record<string, unknown> = {}
) {
  const body = { from_token: fromToken, to_peer_id: "operator", text, ...extras };
  return post<{ ok: boolean; error?: string }>(`${b.url}/send-message`, {
    ...body,
    ...(signedBy ? { auth: runInboxProof(signedBy, body, INBOX_GATES.deposit) } : {}),
  });
}

export function runInboxCall<T>(
  b: TestBroker,
  path: "/operator-inbox" | "/operator-inbox/purge",
  run: RunCredential,
  fields: Record<string, unknown>,
  options: { gate?: InboxGate; runRef?: string } = {}
) {
  const body = {
    group_id: run.group,
    group_secret_hash: run.secretHash,
    run_ref: options.runRef ?? run.run,
    ...fields,
  };
  const gate = options.gate ?? (path === "/operator-inbox" ? INBOX_GATES.drain : INBOX_GATES.purge);
  return post<T>(`${b.url}${path}`, { ...body, auth: operatorInboxProof(body, gate) });
}

export interface MandateCredential {
  cred: ApprovalCredential;
  tokenId: string;
}

export interface InboxOperatorKey {
  cred: ApprovalCredential;
  id: string;
}

const FIXTURE_OPERATOR_KEY: InboxOperatorKey = { cred: FIXTURE_OPERATOR, id: FIXTURE_OPERATOR_ID };

/**
 * A mandate hanging from `run`, minted by the operator key, for one authority,
 * acting for the tile whose desk session is `tile`: only an instance registered
 * with that `desk_session` can prove under it.
 */
export async function mintMandate(
  b: TestBroker,
  run: Pick<RunCredential, "tokenId">,
  authority: "author" | "lead" | "supervisor",
  caller: string,
  options: { tile: string; operator?: InboxOperatorKey; project?: string; send?: PostFn }
): Promise<MandateCredential> {
  const operator = options.operator ?? FIXTURE_OPERATOR_KEY;
  const cred = generateCredential();
  const body = {
    session_public_key: cred.publicKey,
    session_ref: caller,
    project_key: options.project ?? INBOX_TEST_PROJECT,
    inbox: { version: 1, kind: "mandate", parent_token_id: run.tokenId, caller_ref: caller, authority, desk_session: options.tile },
    public_key: operator.cred.publicKey,
  };
  const auth = buildInboxProof(operator.cred.privateKey, body, INBOX_GATES.mint, { kind: "operator", operator_id: operator.id });
  const res = await (options.send ?? post)<{ token_id: string }>(`${b.url}/approval/token-mint`, { ...body, auth });
  if (res.status !== 200) throw new Error(`mandate mint refused: ${res.status} ${JSON.stringify(res.body)}`);
  return { cred, tokenId: res.body.token_id };
}

/**
 * POST /inbox/close as the main would assemble it: the envelope signed by the
 * mandate, carrying the instance proof signed by the run root. A null
 * `instanceToken` sends no instance proof.
 */
export function closeInbox<T = { entry?: unknown; error?: string; state?: string }>(
  b: TestBroker,
  run: Pick<RunCredential, "cred" | "tokenId">,
  mandate: MandateCredential,
  close: { entryId: unknown; reason: unknown; instanceToken: string | null },
  operatorId: string = FIXTURE_OPERATOR_ID,
  send: PostFn = post
) {
  const core: Record<string, unknown> = { inbox_operation: "close", entry_id: close.entryId, reason: close.reason };
  const sessionAs = (tokenId: string) => ({ kind: "session" as const, operator_id: operatorId, token_id: tokenId });
  const body: Record<string, unknown> = { ...core };
  if (close.instanceToken !== null) {
    const payload = { ...core, instance_token: close.instanceToken };
    body.author = {
      payload,
      auth: buildInboxProof(run.cred.privateKey, payload, INBOX_GATES.authorClose, sessionAs(run.tokenId)),
    };
  }
  const auth = buildInboxProof(mandate.cred.privateKey, body, INBOX_GATES.mandateClose, sessionAs(mandate.tokenId));
  return send<T>(`${b.url}/inbox/close`, { ...body, auth });
}

/** POST /inbox/list, assembled like closeInbox; a null `instanceToken` sends no instance proof. */
export function listInbox<T = { entries?: Array<Record<string, unknown>>; next_cursor?: string | null; error?: string }>(
  b: TestBroker,
  run: Pick<RunCredential, "cred" | "tokenId">,
  mandate: MandateCredential,
  list: { instanceToken: string | null; cursor?: unknown },
  operatorId: string = FIXTURE_OPERATOR_ID,
  send: PostFn = post
) {
  const core: Record<string, unknown> = { inbox_operation: "list" };
  const sessionAs = (tokenId: string) => ({ kind: "session" as const, operator_id: operatorId, token_id: tokenId });
  const body: Record<string, unknown> = { ...core, ...(list.cursor !== undefined ? { cursor: list.cursor } : {}) };
  if (list.instanceToken !== null) {
    const payload = { ...core, instance_token: list.instanceToken };
    body.author = {
      payload,
      auth: buildInboxProof(run.cred.privateKey, payload, INBOX_GATES.authorList, sessionAs(run.tokenId)),
    };
  }
  const auth = buildInboxProof(mandate.cred.privateKey, body, INBOX_GATES.mandateList, sessionAs(mandate.tokenId));
  return send<T>(`${b.url}/inbox/list`, { ...body, auth });
}

/** POST /operator-inbox/reply, signed by the operator key for the reply door. */
export function replyInbox<T = { ok?: boolean; replayed?: boolean; message_id?: number; error?: string; state?: string }>(
  b: TestBroker,
  run: Pick<RunCredential, "group" | "secretHash" | "run">,
  fields: Record<string, unknown>,
  options: { gate?: InboxGate; runRef?: string } = {}
) {
  const body = {
    group_id: run.group,
    group_secret_hash: run.secretHash,
    run_ref: options.runRef ?? run.run,
    ...fields,
  };
  return post<T>(`${b.url}/operator-inbox/reply`, { ...body, auth: operatorInboxProof(body, options.gate ?? INBOX_GATES.reply) });
}

interface CoreRegistrationReply {
  result?: { isError?: boolean; content?: Array<{ text?: string }> };
  error?: { message?: string };
}

/**
 * server.ts answers initialize before /register ends, and the identity snapshot
 * a companion reads is written at the end of it; a tools/call is the only reply
 * that waits for the registration.
 */
export async function awaitCoreRegistered(
  send: (msg: unknown) => void,
  read: (id: number) => Promise<CoreRegistrationReply>,
  id = 1_000_000
): Promise<void> {
  send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "whoami", arguments: {} } });
  const reply = await reachedWithin(read(id), "whoami reply of the core peers session, so the end of its registration", 30_000);
  const refusal = reply.error?.message ?? (reply.result?.isError ? reply.result.content?.[0]?.text : undefined);
  if (refusal !== undefined) throw new Error(`the core peers session did not register before the companion started: ${refusal}`);
}
