import { afterAll, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertFactoryComplete,
  callSiteFromStack,
  GUARD_REPO_ROOT,
  guardedMock,
  isMockModuleGuardInstalled,
  loadGuardConfig,
  missingExports,
  MockModuleGuardError,
  resolveMockTarget,
  runtimeExportsOf
} from "./_mock-module-guard";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function write(root: string, rel: string, text: string): string {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

/** A miniature repo: the alias table, a source file, and one file per classification. */
function miniRepo(): { root: string; caller: string; shared: string } {
  const root = scratchDir("mmguard-repo-");
  write(root, "desktop/tsconfig.web.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@shared/*": ["src/shared/*"], "@exact": ["../shared/exact.ts"] } } }));
  write(root, "desktop/tsconfig.node.json", '{\n  // JSONC comment the loader must tolerate\n  "compilerOptions": { "baseUrl": ".", "paths": { "@shared/*": ["src/shared/*"] } }\n}\n');
  const shared = write(root, "desktop/src/shared/a.ts", "export const one = 1;\nexport function two() {}\nexport type Ty = 1;\nexport const three = 3;\n");
  write(root, "desktop/src/shared/star.ts", 'export * from "./a";\n');
  write(root, "desktop/src/shared/plain.js", "export const js = 1;\n");
  write(root, "shared/exact.ts", "export const exact = 1;\n");
  write(root, "node_modules/pkg/index.ts", "export const pkg = 1;\n");
  write(root, "tests/helper.ts", "export const helper = 1;\n");
  write(root, ".worktrees/w/src/y.ts", "export const y = 1;\n");
  const caller = write(root, "tests/x.test.ts", "// caller\n");
  return { root, caller, shared };
}

test("runtimeExportsOf lists value exports of every declaration form and none of the type-only ones", () => {
  const source = [
    "export const a = 1, b = 2;",
    "export function f() {}",
    "export class C {}",
    "export enum E { A }",
    "export type T = 1;",
    "export interface I {}",
    "export declare const d: number;",
    "const x = 1; export { x as y };",
    "export default 1;"
  ].join("\n");
  expect(runtimeExportsOf(source, "m.ts")).toEqual(["C", "E", "a", "b", "default", "f", "y"]);
});

test("runtimeExportsOf parses JSX only for a .tsx file", () => {
  expect(runtimeExportsOf("export const A = () => <div />;", "m.tsx")).toEqual(["A"]);
});

test("runtimeExportsOf refuses export-star, which the scan cannot resolve, and any file kind it cannot read", () => {
  expect(() => runtimeExportsOf('export * from "./a";', "m.ts")).toThrow(/export \*/);
  expect(() => runtimeExportsOf('export * as ns from "./a";', "m.ts")).toThrow(/export \*/);
  expect(() => runtimeExportsOf("module.exports = {};", "m.cjs")).toThrow(/cannot read runtime exports/);
});

test("missingExports reports exactly the names a factory leaves out and ignores extra keys", () => {
  expect(missingExports(["a"], ["a", "b", "c"])).toEqual(["b", "c"]);
  expect(missingExports(["a", "b", "c", "extra"], ["a", "b", "c"])).toEqual([]);
});

test("resolveMockTarget classifies each specifier form against the alias table", () => {
  const { root, caller, shared } = miniRepo();
  const config = loadGuardConfig(root);
  const project = (file: string) => ({ kind: "project" as const, file });
  const outside = write(scratchDir("mmguard-out-"), "elsewhere.ts", "export const elsewhere = 1;\n");
  expect(resolveMockTarget("@shared/a", caller, config)).toEqual(project(shared));
  expect(resolveMockTarget("@exact", caller, config)).toEqual(project(join(root, "shared", "exact.ts")));
  expect(resolveMockTarget("../desktop/src/shared/a.ts", caller, config)).toEqual(project(shared));
  expect(resolveMockTarget("../desktop/src/shared/a", caller, config)).toEqual(project(shared));
  expect(resolveMockTarget(shared, caller, config)).toEqual(project(shared));
  expect(resolveMockTarget(shared, null, config)).toEqual(project(shared));
  expect(resolveMockTarget("node-pty", caller, config)).toEqual({ kind: "external" });
  expect(resolveMockTarget("../node_modules/pkg/index.ts", caller, config)).toEqual({ kind: "external" });
  expect(resolveMockTarget("./helper", caller, config)).toEqual({ kind: "external" });
  expect(resolveMockTarget("../.worktrees/w/src/y.ts", caller, config)).toEqual({ kind: "external" });
  expect(resolveMockTarget(outside, caller, config)).toEqual({ kind: "external" });
});

test("resolveMockTarget throws instead of skipping a specifier that looks project-local but resolves to nothing", () => {
  const { root, caller } = miniRepo();
  const config = loadGuardConfig(root);
  expect(() => resolveMockTarget("@shared/missing", caller, config)).toThrow(/matches the tsconfig alias "@shared\/\*" but resolves to no file/);
  expect(() => resolveMockTarget("../desktop/src/shared/missing.ts", caller, config)).toThrow(/resolves to no file/);
  expect(() => resolveMockTarget("../desktop/src/shared/a.ts", null, config)).toThrow(/calling file could not be determined/);
});

test("resolveMockTarget follows a file: URL to the project file it names", () => {
  const { root, caller, shared } = miniRepo();
  const config = loadGuardConfig(root);
  expect(resolveMockTarget(pathToFileURL(shared).href, caller, config)).toEqual({ kind: "project", file: shared });
  expect(resolveMockTarget(pathToFileURL(join(root, "node_modules", "pkg", "index.ts")).href, caller, config)).toEqual({ kind: "external" });
  expect(() => resolveMockTarget(pathToFileURL(join(root, "desktop", "src", "shared", "missing.ts")).href, caller, config)).toThrow(/resolves to no file/);
});

test("a file: specifier that is not an absolute file URL is refused with the specifier named, not a raw TypeError", () => {
  const { root, caller } = miniRepo();
  const config = loadGuardConfig(root);
  let thrown: unknown;
  try {
    resolveMockTarget("file:./relative.ts", caller, config);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(MockModuleGuardError);
  expect((thrown as Error).message).toContain('mock.module("file:./relative.ts")');
  const { wrapper, registered } = recordingMock();
  expect(() => wrapper("file:./relative.ts", () => ({}))).toThrow(/file:\.\/relative\.ts.*tests\/mock-module-guard\.test\.ts:\d+/);
  expect(registered.length).toBe(0);
});

test("resolveMockTarget sees a project file through a symlinked repo root", () => {
  const { root, caller, shared } = miniRepo();
  const link = join(scratchDir("mmguard-link-"), "linked-root");
  symlinkSync(root, link, process.platform === "win32" ? "junction" : "dir");
  const config = loadGuardConfig(link);
  expect(resolveMockTarget(shared, caller, config).kind).toBe("project");
});

test("assertFactoryComplete names the site, the specifier, the module and every omitted export", () => {
  const { root, caller } = miniRepo();
  const config = loadGuardConfig(root);
  const registration = { specifier: "@shared/a", callerFile: caller, site: "tests/x.test.ts:12" };
  let thrown: unknown;
  try {
    assertFactoryComplete(registration, { one: 1 }, config);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(MockModuleGuardError);
  const message = (thrown as Error).message;
  expect(message, "the message must locate the mock").toContain('mock.module("@shared/a") at tests/x.test.ts:12');
  expect(message, "the message must name the module read for the comparison").toContain("desktop/src/shared/a.ts");
  expect(message, "the omitted exports are listed, the type-only one is not").toContain("omits 2 of 3 runtime export(s)");
  expect(message).toContain("three, two");
  expect(message, "the message must say what happens to later importers after a refusal").toContain("later importers of this specifier in this process see an empty module");
  expect(message).not.toContain("Ty");
});

test("assertFactoryComplete accepts a complete factory, a superset, a namespace object and any external module", () => {
  const { root, caller } = miniRepo();
  const config = loadGuardConfig(root);
  const registration = (specifier: string) => ({ specifier, callerFile: caller, site: "tests/x.test.ts:1" });
  expect(() => assertFactoryComplete(registration("@shared/a"), { one: 1, two: 2, three: 3 }, config)).not.toThrow();
  expect(() => assertFactoryComplete(registration("@shared/a"), { one: 1, two: 2, three: 3, more: 4 }, config)).not.toThrow();
  expect(() => assertFactoryComplete(registration("@shared/a"), { __proto__: null, one: 1, two: 2, three: 3 }, config)).not.toThrow();
  expect(() => assertFactoryComplete(registration("node-pty"), { spawn: 1 }, config)).not.toThrow();
  expect(() => assertFactoryComplete(registration("node-pty"), null, config)).not.toThrow();
});

test("assertFactoryComplete refuses a factory result it cannot enumerate synchronously", () => {
  const { root, caller } = miniRepo();
  const config = loadGuardConfig(root);
  const registration = { specifier: "@shared/a", callerFile: caller, site: "tests/x.test.ts:1" };
  expect(() => assertFactoryComplete(registration, null, config)).toThrow(/returned null/);
  expect(() => assertFactoryComplete(registration, "text", config)).toThrow(/returned string/);
  expect(() => assertFactoryComplete(registration, Promise.resolve({ one: 1, two: 2, three: 3 }), config)).toThrow(/thenable/);
});

test("assertFactoryComplete refuses a mocked project module whose exports it cannot read", () => {
  const { root, caller } = miniRepo();
  const config = loadGuardConfig(root);
  const registration = (specifier: string) => ({ specifier, callerFile: caller, site: "tests/x.test.ts:1" });
  expect(() => assertFactoryComplete(registration("@shared/star"), { one: 1 }, config)).toThrow(/export \*/);
  expect(() => assertFactoryComplete(registration("@shared/plain.js"), { js: 1 }, config)).toThrow(/cannot read runtime exports/);
});

test("callSiteFromStack skips the guard's own frames and reads a parenthesised or bare frame", () => {
  const guard = join(GUARD_REPO_ROOT, "tests", "_mock-module-guard.ts");
  const caller = join(GUARD_REPO_ROOT, "tests", "some.test.ts");
  const parenthesised = `Error\n    at guarded (${guard}:201:23)\n    at <anonymous> (${caller}:117:6)\n    at loader (${caller}:1:1)`;
  const bare = `Error\n    at guarded (${guard}:201:23)\n    at ${caller}:42:9`;
  expect(callSiteFromStack(parenthesised, guard)).toEqual({ file: resolve(caller), line: 117 });
  expect(callSiteFromStack(bare, guard)).toEqual({ file: resolve(caller), line: 42 });
  expect(callSiteFromStack("Error\n    at guarded (native:1:1)", guard)).toBeNull();
});

const ROLE_MODULE = join(GUARD_REPO_ROOT, "desktop", "src", "shared", "role.ts");

function recordingMock(): { wrapper: ReturnType<typeof guardedMock>; registered: Array<{ specifier: string; factory: () => unknown }> } {
  const registered: Array<{ specifier: string; factory: () => unknown }> = [];
  const wrapper = guardedMock((specifier, factory) => {
    registered.push({ specifier, factory });
  });
  return { wrapper, registered };
}

test("guardedMock leaves a factory for an external module exactly as written and never calls it", () => {
  const { wrapper, registered } = recordingMock();
  let calls = 0;
  const factory = () => {
    calls++;
    return { spawn: 1 };
  };
  wrapper("node-pty", factory);
  expect(registered[0]?.factory, "bun must receive the caller's own function").toBe(factory);
  expect(calls, "the guard must not evaluate an external module's factory").toBe(0);
});

test("guardedMock calls a project module's factory only when bun does, and returns its value untouched", async () => {
  const { wrapper, registered } = recordingMock();
  const role = { ...((await import(ROLE_MODULE)) as Record<string, unknown>) };
  let calls = 0;
  wrapper("@shared/role", () => {
    calls++;
    return role;
  });
  expect(calls, "registration must not evaluate the factory").toBe(0);
  const wrapped = registered[0]?.factory as () => unknown;
  expect(wrapped()).toBe(role);
  expect(wrapped()).toBe(role);
  expect(calls, "each call bun makes reaches the caller's factory once").toBe(2);
});

test("guardedMock keeps a factory's late-bound values late bound", async () => {
  const { wrapper, registered } = recordingMock();
  const role = { ...((await import(ROLE_MODULE)) as Record<string, unknown>) };
  const [firstName] = Object.keys(role) as [string];
  let impl: unknown;
  wrapper("@shared/role", () => ({ ...role, [firstName]: impl }));
  const spy = () => "spy";
  impl = spy;
  expect((registered[0]?.factory() as Record<string, unknown>)[firstName], "the value read when bun calls the factory, not when the mock was registered").toBe(spy);
});

test("guardedMock refuses a partial project factory when bun calls it, naming the registration site", () => {
  const { wrapper, registered } = recordingMock();
  wrapper("@shared/role", () => ({ sanitizeRole: () => "x" }));
  expect(registered.length, "registration itself succeeds; the refusal happens where bun materializes the module").toBe(1);
  expect(() => (registered[0]?.factory as () => unknown)()).toThrow(/tests\/mock-module-guard\.test\.ts:\d+ omits \d+ of \d+ runtime export/);
});

test("guardedMock refuses a project specifier that resolves to nothing at registration", () => {
  const { wrapper, registered } = recordingMock();
  expect(() => wrapper("@shared/no-such-module-anywhere", () => ({}))).toThrow(/resolves to no file/);
  expect(registered.length).toBe(0);
});

test("every route bun offers for registering a module mock is guarded", () => {
  expect(isMockModuleGuardInstalled()).toBe(true);
});

test("guardedMock refuses arguments it cannot check", () => {
  const wrapper = guardedMock(() => undefined);
  expect(() => (wrapper as unknown as (a: unknown, b: unknown) => unknown)("@shared/role", { not: "a function" })).toThrow(/expected \(string, function\)/);
  expect(() => (wrapper as unknown as (a: unknown, b: unknown) => unknown)(42, () => ({}))).toThrow(/expected \(string, function\)/);
});

const SHARED_DIR = join(GUARD_REPO_ROOT, "desktop", "src", "shared");
const MOCK_LITERAL = /\b(?:mock\.module|jest\.mock|vi\.mock)\(\s*(?:"([^"\n]*)"|'([^'\n]*)'|`([^`\n$]*)`)/g;
const OWN_FILES = new Set(["mock-module-guard.test.ts", "_mock-module-guard.ts"]);
const BUILT_SPECIFIER_TARGETS = [join(GUARD_REPO_ROOT, "desktop", "src", "main", "store.ts")];
const MAY_BE_UNIMPORTABLE_IN_RUNNER = ["desktop/src/main/store.ts"];

/** Project modules named by a literal specifier in a mock call under tests/, plus every desktop/src/shared module. */
function calibrationTargets(): { fromLiterals: string[]; all: string[] } {
  const config = loadGuardConfig();
  const found = new Set<string>();
  for (const entry of readdirSync(join(GUARD_REPO_ROOT, "tests"), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.[cm]?tsx?$/.test(entry.name) || OWN_FILES.has(entry.name)) continue;
    const file = join(entry.parentPath, entry.name);
    for (const match of readFileSync(file, "utf8").matchAll(MOCK_LITERAL)) {
      const specifier = (match[1] ?? match[2] ?? match[3]) as string;
      let target;
      try {
        target = resolveMockTarget(specifier, file, config);
      } catch {
        continue;
      }
      if (target.kind === "project") found.add(target.file);
    }
  }
  const fromLiterals = [...found].sort();
  for (const name of readdirSync(SHARED_DIR).filter((entry) => /\.tsx?$/.test(entry))) found.add(join(SHARED_DIR, name));
  for (const name of BUILT_SPECIFIER_TARGETS) found.add(name);
  return { fromLiterals, all: [...found].sort() };
}

test("the export scan agrees with the runtime export list of every project module the tests mock", async () => {
  const { fromLiterals, all: targets } = calibrationTargets();
  expect(fromLiterals.length, "the literal-specifier derivation must keep finding the modules the tests mock").toBeGreaterThanOrEqual(18);
  expect(targets.length, "the calibration list must not have collapsed").toBeGreaterThanOrEqual(33);
  for (const name of readdirSync(SHARED_DIR).filter((entry) => /\.tsx?$/.test(entry))) {
    const namespace = await import(join(SHARED_DIR, name));
    mock.module(`@shared/${name.replace(/\.tsx?$/, "")}`, () => namespace);
  }
  const roadmapAppend = await import(join(GUARD_REPO_ROOT, "shared", "roadmap-append.ts"));
  mock.module("@roadmap-append", () => roadmapAppend);
  const notImportable: string[] = [];
  const reasons: string[] = [];
  for (const file of targets) {
    const shown = relative(GUARD_REPO_ROOT, file).split(sep).join("/");
    let imported: string[];
    try {
      imported = Object.keys((await import(file)) as object).sort();
    } catch (error) {
      notImportable.push(shown);
      reasons.push(`${shown}: ${String(error).split("\n")[0]}`);
      continue;
    }
    expect(runtimeExportsOf(readFileSync(file, "utf8"), file), `${shown}: the scan must list exactly what the module exports at runtime`).toEqual(imported);
  }
  const unexpected = notImportable.filter((shown) => !MAY_BE_UNIMPORTABLE_IN_RUNNER.includes(shown));
  expect(unexpected, `targets whose scan could not be checked against a real import:\n${reasons.join("\n")}`).toEqual([]);
});

const FIXTURE_MODULES = ["pick-security", "role", "announce", "palette", "reorder", "session-status", "workflow", "graph", "models", "types"] as const;
const FIXTURE_TESTS = 13;

async function fixtureSource(fixtureDir: string): Promise<string> {
  const file = (name: string) => join(SHARED_DIR, `${name}.ts`);
  const names: Record<string, string[]> = {};
  for (const name of FIXTURE_MODULES) names[name] = Object.keys((await import(file(name))) as object).sort();
  let relativeSpecifier = relative(fixtureDir, file("announce")).split(sep).join("/");
  if (!relativeSpecifier.startsWith(".") && !isAbsolute(relativeSpecifier)) relativeSpecifier = "./" + relativeSpecifier;
  const refused = (title: string, register: string, specifier: string, module: string) =>
    [
      `test(${JSON.stringify(title)}, async () => {`,
      `  ${register.replace("$FACTORY", `partial(${JSON.stringify(module)})`).replace("$SPECIFIER", specifier)};`,
      `  await expect(import(${specifier})).rejects.toThrow(omits(${JSON.stringify(module)}));`,
      "});"
    ].join("\n");
  return [
    'import { expect, jest, mock, test, vi } from "bun:test";',
    `const NAMES = ${JSON.stringify(names)} as Record<string, string[]>;`,
    `const RELATIVE = ${JSON.stringify(relativeSpecifier)};`,
    `const ABSOLUTE = ${JSON.stringify(file("role"))};`,
    `const FILE_URL = ${JSON.stringify(pathToFileURL(file("workflow")).href)};`,
    "const partial = (module: string) => () => ({ [NAMES[module]![0]!]: 1 });",
    "const whole = (module: string) => () => Object.fromEntries(NAMES[module]!.map((name) => [name, 1]));",
    "const omits = (module: string) => new RegExp(NAMES[module]!.at(-1)!);",
    refused("a partial factory behind a tsconfig alias is refused when the module loads", "mock.module($SPECIFIER, $FACTORY)", JSON.stringify("@shared/pick-security"), "pick-security"),
    refused("a partial factory behind an absolute path is refused when the module loads", "mock.module($SPECIFIER, $FACTORY)", "ABSOLUTE", "role"),
    refused("a partial factory behind a relative path is refused when the module loads", "mock.module($SPECIFIER, $FACTORY)", "RELATIVE", "announce"),
    refused("a partial factory behind a file: URL is refused when the module loads", "mock.module($SPECIFIER, $FACTORY)", "FILE_URL", "workflow"),
    refused("a partial factory registered through jest.mock is refused when the module loads", "jest.mock($SPECIFIER, $FACTORY)", JSON.stringify("@shared/reorder"), "reorder"),
    refused("a partial factory registered through vi.mock is refused when the module loads", "vi.mock($SPECIFIER, $FACTORY)", JSON.stringify("@shared/session-status"), "session-status"),
    'test("a partial factory behind a template-literal specifier is refused when the module loads", async () => {',
    '  for (const name of ["palette"]) {',
    "    mock.module(`@shared/${name}`, partial(name));",
    '    await expect(import(`@shared/${name}`)).rejects.toThrow(omits("palette"));',
    "  }",
    "});",
    'test("the refusal names the calling file and line", async () => {',
    '  mock.module("@shared/graph", partial("graph"));',
    '  await expect(import("@shared/graph")).rejects.toThrow(/guard-fixture\\.test\\.ts:\\d+ omits/);',
    "});",
    'test("a project factory naming every export is accepted and keeps its late-bound value", async () => {',
    "  let impl: unknown;",
    '  mock.module("@shared/models", () => ({ ...whole("models")(), [NAMES.models![0]!]: impl }));',
    "  impl = () => \"late\";",
    '  const loaded = (await import("@shared/models")) as Record<string, unknown>;',
    "  expect(loaded[NAMES.models![0]!]).toBe(impl);",
    "});",
    'test("an external module keeps its late-bound value", async () => {',
    "  let impl: unknown;",
    '  mock.module("zz-external-probe", () => ({ fn: impl }));',
    "  impl = () => \"late\";",
    '  const loaded = (await import("zz-external-probe")) as { fn: unknown };',
    "  expect(loaded.fn).toBe(impl);",
    "});",
    'test("an alias that resolves to no file is refused at registration", () => {',
    '  expect(() => mock.module("@shared/no-such-module-anywhere", () => ({}))).toThrow(/resolves to no file/);',
    "});",
    'test("every registration route carries the guard marker", () => {',
    "  const marked = (fn: unknown) => (fn as { __mockModuleGuard?: boolean }).__mockModuleGuard === true;",
    "  expect([marked(mock.module), marked(jest.mock), marked(vi.mock)]).toEqual([true, true, true]);",
    "});",
    'test("a factory returning the whole real namespace shape is accepted", async () => {',
    '  mock.module("@shared/types", whole("types"));',
    '  expect(Object.keys((await import("@shared/types")) as object).sort()).toEqual(NAMES.types);',
    "});",
    ""
  ].join("\n");
}

async function runFixture(configArgs: string[]): Promise<{ output: string; exitCode: number }> {
  const dir = scratchDir("mmguard-fixture-");
  const file = write(dir, "guard-fixture.test.ts", await fixtureSource(dir));
  const run = Bun.spawnSync(["bun", "test", ...configArgs, file], { cwd: GUARD_REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  return { output: `${run.stdout.toString()}${run.stderr.toString()}`, exitCode: run.exitCode ?? 1 };
}

test("bunfig.toml arms the guard in a fresh `bun test` process started from the repo root", async () => {
  const { output, exitCode } = await runFixture([]);
  expect(output, `the fixture must actually have run:\n${output}`).toContain(`Ran ${FIXTURE_TESTS} tests across 1 file`);
  expect(exitCode, output).toBe(0);
  expect(output).toContain(` ${FIXTURE_TESTS} pass`);
}, 60_000);

test("the same fixture fails when the repo bunfig.toml is bypassed, so its assertions bite", async () => {
  const emptyConfig = write(scratchDir("mmguard-empty-"), "empty.toml", "\n");
  const { output, exitCode } = await runFixture([`--config=${emptyConfig}`]);
  expect(output, `the fixture must actually have run:\n${output}`).toContain(`Ran ${FIXTURE_TESTS} tests across 1 file`);
  expect(exitCode, "without the preload every refusal assertion has to fail").not.toBe(0);
  const failed = Number(/ (\d+) fail/.exec(output)?.[1]);
  expect(failed, `each of the five refusal forms must fail without the preload:\n${output}`).toBeGreaterThanOrEqual(5);
}, 60_000);

test("the repo bunfig.toml preloads the guard module", () => {
  const bunfig = readFileSync(join(GUARD_REPO_ROOT, "bunfig.toml"), "utf8");
  expect(bunfig, "bunfig.toml must list the guard module under [test] preload").toMatch(/\[test\][^[]*preload\s*=\s*\[[^\]]*_mock-module-guard\.ts/);
});
