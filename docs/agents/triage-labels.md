# Triage labels

The skills speak in terms of five canonical triage roles. This file maps those
roles to what is actually written on a card of the shared roadmap (see
`issue-tracker.md`).

| Role in the skills | Written here as | Meaning |
|---|---|---|
| `needs-triage` | `triage: "needs-triage"` | A maintainer still has to evaluate this card |
| `needs-info` | `triage: "needs-info"` | Waiting on the reporter for more information |
| `ready-for-agent` | `triage: "ready-for-agent"` | Fully specified, an AFK agent can take it |
| `ready-for-human` | `triage: "ready-for-human"` | Requires a human implementer |
| `wontfix` | `triage: "wontfix"` + `priority: "wont"` | Will not be actioned |

The default vocabulary is kept as-is: the five role strings are the field
values. `triage` is a first-class card field, not a tag: a value outside the
five is refused, and the role replicates between brokers like `status` or
`priority`.

## Reading and writing the role

- Set it: `roadmap_add` / `roadmap_update` with `triage: "<role>"`. An explicit
  `null` on update sends the card back to untriaged.
- Filter by it: `roadmap_list` with `triages: ["ready-for-agent"]`. An unknown
  role is a 400, never an empty list, so a typo cannot read back as "no such
  card".
- Leave it out and nothing happens to it: a write that does not name the field
  keeps the stored role.

`null` is a real state, not a missing value: it means nobody has triaged the
card yet, and it is what every card created without a role carries.

## The one invariant

`wontfix` and `priority: wont` are the same fact said twice. A write that makes
them disagree is REFUSED, naming the contradiction; neither is ever derived
from the other, so no write moves a field its author did not name. The
implication runs one way only: a `wont` card that nobody has triaged is legal.

Cards that carried a role as a free-text tag were promoted into the field by a
startup migration, which also removed the tag. A card that carried several
roles resolved to the one that waits on a person.

The Deck's roadmap view does not display or filter the role yet; card
`5d2b95cd` covers that half.
