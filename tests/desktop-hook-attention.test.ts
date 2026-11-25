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
  const broadcasts: Parameters<PendingApprovalsIo<string>["broadcastPending"]>[0][] = [];
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

test("the list is enriched with the Deck's danger signal before any consumer receives it", async () => {
  const list = [approval({ status: "pending", reply_route: "hook", tile_ref: "tile-a" })];
  const probe = tickProbe({ fetch: async () => list });
  const view = { reevaluation: "done" as const, entries: [] };
  probe.io.enrich = async (rows) => rows.map((a) => ({ ...a, danger_view: view }));

  await probe.tick();

  expect(probe.broadcasts).toEqual([[{ ...list[0]!, danger_view: view }]]);
  expect(probe.awaited, "the tile flags do not wait for the danger check").toEqual([["tile-a"]]);
});

test("a list still being enriched is never broadcast after a newer one: a call during a tick runs after it", async () => {
  const old = [approval({ status: "pending", reply_route: "hook", tile_ref: "tile-a" })];
  const lists: Approval[][] = [old, []];
  let fetches = 0;
  const probe = tickProbe({ fetch: async () => lists[fetches++] ?? [] });
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  probe.io.enrich = async (rows) => {
    if (rows.length > 0) await held;
    return rows;
  };

  const first = probe.tick();
  await Bun.sleep(0);
  const second = probe.tick();
  await Bun.sleep(0);
  expect(fetches, "the second call does not read the broker while the first is enriching").toBe(1);
  release();
  await Promise.all([first, second]);

  expect(fetches, "the call made during the tick is not lost").toBe(2);
  expect(probe.broadcasts, "the newer, empty list is the last one broadcast").toEqual([old, []]);
});

test("two calls during one tick ask for exactly one more pass", async () => {
  let fetches = 0;
  const probe = tickProbe({ fetch: async () => (fetches++, []) });
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  let first = true;
  probe.io.enrich = async (rows) => {
    if (first) {
      first = false;
      await held;
    }
    return rows;
  };

  const running = probe.tick();
  await Bun.sleep(0);
  const second = probe.tick();
  const third = probe.tick();
  release();
  await Promise.all([running, second, third]);

  expect(fetches).toBe(2);
});

test("a tick that fails does not block the ticks after it", async () => {
  let fetches = 0;
  const probe = tickProbe({ fetch: async () => (fetches++, []) });
  let fail = true;
  probe.io.enrich = async (rows) => {
    if (fail) throw new Error("enrich broke");
    return rows;
  };

  await expect(probe.tick()).rejects.toThrow("enrich broke");
  fail = false;
  await probe.tick();

  expect(fetches, "the next call reads the broker again").toBe(2);
});

test("a danger view that changes on an unchanged row is broadcast again", async () => {
  const list = [approval({ status: "pending", reply_route: "hook", tile_ref: "tile-a" })];
  const probe = tickProbe({ fetch: async () => list });
  let entries: { id: string; source: "kory"; message: string; messageFrom: "deck"; known: boolean; confirmed: boolean }[] = [];
  probe.io.enrich = async (rows) => rows.map((a) => ({ ...a, danger_view: { reevaluation: "done" as const, entries } }));

  await probe.tick();
  entries = [{ id: "kory/rm-recursive", source: "kory", message: "m", messageFrom: "deck", known: true, confirmed: true }];
  await probe.tick();
  await probe.tick();

  expect(probe.broadcasts.map((b) => b[0]!.danger_view!.entries.length)).toEqual([0, 1]);
});

test("the Deck's poll timer runs the tested tick and notifies on the service's needs-you event", () => {
  const index = readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "index.ts"), "utf8");
  expect(index).toMatch(/const pollPendingApprovals = createPendingApprovalsTick\(/);
});

test("the Avatar client reads the poll's last list and the Courrier's pending messages", () => {
  const index = stripComments(readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "index.ts"), "utf8"));
  const tick = index.slice(index.indexOf("const pollPendingApprovals = createPendingApprovalsTick("));
  const tickBody = tick.slice(0, tick.indexOf("\n})"));
  expect(tickBody, "the list kept for the Avatar is the one broadcast").toMatch(/broadcastPending: \(list\) => \{\s*lastPendingApprovals = list/);
  expect(tickBody, "an unreadable poll empties the list kept for the Avatar").toMatch(/pendingUnavailable: \(\) => \{\s*lastPendingApprovals = \[\]/);
  expect(tickBody, "the broadcast list carries the Deck's own danger check, run in the isolated evaluator").toMatch(
    /enrich: createDangerEnricher\(\{\s*rulesFor: \(tileRef\) => ttsr\.dangerRulesFor\(tileRef\),\s*evaluate: \(rules, call\) => evaluateIsolated\(rules, call,/
  );
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
function indexBodies(): {
  waiting: string;
  inbox: string;
  graph: string;
  needsYou: string;
  broadcastPending: string;
  soundPlay: string;
  soundReady: string;
  rendererGone: string;
  startLoading: string;
  soundDeps: string;
} {
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
    graph: bodyAfter("const pollGraphDrafts = async", true),
    needsYou: bodyAfter("service.on('needs-you'", true),
    broadcastPending: bodyAfter("broadcastPending: (list) => {", true),
    soundPlay: bodyAfter("play: (kind) => {", true),
    soundReady: bodyAfter("regOn('notify:sound-ready'", true),
    rendererGone: bodyAfter("app.on('render-process-gone'", true),
    startLoading: bodyAfter("mainWindow.webContents.on('did-start-loading'", true),
    soundDeps: extractParenBody(index, index.indexOf("(", index.indexOf("createNotificationSounder(")), true)
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

test("the needs-you handler and the approvals broadcast both reach the sound decision, and the ready signal reaches the sounder", () => {
  const { needsYou, broadcastPending, soundReady } = indexBodies();
  const calls: string[] = [];
  const sounder = {
    noteAttention: () => void calls.push("attention"),
    noteApprovals: (list: unknown) => void calls.push(`approvals:${(list as string[]).join(",")}`),
    rendererReady: () => void calls.push("ready")
  };

  const onNeedsYou = compile("onNeedsYou", ["{ id }: { id: string }"], needsYou, ["notifyWaitingSession", "notificationSounder"])(
    (id: string) => void calls.push(`notify:${id}`),
    sounder
  ) as (event: { id: string }) => void;
  onNeedsYou({ id: "s1" });
  expect(calls, "the OS notification and the sound both run for a needs-you edge").toEqual(["notify:s1", "attention"]);

  calls.length = 0;
  const list = ["a1", "a2"];
  const avatarClient = { sessionsChanged: () => void calls.push("sessions"), inboxChanged: () => void calls.push("inbox") };
  const onBroadcast = compile("broadcastPending", ["list: string[]"], broadcastPending, ["lastPendingApprovals", "broadcast", "avatarClient", "notificationSounder"])(
    [],
    (channel: string) => void calls.push(`broadcast:${channel}`),
    avatarClient,
    sounder
  ) as (list: string[]) => void;
  onBroadcast(list);
  expect(calls, "the sound decision sees the broadcast list, next to the Avatar refresh").toEqual([
    "broadcast:approvals:pending",
    "approvals:a1,a2",
    "sessions",
    "inbox"
  ]);

  calls.length = 0;
  (compile("onReady", [], soundReady, ["notificationSounder"])(sounder) as () => void)();
  expect(calls, "the renderer ready signal is forwarded to the sounder").toEqual(["ready"]);
});

test("a reload or a crash of the main renderer marks it not ready, and no other web contents does", () => {
  const { rendererGone, startLoading } = indexBodies();
  const calls: string[] = [];
  const sounder = { rendererNotReady: () => void calls.push("not-ready") };
  const mainContents = { id: "main" };
  const mainWindow = { webContents: mainContents };

  const onGone = compile("onGone", ["_e: unknown", "contents: unknown", "details: { reason: string; exitCode: number }"], rendererGone, [
    "reportError",
    "mainWindow",
    "notificationSounder",
    "BrowserWindow",
    "dialog"
  ])(() => undefined, mainWindow, sounder, { fromWebContents: () => null }, {}) as (e: unknown, contents: unknown, details: { reason: string; exitCode: number }) => void;
  onGone(null, mainContents, { reason: "clean-exit", exitCode: 0 });
  expect(calls, "the main renderer is not ready even on a clean exit, before the early return").toEqual(["not-ready"]);
  calls.length = 0;
  onGone(null, { id: "webview" }, { reason: "clean-exit", exitCode: 0 });
  expect(calls, "another web contents leaves the main renderer ready").toEqual([]);

  const onLoading = compile("onLoading", [], startLoading, ["notificationSounder"])(sounder) as () => void;
  onLoading();
  expect(calls, "a navigation of the main window marks its listener gone").toEqual(["not-ready"]);
});

test("the sounder the Deck builds follows the config switch, reads the Avatar file where the Avatar writes it, and reports under its own scope", () => {
  const { soundDeps } = indexBodies();
  const reads: unknown[][] = [];
  const reported: unknown[][] = [];
  const reportError = (...args: unknown[]) => void reported.push(args);
  const appearance = { sound: false, dndUntil: 5 };
  const build = (config: Record<string, unknown>) => {
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(`function build() { return (${soundDeps}) }`);
    const make = new Function(
      "config",
      "app",
      "join",
      "APP_STATE_SUBDIR",
      "AVATAR_APPEARANCE_FILE",
      "readAvatarAppearance",
      "reportError",
      "mainWindow",
      "Date",
      `${js}\nreturn build;`
    );
    return make(
      config,
      { getPath: (name: string) => (name === "userData" ? "USERDATA" : "WRONG") },
      join,
      "state-subdir",
      "avatar-appearance.json",
      (...args: unknown[]) => {
        reads.push(args);
        return appearance;
      },
      reportError,
      null,
      { now: () => 4242 }
    )() as {
      enabled: () => boolean;
      appearance: () => unknown;
      now: () => number;
      report: (text: string, err?: unknown) => void;
    };
  };

  expect(build({ notifySound: true }).enabled()).toBe(true);
  expect(build({ notifySound: false }).enabled(), "the Settings switch decides").toBe(false);
  expect(build({}).enabled(), "an absent setting reads as on").toBe(true);

  const deps = build({});
  expect(deps.appearance(), "the Avatar file read is what the sounder sees").toBe(appearance);
  expect(reads[0]![0], "the file the Avatar writes, under the Deck state dir").toBe(join("USERDATA", "state-subdir", "avatar-appearance.json"));
  expect((reads[0]![1] as { reportError: unknown }).reportError, "the reader reports through the Deck's sink").toBe(reportError);
  expect(deps.now(), "the clock is Date.now").toBe(4242);

  const boom = new Error("boom");
  deps.report("some text", boom);
  expect(reported).toEqual([["notification-sound", "some text", boom]]);
});

test("the Deck hands a sound to its window only while that window is alive, and says whether it did", () => {
  const { soundPlay } = indexBodies();
  const sent: unknown[][] = [];
  const window = (destroyed: boolean) => ({
    isDestroyed: () => destroyed,
    webContents: { send: (...args: unknown[]) => void sent.push(args) }
  });
  const play = (mainWindow: unknown): boolean => {
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(`function play(kind: string) {${soundPlay}\n}`);
    const build = new Function("mainWindow", `${js}\nreturn play;`) as (window: unknown) => (kind: string) => boolean;
    return build(mainWindow)("question");
  };

  expect(play(null), "no window yet").toBe(false);
  expect(play(window(true)), "a destroyed window").toBe(false);
  expect(sent).toEqual([]);
  expect(play(window(false)), "a live window").toBe(true);
  expect(sent).toEqual([["notify:sound", "question"]]);
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
