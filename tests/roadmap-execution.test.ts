import { describe, expect, test } from "bun:test";
import {
  formatLotExecutionRefusal,
  judgeLotExecution,
  lotExecutionInterruption,
  lotExecutionRefusalStatus,
  type LotExecution,
  type LotExecutionRequest,
  type LotExecutionSubject,
  type LotInstanceSubject,
} from "../shared/roadmap-execution.ts";

const PROJECT = "github.com/vocsap/execution-repo";

const EXECUTION: LotExecution = {
  project_key: PROJECT,
  lot_id: "lot-1",
  epoch: 1,
  state: "running",
  operator_id: "operator-a",
  group_id: "group-a",
  run_ref: "run-a",
  controller_ref: "instance-lead",
  controller_peer_id: "lead-peer",
  started_at: "2026-01-01T00:00:00.000Z",
  interrupted_at: null,
  interrupted_reason: null,
};

const CONTROLLER: LotInstanceSubject = {
  kind: "instance",
  operator_id: "operator-a",
  group_id: "group-a",
  run_ref: "run-a",
  project_key: PROJECT,
  instance_ref: "instance-lead",
};

const OPERATOR: LotExecutionSubject = { kind: "operator", operator_id: "operator-a", window: null };
const HOLDING_WINDOW: LotExecutionSubject = {
  kind: "operator",
  operator_id: "operator-a",
  window: { run_ref: "run-a", group_id: "group-a" },
};

function judge(overrides: Partial<LotExecutionRequest>) {
  return judgeLotExecution({
    project_key: PROJECT,
    execution: EXECUTION,
    subject: CONTROLLER,
    act: { kind: "claim" },
    participants: new Set(),
    replica: false,
    ...overrides,
  });
}

const code = (overrides: Partial<LotExecutionRequest>) => {
  const verdict = judge(overrides);
  return verdict.ok ? verdict.effect : verdict.code;
};

describe("an agent against a running execution", () => {
  test("the controller claims and changes", () => {
    expect(code({})).toBe("continue");
    expect(code({ act: { kind: "change" } })).toBe("continue");
  });

  // One dimension at a time: a holder compared on fewer of them lets exactly one of these through.
  for (const [field, value] of [
    ["operator_id", "operator-b"],
    ["group_id", "group-b"],
    ["run_ref", "run-b"],
    ["project_key", "github.com/vocsap/other-repo"],
    ["instance_ref", "instance-second-lead"],
  ] as const) {
    test(`an instance differing only by ${field} is refused`, () => {
      const subject = { ...CONTROLLER, [field]: value };
      expect(code({ subject })).toBe("lot_execution_held");
      expect(code({ subject, act: { kind: "change" } })).toBe("lot_execution_held");
    });
  }

  test("a worker acts once the controller granted it, and not before", () => {
    const worker = { ...CONTROLLER, instance_ref: "instance-worker" };
    expect(code({ subject: worker })).toBe("lot_execution_held");
    expect(code({ subject: worker, participants: new Set(["instance-worker"]) })).toBe("continue");
  });

  test("a grant does not carry a worker across runs", () => {
    const stranger = { ...CONTROLLER, instance_ref: "instance-worker", run_ref: "run-b" };
    expect(code({ subject: stranger, participants: new Set(["instance-worker"]) })).toBe("lot_execution_held");
  });

  test("a writer proving nothing is refused", () => {
    expect(code({ subject: { kind: "unproven" } })).toBe("lot_execution_unproven");
    expect(code({ subject: { kind: "unproven" }, act: { kind: "change" } })).toBe("lot_execution_unproven");
  });
});

describe("the operator against a running execution", () => {
  test("changes from any window, claims only from the holding one", () => {
    expect(code({ subject: OPERATOR, act: { kind: "change" } })).toBe("continue");
    expect(code({ subject: OPERATOR })).toBe("lot_execution_held");
    expect(code({ subject: HOLDING_WINDOW })).toBe("continue");
  });

  for (const window of [
    { run_ref: "run-b", group_id: "group-a" },
    { run_ref: "run-a", group_id: "group-b" },
  ]) {
    test(`a claim naming ${window.run_ref} in ${window.group_id} is refused`, () => {
      expect(code({ subject: { kind: "operator", operator_id: "operator-a", window } })).toBe("lot_execution_held");
    });
  }

  test("another operator is refused every act, whatever window it names", () => {
    const other: LotExecutionSubject = {
      kind: "operator",
      operator_id: "operator-b",
      window: { run_ref: "run-a", group_id: "group-a" },
    };
    expect(code({ subject: other })).toBe("lot_execution_held");
    expect(code({ subject: other, act: { kind: "change" } })).toBe("lot_execution_held");
  });
});

describe("an interrupted execution", () => {
  const interrupted: LotExecution = { ...EXECUTION, state: "interrupted" };

  test("takes no claim from its former holder or from the holding window", () => {
    expect(code({ execution: interrupted })).toBe("lot_execution_interrupted");
    expect(code({ execution: interrupted, subject: HOLDING_WINDOW })).toBe("lot_execution_interrupted");
  });

  test("still lets its holder and its operator close or release cards", () => {
    expect(code({ execution: interrupted, act: { kind: "change" } })).toBe("continue");
    expect(code({ execution: interrupted, subject: OPERATOR, act: { kind: "change" } })).toBe("continue");
  });

  test("stays closed to anyone else", () => {
    const stranger = { ...CONTROLLER, instance_ref: "instance-second-lead" };
    expect(code({ execution: interrupted, subject: stranger })).toBe("lot_execution_held");
  });
});

describe("a lot with no execution", () => {
  for (const execution of [null, { ...EXECUTION, state: "closed" as const }]) {
    test(`${execution === null ? "prepared" : "closed"}: no write claims, any write changes`, () => {
      for (const subject of [CONTROLLER, HOLDING_WINDOW, { kind: "unproven" } as const]) {
        expect(code({ execution, subject })).toBe("lot_execution_not_started");
        expect(code({ execution, subject, act: { kind: "change" } })).toBe("pass");
      }
    });
  }

  const start = { kind: "start" as const, controller: CONTROLLER };

  test("an operator write starts it and names a controller of its own", () => {
    expect(code({ execution: null, subject: OPERATOR, act: start })).toBe("start");
  });

  test("no agent starts it, the intended controller included", () => {
    expect(code({ execution: null, subject: CONTROLLER, act: start })).toBe("lot_execution_unproven");
  });

  test("an operator cannot name another operator's instance or another project's", () => {
    for (const controller of [
      { ...CONTROLLER, operator_id: "operator-b" },
      { ...CONTROLLER, project_key: "github.com/vocsap/other-repo" },
    ]) {
      expect(code({ execution: null, subject: OPERATOR, act: { kind: "start", controller } })).toBe(
        "lot_execution_unproven"
      );
    }
  });

  test("a held or interrupted lot is not started over", () => {
    expect(code({ subject: OPERATOR, act: start })).toBe("lot_execution_held");
    expect(code({ execution: { ...EXECUTION, state: "interrupted" }, subject: OPERATOR, act: start })).toBe(
      "lot_execution_interrupted"
    );
  });
});

test("a replica neither starts, claims nor grants, and still changes and restructures", () => {
  expect(code({ replica: true })).toBe("lot_execution_replica");
  expect(code({ replica: true, execution: null, subject: OPERATOR, act: { kind: "start", controller: CONTROLLER } })).toBe(
    "lot_execution_replica"
  );
  expect(code({ replica: true, act: { kind: "grant", grantee: CONTROLLER } })).toBe("lot_execution_replica");
  expect(code({ replica: true, execution: null, act: { kind: "change" } })).toBe("pass");
  expect(code({ replica: true, execution: null, act: { kind: "restructure" } })).toBe("pass");
});

describe("restructuring a lot", () => {
  test("is free while nobody processes it", () => {
    for (const execution of [null, { ...EXECUTION, state: "closed" as const }]) {
      expect(code({ execution, subject: { kind: "unproven" }, act: { kind: "restructure" } })).toBe("pass");
    }
  });

  test("is refused to everyone under execution, its controller and operator included", () => {
    for (const subject of [CONTROLLER, HOLDING_WINDOW, { kind: "unproven" } as const]) {
      expect(code({ subject, act: { kind: "restructure" } })).toBe("lot_execution_held");
      expect(code({ execution: { ...EXECUTION, state: "interrupted" }, subject, act: { kind: "restructure" } })).toBe(
        "lot_execution_interrupted"
      );
    }
  });
});

describe("granting a worker", () => {
  const worker: LotInstanceSubject = { ...CONTROLLER, instance_ref: "instance-worker" };
  const grant = { kind: "grant" as const, grantee: worker };

  test("the controller grants a session of its own run", () => {
    expect(code({ act: grant })).toBe("continue");
  });

  test("nobody else grants: another session, a granted worker, the operator, a bare writer", () => {
    expect(code({ subject: worker, act: grant })).toBe("lot_execution_held");
    expect(code({ subject: worker, participants: new Set(["instance-worker"]), act: grant })).toBe("lot_execution_held");
    expect(code({ subject: HOLDING_WINDOW, act: grant })).toBe("lot_execution_held");
    expect(code({ subject: { kind: "unproven" }, act: grant })).toBe("lot_execution_unproven");
  });

  test("a controller seen from another run grants nothing", () => {
    expect(code({ subject: { ...CONTROLLER, run_ref: "run-b" }, act: grant })).toBe("lot_execution_held");
  });

  for (const [field, value] of [
    ["operator_id", "operator-b"],
    ["group_id", "group-b"],
    ["run_ref", "run-b"],
    ["project_key", "github.com/vocsap/other-repo"],
  ] as const) {
    test(`a grantee differing by ${field} is refused`, () => {
      expect(code({ act: { kind: "grant", grantee: { ...worker, [field]: value } } })).toBe("lot_execution_grantee");
    });
  }

  test("an unprovable grantee, a lot nobody processes and an interrupted lot take no grant", () => {
    expect(code({ act: { kind: "grant", grantee: null } })).toBe("lot_execution_grantee");
    expect(code({ execution: null, act: grant })).toBe("lot_execution_not_started");
    expect(code({ execution: { ...EXECUTION, state: "interrupted" }, act: grant })).toBe("lot_execution_interrupted");
    expect(lotExecutionRefusalStatus("lot_execution_grantee")).toBe(403);
  });
});

describe("interruption", () => {
  const NOW = 1_000_000;
  const TTL = 600_000;
  const why = (controller: { active: boolean; lastSeenMs: number } | null, runCredentialLive = true) =>
    lotExecutionInterruption({ runCredentialLive, controller }, NOW, TTL);

  test("a present controller keeps the lot running", () => {
    expect(why({ active: true, lastSeenMs: 0 })).toBeNull();
    expect(why({ active: false, lastSeenMs: NOW - TTL + 1 })).toBeNull();
  });

  test("silence reaching the delay interrupts it", () => {
    expect(why({ active: false, lastSeenMs: NOW - TTL })).toBe("controller-silent");
    expect(why({ active: false, lastSeenMs: Number.NaN })).toBe("controller-silent");
  });

  test("a vanished controller or a dead run credential interrupts it at once", () => {
    expect(why(null)).toBe("controller-gone");
    expect(why({ active: true, lastSeenMs: NOW }, false)).toBe("run-ended");
  });
});

test("a refusal names the lot and the controlling peer, and no run or instance digest", () => {
  const held = formatLotExecutionRefusal("lot_execution_held", "release train", EXECUTION.controller_peer_id);
  expect(held.startsWith("lot_execution_held: Workflow en cours, pas touche")).toBe(true);
  expect(held).toContain("release train");
  expect(held).toContain("lead-peer");
  expect(lotExecutionRefusalStatus("lot_execution_held")).toBe(409);
  expect(lotExecutionRefusalStatus("lot_execution_unproven")).toBe(403);
  expect(lotExecutionRefusalStatus("lot_execution_replica")).toBe(403);
});
