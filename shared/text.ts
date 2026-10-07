// Text sanitisers and cutters, with ZERO dependencies.
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
