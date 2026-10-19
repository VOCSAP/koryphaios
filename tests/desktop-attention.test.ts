// PLAN-v0.4 C11: "needs you" detection (desktop/src/main/attention).
// Fixtures mirror Claude Code's waiting screens (numbered chooser, trust
// prompt); prose/code containing question-like text must NOT trigger.

import { beforeAll, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AttentionDetector,
  ATTENTION_CONFIRMATION_DELAY_MS,
  detectWaiting,
  screenShowsWait,
  stripAnsi,
  type AttentionEvent
} from "../desktop/src/main/attention.ts";
import { createScreenWitness } from "../desktop/src/main/attention-screen-witness.ts";
import { EXPECTED_FIXTURE_VERDICTS, RESIZE_MARKER } from "./_fixture-verdicts.ts";
import {
  createXtermScreen,
  inspectInjectGuard,
  type XtermScreenRead,
  type XtermScreenUnavailableReason
} from "../desktop/src/main/xterm-screen.ts";

const PERMISSION_SCREEN = `
Bash command: rm -rf node_modules
Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again
  3. No (esc)
`;

const TRUST_SCREEN = `Do you trust the files in this folder?`;

function collect(d: AttentionDetector): AttentionEvent[] {
  const events: AttentionEvent[] = [];
  d.on("attention", (e: AttentionEvent) => events.push(e));
  return events;
}

interface PlannedTimer {
  callback: () => void;
  dueAt: number;
  delayMs: number;
  cleared: boolean;
  fired: boolean;
}

function confirmationClock() {
  const planned: PlannedTimer[] = [];
  let now = 0;
  const advanceTo = (target: number): void => {
    if (target < now) throw new Error(`clock moved backward from ${now} to ${target}`);
    while (true) {
      const due = planned
        .filter((timer) => !timer.cleared && !timer.fired && timer.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt)[0];
      if (!due) break;
      now = due.dueAt;
      due.fired = true;
      due.callback();
    }
    now = target;
  };
  return {
    planned,
    get now(): number {
      return now;
    },
    advanceTo,
    advanceBy(delayMs: number): void {
      advanceTo(now + delayMs);
    },
    options: {
      setTimeout(callback: () => void, delayMs: number): PlannedTimer {
        const timer = { callback, dueAt: now + delayMs, delayMs, cleared: false, fired: false };
        planned.push(timer);
        return timer;
      },
      clearTimeout(timer: unknown): void {
        (timer as PlannedTimer).cleared = true;
      }
    }
  };
}

function detector(): AttentionDetector {
  return new AttentionDetector({
    setTimeout(callback: () => void): undefined {
      callback();
      return undefined;
    },
    clearTimeout(): void {}
  });
}

test("a waiting screen raises only after the confirmation delay", () => {
  const clock = confirmationClock();
  const d = new AttentionDetector(clock.options);
  const events = collect(d);

  d.feed("s1", PERMISSION_SCREEN);

  expect(events).toEqual([]);
  expect(clock.planned).toHaveLength(1);
  expect(clock.planned[0]!.delayMs).toBe(ATTENTION_CONFIRMATION_DELAY_MS);
  clock.advanceBy(ATTENTION_CONFIRMATION_DELAY_MS - 1);
  expect(events).toEqual([]);
  clock.advanceBy(1);
  expect(events).toEqual([{ id: "s1", waiting: true }]);
});

test("a repainting waiting screen confirms from its first detection", () => {
  const clock = confirmationClock();
  const d = new AttentionDetector(clock.options);
  const events: Array<{ t: number; waiting: boolean }> = [];
  d.on("attention", (event: AttentionEvent) => events.push({ t: clock.now, waiting: event.waiting }));

  d.feed("s1", PERMISSION_SCREEN);
  const repaintIntervalMs = 400;
  const lastRepaintAt = ATTENTION_CONFIRMATION_DELAY_MS * 4;
  for (let t = repaintIntervalMs; t <= lastRepaintAt; t += repaintIntervalMs) {
    clock.advanceTo(t);
    d.feed("s1", PERMISSION_SCREEN);
  }
  clock.advanceTo(lastRepaintAt + ATTENTION_CONFIRMATION_DELAY_MS);

  expect(events).toEqual([{ t: ATTENTION_CONFIRMATION_DELAY_MS, waiting: true }]);
});

test("a busy cue or waiting-screen fallback cancels a pending confirmation", () => {
  for (const [label, data] of [
    ["busy cue", "⠹ running… esc to interrupt"],
    ["composer fallback", "────────────────\n❯ \n────────────────\n? for shortcuts"],
  ] as const) {
    const clock = confirmationClock();
    const d = new AttentionDetector(clock.options);
    const events = collect(d);

    d.feed("s1", PERMISSION_SCREEN);
    d.feed("s1", data);

    expect(clock.planned[0]!.cleared, label).toBe(true);
    clock.planned[0]!.callback();
    expect(events, label).toEqual([]);
  }
});

test("clearing, purging, or stopping cancels a pending confirmation", () => {
  for (const [label, action] of [
    ["clear", (d: AttentionDetector) => d.clear("s1")],
    ["purge", (d: AttentionDetector) => d.purgeScreenMemory("s1")],
    ["stop", (d: AttentionDetector) => d.stop()],
  ] as const) {
    const clock = confirmationClock();
    const d = new AttentionDetector(clock.options);
    const events = collect(d);

    d.feed("s1", PERMISSION_SCREEN);
    action(d);

    expect(clock.planned[0]!.cleared, label).toBe(true);
    clock.planned[0]!.callback();
    expect(events, label).toEqual([]);
  }
});

test("detectWaiting matches the numbered chooser and the trust prompt only", () => {
  expect(detectWaiting(PERMISSION_SCREEN)).toBe(true);
  expect(detectWaiting(TRUST_SCREEN)).toBe(true);
  // Question-like prose without a chooser must not match (streamed content).
  expect(detectWaiting("Do you want to refactor this later? I suggest…")).toBe(false);
  expect(detectWaiting("const menu = ['1.', '2.']")).toBe(false);
});

test("one episode per wait screen; busy output closes it and re-arms", () => {
  const d = detector();
  const events = collect(d);

  d.feed("s1", PERMISSION_SCREEN);
  d.feed("s1", PERMISSION_SCREEN); // redraw while waiting -> no second episode
  expect(events).toEqual([{ id: "s1", waiting: true }]);

  d.feed("s1", "⠹ running… esc to interrupt");
  expect(events).toEqual([
    { id: "s1", waiting: true },
    { id: "s1", waiting: false }
  ]);

  // A later prompt opens a NEW episode.
  d.feed("s1", TRUST_SCREEN);
  expect(events.length).toBe(3);
  expect(events[2]).toEqual({ id: "s1", waiting: true });
  d.stop();
});

test("a wait screen split across chunks is caught by the rolling buffer", () => {
  const d = detector();
  const events = collect(d);
  d.feed("s1", "Do you want to proceed?\n❯ ");
  expect(events.length).toBe(0);
  d.feed("s1", "1. Yes\n  2. No");
  expect(events).toEqual([{ id: "s1", waiting: true }]);
  d.stop();
});

test("busy output in the same chunk resets stale context but keeps what follows", () => {
  const d = detector();
  const events = collect(d);
  d.feed("s1", "streaming some prose with ❯ nothing conclusive");
  d.feed("s1", "⠹ esc to interrupt … done.\nDo you want to proceed?\n❯ 1. Yes");
  expect(events).toEqual([{ id: "s1", waiting: true }]);
  d.stop();
});

test("clear() drops the session state entirely", () => {
  const d = detector();
  const events = collect(d);
  d.feed("s1", PERMISSION_SCREEN);
  d.clear("s1");
  d.feed("s1", "⠹ busy again");
  // No waiting=false leak after clear (state was dropped, not closed).
  expect(events).toEqual([{ id: "s1", waiting: true }]);
  d.stop();
});

const DEV_CHANNELS_TITLE_ONLY = "Loading development channels...\n";
const CHANNELS_WARNING = `WARNING: Loading development channels
This uses unreleased code.
❯ 1. I am using this for local development
  2. Cancel
Enter to confirm · Esc to cancel`;

test("a bare dev-channels title (no accept line) does not suppress a later real chooser", () => {
  const d = detector();
  const events = collect(d);
  d.feed("s1", DEV_CHANNELS_TITLE_ONLY);
  d.feed("s1", PERMISSION_SCREEN);
  expect(events).toEqual([{ id: "s1", waiting: true }]);
  d.stop();
});

test("a genuinely raised flag is NOT cleared by a bare dev-channels title arriving after it (reverse-order, minimal cue)", () => {
  const d = detector();
  const events = collect(d);
  d.feed("s1", PERMISSION_SCREEN);
  d.feed("s1", DEV_CHANNELS_TITLE_ONLY);
  expect(events).toEqual([{ id: "s1", waiting: true }]);
  d.stop();
});

test("the channels exemption needs BOTH cues, so a reworded accept option stops exempting", () => {
  const titleOnly = `WARNING: Loading development channels
❯ 1. Continue anyway
  2. Cancel
Enter to confirm · Esc to cancel`;
  expect(detectWaiting(CHANNELS_WARNING)).toBe(false);
  expect(detectWaiting(titleOnly)).toBe(true);
});

test("the accept option alone, with the title scrolled off, does not exempt", () => {
  const acceptOnly = `This uses unreleased code.
❯ 1. I am using this for local development
  2. Cancel
Enter to confirm · Esc to cancel`;
  expect(detectWaiting(acceptOnly)).toBe(true);
});

test("a genuine chooser rendered on a screen carrying the channels title still raises", () => {
  const mixed = `WARNING: Loading development channels
Bash command: rm -rf /
Do you want to proceed?
❯ 1. Yes
  2. No`;
  expect(detectWaiting(mixed)).toBe(true);
});

test("a reworded title upstream falls back to raising, never to silence", () => {
  const reworded = `WARNING: Loading dev channels
❯ 1. I am using this for local development
Enter to confirm · Esc to cancel`;
  expect(detectWaiting(reworded)).toBe(true);
});

test("a pure-ANSI repaint does not clear a raised flag", () => {
  const d = detector();
  const events = collect(d);
  d.feed("s1", PERMISSION_SCREEN);
  d.feed("s1", "\x1b[2J\x1b[1;1H\x1b[?25l\x1b[?25h");
  expect(events.map((e) => e.waiting)).toEqual([true]);
  d.stop();
});

test("the exempted screen arriving later does not clear a raised flag", () => {
  const d = detector();
  const events = collect(d);
  d.feed("s1", PERMISSION_SCREEN);
  d.feed("s1", CHANNELS_WARNING);
  expect(events.map((e) => e.waiting)).toEqual([true]);
  d.stop();
});

test("streamed prose mentioning the exempted wording does not clear a raised flag", () => {
  const d = detector();
  const events = collect(d);
  d.feed("s1", PERMISSION_SCREEN);
  d.feed(
    "s1",
    "I checked the docs: loading development channels is what the warning screen is about."
  );
  expect(events.map((e) => e.waiting)).toEqual([true]);
  d.stop();
});

// Both encodings of the channels-warning dialog must stay exempted: `\x1b[1C`
// spacing between words, and the literal-space repaint the CLI produces roughly
// 130ms later.
type ChannelsChunk = { t: number; data: string };
const CHANNELS_FIELD_CAPTURE: ChannelsChunk[] = JSON.parse(
  readFileSync(
    join(import.meta.dir, "pty-harness", "fixtures", "channels-warning-conpty-win.json"),
    "utf-8"
  )
);

const CHANNELS_SCREEN_CHUNKS = (() => {
  const hasCue = (c: ChannelsChunk) =>
    /Loading.{0,8}development.{0,8}channels/.test(stripAnsi(c.data));
  const first = CHANNELS_FIELD_CAPTURE.findIndex(hasCue);
  let last = first;
  CHANNELS_FIELD_CAPTURE.forEach((c, i) => {
    if (hasCue(c)) last = i;
  });
  return CHANNELS_FIELD_CAPTURE.slice(first, last + 1);
})();

test("the ConPTY repaint frame of the channels screen is still exempted (real capture, both spacings)", () => {
  // Guard the slice itself: an empty or one-chunk window would make the
  // assertion below pass while proving nothing. Both spacings must be in it.
  expect(CHANNELS_SCREEN_CHUNKS.length).toBeGreaterThan(1);
  const joined = CHANNELS_SCREEN_CHUNKS.map((c) => c.data).join("");
  expect(joined).toContain("WARNING:\x1b[1CLoading\x1b[1Cdevelopment\x1b[1Cchannels");
  expect(stripAnsi(joined)).toContain("WARNING: Loading development channels");

  const d = detector();
  const events = collect(d);
  // Replayed chunk by chunk, exactly as node-pty delivered them: the
  // compressed first paint AND the literal-space repaints go through.
  for (const c of CHANNELS_SCREEN_CHUNKS) d.feed("s1", c.data);
  expect(events).toEqual([]);
  d.stop();
});

test("purgeScreenMemory clears the retained buffer without touching a live waiting state", () => {
  const d = detector();
  const events = collect(d);
  d.feed("s1", PERMISSION_SCREEN);
  d.purgeScreenMemory("s1");
  // Buffer purged: the re-scan fallback sees only what arrives from here on.
  // A busy cue must still close the episode normally.
  d.feed("s1", "⠹ esc to interrupt");
  expect(events).toEqual([
    { id: "s1", waiting: true },
    { id: "s1", waiting: false }
  ]);
  d.stop();
});

test("the buffer-slide clearer clears after the waiting pattern leaves the retained window", () => {
  const d = detector();
  const events = collect(d);
  d.feed("s1", PERMISSION_SCREEN);
  expect(events).toEqual([{ id: "s1", waiting: true }]);

  const ORDINARY_LINE = "The build compiled successfully; no errors were found in the log.\n";
  const filler = ORDINARY_LINE.repeat(Math.ceil(4200 / ORDINARY_LINE.length));
  expect(filler.length).toBeGreaterThan(4096);

  d.feed("s1", filler);
  expect(events).toEqual([
    { id: "s1", waiting: true },
    { id: "s1", waiting: false }
  ]);
  d.stop();
});

test("purgeScreenMemory clears retained waiting text without a busy cue", () => {
  const d = detector();
  const events = collect(d);
  d.feed("s1", PERMISSION_SCREEN);
  expect(events).toEqual([{ id: "s1", waiting: true }]);

  d.purgeScreenMemory("s1");
  // Deliberately not a busy cue, which clears unconditionally regardless of
  // buffer content: this only reports 'cleared' if purgeScreenMemory actually
  // emptied the buffer of the prior waiting pattern.
  d.feed("s1", DEV_CHANNELS_TITLE_ONLY);
  expect(events).toEqual([
    { id: "s1", waiting: true },
    { id: "s1", waiting: false }
  ]);
  d.stop();
});

test("stripAnsi removes an OSC sequence, not just CSI", () => {
  const withOsc = "\x1b]0;⣋title\x07plain screen text";
  expect(stripAnsi(withOsc)).toBe("plain screen text");
});

test("busy text carried inside an OSC title does not spuriously clear a real waiting episode", () => {
  const d = detector();
  const events = collect(d);

  d.feed("s1", PERMISSION_SCREEN);
  expect(events).toEqual([{ id: "s1", waiting: true }]);

  // The busy text lives ONLY inside the OSC 0 title payload, never in
  // the plain screen text -- a real busy cue would be plain-text, this is
  // exactly the OSC-noise case the fix distinguishes from the real thing.
  d.feed("s1", "\x1b]0;✳ (3s · esc to interrupt)\x07");
  expect(events).toEqual([{ id: "s1", waiting: true }]); // still waiting, no false clear

  // A genuine plain-text busy cue still clears it, unaffected by the fix.
  d.feed("s1", "⣋ esc to interrupt");
  expect(events).toEqual([
    { id: "s1", waiting: true },
    { id: "s1", waiting: false }
  ]);
  d.stop();
});

test("busy text carried inside an OSC title FRAGMENTED across two chunks still does not spuriously clear a real waiting episode", () => {
  const d = detector();
  const events = collect(d);

  d.feed("s1", PERMISSION_SCREEN);
  expect(events).toEqual([{ id: "s1", waiting: true }]);

  const osc = "\x1b]0;✳ (3s · esc to interrupt)\x07";
  d.feed("s1", osc.slice(0, 12)); // carries "(3s ·", no terminator yet
  d.feed("s1", osc.slice(12)); // the terminator
  expect(events).toEqual([{ id: "s1", waiting: true }]); // still waiting, no false clear

  d.stop();
});

// ----- current trust prompt ("Quick safety check"), real capture -----

type Chunk = { t: number; data: string };
const loadFixture = (name: string): Chunk[] =>
  JSON.parse(readFileSync(join(import.meta.dir, "pty-harness", "fixtures", name), "utf-8"));

test("the current trust prompt raises attention (real Claude Code 2.1.282 capture, words placed by cursor moves)", () => {
  const chunks = loadFixture("trust-dialog-quick-safety-check.json");
  const dialog = chunks.findIndex((c) => stripAnsi(c.data).includes("safety"));
  expect(dialog, "the capture holds the dialog paint").toBeGreaterThanOrEqual(0);
  const d = detector();
  const events = collect(d);
  chunks.slice(0, dialog).forEach((c) => d.feed("s", c.data));
  expect(events, "nothing before the dialog is painted").toEqual([]);
  d.feed("s", chunks[dialog]!.data);
  expect(events, "the dialog paint raises exactly once").toEqual([{ id: "s", waiting: true }]);
});

test("the current trust prompt raises with its rows placed by cursor positioning (ConPTY shape, no line break)", () => {
  const screen =
    "\u001b[9;2H❯\u001b[9;4HNo,\u001b[9;8Hexit\u001b[10;4HYes,\u001b[10;9HI\u001b[10;11Htrust\u001b[10;17Hthis\u001b[10;22Hfolder";
  expect(detectWaiting(stripAnsi(screen)), "rows joined without CR/LF").toBe(true);
  expect(detectWaiting("No, exit\n❯ Yes, I trust this folder"), "selector moved to the second option").toBe(true);
});

test("prose about trusting a folder does not raise", () => {
  for (const prose of [
    "Yes, I trust this folder structure; the tests cover it.",
    "I trust this folder, so no, exit is not needed.",
    "Quick safety check: is this project one you trust?",
    "No, exit codes are ignored here.",
  ]) {
    expect(detectWaiting(prose), prose).toBe(false);
    const d = detector();
    const events = collect(d);
    d.feed("s", `● ${prose}\r\n`);
    expect(events, `streamed: ${prose}`).toEqual([]);
  }
});

test("whole real turns (with and without a statusLine) never raise attention", () => {
  for (const name of [
    "turn-with-statusline-count.json",
    "turn-with-statusline-hi.json",
    "turn-no-statusline-count.json",
    "turn-no-statusline-hi.json",
  ]) {
    const d = detector();
    const events = collect(d);
    for (const c of loadFixture(name)) d.feed("s", c.data);
    expect(events, name).toEqual([]);
  }
});

test("the transient numbered full-screen repaint does not confirm attention", () => {
  const clock = confirmationClock();
  const d = new AttentionDetector(clock.options);
  const events = collect(d);

  for (const c of loadFixture("turn-with-statusline-count.json")) {
    clock.advanceTo(c.t);
    d.feed("s", c.data.replace("count slowly", "1. count slowly"));
  }
  clock.advanceBy(ATTENTION_CONFIRMATION_DELAY_MS);

  expect(clock.planned.length).toBeGreaterThan(0);
  expect(events).toEqual([]);
});

// ----- accepted trust prompt: the welcome screen clears the flag -----

const trustDialogChunks = (): { before: Chunk[]; dialog: Chunk; after: Chunk[] } => {
  const chunks = loadFixture("trust-dialog-quick-safety-check.json");
  const i = chunks.findIndex((c) => stripAnsi(c.data).includes("safety"));
  expect(i, "the capture holds the dialog paint").toBeGreaterThanOrEqual(0);
  return { before: chunks.slice(0, i), dialog: chunks[i]!, after: chunks.slice(i + 1) };
};

/** The welcome screen up to its first idle prompt, before any keystroke (real capture). */
const WELCOME_PAINT: Chunk[] = (() => {
  const chunks = loadFixture("turn-with-statusline-hi.json");
  const typed = chunks.findIndex((c) => stripAnsi(c.data).includes("reply with"));
  const welcome = chunks.slice(0, typed);
  const joined = stripAnsi(welcome.map((c) => c.data).join(""));
  expect(joined, "the slice holds the banner").toMatch(/Claude\s*Code\s*v2\.1\.282/);
  expect(joined, "the slice holds the idle prompt").toMatch(/\u276f\s*Try/);
  return welcome;
})();

test("accepting the trust prompt clears the flag once the welcome screen is painted (real captures)", () => {
  const { before, dialog, after } = trustDialogChunks();
  const d = detector();
  const events = collect(d);
  for (const c of [...before, dialog, ...after]) d.feed("s", c.data);
  expect(events, "the dialog raises").toEqual([{ id: "s", waiting: true }]);
  for (const c of WELCOME_PAINT) d.feed("s", c.data);
  expect(events, "the welcome screen after the dialog must clear it").toEqual([
    { id: "s", waiting: true },
    { id: "s", waiting: false }
  ]);
  // Re-armed: nothing of the dialog is left to recombine with later output.
  d.feed("s", PERMISSION_SCREEN);
  expect(events.length).toBe(3);
});

test("a repaint of the trust prompt does not clear it, even with the banner painted above it", () => {
  const { before, dialog, after } = trustDialogChunks();
  for (const lead of [[], WELCOME_PAINT]) {
    const d = detector();
    const events = collect(d);
    for (const c of [...lead, ...before, dialog, ...after]) d.feed("s", c.data);
    expect(events, `dialog's own tail, banner first: ${lead.length > 0}`).toEqual([{ id: "s", waiting: true }]);
    d.feed("s", dialog.data);
    expect(events, `repaint, banner first: ${lead.length > 0}`).toEqual([{ id: "s", waiting: true }]);
    // A full redraw carrying the banner above the still-open prompt.
    d.feed("s", WELCOME_PAINT.map((c) => c.data).join("") + dialog.data);
    expect(events, `redraw with banner, banner first: ${lead.length > 0}`).toEqual([{ id: "s", waiting: true }]);
  }
});

test("a chooser painted after the welcome screen still holds the flag", () => {
  const { before, dialog } = trustDialogChunks();
  const d = detector();
  const events = collect(d);
  for (const c of [...before, dialog]) d.feed("s", c.data);
  d.feed("s", WELCOME_PAINT.map((c) => c.data).join("") + PERMISSION_SCREEN);
  expect(events).toEqual([{ id: "s", waiting: true }]);
});

// ----- the dev-channels exemption still lets a trust prompt raise -----

test("with the dev-channels warning in the window, both trust wordings still raise", () => {
  const newWording = stripAnsi(trustDialogChunks().dialog.data);
  expect(detectWaiting(CHANNELS_WARNING), "the warning alone stays exempted").toBe(false);
  expect(detectWaiting(`${CHANNELS_WARNING}\n${newWording}`), "current wording").toBe(true);
  expect(detectWaiting(`${CHANNELS_WARNING}\n${TRUST_SCREEN}`), "old wording").toBe(true);
  expect(detectWaiting(`${newWording}\n${CHANNELS_WARNING}`), "warning painted after the prompt").toBe(true);
});

test("the current trust prompt painted after the dev-channels warning raises (detector)", () => {
  const { dialog } = trustDialogChunks();
  const d = detector();
  const events = collect(d);
  d.feed("s", CHANNELS_WARNING);
  expect(events, "the warning alone is exempted").toEqual([]);
  d.feed("s", dialog.data);
  expect(events).toEqual([{ id: "s", waiting: true }]);
});

const SELECTOR = String.fromCodePoint(0x276f);
const BORDER = String.fromCodePoint(0x2500).repeat(60);
const isMarker = (c: Chunk): boolean => c.data.startsWith("\n########## ");

const NUMBERED_COMPOSER_CAPTURES: Record<string, string> = {
  "draft-numbered-2.1.301.json": "draft typed",
  "typing-numbered-2.1.301.json": "typing starts",
  "resize-numbered-draft-2.1.301.json": "typing starts",
};

let REAL_CHOOSERS: string[] = [];

beforeAll(async () => {
  const fixtures = readdirSync(join(import.meta.dir, "pty-harness", "fixtures"))
    .filter((name) => name.endsWith(".json") && !(name in NUMBERED_COMPOSER_CAPTURES));

  const pickers = await Promise.all(
    fixtures.map(async (name) => {
      const screen = createXtermScreen({ cols: 120, rows: 40, reportError: () => undefined });
      for (const chunk of loadFixture(name)) if (!isMarker(chunk)) screen.feed(chunk.data);
      await screen.drain();
      const read = screen.read();
      screen.dispose();
      if (read.status !== "ready") throw new Error(`${name}: xterm screen unavailable: ${read.reason}`);
      const inspection = inspectInjectGuard(read.snapshot);
      return inspection.state === "modal" && inspection.rule === "picker" ? name : null;
    })
  );

  REAL_CHOOSERS = pickers.filter((name): name is string => name !== null).sort();
});

const MODAL_ATTENTION_EXEMPTIONS = new Set([
  "channels-warning-conpty-win.json",
  "draft-numbered-2.1.301.json",
  "typing-numbered-2.1.301.json",
  "resize-numbered-draft-2.1.301.json",
  "scroll-context-2.1.284-reduced.json",
  "turn-chunks-inherited-env.json",
  "turn-chunks-scrubbed-env.json",
]);

const MODAL_ATTENTION_FIXTURES = Object.entries(EXPECTED_FIXTURE_VERDICTS)
  .filter(([, verdict]) => verdict.final === "modal")
  .map(([name]) => name)
  .filter((name) => !MODAL_ATTENTION_EXEMPTIONS.has(name))
  .sort();

const replayEvents = (name: string): { at: number; waiting: boolean }[] => {
  const d = detector();
  const events: { at: number; waiting: boolean }[] = [];
  let at = -1;
  d.on("attention", (e: AttentionEvent) => events.push({ at, waiting: e.waiting }));
  loadFixture(name).forEach((c, i) => {
    at = i;
    if (!isMarker(c)) d.feed("s", c.data);
  });
  return events;
};

test("an accepted trust prompt emits nothing before the later AskUserQuestion chooser", () => {
  const clock = confirmationClock();
  const d = new AttentionDetector(clock.options);
  const events: { at: number; waiting: boolean }[] = [];
  let at = -1;
  d.on("attention", (e: AttentionEvent) => events.push({ at, waiting: e.waiting }));
  const chunks = loadFixture("ask-user-question-2.1.301.json");
  const chooser = chunks.findIndex((c) => stripAnsi(c.data).includes("Which color do you prefer?"));
  expect(chooser, "the capture paints the real chooser").toBeGreaterThanOrEqual(0);

  chunks.forEach((c, i) => {
    clock.advanceTo(c.t);
    at = i;
    if (!isMarker(c)) d.feed("s", c.data);
  });

  expect(events.filter((event) => event.waiting && event.at < chooser)).toEqual([]);
  expect(events.filter((event) => event.waiting && event.at >= chooser)).toHaveLength(1);
});

test("the numbered pickers derived from the captures include the permission, AskUserQuestion and plan choosers", () => {
  for (const name of ["ask-user-question-2.1.301.json", "permission-write-2.1.291.json", "plan-approval-2.1.301.json"]) {
    expect(REAL_CHOOSERS, name).toContain(name);
  }
});

test("every captured numbered chooser raises after confirmation and still holds", () => {
  for (const name of REAL_CHOOSERS) {
    const clock = confirmationClock();
    const d = new AttentionDetector(clock.options);
    const events = collect(d);
    for (const c of loadFixture(name)) if (!isMarker(c)) d.feed("s", c.data);

    const pending = clock.planned.filter((timer) => !timer.cleared);
    expect(pending.length, name).toBeGreaterThan(0);
    for (const timer of pending) timer.callback();
    expect(events, name).toEqual([{ id: "s", waiting: true }]);
  }
});

test("every non-exempt modal fixture raises at the confirmation deadline", () => {
  for (const name of MODAL_ATTENTION_FIXTURES) {
    const clock = confirmationClock();
    const d = new AttentionDetector(clock.options);
    const events: Array<{ waiting: boolean; t: number }> = [];
    d.on("attention", (event: AttentionEvent) => events.push({ waiting: event.waiting, t: clock.now }));

    for (const chunk of loadFixture(name)) {
      if (chunk.t !== undefined) clock.advanceTo(chunk.t);
      if (!isMarker(chunk)) d.feed("s", chunk.data);
    }
    clock.advanceBy(ATTENTION_CONFIRMATION_DELAY_MS);

    const raised = events.filter((event) => event.waiting);
    expect(raised, name).toHaveLength(1);
    const confirmingTimer = clock.planned.find(
      (timer) => timer.fired && timer.dueAt === raised[0]!.t
    );
    expect(confirmingTimer?.delayMs, name).toBe(ATTENTION_CONFIRMATION_DELAY_MS);
  }
});

test("a numbered prompt pasted, typed, resized or submitted in the composer never raises (real captures)", () => {
  for (const [name, marker] of Object.entries(NUMBERED_COMPOSER_CAPTURES)) {
    const start = loadFixture(name).findIndex((c) => isMarker(c) && c.data.includes(marker));
    expect(start, `${name} holds its "${marker}" marker`).toBeGreaterThan(0);
    const raises = replayEvents(name).filter((e) => e.waiting && e.at > start);
    expect(raises, name).toEqual([]);
  }
});

test("the echo of a submitted numbered prompt does not raise, during the turn or once it settles", () => {
  const echo = `${SELECTOR} 1. rename the helper\n  2. run its tests\n`;
  expect(detectWaiting(`${echo}· Noodling… (3s · esc to interrupt)`), "running turn").toBe(false);
  expect(detectWaiting(`${echo}● Done.\n${BORDER}\n${SELECTOR} \n${BORDER}\n? for shortcuts`), "settled turn").toBe(false);
});

test("a numbered draft painted inside the composer box does not raise", () => {
  expect(detectWaiting(`${BORDER}\n${SELECTOR} 1. rename the helper\n${BORDER}\n? for shortcuts`)).toBe(false);
});

const CHOOSER = `Do you want to proceed?\r\n${SELECTOR} 1. Yes\r\n  2. Yes, and don't ask again\r\n  3. No\r\nEsc to cancel\r\n`;
const COMPOSER = `${BORDER}\r\n${SELECTOR} \r\n${BORDER}\r\n? for shortcuts`;

for (const [label, toOption2, toOption1] of [
  ["its rows rewritten", `\x1b[4;1H  1. Yes\x1b[K\r\n${SELECTOR} 2. Yes, and don't ask again`, `\x1b[4;1H${SELECTOR} 1. Yes\x1b[K\r\n  2. Yes, and don't ask again`],
  ["the glyph alone moved", `\x1b[4;1H \x1b[5;1H${SELECTOR}`, `\x1b[5;1H \x1b[4;1H${SELECTOR}`],
] as const) {
  test(`moving a raised chooser's selection (${label}) holds the flag until the composer is painted`, () => {
    const d = detector();
    const events = collect(d);
    d.feed("s", CHOOSER);
    expect(events, "the chooser raises").toEqual([{ id: "s", waiting: true }]);
    d.feed("s", toOption2);
    expect(events, "selection moved to option 2").toEqual([{ id: "s", waiting: true }]);
    d.feed("s", toOption1);
    expect(events, "selection back on option 1").toEqual([{ id: "s", waiting: true }]);
    d.feed("s", COMPOSER);
    expect(events, "the composer replaces the chooser").toEqual([
      { id: "s", waiting: true },
      { id: "s", waiting: false },
    ]);
  });
}

test("a chooser raises whatever its footer or question says", () => {
  expect(detectWaiting(`Resume this conversation?\n${SELECTOR} 1. Resume\n  2. Start a new conversation\nEsc to resume`), "resume").toBe(true);
  expect(detectWaiting(`How should the plan be implemented?\n${SELECTOR} 1. Here\n  2. In a new session`), "no cue").toBe(true);
  expect(detectWaiting(`${SELECTOR} 1. A\n${"preview ".repeat(250)}\nEsc to cancel`), "long preview").toBe(true);
  expect(detectWaiting(`Pick one\n${SELECTOR} 1. A\n  2. B\nEsc to go back`), "Esc to go back").toBe(true);
  expect(detectWaiting(`${SELECTOR}1Yes2. No`), "selection repaint without the period").toBe(true);
});

// ----- screen witness: may only veto a raise at its deadline, from the rendered screen -----

const D = ATTENTION_CONFIRMATION_DELAY_MS;
const ESC = String.fromCodePoint(0x1b);
const screenOf = (text: string): XtermScreenRead => ({
  status: "ready",
  snapshot: { revision: 0, cols: 120, rows: 40, lines: text.split("\n"), cursor: { x: 0, y: 0 } },
});
const WAIT_READ = screenOf(PERMISSION_SCREEN);
const BLANK_READ = screenOf("");
const unavailable = (reason: XtermScreenUnavailableReason): XtermScreenRead => ({ status: "unavailable", reason });
const READ_TIMES = Array.from({ length: 11 }, (_, k) => D - 100 + k * 10);

function witnessRig(
  read: (at: number) => XtermScreenRead,
  reportError: (scope: string, message: string, error?: unknown) => void = () => undefined
) {
  const clock = confirmationClock();
  const reads: Array<{ at: number; id: string }> = [];
  const d = new AttentionDetector({
    ...clock.options,
    screenWitness: createScreenWitness({
      read: (id) => {
        reads.push({ at: clock.now, id });
        return read(clock.now);
      },
      now: () => clock.now,
      showsWait: screenShowsWait,
      reportError,
    }),
  });
  const events: Array<{ at: number; waiting: boolean }> = [];
  d.on("attention", (e: AttentionEvent) => events.push({ at: clock.now, waiting: e.waiting }));
  return { clock, d, reads, events };
}

const readyAt = (times: readonly number[], otherwise: XtermScreenRead = unavailable("screen-pending")) => (at: number) =>
  times.includes(at) ? BLANK_READ : otherwise;

test("the witness reads the screen every 10 ms over the last 100 ms before the deadline, plus once at it, then vetoes a blank screen", () => {
  const { clock, d, reads, events } = witnessRig(() => BLANK_READ);
  d.feed("s1", PERMISSION_SCREEN);

  clock.advanceTo(D - 101);
  expect(reads, "nothing is read before the window opens").toEqual([]);
  clock.advanceTo(D);

  expect(reads.map((r) => r.at)).toEqual(READ_TIMES);
  expect(reads.every((r) => r.id === "s1")).toBe(true);
  expect(events, "a blank screen is no wait screen").toEqual([]);
});

test("a detector without a witness raises at the deadline whatever a screen would show", () => {
  const clock = confirmationClock();
  const d = new AttentionDetector(clock.options);
  const events = collect(d);
  d.feed("s1", PERMISSION_SCREEN);
  clock.advanceTo(D);
  expect(events).toEqual([{ id: "s1", waiting: true }]);
});

for (const [reason, ignored] of [
  ["screen-pending", true],
  ["sequence-incomplete", true],
  ["resize-pending", false],
  ["screen-fault", false],
  ["disposed", false],
] as const) {
  test(`a ${reason} read ${ignored ? "is ignored, the other reads still veto" : "makes the witness abstain, the raise stands"}`, () => {
    const { clock, d, events } = witnessRig((at) => (at === 1450 ? unavailable(reason) : BLANK_READ));
    d.feed("s1", PERMISSION_SCREEN);
    clock.advanceTo(D);
    expect(events).toEqual(ignored ? [] : [{ at: D, waiting: true }]);
  });
}

test("a veto needs six ready reads, one of them among the last three", () => {
  const cases: Array<[string, readonly number[], boolean]> = [
    ["six ready reads ending at the deadline", [1420, 1440, 1460, 1480, 1490, 1500], true],
    ["five ready reads", [1440, 1460, 1480, 1490, 1500], false],
    ["six ready reads, none among the last three", [1400, 1410, 1420, 1430, 1440, 1450], false],
    ["six ready reads, the third from last is the only recent one", [1400, 1410, 1420, 1430, 1440, 1480], true],
    ["six ready reads, the fourth from last is the only recent one", [1400, 1410, 1420, 1430, 1440, 1470], false],
  ];
  for (const [label, times, vetoed] of cases) {
    const { clock, d, events } = witnessRig(readyAt(times));
    d.feed("s1", PERMISSION_SCREEN);
    clock.advanceTo(D);
    expect(events, label).toEqual(vetoed ? [] : [{ at: D, waiting: true }]);
  }
});

test("a wait screen seen anywhere in the window, by either rule, lets the raise stand", () => {
  const stillOnly = "some output\n❯ typed text";
  expect(detectWaiting(stillOnly), "premise: the raising rule ignores this screen").toBe(false);
  expect(screenShowsWait(stillOnly), "premise: the holding rule keeps it").toBe(true);

  const shownAt: Array<[string, number]> = [
    ["first read", 1400],
    ["middle read", 1450],
    ["deadline read", 1500],
  ];
  for (const [label, shown] of shownAt) {
    for (const [kind, screen] of [["raising rule", WAIT_READ], ["holding rule", screenOf(stillOnly)]] as const) {
      const { clock, d, events } = witnessRig((at) => (at === shown ? screen : BLANK_READ));
      d.feed("s1", PERMISSION_SCREEN);
      clock.advanceTo(D);
      expect(events, `${label}, ${kind}`).toEqual([{ at: D, waiting: true }]);
    }
  }
});

test("a chunk every 10 ms keeps the screen pending, so nothing vetoes; every 40 ms leaves enough settled reads", () => {
  for (const [period, vetoed] of [[10, false], [40, true]] as const) {
    let chunkAt = -Infinity;
    const { clock, d, events } = witnessRig((at) => (at - chunkAt < 16 ? unavailable("screen-pending") : BLANK_READ));
    for (let at = 0; at < D; at += period) {
      clock.advanceTo(at);
      chunkAt = at;
      d.feed("s1", PERMISSION_SCREEN);
    }
    clock.advanceTo(D);
    expect(events, `a chunk every ${period} ms`).toEqual(vetoed ? [] : [{ at: D, waiting: true }]);
  }
});

test("a dialog visible for 30 ms between 16 ms blanks is seen by the 10 ms reads", () => {
  // 46 ms cycle, blank for its first 16 ms; aligned so that reads 50 ms apart would all land in a blank.
  const cycle = (at: number): XtermScreenRead => ((at - 1398) % 46 < 16 ? BLANK_READ : WAIT_READ);
  const { clock, d, events } = witnessRig(cycle);
  d.feed("s1", PERMISSION_SCREEN);
  clock.advanceTo(D);
  expect(events).toEqual([{ at: D, waiting: true }]);
});

test("a veto on a screen painted later re-checks one delay on and raises, though the stream stays silent", () => {
  let dialogUp = false;
  const { clock, d, events } = witnessRig(() => (dialogUp ? WAIT_READ : BLANK_READ));
  d.feed("s1", PERMISSION_SCREEN);
  clock.advanceTo(D);
  expect(events, "vetoed").toEqual([]);

  dialogUp = true;
  clock.advanceTo(2 * D - 1);
  expect(events, "not before one delay").toEqual([]);
  clock.advanceTo(60_000);
  expect(events).toEqual([{ at: 2 * D, waiting: true }]);
});

test("three vetoes in a row end the re-checks; the next chunk starts a fresh episode", () => {
  let dialogUp = false;
  const { clock, d, reads, events } = witnessRig(() => (dialogUp ? WAIT_READ : BLANK_READ));
  d.feed("s1", PERMISSION_SCREEN);
  clock.advanceTo(60_000);
  expect(events, "a screen that never shows the dialog never raises").toEqual([]);
  expect(reads, "three windows of eleven reads, then nothing").toHaveLength(33);
  expect(clock.planned.filter((timer) => !timer.cleared && !timer.fired), "no timer left armed").toEqual([]);

  dialogUp = true;
  d.feed("s1", `${ESC}[?25l`);
  clock.advanceTo(60_000 + D);
  expect(events).toEqual([{ at: 60_000 + D, waiting: true }]);
});

test("ready reads stamped less than half the window apart never veto", () => {
  const stamps = (first: number, step: number): number[] => Array.from({ length: 11 }, (_, k) => first + k * step);
  const pendingThenBunched = [...stamps(1400, 10).slice(0, 5), ...Array<number>(6).fill(1480)];
  const cases: Array<[string, number[], number, boolean]> = [
    ["all at one instant", stamps(1450, 0), 0, false],
    ["spread over 40 ms", stamps(1460, 4), 0, false],
    ["spread over 50 ms", stamps(1450, 5), 0, true],
    ["five spread pending reads, then six ready reads at one instant", pendingThenBunched, 5, false],
  ];
  for (const [label, times, pending, vetoed] of cases) {
    let taken = 0;
    const witness = createScreenWitness({
      read: () => (taken < pending ? unavailable("screen-pending") : BLANK_READ),
      now: () => times[taken++]!,
      showsWait: screenShowsWait,
      reportError: () => undefined,
    });
    const window = witness.arm("s1", D, {
      setTimeout: (callback) => {
        callback();
        return undefined;
      },
      clearTimeout: () => undefined,
    });
    expect(window.decide(), label).toBe(vetoed);
  }
});

test("a clear, purge, stop or busy cue inside the window ends every read and the raise", () => {
  for (const [label, act] of [
    ["clear", (d: AttentionDetector) => d.clear("s1")],
    ["purge", (d: AttentionDetector) => d.purgeScreenMemory("s1")],
    ["stop", (d: AttentionDetector) => d.stop()],
    ["busy cue", (d: AttentionDetector) => d.feed("s1", "⠹ running… esc to interrupt")],
  ] as const) {
    const { clock, d, reads, events } = witnessRig(() => BLANK_READ);
    d.feed("s1", PERMISSION_SCREEN);
    clock.advanceTo(1450);
    expect(reads.length, `${label}: reads taken before`).toBe(6);
    act(d);
    clock.advanceTo(3 * D);
    expect(reads.length, `${label}: no read afterwards`).toBe(6);
    expect(events, label).toEqual([]);
  }
});

test("a reader that throws is reported on every read and the raise stands", () => {
  const failure = new Error("screen gone");
  const reported: Array<{ scope: string; message: string; error: unknown }> = [];
  const { clock, d, events } = witnessRig(
    () => {
      throw failure;
    },
    (scope, message, error) => reported.push({ scope, message, error })
  );
  d.feed("s1", PERMISSION_SCREEN);
  clock.advanceTo(D);
  expect(reported).toHaveLength(11);
  expect(reported[0]).toEqual({ scope: "attention", message: "screen witness read failed", error: failure });
  expect(events).toEqual([{ at: D, waiting: true }]);
});

test("one read that throws among blank reads keeps the raise", () => {
  const failure = new Error("screen gone");
  const reported: unknown[] = [];
  const { clock, d, events } = witnessRig(
    (at) => {
      if (at === 1450) throw failure;
      return BLANK_READ;
    },
    (_scope, _message, error) => reported.push(error)
  );
  d.feed("s1", PERMISSION_SCREEN);
  clock.advanceTo(D);
  expect(reported).toEqual([failure]);
  expect(events).toEqual([{ at: D, waiting: true }]);
});

// ----- screen witness replayed on the captures, through a real xterm screen -----

const LAGS = [0, 16] as const;

/**
 * What a reader of the real xterm screen gets right after each chunk of a capture, and right after each RESIZE marker.
 * The next chunk is fed from the release hook of the previous one, so xterm's write timer is paid once per capture
 * instead of once per chunk (a timer tick per chunk on Windows), and the replay itself runs on the virtual clock.
 */
function screenStates(name: string): Promise<{ initial: XtermScreenRead; after: Array<XtermScreenRead | undefined> }> {
  const chunks = loadFixture(name);
  const after: Array<XtermScreenRead | undefined> = new Array(chunks.length).fill(undefined);
  return new Promise((resolve) => {
    let next = 0;
    let fed = -1;
    const advance = (): void => {
      if (fed >= 0) after[fed] = screen.read();
      fed = -1;
      while (next < chunks.length) {
        const chunk = chunks[next]!;
        const index = next++;
        const resize = RESIZE_MARKER.exec(chunk.data);
        if (resize) {
          screen.resize(Number(resize[1]), Number(resize[2]));
          after[index] = screen.read();
        } else if (!isMarker(chunk) && chunk.data.length > 0) {
          fed = index;
          screen.feed(chunk.data);
          return;
        }
      }
      screen.dispose();
      resolve({ initial, after });
    };
    const screen = createXtermScreen({ cols: 120, rows: 40, reportError: () => undefined, releasePending: advance });
    const initial = screen.read();
    advance();
  });
}

type RaiseEvent = { at: number; waiting: boolean };
const showsAt = (events: RaiseEvent[]): string => events.map((e) => `${e.waiting ? "+" : "-"}${e.at}`).join(" ");

/** Events of the stream-only detector and, per read lag, of the same detector with the witness reading the real screen. */
async function replayWithScreen(name: string): Promise<{ head: RaiseEvent[]; witnessed: Record<number, RaiseEvent[]> }> {
  const { initial, after } = await screenStates(name);
  let current = initial;
  let chunkAt = -Infinity;
  const runs = [undefined, ...LAGS].map((lag) => {
    const clock = confirmationClock();
    const events: RaiseEvent[] = [];
    const d = new AttentionDetector({
      ...clock.options,
      ...(lag === undefined
        ? {}
        : {
            screenWitness: createScreenWitness({
              read: () => (clock.now - chunkAt < lag ? unavailable("screen-pending") : current),
              now: () => clock.now,
              showsWait: screenShowsWait,
              reportError: () => undefined,
            }),
          }),
    });
    d.on("attention", (e: AttentionEvent) => events.push({ at: clock.now, waiting: e.waiting }));
    return { lag, clock, d, events };
  });

  loadFixture(name).forEach((chunk, index) => {
    for (const run of runs) if (chunk.t !== undefined) run.clock.advanceTo(chunk.t);
    const state = after[index];
    if (state) current = state;
    if (isMarker(chunk) || chunk.data.length === 0) return;
    chunkAt = runs[0]!.clock.now;
    for (const run of runs) run.d.feed("s", chunk.data);
  });
  for (const run of runs) run.clock.advanceBy(D);

  return {
    head: runs[0]!.events,
    witnessed: Object.fromEntries(runs.slice(1).map((run) => [run.lag, run.events])),
  };
}

test("replaying every capture through a real screen, the witness changes no verdict but the named one", async () => {
  const names = readdirSync(join(import.meta.dir, "pty-harness", "fixtures")).filter((name) => name.endsWith(".json")).sort();
  const deviations: Record<string, { head: string; witnessed: string }> = {};

  const replays = await Promise.all(names.map(async (name) => ({ name, ...(await replayWithScreen(name)) })));
  for (const { name, head, witnessed } of replays) {
    for (const lag of LAGS) {
      if (showsAt(witnessed[lag]!) !== showsAt(head)) {
        deviations[`${name} @${lag}ms`] = { head: showsAt(head), witnessed: showsAt(witnessed[lag]!) };
      }
    }
  }

  expect(deviations).toEqual({
    "resize-numbered-draft-2.1.301.json @0ms": { head: "+7838 -7889", witnessed: "" },
    "resize-numbered-draft-2.1.301.json @16ms": { head: "+7838 -7889", witnessed: "" },
  });
});

/** The screen as a reader sees it at `at`: settled chunk states, pending right after a chunk, resize-pending after a resize. */
async function stormTimeline() {
  const name = "resize-storm-write-perm-2.1.303.json";
  const { after } = await screenStates(name);
  const samples: Array<{ at: number; chunk: boolean; read: XtermScreenRead }> = [];
  let escWrittenAt = -1;
  loadFixture(name).forEach((chunk, index) => {
    const read = after[index];
    if (read) samples.push({ at: chunk.t, chunk: !isMarker(chunk), read });
    else if (chunk.data.includes("\\u001b")) escWrittenAt = chunk.t;
  });
  const readAt = (at: number, lag: number): XtermScreenRead => {
    let found: (typeof samples)[number] | undefined;
    for (const sample of samples) if (sample.at <= at) found = sample;
    if (!found) return unavailable("disposed");
    return found.chunk && at - found.at < lag ? unavailable("screen-pending") : found.read;
  };
  const firstWaitAt = samples.find(
    (s) => s.read.status === "ready" && screenShowsWait(s.read.snapshot.lines.join("\n"))
  )!.at;
  const resizeAts = samples.filter((s) => !s.chunk).map((s) => s.at);
  return {
    readAt,
    firstWaitAt,
    escWrittenAt,
    lastAt: samples[samples.length - 1]!.at,
    stormFrom: resizeAts[0]! - 100,
    stormTo: resizeAts[resizeAts.length - 1]! + 400,
  };
}

/** Whether the witness vetoes a raise whose deadline falls at `deadlineAt`, reading the timeline through its own clock. */
function vetoesAt(readAt: (at: number) => XtermScreenRead, deadlineAt: number): boolean {
  const clock = confirmationClock();
  const witness = createScreenWitness({
    read: () => readAt(deadlineAt - D + clock.now),
    now: () => clock.now,
    showsWait: screenShowsWait,
    reportError: () => undefined,
  });
  const window = witness.arm("s", D, clock.options);
  clock.advanceTo(D);
  return window.decide();
}

test("a real resize storm over an open dialog never vetoes, whatever the read lag; the same screen vetoes once the dialog is gone", async () => {
  const { readAt, firstWaitAt, escWrittenAt, lastAt, stormFrom, stormTo } = await stormTimeline();
  expect(firstWaitAt, "the capture paints the dialog before the storm").toBeGreaterThan(0);
  expect(escWrittenAt, "the capture records the Esc that closes the dialog").toBeGreaterThan(firstWaitAt);
  expect(stormFrom, "the storm lies inside the open dialog").toBeGreaterThan(firstWaitAt + 100);
  expect(stormTo, "the storm ends before the Esc").toBeLessThan(escWrittenAt);

  // The screen only changes at chunks: every millisecond across the storm, sparser where it is static.
  const deadlines = (from: number, to: number): number[] => {
    const at: number[] = [];
    for (let t = from; t <= to; t += t >= stormFrom && t <= stormTo ? 1 : 13) at.push(t);
    return at;
  };
  for (const lag of [0, 8, 16]) {
    const read = (at: number): XtermScreenRead => readAt(at, lag);
    const falseVetoes = deadlines(firstWaitAt + 100, escWrittenAt).filter((at) => vetoesAt(read, at));
    expect(falseVetoes, `lag ${lag} ms`).toEqual([]);

    const missed = deadlines(escWrittenAt + 400, lastAt).filter((at) => !vetoesAt(read, at));
    expect(missed, `lag ${lag} ms, dialog gone`).toEqual([]);
  }
});
