import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

const REPO_ROOT = join(import.meta.dir, "..");
const CLI_SOURCE = readFileSync(join(REPO_ROOT, "cli.ts"), "utf-8");
const SKILL_SOURCE = readFileSync(
  join(REPO_ROOT, "desktop", "deck-plugin", "skills", "roadmap-card", "SKILL.md"),
  "utf-8",
);
const AGENT_SOURCE = readFileSync(
  join(REPO_ROOT, "desktop", "deck-plugin", "agents", "roadmap-scribe.md"),
  "utf-8",
);

test("cli.ts declares a roadmap-add verb (fails closed if removed/renamed)", () => {
  expect(CLI_SOURCE).toMatch(/case\s+"roadmap-add"\s*:/);
});

test("roadmap-add reads its payload from a file, not from a token-shaped flag", () => {
  // The verb's own block must use --input (file path), and must not declare
  // any --token / -t flag anywhere in cli.ts. A token-shaped flag on this
  // verb's argv surface is exactly the leak this test exists to catch.
  //
  // Block boundary found via the next top-level `case "..."` / `default:`
  // marker rather than a literal "\n  }\n" closing-brace string: cli.ts uses
  // CRLF line endings, so a bare "\n"-only pattern silently never matches
  // (measured -- the first version of this test failed on that, not on a
  // real regression) and would have made this assertion pass vacuously on
  // an empty/wrong slice instead of failing loudly.
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

test("SKILL.md no longer sanctions building the raw Bearer request itself", () => {
  // Literal absence, not paraphrase: the fallback prose must not spell out
  // either the header shape or the env var name in a form an agent could
  // copy into a shell command. (A "never do X" sentence that still names X
  // verbatim defeats this -- caught when this test was first written: the
  // replacement prose initially still said "Authorization: Bearer" inside
  // its own prohibition and failed this exact assertion.)
  expect(SKILL_SOURCE).not.toMatch(/Authorization:\s*Bearer/i);
  expect(SKILL_SOURCE).not.toContain("CLAUDE_PEERS_BROKER_TOKEN");
  expect(SKILL_SOURCE).toContain("roadmap-add --input");
});

test("roadmap-scribe.md (the file that actually executes the fallback) carries no raw Bearer/token instructions", () => {
  // SKILL.md forks into this agent for the full step-by-step procedure; the
  // agent file is what runs when the fallback fires, so a leak surviving
  // here is live even if SKILL.md itself is clean. Same caught-on-first-draft
  // trap as SKILL.md: the rewrite must not still name the env var or the raw
  // header shape inside its own "never do this" sentence.
  expect(AGENT_SOURCE).not.toMatch(/Authorization:\s*Bearer/i);
  expect(AGENT_SOURCE).not.toContain("CLAUDE_PEERS_BROKER_TOKEN");
  expect(AGENT_SOURCE).not.toMatch(/roadmap\/upsert/i);
  expect(AGENT_SOURCE).not.toMatch(/curl\s/);
  expect(AGENT_SOURCE).toContain("roadmap-add --input");
});
