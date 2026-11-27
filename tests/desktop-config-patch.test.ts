import { test, expect } from "bun:test";
import { CONFIG_KEY_ACCESS, restrictConfigPatch } from "../desktop/src/main/config-patch.ts";
import { DEFAULT_CONFIG } from "../desktop/src/main/store-defaults.ts";

function restrict(patch: Record<string, unknown>): { kept: Record<string, unknown>; reports: string[] } {
  const reports: string[] = [];
  const kept = restrictConfigPatch(patch, DEFAULT_CONFIG, (message) => reports.push(message));
  return { kept, reports };
}

test("the access table classes exactly the keys of the default config", () => {
  expect(Object.keys(CONFIG_KEY_ACCESS).sort(), "a config field without a class (or a class for a removed field)").toEqual(
    Object.keys(DEFAULT_CONFIG).sort()
  );
});

test("a patchable key lands and nothing is traced", () => {
  const { kept, reports } = restrict({ theme: "light", fontSize: 15 });
  expect(kept).toEqual({ theme: "light", fontSize: 15 });
  expect(reports).toEqual([]);
});

test("the notification sound switch is a patchable key that lands without a trace", () => {
  const { kept, reports } = restrict({ notifySound: false });
  expect(kept).toEqual({ notifySound: false });
  expect(reports).toEqual([]);
});

test("the look of the row counts is a patchable key that lands without a trace", () => {
  const { kept, reports } = restrict({ countBadgeStyle: "pill" });
  expect(kept).toEqual({ countBadgeStyle: "pill" });
  expect(reports).toEqual([]);
});

test("a key outside the config is dropped and traced, the rest of the patch lands", () => {
  const { kept, reports } = restrict({ shellHook: "x", theme: "light" });
  expect(kept).toEqual({ theme: "light" });
  expect(reports).toEqual(['rejected config:set key "shellHook" (unknown)']);
});

test("a file-only key is refused with a new value and accepted with the stored one", () => {
  const changed = restrict({ peerCommand: "other", projectDir: "/elsewhere" });
  expect(changed.kept).toEqual({});
  expect(changed.reports).toEqual([
    'rejected config:set key "peerCommand" (not patchable)',
    'rejected config:set key "projectDir" (not patchable)'
  ]);
  const same = restrict({ projectDir: DEFAULT_CONFIG.projectDir });
  expect(same.kept).toEqual({ projectDir: DEFAULT_CONFIG.projectDir });
  expect(same.reports).toEqual([]);
});

test("inherited and prototype names are refused as unknown keys", () => {
  const patch = JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1, "toString": 2}') as Record<string, unknown>;
  const { kept, reports } = restrict(patch);
  expect(kept).toEqual({});
  expect(Object.getPrototypeOf(kept)).toBe(Object.prototype);
  expect(reports).toHaveLength(3);
  expect(reports.every((message) => message.endsWith("(unknown)"))).toBe(true);
});

test("a patch that is not an object contributes no key and one trace per index", () => {
  const { kept, reports } = restrict("ab" as unknown as Record<string, unknown>);
  expect(kept).toEqual({});
  expect(reports).toEqual(['rejected config:set key "0" (unknown)', 'rejected config:set key "1" (unknown)']);
});

test("a long hostile key is cut in the trace", () => {
  const { reports } = restrict({ ["k".repeat(500)]: 1 });
  expect(reports).toHaveLength(1);
  expect(reports[0]!.length).toBeLessThan(120);
});
