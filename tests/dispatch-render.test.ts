import { test, expect } from "bun:test";
import * as server from "../server.ts";
import type { DispatchRequest } from "../shared/types.ts";

const renderDispatchOutcome = (server as unknown as {
  renderDispatchOutcome?: (request: DispatchRequest) => string;
}).renderDispatchOutcome;

function request(outcome: DispatchRequest["outcome"]): DispatchRequest {
  return {
    id: "request-1",
    project_key: "project",
    from_peer: "lead",
    status: "done",
    created_at: "2026-09-30T00:00:00.000Z",
    resolved_at: "2026-09-30T00:00:01.000Z",
    outcome,
  };
}

test("dispatch rendering keeps refused and pending targets outside the hit line", () => {
  expect(renderDispatchOutcome).toBeFunction();
  if (!renderDispatchOutcome) throw new Error("renderDispatchOutcome is required");

  const text = renderDispatchOutcome(request({
    cards: [{
      id: "card-1",
      title: "Clear the team",
      kind: "directive",
      matched: ["written"],
      missing: [],
      ambiguous: [],
      refused: [{ peerId: "modal", reason: "refused-modal" }],
      pending: ["slow"],
    }],
    note: "1 card dispatched",
  }));

  expect(text.split("\n").find((line) => line.trim().startsWith("hit:"))).toBe("    hit: written");
  expect(text).toContain("refused: modal (refused-modal)");
  expect(text).toContain("pending: slow");
});

test("dispatch rendering treats omitted supplemental outcomes as empty", () => {
  expect(renderDispatchOutcome).toBeFunction();
  if (!renderDispatchOutcome) throw new Error("renderDispatchOutcome is required");

  const text = renderDispatchOutcome(request({
    cards: [{
      id: "card-1",
      title: "Clear the team",
      kind: "directive",
      matched: [],
      missing: [],
      ambiguous: [],
    }],
    note: "1 card dispatched",
  }));

  expect(text).toContain("hit: (none)");
  expect(text).not.toContain("refused:");
  expect(text).not.toContain("pending:");
});
