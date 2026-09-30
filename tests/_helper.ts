import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { buildAuthProof, deriveOperatorId, generateCredential } from "../shared/approval.ts";
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
  /** argv to spawn in place of `bun broker.ts`; it must serve /health on CLAUDE_PEERS_PORT. */
  command?: string[];
  /** Wall-clock budget shared by every attempt. */
  budgetMs?: number;
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
  const dbPath = join(tmpDir, "peers.db");
  const command = options.command ?? ["bun", "broker.ts"];
  const deadline = Date.now() + (options.budgetMs ?? BOOT_BUDGET_MS);
  const failures: string[] = [];

  // A retry only follows a process that EXITED (lost the TOCTOU port race,
  // crashed at boot). A live broker that has not answered yet is still
  // booting: killing it to try another port throws that boot away, which is
  // how a slow runner turned into three killed brokers in a row.
  for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt++) {
    const port = await reserveEphemeralPort();
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
    const proc = Bun.spawn(command, {
      env,
      stdio: ["ignore", "ignore", Bun.file(stderrPath)],
    });

    // A 200 on /health only proves that SOMEBODY listens on this port, never
    // that it is the process we just spawned. When two concurrent test runs
    // pick the same port, the other run's broker answers immediately while
    // ours is still failing to bind and about to exit -- and the caller would
    // get a handle whose url points at a FOREIGN broker (its db, its peers)
    // with a dead `proc`, then ECONNREFUSED as soon as that run stops it.
    // So readiness also requires our own process to still be alive, and not
    // before it has had time to die. Measured on this machine: a foreign
    // broker answers at +5 ms, our own at +70..85 ms, and a losing broker's
    // exitCode becomes observable at +92 ms -- hence the settle window below
    // (~2.7x the exit latency). A dead process breaks out immediately so the
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
        if (res.ok && Date.now() - spawnedAt >= SETTLE_MS && proc.exitCode === null) {
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
        `\n  broker.log (shared by all attempts) ${await readLogEnds(join(tmpDir, "logs", "broker.log"))}` +
        `\n  stderr tail: ${await readTail(stderrPath, STDERR_TAIL_CHARS)}`
    );
    if (!exitedOnItsOwn) break;
  }
  rmSync(tmpDir, { recursive: true, force: true });
  throw new Error(
    `could not start broker on any port (${command.join(" ")}, ${failures.length} attempt(s)):\n${failures.join("\n")}`
  );
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
const FIXTURE_OPERATOR = generateCredential();

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
