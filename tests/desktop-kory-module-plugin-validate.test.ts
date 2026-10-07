import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DESKTOP = join(import.meta.dir, "..", "desktop");
const PLUGIN = join(DESKTOP, "deck-plugin");
const SKIP_ENV = "KORY_SKIP_PLUGIN_VALIDATE";
const VALIDATE_TIMEOUT_MS = 60_000;

/** Manifest errors that say nothing about whether the module loads. */
const TOLERATED_MANIFEST_ERRORS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "reserved plugin name", pattern: /^Plugin name "[^"]+" is reserved:/ },
];

/** Breaks one loader rule on purpose: the env name is not a string literal. */
const FAULTY_MODULE = `export function register(on) {
  on("tool.check", async ($, e, next) => {
    const name = ["KORY", "X"].join("_");
    await $.env.get(name);
    return next(e);
  });
}
`;

type Finding = { path?: string; message?: string };
type ValidateReport = {
  manifest?: { errors?: Finding[] };
  contents?: Array<{ file?: string; errors?: Finding[] }>;
};
type Validation = { exitCode: number | null; report: ValidateReport };

const skip = process.env[SKIP_ENV];

function tolerated(f: Finding): boolean {
  return TOLERATED_MANIFEST_ERRORS.some((t) => t.pattern.test(f.message ?? ""));
}

function validateModule(claude: string, moduleCode: string): Validation {
  const dir = mkdtempSync(join(tmpdir(), "kory-plugin-validate-"));
  try {
    mkdirSync(join(dir, ".claude-plugin"));
    mkdirSync(join(dir, "hooks"));
    copyFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), join(dir, ".claude-plugin", "plugin.json"));
    copyFileSync(join(PLUGIN, "hooks", "hooks.json"), join(dir, "hooks", "hooks.json"));
    writeFileSync(join(dir, "hooks", "kory-module.mjs"), moduleCode);
    const run = Bun.spawnSync([claude, "plugin", "validate", "--json", dir], { timeout: VALIDATE_TIMEOUT_MS });
    const stdout = run.stdout.toString();
    try {
      return { exitCode: run.exitCode, report: JSON.parse(stdout) as ValidateReport };
    } catch {
      throw new Error(`claude plugin validate gave no JSON report (exit ${run.exitCode}, signal ${run.signalCode}): ${stdout.slice(0, 500)} ${run.stderr.toString().slice(0, 500)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function moduleErrors(report: ValidateReport): string[] {
  return (report.contents ?? []).flatMap((c) => (c.errors ?? []).map((f) => `${c.file}: ${f.path}: ${f.message}`));
}

function claudeOrFail(): string {
  const claude = Bun.which("claude");
  expect(claude, `claude CLI absent: cannot validate kory-module.mjs; set ${SKIP_ENV}=1 to exempt explicitly`).not.toBeNull();
  return claude!;
}

test(`${SKIP_ENV} is either unset or exactly "1"`, () => {
  expect(skip === undefined || skip === "1", `${SKIP_ENV}=${JSON.stringify(skip)}: only "1" exempts the guard`).toBe(true);
});

test("only the reserved-name manifest error is tolerated", () => {
  expect(tolerated({ message: 'Plugin name "x" is reserved: it passes as one of Anthropic\'s own.' })).toBe(true);
  expect(tolerated({ message: "Plugin name x is invalid" })).toBe(false);
  expect(tolerated({ message: "hooks.json: modules is not an array" })).toBe(false);
});

test.skipIf(skip === "1")(
  "the CLI still reports a module that breaks a loader rule (positive control)",
  () => {
    const { report } = validateModule(claudeOrFail(), FAULTY_MODULE);
    const errors = moduleErrors(report);
    expect(errors, "a non-literal $.env.get name must surface as a module error").not.toEqual([]);
    expect(errors.join("\n"), "the error names the broken rule").toContain("$.env.get");
    expect(errors.join("\n"), "the error is the literal-name rule, not a parse error quoting the source").toContain("takes a literal name");
  },
  VALIDATE_TIMEOUT_MS + 30_000,
);

test.skipIf(skip === "1")(
  "the built kory-module.mjs is loadable by the real Claude Code module loader",
  async () => {
    const claude = claudeOrFail();
    const built = await Bun.build({ entrypoints: [join(DESKTOP, "hooks", "kory-module.ts")], target: "node" });
    expect(built.success, "kory-module.ts bundles").toBe(true);
    const { exitCode, report } = validateModule(claude, await built.outputs[0]!.text());

    const hooksEntry = (report.contents ?? []).find((c) => typeof c.file === "string" && /hooks\.json$/.test(c.file));
    expect(hooksEntry, "the report lists hooks.json under contents").toBeDefined();
    expect(Array.isArray(hooksEntry!.errors), "the hooks.json entry carries an errors array").toBe(true);

    const manifestErrors = report.manifest?.errors ?? [];
    const unexplained = [...manifestErrors.filter((f) => !tolerated(f)).map((f) => `manifest: ${f.path}: ${f.message}`), ...moduleErrors(report)];
    expect(unexplained, "the Deck plugin's module must be loadable by the real Claude Code loader").toEqual([]);

    const exitExplained = exitCode === 0 || (manifestErrors.length > 0 && manifestErrors.every(tolerated));
    expect(exitExplained, `validate exited ${exitCode} with no tolerated manifest error to explain it`).toBe(true);
  },
  VALIDATE_TIMEOUT_MS + 30_000,
);
