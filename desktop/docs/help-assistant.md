# The floating "?" help assistant & the resume digest

## The help assistant

The floating **"?"** button (bottom corner) opens a popup where the operator
asks about the app or about what's on screen — "which roadmap item should I
tackle next?", "how do I give an agent its own branch?".

### How it works

- Each question is a **one-shot, stateless inference** (no long-lived chat
  session). The popup replays the last few exchanges into the prompt for
  conversational continuity.
- The app injects a **context snapshot** into the system prompt: the active
  view plus the live app state — roadmap items, sessions (status, peer ids,
  worktree branches), git worktrees. Questions are grounded in what is
  actually on screen.
- The app also points the assistant at **this documentation directory**, so
  questions about features and options are answered from the reference docs
  rather than guesswork (CLI targets read the files; local HTTP endpoints
  cannot read files and rely on the snapshot alone).
- It answers **in the language of the question**.

### Strictly read-only

The assistant is an **advisor, never an actor** — technically, not just by
prompt: no MCP servers are loaded and every mutating tool is disabled. It
cannot spawn sessions, edit the roadmap, modify files or run commands. If
asked to DO something, it explains how the operator can do it in the UI or
delegate it to the supervisor (Home view).

### Options

- **Model**: right-click the "?" button to switch the model, or set it in
  `Settings > Models > Help assistant & resume digest model`. Any catalog
  target works (frontier CLI or local endpoint); **Haiku is the default** —
  cheap and usually enough.
- **Hide**: right-click > hide, or `Settings > General > Show the floating
  "?" help button`.

## The resume digest (📋)

One click in the help popup produces a **"where things stand / in flight /
what's next"** briefing for an operator coming back to a project. It combines:

- the same live app snapshot (roadmap, sessions, worktrees), and
- **configurable project sources**: files/globs (e.g. `PLAN*.md`) and
  commands (e.g. `git log --oneline -15`) run in the project directory.

Default sources are `PLAN*.md` + `git log --oneline -15`. Sources come from
the **global** config only — never from a repo-carried config (a cloned
repository must not be able to execute arbitrary commands). See
[settings.md](settings.md#resume-digest-sources) for the config format,
including per-project overrides.

The digest answers in the configured UI language and uses the same model and
read-only harness as the help assistant.
