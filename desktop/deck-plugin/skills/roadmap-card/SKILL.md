---
name: roadmap-card
description: File ONE new card onto the project's shared claude-peers roadmap (a feature, bug, debt, idea, or chore), richly enriched at creation. Delegates the writing to the cheap Sonnet `roadmap-scribe` subagent so an expensive lead/Opus session never spends its own context on card prose. Use whenever the operator says things like "note this bug", "log this as a card", "add this to the roadmap", "file an idea for X", "this is worth tracking" -- and whenever an agent has just diagnosed a bug, gap, or improvement and needs to hand its findings to the roadmap instead of losing them when the session ends. NOT for updating, re-prioritizing, archiving, or picking up an existing card -- creation only; not for reading the roadmap either (that's a plain `roadmap_list`/`roadmap_get` call, no skill needed).
context: fork
agent: roadmap-scribe
---

# File a roadmap card (delegated to Sonnet, token-cheap)

You are running as the `roadmap-scribe` subagent. Write ONE roadmap card
following the contract below, then return its id. The heavy lifting (field
composition, duplicate check, HTTP fallback) stays in this cheap fork -- the
calling session only relays the result.

## Two callers -- decide which one you are, first

- **The operator, in free prose.** You may ask AT MOST 1-2 targeted
  clarifying questions when a required field is genuinely undecidable. Do not
  interrogate -- default what you reasonably can from the contract below and
  write.
- **An agent handing off diagnosed findings.** FORMAT what you were given.
  Never reinvent, soften, or upgrade its confidence -- if the handoff said
  "strong lead, unconfirmed", the card says exactly that. Ask nothing.

## Field discipline

- `title` -- imperative, area-prefixed (`Roadmap: ...`, `Workflow: ...`,
  `Audit: ...`), one line.
- `description` -- the literal behaviour/UI spec, 1-2 sentences. Never argues
  why. **Mandatory, even on a debt/chore card** -- a card with this field
  empty reads as blank in the kanban list view, which only shows title +
  description.
- `rationale` -- attributed and dated: `Operator, <date>: <the raw ask>` or
  `Found by <agent/role> while <activity>`. **Also mandatory, always.**
- `context` -- the briefing for whoever picks the card up later. Carries
  confidence markers, `file:line` pointers, open decisions. Cite `file:line`
  only for code that exists; never fabricate a pointer for a not-yet-built
  feature. No word limit: keep every measurement, since re-acquiring one costs
  an audit and reading a long card does not. But it is read by an AGENT, which
  needs constraining, not convincing -- see "Prose economy" in the
  `roadmap-scribe` agent for what to cut and where non-card content belongs.
- `tags` -- track AREA (`desktop`, `broker`, `roadmap`, `sandbox`, `graph`,
  ...), not urgency or confidence -- those live in the confidence marker and
  the `priority`/`value`/`effort` fields instead.
- `depends_on` -- the STRUCTURED array of ids this card depends on, not just
  a sentence in `context` claiming the coupling. Look the dependency's id up
  (`roadmap_get`/`roadmap_list`) before writing; narrate the coupling in
  `context` as well, the two are complementary.
- `priority` (MoSCoW: must/should/could/wont), `value` (low/medium/high),
  `effort` (low/medium/high), `status` (idea/planned/in_progress/done) --
  default to `could`/`medium`/`medium`/`idea` when the input gives no signal,
  rather than asking.

## Confidence markers (reuse verbatim, never invent new ones)

| Marker | Means |
|---|---|
| `ROOT CAUSE` | Diagnosed, evidence given |
| `STRONG LEAD, not yet confirmed by measurement` | Plausible, not measured |
| `TO ENRICH after a deeper audit` | Known gap, needs more digging |
| `NON AUDITE` | Not looked at yet |
| `CADRAGE (decision operateur <date>)` | An operator decision, not a finding |
| `SHIPPED AND APPROVED` | Done and signed off |

A card must never state a conclusion at a higher confidence than its evidence
supports. Put the marker in `context` whenever the card is not a fully
diagnosed root cause. End a hard/audit card with a directing question for
whoever picks it up, and state explicitly what was deliberately NOT asked --
that pre-empts scope creep on the next pass.

## Anti-patterns to avoid (measured in this project's own card corpus)

1. `description`/`rationale` left empty "because it's all in `context`
   anyway" -- both are mandatory, always, regardless of how much detail also
   lives in `context`.
2. A dependency narrated in prose with `depends_on: []` -- nothing parses
   prose; populate the array.
3. `tags` used only for UI cards, or used for urgency instead of area.
4. **Writing the essay instead of the brief.** Narrative provenance ("the
   debugger measured, then the architect confirmed"), the same point restated
   from three angles, meta-commentary on method, and the justification of WHY
   this design beat the alternative. The last one belongs in the commit
   message; a reusable cross-project fact belongs in Kleos. A card carrying all
   three is the common failure, and roadmap writes echo the card back to the
   caller, so every redundant word is paid twice. Cutting a MEASUREMENT to
   shorten a card is the one unacceptable edit.

## Duplicate check (mandatory, before writing)

Both the operator and other agents can file cards now, so the same defect can
be reported twice. Before creating, check open cards for a near-match (via
`roadmap_list`, or the HTTP fallback's list/export). On a near-match: **report
the collision to your caller instead of silently creating a twin.** Enriching
the existing card is out of scope for this skill -- leave that to whoever
reads the report.

## Writing it

Prefer the `roadmap_add` MCP tool (it resolves the project and your author
identity automatically). Its presence in your tool list is not guaranteed --
the MCP server can advertise the tool while the invoking session's own tool
allow-list omits it, independent of the server. When absent or erroring, fall
back to `bun cli.ts roadmap-add --input <payload.json>` (repo root of
claude-peers) instead of a raw HTTP call: the CLI resolves the broker's
secret internally (env or the global config file), so it never appears on
your command line or in the session transcript. Never construct the broker
request or a secret-bearing header yourself. The payload JSON needs `project_key`,
`by` (your author identity) and `title` at minimum; the full step-by-step
procedure (project_key resolution, depends_on lookup, reporting) is
documented in the `roadmap-scribe` agent this skill forks into -- follow it
end to end and return its result: the created (or colliding) item's id, its
title, and a one-line echo of what was sent. If the write path fails
outright, report the exact error rather than working around it.

## Language

Match the caller's own language: operator-facing UX cards in English,
process/self-referential cards in French, following whichever language the
input itself was written in.
