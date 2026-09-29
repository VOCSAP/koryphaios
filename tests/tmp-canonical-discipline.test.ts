import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ROOTS = [join(REPO_ROOT, "tests"), join(REPO_ROOT, "desktop", "tests-support")];
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

const RULE_SYNC = ["real", "pathSync"].join("");
const RULE_ASYNC = ["real", "path"].join("");
const WORD = new RegExp(`\\b(?:${RULE_SYNC}|${RULE_ASYNC})\\b(?!\\s*\\.\\s*native)`, "g");
const NAMED_IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
const PROMISES_MODULE = /^(?:node:)?fs\/promises$/;
const PROMISES_NAMESPACE_IMPORT = /import\s+(?:\*\s+as\s+)?([\w$]+)\s+from\s*["'](?:node:)?fs\/promises["']/g;

interface Violation {
  line: number;
  text: string;
}

function mask(source: string, at: number, length: number): string {
  return source.slice(0, at) + " ".repeat(length) + source.slice(at + length);
}

function maskAll(source: string, pattern: RegExp, pick: (m: RegExpMatchArray) => [number, number]): string {
  let masked = source;
  for (const m of source.matchAll(pattern)) {
    const [at, length] = pick(m);
    masked = mask(masked, at, length);
  }
  return masked;
}

/**
 * The bare word is the unit, wherever it appears: an alias by assignment, a
 * call, a bind, a map argument or a comment all keep the short name that only
 * the native form expands. Exempt: the native form, an unrenamed named import
 * (an import is not a use), and the promise flavour, which resolves to the
 * long name already.
 */
function findJsRealpath(source: string): Violation[] {
  let masked = source;
  let promisesNamed = false;
  const word = new RegExp(`(?<![\\w$])(?:${RULE_SYNC}|${RULE_ASYNC})(?![\\w$])(?!\\s+as\\b)`, "g");
  for (const imp of source.matchAll(NAMED_IMPORT)) {
    const innerStart = (imp.index ?? 0) + imp[0].indexOf("{") + 1;
    const inner = imp[1] as string;
    for (const spec of inner.matchAll(word)) {
      masked = mask(masked, innerStart + (spec.index ?? 0), spec[0].length);
      if (PROMISES_MODULE.test(imp[2] as string) && spec[0] === RULE_ASYNC) promisesNamed = true;
    }
  }
  if (promisesNamed) {
    masked = maskAll(masked, new RegExp(`(?<![.\\w$])${RULE_ASYNC}(?![\\w$])`, "g"), (m) => [m.index ?? 0, m[0].length]);
  }
  const namespaces = ["promises", ...[...source.matchAll(PROMISES_NAMESPACE_IMPORT)].map((m) => m[1] as string)];
  for (const name of namespaces) {
    const member = new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}\\s*\\.\\s*(${RULE_ASYNC})(?![\\w$])`, "g");
    masked = maskAll(masked, member, (m) => [(m.index ?? 0) + m[0].length - RULE_ASYNC.length, RULE_ASYNC.length]);
  }
  const lines = source.split("\n");
  const found: Violation[] = [];
  for (const m of masked.matchAll(WORD)) {
    const line = source.slice(0, m.index).split("\n").length;
    found.push({ line, text: (lines[line - 1] ?? "").trim().slice(0, 120) });
  }
  return found;
}

function sourceFilesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE_FILE.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => !relative(root, file).split(sep).includes("node_modules"));
}

const F_SYNC = ["rea", "lpathSync"].join("");
const F_ASYNC = ["rea", "lpath"].join("");

test("the scan flags every way of reaching the JS canonicaliser, on the line it sits on", () => {
  const flagged = [
    `const d = ${F_SYNC}(mkdtempSync(join(tmpdir(), "x-")));`,
    `const d = fs.${F_SYNC}(dir);`,
    `fs.${F_ASYNC}(dir, (err, resolved) => done(resolved));`,
    `const d = await ${F_ASYNC}(dir);`,
    `import { ${F_SYNC} as rp } from "node:fs";`,
    `import { ${F_ASYNC} as rp } from "node:fs";`,
    `const fn = fs["${F_SYNC}"];`,
    `const { ${F_SYNC}: rp } = require("node:fs");`,
    `const { ${F_SYNC} } = require("node:fs");`,
    `const rp = fs.${F_SYNC};`,
    `const { ${F_SYNC}: rp } = fs;`,
    `const d = fs.${F_SYNC}.call(fs, dir);`,
    `const d = fs.${F_SYNC}.apply(fs, [dir]);`,
    `const all = dirs.map(fs.${F_SYNC});`,
    `const rp = promisify(fs.${F_ASYNC});`,
    `const d = fs.${F_SYNC}?.(dir);`,
    `const rp = fs.${F_SYNC}.bind(fs);`,
    `// the plain ${F_SYNC}( keeps 8.3 names`
  ];
  for (const source of flagged) {
    const found = findJsRealpath(`first line\n${source}\nlast line`);
    expect(found.length, `not flagged: ${source}`).toBeGreaterThan(0);
    expect(found[0]?.line, `wrong line for: ${source}`).toBe(2);
  }
});

test("the scan leaves alone the native form, an unrenamed import, the promise flavour and unrelated names", () => {
  const clean = [
    `const d = ${F_SYNC}.native(mkdtempSync(join(tmpdir(), "x-")));`,
    `const d = fs.${F_SYNC}.native(dir);`,
    `const d = fs.${F_ASYNC}.native(dir, cb);`,
    `const d = ${F_SYNC}   .native(dir);`,
    `import { ${F_SYNC} } from "node:fs";`,
    `import {\n  mkdirSync,\n  ${F_SYNC},\n  rmSync\n} from "node:fs";\nconst d = ${F_SYNC}.native(dir);`,
    `import { ${F_ASYNC} } from "node:fs";`,
    `const d = await fs.promises.${F_ASYNC}(dir);`,
    `const d = await promises.${F_ASYNC}(dir);`,
    `import { ${F_ASYNC} } from "node:fs/promises";\nconst d = await ${F_ASYNC}(dir);`,
    `import { ${F_ASYNC} } from "fs/promises";\nconst d = await ${F_ASYNC}(dir);`,
    `import * as fsp from "node:fs/promises";\nconst d = await fsp.${F_ASYNC}(dir);`,
    `import fsp from "node:fs/promises";\nconst d = await fsp.${F_ASYNC}(dir);`,
    `const inside = ${F_ASYNC}Within(root, file);`,
    "const p = canonicalRealpath(dir);",
    `const ${F_ASYNC}_cache = new Map();`
  ];
  for (const source of clean) expect(findJsRealpath(source), `wrongly flagged: ${source}`).toEqual([]);
});

test("an unrenamed import is not a use: the call that follows it is still flagged", () => {
  expect(findJsRealpath(`import { ${F_ASYNC} } from "node:fs";\nconst d = await ${F_ASYNC}(dir);`).map((v) => v.line)).toEqual([2]);
  expect(findJsRealpath(`import { ${F_SYNC} } from "node:fs";\nconst d = ${F_SYNC}(dir);`).map((v) => v.line)).toEqual([2]);
});

test("the promise flavour exemption does not extend to a name imported from the callback module", () => {
  const source = `import { ${F_ASYNC} } from "node:fs/promises";\nimport * as fs from "node:fs";\nfs.${F_ASYNC}(dir, cb);\nfs.${F_SYNC}(dir);`;
  expect(findJsRealpath(source).map((v) => v.line)).toEqual([3, 4]);
});

test("the scan reads a multi-line source and reports each hit on its own line", () => {
  const source = ["a", `b ${F_SYNC}(x)`, "c", `d ${F_ASYNC}(y)`].join("\n");
  expect(findJsRealpath(source).map((v) => v.line)).toEqual([2, 4]);
});

test("the domain is derived from the directories and has not collapsed", () => {
  const [testsDir, supportDir] = ROOTS as [string, string];
  const tests = sourceFilesUnder(testsDir);
  const support = sourceFilesUnder(supportDir);
  expect(tests.length, "tests/ listing collapsed").toBeGreaterThanOrEqual(320);
  expect(support.length, "desktop/tests-support listing collapsed").toBeGreaterThanOrEqual(2);
  expect(tests.some((file) => file.endsWith("mock-module-guard.test.ts")), "a known test file is missing from the derived domain").toBe(true);
});

test("no test source names the JS canonicaliser, which keeps Windows 8.3 short names; use the .native form", () => {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of sourceFilesUnder(root)) {
      for (const violation of findJsRealpath(readFileSync(file, "utf8"))) {
        offenders.push(`${relative(REPO_ROOT, file).split(sep).join("/")}:${violation.line}  ${violation.text}`);
      }
    }
  }
  expect(
    offenders,
    `The plain sync and callback forms leave C:\\Users\\RUNNER~1 unexpanded while product code canonicalises to the long name, so an expected path built with them differs on a Windows runner only. ` +
      `The scan matches the bare word wherever it appears, in a comment or a string too: reword the prose or use the .native form. ` +
      `The promise flavour and an unrenamed named import are exempt.\n${offenders.join("\n")}`
  ).toEqual([]);
});
