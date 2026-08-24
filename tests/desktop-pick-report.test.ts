// Chantier OD5 (DESIGN-ORCA-DOOP-ADOPTION.md §3.5): pure-function coverage
// for shared/pick-prompt.ts's formatAnnotationsReport -- the batch report
// that folds up to PICK_BUDGET.annotationsMaxPerPage pinned elements into
// ONE structured `## Design Feedback` message. No DOM needed: the module
// only touches the global `URL` constructor, which bun provides natively.

import { expect, test } from "bun:test";
import { formatAnnotationsReport } from "../desktop/src/shared/pick-prompt.ts";
import type { ElementPick, PickAnnotation } from "../desktop/src/shared/types.ts";

/** Minimal valid ElementPick, overridable per test. */
function pick(overrides: Partial<ElementPick> = {}): ElementPick {
  return {
    tagName: "button",
    id: "",
    classes: [],
    text: "",
    selectors: [{ type: "css", value: "button.btn" }],
    width: 120,
    height: 40,
    pageUrl: "https://example.com/settings",
    ...overrides,
  };
}

/** Minimal valid PickAnnotation, overridable per test. */
function annotation(overrides: Partial<PickAnnotation> = {}): PickAnnotation {
  return {
    id: "a1",
    comment: "Make this button blue",
    intent: "change",
    priority: "suggestion",
    pick: pick(),
    ...overrides,
  };
}

test("formatAnnotationsReport: empty array yields ''", () => {
  expect(formatAnnotationsReport([], { url: "https://example.com/settings" })).toBe("");
});

test("formatAnnotationsReport: header carries the URL pathname, URL and (when present) viewport", () => {
  const out = formatAnnotationsReport([annotation()], {
    url: "https://example.com/settings?tab=billing",
    viewport: "375x667 – iPhone SE",
  });
  const lines = out.split("\n");
  // Query stripped everywhere (pick-security.ts's sanitizePickUrl
  // guarantee): an exact-line match, not `toContain`, because a substring
  // check would still pass if the query survived (it would just be a
  // longer string containing the same prefix) -- exact equality is what
  // actually proves the query is gone.
  expect(lines[0]).toBe("## Design Feedback: /settings");
  expect(lines[2]).toBe("URL: https://example.com/settings");
  expect(out).not.toContain("tab=billing");
  expect(out).toContain("Viewport: 375x667 – iPhone SE");
});

test("formatAnnotationsReport: header omits the Viewport line when not supplied", () => {
  const out = formatAnnotationsReport([annotation()], { url: "https://example.com/settings" });
  expect(out).not.toContain("Viewport:");
});

test("formatAnnotationsReport: an unparsable url falls back to the raw string in the heading", () => {
  const out = formatAnnotationsReport([annotation()], { url: "not-a-url" });
  expect(out.split("\n")[0]).toBe("## Design Feedback: not-a-url");
});

// A disallowed-protocol url (unlike an unparsable string) DOES parse -- it
// is simply rejected by sanitizePickUrl's protocol allowlist -- so it can
// carry a genuine embedded query, exactly the class of input the query-
// stripping guarantee exists to close. Falling back to the raw string here
// (as the parse-failure case correctly does) would re-leak it.
test("formatAnnotationsReport: a disallowed-protocol url falls back to a neutral label, never the raw string", () => {
  const out = formatAnnotationsReport([annotation()], {
    url: "data:text/html,x?access_token=leaked-abc",
  });
  const lines = out.split("\n");
  expect(lines[0]).toBe("## Design Feedback: current page");
  expect(lines[2]).toBe("URL: current page");
  expect(out).not.toContain("access_token=leaked-abc");
});

test("formatAnnotationsReport: sections are numbered in order, one per annotation", () => {
  const out = formatAnnotationsReport(
    [
      annotation({ id: "a1", pick: pick({ tagName: "button" }) }),
      annotation({ id: "a2", pick: pick({ tagName: "input" }) }),
      annotation({ id: "a3", pick: pick({ tagName: "a" }) }),
    ],
    { url: "https://example.com/settings" },
  );
  expect(out).toContain("### 1. button");
  expect(out).toContain("### 2. input");
  expect(out).toContain("### 3. a");
});

test("formatAnnotationsReport: element label prefers accessibleName, falls back to text, then bare tag", () => {
  const withName = formatAnnotationsReport(
    [annotation({ pick: pick({ tagName: "button", accessibleName: "Add to cart", text: "ignored" }) })],
    { url: "https://example.com/settings" },
  );
  expect(withName).toContain('### 1. button "Add to cart"');

  const withText = formatAnnotationsReport(
    [annotation({ pick: pick({ tagName: "button", text: "Buy now" }) })],
    { url: "https://example.com/settings" },
  );
  expect(withText).toContain('### 1. button "Buy now"');

  const bare = formatAnnotationsReport([annotation({ pick: pick({ tagName: "div" }) })], {
    url: "https://example.com/settings",
  });
  expect(bare).toContain("### 1. div");
  expect(bare).not.toContain('### 1. div "');
});

test("formatAnnotationsReport: Intent/Priority lines carry the annotation's own values, not the report defaults", () => {
  const out = formatAnnotationsReport(
    [annotation({ intent: "fix", priority: "blocking" })],
    { url: "https://example.com/settings" },
  );
  expect(out).toContain("Intent: fix");
  expect(out).toContain("Priority: blocking");
});

test("formatAnnotationsReport: Selector line uses the pick's best (first) selector", () => {
  const out = formatAnnotationsReport(
    [
      annotation({
        pick: pick({
          selectors: [
            { type: "qa", value: '[data-testid="submit"]' },
            { type: "css", value: "form > button" },
          ],
        }),
      }),
    ],
    { url: "https://example.com/settings" },
  );
  expect(out).toContain('Selector: [data-testid="submit"]');
  expect(out).not.toContain("Selector: form > button");
});

test("formatAnnotationsReport: Source/React lines only when present", () => {
  const withBoth = formatAnnotationsReport(
    [
      annotation({
        pick: pick({ sourceFile: "src/Card.tsx:12:3", reactComponents: "<App> > <Card>" }),
      }),
    ],
    { url: "https://example.com/settings" },
  );
  expect(withBoth).toContain("Source: src/Card.tsx:12:3");
  expect(withBoth).toContain("React: <App> > <Card>");

  const withNeither = formatAnnotationsReport([annotation()], { url: "https://example.com/settings" });
  expect(withNeither).not.toContain("Source:");
  expect(withNeither).not.toContain("React:");
});

test("formatAnnotationsReport: Bounds renders x/y/WxH, defaulting x/y to 0 when the pick omits them", () => {
  const withXY = formatAnnotationsReport(
    [annotation({ pick: pick({ x: 10, y: 20, width: 100, height: 50 }) })],
    { url: "https://example.com/settings" },
  );
  expect(withXY).toContain("Bounds: x=10, y=20, 100x50");

  const withoutXY = formatAnnotationsReport(
    [annotation({ pick: pick({ width: 100, height: 50 }) })],
    { url: "https://example.com/settings" },
  );
  expect(withoutXY).toContain("Bounds: x=0, y=0, 100x50");
});

test("formatAnnotationsReport: Styles block lists every entry as '- k: v', omitted when there are none", () => {
  const withStyles = formatAnnotationsReport(
    [annotation({ pick: pick({ styles: { display: "flex", color: "rgb(1, 2, 3)" } }) })],
    { url: "https://example.com/settings" },
  );
  expect(withStyles).toContain("Styles:");
  expect(withStyles).toContain("- display: flex");
  expect(withStyles).toContain("- color: rgb(1, 2, 3)");

  const withoutStyles = formatAnnotationsReport([annotation()], { url: "https://example.com/settings" });
  expect(withoutStyles).not.toContain("Styles:");
});

test("formatAnnotationsReport: Screenshot line only when annotation.screenshotPath is present", () => {
  const withShot = formatAnnotationsReport(
    [annotation({ screenshotPath: "/tmp/annotations/shot-1.png" })],
    { url: "https://example.com/settings" },
  );
  expect(withShot).toContain("Screenshot: /tmp/annotations/shot-1.png");

  const withoutShot = formatAnnotationsReport([annotation()], { url: "https://example.com/settings" });
  expect(withoutShot).not.toContain("Screenshot:");
});

test("formatAnnotationsReport: Feedback line carries the operator's comment verbatim", () => {
  const out = formatAnnotationsReport([annotation({ comment: "Nudge this left by 8px" })], {
    url: "https://example.com/settings",
  });
  expect(out).toContain("Feedback: Nudge this left by 8px");
});

test("formatAnnotationsReport: HTML fence marker outruns every backtick run embedded in the html", () => {
  const html = "<div>``` not a real fence, just ` backticks ```` here</div>";
  const out = formatAnnotationsReport([annotation({ pick: pick({ html }) })], {
    url: "https://example.com/settings",
  });
  expect(out).toContain("HTML:");
  // The longest embedded run is 4 backticks ("````"), so the fence marker
  // must be at least 5 -- and the opening/closing lines must share the SAME
  // marker (the opening line is marker+language, the closing is bare marker).
  const fenceLines = out.split("\n").filter((l) => /^`{4,}/.test(l));
  expect(fenceLines.length).toBe(2);
  const markerOf = (l: string): string => l.match(/^`+/)![0];
  const openMarker = markerOf(fenceLines[0]!);
  const closeMarker = markerOf(fenceLines[1]!);
  expect(openMarker).toBe(closeMarker);
  expect(fenceLines[0]).toBe(`${openMarker}html`);
  expect(fenceLines[1]).toBe(closeMarker);
  expect(openMarker.length).toBeGreaterThanOrEqual(5);
  expect(out).toContain(html);
});

test("formatAnnotationsReport: no HTML field omits the HTML section entirely", () => {
  const out = formatAnnotationsReport([annotation()], { url: "https://example.com/settings" });
  expect(out).not.toContain("HTML:");
});
