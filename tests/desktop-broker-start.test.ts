import { describe, expect, test } from "bun:test";
import type { EnsureOutcome } from "../desktop/src/main/broker-spawn";
import { createBrokerStart, type BrokerStartDeps } from "../desktop/src/main/broker-start";

interface Harness {
  deps: BrokerStartDeps;
  calls: string[];
  reports: string[];
}

function harness(overrides: Partial<BrokerStartDeps> = {}): Harness {
  const calls: string[] = [];
  const reports: string[] = [];
  const deps: BrokerStartDeps = {
    clearMarker: () => { calls.push("clear"); },
    isAlive: async () => { calls.push("health"); return false; },
    ensure: async () => { calls.push("ensure"); return { action: "started", script: "broker.ts", source: "claude-json" } as EnsureOutcome; },
    refresh: () => { calls.push("refresh"); },
    report: (_scope, message) => { reports.push(message); },
    ...overrides,
  };
  return { deps, calls, reports };
}

describe("createBrokerStart", () => {
  test("clears the marker, probes /health, then ensures the broker when /health is silent", async () => {
    const h = harness();
    expect(await createBrokerStart(h.deps)()).toEqual({ ok: true });
    expect(h.calls).toEqual(["clear", "health", "ensure", "refresh"]);
    expect(h.reports).toEqual([]);
  });

  test("a broker already answering /health is never spawned again", async () => {
    const h = harness({ isAlive: async () => true });
    expect(await createBrokerStart(h.deps)()).toEqual({ ok: true });
    expect(h.calls, "a second broker on the same port fails only after opening the database").not.toContain("ensure");
  });

  test("two concurrent starts share one probe and one spawn", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({ ensure: async () => { h.calls.push("ensure"); await gate; return { action: "already-running" }; } });
    const start = createBrokerStart(h.deps);
    const first = start();
    const second = start();
    release();
    expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }]);
    expect(h.calls.filter((c) => c === "ensure")).toHaveLength(1);
    expect(h.calls.filter((c) => c === "clear")).toHaveLength(1);
  });

  test("a later start after the first settled runs again", async () => {
    const h = harness();
    const start = createBrokerStart(h.deps);
    await start();
    await start();
    expect(h.calls.filter((c) => c === "ensure")).toHaveLength(2);
  });

  test("a marker that cannot be removed stops the start before any spawn and is reported", async () => {
    const h = harness({ clearMarker: () => { throw new Error("EPERM"); } });
    const result = await createBrokerStart(h.deps)();
    expect(result.ok).toBe(false);
    expect(h.calls).not.toContain("ensure");
    expect(h.calls).toContain("refresh");
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toContain("EPERM");
  });

  const failures: [string, EnsureOutcome, string][] = [
    ["failed spawn", { action: "failed", script: "broker.ts", reason: "spawn bun ENOENT" }, "spawn bun ENOENT"],
    ["missing script", { action: "not-found" }, "no broker.ts"],
    ["remote mode", { action: "skipped", reason: "remote-mode" }, "remote broker"],
    ["stopped again meanwhile", { action: "skipped", reason: "manual-stop" }, "stopped again"],
  ];
  for (const [name, outcome, fragment] of failures) {
    test(`a ${name} is a failed start, reported and returned`, async () => {
      const h = harness({ ensure: async () => outcome });
      const result = await createBrokerStart(h.deps)();
      expect(result).toEqual({ ok: false, error: expect.stringContaining(fragment) });
      expect(h.reports).toHaveLength(1);
      expect(h.reports[0]).toContain(fragment);
    });
  }

  test("a refresh that throws is reported and does not turn a started broker into a rejection", async () => {
    const h = harness({ refresh: () => { throw new Error("marker read crashed"); } });
    expect(await createBrokerStart(h.deps)()).toEqual({ ok: true });
    expect(h.reports).toEqual(["broker status refresh failed"]);
  });

  test("a throwing probe is a failed start, never an unhandled rejection", async () => {
    const h = harness({ isAlive: async () => { throw new Error("socket hang up"); } });
    expect(await createBrokerStart(h.deps)()).toEqual({ ok: false, error: "socket hang up" });
    expect(h.reports).toHaveLength(1);
  });
});
