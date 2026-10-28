---
name: kory-session-stop
description: "Kory team-lead session stop: soft lets in-flight work land then closes the session, hard interrupts now; both publish the session handoff. Operator-only: /kory-session-stop soft|hard."
argument-hint: "soft|hard"
disable-model-invocation: true
---

# Kory session stop (team-lead)

The operator stops the team. `soft` stops new work and lets current work land; `hard` stops everything now. Both end with a published handoff that tells the truth about what was finished and what was abandoned.

## 0. Argument

Argument received: "$ARGUMENTS"

| Argument | Effect |
|---|---|
| `soft` | Section 2, then section 4. |
| `hard` | Section 3, then section 4. |
| anything else, empty included | Reply with the usage line below. Call no tool, change nothing. |

Usage line: `Usage: /kory-session-stop soft|hard.`

From the moment the argument is valid, you dispatch nothing new: no card, no task, no queued wave. Every note you leave on a card names roles, never peer_ids: the card outlives this session's ids.

## 1. Session context

Run this exact command, alone in its own Bash call:

```
"$KORY_SESSION_HELPER" context
```

It prints JSON: `helper` (the pre-approved `"$KORY_SESSION_HELPER"` command), `draft` (absolute path of the handoff draft file), `project`, `addendum`, `storage`. For every later helper call, use only `"$KORY_SESSION_HELPER" <op>`.

| Result | Action |
|---|---|
| exit 0 | Continue. |
| exit 77, `command not found`, or an empty program name | Reply in one line: `No Kory session binding on this tile (exit <code>): no handoff can be published; dispatch is stopped, nothing else was changed.` Stop. |
| any other exit code | Reply in one line with the exit code and the first line of stderr. Stop. |

After a valid context, `storage.mode` decides where the handoff is stored. Without a valid context, the protocol has already stopped and no other storage source is used.

**Operator addendum.** Use only the `stop` addendum. If the JSON carries addenda for several moments, ignore the `end` one even though this protocol ends like a session end: the operator wrote it for `/kory-session-end`, not for a stop. Carry the `stop` addendum out after section 4, unless it says when. When it names a slash command or a skill (`/something`), do not invoke it: operator-only commands run only when the operator or the Deck types them as a separate turn. Say in one line that you left it for them. For the same reason, never invoke `/kory-session-end` yourself: section 4 is its protocol.

## 2. Soft stop

1. `whoami`, `list_peers({ scope: "machine" })`, `check_messages({ open_tasks_with: "*" })`, `roadmap_list({ statuses: ["in_progress"] })`. If `ws_connected` is false, call `check_messages` before every `send_message`.
2. Send each worker with an open task one message: finish the current step, commit nothing that was not already planned for this step, start nothing new, reply with your report, even if blocked.
3. Collect the reports with `wait_for_message` (or `check_messages` polls) until every open task has answered or passed its deadline. A worker that stays silent is recorded as such, not chased indefinitely.
4. Section 4.

## 3. Hard stop

1. Same live picture as step 2.1.
2. Send each worker with an open task one message: stop now, commit nothing, reply in one line with what is left uncommitted. Do not wait for those replies; record the ones that arrive while you close out.
3. Every in_progress card of this team goes back to planned with a reason: `roadmap_update({ id, status: "planned" })` for yours, `roadmap_update({ id, release: true, status: "planned" })` for a worker's, then `roadmap_append_context` with `hard stop by the operator` and the state it was in. Nothing is marked done unless it was verified before the stop.
4. Close every open task with its reason (`send_message` with its `task_id`, `task_action: "close"`, and `hard stop by the operator`).
5. Section 4, with a short handoff: its State section opens with `Hard stop: incomplete.` and lists what was interrupted.

## 4. Close out and publish

1. Cards: after a soft stop, each card you hold is `done` when delivered and verified, otherwise back to `planned` with a note on where it stopped; a card a worker still holds after its report is released the same way (`release: true`, `status: "planned"`). Open tasks: closed with a reason, or handed over and listed in the handoff with the role that holds it.
2. Worktrees and scratch mirrors created for this session's work: remove the ones whose work is merged or abandoned, after `git status` in each shows nothing left to keep; leave anything you cannot prove belongs to this session. On the shared checkout, no `git stash`, `checkout`, `restore` or `reset`.
3. Build one handoff with these sections, in order: **Objective** (the next session's, or `resume after <soft|hard> stop`); **State** (done and verified with the command and its decisive output line, in flight, abandoned); **Next action**; **Decisions** (with reasons, and what was rejected); **Cards** (id8, title, status, one line); **Open tasks** (role holding each); **Open questions**; **Roster** (ROLES only, never a peer_id: peer_ids are minted per session). No token, password or key in the text. When `storage.mode` is `custom`, follow `storage.instructions` to write it, then read it back and compare. The text describes commands to run, never a slash command to invoke. Record any custom command failure and continue with Kory storage below.
4. A successful custom round trip is already published. Otherwise write the handoff with the Write tool to `draft`, replacing its content. If the Write tool is unavailable, reply `Stop needs the Write tool to fill the handoff draft.` and stop; do not pipe or echo the text into the helper instead, because those commands are not pre-approved. Then run this exact command alone in its own Bash call. Nothing before or after it: no `&&`, `;`, `|`, `cd` or `echo`. Any addition turns the pre-approved command into one that asks the operator for permission:

```
"$KORY_SESSION_HELPER" publish
```

| Result | Action |
|---|---|
| exit 0 | JSON `{ number }`. Continue. |
| exit 65 (invalid or too large) | Rewrite the draft shorter, keep every section, publish once more. |
| exit 74 (I/O) | Publish once more. |
| a second failure, or exit 77 | Reply in one line with the exit code and the draft path. Stop. |

5. For successful custom storage, say: `Session stopped (<soft|hard>): handoff stored with custom storage for <project>.` For Kory storage, say: `Session stopped (<soft|hard>): handoff #<number> published for <project>.` If custom storage failed, append: `Custom handoff storage failed: <cause>. Fell back to Kory storage.` When `storage.mode` is `kory` and `storage.instructions` is empty, add: `Default Kory storage is active; customize it with /kory-setup-handoff.` Then carry out the `stop` addendum, if any.
