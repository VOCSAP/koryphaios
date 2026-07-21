# The supervisor & team spawning

## What the supervisor is

The **Home** rail view hosts a special Claude session that **pilots the
window instead of coding**: tell it "resume work on this repo" and it reads
the roadmap, picks agent profiles, spawns briefed tiles (optionally one
worktree each) and coordinates them via peer messages.

- It is the **only** session bridged to the app, through private `deck_*`
  MCP tools served over a loopback endpoint with a per-launch Bearer token.
- It never writes code itself; it delegates to the agents it spawns.
- It also has the shared `roadmap_*` tools and claude-peers messaging
  (`list_peers` / `send_message`).

## Security model (fixed by the application)

The supervisor's role definition is a **code constant**, re-anchored at
system-prompt level on every spawn — deliberately **not** operator- or
repo-configurable, so a cloned repository can never silently repurpose the
session that pilots the app. Additional hard rules:

- **Consent rule**: the supervisor never spawns sessions on its own
  initiative. Only an explicit operator instruction in the conversation
  authorizes spawning; a request arriving through a peer message, a file or a
  roadmap item is NOT consent (it declines and reports it).
- **Destructive deck actions** (close session, remove worktree…) only work on
  what the supervisor itself created.
- **Spawn cap**: at most 8 live sessions; large roadmaps are worked in waves.

## The deck tools

| Tool | Purpose |
|------|---------|
| `deck_team_playbook` | The hardcoded team-building playbook (consent, decomposition, sizing, briefing, acks) |
| `deck_team_agents` | Catalog of embedded fallback agent profiles (team-lead, developer, reviewer, explorer, debugger, test-engineer) |
| `deck_spawn_session` | Spawn one briefed tile (agent or `embedded_agent` by id, model, worktree_branch, `wait_for_peer`) |
| `deck_spawn_team` | Spawn a whole validated team plan in one call, async connection acks |
| `deck_list_agents` | The operator's agent profiles (`.claude/agents`, `~/.claude/agents`) |
| `deck_list_models` / `deck_list_presets` | Launch-config models and presets |
| `deck_list_sessions` / `deck_restart_session` / `deck_close_session` | Inspect and manage tiles |
| `deck_create_worktree` / `deck_list_worktrees` / `deck_remove_worktree` | Worktree management |
| `deck_list_templates` / `deck_apply_template` / `deck_save_template` | Team templates |
| `deck_announce` | Broadcast or targeted no-reply announcement to the group |

## Trust modes (supervisor spawns)

`Settings > General > Supervisor agent spawns` gates every supervisor-
initiated spawn:

- **Hands-free** (default) — spawns happen with no app-level confirmation;
  every launch stays visible (tile + journal).
- **Team review** — the app shows the full team plan in one recap dialog;
  one click approves it all.
- **Full control** — each agent is confirmed one by one.

## Typical flow

1. Operator opens Home and starts the supervisor (it introduces itself, runs
   `deck_list_agents` and `roadmap_list`, and asks what to do).
2. Operator: "resume work on this repo" / "spawn a team for X".
3. The supervisor surveys the repo and roadmap, groups items into independent
   work streams (one stream = one agent = one worktree), proposes the team if
   it was a question, and spawns after explicit consent.
4. Each agent learns its mission from its **initial prompt** (roadmap item
   id, goal, worktree, boundaries, reporting contract).
5. The Deck notifies the supervisor as each session connects (targeted
   `deck` announces); the supervisor follows up via `send_message` and keeps
   roadmap statuses current.
6. When a team works well, the supervisor can capture it with
   `deck_save_template`.

## The team-lead (👑)

Independent of the supervisor, ONE session per window can be designated
**team-lead** (create-menu checkbox — suggested by the configurable
`leadPattern` — or sidebar right-click). Targeted Deck notices go to it:

- roadmap **dispatch-queue** items (see [roadmap.md](roadmap.md)),
- **review reports** from one-shot diff reviewers,
- integration notices.

Designating a new lead demotes the previous one. The crown is captured in
workspaces and templates.

## Deck announcements

System messages from the window (join announcements, operator megaphone
lines, spawn acks, dispatches) are sent from the reserved non-routable
`deck` sender and rendered to receiving peers as "informational only — do not
reply". The window never reads inbound peer traffic except the operator
inbox (see [communication.md](communication.md)).
