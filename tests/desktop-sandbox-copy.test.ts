// PLAN-SANDBOX M3: ephemeral-copy selection (glob matching + the hard deny
// list that always wins) — desktop/src/main/sandbox-copy.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SKIP_DIRS,
  globToRegExp,
  isDeniedCopyPath,
  planIgnoredCopy,
  selectCopyPaths,
  walkProjectFiles,
} from "../desktop/src/main/sandbox-copy.ts";
import { onDeckError } from "../desktop/src/main/log.ts";

/** Capture reportError('sandbox', ...) calls via the Journal hook (card 5ff9a432). */
function captureDeckErrors(): { scope: string; text: string }[] {
  const captured: { scope: string; text: string }[] = [];
  onDeckError((scope, text) => captured.push({ scope, text }));
  return captured;
}

test("globToRegExp: * stays inside a segment, ** crosses", () => {
  expect(globToRegExp("PLAN-*.md").test("PLAN-A.md")).toBe(true);
  expect(globToRegExp("PLAN-*.md").test("docs/PLAN-A.md")).toBe(false);
  expect(globToRegExp("docs/**").test("docs/a/b.md")).toBe(true);
  expect(globToRegExp("docs/**/x.md").test("docs/x.md")).toBe(true);
  expect(globToRegExp("docs/**/x.md").test("docs/a/b/x.md")).toBe(true);
  expect(globToRegExp("note?.txt").test("note1.txt")).toBe(true);
  expect(globToRegExp("note?.txt").test("note12.txt")).toBe(false);
  // Regex metacharacters in a glob are literals, not operators.
  expect(globToRegExp("a+b.md").test("a+b.md")).toBe(true);
  expect(globToRegExp("a+b.md").test("aab.md")).toBe(false);
});

test("deny list covers secrets, keys and dependency bulk", () => {
  for (const p of [
    ".env",
    ".env.local",
    "sub/.env.production",
    "node_modules/x/index.js",
    ".git/config",
    ".ssh/id_rsa",
    "certs/server.pem",
    "app.key",
    ".aws/credentials",
    "id_ed25519",
  ]) {
    expect(isDeniedCopyPath(p)).toBe(true);
  }
  for (const p of ["PLAN-SANDBOX.md", "docs/notes.md", "environment.md", "keys.md"]) {
    expect(isDeniedCopyPath(p)).toBe(false);
  }
});

// Negative-coverage matrix (audit findings 1-7, roadmap card 94f8cc0c). Each
// entry here was measured RED against the pre-fix DENY_PATTERNS -- see the
// "known-good/pre-fix" note below for the one exception kept anyway.
test("deny list: escaped/missing secret-file forms are now denied (findings 1-3)", () => {
  for (const p of [
    ".envrc", // was escaping on the "r" -- (^|/)\.env($|\.) needs end-or-dot
    ".env-local", // was escaping on the hyphen
    "prod.env", // suffix form: START anchor required ".env" at segment start
    "dev.env",
    ".env.vault", // NOTE: this one was already caught pre-fix (dot follows
    // ".env", which the old pattern's ($|\.) alternative allowed) -- kept
    // here as a legitimate secret-file case, not as regression coverage.
    ".dev.vars", // wrangler-style secrets file, not ".env"-prefixed at all
    "release.keystore", // finding 2: /\.key$/ covers neither .keystore nor .jks
    "upload-keystore.jks",
    "keystore.properties",
    ".git-credentials", // finding 3: NOT covered by the .git pattern (hyphen
    // breaks "(^|/)\.git(\/|$)"), despite reading as though it would be
    ".pgpass",
    ".htpasswd",
    "kubeconfig",
    ".docker/config.json",
    ".terraformrc",
    "secrets.json",
    ".pypirc",
  ]) {
    expect(isDeniedCopyPath(p)).toBe(true);
  }
});

test("deny list: case-insensitive on every pattern (finding 4)", () => {
  for (const p of [
    ".ENV",
    ".ENV.local",
    "ID_RSA",
    "server.PEM",
    "app.KEY",
    "Cert.P12",
    ".SSH/config", // was RED pre-fix (case-sensitive (^|\/)\.ssh(\/|$) missed it)
    ".AWS/credentials",
  ]) {
    expect(isDeniedCopyPath(p)).toBe(true);
  }
});

test("deny list: suffix decoration cannot defeat a $-anchored extension (finding 5)", () => {
  for (const p of [
    "server.pem.bak",
    "key.pem~",
    ".worktrees/x/.env-secret",
  ]) {
    expect(isDeniedCopyPath(p)).toBe(true);
  }
});

test("deny list: SKIP_DIRS is backstopped, not the sole enforcer (finding 6)", () => {
  for (const p of [".cache/pip/creds", "build/creds", "out/token.txt"]) {
    expect(isDeniedCopyPath(p)).toBe(true);
  }
});

// Mutation-tested by the reviewer: deleting any one of these 5 DENY_PATTERNS
// entries (.secrets, .npmrc, bare `credentials`, extDeny('pfx'), extDeny('p8'))
// left the suite green -- nothing above exercised them directly.
test("deny list: patterns with no prior probe (review round 2, card 94f8cc0c)", () => {
  for (const p of [".secrets/x", ".npmrc", "credentials", "cert.pfx", "apns.p8"]) {
    expect(isDeniedCopyPath(p)).toBe(true);
  }
});

// Extension-token-in-directory-component regression (review round 2, card
// 94f8cc0c): before the extDeny fix, nothing stopped `/` from following the
// extension, so the whole subtree under a directory NAMED like a key/cert
// file silently stopped arriving.
test("deny list: extDeny does not cross a directory segment boundary", () => {
  for (const p of ["foo.key/bar.txt", "test.p12.fixtures/readme.md", "a.p8.notes/readme.md"]) {
    expect(isDeniedCopyPath(p)).toBe(false);
  }
  // Same-segment decoration is still denied -- the residual, documented trade.
  for (const p of ["app.key-mapping.json", "docs/api.key-rotation.md", "deploy.pem_notes.md"]) {
    expect(isDeniedCopyPath(p)).toBe(true);
  }
});

test("deny list: non-regression -- pre-existing denials still deny (green in both arms)", () => {
  for (const p of [
    ".env",
    ".env.local",
    "sub/.env",
    ".ssh/id_rsa",
    "id_ed25519",
    "certs/server.pem",
    "app.key",
    ".netrc",
  ]) {
    expect(isDeniedCopyPath(p)).toBe(true);
  }
});

test("deny list: anti-overblock -- legitimate lookalike files stay allowed", () => {
  for (const p of [
    "environment.md",
    "keys.md",
    "readme.env.md",
    "src/env.ts",
    "lib/keyboard.ts",
    "docs/PLAN-A.md",
    "notes/config.json",
  ]) {
    expect(isDeniedCopyPath(p)).toBe(false);
  }
});

test("deny list: card 5ff9a432 build/dependency dirs (target, vendor, Pods, .gradle)", () => {
  for (const p of [
    "target/classes/App.class",
    "vendor/pkg/a.php",
    "Pods/Alamofire/a.m",
    ".gradle/caches/x",
  ]) {
    expect(isDeniedCopyPath(p)).toBe(true);
  }
});

test("deny list: card 5ff9a432 dirs match only an exact path segment, not a substring", () => {
  for (const p of [
    "my-target/file.txt",
    "target-audience.md",
    "vendors/a.txt",
    "PodsExtra/a.txt",
    ".gradlew",
  ]) {
    expect(isDeniedCopyPath(p)).toBe(false);
  }
});

test("structural: every SKIP_DIRS entry is also denied by DENY_PATTERNS (finding 6)", () => {
  // Enumerated FROM the exported SKIP_DIRS set itself, not a hardcoded copy,
  // so a future addition to SKIP_DIRS that forgets deny coverage fails this
  // test closed instead of silently reopening a copy path.
  expect(SKIP_DIRS.size).toBeGreaterThan(0);
  for (const dir of SKIP_DIRS) {
    expect(isDeniedCopyPath(`${dir}/x`)).toBe(true);
  }
});

// The loop above iterates the live Set, so removing an entry removes its own
// assertion too -- growth is covered, shrinkage is not.
// Pins the content as a literal so a removed entry fails closed instead of
// silently narrowing the loop above.
test("structural: SKIP_DIRS content is pinned (review round 2, card 94f8cc0c)", () => {
  expect([...SKIP_DIRS].sort()).toEqual([
    ".cache",
    ".git",
    ".gradle",
    ".next",
    ".venv",
    ".worktrees",
    "Pods",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "out",
    "target",
    "vendor",
  ]);
});

test("structural: isDeniedCopyPath normalizes backslashes itself (finding 7)", () => {
  // Independent of walkProjectFiles/selectCopyPaths' own normalization --
  // the guarantee must travel with the exported function.
  expect(isDeniedCopyPath("sub\\.env")).toBe(true);
  expect(isDeniedCopyPath(".git\\config")).toBe(true);
});

test("selectCopyPaths: bare filename patterns match at any depth", () => {
  const all = ["PLAN-A.md", "docs/PLAN-B.md", "src/index.ts"];
  expect(selectCopyPaths(all, ["PLAN-*.md"])).toEqual(["PLAN-A.md", "docs/PLAN-B.md"]);
  // A pattern WITH a separator is anchored and does not gain the **/ variant.
  expect(selectCopyPaths(all, ["docs/PLAN-*.md"])).toEqual(["docs/PLAN-B.md"]);
});

test("selectCopyPaths: the deny list beats an explicit allow glob", () => {
  const all = [".env", ".env.local", "notes.md", "node_modules/pkg/a.js"];
  // The operator asks for EVERYTHING; secrets and bulk still stay behind.
  expect(selectCopyPaths(all, ["**"])).toEqual(["notes.md"]);
  expect(selectCopyPaths(all, [".env"])).toEqual([]);
});

test("selectCopyPaths: no globs copies nothing", () => {
  expect(selectCopyPaths(["a.md"], [])).toEqual([]);
  expect(selectCopyPaths(["a.md"], ["  "])).toEqual([]);
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cp-sandbox-copy-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  onDeckError(() => {}); // don't leak a test-local listener into later tests/files
});

test("walkProjectFiles skips heavy dirs and returns posix-relative paths", () => {
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, "PLAN-A.md"), "x");
  writeFileSync(join(dir, "docs", "note.md"), "x");
  writeFileSync(join(dir, "node_modules", "pkg", "a.js"), "x");
  writeFileSync(join(dir, ".git", "config"), "x");

  const files = walkProjectFiles(dir).sort();
  expect(files).toEqual(["PLAN-A.md", "docs/note.md"]);
});

test("planIgnoredCopy reports patterns that matched nothing", () => {
  writeFileSync(join(dir, "PLAN-A.md"), "x");
  writeFileSync(join(dir, ".env"), "SECRET=1");
  const plan = planIgnoredCopy(dir, ["PLAN-*.md", "missing-*.txt", ".env"]);
  expect(plan.files).toEqual(["PLAN-A.md"]);
  // `.env` matched a real file that the deny-list then blocked -- a refusal,
  // not a typo, so it belongs in `denied`, not `unmatched` (card 72f0ce22:
  // both used to collapse to `unmatched`, so the operator could not tell a
  // typo apart from "everything this glob found was blocked").
  expect(plan.unmatched).toEqual(["missing-*.txt"]);
  expect(plan.denied).toEqual([".env"]);
});

test("planIgnoredCopy: glob partially denied keeps the allowed files AND reports the denied ones, never as unmatched", () => {
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "guide.md"), "x");
  writeFileSync(join(dir, "docs", "id_rsa"), "SECRET");
  const plan = planIgnoredCopy(dir, ["docs/**"]);
  expect(plan.files).toEqual(["docs/guide.md"]);
  expect(plan.unmatched).toEqual([]);
  expect(plan.denied).toEqual(["docs/id_rsa"]);
});

test("planIgnoredCopy: a glob whose entire target is a walk-skipped bulk dir is denied, not unmatched", () => {
  // node_modules is pruned by SKIP_DIRS before the walk ever visits it, so
  // selectRawMatches sees zero candidates -- indistinguishable from a typo
  // without globIsDenied reusing the DENY_PATTERNS regex directly.
  mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "pkg", "a.js"), "x");
  writeFileSync(join(dir, "PLAN-A.md"), "x");
  const plan = planIgnoredCopy(dir, ["PLAN-*.md", "node_modules/**"]);
  expect(plan.files).toEqual(["PLAN-A.md"]);
  expect(plan.unmatched).toEqual([]);
  expect(plan.denied).toEqual(["node_modules/**"]);
});

test("planIgnoredCopy: globIsDenied does not false-positive on a name that merely looks like a denied segment", () => {
  mkdirSync(join(dir, "dist-docs"), { recursive: true });
  writeFileSync(join(dir, "dist-docs", "guide.md"), "x");
  const plan = planIgnoredCopy(dir, ["dist-docs/**"]);
  expect(plan.files).toEqual(["dist-docs/guide.md"]);
  expect(plan.unmatched).toEqual([]);
  expect(plan.denied).toEqual([]);
});

// Probe table below locks in every row a review round raised for
// globIsDenied against a SKIP_DIRS-pruned glob (zero raw matches, so the
// verdict comes only from the static segment scan, never from a real walk).
test.each([
  ["node_modules/**", true],
  ["nested/node_modules/**", true],
  [".git/**", true],
  // Leading-wildcard forms of "at any depth" -- the MAJOR fix: an earlier
  // version tested only the literal PREFIX (text before the first
  // wildcard), which is the empty string for both of these, so both were
  // wrongly reported `unmatched` (implying a fixable typo) instead of
  // `denied` (unfixable by retyping).
  ["**/node_modules/**", true],
  ["*/node_modules/**", true],
  // Same name, not a denied segment (segment-bounded matching, unchanged by
  // the MAJOR fix): must still not trip the `dist` pattern.
  ["dist-docs/**", false],
])("planIgnoredCopy: SKIP_DIRS-pruned glob %s classifies as denied=%s", (glob, expectDenied) => {
  mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "pkg", "a.js"), "x");
  mkdirSync(join(dir, "nested", "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(dir, "nested", "node_modules", "pkg", "a.js"), "x");
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "config"), "x");
  mkdirSync(join(dir, "dist-docs"), { recursive: true });
  writeFileSync(join(dir, "dist-docs", "guide.md"), "x");

  const plan = planIgnoredCopy(dir, [glob]);
  if (expectDenied) {
    expect(plan.denied).toEqual([glob]);
    expect(plan.unmatched).toEqual([]);
  } else {
    expect(plan.denied).toEqual([]);
  }
});

test("planIgnoredCopy: a non-last literal segment only denies via a subtree-shaped pattern, not an extDeny/end-anchored one (false-positive review catch)", () => {
  // report.key/** must NOT be denied: extDeny('key') matches the isolated
  // segment "report.key", but a real candidate path "report.key/notes.md"
  // does not match it (extDeny excludes "/" from its decoration by design,
  // so a directory merely NAMED like a denied extension stays copyable).
  // globIsDenied's first pass tested every segment against the full pattern
  // set unconditionally and would have wrongly denied this.
  mkdirSync(join(dir, "report.key"), { recursive: true });
  writeFileSync(join(dir, "report.key", "notes.md"), "x");
  const plan = planIgnoredCopy(dir, ["report.key/**"]);
  expect(plan.files).toEqual(["report.key/notes.md"]);
  expect(plan.denied).toEqual([]);
  expect(plan.unmatched).toEqual([]);
});

test("planIgnoredCopy: a bare glob whose LAST segment is itself extDeny-triggered is denied, not unmatched", () => {
  // Deliberately NOT a "dir/**" subtree glob (see the test above: a real
  // app.key-mapping/** subtree glob would not be denied, since extDeny does
  // not deny a directory's contents). This glob's own text is instead the
  // exact name a matching FILE would have, with no wildcard suffix, so it
  // is the terminal-segment branch of globIsDenied (the one entitled to use
  // the full pattern set) that classifies it. No file named exactly
  // "app.key-mapping" exists in this project, so selectRawMatches sees zero
  // candidates and the verdict comes from the static segment scan.
  writeFileSync(join(dir, "PLAN-A.md"), "x");
  const plan = planIgnoredCopy(dir, ["app.key-mapping"]);
  expect(plan.files).toEqual([]);
  expect(plan.unmatched).toEqual([]);
  expect(plan.denied).toEqual(["app.key-mapping"]);
});

test("walkProjectFiles never follows symlinks (foreign files, and infinite loops)", () => {
  // Following links let copy-mode globs pull files from OUTSIDE the repo into
  // the sandbox clone, and a self-referential link made this synchronous walk
  // spin forever — the file cap could not stop it, a link loop yields no files.
  const outside = mkdtempSync(join(tmpdir(), "cp-outside-"));
  writeFileSync(join(outside, "secret.md"), "not yours");
  try {
    writeFileSync(join(dir, "own.md"), "mine");
    symlinkSync(outside, join(dir, "linked-dir"), "junction");
    symlinkSync(join(outside, "secret.md"), join(dir, "linked-file.md"));
    symlinkSync(dir, join(dir, "self"), "junction"); // the loop

    const files = walkProjectFiles(dir);
    expect(files).toEqual(["own.md"]);
    // Nothing from outside the tree can be selected, even by a greedy glob.
    expect(selectCopyPaths(files, ["**"])).toEqual(["own.md"]);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

// Card 5ff9a432: hitting MAX_WALK_ENTRIES/MAX_WALK_VISITS used to truncate
// the copy plan with zero trace anywhere. `limits` overrides the caps so the
// probe stays fast instead of materializing 20k+ real files.
test("walkProjectFiles: no truncation trace when the tree is well under both caps", () => {
  const captured = captureDeckErrors();
  writeFileSync(join(dir, "a.md"), "x");
  writeFileSync(join(dir, "b.md"), "x");
  const files = walkProjectFiles(dir, { maxEntries: 10, maxVisits: 10 });
  expect(files.length).toBe(2);
  expect(captured).toEqual([]);
});

test("walkProjectFiles: hitting the cap exactly as the tree naturally ends is NOT reported as truncated", () => {
  // Guards against checking the cap after pushing a file rather than before
  // consuming the next name, which would falsely flag truncation even though
  // nothing was left unvisited.
  const captured = captureDeckErrors();
  writeFileSync(join(dir, "a.md"), "x");
  writeFileSync(join(dir, "b.md"), "x");
  const files = walkProjectFiles(dir, { maxEntries: 2 });
  expect(files.length).toBe(2);
  expect(captured).toEqual([]);
});

test("walkProjectFiles: reports a truncation trace via reportError when MAX_WALK_ENTRIES is hit (card 5ff9a432)", () => {
  for (const name of ["a.md", "b.md", "c.md"]) writeFileSync(join(dir, name), "x");
  const captured = captureDeckErrors();
  const files = walkProjectFiles(dir, { maxEntries: 2 });
  expect(files.length).toBe(2);
  expect(captured.length).toBe(1);
  expect(captured[0].scope).toBe("sandbox");
  expect(captured[0].text).toContain("copy plan truncated");
  expect(captured[0].text).toContain("2");
});

test("walkProjectFiles: reports a truncation trace when MAX_WALK_VISITS is hit mid-directory (card 5ff9a432)", () => {
  for (const name of ["a.md", "b.md", "c.md", "d.md"]) writeFileSync(join(dir, name), "x");
  const captured = captureDeckErrors();
  const files = walkProjectFiles(dir, { maxVisits: 2 });
  // Two names never get visited at all (cut off mid-readdir batch) -- distinct
  // from the entries cap, and the stack is already empty when it fires (this
  // was the flat single-directory dual of the "last stack frame" edge case).
  expect(files.length).toBe(2);
  expect(captured.length).toBe(1);
  expect(captured[0].text).toContain("copy plan truncated");
});

test("walkProjectFiles: reports exactly once when the cap fires while sibling directories are still pending", () => {
  mkdirSync(join(dir, "dirA"));
  mkdirSync(join(dir, "dirB"));
  writeFileSync(join(dir, "dirA", "a.md"), "x");
  writeFileSync(join(dir, "dirB", "b.md"), "x");
  const captured = captureDeckErrors();
  const files = walkProjectFiles(dir, { maxEntries: 1 });
  // One of the two sibling dirs never gets explored at all -- the LIFO stack
  // still held it when the cap fired.
  expect(files.length).toBe(1);
  expect(captured.length).toBe(1);
});

// Audit 94f8cc0c round 2 (reviewer): nothing kept globToRegExp/expandCopyGlob
// in lock-step between this file and shared/types.ts -- the next edit to
// either copy would diverge in BEHAVIOR, silently, with no test failing.
// Compare the two bodies verbatim (doc comments excluded on purpose: they
// already read differently, one main-process-flavored, one renderer-flavored)
// so a drift fails CLOSED at the exact line it happens, rather than waiting
// for some future glob idiom to expose it the way this whole audit did.
function extractFunctionBody(source: string, name: string): string {
  const match = source.match(
    new RegExp(`(?:export )?function ${name}\\([^)]*\\)[^{]*\\{\\r?\\n([\\s\\S]*?)\\r?\\n\\}`)
  );
  if (!match) throw new Error(`function ${name} not found in source`);
  return match[1];
}

test("globToRegExp and expandCopyGlob stay byte-identical across their two duplicated copies", () => {
  const mainSrc = readFileSync(join(__dirname, "../desktop/src/main/sandbox-copy.ts"), "utf-8");
  const sharedSrc = readFileSync(join(__dirname, "../desktop/src/shared/types.ts"), "utf-8");
  expect(extractFunctionBody(sharedSrc, "globToRegExp")).toBe(
    extractFunctionBody(mainSrc, "globToRegExp")
  );
  expect(extractFunctionBody(sharedSrc, "expandCopyGlob")).toBe(
    extractFunctionBody(mainSrc, "expandCopyGlob")
  );
});
