// index.ts and the renderer store cannot load under bun (Electron, a live
// window.api): the wiring runs from index.ts's own source against stubs, and
// the real store runs in a child process.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pendingQuestionTarget } from "../desktop/src/main/pending-question-target.ts";

const INDEX = resolve(import.meta.dir, "../desktop/src/main/index.ts");

function braced(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error("unterminated");
}

function indexSource(): string {
  return readFileSync(INDEX, "utf8").replace(/\r\n/g, "\n");
}

function openOldest(deps: Record<string, unknown>): () => Promise<void> {
  const source = indexSource();
  const start = source.indexOf("async function openOldestPendingQuestion(");
  if (start < 0) throw new Error("index.ts: openOldestPendingQuestion is unavailable");
  const fn = source.slice(start, source.indexOf("{", start)) + braced(source, source.indexOf("{", start));
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(fn);
  const names = Object.keys(deps);
  return new Function(...names, `${js}\nreturn openOldestPendingQuestion;`)(...names.map((n) => deps[n])) as () => Promise<void>;
}

function avatarOpenQuestion(openOldestPendingQuestion: () => Promise<void>): () => Promise<void> {
  const source = indexSource();
  const anchor = source.indexOf("const avatarClient = createAvatarClient({");
  const marker = "  openQuestion: ";
  const start = anchor < 0 ? -1 : source.indexOf(marker, anchor);
  if (start < 0) throw new Error("index.ts: the avatar client openQuestion option is unavailable");
  const expr = source.slice(start + marker.length, source.indexOf("\n", start));
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(`export const f = ${expr}`).replace("export const f = ", "return ");
  return new Function("openOldestPendingQuestion", js)(openOldestPendingQuestion) as () => Promise<void>;
}

const row = (id: string, created_at: string) => ({ id, created_at, status: "pending", origin: { tile_ref: "" }, reply_route: "courrier" });

test("the avatar client's openQuestion option runs openOldestPendingQuestion", async () => {
  let calls = 0;
  await avatarOpenQuestion(async () => { calls += 1; })();
  expect(calls).toBe(1);
});

test("openOldestPendingQuestion focuses the window, then opens the oldest pending row in the Courrier", async () => {
  const sent: unknown[][] = [];
  const order: string[] = [];
  const win = { webContents: { send: (...args: unknown[]) => { order.push("send"); sent.push(args); } } };
  const run = openOldest({
    pendingQuestionTarget,
    lastPendingApprovals: [row("apr-new", "2026-10-16T12:00:00Z"), row("apr-old", "2026-10-16T10:00:00Z")],
    service: { list: () => [] },
    focusDeckWindow: async () => { order.push("focus"); },
    mainWindow: win,
    InboxOpenTarget: undefined,
  });
  await run();
  expect(order).toEqual(["focus", "send"]);
  expect(sent).toEqual([["inbox:open", { approvalId: "apr-old" }]]);
});

test("openOldestPendingQuestion focuses the window, then the live tile whose module awaits the oldest row", async () => {
  const sent: unknown[][] = [];
  const order: string[] = [];
  const win = { webContents: { send: (...args: unknown[]) => { order.push("send"); sent.push(args); } } };
  const hook = { ...row("apr-hook", "2026-10-16T09:00:00Z"), reply_route: "hook", origin: { tile_ref: "tile-2" } };
  const run = openOldest({
    pendingQuestionTarget,
    lastPendingApprovals: [row("apr-mail", "2026-10-16T10:00:00Z"), hook],
    service: { list: () => [{ id: "tile-1", needsAttention: true }, { id: "tile-2", needsAttention: true }] },
    focusDeckWindow: async () => { order.push("focus"); },
    mainWindow: win,
    InboxOpenTarget: undefined,
  });
  await run();
  expect(order).toEqual(["focus", "send"]);
  expect(sent, "a tile's question opens on the tile, never in the Courrier").toEqual([["session:focus", "tile-2"]]);
});

test("the real store opens the inbox and seeds the question named by an inbox:open target", () => {
  const dir = mkdtempSync(join(tmpdir(), "dk-store-probe-"));
  try {
    const storePath = resolve(import.meta.dir, "../desktop/src/renderer/src/store.ts").replaceAll("\\", "/");
    const probe = join(dir, "probe.ts");
    // The stub answers every fetch with [] (getI18n and getConfig need their own
    // shape), and an unhandledRejection listener keeps init's fire-and-forget
    // fetches from killing the child process.
    writeFileSync(probe, [
      "let inboxOpen: ((t?: unknown) => void) | null = null;",
      "const api = new Proxy({}, { get: (_t, key) => {",
      "  if (key === 'onInboxOpen') return (cb: (t?: unknown) => void) => { inboxOpen = cb; return () => {}; };",
      "  if (typeof key === 'string' && key.startsWith('on')) return () => () => {};",
      "  if (typeof key === 'string' && key.startsWith('list')) return () => Promise.resolve([]);",
      "  if (key === 'getI18n') return () => Promise.resolve({ dict: {}, available: [] });",
      "  if (key === 'getConfig') return () => Promise.resolve({});",
      "  if (key === 'reportError') return (...a: unknown[]) => console.error('reportError', ...a);",
      "  return () => Promise.resolve([]);",
      "} });",
      "process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));",
      "(globalThis as Record<string, unknown>).window = { api, innerWidth: 1200 };",
      `const { useDeck } = await import(${JSON.stringify(storePath)});`,
      "try { await useDeck.getState().init(); } catch (e) { console.error('init failed after wiring listeners', e); }",
      "if (!inboxOpen) throw new Error('init wired no onInboxOpen');",
      "inboxOpen({ approvalId: 'apr-old' });",
      "const s = useDeck.getState();",
      "console.log(JSON.stringify({ open: s.inboxOpen, seed: s.inboxSeed }));",
    ].join("\n"));
    const tsconfig = resolve(import.meta.dir, "../desktop/tsconfig.web.json");
    const r = Bun.spawnSync([process.execPath, `--tsconfig-override=${tsconfig}`, "run", probe]);
    expect(r.exitCode, `probe failed: ${r.stderr.toString()}`).toBe(0);
    expect(JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!)).toEqual({ open: true, seed: "apr-old" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
