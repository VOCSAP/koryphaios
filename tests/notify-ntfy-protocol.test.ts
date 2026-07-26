// The ntfy wire format (PLAN N5) — pure, so no test touches a network.
//
// The replies topic is a bus: anything anyone publishes on it reaches
// `decodeInbound`. Most of what follows is therefore hostile-input coverage.

import { describe, expect, test } from "bun:test";
import {
  approvalClickUrl,
  buildApprovalPublish,
  buildSettledPublish,
  decodeInbound,
  decodePairingPayload,
  encodeAnswer,
  encodePair,
  encodePairingPayload,
  isPrivateHost,
  isValidTopic,
  normalizeNtfyServer,
  NTFY_ANSWER_MAX,
  NTFY_CLICK_SCHEME,
  NTFY_MESSAGE_MAX,
  NTFY_TITLE_MAX,
  pairedClickUrl,
  parseClickUrl,
  renderNtfy,
  settledClickUrl,
} from "../notify/ntfy-protocol.ts";
import type { Approval } from "../shared/types.ts";

function approval(patch: Partial<Approval> = {}): Approval {
  return {
    id: "a4f1c2d0-0000-4000-8000-000000000001",
    operator_id: "op-a",
    origin: {
      host: "bureau",
      os_user_hash: "h",
      project_key: "/home/o/koryphaios",
      group_id: "g",
      from_peer: "",
      session_ref: "s",
      tile_ref: "t",
    },
    kind: "permission",
    title: "Bash",
    question: "Allow `rm -rf build`?",
    options: [],
    status: "pending",
    reply_route: "pty",
    answered_via: null,
    answer_kind: null,
    answer_text: null,
    created_at: "",
    notif_expires_at: "",
    answered_at: null,
    delivered_at: null,
    ...patch,
  } as Approval;
}

const DEPS = {
  server: "https://ntfy.sh",
  topicNotif: "a".repeat(48),
  topicReplies: "b".repeat(48),
};

describe("normalizeNtfyServer", () => {
  test("adds https when the scheme is missing", () => {
    expect(normalizeNtfyServer("ntfy.sh")).toEqual({ ok: true, value: "https://ntfy.sh" });
  });

  test("strips a trailing slash but keeps a base path", () => {
    expect(normalizeNtfyServer("https://example.org/ntfy/")).toEqual({
      ok: true,
      value: "https://example.org/ntfy",
    });
  });

  test("refuses plain http towards the internet", () => {
    const res = normalizeNtfyServer("http://ntfy.sh");
    expect(res.ok).toBe(false);
  });

  test("allows plain http on a private address (self-hosted LAN)", () => {
    expect(normalizeNtfyServer("http://192.168.1.20:8080")).toEqual({
      ok: true,
      value: "http://192.168.1.20:8080",
    });
  });

  test("refuses a query or fragment, a non-http scheme, and the empty string", () => {
    expect(normalizeNtfyServer("https://ntfy.sh/?x=1").ok).toBe(false);
    expect(normalizeNtfyServer("https://ntfy.sh/#a").ok).toBe(false);
    expect(normalizeNtfyServer("ftp://ntfy.sh").ok).toBe(false);
    expect(normalizeNtfyServer("   ").ok).toBe(false);
  });

  test("strips control characters before parsing", () => {
    expect(normalizeNtfyServer("https://ntfy.sh")).toEqual({ ok: true, value: "https://ntfy.sh" });
  });
});

describe("isPrivateHost", () => {
  test("recognises the RFC1918 / loopback / ULA families", () => {
    for (const h of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "::1", "fd00::1", "localhost"]) {
      expect(isPrivateHost(h)).toBe(true);
    }
  });

  test("rejects public addresses and the 172.32 lookalike", () => {
    for (const h of ["8.8.8.8", "ntfy.sh", "172.32.0.1", "2001:db8::1"]) {
      expect(isPrivateHost(h)).toBe(false);
    }
  });
});

describe("isValidTopic", () => {
  test("accepts our 48-hex topics, refuses short or exotic ones", () => {
    expect(isValidTopic("a".repeat(48))).toBe(true);
    expect(isValidTopic("short")).toBe(false);
    expect(isValidTopic(`${"a".repeat(40)}/../etc`)).toBe(false);
    expect(isValidTopic("")).toBe(false);
  });
});

describe("pairing payload", () => {
  const base = {
    server: "https://ntfy.sh",
    topic_notif: "a".repeat(48),
    topic_replies: "b".repeat(48),
    token: "tk_x",
    code: "abc12345",
  };

  test("round-trips", () => {
    const decoded = decodePairingPayload(encodePairingPayload(base));
    expect(decoded).toMatchObject(base);
    expect(decoded?.mode).toBe("approvals");
  });

  test("rejects a companion URL, junk, and a wrong version", () => {
    expect(decodePairingPayload("https://192.168.1.5:8443/#t=abc")).toBeNull();
    expect(decodePairingPayload("{")).toBeNull();
    expect(decodePairingPayload(JSON.stringify({ ...base, v: 2, mode: "approvals" }))).toBeNull();
  });

  test("rejects identical topics, an invalid topic and a missing code", () => {
    expect(decodePairingPayload(encodePairingPayload({ ...base, topic_replies: base.topic_notif }))).toBeNull();
    expect(decodePairingPayload(encodePairingPayload({ ...base, topic_notif: "x" }))).toBeNull();
    expect(decodePairingPayload(encodePairingPayload({ ...base, code: "" }))).toBeNull();
  });

  test("rejects a payload whose server would send questions in the clear", () => {
    expect(decodePairingPayload(encodePairingPayload({ ...base, server: "http://ntfy.sh" }))).toBeNull();
  });
});

describe("decodeInbound (hostile: anyone can publish on the topic)", () => {
  test("decodes a button tap", () => {
    expect(decodeInbound(encodeAnswer("appr-1", "allow"))).toEqual({
      t: "answer",
      approvalId: "appr-1",
      kind: "allow",
      text: "",
      device: "",
    });
  });

  test("decodes a free-text answer with its device label", () => {
    expect(decodeInbound(encodeAnswer("appr-1", "text", "use the staging bucket", "Pixel 8"))).toEqual({
      t: "answer",
      approvalId: "appr-1",
      kind: "text",
      text: "use the staging bucket",
      device: "Pixel 8",
    });
  });

  test("decodes a pairing message", () => {
    expect(decodeInbound(encodePair("code-1", "Pixel 8"))).toEqual({
      t: "pair",
      code: "code-1",
      device: "Pixel 8",
    });
  });

  test("refuses junk, a wrong version, an unknown type and a missing id", () => {
    expect(decodeInbound("not json")).toBeNull();
    expect(decodeInbound(JSON.stringify({ v: 99, t: "answer", a: "x", k: "allow" }))).toBeNull();
    expect(decodeInbound(JSON.stringify({ v: 1, t: "claim", a: "x" }))).toBeNull();
    expect(decodeInbound(JSON.stringify({ v: 1, t: "answer", k: "allow" }))).toBeNull();
    expect(decodeInbound(JSON.stringify({ v: 1, t: "answer", a: "x", k: "sudo" }))).toBeNull();
  });

  test("refuses a text answer that carries no text", () => {
    expect(decodeInbound(JSON.stringify({ v: 1, t: "answer", a: "x", k: "text", x: "   " }))).toBeNull();
  });

  test("refuses an oversize frame outright and caps the answer it accepts", () => {
    expect(decodeInbound("x".repeat(9000))).toBeNull();
    const long = JSON.stringify({ v: 1, t: "answer", a: "x", k: "text", x: "y".repeat(5000) });
    const decoded = decodeInbound(long);
    expect(decoded?.t).toBe("answer");
    expect(decoded && "text" in decoded && decoded.text.length).toBeLessThanOrEqual(NTFY_ANSWER_MAX);
  });

  test("strips control characters out of the device label", () => {
    const decoded = decodeInbound(JSON.stringify({ v: 1, t: "pair", c: "c", d: "Pix\x1b[31mel" }));
    expect(decoded && "device" in decoded && decoded.device).toBe("Pixel");
  });

  test("refuses a non-string and an array payload", () => {
    expect(decodeInbound(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(decodeInbound(JSON.stringify("plain"))).toBeNull();
  });
});

describe("click deep links", () => {
  test("round-trip both views", () => {
    expect(parseClickUrl(approvalClickUrl("appr-1"))).toEqual({ view: "approval", approvalId: "appr-1" });
    expect(parseClickUrl(settledClickUrl("appr-1"))).toEqual({ view: "settled", approvalId: "appr-1" });
  });

  test("survives an id needing percent-encoding", () => {
    expect(parseClickUrl(approvalClickUrl("a/b c"))).toEqual({ view: "approval", approvalId: "a/b c" });
  });

  test("round-trips the pairing acknowledgement, both verdicts", () => {
    expect(parseClickUrl(pairedClickUrl(true))).toEqual({ view: "paired", approvalId: "1" });
    expect(parseClickUrl(pairedClickUrl(false))).toEqual({ view: "paired", approvalId: "0" });
  });

  test("the scheme comes from the constant, so a rename cannot half-apply", () => {
    // Encoding used the constant while parsing hard-coded the literal: renaming
    // the app would have kept publishing links the phone silently ignored.
    expect(approvalClickUrl("x").startsWith(`${NTFY_CLICK_SCHEME}://`)).toBe(true);
    expect(parseClickUrl(`${NTFY_CLICK_SCHEME}://approval/x`)).not.toBeNull();
  });

  test("refuses another scheme, another host and junk", () => {
    expect(parseClickUrl("https://evil.example/approval/x")).toBeNull();
    expect(parseClickUrl(`${NTFY_CLICK_SCHEME}://settings/x`)).toBeNull();
    expect(parseClickUrl("")).toBeNull();
  });
});

describe("renderNtfy (hostile input #4: the agent writes these strings)", () => {
  test("prefixes the origin and keeps the question's newlines", () => {
    const r = renderNtfy(approval({ question: "line one\nline two" }), "bureau · koryphaios");
    expect(r.title).toBe("bureau · koryphaios · Bash");
    expect(r.message).toBe("line one\nline two");
  });

  test("strips ANSI and control characters from both fields", () => {
    const r = renderNtfy(
      approval({ title: "Ba\x1b[31msh\x07", question: "rm \x00-rf" }),
      "bureau"
    );
    expect(r.title).toBe("bureau · Bash");
    expect(r.message).toBe("rm -rf");
  });

  test("caps both fields", () => {
    const r = renderNtfy(approval({ title: "T".repeat(500), question: "Q".repeat(5000) }), "b");
    expect(r.title.length).toBeLessThanOrEqual(NTFY_TITLE_MAX);
    expect(r.message.length).toBeLessThanOrEqual(NTFY_MESSAGE_MAX);
  });

  test("falls back to a name when the agent sent an empty title", () => {
    expect(renderNtfy(approval({ title: "" }), "bureau").title).toBe("bureau · Koryphaios");
  });

  test("a huge origin cannot crowd the agent's title out entirely", () => {
    // Without a share of its own, `host · project` filled all 200 characters
    // and the operator saw WHICH machine was asking but not WHAT.
    const r = renderNtfy(approval({ title: "Bash" }), "H".repeat(300));
    expect(r.title.length).toBeLessThanOrEqual(NTFY_TITLE_MAX);
    expect(r.title).toContain("Bash");
  });
});

describe("buildApprovalPublish", () => {
  test("a permission gets two buttons posting to the replies topic", () => {
    const p = buildApprovalPublish(approval(), "bureau · koryphaios", DEPS);
    expect(p.topic).toBe(DEPS.topicNotif);
    expect(p.priority).toBe(4);
    expect(p.click).toBe(approvalClickUrl(approval().id));
    expect(p.actions).toHaveLength(2);
    expect(p.actions?.[0]).toMatchObject({
      action: "http",
      label: "Approve",
      method: "POST",
      url: `${DEPS.server}/${DEPS.topicReplies}`,
      clear: true,
    });
    expect(decodeInbound(p.actions![0]!.body)).toEqual({
      t: "answer",
      approvalId: approval().id,
      kind: "allow",
      text: "",
      device: "",
    });
    expect(decodeInbound(p.actions![1]!.body)).toMatchObject({ kind: "deny" });
  });

  test("an open question gets no button: free text lives in our app", () => {
    const p = buildApprovalPublish(approval({ kind: "question" }), "bureau", DEPS);
    expect(p.actions).toBeUndefined();
  });

  test("carries NO credential: the token never rides in a published button", () => {
    // An ntfy token is an ACCOUNT credential; the relay caches the message, so
    // embedding it handed the account to anyone who learned the topic.
    const p = buildApprovalPublish(approval(), "b", DEPS);
    expect(JSON.stringify(p)).not.toContain("tk_secret");
    expect(JSON.stringify(p)).not.toContain("Authorization");
  });
});

describe("buildSettledPublish", () => {
  test("is a NEW minimum-priority message keyed on the approval id", () => {
    const p = buildSettledPublish("appr-1", "✓ Bash — handled via deck: approved", {
      topicNotif: DEPS.topicNotif,
    });
    expect(p.priority).toBe(1);
    expect(p.click).toBe(settledClickUrl("appr-1"));
    expect(p.actions).toBeUndefined();
    expect(p.message).toContain("handled via deck");
  });
});
