// Pins the exact text list_peers and send_message hand to the model for a
// federated peer (DESIGN-PEER-FEDERATION §2.3, §5, §9): the Via: / Federated
// as: lines, their position in the block, and the "queued" acknowledgement.
// A local peer's block is asserted byte-for-byte so the federation lines can
// never leak into it.

import { test, expect, describe } from "bun:test";
import type { DelegatedTask, PublicPeer } from "../shared/types.ts";
import { formatPeer, formatDuration, renderOpenTasks, renderSendAck, renderTaskCloseAck } from "../shared/peer-render.ts";

const NOW = Date.parse("2026-09-06T12:00:00.000Z");

function peer(overrides: Partial<PublicPeer> = {}): PublicPeer {
  return {
    peer_id: "alice",
    group_id: "g1",
    cwd: "/work/repo",
    git_root: "/work/repo",
    tty: "/dev/ttys001",
    summary: "refactoring the broker",
    registered_at: "2026-09-06T11:00:00.000Z",
    last_seen: "2026-09-06T11:59:00.000Z",
    host: "laptop",
    project_key: "github.com/acme/repo",
    status: "active",
    last_activity_at: "2026-09-06T11:55:00.000Z",
    activity_status: "active",
    role: "reviewer",
    via: null,
    upstream_peer_id: null,
    ...overrides,
  };
}

const LOCAL_BLOCK = [
  "🟢 active  peer_id: alice  (laptop)",
  "CWD: /work/repo",
  "Role: reviewer",
  "Repo: /work/repo",
  "Project: github.com/acme/repo",
  "TTY: /dev/ttys001",
  "Summary: refactoring the broker",
  "Last exchange: 5m ago",
].join("\n  ");

function lines(block: string): string[] {
  return block.split("\n  ");
}

describe("formatPeer: a local peer renders exactly as before federation", () => {
  test("no Via: / Federated as: line when via and upstream_peer_id are null", () => {
    expect(formatPeer(peer(), NOW), "the local block must be byte-identical to the pre-federation rendering").toBe(LOCAL_BLOCK);
  });

  test("an empty-string via is treated as absent", () => {
    expect(formatPeer(peer({ via: "" }), NOW), "an empty via must not produce a Via: line").toBe(LOCAL_BLOCK);
  });
});

describe("formatPeer: the Via: line", () => {
  test("via 'upstream' names the central broker", () => {
    const block = formatPeer(peer({ via: "upstream" }), NOW);
    expect(lines(block), "a native upstream peer must carry 'Via: upstream broker'").toContain("Via: upstream broker");
  });

  test("any other via is the 8-char label of another replica", () => {
    const block = formatPeer(peer({ via: "abcd1234" }), NOW);
    expect(lines(block), "a peer relayed by another replica must carry 'Via: replica <label>'").toContain("Via: replica abcd1234");
  });

  test("link_down_since appends how long the link has been down, without any grace math", () => {
    const block = formatPeer(peer({ via: "upstream", link_down_since: "2026-09-06T11:59:15.000Z" }), NOW);
    expect(lines(block), "the Via: line must say since when the link is down").toContain("Via: upstream broker (link down for 45s)");
    expect(block, "the client never states a remaining grace: the broker owns it").not.toContain("left");
  });

  test("link_down_since is ignored on a local peer", () => {
    const block = formatPeer(peer({ link_down_since: "2026-09-06T11:59:15.000Z" }), NOW);
    expect(block, "a local peer has no link that can be down").toBe(LOCAL_BLOCK);
  });
});

describe("formatPeer: the Federated as: line", () => {
  test("an upstream_peer_id equal to peer_id adds nothing", () => {
    const block = formatPeer(peer({ upstream_peer_id: "alice" }), NOW);
    expect(block, "a name that is the same on both brokers needs no alias line").toBe(LOCAL_BLOCK);
  });

  test("a different upstream_peer_id names the alias other machines must use", () => {
    const block = formatPeer(peer({ upstream_peer_id: "alice-2" }), NOW);
    expect(lines(block), "the upstream alias must be shown as 'Federated as:'").toContain("Federated as: alice-2");
  });

  test("a mirrored peer renamed on collision shows both its origin and its true name", () => {
    const block = formatPeer(peer({ peer_id: "bob-2", via: "upstream", upstream_peer_id: "bob" }), NOW);
    expect(lines(block), "a collision-suffixed mirror must show Via: and Federated as:").toEqual(
      expect.arrayContaining(["Via: upstream broker", "Federated as: bob"]),
    );
  });
});

describe("formatPeer: line order", () => {
  test("Via: then Federated as: sit after Summary: and before Last exchange:", () => {
    const block = formatPeer(peer({ via: "upstream", upstream_peer_id: "alice-2" }), NOW);
    const ls = lines(block);
    const summary = ls.indexOf("Summary: refactoring the broker");
    const via = ls.indexOf("Via: upstream broker");
    const federated = ls.indexOf("Federated as: alice-2");
    const last = ls.indexOf("Last exchange: 5m ago");
    expect([summary, via, federated, last].every((i) => i >= 0), "every expected line must be present").toBe(true);
    expect(via, "Via: must follow Summary:").toBe(summary + 1);
    expect(federated, "Federated as: must follow Via:").toBe(via + 1);
    expect(last, "Last exchange: must stay the final line").toBe(federated + 1);
    expect(ls.length, "no other line may appear in the block").toBe(last + 1);
  });

  test("every pre-federation line keeps its text and position", () => {
    const block = formatPeer(peer({ via: "upstream", upstream_peer_id: "alice-2" }), NOW);
    const withoutFederation = lines(block).filter((l) => !l.startsWith("Via: ") && !l.startsWith("Federated as: "));
    expect(withoutFederation.join("\n  "), "stripping the federation lines must yield the local block").toBe(LOCAL_BLOCK);
  });
});

describe("formatDuration", () => {
  test("uses the formatElapsed buckets without 'ago'", () => {
    expect(formatDuration(45_000), "seconds under a minute").toBe("45s");
    expect(formatDuration(5 * 60_000 + 30_000), "whole minutes under an hour").toBe("5m");
    expect(formatDuration(65 * 60_000), "hours and minutes under a day").toBe("1h5m");
    expect(formatDuration(49 * 3_600_000), "days beyond 24h").toBe("2d");
  });

  test("a negative or non-finite duration never renders NaN", () => {
    expect(formatDuration(-5_000), "a clock skew must read as 0s").toBe("0s");
    expect(formatDuration(Number.NaN), "NaN must read as 0s").toBe("0s");
  });
});

describe("renderSendAck", () => {
  test("a plain success keeps the historical text", () => {
    expect(renderSendAck("bob", { }), "the non-queued ack must be unchanged").toBe("Message sent to peer 'bob'");
    expect(renderSendAck("bob", { queued: false }), "queued:false must read as a plain success").toBe("Message sent to peer 'bob'");
  });

  test("a queued response says the broker is unreachable and for how long it can wait", () => {
    expect(renderSendAck("bob", { queued: true, grace_left_sec: 421 }), "the grace must be rounded UP to whole minutes").toBe(
      "Message to peer 'bob' queued: the central broker is unreachable, it will be delivered if the link returns within 8 min, otherwise dropped and you will be told.",
    );
  });

  test("a grace under a minute still reads as 1 min, never 0", () => {
    expect(renderSendAck("bob", { queued: true, grace_left_sec: 10 }), "ceil(10/60) must not become 0 min").toContain("within 1 min");
  });

  test("a missing or NaN grace never renders 'NaN min'", () => {
    for (const grace of [undefined, Number.NaN]) {
      const text = renderSendAck("bob", { queued: true, grace_left_sec: grace });
      expect(text, `grace ${grace} must fall back to a wording without a number`).not.toContain("NaN");
      expect(text, `grace ${grace} must still say the message is queued`).toContain("queued");
    }
  });
});

const TASK: DelegatedTask = {
  task_id: "6f1c2a4e-0b7d-4c3e-9a51-2d8e7f6a9b10",
  group_id: "g",
  delegator_peer_id: "bob",
  delegate_peer_id: "alice",
  label: "Audit the resume flow",
  status: "armed",
  due_at_ms: Date.parse("2026-10-09T20:00:00.000Z"),
  decision_due_at_ms: null,
  rearm_count: 1,
  generation: 1,
  policy: { max_rearms: 3, lead_silence_sec: 300, max_deadline_sec: 14_400 },
  created_at: "2026-10-09T18:00:00.000Z",
  updated_at: "2026-10-09T18:00:00.000Z",
  closed_at: null,
  terminal_reason: null,
  escalation_result: null,
};

describe("tracked task acknowledgements", () => {
  test("a created or rearmed task names its id, label, due date and rearm counter", () => {
    expect(renderSendAck("alice", { task: TASK })).toBe(
      `Message sent to peer 'alice'; tracked task ${TASK.task_id} "Audit the resume flow", due 2026-10-09T20:00:00.000Z, rearms used 1/3.`
    );
  });

  test("a report that closes the task says so", () => {
    expect(renderSendAck("bob", { task: { ...TASK, status: "closed", due_at_ms: null } })).toBe(
      `Message sent to peer 'bob'; task ${TASK.task_id} "Audit the resume flow" is closed.`
    );
  });

  test("a label with quotes stays quoted in every rendering", () => {
    const quoted = { ...TASK, label: 'say "done"' };
    expect(renderSendAck("alice", { task: quoted })).toContain(`tracked task ${TASK.task_id} "say \\"done\\"",`);
    expect(renderOpenTasks("*", [quoted])).toContain(`task ${TASK.task_id} "say \\"done\\"" to 'alice'`);
  });

  test("a close without a message is never presented as a sent message", () => {
    const text = renderTaskCloseAck({ ...TASK, status: "closed", due_at_ms: null });
    expect(text).toBe(`No message sent; task ${TASK.task_id} "Audit the resume flow" is closed.`);
    expect(text).not.toContain("Message sent");
  });

  test("the open task list names each delegate and keeps the peer scope", () => {
    expect(renderOpenTasks("alice", [])).toBe("No open tasks you delegated with 'alice'.");
    expect(renderOpenTasks("*", [])).toBe("No open tasks you delegated.");
    expect(renderOpenTasks("*", [TASK, { ...TASK, task_id: "t2", status: "overdue", rearm_count: 2 }])).toBe(
      "2 open task(s) you delegated:\n" +
        `- task ${TASK.task_id} "Audit the resume flow" to 'alice', due 2026-10-09T20:00:00.000Z, status armed, rearms used 1/3\n` +
        `- task t2 "Audit the resume flow" to 'alice', due 2026-10-09T20:00:00.000Z, status overdue, rearms used 2/3`
    );
  });
});
