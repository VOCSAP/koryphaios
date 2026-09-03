import { expect, test } from "bun:test";
import {
  annotationToCardFields,
  cardTitle,
  intentToKind,
  pickNoteToCardSeed,
  priorityToRoadmap,
} from "../desktop/src/shared/pick-card.ts";
import type { ElementPick, PickAnnotation, PickNote } from "../desktop/src/shared/types.ts";

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

// ---------------------------------------------------------------------------
// intentToKind / priorityToRoadmap: every mapping value, spelled out so a
// silent remap (not just a missing case) fails the test.
// ---------------------------------------------------------------------------

test("intentToKind: every PickAnnotationIntent maps to its RoadmapKind", () => {
  expect(intentToKind("fix")).toBe("bug");
  expect(intentToKind("change")).toBe("feature");
  expect(intentToKind("question")).toBe("idea");
  expect(intentToKind("approve")).toBe("idea");
});

test("priorityToRoadmap: every PickAnnotationPriority maps to its MoSCoW RoadmapPriority", () => {
  expect(priorityToRoadmap("blocking")).toBe("must");
  expect(priorityToRoadmap("important")).toBe("should");
  expect(priorityToRoadmap("suggestion")).toBe("could");
});

// ---------------------------------------------------------------------------
// cardTitle
// ---------------------------------------------------------------------------

test("cardTitle: uses the first 8 words of the comment, ellipsised, when there is one", () => {
  const a = annotation({ comment: "This button should be blue instead of the current dull grey shade please" });
  expect(cardTitle(a, { url: "https://example.com/settings" })).toBe("This button should be blue instead of the…");
});

test("cardTitle: a short comment (<= 8 words) is not ellipsised", () => {
  const a = annotation({ comment: "Make this blue" });
  expect(cardTitle(a, { url: "https://example.com/settings" })).toBe("Make this blue");
});

test("cardTitle: falls back to '<label> on <pathname>' when the comment is empty or whitespace-only", () => {
  const a = annotation({ comment: "   ", pick: pick({ tagName: "button", accessibleName: "Save" }) });
  expect(cardTitle(a, { url: "https://example.com/settings" })).toBe('button "Save" on /settings');
});

test("cardTitle: fallback pathname strips query/fragment (sanitizePickUrl) and falls back to 'page' when unparsable", () => {
  const a = annotation({ comment: "", pick: pick({ tagName: "div" }) });
  expect(cardTitle(a, { url: "https://example.com/settings?tab=billing#x" })).toBe("div on /settings");
  expect(cardTitle(a, { url: "not-a-url" })).toBe("div on page");
});

test("cardTitle: region annotation with no comment falls back to the region label", () => {
  const a: PickAnnotation = {
    id: "r1",
    comment: "",
    intent: "fix",
    priority: "important",
    region: { x: 0, y: 0, width: 10, height: 10, tool: "circle", pageUrl: "https://example.com/x" },
  };
  expect(cardTitle(a, { url: "https://example.com/x" })).toBe("circled region on /x");
});

test("cardTitle: caps at 120 characters", () => {
  const longComment = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
  const a = annotation({ comment: longComment });
  const title = cardTitle(a, { url: "https://example.com/settings" });
  expect(title.length).toBeLessThanOrEqual(120);
});

test("cardTitle: never empty even in the most degenerate case (no comment, no tagName, no url)", () => {
  const a = annotation({ comment: "", pick: pick({ tagName: "" }) });
  const title = cardTitle(a, { url: "not-a-url" });
  expect(title.length).toBeGreaterThan(0);
  expect(title.trim().length).toBeGreaterThan(0);
});

test("cardTitle: accepts the { pick, note } shape used by the single-pick dialog", () => {
  const note: PickNote = { comment: "Nudge this left", intent: "change" };
  expect(cardTitle({ pick: pick(), note }, { url: "https://example.com/settings" })).toBe("Nudge this left");

  const emptyNote: PickNote = { comment: "" };
  expect(cardTitle({ pick: pick({ tagName: "a" }), note: emptyNote }, { url: "https://example.com/settings" })).toBe(
    "a on /settings",
  );
});

// ---------------------------------------------------------------------------
// annotationToCardFields
// ---------------------------------------------------------------------------

test("annotationToCardFields: fields object has exactly the expected keys, no more, no less", () => {
  const fields = annotationToCardFields(annotation(), { url: "https://example.com/settings" });
  expect(Object.keys(fields).sort()).toEqual(
    ["context", "description", "kind", "priority", "status", "tags", "title"].sort(),
  );
});

test("annotationToCardFields: kind/priority/status/tags are derived correctly, never a spread of the annotation", () => {
  const fields = annotationToCardFields(annotation({ intent: "fix", priority: "blocking" }), {
    url: "https://example.com/settings",
  });
  expect(fields.kind).toBe("bug");
  expect(fields.priority).toBe("must");
  expect(fields.status).toBe("planned");
  expect(fields.tags).toEqual(["design-review"]);
  expect((fields as Record<string, unknown>).id).toBeUndefined();
  expect((fields as Record<string, unknown>).project_key).toBeUndefined();
});

test("annotationToCardFields: description carries the Feedback line and Screenshot path verbatim", () => {
  const fields = annotationToCardFields(
    annotation({ comment: "Nudge this left by 8px", screenshotPath: "/tmp/annotations/shot-1.png" }),
    { url: "https://example.com/settings" },
  );
  expect(fields.description).toContain("Feedback: Nudge this left by 8px");
  expect(fields.description).toContain("Screenshot: /tmp/annotations/shot-1.png");
});

test("annotationToCardFields: description carries the selector line for a pick annotation", () => {
  const fields = annotationToCardFields(
    annotation({ pick: pick({ selectors: [{ type: "qa", value: '[data-testid="submit"]' }] }) }),
    { url: "https://example.com/settings" },
  );
  expect(fields.description).toContain('Selector: [data-testid="submit"]');
});

test("annotationToCardFields: description works for a region annotation too (bounds/tool, no Selector)", () => {
  const a: PickAnnotation = {
    id: "r1",
    comment: "misaligned block",
    intent: "change",
    priority: "important",
    region: { x: 10, y: 20, width: 300, height: 120, tool: "circle", pageUrl: "https://example.com/x" },
  };
  const fields = annotationToCardFields(a, { url: "https://example.com/x" });
  expect(fields.description).toContain("Region: circle");
  expect(fields.description).toContain("Bounds: x=10, y=20, 300x120");
  expect(fields.description).toContain("Feedback: misaligned block");
  expect(fields.description).not.toContain("Selector:");
});

test("annotationToCardFields: context names the sanitized page url, with a Viewport line only when supplied", () => {
  const withViewport = annotationToCardFields(annotation(), {
    url: "https://example.com/settings?tab=billing",
    viewport: "375x667",
  });
  expect(withViewport.context).toBe(
    "Created from the Deck browser review of https://example.com/settings\nViewport: 375x667",
  );
  expect(withViewport.context).not.toContain("tab=billing");

  const withoutViewport = annotationToCardFields(annotation(), { url: "https://example.com/settings" });
  expect(withoutViewport.context).toBe("Created from the Deck browser review of https://example.com/settings");
});

// ---------------------------------------------------------------------------
// pickNoteToCardSeed
// ---------------------------------------------------------------------------

test("pickNoteToCardSeed: matches the openRoadmapDraft seed shape exactly", () => {
  const seed = pickNoteToCardSeed(pick(), { comment: "Make this blue" }, { url: "https://example.com/settings" });
  expect(Object.keys(seed).sort()).toEqual(["description", "kind", "title"].sort());
});

test("pickNoteToCardSeed: kind defaults to 'change' -> 'feature' when the note carries no intent", () => {
  const seed = pickNoteToCardSeed(pick(), { comment: "" }, { url: "https://example.com/settings" });
  expect(seed.kind).toBe("feature");
});

test("pickNoteToCardSeed: kind follows the note's own intent when set", () => {
  const seed = pickNoteToCardSeed(
    pick(),
    { comment: "", intent: "fix" },
    { url: "https://example.com/settings" },
  );
  expect(seed.kind).toBe("bug");
});

test("pickNoteToCardSeed: description contains the note: line when the note has a comment", () => {
  const seed = pickNoteToCardSeed(
    pick(),
    { comment: "Ship this today", intent: "fix", priority: "blocking" },
    { url: "https://example.com/settings" },
  );
  expect(seed.description).toContain("note: Ship this today");
  expect(seed.description).toContain("intent: fix");
  expect(seed.description).toContain("priority: blocking");
});

test("pickNoteToCardSeed: description leads with the tag, selector and sanitized url", () => {
  const seed = pickNoteToCardSeed(
    pick({ tagName: "button", selectors: [{ type: "css", value: "button.btn-save" }] }),
    { comment: "" },
    { url: "https://example.com/settings?tab=billing" },
  );
  expect(seed.description.startsWith("<button> button.btn-save on https://example.com/settings")).toBe(true);
  expect(seed.description).not.toContain("tab=billing");
});
