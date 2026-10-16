// index.ts cannot load under bun (Electron): each wiring piece runs from
// index.ts's own source against stubs.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const INDEX = resolve(import.meta.dir, "../desktop/src/main/index.ts");

function source(): string {
  return readFileSync(INDEX, "utf8").replace(/\r\n/g, "\n");
}

function braced(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  throw new Error("unterminated");
}

function js(ts: string): string {
  return new Bun.Transpiler({ loader: "ts" }).transformSync(ts);
}

function readManualStopWith(deps: { reading: () => unknown; reportError: (scope: string, message: string) => void }): () => unknown {
  const text = source();
  const start = text.indexOf("function readManualStop(");
  if (start < 0) throw new Error("index.ts: readManualStop is unavailable");
  const fn = text.slice(start, text.indexOf("{", start)) + braced(text, text.indexOf("{", start));
  return new Function(
    "deps",
    `let brokerStopProblem = null;
     const readBrokerStopMarker = () => deps.reading();
     const brokerStopMarkerPath = (p) => p;
     const peersConfigPath = () => "config.json";
     const reportError = deps.reportError;
     ${js(fn)}
     return readManualStop;`
  )(deps) as () => unknown;
}

interface HealthDeps {
  logInfo: (scope: string, message: string) => void;
  reportError: (scope: string, message: string) => void;
  startLoopbackBroker: (reason: string) => Promise<void>;
  broadcast: (channel: string, payload: unknown) => void;
}

function healthCallback(deps: HealthDeps): (status: unknown) => void {
  const text = source();
  const anchor = text.indexOf("const brokerHealth = new BrokerHealthTracker(");
  if (anchor < 0) throw new Error("index.ts: the broker health tracker is unavailable");
  const arrow = text.indexOf("(status) => {", anchor);
  const body = braced(text, text.indexOf("{", arrow));
  return new Function(
    "deps",
    `let brokerWasUp = true;
     let roadmapSyncProbeDue = false;
     const brokerRespawn = { allow: () => true };
     const { logInfo, reportError, startLoopbackBroker, broadcast } = deps;
     ${js(`export const f = (status: any) => ${body}`).replace("export const f = ", "return ")}`
  )(deps) as (status: unknown) => void;
}

function optionExpression(anchorText: string, marker: string): string {
  const text = source();
  const anchor = text.indexOf(anchorText);
  const start = anchor < 0 ? -1 : text.indexOf(marker, anchor);
  if (start < 0) throw new Error(`index.ts: ${marker.trim()} is unavailable after ${anchorText}`);
  return text.slice(start + marker.length, text.indexOf("\n", start)).replace(/,$/, "");
}

test("an absent marker is no manual stop; a valid one carries its date", () => {
  const reports: string[] = [];
  let reading: unknown = { stopped: false };
  const read = readManualStopWith({ reading: () => reading, reportError: (_s, m) => reports.push(m) });
  expect(read()).toBeNull();
  reading = { stopped: true, marker: { stopped_at: "2026-10-16T19:00:00.000Z", by: "tray", killed_pid: 42 } };
  expect(read()).toEqual({ stopped_at: "2026-10-16T19:00:00.000Z" });
  expect(reports).toEqual([]);
});

test("a malformed marker still means stopped, and its problem is reported once until it changes", () => {
  const reports: string[] = [];
  let reading: unknown = { stopped: true, marker: null, problem: "not valid JSON" };
  const read = readManualStopWith({ reading: () => reading, reportError: (_s, m) => reports.push(m) });
  expect(read()).toEqual({ stopped_at: null });
  expect(read()).toEqual({ stopped_at: null });
  expect(reports).toHaveLength(1);
  expect(reports[0]).toContain("not valid JSON");
  reading = { stopped: true, marker: null, problem: "cannot be read: EACCES" };
  read();
  expect(reports).toHaveLength(2);
});

function healthHarness(): { cb: (status: unknown) => void; calls: string[] } {
  const calls: string[] = [];
  const cb = healthCallback({
    logInfo: (_s, m) => calls.push(`info:${m}`),
    reportError: (_s, m) => calls.push(`error:${m}`),
    startLoopbackBroker: async (reason) => { calls.push(`start:${reason}`); },
    broadcast: (channel) => calls.push(`broadcast:${channel}`),
  });
  return { cb, calls };
}

test("an outage during a manual stop is neither reported as a failure nor relaunched", () => {
  const { cb, calls } = healthHarness();
  cb({ up: false, since: 1, lastError: "ECONNREFUSED", manualStop: { stopped_at: "2026-10-16T19:00:00.000Z" } });
  expect(calls.filter((c) => c.startsWith("error:"))).toEqual([]);
  expect(calls.filter((c) => c.startsWith("start:"))).toEqual([]);
  expect(calls).toContain("broadcast:broker:status");
});

test("an outage without a manual stop is reported and relaunched once", () => {
  const { cb, calls } = healthHarness();
  cb({ up: false, since: 1, lastError: "ECONNREFUSED", manualStop: null });
  expect(calls.filter((c) => c.startsWith("error:"))).toHaveLength(1);
  expect(calls).toContain("start:outage");
});

test("a marker change alone is broadcast without replaying the reachability side effects", () => {
  const { cb, calls } = healthHarness();
  cb({ up: true, since: 1, lastError: null, manualStop: { stopped_at: null } });
  expect(calls).toEqual(["broadcast:broker:status"]);
});

test("every Deck launcher honours the marker: ensureLoopbackBroker's stopped dep reads it", () => {
  const expr = optionExpression("async function startLoopbackBroker(", "    stopped: ");
  let marker: unknown = null;
  const stopped = new Function("readManualStop", `return ${js(`export const f = ${expr}`).replace("export const f = ", "")}`)(
    () => marker
  ) as () => boolean;
  expect(stopped()).toBe(false);
  marker = { stopped_at: null };
  expect(stopped(), "a malformed marker must also stop the launch").toBe(true);
});

test("the broker:start dep runs the banner's start", async () => {
  const expr = optionExpression("brokerStatus: () => brokerHealth.status,", "    brokerStart: ");
  let calls = 0;
  const start = new Function("startBrokerFromBanner", `return ${js(`export const f = ${expr}`).replace("export const f = ", "")}`)(
    async () => { calls += 1; return { ok: true }; }
  ) as () => Promise<unknown>;
  expect(await start()).toEqual({ ok: true });
  expect(calls).toBe(1);
});

test("the marker is read right before the startup launch, in code and not in a comment", () => {
  // The transpiler drops comments, so a pair copied into one cannot satisfy this.
  expect(js(source()), "the tracker starts up: the stop must be posted before the first launch").toMatch(
    /brokerHealth\.setManualStop\(readManualStop\(\)\);?\s*await startLoopbackBroker\(["']startup["']\)/
  );
});

function pollOperatorInboxWith(order: string[], fetch: () => Promise<unknown[]>): () => Promise<void> {
  const text = source();
  const start = text.indexOf("const pollOperatorInbox = async (): Promise<void> => {");
  if (start < 0) throw new Error("index.ts: pollOperatorInbox is unavailable");
  const body = braced(text, text.indexOf("{", start));
  return new Function(
    "order",
    "fetch",
    `const brokerHealth = {
       setManualStop: () => order.push("setManualStop"),
       recordSuccess: () => order.push("recordSuccess"),
       recordFailure: () => order.push("recordFailure"),
     };
     const readManualStop = () => { order.push("readManualStop"); return null; };
     const fetchOperatorInbox = async () => { order.push("fetch"); return fetch(); };
     const activeScope = { groupId: "g", secret: "s" };
     const currentInboxSessionId = () => "session";
     const resolveBrokerEndpoint = () => ({ url: "http://127.0.0.1:7899" });
     const pendingInboxWrites = [];
     ${js(`export const f = async () => ${body}`).replace("export const f = ", "return ")}`
  )(order, fetch) as () => Promise<void>;
}

test("every health tick reads the marker before the poll that feeds the tracker", async () => {
  const order: string[] = [];
  await pollOperatorInboxWith(order, async () => [])();
  expect(order).toEqual(["readManualStop", "setManualStop", "fetch", "recordSuccess"]);
});

test("a failed health tick has read the marker before the failure reaches the tracker", async () => {
  const order: string[] = [];
  await pollOperatorInboxWith(order, async () => { throw new Error("ECONNREFUSED"); })();
  expect(order).toEqual(["readManualStop", "setManualStop", "fetch", "recordFailure"]);
});
