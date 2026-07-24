// REC scripted-scenario lot: pure script builders + validation of
// browser-drive-scripts.ts. The selectors come from the demo AGENT (hostile
// until proven otherwise): they must only ever enter a script JSON-encoded.

import { test, expect } from "bun:test";
import {
  buildExistsScript,
  buildFocusScript,
  buildLocateScript,
  buildReadScript,
  isNavigableUrl,
  MAX_SELECTOR_CHARS,
  READ_INTERACTIVE_CAP,
  READ_TEXT_CAP,
  validSelector
} from "../desktop/src/main/browser-drive-scripts.ts";

test("isNavigableUrl allows web pages only", () => {
  expect(isNavigableUrl("http://localhost:3000/")).toBe(true);
  expect(isNavigableUrl("https://example.com/a?b=1")).toBe(true);
  expect(isNavigableUrl("file:///etc/passwd")).toBe(false);
  expect(isNavigableUrl("devtools://devtools/")).toBe(false);
  expect(isNavigableUrl("about:blank")).toBe(false);
  expect(isNavigableUrl("javascript:alert(1)")).toBe(false);
  expect(isNavigableUrl("http://")).toBe(false);
  expect(isNavigableUrl("")).toBe(false);
});

test("validSelector enforces the cap, not truncation", () => {
  expect(validSelector("#ok")).toBe(true);
  expect(validSelector("")).toBe(false);
  expect(validSelector("x".repeat(MAX_SELECTOR_CHARS))).toBe(true);
  expect(validSelector("x".repeat(MAX_SELECTOR_CHARS + 1))).toBe(false);
});

test("a hostile selector enters scripts JSON-encoded, never raw", () => {
  // A selector trying to break out of the string and run code.
  const hostile = `"]'); document.title='pwned'; ('`;
  for (const script of [
    buildLocateScript(hostile),
    buildFocusScript(hostile),
    buildExistsScript(hostile)
  ]) {
    // The payload reaches querySelector as ONE JSON string literal — the
    // escaped quote cannot terminate it, so nothing executes.
    expect(script).toContain(`document.querySelector(${JSON.stringify(hostile)})`);
    expect(script).not.toContain(`querySelector(${hostile}`);
  }
});

test("locate/focus/exists scripts return the shapes the driver expects", () => {
  const locate = buildLocateScript("#go");
  expect(locate).toContain("scrollIntoView");
  expect(locate).toContain("found: true");
  expect(locate).toContain("x: Math.round");
  const focus = buildFocusScript("#q");
  expect(focus).toContain("el.focus()");
  const exists = buildExistsScript(".done");
  expect(exists).toContain("r.width > 0");
});

test("read script carries the caps and the selector-preference chain", () => {
  const script = buildReadScript();
  expect(script).toContain(`${READ_TEXT_CAP}`);
  expect(script).toContain(`${READ_INTERACTIVE_CAP}`);
  expect(script).toContain("data-testid");
  expect(script).toContain("aria-label");
  expect(script).toContain("nth-of-type");
  expect(script).toContain("location.href");
  // Caps are floored into the script even when passed as floats.
  expect(buildReadScript(100.9, 3.7)).toContain("100");
  expect(buildReadScript(100.9, 3.7)).toContain("3");
});
