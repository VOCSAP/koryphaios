import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBroker, stopBroker } from "./_helper.ts";

const SLOW_BOOT_MS = 6000;
const FAKE_BODY = "fake-slow-broker";
const STDERR_MARKER = "FAKE_BROKER_BOOT_FAILURE_7ce18c06";

let scriptsDir: string;
let slowBroker: string;
let dyingBroker: string;
let silentBroker: string;

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
