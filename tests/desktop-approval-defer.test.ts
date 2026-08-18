// Card 9c6de1e1: a verdict answered from the phone was marked DELIVERED
// without ever being typed, whenever the operator had dismissed the tile's
// attention badge in the meantime.
//
// Chain (hyp_9405c518): clearAttention -> waitingTiles.delete -> the poller's
// `!canApplyVerdict` branch -> `applied.push(id)` -> markVerdictsDelivered.
// The poller conflated "nobody will ever type this" (tile gone, channel
// route) with "this tile is alive, its flag was merely cleared".
//
// The guard lives in TWO places and both are exercised here:
//   1. the pure classifier in approval-service.ts (imports cleanly), and
//   2. the REAL poller in desktop/src/main/index.ts, sliced verbatim out of
//      the file and run with fakes -- index.ts cannot be imported under bun
//      (electron, node-pty), but the poller closes over nothing that needs
//      them. Slicing rather than retyping means the bytes under test are the
//      shipped bytes: a paraphrase here could drift from index.ts without
//      anything failing, which is exactly the failure mode this test exists
//      to prevent. The extracted line range + a sha256 are printed so a
//      reviewer can check what actually ran.
//
// The attention listener is sliced the same way for the second half of the
// fix: dismissing a flag while an approval is still open must leave a trace.
import { describe, expect, test } from "bun:test";
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
} from "../desktop/src/main/approval-service";
import type { Approval } from "../desktop/src/main/approval-auth";

// The negative control has to stay REPLAYABLE, or "I measured it red" is just
// a claim: point this at an older copy of index.ts and the four defect
// assertions must fail there, which is what proves they look at the right place
// and that the untouched-path assertions are not vacuous.
//   git show <rev>:desktop/src/main/index.ts > /tmp/index-prefix.ts
//   KORY_INDEX_TS=/tmp/index-prefix.ts bun test tests/desktop-approval-defer.test.ts
const INDEX =
  process.env.KORY_INDEX_TS || join(import.meta.dir, "..", "desktop", "src", "main", "index.ts");
// index.ts is CRLF on disk; normalise line endings only (no other rewriting)
// so a \n-based indexOf finds the anchors and the slice stays stable.
const SRC = readFileSync(INDEX, "utf8").replace(/\r\n/g, "\n");

/**
 * Cut one top-level statement out of index.ts, from `anchor` to the first
 * column-0 terminator line. A paren-counting walker looks smarter but breaks
 * on apostrophes inside the comments this file is full of.
 */
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
// Un repertoire NEUF par tranche, et son chemin canonicalise. Les deux moities
// repondent au meme echec de CI, rouge sur le seul job macos-latest depuis le
// 2026-08-13 (carte c1849cf9) :
//
//   error: Cannot find module '/private/var/folders/.../kory-slice-XXXXXX/
//                              listener-b6342d05.ts' from ''
//
// Le fait discriminant est que le PREMIER import de tranche REUSSIT et que
// seul le SECOND echoue. Si la cause etait la seule canonicalisation macOS de
// /var vers /private/var, le premier echouerait aussi ; le /private/var du
// message est donc la forme sous laquelle bun rapporte, pas la cause. Reste
// que le second fichier est ecrit APRES que le premier import a fait lister ce
// repertoire, d'ou un repertoire par tranche : aucun listing n'est reutilise.
//
// `realpathSync.native` traite l'autre moitie, celle que CLAUDE.md nomme
// (« Comparing two paths? Canonicalize both ») : sur macOS `tmpdir()` rend
// /var/folders/... quand tout outil externe repond /private/var/folders/...,
// et sur Windows un nom court 8.3. Le chemin ecrit et le chemin resolu sont
// alors le meme.
//
// Aucune des deux moities n'est verifiable ailleurs que sur le runner macOS :
// ni Linux ni Windows ne symlinkent leur repertoire temporaire, ce qui est
// exactement la remarque « Cross-platform tests » de TESTING.md.
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
          journal, markVerdictsDelivered, reportError } = env
${POLLER}
  return { poll: pollApprovalVerdicts }
}
`,
  "poller",
);

const registerListener = await evaluate<void>(
  `export function register(env) {
  const { service, waitingTiles, openApprovals, approvals, claimApproval, reportError, journal,
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

function pollerEnv(opts: { settled: Approval[]; tiles?: string[]; waiting?: string[] }) {
  const calls: Call[] = [];
  const waitingTiles = new Set<string>(opts.waiting ?? []);
  const openApprovals = new Map<string, string>();
  const written: Array<{ tile: string; keys: string }> = [];
  const marked: string[][] = [];
  const env = {
    approvals: { deps: () => ({ fake: true }) },
    approvalsEnabled: () => true,
    fetchUndeliveredVerdicts: async () => opts.settled,
    service: {
      list: () => (opts.tiles ?? ["s1"]).map((id) => ({ id, name: `tile ${id}`, peerId: null })),
      write: (tile: string, keys: string) => written.push({ tile, keys }),
    },
    waitingTiles,
    openApprovals,
    // Poll-to-poll bookkeeping lives at index.ts module scope, i.e. OUTSIDE
    // the sliced statement, so the test owns it -- which is also what makes
    // "one journal line per held verdict, not one per tick" observable here.
    heldVerdicts: new Set<string>(),
    canApplyVerdict,
    classifyVerdict,
    buildKeystrokes,
    journal: { add: (...args: unknown[]) => calls.push({ fn: "journal.add", args }) },
    markVerdictsDelivered: async (_deps: unknown, ids: string[]) => {
      marked.push([...ids]);
      return ids.length;
    },
    reportError: (...args: unknown[]) => calls.push({ fn: "reportError", args }),
  };
  const { poll: rawPoll } = registerPoller(env);
  // The poller swallows its own exceptions into reportError, so a free
  // identifier this harness forgot to inject would show up as an assertion
  // passing for the WRONG reason (a ReferenceError also "leaves a trace").
  // Measured once, for real: heldVerdicts was missing, and the very first
  // defect assertion went green on the swallowed error. Fail loudly instead.
  const poll = async (): Promise<void> => {
    await rawPoll();
    const crash = calls.find(
      (c) => c.fn === "reportError" && String(c.args[1]).includes("verdict poll failed"),
    );
    if (crash) throw new Error(`the sliced poller threw: ${String(crash.args[2])}`);
  };
  return { poll, calls, written, marked, waitingTiles, openApprovals };
}

/** Every id the poller told the broker to stop re-sending, across all calls. */
const flat = (marked: string[][]) => marked.flat();

describe("classifyVerdict (pure)", () => {
  test("a waiting tile applies", () => {
    expect(classifyVerdict(verdict(), { exists: true, waiting: true })).toBe("apply");
  });

  test("a tile that is alive but no longer flagged DEFERS, it is not settled", () => {
    // The operator dismissed the badge; the agent may still be sitting at the
    // very same prompt. Marking it delivered here is what lost the answer.
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

describe("pollApprovalVerdicts (sliced verbatim from index.ts)", () => {
  test("a dismissed-but-live tile keeps its verdict pending instead of burning it", async () => {
    const { poll, written, marked, calls } = pollerEnv({ settled: [verdict()], tiles: ["s1"], waiting: [] });
    await poll();
    expect(written).toEqual([]);
    expect(flat(marked)).not.toContain("appr-42");
    // Not silent either: the operator must be able to see why nothing landed.
    const held = calls.filter((c) => c.fn === "journal.add" && /holding/i.test(String(c.args[1])));
    expect(held).toHaveLength(1);
    // ...and exactly ONE line, not one per poll tick (10s apart in the app).
    await poll();
    await poll();
    expect(calls.filter((c) => c.fn === "journal.add" && /holding/i.test(String(c.args[1])))).toHaveLength(1);
  });

  test("the verdict comes back and is applied once the tile is flagged again", async () => {
    const settled = [verdict()];
    const { poll, written, marked, waitingTiles } = pollerEnv({ settled, tiles: ["s1"], waiting: [] });
    await poll();
    expect(flat(marked)).not.toContain("appr-42");
    waitingTiles.add("s1"); // a repaint of the same still-blocked prompt re-arms the flag
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

  // --- untouched paths: these must keep behaving exactly as before the fix.
  test("a waiting tile still gets the keystrokes and is still marked delivered", async () => {
    const { poll, written, marked } = pollerEnv({ settled: [verdict()], tiles: ["s1"], waiting: ["s1"] });
    await poll();
    expect(written).toEqual([{ tile: "s1", keys: "\r" }]);
    expect(flat(marked)).toEqual(["appr-42"]);
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

describe("attention listener (sliced verbatim from index.ts)", () => {
  function listenerEnv() {
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
      claimApproval: (...args: unknown[]) => {
        calls.push({ fn: "claimApproval", args });
        return Promise.resolve();
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
    // 4f0143ff must stay closed: a dismiss still answers nothing on its own.
    expect(calls.some((c) => c.fn === "claimApproval")).toBe(false);
    // ...and the approval stays open, so the poller can still deliver it.
    expect(openApprovals.get("s1")).toBe("appr-42");
  });

  test("dismissing a flag with no open approval reports nothing", async () => {
    const { calls, service } = listenerEnv();
    service.emit("attention", { id: "s1", waiting: false, manual: true });
    await Bun.sleep(20);
    expect(calls.some((c) => c.fn === "reportError")).toBe(false);
  });

  test("an automatic clear still settles the open approval (untouched path)", async () => {
    const { calls, service, openApprovals } = listenerEnv();
    openApprovals.set("s1", "appr-42");
    service.emit("attention", { id: "s1", waiting: false });
    await Bun.sleep(20);
    expect(calls.filter((c) => c.fn === "claimApproval")).toHaveLength(1);
    expect(openApprovals.has("s1")).toBe(false);
  });
});
