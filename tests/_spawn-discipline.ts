// Spawn discipline of the tests that launch a server: every launch must pass
// env: scrubEnv(...), or the child inherits this session's peer identity and
// overwrites it. Read on the TypeScript AST. Every reference to a launch
// binding (Bun, Bun.spawn/spawnSync/$, what `bun` exports, what child_process
// exports through import, require or destructuring) is either the direct
// callee of a launch whose options are then judged, or it is reported as not
// understood; so are a dynamic import of those modules and new Worker(). A
// launch hidden behind a wrapper function of the test's own is not seen.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/** A server entry named at a path boundary: avatar-server.ts is another program. */
export const SERVER_ARTIFACT = /(?:^|[\\/"'`\s=])server(?:-deck)?\.(?:ts|[cm]?js)\b/;

const CHILD_PROCESS_MODULES = new Set(["node:child_process", "child_process"]);
const CHILD_PROCESS_LAUNCHES = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);
const COMMAND_LINE_LAUNCHES = new Set(["exec", "execSync"]);
const BUN_LAUNCHES = new Set(["spawn", "spawnSync"]);
const BUN_LAUNCH_MEMBERS = new Set(["spawn", "spawnSync", "$"]);
const SCRUB_ENV_MODULES = new Set(["./_helper.ts", "./_helper", "./_scrub-env.ts", "./_scrub-env"]);

/**
 * Exact number of server launches per test file (path relative to tests/, `/`
 * separators). A new server test adds its line here: the friction is the point,
 * a total that only has to stay above zero hides a file that stopped launching.
 */
export const EXPECTED_LAUNCHES: Readonly<Record<string, number>> = {
  "broker-desktop-roadmap-service.test.ts": 4,
  "broker-expects-reply-delivery.test.ts": 1,
  "broker-register-body.test.ts": 1,
  "broker-register-role.test.ts": 1,
  "deck-lead-node-bundle.test.ts": 2,
  "deck-mcp-surface.test.ts": 1,
  "deck-mcp-tools-allowlist.test.ts": 1,
  "desktop-deck-control.test.ts": 2,
  "mcp-instructions-registry.test.ts": 1,
  "mcp-roadmap-ack.test.ts": 1,
  "probe-askuserquestion-hooks.test.ts": 2,
  "server-ask-operator.test.ts": 2,
  "server-cleanup-identity.test.ts": 1,
  "server-deck-reply-route.test.ts": 2,
  "server-deck-token-authz.test.ts": 1,
  "server-deck-tools-parity.test.ts": 1,
  "server-inbound-framing-delivery.test.ts": 2,
  "server-roadmap-inactive-agent-guard.test.ts": 1,
  "server-roadmap-inactive-marker.test.ts": 1,
  "server-roadmap-queue-order.test.ts": 1,
  "server-scrub-env-home-redirect.test.ts": 1,
  "server-set-id-identity.test.ts": 1,
  "server-stdin-eof.test.ts": 1,
  "server-tools-allowlist.test.ts": 1,
};

export interface Launch {
  callee: string;
  scrubbed: boolean;
  line: number;
}

export interface Unrecognized {
  text: string;
  line: number;
}

export interface LaunchScan {
  namesServer: boolean;
  launches: Launch[];
  unrecognized: Unrecognized[];
}

type Origin = { module: "child_process" | "bun"; name: string } | { module: "child_process" | "bun"; namespace: true };

interface Bindings {
  /** Local identifier -> what it is bound to. */
  origins: Map<string, Origin>;
  scrubEnvImported: boolean;
  scrubEnvRedeclared: boolean;
}

function moduleKind(specifier: string): "child_process" | "bun" | null {
  if (CHILD_PROCESS_MODULES.has(specifier)) return "child_process";
  if (specifier === "bun") return "bun";
  return null;
}

function requiredModule(node: ts.Node): "child_process" | "bun" | null {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "require") return null;
  const [first] = node.arguments;
  return first !== undefined && ts.isStringLiteralLike(first) ? moduleKind(first.text) : null;
}

function bindPattern(bindings: Bindings, name: ts.BindingName, module: "child_process" | "bun"): void {
  if (ts.isIdentifier(name)) {
    bindings.origins.set(name.text, { module, namespace: true });
    return;
  }
  if (!ts.isObjectBindingPattern(name)) return;
  for (const element of name.elements) {
    if (!ts.isIdentifier(element.name)) continue;
    const imported = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
    bindings.origins.set(element.name.text, { module, name: imported });
  }
}

function collectBindings(file: ts.SourceFile): Bindings {
  const bindings: Bindings = { origins: new Map(), scrubEnvImported: false, scrubEnvRedeclared: false };
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const from = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const module = moduleKind(from);
    const named = clause.namedBindings;
    if (module !== null) {
      if (clause.name) bindings.origins.set(clause.name.text, { module, namespace: true });
      if (named && ts.isNamespaceImport(named)) bindings.origins.set(named.name.text, { module, namespace: true });
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          if (element.isTypeOnly) continue;
          bindings.origins.set(element.name.text, { module, name: (element.propertyName ?? element.name).text });
        }
      }
    }
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        if (element.name.text !== "scrubEnv") continue;
        const imported = (element.propertyName ?? element.name).text;
        if (imported === "scrubEnv" && SCRUB_ENV_MODULES.has(from)) bindings.scrubEnvImported = true;
        else bindings.scrubEnvRedeclared = true;
      }
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const module = requiredModule(node.initializer);
      if (module !== null) bindPattern(bindings, node.name, module);
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isParameter(node) || ts.isClassDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      node.name.text === "scrubEnv"
    ) {
      bindings.scrubEnvRedeclared = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return bindings;
}

function namesServer(file: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && SERVER_ARTIFACT.test(node.text)) found = true;
    if ((ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && SERVER_ARTIFACT.test(node.text)) found = true;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function inTypePosition(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (ts.isTypeNode(current) || ts.isTypeQueryNode(current)) return true;
    if (ts.isStatement(current) || ts.isSourceFile(current)) return false;
  }
  return false;
}

/** Declarations and member names are not references. */
function isDeclarationOrMemberName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) return true;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if ((ts.isFunctionDeclaration(parent) || ts.isParameter(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) return true;
  return false;
}

/** The launch a direct, non-optional call is, or null. */
function directCall(node: ts.Expression): ts.CallExpression | null {
  const parent = node.parent;
  return ts.isCallExpression(parent) && parent.expression === node && parent.questionDotToken === undefined ? parent : null;
}

type Classified = { kind: "bun" | "child_process"; name: string; call: ts.CallExpression } | "not understood" | "ignored";

/** Judges one reference to a launch binding (an identifier bound to Bun, bun or child_process). */
function classifyReference(node: ts.Identifier, bindings: Bindings): Classified {
  const origin: Origin | undefined = node.text === "Bun" && !bindings.origins.has("Bun") ? { module: "bun", namespace: true } : bindings.origins.get(node.text);
  if (origin === undefined) return "ignored";
  if (!("namespace" in origin)) {
    const call = directCall(node);
    if (call === null) return "not understood";
    if (origin.module === "child_process" && CHILD_PROCESS_LAUNCHES.has(origin.name)) return { kind: "child_process", name: origin.name, call };
    if (origin.module === "bun" && BUN_LAUNCHES.has(origin.name)) return { kind: "bun", name: origin.name, call };
    return "not understood";
  }
  const parent = node.parent;
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node || parent.questionDotToken !== undefined) return "not understood";
  const member = parent.name.text;
  const launchMembers = origin.module === "child_process" ? CHILD_PROCESS_LAUNCHES : BUN_LAUNCH_MEMBERS;
  if (!launchMembers.has(member)) return "ignored";
  const call = directCall(parent);
  if (call === null || member === "$") return "not understood";
  return { kind: origin.module, name: member, call };
}

/**
 * A call spelled like a launch whose callee is bound to none of the tracked
 * modules: a local spawn() or runner.spawnSync() may wrap the real one.
 * `.exec` on an unknown object is RegExp.exec or a database, not a launch.
 */
function launchNamedCallOfUnknownOwner(callee: ts.Expression, bindings: Bindings): boolean {
  if (ts.isIdentifier(callee)) return CHILD_PROCESS_LAUNCHES.has(callee.text) && !bindings.origins.has(callee.text);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const member = callee.name.text;
  if (!CHILD_PROCESS_LAUNCHES.has(member) || member === "exec") return false;
  const owner = callee.expression;
  return !(ts.isIdentifier(owner) && (owner.text === "Bun" || bindings.origins.has(owner.text)));
}

function optionsArgument(call: ts.CallExpression, kind: "bun" | "child_process", name: string): ts.Expression | undefined {
  const [first, second, third] = call.arguments;
  if (kind === "bun") return first !== undefined && ts.isObjectLiteralExpression(first) ? first : second;
  if (COMMAND_LINE_LAUNCHES.has(name)) return second;
  return second !== undefined && ts.isArrayLiteralExpression(second) ? third : second;
}

function isScrubbed(options: ts.Expression | undefined, bindings: Bindings): boolean {
  if (options === undefined || !ts.isObjectLiteralExpression(options)) return false;
  if (!bindings.scrubEnvImported || bindings.scrubEnvRedeclared) return false;
  const properties = options.properties;
  const envIndexes: number[] = [];
  for (const [index, property] of properties.entries()) {
    if (ts.isSpreadAssignment(property)) continue;
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return false;
    const name = property.name;
    if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) return false;
    if (name.text === "env") envIndexes.push(index);
  }
  if (envIndexes.length !== 1) return false;
  const envIndex = envIndexes[0]!;
  if (properties.slice(envIndex + 1).some((property) => ts.isSpreadAssignment(property))) return false;
  const env = properties[envIndex]!;
  if (!ts.isPropertyAssignment(env)) return false;
  const value = env.initializer;
  return ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === "scrubEnv";
}

export function scanLaunches(fileName: string, source: string): LaunchScan {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const bindings = collectBindings(file);
  const launches: Launch[] = [];
  const unrecognized: Unrecognized[] = [];
  const lineOf = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const refuse = (node: ts.Node) => unrecognized.push({ text: node.getText(file), line: lineOf(node) });
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !isDeclarationOrMemberName(node) && !inTypePosition(node)) {
      const classified = classifyReference(node, bindings);
      if (classified === "not understood") refuse(node.parent);
      else if (classified !== "ignored") {
        launches.push({
          callee: classified.call.expression.getText(file),
          scrubbed: isScrubbed(optionsArgument(classified.call, classified.kind, classified.name), bindings),
          line: lineOf(classified.call),
        });
      }
    }
    if (ts.isCallExpression(node)) {
      const module = requiredModule(node);
      if (module !== null && !ts.isVariableDeclaration(node.parent)) refuse(node);
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const [first] = node.arguments;
        if (first !== undefined && ts.isStringLiteralLike(first) && moduleKind(first.text) !== null) refuse(node);
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Worker") refuse(node);
    if (ts.isCallExpression(node) && launchNamedCallOfUnknownOwner(node.expression, bindings)) refuse(node.expression);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { namesServer: namesServer(file), launches, unrecognized };
}

export function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return entry.isFile() && /\.[cm]?[tj]sx?$/.test(entry.name) ? [path] : [];
  });
}

export interface DomainFinding {
  file: string;
  problem: string;
}

/**
 * Every file naming a server has exactly its tabled number of launches, all
 * scrubbed, and no launch the scan does not understand; every tabled file
 * still exists and still names a server.
 */
export function auditDomain(files: Array<{ file: string; source: string }>): DomainFinding[] {
  const findings: DomainFinding[] = [];
  const seen = new Set<string>();
  for (const { file, source } of files) {
    if (!SERVER_ARTIFACT.test(source)) continue;
    const scan = scanLaunches(file, source);
    if (!scan.namesServer) continue;
    seen.add(file);
    for (const launch of scan.unrecognized) findings.push({ file, problem: `line ${launch.line}: launch form not understood: ${launch.text}` });
    for (const launch of scan.launches) {
      if (!launch.scrubbed) findings.push({ file, problem: `line ${launch.line}: ${launch.callee} without a top-level env: scrubEnv(...)` });
    }
    const expected = EXPECTED_LAUNCHES[file] ?? 0;
    if (scan.launches.length !== expected) {
      findings.push({ file, problem: `${scan.launches.length} launches, the table expects ${expected}` });
    }
  }
  for (const file of Object.keys(EXPECTED_LAUNCHES)) {
    if (!seen.has(file)) findings.push({ file, problem: "tabled but missing, or no longer names a server" });
  }
  return findings;
}
