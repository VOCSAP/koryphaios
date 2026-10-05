import { expect, test } from "bun:test";
import type { CreateSessionInput, SessionRuntime } from "../desktop/src/shared/types";
import { createSessionWithWorktree } from "../desktop/src/main/create-session";
import type { SessionService } from "../desktop/src/main/session-service";

test("createSessionWithWorktree forwards the trusted embedded role option", async () => {
  let receivedOpts: { teamLeadDeckBridge?: boolean; hasDeckLeadTools?: boolean } | undefined;
  const service = {
    create(_input: CreateSessionInput, opts?: { teamLeadDeckBridge?: boolean; hasDeckLeadTools?: boolean }) {
      receivedOpts = opts;
      return {} as SessionRuntime;
    }
  } as unknown as SessionService;

  await createSessionWithWorktree(
    service,
    "/project",
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    { hasDeckLeadTools: true }
  );

  expect(receivedOpts).toEqual({ hasDeckLeadTools: true });
});
