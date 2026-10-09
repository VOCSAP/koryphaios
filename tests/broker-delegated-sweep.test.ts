import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DECK_INSTANCE_TOKEN, OPERATOR_INSTANCE_TOKEN } from "../shared/types.ts";
import { groupId, livePid, post, sha256Hex, startBroker, stopBroker, type TestBroker } from "./_helper.ts";

interface Peer {
  peer_id: string;
  instance_token: string;
}

interface Group {
  id: string;
  hash: string;
}

interface Task {
  task_id: string;
  policy: { max_rearms: number; lead_silence_sec: number; max_deadline_sec: number };
}

interface TaskState {
  status: string;
  terminal_reason: string | null;
  escalation_result: string | null;
  rearm_count: number;
  generation: number;
  due_at_ms: number | null;
  decision_due_at_ms: number | null;
  updated_at: string;
}

const TICK_ENV = { CLAUDE_PEERS_DELEGATION_SWEEP_SEC: "1", CLAUDE_PEERS_CLEAN_INTERVAL_SEC: "1" };
const ALERT = "No explicit closure";
const SETTLED = "is unresolved";

let main: TestBroker;

beforeAll(async () => {
  main = await startBroker(TICK_ENV);
});

afterAll(async () => {
  await stopBroker(main);
});

async function newGroup(): Promise<Group> {
  const secret = randomUUID();
  return { id: await groupId(secret), hash: await sha256Hex(secret) };
}

async function registerIn(b: TestBroker, group: Group, host: string): Promise<Peer> {
  const result = await post<Peer>(`${b.url}/register`, {
    pid: livePid(), cwd: `/${host}`, git_root: null, tty: null, summary: "", host: `${host}-${randomUUID().slice(0, 8)}`,
    client_pid: 1, project_key: null, group_id: group.id, group_secret_hash: group.hash,
  });
  expect(result.status).toBe(200);
  return result.body;
}

async function createTask(b: TestBroker, bob: Peer, alice: Peer, label: string): Promise<Task> {
  const result = await post<{ ok: boolean; task?: Task; error?: string }>(`${b.url}/send-message`, {
    from_token: bob.instance_token, to_peer_id: alice.peer_id, text: `Work for ${label}`, deadline_sec: 60, task_label: label,
  });
  expect(result.body.error).toBeUndefined();
  expect(result.body.ok).toBeTrue();
  return result.body.task!;
}

async function rearm(b: TestBroker, bob: Peer, alice: Peer, taskId: string): Promise<{ ok: boolean; error?: string }> {
  const result = await post<{ ok: boolean; error?: string }>(`${b.url}/send-message`, {
    from_token: bob.instance_token, to_peer_id: alice.peer_id, text: "Please continue", task_id: taskId, deadline_sec: 60,
  });
  return result.body;
}

function withDb<T>(b: TestBroker, fn: (db: Database) => T): T {
  const db = new Database(b.dbPath);
  try {
    db.run("PRAGMA busy_timeout = 3000");
    return fn(db);
  } finally {
    db.close();
  }
}

function edit(b: TestBroker, sql: string, params: (string | number | null)[]): void {
  withDb(b, (db) => db.run(sql, params));
}

function state(b: TestBroker, taskId: string): TaskState {
  return withDb(b, (db) =>
    db.query(
      `SELECT status, terminal_reason, escalation_result, rearm_count, generation, due_at_ms, decision_due_at_ms, updated_at
         FROM delegated_tasks WHERE task_id = ?`
    ).get(taskId) as TaskState
  );
}

function deckMessagesTo(b: TestBroker, token: string, taskId: string, fragment: string): number {
  return withDb(b, (db) =>
    (db.query(
      "SELECT COUNT(*) AS n FROM messages WHERE from_token = ? AND to_token = ? AND text LIKE ? AND text LIKE ?"
    ).get(DECK_INSTANCE_TOKEN, token, `%${taskId}%`, `%${fragment}%`) as { n: number }).n
  );
}

function operatorMessages(b: TestBroker, taskId: string): number {
  return deckMessagesTo(b, OPERATOR_INSTANCE_TOKEN, taskId, "");
}

function eventGenerations(b: TestBroker, taskId: string, kind: string): number[] {
  return withDb(b, (db) =>
    (db.query("SELECT generation FROM delegation_events WHERE task_id = ? AND kind = ? ORDER BY generation").all(taskId, kind) as {
      generation: number;
    }[]).map((e) => e.generation)
  );
}

async function waitFor<T>(read: () => T, done: (value: T) => boolean, what: string, timeoutMs = 12_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = read();
  while (!done(last)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last=${JSON.stringify(last)}`);
    await Bun.sleep(50);
    last = read();
  }
  return last;
}

/**
 * Returns once a full sweep has started after the caller's last write: the
 * second canary is created only after the first was escalated, so the tick
 * that settles it began after every write made before this call.
 */
async function barrier(b: TestBroker): Promise<void> {
  const group = await newGroup();
  const bob = await registerIn(b, group, "barrier-bob");
  const alice = await registerIn(b, group, "barrier-alice");
  for (let round = 0; round < 2; round++) {
    const canary = await createTask(b, bob, alice, `Barrier ${round}`);
    edit(b, "UPDATE delegated_tasks SET due_at_ms = 1, rearm_count = max_rearms WHERE task_id = ?", [canary.task_id]);
    await waitFor(() => state(b, canary.task_id), (s) => s.status === "escalated", "barrier canary");
  }
}

function pastDue(b: TestBroker, taskId: string): void {
  edit(b, "UPDATE delegated_tasks SET due_at_ms = ? WHERE task_id = ?", [Date.now() - 1000, taskId]);
}

describe("delegated task sweep", () => {
  test("alerts the delegator once per generation, then escalates once after the silence", async () => {
    const group = await newGroup();
    const bob = await registerIn(main, group, "sweep-gen-bob");
    const alice = await registerIn(main, group, "sweep-gen-alice");
    const task = await createTask(main, bob, alice, "Generation alerts");
    const notDue = await createTask(main, bob, alice, "Not yet due");

    const dueAt = Date.now() - 1000;
    edit(main, "UPDATE delegated_tasks SET due_at_ms = ? WHERE task_id = ?", [dueAt, task.task_id]);
    const overdue = await waitFor(() => state(main, task.task_id), (s) => s.status === "overdue", "first overdue");
    expect(overdue.decision_due_at_ms).toBe(dueAt + 300_000);
    expect(deckMessagesTo(main, bob.instance_token, task.task_id, ALERT)).toBe(1);

    await barrier(main);
    expect(deckMessagesTo(main, bob.instance_token, task.task_id, ALERT)).toBe(1);
    expect(state(main, notDue.task_id).status).toBe("armed");
    expect(deckMessagesTo(main, bob.instance_token, notDue.task_id, ALERT)).toBe(0);

    expect((await rearm(main, bob, alice, task.task_id)).ok).toBeTrue();
    pastDue(main, task.task_id);
    await waitFor(() => state(main, task.task_id), (s) => s.status === "overdue" && s.generation === 1, "second overdue");
    expect(deckMessagesTo(main, bob.instance_token, task.task_id, ALERT)).toBe(2);
    expect(eventGenerations(main, task.task_id, "due")).toEqual([0, 1]);

    edit(main, "UPDATE delegated_tasks SET decision_due_at_ms = ? WHERE task_id = ?", [Date.now() - 1, task.task_id]);
    const escalated = await waitFor(() => state(main, task.task_id), (s) => s.status === "escalated", "escalation");
    expect(escalated).toMatchObject({ terminal_reason: "lead_silent", escalation_result: "no_consumer", rearm_count: 1 });
    expect(operatorMessages(main, task.task_id)).toBe(1);
    expect(deckMessagesTo(main, bob.instance_token, task.task_id, SETTLED)).toBe(1);
    expect(eventGenerations(main, task.task_id, "escalate")).toEqual([1]);

    await barrier(main);
    expect(operatorMessages(main, task.task_id)).toBe(1);
    expect(deckMessagesTo(main, bob.instance_token, task.task_id, ALERT)).toBe(2);
    expect((await rearm(main, bob, alice, task.task_id)).ok).toBeFalse();
    expect(state(main, task.task_id).status).toBe("escalated");
  }, 40_000);

  test("sends the initial request plus three rearms at the default profile, then one escalation", async () => {
    const group = await newGroup();
    const bob = await registerIn(main, group, "sweep-cap-bob");
    const alice = await registerIn(main, group, "sweep-cap-alice");
    const task = await createTask(main, bob, alice, "Default cap");
    expect(task.policy.max_rearms).toBe(3);

    for (let round = 0; round < 3; round++) {
      pastDue(main, task.task_id);
      await waitFor(() => state(main, task.task_id), (s) => s.status === "overdue" && s.generation === round, `overdue ${round}`);
      expect((await rearm(main, bob, alice, task.task_id)).ok).toBeTrue();
      expect(state(main, task.task_id)).toMatchObject({ status: "armed", rearm_count: round + 1 });
    }
    const seen = new Date().toISOString();
    edit(main, "INSERT INTO operator_inbox_sessions (session_id, group_id, last_id, started_at, last_seen_at) VALUES (?, ?, 0, ?, ?)", [
      randomUUID(), group.id, seen, seen,
    ]);
    pastDue(main, task.task_id);
    const escalated = await waitFor(() => state(main, task.task_id), (s) => s.status === "escalated", "cap escalation");
    expect(escalated).toMatchObject({ terminal_reason: "rearms_exhausted", escalation_result: "emitted" });
    expect(deckMessagesTo(main, bob.instance_token, task.task_id, ALERT)).toBe(3);
    expect(operatorMessages(main, task.task_id)).toBe(1);
    expect((await rearm(main, bob, alice, task.task_id)).ok).toBeFalse();
  }, 40_000);

  test("escalates at the first deadline when the profile allows zero rearms", async () => {
    const zero = await startBroker({ ...TICK_ENV, CLAUDE_PEERS_DELEGATION_MAX_REARMS: "0" });
    try {
      const group = await newGroup();
      const bob = await registerIn(zero, group, "sweep-zero-bob");
      const alice = await registerIn(zero, group, "sweep-zero-alice");
      const task = await createTask(zero, bob, alice, "Zero rearms");
      expect(task.policy.max_rearms).toBe(0);
      const stale = new Date(Date.now() - 3 * 86_400_000).toISOString();
      edit(zero, "INSERT INTO operator_inbox_sessions (session_id, group_id, last_id, started_at, last_seen_at) VALUES (?, ?, 0, ?, ?)", [
        randomUUID(), group.id, stale, stale,
      ]);
      pastDue(zero, task.task_id);
      const escalated = await waitFor(() => state(zero, task.task_id), (s) => s.status === "escalated", "direct escalation");
      expect(escalated).toMatchObject({ terminal_reason: "rearms_exhausted", escalation_result: "no_consumer" });
      expect(deckMessagesTo(zero, bob.instance_token, task.task_id, ALERT)).toBe(0);
      expect(eventGenerations(zero, task.task_id, "due")).toEqual([]);
      expect(operatorMessages(zero, task.task_id)).toBe(1);
      expect(deckMessagesTo(zero, bob.instance_token, task.task_id, SETTLED)).toBe(1);
    } finally {
      await stopBroker(zero);
    }
  }, 30_000);

  test("falls back to the default sweep period for a value outside 1..86400, and says so", async () => {
    const warning = "CLAUDE_PEERS_DELEGATION_SWEEP_SEC is not an integer between 1 and 86400";
    const logOf = (b: TestBroker): string => readFileSync(join(b.tmpDir, "logs", "broker.log"), "utf8");
    for (const [value, warned] of [["86401", true], ["3000000000", true], ["0", true], ["86400", false], ["1", false]] as const) {
      const probe = await startBroker({ CLAUDE_PEERS_DELEGATION_SWEEP_SEC: value });
      try {
        expect(logOf(probe).includes(warning), `value ${value}`).toBe(warned);
      } finally {
        await stopBroker(probe);
      }
    }
  }, 60_000);

  test("allows the tenth rearm and escalates at the eleventh expiry when the profile allows ten", async () => {
    const ten = await startBroker({ ...TICK_ENV, CLAUDE_PEERS_DELEGATION_MAX_REARMS: "10", CLAUDE_PEERS_DELEGATION_LEAD_SILENCE_SEC: "15" });
    try {
      const group = await newGroup();
      const bob = await registerIn(ten, group, "sweep-ten-bob");
      const alice = await registerIn(ten, group, "sweep-ten-alice");
      const task = await createTask(ten, bob, alice, "Ten rearms");
      expect(task.policy).toMatchObject({ max_rearms: 10, lead_silence_sec: 15 });
      edit(ten, "UPDATE delegated_tasks SET rearm_count = 9, generation = 9 WHERE task_id = ?", [task.task_id]);

      pastDue(ten, task.task_id);
      await waitFor(() => state(ten, task.task_id), (s) => s.status === "overdue", "ninth overdue");
      expect((await rearm(ten, bob, alice, task.task_id)).ok).toBeTrue();
      expect(state(ten, task.task_id)).toMatchObject({ status: "armed", rearm_count: 10, generation: 10 });

      pastDue(ten, task.task_id);
      const escalated = await waitFor(() => state(ten, task.task_id), (s) => s.status === "escalated", "tenth escalation");
      expect(escalated.terminal_reason).toBe("rearms_exhausted");
      expect(operatorMessages(ten, task.task_id)).toBe(1);
    } finally {
      await stopBroker(ten);
    }
  }, 30_000);

  test("leaves terminal and not-yet-due tasks untouched", async () => {
    const group = await newGroup();
    const bob = await registerIn(main, group, "sweep-control-bob");
    const alice = await registerIn(main, group, "sweep-control-alice");
    const untouched: string[] = [];
    for (const status of ["escalated", "orphaned", "delivery_failed", "closed"]) {
      const task = await createTask(main, bob, alice, `Terminal ${status}`);
      edit(main, "UPDATE delegated_tasks SET status = ?, due_at_ms = 1, decision_due_at_ms = 1 WHERE task_id = ?", [status, task.task_id]);
      untouched.push(task.task_id);
    }
    const armed = await createTask(main, bob, alice, "Armed future");
    const before = untouched.map((id) => state(main, id));

    await barrier(main);
    expect(untouched.map((id) => state(main, id))).toEqual(before);
    for (const id of [...untouched, armed.task_id]) {
      expect(operatorMessages(main, id)).toBe(0);
      expect(deckMessagesTo(main, bob.instance_token, id, "")).toBe(0);
    }
    expect(state(main, armed.task_id).status).toBe("armed");
  }, 30_000);

  describe("a row changed between the sweep's read and its update", () => {
    type Scenario = {
      name: string;
      prepare: string;
      settle: (first: string, second: string) => string;
      alertsExpected: boolean;
      before: string;
    };
    const scenarios: Scenario[] = [
      {
        name: "overdue alert",
        prepare: "",
        settle: (first, second) => `due_at_ms = CASE task_id WHEN '${first}' THEN ${Date.now() - 2000} ELSE ${Date.now() - 1000} END WHERE task_id IN ('${first}', '${second}')`,
        alertsExpected: true,
        before: "armed",
      },
      {
        name: "rearm cap escalation",
        prepare: "rearm_count = max_rearms,",
        settle: (first, second) => `due_at_ms = CASE task_id WHEN '${first}' THEN ${Date.now() - 2000} ELSE ${Date.now() - 1000} END WHERE task_id IN ('${first}', '${second}')`,
        alertsExpected: false,
        before: "armed",
      },
      {
        name: "silent delegator escalation",
        prepare: "status = 'overdue', due_at_ms = 1,",
        settle: (first, second) => `decision_due_at_ms = CASE task_id WHEN '${first}' THEN ${Date.now() - 2000} ELSE ${Date.now() - 1000} END WHERE task_id IN ('${first}', '${second}')`,
        alertsExpected: false,
        before: "overdue",
      },
    ];
    const changes = [
      { name: "closed", set: "status = 'closed'", regenerated: false },
      { name: "pushed back by a rearm", set: "due_at_ms = 9999999999999, decision_due_at_ms = 9999999999999", regenerated: false },
      { name: "re-generated", set: "generation = 1", regenerated: true },
    ];

    for (const scenario of scenarios) {
      for (const change of changes) {
        test(`${scenario.name}: ${change.regenerated ? "handles" : "leaves"} a row ${change.name} by the first row's processing ${change.regenerated ? "under its new generation" : "untouched"}`, async () => {
          const group = await newGroup();
          const bob = await registerIn(main, group, "sweep-stale-bob");
          const alice = await registerIn(main, group, "sweep-stale-alice");
          const created = [
            (await createTask(main, bob, alice, "Stale one")).task_id,
            (await createTask(main, bob, alice, "Stale two")).task_id,
          ];
          const [first, second] = [...created].sort() as [string, string];
          const trigger = `stale_${randomUUID().replaceAll("-", "")}`;
          if (scenario.prepare) {
            edit(main, `UPDATE delegated_tasks SET ${scenario.prepare} generation = generation WHERE task_id IN (?, ?)`, [first, second]);
          }
          edit(
            main,
            `CREATE TRIGGER ${trigger} AFTER INSERT ON messages WHEN NEW.text LIKE '%${first}%'
               BEGIN UPDATE delegated_tasks SET ${change.set} WHERE task_id = '${second}'; END`,
            []
          );
          try {
            edit(main, `UPDATE delegated_tasks SET ${scenario.settle(first, second)}`, []);
            await waitFor(() => state(main, first), (s) => s.status === (scenario.alertsExpected ? "overdue" : "escalated"), "first row processed");
            if (change.regenerated) {
              const kind = scenario.alertsExpected ? "due" : "escalate";
              await waitFor(() => state(main, second), (s) => s.status === (scenario.alertsExpected ? "overdue" : "escalated"), "second row processed");
              expect(eventGenerations(main, second, kind)).toEqual([1]);
              return;
            }
            await barrier(main);
            expect(state(main, second).status).toBe(change.name === "closed" ? "closed" : scenario.before);
            expect(deckMessagesTo(main, bob.instance_token, second, "")).toBe(0);
            expect(operatorMessages(main, second)).toBe(0);
            expect(eventGenerations(main, second, "due")).toEqual([]);
            expect(eventGenerations(main, second, "escalate")).toEqual([]);
          } finally {
            edit(main, `DROP TRIGGER IF EXISTS ${trigger}`, []);
          }
        }, 40_000);
      }
    }

    const orphanChanges = [
      { name: "closed", set: "status = 'closed'", status: "closed" },
      { name: "pointing at a live participant again", set: "delegate_binding = delegator_token", status: "armed" },
    ];
    for (const change of orphanChanges) {
      test(`orphaning: leaves a row ${change.name} by the first row's processing untouched`, async () => {
        const group = await newGroup();
        const bob = await registerIn(main, group, "sweep-stale-orphan-bob");
        const alice = await registerIn(main, group, "sweep-stale-orphan-alice");
        const created = [
          (await createTask(main, bob, alice, "Orphan one")).task_id,
          (await createTask(main, bob, alice, "Orphan two")).task_id,
        ];
        const [first, second] = [...created].sort() as [string, string];
        const trigger = `stale_${randomUUID().replaceAll("-", "")}`;
        edit(
          main,
          `CREATE TRIGGER ${trigger} AFTER INSERT ON messages WHEN NEW.text LIKE '%${first}%'
             BEGIN UPDATE delegated_tasks SET ${change.set} WHERE task_id = '${second}'; END`,
          []
        );
        try {
          edit(main, "DELETE FROM peers WHERE instance_token = ?", [alice.instance_token]);
          await waitFor(() => state(main, first), (s) => s.status === "orphaned", "first row orphaned");
          await barrier(main);
          expect(state(main, second).status).toBe(change.status);
          expect(operatorMessages(main, second)).toBe(0);
          expect(deckMessagesTo(main, bob.instance_token, second, "")).toBe(0);
        } finally {
          edit(main, `DROP TRIGGER IF EXISTS ${trigger}`, []);
        }
      }, 40_000);
    }
  });

  test("refuses a rearm after the decision window even before the next tick, then escalates directly after a restart", async () => {
    const first = await startBroker({ CLAUDE_PEERS_DELEGATION_SWEEP_SEC: "3600" });
    let second: TestBroker | null = null;
    let third: TestBroker | null = null;
    try {
      const group = await newGroup();
      const bob = await registerIn(first, group, "sweep-restart-bob");
      const alice = await registerIn(first, group, "sweep-restart-alice");
      const silent = await createTask(first, bob, alice, "Overdue past decision");
      const longGone = await createTask(first, bob, alice, "Armed past both windows");
      const already = await createTask(first, bob, alice, "Already escalated");
      const now = Date.now();
      edit(first, "UPDATE delegated_tasks SET status = 'overdue', due_at_ms = ?, decision_due_at_ms = ? WHERE task_id = ?", [
        now - 400_000, now - 100_000, silent.task_id,
      ]);
      edit(first, "UPDATE delegated_tasks SET due_at_ms = ? WHERE task_id = ?", [now - 400_000, longGone.task_id]);
      edit(
        first,
        `UPDATE delegated_tasks SET status = 'escalated', terminal_reason = 'lead_silent', escalation_result = 'emitted',
           due_at_ms = ? WHERE task_id = ?`,
        [now - 400_000, already.task_id]
      );

      expect((await rearm(first, bob, alice, silent.task_id)).ok).toBeFalse();
      expect(state(first, silent.task_id)).toMatchObject({ status: "overdue", rearm_count: 0, generation: 0 });

      first.proc.kill();
      await first.proc.exited;
      second = await startBroker({ CLAUDE_PEERS_DB: first.dbPath, CLAUDE_PEERS_DELEGATION_SWEEP_SEC: "3600" });
      second.dbPath = first.dbPath;
      for (const id of [silent.task_id, longGone.task_id]) {
        expect(state(second, id)).toMatchObject({ status: "escalated", terminal_reason: "lead_silent", escalation_result: "no_consumer" });
        expect(operatorMessages(second, id)).toBe(1);
        expect(deckMessagesTo(second, bob.instance_token, id, ALERT)).toBe(0);
        expect(eventGenerations(second, id, "due")).toEqual([]);
      }
      expect(operatorMessages(second, already.task_id)).toBe(0);
      expect(state(second, already.task_id).escalation_result).toBe("emitted");

      second.proc.kill();
      await second.proc.exited;
      third = await startBroker({ ...TICK_ENV, CLAUDE_PEERS_DB: first.dbPath });
      third.dbPath = first.dbPath;
      await barrier(third);
      for (const id of [silent.task_id, longGone.task_id]) expect(operatorMessages(third, id)).toBe(1);
      expect(operatorMessages(third, already.task_id)).toBe(0);
    } finally {
      if (third) await stopBroker(third);
      if (second) await stopBroker(second);
      await stopBroker(first);
    }
  }, 60_000);

  test("orphans a task whose participant was purged or unregistered and never routes it to a namesake", async () => {
    const group = await newGroup();
    const bob = await registerIn(main, group, "sweep-orphan-bob");
    const alice = await registerIn(main, group, "sweep-orphan-alice");
    alice.peer_id = `alice-${randomUUID().slice(0, 8)}`;
    const named = await post(`${main.url}/set-id`, { instance_token: alice.instance_token, new_peer_id: alice.peer_id });
    expect(named.status).toBe(200);
    const task = await createTask(main, bob, alice, "Purged delegate");

    edit(main, "UPDATE peers SET status = 'dormant' WHERE instance_token = ?", [alice.instance_token]);
    await barrier(main);
    expect(state(main, task.task_id).status).toBe("armed");

    edit(main, "UPDATE peers SET last_seen = ? WHERE instance_token = ?", [new Date(Date.now() - 3 * 86_400_000).toISOString(), alice.instance_token]);
    const orphaned = await waitFor(() => state(main, task.task_id), (s) => s.status === "orphaned", "orphaned by purge");
    expect(orphaned).toMatchObject({ terminal_reason: "participant_gone", escalation_result: "no_consumer" });
    expect(operatorMessages(main, task.task_id)).toBe(1);
    expect(deckMessagesTo(main, bob.instance_token, task.task_id, SETTLED)).toBe(1);

    const namesake = await registerIn(main, group, "sweep-orphan-namesake");
    const renamed = await post<{ peer_id?: string; error?: string }>(`${main.url}/set-id`, {
      instance_token: namesake.instance_token,
      new_peer_id: alice.peer_id,
    });
    expect(renamed.body.error).toBeUndefined();
    expect(renamed.body.peer_id).toBe(alice.peer_id);
    await barrier(main);
    expect(deckMessagesTo(main, namesake.instance_token, task.task_id, "")).toBe(0);
    expect(operatorMessages(main, task.task_id)).toBe(1);
    expect(state(main, task.task_id).status).toBe("orphaned");

    const lone = await registerIn(main, group, "sweep-orphan-lone-bob");
    const delegate = await registerIn(main, group, "sweep-orphan-lone-alice");
    const loneTask = await createTask(main, lone, delegate, "Unregistered delegator");
    const unregistered = await post(`${main.url}/unregister`, { instance_token: lone.instance_token });
    expect(unregistered.status).toBe(200);
    await waitFor(() => state(main, loneTask.task_id), (s) => s.status === "orphaned", "orphaned by unregister");
    expect(operatorMessages(main, loneTask.task_id)).toBe(1);
    expect(deckMessagesTo(main, delegate.instance_token, loneTask.task_id, "")).toBe(0);
  }, 40_000);

  test("keeps a task running when its delegate is renamed and its delegator is dormant", async () => {
    const group = await newGroup();
    const bob = await registerIn(main, group, "sweep-rename-bob");
    const alice = await registerIn(main, group, "sweep-rename-alice");
    const task = await createTask(main, bob, alice, "Renamed delegate");
    const renamed = await post<{ peer_id?: string }>(`${main.url}/set-id`, {
      instance_token: alice.instance_token,
      new_peer_id: `renamed-${randomUUID().slice(0, 8)}`,
    });
    expect(renamed.status).toBe(200);
    edit(main, "UPDATE peers SET status = 'dormant' WHERE instance_token = ?", [bob.instance_token]);

    await barrier(main);
    expect(state(main, task.task_id).status).toBe("armed");

    pastDue(main, task.task_id);
    await waitFor(() => state(main, task.task_id), (s) => s.status === "overdue", "overdue after rename");
    expect(deckMessagesTo(main, bob.instance_token, task.task_id, ALERT)).toBe(1);
    expect(deckMessagesTo(main, bob.instance_token, task.task_id, renamed.body.peer_id!)).toBe(1);
  }, 30_000);

  test("settles an escalation whose notification fails without retrying it on later ticks", async () => {
    const failing = await startBroker(TICK_ENV);
    try {
      const group = await newGroup();
      const bob = await registerIn(failing, group, "sweep-fail-bob");
      const alice = await registerIn(failing, group, "sweep-fail-alice");
      const task = await createTask(failing, bob, alice, "Inbox failure");
      edit(failing, "DELETE FROM peers WHERE instance_token = ?", [OPERATOR_INSTANCE_TOKEN]);
      expect(
        withDb(failing, (db) => (db.query("SELECT COUNT(*) AS n FROM peers WHERE instance_token = ?").get(OPERATOR_INSTANCE_TOKEN) as { n: number }).n)
      ).toBe(0);

      edit(failing, "UPDATE delegated_tasks SET due_at_ms = 1, rearm_count = max_rearms WHERE task_id = ?", [task.task_id]);
      const settled = await waitFor(() => state(failing, task.task_id), (s) => s.status === "escalated", "settled despite failure");
      expect(settled).toMatchObject({ terminal_reason: "rearms_exhausted", escalation_result: "failed" });
      expect(operatorMessages(failing, task.task_id)).toBe(0);
      expect(deckMessagesTo(failing, bob.instance_token, task.task_id, SETTLED)).toBe(0);

      await barrier(failing);
      expect(state(failing, task.task_id)).toEqual(settled);
      const log = readFileSync(join(failing.tmpDir, "logs", "broker.log"), "utf8");
      expect(log.split("\n").filter((line) => line.includes(`notifying escalated task ${task.task_id}`))).toHaveLength(1);
    } finally {
      await stopBroker(failing);
    }
  }, 40_000);

  test("two brokers on one database stay consistent", async () => {
    const other = await startBroker({ ...TICK_ENV, CLAUDE_PEERS_DB: main.dbPath });
    try {
      const group = await newGroup();
      const bob = await registerIn(main, group, "sweep-race-bob");
      const alice = await registerIn(main, group, "sweep-race-alice");
      const ids: string[] = [];
      for (let index = 0; index < 5; index++) ids.push((await createTask(main, bob, alice, `Race ${index}`)).task_id);

      for (const id of ids) pastDue(main, id);
      for (const id of ids) await waitFor(() => state(main, id), (s) => s.status === "overdue", "race overdue");
      await barrier(main);
      for (const id of ids) {
        expect(deckMessagesTo(main, bob.instance_token, id, ALERT)).toBe(1);
        expect(eventGenerations(main, id, "due")).toEqual([0]);
      }

      for (const id of ids) edit(main, "UPDATE delegated_tasks SET decision_due_at_ms = ? WHERE task_id = ?", [Date.now() - 1, id]);
      for (const id of ids) await waitFor(() => state(main, id), (s) => s.status === "escalated", "race escalated");
      await barrier(main);
      for (const id of ids) {
        expect(operatorMessages(main, id)).toBe(1);
        expect(deckMessagesTo(main, bob.instance_token, id, SETTLED)).toBe(1);
      }
    } finally {
      await stopBroker(other);
    }
  }, 60_000);
});
