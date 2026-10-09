import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { get, groupId, livePid, post, sha256Hex, startBroker, stopBroker, type TestBroker } from "./_helper.ts";

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

async function register(host: string, cwd: string): Promise<Peer> {
  const result = await post<Peer>(`${broker.url}/register`, {
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

async function createTask(delegator: Peer, delegate: Peer, label: string): Promise<Task> {
  const result = await post<{ ok: boolean; task?: Task; error?: string }>(`${broker.url}/send-message`, {
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

function taskRow(taskId: string): { status: string; rearm_count: number; generation: number; closed_at: string | null } {
  const db = new Database(broker.dbPath, { readonly: true });
  try {
    return db.query(
      "SELECT status, rearm_count, generation, closed_at FROM delegated_tasks WHERE task_id = ?"
    ).get(taskId) as { status: string; rearm_count: number; generation: number; closed_at: string | null };
  } finally {
    db.close();
  }
}

function countMessagesWithText(text: string): number {
  const db = new Database(broker.dbPath, { readonly: true });
  try {
    return (db.query("SELECT COUNT(*) AS count FROM messages WHERE text = ?").get(text) as { count: number }).count;
  } finally {
    db.close();
  }
}

function countTasksWithLabel(label: string): number {
  const db = new Database(broker.dbPath, { readonly: true });
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
    const homonymDb = new Database(broker.dbPath);
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
    const groupBound = new Database(broker.dbPath, { readonly: true });
    try {
      expect(
        (groupBound.query("SELECT delegate_binding FROM delegated_tasks WHERE label = ?").get("Group binding") as { delegate_binding: string }).delegate_binding
      ).toBe(delegate.instance_token);
    } finally {
      groupBound.close();
    }

    const relayLabel = "Relay refusal";
    const relayText = "must not reach a relay";
    const relayDb = new Database(broker.dbPath);
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
    const db = new Database(broker.dbPath);
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
    const db = new Database(broker.dbPath);
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

    const db = new Database(broker.dbPath);
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
    const renameDb = new Database(broker.dbPath);
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

  test("rearms only an overdue task and persists a new generation with its message", async () => {
    const delegator = await register("delegation-rearm-bob", "/delegation-rearm-bob");
    const delegate = await register("delegation-rearm-alice", "/delegation-rearm-alice");
    const task = await createTask(delegator, delegate, "Rearm task");
    const db = new Database(broker.dbPath);
    try {
      db.run(
        "UPDATE delegated_tasks SET status = 'overdue', decision_due_at_ms = ? WHERE task_id = ?",
        [Date.now() + 60_000, task.task_id]
      );
    } finally {
      db.close();
    }

    const rearmText = "Please continue the assigned work";
    const rejectDb = new Database(broker.dbPath);
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
