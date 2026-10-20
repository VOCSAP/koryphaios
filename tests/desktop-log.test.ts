import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  utimesSync,
  existsSync,
} from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
  createJournalWriter,
  createPersistentJournal,
  createRollingLogger,
  initDeckLog,
  logWarn,
  reportError,
} from "../desktop/src/main/log";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cp-decklog-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const fixedNow = () => new Date("2026-07-19T10:00:00.000Z");

test("rolling logger writes leveled lines and rotates at maxBytes", () => {
  const log = createRollingLogger({
    dir,
    name: "main",
    maxBytes: 150,
    maxFiles: 2,
    mirrorToConsole: false,
    now: fixedNow,
  });
  log.error("[scope] boom", new Error("cause"));
  for (let i = 0; i < 20; i++) log.info(`entry-${i}`);

  const files = readdirSync(dir).sort();
  expect(files).toEqual(["main.log", "main.log.1"]);
  expect(readFileSync(join(dir, "main.log"), "utf-8")).toContain("entry-19");
});

test("journal writers persist entries immediately in distinct run files", () => {
  const first = createJournalWriter({ dir, now: fixedNow });
  const second = createJournalWriter({ dir, now: fixedNow });

  first.write({ id: 1, at: fixedNow().getTime(), kind: "quota", text: "session limited" });
  first.write({ id: 2, at: fixedNow().getTime(), kind: "session", text: "session resumed" });
  second.write({ id: 1, at: fixedNow().getTime(), kind: "session", text: "session spawned" });

  const firstText = readFileSync(first.file, "utf-8");
  expect(first.file).not.toBe(second.file);
  expect(firstText).toContain("[quota] session limited");
  expect(firstText.indexOf("[quota] session limited")).toBeLessThan(firstText.indexOf("[session] session resumed"));
  expect(readFileSync(second.file, "utf-8")).toContain("[session] session spawned");
});

test("persistent journal writes each added entry to disk", () => {
  const journal = createPersistentJournal({
    dir,
    now: fixedNow,
    entryNow: () => fixedNow().getTime(),
  });

  journal.add("quota", "session limited");

  const file = readdirSync(dir).find((entry) => entry.startsWith("journal-"));
  expect(file).toBeDefined();
  expect(readFileSync(join(dir, file!), "utf-8")).toContain("[quota] session limited");
});

test("persistent journal writes agent text as one physical line", () => {
  const journal = createPersistentJournal({
    dir,
    now: fixedNow,
    entryNow: () => fixedNow().getTime(),
  });
  const unsafe = `title${String.fromCharCode(13, 10)}forged${String.fromCodePoint(0x2028)}line`

  journal.add("dispatch", unsafe);

  const file = readdirSync(dir).find((entry) => entry.startsWith("journal-"));
  const text = readFileSync(join(dir, file!), "utf-8");
  expect(text.split("\n").filter(Boolean)).toHaveLength(1);
  expect(text).toContain("[dispatch] title / forged / line");
});

test("journal writer rotates its run file and prunes expired runs", () => {
  const stale = join(dir, "journal-old.log");
  writeFileSync(stale, "old run\n");
  const tenDaysAgo = (fixedNow().getTime() - 10 * 24 * 3600 * 1000) / 1000;
  utimesSync(stale, tenDaysAgo, tenDaysAgo);
  const writer = createJournalWriter({
    dir,
    maxBytes: 150,
    maxFiles: 2,
    now: fixedNow,
  });

  for (let i = 0; i < 20; i++) {
    writer.write({ id: i + 1, at: fixedNow().getTime(), kind: "session", text: `entry-${i}` });
  }

  const name = basename(writer.file);
  expect(readdirSync(dir).filter((entry) => entry === name || entry.startsWith(`${name}.`)).sort()).toEqual([
    name,
    `${name}.1`,
  ].sort());
  expect(existsSync(stale)).toBe(false);

  rmSync(writer.file);
  rmSync(`${writer.file}.1`);
  writer.write({ id: 21, at: fixedNow().getTime(), kind: "session", text: "recreated" });
  expect(readFileSync(writer.file, "utf-8")).toContain("[session] recreated");
  for (let i = 0; i < 20; i++) {
    writer.write({ id: i + 22, at: fixedNow().getTime(), kind: "session", text: `recovered-${i}` });
  }
  expect(existsSync(`${writer.file}.1`)).toBe(true);
});

test("journal writer reports an unavailable target once through main.log", () => {
  const journalDir = join(dir, "journal-logs");
  const main = initDeckLog(dir);
  const writer = createJournalWriter({
    dir: journalDir,
    now: fixedNow,
    onWriteFailure: (file, error) => logWarn("journal", `cannot persist ${file}`, error),
  });
  rmSync(journalDir, { recursive: true, force: true });
  writeFileSync(journalDir, "occupied");

  writer.write({ id: 1, at: fixedNow().getTime(), kind: "error", text: "first" });
  writer.write({ id: 2, at: fixedNow().getTime(), kind: "error", text: "second" });

  const warnings = readFileSync(main.file, "utf-8").match(/cannot persist/g) ?? [];
  expect(warnings).toHaveLength(1);
});

test("journal writer reports prune and write failures independently through main.log", () => {
  const journalDir = join(dir, "occupied");
  const main = initDeckLog(dir);
  writeFileSync(journalDir, "occupied");
  const writer = createJournalWriter({
    dir: journalDir,
    now: fixedNow,
    onWriteFailure: (file, error) => logWarn("journal", `cannot persist ${file}`, error),
  });

  writer.write({ id: 1, at: fixedNow().getTime(), kind: "error", text: "first" });
  writer.write({ id: 2, at: fixedNow().getTime(), kind: "error", text: "second" });

  const warnings = readFileSync(main.file, "utf-8").match(/cannot persist/g) ?? [];
  expect(warnings).toHaveLength(2);
});

test("a reported message starts a single main.log entry and carries no raw control character", () => {
  const esc = String.fromCharCode(27);
  const c1 = String.fromCharCode(0x9b);
  const cr = String.fromCharCode(13);
  const main = initDeckLog(dir);

  reportError("renderer:x", `boom\n2026-10-20T00:00:00.000Z ERROR [x] forged${esc}[31m${c1}${cr}end`);

  const text = readFileSync(main.file, "utf-8");
  expect(text.match(/^\d{4}-\d\d-\d\dT/gm)).toHaveLength(1);
  expect(text).toContain("[renderer:x] boom\n\t2026-10-20T00:00:00.000Z ERROR [x] forged\\x1b[31m\\x9b\n\tend\n");
  for (const byte of [esc, c1, cr]) expect(text).not.toContain(byte);
});

test("a secret split by a line break or a control character is redacted in main.log", () => {
  const esc = String.fromCharCode(27);
  const soh = String.fromCharCode(1);
  const cr = String.fromCharCode(13);
  const passwordName = ["pass", "word"].join("");
  const main = initDeckLog(dir);

  reportError("renderer:x", `${passwordName}=hunter\n2secretTail`);
  reportError("renderer:x", `Bearer abcdefgh${esc}ijklmnopqrstuvwx`);
  reportError("renderer:x", `sk-abcdefghij${soh}klmnopqrstuvwx`);
  reportError("renderer:x", `ghp_${"A".repeat(10)}${cr}${"B".repeat(20)}`);

  const text = readFileSync(main.file, "utf-8");
  for (const piece of ["hunter", "secretTail", "ijklmnop", "abcdefghij", "klmnop", "AAAAAAAAAA", "BBBBBBBBBB"]) {
    expect(text, `piece ${piece} of a split secret left in clear in main.log`).not.toContain(piece);
  }
});

test("a line cut at the logged cap never ends inside an escape", () => {
  const esc = String.fromCharCode(27);
  const log = createRollingLogger({ dir, name: "main", mirrorToConsole: false, now: fixedNow });
  log.info(esc.repeat(9000));
  const line = readFileSync(log.file, "utf-8").trimEnd();
  expect(line.length).toBeLessThanOrEqual(8192);
  expect(line).toEndWith("\\x1b");
  expect(line).not.toContain(esc);
});

test("the rolling logger keeps a tab and turns a line break into an indented continuation", () => {
  const log = createRollingLogger({ dir, name: "serve", mirrorToConsole: false, now: fixedNow });
  log.info("a\nb\tc");
  expect(readFileSync(log.file, "utf-8")).toBe("2026-07-19T10:00:00.000Z INFO  a\n\tb\tc\n");
});

test("main.log never carries a value from a reported error message, stack or context", () => {
  const tails = ["Q7vX2mR9kL4pW8nZ3cT6", "H5jN1bF8sD3gY6uE0aK9"];
  const anthropicKey = ["sk", "ant", "api03", tails[0]].join("-");
  const main = initDeckLog(dir);

  reportError("graph", `inference with Bearer ${tails[1]} failed`, new Error(`provider rejected ${anthropicKey}`));
  logWarn("graph", "provider config", { apiKey: tails[1] });

  const text = readFileSync(main.file, "utf-8");
  expect(text).toContain("provider rejected [redacted]");
  expect(text).toMatch(/\n\s+at /);
  for (const tail of tails) expect(text, `value ${tail} left in clear in main.log`).not.toContain(tail);
});
