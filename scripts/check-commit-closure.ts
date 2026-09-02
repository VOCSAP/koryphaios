// Checks import closure (relative and @shared/* imports resolve against the
// tree being verified, never the working tree) and literal control bytes in
// tracked blobs, across --pr, sha, and --staged modes.
// Exit 0 clean, 1 at least one finding, 2 usage/tool error, so a broken
// invocation is distinguishable from a real finding in CI logs.
// Known gaps: no reverse-import check, symbol name matched but not shape/type,
// and merges audited against their first parent only.

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
 * A merge is audited against its first parent -- the diff it introduces into
 * the branch it merges into -- because `git show --name-only` prints nothing
 * for a merge commit.
 * Blobs are still read at the merge sha itself, so what is judged is the merged
 * tree, not either parent alone.
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
 * Blanks every comment body (spaces/newlines preserved, so offsets stay
 * unchanged) and flags characters inside a string/template/regex literal, so an
 * import statement that is merely quoted is never parsed as a real one.
 * An ambiguous `/` is resolved as division, never regex, so a mis-lex stays
 * bounded to one line instead of swallowing the rest of the file.
 * JSX text is not distinguished from code: a literal `/*` or stray backtick in
 * rendered text can open a comment or template that runs unbounded to end of
 * file.
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

  // Regex-literal tracking is required: ordinary code like `/"/g` would
  // otherwise let the quote inside the regex desynchronize string masking for
  // the rest of the file.
  // A `/` is read as a regex only when the previous token cannot end an
  // expression; otherwise it's division, since a wrong regex guess can swallow
  // the whole file while a wrong division guess only mis-lexes one line.
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

      // Target resolution runs for every import form before checking whether
      // anything is named, so a default, namespace, or side-effect import is
      // checked against a missing target too, not just the named form.
      // .d.ts is a valid candidate: a hand-written declaration file (e.g.
      // webview-types.d.ts) is a real import target with no .ts sibling.
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
        // Matches both brace export forms, local (`export { A }`) and re-export
        // (`export { A } from`), including the optional `type` keyword needed
        // to recognize a type-only re-export as exporting the name.
        // `export * from` is deliberately not followed and yields a finding
        // instead -- a fail-closed choice for a re-export this scan cannot
        // verify.
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

// Deny-list, not an allow-list: an allow-list of text extensions fails open by
// silently exempting anything unlisted, so this scans every tracked file by
// default and a new binary format must be added here explicitly.
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
 * Import closure runs per commit over base..head, since it's the only half that
 * can catch a mid-stack commit referencing code that exists only in the
 * author's working tree.
 * Control bytes run once over the PR's net diff at head instead: a control byte
 * is a defect of a file's state, not of coherence between commits, and history
 * cannot be un-reddened.
 * No exemption list: a merge that brings in pre-exemption commits is still
 * audited via its own first-parent diff, so an exemption would neither close
 * the hole nor survive history being rewritten.
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
