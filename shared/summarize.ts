/**
 * Generate a 1-2 sentence summary of what a Claude Code instance is likely
 * working on, based on its working directory and git context.
 *
 * Multi-provider with graceful fallback:
 *   - "anthropic"     -> Anthropic Messages API (https://api.anthropic.com)
 *   - "openai-compat" -> any OpenAI-compatible /chat/completions endpoint
 *                        (LiteLLM, Ollama via /v1, OpenRouter, vLLM, OpenAI...)
 *   - "none"          -> heuristic only
 *
 * Resolution: see shared/config.ts (resolveProvider).
 *
 * If the network call fails (no key, HTTP error, timeout, parse error), the
 * heuristic summary is returned. Never throws, always returns a non-empty string.
 */

import { basename } from "node:path";
import { normalizeRemoteUrl } from "./project-key";

// Card 6aa32af4 (2nd review round): normalizeRemoteUrl used to be defined
// here; moved to shared/project-key.ts (single source, imported by
// desktop/src/main/roadmap-service.ts too) and re-exported below so
// existing `from "./summarize.ts"` imports keep working.
export { normalizeRemoteUrl };

export interface SummaryContext {
  cwd: string;
  git_root: string | null;
  git_branch?: string | null;
  recent_files?: string[];
}

export interface SummaryProviderConfig {
  /** Resolved provider. */
  provider: "anthropic" | "openai-compat" | "none";
  /** Bearer / x-api-key. */
  api_key: string | null;
  /** Model identifier passed to the provider. */
  model: string;
  /** Base URL for openai-compat (must include /v1 suffix when applicable). */
  base_url?: string | null;
}

const SYSTEM_PROMPT =
  "You generate brief summaries of what a developer is working on based on their project context. Respond with exactly 1-2 sentences, no more. Be specific about the project name and likely task.";

const HTTP_TIMEOUT_MS = 5000;

export function heuristicSummary(context: SummaryContext): string {
  const projectName = context.git_root
    ? basename(context.git_root)
    : basename(context.cwd) || context.cwd;

  const parts = [`Working on \`${projectName}\``];
  if (context.git_branch) {
    parts.push(`(branch: ${context.git_branch})`);
  }
  if (context.recent_files && context.recent_files.length > 0) {
    const preview = context.recent_files.slice(0, 3).join(", ");
    parts.push(`-- recent: ${preview}`);
  }
  return parts.join(" ");
}

function buildUserMessage(context: SummaryContext): string {
  const parts = [`Working directory: ${context.cwd}`];
  if (context.git_root) parts.push(`Git repo root: ${context.git_root}`);
  if (context.git_branch) parts.push(`Branch: ${context.git_branch}`);
  if (context.recent_files && context.recent_files.length > 0) {
    parts.push(`Recently modified files: ${context.recent_files.join(", ")}`);
  }
  return `Based on this context, what is this developer likely working on?\n\n${parts.join("\n")}`;
}

async function callAnthropic(
  ctx: SummaryContext,
  cfg: SummaryProviderConfig
): Promise<string | null> {
  // Card 630e3d16 audit round 2: no process.env.ANTHROPIC_API_KEY fallback
  // here. cfg.api_key is fully resolved upstream by
  // shared/config.ts#buildSummaryProviderConfig before it ever reaches
  // generateSummary, which is this function's only caller. Reading the env
  // var again here would be a second, redundant leak path if the Anthropic
  // endpoint below is ever made configurable without updating this file.
  const apiKey = cfg.api_key;
  if (!apiKey) return null;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: cfg.model,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserMessage(ctx) }],
        max_tokens: 100,
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    return data.content?.[0]?.text?.trim() ?? null;
  } catch {
    return null;
  }
}

async function callOpenAICompat(
  ctx: SummaryContext,
  cfg: SummaryProviderConfig
): Promise<string | null> {
  if (!cfg.base_url) return null;

  const url = `${cfg.base_url.replace(/\/+$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.api_key) headers["Authorization"] = `Bearer ${cfg.api_key}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserMessage(ctx) },
        ],
        max_tokens: 100,
        temperature: 0.3,
        stream: false,
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * Try the configured provider. On any failure, return the heuristic summary.
 * Never throws, never returns null.
 */
export async function generateSummary(
  ctx: SummaryContext,
  providerCfg: SummaryProviderConfig
): Promise<string> {
  let llm: string | null = null;

  if (providerCfg.provider === "anthropic") {
    llm = await callAnthropic(ctx, providerCfg);
  } else if (providerCfg.provider === "openai-compat") {
    llm = await callOpenAICompat(ctx, providerCfg);
  }

  return llm ?? heuristicSummary(ctx);
}

/**
 * Get the current git branch name for a directory.
 */
export async function getGitBranch(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) return text.trim();
  } catch {
    // not a git repo
  }
  return null;
}

/**
 * Get recently modified tracked files in the git repo.
 */
export async function getRecentFiles(
  cwd: string,
  limit = 10
): Promise<string[]> {
  try {
    const diffProc = Bun.spawn(["git", "diff", "--name-only", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const diffText = await new Response(diffProc.stdout).text();
    await diffProc.exited;

    const files = diffText
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);

    if (files.length >= limit) {
      return files.slice(0, limit);
    }

    const logProc = Bun.spawn(
      ["git", "log", "--oneline", "--name-only", "-5", "--format="],
      {
        cwd,
        stdout: "pipe",
        stderr: "ignore",
      }
    );
    const logText = await new Response(logProc.stdout).text();
    await logProc.exited;

    const logFiles = logText
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);

    const allFiles = [...new Set([...files, ...logFiles])];
    return allFiles.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Compute a normalized "project key" from a directory's git remote URL.
 * Used for cross-PC repo matching, so that two clones of the same repo on
 * different machines (with different cwd/git_root paths) can be matched.
 *
 * Examples:
 *   git@github.com:vocsap/koryphaios.git   -> github.com/vocsap/koryphaios
 *   https://github.com/vocsap/koryphaios.git -> github.com/vocsap/koryphaios
 *   ssh://git@gitlab.com:2222/group/proj.git     -> gitlab.com/group/proj
 *
 * Returns null if no git remote is configured.
 */
export async function computeProjectKey(cwd: string): Promise<string | null> {
  let remoteUrl: string | null = null;
  try {
    const proc = Bun.spawn(["git", "remote", "get-url", "origin"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) {
      remoteUrl = text.trim();
    }
  } catch {
    return null;
  }
  if (!remoteUrl) return null;

  return normalizeRemoteUrl(remoteUrl);
}
