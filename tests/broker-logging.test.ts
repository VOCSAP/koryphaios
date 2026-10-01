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

test("malformed JSON bodies return a logged 400", async () => {
  const res = await fetch(`${b.url}/send-message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "invalid JSON body" });

  const logDir = join(b.tmpDir, "logs");
  expect(existsSync(logDir)).toBe(true);
  expect(readdirSync(logDir)).toContain("broker.log");
  const content = readFileSync(join(logDir, "broker.log"), "utf-8");
  expect(content).toContain("listening on");
  expect(content).toContain("invalid JSON body");
});

test("unexpected request failures hide exception text behind unique error IDs", async () => {
  const first = await fetch(`${b.url}/send-message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "null",
  });
  const second = await fetch(`${b.url}/send-message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "null",
  });

  expect(first.status).toBe(500);
  expect(second.status).toBe(500);
  const firstBody = await first.json() as { error: string; error_id: string };
  const secondBody = await second.json() as { error: string; error_id: string };
  expect(firstBody.error).toBe("internal error");
  expect(secondBody.error).toBe("internal error");
  expect(firstBody.error_id).toMatch(/^[0-9a-f]{8}$/);
  expect(secondBody.error_id).toMatch(/^[0-9a-f]{8}$/);
  expect(firstBody.error_id).not.toBe(secondBody.error_id);
  expect(JSON.stringify(firstBody)).not.toContain("from_token");

  const content = readFileSync(join(b.tmpDir, "logs", "broker.log"), "utf-8");
  expect(content).toContain(firstBody.error_id);
  expect(content).toContain(secondBody.error_id);
});
