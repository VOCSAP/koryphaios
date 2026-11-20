// Text sanitisers and cutters, with ZERO dependencies.
// The Deck renderer and the Android shell import this file: it must stay free of imports.
//
// These two live apart from `shared/approval.ts` (which pulls `node:crypto`)
// and from `notify/format.ts` (which reaches for `Buffer`) for one concrete
// reason: `notify/ntfy-protocol.ts` needs them, and that module is bundled
// into the Android WebView app, where neither of those exists. Keeping the
// leaf leaf-shaped is what lets the phone and the broker share ONE definition
// of the wire format instead of drifting copies.

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Drop ANSI sequences and C0/DEL controls. Newlines optionally survive. */
export function stripControl(s: string, opts: { keepNewlines?: boolean } = {}): string {
  const noAnsi = s.replace(ANSI_RE, "");
  const cleaned = noAnsi.replace(CTRL_RE, "");
  return opts.keepNewlines ? cleaned.replace(/\r\n?/g, "\n") : cleaned.replace(/[\r\n]+/g, " ");
}

/**
 * Cut to `max` code points, saying so: the end is replaced by a marker naming
 * the original length, so the operator never answers a silently shortened text.
 * A bound too small to hold the marker cuts without it.
 */
export function capVisibly(s: string, max: number): string {
  const points = Array.from(s);
  if (points.length <= max) return s;
  const marker = ` … [truncated from ${points.length} characters]`;
  const room = max - Array.from(marker).length;
  if (room <= 0) return points.slice(0, Math.max(0, max)).join("");
  return points.slice(0, room).join("").trimEnd() + marker;
}

/**
 * Render `compose(text)` whole when `text` fits `budget` and the message fits
 * `messageMax` (both in UTF-16 units, what the chat APIs count); otherwise the
 * longest `capVisibly` cut whose message fits, with `whole` false.
 */
export function fitVisibly(
  text: string,
  budget: number,
  messageMax: number,
  compose: (body: string, whole: boolean) => string
): { message: string; whole: boolean } {
  if (text.length <= budget) {
    const message = compose(text, true);
    if (message.length <= messageMax) return { message, whole: true };
  }
  for (let n = Math.min(Array.from(text).length, budget); ; n = Math.floor(n * 0.9)) {
    const message = compose(capVisibly(text, n), false);
    if (message.length <= messageMax || n === 0) return { message, whole: false };
  }
}

/**
 * Cut to `max` on a character boundary, appending an ellipsis when cut.
 * Length is measured in UTF-16 code units, matching what the chat APIs count.
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

const HIDDEN_CHAR_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const BIDI_CHAR_RE = /\p{Bidi_Control}/u;
const CONTROL_CHAR_RE = /\p{Cc}/u;
const INVISIBLE_CHAR_RE = /[\p{Cf}\p{Zl}\p{Zp}]/u;

/** LF and TAB lay a multiline command out; they hide nothing and stay as they are. */
function showsLayoutOnly(char: string): boolean {
  return char === "\n" || char === "\t";
}

/**
 * Show every control, format and line/paragraph separator character as
 * `<U+XXXX>` so text cannot reorder or hide part of itself on a screen.
 * Display only: the stored text stays what the agent sent.
 */
export function revealFormatChars(s: string): string {
  return s.replace(HIDDEN_CHAR_RE, (char) =>
    showsLayoutOnly(char) ? char : `<U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}>`
  );
}

/** What an approval's text hides, in a fixed order; empty when it hides nothing. */
export function approvalTextFlags(
  title: string,
  question: string,
  options: readonly string[] = []
): Array<"bidi" | "control" | "invisible"> {
  const found = new Set<"bidi" | "control" | "invisible">();
  for (const char of [title, question, ...options].join("\n")) {
    if (BIDI_CHAR_RE.test(char)) found.add("bidi");
    else if (CONTROL_CHAR_RE.test(char)) {
      if (!showsLayoutOnly(char)) found.add("control");
    } else if (INVISIBLE_CHAR_RE.test(char)) found.add("invisible");
  }
  return (["bidi", "control", "invisible"] as const).filter((flag) => found.has(flag));
}
