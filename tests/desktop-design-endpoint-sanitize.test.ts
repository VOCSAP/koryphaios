// Chantier OD1/OD2: sanitizePick() is the main-side re-validation of an
// UNTRUSTED body POSTed to the design endpoint by an external app's
// deck-design.js client (see design-endpoint.ts's own header comment on why
// this exists: "the page is an adversary", §3.4 of
// DESIGN-ORCA-DOOP-ADOPTION.md). Pure module (node:http/crypto only), no DOM
// needed -- imported directly.

import { expect, test } from "bun:test";
import { sanitizePick } from "../desktop/src/main/design-endpoint.ts";
import { PICK_BUDGET } from "../desktop/src/shared/pick-security.ts";

test("null/non-object/missing tagName all yield null", () => {
  expect(sanitizePick(null)).toBeNull();
  expect(sanitizePick(undefined)).toBeNull();
  expect(sanitizePick("hi")).toBeNull();
  expect(sanitizePick(42)).toBeNull();
  expect(sanitizePick({})).toBeNull();
  expect(sanitizePick({ tagName: "" })).toBeNull();
});

test("a minimal legacy pick (pre-OD1, no enriched fields) still sanitizes cleanly", () => {
  const pick = sanitizePick({
    tagName: "button",
    id: "submit",
    classes: ["btn", "btn-primary"],
    text: "Submit",
    selectors: [{ type: "id", value: "#submit" }],
    width: 80,
    height: 32,
    pageUrl: "https://example.com/checkout",
  });
  expect(pick).not.toBeNull();
  expect(pick!.tagName).toBe("button");
  expect(pick!.id).toBe("submit");
  expect(pick!.pageUrl).toBe("https://example.com/checkout");
  // Absent optional fields stay undefined, never defaulted to {} / [] / ''.
  expect(pick!.x).toBeUndefined();
  expect(pick!.y).toBeUndefined();
  expect(pick!.isFixed).toBeUndefined();
  expect(pick!.role).toBeUndefined();
  expect(pick!.accessibleName).toBeUndefined();
  expect(pick!.attributes).toBeUndefined();
  expect(pick!.styles).toBeUndefined();
  expect(pick!.html).toBeUndefined();
  expect(pick!.nearbyText).toBeUndefined();
  expect(pick!.ancestors).toBeUndefined();
});

test("huge strings are capped to their PICK_BUDGET length", () => {
  const hugeText = "x".repeat(5000);
  const pick = sanitizePick({
    tagName: "div",
    text: hugeText,
    id: "y".repeat(500),
    pageUrl: "https://example.com/" + "z".repeat(2000),
  });
  expect(pick).not.toBeNull();
  expect(pick!.text.length).toBe(PICK_BUDGET.textMaxLength);
  expect(pick!.id.length).toBe(PICK_BUDGET.idMaxLength);
  // pageUrl is capped BEFORE sanitizePickUrl re-serializes it; the sanitized
  // result stays a valid, well-formed URL under that cap.
  expect(pick!.pageUrl.length).toBeLessThanOrEqual(PICK_BUDGET.pageUrlMaxLength);
});

test("wrong types are dropped, not coerced", () => {
  const pick = sanitizePick({
    tagName: "span",
    id: 12345,
    classes: "not-an-array",
    text: { nested: true },
    selectors: "not-an-array-either",
    width: "80px",
    height: null,
    isFixed: "yes",
    x: "10",
    attributes: "not-an-object",
    styles: ["not", "a", "record"],
    nearbyText: "not-an-array",
  });
  expect(pick).not.toBeNull();
  expect(pick!.id).toBe(""); // number rejected by str()
  expect(pick!.classes).toEqual([]);
  expect(pick!.text).toBe(""); // object rejected by str()
  expect(pick!.selectors).toEqual([]);
  expect(pick!.width).toBe(0);
  expect(pick!.height).toBe(0);
  expect(pick!.isFixed).toBeUndefined(); // "yes" is not a boolean
  expect(pick!.x).toBeUndefined(); // "10" is not a number
  expect(pick!.attributes).toBeUndefined();
  expect(pick!.styles).toBeUndefined();
  expect(pick!.nearbyText).toBeUndefined();
});

test("secret-bearing id and text are redacted", () => {
  const pick = sanitizePick({
    tagName: "input",
    id: "api_key_field",
    text: "current session_id: abc123",
  });
  expect(pick).not.toBeNull();
  expect(pick!.id).toBe(""); // id redaction: replaced with ''
  expect(pick!.text).toBe("[redacted]"); // text redaction: replaced with the marker
});

test("attributes outside the allowlist are dropped; aria-* and allowlisted names survive", () => {
  const pick = sanitizePick({
    tagName: "button",
    attributes: {
      onclick: "doEvil()",
      style: "color: red",
      href: "https://example.com/go?ref=abc",
      "aria-label": "Add to cart",
      type: "submit",
    },
  });
  expect(pick).not.toBeNull();
  expect(pick!.attributes).toBeDefined();
  expect(pick!.attributes!.onclick).toBeUndefined();
  expect(pick!.attributes!.style).toBeUndefined();
  expect(pick!.attributes!.href).toBe("https://example.com/go"); // query stripped
  expect(pick!.attributes!["aria-label"]).toBe("Add to cart");
  expect(pick!.attributes!.type).toBe("submit");
});

test("attribute values containing a secret are redacted, not dropped", () => {
  const pick = sanitizePick({
    tagName: "div",
    attributes: { title: "your api_key is exposed here" },
  });
  expect(pick!.attributes!.title).toBe("[redacted]");
});

test("href/src attribute values with a disallowed protocol are dropped entirely", () => {
  const pick = sanitizePick({
    tagName: "a",
    attributes: { href: "javascript:alert(1)", title: "click me" },
  });
  expect(pick!.attributes!.href).toBeUndefined();
  expect(pick!.attributes!.title).toBe("click me");
});

test("nearbyText: non-array input is ignored (stays undefined), array is capped and secret entries skipped", () => {
  const notArray = sanitizePick({ tagName: "div", nearbyText: "Qty" });
  expect(notArray!.nearbyText).toBeUndefined();

  const withArray = sanitizePick({
    tagName: "div",
    nearbyText: ["Qty", "Remove", "contains a password field", "Extra1", "Extra2", "Extra3"],
  });
  expect(withArray!.nearbyText).toBeDefined();
  expect(withArray!.nearbyText!.length).toBeLessThanOrEqual(PICK_BUDGET.nearbyTextMaxEntries);
  expect(withArray!.nearbyText).not.toContain("contains a password field");
});

test("ancestors: capped at PICK_BUDGET.ancestorsMaxEntries", () => {
  const many = Array.from({ length: 20 }, (_, i) => `div.level-${i}`);
  const pick = sanitizePick({ tagName: "span", ancestors: many });
  expect(pick!.ancestors!.length).toBe(PICK_BUDGET.ancestorsMaxEntries);
});

test("styles: capped at PICK_BUDGET.stylesMaxEntries, non-string values dropped", () => {
  const styles: Record<string, unknown> = { color: "red" };
  for (let i = 0; i < 40; i++) styles[`prop-${i}`] = "value";
  styles.badValue = 42;
  const pick = sanitizePick({ tagName: "div", styles });
  expect(Object.keys(pick!.styles!).length).toBeLessThanOrEqual(PICK_BUDGET.stylesMaxEntries);
  expect(pick!.styles!.badValue).toBeUndefined();
});

test("html: capped and secret-bearing html is omitted entirely (not truncated-and-kept)", () => {
  const longHtml = `<div>${"a".repeat(3000)}</div>`;
  const withLongHtml = sanitizePick({ tagName: "div", html: longHtml });
  expect(withLongHtml!.html).toBeDefined();
  expect(withLongHtml!.html!.length).toBeLessThanOrEqual(PICK_BUDGET.htmlMaxLength + 2);

  const secretHtml = `<input value="api_key=abc123">`;
  const withSecret = sanitizePick({ tagName: "input", html: secretHtml });
  expect(withSecret!.html).toBeUndefined();
});

test("x/y/isFixed/role/accessibleName round-trip when well-typed", () => {
  const pick = sanitizePick({
    tagName: "button",
    x: 12.6,
    y: 40.4,
    isFixed: true,
    role: "button",
    accessibleName: "Add to cart",
  });
  expect(pick!.x).toBe(13);
  expect(pick!.y).toBe(40);
  expect(pick!.isFixed).toBe(true);
  expect(pick!.role).toBe("button");
  expect(pick!.accessibleName).toBe("Add to cart");
});

test("selectors: dropped entries with a secret-bearing value do not survive", () => {
  const pick = sanitizePick({
    tagName: "div",
    selectors: [
      { type: "attr", value: '[data-foo="secret-token-abc"]' },
      { type: "css", value: "div.card > button" },
    ],
  });
  expect(pick!.selectors.length).toBe(1);
  expect(pick!.selectors[0]!.value).toBe("div.card > button");
});

test("styles: oversized or empty KEYS are dropped (attacker-controlled, no allowlist bounds them)", () => {
  const pick = sanitizePick({
    tagName: "div",
    styles: {
      color: "red",
      ["k".repeat(500)]: "payload that must not ride into the prompt",
      "": "empty key",
    },
  });
  expect(pick!.styles).toBeDefined();
  expect(Object.keys(pick!.styles!)).toEqual(["color"]);
});

// ----- OD3 fields: reactComponents / sourceFile -----

test("reactComponents/sourceFile round-trip when well-typed", () => {
  const pick = sanitizePick({
    tagName: "button",
    reactComponents: "<App> > <ProductList> > <ProductCard>",
    sourceFile: "src/components/ProductCard.tsx:42:7",
  });
  expect(pick).not.toBeNull();
  expect(pick!.reactComponents).toBe("<App> > <ProductList> > <ProductCard>");
  expect(pick!.sourceFile).toBe("src/components/ProductCard.tsx:42:7");
});

test("reactComponents/sourceFile: oversized values are capped to their PICK_BUDGET length", () => {
  const pick = sanitizePick({
    tagName: "div",
    reactComponents: "<Comp>".repeat(100),
    sourceFile: "src/" + "x".repeat(1000) + ".tsx:1:1",
  });
  expect(pick!.reactComponents!.length).toBe(PICK_BUDGET.reactComponentsMaxLength);
  expect(pick!.sourceFile!.length).toBe(PICK_BUDGET.sourceFileMaxLength);
});

test("sourceFile carrying a secret pattern is dropped entirely, not redacted", () => {
  const pick = sanitizePick({
    tagName: "div",
    reactComponents: "<App> > <Widget>",
    sourceFile: "src/api_key/Widget.tsx:10:3",
  });
  expect(pick).not.toBeNull();
  expect(pick!.sourceFile).toBeUndefined();
  // A secret in sourceFile does not take reactComponents down with it.
  expect(pick!.reactComponents).toBe("<App> > <Widget>");
});

test("reactComponents carrying a secret pattern is dropped entirely", () => {
  const pick = sanitizePick({
    tagName: "div",
    reactComponents: "<App> > <ApiKeyDisplay password=\"x\">",
  });
  expect(pick!.reactComponents).toBeUndefined();
});

test("reactComponents/sourceFile: non-string values are ignored", () => {
  const pick = sanitizePick({
    tagName: "div",
    reactComponents: 42,
    sourceFile: { fileName: "x.tsx" },
  });
  expect(pick).not.toBeNull();
  expect(pick!.reactComponents).toBeUndefined();
  expect(pick!.sourceFile).toBeUndefined();
});

test("a legacy pick without reactComponents/sourceFile leaves both absent", () => {
  const pick = sanitizePick({ tagName: "div" });
  expect(pick).not.toBeNull();
  expect(pick!.reactComponents).toBeUndefined();
  expect(pick!.sourceFile).toBeUndefined();
});
