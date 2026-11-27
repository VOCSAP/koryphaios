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

  test("tells every proven writer who holds nothing that it must be resumed", () => {
    for (const subject of [
      { ...CONTROLLER, instance_ref: "instance-second-lead" },
      { kind: "operator", operator_id: "operator-b", window: null },
    ] as const) {
      for (const act of [{ kind: "claim" }, { kind: "change" }, { kind: "grant", grantee: CONTROLLER }] as const) {
        expect([subject.kind, act.kind, code({ execution: interrupted, subject, act })]).toEqual([
          subject.kind,
          act.kind,
          "lot_execution_interrupted",
        ]);
      }
    }
    expect(code({ execution: interrupted, subject: OPERATOR })).toBe("lot_execution_interrupted");
  });

  test("tells a writer proving nothing only that, whatever it attempts", () => {
    for (const act of [
      { kind: "claim" },
      { kind: "change" },
      { kind: "grant", grantee: CONTROLLER },
      { kind: "start", controller: CONTROLLER, after: 0, lastClosed: 0 },
      { kind: "dispatch", target: CONTROLLER, epoch: 1 },
      { kind: "resume", controller: CONTROLLER, epoch: 1 },
      { kind: "close", epoch: 1 },
    ] as const) {
      expect([act.kind, code({ execution: interrupted, subject: { kind: "unproven" }, act })]).toEqual([
        act.kind,
        "lot_execution_unproven",
      ]);
    }
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

  const start = { kind: "start" as const, controller: CONTROLLER, after: 0, lastClosed: 0 };

  test("a start signed before a later close of the lot is refused", () => {
    for (const [after, lastClosed] of [[0, 1], [1, 2], [2, 1]] as const) {
      expect(code({ execution: null, subject: HOLDING_WINDOW, act: { ...start, after, lastClosed } })).toBe(
        "lot_execution_stale"
      );
    }
    expect(code({ execution: null, subject: HOLDING_WINDOW, act: { ...start, after: 2, lastClosed: 2 } })).toBe("start");
  });

  test("an operator write signing the controller's run starts it", () => {
    expect(code({ execution: null, subject: HOLDING_WINDOW, act: start })).toBe("start");
  });

  test("no agent starts it, the intended controller included", () => {
    expect(code({ execution: null, subject: CONTROLLER, act: start })).toBe("lot_execution_unproven");
  });

  // One dimension at a time, as for a holder.
  for (const [field, value] of [
    ["operator_id", "operator-b"],
    ["project_key", "github.com/vocsap/other-repo"],
    ["run_ref", "run-b"],
    ["group_id", "group-b"],
  ] as const) {
    test(`a controller whose binding differs by ${field} from the signed start is refused`, () => {
      const act = { ...start, controller: { ...CONTROLLER, [field]: value } };
      expect(code({ execution: null, subject: HOLDING_WINDOW, act })).toBe("lot_execution_controller");
    });
  }

  test("an unprovable controller or a signature naming no run starts nothing", () => {
    expect(code({ execution: null, subject: HOLDING_WINDOW, act: { ...start, controller: null } })).toBe(
      "lot_execution_controller"
    );
    expect(code({ execution: null, subject: OPERATOR, act: start })).toBe("lot_execution_controller");
  });

  test("a held or interrupted lot is not started over", () => {
    expect(code({ subject: HOLDING_WINDOW, act: start })).toBe("lot_execution_held");
    expect(code({ execution: { ...EXECUTION, state: "interrupted" }, subject: HOLDING_WINDOW, act: start })).toBe(
      "lot_execution_interrupted"
    );
  });

  test("takes no further dispatch and nothing to resume", () => {
    for (const execution of [null, { ...EXECUTION, state: "closed" as const }]) {
      for (const act of [
        { kind: "dispatch" as const, target: CONTROLLER, epoch: 1 },
        { kind: "resume" as const, controller: CONTROLLER, epoch: 1 },
        { kind: "close" as const, epoch: 1 },
      ]) {
        expect(code({ execution, subject: HOLDING_WINDOW, act })).toBe("lot_execution_not_started");
      }
    }
  });
});

describe("dispatching again on an execution", () => {
  const open: LotExecution = { ...EXECUTION, epoch: 2 };
  const dispatch = { kind: "dispatch" as const, target: CONTROLLER, epoch: 2 };

  test("the holding window sends to the controller under the open epoch", () => {
    expect(code({ execution: open, subject: HOLDING_WINDOW, act: dispatch })).toBe("continue");
  });

  test("an epoch that is not the open one is refused", () => {
    for (const epoch of [1, 3]) {
      expect(code({ execution: open, subject: HOLDING_WINDOW, act: { ...dispatch, epoch } })).toBe("lot_execution_stale");
    }
    expect(lotExecutionRefusalStatus("lot_execution_stale")).toBe(409);
  });

  for (const [field, value] of [
    ["operator_id", "operator-b"],
    ["group_id", "group-b"],
    ["run_ref", "run-b"],
    ["project_key", "github.com/vocsap/other-repo"],
    ["instance_ref", "instance-second-lead"],
  ] as const) {
    test(`a target differing from the controller by ${field} is refused`, () => {
      const target = { ...CONTROLLER, [field]: value };
      expect(code({ execution: open, subject: HOLDING_WINDOW, act: { ...dispatch, target } })).toBe("lot_execution_held");
    });
  }

  test("an unprovable target is refused, a granted worker included", () => {
    const worker = { ...CONTROLLER, instance_ref: "instance-worker" };
    expect(code({ execution: open, subject: HOLDING_WINDOW, act: { ...dispatch, target: null } })).toBe(
      "lot_execution_held"
    );
    expect(
      code({
        execution: open,
        subject: HOLDING_WINDOW,
        participants: new Set(["instance-worker"]),
        act: { ...dispatch, target: worker },
      })
    ).toBe("lot_execution_held");
  });

  test("only the operator's holding window dispatches", () => {
    for (const subject of [
      OPERATOR,
      { kind: "operator", operator_id: "operator-b", window: { run_ref: "run-a", group_id: "group-a" } },
      { kind: "operator", operator_id: "operator-a", window: { run_ref: "run-b", group_id: "group-a" } },
      { kind: "operator", operator_id: "operator-a", window: { run_ref: "run-a", group_id: "group-b" } },
    ] as const) {
      expect(code({ execution: open, subject, act: dispatch })).toBe("lot_execution_held");
    }
    expect(code({ execution: open, subject: CONTROLLER, act: dispatch })).toBe("lot_execution_unproven");
  });

  test("an interrupted execution sends nothing, whatever epoch is named", () => {
    const execution: LotExecution = { ...open, state: "interrupted" };
    for (const epoch of [1, 2]) {
      expect(code({ execution, subject: HOLDING_WINDOW, act: { ...dispatch, epoch } })).toBe("lot_execution_interrupted");
    }
  });
});

describe("resuming an interrupted execution", () => {
  const interrupted: LotExecution = { ...EXECUTION, epoch: 2, state: "interrupted" };
  const nextRun: LotExecutionSubject = {
    kind: "operator",
    operator_id: "operator-a",
    window: { run_ref: "run-next", group_id: "group-next" },
  };
  const nextController: LotInstanceSubject = {
    ...CONTROLLER,
    run_ref: "run-next",
    group_id: "group-next",
    instance_ref: "instance-next-lead",
  };
  const resume = { kind: "resume" as const, controller: nextController, epoch: 2 };

  test("the same operator hands it to a controller of the run it signs", () => {
    expect(code({ execution: interrupted, subject: nextRun, act: resume })).toBe("resume");
  });

  test("a running execution is not resumed", () => {
    const execution: LotExecution = { ...interrupted, state: "running" };
    expect(code({ execution, subject: nextRun, act: resume })).toBe("lot_execution_held");
  });

  test("a resume naming another epoch is refused", () => {
    for (const epoch of [1, 3]) {
      expect(code({ execution: interrupted, subject: nextRun, act: { ...resume, epoch } })).toBe("lot_execution_stale");
    }
  });

  test("another operator and an agent resume nothing", () => {
    const other: LotExecutionSubject = { ...nextRun, kind: "operator", operator_id: "operator-b", window: nextRun.window };
    const act = { ...resume, controller: { ...nextController, operator_id: "operator-b" } };
    expect(code({ execution: interrupted, subject: other, act })).toBe("lot_execution_interrupted");
    expect(code({ execution: interrupted, subject: nextController, act: resume })).toBe("lot_execution_interrupted");
  });

  for (const [field, value] of [
    ["operator_id", "operator-b"],
    ["project_key", "github.com/vocsap/other-repo"],
    ["run_ref", "run-a"],
    ["group_id", "group-a"],
  ] as const) {
    test(`a new controller whose binding differs by ${field} from the signed resume is refused`, () => {
      const act = { ...resume, controller: { ...nextController, [field]: value } };
      expect(code({ execution: interrupted, subject: nextRun, act })).toBe("lot_execution_controller");
    });
  }

  test("an unprovable controller or a signature naming no run resumes nothing", () => {
    expect(code({ execution: interrupted, subject: nextRun, act: { ...resume, controller: null } })).toBe(
      "lot_execution_controller"
    );
    expect(code({ execution: interrupted, subject: OPERATOR, act: resume })).toBe("lot_execution_controller");
    expect(lotExecutionRefusalStatus("lot_execution_controller")).toBe(403);
  });
});

test("a replica neither starts, claims nor grants, and still changes and restructures", () => {
  expect(code({ replica: true })).toBe("lot_execution_replica");
  expect(
    code({
      replica: true,
      execution: null,
      subject: OPERATOR,
      act: { kind: "start", controller: CONTROLLER, after: 0, lastClosed: 0 },
    })
  ).toBe("lot_execution_replica");
  expect(code({ replica: true, act: { kind: "grant", grantee: CONTROLLER } })).toBe("lot_execution_replica");
  expect(code({ replica: true, subject: HOLDING_WINDOW, act: { kind: "dispatch", target: CONTROLLER, epoch: 1 } })).toBe(
    "lot_execution_replica"
  );
  expect(code({ replica: true, subject: HOLDING_WINDOW, act: { kind: "resume", controller: CONTROLLER, epoch: 1 } })).toBe(
    "lot_execution_replica"
  );
  expect(code({ replica: true, subject: OPERATOR, act: { kind: "close", epoch: 1 } })).toBe("lot_execution_replica");
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

describe("closing an execution", () => {
  const close = { kind: "close" as const, epoch: 2 };

  for (const state of ["running", "interrupted"] as const) {
    test(`the holding operator closes a ${state} one from any window, under its epoch`, () => {
      const execution: LotExecution = { ...EXECUTION, epoch: 2, state };
      expect(code({ execution, subject: OPERATOR, act: close })).toBe("close");
      expect(code({ execution, subject: HOLDING_WINDOW, act: close })).toBe("close");
      for (const epoch of [1, 3]) {
        expect(code({ execution, subject: OPERATOR, act: { ...close, epoch } })).toBe("lot_execution_stale");
      }
    });

    test(`nobody else closes a ${state} one`, () => {
      const execution: LotExecution = { ...EXECUTION, epoch: 2, state };
      const refused = state === "running" ? "lot_execution_held" : "lot_execution_interrupted";
      const other: LotExecutionSubject = { kind: "operator", operator_id: "operator-b", window: null };
      expect(code({ execution, subject: other, act: close })).toBe(refused);
      expect(code({ execution, subject: CONTROLLER, act: close })).toBe(
        state === "running" ? "lot_execution_unproven" : "lot_execution_interrupted"
      );
    });

    test(`settling a send of a ${state} one is the holding operator's gesture, under its epoch`, () => {
      const execution: LotExecution = { ...EXECUTION, epoch: 2, state };
      const settle = { kind: "settle" as const, epoch: 2 };
      const other: LotExecutionSubject = { kind: "operator", operator_id: "operator-b", window: null };
      expect(code({ execution, subject: OPERATOR, act: settle })).toBe("continue");
      expect(code({ execution, subject: OPERATOR, act: { ...settle, epoch: 1 } })).toBe("lot_execution_stale");
      expect(code({ execution, subject: other, act: settle })).toBe(
        state === "running" ? "lot_execution_held" : "lot_execution_interrupted"
      );
      expect(code({ execution, subject: CONTROLLER, act: settle })).toBe(
        state === "running" ? "lot_execution_unproven" : "lot_execution_interrupted"
      );
      expect(code({ execution: null, subject: OPERATOR, act: settle })).toBe("lot_execution_not_started");
      expect(code({ execution, subject: OPERATOR, act: settle, replica: true })).toBe("lot_execution_replica");
    });
  }
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

test("a refusal raised before any execution exists names no controller", () => {
  const refused = formatLotExecutionRefusal("lot_execution_controller", "release train", null);
  expect(refused.startsWith("lot_execution_controller:")).toBe(true);
  expect(refused).not.toContain("null");
});
