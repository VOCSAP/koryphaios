import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATOMIC_DISPATCH_MAX_MEMBERS,
  ATOMIC_DISPATCH_MAX_OPERATION_MS,
  ATOMIC_DISPATCH_REGISTRY_CAPACITY,
  DISPATCH_OPERATIONS_DDL,
  atomicDispatchDigest,
  dispatchStateTag,
  parseOperationId,
  runAtomicDispatch,
  validateAtomicDispatchIntent,
  type AtomicDispatchDeps,
  type AtomicDispatchMemberRow,
  type DispatchStateColumns,
} from "../shared/roadmap-dispatch-atomic.ts";
import {
  composeAtomicDispatchText,
  composeDispatchText,
  composeMultiDispatchText,
  composeAssignText,
} from "../shared/roadmap-dispatch-message.ts";
import type { AtomicDispatchIntent, AtomicDispatchOutcome } from "../shared/types.ts";

const BROKER = "11111111-aaaa-bbbb-cccc-222222222222";
const PROJECT = "github.com/example/repo";
const GROUP = "group-one";
const OPERATOR = "operator-a";
const START = 1_800_000_000_000;

const isPeerId = (v: string): boolean => /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(v);

const STATE: DispatchStateColumns = {
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  project_key: PROJECT,
  queue: 3,
  lot_id: "default",
  locked: 1,
  locked_by: "worker-1",
  locked_group: GROUP,
  locked_by_token: "tok-private",
  locked_at: "2026-01-01 00:00:00",
  lock_parked_by: null,
  lock_parked_at: null,
  lock_scope: "local",
  lock_relay: null,
  lock_contested_by: "[]",
  lock_release_owner: null,
  sync_state: "clean",
};

describe("dispatchStateTag", () => {
  const base = dispatchStateTag(STATE, BROKER);

  test("is a 64-character hex digest that does not contain the private lock token", () => {
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(base).not.toContain("tok-private");
  });

  test("ignores columns outside the operational state, such as rev and updated_at", () => {
    const echoed = { ...STATE, rev: 99, updated_at: "later", sync_dirty: 1, lock_relay_seen: "x" };
    expect(dispatchStateTag(echoed, BROKER)).toBe(base);
  });

  const moves: [string, Partial<DispatchStateColumns>][] = [
    ["queue", { queue: 4 }],
    ["queue cleared", { queue: null }],
    ["lot", { lot_id: "bbbbbbbb-0000-0000-0000-000000000001" }],
    ["lock held", { locked: 0 }],
    ["lock owner", { locked_by: "worker-2" }],
    ["lock group", { locked_group: "group-two" }],
    ["lock owner token", { locked_by_token: "tok-other" }],
    ["lock date", { locked_at: "2026-01-02 00:00:00" }],
    ["park owner", { lock_parked_by: "op" }],
    ["park date", { lock_parked_at: "2026-01-02 00:00:00" }],
    ["lock scope", { lock_scope: "contested" }],
    ["lock relay", { lock_relay: "{\"peer\":\"x\"}" }],
    ["lock contest", { lock_contested_by: "[\"x\"]" }],
    ["release owner", { lock_release_owner: "worker-1" }],
    ["sync state", { sync_state: "conflict" }],
    ["card id", { id: "aaaaaaaa-0000-0000-0000-000000000002" }],
    ["project", { project_key: "github.com/example/other" }],
  ];
  test.each(moves)("changes when the %s changes", (_name, patch) => {
    expect(dispatchStateTag({ ...STATE, ...patch }, BROKER)).not.toBe(base);
  });

  test("changes with the broker identity", () => {
    expect(dispatchStateTag(STATE, "99999999-aaaa-bbbb-cccc-222222222222")).not.toBe(base);
  });
});

const TAG_A = "a".repeat(64);
function intent(over: Partial<AtomicDispatchIntent> = {}): AtomicDispatchIntent {
  return {
    broker_id: BROKER,
    operation_id: `${START + 60_000}:5b1b7a8e-1c6f-4d7e-9a3b-0c5f6a7b8c9d`,
    project_key: PROJECT,
    group_id: GROUP,
    mode: "wave",
    target_kind: "lead",
    to_peer_id: "lead-1",
    members: [{ id: "card-aaaa-0001", expected_content_rev: 4, expected_dispatch_state_tag: TAG_A }],
    ...over,
  };
}

describe("operation id and digest", () => {
  test("parses <deadline_ms>:<uuid> and nothing else", () => {
    expect(parseOperationId(`1800000060000:5b1b7a8e-1c6f-4d7e-9a3b-0c5f6a7b8c9d`)).toEqual({ deadlineMs: 1800000060000 });
    for (const bad of ["", "abc", "1:2", "1800000060000:NOT-A-UUID", "-5:5b1b7a8e-1c6f-4d7e-9a3b-0c5f6a7b8c9d", "99999999999999999:5b1b7a8e-1c6f-4d7e-9a3b-0c5f6a7b8c9d"]) {
      expect(parseOperationId(bad)).toBeNull();
    }
  });

  test("digest ignores the operation id and moves with every business field", () => {
    const base = atomicDispatchDigest(intent());
    expect(atomicDispatchDigest(intent({ operation_id: `${START + 1}:5b1b7a8e-1c6f-4d7e-9a3b-0c5f6a7b8c9d` }))).toBe(base);
    const moved: Partial<AtomicDispatchIntent>[] = [
      { broker_id: "99999999-aaaa-bbbb-cccc-222222222222" },
      { project_key: "github.com/example/other" },
      { group_id: "group-two" },
      { mode: "assign", target_kind: "assignee" },
      { target_kind: "sole-active-fallback" },
      { to_peer_id: "lead-2" },
      { members: [{ id: "card-aaaa-0001", expected_content_rev: 5, expected_dispatch_state_tag: TAG_A }] },
      { members: [{ id: "card-aaaa-0001", expected_content_rev: 4, expected_dispatch_state_tag: "b".repeat(64) }] },
      { members: [{ id: "card-aaaa-0002", expected_content_rev: 4, expected_dispatch_state_tag: TAG_A }] },
    ];
    for (const patch of moved) expect(atomicDispatchDigest(intent(patch))).not.toBe(base);
  });

  test("digest depends on member order", () => {
    const a = { id: "card-aaaa-0001", expected_content_rev: 1, expected_dispatch_state_tag: TAG_A };
    const b = { id: "card-aaaa-0002", expected_content_rev: 1, expected_dispatch_state_tag: TAG_A };
    expect(atomicDispatchDigest(intent({ members: [a, b] }))).not.toBe(atomicDispatchDigest(intent({ members: [b, a] })));
  });
});

describe("validateAtomicDispatchIntent", () => {
  const ok = (raw: unknown): boolean => validateAtomicDispatchIntent(raw, isPeerId).ok;
  const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(intent()));

  test("accepts a well-formed wave and assign intent", () => {
    expect(ok(intent())).toBe(true);
    expect(ok(intent({ mode: "assign", target_kind: "assignee" }))).toBe(true);
  });

  test("refuses every closed-validation violation", () => {
    const m2 = { id: "card-aaaa-0002", expected_content_rev: 1, expected_dispatch_state_tag: TAG_A };
    const cases: [string, unknown][] = [
      ["non-object", "x"],
      ["array", []],
      ["extra intent key", { ...clone(), status: "done" }],
      ["missing intent key", (() => { const r = clone(); delete r.group_id; return r; })()],
      ["bad broker id", { ...clone(), broker_id: "x" }],
      ["bad operation id", { ...clone(), operation_id: "nope" }],
      ["upper-case project key", { ...clone(), project_key: "GitHub.com/Example/Repo" }],
      ["empty group", { ...clone(), group_id: "" }],
      ["bad mode", { ...clone(), mode: "stop" }],
      ["assign with lead", { ...clone(), mode: "assign", target_kind: "lead" }],
      ["wave with assignee", { ...clone(), target_kind: "assignee" }],
      ["bad peer id", { ...clone(), to_peer_id: "Not A Peer" }],
      ["empty members", { ...clone(), members: [] }],
      ["non-array members", { ...clone(), members: "x" }],
      ["assign with two members", intent({ mode: "assign", target_kind: "assignee", members: [intent().members[0]!, m2] })],
      ["duplicate member", intent({ members: [intent().members[0]!, intent().members[0]!] })],
      ["extra member key", { ...clone(), members: [{ ...intent().members[0]!, queue: 1 }] }],
      ["fractional revision", intent({ members: [{ ...intent().members[0]!, expected_content_rev: 1.5 }] })],
      ["negative revision", intent({ members: [{ ...intent().members[0]!, expected_content_rev: -1 }] })],
      ["unsafe revision", intent({ members: [{ ...intent().members[0]!, expected_content_rev: 2 ** 60 }] })],
      ["NaN revision", intent({ members: [{ ...intent().members[0]!, expected_content_rev: Number.NaN }] })],
      ["string revision", { ...clone(), members: [{ ...intent().members[0]!, expected_content_rev: "4" }] }],
      ["missing tag", { ...clone(), members: [{ id: "card-aaaa-0001", expected_content_rev: 4 }] }],
      ["short tag", intent({ members: [{ ...intent().members[0]!, expected_dispatch_state_tag: "abc" }] })],
      ["too many members", intent({ members: Array.from({ length: ATOMIC_DISPATCH_MAX_MEMBERS + 1 }, (_, i) => ({ id: `card-aaaa-${String(i).padStart(4, "0")}`, expected_content_rev: 0, expected_dispatch_state_tag: TAG_A })) })],
    ];
    for (const [name, raw] of cases) expect([name, ok(raw)]).toEqual([name, false]);
  });
});

describe("dispatch message composers", () => {
  const card = {
    id: "12345678-aaaa-bbbb-cccc-000000000001",
    title: "First",
    kind: "feature",
    priority: "should",
    value: "high",
    effort: "low",
    status: "planned",
    description: "d",
    rationale: "",
    context: "",
    tags: ["x"],
    depends_on: ["abcdef12-0000"],
  };
  const second = { ...card, id: "12345678-aaaa-bbbb-cccc-000000000002", title: "Second" };

  test("a one-card wave is the single dispatch text, a lead target adds no note", () => {
    expect(composeAtomicDispatchText("wave", "lead", [card])).toBe(composeDispatchText(card));
    expect(composeMultiDispatchText([card])).toBe(composeDispatchText(card));
  });

  test("the sole-session note follows the validated target kind only", () => {
    const text = composeAtomicDispatchText("wave", "sole-active-fallback", [card, second]);
    expect(text).toBe(`${composeMultiDispatchText([card, second])}\n(No team-lead is designated; you are the only active session.)`);
    expect(composeAtomicDispatchText("wave", "lead", [card, second])).not.toContain("No team-lead");
  });

  test("an assignment is the assign text of its one card", () => {
    expect(composeAtomicDispatchText("assign", "assignee", [card])).toBe(composeAssignText(card));
    expect(composeAssignText(card)).toContain("assigned THIS roadmap item to you");
  });
});

interface World {
  db: Database;
  deps: AtomicDispatchDeps;
  clock: { now: number };
  pushes: { token: string; messageId: number; text: string; sentAt: string }[];
  warns: string[];
  tagOf: (id: string) => string;
  revOf: (id: string) => number;
  members: (ids: string[]) => AtomicDispatchIntent["members"];
  cardRows: () => unknown[];
  messageCount: () => number;
  opCount: () => number;
}

function seed(db: Database): void {
  db.run(`CREATE TABLE cards (id TEXT PRIMARY KEY, project_key TEXT, kind TEXT, status TEXT, inactive INTEGER,
    deleted_at TEXT, queue INTEGER, content_rev INTEGER, tag TEXT, title TEXT)`);
  db.run(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, to_token TEXT, group_id TEXT, text TEXT, sent_at TEXT)`);
  for (const ddl of DISPATCH_OPERATIONS_DDL) db.run(ddl);
  const add = (id: string, status: string, queue: number | null, extra: Partial<{ kind: string; inactive: number; project: string }> = {}): void => {
    db.run("INSERT INTO cards VALUES (?, ?, ?, ?, ?, NULL, ?, 4, ?, ?)", [
      id, extra.project ?? PROJECT, extra.kind ?? "feature", status, extra.inactive ?? 0, queue, `${"c".repeat(60)}${id.slice(-4)}`, `title ${id}`,
    ]);
  };
  add("card-aaaa-0001", "idea", 1);
  add("card-aaaa-0002", "planned", 1);
  add("card-aaaa-0003", "planned", 2);
  add("card-aaaa-0004", "done", null);
  add("card-aaaa-0005", "planned", null, { inactive: 1 });
  add("card-aaaa-0006", "planned", null, { kind: "directive" });
  add("card-aaaa-0007", "planned", null, { project: "github.com/example/other" });
}

function world(db: Database = new Database(":memory:"), onPush?: AtomicDispatchDeps["push"]): World {
  seed(db);
  const clock = { now: START };
  const pushes: World["pushes"] = [];
  const warns: string[] = [];
  const deps: AtomicDispatchDeps = {
    db,
    now: () => clock.now,
    brokerId: BROKER,
    isPeerId,
    findTarget: (group, peer) => (group === GROUP && (peer === "lead-1" || peer === "worker-9") ? { token: `token-${peer}` } : null),
    loadMember: (id) => {
      const r = db.query("SELECT * FROM cards WHERE id = ?").get(id) as Record<string, unknown> | null;
      if (!r) return null;
      return {
        id: r.id, project_key: r.project_key, kind: r.kind, status: r.status, inactive: r.inactive === 1,
        deleted_at: r.deleted_at, queue: r.queue, content_rev: r.content_rev, state_tag: r.tag,
      } as AtomicDispatchMemberRow;
    },
    headWaveIds: (project) => {
      const rows = db
        .query("SELECT id, queue FROM cards WHERE project_key = ? AND queue IS NOT NULL AND status NOT IN ('done','archived') ORDER BY queue, id")
        .all(project) as { id: string; queue: number }[];
      const head = rows[0]?.queue;
      return rows.filter((r) => r.queue === head).map((r) => r.id);
    },
    writeMember: (member, patch, expectedRev) => {
      const res = db.run("UPDATE cards SET status = ?, queue = ?, content_rev = content_rev + 1 WHERE id = ? AND content_rev = ?", [patch.status, patch.queue, member.id, expectedRev]);
      if (res.changes === 0) return { ok: false, reason: "card-changed" };
      const r = db.query("SELECT * FROM cards WHERE id = ?").get(member.id) as Record<string, string>;
      return { ok: true, card: { id: r.id!, title: r.title!, kind: r.kind as "feature", priority: "should", value: "medium", effort: "medium", status: r.status!, description: "", rationale: "", context: "", tags: [], depends_on: [] } };
    },
    insertMessage: (token, group, text, at) => Number(db.run("INSERT INTO messages (to_token, group_id, text, sent_at) VALUES (?, ?, ?, ?)", [token, group, text, at]).lastInsertRowid),
    push: onPush ?? ((frame) => { pushes.push(frame); }),
    warn: (message) => { warns.push(message); },
  };
  return {
    db, deps, clock, pushes, warns,
    tagOf: (id) => (db.query("SELECT tag FROM cards WHERE id = ?").get(id) as { tag: string }).tag,
    revOf: (id) => (db.query("SELECT content_rev FROM cards WHERE id = ?").get(id) as { content_rev: number }).content_rev,
    members: (ids) => ids.map((id) => ({ id, expected_content_rev: (db.query("SELECT content_rev FROM cards WHERE id = ?").get(id) as { content_rev: number }).content_rev, expected_dispatch_state_tag: (db.query("SELECT tag FROM cards WHERE id = ?").get(id) as { tag: string }).tag })),
    cardRows: () => db.query("SELECT * FROM cards ORDER BY id").all(),
    messageCount: () => (db.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n,
    opCount: () => (db.query("SELECT COUNT(*) AS n FROM roadmap_dispatch_operations").get() as { n: number }).n,
  };
}

let opSeq = 0;
function opId(clockNow: number, offsetMs = 60_000): string {
  opSeq += 1;
  return `${clockNow + offsetMs}:5b1b7a8e-1c6f-4d7e-9a3b-${String(opSeq).padStart(12, "0")}`;
}

function wave(w: World, ids: string[], over: Partial<AtomicDispatchIntent> = {}): AtomicDispatchIntent {
  return intent({ operation_id: opId(w.clock.now), members: w.members(ids), ...over });
}

const run = (w: World, action: "execute" | "resolve", i: AtomicDispatchIntent, operator = OPERATOR) =>
  runAtomicDispatch(w.deps, operator, { action, intent: i });

function outcome(http: { body: unknown }): AtomicDispatchOutcome {
  return http.body as AtomicDispatchOutcome;
}

describe("runAtomicDispatch: execute", () => {
  test("a wave writes its cards, stores one message for the target and records a sent result", () => {
    const w = world();
    const i = wave(w, ["card-aaaa-0001", "card-aaaa-0002"]);
    const http = run(w, "execute", i);
    expect(http.status).toBe(200);
    const sent = outcome(http);
    expect(sent.delivery).toBe("sent");
    expect(w.db.query("SELECT status, queue FROM cards WHERE id = 'card-aaaa-0001'").get()).toEqual({ status: "planned", queue: null });
    expect(w.db.query("SELECT status, queue FROM cards WHERE id = 'card-aaaa-0002'").get()).toEqual({ status: "planned", queue: null });
    expect(w.messageCount()).toBe(1);
    const msg = w.db.query("SELECT * FROM messages").get() as { id: number; to_token: string; text: string };
    expect(msg.to_token).toBe("token-lead-1");
    expect(msg.text).toContain("title card-aaaa-0001");
    expect(msg.text).toContain("title card-aaaa-0002");
    expect(sent.delivery === "sent" && sent.message_id).toBe(msg.id);
    expect(sent.delivery === "sent" && sent.cards.map((c) => c.id)).toEqual(["card-aaaa-0001", "card-aaaa-0002"]);
    expect(w.opCount()).toBe(1);
    expect(w.pushes).toHaveLength(1);
    expect(w.pushes[0]!.messageId).toBe(msg.id);
  });

  test("an assignment targets the given peer, moves the card to in_progress and never the lead", () => {
    const w = world();
    const i = wave(w, ["card-aaaa-0003"], { mode: "assign", target_kind: "assignee", to_peer_id: "worker-9" });
    expect(run(w, "execute", i).status).toBe(200);
    expect(w.db.query("SELECT status, queue FROM cards WHERE id = 'card-aaaa-0003'").get()).toEqual({ status: "in_progress", queue: null });
    const msg = w.db.query("SELECT to_token, text FROM messages").get() as { to_token: string; text: string };
    expect(msg.to_token).toBe("token-worker-9");
    expect(msg.text).toContain("assigned THIS roadmap item to you");
  });

  test("an assignment to a peer that is not active refuses instead of falling back to the lead", () => {
    const w = world();
    const i = wave(w, ["card-aaaa-0003"], { mode: "assign", target_kind: "assignee", to_peer_id: "ghost-1" });
    const http = run(w, "execute", i);
    expect(http.status).toBe(409);
    expect(outcome(http)).toMatchObject({ delivery: "not-sent", reason: "no-target" });
    expect(w.messageCount()).toBe(0);
    expect(w.db.query("SELECT queue FROM cards WHERE id = 'card-aaaa-0003'").get()).toEqual({ queue: 2 });
  });

  test("the push leaves only after the commit, observable from a second connection", () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-atomic-"));
    cleanup.push(dir);
    const path = join(dir, "d.db");
    const writer = new Database(path);
    const reader = new Database(path, { readonly: true });
    const seenAtPush: number[] = [];
    const w = world(writer, () => {
      seenAtPush.push((reader.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n);
    });
    expect(run(w, "execute", wave(w, ["card-aaaa-0001", "card-aaaa-0002"])).status).toBe(200);
    expect(seenAtPush).toEqual([1]);
    reader.close();
    writer.close();
  });

  test("a push that throws after the commit keeps the sent result and stores no second message", () => {
    const w = world(new Database(":memory:"), () => {
      throw new Error("ws closed");
    });
    const i = wave(w, ["card-aaaa-0001", "card-aaaa-0002"]);
    expect(outcome(run(w, "execute", i)).delivery).toBe("sent");
    expect(w.messageCount()).toBe(1);
    expect(w.warns.join("\n")).toContain("push after commit failed");
    expect(outcome(run(w, "execute", i)).delivery).toBe("sent");
    expect(w.messageCount()).toBe(1);
  });

  const faults: [string, string][] = [
    [
      "the second card write, after the first was written",
      "CREATE TRIGGER inject AFTER UPDATE ON cards WHEN NEW.id = 'card-aaaa-0002' BEGIN SELECT RAISE(ABORT, 'injected'); END",
    ],
    ["the message insert", "CREATE TRIGGER inject BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'injected'); END"],
    [
      "the sent-result record, after the message was inserted",
      `CREATE TRIGGER inject BEFORE INSERT ON roadmap_dispatch_operations
         WHEN NEW.result_json LIKE '%"delivery":"sent"%' BEGIN SELECT RAISE(ABORT, 'injected'); END`,
    ],
  ];
  test.each(faults)("a fault at %s rolls back cards, message and sent result and records write-failed", (_name, trigger) => {
    const w = world();
    const before = JSON.stringify(w.cardRows());
    w.db.run(trigger);
    const i = wave(w, ["card-aaaa-0001", "card-aaaa-0002"]);
    const http = run(w, "execute", i);
    expect(http.status).toBe(409);
    expect(outcome(http)).toMatchObject({ delivery: "not-sent", reason: "write-failed" });
    expect(JSON.stringify(w.cardRows())).toBe(before);
    expect(w.messageCount()).toBe(0);
    expect(w.pushes).toHaveLength(0);
    expect(w.opCount()).toBe(1);
    expect(w.warns.join("\n")).toContain("rolled back");
    w.db.run("DROP TRIGGER inject");
    expect(outcome(run(w, "execute", i))).toMatchObject({ delivery: "not-sent", reason: "write-failed" });
    expect(w.messageCount()).toBe(0);
  });

  test("a failure that also stops the result from being kept throws and leaves nothing behind", () => {
    const w = world();
    const before = JSON.stringify(w.cardRows());
    w.db.run("CREATE TRIGGER inject BEFORE INSERT ON roadmap_dispatch_operations BEGIN SELECT RAISE(ABORT, 'injected'); END");
    expect(() => run(w, "execute", wave(w, ["card-aaaa-0001", "card-aaaa-0002"]))).toThrow("injected");
    expect(JSON.stringify(w.cardRows())).toBe(before);
    expect(w.messageCount()).toBe(0);
    expect(w.pushes).toHaveLength(0);
    w.db.run("DROP TRIGGER inject");
    expect(w.opCount()).toBe(0);
  });

  test("a second member that fails to write undoes the first member", () => {
    const w = world();
    const before = JSON.stringify(w.cardRows());
    const members = w.members(["card-aaaa-0001", "card-aaaa-0002"]);
    // The CAS inside the write loses on the second card only: the tag and revision pre-check passed.
    const realWrite = w.deps.writeMember;
    w.deps.writeMember = (m, p, rev) => {
      if (m.id === "card-aaaa-0002") return { ok: false, reason: "card-changed" };
      return realWrite(m, p, rev);
    };
    const http = run(w, "execute", intent({ operation_id: opId(w.clock.now), members }));
    expect(outcome(http)).toMatchObject({ delivery: "not-sent", reason: "card-changed", card_ids: ["card-aaaa-0002"] });
    expect(JSON.stringify(w.cardRows())).toBe(before);
    expect(w.messageCount()).toBe(0);
  });

  const refusals: [string, (w: World) => AtomicDispatchIntent, string, string[]][] = [
    ["a stale content revision", (w) => { const i = wave(w, ["card-aaaa-0001", "card-aaaa-0002"]); i.members[1]!.expected_content_rev = 3; return i; }, "card-changed", ["card-aaaa-0002"]],
    ["a stale state tag", (w) => { const i = wave(w, ["card-aaaa-0001", "card-aaaa-0002"]); i.members[0]!.expected_dispatch_state_tag = "f".repeat(64); return i; }, "card-changed", ["card-aaaa-0001"]],
    ["a closed member", (w) => wave(w, ["card-aaaa-0001", "card-aaaa-0004"]), "ineligible", ["card-aaaa-0004"]],
    ["an inactive member", (w) => wave(w, ["card-aaaa-0001", "card-aaaa-0005"]), "ineligible", ["card-aaaa-0005"]],
    ["a directive member", (w) => wave(w, ["card-aaaa-0001", "card-aaaa-0006"]), "ineligible", ["card-aaaa-0006"]],
    ["an unknown member", (w) => { const i = wave(w, ["card-aaaa-0001"]); i.members.push({ id: "card-zzzz-9999", expected_content_rev: 0, expected_dispatch_state_tag: TAG_A }); return i; }, "ineligible", ["card-zzzz-9999"]],
    ["a member of another project", (w) => wave(w, ["card-aaaa-0001", "card-aaaa-0007"]), "ineligible", ["card-aaaa-0007"]],
    ["a head wave that grew a member", (w) => wave(w, ["card-aaaa-0001"]), "queue-changed", ["card-aaaa-0001"]],
    ["a head wave that is another rank", (w) => wave(w, ["card-aaaa-0003"]), "queue-changed", ["card-aaaa-0003"]],
    ["an absent target", (w) => wave(w, ["card-aaaa-0001", "card-aaaa-0002"], { to_peer_id: "ghost-1" }), "no-target", []],
    ["a target in another group", (w) => wave(w, ["card-aaaa-0001", "card-aaaa-0002"], { group_id: "group-two" }), "no-target", []],
  ];
  test.each(refusals)("%s refuses with no card or message effect", (_name, build, reason, ids) => {
    const w = world();
    const before = JSON.stringify(w.cardRows());
    const http = run(w, "execute", build(w));
    expect(http.status).toBe(409);
    expect(outcome(http)).toMatchObject({ delivery: "not-sent", reason, card_ids: ids });
    expect(JSON.stringify(w.cardRows())).toBe(before);
    expect(w.messageCount()).toBe(0);
    expect(w.pushes).toHaveLength(0);
  });

  test("a directive that joined the head wave since the read refuses the wave as queue-changed", () => {
    const w = world();
    const i = wave(w, ["card-aaaa-0001", "card-aaaa-0002"]);
    w.db.run("UPDATE cards SET queue = 1 WHERE id = 'card-aaaa-0006'");
    expect(outcome(run(w, "execute", i))).toMatchObject({ reason: "queue-changed" });
    expect(w.messageCount()).toBe(0);
  });

  test("a member refused only after another passed validation leaves the first untouched", () => {
    const w = world();
    const before = JSON.stringify(w.cardRows());
    const i = wave(w, ["card-aaaa-0001", "card-aaaa-0002"]);
    i.members[1]!.expected_content_rev = 99;
    expect(outcome(run(w, "execute", i))).toMatchObject({ reason: "card-changed" });
    expect(JSON.stringify(w.cardRows())).toBe(before);
  });
});

describe("runAtomicDispatch: replay, resolve and expiry", () => {
  test("replaying the same intent returns the stored result and inserts no second message", () => {
    const w = world();
    const i = wave(w, ["card-aaaa-0001", "card-aaaa-0002"]);
    const first = outcome(run(w, "execute", i));
    const again = run(w, "execute", i);
    expect(again.status).toBe(200);
    expect(outcome(again)).toEqual(first);
    expect(w.messageCount()).toBe(1);
    expect(w.pushes).toHaveLength(1);
    expect(outcome(run(w, "resolve", i))).toEqual(first);
  });

  test("a stored refusal replays as the same refusal even after the cards would now pass", () => {
    const w = world();
    const i = wave(w, ["card-aaaa-0001", "card-aaaa-0002"]);
    i.members[0]!.expected_content_rev = 0;
    expect(outcome(run(w, "execute", i))).toMatchObject({ reason: "card-changed" });
    w.db.run("UPDATE cards SET content_rev = 0 WHERE id = 'card-aaaa-0001'");
    expect(outcome(run(w, "execute", i))).toMatchObject({ reason: "card-changed" });
    expect(w.messageCount()).toBe(0);
  });

  test("the same id with a different intent is a mismatch and acts on nothing", () => {
    const w = world();
    const i = wave(w, ["card-aaaa-0001", "card-aaaa-0002"]);
    run(w, "execute", i);
    const http = run(w, "execute", { ...i, to_peer_id: "worker-9" });
    expect(http).toMatchObject({ status: 409, body: { code: "dispatch-operation-mismatch" } });
    expect(w.messageCount()).toBe(1);
  });

  test("another operator never reads or replays the result of this one", () => {
    const w = world();
    const i = wave(w, ["card-aaaa-0001", "card-aaaa-0002"]);
    run(w, "execute", i);
    const other = run(w, "resolve", i, "operator-b");
    expect(outcome(other)).toMatchObject({ delivery: "not-sent", reason: "cancelled-before-execution" });
    expect(w.db.query("SELECT COUNT(*) AS n FROM roadmap_dispatch_operations WHERE operator_id = 'operator-b'").get()).toEqual({ n: 1 });
    expect(w.messageCount()).toBe(1);
  });

  test("an intent for another broker is refused before any registry write", () => {
    const w = world();
    const i = wave(w, ["card-aaaa-0001", "card-aaaa-0002"], { broker_id: "99999999-aaaa-bbbb-cccc-222222222222" });
    expect(run(w, "execute", i)).toMatchObject({ status: 409, body: { code: "dispatch-broker-mismatch" } });
    expect(run(w, "resolve", i)).toMatchObject({ status: 409, body: { code: "dispatch-broker-mismatch" } });
    expect(w.opCount()).toBe(0);
  });

  test("resolve of an absent operation records a cancellation that a delayed execute then obeys", () => {
    const w = world();
    const i = wave(w, ["card-aaaa-0001", "card-aaaa-0002"]);
    const before = JSON.stringify(w.cardRows());
    const resolved = run(w, "resolve", i);
    expect(resolved.status).toBe(409);
    expect(outcome(resolved)).toMatchObject({ delivery: "not-sent", reason: "cancelled-before-execution" });
    const late = run(w, "execute", i);
    expect(outcome(late)).toMatchObject({ delivery: "not-sent", reason: "cancelled-before-execution" });
    expect(JSON.stringify(w.cardRows())).toBe(before);
    expect(w.messageCount()).toBe(0);
  });

  test("resolve after a committed execute returns the sent result", () => {
    const w = world();
    const i = wave(w, ["card-aaaa-0001", "card-aaaa-0002"]);
    const sent = outcome(run(w, "execute", i));
    expect(outcome(run(w, "resolve", i))).toEqual(sent);
  });

  test("an execute after its deadline has no effect and is refused as expired", () => {
    const w = world();
    const i = wave(w, ["card-aaaa-0001", "card-aaaa-0002"]);
    w.clock.now += 60_001;
    expect(run(w, "execute", i)).toMatchObject({ status: 409, body: { code: "dispatch-operation-expired" } });
    expect(w.messageCount()).toBe(0);
    expect(w.opCount()).toBe(0);
  });

  test("a purged result resolves to unknown expired, never to not-sent", () => {
    const w = world();
    const i = wave(w, ["card-aaaa-0001", "card-aaaa-0002"]);
    run(w, "execute", i);
    w.clock.now += 60_001;
    const http = run(w, "resolve", i);
    expect(http.status).toBe(200);
    expect(http.body).toEqual({ delivery: "unknown", operation_id: i.operation_id, reason: "expired" });
    expect(w.opCount()).toBe(0);
    expect(run(w, "execute", i)).toMatchObject({ body: { code: "dispatch-operation-expired" } });
    expect(w.messageCount()).toBe(1);
  });

  test("a live result is kept until its deadline, an expired one is purged by the next request", () => {
    const w = world();
    const live = wave(w, ["card-aaaa-0001", "card-aaaa-0002"]);
    run(w, "execute", live);
    w.clock.now += 59_999;
    run(w, "resolve", wave(w, ["card-aaaa-0003"]));
    expect(w.opCount()).toBe(2);
    w.clock.now += 2;
    run(w, "resolve", wave(w, ["card-aaaa-0003"]));
    expect(w.db.query("SELECT COUNT(*) AS n FROM roadmap_dispatch_operations WHERE operation_id = ?").get(live.operation_id)).toEqual({ n: 0 });
  });

  test("a deadline beyond the maximum lifetime is refused", () => {
    const w = world();
    const i = wave(w, ["card-aaaa-0001", "card-aaaa-0002"], { operation_id: opId(w.clock.now, ATOMIC_DISPATCH_MAX_OPERATION_MS + 1) });
    expect(run(w, "execute", i)).toMatchObject({ status: 400, body: { code: "dispatch-invalid-request" } });
  });

  test("a full registry of live operations refuses before any effect and evicts nothing", () => {
    const w = world();
    const insert = w.db.prepare(
      "INSERT INTO roadmap_dispatch_operations VALUES (?, ?, 'd', 'p', 'g', 'wave', 'x', '{\"delivery\":\"not-sent\"}', NULL, 0, ?)"
    );
    w.db.transaction(() => {
      for (let n = 0; n < ATOMIC_DISPATCH_REGISTRY_CAPACITY; n++) insert.run("filler", `f${n}`, START + 10 * 60_000);
    })();
    const before = JSON.stringify(w.cardRows());
    const i = wave(w, ["card-aaaa-0001", "card-aaaa-0002"]);
    expect(run(w, "execute", i)).toMatchObject({ status: 503, body: { code: "dispatch-capacity-exceeded" } });
    expect(run(w, "resolve", i).body).toMatchObject({ delivery: "unknown", reason: "outcome-unavailable" });
    expect(JSON.stringify(w.cardRows())).toBe(before);
    expect(w.opCount()).toBe(ATOMIC_DISPATCH_REGISTRY_CAPACITY);
  });

  test("an unreadable stored result resolves to unknown outcome-unavailable and says so", () => {
    const w = world();
    const i = wave(w, ["card-aaaa-0001", "card-aaaa-0002"]);
    run(w, "execute", i);
    w.db.run("UPDATE roadmap_dispatch_operations SET result_json = 'not json'");
    expect(run(w, "resolve", i).body).toMatchObject({ delivery: "unknown", reason: "outcome-unavailable" });
    expect(w.warns.join("\n")).toContain("not JSON");
  });

  test("an unknown action is an invalid request", () => {
    const w = world();
    expect(runAtomicDispatch(w.deps, OPERATOR, { action: "prepare", intent: wave(w, ["card-aaaa-0001"]) })).toMatchObject({
      status: 400,
      body: { code: "dispatch-invalid-request" },
    });
  });
});

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});
