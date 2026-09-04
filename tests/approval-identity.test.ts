import { test, expect, describe } from "bun:test";
import {
  APPROVAL_ANSWER_MAX,
  APPROVAL_AUTH_SKEW_SEC,
  APPROVAL_OPTIONS_MAX,
  APPROVAL_TITLE_MAX,
  buildAuthProof,
  canonicalize,
  deriveOperatorId,
  deriveTokenId,
  formatOrigin,
  generateCredential,
  generateSecret,
  isOperationAllowed,
  sanitizeAnswerForPty,
  stripControl,
  validateApprovalDraft,
  verifyAuthProof,
} from "../shared/approval.ts";

describe("identity derivation", () => {
  test("operator_id is stable, 16 hex chars, and key-dependent", () => {
    const a = deriveOperatorId("key-a");
    expect(a).toBe(deriveOperatorId("key-a"));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(deriveOperatorId("key-b"));
  });

  test("two OS accounts (distinct credentials) never collide", () => {
    // The whole point of the operator axis: hostname() is identical for both,
    // the app-state credential is not.
    const accountA = generateCredential();
    const accountB = generateCredential();
    expect(deriveOperatorId(accountA.publicKey)).not.toBe(deriveOperatorId(accountB.publicKey));
  });

  test("token id is derived from the token, not the operator", () => {
    expect(deriveTokenId("tok")).toMatch(/^[0-9a-f]{16}$/);
    expect(deriveTokenId("tok")).not.toBe(deriveOperatorId("tok"));
  });

  test("generateSecret yields distinct base64url secrets", () => {
    const s = new Set(Array.from({ length: 50 }, () => generateSecret()));
    expect(s.size).toBe(50);
    for (const v of s) expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("canonicalize", () => {
  test("key order does not change the serialization", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  test("undefined members are dropped, null is kept", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
    expect(canonicalize({ a: null })).toBe('{"a":null}');
  });

  test("nested objects and arrays are stable", () => {
    const one = canonicalize({ o: { z: 1, a: [1, { y: 2, x: 3 }] } });
    const two = canonicalize({ o: { a: [1, { x: 3, y: 2 }], z: 1 } });
    expect(one).toBe(two);
  });

  test("arrays keep their order (order is meaningful)", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });
});

describe("auth proof (Ed25519)", () => {
  const cred = generateCredential();
  const payload = { id: "abc", kind: "permission" as const };
  const opts = { kind: "operator" as const, operator_id: "op" };

  test("a fresh proof verifies against the PUBLIC half only", () => {
    const proof = buildAuthProof(cred.privateKey, payload, opts);
    expect(verifyAuthProof(cred.publicKey, payload, proof)).toEqual({ ok: true });
  });

  test("the broker never needs the private half (leak of its DB proves nothing)", () => {
    // Everything the broker stores is cred.publicKey; forging a proof from it
    // must be impossible.
    const forged = buildAuthProof(generateCredential().privateKey, payload, opts);
    expect(verifyAuthProof(cred.publicKey, payload, forged)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  test("the signature covers the payload", () => {
    const proof = buildAuthProof(cred.privateKey, payload, opts);
    expect(verifyAuthProof(cred.publicKey, { ...payload, id: "other" }, proof)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  test("payload key order does not matter (canonical signing)", () => {
    const proof = buildAuthProof(cred.privateKey, { a: 1, b: 2 }, opts);
    expect(verifyAuthProof(cred.publicKey, { b: 2, a: 1 }, proof)).toEqual({ ok: true });
  });

  test("a proof outside the skew window is stale", () => {
    const now = 1_000_000;
    const proof = buildAuthProof(cred.privateKey, payload, { ...opts, now });
    expect(
      verifyAuthProof(cred.publicKey, payload, proof, { now: now + APPROVAL_AUTH_SKEW_SEC + 1 })
    ).toEqual({ ok: false, reason: "stale-proof" });
    // ...and a proof from the future is equally refused.
    expect(
      verifyAuthProof(cred.publicKey, payload, proof, { now: now - APPROVAL_AUTH_SKEW_SEC - 1 }).ok
    ).toBe(false);
  });

  test("inside the skew window it still verifies", () => {
    const now = 1_000_000;
    const proof = buildAuthProof(cred.privateKey, payload, { ...opts, now });
    expect(
      verifyAuthProof(cred.publicKey, payload, proof, { now: now + APPROVAL_AUTH_SKEW_SEC })
    ).toEqual({ ok: true });
  });

  test("missing, malformed or garbage proofs are verdicts, never exceptions", () => {
    expect(verifyAuthProof(cred.publicKey, payload, undefined)).toEqual({
      ok: false,
      reason: "missing-proof",
    });
    const ts = Math.floor(Date.now() / 1000);
    const garbage = { kind: "operator", operator_id: "op", nonce: "n", ts, sig: "!!!" } as never;
    expect(verifyAuthProof(cred.publicKey, payload, garbage).ok).toBe(false);
    // A non-key public half must not throw either.
    const proof = buildAuthProof(cred.privateKey, payload, opts);
    expect(verifyAuthProof("not-a-key", payload, proof)).toEqual({
      ok: false,
      reason: "malformed-proof",
    });
  });

  test("each proof carries a fresh nonce (the replay cache has a key)", () => {
    const nonces = new Set(
      Array.from({ length: 20 }, () => buildAuthProof(cred.privateKey, payload, opts).nonce)
    );
    expect(nonces.size).toBe(20);
  });
});

describe("credential scope (PLAN §6.8)", () => {
  test("a session token may only add and wait", () => {
    expect(isOperationAllowed("session", "add")).toBe(true);
    expect(isOperationAllowed("session", "wait")).toBe(true);
  });

  test("a session token may NEVER claim — that is the sandbox escape guard", () => {
    expect(isOperationAllowed("session", "claim")).toBe(false);
  });

  test("a session token may not read the operator's approvals nor touch channels", () => {
    expect(isOperationAllowed("session", "list")).toBe(false);
    expect(isOperationAllowed("session", "channels")).toBe(false);
    expect(isOperationAllowed("session", "mint-token")).toBe(false);
  });

  test("the operator key may do everything", () => {
    for (const op of ["add", "wait", "claim", "list", "channels", "mint-token"] as const) {
      expect(isOperationAllowed("operator", op)).toBe(true);
    }
  });
});

describe("draft validation (agent-supplied, hostile input #4)", () => {
  const base = { kind: "permission", title: "Run tests", question: "Allow npm test?" };

  test("a well-formed draft passes and is normalised", () => {
    const r = validateApprovalDraft({ ...base, options: ["Yes", "No"] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.title).toBe("Run tests");
      expect(r.value.options).toEqual(["Yes", "No"]);
    }
  });

  test("an unknown kind is refused", () => {
    expect(validateApprovalDraft({ ...base, kind: "root" }).ok).toBe(false);
  });

  test("title and question are required", () => {
    expect(validateApprovalDraft({ ...base, title: "   " }).ok).toBe(false);
    expect(validateApprovalDraft({ ...base, question: "" }).ok).toBe(false);
  });

  test("oversized fields are capped, not rejected", () => {
    const r = validateApprovalDraft({ ...base, title: "x".repeat(5000) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.title.length).toBe(APPROVAL_TITLE_MAX);
  });

  test("too many options are refused", () => {
    const many = Array.from({ length: APPROVAL_OPTIONS_MAX + 1 }, (_, i) => `opt${i}`);
    expect(validateApprovalDraft({ ...base, options: many }).ok).toBe(false);
  });

  test("ANSI and control characters never survive into the title", () => {
    const r = validateApprovalDraft({ ...base, title: "\x1b[31mred\x1b[0m\x07boom" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.title).toBe("redboom");
      expect(r.value.title).not.toContain("\x1b");
    }
  });

  test("newlines survive in the question but not in the title", () => {
    const r = validateApprovalDraft({ ...base, title: "a\nb", question: "line1\nline2" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.title).toBe("a b");
      expect(r.value.question).toBe("line1\nline2");
    }
  });

  test("non-string members degrade instead of throwing", () => {
    expect(validateApprovalDraft({ kind: 42, title: null, question: {} }).ok).toBe(false);
    const r = validateApprovalDraft({ ...base, options: [1, "ok", null] as never });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.options).toEqual(["ok"]);
  });

  test("merge defaults to 'tile' when absent or null, and 'never' is honoured", () => {
    const absent = validateApprovalDraft({ ...base });
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.value.merge).toBe("tile");

    const nullMerge = validateApprovalDraft({ ...base, merge: null });
    expect(nullMerge.ok).toBe(true);
    if (nullMerge.ok) expect(nullMerge.value.merge).toBe("tile");

    const never = validateApprovalDraft({ ...base, merge: "never" });
    expect(never.ok).toBe(true);
    if (never.ok) expect(never.value.merge).toBe("never");
  });

  test("a PRESENT but unrecognised merge value is refused, never silently folded into 'tile'", () => {
    // A typo or a stray casing must not fold into 'tile': that fold would
    // let a guarded request merge with whatever else is pending on the tile,
    // the exact defect this field exists to close.
    for (const bad of ["nevr", "Never", "NEVER", 42, ["never"]]) {
      expect(validateApprovalDraft({ ...base, merge: bad as never }).ok).toBe(false);
    }
  });
});

describe("sanitizeAnswerForPty (hostile input, PLAN §6.3)", () => {
  test("a plain answer passes through trimmed", () => {
    const r = sanitizeAnswerForPty("  use the second option  ");
    expect(r).toEqual({ ok: true, value: "use the second option" });
  });

  test("CR and LF collapse to spaces — the answer can never self-submit", () => {
    // This is the core danger: a remote answer typed into a PTY whose CR would
    // validate the dialog early and run the remainder as a second command.
    for (const evil of ["yes\rrm -rf /", "yes\nrm -rf /", "yes\r\nrm -rf /"]) {
      const r = sanitizeAnswerForPty(evil);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value).not.toContain("\r");
        expect(r.value).not.toContain("\n");
        expect(r.value).toBe("yes rm -rf /");
      }
    }
  });

  test("ANSI escapes and control bytes are removed", () => {
    const r = sanitizeAnswerForPty("\x1b[2Jok\x00\x07\x7f");
    expect(r).toEqual({ ok: true, value: "ok" });
  });

  test("an answer that is only whitespace or control chars is refused", () => {
    expect(sanitizeAnswerForPty("   ").ok).toBe(false);
    expect(sanitizeAnswerForPty("\r\n\x00").ok).toBe(false);
    expect(sanitizeAnswerForPty("").ok).toBe(false);
  });

  test("length is capped", () => {
    const r = sanitizeAnswerForPty("x".repeat(APPROVAL_ANSWER_MAX * 2));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.length).toBe(APPROVAL_ANSWER_MAX);
  });

  test("non-string input does not throw", () => {
    expect(sanitizeAnswerForPty(undefined as never).ok).toBe(false);
    expect(sanitizeAnswerForPty(42 as never).ok).toBe(true);
  });
});

describe("stripControl", () => {
  test("keeps ordinary unicode (accents, CJK, emoji-free prose)", () => {
    expect(stripControl("déjà vu 東京")).toBe("déjà vu 東京");
  });

  test("normalises CRLF to LF when newlines are kept", () => {
    expect(stripControl("a\r\nb", { keepNewlines: true })).toBe("a\nb");
  });
});

describe("formatOrigin", () => {
  test("builds a 'host · project' badge for multi-PC disambiguation", () => {
    expect(formatOrigin({ host: "bureau", project_key: "github.com/vocsap/koryphaios" })).toBe(
      "bureau · koryphaios"
    );
  });

  test("degrades gracefully without a project key", () => {
    expect(formatOrigin({ host: "portable", project_key: "" })).toBe("portable");
  });
});
