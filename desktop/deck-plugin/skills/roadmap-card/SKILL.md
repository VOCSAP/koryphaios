---
name: roadmap-card
description: Use before calling roadmap_add to file ONE new card (bug, feature, debt, idea, chore) on the shared claude-peers roadmap. Triggers include "note ce bug", "crée une carte", "ajoute à la roadmap", "note une idée", "file an idea", "log this as a card", "add this to the roadmap", and the end of a diagnosis or review whose findings another session must pick up. NOT for updating, re-prioritizing, archiving or reading an existing card, nor for a directive card (workflow-from-cards).
---

# Roadmap card

You write ONE card with `roadmap_add`, right on the first call, and read it
back before announcing it. Its reader is an agent with none of your context.

## 1. Look for a twin, and for what it depends on

- Call `roadmap_list({ q, q_deep: true, statuses: ["idea", "planned", "in_progress"] })`
  twice, with two different keyword sets: first the English words a card title
  would use, then a synonym or the area/file name. `q` requires EVERY word,
  whole words only, no stemming (`pidfile` misses `pidfiles`, a French word
  misses an English card), so one empty list proves nothing.
- Same defect or same ask already filed: create nothing. Give the caller its
  id8 and title; a fact that card lacks goes in with `roadmap_append_context`.
- A card that must land first: `roadmap_get` it and copy its full `id:` line
  into `depends_on`. An id8 is stored as typed, never resolved, and dispatch
  reads an unknown id as a satisfied dependency.

## 2. Fields

| field | rule |
|---|---|
| `title` | `Area: <verb> <what>`, under 80 chars, naming the change, not the symptom (the symptom goes in `description`): `Broker: refuse a queue rank on an archived card`. |
| `kind` | `bug` broken behaviour · `feature` new capability · `debt` works but costs later · `idea` not decided yet · `chore` upkeep, no behaviour change. |
| `status` | `planned` when the work is decided and specified (a diagnosed bug usually is), else `idea`. Never `in_progress`: it locks the card under you. |
| `priority` | `must` / `should` / `could` / `wont`. No signal: `could`. |
| `value`, `effort` | `low` / `medium` / `high`. No signal: `medium`. |
| `triage` | `ready-for-agent` only when a session can take it as written: cause located, acceptance testable, no open decision. Else `needs-info` (question for the reporter), `ready-for-human` (needs a human decision or hands), `needs-triage` (unsure). `wontfix` requires `priority: wont`. |
| `tags` | Areas (`sandbox`, `broker`, `roadmap`, `desktop`, `inbox`...), never urgency or confidence. |
| `description` | The WHAT, 1-3 sentences for a human scanning the board (the list shows only title and description). Never empty. |
| `rationale` | Who asked or found it, and why it matters: `Operator, 2026-09-30: ...` or `Found by <role> while <activity>`. Never empty. |
| `depends_on` | Full ids only (section 1). |
| `context` | The brief below. |

`context`, one short block per item, in this order; say an item is unknown
or empty rather than skip it:

1. Objective, and what is out of scope.
2. Files and tests: a `file:line` or symbol only for code someone actually
   read; a test to write names its path.
3. Acceptance: the observable check that closes the card.
4. Decisions already made, and by whom, so nobody reopens them.
5. Evidence, each item labelled `MESURÉ` (the number and how it was
   obtained), `DÉDUIT` (from code read) or `SUPPOSÉ`. Keep the label you were
   given, never a higher one. An idea with no measurement says so and lists its
   open questions.

Keep every measurement. Cut the story of who found what, repetition, and the
argument for a design (that goes in the commit). Stay under 16000 characters:
past that, every later `roadmap_append_context` is refused. Write in the
caller's language.

## 3. Write: one call, alone in its tool block

- Emit `roadmap_add` with no other tool call beside it, so a refusal or a
  malformed argument touches this call only.
- No text field may contain a parameter closing tag (`</context>`,
  `</parameter>`) followed by `<parameter name="...">`: the plugin's guard
  refuses the call, because that shape means content meant for two parameters
  landed in one. To quote such markup (a repro), put a space after the `<` of
  each closing tag and add a line to `context` saying that the real input has
  no such space. Never encode it instead (`<`, entities, a literal `\n`):
  the stored text is then something nobody sent, and the guard stays blind.
- Refused (guard or broker 400): fix what the message names, resend once. A
  refusal is never routed around, through the CLI below or otherwise.
- `roadmap_add` absent from your tools: write the same fields plus `by` (your
  peer_id from `whoami`) as JSON with the Write tool to a file outside any
  repo, then run `bun <repo>/cli.ts roadmap-add --input <file>` from the target
  repo. Never build the broker request yourself.

## 4. Read it back before announcing it

1. The ack says `Roadmap item created: <id8>` and, per text field,
   `requested N chars, landed M chars`. Any N different from M: the card is not
   what you sent; fix that field with `roadmap_update` and check again.
2. `roadmap_get <id8>`: compare the title, the first and last lines of
   `context`, and `depends_on` with what you sent.
3. Announce only an id8 that `roadmap_get` returned, with the title,
   kind/priority/triage and the fields you defaulted. A failed write is
   reported with its exact error, never with an id.
