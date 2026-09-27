import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Node-only modules (no electron), import under bun.
import {
  BoundedMap,
  BoundedSet,
  REPO_RULES_REL,
  TTSR_LOG_LINE_CHARS,
  TTSR_LOG_MINUTE_LINES,
  TTSR_PROBE_CONCURRENCY,
  TTSR_PROMPT_INTERVAL_MS,
  TtsrService,
  defaultResolveProject,
  repoRulesPathForWrite,
  type TtsrApprovalRequest,
  type TtsrProjectRef,
  type TtsrServiceDeps,
} from "../desktop/src/main/ttsr-service";
import {
  TTSR_APPROVALS_PER_KEY,
  emptyTtsrApprovals,
  isTtsrApproved,
  readTtsrApprovals,
  withTtsrApproval,
} from "../desktop/src/main/ttsr-approvals";
import { TTSR_DISABLED_MAX, isTtsrToggleKey, sanitizeTtsrDisabled, ttsrToggleKey } from "../desktop/src/main/ttsr-toggles";
import { matchIsolated } from "../desktop/src/main/ttsr-regex-worker";
import { MAX_FILE_BYTES, parseEffectiveFile, parseRulesFile, rulesHash } from "../desktop/src/shared/ttsr-rules";
import { readBounded } from "../desktop/src/shared/ttsr-fs";
import { KORY_RULES } from "../desktop/src/shared/ttsr-builtin";
import { extractBracedBody } from "./_braced-body";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tmp(prefix = "ttsr-svc-"): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(d);
  return d;
}

const rule = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  event: "PreToolUse",
  tools: ["Edit", "Write"],
  field: "added",
  pattern: "forbidden-token",
  mode: "deny",
  message: `Rule ${id}: do not write the forbidden token; write the allowed one instead.`,
  ...extra,
});
const fileOf = (...rules: Record<string, unknown>[]): string => JSON.stringify({ version: 1, rules }, null, 2);

function writeRepoRules(root: string, text: string): string {
  const p = join(root, REPO_RULES_REL);
  mkdirSync(join(root, ".claude", "claude-peers"), { recursive: true });
  writeFileSync(p, text);
  return p;
}

interface Harness {
  svc: TtsrService;
  dir: string;
  globalFile: string;
  approvalsFile: string;
  effectiveDir: string;
  disabled: string[];
  errors: string[];
  journal: string[];
  prompts: TtsrApprovalRequest[];
  answer: { value: boolean };
  changed: { count: number };
  keys: Map<string, string>;
  clock: { now: number };
}

/** Service on a throwaway dir; project root = the cwd itself, key from `keys` (default local:<root>). */
function harness(opts: Partial<TtsrServiceDeps> = {}): Harness {
  const dir = tmp();
  const h: Harness = {
    svc: undefined as unknown as TtsrService,
    dir,
    globalFile: join(dir, "config", "ttsr-rules.json"),
    approvalsFile: join(dir, "state", "ttsr-approvals.json"),
    effectiveDir: join(dir, "state", "sessions", "g", "ttsr"),
    disabled: [],
    errors: [],
    journal: [],
    prompts: [],
    answer: { value: false },
    changed: { count: 0 },
    keys: new Map(),
    clock: { now: 1_000_000 },
  };
  h.svc = new TtsrService({
    globalRulesFile: () => h.globalFile,
    approvalsFile: () => h.approvalsFile,
    sessionDir: () => join(h.dir, "state", "sessions", "g"),
    getDisabled: () => h.disabled,
    reportError: (scope, message, err) => {
      h.errors.push(`${scope}: ${message}${err ? ` (${String(err)})` : ""}`);
    },
    journal: (t) => h.journal.push(t),
    promptApproval: async (req) => {
      h.prompts.push(req);
      return h.answer.value;
    },
    onChanged: () => h.changed.count++,
    resolveProject: (cwd) => ({ root: cwd, projectKey: h.keys.get(cwd) ?? `local:${cwd}` }),
    defer: (fn) => fn(),
    now: () => h.clock.now,
    // Synchronous "all fast" verdict; the worker probe has its own tests below.
    probeRules: () => [],
    ...opts,
  });
  return h;
}

function effective(path: string): string[] {
  const parsed = parseEffectiveFile(readFileSync(path, "utf8"));
  if (!parsed.ok) throw new Error(`effective file invalid: ${parsed.errors.join("; ")}`);
  return parsed.file.rules.map((r) => r.qualifiedId);
}

const KORY_IDS = KORY_RULES.map((r) => `kory/${r.id}`);
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe("effective file per tile", () => {
  test("path is <effectiveDir>/<desk id>.json and holds the Kory rules when nothing else exists", () => {
    const h = harness();
    const id = randomUUID();
    const cwd = tmp();
    const path = h.svc.fileFor({ id, cwd });
    expect(path, "the env value must be the per-tile file under the window's session dir").toBe(join(h.effectiveDir, `${id}.json`));
    expect(effective(path)).toEqual(KORY_IDS);
    expect(h.errors).toEqual([]);
  });

  test("a non-uuid desk id gets no file (never a path segment) and leaves a trace", () => {
    const h = harness();
    expect(h.svc.fileFor({ id: "../../etc/x", cwd: tmp() })).toBe("");
    expect(h.errors.join("\n")).toContain("its id is not a uuid");
  });

  test("valid global rules are added as user/<id>; toggles remove kory and user rules", () => {
    const h = harness();
    mkdirSync(join(h.dir, "config"), { recursive: true });
    writeFileSync(h.globalFile, fileOf(rule("g-one"), rule("g-two")));
    const h2 = harness();
    // Fresh service reads the global file at construction; reuse paths of h.
    const svc = new TtsrService({
      globalRulesFile: () => h.globalFile,
      approvalsFile: () => h2.approvalsFile,
      sessionDir: () => join(h2.dir, "state", "sessions", "g"),
      getDisabled: () => h2.disabled,
      reportError: (s, m) => h2.errors.push(`${s}: ${m}`),
      journal: () => {},
      promptApproval: async () => false,
      onChanged: () => {},
      resolveProject: (cwd) => ({ root: cwd, projectKey: `local:${cwd}` }),
      probeRules: () => [],
    });
    const id = randomUUID();
    const path = svc.fileFor({ id, cwd: tmp() });
    expect(effective(path)).toEqual([...KORY_IDS, "user/g-one", "user/g-two"]);
    h2.disabled.push("user/g-one", "kory/empty-catch");
    svc.recompileAll();
    expect(effective(path)).toEqual([...KORY_IDS.filter((k) => k !== "kory/empty-catch"), "user/g-two"]);
  });

  test("an invalid global file loads NO user rule (never a subset), exposes its errors and traces once", () => {
    const h = harness();
    mkdirSync(join(h.dir, "config"), { recursive: true });
    // One valid rule next to one with a typo: a partial load would keep g-ok.
    const text = fileOf(rule("g-ok"), { ...rule("g-typo"), patern: "x" });
    writeFileSync(h.globalFile, text);
    h.svc.tick();
    const path = h.svc.fileFor({ id: randomUUID(), cwd: tmp() });
    expect(effective(path), "an invalid global file must contribute zero rules").toEqual(KORY_IDS);
    const list = h.svc.list();
    expect(list.global.file.status).toBe("invalid");
    expect(list.global.file.errors).toEqual((parseRulesFile(text) as { errors: string[] }).errors);
    expect(list.global.file.text).toBe(text);
    expect(list.global.rules).toEqual([]);
    h.svc.tick();
    expect(h.errors.filter((e) => e.includes("global guard rules rejected"))).toHaveLength(1);
  });

  test("the supervisor tile gets Kory rules only, whatever global and repo rules exist", async () => {
    const h = harness();
    mkdirSync(join(h.dir, "config"), { recursive: true });
    writeFileSync(h.globalFile, fileOf(rule("g-one")));
    const cwd = tmp();
    writeRepoRules(cwd, fileOf(rule("r-one")));
    h.answer.value = true;
    h.svc.tick();
    const worker = h.svc.fileFor({ id: randomUUID(), cwd });
    await flush();
    expect(effective(worker)).toEqual([...KORY_IDS, "user/g-one", "repo/r-one"]);
    const sup = h.svc.fileFor({ id: randomUUID(), cwd, supervisor: true });
    expect(effective(sup), "the supervisor applies only the generic Kory rules").toEqual(KORY_IDS);
  });

  test("remove() deletes the tile's effective file and its sandbox copy", () => {
    const h = harness();
    const id = randomUUID();
    const path = h.svc.fileFor({ id, cwd: tmp() });
    const run = join(h.dir, "run");
    const sid = randomUUID();
    expect(h.svc.projectIntoSandbox(id, sid, run)).toEqual({
      file: `/kory-run/ttsr-${sid}.json`,
      log: `/kory-run/ttsr-${sid}.log`,
    });
    expect(existsSync(join(run, `ttsr-${sid}.json`))).toBe(true);
    writeFileSync(join(run, `ttsr-${sid}.log`), "x\n");
    writeFileSync(h.svc.logPathOf(id), "y\n");
    h.svc.remove(id);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(run, `ttsr-${sid}.json`))).toBe(false);
    expect(existsSync(join(run, `ttsr-${sid}.log`)), "the sandbox hook log goes with the tile").toBe(false);
    expect(existsSync(path.replace(/\.json$/, ".log")), "the host hook log goes with the tile").toBe(false);
    expect(h.svc.effectivePathOf(id)).toBeNull();
  });
});

describe("repo rules and approvals", () => {
  test("a valid unapproved repo file stays out, prompts once; approval brings it in; any edit puts it back to pending", async () => {
    const h = harness();
    const cwd = tmp();
    const text = fileOf(rule("r-one"));
    writeRepoRules(cwd, text);
    const id = randomUUID();
    const path = h.svc.fileFor({ id, cwd });
    await flush();
    expect(effective(path), "an unapproved repo file must never reach the hook").toEqual(KORY_IDS);
    expect(h.prompts.map((p) => p.hash)).toEqual([rulesHash(text)]);
    expect(h.svc.list().projects[0]!.file.status).toBe("pending");

    // "Not now" is not asked again for the same (project, hash) in this run.
    h.svc.fileFor({ id: randomUUID(), cwd });
    h.svc.tick();
    await flush();
    expect(h.prompts).toHaveLength(1);

    expect(h.svc.approveRepo({ root: cwd, projectKey: `local:${cwd}` }, rulesHash(text))).toEqual({ ok: true });
    expect(effective(path)).toEqual([...KORY_IDS, "repo/r-one"]);
    expect(h.svc.list().projects[0]!.file.status).toBe("approved");

    // One character changes: the poll sees it and withdraws the rules.
    h.clock.now += TTSR_PROMPT_INTERVAL_MS;
    const edited = text.replace("forbidden-token", "forbidden-tokem");
    writeRepoRules(cwd, edited);
    h.svc.tick();
    await flush();
    expect(effective(path), "an edited repo file must be pending again").toEqual(KORY_IDS);
    expect(h.svc.list().projects[0]!.file.status).toBe("pending");
    expect(h.prompts.map((p) => p.hash)).toEqual([rulesHash(text), rulesHash(edited)]);
  });

  test("approving from the prompt stores the hash and recompiles", async () => {
    const h = harness();
    h.answer.value = true;
    const cwd = tmp();
    const text = fileOf(rule("r-one"));
    writeRepoRules(cwd, text);
    const path = h.svc.fileFor({ id: randomUUID(), cwd });
    await flush();
    expect(effective(path)).toEqual([...KORY_IDS, "repo/r-one"]);
    const stored = JSON.parse(readFileSync(h.approvalsFile, "utf8"));
    expect(stored.keys[`local:${cwd}`]).toEqual([rulesHash(text)]);
    expect(stored.roots[cwd], "approving sets the hash this root applies").toBe(rulesHash(text));
  });

  test("approveRepo refuses a hash that is not the file's current hash (no approving stale content)", () => {
    const h = harness();
    const cwd = tmp();
    const old = fileOf(rule("r-one"));
    writeRepoRules(cwd, old);
    const ref: TtsrProjectRef = { root: cwd, projectKey: `local:${cwd}` };
    h.svc.fileFor({ id: randomUUID(), cwd });
    writeRepoRules(cwd, fileOf(rule("r-one", { mode: "warn" })));
    expect(h.svc.approveRepo(ref, rulesHash(old))).toEqual({ ok: false, reason: "stale" });
    writeRepoRules(cwd, "{ not json");
    expect(h.svc.approveRepo(ref, rulesHash("{ not json"))).toEqual({ ok: false, reason: "invalid" });
  });

  test("an invalid repo file loads nothing, raises no prompt, traces once per content", async () => {
    const h = harness();
    const cwd = tmp();
    writeRepoRules(cwd, fileOf(rule("r-ok"), { ...rule("r-bad"), mode: "block" }));
    const path = h.svc.fileFor({ id: randomUUID(), cwd });
    h.svc.fileFor({ id: randomUUID(), cwd });
    h.svc.tick();
    await flush();
    expect(effective(path)).toEqual(KORY_IDS);
    expect(h.prompts).toEqual([]);
    const proj = h.svc.list().projects[0]!;
    expect(proj.file.status).toBe("invalid");
    expect(proj.rules).toEqual([]);
    expect(h.errors.filter((e) => e.includes("repo guard rules rejected"))).toHaveLength(1);
  });

  test("two worktrees of one project key with two different files are both approved, neither revokes the other", async () => {
    const h = harness();
    const wtA = tmp();
    const wtB = tmp();
    h.keys.set(wtA, "github.com/o/r");
    h.keys.set(wtB, "github.com/o/r");
    const a = fileOf(rule("r-one"));
    const b = fileOf(rule("r-one"), rule("r-two"));
    writeRepoRules(wtA, a);
    writeRepoRules(wtB, b);
    const pa = h.svc.fileFor({ id: randomUUID(), cwd: wtA });
    const pb = h.svc.fileFor({ id: randomUUID(), cwd: wtB });
    expect(h.svc.approveRepo({ root: wtA, projectKey: "github.com/o/r" }, rulesHash(a)).ok).toBe(true);
    expect(h.svc.approveRepo({ root: wtB, projectKey: "github.com/o/r" }, rulesHash(b)).ok).toBe(true);
    h.svc.tick();
    expect(effective(pa)).toEqual([...KORY_IDS, "repo/r-one"]);
    expect(effective(pb), "approving worktree B must not revoke worktree A").toEqual([...KORY_IDS, "repo/r-one", "repo/r-two"]);
    const stored = readTtsrApprovals(h.approvalsFile, (m) => h.errors.push(m));
    expect(stored.keys["github.com/o/r"]).toEqual([rulesHash(a), rulesHash(b)]);
    expect(stored.roots, "each worktree root applies its own approved hash").toEqual({ [wtA]: rulesHash(a), [wtB]: rulesHash(b) });
  });

  test("repo toggles are keyed by project: disabling r-one in project A leaves r-one of project B active", () => {
    const h = harness();
    const pA = tmp();
    const pB = tmp();
    h.keys.set(pA, "github.com/o/a");
    h.keys.set(pB, "github.com/o/b");
    const text = fileOf(rule("r-one"));
    writeRepoRules(pA, text);
    writeRepoRules(pB, text);
    const fa = h.svc.fileFor({ id: randomUUID(), cwd: pA });
    const fb = h.svc.fileFor({ id: randomUUID(), cwd: pB });
    h.svc.approveRepo({ root: pA, projectKey: "github.com/o/a" }, rulesHash(text));
    h.svc.approveRepo({ root: pB, projectKey: "github.com/o/b" }, rulesHash(text));
    h.disabled.push(ttsrToggleKey("repo", "r-one", "github.com/o/a"));
    h.svc.recompileAll();
    expect(effective(fa)).toEqual(KORY_IDS);
    expect(effective(fb)).toEqual([...KORY_IDS, "repo/r-one"]);
    const rows = h.svc.list().projects.map((p) => [p.projectKey, p.rules[0]!.toggleKey, p.rules[0]!.active]);
    expect(rows).toEqual([
      ["github.com/o/a", "repo/github.com/o/a/r-one", false],
      ["github.com/o/b", "repo/github.com/o/b/r-one", true],
    ]);
  });

  test("an approval written by another window (same approvals file) is picked up by the poll", () => {
    const h = harness();
    const cwd = tmp();
    const text = fileOf(rule("r-one"));
    writeRepoRules(cwd, text);
    const path = h.svc.fileFor({ id: randomUUID(), cwd });
    mkdirSync(join(h.dir, "state"), { recursive: true });
    writeFileSync(h.approvalsFile, JSON.stringify({ [`local:${cwd}`]: [rulesHash(text)] }));
    h.svc.tick();
    expect(effective(path)).toEqual([...KORY_IDS, "repo/r-one"]);
  });
});

describe("approvals store", () => {
  test("keeps the most recent hashes per key, set semantics, re-approval moves a hash to the end", () => {
    let a = emptyTtsrApprovals();
    const hashes = Array.from({ length: TTSR_APPROVALS_PER_KEY + 5 }, (_, i) => rulesHash(`v${i}`));
    for (const h of hashes) a = withTtsrApproval(a, "k", h);
    a = withTtsrApproval(a, "k", hashes[10]!);
    const kept = a.keys.k!;
    expect(kept).toHaveLength(TTSR_APPROVALS_PER_KEY);
    expect(kept.at(-1)).toBe(hashes[10]!);
    expect(new Set(kept).size).toBe(kept.length);
    expect(isTtsrApproved(a, "k", hashes[0]!)).toBe(false);
    expect(isTtsrApproved(a, "k", hashes.at(-1)!)).toBe(true);
  });

  test("a corrupt store is reported, not silently empty; malformed entries are dropped with a trace", () => {
    const d = tmp();
    const f = join(d, "a.json");
    const errs: string[] = [];
    expect(readTtsrApprovals(join(d, "missing.json"), (m) => errs.push(m))).toEqual(emptyTtsrApprovals());
    expect(errs, "a missing store is the normal first run, not an error").toEqual([]);
    writeFileSync(f, "{ torn");
    expect(readTtsrApprovals(f, (m) => errs.push(m))).toEqual(emptyTtsrApprovals());
    expect(errs[0]).toContain("not valid JSON");
    const good = rulesHash("x");
    writeFileSync(f, JSON.stringify({ k: [good, "nothex", good], "": [good], j: "x" }));
    expect(readTtsrApprovals(f, (m) => errs.push(m)), "a version-1 store reads as keys with no root").toEqual({ keys: { k: [good] }, roots: {} });
    expect(errs[1]).toContain("dropped");
    writeFileSync(f, JSON.stringify({ version: 2, keys: { k: [good] }, roots: { "/p": good, "rel/p": good, "/q": "nothex" } }));
    expect(readTtsrApprovals(f, (m) => errs.push(m)), "a root must be absolute and map to a sha256").toEqual({
      keys: { k: [good] },
      roots: { "/p": good },
    });
    expect(errs[2]).toContain("dropped 2");
  });
});

describe("toggle keys", () => {
  test("three shapes, project keys may hold slashes, junk is dropped, list is deduplicated and capped", () => {
    expect(isTtsrToggleKey("kory/empty-catch")).toBe(true);
    expect(isTtsrToggleKey("user/my-rule")).toBe(true);
    expect(isTtsrToggleKey("repo/github.com/o/r/my-rule")).toBe(true);
    expect(isTtsrToggleKey("repo/local:abcdef/my-rule")).toBe(true);
    for (const bad of ["kory/", "kory/Bad_Id", "repo/my-rule", "repo//my-rule", "other/x", "user/a/b", 7, null])
      expect(isTtsrToggleKey(bad), String(bad)).toBe(false);
    expect(sanitizeTtsrDisabled(["kory/a", "kory/a", "junk", 3, "user/b"])).toEqual(["kory/a", "user/b"]);
    expect(sanitizeTtsrDisabled("kory/a")).toEqual([]);
    const many = Array.from({ length: TTSR_DISABLED_MAX + 10 }, (_, i) => `user/r${i}`);
    expect(sanitizeTtsrDisabled(many)).toHaveLength(TTSR_DISABLED_MAX);
    expect(() => ttsrToggleKey("repo", "x")).toThrow();
  });
});

describe("paths and symlinks", () => {
  test("a symlinked repo rules.json is refused on read (no rules, no prompt) and on write", async () => {
    const h = harness();
    const cwd = tmp();
    const elsewhere = tmp();
    const target = join(elsewhere, "rules.json");
    writeFileSync(target, fileOf(rule("r-one")));
    mkdirSync(join(cwd, ".claude", "claude-peers"), { recursive: true });
    symlinkSync(target, join(cwd, REPO_RULES_REL));
    const path = h.svc.fileFor({ id: randomUUID(), cwd });
    await flush();
    expect(effective(path)).toEqual(KORY_IDS);
    expect(h.prompts).toEqual([]);
    expect(h.svc.list().projects[0]!.file.errors[0]).toContain("symlink");
    expect(() => repoRulesPathForWrite(cwd)).toThrow(/symlink/);
    const res = await h.svc.saveRepo({ root: cwd, projectKey: `local:${cwd}` }, fileOf(rule("r-two")), null);
    expect(res.ok, "a save over a symlinked leaf is refused").toBe(false);
    expect((res as { errors: string[] }).errors.join("\n")).toContain("symlink");
    expect(readFileSync(target, "utf8"), "the write must not go through the symlink").toContain("r-one");
  });

  test("a .claude directory symlinked outside the project is refused on read and write", () => {
    const h = harness();
    const cwd = tmp();
    const outside = tmp();
    mkdirSync(join(outside, "claude-peers"), { recursive: true });
    writeFileSync(join(outside, "claude-peers", "rules.json"), fileOf(rule("r-one")));
    symlinkSync(outside, join(cwd, ".claude"), "junction");
    h.svc.fileFor({ id: randomUUID(), cwd });
    expect(h.svc.list().projects[0]!.file.errors[0]).toContain("outside the project root");
    expect(() => repoRulesPathForWrite(cwd)).toThrow(/outside the project root/);
  });

  test("a project reached through a symlinked prefix resolves to the same project (canonical roots)", () => {
    const real = tmp();
    const linkParent = tmp();
    const link = join(linkParent, "link");
    symlinkSync(real, link, "junction");
    const h = harness({ resolveProject: undefined });
    const ref = h.svc.projectFor(link);
    expect(ref.root).toBe(realpathSync(real));
    h.svc.fileFor({ id: randomUUID(), cwd: link });
    expect(h.svc.knownProject(link)?.root).toBe(realpathSync(real));
    expect(h.svc.knownProject(real)?.root).toBe(realpathSync(real));
  });

  test("defaultResolveProject takes the git toplevel of a subdirectory", () => {
    const repo = tmp();
    const init = spawnSync("git", ["init", "-q"], { cwd: repo });
    if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
    mkdirSync(join(repo, "sub", "deeper"), { recursive: true });
    const errs: string[] = [];
    const ref = defaultResolveProject(join(repo, "sub", "deeper"), (m) => errs.push(m));
    expect(ref.root).toBe(realpathSync(repo));
    expect(ref.projectKey.startsWith("local:")).toBe(true);
    expect(errs).toEqual([]);
  });
});

describe("operator saves", () => {
  test("saveGlobal validates through the shared parser, writes, recompiles", async () => {
    const h = harness();
    const bad = fileOf({ ...rule("g-one"), extra: 1 });
    expect(await h.svc.saveGlobal(bad, null)).toEqual({
      ok: false,
      reason: "invalid",
      errors: (parseRulesFile(bad) as { errors: string[] }).errors,
    });
    expect(existsSync(h.globalFile)).toBe(false);
    const path = h.svc.fileFor({ id: randomUUID(), cwd: tmp() });
    const good = fileOf(rule("g-one"));
    expect(await h.svc.saveGlobal(good, null)).toEqual({ ok: true, hash: rulesHash(good), approved: true });
    expect(readFileSync(h.globalFile, "utf8")).toBe(good);
    expect(effective(path)).toEqual([...KORY_IDS, "user/g-one"]);
  });

  test("saveRepo writes the file and approves its new hash in the same call", async () => {
    const h = harness();
    const cwd = tmp();
    const path = h.svc.fileFor({ id: randomUUID(), cwd });
    const text = fileOf(rule("r-one"));
    expect(await h.svc.saveRepo({ root: cwd, projectKey: `local:${cwd}` }, text, null)).toEqual({
      ok: true,
      hash: rulesHash(text),
      approved: true,
    });
    expect(readFileSync(join(cwd, REPO_RULES_REL), "utf8")).toBe(text);
    expect(effective(path)).toEqual([...KORY_IDS, "repo/r-one"]);
  });
});

describe("sandbox copy", () => {
  test("the copy mirrors the effective file, follows recompiles, replaces a planted symlink and is restored after tampering", () => {
    const h = harness();
    const id = randomUUID();
    const path = h.svc.fileFor({ id, cwd: tmp() });
    const run = join(h.dir, "sandbox-run", "kory-sbx-x");
    const sid = randomUUID();
    mkdirSync(run, { recursive: true });
    const victim = join(h.dir, "victim.txt");
    writeFileSync(victim, "untouched");
    symlinkSync(victim, join(run, `ttsr-${sid}.json`));
    expect(h.svc.projectIntoSandbox(id, sid, run).file).toBe(`/kory-run/ttsr-${sid}.json`);
    const copy = join(run, `ttsr-${sid}.json`);
    expect(lstatSync(copy).isSymbolicLink(), "the planted symlink must be replaced, not followed").toBe(false);
    expect(readFileSync(victim, "utf8")).toBe("untouched");
    expect(readFileSync(copy, "utf8")).toBe(readFileSync(path, "utf8"));

    h.disabled.push("kory/git-add-all");
    h.svc.recompileAll();
    expect(readFileSync(copy, "utf8")).toBe(readFileSync(path, "utf8"));
    expect(effective(copy)).not.toContain("kory/git-add-all");

    writeFileSync(copy, JSON.stringify({ version: 1, rules: [] }));
    h.svc.tick();
    expect(effective(copy)).toEqual(effective(path));
    expect(h.errors.join("\n")).toContain("were modified or removed; restored");
  });

  test("a non-uuid session id is refused with a trace; a respawn drops the previous copy", () => {
    const h = harness();
    const id = randomUUID();
    const cwd = tmp();
    h.svc.fileFor({ id, cwd });
    const run = join(h.dir, "run");
    expect(h.svc.projectIntoSandbox(id, "x/../y", run)).toEqual({ file: "", log: "" });
    expect(h.errors.join("\n")).toContain("is not a uuid");
    const first = randomUUID();
    h.svc.projectIntoSandbox(id, first, run);
    h.svc.fileFor({ id, cwd });
    expect(existsSync(join(run, `ttsr-${first}.json`))).toBe(false);
  });
});

describe("rule test (isolated regex)", () => {
  test("match, no match, invalid rule, path filter", async () => {
    const h = harness();
    const r = rule("t-one", { paths: ["src/**", "!src/gen/**"] });
    const hit = await h.svc.test(r, "a forbidden-token here", { filePath: "src/a.ts" });
    expect(hit).toEqual({ ok: true, timedOut: false, matched: true, match: { index: 2, text: "forbidden-token" }, pathMatched: true });
    const miss = await h.svc.test(r, "clean", { filePath: "src/gen/a.ts" });
    expect(miss).toEqual({ ok: true, timedOut: false, matched: false, match: null, pathMatched: false });
    const bad = await h.svc.test({ ...r, patern: "x" }, "x");
    expect(bad.ok).toBe(false);
    const badPath = await h.svc.test(r, "x", { filePath: "../etc/passwd" });
    expect(badPath.ok).toBe(false);
    const badTool = await h.svc.test(r, "x", { tool: "Bash" });
    expect(badTool.ok).toBe(false);
    const bash = await h.svc.test(rule("t-bash", { tools: ["Bash"], field: "command", pattern: "^rm\\b" }), "rm -rf x");
    expect(bash).toMatchObject({ ok: true, matched: true });
  });

  test("a catastrophic regex times out in the worker instead of hanging the caller", async () => {
    const t0 = Date.now();
    const res = await matchIsolated("(a|a)*c", "", ["a".repeat(40)], 300);
    expect(res).toEqual({ timedOut: true });
    expect(Date.now() - t0, "the deadline must bound the call").toBeLessThan(3000);
    const h = harness();
    const viaService = await h.svc.test(rule("t-slow", { pattern: "(a|a)*c" }), "a".repeat(40));
    expect(viaService).toEqual({ ok: true, timedOut: true });
  });
});

describe("wiring", () => {
  const SESSION_SERVICE = join(import.meta.dir, "..", "desktop", "src", "main", "session-service.ts");

  test("startPty exports CLAUDE_PEERS_TTSR_FILE and CLAUDE_PEERS_TTSR_LOG on every spawn, after sessionEnv, before the sandbox wrap", () => {
    const src = readFileSync(SESSION_SERVICE, "utf8");
    const m = /private startPty\([^)]*\)[^{]*\{/.exec(src);
    expect(m, "startPty() not found in session-service.ts").not.toBeNull();
    const body = extractBracedBody(src, m!.index + m![0].length - 1);
    const code = body
      .split("\n")
      .map((l) => l.replace(/\/\/.*/, ""))
      .join("\n");
    for (const name of ["CLAUDE_PEERS_TTSR_FILE", "CLAUDE_PEERS_TTSR_LOG"]) {
      const refs = [...code.matchAll(new RegExp(name, "g"))];
      expect(refs.length, `exactly one code reference to ${name}: an unconditional Object.assign onto sessionEnv`).toBe(1);
    }
    const provider = code.indexOf("const ttsr = this.ttsrFiles(def)");
    expect(provider, "both values must come from one call of the injected provider").toBeGreaterThan(-1);
    const assign = code.indexOf(
      "Object.assign(sessionEnv, { CLAUDE_PEERS_TTSR_FILE: ttsr.file, CLAUDE_PEERS_TTSR_LOG: ttsr.log })"
    );
    expect(assign, "the env values must come from the injected provider, unconditionally").toBeGreaterThan(provider);
    const before = code.slice(0, assign);
    expect(/\bif\s*\([^)]*\)\s*$/.test(before.trimEnd()), "the assignment must not sit behind an if").toBe(false);
    expect(assign, "set after the sessionEnv literal").toBeGreaterThan(code.indexOf("const sessionEnv = {"));
    expect(assign, "set before the sandbox wrap reads sessionEnv").toBeLessThan(code.indexOf("this.getSandboxWrapper()"));
  });
});

describe("the three call sites validate through the shared parser", () => {
  const HOOK = join(import.meta.dir, "..", "desktop", "hooks", "ttsr-hook.ts");
  const CLI = join(import.meta.dir, "..", "desktop", "cli", "kory-rules.ts");
  // A rule the engine would enforce if the reader skipped validation: its only
  // defect is an unknown field, which the shared parser rejects.
  const typo = { ...rule("typo"), patern: "x" };

  test("hook: an effective file the shared parser rejects applies no rule", async () => {
    expect(existsSync(HOOK), `hook source missing: ${HOOK}`).toBe(true);
    const { decide } = (await import(HOOK)) as { decide: (p: unknown) => unknown };
    const dir = tmp();
    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      cwd: dir,
      tool_input: { file_path: join(dir, "a.ts"), content: "forbidden-token" },
    };
    const eff = (r: Record<string, unknown>): string =>
      JSON.stringify({ version: 1, rules: [{ ...r, source: "user", qualifiedId: `user/${r.id}` }] });
    const file = join(dir, "eff.json");
    const saved = process.env.CLAUDE_PEERS_TTSR_FILE;
    const savedLog = process.env.CLAUDE_PEERS_TTSR_LOG;
    process.env.CLAUDE_PEERS_TTSR_FILE = file;
    process.env.CLAUDE_PEERS_TTSR_LOG = join(dir, "hook.log");
    try {
      writeFileSync(file, eff(rule("typo")));
      expect(decide(payload), "positive control: the valid rule denies").toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
      writeFileSync(file, eff(typo));
      expect(parseEffectiveFile(readFileSync(file, "utf8")).ok).toBe(false);
      expect(decide(payload), "the hook must reject what the shared parser rejects").toBeNull();
      expect(readFileSync(join(dir, "hook.log"), "utf8"), "rejected for the parser's reason, not a crash").toContain(
        'rules[0] "typo": patern: unknown field'
      );
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_PEERS_TTSR_FILE;
      else process.env.CLAUDE_PEERS_TTSR_FILE = saved;
      if (savedLog === undefined) delete process.env.CLAUDE_PEERS_TTSR_LOG;
      else process.env.CLAUDE_PEERS_TTSR_LOG = savedLog;
    }
  });

  test("CLI check: fails with exactly the shared parser's errors", () => {
    expect(existsSync(CLI), `CLI source missing: ${CLI}`).toBe(true);
    const dir = tmp();
    const file = join(dir, "rules.json");
    const text = fileOf(typo, { ...rule("two"), mode: "block" });
    writeFileSync(file, text);
    // Run from the rules file's own directory: the CLI reads only files of the project it runs in.
    const res = spawnSync(process.execPath, [CLI, "check", file], { encoding: "utf8", cwd: dir });
    expect(res.status).toBe(1);
    const errors = (parseRulesFile(text) as { errors: string[] }).errors;
    expect(errors.length).toBeGreaterThan(1);
    for (const e of errors) expect(res.stdout, `CLI output must list: ${e}`).toContain(e);
  });

  test("Deck main: global load, repo load and both saves report the shared parser's errors", async () => {
    const text = fileOf(typo);
    const expected = (parseRulesFile(text) as { errors: string[] }).errors;
    const h = harness();
    expect(await h.svc.saveGlobal(text, null)).toEqual({ ok: false, reason: "invalid", errors: expected });
    const cwd = tmp();
    expect(await h.svc.saveRepo({ root: cwd, projectKey: `local:${cwd}` }, text, null)).toEqual({
      ok: false,
      reason: "invalid",
      errors: expected,
    });
    mkdirSync(join(h.dir, "config"), { recursive: true });
    writeFileSync(h.globalFile, text);
    writeRepoRules(cwd, text);
    h.svc.tick();
    h.svc.fileFor({ id: randomUUID(), cwd });
    const list = h.svc.list();
    expect(list.global.file.errors).toEqual(expected);
    expect(list.projects[0]!.file.errors).toEqual(expected);
  });
});

describe("pattern timing gate (worker probe)", () => {
  // Cubic backtracking: seconds on 4 Ki word characters, while the validator
  // (no nested quantifier) lets it through.
  const SLOW = "\\w+\\w+\\w+x";
  const until = async (cond: () => boolean, ms = 15000): Promise<void> => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error("condition not reached in time");
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const real = { probeRules: undefined } as Partial<TtsrServiceDeps>;

  test("saveGlobal and saveRepo refuse a slow pattern the parser accepts, and write nothing", async () => {
    const h = harness(real);
    const text = fileOf(rule("g-slow", { pattern: SLOW }));
    expect(parseRulesFile(text).ok, "precondition: the synchronous parser accepts it").toBe(true);
    const res = await h.svc.saveGlobal(text, null);
    expect(res.ok, "a slow pattern must not reach the global file").toBe(false);
    expect((res as { errors: string[] }).errors.join("\n")).toContain('rules[0] "g-slow": pattern: too slow');
    expect(existsSync(h.globalFile)).toBe(false);
    const cwd = tmp();
    const repo = await h.svc.saveRepo({ root: cwd, projectKey: `local:${cwd}` }, text, null);
    expect(repo.ok, "a slow pattern must not reach the repo file").toBe(false);
    expect(existsSync(join(cwd, REPO_RULES_REL))).toBe(false);
  }, 20000);

  test("a slow repo file on disk is never compiled nor prompted; a fast one is, once timed", async () => {
    const h = harness(real);
    h.answer.value = true;
    const slowDir = tmp();
    writeRepoRules(slowDir, fileOf(rule("r-slow", { pattern: SLOW })));
    const fastDir = tmp();
    writeRepoRules(fastDir, fileOf(rule("r-fast")));
    const slowPath = h.svc.fileFor({ id: randomUUID(), cwd: slowDir });
    const fastPath = h.svc.fileFor({ id: randomUUID(), cwd: fastDir });
    expect(h.prompts, "no prompt before the patterns are timed").toEqual([]);
    await until(() => effective(fastPath).includes("repo/r-fast"));
    await until(() => h.svc.list().projects.some((p) => p.file.status === "invalid"));
    expect(effective(slowPath), "a slow repo file contributes no rule").toEqual(KORY_IDS);
    expect(h.prompts.map((p) => p.projectDir), "only the fast file reaches the operator").toEqual([fastDir]);
    const slow = h.svc.list().projects.find((p) => p.projectDir === slowDir)!;
    expect(slow.file.errors.join("\n")).toContain("too slow");
  }, 20000);

  test("the Kory built-ins pass the probe", async () => {
    const { probeRulesSpeed } = await import("../desktop/src/shared/ttsr-probe");
    expect(await probeRulesSpeed(KORY_RULES), "a built-in slow enough to fail the probe would hold every hook call up").toEqual([]);
  }, 20000);
});

describe("hook trace logs", () => {
  test("new lines of a tile's host log reach reportError('ttsr-hook'), bounded per pass, truncation restarts", () => {
    const h = harness();
    const id = randomUUID();
    h.svc.fileFor({ id, cwd: tmp() });
    const log = h.svc.logPathOf(id);
    expect(log.endsWith(`${id}.log`), "the log lives next to the tile's effective file").toBe(true);
    mkdirSync(join(log, ".."), { recursive: true });
    writeFileSync(log, "one\ntwo\npartial");
    h.svc.tick();
    const hook = (): string[] => h.errors.filter((e) => e.startsWith("ttsr-hook: "));
    expect(hook(), "complete lines only; a partial line waits").toEqual([`ttsr-hook: tile ${id}: one`, `ttsr-hook: tile ${id}: two`]);
    writeFileSync(log, "z\n");
    h.svc.tick();
    expect(hook()[2], "a truncated log is read again from its start").toBe(`ttsr-hook: tile ${id}: z`);
    appendFileSync(log, Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n") + "\n");
    h.svc.tick();
    const after = hook().slice(3);
    expect(after.length, "at most TTSR_LOG_TICK_LINES lines plus one summary per pass").toBe(21);
    expect(after[0]).toBe(`ttsr-hook: tile ${id}: l0`);
    expect(after[20]).toContain("+30 more lines suppressed");
  });

  test("a sandbox log replaced by a symlink is refused, never followed", () => {
    const h = harness();
    const id = randomUUID();
    h.svc.fileFor({ id, cwd: tmp() });
    const run = join(h.dir, "run");
    const sid = randomUUID();
    expect(h.svc.projectIntoSandbox(id, sid, run).log).toBe(`/kory-run/ttsr-${sid}.log`);
    const secret = join(h.dir, "host-secret.txt");
    writeFileSync(secret, "TOKEN=abc\n");
    symlinkSync(secret, join(run, `ttsr-${sid}.log`));
    h.svc.tick();
    expect(h.errors.join("\n"), "a host file must never be forwarded through a planted symlink").not.toContain("TOKEN=abc");
    expect(h.errors.join("\n")).toContain("is a symlink, not read");
  });
});

describe("repo rules: any change re-requires approval (per canonical root)", () => {
  const two = (): { v1: string; v2: string } => ({
    v1: fileOf(rule("weak")),
    v2: fileOf(rule("weak"), rule("strict", { pattern: "strict-token" })),
  });

  test("reverting to an OLDER approved hash is pending again, traced once, and prompts after the interval", async () => {
    const h = harness();
    const cwd = tmp();
    const ref: TtsrProjectRef = { root: cwd, projectKey: `local:${cwd}` };
    const { v1, v2 } = two();
    writeRepoRules(cwd, v1);
    const path = h.svc.fileFor({ id: randomUUID(), cwd });
    expect(h.svc.approveRepo(ref, rulesHash(v1))).toEqual({ ok: true });
    writeRepoRules(cwd, v2);
    h.svc.tick();
    expect(h.svc.approveRepo(ref, rulesHash(v2))).toEqual({ ok: true });
    expect(effective(path)).toEqual([...KORY_IDS, "repo/weak", "repo/strict"]);
    const errs = h.errors.length;
    const prompts = h.prompts.length;
    h.clock.now += TTSR_PROMPT_INTERVAL_MS;
    writeRepoRules(cwd, v1);
    h.svc.tick();
    await flush();
    expect(effective(path), "an agent reverting to an older approved version must not weaken the rules silently").toEqual(KORY_IDS);
    expect(h.svc.list().projects[0]!.file.status).toBe("pending");
    expect(h.svc.list().projects[0]!.file.previousHash).toBe(rulesHash(v2));
    expect(h.prompts.slice(prompts).map((p) => p.hash), "the revert asks the operator again").toEqual([rulesHash(v1)]);
    const traced = h.errors.slice(errs).filter((e) => e.includes("no longer apply"));
    expect(traced, "losing applied rules is an operator-visible trace, once per transition").toHaveLength(1);
    expect(h.journal.some((j) => j.includes("no longer apply"))).toBe(true);
    const total = h.errors.filter((e) => e.includes("no longer apply")).length;
    h.svc.tick();
    expect(h.errors.filter((e) => e.includes("no longer apply")), "an unchanged file is not traced again").toHaveLength(total);
  });

  test("deleting an applied file is traced and flagged removedApproved in rules:list", () => {
    const h = harness();
    const cwd = tmp();
    const { v1 } = two();
    const p = writeRepoRules(cwd, v1);
    h.svc.fileFor({ id: randomUUID(), cwd });
    h.svc.approveRepo({ root: cwd, projectKey: `local:${cwd}` }, rulesHash(v1));
    rmSync(p);
    h.svc.tick();
    const file = h.svc.list().projects[0]!.file;
    expect(file.status).toBe("absent");
    expect(file.removedApproved, "a deleted approved file must stay visible in Settings").toBe(true);
    expect(file.previousHash).toBe(rulesHash(v1));
    expect(h.errors.filter((e) => e.includes("the file was deleted")), "the deletion is traced once").toHaveLength(1);
    // The same approved content coming back applies again, without a prompt.
    writeRepoRules(cwd, v1);
    h.svc.tick();
    expect(h.svc.list().projects[0]!.file.status).toBe("approved");
    expect(h.svc.list().projects[0]!.file.removedApproved).toBeUndefined();
  });

  test("a NEW worktree applies a key-approved hash and adopts it; another key-approved hash there is pending", () => {
    const h = harness();
    const wtA = tmp();
    const wtB = tmp();
    h.keys.set(wtA, "github.com/o/r");
    h.keys.set(wtB, "github.com/o/r");
    const { v1, v2 } = two();
    writeRepoRules(wtA, v1);
    h.svc.fileFor({ id: randomUUID(), cwd: wtA });
    h.svc.approveRepo({ root: wtA, projectKey: "github.com/o/r" }, rulesHash(v1));
    writeRepoRules(wtA, v2);
    h.svc.tick();
    h.svc.approveRepo({ root: wtA, projectKey: "github.com/o/r" }, rulesHash(v2));
    writeRepoRules(wtB, v2);
    const pb = h.svc.fileFor({ id: randomUUID(), cwd: wtB });
    expect(effective(pb), "a new worktree of an approved project applies its approved file").toEqual([
      ...KORY_IDS,
      "repo/weak",
      "repo/strict",
    ]);
    expect(readTtsrApprovals(h.approvalsFile, () => {}).roots[wtB], "the adopted hash becomes wtB's current").toBe(rulesHash(v2));
    writeRepoRules(wtB, v1);
    h.svc.tick();
    expect(effective(pb), "once adopted, an older key-approved hash is pending at that root").toEqual(KORY_IDS);
  });
});

describe("operator saves: base hash and approval rules", () => {
  test("saveGlobal and saveRepo refuse a stale base (the file changed since the editor opened it)", async () => {
    const h = harness();
    mkdirSync(join(h.dir, "config"), { recursive: true });
    const g1 = fileOf(rule("g-one"));
    writeFileSync(h.globalFile, g1);
    h.svc.tick();
    const g2 = fileOf(rule("g-two"));
    expect(await h.svc.saveGlobal(g2, null), "saving over a file the editor did not see").toMatchObject({ ok: false, reason: "stale" });
    expect(readFileSync(h.globalFile, "utf8")).toBe(g1);
    expect(await h.svc.saveGlobal(g2, rulesHash(g1))).toEqual({ ok: true, hash: rulesHash(g2), approved: true });

    const cwd = tmp();
    const ref: TtsrProjectRef = { root: cwd, projectKey: `local:${cwd}` };
    h.svc.fileFor({ id: randomUUID(), cwd });
    const r1 = fileOf(rule("r-one"));
    expect(await h.svc.saveRepo(ref, r1, null)).toEqual({ ok: true, hash: rulesHash(r1), approved: true });
    const agent = fileOf(rule("r-one", { mode: "warn" }));
    writeRepoRules(cwd, agent);
    const mine = fileOf(rule("r-one"), rule("r-two"));
    expect(await h.svc.saveRepo(ref, mine, rulesHash(r1)), "the agent rewrote the file after the editor opened it").toMatchObject({
      ok: false,
      reason: "stale",
    });
    expect(readFileSync(join(cwd, REPO_RULES_REL), "utf8")).toBe(agent);
  });

  test("saveRepo over a PENDING base is refused: the operator would approve agent content unseen", async () => {
    const h = harness();
    const cwd = tmp();
    const ref: TtsrProjectRef = { root: cwd, projectKey: `local:${cwd}` };
    const agent = fileOf(rule("r-agent"));
    writeRepoRules(cwd, agent);
    h.svc.fileFor({ id: randomUUID(), cwd });
    const res = await h.svc.saveRepo(ref, fileOf(rule("r-agent"), rule("r-mine")), rulesHash(agent));
    expect(res, "a pending base must be reviewed and approved first").toMatchObject({ ok: false, reason: "pending" });
    expect(readFileSync(join(cwd, REPO_RULES_REL), "utf8")).toBe(agent);
  });

  test("saveRepo over an INVALID base writes the file but leaves it pending (approved: false)", async () => {
    const h = harness();
    const cwd = tmp();
    const ref: TtsrProjectRef = { root: cwd, projectKey: `local:${cwd}` };
    const broken = "{ not json";
    writeRepoRules(cwd, broken);
    const path = h.svc.fileFor({ id: randomUUID(), cwd });
    const fixed = fileOf(rule("r-fixed"));
    expect(await h.svc.saveRepo(ref, fixed, rulesHash(broken))).toEqual({ ok: true, hash: rulesHash(fixed), approved: false });
    expect(readFileSync(join(cwd, REPO_RULES_REL), "utf8")).toBe(fixed);
    expect(effective(path), "content fixed from an invalid (possibly agent-written) base is not approved by the save").toEqual(KORY_IDS);
    expect(h.svc.list().projects[0]!.file.status).toBe("pending");
  });

  test("the IPC handlers pass expectedHash through, validated as null or a sha256", () => {
    const src = readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "ipc.ts"), "utf8");
    const anchor = src.indexOf("const requireExpectedHash = (hash: unknown): string | null =>");
    expect(anchor, "ipc.ts must validate expectedHash in requireExpectedHash").toBeGreaterThan(-1);
    const body = extractBracedBody(src, src.indexOf("{", anchor));
    expect(body, "expectedHash crossing the renderer boundary must be validated main-side").toContain("/^[0-9a-f]{64}$/");
    expect(src).toContain("ttsr.saveGlobal(requireText(text), requireExpectedHash(expectedHash))");
    expect(src).toContain("ttsr.saveRepo(await rulesProject(dir), requireText(text), requireExpectedHash(expectedHash))");
  });
});

describe("hostile files: no hang, no read outside, bounded", () => {
  test("readBounded refuses a symlink leaf, a non-regular file, a file past the cap and a replaced inode", () => {
    const d = tmp();
    const f = join(d, "f.json");
    writeFileSync(f, "x".repeat(100));
    const ok = readBounded(f, { cap: 100 });
    expect(ok.kind).toBe("ok");
    expect(readBounded(f, { cap: 99 }), "a file past the cap is refused, not read").toMatchObject({ kind: "refused" });
    expect(readBounded(f, { cap: 10, overflow: "truncate" })).toMatchObject({ kind: "ok", truncated: true });
    const link = join(d, "l.json");
    symlinkSync(f, link);
    expect(readBounded(link, { cap: 1000 }), "a symlink leaf is never followed").toMatchObject({ kind: "refused", reason: "is a symlink" });
    expect(readBounded(link, { cap: 1000, follow: true }).kind).toBe("ok");
    expect(readBounded(d, { cap: 1000 }), "a directory is not a regular file").toMatchObject({ kind: "refused" });
    const st = lstatSync(f);
    expect(readBounded(f, { cap: 1000, expect: { dev: st.dev, ino: st.ino + 1 } }), "an inode other than the lstat's is refused").toMatchObject({
      kind: "refused",
    });
    expect(readBounded(join(d, "missing"), { cap: 1 })).toEqual({ kind: "absent" });
  });

  test.skipIf(process.platform === "win32")("a FIFO as repo rules.json or as a hook log never blocks Deck main", () => {
    const h = harness();
    const cwd = tmp();
    mkdirSync(join(cwd, ".claude", "claude-peers"), { recursive: true });
    const mk = spawnSync("mkfifo", [join(cwd, REPO_RULES_REL)]);
    if (mk.status !== 0) throw new Error(`mkfifo failed: ${mk.stderr}`);
    const id = randomUUID();
    const t0 = Date.now();
    h.svc.fileFor({ id, cwd });
    expect(h.svc.list().projects[0]!.file.status, "a FIFO rules file is invalid, never opened for a blocking read").toBe("invalid");
    const log = h.svc.logPathOf(id);
    mkdirSync(join(log, ".."), { recursive: true });
    spawnSync("mkfifo", [log]);
    h.svc.tick();
    expect(Date.now() - t0, "no FIFO may block the rules poll").toBeLessThan(2000);
    expect(h.errors.join("\n")).toContain("is not a regular file, not read");
  });

  test("a repo rules file larger than the cap is invalid without being read", () => {
    const h = harness();
    const cwd = tmp();
    writeRepoRules(cwd, " ".repeat(MAX_FILE_BYTES + 1));
    h.svc.fileFor({ id: randomUUID(), cwd });
    const file = h.svc.list().projects[0]!.file;
    expect(file.status).toBe("invalid");
    expect(file.text, "an oversized file must not be loaded").toBeNull();
    expect(file.errors.join("\n")).toContain("exceeds");
  });

  test("repoRulesPathForWrite creates nothing outside when .claude points outside the root", () => {
    const cwd = tmp();
    const outside = tmp();
    symlinkSync(outside, join(cwd, ".claude"), "junction");
    expect(() => repoRulesPathForWrite(cwd)).toThrow(/outside the project root/);
    expect(existsSync(join(outside, "claude-peers")), "no directory may be created through the symlink before the check").toBe(false);
    const dangling = tmp();
    symlinkSync(join(outside, "not-yet"), join(dangling, ".claude"), "junction");
    expect(() => repoRulesPathForWrite(dangling)).toThrow(/symlink|outside/);
    expect(existsSync(join(outside, "not-yet")), "a dangling symlink is not followed by mkdir").toBe(false);
  });

  test("a host effective file modified or deleted outside the Deck is rewritten, with a trace", () => {
    const h = harness();
    const path = h.svc.fileFor({ id: randomUUID(), cwd: tmp() });
    writeFileSync(path, JSON.stringify({ version: 1, rules: [] }));
    h.svc.tick();
    expect(effective(path), "an emptied effective file must be restored on the next poll").toEqual(KORY_IDS);
    rmSync(path);
    h.svc.tick();
    expect(effective(path), "a deleted effective file must be restored on the next poll").toEqual(KORY_IDS);
    expect(h.errors.filter((e) => e.includes("modified or removed outside the Deck"))).toHaveLength(2);
  });
});

describe("dialogs, memos and probe workers are bounded", () => {
  test("one open dialog per root; a change meanwhile is coalesced; the interval holds later ones", async () => {
    const h = harness();
    const cwd = tmp();
    let close: (v: boolean) => void = () => {};
    const svc = new TtsrService({
      globalRulesFile: () => h.globalFile,
      approvalsFile: () => h.approvalsFile,
      sessionDir: () => join(h.dir, "state", "sessions", "g"),
      getDisabled: () => [],
      reportError: (s, m) => h.errors.push(`${s}: ${m}`),
      journal: () => {},
      promptApproval: (req) => {
        h.prompts.push(req);
        return new Promise<boolean>((r) => (close = r));
      },
      onChanged: () => {},
      resolveProject: (c) => ({ root: c, projectKey: `local:${c}` }),
      defer: (fn) => fn(),
      now: () => h.clock.now,
      probeRules: () => [],
    });
    writeRepoRules(cwd, fileOf(rule("a")));
    svc.fileFor({ id: randomUUID(), cwd });
    for (let i = 0; i < 5; i++) {
      h.clock.now += TTSR_PROMPT_INTERVAL_MS;
      writeRepoRules(cwd, fileOf(rule(`b${i}`)));
      svc.tick();
    }
    expect(h.prompts, "an agent rewriting its file must not stack dialogs for one root").toHaveLength(1);
    close(false);
    await flush();
    expect(h.prompts.map((p) => p.rules[0]!.id), "closing re-evaluates the CURRENT content only").toEqual(["a", "b4"]);
    close(false);
    await flush();
    writeRepoRules(cwd, fileOf(rule("c")));
    svc.tick();
    await flush();
    expect(h.prompts, "a change inside the interval waits in Settings, no dialog").toHaveLength(2);
  });

  test("per-run memos are bounded structures", () => {
    const h = harness();
    const svc = h.svc as unknown as Record<string, unknown>;
    for (const name of ["prompted", "reportedInvalid"]) {
      expect(svc[name] instanceof BoundedSet, `${name} must be bounded: every agent rewrite mints a new key`).toBe(true);
    }
    for (const name of ["probes", "lastPromptAt"]) {
      expect(svc[name] instanceof BoundedMap, `${name} must be bounded: every agent rewrite mints a new key`).toBe(true);
    }
    const set = new BoundedSet(3);
    for (const k of ["a", "b", "c", "d"]) set.add(k);
    expect(set.has("a"), "the oldest entry is evicted past the cap").toBe(false);
    expect(set.has("d")).toBe(true);
    const map = new BoundedMap<number>(2);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    expect(map.size).toBe(2);
    expect(map.get("a")).toBeUndefined();
  });

  test(`at most TTSR_PROBE_CONCURRENCY probes run at once; the rest queue`, async () => {
    const releases: Array<() => void> = [];
    let started = 0;
    const h = harness({
      probeRules: () => {
        started++;
        return new Promise<string[]>((r) => releases.push(() => r([])));
      },
    });
    const dirs = Array.from({ length: 5 }, () => tmp());
    dirs.forEach((d, i) => {
      writeRepoRules(d, fileOf(rule(`r${i}`)));
      h.svc.fileFor({ id: randomUUID(), cwd: d });
    });
    expect(started, "each probe holds a worker thread: the count must be capped").toBe(TTSR_PROBE_CONCURRENCY);
    releases.shift()!();
    await flush();
    expect(started, "a finished probe lets the next queued one start").toBe(TTSR_PROBE_CONCURRENCY + 1);
    while (releases.length > 0) {
      releases.shift()!();
      await flush();
    }
    expect(started).toBe(5);
  });
});

describe("hook log forwarding is sanitized and rate-limited per tile", () => {
  test("control characters neutralized, lines truncated, <= TTSR_LOG_MINUTE_LINES per minute then one summary", () => {
    const h = harness();
    const id = randomUUID();
    h.svc.fileFor({ id, cwd: tmp() });
    const log = h.svc.logPathOf(id);
    mkdirSync(join(log, ".."), { recursive: true });
    writeFileSync(log, `evil \u001b[2J\u202etext ${"z".repeat(2000)}\n`);
    h.svc.tick();
    const hook = (): string[] => h.errors.filter((e) => e.startsWith("ttsr-hook: "));
    const first = hook()[0]!;
    expect(first, "an escape sequence from a sandbox log must not reach the Deck log raw").not.toContain("\u001b");
    expect(first).not.toContain("\u202e");
    expect(first.length, "a forwarded line is truncated").toBeLessThan(TTSR_LOG_LINE_CHARS + 100);
    for (let t = 0; t < 15; t++) {
      appendFileSync(log, Array.from({ length: 30 }, (_, i) => `t${t}-${i}`).join("\n") + "\n");
      h.svc.tick();
    }
    const lines = hook().filter((l) => !l.includes("suppressed"));
    expect(lines.length, "per-minute cap on forwarded lines of one tile").toBeLessThanOrEqual(TTSR_LOG_MINUTE_LINES);
    const before = hook().length;
    h.clock.now += 60_000;
    h.svc.tick();
    const summary = hook().slice(before);
    expect(summary.some((l) => /\+\d+ more lines suppressed/.test(l)), "the suppressed count is reported once the window rolls").toBe(true);
  });
});
