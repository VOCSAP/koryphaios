// An agent, invited by the operator, escalates a blocking question into a
// pre-filled (never auto-submitted) graph-chat prompt; a pinned-haiku one-shot
// compiles the question plus only relevant context so the more expensive models
// the operator later fans out to don't pay for repo exploration.
// The system prompt is a code constant, never operator- or repo-configurable;
// invocation is read-only (Read/Grep/Glob left available) and the model is
// pinned to haiku -- it only proposes, the calling agent reviews and explicitly
// sends.
// Security model (C8 rule, same harness family as the desktop's context wand):

export const GRAPH_DRAFT_MODEL = "haiku";
export const GRAPH_DRAFT_TITLE_MAX = 200;
export const GRAPH_DRAFT_PROMPT_MAX = 32 * 1024;
export const GRAPH_DRAFT_QUESTION_MAX = 4 * 1024;
export const GRAPH_DRAFT_TIMEOUT_MS = 120_000;

/** Same deny-list as the desktop one-shot helpers (help-assistant/context-wand). */
export const GRAPH_DRAFT_DISALLOWED_TOOLS =
  "Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,KillShell";

export const GRAPH_DRAFT_SYSTEM_PROMPT = [
  "You are the GRAPH DRAFT COMPILER of claude-peers/Koryphaios. A coding agent hit a question that needs a discussion between the human operator and one or more LLMs in the Koryphaios GRAPH CHAT view. Your ONLY job: turn the agent's raw question into ONE ready-to-send prompt draft. The draft will be placed, UNSUBMITTED, in a fresh graph conversation; the operator will pick the target models and launch the inference. Those target models will NOT have access to the repository: your draft is everything they get.",
  "You may use Read, Grep and Glob on the current project to verify claims and collect references. You are technically read-only: never try to modify files, run commands or use other tools.",
  [
    "Output format — STRICT:",
    "- First line: `# <short title>` (a few words naming the question).",
    "- Then a `## Question` section: the question restated clearly and completely, self-contained (a reader with zero prior context must understand it).",
    "- Then a `## Context` section ONLY IF it helps answer: the minimum strictly relevant facts (existing behavior, constraints, decisions already made, short code excerpts of a few lines when they carry the crux). No repo tour, no filler.",
    "- Then a `## References` section: repo-relative `path:line` pointers the responders MAY consult through the human if needed. Only files you actually verified.",
    "- Nothing else: no preamble, no closing remarks, no code fence around the whole answer.",
  ].join("\n"),
  "Budget: the whole draft must stay well under 8000 characters — dense and curated beats exhaustive. Write in the language of the agent's question.",
].join("\n\n");

/** User message of the one-shot: the agent's question plus optional hints. */
export function composeDraftUserMessage(question: string, hints?: string): string {
  const q = question.trim().slice(0, GRAPH_DRAFT_QUESTION_MAX);
  const h = hints?.trim().slice(0, GRAPH_DRAFT_QUESTION_MAX);
  return h
    ? `Agent question:\n${q}\n\nAgent hints (files/areas already identified):\n${h}`
    : `Agent question:\n${q}`;
}

/**
 * Argv (NO shell, spawn-ready) of the read-only pinned-haiku one-shot.
 * Mirrors the desktop's buildHelpCommand flag set; array form avoids the
 * shell-quoting problem entirely.
 */
export function buildDraftPrepareArgs(opts: {
  userMessage: string;
  systemPromptFile: string;
  claudeBin?: string;
}): string[] {
  return [
    opts.claudeBin?.trim() || "claude",
    "-p",
    opts.userMessage,
    "--append-system-prompt-file",
    opts.systemPromptFile,
    "--model",
    GRAPH_DRAFT_MODEL,
    "--strict-mcp-config",
    "--disallowedTools",
    GRAPH_DRAFT_DISALLOWED_TOOLS,
  ];
}

/**
 * Split the one-shot output into {title, prompt}: the leading `# title` line
 * feeds the graph doc name, the body (title line stripped) is the node text.
 * Falls back to the question when the model ignored the title format.
 */
export function parseDraftOutput(
  output: string,
  fallbackTitle: string
): { title: string; prompt: string } {
  const text = output.trim();
  const m = text.match(/^#\s+(.+)\s*\n+/);
  const title = (m?.[1] ?? fallbackTitle).trim().slice(0, GRAPH_DRAFT_TITLE_MAX) || "question";
  const prompt = (m ? text.slice(m[0].length) : text).trim().slice(0, GRAPH_DRAFT_PROMPT_MAX);
  return { title, prompt };
}

/**
 * Normalize/validate a draft payload before it reaches the broker (shared by
 * the server tool and the broker endpoint: single source of truth). Returns
 * the normalized fields or an error string.
 */
export function validateDraftPayload(raw: {
  title?: unknown;
  prompt?: unknown;
}): { title: string; prompt: string } | { error: string } {
  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, GRAPH_DRAFT_TITLE_MAX) : "";
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  if (!title) return { error: "title is required" };
  if (!prompt) return { error: "prompt is required" };
  if (prompt.length > GRAPH_DRAFT_PROMPT_MAX) {
    return { error: `prompt too long (max ${GRAPH_DRAFT_PROMPT_MAX} chars)` };
  }
  return { title, prompt };
}
