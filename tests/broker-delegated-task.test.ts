import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get, groupId, livePid, post, sha256Hex, startBroker, stopBroker, type TestBroker, openBrokerDb } from "./_helper.ts";

interface Peer {
  peer_id: string;
  instance_token: string;
}

interface Task {
  task_id: string;
  status: string;
  label: string;
  rearm_count: number;
  generation: number;
  due_at_ms: number | null;
  closed_at: string | null;
  policy: { max_rearms: number; lead_silence_sec: number; max_deadline_sec: number };
}

const attachNoticeBody = (taskId: string): string => `A deadline was attached to the sender's earlier request: task ${taskId}.`;

let broker: TestBroker;
let delegatedGroup: string;
let delegatedSecretHash: string;

beforeAll(async () => {
  broker = await startBroker();
  delegatedGroup = await groupId("delegated-task-test-group");
  delegatedSecretHash = await sha256Hex("delegated-task-test-group");
});

afterAll(async () => {
  await stopBroker(broker);
});

async function register(host: string, cwd: string, target = broker): Promise<Peer> {
  const result = await post<Peer>(`${target.url}/register`, {
    pid: livePid(),
    cwd,
    git_root: null,
    tty: null,
    summary: "",
    host,
    client_pid: 1,
    project_key: null,
    group_id: delegatedGroup,
    group_secret_hash: delegatedSecretHash,
  });
  expect(result.status).toBe(200);
  return result.body;
}

async function createTask(delegator: Peer, delegate: Peer, label: string, target = broker): Promise<Task> {
  const result = await post<{ ok: boolean; task?: Task; error?: string }>(`${target.url}/send-message`, {
    from_token: delegator.instance_token,
    to_peer_id: delegate.peer_id,
    text: `Initial request for ${label}`,
    deadline_sec: 60,
    task_label: label,
  });
  expect(result.status).toBe(200);
  expect(result.body.ok).toBeTrue();
  expect(result.body.task).toBeDefined();
  const publicJson = JSON.stringify(result.body);
  for (const internal of ["delegator_token", "delegate_binding", "owner_broker_id", "instance_token", "pid", "client_pid"]) {
    expect(publicJson).not.toContain(internal);
  }
  return result.body.task!;
}

function taskRow(taskId: string, target = broker): { status: string; rearm_count: number; generation: number; due_at_ms: number | null; closed_at: string | null } {
  const db = openBrokerDb(target.dbPath, { readonly: true });
  try {
    return db.query(
      "SELECT status, rearm_count, generation, due_at_ms, closed_at FROM delegated_tasks WHERE task_id = ?"
    ).get(taskId) as { status: string; rearm_count: number; generation: number; due_at_ms: number | null; closed_at: string | null };
  } finally {
    db.close();
  }
}

function seedOpenTasks(delegator: Peer, delegate: Peer, count: number, target = broker): void {
  const db = openBrokerDb(target.dbPath);
  try {
    const now = new Date().toISOString();
    for (let index = 0; index < count; index++) {
      db.run(
        `INSERT INTO delegated_tasks (
          task_id, group_id, owner_broker_id, delegator_token, delegate_kind, delegate_binding,
          delegator_peer_id_snapshot, delegate_peer_id_snapshot, label, status, due_at_ms,
          decision_due_at_ms, rearm_count, generation, max_rearms, lead_silence_sec, max_deadline_sec,
          created_at, updated_at
        ) VALUES (?, ?, 'test', ?, 'local', ?, ?, ?, ?, 'armed', ?, NULL, 0, 0, 3, 300, 14400, ?, ?)`,
        [randomUUID(), delegatedGroup, delegator.instance_token, delegate.instance_token, delegator.peer_id, delegate.peer_id, `Quota seed ${index}`, Date.now() + 60_000, now, now]
      );
    }
  } finally {
    db.close();
  }
}

function countMessagesWithText(text: string): number {
  const db = openBrokerDb(broker.dbPath, { readonly: true });
  try {
    return (db.query("SELECT COUNT(*) AS count FROM messages WHERE text = ?").get(text) as { count: number }).count;
  } finally {
    db.close();
  }
}

function countTasksWithLabel(label: string): number {
  const db = openBrokerDb(broker.dbPath, { readonly: true });
  try {
    return (db.query("SELECT COUNT(*) AS count FROM delegated_tasks WHERE label = ?").get(label) as { count: number }).count;
  } finally {
    db.close();
  }
}

describe("delegated tasks", () => {
  test("projects the effective delegation policy on health", async () => {
    const health = await get<{ delegation_policy: Record<string, unknown> }>(`${broker.url}/health`);
    expect(health.status).toBe(200);
    expect(health.body.delegation_policy).toEqual({
      available: true,
      values: { max_rearms: 3, lead_silence_sec: 300, max_deadline_sec: 14_400 },
      sources: { max_rearms: "default", lead_silence_sec: "default", max_deadline_sec: "default" },
      bounds: {
        max_rearms: { min: 0, max: 10 },
        lead_silence_sec: { min: 15, max: 3_600 },
        max_deadline_sec: { min: 1, max: 86_400 },
      },
      diagnostics: [],
      config_path_fingerprint: expect.any(String),
    });
  });

  test("leaves ordinary messages available when the delegation policy is invalid", async () => {
    const restricted = await startBroker({ CLAUDE_PEERS_DELEGATION_MAX_REARMS: "11" });
    try {
      const secret = randomUUID();
      const group = await groupId(secret);
      const hash = await sha256Hex(secret);
      const registerRestricted = async (host: string, cwd: string) => {
        const result = await post<Peer>(`${restricted.url}/register`, {
          pid: livePid(),
          cwd,
          git_root: null,
          tty: null,
          summary: "",
          host,
          client_pid: 1,
          project_key: null,
          group_id: group,
          group_secret_hash: hash,
        });
        expect(result.status).toBe(200);
        return result.body;
      };
      const delegator = await registerRestricted("invalid-policy-bob", "/invalid-policy-bob");
      const delegate = await registerRestricted("invalid-policy-alice", "/invalid-policy-alice");
      const ordinary = await post<{ ok: boolean }>(`${restricted.url}/send-message`, {
        from_token: delegator.instance_token,
        to_peer_id: delegate.peer_id,
        text: "ordinary message remains available",
      });
      expect(ordinary.body.ok).toBeTrue();
      const tracked = await post<{ ok: boolean; error?: string }>(`${restricted.url}/send-message`, {
        from_token: delegator.instance_token,
        to_peer_id: delegate.peer_id,
        text: "tracked task must be refused",
        deadline_sec: 60,
        task_label: "Refused task",
      });
      expect(tracked.body.ok).toBeFalse();
      expect(tracked.body.error).toContain("Delegation policy unavailable");
    } finally {
      await stopBroker(restricted);
    }
  });

  test("returns the persisted id for a local ordinary send", async () => {
    const sender = await register("delegation-ordinary-id-bob", "/delegation-ordinary-id-bob");
    const recipient = await register("delegation-ordinary-id-alice", "/delegation-ordinary-id-alice");
    const sent = await post<{ ok: boolean; message_id?: number }>(`${broker.url}/send-message`, {
      from_token: sender.instance_token,
      to_peer_id: recipient.peer_id,
      text: "message that will later gain an ETA",
    });

    expect(sent.status).toBe(200);
    expect(sent.body.ok).toBeTrue();
    const messageId = sent.body.message_id;
    expect(typeof messageId).toBe("number");
    if (typeof messageId !== "number") throw new Error("local send did not return its message id");
    const db = openBrokerDb(broker.dbPath, { readonly: true });
    try {
      expect(db.query("SELECT id FROM messages WHERE id = ?").get(messageId)).toBeDefined();
    } finally {
      db.close();
    }
  });

  test("attaches an ETA from the attachment time and deposits one fixed Deck notice", async () => {
    const clockDir = mkdtempSync(join(tmpdir(), "cp-attach-clock-"));
    const clockPath = join(clockDir, "fixed-clock.ts");
    const nowMs = 1_762_586_400_000;
    writeFileSync(clockPath, `Date.now = () => ${nowMs};\n`);
    let fixedBroker: TestBroker | null = null;
    try {
      fixedBroker = await startBroker({}, { command: ["bun", "--preload", clockPath, "broker.ts"] });
      const delegator = await register("delegation-attach-bob", "/delegation-attach-bob", fixedBroker);
      const delegate = await register("delegation-attach-alice", "/delegation-attach-alice", fixedBroker);
      const observer = await register("delegation-attach-observer", "/delegation-attach-observer", fixedBroker);
      const sourceText = "Please complete the source migration before review";
      const source = await post<{ ok: boolean; message_id?: number }>(`${fixedBroker.url}/send-message`, {
        from_token: delegator.instance_token,
        to_peer_id: delegate.peer_id,
        text: sourceText,
      });
      expect(source.body).toEqual({ ok: true, message_id: expect.any(Number) });
      const sourceMessageId = source.body.message_id;
      if (typeof sourceMessageId !== "number") throw new Error("local source message id missing");

      const incoming = await post<{ ok: boolean; message_id?: number }>(`${fixedBroker.url}/send-message`, {
        from_token: observer.instance_token,
        to_peer_id: delegator.peer_id,
        text: "unread before attachment",
      });
      const incomingMessageId = incoming.body.message_id;
      if (typeof incomingMessageId !== "number") throw new Error("incoming message id missing");
      const sourceDb = openBrokerDb(fixedBroker.dbPath);
      try {
        sourceDb.run("UPDATE messages SET sent_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", sourceMessageId]);
      } finally {
        sourceDb.close();
      }

      const attachResponse = await fetch(`${fixedBroker.url}/delegations/attach`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from_token: delegator.instance_token, message_id: sourceMessageId, deadline_sec: 60 }),
      });
      expect(attachResponse.headers.get("content-type")).toContain("application/json");
      const attached = await attachResponse.json() as { task: Task; already_tracked: boolean };
      expect(attachResponse.status).toBe(200);
      expect(attached.already_tracked).toBeFalse();
      expect(attached.task.due_at_ms).toBe(nowMs + 60_000);

      const db = openBrokerDb(fixedBroker.dbPath, { readonly: true });
      try {
        expect(db.query("SELECT task_id FROM messages WHERE id = ?").get(sourceMessageId)).toEqual({ task_id: attached.task.task_id });
        expect(
          db.query("SELECT source_message_id FROM delegated_tasks WHERE task_id = ?").get(attached.task.task_id)
        ).toEqual({ source_message_id: sourceMessageId });
        const notices = db.query(
          "SELECT text, delivered FROM messages WHERE from_token = '__deck__' AND to_token = ?"
        ).all(delegate.instance_token) as { text: string; delivered: number }[];
        expect(notices).toHaveLength(1);
        const notice = notices[0]!;
        expect(notice.delivered).toBe(0);
        expect(notice.text).toBe(attachNoticeBody(attached.task.task_id));
        expect(notice.text).not.toContain(new Date(nowMs + 60_000).toISOString());
        expect(notice.text).not.toContain("Close");
        expect(db.query("SELECT task_id FROM messages WHERE from_token = '__deck__' AND to_token = ?").get(delegate.instance_token)).toEqual({
          task_id: attached.task.task_id,
        });
        expect(notice.text).not.toContain(sourceText);
        expect(notice.text).not.toContain(attached.task.label);
        expect(db.query("SELECT delivered FROM messages WHERE id = ?").get(incomingMessageId)).toEqual({ delivered: 0 });
      } finally {
        db.close();
      }
    } finally {
      if (fixedBroker) await stopBroker(fixedBroker);
      rmSync(clockDir, { recursive: true, force: true });
    }
  });

  test("keeps the first attachment immutable across retries and source expiry", async () => {
    const delegator = await register("delegation-attach-retry-bob", "/delegation-attach-retry-bob");
    const delegate = await register("delegation-attach-retry-alice", "/delegation-attach-retry-alice");
    const source = await post<{ ok: boolean; message_id?: number }>(`${broker.url}/send-message`, {
      from_token: delegator.instance_token,
      to_peer_id: delegate.peer_id,
      text: "Retry source message",
    });
    const sourceMessageId = source.body.message_id;
    if (typeof sourceMessageId !== "number") throw new Error("local source message id missing");
    const first = await post<{ task: Task; already_tracked: boolean }>(`${broker.url}/delegations/attach`, {
      from_token: delegator.instance_token,
      message_id: sourceMessageId,
      deadline_sec: 60,
    });
    expect(first.body.already_tracked).toBeFalse();
    const firstSnapshot = taskRow(first.body.task.task_id);
    const db = openBrokerDb(broker.dbPath, { readonly: true });
    let firstNoticeCount: number;
    try {
      firstNoticeCount = (
        db.query("SELECT COUNT(*) AS count FROM messages WHERE from_token = '__deck__' AND to_token = ? AND task_id = ?")
          .get(delegate.instance_token, first.body.task.task_id) as { count: number }
      ).count;
    } finally {
      db.close();
    }
    expect(firstNoticeCount).toBe(1);

    const third = await register("delegation-attach-retry-third", "/delegation-attach-retry-third");
    for (const caller of [delegate, third]) {
      const intruder = await post<{ error?: string; task?: unknown }>(`${broker.url}/delegations/attach`, {
        from_token: caller.instance_token,
        message_id: sourceMessageId,
        deadline_sec: 60,
      });
      expect(intruder.status).toBe(403);
      expect(intruder.body.task).toBeUndefined();
    }

    const retried = await post<{ task: Task; already_tracked: boolean }>(`${broker.url}/delegations/attach`, {
      from_token: delegator.instance_token,
      message_id: sourceMessageId,
      deadline_sec: 120,
    });
    expect(retried.body).toMatchObject({ already_tracked: true, task: { task_id: first.body.task.task_id } });
    expect(taskRow(first.body.task.task_id)).toEqual(firstSnapshot);

    const freeze = openBrokerDb(broker.dbPath);
    try {
      freeze.run("UPDATE delegated_tasks SET max_deadline_sec = 100 WHERE task_id = ?", [first.body.task.task_id]);
    } finally {
      freeze.close();
    }
    const beyondFrozen = await post<{ error?: string; task?: unknown }>(`${broker.url}/delegations/attach`, {
      from_token: delegator.instance_token,
      message_id: sourceMessageId,
      deadline_sec: 101,
    });
    expect(beyondFrozen.status).toBe(400);
    expect(beyondFrozen.body.task).toBeUndefined();
    const withinFrozen = await post<{ task: Task; already_tracked: boolean }>(`${broker.url}/delegations/attach`, {
      from_token: delegator.instance_token,
      message_id: sourceMessageId,
      deadline_sec: 100,
    });
    expect(withinFrozen.body).toMatchObject({ already_tracked: true, task: { task_id: first.body.task.task_id } });
    expect(taskRow(first.body.task.task_id)).toEqual(firstSnapshot);
    const afterRetry = openBrokerDb(broker.dbPath, { readonly: true });
    try {
      expect(
        (afterRetry.query("SELECT COUNT(*) AS count FROM messages WHERE from_token = '__deck__' AND to_token = ? AND task_id = ?")
          .get(delegate.instance_token, first.body.task.task_id) as { count: number }).count
      ).toBe(firstNoticeCount);
    } finally {
      afterRetry.close();
    }

    const closed = await post<{ task: Task }>(`${broker.url}/delegations/close`, {
      from_token: delegate.instance_token,
      task_id: first.body.task.task_id,
    });
    expect(closed.body.task.status).toBe("closed");
    const expireSource = openBrokerDb(broker.dbPath);
    try {
      expireSource.run("DELETE FROM messages WHERE id = ?", [sourceMessageId]);
    } finally {
      expireSource.close();
    }
    const expiredRetry = await post<{ task: Task; already_tracked: boolean }>(`${broker.url}/delegations/attach`, {
      from_token: delegator.instance_token,
      message_id: sourceMessageId,
      deadline_sec: 60,
    });
    expect(expiredRetry.body).toMatchObject({ already_tracked: true, task: { task_id: first.body.task.task_id, status: "closed" } });
  });

  test("refuses attachment by a recipient, a peer reusing the sender name, sentinels and invalid forms", async () => {
    const delegator = await register("delegation-attach-authority-bob", "/delegation-attach-authority-bob");
    const delegate = await register("delegation-attach-authority-alice", "/delegation-attach-authority-alice");
    const impostor = await register("delegation-attach-authority-impostor", "/delegation-attach-authority-impostor");
    const source = await post<{ ok: boolean; message_id?: number }>(`${broker.url}/send-message`, {
      from_token: delegator.instance_token,
      to_peer_id: delegate.peer_id,
      text: "Source protected by its token",
    });
    const sourceMessageId = source.body.message_id;
    if (typeof sourceMessageId !== "number") throw new Error("local source message id missing");

    const recipientAttempt = await post<{ error?: string }>(`${broker.url}/delegations/attach`, {
      from_token: delegate.instance_token,
      message_id: sourceMessageId,
      deadline_sec: 60,
    });
    expect(recipientAttempt.status).toBe(403);

    const db = openBrokerDb(broker.dbPath);
    try {
      db.run("UPDATE peers SET peer_id = ? WHERE instance_token = ?", ["delegation-attach-authority-former", delegator.instance_token]);
      db.run("UPDATE peers SET peer_id = ? WHERE instance_token = ?", [delegator.peer_id, impostor.instance_token]);
    } finally {
      db.close();
    }
    const homonymAttempt = await post<{ error?: string }>(`${broker.url}/delegations/attach`, {
      from_token: impostor.instance_token,
      message_id: sourceMessageId,
      deadline_sec: 60,
    });
    expect(homonymAttempt.status).toBe(403);

    const malformed = await post<{ error?: string }>(`${broker.url}/delegations/attach`, {
      from_token: delegator.instance_token,
      message_id: sourceMessageId,
      deadline_sec: 60,
      text: "must not become a new send",
    });
    expect(malformed.status).toBe(400);
    const sentinel = await post<{ error?: string }>(`${broker.url}/delegations/attach`, {
      from_token: "__deck__",
      message_id: sourceMessageId,
      deadline_sec: 60,
    });
    expect(sentinel.status).toBe(400);
    const invalidDeadline = await post<{ error?: string }>(`${broker.url}/delegations/attach`, {
      from_token: delegator.instance_token,
      message_id: sourceMessageId,
      deadline_sec: Number.MAX_SAFE_INTEGER + 1,
    });
    expect(invalidDeadline.status).toBe(400);
    const absent = await post<{ error?: string }>(`${broker.url}/delegations/attach`, {
      from_token: delegator.instance_token,
      message_id: 999_999_999,
      deadline_sec: 60,
    });
    expect(absent.status).toBe(404);
    const check = openBrokerDb(broker.dbPath, { readonly: true });
    try {
      expect(
        (check.query("SELECT COUNT(*) AS count FROM delegated_tasks WHERE source_message_id = ?").get(sourceMessageId) as { count: number }).count
      ).toBe(0);
    } finally {
      check.close();
    }
  });

  test("refuses remote, inactive, inbox-less and over-quota attachment without persistence", async () => {
    const delegator = await register("delegation-attach-guards-bob", "/delegation-attach-guards-bob");
    const delegate = await register("delegation-attach-guards-alice", "/delegation-attach-guards-alice");
    const remoteSource = await post<{ ok: boolean; message_id?: number }>(`${broker.url}/send-message`, {
      from_token: delegator.instance_token,
      to_peer_id: delegate.peer_id,
      text: "Remote source refusal",
    });
    const remoteMessageId = remoteSource.body.message_id;
    if (typeof remoteMessageId !== "number") throw new Error("local source message id missing");
    const remoteDb = openBrokerDb(broker.dbPath);
    try {
      remoteDb.run("UPDATE messages SET federation_id = ? WHERE id = ?", ["upstream:1", remoteMessageId]);
    } finally {
      remoteDb.close();
    }
    const remote = await post<{ error?: string }>(`${broker.url}/delegations/attach`, {
      from_token: delegator.instance_token,
      message_id: remoteMessageId,
      deadline_sec: 60,
    });
    expect(remote.status).toBe(400);

    const inactiveSource = await post<{ ok: boolean; message_id?: number }>(`${broker.url}/send-message`, {
      from_token: delegator.instance_token,
      to_peer_id: delegate.peer_id,
      text: "Inactive recipient refusal",
    });
    const inactiveMessageId = inactiveSource.body.message_id;
    if (typeof inactiveMessageId !== "number") throw new Error("local source message id missing");
    const inactiveDb = openBrokerDb(broker.dbPath);
    try {
      inactiveDb.run("UPDATE peers SET status = 'dormant' WHERE instance_token = ?", [delegate.instance_token]);
    } finally {
      inactiveDb.close();
    }
    const inactive = await post<{ error?: string }>(`${broker.url}/delegations/attach`, {
      from_token: delegator.instance_token,
      message_id: inactiveMessageId,
      deadline_sec: 60,
    });
    expect(inactive.status).toBe(409);

    const viaDelegator = await register("delegation-attach-via-bob", "/delegation-attach-via-bob");
    const viaDelegate = await register("delegation-attach-via-alice", "/delegation-attach-via-alice");
    const viaSource = await post<{ ok: boolean; message_id?: number }>(`${broker.url}/send-message`, {
      from_token: viaDelegator.instance_token,
      to_peer_id: viaDelegate.peer_id,
      text: "Relayed recipient refusal",
    });
    const viaMessageId = viaSource.body.message_id;
    if (typeof viaMessageId !== "number") throw new Error("local source message id missing");
    const viaDb = openBrokerDb(broker.dbPath);
    try {
      viaDb.run("UPDATE peers SET via = 'upstream' WHERE instance_token = ?", [viaDelegate.instance_token]);
    } finally {
      viaDb.close();
    }
    const viaAttempt = await post<{ error?: string }>(`${broker.url}/delegations/attach`, {
      from_token: viaDelegator.instance_token,
      message_id: viaMessageId,
      deadline_sec: 60,
    });
    expect(viaAttempt.status).toBe(400);

    const replacedDelegator = await register("delegation-attach-replaced-bob", "/delegation-attach-replaced-bob");
    const replacedDelegate = await register("delegation-attach-replaced-alice", "/delegation-attach-replaced-alice");
    const replacedSource = await post<{ ok: boolean; message_id?: number }>(`${broker.url}/send-message`, {
      from_token: replacedDelegator.instance_token,
      to_peer_id: replacedDelegate.peer_id,
      text: "Replaced recipient refusal",
    });
    const replacedMessageId = replacedSource.body.message_id;
    if (typeof replacedMessageId !== "number") throw new Error("local source message id missing");
    const replacedDb = openBrokerDb(broker.dbPath);
    try {
      replacedDb.run("UPDATE peers SET instance_token = ? WHERE instance_token = ?", [randomUUID(), replacedDelegate.instance_token]);
    } finally {
      replacedDb.close();
    }
    const replacedAttempt = await post<{ error?: string }>(`${broker.url}/delegations/attach`, {
      from_token: replacedDelegator.instance_token,
      message_id: replacedMessageId,
      deadline_sec: 60,
    });
    expect(replacedAttempt.status).toBe(409);

    const noInboxA = await post<Peer>(`${broker.url}/register`, {
      pid: livePid(), cwd: "/delegation-attach-no-inbox-a", git_root: null, tty: null, summary: "",
      host: "delegation-attach-no-inbox-a", client_pid: 1, project_key: null, group_id: "default", group_secret_hash: null,
    });
    const noInboxB = await post<Peer>(`${broker.url}/register`, {
      pid: livePid(), cwd: "/delegation-attach-no-inbox-b", git_root: null, tty: null, summary: "",
      host: "delegation-attach-no-inbox-b", client_pid: 1, project_key: null, group_id: "default", group_secret_hash: null,
    });
    const noInboxSource = await post<{ ok: boolean; message_id?: number }>(`${broker.url}/send-message`, {
      from_token: noInboxA.body.instance_token,
      to_peer_id: noInboxB.body.peer_id,
      text: "Inbox-less source",
    });
    const noInboxMessageId = noInboxSource.body.message_id;
    if (typeof noInboxMessageId !== "number") throw new Error("local source message id missing");
    const noInbox = await post<{ error?: string }>(`${broker.url}/delegations/attach`, {
      from_token: noInboxA.body.instance_token,
      message_id: noInboxMessageId,
      deadline_sec: 60,
    });
    expect(noInbox.status).toBe(409);

    const quotaDelegator = await register("delegation-attach-quota-bob", "/delegation-attach-quota-bob");
    const quotaDelegate = await register("delegation-attach-quota-alice", "/delegation-attach-quota-alice");
    const quotaSource = await post<{ ok: boolean; message_id?: number }>(`${broker.url}/send-message`, {
      from_token: quotaDelegator.instance_token,
      to_peer_id: quotaDelegate.peer_id,
      text: "Quota attachment source",
    });
    const quotaMessageId = quotaSource.body.message_id;
    if (typeof quotaMessageId !== "number") throw new Error("local source message id missing");
    seedOpenTasks(quotaDelegator, quotaDelegate, 100);
    const quota =await post<{ error?: string }>(`${broker.url}/delegations/attach`, {
      from_token: quotaDelegator.instance_token,
      message_id: quotaMessageId,
      deadline_sec: 60,
    });
    expect(quota.status).toBe(409);
    expect(quota.body.error).toContain('check_messages(open_tasks_with="*")');
    const verify = openBrokerDb(broker.dbPath, { readonly: true });
    try {
      expect(verify.query("SELECT task_id FROM messages WHERE id = ?").get(quotaMessageId)).toEqual({ task_id: null });
      expect(
        (verify.query("SELECT COUNT(*) AS count FROM delegated_tasks WHERE source_message_id = ?").get(quotaMessageId) as { count: number }).count
      ).toBe(0);
    } finally {
      verify.close();
    }
  });

  test("rolls back an attachment when its Deck notice is rejected", async () => {
    const delegator = await register("delegation-attach-rollback-bob", "/delegation-attach-rollback-bob");
    const delegate = await register("delegation-attach-rollback-alice", "/delegation-attach-rollback-alice");
    const source = await post<{ ok: boolean; message_id?: number }>(`${broker.url}/send-message`, {
      from_token: delegator.instance_token,
      to_peer_id: delegate.peer_id,
      text: "Attachment rollback source",
    });
    const sourceMessageId = source.body.message_id;
    if (typeof sourceMessageId !== "number") throw new Error("local source message id missing");
    const db = openBrokerDb(broker.dbPath);
    try {
      db.run(
        `CREATE TRIGGER reject_delegation_attach_notice BEFORE INSERT ON messages
           WHEN NEW.from_token = '__deck__'
           BEGIN SELECT RAISE(ABORT, 'Deck notice rejected'); END`
      );
      const rejected = await post<{ error?: string }>(`${broker.url}/delegations/attach`, {
        from_token: delegator.instance_token,
        message_id: sourceMessageId,
        deadline_sec: 60,
      });
      expect(rejected.status).toBe(500);
      expect(db.query("SELECT task_id FROM messages WHERE id = ?").get(sourceMessageId)).toEqual({ task_id: null });
      expect(
        (db.query("SELECT COUNT(*) AS count FROM delegated_tasks WHERE source_message_id = ?").get(sourceMessageId) as { count: number }).count
      ).toBe(0);
    } finally {
      db.run("DROP TRIGGER IF EXISTS reject_delegation_attach_notice");
      db.close();
    }
  });

  test("serves a retry for an already attached source while the delegator quota is full", async () => {
    const delegator = await register("delegation-attach-full-retry-bob", "/delegation-attach-full-retry-bob");
    const delegate = await register("delegation-attach-full-retry-alice", "/delegation-attach-full-retry-alice");
    const source = await post<{ ok: boolean; message_id?: number }>(`${broker.url}/send-message`, {
      from_token: delegator.instance_token,
      to_peer_id: delegate.peer_id,
      text: "Attached before the quota filled",
    });
    const sourceMessageId = source.body.message_id;
    if (typeof sourceMessageId !== "number") throw new Error("local source message id missing");
    const first = await post<{ task: Task; already_tracked: boolean }>(`${broker.url}/delegations/attach`, {
      from_token: delegator.instance_token,
      message_id: sourceMessageId,
      deadline_sec: 60,
    });
    expect(first.status).toBe(200);
    seedOpenTasks(delegator, delegate, 99);

    const retry = await post<{ task: Task; already_tracked: boolean }>(`${broker.url}/delegations/attach`, {
      from_token: delegator.instance_token,
      message_id: sourceMessageId,
      deadline_sec: 60,
    });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ already_tracked: true, task: { task_id: first.body.task.task_id } });
  });

  test("refuses a first attachment beyond the policy maximum and accepts the maximum itself", async () => {
    const delegator = await register("delegation-attach-bound-bob", "/delegation-attach-bound-bob");
    const delegate = await register("delegation-attach-bound-alice", "/delegation-attach-bound-alice");
    const sendSource = async (text: string): Promise<number> => {
      const sent = await post<{ ok: boolean; message_id?: number }>(`${broker.url}/send-message`, {
        from_token: delegator.instance_token,
        to_peer_id: delegate.peer_id,
        text,
      });
      if (typeof sent.body.message_id !== "number") throw new Error("local source message id missing");
      return sent.body.message_id;
    };
    const beyondId = await sendSource("Source beyond the maximum");
    const beyond = await post<{ error?: string }>(`${broker.url}/delegations/attach`, {
      from_token: delegator.instance_token,
      message_id: beyondId,
      deadline_sec: 14_401,
    });
    expect(beyond.status).toBe(400);
    const check = openBrokerDb(broker.dbPath, { readonly: true });
    try {
      expect(check.query("SELECT task_id FROM messages WHERE id = ?").get(beyondId)).toEqual({ task_id: null });
      expect(
        (check.query("SELECT COUNT(*) AS count FROM delegated_tasks WHERE source_message_id = ?").get(beyondId) as { count: number }).count
      ).toBe(0);
    } finally {
      check.close();
    }

    const atMaxId = await sendSource("Source at the maximum");
    const atMax = await post<{ already_tracked: boolean }>(`${broker.url}/delegations/attach`, {
      from_token: delegator.instance_token,
      message_id: atMaxId,
      deadline_sec: 14_400,
    });
    expect(atMax.status).toBe(200);
    expect(atMax.body.already_tracked).toBeFalse();
  });

  test("leaves a task citation without a message id", async () => {
    const delegator = await register("delegation-citation-bob", "/delegation-citation-bob");
    const delegate = await register("delegation-citation-alice", "/delegation-citation-alice");
    const task = await createTask(delegator, delegate, "Citation target");
    const cited = await post<unknown>(`${broker.url}/send-message`, {
      from_token: delegator.instance_token,
      to_peer_id: delegate.peer_id,
      text: "A follow-up that cites the task",
      task_id: task.task_id,
    });
    expect(cited.status).toBe(200);
    expect(cited.body).toEqual({ ok: true });
  });

  test("migrates a database created without the source column and attaches an old message", async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "cp-attach-legacy-"));
    const legacyDb = join(legacyDir, "legacy.db");
    let first: TestBroker | null = null;
    let second: TestBroker | null = null;
    try {
      first = await startBroker({ CLAUDE_PEERS_DB: legacyDb });
      const delegator = await register("delegation-legacy-bob", "/delegation-legacy-bob", first);
      const delegate = await register("delegation-legacy-alice", "/delegation-legacy-alice", first);
      const kept = await createTask(delegator, delegate, "Task kept across the migration", first);
      const source = await post<{ ok: boolean; message_id?: number }>(`${first.url}/send-message`, {
        from_token: delegator.instance_token,
        to_peer_id: delegate.peer_id,
        text: "Message sent before the column existed",
      });
      const sourceMessageId = source.body.message_id;
      if (typeof sourceMessageId !== "number") throw new Error("local source message id missing");
      await stopBroker(first);
      first = null;

      const legacy = openBrokerDb(legacyDb);
      try {
        legacy.run("DROP INDEX idx_delegated_tasks_source_message");
        legacy.run("ALTER TABLE delegated_tasks DROP COLUMN source_message_id");
        const columns = legacy.query("PRAGMA table_info(delegated_tasks)").all() as { name: string }[];
        expect(columns.map((column) => column.name)).not.toContain("source_message_id");
      } finally {
        legacy.close();
      }

      second = await startBroker({ CLAUDE_PEERS_DB: legacyDb });
      const migrated = openBrokerDb(legacyDb, { readonly: true });
      try {
        const columns = migrated.query("PRAGMA table_info(delegated_tasks)").all() as { name: string }[];
        expect(columns.map((column) => column.name)).toContain("source_message_id");
        expect(migrated.query("SELECT status FROM delegated_tasks WHERE task_id = ?").get(kept.task_id)).toEqual({ status: "armed" });
      } finally {
        migrated.close();
      }
      const attached = await post<{ task: Task; already_tracked: boolean }>(`${second.url}/delegations/attach`, {
        from_token: delegator.instance_token,
        message_id: sourceMessageId,
        deadline_sec: 60,
      });
      expect(attached.status).toBe(200);
      expect(attached.body.already_tracked).toBeFalse();
    } finally {
      if (first) await stopBroker(first);
      if (second) await stopBroker(second);
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  test("keeps existing task list and close operations available after a restart with invalid policy", async () => {
    const source = await startBroker();
    let restarted: TestBroker | null = null;
    try {
      const secret = randomUUID();
      const group = await groupId(secret);
      const hash = await sha256Hex(secret);
      const registerSource = async (host: string, cwd: string) => {
        const result = await post<Peer>(`${source.url}/register`, {
          pid: livePid(), cwd, git_root: null, tty: null, summary: "", host, client_pid: 1,
          project_key: null, group_id: group, group_secret_hash: hash,
        });
        expect(result.status).toBe(200);
        return result.body;
      };
      const delegator = await registerSource("restart-policy-bob", "/restart-policy-bob");
      const delegate = await registerSource("restart-policy-alice", "/restart-policy-alice");
      const created = await post<{ ok: boolean; task: Task }>(`${source.url}/send-message`, {
        from_token: delegator.instance_token, to_peer_id: delegate.peer_id, text: "survives invalid restart",
        deadline_sec: 60, task_label: "Restart policy",
      });
      expect(created.body.ok).toBeTrue();
      source.proc.kill();
      await source.proc.exited;

      restarted = await startBroker({
        CLAUDE_PEERS_DB: source.dbPath,
        CLAUDE_PEERS_DELEGATION_MAX_REARMS: "11",
      });
      const listed = await post<{ tasks: Task[] }>(`${restarted.url}/delegations/list`, {
        from_token: delegator.instance_token,
      });
      expect(listed.status).toBe(200);
      expect(listed.body.tasks.map((entry) => entry.task_id)).toEqual([created.body.task.task_id]);
      const closed = await post<{ task: Task }>(`${restarted.url}/delegations/close`, {
        from_token: delegate.instance_token,
        task_id: created.body.task.task_id,
      });
      expect(closed.status).toBe(200);
      expect(closed.body.task.status).toBe("closed");
      const rejectedCreation = await post<{ ok: boolean; error?: string }>(`${restarted.url}/send-message`, {
        from_token: delegator.instance_token, to_peer_id: delegate.peer_id, text: "must fail",
        deadline_sec: 60, task_label: "Invalid policy creation",
      });
      expect(rejectedCreation.body.ok).toBeFalse();
      expect(rejectedCreation.body.error).toContain("Delegation policy unavailable");
    } finally {
      if (restarted) await stopBroker(restarted);
      await stopBroker(source);
    }
  });

  test("refuses cross-group, relayed, inbox-less and over-quota task creation without persistence", async () => {
    const delegator = await register("delegation-create-guards-bob", "/delegation-create-guards-bob");
    const otherSecret = randomUUID();
    const otherGroup = await groupId(otherSecret);
    const otherHash = await sha256Hex(otherSecret);
    const homonym = await post<Peer>(`${broker.url}/register`, {
      pid: livePid(), cwd: "/delegation-create-guards-other", git_root: null, tty: null, summary: "",
      host: "delegation-create-guards-other", client_pid: 1, project_key: null,
      group_id: otherGroup, group_secret_hash: otherHash,
    });
    expect(homonym.status).toBe(200);
    const delegate = await register("delegation-create-guards-alice", "/delegation-create-guards-alice");
    const isolatedGroup = randomUUID();
    const sharedPeerId = randomUUID();
    const homonymDb = openBrokerDb(broker.dbPath);
    try {
      homonymDb.run("UPDATE peers SET group_id = ?, peer_id = ? WHERE instance_token = ?", [isolatedGroup, sharedPeerId, homonym.body.instance_token]);
      const relocated = homonymDb.query("SELECT group_id FROM peers WHERE instance_token = ?").get(homonym.body.instance_token) as { group_id: string };
      expect(relocated.group_id).toBe(isolatedGroup);
      homonymDb.run("UPDATE peers SET peer_id = ? WHERE instance_token = ?", [sharedPeerId, delegate.instance_token]);
      delegate.peer_id = sharedPeerId;
    } finally {
      homonymDb.close();
    }
    const crossGroup = await post<{ ok: boolean; error?: string }>(`${broker.url}/send-message`, {
      from_token: delegator.instance_token, to_peer_id: delegate.peer_id, text: "group-local target",
      deadline_sec: 60, task_label: "Group binding",
    });
    expect(crossGroup.body.ok).toBeTrue();
    const groupBound = openBrokerDb(broker.dbPath, { readonly: true });
    try {
      expect(
        (groupBound.query("SELECT delegate_binding FROM delegated_tasks WHERE label = ?").get("Group binding") as { delegate_binding: string }).delegate_binding
      ).toBe(delegate.instance_token);
    } finally {
      groupBound.close();
    }

    const relayLabel = "Relay refusal";
    const relayText = "must not reach a relay";
    const relayDb = openBrokerDb(broker.dbPath);
    try {
      relayDb.run("UPDATE peers SET via = 'test-relay' WHERE instance_token = ?", [delegate.instance_token]);
      const relayed = await post<{ ok: boolean }>(`${broker.url}/send-message`, {
        from_token: delegator.instance_token, to_peer_id: delegate.peer_id, text: relayText,
        deadline_sec: 60, task_label: relayLabel,
      });
      expect(relayed.body.ok).toBeFalse();
      expect(countTasksWithLabel(relayLabel)).toBe(0);
      expect(countMessagesWithText(relayText)).toBe(0);
    } finally {
      relayDb.run("UPDATE peers SET via = NULL WHERE instance_token = ?", [delegate.instance_token]);
      relayDb.close();
    }

    const noInboxA = await post<Peer>(`${broker.url}/register`, {
      pid: livePid(), cwd: "/delegation-no-inbox-a", git_root: null, tty: null, summary: "",
      host: "delegation-no-inbox-a", client_pid: 1, project_key: null, group_id: "default", group_secret_hash: null,
    });
    const noInboxB = await post<Peer>(`${broker.url}/register`, {
      pid: livePid(), cwd: "/delegation-no-inbox-b", git_root: null, tty: null, summary: "",
      host: "delegation-no-inbox-b", client_pid: 1, project_key: null, group_id: "default", group_secret_hash: null,
    });
    expect(noInboxA.status).toBe(200);
    expect(noInboxB.status).toBe(200);
    const inboxLabel = "No inbox refusal";
    const inboxText = "must not create without inbox";
    const noInbox = await post<{ ok: boolean }>(`${broker.url}/send-message`, {
      from_token: noInboxA.body.instance_token, to_peer_id: noInboxB.body.peer_id, text: inboxText,
      deadline_sec: 60, task_label: inboxLabel,
    });
    expect(noInbox.body.ok).toBeFalse();
    expect(countTasksWithLabel(inboxLabel)).toBe(0);
    expect(countMessagesWithText(inboxText)).toBe(0);

    const quotaDelegator = await register("delegation-quota-bob", "/delegation-quota-bob");
    const quotaDelegate = await register("delegation-quota-alice", "/delegation-quota-alice");
    for (let index = 0; index < 100; index++) {
      const response = await post<{ ok: boolean }>(`${broker.url}/send-message`, {
        from_token: quotaDelegator.instance_token, to_peer_id: quotaDelegate.peer_id, text: `quota task ${index}`,
        deadline_sec: 60, task_label: `Quota ${index}`,
      });
      expect(response.body.ok).toBeTrue();
    }
    const overflowText = "quota task overflow";
    const overflow = await post<{ ok: boolean }>(`${broker.url}/send-message`, {
      from_token: quotaDelegator.instance_token, to_peer_id: quotaDelegate.peer_id, text: overflowText,
      deadline_sec: 60, task_label: "Quota overflow",
    });
    expect(overflow.body.ok).toBeFalse();
    expect(countTasksWithLabel("Quota overflow")).toBe(0);
    expect(countMessagesWithText(overflowText)).toBe(0);
  });

  test("creates a task and its initial message atomically with the policy snapshot", async () => {
    const delegator = await register("delegation-create-bob", "/delegation-create-bob");
    const delegate = await register("delegation-create-alice", "/delegation-create-alice");
    const invisible = await post<{ ok: boolean; error?: string }>(`${broker.url}/send-message`, {
      from_token: delegator.instance_token,
      to_peer_id: delegate.peer_id,
      text: "\u0000  \n",
      deadline_sec: 60,
      task_label: "Visible label",
    });
    expect(invisible.body.ok).toBeFalse();
    expect(invisible.body.error).toContain("visible text");
    const task = await createTask(delegator, delegate, "Audit restart path");

    expect(task.status).toBe("armed");
    expect(task.policy).toEqual({ max_rearms: 3, lead_silence_sec: 300, max_deadline_sec: 14_400 });
    expect(task.due_at_ms).toBeGreaterThan(Date.now());
    expect(countMessagesWithText("Initial request for Audit restart path")).toBe(1);
  });

  test("rolls back task creation when its initial message is rejected by SQLite", async () => {
    const delegator = await register("delegation-create-rollback-bob", "/delegation-create-rollback-bob");
    const delegate = await register("delegation-create-rollback-alice", "/delegation-create-rollback-alice");
    const label = "Create rollback";
    const text = "initial-message-that-trigger-rejects";
    const db = openBrokerDb(broker.dbPath);
    try {
      db.run(
        `CREATE TRIGGER reject_delegated_task_initial BEFORE INSERT ON messages
           WHEN NEW.text = '${text}'
           BEGIN SELECT RAISE(ABORT, 'initial message rejected'); END`
      );
      const rejected = await post<{ ok?: boolean; error?: string }>(`${broker.url}/send-message`, {
        from_token: delegator.instance_token,
        to_peer_id: delegate.peer_id,
        text,
        deadline_sec: 60,
        task_label: label,
      });
      expect(rejected.status).toBe(500);
      expect(countTasksWithLabel(label)).toBe(0);
      expect(countMessagesWithText(text)).toBe(0);
    } finally {
      db.run("DROP TRIGGER IF EXISTS reject_delegated_task_initial");
      db.close();
    }
  });

  test("keeps a task open when its closing report is rejected by SQLite", async () => {
    const delegator = await register("delegation-close-bob", "/delegation-close-bob");
    const delegate = await register("delegation-close-alice", "/delegation-close-alice");
    const task = await createTask(delegator, delegate, "Atomic close");
    const report = "report-that-trigger-rejects";
    const db = openBrokerDb(broker.dbPath);
    try {
      db.run(
        `CREATE TRIGGER reject_delegated_task_report BEFORE INSERT ON messages
           WHEN NEW.text = '${report}'
           BEGIN SELECT RAISE(ABORT, 'report rejected'); END`
      );
      const rejected = await post<{ ok?: boolean; error?: string }>(`${broker.url}/send-message`, {
        from_token: delegate.instance_token,
        to_peer_id: delegator.peer_id,
        text: report,
        task_id: task.task_id,
        task_action: "close",
      });
      expect(rejected.status).toBe(500);
      expect(taskRow(task.task_id)).toMatchObject({ status: "armed", closed_at: null });
    } finally {
      db.run("DROP TRIGGER IF EXISTS reject_delegated_task_report");
      db.close();
    }

    const closed = await post<{ ok: boolean; task: Task }>(`${broker.url}/send-message`, {
      from_token: delegate.instance_token,
      to_peer_id: delegator.peer_id,
      text: report,
      task_id: task.task_id,
      task_action: "close",
    });
    expect(closed.status).toBe(200);
    expect(closed.body.task.status).toBe("closed");
    expect(countMessagesWithText(report)).toBe(1);
  });

  test("returns the closed task when a repeated report targets a dormant or renamed peer", async () => {
    const delegator = await register("delegation-repeat-close-bob", "/delegation-repeat-close-bob");
    const delegate = await register("delegation-repeat-close-alice", "/delegation-repeat-close-alice");
    const task = await createTask(delegator, delegate, "Repeated close");
    const first = await post<{ ok: boolean; task: Task }>(`${broker.url}/send-message`, {
      from_token: delegate.instance_token,
      to_peer_id: delegator.peer_id,
      text: "first report",
      task_id: task.task_id,
      task_action: "close",
    });
    expect(first.body.task.status).toBe("closed");

    const db = openBrokerDb(broker.dbPath);
    try {
      db.run("UPDATE peers SET status = 'dormant' WHERE instance_token = ?", [delegator.instance_token]);
    } finally {
      db.close();
    }
    const dormantRepeat = await post<{ ok: boolean; task: Task }>(`${broker.url}/send-message`, {
      from_token: delegate.instance_token,
      to_peer_id: delegator.peer_id,
      text: "ignored report while dormant",
      task_id: task.task_id,
      task_action: "close",
    });
    expect(dormantRepeat.body).toMatchObject({ ok: true, task: { task_id: task.task_id, status: "closed" } });

    const renamed = "delegation-repeat-close-bob-renamed";
    const renameDb = openBrokerDb(broker.dbPath);
    try {
      renameDb.run("UPDATE peers SET peer_id = ?, status = 'active' WHERE instance_token = ?", [renamed, delegator.instance_token]);
    } finally {
      renameDb.close();
    }
    const renamedRepeat = await post<{ ok: boolean; task: Task }>(`${broker.url}/send-message`, {
      from_token: delegate.instance_token,
      to_peer_id: delegator.peer_id,
      text: "ignored report after rename",
      task_id: task.task_id,
      task_action: "close",
    });
    expect(renamedRepeat.body).toMatchObject({ ok: true, task: { task_id: task.task_id, status: "closed" } });
    expect(countMessagesWithText("ignored report while dormant")).toBe(0);
    expect(countMessagesWithText("ignored report after rename")).toBe(0);
  });

  test("allows a participant to close without an artificial message", async () => {
    const delegator = await register("delegation-close-only-bob", "/delegation-close-only-bob");
    const delegate = await register("delegation-close-only-alice", "/delegation-close-only-alice");
    const task = await createTask(delegator, delegate, "Close only");
    const closed = await post<{ task: Task }>(`${broker.url}/delegations/close`, {
      from_token: delegate.instance_token,
      task_id: task.task_id,
    });

    expect(closed.status).toBe(200);
    expect(closed.body.task.status).toBe("closed");
    expect(closed.body.task.closed_at).toBeTruthy();
    const publicJson = JSON.stringify(closed.body);
    for (const internal of ["delegator_token", "delegate_binding", "owner_broker_id", "instance_token", "pid", "client_pid"]) {
      expect(publicJson).not.toContain(internal);
    }
  });

  test("lets only the delegator extend an armed task without consuming a rearm", async () => {
    const delegator = await register("delegation-extend-bob", "/delegation-extend-bob");
    const delegate = await register("delegation-extend-alice", "/delegation-extend-alice");
    const task = await createTask(delegator, delegate, "Extend armed task");
    const extension = await post<{ ok: boolean; task?: Task; error?: string }>(`${broker.url}/send-message`, {
      from_token: delegator.instance_token,
      to_peer_id: delegate.peer_id,
      text: "The deadline has been extended",
      task_id: task.task_id,
      deadline_sec: 120,
    });

    expect(extension.status).toBe(200);
    expect(extension.body.ok).toBeTrue();
    expect(extension.body.task).toMatchObject({ status: "armed", rearm_count: 0, generation: 0 });
    expect(extension.body.task!.due_at_ms).toBeGreaterThan(task.due_at_ms!);
    const extendedDueAt = extension.body.task!.due_at_ms!;

    const shorter = await post<{ ok: boolean; error?: string }>(`${broker.url}/send-message`, {
      from_token: delegator.instance_token,
      to_peer_id: delegate.peer_id,
      text: "The shorter deadline must be refused",
      task_id: task.task_id,
      deadline_sec: 1,
    });
    expect(shorter.body).toEqual({ ok: false, error: "The new deadline must extend the task deadline" });
    expect(taskRow(task.task_id).due_at_ms).toBe(extendedDueAt);

    const rejected = await post<{ ok: boolean; error?: string }>(`${broker.url}/send-message`, {
      from_token: delegate.instance_token,
      to_peer_id: delegator.peer_id,
      text: "Unauthorized extension",
      task_id: task.task_id,
      deadline_sec: 120,
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toEqual({ ok: false, error: "Only the delegator can rearm this task" });
    expect(taskRow(task.task_id)).toMatchObject({ status: "armed", rearm_count: 0, generation: 0 });
  });

  test("refuses an equal armed-task deadline without moving it", async () => {
    const clockDir = mkdtempSync(join(tmpdir(), "cp-delegated-clock-"));
    const clockPath = join(clockDir, "fixed-clock.ts");
    const nowMs = 1_762_586_400_000;
    writeFileSync(clockPath, `Date.now = () => ${nowMs};\n`);
    let fixedBroker: TestBroker | null = null;
    try {
      fixedBroker = await startBroker({}, { command: ["bun", "--preload", clockPath, "broker.ts"] });
      const delegator = await register("delegation-equal-bob", "/delegation-equal-bob", fixedBroker);
      const delegate = await register("delegation-equal-alice", "/delegation-equal-alice", fixedBroker);
      const task = await createTask(delegator, delegate, "Equal armed task", fixedBroker);
      const equal = await post<{ ok: boolean; error?: string }>(`${fixedBroker.url}/send-message`, {
        from_token: delegator.instance_token,
        to_peer_id: delegate.peer_id,
        text: "The equal deadline must be refused",
        task_id: task.task_id,
        deadline_sec: 60,
      });
      expect(equal.body).toEqual({ ok: false, error: "The new deadline must extend the task deadline" });
      expect(taskRow(task.task_id, fixedBroker).due_at_ms).toBe(task.due_at_ms);
    } finally {
      if (fixedBroker) await stopBroker(fixedBroker);
      rmSync(clockDir, { recursive: true, force: true });
    }
  });

  test("rearms only an overdue task and persists a new generation with its message", async () => {
    const delegator = await register("delegation-rearm-bob", "/delegation-rearm-bob");
    const delegate = await register("delegation-rearm-alice", "/delegation-rearm-alice");
    const task = await createTask(delegator, delegate, "Rearm task");
    const db = openBrokerDb(broker.dbPath);
    try {
      db.run(
        "UPDATE delegated_tasks SET status = 'overdue', decision_due_at_ms = ? WHERE task_id = ?",
        [Date.now() + 60_000, task.task_id]
      );
    } finally {
      db.close();
    }

    const rearmText = "Please continue the assigned work";
    const rejectDb = openBrokerDb(broker.dbPath);
    try {
      rejectDb.run(
        `CREATE TRIGGER reject_delegated_task_rearm BEFORE INSERT ON messages
           WHEN NEW.text = '${rearmText}'
           BEGIN SELECT RAISE(ABORT, 'rearm message rejected'); END`
      );
      const rejected = await post<{ ok?: boolean; error?: string }>(`${broker.url}/send-message`, {
        from_token: delegator.instance_token,
        to_peer_id: delegate.peer_id,
        text: rearmText,
        task_id: task.task_id,
        deadline_sec: 120,
      });
      expect(rejected.status).toBe(500);
      expect(taskRow(task.task_id)).toMatchObject({ status: "overdue", rearm_count: 0, generation: 0 });
    } finally {
      rejectDb.run("DROP TRIGGER IF EXISTS reject_delegated_task_rearm");
      rejectDb.close();
    }

    const rearmed = await post<{ ok: boolean; task: Task }>(`${broker.url}/send-message`, {
      from_token: delegator.instance_token,
      to_peer_id: delegate.peer_id,
      text: rearmText,
      task_id: task.task_id,
      deadline_sec: 120,
    });
    expect(rearmed.status).toBe(200);
    expect(rearmed.body.task).toMatchObject({ status: "armed", rearm_count: 1, generation: 1 });
    expect(countMessagesWithText(rearmText)).toBe(1);
  });

  test("refuses task close operations by a third peer and a peer from another group", async () => {
    const delegator = await register("delegation-authority-bob", "/delegation-authority-bob");
    const delegate = await register("delegation-authority-alice", "/delegation-authority-alice");
    const third = await register("delegation-authority-third", "/delegation-authority-third");
    const task = await createTask(delegator, delegate, "Authority guard");
    const thirdClose = await post<{ error?: string }>(`${broker.url}/delegations/close`, {
      from_token: third.instance_token,
      task_id: task.task_id,
    });
    expect(thirdClose.status).toBe(403);
    const thirdReport = await post<{ ok: boolean }>(`${broker.url}/send-message`, {
      from_token: third.instance_token,
      to_peer_id: delegator.peer_id,
      text: "unauthorized report",
      task_id: task.task_id,
      task_action: "close",
    });
    expect(thirdReport.status).toBe(403);
    expect(taskRow(task.task_id)).toMatchObject({ status: "armed", closed_at: null });

    const otherSecret = randomUUID();
    const otherGroup = await groupId(otherSecret);
    const otherHash = await sha256Hex(otherSecret);
    const outsider = await post<Peer>(`${broker.url}/register`, {
      pid: livePid(), cwd: "/delegation-authority-outsider", git_root: null, tty: null, summary: "",
      host: "delegation-authority-outsider", client_pid: 1, project_key: null,
      group_id: otherGroup, group_secret_hash: otherHash,
    });
    expect(outsider.status).toBe(200);
    const outsiderClose = await post<{ error?: string }>(`${broker.url}/delegations/close`, {
      from_token: outsider.body.instance_token,
      task_id: task.task_id,
    });
    expect(outsiderClose.status).toBe(404);
    const outsiderReport = await post<{ ok: boolean }>(`${broker.url}/send-message`, {
      from_token: outsider.body.instance_token,
      to_peer_id: delegator.peer_id,
      text: "cross-group report",
      task_id: task.task_id,
      task_action: "close",
    });
    expect(outsiderReport.status).toBe(404);
    expect(taskRow(task.task_id)).toMatchObject({ status: "armed", closed_at: null });
  });

  test("lists only the delegator's open tasks and leaves an explicit citation unchanged", async () => {
    const delegator = await register("delegation-list-bob", "/delegation-list-bob");
    const delegate = await register("delegation-list-alice", "/delegation-list-alice");
    const task = await createTask(delegator, delegate, "List and cite");
    const otherDelegator = await register("delegation-list-second-bob", "/delegation-list-second-bob");
    const otherTask = await createTask(otherDelegator, delegate, "Other delegator task");
    const citation = "ACK";
    const sent = await post<{ ok: boolean }>(`${broker.url}/send-message`, {
      from_token: delegate.instance_token,
      to_peer_id: delegator.peer_id,
      text: citation,
      task_id: task.task_id,
    });
    expect(sent.status).toBe(200);
    expect(taskRow(task.task_id)).toMatchObject({ status: "armed", rearm_count: 0, generation: 0 });

    const list = await post<{ tasks: Task[] }>(`${broker.url}/delegations/list`, {
      from_token: delegator.instance_token,
      peer_id: delegate.peer_id,
    });
    expect(list.status).toBe(200);
    expect(list.body.tasks.map((entry) => entry.task_id)).toEqual([task.task_id]);
    expect(list.body.tasks.map((entry) => entry.task_id)).not.toContain(otherTask.task_id);
    const publicJson = JSON.stringify(list.body);
    for (const internal of ["delegator_token", "delegate_binding", "owner_broker_id", "instance_token", "pid", "client_pid"]) {
      expect(publicJson).not.toContain(internal);
    }
  });
});

const UNTRACKED_REFUSAL =
  "Message not sent. Add deadline_sec, cite an existing task, or use expects_reply:false if no reply is expected.";

type Sent = { ok: boolean; error?: string; message_id?: number; tracking_unavailable?: string; task?: Task };

function sendAs(from: Peer, to: Peer | string, extra: Record<string, unknown> = {}, target = broker) {
  return post<Sent>(`${target.url}/send-message`, {
    from_token: from.instance_token,
    to_peer_id: typeof to === "string" ? to : to.peer_id,
    text: `message ${randomUUID()}`,
    ...extra,
  });
}

const lead = { untracked_reply_policy: "lead", expects_reply: true } as const;

function messagesBetween(from: Peer, to: Peer, target = broker): number {
  const db = openBrokerDb(target.dbPath, { readonly: true });
  try {
    return (
      db.query("SELECT COUNT(*) AS n FROM messages WHERE from_token = ? AND to_token = ?").get(from.instance_token, to.instance_token) as {
        n: number;
      }
    ).n;
  } finally {
    db.close();
  }
}

describe("untracked reply policy", () => {
  test("refuses a lead's new request to a peer that has sent nothing, without storing it", async () => {
    const boss = await register("untracked-first-boss", "/untracked-first-boss");
    const worker = await register("untracked-first-worker", "/untracked-first-worker");
    const refused = await sendAs(boss, worker, lead);
    expect(refused.body).toEqual({ ok: false, error: UNTRACKED_REFUSAL });
    expect(messagesBetween(boss, worker)).toBe(0);
  });

  test("accepts a lead's send once the target has written, then refuses the next one until it writes again", async () => {
    const boss = await register("untracked-reply-boss", "/untracked-reply-boss");
    const worker = await register("untracked-reply-worker", "/untracked-reply-worker");
    expect((await sendAs(worker, boss)).body.ok).toBeTrue();
    const answered = await sendAs(boss, worker, lead);
    expect(answered.body).toEqual({ ok: true, message_id: expect.any(Number) });
    expect((await sendAs(boss, worker, lead)).body).toEqual({ ok: false, error: UNTRACKED_REFUSAL });
    expect((await sendAs(worker, boss)).body.ok).toBeTrue();
    expect((await sendAs(boss, worker, lead)).body.ok).toBeTrue();
    expect(messagesBetween(boss, worker)).toBe(2);
  });

  test("never refuses a lead's message to itself", async () => {
    const boss = await register("untracked-self-boss", "/untracked-self-boss");
    expect((await sendAs(boss, boss, lead)).body).toEqual({ ok: true, message_id: expect.any(Number) });
  });

  test("never refuses a tracked send, a citation, an information send, a warn policy or an older client", async () => {
    const boss = await register("untracked-exempt-boss", "/untracked-exempt-boss");
    const worker = await register("untracked-exempt-worker", "/untracked-exempt-worker");
    const tracked = await sendAs(boss, worker, { ...lead, deadline_sec: 60, task_label: "Exempt" });
    expect(tracked.body.ok).toBeTrue();
    const taskId = tracked.body.task!.task_id;
    expect((await sendAs(boss, worker, { ...lead, task_id: taskId })).body.ok).toBeTrue();
    expect((await sendAs(boss, worker, { untracked_reply_policy: "lead", expects_reply: false })).body.ok).toBeTrue();
    expect((await sendAs(boss, worker, { untracked_reply_policy: "warn", expects_reply: true })).body.ok).toBeTrue();
    expect((await sendAs(boss, worker)).body.ok).toBeTrue();
  });

  test("counts any message the tracked send left behind as the lead's last send", async () => {
    const boss = await register("untracked-last-boss", "/untracked-last-boss");
    const worker = await register("untracked-last-worker", "/untracked-last-worker");
    expect((await sendAs(worker, boss)).body.ok).toBeTrue();
    expect((await sendAs(boss, worker, { ...lead, deadline_sec: 60, task_label: "Last send" })).body.ok).toBeTrue();
    expect((await sendAs(boss, worker, lead)).body).toEqual({ ok: false, error: UNTRACKED_REFUSAL });
  });

  test("refuses an unknown policy and a non boolean expects_reply before any effect", async () => {
    const boss = await register("untracked-invalid-boss", "/untracked-invalid-boss");
    const worker = await register("untracked-invalid-worker", "/untracked-invalid-worker");
    for (const extra of [
      { untracked_reply_policy: "boss" },
      { untracked_reply_policy: 5 },
      { untracked_reply_policy: null },
      { untracked_reply_policy: "lead", expects_reply: "no" },
      { untracked_reply_policy: "warn", expects_reply: 0 },
      { expects_reply: "false" },
    ]) {
      const refused = await sendAs(boss, worker, extra);
      expect(refused.body.ok, JSON.stringify(extra)).toBeFalse();
      expect(refused.body.error, JSON.stringify(extra)).not.toBe(UNTRACKED_REFUSAL);
    }
    expect(messagesBetween(boss, worker)).toBe(0);
  });

  test("decides on message ids, tokens and the group, not on timestamps, delivery or names", async () => {
    const boss = await register("untracked-ids-boss", "/untracked-ids-boss");
    const worker = await register("untracked-ids-worker", "/untracked-ids-worker");
    const other = await register("untracked-ids-other", "/untracked-ids-other");
    expect((await sendAs(other, boss)).body.ok).toBeTrue();
    expect((await sendAs(worker, other)).body.ok).toBeTrue();
    expect((await sendAs(boss, worker, lead)).body).toEqual({ ok: false, error: UNTRACKED_REFUSAL });

    expect((await sendAs(worker, boss)).body.ok).toBeTrue();
    const firstSend = await sendAs(boss, worker, lead);
    expect(firstSend.body.ok).toBeTrue();
    const inbound = await sendAs(worker, boss);
    const db = openBrokerDb(broker.dbPath);
    try {
      // The newer answer carries the older date: only the ids order the exchange.
      db.run("UPDATE messages SET sent_at = '2100-01-01T00:00:00.000Z' WHERE id = ?", [firstSend.body.message_id!]);
      db.run("UPDATE messages SET sent_at = '2000-01-01T00:00:00.000Z', delivered = 1 WHERE id = ?", [inbound.body.message_id!]);
      db.run("UPDATE peers SET peer_id = 'untracked-ids-renamed' WHERE instance_token = ?", [worker.instance_token]);
    } finally {
      db.close();
    }
    const allowed = await sendAs(boss, "untracked-ids-renamed", lead);
    expect(allowed.body).toEqual({ ok: true, message_id: expect.any(Number) });

    const equal = openBrokerDb(broker.dbPath);
    try {
      equal.run("UPDATE messages SET sent_at = '2000-01-01T00:00:00.000Z' WHERE from_token = ? OR to_token = ?", [
        boss.instance_token,
        boss.instance_token,
      ]);
    } finally {
      equal.close();
    }
    expect((await sendAs(boss, "untracked-ids-renamed", lead)).body).toEqual({ ok: false, error: UNTRACKED_REFUSAL });
  });

  test("lets exactly one of several concurrent sends through", async () => {
    const boss = await register("untracked-race-boss", "/untracked-race-boss");
    const worker = await register("untracked-race-worker", "/untracked-race-worker");
    expect((await sendAs(worker, boss)).body.ok).toBeTrue();
    const results = await Promise.all(Array.from({ length: 8 }, () => sendAs(boss, worker, lead)));
    expect(results.filter((result) => result.body.ok)).toHaveLength(1);
    expect(messagesBetween(boss, worker)).toBe(1);
  });

  test("never refuses the operator inbox, a remote peer or a group without an operator inbox, and says tracking is unavailable", async () => {
    const boss = await register("untracked-scope-boss", "/untracked-scope-boss");
    const operator = await sendAs(boss, "operator", lead);
    expect(operator.body).toEqual({ ok: true, message_id: expect.any(Number) });

    const remote = await register("untracked-scope-remote", "/untracked-scope-remote");
    const db = openBrokerDb(broker.dbPath);
    try {
      db.run("UPDATE peers SET via = 'upstream' WHERE instance_token = ?", [remote.instance_token]);
    } finally {
      db.close();
    }
    const toRemote = await sendAs(boss, remote, lead);
    expect(toRemote.body).toEqual({ ok: true, message_id: expect.any(Number), tracking_unavailable: "remote_peer" });

    const bare = async (host: string) =>
      (
        await post<Peer>(`${broker.url}/register`, {
          pid: livePid(), cwd: `/${host}`, git_root: null, tty: null, summary: "", host, client_pid: 1,
          project_key: null, group_id: "default", group_secret_hash: null,
        })
      ).body;
    const bareBoss = await bare("untracked-scope-bare-boss");
    const bareWorker = await bare("untracked-scope-bare-worker");
    const noInbox = await sendAs(bareBoss, bareWorker, lead);
    expect(noInbox.body).toEqual({ ok: true, message_id: expect.any(Number), tracking_unavailable: "no_operator_inbox" });

    const local = await register("untracked-scope-local", "/untracked-scope-local");
    expect((await sendAs(local, boss)).body.tracking_unavailable).toBeUndefined();
    expect((await sendAs(boss, local, { untracked_reply_policy: "warn", expects_reply: true })).body.tracking_unavailable).toBeUndefined();
  });

  test("keeps refusing a lead's new request when the delegator's quota is full", async () => {
    const boss = await register("untracked-quota-boss", "/untracked-quota-boss");
    const worker = await register("untracked-quota-worker", "/untracked-quota-worker");
    seedOpenTasks(boss, worker, 100);
    expect((await sendAs(boss, worker, lead)).body).toEqual({ ok: false, error: UNTRACKED_REFUSAL });
  });

  test("keeps refusing a lead's new request when the delegation policy is unavailable", async () => {
    const restricted = await startBroker({ CLAUDE_PEERS_DELEGATION_MAX_REARMS: "11" });
    try {
      const secret = randomUUID();
      const group = await groupId(secret);
      const hash = await sha256Hex(secret);
      const join = async (host: string): Promise<Peer> =>
        (
          await post<Peer>(`${restricted.url}/register`, {
            pid: livePid(), cwd: `/${host}`, git_root: null, tty: null, summary: "", host, client_pid: 1,
            project_key: null, group_id: group, group_secret_hash: hash,
          })
        ).body;
      const boss = await join("untracked-policy-boss");
      const worker = await join("untracked-policy-worker");
      expect((await sendAs(boss, worker, lead, restricted)).body).toEqual({ ok: false, error: UNTRACKED_REFUSAL });
    } finally {
      await stopBroker(restricted);
    }
  });

  test("announces the capability only a broker with the refusal and the attachment carries", async () => {
    const health = await get<{ untracked_reply_version?: number }>(`${broker.url}/health`);
    expect(health.body.untracked_reply_version).toBe(1);
  });
});
