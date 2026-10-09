import { describe, expect, test } from "bun:test";
import {
  DELEGATE_CLOSE_NOTE,
  DELEGATOR_CHECK_NOTE,
  LEAD_DIRECTIVE_NOTE,
  PEER_INBOUND_NOTE,
  ROUTING_REMINDER_NOTE,
  formatInboundLine,
  renderDelegationNote,
  renderInbound,
} from "../shared/inbound-framing.ts";
import type { DelegationContext, DelegationTaskRef } from "../shared/types.ts";
import type { WaitCandidateMessage } from "../shared/wait-for-message.ts";

const ID = "6f1c2a4e-0b7d-4c3e-9a51-2d8e7f6a9b10";
const DUE = "2026-10-09T20:00:00.000Z";
const BODY = "Report for the audit";

function ref(n: number, overrides: Partial<DelegationTaskRef> = {}): DelegationTaskRef {
  return { task_id: `00000000-0000-4000-8000-00000000000${n}`, label: `task ${n}`, due_at: DUE, status: "armed", ...overrides };
}

const delegateContext: DelegationContext = {
  task: { task_id: ID, label: "Audit the resume flow", due_at: DUE, status: "armed", recipient_side: "delegate" },
};

describe("the two delegation notes are pinned literally", () => {
  test("delegate close note", () => {
    expect(DELEGATE_CLOSE_NOTE).toBe(
      'When it is done, close it explicitly with send_message(task_id=<this id>, task_action="close"); an ACK or a citation never closes it.'
    );
  });

  test("delegator check note", () => {
    expect(DELEGATOR_CHECK_NOTE).toBe(
      'Check whether this message completes one of them; if so, close it explicitly with send_message(task_id=<its id>, task_action="close"). An ACK never closes a task.'
    );
  });

  test("neither note asks for a reply or an acknowledgement", () => {
    for (const note of [DELEGATE_CLOSE_NOTE, DELEGATOR_CHECK_NOTE]) {
      const lower = note.toLowerCase();
      expect(lower).not.toContain("reply");
      expect(lower).not.toContain("acknowledge");
      expect(lower).not.toContain("respond");
    }
  });
});

describe("delegate side", () => {
  test("names the task id, label, due date and status, then the close instruction", () => {
    expect(renderDelegationNote("bob", delegateContext)).toBe(
      `\n\n[claude-peers] Tracked task ${ID} "Audit the resume flow", due ${DUE}, status armed. ${DELEGATE_CLOSE_NOTE}`
    );
  });

  test("a task without a due date says so", () => {
    const note = renderDelegationNote("bob", { task: { ...delegateContext.task!, due_at: null, status: "orphaned" } });
    expect(note).toBe(`\n\n[claude-peers] Tracked task ${ID} "Audit the resume flow", no deadline, status orphaned. ${DELEGATE_CLOSE_NOTE}`);
  });

  test("a closed task carries no close instruction", () => {
    const note = renderDelegationNote("bob", { task: { ...delegateContext.task!, due_at: null, status: "closed" } });
    expect(note).toBe(`\n\n[claude-peers] Tracked task ${ID} "Audit the resume flow", no deadline, status closed.`);
  });

  test("a label with quotes cannot break out of its quoting", () => {
    const note = renderDelegationNote("bob", { task: { ...delegateContext.task!, label: 'say "done"' } });
    expect(note).toContain(`Tracked task ${ID} "say \\"done\\""`);
  });
});

describe("delegator side", () => {
  test("lists the open tasks with the exact total and the check instruction", () => {
    const context: DelegationContext = { open_from_recipient_to_sender: { total: 2, tasks: [ref(1), ref(2, { due_at: null, status: "overdue" })] } };
    expect(renderDelegationNote("alice", context)).toBe(
      "\n\n[claude-peers] This peer has 2 open task(s) from you:\n" +
        `- ${ref(1).task_id} "task 1", due ${DUE}, status armed\n` +
        `- ${ref(2).task_id} "task 2", no deadline, status overdue\n` +
        DELEGATOR_CHECK_NOTE
    );
  });

  test("a truncated list keeps the exact total and points to the full list for that peer", () => {
    const tasks = [1, 2, 3, 4, 5].map((n) => ref(n));
    const note = renderDelegationNote("alice", { open_from_recipient_to_sender: { total: 7, tasks } });
    expect(note).toContain("This peer has 7 open task(s) from you:");
    expect(note.match(/^- /gm)?.length).toBe(5);
    expect(note.endsWith(`${DELEGATOR_CHECK_NOTE} Full list (2 more): check_messages(open_tasks_with="alice").`)).toBeTrue();
  });

  test("a dormant sender's pointer lists all open tasks instead of naming an empty peer", () => {
    const tasks = [1, 2, 3, 4, 5].map((n) => ref(n));
    const note = renderDelegationNote("", { open_from_recipient_to_sender: { total: 6, tasks } });
    expect(note.endsWith(`Full list (1 more): check_messages(open_tasks_with="*").`)).toBeTrue();
  });

  test("a citation received by the delegator adds nothing", () => {
    expect(renderDelegationNote("alice", { task: { ...delegateContext.task!, recipient_side: "delegator" } })).toBe("");
  });
});

describe("renderInbound and formatInboundLine carry the note", () => {
  test("no context leaves every sender class exactly as before", () => {
    expect(renderInbound("alice", BODY)).toBe(`${BODY}${PEER_INBOUND_NOTE}`);
    expect(renderInbound("alice", BODY, null, undefined)).toBe(renderInbound("alice", BODY));
    expect(renderInbound("alice", BODY, "team-lead", {})).toBe(renderInbound("alice", BODY, "team-lead"));
  });

  test("the delegation note comes after the peer and lead notes", () => {
    const note = renderDelegationNote("bob", delegateContext);
    expect(renderInbound("bob", BODY, null, delegateContext)).toBe(`${BODY}${PEER_INBOUND_NOTE}${note}`);
    expect(renderInbound("bob", BODY, "team-lead", delegateContext)).toBe(
      `${BODY}${PEER_INBOUND_NOTE}${ROUTING_REMINDER_NOTE}${LEAD_DIRECTIVE_NOTE}${note}`
    );
  });

  test("sentinel senders never get a delegation note", () => {
    expect(renderInbound("deck", BODY, null, delegateContext)).toBe(renderInbound("deck", BODY));
    expect(renderInbound("operator", BODY, null, delegateContext)).toBe(renderInbound("operator", BODY));
  });

  test("formatInboundLine keeps its prefix and appends the note", () => {
    const at = "2026-10-09T18:00:00.000Z";
    expect(formatInboundLine("alice", BODY, at, null)).toBe(`From alice (${at}):\n${BODY}${PEER_INBOUND_NOTE}`);
    expect(formatInboundLine("", BODY, at, null)).toBe(`From <dormant peer> (${at}):\n${BODY}${PEER_INBOUND_NOTE}`);
    expect(formatInboundLine("bob", BODY, at, null, delegateContext)).toBe(
      `From bob (${at}):\n${renderInbound("bob", BODY, null, delegateContext)}`
    );
  });

  test("a wait candidate can hold the context", () => {
    const candidate: WaitCandidateMessage = {
      id: 1,
      from_peer_id: "bob",
      from_summary: "",
      from_host: "",
      from_cwd: "",
      text: BODY,
      sent_at: DUE,
      delegation_context: delegateContext,
    };
    expect(candidate.delegation_context).toBe(delegateContext);
  });
});
