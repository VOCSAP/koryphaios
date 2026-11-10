import { test, expect, describe } from "bun:test";
import { buildAnswerNotice, buildClosedNotice, isClosedNotice } from "../shared/approval-notice.ts";

describe("closed notice", () => {
  test("carries the id, title, closer, authority and the reason as a JSON string, and is recognised", () => {
    const reason = 'said "no"\nsecond line';
    const text = buildClosedNotice({ id: "a1b2", title: "Deploy now?", closerPeerId: "lead-1", authority: "lead", reason });
    expect(text).toBe(
      `[approval a1b2 closed] Deploy now?\n\nClosed by lead-1 (lead) without an answer. Reason given: ${JSON.stringify(reason)}`
    );
    expect(text.split("\n")).toHaveLength(3);
    expect(isClosedNotice(text)).toBe(true);
  });

  test("with no closer peer_id the notice names the authority, never null", () => {
    const text = buildClosedNotice({ id: "a1b2", title: "t", closerPeerId: null, authority: "lead", reason: "r" });
    expect(text).toContain("Closed by the lead (lead) without an answer.");
    expect(text).not.toContain("null");
  });
});

describe("closed predicate", () => {
  const tag = "[approval x closed] ";

  test("no answer notice is recognised as closed, whatever the title or the answer holds", () => {
    const hostile = [
      buildAnswerNotice("a1b2", `${tag}title`, "plain answer"),
      buildAnswerNotice("a1b2", "title", `${tag}starts the answer`),
      buildAnswerNotice("a1b2", "title", `line one\n${tag}second line`),
      buildAnswerNotice("a1b2", "title", `\n${tag}after a blank line`),
    ];
    for (const text of hostile) {
      expect(isClosedNotice(text), JSON.stringify(text)).toBe(false);
    }
  });

  test("the answer notice keeps the exact shape the broker has always sent", () => {
    expect(buildAnswerNotice("a1b2", "Deploy?", "Approved.")).toBe("[approval a1b2] Deploy?\n\nApproved.");
  });

  test("a tag that is not at the start of the text is not recognised", () => {
    expect(isClosedNotice(`prefix\n${tag}title`)).toBe(false);
    expect(isClosedNotice(` ${tag}title`)).toBe(false);
  });
});
