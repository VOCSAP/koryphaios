import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { deriveOperatorId, generateCredential } from "../shared/approval.ts";
import { OPERATOR_TRUST_VERSION, publicKeyFingerprint } from "../shared/operator-trust.ts";
import { scrubEnv } from "./_scrub-env.ts";

const CLI_PATH = resolve(import.meta.dir, "..", "cli.ts");
const dirs: string[] = [];

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "cp-cli-operator-trust-"));
  dirs.push(dir);
  return dir;
}

function trustPath(settingsDir: string): string {
  return join(settingsDir, "claude-peers", "operator-trust.json");
}

async function runCli(args: string[], settingsDir: string): Promise<Run> {
  const proc = Bun.spawn(["bun", CLI_PATH, "operator-trust", ...args], {
    env: scrubEnv(settingsDir),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function writePolicy(settingsDir: string, publicKey: string, label = "personal Deck"): void {
  const path = trustPath(settingsDir);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({
    version: OPERATOR_TRUST_VERSION,
    operators: [{ public_key: publicKey, label }],
  }));
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("bun cli.ts operator-trust", () => {
  test("exports only the local Deck public identity", async () => {
    const settingsDir = scratch();
    const identityPath = join(settingsDir, "operator.json");
    const credential = generateCredential();
    const privateSentinel = "private-material-must-not-appear";
    writeFileSync(identityPath, JSON.stringify({
      publicKey: credential.publicKey,
      privateKeyEnc: privateSentinel,
    }));

    const run = await runCli(["export", "--identity", identityPath], settingsDir);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`operator_id: ${deriveOperatorId(credential.publicKey)}`);
    expect(run.stdout).toContain(`public_key: ${credential.publicKey}`);
    expect(run.stdout).toContain(`fingerprint_sha256: ${publicKeyFingerprint(credential.publicKey)}`);
    expect(run.stdout + run.stderr).not.toContain(privateSentinel);
  });

  test("refuses an identity file without a usable public key", async () => {
    const settingsDir = scratch();
    const identityPath = join(settingsDir, "operator.json");
    writeFileSync(identityPath, JSON.stringify({ privateKeyEnc: "private-material" }));

    const run = await runCli(["export", "--identity", identityPath], settingsDir);

    expect(run.code).toBe(2);
    expect(run.stdout + run.stderr).not.toContain("private-material");
  });

  test("refuses to initialize with malformed public key material", async () => {
    const settingsDir = scratch();

    const run = await runCli(["init", "--public-key", "not-a-key"], settingsDir);

    expect(run.code).toBe(2);
    expect(() => readFileSync(trustPath(settingsDir), "utf8")).toThrow();
  });

  test("initializes the fixed policy exactly once under concurrent calls", async () => {
    const settingsDir = scratch();
    const credential = generateCredential();
    const [first, second] = await Promise.all([
      runCli(["init", "--public-key", credential.publicKey], settingsDir),
      runCli(["init", "--public-key", credential.publicKey], settingsDir),
    ]);

    expect([first.code, second.code].sort()).toEqual([0, 3]);
    const policy = JSON.parse(readFileSync(trustPath(settingsDir), "utf8")) as { operators: { public_key: string }[] };
    expect(policy.operators).toEqual([{ public_key: credential.publicKey }]);
  });

  test("a second init that reads between the creator's open and its write waits for the document, then refuses as already present", async () => {
    const settingsDir = scratch();
    const credential = generateCredential();
    mkdirSync(dirname(trustPath(settingsDir)), { recursive: true });
    writeFileSync(trustPath(settingsDir), "");
    const document = `${JSON.stringify({ version: OPERATOR_TRUST_VERSION, operators: [{ public_key: credential.publicKey }] }, null, 2)}\n`;
    const [run] = await Promise.all([
      runCli(["init", "--public-key", credential.publicKey], settingsDir),
      Bun.sleep(150).then(() => writeFileSync(trustPath(settingsDir), document)),
    ]);

    expect(run.code, run.stderr).toBe(3);
    expect(run.stderr).toContain("requested key is already present");
  });

  test("refuses invalid prepared policies for validation and fingerprint display", async () => {
    const settingsDir = scratch();
    mkdirSync(resolve(trustPath(settingsDir), ".."), { recursive: true });
    writeFileSync(trustPath(settingsDir), "{ invalid");

    const validated = await runCli(["validate"], settingsDir);
    const fingerprints = await runCli(["fingerprints"], settingsDir);

    expect(validated.code).toBe(2);
    expect(fingerprints.code).toBe(2);
  });

  test("validates a prepared policy without selecting an alternative active policy", async () => {
    const settingsDir = scratch();
    const credential = generateCredential();
    const preparedPath = join(settingsDir, "prepared-operator-trust.json");
    writeFileSync(preparedPath, JSON.stringify({
      version: OPERATOR_TRUST_VERSION,
      operators: [{ public_key: credential.publicKey }],
    }));

    const validated = await runCli(["validate", "--input", preparedPath], settingsDir);

    expect(validated.code).toBe(0);
    expect(validated.stdout).toContain("operator-trust: valid");
    expect(() => readFileSync(trustPath(settingsDir), "utf8")).toThrow();
  });

  test("displays fingerprints from the active policy", async () => {
    const settingsDir = scratch();
    const credential = generateCredential();
    writePolicy(settingsDir, credential.publicKey);

    const fingerprints = await runCli(["fingerprints"], settingsDir);

    expect(fingerprints.code).toBe(0);
    expect(fingerprints.stdout).toContain(deriveOperatorId(credential.publicKey));
    expect(fingerprints.stdout).toContain(publicKeyFingerprint(credential.publicKey));
  });
});
