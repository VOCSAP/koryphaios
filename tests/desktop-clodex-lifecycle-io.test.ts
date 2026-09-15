import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

const REPO = join(import.meta.dir, "..");
const ELECTRON = join(
  REPO,
  "desktop",
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron"
);
const SOURCE = join(REPO, "desktop", "src", "main", "clodex-lifecycle-io.ts");
const PROBE = join(import.meta.dir, "clodex-lifecycle-io-probe.cjs");
const TSC = join(REPO, "desktop", "node_modules", "typescript", "bin", "tsc");
const TYPE_ROOTS = join(REPO, "desktop", "node_modules", "@types");

async function buildAdapter(): Promise<{ dir: string; file: string }> {
  const dir = mkdtempSync(join(tmpdir(), "clodex-lifecycle-io-"));
  const result = await Bun.build({
    entrypoints: [SOURCE],
    outdir: dir,
    target: "node",
    format: "cjs",
    external: ["node:sqlite"],
  });

  expect(result.success).toBe(true);
  return { dir, file: join(dir, "clodex-lifecycle-io.js") };
}

function runProbe(bundle: string, args: string[]) {
  const result = spawnSync(ELECTRON, [PROBE, bundle, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf-8",
    timeout: 10_000,
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}

function runProbeAsync(bundle: string, args: string[]) {
  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(ELECTRON, [PROBE, bundle, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`SQLite probe exited ${code}: ${stderr}`));
      else resolve(JSON.parse(stdout));
    });
  });
}

function typecheckFactory() {
  const dir = mkdtempSync(join(tmpdir(), "clodex-lifecycle-io-typecheck-"));
  const source = relative(dir, SOURCE).replaceAll("\\", "/");
  const importPath = source.startsWith(".") ? source : `./${source}`;
  writeFileSync(join(dir, "probe.ts"), [
    'import { DatabaseSync } from "node:sqlite";',
    `import { createSqliteRecordStore } from "${importPath}";`,
    'createSqliteRecordStore(new DatabaseSync(":memory:"));',
  ].join("\n"));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      types: ["node"],
      typeRoots: [TYPE_ROOTS],
    },
    files: ["probe.ts"],
  }));
  const result = spawnSync(process.execPath, [TSC, "-p", "tsconfig.json"], { cwd: dir, encoding: "utf-8" });
  rmSync(dir, { recursive: true, force: true });
  return result;
}

test("SQLite records serialize values canonically and reject invalid stored JSON", async () => {
  expect(existsSync(ELECTRON)).toBe(true);
  const { dir, file } = await buildAdapter();
  const database = join(dir, "records.sqlite");
  try {
    expect(runProbe(file, ["round-trip", database])).toEqual({
      serialized: '{"a":1,"b":2}',
      read: { a: 1, b: 2 },
      listed: [{ id: 1 }, { id: 2 }],
      removed: null,
      invalidReadRejected: true,
      nonCanonicalReadRejected: true,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite records apply busyTimeoutMs to the real DatabaseSync", async () => {
  expect(existsSync(ELECTRON)).toBe(true);
  const { dir, file } = await buildAdapter();
  const database = join(dir, "records.sqlite");
  try {
    expect(runProbe(file, ["busy-timeout", database])).toEqual({ busyTimeoutMs: 73 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite records reject sparse arrays before writing", async () => {
  expect(existsSync(ELECTRON)).toBe(true);
  const { dir, file } = await buildAdapter();
  const database = join(dir, "records.sqlite");
  try {
    expect(runProbe(file, ["sparse-arrays", database])).toEqual({
      emptySlotRejected: true,
      leadingSlotRejected: true,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DatabaseSync satisfies the injected SQLite connection contract", () => {
  const result = typecheckFactory();
  expect({ status: result.status, output: `${result.stdout}${result.stderr}` }).toEqual({ status: 0, output: "" });
});

test("two Electron processes share exactly one successful createExclusive", async () => {
  expect(existsSync(ELECTRON)).toBe(true);
  const { dir, file } = await buildAdapter();
  const database = join(dir, "records.sqlite");
  try {
    runProbe(file, ["prepare", database]);
    const results = await Promise.all([
      runProbeAsync(file, ["create", database, "lease", '{"pid":1}']),
      runProbeAsync(file, ["create", database, "lease", '{"pid":2}']),
    ]);
    expect(results.map((result) => (result as { created: number }).created).sort()).toEqual([0, 1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("conditional deletion preserves a replacement and timed contention preserves the value", async () => {
  expect(existsSync(ELECTRON)).toBe(true);
  const { dir, file } = await buildAdapter();
  const database = join(dir, "records.sqlite");
  try {
    expect(runProbe(file, ["replacement", database])).toEqual({
      removed: false,
      remaining: { generation: "replacement" },
    });
    expect(runProbe(file, ["contention", database])).toEqual({
      rejected: true,
      remaining: { generation: "original" },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
