# Graph chats

The **Graph** view hosts branching, multi-model conversations: a canvas of
nodes where each node is a message and its inferred answers, and edges are
"context flows into" relations. Graphs are per-project and stored locally by
the app (never in the repo).

## Why a graph instead of a linear chat

- **Branch** from any point ("what if…?", "go deeper on…") without losing
  the other branches.
- **Merge** branches: create a node from a multi-selection — the parents'
  histories are compiled as a common trunk plus one labeled section per
  branch.
- **Compare models**: fan one prompt out to several inference targets side
  by side.

## Working the canvas

- `＋ New` creates a graph; `＋ Root node` starts it.
- Select a node to act on it: **Reply** (child node), **Connect parent**
  (add an edge; cycles are refused), **Inspect context** (see the exact
  compiled context sent as the system side), delete (leaf nodes only).
- Shift-click for multi-selection, drag to move, wheel to zoom; auto-arrange
  lays nodes out by hierarchy level. A timeline panel lists nodes
  chronologically.

## Inference targets

Each prompt node can be inferred against one or more **targets** from the
unified model catalog:

- **Frontier CLIs** — claude, codex, gemini; a provider is offered only when
  its CLI is detected on the machine (re-detect in `Settings > Models`).
- **Local endpoints** — OpenAI-compatible servers (Ollama, LiteLLM, vLLM…)
  added in `Settings > Models`; their model lists are discovered
  automatically.
- Favorites (★) pin models to the top of every picker.

Inferences are **one-shot and read-only**: no MCP servers, mutating tools
disabled (claude `--disallowedTools`, codex `--sandbox read-only`, gemini
`--approval-mode plan`). CLI targets can read the project files to ground
answers; local HTTP endpoints cannot.

## Battle mode

Check several targets and enable **Battle mode**: each CLI answers
independently, then a **judge node** (claude) compares the anonymized answers
and produces the merged one.

## Agent-escalated drafts

Agents can park a question durably on the broker for the operator. Pending
drafts appear in the **Inbox** panel under "Questions to open in the graph";
**Open in graph** creates a graph doc with the pre-filled (unsubmitted)
prompt node — running the inference stays a manual operator action.
