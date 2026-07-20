import { test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Node-only module (no electron / no @shared alias), imports under bun.
import {
  globalTemplatesDir,
  localTemplatesDir,
  listTemplates,
  writeTemplate,
  readTemplate,
  deleteTemplate,
  templateSource,
} from "../desktop/src/main/template-store.ts";
import { toTemplate, TEMPLATE_TYPE } from "../desktop/src/shared/template.ts";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tpl-test-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function env(global: string): NodeJS.ProcessEnv {
  return { APPDATA: global, XDG_CONFIG_HOME: global } as NodeJS.ProcessEnv;
}

test("globalTemplatesDir / localTemplatesDir resolve under the app dirs", () => {
  const g = tmp();
  // v0.7.0 rename: the global config dir moved from claude-peers-desk to koryphaios.
  expect(globalTemplatesDir(env(g)).replace(/\\/g, "/")).toContain("koryphaios/templates");
  const proj = tmp();
  expect(localTemplatesDir(proj).replace(/\\/g, "/")).toContain(".claude/claude-peers/templates");
});

test("write then read round-trips a template", () => {
  const g = tmp();
  const tpl = toTemplate([{ name: "dev", args: "--agent dev", color: "#abc" }], "My team");
  const path = writeTemplate(globalTemplatesDir(env(g)), "My team", tpl);
  const back = readTemplate(path);
  expect(back).not.toBeNull();
  expect(back!.type).toBe(TEMPLATE_TYPE);
  expect(back!.sessions[0].name).toBe("dev");
});

test("listTemplates reports global + local with source and session count, skipping junk", () => {
  const g = tmp();
  const proj = tmp();
  writeTemplate(globalTemplatesDir(env(g)), "team-a", toTemplate([{ name: "a" }, { name: "b" }], "Team A"));
  writeTemplate(localTemplatesDir(proj), "team-b", toTemplate([{ name: "c" }], "Team B"));
  // A malformed json in the global dir must be skipped, not crash the scan.
  writeFileSync(join(globalTemplatesDir(env(g)), "junk.json"), "{ not json", "utf-8");

  const list = listTemplates(proj, env(g));
  const byName = Object.fromEntries(list.map((t) => [t.name, t]));
  expect(byName["Team A"]).toMatchObject({ source: "global", sessionCount: 2 });
  expect(byName["Team B"]).toMatchObject({ source: "local", sessionCount: 1 });
  expect(list).toHaveLength(2); // junk.json skipped
});

test("listTemplates returns [] when the dirs do not exist", () => {
  expect(listTemplates(tmp(), env(tmp()))).toEqual([]);
});

test("deleteTemplate removes a global template and it leaves the list", () => {
  const g = tmp();
  const proj = tmp();
  const path = writeTemplate(globalTemplatesDir(env(g)), "gone", toTemplate([{ name: "x" }], "Gone"));
  expect(listTemplates(proj, env(g))).toHaveLength(1);
  expect(deleteTemplate(path, proj, env(g))).toBe(true);
  expect(listTemplates(proj, env(g))).toHaveLength(0);
});

test("deleteTemplate removes a project-local template", () => {
  const g = tmp();
  const proj = tmp();
  const path = writeTemplate(localTemplatesDir(proj), "local-gone", toTemplate([{ name: "y" }], "Local"));
  expect(deleteTemplate(path, proj, env(g))).toBe(true);
  expect(listTemplates(proj, env(g))).toHaveLength(0);
});

test("deleteTemplate refuses a path outside the template dirs (guard)", () => {
  const g = tmp();
  const proj = tmp();
  // A .json sitting in an arbitrary dir must not be deletable through this API.
  const stray = join(tmp(), "secret.json");
  writeFileSync(stray, "{}", "utf-8");
  expect(deleteTemplate(stray, proj, env(g))).toBe(false);
});

test("deleteTemplate refuses a non-.json path and a missing file", () => {
  const g = tmp();
  const proj = tmp();
  const dir = globalTemplatesDir(env(g));
  mkdirSync(dir, { recursive: true });
  const notJson = join(dir, "note.txt");
  writeFileSync(notJson, "x", "utf-8");
  expect(deleteTemplate(notJson, proj, env(g))).toBe(false);
  expect(deleteTemplate(join(dir, "absent.json"), proj, env(g))).toBe(false);
});

// ----- templateSource containment (M-SEC-9) -----

test("templateSource classifies allowed dirs and rejects out-of-tree paths", () => {
  const g = tmp();
  const proj = tmp();
  const e = env(g);
  const gPath = writeTemplate(globalTemplatesDir(e), "gt", toTemplate([{ name: "a" }], "gt"));
  const lPath = writeTemplate(localTemplatesDir(proj), "lt", toTemplate([{ name: "b" }], "lt"));
  expect(templateSource(gPath, proj, e)).toBe("global");
  expect(templateSource(lPath, proj, e)).toBe("local");
  // Arbitrary absolute path outside both dirs → rejected.
  expect(templateSource(join(proj, "evil.json"), proj, e)).toBeNull();
  expect(templateSource("/etc/passwd", proj, e)).toBeNull();
  // A traversal that resolves outside the allowed dir → rejected.
  expect(templateSource(join(globalTemplatesDir(e), "..", "escape.json"), proj, e)).toBeNull();
  // Non-.json in an allowed dir → rejected.
  expect(templateSource(join(globalTemplatesDir(e), "x.txt"), proj, e)).toBeNull();
});
