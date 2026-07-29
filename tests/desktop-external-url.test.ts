import { test, expect } from "bun:test";
import { safeExternalUrl } from "../desktop/src/main/external-url";

// shell.openExternal launches whatever handler the OS registered for a scheme,
// and the links reaching it are printed by a CLI inside a sandbox container or
// by a page in the embedded browser. Only http(s) may cross.

test("lets normal web links through", () => {
  expect(safeExternalUrl("https://claude.ai/oauth/authorize?code=true")).toBe(
    "https://claude.ai/oauth/authorize?code=true"
  );
  expect(safeExternalUrl("http://localhost:3000/")).toBe("http://localhost:3000/");
});

test("refuses every non-web scheme", () => {
  // `about:blank` is what an unvalidated window.open handed to the OS, which
  // is how Windows ended up offering to find an app for the 'about' protocol.
  expect(safeExternalUrl("about:blank")).toBeNull();
  expect(safeExternalUrl("file:///C:/Windows/System32/calc.exe")).toBeNull();
  expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
  expect(safeExternalUrl("ms-settings:")).toBeNull();
  expect(safeExternalUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
});

test("refuses what is not a parseable absolute url", () => {
  expect(safeExternalUrl("")).toBeNull();
  expect(safeExternalUrl("   ")).toBeNull();
  expect(safeExternalUrl("/relative/path")).toBeNull();
  expect(safeExternalUrl(null)).toBeNull();
  expect(safeExternalUrl(42)).toBeNull();
  expect(safeExternalUrl(`https://x.test/${"a".repeat(9000)}`)).toBeNull();
});
