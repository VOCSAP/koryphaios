import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const REPO = join(import.meta.dir, "..");
const REQUIRED_REPO_INPUTS = ["broker.ts", "shared/logger.ts", "shared/log-redact.ts"];
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "broker-import-closure-"));
  temporaryRoots.push(root);
  return root;
}

function normalizedRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function isRelativeImport(specifier: string): boolean {
  return specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
}

function isAllowedBrokerInput(path: string): boolean {
  return path === "broker.ts" || path.startsWith("shared/") || path.startsWith("notify/");
}

async function brokerImportViolations(root: string): Promise<string[]> {
  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    result = await Bun.build({
      entrypoints: [join(root, "broker.ts")],
      root,
      target: "bun",
      allowUnresolved: [],
      metafile: true,
    });
  } catch (error) {
    throw new Error(`Broker import closure requires every relative import to resolve:\n${error instanceof Error ? error.message : String(error)}`);
  }

  if (!result.success || result.metafile === undefined) {
    const diagnostics = result.logs.map((log) => log.message).join("\n");
    throw new Error(`Broker import closure requires every relative import to resolve:\n${diagnostics}`);
  }

  const metafile = result.metafile;
  const inputs = Object.entries(metafile.inputs);
  const violations: string[] = [];

  if (root === REPO) {
    const presentInputs = new Set(inputs.map(([input]) => normalizedRelative(root, isAbsolute(input) ? input : resolve(root, input))));
    const missingInputs = REQUIRED_REPO_INPUTS.filter((input) => !presentInputs.has(input));
    if (missingInputs.length > 0) {
      throw new Error(`Broker import closure build omitted required inputs: ${missingInputs.join(", ")}`);
    }
  }

  for (const [importer, input] of inputs) {
    for (const dependency of input.imports) {
      const specifier = dependency.original ?? dependency.path;
      if (dependency.external || !isRelativeImport(specifier)) continue;
      const importerPath = isAbsolute(importer) ? importer : resolve(REPO, importer);
      const resolved = normalizedRelative(root, normalize(resolve(dirname(importerPath), specifier)));
      if (!isAllowedBrokerInput(resolved)) violations.push(`${normalizedRelative(root, importerPath)} imports ${specifier} (${resolved})`);
    }
  }

  return violations;
}

test("broker import closure stays within the Docker image inputs", async () => {
  const violations = await brokerImportViolations(REPO);
  expect(violations, `Broker imports outside broker.ts, shared/, and notify/: ${violations.join("; ")}`).toEqual([]);
});

test("broker import closure rejects a resolved dependency outside the Docker image inputs", async () => {
  const root = temporaryRoot();
  mkdirSync(join(root, "shared"), { recursive: true });
  mkdirSync(join(root, "desktop"), { recursive: true });
  writeFileSync(join(root, "broker.ts"), 'import "./shared/logger.ts";');
  writeFileSync(join(root, "shared", "logger.ts"), 'import "../desktop/log.ts";');
  writeFileSync(join(root, "desktop", "log.ts"), 'export const log = "desktop";');

  expect(await brokerImportViolations(root)).toEqual([
    "shared/logger.ts imports ../desktop/log.ts (desktop/log.ts)",
  ]);
});

test("broker import closure rejects an unresolved relative dependency", async () => {
  const root = temporaryRoot();
  writeFileSync(join(root, "broker.ts"), 'import "./missing.ts";');

  let message = "";
  try {
    await brokerImportViolations(root);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("Broker import closure requires every relative import to resolve");
});

test("broker import closure rejects an opaque dynamic import", async () => {
  const root = temporaryRoot();
  writeFileSync(join(root, "broker.ts"), "import(process.argv[2]);");

  let message = "";
  try {
    await brokerImportViolations(root);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("Broker import closure requires every relative import to resolve");
});

test("broker import closure rejects an opaque require", async () => {
  const root = temporaryRoot();
  writeFileSync(join(root, "broker.ts"), "require(process.argv[2]);");

  let message = "";
  try {
    await brokerImportViolations(root);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("Broker import closure requires every relative import to resolve");
});

test("broker import closure rejects a literal dynamic import outside the Docker image inputs", async () => {
  const root = temporaryRoot();
  mkdirSync(join(root, "desktop"), { recursive: true });
  writeFileSync(join(root, "broker.ts"), 'import("./desktop/log.ts");');
  writeFileSync(join(root, "desktop", "log.ts"), 'export const log = "desktop";');

  expect(await brokerImportViolations(root)).toEqual([
    "broker.ts imports ./desktop/log.ts (desktop/log.ts)",
  ]);
});

test("broker import closure rejects a literal require outside the Docker image inputs", async () => {
  const root = temporaryRoot();
  mkdirSync(join(root, "desktop"), { recursive: true });
  writeFileSync(join(root, "broker.ts"), 'require("./desktop/log.ts");');
  writeFileSync(join(root, "desktop", "log.ts"), 'export const log = "desktop";');

  expect(await brokerImportViolations(root)).toEqual([
    "broker.ts imports ./desktop/log.ts (desktop/log.ts)",
  ]);
});
