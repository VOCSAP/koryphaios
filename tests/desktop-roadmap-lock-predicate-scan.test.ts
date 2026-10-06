// isRoadmapLocked (desktop/src/shared/workflow.ts) is the only definition of
// "this card is locked" in the renderer. An inline `locked && ... in_progress`
// re-derives the old rule, under which a lock held outside in_progress read as
// free. Textual and over-matching by construction: a false positive costs a
// rename, a miss lets one view disagree with the others.

import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const COMPONENTS_DIR = join(import.meta.dir, "..", "desktop", "src", "renderer", "src", "components");

const INLINE_LOCK_RULE = /\.locked\b[^\n;]*&&[^\n;]*in_progress|in_progress[^\n;]*&&[^\n;]*\.locked\b/;

function inlineLockRules(src: string): string[] {
  return src.split("\n").filter((line) => INLINE_LOCK_RULE.test(line)).map((line) => line.trim());
}

test("no renderer component re-derives the lock rule inline: isRoadmapLocked is the only definition", () => {
  const files = readdirSync(COMPONENTS_DIR).filter((f) => /\.tsx?$/.test(f));
  expect(files.length).toBeGreaterThan(40);
  const failures: string[] = [];
  for (const file of files) {
    for (const line of inlineLockRules(readFileSync(join(COMPONENTS_DIR, file), "utf-8"))) {
      failures.push(`${file}: ${line} -- use isRoadmapLocked from @shared/workflow`);
    }
  }
  expect(failures).toEqual([]);
});

test("detector self-check: both orders bite, the shared predicate does not", () => {
  expect(inlineLockRules("const locked = item.locked && item.status === 'in_progress'")).toHaveLength(1);
  expect(inlineLockRules("if (i.status === 'in_progress' && i.locked) return")).toHaveLength(1);
  expect(inlineLockRules("const locked = isRoadmapLocked(item)")).toEqual([]);
});
