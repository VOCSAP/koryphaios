// The Files viewer computes selected line span from Range.toString(), which
// concatenates text nodes and synthesizes nothing at a block boundary; syntax
// highlighting replaced one flat text node with a span-per-token tree, so line
// breaks now exist only because HighlightedLines emits real newline text nodes
// between lines.
// Exercises HighlightedLines and the real selectionLineRange directly rather
// than the whole ExplorerView, to avoid dragging in the store, i18n and
// window.api for no added coverage.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

// happy-dom's fetch enforces same-origin policy, unlike Bun's native fetch, so
// every later suite in this shared bun test process that talks to a server on
// 127.0.0.1 fails with CORS if this teardown is skipped.
// unregister() must be awaited, not fire-and-forget, or the restore races the
// next test file.
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { selectionLineRange } from "../desktop/src/shared/code-selection.ts";

const ROOT = join(import.meta.dir, "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

// Imported through the bridge inside desktop/ so React resolves to a SINGLE
// copy; see desktop/tests-support/react-test-harness.ts for the two-trees
// explanation. Dynamic, because it must not load before the registration
// above.
const { act, React, createRoot } = await import("../desktop/tests-support/react-test-harness");
const { HighlightedLines } = await import(
  "../desktop/src/renderer/src/components/CodeTokens.tsx"
);

/** Four lines, several tokens each: the shape Shiki actually returns. */
const LINES = [
  [{ content: "const" }, { content: " a = 1" }],
  [{ content: "const" }, { content: " b = 2" }],
  [{ content: "function" }, { content: " third()" }, { content: " {" }],
  [{ content: "  return" }, { content: " a + b" }],
];
const TEXT = "const a = 1\nconst b = 2\nfunction third() {\n  return a + b";

function render(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(HighlightedLines, { lines: LINES }));
  });
  return container;
}

// --- Source scans: the two things the DOM test above cannot see ----------
//
// It mounts `HighlightedLines`, so it says nothing about (a) the viewer
// actually USING that component, and (b) the PLAIN-TEXT branch, which is the
// one that renders most often (unknown language, file over the cap, grammar
// that failed to load). A block element per line in EITHER branch breaks the
// same gesture, and only one of the two is mounted here.
test("the viewer renders the guarded component and keeps its plain-text branch flat", () => {
  const src = read("desktop/src/renderer/src/components/ExplorerView.tsx");
  const viewer = /<pre className="explorer-content[\s\S]*?<\/pre>/.exec(src)?.[0];
  expect(viewer).toBeTruthy();
  // (a) the guarded component is what draws the coloured branch
  expect(viewer).toContain("<HighlightedLines");
  // (b) the fallback is still ONE joined string, not a per-line element
  expect(viewer).toContain("shown.join('\\n')");
  expect(viewer).not.toMatch(/<(div|p|br|li)\b/);
});

test("the dark-theme rule keeps the !important that makes it win", () => {
  const css = read("desktop/src/renderer/src/styles.css");
  const rule = /\[data-theme='dark'\]\s*\.shiki-code span\s*\{[^}]*\}/.exec(css)?.[0];
  expect(rule).toBeTruthy();
  // Not an equivalent mutant: Shiki writes the LIGHT colour as an inline
  // style, which outranks any selector. Drop the !important and the dark
  // theme silently displays the light palette.
  expect(rule).toContain("!important");
});

test("the rendered code keeps every newline as a real text node", () => {
  const container = render();
  // textContent alone would also pass with <div> per line (it walks text
  // nodes of the subtree), so it is only the first half of the claim.
  expect(container.textContent).toBe(TEXT);

  const newlineNodes: string[] = [];
  const walker = document.createTreeWalker(container, 4 /* SHOW_TEXT */);
  let node = walker.nextNode();
  while (node) {
    if (node.textContent === "\n") newlineNodes.push("\n");
    node = walker.nextNode();
  }
  expect(newlineNodes.length).toBe(LINES.length - 1);
});

test("no block element is introduced between the lines", () => {
  const container = render();
  const tags = new Set([...container.querySelectorAll("*")].map((el) => el.tagName));
  // A <div>/<p>/<br> here is precisely the refactor that breaks the gesture.
  expect([...tags]).toEqual(["SPAN"]);
});

test("a selection across two lines still reports those two lines", () => {
  const container = render();
  const walker = document.createTreeWalker(container, 4 /* SHOW_TEXT */);
  const textNodes: Node[] = [];
  let node = walker.nextNode();
  while (node) {
    textNodes.push(node);
    node = walker.nextNode();
  }

  // First text node of line 3 and last of line 4, found by content so the
  // test does not encode the token split.
  const start = textNodes.find((n) => n.textContent === "function");
  const end = textNodes.find((n) => n.textContent === " a + b");
  expect(start && end).toBeTruthy();

  const range = document.createRange();
  range.setStart(start!, 0);
  range.setEnd(end!, end!.textContent!.length);
  const selected = range.toString();
  expect(selected).toBe("function third() {\n  return a + b");

  // Exactly what `captureSelection` does in ExplorerView.tsx.
  const before = document.createRange();
  before.selectNodeContents(container);
  before.setEnd(range.startContainer, range.startOffset);
  expect(selectionLineRange(before.toString(), selected)).toEqual({
    startLine: 3,
    endLine: 4,
  });
});
