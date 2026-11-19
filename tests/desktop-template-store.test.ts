import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Node-only module (no electron / no @shared alias), imports under bun.
import {
  globalTemplatesDir,
  localTemplatesDir,
  localTemplateDirs,
  listTemplates,
  writeTemplate,
  readTemplate,
  deleteTemplate,
  templateSource,
  templateSaveTarget,
  templateWriteDir,
  writeAgentTemplate,
  writeTemplateAt,
} from "../desktop/src/main/template-store.ts";
import { toTemplate, TEMPLATE_TYPE } from "../desktop/src/shared/template.ts";
import { extractBracedBody } from "./_braced-body.ts";
import { onDeckError } from "../desktop/src/main/log.ts";
import { MAX_TRACED_FILES, MAX_TRACED_PER_SCAN } from "../desktop/src/main/project-files.ts";

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
  expect(globalTemplatesDir(env(g)).replace(/\\/g, "/")).toContain("koryphaios/templates");
  const proj = tmp();
  expect(localTemplatesDir(proj).replace(/\\/g, "/")).toContain(".claude/koryphaios/templates");
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

// ----- writeTemplate refuses multiple leads (card 240d6efd, decision 1) -----

test("writeTemplate throws a specific, actionable message naming the offending sessions when >1 lead", () => {
  const g = tmp();
  const tpl = toTemplate(
    [
      { name: "a", lead: true },
      { name: "b" },
      { name: "c", lead: true },
    ] as never,
    "bad team"
  );
  // toTemplate() does not dedupe (it trusts live-session lead exclusivity),
  // so this reproduces exactly what template:export / saveTemplate would
  // hand to writeTemplate if that upstream invariant ever broke.
  expect(() => writeTemplate(globalTemplatesDir(env(g)), "bad team", tpl)).toThrow(/a, c/);
  expect(() => writeTemplate(globalTemplatesDir(env(g)), "bad team", tpl)).toThrow(/multiple leads/i);
});

test("writeTemplate does NOT throw for zero or one lead (negative control)", () => {
  const g = tmp();
  const zeroLead = toTemplate([{ name: "a" }, { name: "b" }] as never, "none");
  expect(() => writeTemplate(globalTemplatesDir(env(g)), "none", zeroLead)).not.toThrow();
  const oneLead = toTemplate([{ name: "a", lead: true }, { name: "b" }] as never, "one");
  expect(() => writeTemplate(globalTemplatesDir(env(g)), "one", oneLead)).not.toThrow();
});

// ----- readTemplate surfaces a silent lead-demotion via reportError (decision 2) -----

test("readTemplate reports an observable signal when the file on disk carries multiple leads", () => {
  const g = tmp();
  const dir = globalTemplatesDir(env(g));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "two-leads.json");
  writeFileSync(
    path,
    JSON.stringify({
      type: TEMPLATE_TYPE,
      version: 1,
      sessions: [{ name: "a", lead: true }, { name: "b", lead: true }],
    }),
    "utf-8"
  );
  const calls: Array<[string, string]> = [];
  onDeckError((scope, text) => calls.push([scope, text]));
  try {
    const back = readTemplate(path);
    expect(back).not.toBeNull();
    expect(back!.sessions.map((s) => !!s.lead)).toEqual([true, false]);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some(([, text]) => text.includes("b"))).toBe(true);
  } finally {
    onDeckError(() => {}); // module-level singleton: never leave a test's listener armed
  }
});

test("readTemplate reports NOTHING for a file with zero or one lead (negative control)", () => {
  const g = tmp();
  const dir = globalTemplatesDir(env(g));
  const path = writeTemplate(dir, "fine", toTemplate([{ name: "a", lead: true }, { name: "b" }] as never, "fine"));
  const calls: Array<[string, string]> = [];
  onDeckError((scope, text) => calls.push([scope, text]));
  try {
    const back = readTemplate(path);
    expect(back).not.toBeNull();
    expect(calls).toEqual([]);
  } finally {
    onDeckError(() => {});
  }
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

test("templateWriteDir refuses the global dir to a caller that is not the Deck window", () => {
  const e = env(tmp());
  const proj = tmp();
  expect(() => templateWriteDir(proj, false, "unattended", e)).toThrow(/refused/);
});

test("templateWriteDir refuses the global dir when the attendance is not recognized", () => {
  const e = env(tmp());
  expect(() => templateWriteDir(tmp(), false, undefined as never, e)).toThrow(/refused/);
});

test("templateWriteDir gives the Deck window the global dir", () => {
  const e = env(tmp());
  expect(templateWriteDir(tmp(), false, "attended", e)).toBe(globalTemplatesDir(e));
});

test("templateWriteDir gives any caller the project dir for a local template", () => {
  const e = env(tmp());
  const proj = tmp();
  expect(templateWriteDir(proj, true, "unattended", e)).toBe(localTemplatesDir(proj));
  expect(templateWriteDir(proj, true, "attended", e)).toBe(localTemplatesDir(proj));
});

const koryphaiosDir = (proj: string): string => join(proj, ".claude", "koryphaios", "templates");
const legacyDir = (proj: string): string => join(proj, ".claude", "claude-peers", "templates");

function traced(run: () => void): string[] {
  const texts: string[] = [];
  onDeckError((_scope, text) => texts.push(text));
  try {
    run();
  } finally {
    onDeckError(() => {});
  }
  return texts;
}

test("local templates are created under koryphaios and read from koryphaios then claude-peers", () => {
  const proj = tmp();
  expect(localTemplatesDir(proj)).toBe(koryphaiosDir(proj));
  expect(localTemplateDirs(proj)).toEqual([koryphaiosDir(proj), legacyDir(proj)]);
  expect(templateWriteDir(proj, true, "unattended", env(tmp()))).toBe(koryphaiosDir(proj));
});

test("templateSource classes a template of either local folder as local and nothing beside them", () => {
  const e = env(tmp());
  const proj = tmp();
  const fresh = writeTemplate(koryphaiosDir(proj), "a", toTemplate([{ name: "a" }], "a"));
  const old = writeTemplate(legacyDir(proj), "b", toTemplate([{ name: "b" }], "b"));
  expect(templateSource(fresh, proj, e)).toBe("local");
  expect(templateSource(old, proj, e)).toBe("local");
  expect(templateSource(join(proj, ".claude", "other", "templates", "x.json"), proj, e)).toBeNull();
  expect(templateSource(join(koryphaiosDir(proj), "sub", "x.json"), proj, e)).toBeNull();
  expect(templateSource(join(proj, ".claude", "koryphaios", "x.json"), proj, e)).toBeNull();
  expect(
    templateSource(join(koryphaiosDir(proj), "..", "..", "claude-peers", "templates", "x.json"), proj, e)
  ).toBe("local");
});

test("listTemplates lists global, koryphaios then claude-peers and never merges one name held by two folders", () => {
  const e = env(tmp());
  const proj = tmp();
  const global = writeTemplate(globalTemplatesDir(e), "shared", toTemplate([{ name: "g" }], "Shared"));
  const fresh = writeTemplate(koryphaiosDir(proj), "shared", toTemplate([{ name: "n" }], "Shared"));
  const old = writeTemplate(legacyDir(proj), "shared", toTemplate([{ name: "o" }, { name: "p" }], "Shared"));
  expect(listTemplates(proj, e).map((t) => [t.path, t.source, t.sessionCount])).toEqual([
    [global, "global", 1],
    [fresh, "local", 1],
    [old, "local", 2],
  ]);
});

test("deleteTemplate removes the exact template chosen in either local folder and refuses a sibling folder", () => {
  const e = env(tmp());
  const proj = tmp();
  const fresh = writeTemplate(koryphaiosDir(proj), "same", toTemplate([{ name: "n" }], "Same"));
  const old = writeTemplate(legacyDir(proj), "same", toTemplate([{ name: "o" }], "Same"));
  expect(deleteTemplate(old, proj, e)).toBe(true);
  expect(listTemplates(proj, e).map((t) => t.path)).toEqual([fresh]);
  expect(deleteTemplate(fresh, proj, e)).toBe(true);
  expect(listTemplates(proj, e)).toEqual([]);

  const sibling = writeTemplate(join(proj, ".claude", "other", "templates"), "x", toTemplate([{ name: "z" }], "X"));
  expect(deleteTemplate(sibling, proj, e)).toBe(false);
  expect(readTemplate(sibling)).not.toBeNull();
});

test("readTemplate traces an invalid file once per signature and stays silent about an absent one", () => {
  const dir = globalTemplatesDir(env(tmp()));
  mkdirSync(dir, { recursive: true });
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{ not json", "utf-8");
  const about = (run: () => void): number => traced(run).filter((text) => text.includes(bad)).length;
  expect(about(() => { expect(readTemplate(bad)).toBeNull(); expect(readTemplate(bad)).toBeNull(); })).toBe(1);
  writeFileSync(bad, "{ not json, and a longer file now", "utf-8");
  expect(about(() => readTemplate(bad))).toBe(1);
  expect(traced(() => { expect(readTemplate(join(dir, "absent.json"))).toBeNull(); })).toEqual([]);
});

test("readTemplate traces valid JSON that is not a template", () => {
  const dir = globalTemplatesDir(env(tmp()));
  mkdirSync(dir, { recursive: true });
  const notATemplate = join(dir, "not-a-template.json");
  writeFileSync(notATemplate, JSON.stringify({ hello: 1 }), "utf-8");
  const texts = traced(() => { expect(readTemplate(notATemplate)).toBeNull(); });
  expect(texts.filter((text) => text.includes(notATemplate))).toHaveLength(1);
});

test("listTemplates traces a folder it cannot read once, and stays silent about an absent folder", () => {
  const e = env(tmp());
  const proj = tmp();
  const unreadable = koryphaiosDir(proj);
  const readDir = (dir: string): string[] => {
    throw Object.assign(new Error(dir === unreadable ? "denied" : "absent"), {
      code: dir === unreadable ? "EACCES" : "ENOENT",
    });
  };
  const texts = traced(() => {
    expect(listTemplates(proj, e, readDir)).toEqual([]);
    expect(listTemplates(proj, e, readDir)).toEqual([]);
  });
  expect(texts.filter((text) => text.includes(unreadable))).toHaveLength(1);
  expect(texts.filter((text) => !text.includes(unreadable))).toEqual([]);
});

test("a folder of more invalid templates than the trace cap costs one trace per file up to the budget, one line for the rest, and nothing on the next listing", () => {
  const e = env(tmp());
  const proj = tmp();
  const dir = koryphaiosDir(proj);
  mkdirSync(dir, { recursive: true });
  for (let index = 0; index < MAX_TRACED_FILES + 1; index++) {
    writeFileSync(join(dir, "junk-" + index + ".json"), "{ not json " + index, "utf-8");
  }
  const first = traced(() => { listTemplates(proj, e); });
  expect(first).toHaveLength(MAX_TRACED_PER_SCAN + 1);
  expect(first.filter((text) => text.includes(MAX_TRACED_FILES + 1 - MAX_TRACED_PER_SCAN + " more invalid files"))).toHaveLength(1);
  expect(traced(() => { listTemplates(proj, e); }), "the second listing traces nothing").toEqual([]);
});

test("the same invalid templates read in another order trace nothing again", () => {
  const e = env(tmp());
  const proj = tmp();
  const dir = koryphaiosDir(proj);
  mkdirSync(dir, { recursive: true });
  for (let index = 0; index < 2 * MAX_TRACED_PER_SCAN + 4; index++) {
    writeFileSync(join(dir, "junk-" + index + ".json"), "{ not json " + index, "utf-8");
  }
  expect(traced(() => { listTemplates(proj, e); })).toHaveLength(MAX_TRACED_PER_SCAN + 1);
  const reversed = (folder: string): string[] => readdirSync(folder).reverse();
  expect(traced(() => { listTemplates(proj, e, reversed); })).toEqual([]);
});

test("ipc.ts and the index.ts saveTemplate reach the global templates dir only through templateWriteDir, ipc with attendance from isLocalIpcEvent", () => {
  const ipcSource = readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "ipc.ts"), "utf-8");
  expect(
    ipcSource,
    "ipc.ts must not name globalTemplatesDir: a handler resolving the global dir itself bypasses the companion refusal of templateWriteDir"
  ).not.toContain("globalTemplatesDir");
  for (const [channel, firstWork, gateCall, sink] of [
    [
      "template:write",
      "parseTemplate(",
      "templateSaveTarget(getConfig().projectDir, local, attendance, name, sourcePath)",
      "writeTemplateAt(target.file,"
    ],
    ["template:export", "captureSessions(", "templateWriteDir(getConfig().projectDir, local, attendance)", "writeTemplate(dir,"]
  ] as const) {
    const gate = gateCall.slice(0, gateCall.indexOf("("));
    const start = ipcSource.indexOf(`regHandle('${channel}'`);
    expect(start, `${channel} handler not found in ipc.ts`).toBeGreaterThanOrEqual(0);
    const end = ipcSource.indexOf("regHandle(", start + 1);
    const body = ipcSource.slice(start, end < 0 ? undefined : end);
    expect(
      body.split(`${gate}(`).length - 1,
      `${channel} must call ${gate} exactly once, or a second call can feed the sink a path resolved without the caller's attendance`
    ).toBe(1);
    expect(body, `${channel} must write to the path ${gate} resolved`).toContain(sink);
    expect(body.indexOf(firstWork), `${channel} body must contain ${firstWork}`).toBeGreaterThanOrEqual(0);
    expect(
      body.indexOf(`${gate}(`) < body.indexOf(firstWork),
      `${channel} must refuse a paired device before ${firstWork} runs, not after work is done`
    ).toBe(true);
    expect(
      body,
      `${channel} must resolve its target through ${gate} with the caller's attendance, or a paired device writes into the global templates dir`
    ).toContain(gateCall);
    expect(body, `${channel} must derive attendance from isLocalIpcEvent(_e)`).toContain(
      "const attendance: CallerAttendance = isLocalIpcEvent(_e) ? 'attended' : 'unattended'"
    );
  }
  const writeAt = ipcSource.indexOf("regHandle('template:write'");
  const writeBody = ipcSource.slice(writeAt, ipcSource.indexOf("regHandle(", writeAt + 1));
  expect(
    writeBody.indexOf("writeTemplateAt(") >= 0 &&
      writeBody.indexOf("writeTemplateAt(") < writeBody.indexOf("deleteTemplate(target.removeAfter,"),
    "template:write must delete a renamed template's old file only after the new one is written"
  ).toBe(true);

  const indexSource = readFileSync(join(import.meta.dir, "..", "desktop", "src", "main", "index.ts"), "utf-8");
  const anchor = "saveTemplate: (name, local) =>";
  expect(indexSource.split(anchor).length - 1, "index.ts must hold exactly one saveTemplate dep").toBe(1);
  const saveBody = extractBracedBody(indexSource, indexSource.indexOf("{", indexSource.indexOf(anchor)));
  expect(
    saveBody,
    "the agent saveTemplate dep must not resolve the global templates dir itself: an agent would write a trusted template"
  ).not.toContain("globalTemplatesDir");
  expect(saveBody, "the agent saveTemplate dep must not call writeTemplate with a dir it chose").not.toContain(
    "writeTemplate("
  );
  expect(saveBody, "the agent saveTemplate dep must write through writeAgentTemplate in the project dir").toContain(
    "writeAgentTemplate(getConfig().projectDir, local,"
  );
});

test("writeAgentTemplate refuses a global write and creates no templates folder", () => {
  const e = env(tmp());
  const proj = tmp();
  expect(() => writeAgentTemplate(proj, false, "evil", toTemplate([{ name: "a" }], "a"), e)).toThrow(
    "refused: an agent saves templates in the project only; the operator saves global ones from the Deck"
  );
  expect(existsSync(globalTemplatesDir(e)), "a refused agent write reached the global templates dir").toBe(false);
  expect(existsSync(localTemplatesDir(proj))).toBe(false);
});

test("writeAgentTemplate writes a local template into the project dir and never the global one", () => {
  const e = env(tmp());
  const proj = tmp();
  const path = writeAgentTemplate(proj, true, "mine", toTemplate([{ name: "a" }], "a"), e);
  expect(path).toBe(join(localTemplatesDir(proj), "mine.json"));
  expect(existsSync(path)).toBe(true);
  expect(existsSync(globalTemplatesDir(e))).toBe(false);
});

function savedTemplate(dir: string, fileName: string, storedName: string): string {
  return writeTemplate(dir, fileName, toTemplate([{ name: "a" }], storedName));
}

test("templateSaveTarget without a source keeps the default dir and the name-derived file", () => {
  const e = env(tmp());
  const proj = tmp();
  expect(templateSaveTarget(proj, true, "attended", "My Team", undefined, e)).toEqual({
    file: join(koryphaiosDir(proj), "My-Team.json")
  });
  expect(() => templateSaveTarget(proj, false, "unattended", "My Team", undefined, e)).toThrow(/refused/);
});

test("templateSaveTarget saves an edited template back into its own file, the legacy folder included", () => {
  const e = env(tmp());
  const proj = tmp();
  const fresh = savedTemplate(koryphaiosDir(proj), "mine", "mine");
  const old = savedTemplate(legacyDir(proj), "old-file", "Old Team");
  expect(templateSaveTarget(proj, true, "attended", "mine", fresh, e)).toEqual({ file: fresh });
  const inPlace = templateSaveTarget(proj, true, "attended", "Old Team", old, e);
  expect(inPlace, "an unchanged name must not move a legacy template into the new folder").toEqual({ file: old });
});

test("templateSaveTarget on a rename targets the source folder and names the old file for removal", () => {
  const e = env(tmp());
  const proj = tmp();
  const old = savedTemplate(legacyDir(proj), "old", "Old Team");
  expect(templateSaveTarget(proj, true, "attended", "New Team", old, e)).toEqual({
    file: join(legacyDir(proj), "New-Team.json"),
    removeAfter: old
  });
});

test("templateSaveTarget treats a case-only rename of the file name as the same file", () => {
  const e = env(tmp());
  const proj = tmp();
  const lower = savedTemplate(koryphaiosDir(proj), "team", "team");
  expect(
    templateSaveTarget(proj, true, "attended", "TEAM", lower, e),
    "removing the old name would delete the file just written on a case-insensitive disk"
  ).toEqual({ file: lower });
});

test("templateSaveTarget refuses a source outside the template folders instead of using the default dir", () => {
  const e = env(tmp());
  const proj = tmp();
  for (const bad of [
    join(proj, "evil.json"),
    "/etc/passwd",
    join(koryphaiosDir(proj), "..", "..", "..", "escape.json"),
    join(koryphaiosDir(proj), "sub", "x.json"),
    join(koryphaiosDir(proj), "x.txt")
  ]) {
    for (const local of [true, false]) {
      expect(() => templateSaveTarget(proj, local, "attended", "x", bad, e), `${bad} local:${local}`).toThrow(
        /not in a template folder/
      );
    }
  }
  expect(() => templateSaveTarget(proj, true, "attended", "x", null as never, e)).toThrow(/not a path/);
});

test("templateSaveTarget copies into the default dir of the other scope and leaves the source alone", () => {
  const e = env(tmp());
  const proj = tmp();
  const global = savedTemplate(globalTemplatesDir(e), "g", "g");
  const legacy = savedTemplate(legacyDir(proj), "p", "p");
  expect(templateSaveTarget(proj, true, "attended", "Copy Name", global, e)).toEqual({
    file: join(koryphaiosDir(proj), "Copy-Name.json")
  });
  expect(templateSaveTarget(proj, false, "attended", "Copy Name", legacy, e)).toEqual({
    file: join(globalTemplatesDir(e), "Copy-Name.json")
  });
});

test("templateSaveTarget refuses a copy into the global folder for a caller that is not the Deck window", () => {
  const e = env(tmp());
  const proj = tmp();
  const project = savedTemplate(koryphaiosDir(proj), "p", "p");
  expect(() => templateSaveTarget(proj, false, "unattended", "p2", project, e)).toThrow(/refused/);
});

test("templateSaveTarget never copies onto an existing template of the other scope", () => {
  const e = env(tmp());
  const proj = tmp();
  const project = savedTemplate(koryphaiosDir(proj), "p", "p");
  savedTemplate(globalTemplatesDir(e), "p", "other");
  expect(() => templateSaveTarget(proj, false, "attended", "p", project, e)).toThrow(
    "refused: a template named p already exists in this folder"
  );
});

test("templateSaveTarget lets only the Deck window save over a global template", () => {
  const e = env(tmp());
  const proj = tmp();
  const global = savedTemplate(globalTemplatesDir(e), "g", "g");
  expect(templateSaveTarget(proj, false, "attended", "g", global, e)).toEqual({ file: global });
  expect(() => templateSaveTarget(proj, false, "unattended", "g", global, e)).toThrow(/refused/);
});

test("deleteTemplate traces a failed delete instead of swallowing it", () => {
  const e = env(tmp());
  const proj = tmp();
  const stuck = join(koryphaiosDir(proj), "stuck.json");
  mkdirSync(stuck, { recursive: true });
  let deleted: boolean | undefined;
  const texts = traced(() => {
    deleted = deleteTemplate(stuck, proj, e);
  });
  expect(deleted).toBe(false);
  expect(texts.some((text) => text.includes("stuck.json")), "a failed template delete left no trace").toBe(true);
});

const canLink = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), "tpl-link-"));
  try {
    writeFileSync(join(probe, "t"), "x");
    symlinkSync(join(probe, "t"), join(probe, "l"), "file");
    mkdirSync(join(probe, "d"));
    symlinkSync(join(probe, "d"), join(probe, "dl"), "junction");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

test("templateSaveTarget never renames onto another template", () => {
  const e = env(tmp());
  const proj = tmp();
  const alpha = savedTemplate(legacyDir(proj), "a", "Alpha");
  savedTemplate(legacyDir(proj), "b", "b");
  expect(() => templateSaveTarget(proj, true, "attended", "b", alpha, e)).toThrow(
    "refused: a template named b already exists in this folder"
  );
});

test("templateSaveTarget refuses a source that is a directory", () => {
  const e = env(tmp());
  const proj = tmp();
  mkdirSync(join(legacyDir(proj), "d.json"), { recursive: true });
  expect(() => templateSaveTarget(proj, true, "attended", "d", join(legacyDir(proj), "d.json"), e)).toThrow(
    /not a regular file/
  );
});

test.skipIf(!canLink)("templateSaveTarget refuses a source that is a link out of the project (needs symlinkSync)", () => {
  const e = env(tmp());
  const proj = tmp();
  const victim = savedTemplate(tmp(), "victim", "victim");
  mkdirSync(legacyDir(proj), { recursive: true });
  const link = join(legacyDir(proj), "evil.json");
  symlinkSync(victim, link, "file");
  expect(() => templateSaveTarget(proj, true, "attended", "victim", link, e)).toThrow(/is a link/);
});

test.skipIf(!canLink)("templateSaveTarget refuses a rename onto a link (needs symlinkSync)", () => {
  const e = env(tmp());
  const proj = tmp();
  const victim = savedTemplate(tmp(), "victim", "victim");
  const real = savedTemplate(legacyDir(proj), "real", "Real");
  symlinkSync(victim, join(legacyDir(proj), "Other.json"), "file");
  expect(() => templateSaveTarget(proj, true, "attended", "Other", real, e)).toThrow(/already exists in this folder/);
});

test.skipIf(!canLink)("templateSaveTarget refuses a source whose folder is a link leaving the project (needs symlinkSync)", () => {
  const e = env(tmp());
  const proj = tmp();
  const outside = tmp();
  savedTemplate(outside, "in", "in");
  mkdirSync(join(proj, ".claude", "claude-peers"), { recursive: true });
  symlinkSync(outside, legacyDir(proj), "junction");
  expect(() => templateSaveTarget(proj, true, "attended", "in", join(legacyDir(proj), "in.json"), e)).toThrow(
    /resolves outside the project/
  );
});

test("editing a legacy template in place leaves one entry in the list, at the legacy path, with the edited content", () => {
  const e = env(tmp());
  const proj = tmp();
  const old = savedTemplate(legacyDir(proj), "old-file", "Old Team");
  const target = templateSaveTarget(proj, true, "attended", "Old Team", old, e);
  writeTemplateAt(target.file, toTemplate([{ name: "a" }, { name: "b" }], "Old Team"));
  if (target.removeAfter) deleteTemplate(target.removeAfter, proj, e);
  expect(
    listTemplates(proj, e).map(({ name, path, sessionCount }) => ({ name, path, sessionCount })),
    "an edit of a legacy template must not leave a second copy in the list"
  ).toEqual([{ name: "Old Team", path: old, sessionCount: 2 }]);
});

test("renaming a legacy template leaves one entry in the list, under the new name", () => {
  const e = env(tmp());
  const proj = tmp();
  const old = savedTemplate(legacyDir(proj), "old-file", "Old Team");
  const target = templateSaveTarget(proj, true, "attended", "New Team", old, e);
  writeTemplateAt(target.file, toTemplate([{ name: "a" }], "New Team"));
  if (target.removeAfter) deleteTemplate(target.removeAfter, proj, e);
  expect(
    listTemplates(proj, e).map(({ name, path }) => ({ name, path })),
    "a rename must leave neither the old name nor a second file in the list"
  ).toEqual([{ name: "New Team", path: join(legacyDir(proj), "New-Team.json") }]);
});
