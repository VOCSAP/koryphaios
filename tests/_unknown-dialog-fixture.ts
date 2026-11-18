import type { XtermScreenRead, XtermScreenSnapshot } from "../desktop/src/main/xterm-screen.ts";

export const UD_COLS = 140;
export const UD_ROWS = 40;
export const RULE = "─".repeat(UD_COLS);
export const CHEVRON = "❯";
export const FOOTER = "Enter to confirm · Esc to cancel";

export const ADD_DIR_LINES: string[] = [
  RULE,
  "Adding a new directory:",
  "",
  "/srv/synthetic/project",
  "",
  "This session hasn't worked here before. Is this a directory you created or one you trust?",
  "",
  `${CHEVRON} No, exit`,
  "  Yes, add it",
  "",
  FOOTER,
];

export function padded(lines: string[], at = 0): string[] {
  const out = Array<string>(UD_ROWS).fill("");
  lines.forEach((line, i) => (out[at + i] = line));
  return out;
}

export function snapshotOf(lines: string[], cursor = { x: 0, y: 0 }): XtermScreenSnapshot {
  return { revision: 1, cols: UD_COLS, rows: UD_ROWS, lines: padded(lines), cursor };
}

export const readyOf = (lines: string[]): XtermScreenRead => ({ status: "ready", snapshot: snapshotOf(lines) });
export const unavailableRead = (reason: "resize-pending" | "screen-pending" | "screen-fault" = "resize-pending"): XtermScreenRead => ({
  status: "unavailable",
  reason,
});
export const blankRead = (): XtermScreenRead => readyOf([]);

export const COMPOSER_LINES: string[] = [...Array<string>(36).fill(""), RULE, `${CHEVRON} `, RULE];
export const composerRead = (): XtermScreenRead => ({
  status: "ready",
  snapshot: { revision: 1, cols: UD_COLS, rows: UD_ROWS, lines: padded(COMPOSER_LINES), cursor: { x: 2, y: 37 } },
});

const quoted = ADD_DIR_LINES.slice(1).map((line) => (line === "" ? "" : `  ${line}`));

export const QUOTED_IN_COMPOSER: string[] = [RULE, `${CHEVRON} ${ADD_DIR_LINES[1]}`, ...quoted.slice(1), RULE];

const quotedWithRule = ADD_DIR_LINES.map((line, i) => (line === "" ? "" : i === 0 ? `  ${RULE.slice(2)}` : `  ${line}`));

export const QUOTED_IN_ANSWER_THEN_COMPOSER: string[] = [
  "● The dialog reads:",
  ...quotedWithRule,
  ...Array<string>(36 - 1 - quotedWithRule.length).fill(""),
  RULE,
  `${CHEVRON} `,
  RULE,
];

export const QUOTED_IN_ANSWER_BUSY: string[] = ["● The dialog reads:", ...quotedWithRule];

export const ADD_DIR_SELECTION_MOVED: string[] = ADD_DIR_LINES.map((line) =>
  line === `${CHEVRON} No, exit` ? "  No, exit" : line === "  Yes, add it" ? `${CHEVRON} Yes, add it` : line
);

export const BUSY_CHUNK = "✳ Working… (12s · esc to interrupt)\r\n";
