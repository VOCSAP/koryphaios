# Koryphaios — Reference documentation

This directory is the reference documentation of **Koryphaios**, the desktop
app that docks multiple Claude Code sessions into one window. It is written
for two audiences at once:

- the **operator** (the human using the app), and
- the **built-in assistants** (the floating "?" help assistant and the Home
  supervisor session), which are pointed at this directory by the app and use
  it to ground their answers about features, options and workflows.

The documentation is maintained in English; assistants answer in the language
of the question.

## Index

| File | Covers |
|------|--------|
| [overview.md](overview.md) | What the app is, core concepts (window, group, session, scope, project dir) |
| [interface.md](interface.md) | The UI tour: navigation rail, sidebar, tile area, search, display modes, menus, keyboard shortcuts |
| [sessions.md](sessions.md) | Creating and managing agent sessions: simple & advanced create, models, effort, 1M context, worktrees, quota auto-resume, "needs you" detection, snippets |
| [workspaces-templates.md](workspaces-templates.md) | Saving & restoring workspaces; reusable team templates and the template composer |
| [supervisor-team.md](supervisor-team.md) | The Home supervisor session, its deck tools, team spawning, trust modes, the team-lead, security model |
| [roadmap.md](roadmap.md) | The shared per-project roadmap: items, priorities, statuses, dispatch queue, assignment, locks, plan import, context wand |
| [browser-design.md](browser-design.md) | The embedded browser: element picker, viewport presets, draw mode, window mirror, design mode in external apps |
| [graph.md](graph.md) | Graph chats: multi-model branching conversations, battle mode, agent-escalated drafts |
| [communication.md](communication.md) | How everyone talks: peer messaging, outbound megaphone, announcements, operator inbox, activity journal |
| [help-assistant.md](help-assistant.md) | The floating "?" help assistant and the resume digest |
| [companion.md](companion.md) | The mobile companion (LAN access from a phone) |
| [sandbox.md](sandbox.md) | Sandbox mode: sessions in a persistent per-project Docker/Podman container, first-run login, the Docker rail view |
| [settings.md](settings.md) | Every configurable option: the Settings page, config files, launch configuration, data locations |
| [faq.md](faq.md) | Troubleshooting and frequently asked questions |

## Conventions used in these pages

- **Operator** — the human driving the app.
- **Session / tile / agent / peer** — one Claude Code instance running in a
  terminal tile inside the window (the four words are near-synonyms; see
  [overview.md](overview.md)).
- **Group** — the isolated claude-peers messaging group shared by all sessions
  of one window.
- **Supervisor** — the special Home-view session that pilots the app itself.
- Paths like `Settings > General` refer to the in-app settings page
  (`Ctrl/Cmd+,`).
