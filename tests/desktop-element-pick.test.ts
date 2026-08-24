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
  createInspectMode,
  pickAncestors,
  pickAttributes,
  pickNearbyText,
  pickReactContext,
  pickStyles,
} from "../desktop/src/shared/element-pick.ts";
import { PICK_BUDGET } from "../desktop/src/shared/pick-security.ts";
import type { ElementPick } from "../desktop/src/shared/types.ts";

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

// ----- pickReactContext (Chantier OD3, DESIGN-ORCA-DOOP-ADOPTION.md §3.2) -----
// React attaches its fiber node to a DOM element under a `__reactFiber$<id>`
// (or legacy `__reactInternalInstance$<id>`) own property. These tests plant
// a FAKE fiber chain (plain objects -- no react dependency) to exercise the
// walk without a real React runtime.

test("pickReactContext: component stack outermost-first, sourceFile from _debugSource", () => {
  document.body.innerHTML = "";
  document.body.innerHTML = `<div id="react-target"></div>`;
  const el = document.getElementById("react-target") as HTMLElement;
  (el as any)["__reactFiber$abc"] = {
    type: "button",
    return: {
      type: function ProductCard() {},
      _debugSource: {
        fileName: "webpack:///./src/components/ProductCard.tsx",
        lineNumber: 42,
        columnNumber: 7,
      },
      return: {
        type: { displayName: "ProductList" },
        return: {
          type: function App() {},
          return: null,
        },
      },
    },
  };
  const ctx = pickReactContext(el);
  expect(ctx).toBeDefined();
  expect(ctx!.components).toBe("<App> > <ProductList> > <ProductCard>");
  expect(ctx!.sourceFile).toBe("src/components/ProductCard.tsx:42:7");
});

test("pickReactContext: no fiber key on the element yields undefined", () => {
  document.body.innerHTML = "";
  document.body.innerHTML = `<div id="no-react"></div>`;
  const el = document.getElementById("no-react") as HTMLElement;
  expect(pickReactContext(el)).toBeUndefined();
});

test("pickReactContext: skip-list names (Provider, Fragment) are excluded from the stack", () => {
  document.body.innerHTML = "";
  document.body.innerHTML = `<div id="skip-target"></div>`;
  const el = document.getElementById("skip-target") as HTMLElement;
  (el as any)["__reactFiber$xyz"] = {
    type: function Provider() {},
    return: {
      type: function Fragment() {},
      return: {
        type: function RealComponent() {},
        return: null,
      },
    },
  };
  const ctx = pickReactContext(el);
  expect(ctx).toBeDefined();
  expect(ctx!.components).toBe("<RealComponent>");
});

test("pickReactContext: a fiber property access that throws yields undefined, not an exception", () => {
  document.body.innerHTML = "";
  document.body.innerHTML = `<div id="throwing"></div>`;
  const el = document.getElementById("throwing") as HTMLElement;
  Object.defineProperty(el, "__reactFiber$boom", {
    enumerable: true,
    configurable: true,
    get() {
      throw new Error("hostile getter");
    },
  });
  expect(() => pickReactContext(el)).not.toThrow();
  expect(pickReactContext(el)).toBeUndefined();
});

test("pickReactContext: sourceFile whose cleaned path contains a secret pattern is dropped, components survive", () => {
  document.body.innerHTML = "";
  document.body.innerHTML = `<div id="secret-source"></div>`;
  const el = document.getElementById("secret-source") as HTMLElement;
  (el as any)["__reactFiber$sec"] = {
    type: function Widget() {},
    _debugSource: { fileName: "src/api_key/Widget.tsx", lineNumber: 10, columnNumber: 3 },
    return: null,
  };
  const ctx = pickReactContext(el);
  expect(ctx).toBeDefined();
  expect(ctx!.sourceFile).toBeUndefined();
  expect(ctx!.components).toBe("<Widget>");
});

test("pickReactContext: depth cap (35) stops the walk on a 100-deep chain", () => {
  document.body.innerHTML = "";
  document.body.innerHTML = `<div id="deep-chain"></div>`;
  const el = document.getElementById("deep-chain") as HTMLElement;
  function DeepComponent() {}
  function XWrapper() {}
  // Build a 100-fiber-deep return chain. Every node uses a skip-listed name
  // ("XWrapper" ends in the skipped "Wrapper" suffix) except one, 49 hops up
  // the chain -- well past the 35-deep walk cap -- so it must never be
  // collected and no sourceFile exists anywhere in the chain either.
  let fiber: any = null;
  for (let i = 0; i < 100; i++) {
    fiber = { type: i === 50 ? DeepComponent : XWrapper, return: fiber };
  }
  (el as any)["__reactFiber$deep"] = fiber;
  expect(pickReactContext(el)).toBeUndefined();
});

// ----- Hover shortcuts C/S (Chantier OD6, DESIGN-ORCA-DOOP-ADOPTION.md §3.6) -----
// createInspectMode installs document-level capture-phase listeners on
// enter() and removes them on exit(); every test below calls mode.exit()
// itself (even when the code under test is also expected to have exited)
// so a forgotten listener can never leak into a later test in this file.

function hover(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
}

function key(k: string, opts: Partial<KeyboardEventInit> = {}): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...opts }));
}

test("createInspectMode: C picks the hovered element without ever dispatching a click", () => {
  document.body.innerHTML = "";
  document.body.innerHTML = `<button id="hoverable">Menu</button>`;
  const btn = document.getElementById("hoverable") as HTMLButtonElement;
  let clicked = false;
  btn.addEventListener("click", () => {
    clicked = true;
  });

  const picks: ElementPick[] = [];
  let exited = 0;
  const mode = createInspectMode({
    onPick: (pick) => picks.push(pick),
    onExit: () => exited++,
  });
  mode.enter();
  hover(btn);
  key("c");

  expect(picks).toHaveLength(1);
  expect(picks[0]!.tagName).toBe("button");
  expect(exited).toBe(1);
  expect(clicked).toBe(false);

  mode.exit();
});

test("createInspectMode: S screenshots the hovered element via onShot, when provided", () => {
  document.body.innerHTML = "";
  document.body.innerHTML = `<div id="shootable">Card</div>`;
  const div = document.getElementById("shootable") as HTMLElement;

  const shots: ElementPick[] = [];
  const picks: ElementPick[] = [];
  let exited = 0;
  const mode = createInspectMode({
    onPick: (pick) => picks.push(pick),
    onExit: () => exited++,
    onShot: (pick) => shots.push(pick),
  });
  mode.enter();
  hover(div);
  key("s");

  expect(shots).toHaveLength(1);
  expect(shots[0]!.tagName).toBe("div");
  expect(picks).toHaveLength(0);
  expect(exited).toBe(1);

  mode.exit();
});

test("createInspectMode: S with no onShot handler does nothing -- stays armed, a later click still picks", () => {
  document.body.innerHTML = "";
  document.body.innerHTML = `<div id="noshot">Card</div>`;
  const div = document.getElementById("noshot") as HTMLElement;

  const picks: ElementPick[] = [];
  let exited = 0;
  const mode = createInspectMode({
    onPick: (pick) => picks.push(pick),
    onExit: () => exited++,
    // onShot intentionally omitted -- mirrors the external deck-design client.
  });
  mode.enter();
  hover(div);
  key("s");

  expect(picks).toHaveLength(0);
  expect(exited).toBe(0);

  // Still armed: a plain click keeps working exactly as before.
  div.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(picks).toHaveLength(1);
  expect(exited).toBe(1);

  mode.exit();
});

test("createInspectMode: C with ctrlKey is ignored -- stays armed", () => {
  document.body.innerHTML = "";
  document.body.innerHTML = `<div id="modified">Card</div>`;
  const div = document.getElementById("modified") as HTMLElement;

  const picks: ElementPick[] = [];
  let exited = 0;
  const mode = createInspectMode({
    onPick: (pick) => picks.push(pick),
    onExit: () => exited++,
  });
  mode.enter();
  hover(div);
  key("c", { ctrlKey: true });

  expect(picks).toHaveLength(0);
  expect(exited).toBe(0);

  // Still armed: the same key without the modifier now picks.
  key("c");
  expect(picks).toHaveLength(1);
  expect(exited).toBe(1);

  mode.exit();
});

test("createInspectMode: C with no hovered element is ignored -- stays armed", () => {
  document.body.innerHTML = "";
  document.body.innerHTML = `<div id="unhovered">Card</div>`;

  const picks: ElementPick[] = [];
  let exited = 0;
  const mode = createInspectMode({
    onPick: (pick) => picks.push(pick),
    onExit: () => exited++,
  });
  mode.enter();
  key("c"); // nothing hovered yet

  expect(picks).toHaveLength(0);
  expect(exited).toBe(0);

  mode.exit();
});

test("buildPick: carries reactComponents + sourceFile end-to-end from a fake fiber chain", () => {
  document.body.innerHTML = "";
  document.body.innerHTML = `<button id="react-btn">Buy</button>`;
  const btn = document.getElementById("react-btn") as HTMLButtonElement;
  (btn as any)["__reactFiber$e2e"] = {
    type: "button",
    return: {
      type: function ProductCard() {},
      _debugSource: {
        fileName: "webpack:///./src/components/ProductCard.tsx",
        lineNumber: 42,
        columnNumber: 7,
      },
      return: {
        type: { displayName: "ProductList" },
        return: {
          type: function App() {},
          return: null,
        },
      },
    },
  };
  const pick = buildPick(btn);
  expect(pick.reactComponents).toBe("<App> > <ProductList> > <ProductCard>");
  expect(pick.sourceFile).toBe("src/components/ProductCard.tsx:42:7");
});

// ----- Multi-shot review mode (Chantier OD5, DESIGN-ORCA-DOOP-ADOPTION.md
// §3.5): createInspectMode({ ... }, { multi: true }) stays armed after a
// delivered pick -- only Escape (or the host calling exit() itself) tears
// down. Single-shot default (opts omitted) is asserted unchanged by every
// test ABOVE this section, which pass no second argument at all.

test("createInspectMode multi: two clicks each deliver a pick, onExit is never called", () => {
  document.body.innerHTML = "";
  document.body.innerHTML = `<div id="one">One</div><div id="two">Two</div>`;
  const one = document.getElementById("one") as HTMLElement;
  const two = document.getElementById("two") as HTMLElement;

  const picks: ElementPick[] = [];
  let exited = 0;
  const mode = createInspectMode(
    {
      onPick: (pick) => picks.push(pick),
      onExit: () => exited++,
    },
    { multi: true },
  );
  mode.enter();
  one.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  two.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

  expect(picks).toHaveLength(2);
  expect(picks[0]!.id).toBe("one");
  expect(picks[1]!.id).toBe("two");
  expect(exited).toBe(0);

  mode.exit();
});

test("createInspectMode multi: Escape tears down and calls onExit exactly once", () => {
  document.body.innerHTML = "";
  document.body.innerHTML = `<div id="only">Only</div>`;
  const only = document.getElementById("only") as HTMLElement;

  const picks: ElementPick[] = [];
  let exited = 0;
  const mode = createInspectMode(
    {
      onPick: (pick) => picks.push(pick),
      onExit: () => exited++,
    },
    { multi: true },
  );
  mode.enter();
  only.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  key("Escape");

  expect(picks).toHaveLength(1);
  expect(exited).toBe(1);

  // Idempotent: a second exit() (e.g. the host's own cleanup) is a no-op.
  mode.exit();
});

test("createInspectMode multi: C hover-shortcut also stays armed across repeated picks", () => {
  document.body.innerHTML = "";
  document.body.innerHTML = `<div id="hv">Hover me</div>`;
  const div = document.getElementById("hv") as HTMLElement;

  const picks: ElementPick[] = [];
  let exited = 0;
  const mode = createInspectMode(
    {
      onPick: (pick) => picks.push(pick),
      onExit: () => exited++,
    },
    { multi: true },
  );
  mode.enter();
  hover(div);
  key("c");
  key("c");

  expect(picks).toHaveLength(2);
  expect(exited).toBe(0);

  mode.exit();
});
