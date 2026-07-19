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
  helpers (help, digest, wand — `utility-inference.ts`) target any catalog
  model (`config.helpTarget` / `config.wandTarget`) and run read-only per
  CLI: `claude -p --strict-mcp-config --disallowedTools` (Read/Grep/Glob
  stay), `codex exec --sandbox read-only`, `gemini --approval-mode plan`;
  local endpoints are pure chat (no tools).
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
  is desktop-local per project_key (`graph-store.ts`), encrypted at rest via
  the safeStorage-backed cipher (K8: envelope with a base64 payload; legacy
  clear files are re-encrypted on first list; clear-text fallback when the OS
  keychain is unavailable so the feature never breaks). Graph drafts: the
  main process polls the broker's pending `graph_drafts` (agent-escalated
  questions, see ARCHITECTURE.md) — they surface as action cards in the ✉
  inbox with a pulsing rail glyph (`is-glowing`), and "Open in graph" creates
  a doc with the pre-filled unsubmitted prompt node, flips the draft
  broker-side, and navigates the graph view onto it (`graphFocus` in the
  store). The inbox itself is persisted to `inbox-history.json`
  (`inbox-store.ts`) because the broker drain is destructive.
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

## Error reporting & logs (PLAN-observabilite O3–O6)

- The main process logs to a rolling `main.log` under `app.getPath('logs')`
  (`desktop/src/main/log.ts`); `reportError(scope, msg, err)` is the single
  sink (file + console in dev + a journal `error` entry). The renderer reaches
  it via `window.api.reportError` / the store's `guarded()` wrapper.
- Process nets live in `index.ts`: `uncaughtException`/`unhandledRejection`
  (log-and-continue once the app is ready; dialog + exit before),
  `render-process-gone` (reload offer), `child-process-gone`.
- Every top-level view is wrapped in an `ErrorBoundary` (App.tsx) — a render
  crash falls back per-view, terminals survive. Wrap new views the same way.
- Broker reachability: `BrokerHealthTracker` (broker-client.ts, fed by the
  inbox poll, 2-failure hysteresis) → `broker:status` → the renderer's red
  `StatusBanner`. Outages are a banner (state), never toasts (events).
- Toast policy: `showToast` is reserved for direct user-action outcomes,
  throttled per key; `error` variant carries raw text (`{ raw: true }`).
- The activity journal flushes to `logs/journal-<date>.log` at quit (pruned
  after 7 days). Full conventions: `.claude/skills/error-reporting/`.

## Renderer view conventions (canvas views especially)

Micro-conventions inferred from the existing views — follow them when
touching `GraphView.tsx` or building anything canvas-like:

- **Dependency-free rendering**: SVG edges + absolutely-positioned divs,
  manual camera (`translate/scale` on a world div). No graph/layout library.
- **Pure logic goes to `desktop/src/shared/`**: anything main AND renderer
  need (or that deserves a bun test) lives there with no electron/node
  imports — e.g. grid constants, `layoutGraph`, `outlineOrder` in
  `shared/graph.ts`. The renderer imports via the `@shared/` alias.
- **Persistence pattern**: clone-and-replace the doc in local state, then
  save through one `mutateDoc(next, debounce?)` helper (400 ms debounce for
  keystroke/drag streams, immediate otherwise).
- **Canvas overlays** (toolbars, panels floating over the canvas) must
  `stopPropagation` on `mouseDown`/`click` (and `wheel` if scrollable),
  otherwise the canvas pan/deselect handlers swallow the interaction.
- **Reuse the app chrome**: `btn`, `icon-btn` (+ `.is-active`), CSS variables
  (`--bg*`, `--fg*`, `--accent`, `--selected`, `--border`). Node-kind colors
  are centralized in the `--graph-k-*` variables (styles.css) — timeline
  bullets, card accents and edges must all read from them.
- **i18n**: no hardcoded UI strings — see "Adding a UI string" in
  `TESTING.md` (three files, parity-tested).
