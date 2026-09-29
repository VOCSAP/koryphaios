import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { redactSecrets } from "../desktop/src/main/log-redact";
import { Journal } from "../desktop/src/main/journal";
import { createPersistentJournal, createRollingLogger } from "../desktop/src/main/log";

const tails = ["Q7vX2mR9kL4pW8nZ3cT6", "H5jN1bF8sD3gY6uE0aK9", "P2wM7qT4xV9cB1nL6rZ8", "U3eG8hJ5yA0dS7fW2kC4", "R6tY1uI9oP4aS2dF7gH3"];
const anthropicKey = ["sk", "ant", "api03", tails[0]].join("-");
const githubPat = ["ghp", `${tails[1]}${tails[2]}`].join("_");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cp-logredact-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function expectNoTail(text: string): void {
  for (const tail of tails) expect(text, `value ${tail} left in clear`).not.toContain(tail);
}

test("redacts every known shape and keeps the rest of the line", () => {
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", tails[3]].join(".");
  const cases: Array<[string, string]> = [
    [`launch: ${anthropicKey} claude`, "launch: [redacted] claude"],
    [`push with ${githubPat} ok`, "push with [redacted] ok"],
    [`push with ${["glpat", tails[4]].join("-")} ok`, "push with [redacted] ok"],
    [`charge ${["sk", "live", tails[0]].join("_")} and ${["sk", "test", tails[1]].join("_")}`, "charge [redacted] and [redacted]"],
    [`maps ${["AIza", tails[2], `${tails[3]}`.slice(0, 15)].join("")} ok`, "maps [redacted] ok"],
    [`session ${jwt} expired`, "session [redacted] expired"],
    [`sent Bearer ${tails[1]}`, "sent Bearer [redacted]"],
    [`env ANTHROPIC_API_KEY=${tails[2]} claude`, "env ANTHROPIC_API_KEY=[redacted] claude"],
    [`https://example.test/cb?access_token=${tails[3]}&state=ok`, "https://example.test/cb?access_token=[redacted]&state=ok"],
    [`https://example.test/cb?key=${tails[3]}&state=ok`, "https://example.test/cb?key=[redacted]&state=ok"],
    [`https://example.test/cb?access_token%3D${tails[3]}`, "https://example.test/cb?access_token%3D[redacted]"],
    [`claude --api-key ${tails[4]} --verbose`, "claude --api-key [redacted] --verbose"],
    [`clone https://bob:${tails[0]}@host.test/repo.git`, "clone https://[redacted]@host.test/repo.git"],
    [`clone https://bob:p@ss${tails[0]}@host.test/repo.git`, "clone https://[redacted]@host.test/repo.git"],
    [`body {\\"apiKey\\":\\"${tails[1]}\\"}`, `body {\\"apiKey\\":\\"[redacted]\\"}`],
    [`config {"apiKey":"${tails[1]}"}`, `config {"apiKey":"[redacted]"}`],
    [`api_key: "correct horse ${tails[2]} staple"`, `api_key: "[redacted]"`],
    [`Cookie: session=${tails[3]}`, "Cookie: [redacted]"],
  ];
  for (const [input, expected] of cases) expect(redactSecrets(input)).toBe(expected);
});

test("redacts values whose name carries a long keyword anywhere", () => {
  const names = [["PG", "PASS", "WORD"].join(""), "accesstoken", "GitHubAPIToken", "zzzzapi_key"];
  for (const name of names) {
    expect(redactSecrets(`env ${name}=${tails[0]} next`)).toBe(`env ${name}=[redacted] next`);
  }
});

test("redacts a value longer than the scan cap to its end, idempotently", () => {
  const long = "Z".repeat(700);
  for (const input of [`token=${long}`, `"token":"${long}"`]) {
    const once = redactSecrets(input);
    expect(once, `${input.slice(0, 10)} left Z in clear`).not.toContain("Z");
    expect(redactSecrets(once)).toBe(once);
  }
});

test("redacts an Authorization value that carries no scheme", () => {
  expect(redactSecrets(`Authorization: ${tails[0]}`)).toBe("Authorization: [redacted]");
  expect(redactSecrets(redactSecrets(`Authorization: ${tails[0]}`))).toBe("Authorization: [redacted]");
});

test("truncates a 1 MiB line before redacting it, in the journal and in the rolling log", () => {
  const huge = `Bearer ${tails[1]} ${"token-".repeat((1 << 20) / 6)}`;

  const journalStart = performance.now();
  const entry = new Journal(10, () => 0).add("announce", huge);
  const journalMs = performance.now() - journalStart;
  expect(entry.text.length).toBeLessThanOrEqual(8192);
  expectNoTail(entry.text);
  expect(journalMs, `journal took ${journalMs.toFixed(1)} ms`).toBeLessThan(100);

  const log = createRollingLogger({ dir, name: "huge", mirrorToConsole: false });
  const logStart = performance.now();
  log.warn(huge);
  const logMs = performance.now() - logStart;
  const written = readFileSync(log.file, "utf-8");
  expect(written.length).toBeLessThanOrEqual(8192 + 1);
  expectNoTail(written);
  expect(logMs, `rolling log took ${logMs.toFixed(1)} ms`).toBeLessThan(100);
});

test("keeps the Authorization scheme and redacts only the credential", () => {
  const basic = Buffer.from(`bob:${tails[0]}`).toString("base64");
  const cases: Array<[string, string]> = [
    [`Authorization: Bearer ${tails[1]}`, "Authorization: Bearer [redacted]"],
    [`Authorization: Basic ${basic}`, "Authorization: Basic [redacted]"],
    [`Proxy-Authorization: Negotiate ${tails[2]}`, "Proxy-Authorization: Negotiate [redacted]"],
    [`authorization: Token ${tails[3]}`, "authorization: Token [redacted]"],
    [`Authorization: Digest ${tails[4]}`, "Authorization: Digest [redacted]"],
  ];
  for (const [input, expected] of cases) expect(redactSecrets(input)).toBe(expected);
});

test("redacts every occurrence of two different shapes on one line", () => {
  const redacted = redactSecrets(`announce ${anthropicKey} then Bearer ${tails[1]} then ${anthropicKey}`);
  expectNoTail(redacted);
  expect(redacted).toBe("announce [redacted] then Bearer [redacted] then [redacted]");
});

test("leaves prose, commit SHAs, uuids and look-alike names intact", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const uuid = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  const lines = [
    "[scope] could not remember scope secret",
    `dispatch card on ${sha} in worktree ${uuid}`,
    "",
    ".credentials.json: EPERM, operation not permitted",
    "usage input_tokens: 1234567890 output_tokens: 1234567890",
    "request max_tokens=409600000",
    "status authenticated: false",
    "commit author: Olivier Vehier",
    "git log --author Olivier",
    "OAuth: callback failed",
    "sort key=abcdefghijkl",
    "token: short",
  ];
  for (const line of lines) expect(redactSecrets(line)).toBe(line);
});

test("is idempotent", () => {
  const once = redactSecrets(`Authorization: Bearer ${tails[1]} ANTHROPIC_API_KEY=${tails[2]} ${anthropicKey} api_key: "a b ${tails[3]}"`);
  expect(redactSecrets(once)).toBe(once);
});

function pathologicalLines(size: number): string[] {
  return [
    "token-".repeat(size / 6),
    "auth.".repeat(size / 5),
    "a".repeat(size),
    `x://${"u:".repeat(size / 2)}`,
    "eyJ-".repeat(size / 4),
    "--token ".repeat(size / 8),
    "Bearer ".repeat(size / 7),
    `${"a:".repeat(size / 4)}${"b@".repeat(size / 4)}`,
  ];
}

test("runs in linear time on pathological lines", () => {
  // The 2 KiB pass fails a super-linear regex in well under a second; going
  // straight to 64 KiB would hang the run instead, since bun cannot interrupt
  // a synchronous regex.
  for (const [size, budgetMs] of [[2 * 1024, 50], [64 * 1024, 500]] as const) {
    for (const line of pathologicalLines(size)) {
      const start = performance.now();
      redactSecrets(line);
      const elapsed = performance.now() - start;
      expect(elapsed, `${size} B ${line.slice(0, 12)}... took ${elapsed.toFixed(1)} ms`).toBeLessThan(budgetMs);
    }
  }
});

test("journal list and export text never carry a value added in clear", () => {
  const journal = new Journal(10, () => 0);
  journal.add("session", `project launchCommand approved: ANTHROPIC_API_KEY=${tails[2]} claude --api-key ${tails[4]}`);
  journal.add("announce", `announce to lead: Bearer ${tails[1]} and ${anthropicKey}`);

  expectNoTail(JSON.stringify(journal.list()));
  expectNoTail(journal.toText());
  expect(journal.toText()).toContain("project launchCommand approved: ANTHROPIC_API_KEY=[redacted] claude");
});

test("persistent journal file on disk never carries a value added in clear", () => {
  const journal = createPersistentJournal({ dir, entryNow: () => 0 });
  journal.add("error", `[graph] inference failed: Bearer ${tails[1]} ${anthropicKey}`);

  const file = readdirSync(dir).find((entry) => entry.startsWith("journal-"));
  expect(file).toBeDefined();
  const text = readFileSync(join(dir, file!), "utf-8");
  expectNoTail(text);
  expect(text).toContain("[error] [graph] inference failed: Bearer [redacted] [redacted]");
});

test("console fallback before the Deck log exists never carries a value in clear", async () => {
  const specifier = "../desktop/src/main/log.ts?console-fallback";
  const fresh = await import(specifier);
  const printed: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    printed.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    fresh.logWarn("graph", `retry with Bearer ${tails[1]}`, { apiKey: tails[2] });
    fresh.reportError("graph", "inference failed", new Error(`provider rejected ${anthropicKey}`));
  } finally {
    console.error = original;
  }
  expect(printed.length).toBe(2);
  expectNoTail(printed.join("\n"));
});
