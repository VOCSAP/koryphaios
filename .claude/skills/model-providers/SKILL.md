---
name: model-providers
description: Map of the multi-provider inference chain (unified catalog, ModelPicker, headless adapters claude/codex/gemini/local, utility inferences help/wand/digest, graph judge) — which file to edit for what, the per-CLI read-only harness flags, and the proxy workarounds to verify provider docs. Use when adding a model or provider to the pickers, touching a headless inference point, adding a model-choice setting, or verifying CLI/API syntax of a non-Anthropic provider.
---

# Multi-provider models & headless inference

Everything LLM-shaped in the Deck flows through ONE chain:
`FRONTIER_CATALOG`/local discovery → `ProviderCatalog` → `ModelPicker` →
`ModelTarget { cli, model, providerId? }` → executors. Edit at the right
altitude; imitate, don't invent.

## Add a frontier model (the common case)

1. **Verify the exact id in the official docs first — never from memory.**
   Anthropic: the `claude-api` skill carries the current ids. OpenAI/Gemini:
   see "Verifying provider docs" below. Ids must match
   `sanitizeModel` (`/^[A-Za-z0-9._:-]{0,128}$/`, `model-adapters.ts`) —
   anything else is silently dropped from the command line.
2. Edit `FRONTIER_CATALOG` in `desktop/src/shared/models.ts` — the ONE
   constant to bump (D10). **Add alongside, don't replace**: favorites are
   `providerId:modelId` keys resolved against the catalog; removing an entry
   silently hides the favorites pointing at it.
3. Nothing else. Tests compare against the constant itself; local providers
   (Ollama/LiteLLM) are discovered dynamically (`/v1/models`, `/api/tags`),
   never listed in code. Run `bun test tests/desktop-models-catalog.test.ts`
   + the desktop typecheck.

The `[1m]` context suffix (CreateMenu) is Claude-session-only — catalog
entries never carry it.

## The inference points and their executors

| Point | Target setting | Executor |
|---|---|---|
| Help "?" + resume digest | `config.helpTarget` | `utility-inference.ts` |
| Roadmap context wand 🪄 | `config.wandTarget` | `utility-inference.ts` |
| Graph fan-out + battle judge | per-graph (renderer state) | `graph-engine.ts` |
| Peer auto-summary (core) | `summary_*` config/env | `shared/summarize.ts` |
| Agent tiles / supervisor / plan import | Claude Code sessions only (lot B, `EXPLORATION-multi-llm.md` §4) | `session-command.ts` |

All one-shot prompts are CODE CONSTANTS (C8) — never operator/repo templates.
Any new one-shot inference goes through `runUtilityInference` (or imitates
it): claude keeps system/question separated, codex/gemini get one composed
stdin document, `local` goes over HTTP — context always travels by FILE or
HTTP body, never the command line (D5).

## Read-only harness per CLI (D6, revised lot A)

| CLI | Flags |
|---|---|
| claude | `-p` + `--strict-mcp-config --disallowedTools "<HELP_DISALLOWED_TOOLS>"` (Read/Grep/Glob stay) |
| codex | `codex exec --sandbox read-only -m <model> -` (stdin via `-`) |
| gemini | `--approval-mode plan` (documented read-only mode), pure stdin, `-m <model>` |
| local | OpenAI-compat `/v1/chat/completions` — no tools at all (can't ground in project files; say so in help texts) |

## Add a model-choice setting

Imitate `helpTarget` end to end: `ModelTarget` field in `AppConfig`
(`shared/types.ts`) → default + `sanitizeTarget(...)` validation/migration in
`store.ts:loadConfig` → `ModelPicker` (single) in SettingsView with
`selected={[targetKey(target)]}` → route by `target.cli` at the call site.
UI strings: three files (en.json, fr.json, `EN_DEFAULTS`) or
`desktop-i18n.test.ts` fails.

## Verifying provider docs (proxy quirks, observed 2026-07)

- `developers.openai.com`, `geminicli.com`, `docs.onlinetool.cc` → **403 via
  the agent proxy**. The `docs/*.md` of `openai/codex@main` are **stubs**
  pointing there: fetch an old tag instead —
  `raw.githubusercontent.com/openai/codex/rust-v0.36.0/docs/config.md` has
  the full config/MCP/profiles reference.
- Gemini: `github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md`
  (blob pages render fine) + the repo README for flags.
- Ollama/LiteLLM: endpoints are already implemented and tested
  (`model-adapters.ts` / `model-registry.ts`) — only re-verify on breakage.
- WebSearch snippets are fine for discovery; confirm exact flags/ids against
  a first-party page (or repo file) before shipping them in code.

## Codex/Gemini gotchas worth remembering

- Codex config overrides: `-c key=value`, values parsed as TOML, dotted keys
  (`-c 'mcp_servers.x.env={A="1"}'`). `developer_instructions` is ADDITIVE to
  the harness; `model_instructions_file` REPLACES it (avoid).
- Codex sessions: `codex resume <id>|--last`, no `--session-id` at spawn, no
  fork equivalent — the Deck's fork-on-resume model does not transpose.
- Gemini headless triggers on non-TTY stdin automatically; `-p` text is
  APPENDED after piped stdin.
- Supervisor-under-Codex feasibility + open checklists: `EXPLORATION-multi-llm.md`
  §4 (retired into CHANGELOG when the batch ships).
