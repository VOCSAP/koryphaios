import { test, expect, describe } from "bun:test";
import {
  ALREADY_HANDLED_NOTICE,
  CALLBACK_DATA_MAX,
  DISCORD_TEXT_MAX,
  TELEGRAM_TEXT_MAX,
  decodeCallback,
  encodeCallback,
  escapeHtml,
  originLabel,
  renderDiscord,
  renderSettled,
  renderTelegram,
  truncate,
} from "../notify/format.ts";
import { loadOrCreateSecretKey, openSecret, sealSecret, secretHint } from "../shared/secret-box.ts";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Approval } from "../shared/types.ts";

function approval(patch: Partial<Approval> = {}): Approval {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    operator_id: "op",
    origin: {
      host: "bureau",
      os_user_hash: "h",
      project_key: "github.com/vocsap/koryphaios",
      group_id: "g",
      from_peer: "p",
      session_ref: "w",
      tile_ref: "t",
    },
    kind: "permission",
    title: "Bash: rm -rf build",
    question: "The agent wants to use Bash.",
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

describe("escaping (hostile input #4: the text comes from an agent)", () => {
  test("the three HTML-mode characters are neutralised", () => {
    expect(escapeHtml('<b>&"')).toBe('&lt;b&gt;&amp;"');
  });

  test("an agent cannot inject Telegram markup through the title", () => {
    const out = renderTelegram(approval({ title: "<b>fake bold</b>" }));
    expect(out).toContain("&lt;b&gt;fake bold&lt;/b&gt;");
    // The only real tags are the ones WE added.
    expect(out.match(/<b>/g)).toHaveLength(1);
  });

  test("an agent cannot break out of the Discord code fence", () => {
    const out = renderDiscord(approval({ question: "```\n@everyone\n```" }));
    expect(out).not.toContain("\n```\n@everyone");
    // Our own fences are still the outer ones.
    expect(out.split("```").length).toBeGreaterThanOrEqual(3);
  });
});

describe("length limits", () => {
  test("truncate marks the cut and never exceeds the budget", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 10)).toBe("abc");
    expect(truncate("abcdef", 4).length).toBe(4);
  });

  test("a huge question still fits each provider's cap", () => {
    const big = approval({ question: "x".repeat(50_000), title: "y".repeat(500) });
    expect(renderTelegram(big).length).toBeLessThanOrEqual(TELEGRAM_TEXT_MAX);
    expect(renderDiscord(big).length).toBeLessThanOrEqual(DISCORD_TEXT_MAX);
  });
});

describe("callback payloads", () => {
  test("round-trip for every action", () => {
    for (const action of ["allow", "deny", "text"] as const) {
      const encoded = encodeCallback(action, "11111111-2222-3333-4444-555555555555");
      expect(decodeCallback(encoded)).toEqual({
        action,
        approvalId: "11111111-2222-3333-4444-555555555555",
      });
    }
  });

  test("it fits Telegram's 64-BYTE cap for a uuid", () => {
    const encoded = encodeCallback("allow", "11111111-2222-3333-4444-555555555555");
    expect(Buffer.byteLength(encoded, "utf-8")).toBeLessThanOrEqual(CALLBACK_DATA_MAX);
  });

  test("an over-long id is refused rather than silently truncated", () => {
    // Truncating would make the payload point at the wrong approval.
    expect(() => encodeCallback("allow", "x".repeat(200))).toThrow();
  });

  test("garbage decodes to null", () => {
    expect(decodeCallback("")).toBeNull();
    expect(decodeCallback("nope")).toBeNull();
    expect(decodeCallback("z:abc")).toBeNull();
  });
});

describe("rendering", () => {
  test("the origin badge disambiguates two PCs", () => {
    expect(originLabel(approval())).toBe("bureau · koryphaios");
  });

  test("a permission carries a button hint, a question asks for a reply", () => {
    expect(renderTelegram(approval({ kind: "permission" }))).toContain("button");
    expect(renderTelegram(approval({ kind: "question" }))).toContain("Reply");
  });

  test("a settled message states who answered and what", () => {
    const out = renderSettled(
      approval({ status: "answered", answer_kind: "text", answer_text: "use staging" }),
      "telegram"
    );
    expect(out).toContain("handled via telegram");
    expect(out).toContain("use staging");
  });

  test("allow and deny read as words, not codes", () => {
    expect(renderSettled(approval({ answer_kind: "allow" }), "deck")).toContain("approved");
    expect(renderSettled(approval({ answer_kind: "deny" }), "deck")).toContain("rejected");
  });

  test("the late-answer notice is the wording the operator was promised", () => {
    expect(ALREADY_HANDLED_NOTICE).toContain("already handled");
  });
});

describe("secret box (bot tokens at rest)", () => {
  const dirs: string[] = [];
  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), "cp-secret-"));
    dirs.push(d);
    return d;
  }

  test("seal/open round-trips", () => {
    const key = loadOrCreateSecretKey(join(tmp(), "notify.key"));
    const sealed = sealSecret(key, "110201543:AAHdqTcv");
    expect(sealed).not.toContain("AAHdqTcv");
    expect(openSecret(key, sealed)).toBe("110201543:AAHdqTcv");
  });

  test("the key file is created 0600 and reused", () => {
    const path = join(tmp(), "notify.key");
    const first = loadOrCreateSecretKey(path);
    const second = loadOrCreateSecretKey(path);
    expect(first.toString("base64")).toBe(second.toString("base64"));
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    // The key itself must be the only thing in there.
    expect(readFileSync(path, "utf-8").trim()).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  test("a wrong key or a tampered payload yields null, never garbage", () => {
    const a = loadOrCreateSecretKey(join(tmp(), "a.key"));
    const b = loadOrCreateSecretKey(join(tmp(), "b.key"));
    const sealed = sealSecret(a, "secret");
    expect(openSecret(b, sealed)).toBeNull();
    // Flip a character in the ciphertext: GCM must reject it.
    const tampered = sealed.slice(0, -2) + (sealed.endsWith("A=") ? "B=" : "A=");
    expect(openSecret(a, tampered)).toBeNull();
    expect(openSecret(a, "not-sealed")).toBeNull();
  });

  test("the hint shows the tail only", () => {
    expect(secretHint("110201543:AAHdqTcvCH1x")).toBe("****CH1x");
    expect(secretHint("ab")).toBe("****");
  });

  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
