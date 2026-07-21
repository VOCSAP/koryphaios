# Sessions: creating & managing agents

## Simple create

**`＋ Add peer`** in the sidebar starts a new session in the window's project
directory with the resolved launch command (see
[settings.md](settings.md#launch-configuration)). The session gets an
auto-assigned colour from the rotating palette and a default name.

## Advanced create (`▾`)

The advanced create popover exposes:

- **Agent** — a Claude Code agent profile, scanned from the project's
  `.claude/agents` and the user's `~/.claude/agents`. Becomes `--agent
  <name>` and seeds the default session name.
- **Name** — free display name (renamable later, double-click the row).
- **Model** — the `--model` value. The dropdown lists the models from the
  launch config (`opus`, `sonnet`, `haiku` by default; editable in the
  project or global config file without rebuilding the app).
- **Extended context (1M)** — appends the `[1m]` suffix to the model to use
  the 1-million-token context window. Supported on Opus and Sonnet, not
  Haiku.
- **Effort** — reasoning effort (`--effort`): Auto / Faster / Smarter. Stored
  per session and re-passed on every resume.
- **Extra launch args** — free-form args appended verbatim (e.g.
  `--add-dir ..`).
- **Initial prompt** — submitted to Claude as soon as the session opens.
  Fresh launch only; never re-played on resume.
- **Join announcement** — text broadcast to the group's peers once this
  session's `peer_id` resolves (defaults to an agent/model/effort summary;
  editable).
- **Presets** — one-click bundles of args (+ optional prompt) defined in the
  launch config.
- **Worktree branch** — creates a fresh git worktree under
  `<project>/.worktrees/` on this NEW branch and runs the session in it (see
  below).
- **Team-lead of this window** — designates the created session as the
  team-lead (👑). Pre-checked when the name matches the configured
  `leadPattern` and no lead exists yet.
- **Custom colour** — overrides the palette colour.
- **Advanced > Working folder** — run the peer in another directory. It
  still joins this window's group; only its cwd changes. Use with care — the
  peer can act on that folder.

## Worktree sessions

A session created with a worktree branch runs in `.worktrees/<name>` on its
own fresh branch, so parallel agents on the same repo never collide. Notes:

- Add `.worktrees/` to the project's `.gitignore`.
- An optional `worktreeInit` command in the launch config (e.g.
  `bun install`) runs in the background inside each fresh worktree.
- Closing the tile offers to remove the worktree. The **branch and its
  commits are always kept**; git's refusal to delete a dirty tree is
  respected (the worktree is then kept too).
- The ⎇ **Worktrees view** lists every worktree with branch, dirty count,
  last commit and attached session. **Orphans** (worktrees left by a closed
  tile) can be resumed into a new session or removed.
- Before an agent spawns into a **dirty working tree**, the app anchors a
  `git stash create` snapshot under `refs/claude-peers/` (the restore command
  is printed in the journal; snapshots auto-purge after 7 days).

## Session lifecycle

- **Status dot**: starting → running (with a *thinking* pulse while Claude is
  busy) → exited.
- **Restart peer** relaunches the terminal, resuming the same Claude
  conversation.
- **Close / remove** stops the terminal. The underlying Claude session can
  still be resumed later from history (via workspace restore).
- **Session ids**: the app tracks each tile's real Claude session id across
  rotations (including in-session `/clear`) through a deterministic
  back-channel written by the claude-peers server, so restore never reopens a
  stale state.

## Quota auto-resume (opt-in)

When a session hits Claude's usage limit, the app can wait for the reset time
printed on screen and submit `continue` automatically (one shot per episode).

- Off by default. Global toggle: `Settings > General > Auto-resume sessions
  when the usage limit resets`. Per-session override: sidebar right-click
  menu.
- While waiting, the status dot turns orange with an "auto-resume at HH:MM"
  badge; the journal records the episode.

## "Needs you" detection

When a session sits at a permission or question screen, its tile shows a ⏸
"needs you" badge and (if `Settings > General > System notification when a
session waits for your input` is on) a clickable system notification brings
it into view.

## Saved prompts (snippets)

Reusable prompts inserted into a session's input field — never sent
automatically. Open via the tile's snippet button; *Manage…* creates, edits
and deletes them.

- **Global** snippets are available to every project; **project** snippets
  live in `<project>/.claude/claude-peers/snippets/` and shadow a global
  prompt with the same name.

## The launch command under the hood

Each tile spawns the resolved launch command in a real pseudo-terminal,
wrapped in a login, non-interactive shell (`"$SHELL" -l -c "<cmd>"` on Unix,
`powershell -NoLogo -NoProfile` on Windows) so rc/profile noise stays out of
the terminal. If the launch command is a shell alias, enable
`Settings > Terminal > Interactive shell` (adds `-i` / loads the profile,
with start-marker noise stripping). A `launchCommand` coming from a
**project's** config triggers a one-time approval dialog (sha256 remembered
per project; refusal falls back to the global command).
