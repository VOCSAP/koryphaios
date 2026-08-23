// Chantier OD1/OD2 (DESIGN-ORCA-DOOP-ADOPTION.md §3.1/§3.4): DOM-level
// coverage for shared/element-pick.ts's enriched buildPick() and its
// exported helpers, plus the guest-side half of the redaction guarantee
// (a compromised page must not be able to smuggle a secret into the pick).
//
// happy-dom, registered globally -- see tests/desktop-explorer-selection-dom.test.ts's
// header comment for the measured cross-file blast radius of a missing
// GlobalRegistrator.unregister() (CORS breakage in every later fetch-using
// suite within this single `bun test` process). Paired register/unregister
// below, same discipline.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// A URL with a query and a hash lets the pageUrl-sanitization assertion run
// for real (happy-dom's register() accepts an initial `url`, so this needs
// no per-test location stubbing).
GlobalRegistrator.register({ url: "https://example.com/checkout?token=leaked-abc123#frag" });

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, expect, test } from "bun:test";
import {
  accessibleName,
  buildPick,
  pickAncestors,
  pickAttributes,
  pickNearbyText,
  pickStyles,
} from "../desktop/src/shared/element-pick.ts";
import { PICK_BUDGET } from "../desktop/src/shared/pick-security.ts";

/**
 * A realistic small fixture: #app > main.checkout > form > button, with two
 * text siblings on each side of the button. Rebuilt fresh per test (document
 * body cleared first) so DOM mutations in one test cannot leak into another.
 */
function buildFixture(): HTMLButtonElement {
  document.body.innerHTML = "";
  document.body.innerHTML = `
    <div id="app">
      <main class="checkout">
        <form>
          <div class="prev2">Extra</div>
          <div class="prev1">Qty</div>
          <button id="add-btn" type="submit" role="button" aria-label="Add to cart"
                  data-testid="add-to-cart-btn" data-foo="secret-token-xyz"
                  class="btn btn-primary" onclick="doEvil()"
                  style="display:flex;color:rgb(10, 20, 30);font-size:14px;">
            Add to cart
          </button>
          <div class="next1">Remove</div>
          <div class="next2">More</div>
        </form>
      </main>
    </div>
  `;
  return document.getElementById("add-btn") as HTMLButtonElement;
}

test("buildPick: pageUrl is sanitized (query + hash stripped)", () => {
  const btn = buildFixture();
  const pick = buildPick(btn);
  expect(pick.pageUrl).toBe("https://example.com/checkout");
});

test("buildPick: role and accessibleName captured", () => {
  const btn = buildFixture();
  const pick = buildPick(btn);
  expect(pick.role).toBe("button");
  expect(pick.accessibleName).toBe("Add to cart");
});

test("buildPick: attributes are allowlisted and capped; onclick is NOT kept", () => {
  const btn = buildFixture();
  const pick = buildPick(btn);
  expect(pick.attributes).toBeDefined();
  expect(pick.attributes!["aria-label"]).toBe("Add to cart");
  expect(pick.attributes!.type).toBe("submit");
  expect(pick.attributes!.role).toBe("button");
  expect(pick.attributes).not.toHaveProperty("onclick");
  expect(pick.attributes).not.toHaveProperty("class"); // class is a top-level field, not in the attribute allowlist
});

test("buildPick: a selector whose value contains a secret is dropped, not just its own attribute", () => {
  const btn = buildFixture();
  const pick = buildPick(btn);
  const values = pick.selectors.map((s) => s.value);
  expect(values.some((v) => v.includes("secret-token-xyz"))).toBe(false);
  // The QA selector (data-testid) survives -- it carries no secret pattern.
  expect(values.some((v) => v.includes("add-to-cart-btn"))).toBe(true);
});

test("buildPick: styles keep explicit signal, drop defaults", () => {
  const btn = buildFixture();
  const pick = buildPick(btn);
  expect(pick.styles).toBeDefined();
  expect(pick.styles!.display).toBe("flex");
  expect(pick.styles!["font-size"]).toBe("14px");
  // position was never set -> computed default 'static' -> filtered out.
  expect(pick.styles).not.toHaveProperty("position");
});

test("buildPick: nearbyText picks up to 2 previous + 2 next sibling texts", () => {
  const btn = buildFixture();
  const pick = buildPick(btn);
  expect(pick.nearbyText).toBeDefined();
  expect(pick.nearbyText!.length).toBeLessThanOrEqual(PICK_BUDGET.nearbyTextMaxEntries);
  const joined = pick.nearbyText!.join("|");
  expect(joined).toContain("Qty");
  expect(joined).toContain("Remove");
});

test("buildPick: ancestors are readable labels, outermost first", () => {
  const btn = buildFixture();
  const pick = buildPick(btn);
  expect(pick.ancestors).toEqual(["#app", "main.checkout", "form"]);
});

test("buildPick: html is capped and omitted when it contains a secret (input value with api_key)", () => {
  document.body.innerHTML = "";
  document.body.innerHTML = `<input id="secret-input" value="api_key=verysecretvalue1234567890" />`;
  const input = document.getElementById("secret-input") as HTMLElement;
  const pick = buildPick(input as HTMLButtonElement);
  expect(pick.html).toBeUndefined();
});

test("buildPick: html is present and capped for an ordinary element", () => {
  document.body.innerHTML = "";
  document.body.innerHTML = `<div id="plain">${"x".repeat(3000)}</div>`;
  const div = document.getElementById("plain") as HTMLElement;
  const pick = buildPick(div as HTMLButtonElement);
  expect(pick.html).toBeDefined();
  expect(pick.html!.length).toBeLessThanOrEqual(PICK_BUDGET.htmlMaxLength + 2);
});

test("buildPick: id and text are redacted when they contain a secret", () => {
  document.body.innerHTML = "";
  document.body.innerHTML = `<div id="csrf_token_field">some session_id value here</div>`;
  const div = document.getElementById("csrf_token_field") as HTMLElement;
  const pick = buildPick(div as HTMLButtonElement);
  expect(pick.id).toBe("");
  expect(pick.text).toBe("[redacted]");
});

test("isFixed: true when position:fixed appears anywhere in the ancestry", () => {
  document.body.innerHTML = "";
  document.body.innerHTML = `
    <div id="header" style="position:fixed;">
      <span id="inner">Menu</span>
    </div>
  `;
  const inner = document.getElementById("inner") as HTMLElement;
  const pick = buildPick(inner as HTMLButtonElement);
  expect(pick.isFixed).toBe(true);
});

test("isFixed: false for a plain, non-fixed element", () => {
  document.body.innerHTML = "";
  document.body.innerHTML = `<div id="plain2">hi</div>`;
  const div = document.getElementById("plain2") as HTMLElement;
  const pick = buildPick(div as HTMLButtonElement);
  expect(pick.isFixed).toBe(false);
});

// ----- Individual helper units (spec asks each be small and testable) -----

test("accessibleName: aria-label takes precedence over alt/title", () => {
  document.body.innerHTML = "";
  document.body.innerHTML = `<img id="i1" aria-label="Primary" alt="ignored-alt" title="ignored-title" />`;
  const el = document.getElementById("i1") as HTMLElement;
  expect(accessibleName(el)).toBe("Primary");
});

test("accessibleName: aria-labelledby resolves referenced ids, joined by space", () => {
  document.body.innerHTML = "";
  document.body.innerHTML = `
    <span id="lbl1">Hello</span>
    <span id="lbl2">World</span>
    <img id="i2" aria-labelledby="lbl1 lbl2" alt="ignored" />
  `;
  const el = document.getElementById("i2") as HTMLElement;
  expect(accessibleName(el)).toBe("Hello World");
});

test("accessibleName: falls back to alt, then title, when no aria attributes", () => {
  document.body.innerHTML = "";
  document.body.innerHTML = `<img id="i3" alt="Alt text" title="ignored-title" />`;
  expect(accessibleName(document.getElementById("i3") as HTMLElement)).toBe("Alt text");

  document.body.innerHTML = `<span id="i4" title="Title only"></span>`;
  expect(accessibleName(document.getElementById("i4") as HTMLElement)).toBe("Title only");
});

test("accessibleName: empty when none of the sources are present", () => {
  document.body.innerHTML = "";
  document.body.innerHTML = `<div id="i5"></div>`;
  expect(accessibleName(document.getElementById("i5") as HTMLElement)).toBe("");
});

test("pickAttributes: unset element yields undefined (skip empty results)", () => {
  document.body.innerHTML = "";
  document.body.innerHTML = `<div id="bare"></div>`;
  expect(pickAttributes(document.getElementById("bare") as HTMLElement)).toBeUndefined();
});

test("pickStyles: unfiltered signal survives, defaults are dropped", () => {
  document.body.innerHTML = "";
  document.body.innerHTML = `<div id="styled" style="margin:0px;padding:0px;color:rgb(1, 2, 3);"></div>`;
  const styles = pickStyles(document.getElementById("styled") as HTMLElement);
  expect(styles).toBeDefined();
  expect(styles!.color).toBe("rgb(1, 2, 3)");
  expect(styles).not.toHaveProperty("margin");
  expect(styles).not.toHaveProperty("padding");
});

test("pickNearbyText: no siblings yields undefined", () => {
  document.body.innerHTML = "";
  document.body.innerHTML = `<div id="lonely"></div>`;
  expect(pickNearbyText(document.getElementById("lonely") as HTMLElement)).toBeUndefined();
});

test("pickAncestors: element directly under body yields undefined (nothing between parent and body)", () => {
  document.body.innerHTML = "";
  document.body.innerHTML = `<div id="topLevel"></div>`;
  expect(pickAncestors(document.getElementById("topLevel") as HTMLElement)).toBeUndefined();
});

test("pickAttributes: entry count is capped guest-side (webview picks never cross sanitizePick)", () => {
  document.body.innerHTML = "";
  const attrs = Array.from({ length: 40 }, (_, i) => `aria-x${i}="v${i}"`).join(" ");
  document.body.innerHTML = `<div id="many" ${attrs}></div>`;
  const out = pickAttributes(document.getElementById("many") as HTMLElement);
  expect(out).toBeDefined();
  expect(Object.keys(out!).length).toBeLessThanOrEqual(PICK_BUDGET.attributesMaxEntries);
});

test("pickAncestors: an arbitrarily long ancestor id is capped to the whole-entry bound", () => {
  document.body.innerHTML = "";
  const longId = "x".repeat(500);
  document.body.innerHTML = `<div id="${longId}"><span id="deep"></span></div>`;
  const ancestors = pickAncestors(document.getElementById("deep") as HTMLElement);
  expect(ancestors).toBeDefined();
  for (const label of ancestors!) {
    expect(label.length).toBeLessThanOrEqual(PICK_BUDGET.ancestorEntryMaxLength);
  }
});
