import { jest, mock, vi } from "bun:test";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const GUARD_REPO_ROOT = resolve(import.meta.dir, "..");
const GUARD_FILE = resolve(import.meta.path);

export class MockModuleGuardError extends Error {}

export interface AliasRule {
  prefix: string;
  wildcard: boolean;
  targets: string[];
}

export interface GuardConfig {
  repoRoot: string;
  aliases: AliasRule[];
}

export type MockTarget = { kind: "external" } | { kind: "project"; file: string };

const SCANNABLE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const RESOLVE_EXTENSIONS = [...SCANNABLE_EXTENSIONS, ".js", ".mjs", ".cjs", ".json"];
const ALIAS_CONFIGS = ["desktop/tsconfig.web.json", "desktop/tsconfig.node.json"];

function aliasRulesFrom(configPath: string): AliasRule[] {
  const parsed = (Bun as unknown as { JSONC: { parse: (text: string) => unknown } }).JSONC.parse(
    readFileSync(configPath, "utf8")
  ) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
  const options = parsed.compilerOptions ?? {};
  const base = resolve(dirname(configPath), options.baseUrl ?? ".");
  return Object.entries(options.paths ?? {}).map(([pattern, targets]) => {
    const wildcard = pattern.endsWith("*");
    return {
      prefix: wildcard ? pattern.slice(0, -1) : pattern,
      wildcard,
      targets: targets.map((target) => resolve(base, target))
    };
  });
}

let cachedConfig: GuardConfig | undefined;

/**
 * Alias table read from the desktop tsconfigs' `paths`, so a new alias is
 * discovered instead of listed. Fails closed: an unreadable config throws.
 */
export function loadGuardConfig(repoRoot: string = GUARD_REPO_ROOT): GuardConfig {
  if (repoRoot === GUARD_REPO_ROOT && cachedConfig) return cachedConfig;
  const config: GuardConfig = {
    repoRoot,
    aliases: ALIAS_CONFIGS.flatMap((rel) => aliasRulesFrom(join(repoRoot, rel)))
  };
  if (repoRoot === GUARD_REPO_ROOT) cachedConfig = config;
  return config;
}

function resolveFile(base: string): string | null {
  const candidates = [base, ...RESOLVE_EXTENSIONS.map((ext) => base + ext), ...RESOLVE_EXTENSIONS.map((ext) => join(base, "index" + ext))];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function fileUrlPath(specifier: string): string {
  try {
    return fileURLToPath(specifier);
  } catch (error) {
    throw new MockModuleGuardError(`mock.module("${specifier}") is not a file: URL naming an absolute path on this platform (${(error as Error).message}).`);
  }
}

function isInside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function classify(file: string, config: GuardConfig): MockTarget {
  const root = realpathSync.native(config.repoRoot);
  const real = realpathSync.native(file);
  const segments = relative(root, real).split(sep);
  const outsideRepo = !isInside(root, real);
  if (outsideRepo || segments.includes("node_modules") || segments[0] === "tests" || segments[0] === ".worktrees") {
    return { kind: "external" };
  }
  return { kind: "project", file };
}

/**
 * Which module a mock.module()/jest.mock() specifier stands for. A project
 * source file is `project`; a bare package or anything outside the repo is
 * `external`. A specifier that LOOKS project-local (a tsconfig alias, a
 * relative or absolute path) but resolves to nothing throws: a mock aimed at a
 * misspelt path is dead, and skipping it would hide the partial factory next to
 * it.
 */
export function resolveMockTarget(specifier: string, callerFile: string | null, config: GuardConfig): MockTarget {
  for (const rule of config.aliases) {
    const matches = rule.wildcard ? specifier.startsWith(rule.prefix) : specifier === rule.prefix;
    if (!matches) continue;
    const rest = rule.wildcard ? specifier.slice(rule.prefix.length) : "";
    for (const target of rule.targets) {
      const file = resolveFile(rule.wildcard ? target.replace("*", rest) : target);
      if (file) return classify(file, config);
    }
    throw new MockModuleGuardError(`mock.module("${specifier}") matches the tsconfig alias "${rule.prefix}${rule.wildcard ? "*" : ""}" but resolves to no file.`);
  }
  const path = specifier.startsWith("file:") ? fileUrlPath(specifier) : specifier;
  if (path.startsWith(".") || isAbsolute(path)) {
    if (!isAbsolute(path) && callerFile === null) {
      throw new MockModuleGuardError(`mock.module("${specifier}") is a relative path and the calling file could not be determined from the stack.`);
    }
    const base = isAbsolute(path) ? path : resolve(dirname(callerFile as string), path);
    const file = resolveFile(base);
    if (!file) throw new MockModuleGuardError(`mock.module("${specifier}") resolves to no file (looked at ${base}).`);
    return classify(file, config);
  }
  return { kind: "external" };
}

/**
 * Runtime value exports of a TS/TSX source, parsed rather than imported so the
 * answer does not depend on which mocks are already registered. `export *`
 * cannot be resolved by the scan and throws.
 */
export function runtimeExportsOf(source: string, file: string): string[] {
  const extension = file.slice(file.lastIndexOf("."));
  if (!SCANNABLE_EXTENSIONS.includes(extension)) {
    throw new MockModuleGuardError(`${file}: cannot read runtime exports of a "${extension}" file, so a mock of it cannot be checked.`);
  }
  if (/\bexport\s*\*/.test(source)) {
    throw new MockModuleGuardError(`${file}: contains "export *", whose names the export scan cannot resolve; list the names explicitly or extend the guard.`);
  }
  const loader = extension === ".tsx" ? "tsx" : "ts";
  const exported = new Bun.Transpiler({ loader }).scan(source).exports;
  return [...new Set(exported)].sort();
}

export function missingExports(factoryKeys: Iterable<string>, realExports: string[]): string[] {
  const present = new Set(factoryKeys);
  return realExports.filter((name) => !present.has(name));
}

function factoryKeysOf(value: unknown, site: string, specifier: string): string[] {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    throw new MockModuleGuardError(`mock.module("${specifier}") at ${site}: the factory returned ${value === null ? "null" : typeof value}, not a module object.`);
  }
  if (typeof (value as { then?: unknown }).then === "function") {
    throw new MockModuleGuardError(`mock.module("${specifier}") at ${site}: the factory returned a thenable; its exports cannot be checked synchronously.`);
  }
  return Object.keys(value as object);
}

export interface Registration {
  specifier: string;
  callerFile: string | null;
  site: string;
}

/**
 * Throws when the factory result omits a runtime export of the module the
 * specifier stands for. bun freezes a specifier's export list at its first
 * materialization for the whole process, so a partial factory breaks whichever
 * later file imports a value it left out.
 */
export function assertFactoryComplete(registration: Registration, factoryResult: unknown, config: GuardConfig = loadGuardConfig()): void {
  const { specifier, callerFile, site } = registration;
  const target = resolveMockTarget(specifier, callerFile, config);
  if (target.kind === "external") return;
  const keys = factoryKeysOf(factoryResult, site, specifier);
  const real = runtimeExportsOf(readFileSync(target.file, "utf8"), target.file);
  const missing = missingExports(keys, real);
  if (missing.length === 0) return;
  const shown = relative(config.repoRoot, target.file).split(sep).join("/");
  throw new MockModuleGuardError(
    `mock.module("${specifier}") at ${site} omits ${missing.length} of ${real.length} runtime export(s) of ${shown}: ${missing.join(", ")}. ` +
      `bun freezes a specifier's export list for the whole process at its first materialization, so a later file importing any of these dies with "Export named ... not found"; ` +
      `after this refusal, later importers of this specifier in this process see an empty module. ` +
      `Spread the real module: { ...realModule, yourOverride }.`
  );
}

const FRAME_PATTERN = /(?:\(|\s|^)((?:[A-Za-z]:)?[^\s():][^():]*?):(\d+):(\d+)\)?\s*$/;

/** First stack frame outside this file, as an absolute path plus line. */
export function callSiteFromStack(stack: string, ignoredFile: string = GUARD_FILE): { file: string; line: number } | null {
  for (const raw of stack.split("\n").slice(1)) {
    const match = FRAME_PATTERN.exec(raw.trim().replace(/^at\s+/, "").replace(/^file:\/\/\/?/, ""));
    if (!match) continue;
    const candidate = match[1] as string;
    if (!isAbsolute(candidate)) continue;
    const file = resolve(candidate);
    if (file === ignoredFile) continue;
    return { file, line: Number(match[2]) };
  }
  return null;
}

type MockFn = ((specifier: string, factory: () => unknown) => unknown) & { __mockModuleGuard?: true };

export function guardedMock(original: (specifier: string, factory: () => unknown) => unknown): MockFn {
  const guarded: MockFn = (specifier, factory) => {
    if (typeof specifier !== "string" || typeof factory !== "function") {
      throw new MockModuleGuardError(`mock.module(${typeof specifier}, ${typeof factory}): expected (string, function); the guard cannot check anything else.`);
    }
    const frame = callSiteFromStack(new Error().stack ?? "");
    const config = loadGuardConfig();
    const registration: Registration = {
      specifier,
      callerFile: frame?.file ?? null,
      site: frame ? `${relative(config.repoRoot, frame.file).split(sep).join("/")}:${frame.line}` : "<unknown call site>"
    };
    let target: MockTarget;
    try {
      target = resolveMockTarget(specifier, registration.callerFile, config);
    } catch (error) {
      if (error instanceof MockModuleGuardError) throw new MockModuleGuardError(`${error.message} Registered at ${registration.site}.`);
      throw error;
    }
    if (target.kind === "external") return original(specifier, factory);
    return original(specifier, () => {
      const value = factory();
      assertFactoryComplete(registration, value, config);
      return value;
    });
  };
  guarded.__mockModuleGuard = true;
  return guarded;
}

const ROUTES: Array<{ owner: Record<string, unknown>; key: string }> = [
  { owner: mock as unknown as Record<string, unknown>, key: "module" },
  { owner: jest as unknown as Record<string, unknown>, key: "mock" },
  { owner: vi as unknown as Record<string, unknown>, key: "mock" }
];

/**
 * Wraps every route bun offers for registering a module mock. Idempotent.
 * The completeness check runs inside the call bun makes to the factory, so a
 * factory keeps reading its late-bound variables exactly as it does unguarded.
 */
export function installMockModuleGuard(): void {
  for (const { owner, key } of ROUTES) {
    const current = owner[key] as MockFn | undefined;
    if (typeof current !== "function" || current.__mockModuleGuard) continue;
    owner[key] = guardedMock(current.bind(owner));
  }
}

export function isMockModuleGuardInstalled(): boolean {
  return ROUTES.every(({ owner, key }) => (owner[key] as MockFn).__mockModuleGuard === true);
}

installMockModuleGuard();
