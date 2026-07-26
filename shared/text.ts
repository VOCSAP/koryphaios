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
 * Cut to `max` on a character boundary, appending an ellipsis when cut.
 * Length is measured in UTF-16 code units, matching what the chat APIs count.
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}
