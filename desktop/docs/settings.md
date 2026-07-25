# Settings & configuration reference

## The Settings page (⚙ / Edit > Settings… / Ctrl+,)

A full-window, VS Code-style settings page: category tree on the left, fields
on the right. Changes apply **live** (no Save button): discrete inputs on
change, free-text inputs on blur.

### General

| Setting | Effect |
|---------|--------|
| **Language** | Auto (OS) or any language present as `locales/*.json` (English, Français), switchable live |
| **Re-open saved sessions on launch** | Restore the previous session set when the app starts |
| **Remember shared scope secrets** | Store custom (shared) group secrets encrypted via the OS keystore, so their workspaces restore without re-supplying the secret. Off = supply the secret via the launch argument each time |
| **Auto-resume sessions when the usage limit resets** | Global quota auto-resume default (overridable per session via its right-click menu) |
| **System notification when a session waits for your input** | The "needs you" notification (⏸ badge always shows) |
| **Show the floating "?" help button** | Show/hide the help assistant button (also right-click > hide) |
| **Supervisor agent spawns** | Trust mode for supervisor-initiated spawns: Hands-free / Team review / Full control (see [supervisor-team.md](supervisor-team.md)) |

### Appearance

| Setting | Effect |
|---------|--------|
| **Theme** | Dark / light |
| **Font size** | Terminal & UI font size |
| **Display mode** | Default tile layout: 1×1 carousel, 1×2, 2×2, custom grid |
| **Session colour palette** | The rotating palette auto-assigned to new sessions (add/remove/reset colours; each session can still be recoloured individually) |

### Terminal

| Setting | Effect |
|---------|--------|
| **Project directory** | Default working directory for new peer terminals |
| **Launch command** | Command run in each terminal, with `--session-id` appended. Saved to the **global** launch config; a project config overrides it (see below) |
| **Shell override** | Empty = auto (`$SHELL` on Unix, `powershell.exe` on Windows) |
| **Interactive shell** | Load rc/profile so shell aliases resolve (start-marker noise stripping applied) |

### Models

| Setting | Effect |
|---------|--------|
| **Detected CLIs** | Frontier providers (claude / codex / gemini) are offered in model pickers only when their CLI is installed; a Refresh button re-detects |
| **Local model endpoints** | OpenAI-compatible endpoints (Ollama, LiteLLM, vLLM…): name, base URL, optional API key (stored encrypted). Models are listed automatically via `/v1/models` (or Ollama `/api/tags`) |
| **Help assistant & resume digest model** | Any catalog target; Haiku default. Note: local endpoints cannot read project files |
| **Roadmap context-wand model** | The read-only inference drafting item briefings; Haiku default |
| Favorites (★ in pickers) | Pin models to the top of every model picker |

## Config files

### Global app config

Location: `%APPDATA%\koryphaios\config.json` (Windows) or
`$XDG_CONFIG_HOME/koryphaios/config.json` (Linux/macOS, default
`~/.config/koryphaios`). Holds the global launch config and the digest
sources. Most of it is edited through the Settings UI; the digest section is
file-only.

### Launch configuration

Resolution order (first wins):

1. **Project-local** `<project>/.claude/claude-peers/config.json`
2. **Global** config file (above)
3. Built-in default:
   `claude --dangerously-load-development-channels server:claude-peers`

Fields:

```jsonc
{
  "launchCommand": "claude --dangerously-load-development-channels server:claude-peers",
  "presets": [
    { "label": "Planner", "args": "--model opus", "prompt": "Read PLAN.md and plan" }
  ],
  "models": [
    { "id": "opus", "label": "Opus" },
    { "id": "sonnet", "label": "Sonnet" },
    { "id": "haiku", "label": "Haiku" }
  ],
  "worktreeInit": "bun install"
}
```

- `presets` — one-click arg bundles in the advanced create menu (optional
  `prompt` pre-fills the initial prompt field).
- `models` — the create-menu model dropdown; edit to track new model ids
  without rebuilding the app.
- `worktreeInit` — command run in the background inside each fresh worktree.
- **Security**: a `launchCommand` coming from a *project* config triggers a
  one-time approval dialog (sha256 remembered per project; refusal falls
  back to the global command).

### Feature flags (per machine)

An optional `features` block in the config file toggles per-machine behavior
used by the roadmap's [directive cards](roadmap.md#directive-cards-contexttoken-economy):

```jsonc
{
  "features": {
    "magicCompact": "auto",   // "auto" (use the Magic Compact plugin when present) | "on" | "off"
    "handoff": "file"          // "file" | "kleos" | "off" (advisory hand-off style)
  }
}
```

- `magicCompact` decides how a `magic_compact` directive behaves: `auto` uses
  the [Magic Compact plugin](https://github.com/aerovato/Magic-compact) when it
  is detected under the Claude config's `plugins/` dir (honoring
  `CLAUDE_CONFIG_DIR`), `on` always tries it, `off` always uses plain
  `/compact`.
- `handoff` is advisory only (it influences briefing wording, not any command).
- **Security**: because `magicCompact` makes the app type a command into an
  agent's terminal, it is **read from the global config only** — a project-local
  (cloned-repo) config can only *restrict* it to `off`, never enable it. This
  mirrors the `launchCommand` / digest-sources gating. `handoff`, being
  advisory text, follows the normal project-then-global precedence.

### Resume digest sources

In the **global** config file only (never project-local, by design —
a repo-carried command list would execute arbitrary code on clone):

```jsonc
{
  "digest": {
    "sources": [
      { "file": "PLAN*.md" },
      { "command": "git log --oneline -15" }
    ],
    "perProject": {
      "<project_key>": [ { "file": "docs/STATUS.md" } ]
    }
  }
}
```

- Each source is exactly one of `file` (path or single-`*` glob in the last
  segment, resolved from the project dir, max 10 files per glob) or
  `command` (run with cwd = project dir, 15 s timeout).
- Each collected source is capped at 20 000 chars.
- `perProject` **replaces** the base list for that project.
- Defaults when unset: `PLAN*.md` + `git log --oneline -15`.

### Locale overrides

UI dictionaries are `locales/en.json` / `locales/fr.json` shipped with the
app. Users can override any key by dropping a `<lang>.json` into
`<userData>/locales/`; missing keys fall back to the shipped file, then to
the embedded English base.

## Data locations

| Data | Location |
|------|----------|
| App config & session persistence | Electron `userData` dir (`koryphaios`) |
| Workspaces | `<project>/.claude/claude-peers/workspaces/*.json` (git-ignored) |
| Local templates | `<project>/.claude/claude-peers/templates/` |
| Global templates | global config dir |
| Project snippets | `<project>/.claude/claude-peers/snippets/` |
| Worktrees | `<project>/.worktrees/<branch>/` (add to `.gitignore`) |
| Dirty-tree checkpoints | `refs/claude-peers/` stash anchors (auto-purged after 7 days) |
| Annotated screenshots | app state dir (pruned after 7 days) |
| Roadmap, inbox, graph drafts | the claude-peers broker (SQLite) |
| Graph chats | app state dir, per project |
| Sandbox settings (per project) | `sandbox.json` in the app state dir |
| Sandbox ephemeral clones | `sandbox-copies/<container>/` in the app state dir |
| Sandbox session launch scripts | `sandbox-run/` in the app state dir |
| Sandbox Claude login | the `kory-claude-auth` Docker volume (not a file) |

## Environment variables (advanced)

Injected by the app into session terminals (informational — not
user-configured): `CLAUDE_PEERS_FORCE_GROUP[_FILE]` / `..._NAME` (group
pinning), `CLAUDE_PEERS_STATUS_LINE_CACHE=1` and
`CLAUDE_PEERS_DESK_SESSION` (peer-id / session-id back-channels),
`CLAUDE_DECK_DESIGN_URL` / `CLAUDE_DECK_DESIGN_TOKEN` (design endpoint).
In sandbox mode the container additionally receives
`CLAUDE_PEERS_BROKER_URL` (+ `_TOKEN`) pointed at `host.docker.internal`, so
the containerized session joins the HOST broker instead of spawning its own.
The claude-peers server/broker side has its own `CLAUDE_PEERS_*` variables,
documented in the claude-peers README.
