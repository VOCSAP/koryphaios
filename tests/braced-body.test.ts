import { test, expect, describe } from "bun:test";
import {
  extractBracedBody,
  extractBracketedBody,
  extractParenBody,
  findMatchingClose
} from "./_braced-body.ts";

// Every source below ends its call with `END)`; the real closing index is the
// one right after that token, whatever the comments and strings before it hold.
function closeOf(src: string, quoteAware = true): number {
  return findMatchingClose(src, src.indexOf("("), "(", ")", quoteAware);
}
function realClose(src: string): number {
  return src.indexOf("END)") + "END)".length;
}

describe("findMatchingClose (quoteAware) ignores comments", () => {
  test("an apostrophe in a line comment does not open a string", () => {
    const src = "call(\n  a, // the container's mount\n  b END)\nconst tail = 'x'\n";
    expect(closeOf(src)).toBe(realClose(src));
  });

  test("an apostrophe in a block comment, single or multi line, does not open a string", () => {
    const single = "call(a, /* it's */ b END)\nconst tail = 'x'\n";
    const multi = "call(\n  /* first line\n     the host's path */\n  b END)\nconst tail = 'x'\n";
    expect(closeOf(single)).toBe(realClose(single));
    expect(closeOf(multi)).toBe(realClose(multi));
  });

  test("a string holding // or /* is not read as a comment, so the bracket after it still counts", () => {
    const src = `call("http://host/path", '/* not a comment', (nested) END)\nconst tail = 1\n`;
    expect(closeOf(src)).toBe(realClose(src));
  });

  test("a template literal holding an apostrophe and // is one string", () => {
    const src = "call(`it's a // template`, (x) END)\nconst tail = 1\n";
    expect(closeOf(src)).toBe(realClose(src));
  });

  test("an unbalanced bracket inside a comment is ignored in quoteAware mode and counted otherwise", () => {
    const src = "call(a, // stray )\n  b END)\nconst tail = 1\n";
    expect(closeOf(src, true)).toBe(realClose(src));
    expect(closeOf(src, false), "default mode is unchanged: the comment bracket closes the call").toBe(
      src.indexOf("stray )") + "stray )".length
    );
  });

  test("an unterminated block comment throws instead of returning an EOF-truncated index", () => {
    expect(() => closeOf("call(a, /* never closed END)")).toThrow("never closed");
  });

  test("a line comment running to the end of the source without a newline throws", () => {
    expect(() => closeOf("call(a // no newline END)")).toThrow("never closed");
  });

  test("the setSandboxProvider shape: two apostrophe comments inside the arguments do not shift the end", () => {
    const src = [
      "service.setSandboxProvider(",
      "  () => {",
      "    // rewrite it onto the container's path",
      "    return null",
      "  },",
      "  // M2 resume: the container's auth volume",
      "  (cwdHost) => sandbox.transcriptsFor(cwdHost),",
      "  () => (sandbox.isEnabled() ? sandbox.peersDirHost : null)",
      "END)",
      "// SBX3: pre-spawn gate -- 'sandbox-auth-required' routes the renderer",
      "const next = 1",
      ""
    ].join("\n");
    expect(closeOf(src)).toBe(realClose(src));
  });
});

describe("the wrappers share the comment-aware scan", () => {
  test("extractParenBody, extractBracedBody and extractBracketedBody skip an apostrophe comment", () => {
    const paren = "f(a, // it's\n b)\nconst t = 'x'";
    const braced = "f({ a: 1, // it's\n b: 2 })\nconst t = 'x'";
    const bracketed = "const xs = [1, // it's\n 2]\nconst t = 'x'";
    expect(extractParenBody(paren, paren.indexOf("("), true)).toBe("a, // it's\n b");
    expect(extractBracedBody(braced, braced.indexOf("{"), true)).toBe(" a: 1, // it's\n b: 2 ");
    expect(extractBracketedBody(bracketed, bracketed.indexOf("["), true)).toBe("1, // it's\n 2");
  });
});
