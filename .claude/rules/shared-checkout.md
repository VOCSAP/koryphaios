---
paths:
  - "**"
---

# Shared checkout

Several sessions edit this working tree at once and nothing is committed until the batch gate.

- Never run `git checkout -- <file>`, `git restore`, `git stash` or `git reset` here; mutate in a mirror (`mirror-probe` skill).
  Why: they rewrite other sessions' uncommitted work and leave a clean `git status`.
- Commit with `-F` on a message file named fresh for this commit, and amend only as `git commit --amend --only -F <msg> -- <your files>`.
  Why: a reused message file commits its old text, and a bare amend commits the whole index, other sessions' staged files included.
- Restoring from your own backup: `diff -u <backup> <file>` first, and restore only if every hunk is yours.
  Why: a peer's edit that landed after the backup is undone without a signal.
- Kill a process by the PID you spawned, never by image name (`taskkill //IM`, `pkill bun`).
  Why: every session's broker, server and Deck share those image names.
- A claim that a name is absent rests on `git grep -c '<exact name>'` over the whole tree, not on an index lookup.
  Why: the AiDex index holds symbols, not string literals (tool names in schemas, `case` labels).
