# Triage labels

The skills speak in terms of five canonical triage roles. This file maps those
roles to what is actually written on a card of the shared roadmap (see
`issue-tracker.md`).

| Role in the skills | Written here as | Meaning |
|---|---|---|
| `needs-triage` | tag `needs-triage` | A maintainer still has to evaluate this card |
| `needs-info` | tag `needs-info` | Waiting on the reporter for more information |
| `ready-for-agent` | tag `ready-for-agent` | Fully specified, an AFK agent can take it |
| `ready-for-human` | tag `ready-for-human` | Requires a human implementer |
| `wontfix` | tag `wontfix` AND `priority: wont` | Will not be actioned |

The default vocabulary is kept as-is: the five role strings are the label
strings.

## Where the role lives today, and where it is going

A roadmap card has no triage field. It has `status`
(`idea`/`planned`/`in_progress`/`done`) and `priority`
(`must`/`should`/`could`/`wont`), and only one role overlaps with those:
`wontfix` is `priority: wont`. So until the card metadata carries the
vocabulary natively, the five roles are applied as free-text `tags`, and
`wontfix` is written BOTH as a tag and as `priority: wont` so the two
vocabularies cannot disagree.

Filtering therefore goes through `roadmap_list` with `tags: ["ready-for-agent"]`,
not through a dedicated field, and a typo in a tag is silent.

Card `5d2b95cd` converges the two: it adds a validated triage field to the card
model, migrates the existing tags into it, and exposes it to `roadmap_list` and
to the Deck. When it ships, this table points at that field and the tag column
disappears.
