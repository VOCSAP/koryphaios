// No entry point here: the Deck main process imports this, and the hook's own
// module ends the process when run directly.

import { stripControl } from "../../shared/approval.ts";

/** Length at which a title's tool detail is cut; the full input stays in the question. */
export const TITLE_DETAIL_MAX = 160;

/** Single-line summary of a tool call, safe for a notification title. */
export function summarizeToolInput(toolName: string, input: Record<string, unknown> | undefined): string {
  const name = stripControl(toolName || "tool").trim() || "tool";
  if (!input || typeof input !== "object") return name;
  const detail =
    typeof input.command === "string"
      ? input.command
      : typeof input.file_path === "string"
        ? input.file_path
        : typeof input.path === "string"
          ? input.path
          : typeof input.url === "string"
            ? input.url
            : "";
  const clean = stripControl(String(detail)).trim();
  return clean ? `${name}: ${clean.slice(0, TITLE_DETAIL_MAX)}` : name;
}
