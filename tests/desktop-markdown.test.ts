// PLAN K5: minimal markdown tokenizer for the roadmap detail modal. The module
// only produces a token tree (never HTML strings): the React side escapes every
// text node, so agent-written content cannot inject markup.

import { test, expect } from "bun:test";
import { parseInline, parseMarkdown } from "../desktop/src/renderer/src/markdown.ts";

test("parseInline handles code, bold, italic, links and plain text", () => {
  expect(parseInline("plain")).toEqual([{ t: "text", text: "plain" }]);
  expect(parseInline("a `code` b")).toEqual([
    { t: "text", text: "a " },
    { t: "code", text: "code" },
    { t: "text", text: " b" },
  ]);
  expect(parseInline("**bold** and *it*")).toEqual([
    { t: "bold", children: [{ t: "text", text: "bold" }] },
    { t: "text", text: " and " },
    { t: "italic", children: [{ t: "text", text: "it" }] },
  ]);
  expect(parseInline("[label](https://x.y)")).toEqual([
    { t: "link", label: "label", href: "https://x.y" },
  ]);
});

test("parseInline nests bold inside text and keeps unterminated markers literal", () => {
  expect(parseInline("**a `c` b**")).toEqual([
    {
      t: "bold",
      children: [
        { t: "text", text: "a " },
        { t: "code", text: "c" },
        { t: "text", text: " b" },
      ],
    },
  ]);
  // No closing marker: rendered literally, never swallowed.
  expect(parseInline("2 * 3 = 6")).toEqual([{ t: "text", text: "2 * 3 = 6" }]);
  expect(parseInline("a **b")).toEqual([{ t: "text", text: "a **b" }]);
  expect(parseInline("a [b](c")).toEqual([{ t: "text", text: "a [b](c" }]);
});

test("parseMarkdown splits headings, paragraphs, lists and fences", () => {
  const blocks = parseMarkdown(
    [
      "# Objective",
      "Fix the login flow.",
      "Same paragraph line.",
      "",
      "- step one",
      "- step two",
      "",
      "1. ordered",
      "2) also ordered",
      "```ts",
      "const x = 1",
      "```",
      "### Notes",
    ].join("\n")
  );
  expect(blocks.map((b) => b.t)).toEqual([
    "heading",
    "paragraph",
    "list",
    "list",
    "codeblock",
    "heading",
  ]);
  const [h, p, ul, ol, code, notes] = blocks;
  expect(h).toEqual({ t: "heading", level: 1, children: [{ t: "text", text: "Objective" }] });
  expect(p!.t === "paragraph" && p.children[0]).toEqual({
    t: "text",
    text: "Fix the login flow.\nSame paragraph line.",
  });
  expect(ul!.t === "list" && ul.ordered).toBe(false);
  expect(ul!.t === "list" && ul.items.length).toBe(2);
  expect(ol!.t === "list" && ol.ordered).toBe(true);
  expect(code).toEqual({ t: "codeblock", text: "const x = 1", lang: "ts" });
  expect(notes!.t === "heading" && notes.level).toBe(3);
});

test("parseMarkdown keeps raw HTML as literal text (injection safety)", () => {
  const blocks = parseMarkdown('<script>alert("x")</script>');
  expect(blocks).toEqual([
    { t: "paragraph", children: [{ t: "text", text: '<script>alert("x")</script>' }] },
  ]);
});

test("parseMarkdown renders an unterminated fence as code to the end", () => {
  const blocks = parseMarkdown("```\nline1\nline2");
  expect(blocks).toEqual([{ t: "codeblock", text: "line1\nline2", lang: "" }]);
});
