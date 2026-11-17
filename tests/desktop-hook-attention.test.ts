import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPendingApprovalsTick, hookAwaitedTiles, type PendingApprovalsIo } from "../desktop/src/main/hook-attention.ts";
import { extractBracedBody, extractParenBody } from "./_braced-body.ts";
import { stripComments } from "./_state-scope-audit.ts";
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
  const index = stripComments(readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "index.ts"), "utf8"));
  const tick = index.slice(index.indexOf("const pollPendingApprovals = createPendingApprovalsTick("));
  const tickBody = tick.slice(0, tick.indexOf("\n})"));
  expect(tickBody, "the list kept for the Avatar is the one broadcast").toMatch(/broadcastPending: \(list\) => \{\s*lastPendingApprovals = list/);
  expect(tickBody, "an unreadable poll empties the list kept for the Avatar").toMatch(/pendingUnavailable: \(\) => \{\s*lastPendingApprovals = \[\]/);
  const avatarClientAssignment = index.indexOf("avatarClient = createAvatarClient(");
  expect(avatarClientAssignment, "the Avatar client is assigned after scope lifecycle setup").toBeGreaterThanOrEqual(0);
  const clientBody = extractParenBody(index, index.indexOf("(", avatarClientAssignment));
  expect(clientBody).toMatch(/pendingApprovals: \(\) => lastPendingApprovals/);
  expect(
    clientBody.match(
      /inboxUnread: pendingInboxCounter\(sessionDir, inboxEffects\.pendingMessages, \(\) => \(\{\s*version: inboxArchive\.version\(\),\s*messages: inboxArchive\.snapshot\(\)\.messages\s*\}\)\)/g
    ) ?? [],
    "the Avatar's unread count is fed by the factory's epoch-filtered pending list, in code and exactly once"
  ).toHaveLength(1);
});

// index.ts cannot be imported as a module: the three OS-notification producers are run from their own source
// against stubs, so the guard sits where the bodies decide, not where a text scan could see it.
function indexBodies(): { waiting: string; inbox: string; graph: string } {
  const index = stripComments(readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "index.ts"), "utf8").replace(/\r\n/g, "\n"));
  const bodyAfter = (anchor: string, arrow: boolean): string => {
    const start = index.indexOf(anchor);
    expect(start, `${anchor} exists`).toBeGreaterThanOrEqual(0);
    const open = arrow ? index.indexOf("=> {", start) + 3 : index.indexOf("{", index.indexOf(")", start));
    return extractBracedBody(index, open, true);
  };
  return {
    waiting: bodyAfter("function notifyWaitingSession(", false),
    inbox: bodyAfter("const notifyInbox = (", true),
    graph: bodyAfter("const pollGraphDrafts = async", true)
  };
}

interface FakeNotification {
  options: { title: string; body: string };
  shown: boolean;
  handlers: Record<string, () => void>;
}

function notificationStubs(supported = true) {
  const made: FakeNotification[] = [];
  class Notification {
    static isSupported = (): boolean => supported;
    private readonly record: FakeNotification;
    constructor(options: { title: string; body: string }) {
      this.record = { options, shown: false, handlers: {} };
      made.push(this.record);
    }
    on(event: string, handler: () => void): void {
      this.record.handlers[event] = handler;
    }
    show(): void {
      this.record.shown = true;
    }
  }
  const sent: string[] = [];
  const mainWindow = { show: () => void sent.push("show"), focus: () => void sent.push("focus"), webContents: { send: (channel: string) => void sent.push(channel) } };
  let replacedAsked = 0;
  const avatarClient = (replaced: boolean) => ({
    notificationsReplaced: () => {
      replacedAsked += 1;
      return replaced;
    }
  });
  return { Notification, made, sent, mainWindow, avatarClient, replacedAsked: () => replacedAsked };
}

const compile = (name: string, params: string[], body: string, args: string[]): ((...values: unknown[]) => unknown) => {
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(`async function ${name}(${params.join(", ")}) {${body}\n}`);
  return new Function(...args, `${js}\nreturn ${name};`) as (...values: unknown[]) => (...values: unknown[]) => unknown;
};

test("a waiting session raises its OS notification unless the Avatar vouches for the replacement, and the existing guards still win", async () => {
  const { waiting } = indexBodies();
  const run = (opts: { notifyAttention?: boolean; supported?: boolean; avatar: boolean | null }) => {
    const stubs = notificationStubs(opts.supported ?? true);
    const config = { notifyAttention: opts.notifyAttention ?? true, locale: "en" };
    const service = { list: () => [{ id: "s1", name: "Session 1" }] };
    const app = { getLocale: () => "en" };
    const avatarClient = opts.avatar === null ? null : stubs.avatarClient(opts.avatar);
    const notify = compile("notifyWaitingSession", ["id: string"], waiting, ["config", "service", "Notification", "app", "mainWindow", "avatarClient"])(
      config,
      service,
      stubs.Notification,
      app,
      stubs.mainWindow,
      avatarClient
    ) as (id: string) => void;
    notify("s1");
    return stubs;
  };

  const shown = run({ avatar: false });
  expect(shown.made.map((n) => [n.options.title, n.shown])).toEqual([["Session 1", true]]);
  shown.made[0]!.handlers.click!();
  expect(shown.sent, "the click handler is kept").toEqual(["show", "focus", "session:focus"]);
  expect(run({ avatar: null }).made, "no Avatar client at all").toHaveLength(1);

  const replaced = run({ avatar: true });
  expect(replaced.made, "an active replacement builds no notification").toEqual([]);
  expect(replaced.replacedAsked()).toBe(1);

  expect(run({ avatar: false, notifyAttention: false }).made, "notifyAttention off").toEqual([]);
  expect(run({ avatar: false, supported: false }).made, "OS notifications unsupported").toEqual([]);
  expect(run({ avatar: true, notifyAttention: false }).replacedAsked(), "the config guard answers first").toBe(0);
});

test("an Inbox batch raises its OS notification unless the Avatar vouches for the replacement, and an empty batch stays silent", () => {
  const { inbox } = indexBodies();
  const run = (batch: { from: string; text: string }[], opts: { supported?: boolean; avatar: boolean | null }) => {
    const stubs = notificationStubs(opts.supported ?? true);
    const config = { locale: "en" };
    const app = { getLocale: () => "en" };
    const avatarClient = opts.avatar === null ? null : stubs.avatarClient(opts.avatar);
    const notify = compile("notifyInbox", ["batch: { from: string; text: string }[]"], inbox, ["config", "Notification", "app", "mainWindow", "avatarClient"])(
      config,
      stubs.Notification,
      app,
      stubs.mainWindow,
      avatarClient
    ) as (batch: { from: string; text: string }[]) => void;
    notify(batch);
    return stubs;
  };
  const batch = [{ from: "coder-1", text: "hello" }];

  const shown = run(batch, { avatar: false });
  expect(shown.made.map((n) => [n.options.title, n.shown])).toEqual([["coder-1", true]]);
  shown.made[0]!.handlers.click!();
  expect(shown.sent, "the Inbox click is kept").toEqual(["show", "focus", "inbox:open"]);
  expect(run(batch, { avatar: null }).made).toHaveLength(1);

  expect(run(batch, { avatar: true }).made, "an active replacement builds no notification").toEqual([]);
  expect(run([], { avatar: false }).made, "an empty batch").toEqual([]);
  expect(run(batch, { avatar: false, supported: false }).made, "OS notifications unsupported").toEqual([]);
  expect(run([], { avatar: true }).replacedAsked(), "an empty batch never asks").toBe(0);
});

test("a graph draft still raises its OS notification while the Avatar replaces the others, and never asks the Avatar", async () => {
  const { graph } = indexBodies();
  const stubs = notificationStubs();
  const state = { lastDraftSignature: "" };
  const config = { projectDir: "C:/work", locale: "en" };
  const app = { getLocale: () => "en" };
  const broadcasts: string[] = [];
  const poll = compile(
    "pollGraphDrafts",
    [],
    graph.replace("lastDraftSignature = signature", "state.lastDraftSignature = signature").replace("signature !== lastDraftSignature", "signature !== state.lastDraftSignature"),
    ["fetchGraphDrafts", "computeDeckProjectKey", "config", "resolveBrokerEndpoint", "state", "broadcast", "notifiedDraftIds", "Notification", "app", "mainWindow", "avatarClient"]
  )(
    async () => [{ id: "d1", from_peer: "peer-9", title: "A question", prompt: "p", created_at: "2026-11-17T00:00:00.000Z" }],
    () => "project",
    config,
    () => ({}),
    state,
    (channel: string) => void broadcasts.push(channel),
    new Set<string>(),
    stubs.Notification,
    app,
    stubs.mainWindow,
    stubs.avatarClient(true)
  ) as () => Promise<void>;
  await poll();
  expect(stubs.made.map((n) => [n.options.title, n.shown])).toEqual([["Graph question — peer-9", true]]);
  stubs.made[0]!.handlers.click!();
  expect(stubs.sent, "the draft click is kept").toEqual(["show", "focus", "inbox:open"]);
  expect(stubs.replacedAsked(), "graph drafts are outside the replacement").toBe(0);
  expect(broadcasts).toEqual(["graphDrafts:update"]);
});
