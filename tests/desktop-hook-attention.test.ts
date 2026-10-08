import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPendingApprovalsTick, hookAwaitedTiles, type PendingApprovalsIo } from "../desktop/src/main/hook-attention.ts";
import type { Approval } from "../shared/types.ts";

function approval(overrides: { status: Approval["status"]; reply_route: Approval["reply_route"]; tile_ref: string }): Approval {
  return {
    id: `ap-${overrides.tile_ref}-${overrides.status}-${overrides.reply_route}`,
    operator_id: "op",
    origin: { host: "h", os_user_hash: "", project_key: "p", group_id: "", from_peer: "", session_ref: "window", tile_ref: overrides.tile_ref },
    kind: "permission",
    title: "t",
    question: "q",
    options: [],
    status: overrides.status,
    reply_route: overrides.reply_route,
    mergeable: false,
    absorbed_permission: false,
    answered_via: null,
    answer_kind: null,
    answer_text: null,
    created_at: "2026-10-06T00:00:00.000Z",
    notif_expires_at: "2026-10-07T00:00:00.000Z",
    answered_at: null,
    delivered_at: null,
    questions: null,
    answers: null,
  };
}

test("a hook row the module still waits on lights its tile, expired notification included", () => {
  const tiles = hookAwaitedTiles([
    approval({ status: "pending", reply_route: "hook", tile_ref: "tile-a" }),
    approval({ status: "expired_notif", reply_route: "hook", tile_ref: "tile-b" }),
  ]);
  expect([...tiles].sort()).toEqual(["tile-a", "tile-b"]);
});

test("rows answered on screen or elsewhere, or not waited on by the module, light nothing", () => {
  const tiles = hookAwaitedTiles([
    approval({ status: "pending", reply_route: "pty", tile_ref: "tile-pty" }),
    approval({ status: "pending", reply_route: "channel", tile_ref: "tile-channel" }),
    approval({ status: "answered", reply_route: "hook", tile_ref: "tile-answered" }),
    approval({ status: "answered_terminal", reply_route: "hook", tile_ref: "tile-withdrawn" }),
    approval({ status: "pending", reply_route: "hook", tile_ref: "" }),
  ]);
  expect([...tiles]).toEqual([]);
});

function tickProbe(options: { deps?: string | null; fetch?: () => Promise<Approval[]> } = {}) {
  const awaited: string[][] = [];
  const reports: string[] = [];
  const broadcasts: Approval[][] = [];
  const io: PendingApprovalsIo<string> = {
    deps: () => (options.deps === undefined ? "deps" : options.deps),
    fetchPending: options.fetch ?? (async () => []),
    setHookAwaited: (tiles) => void awaited.push([...tiles]),
    broadcastPending: (list) => void broadcasts.push(list),
    report: (text) => void reports.push(text),
  };
  return { tick: createPendingApprovalsTick(io), io, awaited, reports, broadcasts };
}

test("a tick hands the tiles of open hook rows to the session service, every tick", async () => {
  const list = [approval({ status: "pending", reply_route: "hook", tile_ref: "tile-a" })];
  const probe = tickProbe({ fetch: async () => list });

  await probe.tick();
  await probe.tick();

  expect(probe.awaited).toEqual([["tile-a"], ["tile-a"]]);
  expect(probe.broadcasts, "the renderer list is re-sent only when it changes").toEqual([list]);
  expect(probe.reports).toEqual([]);
});

test("an unreachable broker drops the hook source and is reported once per outage", async () => {
  let down = true;
  const probe = tickProbe({
    fetch: async () => {
      if (down) throw new Error("ECONNREFUSED");
      return [];
    },
  });

  await probe.tick();
  await probe.tick();
  expect(probe.awaited, "no module is reachable, so no tile stays frozen in 'needs you'").toEqual([[], []]);
  expect(probe.reports).toHaveLength(1);

  down = false;
  await probe.tick();
  down = true;
  await probe.tick();
  expect(probe.reports, "a new outage after a good tick is reported again").toHaveLength(2);
});

test("disarmed approvals drop the hook source without a report: no module can raise a hook row then", async () => {
  const probe = tickProbe({ deps: null });

  await probe.tick();
  await probe.tick();

  expect(probe.awaited).toEqual([[], []]);
  expect(probe.reports).toEqual([]);
});

test("a list that cannot be read is announced as unavailable, and the same list is broadcast again once readable", async () => {
  const list = [approval({ status: "pending", reply_route: "channel", tile_ref: "" })];
  let down = false;
  const unavailable: number[] = [];
  const probe = tickProbe({
    fetch: async () => {
      if (down) throw new Error("ECONNREFUSED");
      return list;
    },
  });
  probe.io.pendingUnavailable = () => void unavailable.push(probe.broadcasts.length);

  await probe.tick();
  down = true;
  await probe.tick();
  down = false;
  await probe.tick();

  expect(unavailable, "the failed tick drops the held list").toEqual([1]);
  expect(probe.broadcasts, "the unchanged list reaches the consumer that dropped it").toEqual([list, list]);
});

test("disarmed approvals announce the list as unavailable on every tick", async () => {
  let count = 0;
  const probe = tickProbe({ deps: null });
  probe.io.pendingUnavailable = () => void (count += 1);

  await probe.tick();
  await probe.tick();

  expect(count).toBe(2);
  expect(probe.broadcasts).toEqual([]);
});

test("the Deck's poll timer runs the tested tick and notifies on the service's needs-you event", () => {
  const index = readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "index.ts"), "utf8");
  expect(index).toMatch(/const pollPendingApprovals = createPendingApprovalsTick\(/);
  expect(index).toMatch(/service\.on\('needs-you', \(\{ id \}: \{ id: string \}\) => notifyWaitingSession\(id\)\)/);
});

test("the Avatar client reads the poll's last list and the Courrier's pending messages", () => {
  const index = readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "index.ts"), "utf8");
  const tick = index.slice(index.indexOf("const pollPendingApprovals = createPendingApprovalsTick("));
  const tickBody = tick.slice(0, tick.indexOf("\n})"));
  expect(tickBody, "the list kept for the Avatar is the one broadcast").toMatch(/broadcastPending: \(list\) => \{\s*lastPendingApprovals = list/);
  expect(tickBody, "an unreadable poll empties the list kept for the Avatar").toMatch(/pendingUnavailable: \(\) => \{\s*lastPendingApprovals = \[\]/);
  const client = index.slice(index.indexOf("const avatarClient = createAvatarClient("));
  const clientBody = client.slice(0, client.indexOf("\n})"));
  expect(clientBody).toMatch(/pendingApprovals: \(\) => lastPendingApprovals/);
  expect(clientBody).toMatch(/inboxUnread: pendingInboxCounter\(sessionDir, \(\) => pendingInboxWrites\)/);
});
