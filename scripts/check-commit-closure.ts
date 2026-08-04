// Card 67519e73. Two mechanical checks against a commit/index TREE, both
// invisible when reading the diff alone:
//
//  1. IMPORT CLOSURE. For every scanned file, every relative (./ ../) or
//     @shared/*-aliased import is resolved AGAINST THE TREE BEING CHECKED
//     (the commit's blobs, or the index's staged blobs with a HEAD fallback
//     for files the commit/stage does not touch) -- never the working tree.
//     Catches "this commit references code that only exists in the working
//     tree": it builds for the author and breaks for everyone else the
//     moment they check the commit out clean.
//  2. LITERAL CONTROL BYTES (NUL, ESC, BEL) inside a committed/staged blob.
//     One embedded NUL and git classifies the whole file BINARY: no diff,
//     no blame, no 3-way merge, ripgrep refuses to show it -- the module
//     silently drops out of code review and code search.
//
// THREE modes, sharing all the resolution logic below:
//   PR mode:      bun scripts/check-commit-closure.ts --pr <base> <head> [repo]
//                 THE MODE CI USES. Import closure per commit over
//                 base..head; control bytes ONCE over the net diff
//                 base...head, blobs read at head. See runPrCheck for why
//                 the two halves are wired differently and what that costs.
//   sha mode:     bun scripts/check-commit-closure.ts <sha> [repo]
//                 audits ONE real, already-made commit -- a manual audit
//                 after the fact, or bisecting which commit of a range went
//                 red. CI does NOT loop over commits with this; that is PR
//                 mode's job.
//   staged mode:  bun scripts/check-commit-closure.ts --staged [repo]
//                 audits the INDEX -- "if I commit right now, does this
//                 commit stand on its own?" -- the question at the moment
//                 it is still cheap to answer. Files staged read from the
//                 index (`git show :<path>`); files the stage does not
//                 touch fall back to HEAD, matching what the resulting
//                 commit would actually contain.
//
// Ported from a hand-validated prototype (sha mode only, hardcoded to one
// repo path) -- kept for provenance, not re-derived: sensitivity proved on
// a throwaway repo carrying both defects, specificity proved silent on two
// real clean commits (1 file, 7 files). This version adds --staged mode,
// @shared/* alias resolution sourced from the tree being checked (not
// disk), and non-zero exit codes so CI can gate on it.
//
// Exit code: 0 = clean, 1 = at least one problem found, 2 = usage/tool
// error (git missing, bad ref, no such commit) so a broken invocation is
// distinguishable from a genuine finding in CI logs.
//
// TEN KNOWN GAPS, documented rather than silently absent (the same
// coverage question this tool exists to enforce, turned on itself). An
// UNLISTED gap is worse than a listed one: the list is what a reader
// audits against, so anything missing from it reads as covered.
//   1. REVERSE DIRECTION NOT SCANNED. This only walks the files IN the
//      commit/stage being checked. A commit that renames or deletes an
//      export breaks every ALREADY-COMMITTED file that imports it, and
//      none of those files are in this commit's file list -- the most
//      perfidious half, invisible in the diff AND in `git show --name-only`.
//      Closing this needs a reverse index (which committed files import the
//      modified module) built by scanning the whole tree, not just the
//      commit -- slower, deliberately out of scope here.
//   2. NAME, NOT SHAPE. A symbol is "closed" once a same-name export
//      exists at the target. A signature/type change under the same name
//      stays green. Closing this needs a type checker, which is what the
//      slow path (full checkout + `npm run typecheck`) is for -- see
//      TESTING.md and the desktop-precommit skill for when to escalate.
//   3. PROSE REFERENCES NOT FOLLOWED. Only `import ... from '...'`
//      statements are parsed. A doc (TESTING.md, a skill) naming a file
//      that never made it into the commit is not an import and is not
//      caught -- caught by eye, or by a doc-specific link checker, neither
//      of which this tool is.
//   4. ALIASES ARE READ ONLY FROM THE TWO TSCONFIGS. Every prefix declared
//      in their `compilerOptions.paths` is resolved, not just `@shared/*`
//      (the constant naming it is a file list, not a prefix filter), so
//      this gap is narrower than it used to claim.
//      electron.vite.config.ts declares its own resolve.alias blocks (JS,
//      not JSON) and is not parsed here -- a drift between it and the
//      tsconfigs is a real defect this tool cannot see. A DIVERGENCE
//      BETWEEN THE TWO TSCONFIGS THEMSELVES is checked and reported,
//      because both are trivially parseable JSON already read for the
//      alias table.
//   5. A BRACE RE-EXPORT IS TRUSTED AT ONE HOP. `export { A } from './x'`
//      and `export type { A } from './x'` count as exporting A without
//      checking that ./x really exports it, so a broken SECOND hop stays
//      green. This is fail-open and deliberate: following the chain means
//      resolving the re-export's own specifier recursively, with cycle
//      detection, which is a different tool. `export * from '...'` is NOT
//      trusted at all and yields a red finding -- the fail-closed side,
//      kept on purpose. Measured on this tree: exactly one `export *`
//      line exists, `export * as React from 'react'`
//      (desktop/tests-support/react-test-harness.ts:71), which is a
//      NAMESPACE re-export of a bare package and is never a resolution
//      target here -- so nothing is red today, but the claim is "one
//      harmless occurrence", not "none".
//   6. `export { A as B }` SATISFIES `import { A }`. The export scan looks
//      for the name anywhere inside the braces, so the LOCAL side of a
//      rename counts as if it were the exported name. Fail-open, measured,
//      and left as is: fixing it means parsing the brace list per entry.
//   7. THE IMPORT SCAN IS EXTENSION-FILTERED to .ts/.tsx/.js/.mjs, so
//      `.jsx`, `.cjs` and `.mts` files' own imports are not walked. None
//      exist in this tree today, which is exactly how this kind of gap
//      survives -- it is the fail-open direction (a growing domain stays
//      exempt), unlike the control-byte scan, which was inverted to a
//      deny-list for that reason.
//   8. JSX TEXT CAN UNBOUND THE LEXICAL PASS. maskCommentsAndStrings reads
//      `/*` and a backtick as code even when they sit in JSX TEXT (not in
//      an attribute string), so a literal `/*` or an odd backtick in
//      rendered text opens a block comment or a template that runs to EOF.
//      Both cases measured; incidence today 0 (no .tsx in this tree does
//      it, and the whole-tree run reports 0 findings). It is NOT bounded
//      to one line, and it cuts BOTH ways: over-stripping on the import
//      side loses an import (silent), and on the export side, where the
//      same pass feeds codeOnlySource, it loses an export and INVENTS a
//      not-exported finding.
//   9. MERGES ARE AUDITED AGAINST THEIR FIRST PARENT ONLY. See
//      listCommitFiles: a merge's second-parent-only changes are not in
//      that diff. The alternative (union of both diffs) re-audits the whole
//      merged branch on every merge, which is the workflow's job via the
//      commit range, not this one commit's.
//  10. IN PR MODE THE CONTROL-BYTE HALF DOES NOT HOLD "EVERY COMMIT STANDS
//      ALONE". It judges the NET diff at head, so a byte introduced and
//      removed inside the range is not reported, and a `git checkout` of a
//      mid-range commit can still land on a file git calls binary. Accepted
//      deliberately (see runPrCheck): a control byte is a defect of a
//      file's STATE, and history cannot be un-reddened, so the alternative
//      was a gate red on its first real PR. The import-closure half keeps
//      the per-commit property, because ITS defect is inter-commit.

import { spawnSync } from "node:child_process";

export interface Problem {
  kind: "missing-target" | "not-exported" | "control-byte" | "alias-divergence" | "tool-error";
  file: string;
  detail: string;
}

export interface AliasTable {
  /** alias prefix (without the trailing "/*", e.g. "@shared") -> resolved dir, relative to repo root */
  aliases: Record<string, string>;
  /** human-readable divergence reports, e.g. two tsconfigs disagreeing on the same prefix */
  divergence: string[];
}

export type BlobReader = (path: string) => string | null;

// `core.quotePath` defaults to TRUE, so git renders any non-ASCII path as a
// quoted, backslash-escaped literal ("src/caf\303\251.ts"). That literal
// resolves to no blob, so every reader below returns null and every loop
// treats the file as absent -- the file is announced as scanned and is
// silently not checked. Turning it off here covers any listing added later;
// the listings that exist today go further and use -z (see listPaths).
function runGit(repo: string, args: string[]) {
  return spawnSync("git", ["-C", repo, "-c", "core.quotePath=false", ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function runGitBinary(repo: string, args: string[]) {
  return spawnSync("git", ["-C", repo, "-c", "core.quotePath=false", ...args], { maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Splits a `-z` listing (NUL-separated, never quoted, never escaped).
 * Preferred over newline splitting even with quotePath off, because it also
 * survives a quote or a NEWLINE inside a filename, which no amount of
 * un-quoting would.
 */
function splitZ(out: string): string[] {
  return out.split("\0").filter(Boolean);
}

/**
 * Files touched by a real commit.
 *
 * MERGE COMMITS NEED THEIR OWN PATH. `git show --name-only` prints NOTHING
 * for a merge (git refuses to diff against several parents at once), so the
 * naive version scanned ZERO files and printed "import closure: OK" --
 * canonically the failure this whole tool exists to catch: a SUBSET that
 * reads as a success. Measured on this repo: `git show --pretty=format:
 * --name-only 3f3f4122` returns 0 lines, `git diff --name-only 3f3f4122^1
 * 3f3f4122` returns 62, and 41 of the last 200 commits are merges -- all of
 * them inside the `git rev-list base..head` range the CI workflow feeds in.
 *
 * A merge is therefore audited against its FIRST PARENT, which is the diff
 * it introduces into the line being merged INTO, and is exactly where a
 * semantic conflict (each side fine, the combination not) becomes visible.
 * Blobs are still read at the merge sha itself, so what is judged is the
 * merged tree, not either side.
 */
export function listCommitFiles(repo: string, sha: string): string[] {
  const parents = runGit(repo, ["rev-list", "--parents", "-n1", sha]);
  if (parents.status !== 0) throw new Error(`git rev-list --parents -n1 ${sha} failed: ${parents.stderr}`);
  // "<sha> <parent1> [<parent2> ...]": more than two fields means a merge.
  const isMerge = parents.stdout.trim().split(/\s+/).filter(Boolean).length > 2;
  const r = isMerge
    ? runGit(repo, ["diff", "--name-only", "-z", `${sha}^1`, sha])
    : runGit(repo, ["show", "--pretty=format:", "--name-only", "-z", sha]);
  if (r.status !== 0) throw new Error(`listing files of ${sha} failed: ${r.stderr}`);
  return splitZ(r.stdout);
}

/** Files currently staged for commit (the index vs HEAD diff). */
export function listStagedFiles(repo: string): string[] {
  const r = runGit(repo, ["diff", "--cached", "--name-only", "-z"]);
  if (r.status !== 0) throw new Error(`git diff --cached --name-only failed: ${r.stderr}`);
  return splitZ(r.stdout);
}

/**
 * Reads a path's content as it would exist in the commit/index being
 * checked. `ref` is a commit sha (sha mode), ANY resolvable ref name (PR
 * mode passes headRef), or the literal string "staged" (staged mode: index
 * blob via `git show :<path>`, falling back to `git show HEAD:<path>` when
 * the path is not staged -- i.e. unchanged by this prospective commit).
 * Only the literal "staged" is special-cased; everything else is handed to
 * git as `<ref>:<path>`. Returns null when the path does not exist there
 * (deleted, or never existed) rather than throwing, since "target absent"
 * is itself a finding, not a tool error.
 */
export function makeBlobReader(repo: string, ref: string): BlobReader {
  return (path: string) => {
    const spec = ref === "staged" ? `:${path}` : `${ref}:${path}`;
    const r = runGit(repo, ["show", spec]);
    if (r.status === 0) return r.stdout;
    if (ref === "staged") {
      const head = runGit(repo, ["show", `HEAD:${path}`]);
      if (head.status === 0) return head.stdout;
    }
    return null;
  };
}

/** Binary-safe variant of makeBlobReader, for the control-byte scan. */
export function makeBinaryBlobReader(repo: string, ref: string): (path: string) => Buffer | null {
  return (path: string) => {
    const spec = ref === "staged" ? `:${path}` : `${ref}:${path}`;
    const r = runGitBinary(repo, ["show", spec]);
    if (r.status === 0 && r.stdout) return r.stdout as unknown as Buffer;
    if (ref === "staged") {
      const head = runGitBinary(repo, ["show", `HEAD:${path}`]);
      if (head.status === 0 && head.stdout) return head.stdout as unknown as Buffer;
    }
    return null;
  };
}

const TSCONFIGS_WITH_SHARED_ALIAS = ["desktop/tsconfig.web.json", "desktop/tsconfig.node.json"];

/**
 * Reads compilerOptions.paths out of the tsconfig(s) AS THEY EXIST IN THE
 * TREE BEING CHECKED (via `read`), not off disk -- a commit that itself
 * edits the alias must be judged by its own new alias table, not the one
 * sitting in the working tree. Every prefix's targets are resolved relative
 * to the tsconfig's OWN directory (desktop/), matching tsc's baseUrl-less
 * "paths" semantics used here. Two tsconfigs declaring the same prefix with
 * different targets is reported as a divergence rather than one silently
 * winning.
 */
export function aliasTableFromTsconfig(read: BlobReader): AliasTable {
  const aliases: Record<string, string> = {};
  const seenBy: Record<string, { file: string; target: string }[]> = {};

  for (const tsconfigPath of TSCONFIGS_WITH_SHARED_ALIAS) {
    const src = read(tsconfigPath);
    if (src === null) continue; // tsconfig not present at this ref -- nothing to derive
    let parsed: { compilerOptions?: { paths?: Record<string, string[]> } };
    try {
      parsed = JSON.parse(src);
    } catch {
      continue; // malformed JSON at this ref is its own (separate) problem; not this tool's job
    }
    const paths = parsed.compilerOptions?.paths;
    if (!paths) continue;
    const tsconfigDir = tsconfigPath.split("/").slice(0, -1).join("/");
    for (const [rawPrefix, targets] of Object.entries(paths)) {
      if (!targets || targets.length === 0) continue;
      const prefix = rawPrefix.replace(/\/\*$/, "");
      const rawTarget = targets[0]!.replace(/\/\*$/, "");
      const resolvedTarget = tsconfigDir ? `${tsconfigDir}/${rawTarget}` : rawTarget;
      (seenBy[prefix] ??= []).push({ file: tsconfigPath, target: resolvedTarget });
    }
  }

  const divergence: string[] = [];
  for (const [prefix, entries] of Object.entries(seenBy)) {
    const distinctTargets = new Set(entries.map((e) => e.target));
    if (distinctTargets.size > 1) {
      divergence.push(
        `alias "${prefix}/*" resolves differently across tsconfigs: ` +
          entries.map((e) => `${e.file} -> ${e.target}`).join(", "),
      );
      // keep the first declaration so resolution can still proceed; the
      // divergence itself is reported as a problem by the caller
      aliases[prefix] = entries[0]!.target;
    } else {
      aliases[prefix] = entries[0]!.target;
    }
  }
  return { aliases, divergence };
}

const IMPORT_RE =
  /import\s+(type\s+)?(\{[^}]*\}|\*\s+as\s+\w+|\w+)?\s*(?:,\s*(\{[^}]*\}))?\s*from\s*['"]([^'"]+)['"]/g;

// Side-effect import: `import './polyfill'`, no `from` clause, so IMPORT_RE
// cannot see it at all. It still points at a file that must exist in the
// tree being checked. The `\s+` before the quote is what keeps a DYNAMIC
// `import("./x")` out: that form has a paren, not whitespace, after the
// keyword.
const SIDE_EFFECT_IMPORT_RE = /import\s+['"]([^'"]+)['"]/g;

/**
 * Lexical pre-pass for IMPORT_RE. Running that regex over the RAW source
 * makes the checker parse an import statement that is only QUOTED -- inside
 * a `//` or block comment, or inside a string literal -- as if the commit
 * really imported it. Measured on this repo before this pass existed: 2 of
 * the 40 most recent commits went red on tests/desktop-tile-area.test.ts,
 * where a comment cites `import { TerminalTile } from './TerminalTile'`,
 * and scripts/fixtures/make-closure-sensitivity-repo.ts produced 5 red
 * findings because the fixture FILE CONTENTS it writes are import
 * statements living in string literals. A gate that is red on healthy code
 * from day one gets disarmed, so this is not cosmetic.
 *
 * Returns the source with every comment body blanked (spaces, newlines
 * preserved, so offsets and line numbers are unchanged) and a per-offset
 * flag marking characters that sit inside a string/template literal. The
 * caller keeps string CONTENT (the specifier itself is a string) and only
 * uses the flag to reject a match whose `import` KEYWORD is quoted.
 *
 * String literals, template literals (including `${ }` interpolation and
 * its brace depth) and REGEX literals are all tracked, because each one can
 * contain a character that would otherwise flip the state: `"https://x"`
 * (would look like a comment), `` `a ${ "b" } c` ``, and `/"/g` (would open
 * a string). Two containment rules keep any residual mis-lex local rather
 * than file-wide: an unterminated string or regex stops at end of line, and
 * an ambiguous `/` is resolved as DIVISION, never as a regex that could
 * swallow the file.
 *
 * Known, deliberate limits, and the bound is NOT uniform:
 *  - a `//` inside a regex whose opening `/` was classified as division
 *    (e.g. after an identifier) is read as a line comment, blanking the
 *    rest of that ONE line. Bounded, and harmless on the import side since
 *    an import statement contains no regex.
 *  - JSX TEXT is not distinguished from code: a literal `/*` or an odd
 *    backtick in rendered text opens a block comment or a template that
 *    runs to EOF. NOT bounded to one line (gap 8 in the header), and it
 *    hurts BOTH consumers -- the import side loses an import (silent), and
 *    codeOnlySource loses an export, which INVENTS a not-exported finding.
 *    Measured incidence on this tree: 0.
 */
export function maskCommentsAndStrings(src: string): { masked: string; inString: Uint8Array } {
  const out = src.split("");
  const inString = new Uint8Array(src.length);
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < src.length; k++) if (src[k] !== "\n") out[k] = " ";
  };

  // `mode` is the current lexical context; `frames` records, for each
  // template literal we are nested inside, how deep its `${ }` expression's
  // own braces currently are -- so an object literal inside `${...}` does
  // not close the interpolation early.
  let mode: "code" | "template" = "code";
  const frames: { braceDepth: number }[] = [];
  let i = 0;

  // Regex-literal detection. Needed, not optional: `/"/g` and `/['"]/` are
  // ordinary code in this repo, and without this the quote INSIDE the regex
  // opens a string literal, which desynchronises every state that follows.
  // Measured before this branch existed: masking desynchronised at
  // desktop/src/main/model-adapters.ts:59 (`p.replace(/"/g, '')`) and the
  // repo-wide closure run went from 3 findings to 54 -- 51 phantom
  // not-exported reports on symbols that really are exported.
  //
  // `/` is ambiguous (regex vs division); it is a regex when the previous
  // significant token cannot end an expression. Guessing DIVISION on the
  // ambiguous leftovers is the containment-preserving choice: a mis-read
  // division only mis-lexes the rest of one line, whereas a mis-read regex
  // could swallow the file.
  const REGEX_PREV_OK = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "^", "~", "<", ">"]);
  const REGEX_PREV_KEYWORDS =
    /\b(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/;
  const startsRegex = (at: number): boolean => {
    let k = at - 1;
    while (k >= 0 && /\s/.test(out[k]!)) k--;
    if (k < 0) return true;
    const prev = out[k]!;
    if (REGEX_PREV_OK.has(prev)) return true;
    if (/[A-Za-z0-9_$]/.test(prev)) return REGEX_PREV_KEYWORDS.test(out.slice(0, k + 1).join(""));
    return false;
  };

  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];

    if (mode === "template") {
      if (c === "\\") {
        inString[i] = 1;
        if (i + 1 < src.length) inString[i + 1] = 1;
        i += 2;
        continue;
      }
      if (c === "`") {
        inString[i] = 1;
        mode = "code";
        frames.pop();
        i++;
        continue;
      }
      if (c === "$" && n === "{") {
        inString[i] = 1;
        inString[i + 1] = 1;
        mode = "code"; // the interpolated expression is real code
        i += 2;
        continue;
      }
      inString[i] = 1;
      i++;
      continue;
    }

    // mode === "code"
    if (c === "/" && n === "/") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && n === "*") {
      let j = i + 2;
      while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) j++;
      j = Math.min(j + 2, src.length);
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && startsRegex(i)) {
      // Skip the regex literal wholesale: its interior is neither code nor
      // string as far as this pass is concerned, it just must not be
      // mis-lexed. Character classes are tracked so `/[/]/` does not end
      // early.
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const rc = src[j];
        if (rc === "\\") {
          j += 2;
          continue;
        }
        if (rc === "\n") break; // unterminated: contain the damage to this line
        if (rc === "[") inClass = true;
        else if (rc === "]") inClass = false;
        else if (rc === "/" && !inClass) {
          j++;
          break;
        }
        j++;
      }
      while (j < src.length && /[a-z]/.test(src[j]!)) j++; // flags
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === "\n") break; // unterminated literal: stop at EOL rather than eating the file
        if (src[j] === quote) {
          j++;
          break;
        }
        j++;
      }
      for (let k = i; k < j && k < src.length; k++) inString[k] = 1;
      i = j;
      continue;
    }
    if (c === "`") {
      inString[i] = 1;
      frames.push({ braceDepth: 0 });
      mode = "template";
      i++;
      continue;
    }
    if (frames.length > 0) {
      // inside a `${ }` interpolation: track braces so the matching `}`
      // returns to the template, and an inner `{ }` does not.
      const frame = frames[frames.length - 1]!;
      if (c === "{") frame.braceDepth++;
      else if (c === "}") {
        if (frame.braceDepth > 0) frame.braceDepth--;
        else {
          inString[i] = 1;
          mode = "template";
          i++;
          continue;
        }
      }
    }
    i++;
  }

  return { masked: out.join(""), inString };
}

/**
 * Same lexical pass, projected down to CODE ONLY: comment bodies and string
 * interiors both blanked (offsets and newlines preserved). Used for the
 * export-side check, where a `export function X` that only exists inside a
 * comment or a quoted example must NOT count as an export -- the fail-OPEN
 * half of this checker's own coverage question, and the exact inverse of the
 * quoted-import false positive above: there, quoted text invented a problem;
 * here, quoted text hides one.
 */
export function codeOnlySource(src: string): string {
  const { masked, inString } = maskCommentsAndStrings(src);
  const out = masked.split("");
  for (let i = 0; i < out.length; i++) if (inString[i] === 1 && out[i] !== "\n") out[i] = " ";
  return out.join("");
}

function normalizeSegments(parts: string): string {
  const norm: string[] = [];
  for (const seg of parts.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") norm.pop();
    else norm.push(seg);
  }
  return norm.join("/");
}

/**
 * Resolves one import specifier to a repo-root-relative base path (no
 * extension), or null if it is neither a relative import (./ ../) nor a
 * recognized alias -- e.g. a bare package specifier, which this tool does
 * not (and should not) resolve against node_modules.
 */
function resolveSpecifier(fromDir: string, spec: string, aliases: Record<string, string>): string | null {
  if (spec.startsWith(".")) {
    return normalizeSegments((fromDir ? fromDir + "/" : "") + spec);
  }
  for (const [prefix, target] of Object.entries(aliases)) {
    if (spec === prefix || spec.startsWith(prefix + "/")) {
      const rest = spec.slice(prefix.length).replace(/^\//, "");
      return normalizeSegments(target + (rest ? "/" + rest : ""));
    }
  }
  return null;
}

/**
 * Import-closure check: for every file, every relative/@shared import must
 * resolve (via `read`, the tree being checked) to a real file that exports
 * every named symbol imported. Files outside the given `scanFiles` set are
 * still resolved via `read` (so an import into an unchanged file correctly
 * finds it there) -- `scanFiles` only decides which files' OWN import
 * statements are walked, not which targets are legal to point at.
 */
export function resolveImportClosure(scanFiles: string[], read: BlobReader, aliases: Record<string, string>): Problem[] {
  const problems: Problem[] = [];
  for (const f of scanFiles) {
    if (!/\.(ts|tsx|js|mjs)$/.test(f)) continue;
    const src = read(f);
    if (src === null) continue; // deleted by this commit/stage
    const dir = f.split("/").slice(0, -1).join("/");
    // Parse the MASKED source (comment bodies blanked) and drop any match
    // whose `import` keyword is itself inside a string literal -- see
    // maskCommentsAndStrings: a merely QUOTED import is not an import.
    const { masked, inString } = maskCommentsAndStrings(src);

    // Two patterns, one pass. IMPORT_RE only matches forms carrying a
    // `from` clause, so a SIDE-EFFECT import (`import './ghost'`) was
    // invisible to it -- not a filtered-out case, an unmatched one, which
    // is why moving the "nothing named" return alone does not cover it.
    const statements: { spec: string; named: string[]; isType: boolean; index: number }[] = [];
    for (const m of masked.matchAll(IMPORT_RE)) {
      if (m.index === undefined || inString[m.index]) continue;
      const spec = m[4];
      if (spec === undefined) continue; // regex matched without a specifier capture -- malformed source, skip
      const named = [m[2], m[3]]
        .filter((g): g is string => g !== undefined && g.startsWith("{"))
        .flatMap((g) => g.slice(1, -1).split(","))
        .map((s) => (s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0] ?? "").trim())
        .filter(Boolean);
      statements.push({ spec, named, isType: Boolean(m[1]), index: m.index });
    }
    for (const m of masked.matchAll(SIDE_EFFECT_IMPORT_RE)) {
      if (m.index === undefined || inString[m.index]) continue;
      const spec = m[1];
      if (spec === undefined) continue;
      statements.push({ spec, named: [], isType: false, index: m.index });
    }

    for (const { spec, named, isType } of statements) {
      const base = resolveSpecifier(dir, spec, aliases);
      if (base === null) continue; // bare package specifier, not resolved here

      // ORDERING IS LOAD-BEARING: target resolution runs for EVERY import
      // form, and only the export check below is skipped when nothing is
      // named. With the "nothing named" return sitting HERE (where it used
      // to), `import Ghost from './ghost'`, `import * as G from './ghost'`
      // and `import './ghost'` reported NOTHING on a target that does not
      // exist -- measured 1 finding for the named form, 0 for the other
      // three, on the same missing target.
      //
      // `.d.ts` belongs in the candidate list: a hand-written declaration file is a perfectly
      // ordinary import target (desktop/src/renderer/src/webview-types.d.ts
      // types the <webview> tag for the renderer, which has no Electron
      // types). Omitting it reported a missing-target on a live, healthy
      // file -- the exact "red on the code it protects" shape that gets a
      // gate disarmed.
      const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.d.ts`, `${base}/index.ts`];
      const target = candidates.find((c) => read(c) !== null);
      if (!target) {
        problems.push({
          kind: "missing-target",
          file: f,
          detail: `imports '${spec}' -- no candidate (${candidates.join(", ")}) exists at this ref`,
        });
        continue;
      }
      if (named.length === 0) continue; // target exists; nothing named to check on the export side
      // Export side: judged on CODE ONLY, so a commented-out or quoted
      // `export function X` does not silently satisfy the import.
      const targetSrc = codeOnlySource(read(target)!);
      for (const name of named) {
        // Second branch covers BOTH brace forms, local export list and
        // re-export: `export { A }`, `export { A } from '...'` and
        // `export type { A, B } from '...'`. The optional `type` keyword is
        // not cosmetic -- without it, desktop/src/shared/companion.ts:619
        // (`export type { CompanionDevice, CompanionInfo } from './types'`)
        // read as exporting nothing, and its importer was reported
        // not-exported on healthy code. NOTE: `export * from '...'` is
        // deliberately still NOT followed; an unrecognised re-export yields
        // a RED finding, which is the fail-CLOSED polarity. Measured: this
        // tree has exactly ONE `export *` line, `export * as React from
        // 'react'` in desktop/tests-support/react-test-harness.ts:71 -- a
        // namespace re-export of a bare package, never a resolution target,
        // so nothing is red today. Gap 6 in the header covers the related
        // `export { A as B }` fail-open, which this branch does NOT catch.
        const exported = new RegExp(
          `export\\s+(async\\s+)?(function|const|let|var|class|interface|type|enum)\\s+${name}\\b|export\\s*(?:type\\s+)?\\{[^}]*\\b${name}\\b`,
        ).test(targetSrc);
        if (!exported) {
          problems.push({
            kind: "not-exported",
            file: f,
            detail: `imports ${isType ? "type " : ""}'${name}' from ${target}, which does not export it at this ref`,
          });
        }
      }
    }
  }
  return problems;
}

const CONTROL_BYTES = [0x00, 0x1b, 0x07];

// Genuinely binary tracked assets (a real PNG, a font, an archive) contain
// NUL/ESC/BEL bytes as a matter of course -- scanning them would make this
// check permanently red on any commit that adds an icon. The defect this
// check exists to catch is a TEXT file that accidentally became binary (one
// embedded control byte).
//
// This is a DENY-list on purpose, and the polarity is the whole point. The
// first version enumerated the extensions to SCAN, which fails OPEN: every
// text extension nobody thought of is silently exempt, and the exempt set
// grows on its own as the repo does. Measured on this repo at the time of
// the inversion: the allow-list scanned 391 of 401 tracked files, silently
// skipping 5 `.kt`, 4 `.gitignore` (the leading dot read as an extension)
// and 1 `.example`. The deny-list scans 401 of 401 and excludes nothing
// currently tracked. Growth now fails CLOSED: a new text extension is
// covered by default, and a newly added binary format shows up as a loud
// red finding on the commit that adds it (add it here) rather than as
// silent absence of coverage.
const BINARY_EXT_RE = /\.(png|jpe?g|gif|bmp|ico|webp|avif|woff2?|ttf|otf|eot|zip|gz|tgz|bz2|xz|7z|rar|pdf|node|exe|dll|dylib|so|class|jar|wasm|mp[34]|wav|ogg|webm|mov|avi|psd|sqlite3?|db|bin|keystore|jks|p12|pfx)$/i;

function isTextLikePath(path: string): boolean {
  return !BINARY_EXT_RE.test(path);
}

/**
 * Literal control-byte scan, over the raw bytes of every scanned file that
 * is expected to be text (see isTextLikePath -- skips genuinely binary
 * tracked assets to avoid permanent false positives on e.g. a committed
 * icon).
 */
export function scanControlBytes(scanFiles: string[], readBinary: (path: string) => Buffer | null): Problem[] {
  const problems: Problem[] = [];
  for (const f of scanFiles) {
    if (!isTextLikePath(f)) continue;
    const buf = readBinary(f);
    if (!buf) continue;
    const hits: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if (b !== undefined && CONTROL_BYTES.includes(b)) {
        const line = buf.subarray(0, i).toString("utf8").split("\n").length;
        hits.push(`0x${b.toString(16).padStart(2, "0")} at line ${line}`);
        if (hits.length >= 3) break;
      }
    }
    if (hits.length) {
      problems.push({ kind: "control-byte", file: f, detail: hits.join(", ") });
    }
  }
  return problems;
}

export interface CheckResult {
  exitCode: 0 | 1 | 2;
  scannedFiles: string[];
  problems: Problem[];
  /** PR mode only: how many commits of base..head had their imports audited. */
  commitsAudited?: number;
  /** PR mode only: distinct files walked across those commits (import closure domain). */
  filesInCommits?: number;
  /** PR mode only: files in the net diff base...head (control-byte domain). Never add the two. */
  filesInNetDiff?: number;
}

/**
 * PR mode. The two halves of this tool are wired DIFFERENTLY on purpose, and
 * the split is the measurement, not a preference:
 *
 *   IMPORT CLOSURE runs PER COMMIT over base..head. It is the only half that
 *   can catch a mid-stack commit that references code existing nowhere but
 *   the author's working tree, and it costs nothing in false reds: replayed
 *   over the full `main..experimental` range (297 commits, 36 merges) it
 *   reported ZERO.
 *
 *   CONTROL BYTES run ONCE over the PR's NET diff (`git diff --name-only
 *   base...head`, three dots), with blobs read AT HEAD. Per commit, the same
 *   range reported 7 reds, all control-byte, on 4 files -- every one of them
 *   a real byte really committed at the time. History cannot be un-reddened,
 *   so a per-commit byte scan makes the first real PR red on day one, and a
 *   gate that is red on day one gets disarmed with `|| true`.
 *
 * TRADE-OFF, stated rather than hidden: the byte half loses the "every
 * commit stands alone" property. This is the right half to lose it in,
 * because a control byte is a defect of a file's STATE, not of coherence
 * BETWEEN commits -- if the byte is gone at head, no checkout of head can
 * suffer from it. The import closure keeps the per-commit property precisely
 * because its defect IS inter-commit.
 *
 * Why no exemption mechanism (a reference sha, or a list of historical shas
 * to skip): neither closes the hole. A merge made after the reference that
 * merges a branch containing pre-reference commits is not an ancestor of the
 * reference, so it is still audited, and its first-parent diff re-lists the
 * offending files -- measured on this repo, 2 of the 7 reds were exactly
 * that (5274713f is an ancestor of 3f3f4122^2, 381af019 of 30e67bc3^2). An
 * exemption also rots the day history is rewritten. The exemption we do not
 * write is the one that cannot rot.
 */
export function runPrCheck(repo: string, baseRef: string, headRef: string): CheckResult {
  const fail = (detail: string): CheckResult => ({
    exitCode: 2,
    scannedFiles: [],
    problems: [{ kind: "tool-error", file: "", detail }],
  });

  // FAIL CLOSED on the inputs. Every branch below would otherwise degrade
  // into an EMPTY scan that prints "OK" -- the same subset-reads-as-success
  // shape that made merge commits silently pass, reintroduced through the
  // wiring instead of the listing.
  const shallow = runGit(repo, ["rev-parse", "--is-shallow-repository"]);
  if (shallow.status !== 0) return fail(`cannot determine whether ${repo} is a shallow clone: ${shallow.stderr.trim()}`);
  if (shallow.stdout.trim() === "true") {
    return fail(
      "shallow repository: the commit range cannot be listed in full, so a scan here would silently audit a SUBSET. " +
        "In CI, set actions/checkout `fetch-depth: 0`.",
    );
  }
  // A PARTIAL clone is a different truncation and answers `false` to the
  // shallow question: the history is complete, the BLOBS are not, so every
  // read is a lazy fetch away and an offline runner degrades into the same
  // silent subset. Measured: on a `--filter=blob:none` clone,
  // `--is-shallow-repository` says false while this config key says
  // blob:none.
  const partial = runGit(repo, ["config", "--get", "remote.origin.partialclonefilter"]);
  if (partial.status === 0 && partial.stdout.trim()) {
    return fail(
      `partial clone (remote.origin.partialclonefilter=${partial.stdout.trim()}): blobs are fetched lazily, so a scan here can silently audit a SUBSET. ` +
        "In CI, clone without --filter.",
    );
  }
  for (const [name, ref] of [
    ["base", baseRef],
    ["head", headRef],
  ] as const) {
    const r = runGit(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (r.status !== 0 || !r.stdout.trim()) return fail(`${name} ref "${ref}" does not resolve to a commit in ${repo}`);
  }

  const range = runGit(repo, ["rev-list", `${baseRef}..${headRef}`]);
  if (range.status !== 0) return fail(`git rev-list ${baseRef}..${headRef} failed: ${range.stderr.trim()}`);
  const commits = range.stdout.trim().split("\n").filter(Boolean);

  const problems: Problem[] = [];
  const scannedFiles = new Set<string>();
  const commitFiles = new Set<string>();

  // Half 1: import closure, per commit, judged at each commit's own tree.
  for (const sha of commits) {
    let files: string[];
    try {
      files = listCommitFiles(repo, sha);
    } catch (e) {
      return fail(String(e));
    }
    for (const f of files) {
      scannedFiles.add(f);
      commitFiles.add(f);
    }
    const read = makeBlobReader(repo, sha);
    const { aliases, divergence } = aliasTableFromTsconfig(read);
    for (const d of divergence) {
      problems.push({ kind: "alias-divergence", file: `${sha.slice(0, 8)}: ${TSCONFIGS_WITH_SHARED_ALIAS.join(" vs ")}`, detail: d });
    }
    for (const p of resolveImportClosure(files, read, aliases)) {
      problems.push({ ...p, file: `${sha.slice(0, 8)}: ${p.file}` });
    }
  }

  // Half 2: control bytes, once, over the NET diff, read at head.
  const net = runGit(repo, ["diff", "--name-only", "-z", `${baseRef}...${headRef}`]);
  if (net.status !== 0) return fail(`git diff --name-only ${baseRef}...${headRef} failed: ${net.stderr.trim()}`);
  const netFiles = splitZ(net.stdout);
  for (const f of netFiles) scannedFiles.add(f);
  problems.push(...scanControlBytes(netFiles, makeBinaryBlobReader(repo, headRef)));

  return {
    exitCode: problems.length === 0 ? 0 : 1,
    scannedFiles: [...scannedFiles],
    problems,
    commitsAudited: commits.length,
    filesInCommits: commitFiles.size,
    filesInNetDiff: netFiles.length,
  };
}

/**
 * Runs both checks for either mode. `mode` picks the file-listing and blob
 * resolution strategy; everything downstream is identical, which is what
 * keeps sha mode and --staged mode from silently drifting apart.
 */
export function runCheck(mode: "sha" | "staged", target: string | undefined, repo: string): CheckResult {
  let scanFiles: string[];
  let ref: string;
  try {
    if (mode === "sha") {
      if (!target) throw new Error("sha mode requires a commit sha");
      scanFiles = listCommitFiles(repo, target);
      ref = target;
    } else {
      scanFiles = listStagedFiles(repo);
      ref = "staged";
    }
  } catch (e) {
    return { exitCode: 2, scannedFiles: [], problems: [{ kind: "missing-target", file: "", detail: String(e) }] };
  }

  const read = makeBlobReader(repo, ref);
  const readBinary = makeBinaryBlobReader(repo, ref);
  const { aliases, divergence } = aliasTableFromTsconfig(read);

  const problems: Problem[] = [];
  for (const d of divergence) problems.push({ kind: "alias-divergence", file: TSCONFIGS_WITH_SHARED_ALIAS.join(" vs "), detail: d });
  problems.push(...resolveImportClosure(scanFiles, read, aliases));
  problems.push(...scanControlBytes(scanFiles, readBinary));

  return { exitCode: problems.length === 0 ? 0 : 1, scannedFiles: scanFiles, problems };
}

const USAGE = [
  "usage: bun scripts/check-commit-closure.ts <sha> [repo]",
  "       bun scripts/check-commit-closure.ts --staged [repo]",
  "       bun scripts/check-commit-closure.ts --pr <base> <head> [repo]",
].join("\n");

function main() {
  const args = process.argv.slice(2);
  const staged = args.includes("--staged");
  const pr = args.includes("--pr");
  const positional = args.filter((a) => a !== "--staged" && a !== "--pr");

  let result: CheckResult;
  let label: string;
  if (pr) {
    const [base, head, repoArg] = positional;
    if (!base || !head) {
      console.error("--pr needs both a base and a head ref");
      console.error(USAGE);
      process.exit(2);
    }
    const repo = repoArg || process.cwd();
    result = runPrCheck(repo, base, head);
    // Two different domains, never summed: the first count is files walked
    // across the audited commits, the second is the net diff. Adding them
    // yields a number that means nothing.
    label =
      `PR ${base}...${head}: ${result.commitsAudited ?? 0} commit(s) audited for import closure ` +
      `(${result.filesInCommits ?? 0} file(s) walked), ${result.filesInNetDiff ?? 0} file(s) in the net diff for control bytes`;
  } else {
    const mode: "sha" | "staged" = staged ? "staged" : "sha";
    const target = staged ? undefined : positional[0];
    const repo = (staged ? positional[0] : positional[1]) || process.cwd();
    if (mode === "sha" && !target) {
      console.error(USAGE);
      process.exit(2);
    }
    result = runCheck(mode, target, repo);
    label = mode === "sha" ? `commit ${target}` : "staged index";
  }

  console.log(`${label}: ${result.scannedFiles.length} file(s)\n`);
  for (const p of result.problems) {
    const tag =
      p.kind === "missing-target"
        ? "MISSING TARGET "
        : p.kind === "not-exported"
          ? "NOT EXPORTED   "
          : p.kind === "control-byte"
            ? "CONTROL BYTE   "
            : p.kind === "tool-error"
              ? "TOOL ERROR     "
              : "ALIAS DIVERGE  ";
    console.log(`  ${tag} ${p.file}: ${p.detail}`);
  }
  // A tool error must never be summarised alongside an "OK": exit 2 means
  // NOTHING was audited, and printing either "OK" line there is exactly the
  // empty-scan-reads-as-success shape this tool exists to refuse.
  if (result.problems.some((p) => p.kind === "tool-error")) {
    console.log("\n  NOT AUDITED (see TOOL ERROR above)");
    process.exit(result.exitCode);
  }
  // "OK" over an EMPTY domain is the same lie as an OK over an unscanned
  // merge: exit 0 is honest (nothing is wrong), the word OK is not (nothing
  // was looked at).
  if (result.scannedFiles.length === 0 && (result.commitsAudited ?? 0) === 0) {
    console.log(`\n  NOTHING TO AUDIT (${pr ? "empty range" : staged ? "empty index" : "commit touches no file"})`);
    process.exit(result.exitCode);
  }
  const closureProblems = result.problems.filter((p) => p.kind !== "control-byte").length;
  const byteProblems = result.problems.filter((p) => p.kind === "control-byte").length;
  console.log(closureProblems === 0 ? "\n  import closure: OK" : `\n  import closure: ${closureProblems} problem(s)`);
  console.log(byteProblems === 0 ? "  control bytes: OK" : `  control bytes: ${byteProblems} file(s) affected`);
  process.exit(result.exitCode);
}

if (import.meta.main) {
  main();
}
