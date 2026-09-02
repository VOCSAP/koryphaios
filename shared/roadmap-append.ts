// Pure, deterministic module (no I/O, no Date.now()) so the MCP tool can
// pre-refuse with the same numbers the broker enforces, without a round trip.

export const ROADMAP_APPEND_PER_CALL_MAX_CHARS = 4000;

/**
 * Cap on the resulting context length in characters, not bytes -- SQLite's
 * length() counts characters here; switching to a byte count would silently
 * desync this comment and check from what the broker enforces.
 */
export const ROADMAP_APPEND_RESULT_MAX_CHARS = 16000;

/**
 * Delimiter markers wrapping each append header: \n<<< append <ISO8601> by
 * <author> >>>\n.
 * Either marker appearing in a caller's submitted text is refused outright,
 * never stripped or escaped, so a forged header cannot be smuggled in and later
 * read back as a legitimate entry.
 */
export const ROADMAP_APPEND_HEADER_OPEN = "<<<";
export const ROADMAP_APPEND_HEADER_CLOSE = ">>>";

/**
 * Attribution, not a signature: records who claimed the append, proven or not,
 * same as created_by/updated_by elsewhere.
 * Append is not idempotent -- a retried call after a timeout duplicates the
 * block -- so the timestamp is what makes that duplicate visible when the card
 * is read back.
 */
export function buildRoadmapAppendHeader(nowIso: string, author: string): string {
  return `\n${ROADMAP_APPEND_HEADER_OPEN} append ${nowIso} by ${author} ${ROADMAP_APPEND_HEADER_CLOSE}\n`;
}

export type RoadmapAppendTextErrorCode = "empty" | "too_long_single" | "contains_delimiter";
export type RoadmapContextAppendErrorCode = RoadmapAppendTextErrorCode | "too_long_result";

export type RoadmapAppendTextPlan =
  | {
      ok: true;
      header: string;
      /** header + text, exactly what gets concatenated onto the existing context. */
      appended: string;
    }
  | {
      ok: false;
      code: RoadmapAppendTextErrorCode;
      message: string;
    };

export type RoadmapContextAppendPlan =
  | {
      ok: true;
      header: string;
      appended: string;
      /** existingContext + appended -- the full new value of `context`. */
      result: string;
    }
  | {
      ok: false;
      code: RoadmapContextAppendErrorCode;
      message: string;
    };

/**
 * Checks only the per-call cap; the result cap is enforced exclusively by the
 * broker's UPDATE ... WHERE length(...) <= 16000 clause, since the broker never
 * SELECTs existingContext to hand here.
 * That UPDATE must use COALESCE(context,'') -- NULL || text evaluates to NULL
 * in SQLite, which would silently discard the append.
 * Only the incoming text is checked for the delimiter marker, not existing
 * context, so a card's own prior append is never used to refuse a new one.
 */
export function planRoadmapAppendText(opts: {
  text: string;
  author: string;
  nowIso: string;
}): RoadmapAppendTextPlan {
  const { text, author, nowIso } = opts;

  if (text.trim().length === 0) {
    return { ok: false, code: "empty", message: "append text is empty" };
  }

  if (text.includes(ROADMAP_APPEND_HEADER_OPEN) || text.includes(ROADMAP_APPEND_HEADER_CLOSE)) {
    return {
      ok: false,
      code: "contains_delimiter",
      message: `append text must not contain '${ROADMAP_APPEND_HEADER_OPEN}' or '${ROADMAP_APPEND_HEADER_CLOSE}'`,
    };
  }

  // Card 562fd9b5 review delta: [...text].length counts CODE POINTS, not
  // UTF-16 code units. `text.length` alone would diverge from SQLite's
  // length() (what the result cap enforces, char-by-char) by up to 2x on
  // astral-plane text (emoji etc.), contradicting this module's own "unit
  // is characters" documentation on the two caps -- fail-closed either way
  // (a stricter count only refuses MORE), but the two caps must count the
  // same thing for "unit: characters" to mean what it says everywhere.
  const textCharLen = [...text].length;
  if (textCharLen > ROADMAP_APPEND_PER_CALL_MAX_CHARS) {
    return {
      ok: false,
      code: "too_long_single",
      message: `append text is ${textCharLen} chars, over the ${ROADMAP_APPEND_PER_CALL_MAX_CHARS}-char per-call cap`,
    };
  }

  const header = buildRoadmapAppendHeader(nowIso, author);
  return { ok: true, header, appended: header + text };
}

/**
 * Full plan INCLUDING the result cap, for a caller that already has
 * `existingContext` in hand. NOT what the broker's own route calls (see
 * planRoadmapAppendText above for why) -- this exists for a caller with a
 * genuine, independent reason to already hold the current context, e.g. a
 * client pre-refusing against a RoadmapItem it fetched for another purpose.
 */
export function planRoadmapContextAppend(opts: {
  existingContext: string;
  text: string;
  author: string;
  nowIso: string;
}): RoadmapContextAppendPlan {
  const textPlan = planRoadmapAppendText(opts);
  if (!textPlan.ok) return textPlan;

  const result = opts.existingContext + textPlan.appended;
  if (result.length > ROADMAP_APPEND_RESULT_MAX_CHARS) {
    return {
      ok: false,
      code: "too_long_result",
      message: `resulting context would be ${result.length} chars, over the ${ROADMAP_APPEND_RESULT_MAX_CHARS}-char cap`,
    };
  }

  return { ok: true, header: textPlan.header, appended: textPlan.appended, result };
}
