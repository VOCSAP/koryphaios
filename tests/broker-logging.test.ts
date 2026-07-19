// PLAN-observabilite-erreurs O2: the broker owns a rolling on-disk log and
// survives handler errors (500 path) while leaving a trace.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { startBroker, stopBroker, type TestBroker } from "./_helper.ts";

let b: TestBroker;

beforeAll(async () => {
  b = await startBroker();
});

afterAll(async () => {
  await stopBroker(b);
});

test("boot banner and request failures land in the rolling broker.log", async () => {
  // Malformed JSON body -> req.json() throws -> 500 catch path.
  const res = await fetch(`${b.url}/send-message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  expect(res.status).toBe(500);

  // The broker still serves after the failed request (no crash).
  const health = await fetch(`${b.url}/health`);
  expect(health.ok).toBe(true);

  const logDir = join(b.tmpDir, "logs");
  expect(existsSync(logDir)).toBe(true);
  expect(readdirSync(logDir)).toContain("broker.log");
  const content = readFileSync(join(logDir, "broker.log"), "utf-8");
  expect(content).toContain("listening on");
  expect(content).toContain("request /send-message failed with 500");
});
