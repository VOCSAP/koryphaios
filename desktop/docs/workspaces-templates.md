# Workspaces & templates

## Workspaces (🗂) — save & restore

A **workspace** is a restorable snapshot of the window: its session set
(names, colours, args, cwd, worktrees, team-lead), display mode, and the
group **identity** (a `groupId` hash — **never the secret**). Workspaces are
stored in-repo at `<project>/.claude/claude-peers/workspaces/<id>.json`
(git-ignored by default).

- The live workspace **auto-saves** continuously while you work.
- **Save As…** names it and pins it (kept, never pruned).
- **Restore** swaps the window to a saved workspace: it adopts that
  workspace's scope and reopens its sessions. Restore is blocked while
  another live app instance owns that workspace's lock ("in use").
- **Restore semantics**: a session that had real activity (a transcript on
  disk) is **resumed** with its full Claude context; a session that was only
  opened but never used simply **starts fresh** — you always get a working
  terminal, never a stuck "expired" tile.
- **File > New (clear)** closes all sessions and returns to the empty window;
  the previous set stays auto-saved and reopenable from Workspaces.
- Restoring a **custom-group** workspace needs the group secret: either
  launch with the same argument (`kory my-team`), or enable
  `Settings > General > Remember shared scope secrets` so the app can rebuild
  the scope from the OS-keystore-encrypted copy.

The supervisor session is never captured in workspaces (it is re-created on
demand from the Home view).

## Templates — reusable team recipes

A **template** is a portable session recipe (no ids, no cwd): per-entry
agent, model, effort, args, initial prompt, worktree branch, announcement,
colour, and a single team-lead crown.

- **Export**: `File > Export template` captures the current session set.
  *Local* templates are saved in `<project>/.claude/claude-peers/templates/`;
  *global* ones are available to every project.
- **Apply**: from the empty-state `Use template` button or the templates
  dialog. `append` adds the template's sessions to the current ones;
  `replace` auto-saves and closes the current set first. Applying a template
  only crowns its lead when the window has none — applying a team never
  silently steals the crown.
- A template whose entries carry **shell-relevant fields from a repo-local
  file** (command, args) goes through the same one-time approval as a
  project launch command.
- Spawning a template batch into a dirty tree anchors one checkpoint
  (`git stash create` under `refs/claude-peers/`) covering the batch.

## Template composer

Create, edit and duplicate templates **without spawning anything**: the
composer renders the team hierarchically (lead top-center) and edits every
per-entry field (agent/model/effort/args/prompt/worktree/announce/colour) and
the single-lead crown. The supervisor can also save the current team as a
template via its `deck_save_template` tool.
