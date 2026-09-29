import { describe, expect, test } from "bun:test";
import { EXPECTED_LAUNCHES, SERVER_ARTIFACT, auditDomain, scanLaunches } from "./_spawn-discipline.ts";

// Concatenated: the CI partition guard reads this import written as plain text
// as a real import of the broker-spawning helper.
const HELPER_IMPORT = "import { scrubEnv } " + 'from "./' + '_helper.ts";\n';

/** One launch expected: is it accepted as scrubbed, or refused / not understood? */
function verdict(source: string): "accepted" | "refused" | "not understood" | "not seen" {
  const scan = scanLaunches("probe.test.ts", source);
  if (scan.unrecognized.length > 0) return "not understood";
  if (scan.launches.length === 0) return "not seen";
  return scan.launches.every((launch) => launch.scrubbed) ? "accepted" : "refused";
}

describe("launch forms", () => {
  test("the correct form is accepted, from either scrubEnv module", () => {
    expect(verdict(`${HELPER_IMPORT}Bun.spawn(["bun", "server.ts"], { env: scrubEnv(dir) });`)).toBe("accepted");
    expect(
      verdict(`import { scrubEnv } from "./_scrub-env.ts";\nBun.spawnSync({ cmd: ["bun", "server.ts"], env: scrubEnv(dir) });`)
    ).toBe("accepted");
    expect(
      verdict(`${HELPER_IMPORT}import { spawn } from "node:child_process";\nspawn("bun", ["server.ts"], { cwd, env: scrubEnv(dir) });`)
    ).toBe("accepted");
  });

  test("execFileSync is a launch like any other", () => {
    expect(
      verdict(`import { execFileSync } from "node:child_process";\nexecFileSync("bun", ["server.ts"], { env: process.env });`)
    ).toBe("refused");
  });

  test("the options argument follows the overload: after an argv array, else right after the command", () => {
    const spawnNoArgv = `${HELPER_IMPORT}import { spawn } from "node:child_process";\nspawn("bun server.ts", { env: scrubEnv(dir) });`;
    expect(verdict(spawnNoArgv)).toBe("accepted");
    const execLeaking = `import { exec } from "node:child_process";\nexec("bun server.ts", { env: process.env }, () => {});`;
    expect(verdict(execLeaking)).toBe("refused");
    const execScrubbed = `${HELPER_IMPORT}import { exec } from "node:child_process";\nexec("bun server.ts", { env: scrubEnv(dir) }, () => {});`;
    expect(verdict(execScrubbed)).toBe("accepted");
  });

  test("env must be the one top-level env of the options, with nothing spread after it", () => {
    const nested = `${HELPER_IMPORT}Bun.spawn(["bun", "server.ts"], { opts: { env: scrubEnv(dir) }, env: process.env });`;
    expect(verdict(nested), "nested env").toBe("refused");
    const spreadAfter = `${HELPER_IMPORT}Bun.spawn(["bun", "server.ts"], { env: scrubEnv(dir), ...{ env: process.env } });`;
    expect(verdict(spreadAfter), "spread after env").toBe("refused");
    const repeated = `${HELPER_IMPORT}Bun.spawn(["bun", "server.ts"], { env: scrubEnv(dir), env: process.env });`;
    expect(verdict(repeated), "env repeated").toBe("refused");
    const shorthand = `${HELPER_IMPORT}const env = scrubEnv(dir);\nBun.spawn(["bun", "server.ts"], { env });`;
    expect(verdict(shorthand), "env by reference").toBe("refused");
  });

  test("scrubEnv must be the imported one, never redeclared nor taken from elsewhere", () => {
    const redeclared = `${HELPER_IMPORT}function run() { const scrubEnv = () => process.env; Bun.spawn(["bun", "server.ts"], { env: scrubEnv(dir) }); }`;
    expect(verdict(redeclared)).toBe("refused");
    const local = `const scrubEnv = () => process.env;\nBun.spawn(["bun", "server.ts"], { env: scrubEnv(dir) });`;
    expect(verdict(local)).toBe("refused");
    const foreign = `import { scrubEnv } from "./elsewhere.ts";\nBun.spawn(["bun", "server.ts"], { env: scrubEnv(dir) });`;
    expect(verdict(foreign)).toBe("refused");
  });

  test("an aliased or namespaced child_process launch is recognized, then judged", () => {
    const alias = `import { spawn as launch } from "node:child_process";\nlaunch("bun", ["server.ts"], { env: process.env });`;
    expect(verdict(alias)).toBe("refused");
    const namespace = `import * as childProcess from "node:child_process";\nchildProcess.spawn("bun", ["server.ts"], { env: process.env });`;
    expect(verdict(namespace)).toBe("refused");
    const defaulted = `import cp from "child_process";\ncp.execFileSync("bun", ["server.ts"], { env: process.env });`;
    expect(verdict(defaulted)).toBe("refused");
  });

  test("a launch form the scan cannot follow fails instead of being skipped", () => {
    expect(verdict(`Bun["spawn"](["bun", "server.ts"], { env: process.env });`), "computed access").toBe("not understood");
    expect(verdict(`${HELPER_IMPORT}Bun.spawn?.(["bun", "server.ts"], { env: scrubEnv(dir) });`), "optional call").toBe(
      "not understood"
    );
    expect(verdict(`const { spawn } = Bun;\nspawn(["bun", "server.ts"], { env: process.env });`), "destructured").toBe(
      "not understood"
    );
    expect(verdict(`runner.spawnSync(["bun", "server.ts"], { env: process.env });`), "unknown owner").toBe("not understood");
  });

  test("every reference to a launch binding that is not the direct callee of a launch is not understood", () => {
    const forms: Record<string, string> = {
      "require used inline": `require("child_process").exec("bun server.ts");`,
      "dynamic import": `const cp = await import("node:child_process");`,
      "Bun.spawn stored": `const run = Bun.spawn;\nrun(["bun", "server.ts"]);`,
      "imported spawn stored": `import { spawn } from "node:child_process";\nconst go = spawn;\ngo("bun", ["server.ts"]);`,
      "Bun.$ template": "Bun.$`bun server.ts`;",
      "$ from bun": `import { $ } from "bun";\n$\`bun server.ts\`;`,
      ".call": `import { spawn } from "node:child_process";\nspawn.call(null, "bun", ["server.ts"]);`,
      ".apply": `Bun.spawn.apply(null, [["bun", "server.ts"]]);`,
      "promisify": `import { promisify } from "node:util";\nimport { execFile } from "node:child_process";\npromisify(execFile)("bun", ["server.ts"]);`,
      "Bun passed around": `const b = Bun;\nb.spawn(["bun", "server.ts"]);`,
      "Bun destructured": `const { spawn } = Bun;\nspawn(["bun", "server.ts"]);`,
      "namespace passed around": `import * as cp from "node:child_process";\nconst launcher = cp;\nlauncher.spawn("bun", ["server.ts"]);`,
      "Worker": `new Worker("./server.ts");`,
    };
    for (const [label, source] of Object.entries(forms)) {
      expect(verdict(source), label).toBe("not understood");
    }
  });

  test("a module bound through require or bun's own export is recognized, then judged", () => {
    const required = `const cp = require("node:child_process");\ncp.exec("bun server.ts", { env: process.env });`;
    expect(verdict(required), "namespace from require").toBe("refused");
    const destructured = `const { spawn } = require("child_process");\nspawn("bun", ["server.ts"], { env: process.env });`;
    expect(verdict(destructured), "destructured require").toBe("refused");
    const fromBun = `${HELPER_IMPORT}import { spawn } from "bun";\nspawn(["bun", "server.ts"], { env: scrubEnv(dir) });`;
    expect(verdict(fromBun), "spawn exported by bun").toBe("accepted");
  });

  test("a computed or accessor env key is refused", () => {
    const computed = `${HELPER_IMPORT}Bun.spawn(["bun", "server.ts"], { env: scrubEnv(dir), ["env"]: process.env });`;
    expect(verdict(computed)).toBe("refused");
    const getter = `${HELPER_IMPORT}Bun.spawn(["bun", "server.ts"], { env: scrubEnv(dir), get cwd() { return dir; } });`;
    expect(verdict(getter)).toBe("refused");
  });

  test("a type-only mention of a launch binding is not a launch", () => {
    const typed = `import { spawn } from "node:child_process";\nlet p: ReturnType<typeof spawn> | ReturnType<typeof Bun.spawn>;`;
    expect(verdict(typed)).toBe("not seen");
  });

  test("scrubEnv named only in a comment or in argv does not count", () => {
    const comment = `${HELPER_IMPORT}// env: scrubEnv(dir)\nBun.spawn(["bun", "server.ts"], { env: process.env });`;
    expect(verdict(comment)).toBe("refused");
    const argv = `${HELPER_IMPORT}Bun.spawn(["bun", "server.ts", JSON.stringify({ env: scrubEnv(dir) })], { env: process.env });`;
    expect(verdict(argv)).toBe("refused");
  });

  test("RegExp.exec and other unrelated exec methods are not launches", () => {
    expect(verdict(`const m = /x/.exec("server.ts"); db.exec("SELECT 1");`)).toBe("not seen");
  });
});

describe("domain", () => {
  test("a server entry is named at a path boundary, never inside another name", () => {
    for (const named of ["server.ts", "../server.ts", "C:\\repo\\server-deck.mjs", "--outfile=server-deck.js", "bun server.ts"]) {
      expect(SERVER_ARTIFACT.test(named), named).toBeTrue();
    }
    for (const other of ["avatar-server.ts", "myserver.ts", "server.tsx"]) {
      expect(SERVER_ARTIFACT.test(other), other).toBeFalse();
    }
  });

  test("a file naming only avatar-server.ts is outside the domain", () => {
    const source = `const f = "avatar-server.ts";\nBun.spawn(["bun", f], { env: process.env });`;
    expect(auditDomain([{ file: "avatar.test.ts", source }]).filter((f) => f.file === "avatar.test.ts")).toEqual([]);
  });

  test("an untabled file launching a server fails, and so does a miscount", () => {
    const launch = `${HELPER_IMPORT}Bun.spawn(["bun", "server.ts"], { env: scrubEnv(dir) });`;
    expect(auditDomain([{ file: "new-server.test.ts", source: launch }]).filter((f) => f.file === "new-server.test.ts")).toEqual([
      { file: "new-server.test.ts", problem: "1 launches, the table expects 0" }
    ]);
    const tabled = Object.keys(EXPECTED_LAUNCHES)[0]!;
    const twice = `${launch}\nBun.spawn(["bun", "server.ts"], { env: scrubEnv(dir) });\n`.repeat(EXPECTED_LAUNCHES[tabled]! + 1);
    expect(auditDomain([{ file: tabled, source: twice }]).filter((f) => f.file === tabled).map((f) => f.problem)).toEqual([
      `${2 * (EXPECTED_LAUNCHES[tabled]! + 1)} launches, the table expects ${EXPECTED_LAUNCHES[tabled]}`
    ]);
  });

  test("a tabled file that disappears, or stops naming a server, fails", () => {
    const findings = auditDomain([]);
    expect(findings.map((f) => f.file).sort()).toEqual(Object.keys(EXPECTED_LAUNCHES).sort());
  });
});
