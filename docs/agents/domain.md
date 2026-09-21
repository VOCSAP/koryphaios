# Domain docs

How the engineering skills consume this repo's domain documentation when
exploring the codebase. Layout: **single-context** -- one `CONTEXT.md` at the
root, one `docs/adr/` directory, both for the two products at once.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root: the glossary.
- **`docs/adr/`**: the ADRs touching the area about to be worked in.

Neither exists yet. If a file listed here is absent, **proceed silently**: do
not flag it, do not propose creating it upfront. `/domain-modeling` creates
them lazily, when a term or a decision actually gets resolved.

What DOES exist, and is not replaced by any of this:

| Already in the repo | What it holds |
|---|---|
| `CLAUDE.md` | the rules for every task, and the read-on-demand map |
| `ARCHITECTURE.md`, `DESKTOP.md`, `DESIGN.md`, `TESTING.md` | the area briefs the map points at |
| `docs/DESIGN-*.md` | design briefs for one feature each, tracked, not scratch |
| the body of the commit citing `Card <id8>` | the history of a shipped lot |

An ADR does not restate an area brief: it records ONE decision, its
alternatives, and why the rejected one was rejected.

## File structure

```
/
├── CONTEXT.md
├── docs/
│   ├── adr/
│   │   ├── 0001-<slug>.md
│   │   └── 0002-<slug>.md
│   └── DESIGN-<FEATURE>.md
├── broker.ts, server.ts, cli.ts, shared/
└── desktop/
```

Multi-context (a root `CONTEXT-MAP.md` pointing at one `CONTEXT.md` per
context) is NOT the layout here: this is two products in one repo, not a
workspace of packages.

## Use the glossary's vocabulary

When output names a domain concept -- a card title, a refactor proposal, a
hypothesis, a test name -- use the term as `CONTEXT.md` defines it, and do not
drift to a synonym the glossary avoids. `CLAUDE.md` already pins three such
terms: LOT, WORKFLOW and VAGUE name three distinct levels, and spending one on
another concept is the drift this rule exists to stop.

A concept missing from the glossary is a signal: either the language is being
invented and the project does not use it (reconsider), or there is a real gap
(note it for `/domain-modeling`).

## Flag ADR conflicts

If the output contradicts an existing ADR, surface it rather than silently
overriding it:

> _Contradicts ADR-0007 (<slug>), but worth reopening because..._
