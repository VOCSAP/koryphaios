import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BIN_DIR = join(ROOT, "node_modules", ".bin");

// Both typescript and typescript6 ship a `tsc` bin and bun links the first
// package by name into .bin, so the alias's name decides which compiler
// `bun run typecheck` runs.
test("the root `tsc` bin is the TypeScript the manifest installs, not the TS 6 kept for its AST API", () => {
  const installed = JSON.parse(readFileSync(join(ROOT, "node_modules", "typescript", "package.json"), "utf8")).version;
  const bin = ["tsc.exe", "tsc.cmd", "tsc"].map((name) => join(BIN_DIR, name)).find((path) => existsSync(path));
  expect(bin, `no tsc bin under ${BIN_DIR}: run \`bun install\``).toBeDefined();
  const proc = Bun.spawnSync([bin!, "--version"], { cwd: ROOT });
  expect(proc.exitCode).toBe(0);
  expect(
    proc.stdout.toString().trim(),
    "node_modules/.bin/tsc resolves to a different compiler than node_modules/typescript: the typecheck gate no longer runs the version the manifest pins",
  ).toBe(`Version ${installed}`);
});
