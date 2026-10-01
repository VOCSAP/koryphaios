import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

const REPO_ROOT = join(import.meta.dir, "..");
const CLI_SOURCE = readFileSync(join(REPO_ROOT, "cli.ts"), "utf-8");
const SKILL_SOURCE = readFileSync(
  join(REPO_ROOT, "desktop", "deck-plugin", "skills", "roadmap-card", "SKILL.md"),
  "utf-8",
);
test("cli.ts declares a roadmap-add verb (fails closed if removed/renamed)", () => {
  expect(CLI_SOURCE).toMatch(/case\s+"roadmap-add"\s*:/);
});

test("roadmap-add reads its payload from a file, not from a token-shaped flag", () => {
  // The next top-level case/default marker prevents a line-ending change from
  // turning this into an empty slice whose content assertions pass vacuously.
  const caseStart = CLI_SOURCE.indexOf('case "roadmap-add"');
  expect(caseStart).toBeGreaterThan(-1);
  const afterMarker = CLI_SOURCE.slice(caseStart + 1).search(/\r?\n  (case "|default:)/);
  expect(afterMarker).toBeGreaterThan(-1);
  const caseEnd = caseStart + 1 + afterMarker;
  const roadmapAddBlock = CLI_SOURCE.slice(caseStart, caseEnd);

  expect(roadmapAddBlock).toContain('"--input"');
  expect(roadmapAddBlock).not.toMatch(/--token|"-t"/);
  expect(CLI_SOURCE).not.toMatch(/--token|["'`]-t["'`]/);
});

test("SKILL.md does not expose raw Bearer credentials", () => {
  // A raw header shape or environment variable here would be copyable into a
  // shell command, even when the prose says not to use it.
  expect(SKILL_SOURCE).not.toMatch(/Authorization:\s*Bearer/i);
  expect(SKILL_SOURCE).not.toContain("CLAUDE_PEERS_BROKER_TOKEN");
  expect(SKILL_SOURCE).toContain("roadmap-add --input");
});
