// Releasing the clodex lease takes the inter-process lock (45 s of budget) and
// then up to 5 s of stop confirmation, so awaiting it inside setConfig would
// freeze the settings panel on the very click the setting exists for.
// This is a text scan: it catches an `await` reintroduced AT THE CALL SITE, and
// nothing else. A change of behaviour inside applyClodexAutoStart, or an await
// added in some other function, is outside what it can see.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractBracedBody } from "./_braced-body";

const indexTs = readFileSync(
  join(import.meta.dir, "..", "desktop", "src", "main", "index.ts"),
  "utf8"
);

const settingsView = readFileSync(
  join(import.meta.dir, "..", "desktop", "src", "renderer", "src", "components", "SettingsView.tsx"),
  "utf8"
);

test("the clodex auto-start toggle is applied detached, never awaited by setConfig", () => {
  const marker = "void applyClodexAutoStart(";
  const callIdx = indexTs.indexOf(marker);
  // Positive control: a rename would otherwise leave this scan searching for
  // nothing, and a scan that finds nothing passes forever.
  expect(callIdx).toBeGreaterThan(-1);
  expect(indexTs.indexOf(marker, callIdx + 1)).toBe(-1);
  expect(indexTs).not.toMatch(/await\s+applyClodexAutoStart\s*\(/);
});

test("the session toggle announces the catalog change, like the startup path does", () => {
  const decl = "const applyClodexAutoStart";
  const declIdx = indexTs.indexOf(decl);
  expect(declIdx).toBeGreaterThan(-1);
  const body = extractBracedBody(indexTs, indexTs.indexOf("{", declIdx));
  // Scoped to the toggle's own body: announceModelsChanged also has a startup
  // call site, and asserting on the whole file would pass on that one alone,
  // which is exactly the gap this pins.
  expect(body).toContain("announceModelsChanged(");
});

test("the clodex checkbox row carries the attribute its dimming rule keys on", () => {
  // styles.css dims `.field-check[aria-disabled='true']`, the whole ROW. The
  // input's own `disabled` only greys the native box, so the label and the help
  // line would stay at full opacity without this attribute.
  const rowIdx = settingsView.indexOf("t('settings.clodexAutoStart')");
  expect(rowIdx).toBeGreaterThan(-1);
  const labelIdx = settingsView.lastIndexOf("<label", rowIdx);
  expect(labelIdx).toBeGreaterThan(-1);
  expect(settingsView.slice(labelIdx, rowIdx)).toMatch(/aria-disabled=\{/);
});
