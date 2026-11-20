import { describe, expect, test } from "bun:test";
import {
  isWireText,
  parseTurnSignal,
  SESSION_END_REASONS,
  TURN_COMPLETE_REASONS,
  TURN_SIGNAL_LIMITS,
  type TurnSignal,
  type TurnSignalRefusal
} from "../desktop/hooks/turn-signal-wire.ts";

const VALID: TurnSignal[] = [
  { kind: "command.run:enter", seq: 1, command: "claude-peers-deck-lead:kory-session-start", args: "2 kory-step:ab12cd34", origin: "composer" },
  { kind: "command.run:resolved", seq: 2, command: "compact" },
  { kind: "turn.start", seq: 3, turnId: "turn-1" },
  { kind: "turn.start", seq: 4, turnId: "turn-2", agentId: "agent-1" },
  { kind: "turn.start", seq: 4, turnId: "turn-2", commandSeq: 0 },
  { kind: "turn.complete", seq: 5, turnId: "turn-1", reason: "answer", isAborted: false },
  { kind: "turn.complete", seq: 6, turnId: "turn-2", reason: "answer", isAborted: false, agentId: "agent-1" },
  { kind: "session.compact:resolved", seq: 7 },
  { kind: "session.end", seq: 8, reason: "clear" },
  { kind: "turn.complete", seq: 9, turnId: "turn-3", reason: "aborted", isAborted: true },
  { kind: "turn.complete", seq: 10, turnId: "turn-4", reason: "answer", isAborted: false, backgroundTasks: 0 },
  { kind: "turn.complete", seq: 11, turnId: "turn-5", reason: "answer", isAborted: false, backgroundTasks: 2 }
];

const parse = (value: unknown): TurnSignal | null => {
  const result = parseTurnSignal(JSON.stringify(value));
  return result.ok ? result.signal : null;
};
const refusal = (value: unknown): TurnSignalRefusal | "accepted" => {
  const result = parseTurnSignal(typeof value === "string" ? value : JSON.stringify(value));
  return result.ok ? "accepted" : result.reason;
};

const ESC = String.fromCharCode(0x1b);
const LONE_SURROGATE = String.fromCharCode(0xd800);
const BIDI_OVERRIDE = String.fromCodePoint(0x202e);
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const PRIVATE_USE = String.fromCodePoint(0xe000);
const UNASSIGNED = String.fromCodePoint(0x0378);
const NO_BREAK_SPACE = String.fromCodePoint(0x00a0);

describe("parseTurnSignal shapes", () => {
  test.each(VALID.map((signal) => [signal.kind + (("agentId" in signal) ? " with agentId" : ""), signal] as const))(
    "%s is accepted whole",
    (_name, signal) => {
      expect(parseTurnSignal(JSON.stringify(signal))).toEqual({ ok: true, signal });
    }
  );

  test("an unknown or absent kind is refused, a prototype name included", () => {
    expect(refusal({ kind: "turn.abort", seq: 1 })).toBe("unknown-kind");
    expect(refusal({ seq: 1 })).toBe("unknown-kind");
    expect(refusal({ kind: 7, seq: 1 })).toBe("unknown-kind");
    expect(refusal({ kind: "constructor", seq: 1 })).toBe("unknown-kind");
    expect(refusal({ kind: "__proto__", seq: 1 })).toBe("unknown-kind");
  });

  test("anything that is not one JSON object is refused", () => {
    for (const raw of ["", "{", "not json", "NaN"]) expect(refusal(raw), raw).toBe("not-json");
    for (const raw of ["null", "7", '"turn.start"', "[]", '[{"kind":"session.compact:resolved","seq":1}]']) {
      expect(refusal(raw), raw).toBe("not-an-object");
    }
  });

  test("a key the shape does not list is refused on every kind, whatever its value", () => {
    for (const signal of VALID) {
      expect(refusal({ ...signal, text: "hello" }), signal.kind).toBe("unknown-key");
      expect(refusal(JSON.stringify(signal).replace(/}$/, ',"__proto__":{"x":1}}')), signal.kind).toBe("unknown-key");
    }
    expect(refusal({ kind: "session.end", seq: 1, reason: "clear", agentId: "a" })).toBe("unknown-key");
  });

  test("a required key that is missing is refused on every kind", () => {
    for (const signal of VALID) {
      for (const key of Object.keys(signal).filter((name) => !["kind", "agentId", "backgroundTasks", "commandSeq"].includes(name))) {
        const { [key]: _removed, ...rest } = signal as Record<string, unknown>;
        expect(refusal(rest), `${signal.kind} without ${key}`).toBe("missing-key");
      }
    }
  });

  test("a turn.complete needs its turnId, and its isAborted must be a boolean", () => {
    expect(refusal({ kind: "turn.complete", seq: 1, reason: "answer", isAborted: false })).toBe("missing-key");
    expect(refusal({ kind: "turn.complete", seq: 1, turnId: "t", reason: "answer", isAborted: "false" })).toBe("bad-flag");
    expect(refusal({ kind: "turn.complete", seq: 1, turnId: "t", reason: "answer", isAborted: 0 })).toBe("bad-flag");
  });

  test("agentId is absent for the main thread, never empty or of another type", () => {
    expect(refusal({ kind: "turn.start", seq: 1, turnId: "t", agentId: "" })).toBe("bad-string");
    expect(refusal({ kind: "turn.start", seq: 1, turnId: "t", agentId: 5 })).toBe("bad-string");
    expect(refusal({ kind: "turn.start", seq: 1, turnId: "t", agentId: null })).toBe("bad-string");
  });
});

describe("parseTurnSignal commandSeq", () => {
  const start = (commandSeq: unknown) => ({ kind: "turn.start", seq: 9, turnId: "t", commandSeq });

  test("a safe integer from 0 is accepted, and the key may be absent", () => {
    for (const value of [0, 1, Number.MAX_SAFE_INTEGER]) expect(refusal(start(value)), String(value)).toBe("accepted");
    expect(refusal({ ...start(0), commandSeq: undefined })).toBe("accepted");
  });

  test.each([-1, 1.5, "3", null, true, 2 ** 53])("a commandSeq of %p is refused", (value) => {
    expect(refusal(start(value))).toBe("bad-seq");
  });

  test("only a turn.start carries it", () => {
    expect(refusal({ kind: "turn.complete", seq: 1, turnId: "t", reason: "answer", isAborted: false, commandSeq: 1 })).toBe("unknown-key");
    expect(refusal({ kind: "command.run:resolved", seq: 1, command: "compact", commandSeq: 1 })).toBe("unknown-key");
  });
});

describe("isWireText", () => {
  test("it accepts what the parser accepts for a label and refuses what it refuses", () => {
    expect(isWireText("compact", 7)).toBe(true);
    expect(isWireText("two words", 9)).toBe(true);
    expect(isWireText("compact", 6), "one past the cap").toBe(false);
    expect(isWireText("", 5), "empty").toBe(false);
    expect(isWireText("   ", 5), "blank").toBe(false);
    expect(isWireText(5, 5)).toBe(false);
    expect(isWireText("a\nb", 5), "newline").toBe(false);
    expect(isWireText("a\tb", 5), "tab").toBe(false);
    expect(isWireText(`a${ZERO_WIDTH_SPACE}b`, 5), "format character").toBe(false);
    expect(isWireText(`a${LONE_SURROGATE}`, 5), "lone surrogate").toBe(false);
    expect(isWireText(`a${PRIVATE_USE}`, 5), "private use").toBe(false);
  });

  test("it agrees with the parser on a command name", () => {
    for (const command of ["compact", "x".repeat(128), "x".repeat(129), " ", `a${ZERO_WIDTH_SPACE}`, "a\nb"]) {
      expect(isWireText(command, TURN_SIGNAL_LIMITS.command), JSON.stringify(command)).toBe(
        refusal({ kind: "command.run:resolved", seq: 1, command }) === "accepted"
      );
    }
  });
});

describe("parseTurnSignal backgroundTasks", () => {
  const complete = (backgroundTasks: unknown) => ({
    kind: "turn.complete",
    seq: 1,
    turnId: "t",
    reason: "answer",
    isAborted: false,
    backgroundTasks
  });

  test("a count from 0 to its cap is accepted, and the key may be absent", () => {
    for (const count of [0, 1, TURN_SIGNAL_LIMITS.backgroundTasks]) expect(refusal(complete(count)), String(count)).toBe("accepted");
    expect(refusal({ ...complete(0), backgroundTasks: undefined })).toBe("accepted");
  });

  test.each([-1, 1.5, "0", null, true, TURN_SIGNAL_LIMITS.backgroundTasks + 1, 2 ** 53])("a count of %p is refused", (count) => {
    expect(refusal(complete(count))).toBe("bad-count");
  });

  test("only a turn.complete carries the count", () => {
    expect(refusal({ kind: "turn.start", seq: 1, turnId: "t", backgroundTasks: 0 })).toBe("unknown-key");
    expect(refusal({ kind: "session.end", seq: 1, reason: "clear", backgroundTasks: 0 })).toBe("unknown-key");
  });
});

describe("parseTurnSignal reasons", () => {
  const complete = (reason: unknown, isAborted: unknown) => ({ kind: "turn.complete", seq: 1, turnId: "t", reason, isAborted });

  test("each turn reason of the engine is accepted with the isAborted it implies", () => {
    for (const reason of TURN_COMPLETE_REASONS) {
      expect(refusal(complete(reason, reason === "aborted")), reason).toBe("accepted");
    }
    expect([...TURN_COMPLETE_REASONS]).toEqual(["answer", "aborted", "refusal", "error"]);
  });

  test("a turn reason outside the engine's set is refused, a near miss included", () => {
    for (const reason of ["done", "ANSWER", "answer ", "interrupted", "", 7, null]) {
      expect(refusal(complete(reason, false)), String(reason)).toBe("bad-reason");
    }
  });

  test("isAborted must be true exactly when the reason is aborted", () => {
    expect(refusal(complete("answer", true))).toBe("aborted-mismatch");
    expect(refusal(complete("refusal", true))).toBe("aborted-mismatch");
    expect(refusal(complete("error", true))).toBe("aborted-mismatch");
    expect(refusal(complete("aborted", false))).toBe("aborted-mismatch");
  });

  test("each session end reason of the engine is accepted, anything else is refused", () => {
    expect([...SESSION_END_REASONS]).toEqual(["clear", "resume", "logout", "prompt_input_exit", "other"]);
    for (const reason of SESSION_END_REASONS) {
      expect(refusal({ kind: "session.end", seq: 1, reason }), reason).toBe("accepted");
    }
    for (const reason of ["exit", "Clear", "clear ", "", 3, null]) {
      expect(refusal({ kind: "session.end", seq: 1, reason }), String(reason)).toBe("bad-reason");
    }
  });
});

describe("parseTurnSignal refusals", () => {
  test("every refusal names its rule and nothing of the body", () => {
    const marker = "BODY-CONTENT-MARKER";
    const bodies: unknown[] = [
      { kind: marker, seq: 1 },
      { kind: "session.end", seq: 1, reason: "clear", [marker]: 1 },
      { kind: "session.end", seq: 1, reason: marker },
      { kind: "command.run:enter", seq: 1, command: `${marker}${ESC}`, args: "", origin: "composer" },
      { kind: "turn.complete", seq: 1, turnId: marker, reason: "aborted", isAborted: false },
      { kind: "session.compact:resolved", seq: marker }
    ];
    const reasons = bodies.map((body) => {
      const result = parseTurnSignal(JSON.stringify(body));
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result), JSON.stringify(body)).not.toContain(marker);
      return result.ok ? "" : result.reason;
    });
    expect(reasons).toEqual(["unknown-kind", "unknown-key", "bad-reason", "bad-string", "aborted-mismatch", "bad-seq"]);
  });

  test("an oversized body is refused before it is parsed", () => {
    expect(refusal(" ".repeat(TURN_SIGNAL_LIMITS.bodyBytes + 1) + "{")).toBe("body-too-large");
  });
});

describe("parseTurnSignal seq", () => {
  const withSeq = (seq: string): string => `{"kind":"session.compact:resolved","seq":${seq}}`;

  test("a safe integer from 0 is accepted", () => {
    expect(parseTurnSignal(withSeq("0"))).toEqual({ ok: true, signal: { kind: "session.compact:resolved", seq: 0 } });
    expect(refusal(withSeq(String(Number.MAX_SAFE_INTEGER)))).toBe("accepted");
  });

  test.each(["-1", "1.5", '"1"', "null", "true", "1e999", "-1e999", String(Number.MAX_SAFE_INTEGER + 2)])(
    "seq %s is refused",
    (seq) => {
      expect(refusal(withSeq(seq))).toBe("bad-seq");
    }
  );

  test.each(["NaN", "Infinity"])("seq %s is not even JSON", (seq) => {
    expect(refusal(withSeq(seq))).toBe("not-json");
  });
});

describe("parseTurnSignal bounds", () => {
  test("a string is accepted at its cap and refused one character past it", () => {
    const at = (key: string, max: number, base: TurnSignal) => {
      expect(parse({ ...base, [key]: "a".repeat(max) }), `${key} at ${max}`).not.toBeNull();
      expect(refusal({ ...base, [key]: "a".repeat(max + 1) }), `${key} at ${max + 1}`).toBe("bad-string");
    };
    at("command", TURN_SIGNAL_LIMITS.command, VALID[1]!);
    at("args", TURN_SIGNAL_LIMITS.args, VALID[0]!);
    at("origin", TURN_SIGNAL_LIMITS.label, VALID[0]!);
    at("turnId", TURN_SIGNAL_LIMITS.id, VALID[2]!);
    at("agentId", TURN_SIGNAL_LIMITS.id, VALID[3]!);
  });

  test("only args may be empty", () => {
    expect(parse({ ...VALID[0]!, args: "" })).not.toBeNull();
    expect(refusal({ ...VALID[0]!, command: "" })).toBe("bad-string");
    expect(refusal({ ...VALID[0]!, origin: "" })).toBe("bad-string");
    expect(refusal({ ...VALID[2]!, turnId: "" })).toBe("bad-string");
  });

  test("a label made only of whitespace is refused, args excepted", () => {
    for (const blank of [" ", "   ", NO_BREAK_SPACE, ` ${NO_BREAK_SPACE} `]) {
      expect(refusal({ ...VALID[0]!, command: blank }), JSON.stringify(blank)).toBe("bad-string");
      expect(refusal({ ...VALID[0]!, origin: blank }), JSON.stringify(blank)).toBe("bad-string");
      expect(refusal({ ...VALID[2]!, turnId: blank }), JSON.stringify(blank)).toBe("bad-string");
      expect(refusal({ ...VALID[3]!, agentId: blank }), JSON.stringify(blank)).toBe("bad-string");
    }
    expect(parse({ ...VALID[0]!, command: " compact " })).not.toBeNull();
    expect(parse({ ...VALID[0]!, args: "   " })).not.toBeNull();
  });

  test("a string is counted in code points, not UTF-16 units", () => {
    expect(parse({ ...VALID[0]!, args: "\u{1F600}".repeat(TURN_SIGNAL_LIMITS.args) })).not.toBeNull();
  });

  test("a control, format, private, unassigned or separator character is refused in any string", () => {
    const hostile = [
      `a${ESC}b`,
      "a\nb",
      "a\tb",
      `a${BIDI_OVERRIDE}b`,
      `a${LINE_SEPARATOR}b`,
      `a${PARAGRAPH_SEPARATOR}b`,
      `a${ZERO_WIDTH_SPACE}b`,
      `a${PRIVATE_USE}b`,
      `a${UNASSIGNED}b`
    ];
    for (const bad of hostile) {
      expect(refusal({ ...VALID[0]!, args: bad }), JSON.stringify(bad)).toBe("bad-string");
      expect(refusal({ ...VALID[0]!, command: bad }), JSON.stringify(bad)).toBe("bad-string");
      expect(refusal({ ...VALID[2]!, turnId: bad }), JSON.stringify(bad)).toBe("bad-string");
    }
  });

  test("a malformed string, a lone surrogate, is refused wherever it sits", () => {
    for (const bad of [LONE_SURROGATE, `a${LONE_SURROGATE}`, `${LONE_SURROGATE}a`, `\u{1F600}${LONE_SURROGATE}`]) {
      expect(refusal({ ...VALID[0]!, args: bad }), JSON.stringify(bad)).toBe("bad-string");
      expect(refusal({ ...VALID[2]!, turnId: bad }), JSON.stringify(bad)).toBe("bad-string");
    }
    expect(parse({ ...VALID[0]!, args: "\u{1F600}" })).not.toBeNull();
  });

  test("the body is bounded to its byte size, padding outside the strings included", () => {
    const body = JSON.stringify(VALID[4]!);
    const pad = (bytes: number): string => `{${" ".repeat(bytes - body.length)}${body.slice(1)}`;
    expect(new TextEncoder().encode(pad(TURN_SIGNAL_LIMITS.bodyBytes)).length).toBe(TURN_SIGNAL_LIMITS.bodyBytes);
    expect(parseTurnSignal(pad(TURN_SIGNAL_LIMITS.bodyBytes))).toEqual({ ok: true, signal: VALID[4]! });
    expect(refusal(pad(TURN_SIGNAL_LIMITS.bodyBytes + 1))).toBe("body-too-large");
  });

  test("the bound counts UTF-8 bytes: a body within 4096 UTF-16 units can still be too large", () => {
    const wide = JSON.stringify({ ...VALID[0]!, args: "\u{1F600}".repeat(TURN_SIGNAL_LIMITS.args) });
    const raw = `{${" ".repeat(TURN_SIGNAL_LIMITS.bodyBytes - wide.length)}${wide.slice(1)}`;
    expect(raw.length).toBe(TURN_SIGNAL_LIMITS.bodyBytes);
    expect(new TextEncoder().encode(raw).length).toBeGreaterThan(TURN_SIGNAL_LIMITS.bodyBytes);
    expect(refusal(raw)).toBe("body-too-large");
  });
});
