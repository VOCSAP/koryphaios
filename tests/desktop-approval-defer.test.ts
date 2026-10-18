import { beforeAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  VERDICT_DEFER_MS,
  buildKeystrokes,
  canApplyVerdict,
  classifyVerdict,
  settleTileAnsweredInTerminal,
} from "../desktop/src/main/approval-service";
import { matchPermissionDialog, permissionDialogShown } from "../desktop/src/main/permission-dialog";
import { withinDeferWindow } from "../desktop/src/main/approval-service";
import { canonicalPath } from "../desktop/src/main/worktree-service";
import { buildApprovalRequest } from "../desktop/hooks/approval-hook";
import { createXtermScreen, type XtermScreenRead } from "../desktop/src/main/xterm-screen";
import { deriveOperatorId, generateCredential } from "../shared/approval.ts";
import type { Approval } from "../desktop/src/main/approval-auth";

const INDEX =
  process.env.KORY_INDEX_TS || join(import.meta.dir, "..", "desktop", "src", "main", "index.ts");
const SRC = readFileSync(INDEX, "utf8").replace(/\r\n/g, "\n");
function slice(anchor: string, terminators: string[], label: string): string {
  const start = SRC.indexOf(anchor);
  if (start < 0) throw new Error(`${label}: anchor not found -- index.ts changed shape`);
  const ends = terminators
    .map((t) => ({ t, i: SRC.indexOf(t, start) }))
    .filter((c) => c.i >= 0)
    .sort((a, b) => a.i - b.i);
  if (ends.length === 0) throw new Error(`${label}: no column-0 terminator after the anchor`);
  const body = SRC.slice(start, ends[0].i + ends[0].t.length - 1);
  const lineOf = (idx: number) => SRC.slice(0, idx).split("\n").length;
  console.log(
    `[${label}] index.ts lines ${lineOf(start)}..${lineOf(ends[0].i)} ` +
      `(${body.length} bytes, sha256 ${createHash("sha256").update(body).digest("hex").slice(0, 16)})`,
  );
  return body;
}
async function evaluate<T>(wrapper: string, name: string): Promise<(env: Record<string, unknown>) => T> {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "kory-slice-")));
  const file = join(dir, `${name}-${createHash("sha256").update(wrapper).digest("hex").slice(0, 8)}.ts`);
  writeFileSync(file, wrapper);
  const mod = (await import(pathToFileURL(file).href)) as { register: (env: Record<string, unknown>) => T };
  return mod.register;
}

const POLLER = slice(
  "const pollApprovalVerdicts = async (): Promise<void> => {",
  ["\n}\n"],
  "poller",
);
const LISTENER = slice("service.on(\n  'attention',", ["\n)\n", "\n})\n"], "attention listener");

const registerPoller = await evaluate<{ poll: () => Promise<void> }>(
  `export function register(env) {
  const { approvals, approvalsEnabled, fetchUndeliveredVerdicts, service, waitingTiles,
          openApprovals, heldVerdicts, canApplyVerdict, classifyVerdict, buildKeystrokes,
          journal, markVerdictsDelivered, reportError, matchPermissionDialog, permissionDialogShown,
          withinDeferWindow, canonicalPath, broadcast } = env
${POLLER}
  return { poll: pollApprovalVerdicts }
}
`,
  "poller",
);

const registerListener = await evaluate<void>(
  `export function register(env) {
  const { service, waitingTiles, openApprovals, approvals, settleTileAnsweredInTerminal, reportError, journal,
          addApproval, approvalsEnabled, computeDeckProjectKey, cliContext, activeScope, hostname,
          config, Notification, app } = env
${LISTENER}
}
`,
  "listener",
);

interface Call {
  fn: string;
  args: unknown[];
}

function verdict(over: Partial<Approval> & { tile?: string } = {}): Approval {
  const { tile = "s1", ...rest } = over;
  return {
    id: "appr-42",
    status: "answered",
    answer_kind: "allow",
    answer_text: null,
    answered_via: "telegram",
    answered_at: new Date().toISOString(),
    reply_route: "pty",
    origin: { tile_ref: tile, session_ref: tile },
    ...rest,
  } as unknown as Approval;
}

const blankScreen = (): XtermScreenRead => ({
  status: "ready",
  snapshot: { revision: 0, cols: 120, rows: 40, lines: Array(40).fill(""), cursor: { x: 0, y: 0 } },
});

function pollerEnv(opts: {
  settled: Approval[];
  tiles?: string[];
  waiting?: string[];
  approvalsEnabled?: () => boolean;
  screens?: Record<string, XtermScreenRead>;
}) {
  const calls: Call[] = [];
  const waitingTiles = new Set<string>(opts.waiting ?? []);
  const openApprovals = new Map<string, string>();
  const written: Array<{ tile: string; keys: string }> = [];
  const marked: string[][] = [];
  const env = {
    approvals: { deps: () => ({ fake: true }) },
    approvalsEnabled: opts.approvalsEnabled ?? (() => true),
    fetchUndeliveredVerdicts: async () => opts.settled,
    service: {
      list: () => (opts.tiles ?? ["s1"]).map((id) => ({ id, name: `tile ${id}`, peerId: null, cwd: "C:\\proj" })),
      write: (tile: string, keys: string) => written.push({ tile, keys }),
      screenRead: (tile: string) => opts.screens?.[tile] ?? blankScreen(),
    },
    waitingTiles,
    openApprovals,
    heldVerdicts: new Set<string>(),
    canApplyVerdict,
    classifyVerdict,
    buildKeystrokes,
    matchPermissionDialog,
    permissionDialogShown,
    withinDeferWindow,
    canonicalPath,
    broadcast: (...args: unknown[]) => calls.push({ fn: "broadcast", args }),
    journal: { add: (...args: unknown[]) => calls.push({ fn: "journal.add", args }) },
    markVerdictsDelivered: async (_deps: unknown, ids: string[]) => {
      marked.push([...ids]);
      return ids.length;
    },
    reportError: (...args: unknown[]) => calls.push({ fn: "reportError", args }),
  };
  const { poll: rawPoll } = registerPoller(env);
  const poll = async (): Promise<void> => {
    await rawPoll();
    const crash = calls.find(
      (c) => c.fn === "reportError" && String(c.args[1]).includes("verdict poll failed"),
    );
    if (crash) throw new Error(`the sliced poller threw: ${String(crash.args[2])}`);
  };
  return { poll, calls, written, marked, waitingTiles, openApprovals };
}

const flat = (marked: string[][]) => marked.flat();

describe("classifyVerdict (pure)", () => {
  test("a waiting tile applies", () => {
    expect(classifyVerdict(verdict(), { exists: true, waiting: true })).toBe("apply");
  });

  test("a tile that is alive but no longer flagged DEFERS, it is not settled", () => {
    expect(classifyVerdict(verdict(), { exists: true, waiting: false })).toBe("defer");
  });

  test("the deferral is bounded: past the window the verdict is abandoned, not deferred forever", () => {
    const old = verdict({ answered_at: new Date(Date.now() - VERDICT_DEFER_MS - 1_000).toISOString() });
    expect(classifyVerdict(old, { exists: true, waiting: false })).toBe("abandon");
  });

  test("an unparseable answered_at abandons rather than deferring forever", () => {
    expect(classifyVerdict(verdict({ answered_at: null }), { exists: true, waiting: false })).toBe("abandon");
  });

  test("a closed or unknown session settles silently -- nothing will ever type it", () => {
    expect(classifyVerdict(verdict(), { exists: false, waiting: true })).toBe("settle");
    expect(classifyVerdict(verdict(), null)).toBe("settle");
  });

  test("a channel-route answer settles: the broker already delivered it as a message", () => {
    expect(classifyVerdict(verdict({ reply_route: "channel" }), { exists: true, waiting: true })).toBe("settle");
  });

  test("a hook-route answer settles on every session state: the Claude Code module returns it itself", () => {
    const states: Array<{ exists: boolean; waiting: boolean } | null> = [
      { exists: true, waiting: true },
      { exists: true, waiting: false },
      { exists: false, waiting: false },
      null,
    ];
    const stale = new Date(Date.now() - VERDICT_DEFER_MS - 1_000).toISOString();
    for (const s of states) {
      expect(classifyVerdict(verdict({ reply_route: "hook" }), s)).toBe("settle");
      expect(classifyVerdict(verdict({ reply_route: "hook", answered_at: stale }), s)).toBe("settle");
    }
  });

  test("an unsettled approval is never applied", () => {
    const pending = verdict({ status: "pending", answer_kind: null });
    expect(classifyVerdict(pending, { exists: true, waiting: true })).not.toBe("apply");
    expect(canApplyVerdict(pending, { exists: true, waiting: true })).toBe(false);
  });

  test("canApplyVerdict stays the single 'apply' predicate (one truth, two callers)", () => {
    const cases: Array<{ exists: boolean; waiting: boolean } | null> = [
      { exists: true, waiting: true },
      { exists: true, waiting: false },
      { exists: false, waiting: false },
      null,
    ];
    for (const s of cases) {
      expect(canApplyVerdict(verdict(), s)).toBe(classifyVerdict(verdict(), s) === "apply");
    }
  });
});

describe("pollApprovalVerdicts delivery rules", () => {
  test("a dismissed-but-live tile keeps its verdict pending instead of burning it", async () => {
    const { poll, written, marked, calls } = pollerEnv({ settled: [verdict()], tiles: ["s1"], waiting: [] });
    await poll();
    expect(written).toEqual([]);
    expect(flat(marked)).not.toContain("appr-42");
    const held = calls.filter((c) => c.fn === "journal.add" && /holding/i.test(String(c.args[1])));
    expect(held).toHaveLength(1);
    await poll();
    await poll();
    expect(calls.filter((c) => c.fn === "journal.add" && /holding/i.test(String(c.args[1])))).toHaveLength(1);
  });

  test("the verdict comes back and is applied once the tile is flagged again", async () => {
    const settled = [verdict()];
    const { poll, written, marked, waitingTiles } = pollerEnv({ settled, tiles: ["s1"], waiting: [] });
    await poll();
    expect(flat(marked)).not.toContain("appr-42");
    waitingTiles.add("s1");
    await poll();
    expect(written).toEqual([{ tile: "s1", keys: "\r" }]);
    expect(flat(marked)).toContain("appr-42");
  });

  test("an abandoned verdict is marked delivered AND reported, never silently dropped", async () => {
    const stale = verdict({ answered_at: new Date(Date.now() - VERDICT_DEFER_MS - 1_000).toISOString() });
    const { poll, written, marked, calls } = pollerEnv({ settled: [stale], tiles: ["s1"], waiting: [] });
    await poll();
    expect(written).toEqual([]);
    expect(flat(marked)).toContain("appr-42");
    expect(calls.some((c) => c.fn === "reportError")).toBe(true);
  });

  test.each([
    ["a question", verdict({ kind: "question", answer_kind: "text", answer_text: "go on" } as Partial<Approval>)],
    ["a permission", verdict({ kind: "permission" } as Partial<Approval>)],
  ])("%s verdict remains pending when the screen is unavailable", async (_kind, settled) => {
    const { poll, written, marked, calls } = pollerEnv({
      settled: [settled],
      waiting: ["s1"],
      screens: { s1: { status: "unavailable", reason: "screen-pending" } },
    });

    await poll();
    expect(written).toEqual([]);
    expect(flat(marked)).toEqual([]);
    expect(calls.filter((call) => call.fn === "journal.add" && /holding/.test(String(call.args[1])))).toHaveLength(1);
  });

  test("a waiting tile still gets the keystrokes and is still marked delivered", async () => {
    const { poll, written, marked } = pollerEnv({ settled: [verdict()], tiles: ["s1"], waiting: ["s1"] });
    await poll();
    expect(written).toEqual([{ tile: "s1", keys: "\r" }]);
    expect(flat(marked)).toEqual(["appr-42"]);
  });

  test("a waiting tile receives its verdict while approvals are disabled", async () => {
    const { poll, written, marked } = pollerEnv({
      settled: [verdict()],
      tiles: ["s1"],
      waiting: ["s1"],
      approvalsEnabled: () => false,
    });
    await poll();
    expect(written).toEqual([{ tile: "s1", keys: "\r" }]);
    expect(flat(marked)).toEqual(["appr-42"]);
  });

  test("an answered hook-route row on a live waiting tile is settled with zero keystrokes", async () => {
    const { poll, written, marked, calls } = pollerEnv({
      settled: [verdict({ reply_route: "hook" })],
      tiles: ["s1"],
      waiting: ["s1"],
    });
    await poll();
    expect(written, "the module already returned this verdict to Claude Code; typing it would answer twice").toEqual([]);
    expect(flat(marked)).toEqual(["appr-42"]);
    expect(calls.filter((c) => c.fn === "reportError")).toEqual([]);
  });

  test("a verdict for a tile that no longer exists is still settled in one poll", async () => {
    const { poll, written, marked } = pollerEnv({ settled: [verdict({ tile: "gone" })], tiles: ["s1"] });
    await poll();
    expect(written).toEqual([]);
    expect(flat(marked)).toEqual(["appr-42"]);
  });

  test("nothing settled means no call to the broker at all", async () => {
    const { poll, marked } = pollerEnv({ settled: [] });
    await poll();
    expect(marked).toEqual([]);
  });
});

describe("pollApprovalVerdicts types a permission verdict only into the dialog it describes", () => {
  let SCREEN: XtermScreenRead;
  beforeAll(async () => {
    const chunks = JSON.parse(
      readFileSync(join(import.meta.dir, "pty-harness", "fixtures", "permission-bash-2.1.291.json"), "utf8")
    ) as { data: string }[];
    const screen = createXtermScreen({ cols: 120, rows: 40, reportError: () => undefined });
    for (const chunk of chunks) if (!chunk.data.startsWith("\n##########")) screen.feed(chunk.data);
    await screen.drain();
    SCREEN = screen.read();
    if (SCREEN.status !== "ready") throw new Error(`permission fixture screen unavailable: ${SCREEN.reason}`);
    screen.dispose();
  });
  const truncatedScreen = (lineCount: number): XtermScreenRead => {
    if (SCREEN.status !== "ready") throw new Error("permission fixture screen did not become ready");
    return { status: "ready", snapshot: { ...SCREEN.snapshot, lines: SCREEN.snapshot.lines.slice(0, lineCount) } };
  };

  const permission = (command: string, over: Partial<Approval> = {}) => {
    const body = buildApprovalRequest(
      { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command } },
      { origin: {} } as never,
      "s1"
    );
    return verdict({ kind: "permission", title: body.title, question: body.question, ...over } as Partial<Approval>);
  };
  const notApplied = (calls: Call[]) => calls.filter((c) => c.fn === "broadcast" && c.args[0] === "approvals:not-applied");

  test("the dialog on screen is the approved one: Enter is typed", async () => {
    const { poll, written, marked, calls } = pollerEnv({
      settled: [permission("mkdir probe-4122-dir && echo created")],
      waiting: ["s1"],
      screens: { s1: SCREEN },
    });
    await poll();
    expect(written).toEqual([{ tile: "s1", keys: "\r" }]);
    expect(flat(marked)).toEqual(["appr-42"]);
    expect(notApplied(calls)).toEqual([]);
  });

  test("a verdict describing another dialog types NOTHING, is consumed, traced and toasted", async () => {
    const { poll, written, marked, calls } = pollerEnv({
      settled: [permission("ls")],
      waiting: ["s1"],
      screens: { s1: SCREEN },
    });
    await poll();
    expect(written, "a verdict must never be typed into a dialog the operator was not shown").toEqual([]);
    expect(flat(marked)).toEqual(["appr-42"]);
    expect(calls.filter((c) => c.fn === "reportError" && /NOT typed/.test(String(c.args[1])))).toHaveLength(1);
    const toast = notApplied(calls);
    expect(toast, "the operator who answered must see it was not applied").toHaveLength(1);
    expect(toast[0]!.args[1]).toMatchObject({ tile: "tile s1", title: "Bash: ls" });
  });

  test("no dialog on screen yet: the verdict is HELD, not burnt, then given up with a trace", async () => {
    const { poll, written, marked, calls } = pollerEnv({
      settled: [permission("mkdir probe-4122-dir && echo created")],
      waiting: ["s1"],
    });
    await poll();
    expect(written).toEqual([]);
    expect(flat(marked), "an absent screen must not consume the answer").toEqual([]);
    expect(calls.filter((c) => c.fn === "journal.add" && /holding/.test(String(c.args[1])))).toHaveLength(1);

    const stale = permission("mkdir probe-4122-dir && echo created", {
      answered_at: new Date(Date.now() - VERDICT_DEFER_MS - 1_000).toISOString(),
    });
    const late = pollerEnv({ settled: [stale], waiting: ["s1"] });
    await late.poll();
    expect(flat(late.marked)).toEqual(["appr-42"]);
    expect(late.calls.some((c) => c.fn === "reportError" && /no permission dialog/.test(String(c.args[1])))).toBe(true);
    expect(notApplied(late.calls)).toHaveLength(1);
  });

  test("a held verdict lands once its dialog is painted", async () => {
    const screens: Record<string, XtermScreenRead> = {};
    const { poll, written } = pollerEnv({
      settled: [permission("mkdir probe-4122-dir && echo created")],
      waiting: ["s1"],
      screens,
    });
    await poll();
    expect(written).toEqual([]);
    screens.s1 = SCREEN;
    await poll();
    expect(written).toEqual([{ tile: "s1", keys: "\r" }]);
  });

  test("a question's text answer is never typed into a permission chooser", async () => {
    const question = verdict({ kind: "question", answer_kind: "text", answer_text: "1" } as Partial<Approval>);
    const { poll, written, marked, calls } = pollerEnv({ settled: [question], waiting: ["s1"], screens: { s1: SCREEN } });
    await poll();
    expect(written).toEqual([]);
    expect(flat(marked)).toEqual(["appr-42"]);
    expect(notApplied(calls)).toHaveLength(1);
  });

  test("a question's answer still reaches a tile showing no chooser", async () => {
    const question = verdict({ kind: "question", answer_kind: "text", answer_text: "go on" } as Partial<Approval>);
    const { poll, written } = pollerEnv({ settled: [question], waiting: ["s1"], screens: { s1: truncatedScreen(5) } });
    await poll();
    expect(written).toEqual([{ tile: "s1", keys: "go on\r" }]);
  });
});

describe("attention listener settlement rules", () => {
  function listenerEnv(
    sweepResult: { settled: string[]; lost: string[]; delivered: string[] } = {
      settled: ["appr-42"],
      lost: [],
      delivered: [],
    },
  ) {
    const calls: Call[] = [];
    const service = new EventEmitter() as EventEmitter & { list: () => unknown[] };
    service.list = () => [{ id: "s1", name: "tile one", peerId: null }];
    const waitingTiles = new Set<string>();
    const openApprovals = new Map<string, string>();
    registerListener({
      service,
      waitingTiles,
      openApprovals,
      approvals: { deps: () => ({ fake: true }) },
      settleTileAnsweredInTerminal: (...args: unknown[]) => {
        calls.push({ fn: "settleTileAnsweredInTerminal", args });
        return Promise.resolve(sweepResult);
      },
      addApproval: (...args: unknown[]) => {
        calls.push({ fn: "addApproval", args });
        return Promise.resolve({ id: "appr-new" });
      },
      approvalsEnabled: () => true,
      reportError: (...args: unknown[]) => calls.push({ fn: "reportError", args }),
      journal: { add: (...args: unknown[]) => calls.push({ fn: "journal.add", args }) },
      computeDeckProjectKey: () => "proj",
      cliContext: { projectDir: "C:/tmp" },
      activeScope: { groupId: "g1" },
      hostname: () => "host",
      config: { notifyAttention: false, locale: "en" },
      Notification: Object.assign(function () {}, { isSupported: () => false }),
      app: { getLocale: () => "en" },
    });
    return { calls, service, waitingTiles, openApprovals };
  }

  test("dismissing a flag while an approval is still open leaves a trace", async () => {
    const { calls, service, openApprovals } = listenerEnv();
    openApprovals.set("s1", "appr-42");
    service.emit("attention", { id: "s1", waiting: false, manual: true });
    await Bun.sleep(20);
    expect(calls.some((c) => c.fn === "reportError")).toBe(true);
    expect(calls.some((c) => c.fn === "settleTileAnsweredInTerminal")).toBe(false);
    expect(openApprovals.get("s1")).toBe("appr-42");
  });

  test("dismissing a flag with no open approval reports nothing", async () => {
    const { calls, service } = listenerEnv();
    service.emit("attention", { id: "s1", waiting: false, manual: true });
    await Bun.sleep(20);
    expect(calls.some((c) => c.fn === "reportError")).toBe(false);
  });

  test("an automatic clear sweeps the whole tile, even with no approval of the Deck's own open", async () => {
    const { calls, service, openApprovals } = listenerEnv();
    service.emit("attention", { id: "s1", waiting: false });
    await Bun.sleep(20);
    const sweeps = calls.filter((c) => c.fn === "settleTileAnsweredInTerminal");
    expect(
      sweeps.map((c) => c.args[1]),
      "the hook's permission is not in openApprovals: gating the sweep on it leaves the permission Approve-able",
    ).toEqual(["s1"]);
    expect(calls.some((c) => c.fn === "reportError"), "the local settlement failed").toBe(false);
    openApprovals.set("s1", "appr-42");
    service.emit("attention", { id: "s1", waiting: false });
    await Bun.sleep(20);
    expect(openApprovals.has("s1")).toBe(false);
  });

  test("a verdict given elsewhere that the terminal answer overrides is journaled once", async () => {
    const { calls, service } = listenerEnv({ settled: [], lost: ["appr-42"], delivered: ["appr-42", "appr-43"] });
    service.emit("attention", { id: "s1", waiting: false });
    await Bun.sleep(20);
    const traced = (id: string) =>
      calls.filter((c) => c.fn === "journal.add" && c.args[0] === "attention" && String(c.args[1]).includes(id));
    expect(traced("appr-42"), "a remote verdict overridden by the terminal answer must leave one journal line").toHaveLength(1);
    expect(traced("appr-43")).toHaveLength(1);
  });
});

describe("settleTileAnsweredInTerminal", () => {
  const identity = (() => {
    const cred = generateCredential();
    return {
      publicKey: cred.publicKey,
      privateKey: cred.privateKey,
      operatorId: deriveOperatorId(cred.publicKey),
      osUserHash: "h",
    };
  })();

  function row(id: string, tile: string, over: Partial<Approval> = {}): Approval {
    return {
      id,
      status: "pending",
      mergeable: true,
      absorbed_permission: false,
      answer_kind: null,
      created_at: "2026-10-02T08:00:00.000Z",
      origin: { tile_ref: tile, session_ref: tile },
      ...over,
    } as unknown as Approval;
  }

  function fakeBroker(opts: { pending: Approval[]; undelivered: Approval[]; lost?: string[] }) {
    const claims: Array<Record<string, unknown>> = [];
    const marked: string[][] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const url = String(_url);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
      if (url.endsWith("/approval/list")) {
        if (body.undelivered_only) return json({ approvals: opts.undelivered });
        return json({ approvals: body.status === "pending" ? opts.pending : [] });
      }
      if (url.endsWith("/approval/claim")) {
        claims.push(body);
        if (opts.lost?.includes(String(body.id))) return json({ error: "already-settled" }, 409);
        return json({ approval: row(String(body.id), "s1", { status: "answered_terminal" }) });
      }
      if (url.endsWith("/approval/delivered")) {
        marked.push(body.ids as string[]);
        return json({ marked: (body.ids as string[]).length });
      }
      return json({ error: "unexpected" }, 500);
    }) as unknown as typeof fetch;
    const deps = { endpoint: { url: "http://broker", token: null }, identity, projectKey: "proj", fetchImpl };
    return { deps, claims, marked };
  }

  test("closes every tile notification as answered in the terminal and spares guarded requests and other tiles", async () => {
    const { deps, claims, marked } = fakeBroker({
      pending: [
        row("deck-question", "s1", { absorbed_permission: true }),
        row("hook-permission", "s1"),
        row("session-only", "s1", { origin: { tile_ref: "", session_ref: "s1" } } as Partial<Approval>),
        row("guarded-ticket", "s1", { mergeable: false }),
        row("other-tile", "s2"),
      ],
      undelivered: [
        row("phone-allow", "s1", { status: "answered", answer_kind: "allow" }),
        row("other-verdict", "s2", { status: "answered", answer_kind: "allow" }),
      ],
      lost: ["hook-permission"],
    });
    const result = await settleTileAnsweredInTerminal(deps as never, "s1");
    expect(claims.map((c) => c.id)).toEqual(["deck-question", "hook-permission", "session-only"]);
    expect(
      claims.every((c) => c.terminal === true && c.answer_kind === undefined),
      "a terminal answer must never be relayed as a verdict the operator did not give",
    ).toBe(true);
    expect(result).toEqual({
      settled: ["deck-question", "session-only"],
      lost: ["hook-permission"],
      delivered: ["phone-allow"],
    });
    expect(marked, "a verdict answered before the terminal would be typed into the tile's next dialog").toEqual([
      ["phone-allow"],
    ]);
  });

  test("a row raised just before the sweep is closed, never left Approve-able: losing the next dialog's phone answer beats an orphan permission typed later", async () => {
    const justRaised = row("raised-just-now", "s1", { kind: "permission", created_at: new Date().toISOString() } as Partial<Approval>);
    const { deps, claims, marked } = fakeBroker({ pending: [justRaised], undelivered: [] });
    const result = await settleTileAnsweredInTerminal(deps as never, "s1");
    expect(result.settled, "the sweep takes no snapshot: a row whose hook POST landed late is still closed").toEqual([
      "raised-just-now",
    ]);
    expect(claims).toEqual([expect.objectContaining({ id: "raised-just-now", terminal: true })]);
    expect(marked).toEqual([]);
    const closed = row("raised-just-now", "s1", { status: "answered_terminal" });
    expect(
      classifyVerdict(closed, { exists: true, waiting: true }),
      "a row closed by the terminal must never be typed into the dialog now on screen",
    ).not.toBe("apply");
    expect(buildKeystrokes(closed)).toBeNull();
  });
});
