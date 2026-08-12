import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { buildAuthProof, deriveOperatorId, generateCredential } from "../shared/approval.ts";

export interface TestBroker {
  url: string;
  wsUrl: string;
  port: number;
  proc: ReturnType<typeof Bun.spawn>;
  dbPath: string;
  tmpDir: string;
}

// Each test file picks a port from a wide window so parallel suites don't collide.
let nextPort = 17900 + Math.floor(Math.random() * 5000);

export async function startBroker(
  envOverrides: Record<string, string> = {}
): Promise<TestBroker> {
  const tmpDir = mkdtempSync(join(tmpdir(), "cp-test-"));
  const dbPath = join(tmpDir, "peers.db");

  // Scrub any CLAUDE_PEERS_* vars inherited from the developer's shell
  // (BROKER_TOKEN, BROKER_URL, ...). Tests must own their broker config
  // entirely through envOverrides; otherwise a token set in the user
  // environment turns every unauthenticated test POST into a 401.
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE_PEERS_"))
  ) as Record<string, string>;

  for (let attempt = 0; attempt < 20; attempt++) {
    const port = nextPort++;
    const proc = Bun.spawn(["bun", "broker.ts"], {
      env: {
        ...cleanEnv,
        CLAUDE_PEERS_PORT: String(port),
        CLAUDE_PEERS_DB: dbPath,
        // Keep the rolling log inside the test sandbox (cleaned with it).
        CLAUDE_PEERS_LOG_DIR: join(tmpDir, "logs"),
        CLAUDE_PEERS_DORMANT_TTL_HOURS: "24",
        ...envOverrides,
      },
      stdio: ["ignore", "ignore", "ignore"],
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
    for (let i = 0; i < 80; i++) {
      if (proc.exitCode !== null) break;
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
      };
    }
    try { proc.kill(); await proc.exited; } catch { /* */ }
  }
  rmSync(tmpDir, { recursive: true, force: true });
  throw new Error("could not start broker on any port");
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
 * Sign a roadmap write as the operator (card 39c40571 layer 2).
 *
 * `by: 'deck'` names the HUMAN, so the broker demands an Ed25519 proof on it.
 * Fixtures that only need SOME author should use a plain name instead (any
 * string matching no peer row is accepted unproven); this helper is for the
 * tests that assert DECK-SPECIFIC behaviour -- the lock exemptions, force, the
 * "submitted, not started" rule -- which would otherwise silently stop testing
 * the deck path the day they were switched to another author.
 *
 * One credential per test process: operator_id is the digest of the public key,
 * so the broker self-certifies it on first contact and every fixture speaks as
 * the same operator, which is what a single Deck does.
 */
const FIXTURE_OPERATOR = generateCredential();

/**
 * The operator_id digest `deckAuthored` writes stamp on a card (card
 * edefff05). Exported so tests can assert the exact value a signed write
 * persisted, not just that some truthy string landed.
 */
export const FIXTURE_OPERATOR_ID = deriveOperatorId(FIXTURE_OPERATOR.publicKey);

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
