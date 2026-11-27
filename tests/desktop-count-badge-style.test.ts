import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeCountBadgeStyle } from "../desktop/src/main/count-badge-style.ts";
import { extractBracedBody } from "./_braced-body.ts";

test("a stored look of the row counts is kept only when it is one the sidebar draws", () => {
  expect(normalizeCountBadgeStyle("glyph")).toBe("glyph");
  expect(normalizeCountBadgeStyle("pill")).toBe("pill");
  expect(normalizeCountBadgeStyle(undefined), "a config written before the setting existed").toBe("glyph");
  expect(normalizeCountBadgeStyle("future"), "a hand-edited or newer value").toBe("glyph");
  expect(normalizeCountBadgeStyle(1)).toBe("glyph");
});

// loadConfig cannot run here: store.ts imports electron, and a mock.module("electron")
// has no teardown in a shared bun process. One anchor, inside the function body.
test("loadConfig passes the stored look of the row counts through the normalizer", () => {
  const src = readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "store.ts"), "utf8");
  const anchor = src.indexOf("export function loadConfig(");
  expect(anchor, "loadConfig not found in store.ts").toBeGreaterThan(-1);
  const body = extractBracedBody(src, src.indexOf("{", anchor));
  expect(body, "an unknown countBadgeStyle in config.json would reach the renderer").toContain(
    "cfg.countBadgeStyle = normalizeCountBadgeStyle(cfg.countBadgeStyle)"
  );
});
