# Desktop (Koryphaios) overview

Electron + React 19 + zustand, xterm terminals over node-pty. Sources in
`desktop/src/{main,preload,renderer,shared}`; `@shared` maps to `src/shared`
(types and pure logic shared across processes). Highlights:

- **Sessions**: PTY tiles wrapped in a login shell (`shell-command.ts`),
  workspaces (save/restore) and portable templates; per-session worktrees
  (`worktree-service.ts`); git checkpoints before spawning into a dirty tree.
- **Supervisor (Home rail)**: a Claude session piloting the app through a
  loopback deck-control endpoint + dependency-free MCP stdio bridge, injected
  only into the supervisor via a generated `--mcp-config`.
- **Locked harnesses (C8 rule)**: every agent prompt (supervisor, plan import,
  reviewer, dispatch, digest, help assistant, context wand, graph chat/merge/
  judge) is a CODE CONSTANT, never operator- or repo-configurable. One-shot
  helpers run read-only: `claude -p` with `--strict-mcp-config` +
  `--disallowedTools` (Read/Grep/Glob stay available).
- **Graph chat (🕸 rail view)**: per-project chat graphs where every exchange
  is a node and the graph is the source of truth — each assistant node is ONE
  stateless headless invocation whose context is recompiled from its
  ancestors (`graph-engine.ts`, `shared/graph.ts`). DAG: branch anywhere,
  cross N nodes into a fresh prompt node; multi-parent nodes get a
  documentary three-way merge rendering (common trunk once + labeled
  divergent branch sections — never a fake linear history). Fan-out targets
  `claude -p` / `codex exec --sandbox read-only` / `gemini` / local HTTP
  endpoints, the compiled context traveling by FILE
  (`--append-system-prompt-file` or stdin — never the command line). Battle
  mode adds a 🏆 judge node arbitrating the anonymized answers. Persistence
  is desktop-local per project_key (`graph-store.ts`).
- **Roadmap (🗺 rail view)**: kanban board over the broker's shared roadmap —
  one column per status (idea/planned/in_progress/done, + archived behind the
  toggle), MoSCoW priority as a colored chip + in-column sort, native HTML5
  drag & drop between columns (`RoadmapView.tsx`). Dropping on done asks for
  confirmation; a card locked by an agent (K2 work-lock: the broker locks an
  item whose status an agent set to in_progress) is greyed, non-draggable and
  carries a 🔒 `locked_by` badge. Clicking a card opens a foreground detail
  modal (`RoadmapItemModal.tsx`) rendering description/rationale/context
  through the injection-safe markdown tokenizer (`markdown.ts` — token tree,
  React escapes every text node; agent links are shown, never navigated).
  The ⏹ Stop button on a locked item routes a CODE-CONSTANT stop notice
  through the live supervisor when there is one (report back via the operator
  inbox) or broadcasts it to the group, then unlocks the item back to planned
  (`stopRoadmapItem`, `composeStopText`). An idle-lock watcher releases locks
  held by local tiles whose PTY printed nothing for 2 h; the broker's
  TTL/owner-gone sweep covers everything the Deck cannot observe. Right-click
  on a card opens a context menu (edit / queue / process-now / delete-as-
  archive); "Process now" targets one live agent with a CODE-CONSTANT
  announce (`composeAssignText`, IPC `roadmap:assign`) or spawns a fresh one.
- **Unified model picker** (`ModelPicker.tsx`, `shared/models.ts`,
  `model-registry.ts`): provider accordion + star-pinned favorites, shared by
  the graph fan-out and the agents' create menu. Frontier providers
  (Anthropic/OpenAI/Gemini) appear only when their CLI is detected
  (login-shell probe, cached); their model lists are curated in code
  (`FRONTIER_CATALOG` is the one constant to bump). Local OpenAI-compatible
  endpoints (Ollama, LiteLLM…) are configured in Settings > Models and
  discovered dynamically (`/v1/models`, `/api/tags` fallback); their API keys
  are encrypted at rest via safeStorage (`provider-secrets.ts` — the renderer
  only ever sees a `hasKey` marker).
- **Security gates**: PROJECT-config `launchCommand` requires a one-time
  operator approval (sha256 per project_key); resume-digest sources come from
  the GLOBAL config only (a repo-carried command list would execute arbitrary
  code on clone).
