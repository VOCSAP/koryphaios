---
name: create-pr
description: Open a GitHub pull request for the current branch, drafted to the repo's PR standard. Delegates the whole job to the cheap Haiku `pr-writer` subagent (commit messages + diffstat, never the full diff) to save tokens. Use when the user asks to create / open / raise / "faire" / "ouvrir" a PR or pull request (optionally naming the base, e.g. "vers experimental"). NOT for merging, reviewing, updating, or watching an existing PR.
context: fork
agent: pr-writer
---

# Create a pull request (delegated to Haiku, token-cheap)

You are running as the `pr-writer` subagent (Haiku, low effort). Open ONE pull
request for the current branch following your standard, then return its URL.
All the heavy work stays in this cheap context — the main session only relays
your result.

## Base / head resolution

- `head` = the current branch (`git rev-parse --abbrev-ref HEAD`) unless the
  invocation names another.
- `base` = the target branch from the skill argument (e.g. `experimental`). If
  no argument was given, infer it:
  `git symbolic-ref --quiet --short refs/remotes/origin/HEAD` (already stripped
  of `origin/`); if that is unset, fall back to this repo's integration branch
  `experimental`. State which base you used in your final line.

Then run your `pr-writer` procedure end to end: gather `git log` +
`git diff --stat`, honor any PR template, compose the standard body, check for
an existing PR (return it instead of duplicating), create the PR, and return
only its URL/number.
