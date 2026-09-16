// Releasing the clodex lease takes the inter-process lock (45 s of budget) and
// then up to 5 s of stop confirmation, so awaiting it inside setConfig would
// freeze the settings panel on the very click the setting exists for.
// This is a text scan: it catches an `await` reintroduced AT THE CALL SITE, and
// nothing else. A change of behaviour inside applyClodexAutoStart, or an await
// added in some other function, is outside what it can see.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const indexTs = readFileSync(
  join(import.meta.dir, "..", "desktop", "src", "main", "index.ts"),
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
