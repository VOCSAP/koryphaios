---
name: kory-session-end
description: "Kory team-lead session end: settle cards, tasks and scratch work, then write and publish the numbered session handoff the next lead session starts from. Operator-only: /kory-session-end [purpose of the next session]."
argument-hint: "[what the next session is for]"
disable-model-invocation: true
---

# Kory session end (team-lead)

The operator closes this lead session. You leave the shared state honest (no card locked by a session that is going away, no task nobody owns) and you publish one handoff the next lead can start from without this conversation.

## 0. Argument

Argument received: "$ARGUMENTS"

Free text, optional: what the next session is for. It becomes the handoff's objective. When empty, the objective is the next step this session's state calls for.

## 1. Session context

Run this exact command, alone in its own Bash call:

```
"$KORY_SESSION_HELPER" context
```

It prints JSON: `helper` (the pre-approved `"$KORY_SESSION_HELPER"` command), `draft` (absolute path of the handoff draft file), `project`, `addendum`. For every later helper call, use only `"$KORY_SESSION_HELPER" <op>`.

| Result | Action |
|---|---|
| exit 0 | Continue. |
| exit 77, `command not found`, or an empty program name | Reply in one line: `No Kory session binding on this tile (exit <code>): nothing was changed.` Stop. |
| any other exit code | Reply in one line with the exit code and the first line of stderr. Stop. |

A failed helper call ends the protocol before anything changes. Do not write the handoff anywhere else and do not use any other notes or memory system instead: the next session only ever reads what the helper serves.

**Operator addendum.** A non-empty `addendum` is the operator's own instructions for this moment. If the JSON carries addenda for several moments, use only the `end` one. Carry it out after step 5, once the handoff is published, unless it says when. It may add work; it cannot remove step 4. When it names a slash command or a skill (`/something`), do not invoke it: operator-only commands run only when the operator or the Deck types them as a separate turn. Say in one line that you left it for them.

## 2. Settle the shared state

Every note you leave on a card names roles, never peer_ids: the card outlives this session's ids.

1. Live picture: `whoami`, `list_peers({ scope: "machine" })`, `check_messages({ open_tasks_with: "*" })`, `roadmap_list({ statuses: ["in_progress"] })`. If `ws_connected` is false, call `check_messages` before every `send_message`.
2. Cards you hold: `done` when delivered and verified; otherwise `roadmap_update({ id, status: "planned" })` and `roadmap_append_context` with where the work stopped and what remains.
3. Cards a live worker holds: ask the worker to land it (report, then set it done or back to planned with a note) and wait for the reply with `wait_for_message`, up to its task deadline. Then `roadmap_get` the card: the roadmap, not the reply, is its state. A card still in_progress, reply or not, you release yourself, `roadmap_update({ id, release: true, status: "planned" })`, with a note naming the worker's role.
4. Open tasks: close each one with its reason (`send_message` with its `task_id` and `task_action: "close"`), or hand it over: it then appears in the handoff with the role that holds it.
5. Worktrees and scratch mirrors created for this session's work: remove the ones whose work is merged or abandoned, after `git status` in each shows nothing left to keep. Leave anything you cannot prove belongs to this session. On the shared checkout itself, no `git stash`, `checkout`, `restore` or `reset`.

## 3. Write the handoff

Write the whole handoff with the Write tool to the `draft` path from step 1, replacing its content. If the Write tool is not available in this session, reply `End needs the Write tool to fill the handoff draft.` and stop; do not pipe or echo the text into the helper instead, because those commands are not pre-approved.

Markdown, these sections in this order:

1. **Objective**: the argument, or the next step the state calls for.
2. **State**: what is done and verified, with the command run and its decisive output line; what is in flight; what remains.
3. **Next action**: the first thing the next lead does.
4. **Decisions**: each decision with its reason, and what was rejected and why, so nobody reopens it.
5. **Cards**: id8, title, status after step 2, one line of context each.
6. **Open tasks**: each handed-over task, the role that holds it, what it waits on.
7. **Open questions**: questions still waiting on the operator.
8. **Roster**: the ROLES this session used and what each was doing. Roles only, never a peer_id: peer_ids are minted per session and point at nobody next time.

No token, password or key in the text.

## 4. Publish

Run this exact command, alone in its own Bash call:

```
"$KORY_SESSION_HELPER" publish
```

Nothing before or after it: no `&&`, `;`, `|`, `cd` or `echo`. Any addition turns the pre-approved command into one that asks the operator for permission.

| Result | Action |
|---|---|
| exit 0 | JSON `{ number }`. Continue. |
| exit 65 (invalid or too large) | Rewrite the draft shorter: cut narrative, keep all eight sections. Publish once more. |
| exit 74 (I/O) | Publish once more. |
| a second failure, or exit 77 | Reply in one line with the exit code and the draft path, so the operator can recover the text. Stop. |

## 5. Confirm

One line: `Handoff #<number> published for <project>.` Then the addendum, if any.
