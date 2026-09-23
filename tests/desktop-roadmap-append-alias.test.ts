import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DESKTOP_ROOT = process.env.ROADMAP_APPEND_ALIAS_DESKTOP_ROOT ?? join(import.meta.dir, "..", "desktop");
const REPO_ROOT = resolve(DESKTOP_ROOT, "..");
const CANONICAL_APPEND_MODULE = join(REPO_ROOT, "shared", "roadmap-append.ts");

function readViteRoadmapAppendAlias(desktopRoot: string): string {
  const source = readFileSync(join(desktopRoot, "electron.vite.config.ts"), "utf8");
  const match = source.match(/['"]@roadmap-append['"]\s*:\s*resolve\(__dirname,\s*['"]([^'"]+)['"]\)/);
  if (!match?.[1]) throw new Error("Vite renderer config does not declare @roadmap-append");
  return resolve(desktopRoot, match[1]);
}

function readTsconfigRoadmapAppendAlias(desktopRoot: string): string {
  const tsconfig = JSON.parse(readFileSync(join(desktopRoot, "tsconfig.web.json"), "utf8")) as {
    compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
  };
  const alias = tsconfig.compilerOptions?.paths?.["@roadmap-append"]?.[0];
  if (!alias) throw new Error("TypeScript web config does not declare @roadmap-append");
  return resolve(desktopRoot, tsconfig.compilerOptions?.baseUrl ?? ".", alias);
}

test("Vite and TypeScript resolve the renderer roadmap append alias to the canonical root module", () => {
  expect(readViteRoadmapAppendAlias(DESKTOP_ROOT)).toBe(CANONICAL_APPEND_MODULE);
  expect(readTsconfigRoadmapAppendAlias(DESKTOP_ROOT)).toBe(CANONICAL_APPEND_MODULE);
});
