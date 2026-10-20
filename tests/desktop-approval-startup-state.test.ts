import { expect, test } from "bun:test";
import { createStartupState, shouldQuitAfterAllWindowsClosed } from "../desktop/src/main/approval-startup-state.ts";

test("a run starts in bootstrap and moves to running once launched", () => {
  const state = createStartupState();
  expect(state.phase()).toBe("bootstrap");
  expect(state.isQuitting()).toBe(false);
  state.markRunning();
  expect(state.phase()).toBe("running");
});

test("a quit intent during bootstrap is final: a later launch step cannot bring the run back", () => {
  const state = createStartupState();
  state.markQuitting();
  state.markRunning();
  expect(state.phase(), "a startup answer arriving after quit must not resume the launch").toBe("quitting");
  expect(state.isQuitting()).toBe(true);
});

test("a running app that starts quitting stays quitting", () => {
  const state = createStartupState();
  state.markRunning();
  state.markQuitting();
  state.markRunning();
  expect(state.isQuitting()).toBe(true);
});

test("window-all-closed quits only a running non-darwin app", () => {
  expect(shouldQuitAfterAllWindowsClosed("win32", "bootstrap")).toBe(false);
  expect(shouldQuitAfterAllWindowsClosed("win32", "quitting")).toBe(false);
  expect(shouldQuitAfterAllWindowsClosed("win32", "running")).toBe(true);
  expect(shouldQuitAfterAllWindowsClosed("darwin", "running")).toBe(false);
});
