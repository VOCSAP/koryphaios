---
paths:
  - "desktop/src/main/**"
  - "desktop/src/shared/**"
  - "desktop/tsconfig*.json"
---

# Deck main process

Importing repo-root `shared/` from `desktop/src/main`: `add-broker-feature` skill, the `tsconfig.node.json` note.

- A path an agent or a paired companion can reach never opens `dialog.showMessageBoxSync`; it takes a `CallerAttendance` and refuses when the caller is `'unattended'`.
  Why: a synchronous modal freezes the whole main process (timers, PTY output, companion sockets), and the remote caller waits with no timeout.
- A regex run on PTY output (`desktop/src/main/detect/` and the detectors fed per chunk) bounds every quantifier; no unbounded lazy class over the accumulated buffer.
  Why: it runs on the main process for every chunk of every session, and a run of unterminated `ESC ]` heads made it quadratic.
- A change to OSC terminators or the open-OSC length cap in `detect/osc.ts` or `detect/safe-strip.ts` is made in both, and `tests/desktop-safe-strip.test.ts` (which imports both) is in the run.
  Why: they are twin escape-sequence state machines over the same PTY stream; a divergent cap leaks fragments into one consumer only.
- A `CLAUDE_PEERS_*` variable set per session is read by its consumer as `process.env.X || ''`, never `=== ''` or `'X' in process.env`.
  Why: on Windows an empty value reaches the child as an absent variable.
- On win32, do not spawn a console program (`cmd.exe`, a `.cmd` shim) with `detached: true`; gate it on the platform as `serve-lifecycle.ts` does (`detached: isPosix(state)`).
  Why: the detached child allocates a new, visible console window, and no test observes windows.
- A startup migration writes its completion marker only after a copy that succeeded and copied something (`markMigrationDone` in `migrate-data-dir.ts`).
  Why: a marker written on a no-op freezes the migration, so data that appears later in the legacy location is never taken.
