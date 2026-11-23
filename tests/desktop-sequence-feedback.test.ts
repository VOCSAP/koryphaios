import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { skillRefusalToast } from "../desktop/src/renderer/src/sequence-feedback.ts";

const REFUSALS = [
  "bad-request",
  "unknown-tile",
  "not-eligible",
  "settings-unreadable",
  "command-refused",
  "bad-plan",
  "no-source",
  "sequence-active"
];

test("each refusal has its own error key", () => {
  const keys = REFUSALS.map((reason) => skillRefusalToast({ reason }));
  for (const t of keys) expect(t.level).toBe("error");
  expect(new Set(keys.map((t) => t.key)).size, "two refusals share a key").toBe(REFUSALS.length);
});

test("a refused command shows main's detail verbatim, and so does an ineligible tile", () => {
  expect(skillRefusalToast({ reason: "command-refused", detail: "stop line 2: dialogue-command" })).toEqual({
    key: "toast.skillRefused.commandRefused",
    level: "error",
    params: { detail: "stop line 2: dialogue-command" }
  });
  expect(skillRefusalToast({ reason: "not-eligible", detail: "not-lead" }).params).toEqual({ detail: "not-lead" });
});

test("a detail-bearing refusal with no detail falls back to its reason code", () => {
  expect(skillRefusalToast({ reason: "command-refused" }).params).toEqual({ detail: "command-refused" });
});

test("the other refusals never carry a detail, even when main sends one", () => {
  for (const reason of REFUSALS.filter((r) => r !== "command-refused" && r !== "not-eligible")) {
    expect(skillRefusalToast({ reason, detail: "x" }).params, reason).toBeUndefined();
  }
});

test("an unknown or inherited refusal still says the sequence did not start", () => {
  for (const reason of ["a-refusal-from-a-newer-main", "toString"]) {
    expect(skillRefusalToast({ reason }), reason).toEqual({
      key: "toast.skillRefused.other",
      level: "error",
      params: { detail: reason }
    });
  }
});

test("every refusal key exists in en.json and fr.json", () => {
  const root = join(import.meta.dir, "../desktop/locales");
  const en = JSON.parse(readFileSync(join(root, "en.json"), "utf-8"));
  const fr = JSON.parse(readFileSync(join(root, "fr.json"), "utf-8"));
  for (const reason of [...REFUSALS, "unknown"]) {
    const { key } = skillRefusalToast({ reason });
    expect(typeof en[key], `en ${key}`).toBe("string");
    expect(typeof fr[key], `fr ${key}`).toBe("string");
  }
});
