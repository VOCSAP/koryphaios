---
name: repo-rules
description: Add or change a repo-specific guard rule (.claude/claude-peers/rules.json) that blocks or warns on a tool call matching a regex. Use when the same mechanical mistake recurs in this repo, or when the operator asks for a rule. Not for judgment rules.
allowed-tools: Bash(bun "${CLAUDE_PLUGIN_ROOT}/bin/kory-rules.mjs" *)
---

# Repo rules (TTSR)

A repo rule fires a hook on a matching tool call, so the instruction is paid
for in tokens only the day it fires -- unlike a line in CLAUDE.md, read every
turn. It is a regex check on one tool call's input, nothing more.

## When to write one

Write a rule for a **mechanical, regex-detectable** mistake that keeps
recurring in this repo: a forbidden shell flag, a banned string pattern in
new code, a path that must never be touched a certain way.

Do NOT write a rule for a judgment call: "keyed by what, and what happens
when there are two", canonicalizing paths before comparing them, which of
five hostile inputs a new field is. Those need reading and reasoning, not a
regex -- they stay in CLAUDE.md.

## Format (`.claude/claude-peers/rules.json`)

```json
{
  "version": 1,
  "rules": [
    {
      "id": "kebab-case-id",
      "event": "PreToolUse",
      "tools": ["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"],
      "field": "added",
      "paths": ["src/**", "!src/generated/**"],
      "pattern": "regex, JS syntax",
      "flags": "imsu",
      "mode": "deny",
      "message": "Imperative instruction + the remedy, <=400 chars."
    }
  ]
}
```

- `event`: `PreToolUse` or `PostToolUse` (`PostToolUse` is `Bash` only, and
  never `deny` -- the command already ran).
- `tools`: subset of `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `Bash`.
- `field`: what string(s) the pattern is tested against --
  `added` = new/inserted text (`new_string`, each MultiEdit edit, `content`,
  `new_source`); `command` = the Bash command line; `file_path` = the edited
  file's path itself; `output` = Bash stdout+stderr (`PostToolUse` only).
- `paths` (optional): project-relative globs (`*`, `**`, `?`) restricting
  which target file/cwd the rule applies to. A leading `!` EXCLUDES a glob
  from an otherwise-matching set, e.g. `["src/**", "!src/generated/**"]`
  matches everything under `src/` except `src/generated/`.
- `mode`: `deny` blocks the call; `warn` only injects `message` as context --
  it never blocks and never silently allows past the operator's own
  permission prompt.
- `message`: what the agent sees. Give the remedy, not just the prohibition.

One full example -- ban a debug print left in committed code:

```json
{
  "id": "no-debug-print",
  "event": "PreToolUse",
  "tools": ["Edit", "Write"],
  "field": "added",
  "paths": ["src/**"],
  "pattern": "\\bDEBUG_PRINT\\(",
  "mode": "warn",
  "message": "DEBUG_PRINT( is a debugging leftover: remove it, or use the project logger if this needs to stay."
}
```

## Workflow

1. Edit `.claude/claude-peers/rules.json` with your normal edit tool (there
   is no `add` command -- editing the JSON directly is already shorter).
2. `bun "${CLAUDE_PLUGIN_ROOT}/bin/kory-rules.mjs" check` -- fix every
   reported error; a typo'd field name is rejected, not silently ignored.
   `check` also times each pattern on long adversarial input: "too slow"
   means nested or adjacent repetitions (`\w+\w+x`, `(a|aa)+`) -- bound or
   anchor them. A pattern matching everyday text (`a`, `\s`, `\d`) is
   rejected too: it would fire on almost every call.
3. `bun "${CLAUDE_PLUGIN_ROOT}/bin/kory-rules.mjs" test <id> --text "..." --expect match`
   on a case that should trigger it, and
   `... test <id> --text "..." --expect none` on one that should not. Both
   must pass before moving on. Options:
   - `--path <repo-relative path>` -- REQUIRED when the rule has `paths`:
     the file the edit targets (`--path src/ui/a.tsx`), or for a `Bash` rule
     the directory the command runs in (`--path desktop`). Test one path
     inside the globs and one outside.
   - `--tool <Edit|MultiEdit|Write|NotebookEdit|Bash>` -- which of the
     rule's `tools` to simulate (default: the first one).
   - `--file <repo file>` instead of `--text`, to test a file's content.
4. `bun "${CLAUDE_PLUGIN_ROOT}/bin/kory-rules.mjs" scan <id>` -- for a `deny`
   rule targeting `Write`, a nonzero match count means it would block a future
   rewrite of code that already exists. Narrow the pattern or the `paths`
   filter, or switch to `warn`, before proposing it as-is.
5. Tell the operator a repo rule is staged and **needs approval in the Deck,
   Settings > Rules**, before it does anything. Never present the rule as
   active or as done -- until approved it has no effect at all, and an
   operator-visible approval step is the design's safety valve for a rule an
   agent wrote itself.

`bun "${CLAUDE_PLUGIN_ROOT}/bin/kory-rules.mjs" list` shows each repo rule as
`active` or `inactive (pending approval or disabled by the operator)`: it
cannot tell the two apart. Mention an inactive rule once, when you have just
written or changed it; otherwise the operator may have switched it off on
purpose -- do not ask again.

## Never do this

- Never disable, delete, or widen an existing rule (its `pattern`, `paths`,
  or `tools`) without the operator explicitly asking for that change.
- Never propose a `deny` rule on `Write` for a pattern `scan` shows already
  present in the codebase -- it would block ordinary future edits.
- Never write a judgment rule (see "When to write one" above) -- it will
  either never fire or fire on everything.
- Never write a `message` that only states the prohibition; it must also say
  what to do instead.
