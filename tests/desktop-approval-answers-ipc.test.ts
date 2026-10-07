import { beforeEach, expect, test } from "bun:test";
import { claimApproval, handleAnswersIpc, parseApprovalAnswers, type ApprovalDeps } from "../desktop/src/main/approval-service.ts";
import { onDeckError } from "../desktop/src/main/log.ts";
import { COMPANION_MANIFEST, CHANNEL_TIERS, REMOTE_BLOCKED_CHANNELS } from "../desktop/src/shared/companion.ts";
import { deriveOperatorId, generateCredential } from "../shared/approval.ts";

let calls: { url: string; body: Record<string, unknown> }[];

function makeDeps(): ApprovalDeps {
  const cred = generateCredential();
  return {
    endpoint: { url: "http://127.0.0.1:0", token: null },
    identity: {
      operatorId: deriveOperatorId(cred.publicKey),
      publicKey: cred.publicKey,
      privateKey: cred.privateKey,
      osUserHash: "test-host"
    },
    projectKey: "proj",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ approval: { id: "a" } }), { status: 200 });
    }) as unknown as typeof fetch
  };
}

beforeEach(() => {
  calls = [];
});

test("an answers claim sends answer_kind answers and the answers object, no answer_text", async () => {
  await claimApproval(makeDeps(), { id: "a", answerKind: "answers", answers: { "Which?": ["One"] } });
  expect(calls.length).toBe(1);
  expect(calls[0]!.url.endsWith("/approval/claim")).toBe(true);
  expect(calls[0]!.body.answer_kind).toBe("answers");
  expect(calls[0]!.body.answers).toEqual({ "Which?": ["One"] });
  expect("answer_text" in calls[0]!.body).toBe(false);
});

test("a handback claim sends handback true and no answer field the broker would refuse", async () => {
  await claimApproval(makeDeps(), { id: "a", handback: true });
  const body = calls[0]!.body;
  expect(body.handback).toBe(true);
  for (const k of ["answer_kind", "answer_text", "answers", "terminal", "acknowledge"]) {
    expect(k in body, `${k} must be absent from a handback`).toBe(false);
  }
});

test("a malformed answers payload is refused before any broker call", () => {
  const bad: unknown[] = [
    null,
    "x",
    [],
    ["One"],
    {},
    { q: "One" },
    { q: [] },
    { q: [1] },
    { q: Array.from({ length: 12 }, (_, i) => `o${i}`) },
    { q: ["x".repeat(4001)] },
    { ["q".repeat(4001)]: ["One"] },
    { a: ["1"], b: ["1"], c: ["1"], d: ["1"], e: ["1"] },
    new Map([["q", ["One"]]]),
    { q: new Array(1) },
    { q: structuredClone(["One", , "Two"]) }
  ];
  for (const raw of bad) expect(parseApprovalAnswers(raw), JSON.stringify(raw)).toBeNull();
});

test("the answers IPC handler never reaches the broker call with a refused payload", async () => {
  const seen: unknown[][] = [];
  const call = async (...args: unknown[]) => {
    seen.push(args);
    return true;
  };
  const scopes: string[] = [];
  onDeckError((scope) => scopes.push(scope));
  try {
    for (const raw of [{ q: [] }, { q: [1] }, "x"]) {
      let error: unknown = null;
      try {
        await handleAnswersIpc("a", raw, call);
      } catch (e) {
        error = e;
      }
      expect(String(error), JSON.stringify(raw)).toContain("malformed answers");
    }
  } finally {
    onDeckError(() => {});
  }
  expect(seen, "a refused payload must never be forwarded").toEqual([]);
  expect(scopes, "a refused payload must leave a trace in the Deck error log").toContain("approvals");
});

test("the answers IPC handler forwards a valid payload with the parsed answers", async () => {
  const seen: unknown[][] = [];
  const call = async (...args: unknown[]) => {
    seen.push(args);
    return true;
  };
  expect(await handleAnswersIpc("a", { "Which?": ["One"] }, call)).toBe(true);
  expect(seen).toEqual([["a", { "Which?": ["One"] }]]);
});

test("a well-formed answers payload passes and keeps a __proto__ question as an own key", () => {
  const raw = JSON.parse('{"__proto__": ["One"], "Other?": ["A", "free text"]}');
  const parsed = parseApprovalAnswers(raw)!;
  expect(Object.keys(parsed)).toEqual(["__proto__", "Other?"]);
  expect(parsed["__proto__"]).toEqual(["One"]);
  expect(({} as Record<string, unknown>).One).toBeUndefined();
});

test("both channels are in the manifest, tier 2, and refused to a remote companion", () => {
  expect(COMPANION_MANIFEST.approvalAnswers).toEqual({ kind: "invoke", channel: "approvals:answers" });
  expect(COMPANION_MANIFEST.approvalHandback).toEqual({ kind: "invoke", channel: "approvals:handback" });
  for (const ch of ["approvals:answers", "approvals:handback"]) {
    expect(CHANNEL_TIERS[ch]).toBe(2);
    expect(REMOTE_BLOCKED_CHANNELS.has(ch), `${ch} must be remote-blocked`).toBe(true);
  }
});
