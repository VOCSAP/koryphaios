// Ships with the checker it tests so the sensitivity/specificity proof stays
// runnable after a refactor, instead of decaying into an unverifiable claim.
// Builds one linear commit history, each commit isolating exactly one
// sensitivity or specificity case, so a test can check a single sha and know
// precisely what it proves.

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SensitivityRepoShas {
  base: string;
  notExported: string;
  exportedFix: string;
  missingTarget: string;
  controlByte: string;
  aliasDivergence: string;
  aliasNotExported: string;
  cleanBatch: string;
  quotedImports: string;
  urlThenImport: string;
  unlistedExtControlByte: string;
  templateThenImport: string;
  regexThenImport: string;
  namedReExport: string;
  dtsTarget: string;
  commentedExport: string;
  importForms: string;
  nonAsciiPath: string;
  healedControlByte: string;
  mergeCommit: string;
}

// `-c core.hooksPath=` isolates every commit this fixture makes from the
// HOST's global git hooks (a `~/.gitconfig` with `core.hooksPath` set runs
// against ANY repo, including a throwaway one under os.tmpdir()). Card
// ba58fb12: this machine's global hook runs a secret scanner on every commit
// (~200-450ms each), which can push ~20 commits past Bun's 5s test timeout
// and gets the commit itself killed -- not refused, just never finished, so
// `r.stderr` comes back empty and the thrown message below used to blame the
// wrong (innocent) commit. The empty value scopes to exactly `-c`'s process,
// never the host's `~/.gitconfig` itself, so it cannot affect anything else
// git does on this machine.
const HOOKS_OFF = ["-c", "core.hooksPath="];

function git(repo: string, args: string[]) {
  const r = spawnSync("git", [...HOOKS_OFF, "-C", repo, ...args], { encoding: "utf8" });
  if (r.status !== 0) {
    // A process bun kills for exceeding its timeout reports `status` (SIGTERM
    // maps to a synthetic non-zero code on Windows spawnSync) with `stderr`
    // EMPTY -- git never got to write anything. Reporting only `stderr` (the
    // previous shape) surfaces nothing about THAT failure mode and instead
    // reads as if git rejected the command over its own content, which sent
    // more than one reader chasing the wrong commit. `status`/`signal`/`error`
    // are the fields that actually distinguish "git refused" from "git was
    // killed" or "the binary could not even be spawned".
    throw new Error(
      `git ${args.join(" ")} failed in ${repo}: status=${r.status} signal=${r.signal} ` +
        `error=${r.error ?? "none"} stderr=${JSON.stringify(r.stderr)} stdout=${JSON.stringify(r.stdout)}`,
    );
  }
  return r.stdout.trim();
}

function write(repo: string, relPath: string, content: string) {
  const full = join(repo, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const TSCONFIG_WEB = JSON.stringify(
  { compilerOptions: { paths: { "@shared/*": ["src/shared/*"] } } },
  null,
  2,
);
const TSCONFIG_NODE_AGREEING = JSON.stringify(
  { compilerOptions: { paths: { "@shared/*": ["src/shared/*"] } } },
  null,
  2,
);
const TSCONFIG_NODE_DIVERGENT = JSON.stringify(
  { compilerOptions: { paths: { "@shared/*": ["src/other-shared/*"] } } },
  null,
  2,
);

/**
 * Builds the fixture repo at `dir` (removed and recreated fresh) and
 * returns the sha of each named commit. `dir` must be an absolute path
 * outside this checkout (a scratch temp dir) -- this function does not
 * itself enforce that, callers (tests) are responsible.
 */
export function buildSensitivityRepo(dir: string): SensitivityRepoShas {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "probe@example.com"]);
  git(dir, ["config", "user.name", "probe"]);

  // --- base: 5 files, all correct.
  write(dir, "desktop/tsconfig.web.json", TSCONFIG_WEB);
  write(dir, "desktop/tsconfig.node.json", TSCONFIG_NODE_AGREEING);
  write(dir, "desktop/src/shared/box.ts", 'export function Box() { return "box" }\n');
  write(dir, "desktop/src/helper.ts", "export function old() { return 1 }\n");
  write(
    dir,
    "desktop/src/consumer.ts",
    'import { old } from "./helper"\nimport { Box } from "@shared/box"\nexport const a = old() + Box().length\n',
  );
  git(dir, [
    "add",
    "desktop/tsconfig.web.json",
    "desktop/tsconfig.node.json",
    "desktop/src/shared/box.ts",
    "desktop/src/helper.ts",
    "desktop/src/consumer.ts",
  ]);
  git(dir, ["commit", "-qm", "base"]);
  const base = git(dir, ["rev-parse", "HEAD"]);

  // --- notExported: consumer.ts references a symbol helper.ts does not
  // export yet. helper.ts is deliberately left UNSTAGED for this commit.
  write(
    dir,
    "desktop/src/consumer.ts",
    'import { old, brandNew } from "./helper"\nexport const a = old() + brandNew()\n',
  );
  git(dir, ["add", "desktop/src/consumer.ts"]);
  git(dir, ["commit", "-qm", "consumer references brandNew before helper.ts exports it"]);
  const notExported = git(dir, ["rev-parse", "HEAD"]);

  // --- exportedFix: helper.ts catches up. Clean single-file commit.
  write(dir, "desktop/src/helper.ts", "export function old() { return 1 }\nexport function brandNew() { return 2 }\n");
  git(dir, ["add", "desktop/src/helper.ts"]);
  git(dir, ["commit", "-qm", "helper.ts now exports brandNew"]);
  const exportedFix = git(dir, ["rev-parse", "HEAD"]);

  // --- missingTarget: a new file imports from a path that never existed.
  write(dir, "desktop/src/ghost-consumer.ts", 'import { ghost } from "./ghost"\nexport const g = ghost()\n');
  git(dir, ["add", "desktop/src/ghost-consumer.ts"]);
  git(dir, ["commit", "-qm", "imports a target that has never existed"]);
  const missingTarget = git(dir, ["rev-parse", "HEAD"]);

  // --- controlByte: a new file with a literal ESC byte in its content.
  write(dir, "desktop/src/ansi.ts", 'export const seq = "\x1b[2J"\n');
  git(dir, ["add", "desktop/src/ansi.ts"]);
  git(dir, ["commit", "-qm", "literal ESC byte"]);
  const controlByte = git(dir, ["rev-parse", "HEAD"]);

  // --- aliasDivergence: tsconfig.node.json disagrees with tsconfig.web.json.
  write(dir, "desktop/tsconfig.node.json", TSCONFIG_NODE_DIVERGENT);
  git(dir, ["add", "desktop/tsconfig.node.json"]);
  git(dir, ["commit", "-qm", "tsconfig.node.json diverges from tsconfig.web.json on @shared/*"]);
  const aliasDivergence = git(dir, ["rev-parse", "HEAD"]);

  // --- aliasNotExported: branches off exportedFix (tsconfigs still agree
  // there), a new file imports a symbol via @shared/box that box.ts does
  // not export.
  git(dir, ["checkout", "-q", exportedFix]);
  write(dir, "desktop/src/bad-alias-consumer.ts", 'import { Nope } from "@shared/box"\nexport const n = Nope()\n');
  git(dir, ["add", "desktop/src/bad-alias-consumer.ts"]);
  git(dir, ["commit", "-qm", "imports Nope from @shared/box, which does not export it"]);
  const aliasNotExported = git(dir, ["rev-parse", "HEAD"]);

  // --- cleanBatch: 7 new files in one commit, all correct. Branches off
  // aliasDivergence's tip (the "main" line) so it still carries the
  // divergent tsconfig.node.json -- deliberately reverted back here so this
  // commit is clean on its OWN terms (this commit does not touch the
  // tsconfigs, so aliasTableFromTsconfig would otherwise report the
  // inherited divergence and this would stop being a clean-commit fixture).
  git(dir, ["checkout", "-q", aliasDivergence]);
  write(dir, "desktop/tsconfig.node.json", TSCONFIG_NODE_AGREEING);
  for (let i = 1; i <= 7; i++) {
    write(dir, `desktop/src/clean-batch-${i}.ts`, `export function cleanBatch${i}() { return ${i} }\n`);
  }
  git(dir, [
    "add",
    "desktop/tsconfig.node.json",
    ...Array.from({ length: 7 }, (_, i) => `desktop/src/clean-batch-${i + 1}.ts`),
  ]);
  git(dir, ["commit", "-qm", "7 clean files in one commit, tsconfig re-agreed"]);
  const cleanBatch = git(dir, ["rev-parse", "HEAD"]);

  write(
    dir,
    "desktop/src/quoted-imports.ts",
    '// import { neverExisted } from "./nowhere-line-comment"\n' +
      "/*\n" +
      ' * import { neverExisted } from "./nowhere-block-comment"\n' +
      " */\n" +
      "export const doc = 'import { neverExisted } from \"./nowhere-string\"'\n",
  );
  git(dir, ["add", "desktop/src/quoted-imports.ts"]);
  git(dir, ["commit", "-qm", "every import in this file is quoted (comment/string), none is real"]);
  const quotedImports = git(dir, ["rev-parse", "HEAD"]);

  // --- urlThenImport: SENSITIVITY, and the negative control for the pre-pass
  // above. A REAL broken import shares a physical line with a string literal
  // containing "//" (a URL). If the comment stripper over-strips -- treating
  // the "//" inside the string as the start of a line comment -- the import
  // vanishes and this commit goes silently GREEN, which is the false-negative
  // this fixture exists to make impossible.
  write(
    dir,
    "desktop/src/url-then-import.ts",
    'const doc = "see https://example.com/x"; import { ghost } from "./no-such-target"\nexport const g = ghost() + doc.length\n',
  );
  git(dir, ["add", "desktop/src/url-then-import.ts"]);
  git(dir, ["commit", "-qm", "real broken import on the same line as a URL string literal"]);
  const urlThenImport = git(dir, ["rev-parse", "HEAD"]);

  // --- unlistedExtControlByte: SENSITIVITY for the scan's COVERAGE, not its
  // sensitivity to the byte itself. A .kt file carries a literal NUL. The
  // first version of the checker enumerated the extensions to SCAN, so this
  // file (and the 5 real .kt files this repo tracks) was silently exempt --
  // the fail-open half of the coverage question. Written with the \0 escape,
  // never a literal control byte in this source (CLAUDE.md).
  write(dir, "desktop/mobile-shell/android-src/Probe.kt", 'package probe\n\nconst val marker = "\0"\n');
  git(dir, ["add", "desktop/mobile-shell/android-src/Probe.kt"]);
  git(dir, ["commit", "-qm", "literal NUL in a .kt file, an extension no allow-list enumerated"]);
  const unlistedExtControlByte = git(dir, ["rev-parse", "HEAD"]);

  // --- templateThenImport: SENSITIVITY, second over-strip control (sibling
  // of urlThenImport, covering the OTHER way the lexical scanner can run
  // away). A quoted backtick and a quoted, never-closed "${" appear before a
  // REAL broken import, and a template literal whose interpolation contains
  // its own braces sits between them. If the scanner mistakes any of those
  // for the start of a template/interpolation it never leaves, the rest of
  // the file is masked and the import vanishes -- silently green.
  write(
    dir,
    "desktop/src/template-then-import.ts",
    'const looksLikeTemplate = "a `b ${ c"\n' +
      "const real = `x ${ { nested: 1 }.nested } y`\n" +
      'import { ghostTpl } from "./no-such-template-target"\n' +
      "export const t = ghostTpl() + looksLikeTemplate + real\n",
  );
  git(dir, ["add", "desktop/src/template-then-import.ts"]);
  git(dir, ["commit", "-qm", "real broken import after a quoted backtick and a braced interpolation"]);
  const templateThenImport = git(dir, ["rev-parse", "HEAD"]);

  write(
    dir,
    "desktop/src/regex-then-import.ts",
    "export function strip(p: string): string { return `\"${p.replace(/\"/g, '')}\"` }\n" +
      'import { ghostRe } from "./no-such-regex-target"\n' +
      "export const r = ghostRe()\n",
  );
  git(dir, ["add", "desktop/src/regex-then-import.ts"]);
  git(dir, ["commit", "-qm", "real broken import after a regex literal containing a quote"]);
  const regexThenImport = git(dir, ["rev-parse", "HEAD"]);

  write(dir, "desktop/src/origin.ts", "export function fromOrigin() { return 1 }\nexport type OriginType = { a: number }\n");
  write(
    dir,
    "desktop/src/barrel.ts",
    "export { fromOrigin } from './origin'\nexport type { OriginType } from './origin'\n",
  );
  write(
    dir,
    "desktop/src/barrel-consumer.ts",
    "import { fromOrigin } from './barrel'\nimport type { OriginType } from './barrel'\nexport const b: OriginType = { a: fromOrigin() }\n",
  );
  git(dir, ["add", "desktop/src/origin.ts", "desktop/src/barrel.ts", "desktop/src/barrel-consumer.ts"]);
  git(dir, ["commit", "-qm", "consumer imports through a barrel using both brace re-export forms"]);
  const namedReExport = git(dir, ["rev-parse", "HEAD"]);

  // --- dtsTarget: SPECIFICITY. The only file backing the specifier is a
  // hand-written `.d.ts` declaration file. Must stay GREEN: this is an
  // ordinary import target (BrowserView.tsx -> webview-types.d.ts), and
  // omitting the extension from the candidate list reported a
  // missing-target on a live, healthy file.
  write(dir, "desktop/src/only-types.d.ts", "export interface OnlyType {\n  n: number\n}\n");
  write(
    dir,
    "desktop/src/dts-consumer.ts",
    "import type { OnlyType } from './only-types'\nexport const o: OnlyType = { n: 1 }\n",
  );
  git(dir, ["add", "desktop/src/only-types.d.ts", "desktop/src/dts-consumer.ts"]);
  git(dir, ["commit", "-qm", "consumer imports a type whose only backing file is a .d.ts"]);
  const dtsTarget = git(dir, ["rev-parse", "HEAD"]);

  // --- commentedExport: SENSITIVITY for the EXPORT side. quoted-export.ts
  // "exports" onlyInAComment nowhere but in a comment and in a string, and a
  // new consumer imports it. The import must be reported not-exported: a
  // quoted export satisfying a real import is the fail-OPEN mirror of the
  // quoted-import false positive.
  write(
    dir,
    "desktop/src/quoted-export.ts",
    "// export function onlyInAComment() { return 1 }\n" +
      "export const help = 'export function onlyInAComment() {}'\n" +
      "export function realOne() { return 2 }\n",
  );
  write(
    dir,
    "desktop/src/quoted-export-consumer.ts",
    'import { onlyInAComment } from "./quoted-export"\nexport const q = onlyInAComment()\n',
  );
  git(dir, ["add", "desktop/src/quoted-export.ts", "desktop/src/quoted-export-consumer.ts"]);
  git(dir, ["commit", "-qm", "consumer imports a symbol its target only exports inside a comment"]);
  const commentedExport = git(dir, ["rev-parse", "HEAD"]);

  // --- importForms: SENSITIVITY over the import GRAMMAR, not the target.
  // Default, namespace and side-effect imports all point at targets that do
  // not exist. Before the ordering fix only the NAMED form could report a
  // missing target (measured 1 finding vs 0 on the same missing target), so
  // three quarters of the grammar was silently exempt -- and the
  // side-effect form was not even matched by the import regex, which needs
  // a `from` clause.
  write(dir, "desktop/src/form-default.ts", 'import Ghost from "./no-such-default"\nexport const d = Ghost\n');
  write(dir, "desktop/src/form-namespace.ts", 'import * as G from "./no-such-namespace"\nexport const n = G\n');
  write(dir, "desktop/src/form-side-effect.ts", 'import "./no-such-side-effect"\nexport const s = 1\n');
  git(dir, [
    "add",
    "desktop/src/form-default.ts",
    "desktop/src/form-namespace.ts",
    "desktop/src/form-side-effect.ts",
  ]);
  git(dir, ["commit", "-qm", "default, namespace and side-effect imports of targets that do not exist"]);
  const importForms = git(dir, ["rev-parse", "HEAD"]);

  // --- nonAsciiPath: SENSITIVITY over the PATH, not the content. Two files
  // in one commit, each with the same broken import; one path is accented.
  // git quotes and backslash-escapes any non-ASCII path when core.quotePath
  // is on (the default), and the quoted literal resolves to no blob, so the
  // file was announced as scanned and silently checked as nothing --
  // measured 2 files listed, 1 finding reported. The accented file is what
  // makes this probe bite; the plain one is the control that proves the
  // commit itself is not simply green.
  write(dir, "desktop/src/plain-path.ts", 'import { ghostA } from "./no-such-a"\nexport const a = ghostA()\n');
  write(dir, "desktop/src/café-path.ts", 'import { ghostB } from "./no-such-b"\nexport const b = ghostB()\n');
  git(dir, ["add", "-A", "desktop/src"]);
  git(dir, ["commit", "-qm", "two broken imports, one behind an accented path"]);
  const nonAsciiPath = git(dir, ["rev-parse", "HEAD"]);

  // --- healedControlByte: the case the PR mode exists for. ansi.ts got a
  // literal ESC back at `controlByte`; here it is CLEANED. Per commit the
  // range still contains a red (`controlByte` itself, and that is correct
  // history), but the file's STATE at head is fine, so a net-diff scan must
  // say nothing about it. Probe.kt, cleaned by nothing, stays dirty at head
  // and must still be reported -- the two halves of the same PR run.
  write(dir, "desktop/src/ansi.ts", "export const RESET = String.fromCharCode(27) + '[0m'\n");
  git(dir, ["add", "desktop/src/ansi.ts"]);
  git(dir, ["commit", "-qm", "remove the literal ESC from ansi.ts (defect healed inside the range)"]);
  const healedControlByte = git(dir, ["rev-parse", "HEAD"]);

  // --- mergeCommit: SENSITIVITY for the merge path. A side branch adds a
  // file with a broken import, then it is merged with --no-ff. `git show
  // --name-only` prints NOTHING for a merge, so the naive listing scanned
  // zero files and printed OK: a SUBSET that reads as a success, on a shape
  // that is 41 of this repo's last 200 commits.
  const beforeMerge = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["checkout", "-q", "-b", "side-branch"]);
  write(
    dir,
    "desktop/src/merged-ghost.ts",
    'import { mergedGhost } from "./no-such-merged-target"\nexport const mg = mergedGhost()\n',
  );
  git(dir, ["add", "desktop/src/merged-ghost.ts"]);
  git(dir, ["commit", "-qm", "side branch adds a file with a broken import"]);
  git(dir, ["checkout", "-q", beforeMerge]);
  git(dir, ["merge", "-q", "--no-ff", "--no-edit", "side-branch"]);
  const mergeCommit = git(dir, ["rev-parse", "HEAD"]);

  return {
    base,
    notExported,
    exportedFix,
    missingTarget,
    controlByte,
    aliasDivergence,
    aliasNotExported,
    cleanBatch,
    quotedImports,
    urlThenImport,
    unlistedExtControlByte,
    templateThenImport,
    regexThenImport,
    namedReExport,
    dtsTarget,
    commentedExport,
    importForms,
    nonAsciiPath,
    healedControlByte,
    mergeCommit,
  };
}

/**
 * Requires dir already at the fixture's final commit (helper.ts unchanged since
 * exportedFix). Stages, without committing, one file importing a target that
 * exists nowhere and one importing helper.ts via the HEAD fallback for
 * untouched files.
 * Leaves the index staged and dirty on return; the caller owns the temp dir's
 * lifetime.
 */
export function stageOnlyDefect(dir: string): void {
  write(
    dir,
    "desktop/src/staged-ghost.ts",
    'import { neverExisted } from "./never-existed"\nexport const x = neverExisted()\n',
  );
  write(
    dir,
    "desktop/src/staged-valid.ts",
    'import { old } from "./helper"\nexport const y = old()\n',
  );
  git(dir, ["add", "desktop/src/staged-ghost.ts", "desktop/src/staged-valid.ts"]);
}

/** A fresh, initialized-but-empty-index repo, for the "nothing staged" edge case. */
/**
 * Shallow clone of an existing fixture repo, for the fail-closed probe.
 * `--depth` is IGNORED for a plain local path clone, so the source must be
 * given as a `file://` URL -- otherwise the clone is complete, the probe
 * quietly tests nothing, and the guard it is meant to prove looks covered.
 * Returns false when the host's git refuses the clone, so the caller can
 * fail loudly rather than skip silently.
 */
export function buildShallowClone(sourceDir: string, dir: string): boolean {
  rmSync(dir, { recursive: true, force: true });
  const url = `file:///${sourceDir.replace(/\\/g, "/").replace(/^\/+/, "")}`;
  // `clone` ends with an implicit checkout, which DOES run the host's
  // post-checkout hook if one is configured (unlike the two read-only git
  // calls below, `rev-parse`/`config --get`, which have no hook of their
  // own) -- see HOOKS_OFF's comment on `git()` above for why this must never
  // depend on the host's config.
  const r = spawnSync("git", [...HOOKS_OFF, "clone", "--quiet", "--depth", "1", url, dir], { encoding: "utf8" });
  if (r.status !== 0) return false;
  const shallow = spawnSync("git", ["-C", dir, "rev-parse", "--is-shallow-repository"], { encoding: "utf8" });
  return shallow.stdout.trim() === "true";
}

/**
 * Partial (blob-less) clone, for the second fail-closed probe. A partial
 * clone answers FALSE to `--is-shallow-repository`: the history is complete,
 * the blobs are not, so it is a different truncation that the shallow guard
 * alone does not see. Returns whether the marker config key really got set
 * (a local file:// server may refuse to filter and only record the key --
 * which is precisely what the guard keys on).
 */
export function buildPartialClone(sourceDir: string, dir: string): boolean {
  rmSync(dir, { recursive: true, force: true });
  const url = `file:///${sourceDir.replace(/\\/g, "/").replace(/^\/+/, "")}`;
  // Same reasoning as buildShallowClone's `clone` call: this one also ends
  // in an implicit checkout.
  const r = spawnSync("git", [...HOOKS_OFF, "clone", "--quiet", "--filter=blob:none", url, dir], {
    encoding: "utf8",
  });
  if (r.status !== 0) return false;
  const key = spawnSync("git", ["-C", dir, "config", "--get", "remote.origin.partialclonefilter"], {
    encoding: "utf8",
  });
  return key.stdout.trim() === "blob:none";
}

export function buildEmptyRepo(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "probe@example.com"]);
  git(dir, ["config", "user.name", "probe"]);
  write(dir, "README.md", "empty repo, nothing staged\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-qm", "initial"]);
}
