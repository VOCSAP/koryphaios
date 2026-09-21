# Issue tracker: shared roadmap + `BACKLOG.md`

GitHub Issues are DISABLED on `VOCSAP/koryphaios`. Do not call `gh issue`; it
fails with "the repository has disabled issues".

Work for this repo is tracked in two places:

- **The shared roadmap** -- the persistent backlog scoped to this repository,
  reachable from any Claude session through the `roadmap_*` tools of the
  `claude-peers` MCP server. One card is one issue. This is the tracker every
  skill writes to.
- **`BACKLOG.md`** -- the human-readable register of open work (to-do,
  to-verify, deferred, security backlog). A card that covers something already
  written there cites it instead of restating it.

## When a skill says "publish to the issue tracker"

`roadmap_add`, one card per ticket -- never one card listing several tickets.
Fields:

| Field | Value |
|---|---|
| `title` | short, imperative |
| `kind` | `feature` \| `bug` \| `debt` \| `idea` \| `chore` |
| `context` | a briefing for a session holding NONE of the current context: objective, scope boundaries, files and tests involved, acceptance criteria, decisions already taken. Treat it as required. |
| `priority` | MoSCoW: `must` \| `should` \| `could` \| `wont` |
| `value`, `effort` | `low` \| `medium` \| `high` |
| `tags` | including the triage role, see `triage-labels.md` |
| `rationale`, `description` | why it matters, and the details |

A ticket that exists only as a markdown file is invisible to the other
sessions: there is no `.scratch/` convention here, and a spec file is not a
ticket.

## When a skill says "fetch the relevant ticket"

- `roadmap_list` WITH a filter (`statuses`, `kinds`, `q`, `tags`,
  `priorities`) -- never unfiltered, the board is large. `order: "queue"` gives
  the real dispatch order instead of the MoSCoW grouping.
- `roadmap_get <id>` for the full body; the 8-character prefix printed by
  `roadmap_list` is accepted anywhere an id is.
- To leave a note on a card someone else owns: `roadmap_append_context`. It is
  not blocked by the work lock, and it appends instead of replacing.

## Status lifecycle

`idea` -> `planned` -> `in_progress` -> `done`.

`in_progress` LOCKS the card under the peer id that set it: set it only when
the work actually starts, and set it back to `planned` when stopping before the
end. `roadmap_archive` is a reversible soft delete, not a deletion.

## Delivery trace

A commit that advances a card names it, `Card <id8>.`, on the first line of the
commit BODY (not the subject). That citation is the only history of a shipped
lot: `git log --all --grep "Card <id8>"` finds it, `-S`/`-G` cannot.

## PRs as a request surface

OFF. External pull requests are not part of the triage queue.
