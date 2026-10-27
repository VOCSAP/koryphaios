// Pure audit of the Deck's state files, run on injected {path: text} sources.
// Coverage gaps, by design:
// - Only DATA_EXT literals are candidates.
// - Constructors match names rather than imports, so local homonyms and constant groups pass.
// - capturedDirectoryFiles exempts every captured.directory call in inbox-session.ts, including calls outside the factory; behavior tests prove provenance.
// - Factory aliases (`const f = createInboxEffects`) evade the single-call check.
// - registerIpc lacks bindingFactory, so inline accessors are accepted.
// - Comment removal misses a decoy in a string.
// - The scan covers only desktop/src/main.

import { findMatchingClose } from "./_braced-body";

export type StateScope = "session" | "run" | "project" | "machine";

export interface WiringRule {
  /** Function taking the directory the file is written under. */
  callee: string;
  /** Positional index of the dir argument, or the property carrying it in the first object argument. */
  dirArg: number | { prop: string };
}

export interface StateFileRule {
  scope: StateScope;
  reason: string;
  /** 'literal' = a quoted file name; 'constructor' = the function (or IPC handler) building the name. */
  kind: "literal" | "constructor";
  /** Session files only: the module defining the accessors (excluded from the wiring scan) and the accessors themselves. */
  module?: string;
  wiring?: readonly WiringRule[];
}

export interface NotAppStateRule {
  /** Why this name is not a file under the Deck's state dir. */
  reason: string;
}

export interface AccessorBinding {
  /** File that wires the accessor another file calls (index.ts registering ipc deps). */
  file: string;
  callee: string;
  prop: string;
  /** `callee` is called exactly once in the whole scan, in `file`, with `prop` written once and no spread in the object. */
  singleCall?: boolean;
  /** `prop` is the bare identifier of that name, and its sole const binding in `file` calls this factory. */
  bindingFactory?: string;
}

export interface AuditInput {
  sources: Record<string, string>;
  stateScopes: Record<string, StateFileRule>;
  notAppState: Record<string, NotAppStateRule>;
  /** Names of the per-group directory builders (session-state.ts's sessionStateDir and its closable accessor factory). */
  sessionDirBuilders: readonly string[];
  accessorBindings?: readonly AccessorBinding[];
  /** Files whose store calls take `captured.directory`, derived from an injected accessor by the factory itself. */
  capturedDirectoryFiles?: readonly string[];
}

export type FindingKind =
  | "unclassified-literal"
  | "unclassified-constructor"
  | "unattributed-template"
  | "unwired-session-call"
  | "session-literal-outside-module"
  | "unparsed-call"
  | "unbound-accessor"
  | "stale-rule";

export interface Finding {
  kind: FindingKind;
  file: string;
  line: number;
  detail: string;
}

export const DATA_EXT = ["json", "jsonl", "md", "txt", "png", "webm", "mp4", "log", "pem", "crt", "key", "db", "sqlite", "lock", "tmp"] as const;

const extAlt = DATA_EXT.join("|");
const LITERAL_RE = new RegExp(`(['"])(\\.?[A-Za-z0-9_][A-Za-z0-9_.-]*\\.(?:${extAlt}))\\1`, "g");
const TEMPLATE_RE = /`([^`]*)`/g;
const TEMPLATE_NAME_TAIL_RE = new RegExp(`\\.(?:${extAlt})$`);
const TEMPLATE_FILE_IDENT_RE = /\$\{[^}]*\bFILE\b[^}]*\}|\$\{[^}]*_FILE\b[^}]*\}/;
/** Declarations a computed name can be attributed to, nearest preceding wins. */
const DECL_RE =
  /function\s+([A-Za-z_$][\w$]*)\s*[(<]|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*(?:async\s*)?[(<]|reg(?:Handle|On)\(\s*'([^']+)'|^\s*(?:private|protected|public|static|async|\s)*(?!(?:if|for|while|switch|catch|return)\b)([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{\n]*)?\{\s*$/gm;
/** `const NAME = \`...\``: the template IS the initializer. */
const DIRECT_INIT_RE = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*$/;

export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let inString: string | null = null;
  while (i < src.length) {
    const c = src[i]!;
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < src.length) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      // A quoted string never spans a line; a regex literal such as /"([^"]*)"/
      // would otherwise open a "string" that swallows the comments below it.
      if (c === inString || (c === "\n" && inString !== "`")) inString = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n"; // keep line numbers stable
        i++;
      }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function lineAt(src: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === "\n") n++;
  return n;
}

/** Nearest declaration name preceding `pos`, or null when none is found. */
function attribute(src: string, pos: number): string | null {
  const before = src.slice(0, pos);
  const direct = before.match(DIRECT_INIT_RE);
  if (direct) return direct[1]!;
  let last: string | null = null;
  DECL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DECL_RE.exec(before)) !== null) {
    last = m[1] ?? m[2] ?? m[3] ?? m[4] ?? null;
  }
  return last;
}

/** Top-level comma split of an argument list (nesting- and quote-aware). */
function splitArgs(argText: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  let start = 0;
  for (let i = 0; i < argText.length; i++) {
    const c = argText[i]!;
    if (inString) {
      if (c === "\\") i++;
      else if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") inString = c;
    else if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      out.push(argText.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = argText.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/** Value of `prop:` inside an object literal text, or null. */
function objectProp(objText: string, prop: string): string | null {
  const trimmed = objText.trim();
  if (!trimmed.startsWith("{")) return null;
  const body = trimmed.slice(1, findMatchingClose(trimmed, 0, "{", "}", true) - 1);
  for (const entry of splitArgs(body)) {
    const m = entry.match(/^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/);
    if (m && m[1] === prop) return m[2]!.trim();
    if (entry === prop) return prop; // shorthand `{ dir }`
  }
  return null;
}

/** Every `callee(` call in the scan, declarations and import specifiers excluded. */
function findCalls(callee: string, sources: Record<string, string>): Array<{ file: string; src: string; open: number }> {
  const callRe = new RegExp(`(?<![.\\w$])${callee}\\s*\\(`, "g");
  const calls: Array<{ file: string; src: string; open: number }> = [];
  for (const [file, src] of Object.entries(sources)) {
    let m: RegExpExecArray | null;
    callRe.lastIndex = 0;
    while ((m = callRe.exec(src)) !== null) {
      const before = src.slice(Math.max(0, m.index - 40), m.index);
      if (/function\s+$/.test(before) || /import\s*\{[^}]*$/.test(before)) continue;
      calls.push({ file, src, open: m.index + m[0].length - 1 });
    }
  }
  return calls;
}

/** Problem with the object literal text for a single-call binding, or null. */
function objectKeyProblem(objText: string, prop: string): string | null {
  const trimmed = objText.trim();
  if (!trimmed.startsWith("{")) return `the argument ${JSON.stringify(trimmed.slice(0, 60))} is not an object literal`;
  const body = trimmed.slice(1, findMatchingClose(trimmed, 0, "{", "}", true) - 1);
  const entries = splitArgs(body);
  if (entries.some((entry) => entry.startsWith("..."))) return `a spread in the object could override ${prop}`;
  const written = entries.filter((entry) => entry === prop || new RegExp(`^${prop}\\s*:`).test(entry));
  return written.length > 1 ? `${prop} is written ${written.length} times in the object` : null;
}

/**
 * Does `expr` (the dir argument text) reach the per-group directory? Either
 * the builder is called in the expression itself, or the expression is a bare
 * identifier / zero-arg call whose EVERY `const` binding in the file contains
 * the builder call. Ambiguity (a binding without the call) fails closed.
 */
function resolvesToSessionDir(expr: string, fileSrc: string, builders: readonly string[]): { ok: boolean; why: string } {
  const builder = builders.join("|");
  const builderCall = new RegExp(`\\b(?:${builder})\\(`);
  if (builderCall.test(expr)) return { ok: true, why: "builder call in expression" };
  const ident = expr.match(/^([A-Za-z_$][\w$]*)(?:\(\))?$/);
  if (!ident) return { ok: false, why: `dir expression ${JSON.stringify(expr)} neither calls ${builder} nor is an identifier` };
  const name = ident[1]!;
  const bindingRe = new RegExp(`(?:const|let)\\s+${name}\\b[^=\\n]*=\\s*([^\\n]+)`, "g");
  const bindings: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = bindingRe.exec(fileSrc)) !== null) bindings.push(m[1]!);
  if (bindings.length === 0) return { ok: false, why: `identifier ${name} has no const/let binding in this file` };
  const bad = bindings.filter((b) => !builderCall.test(b));
  if (bad.length > 0) return { ok: false, why: `binding of ${name} does not call ${builder}: ${bad[0]!.trim()}` };
  return { ok: true, why: `all ${bindings.length} binding(s) of ${name} call ${builder}` };
}

export function auditStateScopes(input: AuditInput): Finding[] {
  const findings: Finding[] = [];
  const seenLiterals = new Set<string>();
  const seenConstructors = new Set<string>();
  const seenNotAppState = new Set<string>();
  const stripped: Record<string, string> = {};
  for (const [file, raw] of Object.entries(input.sources)) stripped[file] = stripComments(raw);

  // 1. Quoted file names.
  for (const [file, src] of Object.entries(stripped)) {
    LITERAL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LITERAL_RE.exec(src)) !== null) {
      const name = m[2]!;
      if (input.notAppState[name]) {
        seenNotAppState.add(name);
        continue;
      }
      const rule = input.stateScopes[name];
      if (rule && rule.kind === "literal") {
        seenLiterals.add(name);
        // A session file has ONE writer, its module: the same name written
        // elsewhere bypasses the accessors the wiring scan guards.
        if (rule.scope === "session" && rule.module && file !== rule.module && !file.endsWith(`/${rule.module}`)) {
          findings.push({ kind: "session-literal-outside-module", file, line: lineAt(src, m.index), detail: `${name} is owned by ${rule.module}` });
        }
        continue;
      }
      findings.push({ kind: "unclassified-literal", file, line: lineAt(src, m.index), detail: name });
    }
  }

  // 2. Computed names: template literals attributed to their constructor.
  for (const [file, src] of Object.entries(stripped)) {
    TEMPLATE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TEMPLATE_RE.exec(src)) !== null) {
      const body = m[1]!;
      if (!body.includes("${")) continue;
      if (!TEMPLATE_NAME_TAIL_RE.test(body) && !TEMPLATE_FILE_IDENT_RE.test(body)) continue;
      const line = lineAt(src, m.index);
      const owner = attribute(src, m.index);
      if (!owner) {
        findings.push({ kind: "unattributed-template", file, line, detail: `\`${body}\`` });
        continue;
      }
      if (input.notAppState[owner]) {
        seenNotAppState.add(owner);
        continue;
      }
      const rule = input.stateScopes[owner];
      if (rule && rule.kind === "constructor") {
        seenConstructors.add(owner);
        continue;
      }
      findings.push({ kind: "unclassified-constructor", file, line, detail: `${owner} builds \`${body}\`` });
    }
  }

  // 3. Session files: every caller of their accessors passes the per-group dir.
  // Scanned once per accessor (two files of one module share their accessors).
  const accessors = new Map<string, { module: string | undefined; dirArg: WiringRule["dirArg"]; guards: string[] }>();
  for (const [name, rule] of Object.entries(input.stateScopes)) {
    if (rule.scope !== "session" || !rule.wiring) continue;
    for (const w of rule.wiring) {
      const known = accessors.get(w.callee);
      if (known) known.guards.push(name);
      else accessors.set(w.callee, { module: rule.module, dirArg: w.dirArg, guards: [name] });
    }
  }
  for (const [callee, acc] of accessors) {
    const callRe = new RegExp(`(?<![.\\w$])${callee}\\s*\\(`, "g");
    for (const [file, src] of Object.entries(stripped)) {
      if (acc.module && (file === acc.module || file.endsWith(`/${acc.module}`))) continue;
      let m: RegExpExecArray | null;
      callRe.lastIndex = 0;
      while ((m = callRe.exec(src)) !== null) {
        const open = m.index + m[0].length - 1;
        // A declaration `function callee(` or an import specifier is not a call.
        const before = src.slice(Math.max(0, m.index - 40), m.index);
        if (/function\s+$/.test(before) || /import\s*\{[^}]*$/.test(before)) continue;
        const line = lineAt(src, m.index);
        let argText: string;
        try {
          argText = src.slice(open + 1, findMatchingClose(src, open, "(", ")", true) - 1);
        } catch (e) {
          findings.push({ kind: "unparsed-call", file, line, detail: `${callee}: ${String(e)}` });
          continue;
        }
        const args = splitArgs(argText);
        const dirExpr =
          typeof acc.dirArg === "number" ? (args[acc.dirArg] ?? null) : args[0] !== undefined ? objectProp(args[0], acc.dirArg.prop) : null;
        if (dirExpr === null) {
          findings.push({ kind: "unparsed-call", file, line, detail: `${callee}(${argText.trim()}): dir argument not found` });
          continue;
        }
        if (dirExpr === "captured.directory" && input.capturedDirectoryFiles?.includes(file)) continue;
        const r = resolvesToSessionDir(dirExpr, src, input.sessionDirBuilders);
        if (!r.ok) {
          findings.push({ kind: "unwired-session-call", file, line, detail: `${callee} (${acc.guards.join(", ")}): ${r.why}` });
        }
      }
    }
  }

  // 4. Accessor bindings across files (the deps object handing the builder to another module).
  for (const b of input.accessorBindings ?? []) {
    const src = stripped[b.file];
    if (src === undefined) {
      findings.push({ kind: "unbound-accessor", file: b.file, line: 0, detail: `file not in scan` });
      continue;
    }
    let open: number;
    if (b.singleCall) {
      const calls = findCalls(b.callee, stripped);
      if (calls.length !== 1) {
        findings.push({ kind: "unbound-accessor", file: b.file, line: 0, detail: `${b.callee} is called ${calls.length} times in the scan (expected exactly 1)` });
        continue;
      }
      if (calls[0]!.file !== b.file) {
        findings.push({ kind: "unbound-accessor", file: calls[0]!.file, line: 0, detail: `${b.callee} is called outside ${b.file}` });
        continue;
      }
      open = calls[0]!.open;
    } else {
      const m = new RegExp(`(?<![.\\w$])${b.callee}\\s*\\(`).exec(src);
      if (!m) {
        findings.push({ kind: "unbound-accessor", file: b.file, line: 0, detail: `${b.callee}( not found` });
        continue;
      }
      open = m.index + m[0].length - 1;
    }
    const line = lineAt(src, open);
    const argText = src.slice(open + 1, findMatchingClose(src, open, "(", ")", true) - 1);
    if (b.singleCall) {
      const problem = objectKeyProblem(argText, b.prop);
      if (problem !== null) {
        findings.push({ kind: "unbound-accessor", file: b.file, line, detail: `${b.prop}: ${problem}` });
        continue;
      }
    }
    const value = objectProp(argText, b.prop);
    if (value === null) {
      findings.push({ kind: "unbound-accessor", file: b.file, line, detail: `${b.callee}({ ${b.prop}: ... }) missing` });
      continue;
    }
    if (b.bindingFactory) {
      if (value !== b.prop) {
        findings.push({ kind: "unbound-accessor", file: b.file, line, detail: `${b.prop}: ${JSON.stringify(value)} is not the bare identifier ${b.prop}` });
        continue;
      }
      const bindings = [...src.matchAll(new RegExp(`\\b(const|let|var)\\s+${b.prop}\\b[^=\\n]*=\\s*([^\\n]+)`, "g"))];
      if (bindings.length !== 1 || bindings[0]![1] !== "const" || !new RegExp(`\\b${b.bindingFactory}\\(`).test(bindings[0]![2]!)) {
        findings.push({ kind: "unbound-accessor", file: b.file, line, detail: `${b.prop} must have exactly one binding, declared const and calling ${b.bindingFactory} (found ${bindings.length})` });
      }
      continue;
    }
    const r = resolvesToSessionDir(value, src, input.sessionDirBuilders);
    if (!r.ok) findings.push({ kind: "unbound-accessor", file: b.file, line, detail: `${b.prop}: ${r.why}` });
  }

  // 5. Stale rules: a classification nothing in the tree uses is a decision about a file that no longer exists.
  for (const [name, rule] of Object.entries(input.stateScopes)) {
    const seen = rule.kind === "literal" ? seenLiterals.has(name) : seenConstructors.has(name);
    if (!seen) findings.push({ kind: "stale-rule", file: "(table)", line: 0, detail: `${name} (${rule.kind}) matched nothing` });
  }
  for (const name of Object.keys(input.notAppState)) {
    if (!seenNotAppState.has(name)) findings.push({ kind: "stale-rule", file: "(table)", line: 0, detail: `not-app-state ${name} matched nothing` });
  }

  return findings;
}

export function formatFindings(findings: Finding[]): string {
  return findings.map((f) => `  [${f.kind}] ${f.file}:${f.line} ${f.detail}`).join("\n");
}
