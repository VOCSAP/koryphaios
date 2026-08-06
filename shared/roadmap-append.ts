// Card 562fd9b5: caps, delimiter and header/plan constructor for roadmap
// context-append mode. Pure module -- no I/O, no `Date.now()`, nothing that
// makes two calls with the same arguments answer differently. That is what
// lets the MCP tool (server.ts) PRE-REFUSE with the exact same numbers the
// broker will enforce once its route exists, instead of round-tripping a
// doomed request just to learn it was too big.
//
// No roadmap-shaped file exists in shared/ today; every roadmap validation
// currently lives inside broker.ts. This module is the first one, deliberately
// narrow: caps, delimiter and the pure planning function only, nothing that
// touches the DB or the wire.
//
// NO CALLER EXISTS YET. The broker route (/roadmap/append-context) and the
// server.ts MCP tool that will call these functions are the REST of card
// 562fd9b5, not yet written. This module ships ahead of them deliberately --
// it is pure and fully testable on its own -- but that means it is currently
// instantiated by NOTHING (CLAUDE.md: a module/comment asserting a guarantee
// must be wired to it, or a reader three weeks from now has no way to tell
// "not wired yet" from "wired and I haven't found where").

/**
 * Per-call cap on the RAW text a caller appends, before the header is added.
 * Measured as the p90 of a card's current FULL context across the live
 * 107-card roadmap (2026-08-06) -- not invented, not round-tripped from the
 * result cap below.
 */
export const ROADMAP_APPEND_PER_CALL_MAX_CHARS = 4000;

/**
 * Cap on the RESULTING `context` (existing + header + new text) after this
 * append lands. Measured against the same 107-card roadmap: the longest
 * observed context is 14122 characters, so this cap refuses nothing that
 * exists today.
 *
 * UNIT IS CHARACTERS, NOT BYTES. SQLite's `length()` (what the broker uses to
 * enforce this at write time) counts characters by default -- if a future
 * edit switches it to `length(cast(context as blob))`, the cap silently
 * starts counting bytes instead, and this comment (and the client-side
 * pre-check here) go quietly out of sync with what the broker actually
 * enforces.
 */
export const ROADMAP_APPEND_RESULT_MAX_CHARS = 16000;

/**
 * Delimiter markers wrapping every append header:
 *   \n<<< append <ISO8601> by <author> >>>\n
 *
 * Three chevrons, chosen by MEASURING collision against the live 107-card
 * roadmap, not by convention: '=== ' collides on 10 cards, '\n--- ' on 5,
 * '\n## ' on 1, '<<<'/'>>>' on zero. Three rather than seven chevrons is
 * deliberate too: it stays visually distinct from a git conflict marker
 * (`<<<<<<<`), which a card's context can legitimately contain (pasted diffs,
 * merge notes) without meaning "append boundary here".
 *
 * Either marker appearing in a caller's SUBMITTED text is refused outright
 * (see planRoadmapContextAppend) -- not stripped, not escaped. A payload that
 * embeds a forged header (e.g. an attacker-controlled block containing its
 * own "<<< append ... by deck >>>") must never be allowed to land inside a
 * real one and be read back as a legitimate entry by a future consumer of
 * this field.
 */
export const ROADMAP_APPEND_HEADER_OPEN = "<<<";
export const ROADMAP_APPEND_HEADER_CLOSE = ">>>";

/**
 * Builds the attribution header for one append. Takes the timestamp as an
 * explicit ISO-8601 string rather than calling `Date.now()`/`new Date()`
 * itself -- this module stays pure, and the caller (broker.ts) is the one
 * place that already owns "what time is it".
 *
 * VOCABULARY, deliberate: this is an ATTRIBUTION, never call it a
 * "signature" in code or comments that touch it. `resolveRoadmapAuthor`
 * (broker.ts) accepts an unproven `by` -- the header records who CLAIMED the
 * append, proven or not, exactly like `created_by`/`updated_by` elsewhere on
 * a RoadmapItem. Writing "signed" here would assert a guarantee this header
 * is not wired to.
 *
 * The timestamp is not cosmetic either, and the two facts travel together:
 * append is NOT idempotent (a caller whose request times out AFTER the
 * broker already committed will retry and duplicate the block on a second
 * call), and the timestamp is what makes that duplicate visible to whoever
 * reads the card afterward. Making the header optional "to save N
 * characters" would make that non-idempotence invisible, not free.
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
 * Validates and plans the part of an append that depends ONLY on the
 * incoming call -- never on the card's current `context`. This is the
 * function the broker's future /roadmap/context-append route calls: the
 * card's architecture deliberately has NO read-modify-write on the broker
 * side (a single `UPDATE ... SET context = COALESCE(context,'') || ? WHERE
 * id = ? AND length(COALESCE(context,'')) + ? <= 16000`, `db.changes`
 * distinguishing 200 from 409), so the broker never has an `existingContext`
 * to hand this module and must never SELECT one just to satisfy this
 * function's shape. The RESULT cap (ROADMAP_APPEND_RESULT_MAX_CHARS) is
 * therefore NOT checked here -- it is enforced exclusively by that SQL WHERE
 * clause. See planRoadmapContextAppend below for the full check, used only
 * by a caller that already holds `existingContext` for another reason (e.g.
 * a client pre-refusing against a RoadmapItem it already fetched).
 *
 * NOTE for whoever writes that route (not yet written, tracked separately
 * from this pure-module layer): the COALESCE is not cosmetic. In SQLite,
 * `NULL || text` evaluates to `NULL`, so a card whose `context` is NULL
 * would have its append silently discarded (still a 200, `changes` would
 * still be 1, but `context` would stay NULL) without COALESCE -- and the
 * live 107-card corpus this module's caps were measured against has zero
 * NULL contexts, so a test built only from that corpus would stay green
 * without ever exercising this path. That route needs its own dedicated
 * NULL-context probe.
 *
 * Only `text` (the INCOMING append) is checked for the delimiter marker, not
 * the card's existing context: a card that already carries a prior,
 * legitimate append (and therefore already contains "<<<"/">>>" in its
 * history) must not have every future append refused because of markers it
 * did not just submit.
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
