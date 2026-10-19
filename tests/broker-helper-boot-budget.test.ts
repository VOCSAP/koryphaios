import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { pathToFileURL } from "node:url";
import { BROKER_DB_BUSY_TIMEOUT_MS, openBrokerDb, startBroker, stopBroker } from "./_helper.ts";

const SLOW_BOOT_MS = 6000;
const FAKE_BODY = "fake-slow-broker";
const STDERR_MARKER = "FAKE_BROKER_BOOT_FAILURE_7ce18c06";

let scriptsDir: string;
let slowBroker: string;
let dyingBroker: string;
let silentBroker: string;
let lockHolder: string;

const LOCK_RELEASE_DELAY_MS = 150;

beforeAll(() => {
  scriptsDir = mkdtempSync(join(tmpdir(), "cp-fake-broker-"));
  slowBroker = join(scriptsDir, "slow.ts");
  writeFileSync(
    slowBroker,
    `await Bun.sleep(${SLOW_BOOT_MS});\n` +
      `Bun.serve({ port: Number(process.env.CLAUDE_PEERS_PORT), hostname: "127.0.0.1", fetch: () => new Response(${JSON.stringify(FAKE_BODY)}) });\n`
  );
  dyingBroker = join(scriptsDir, "dying.ts");
  writeFileSync(dyingBroker, `console.error(${JSON.stringify(STDERR_MARKER)});\nprocess.exit(3);\n`);
  silentBroker = join(scriptsDir, "silent.ts");
  writeFileSync(silentBroker, "setInterval(() => {}, 1000);\n");
  lockHolder = join(scriptsDir, "lock-holder.ts");
  writeFileSync(
    lockHolder,
    `import { Database } from "bun:sqlite";\n` +
      `self.onmessage = (event: MessageEvent) => {\n` +
      `  const db = new Database(event.data.dbPath);\n` +
      `  const flag = new Int32Array(event.data.flag);\n` +
      `  db.run("BEGIN IMMEDIATE");\n` +
      `  postMessage("holding");\n` +
      `  Atomics.wait(flag, 0, 0);\n` +
      `  setTimeout(() => { db.run("COMMIT"); db.close(); postMessage("released"); }, ${LOCK_RELEASE_DELAY_MS});\n` +
      `};\n`
  );
});

afterAll(() => {
  rmSync(scriptsDir, { recursive: true, force: true });
});

test("a broker that boots slower than one retry window is waited for, not killed and relaunched", async () => {
  const t0 = Date.now();
  const b = await startBroker({}, { command: [process.execPath, slowBroker] });
  const elapsed = Date.now() - t0;
  const body = await (await fetch(`${b.url}/health`)).text();
  await stopBroker(b);
  expect(["the handle points at the slow fake broker, reached after its boot", body, elapsed >= SLOW_BOOT_MS]).toEqual([
    "the handle points at the slow fake broker, reached after its boot",
    FAKE_BODY,
    true,
  ]);
}, 30_000);

test("a broker that exits at boot is retried, and the error carries its stderr and exit code", async () => {
  let message = "";
  try {
    await startBroker({}, { command: [process.execPath, dyingBroker] });
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain("could not start broker on any port");
  expect(message).toContain("3 attempt(s)");
  expect(message).toContain("exitCode=3");
  expect(message).toContain(STDERR_MARKER);
}, 30_000);

test("a live broker that never answers is killed once at the budget, never relaunched on another port", async () => {
  const t0 = Date.now();
  let message = "";
  try {
    await startBroker({}, { command: [process.execPath, silentBroker], budgetMs: 1500 });
  } catch (e) {
    message = (e as Error).message;
  }
  const elapsed = Date.now() - t0;
  expect(message).toContain("1 attempt(s)");
  expect(message).toContain("alive but silent, killed at the budget");
  expect(["the budget bounds the wait", elapsed < 10_000]).toEqual(["the budget bounds the wait", true]);
}, 30_000);

const LOCK_HOLDER_START_BUDGET_MS = 5000;

async function holdWriterLock(
  dbPath: string
): Promise<{ worker: Worker; release: () => void; released: Promise<void> }> {
  const worker = new Worker(pathToFileURL(lockHolder).href);
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const released = new Promise<void>((resolve) => {
    worker.addEventListener("message", (e) => e.data === "released" && resolve());
  });
  const holding = new Promise<void>((resolve, reject) => {
    worker.addEventListener("message", (e) => e.data === "holding" && resolve());
    worker.addEventListener("error", (e) => reject(new Error(`lock holder failed: ${e.message}`)));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`lock holder did not hold the writer lock within ${LOCK_HOLDER_START_BUDGET_MS} ms`)),
      LOCK_HOLDER_START_BUDGET_MS
    );
  });
  const release = () => {
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
  };
  const holder = { worker, released, release };
  worker.postMessage({ dbPath, flag: flag.buffer });
  try {
    await Promise.race([holding, budget]);
  } catch (e) {
    await stopLockHolder(holder);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  return holder;
}

const LOCK_HOLDER_STOP_BUDGET_MS = 2000;

async function stopLockHolder(holder: { worker: Worker; released: Promise<void>; release: () => void }): Promise<void> {
  holder.release();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, LOCK_HOLDER_STOP_BUDGET_MS);
  });
  await Promise.race([holder.released, budget]);
  clearTimeout(timer);
  holder.worker.terminate();
}

test("a database connection opened through openBrokerDb waits for a concurrent writer where a bare one fails at once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-busy-"));
  const dbPath = join(dir, "peers.db");
  let holder: Awaited<ReturnType<typeof holdWriterLock>> | undefined;
  try {
    const seed = new Database(dbPath);
    seed.run("PRAGMA journal_mode = WAL");
    seed.run("CREATE TABLE t (n INTEGER)");
    seed.close();
    holder = await holdWriterLock(dbPath);
    const bare = new Database(dbPath);
    let bareError = "";
    try {
      bare.run("INSERT INTO t VALUES (1)");
    } catch (e) {
      bareError = (e as Error).message;
    }
    bare.close();
    expect([
      "a bare bun:sqlite connection reports the lock at once (the lock holder is really holding)",
      bareError,
    ]).toEqual(["a bare bun:sqlite connection reports the lock at once (the lock holder is really holding)", "database is locked"]);

    const db = openBrokerDb(dbPath);
    holder.release();
    let helperError = "";
    try {
      db.run("INSERT INTO t VALUES (2)");
    } catch (e) {
      helperError = (e as Error).message;
    }
    const rows = db.query("SELECT n FROM t").all() as { n: number }[];
    db.close();
    await holder.released;
    expect([
      "openBrokerDb waits for the writer lock instead of failing with 'database is locked'",
      helperError,
      rows,
    ]).toEqual(["openBrokerDb waits for the writer lock instead of failing with 'database is locked'", "", [{ n: 2 }]]);
  } finally {
    if (holder) await stopLockHolder(holder);
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

test("a readonly connection opened through openBrokerDb carries the same bounded busy timeout", () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-busy-ro-"));
  const dbPath = join(dir, "peers.db");
  const seed = new Database(dbPath);
  seed.run("CREATE TABLE t (n INTEGER)");
  seed.close();
  const db = openBrokerDb(dbPath, { readonly: true });
  const timeout = db.query("PRAGMA busy_timeout").get();
  let writeError = "";
  try {
    db.run("INSERT INTO t VALUES (1)");
  } catch (e) {
    writeError = (e as Error).message;
  }
  db.close();
  rmSync(dir, { recursive: true, force: true });
  expect(["a readonly broker-db connection has a bounded busy timeout", timeout]).toEqual([
    "a readonly broker-db connection has a bounded busy timeout",
    { timeout: BROKER_DB_BUSY_TIMEOUT_MS },
  ]);
  expect(["a readonly broker-db connection refuses a write", writeError]).toEqual([
    "a readonly broker-db connection refuses a write",
    "attempt to write a readonly database",
  ]);
});
