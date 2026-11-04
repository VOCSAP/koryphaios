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

- **Save**: `File > Template > Save Template…` captures the current session set.
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
composer renders the team hierarchically (lead top-center), one card per
entry. Reached from `File > Template > Edit Template…` (choose a template, its
composer opens) or the picker's "Manage templates" mode (New, Edit, Duplicate,
Delete). The supervisor can also save the current team as a template via its
`deck_save_template` tool.

### Parity with the create popover

Every option of the create popover (`CreateMenu.tsx`) is on the template card
(`TemplateEntryCard.tsx`) through the same component and rules
(`PeerOptionFields.tsx`, `peer-options.ts`), except the three below.

| Option | Create popover | Template card | Difference |
| --- | --- | --- | --- |
| Agent | select | same select | none |
| Name | input, placeholder previews the auto name | input in the card head | none |
| Colour | swatch; "Auto colour" returns to the palette | same swatch and "Auto colour" | unset = auto, assigned at launch |
| Role | select + "Other…" remembered in `roleChoices`; team-lead excluded; disabled while lead | same `RoleField` | a stored role missing from the list stays listed |
| Provider + model | default row + `ModelPicker` (catalog, providers, favorites, clodex state, refreshed on `models:changed`); bridge hidden in sandbox mode | same picker, folded behind a button naming the current choice | stored as `model` + `bridge: 'clodex'` |
| Team-lead | checkbox | checkbox in the card head | the composer keeps at most one |
| Extended context (1M) | checkbox appending `[1m]`; off for Haiku and clodex | same | the `[1m]` suffix is read back from `model` |
| Effort | slider, Auto + 5 levels | same slider | none |
| Context Size (clodex only) | slider + number, 200k to 872k, default 200k | same | absent value = 200000; an invalid value blocks Save |
| Extra args | input | same | read back verbatim, historical `--model` text included |
| Initial prompt | textarea | same | none |
| Join announcement | textarea, draft follows agent/model/effort | input, empty until authored | no auto draft |
| Worktree branch | in "Advanced" | in the card | none |
| Presets | chips filling args and prompt | absent | authoring aid: it only pre-fills args and prompt, both on the card |
| Working folder | in "Advanced" | absent | a template carries no cwd, by design |

Template-only: template name, the local checkbox (project vs global scope),
adding and removing entries.
