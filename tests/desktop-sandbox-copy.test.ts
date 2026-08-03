// PLAN-SANDBOX M3: ephemeral-copy selection (glob matching + the hard deny
// list that always wins) — desktop/src/main/sandbox-copy.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("structural: every SKIP_DIRS entry is also denied by DENY_PATTERNS (finding 6)", () => {
  // Enumerated FROM the exported SKIP_DIRS set itself, not a hardcoded copy,
  // so a future addition to SKIP_DIRS that forgets deny coverage fails this
  // test closed instead of silently reopening a copy path.
  expect(SKIP_DIRS.size).toBeGreaterThan(0);
  for (const dir of SKIP_DIRS) {
    expect(isDeniedCopyPath(`${dir}/x`)).toBe(true);
  }
});

// The loop above iterates the LIVE Set, so removing an entry removes its own
// assertion too -- growth is covered, shrinkage is not (review round 2, card
// 94f8cc0c; the same hole shipped this morning in
// tests/desktop-tsconfig-flags.test.ts). Pin the content as a literal so a
// removed entry fails closed instead of silently narrowing the loop above.
test("structural: SKIP_DIRS content is pinned (review round 2, card 94f8cc0c)", () => {
  expect([...SKIP_DIRS].sort()).toEqual([
    ".cache",
    ".git",
    ".next",
    ".venv",
    ".worktrees",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "out",
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
  // `.env` matched a real file but is denied -> reported as unmatched, so the
  // operator sees it never travels instead of assuming it did.
  expect(plan.unmatched.sort()).toEqual([".env", "missing-*.txt"]);
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
