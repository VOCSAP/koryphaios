import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { basename, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { approvalWindowAssets } from "../desktop/src/main/approval-window";

const DESKTOP = join(import.meta.dir, "..", "desktop");
const ELECTRON_PACKAGE = join(DESKTOP, "node_modules", "electron");
const APPROVAL_WINDOW = join(DESKTOP, "src", "main", "approval-window.ts");
const LINUX = process.platform === "linux";
const DPRS = [1, 1.25] as const;
const DOCUMENTS = 12;

const PROBE = `
import { app, BrowserWindow, ipcMain, nativeTheme, session } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { approvalWindowAssets, createApprovalNativeAdapter, createApprovalWindowController } from ${JSON.stringify(APPROVAL_WINDOW.replace(/\\/g, "/"))}

const [resultFile, mainDir, fixtureDir, documentCount] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
const assets = approvalWindowAssets(mainDir)
const reports = []
const verdicts = []
const partitions = []
let lastWindow = null
const progress = { ok: true }

const record = (verdict) => verdicts.push(verdict)
const report = (scope, message, error) => {
  reports.push(error === undefined ? scope + ': ' + message : scope + ': ' + message + ': ' + String(error))
}

const reader = createApprovalNativeAdapter({
  ...assets,
  parent: () => null,
  // The reader shows itself on ready-to-show; kept hidden so a local run never puts a window on the operator's screen.
  createWindow: (options) => {
    const win = new BrowserWindow(options)
    win.show = () => {}
    lastWindow = win
    return win
  },
  sessionFromPartition: (partition) => {
    partitions.push(partition)
    return session.fromPartition(partition)
  },
  reportError: report
})

// The reader page forbids frames, so the subframe sender is a second endpoint whose page embeds one, behind the same controller.
let frameWindow = null
const frameEndpoint = {
  open(_generation, lifecycle) {
    frameWindow = new BrowserWindow({
      show: false,
      webPreferences: { preload: assets.preload, partition: 'approval-frame-fixture', sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true }
    })
    frameWindow.on('closed', () => lifecycle.closed())
    void frameWindow.loadFile(join(fixtureDir, 'frame.html'))
  },
  close() {
    if (frameWindow !== null && !frameWindow.isDestroyed()) frameWindow.destroy()
  },
  endpoint() {
    return frameWindow !== null && !frameWindow.isDestroyed() ? frameWindow.webContents : null
  }
}
let viaFrame = false
const native = () => (viaFrame ? frameEndpoint : reader)

const controller = createApprovalWindowController({
  ipc: ipcMain,
  native: {
    open: (generation, lifecycle) => native().open(generation, lifecycle),
    close: (generation) => native().close(generation),
    endpoint: (generation) => native().endpoint(generation)
  },
  reportError: report,
  presentation: () => ({
    lang: 'en',
    text: { regionLabel: 'Request', unreached: 'Read to the end', reached: 'End reached', readFailed: 'Read failed', verdictFailed: 'Verdict failed' }
  })
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(label, read, done, ms = 8000) {
  const deadline = Date.now() + ms
  let last
  for (;;) {
    try {
      last = await read()
      if (done(last)) return last
    } catch (error) {
      last = error
    }
    if (Date.now() >= deadline) throw new Error(label + ' not reached within ' + ms + ' ms (last: ' + JSON.stringify(String(last)) + ')')
    await sleep(25)
  }
}
const js = (target, code) => target.executeJavaScript(code)
const verdictAfter = (count) => until('verdict', () => verdicts.length, (n) => n > count, 2000).then(() => verdicts[count], (error) => 'none: ' + error.message)

function workspace(index) {
  const lines = []
  for (let s = 1; s <= 12; s++) {
    for (let a = 1; a <= 5; a++) {
      lines.push('session ' + s + '/12 arg ' + a + ': --append-system-prompt "' + ('workspace ' + index + ' keeps every argument visible before approval ').repeat(5) + '"')
    }
  }
  lines.push('END OF WORKSPACE ' + index)
  return { message: 'Launch workspace ' + index + ' (12 sessions)', detail: lines.join('\\n'), approve: 'Approve', refuse: 'Refuse', close: 'Close' }
}

function openReader(document) {
  const count = verdicts.length
  const opened = controller.open(document, record)
  if (opened.kind !== 'opened') throw new Error('approval reader busy')
  return { win: lastWindow, count }
}

const READY = "Boolean(document.querySelector('pre.approval-text') && document.querySelector('button.primary'))"
const rendered = (win) => until('reader rendered', () => js(win.webContents, READY), (ready) => ready === true, 10000)
const STATE = "(() => { const scroll = document.querySelector('.approval-scroll'); return { scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight, disabled: document.querySelector('button.primary').disabled, theme: document.documentElement.dataset.theme, background: getComputedStyle(document.querySelector('.approval-root')).backgroundColor, dpr: devicePixelRatio } })()"
const TEXT = "document.querySelector('pre.approval-text').textContent"
// Button state and last-character geometry in one evaluation: the first reader's viewport can shrink after layout settles.
const END_SAMPLE = "(() => { const box = document.querySelector('.approval-scroll').getBoundingClientRect(); const text = document.querySelector('pre.approval-text').firstChild; const range = document.createRange(); range.setStart(text, text.length - 1); range.setEnd(text, text.length); const last = range.getBoundingClientRect(); return { enabled: !document.querySelector('button.primary').disabled, top: last.top, bottom: last.bottom, boxTop: box.top, boxBottom: box.bottom } })()"
const SCROLL_TO_END = "(() => { const scroll = document.querySelector('.approval-scroll'); scroll.scrollTop = scroll.scrollHeight; return scroll.scrollTop })()"
const UNLOCKED = "!document.querySelector('button.primary').disabled"
const endHidden = (sample) => sample.top < sample.boxTop || sample.bottom > sample.boxBottom
// A verdict destroys the window, and an executeJavaScript still pending on a destroyed webContents never settles.
const CLICK = (selector) => "setTimeout(() => document.querySelector('" + selector + "').click(), 0); true"
const CALL_STATE ="window.api.getState().then(() => 'accepted', (error) => 'rejected: ' + error.message)"
const PERMISSIONS = "Promise.all([Notification.requestPermission(), navigator.permissions.query({ name: 'notifications' }).then((status) => status.state)]).then(([request, query]) => ({ request, query }))"

async function scenario() {
  nativeTheme.themeSource = 'light'
  const result = progress

  viaFrame = true
  const frameCount = verdicts.length
  controller.open(workspace(0), record)
  await until('frame endpoint loaded', () => frameWindow.webContents.mainFrame.frames.length, (n) => n === 1)
  const subFrame = frameWindow.webContents.mainFrame.frames[0]
  await until('main frame api', () => js(frameWindow.webContents, 'typeof window.api'), (type) => type === 'object')
  await until('subframe api', () => js(subFrame, 'typeof window.api'), (type) => type === 'object')
  result.frame = { mainFrame: await js(frameWindow.webContents, CALL_STATE), subFrame: await js(subFrame, CALL_STATE) }
  frameWindow.close()
  result.frame.verdict = await verdictAfter(frameCount)
  viaFrame = false

  const first = openReader(workspace(1))
  await rendered(first.win)
  const approvalSession = first.win.webContents.session
  const partition = partitions[partitions.length - 1]
  result.partition = {
    name: partition,
    isDefault: approvalSession === session.defaultSession,
    isWired: approvalSession === session.fromPartition(partition),
    persistent: approvalSession.isPersistent()
  }
  result.permissions = await js(first.win.webContents, PERMISSIONS)
  const foreign = new BrowserWindow({ show: false, webPreferences: { preload: assets.preload, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await foreign.loadFile(join(fixtureDir, 'child.html'))
  result.foreign = {
    own: await js(first.win.webContents, CALL_STATE),
    call: await js(foreign.webContents, CALL_STATE),
    permissions: await js(foreign.webContents, PERMISSIONS)
  }
  foreign.destroy()
  first.win.close()
  result.close = { verdict: await verdictAfter(first.count) }

  result.documents = []
  for (let index = 1; index <= Number(documentCount); index++) {
    const document = workspace(index)
    const { win, count } = openReader(document)
    await rendered(win)
    await sleep(100)
    const before = await js(win.webContents, STATE)
    const text = await js(win.webContents, TEXT)
    const samples = []
    const end = await until('approve unlocked at the end', async () => {
      await js(win.webContents, SCROLL_TO_END)
      const sample = await js(win.webContents, END_SAMPLE)
      samples.push(sample)
      return sample
    }, (sample) => sample.enabled, 5000).then((sample) => sample, () => samples[samples.length - 1])
    const unlocked = end.enabled
    if (unlocked) await js(win.webContents, CLICK('button.primary'))
    else win.close()
    const verdict = await verdictAfter(count)
    if (verdict.startsWith('none')) {
      win.close()
      await verdictAfter(count)
    }
    result.documents.push({
      scrollHeight: before.scrollHeight,
      clientHeight: before.clientHeight,
      dpr: before.dpr,
      disabledBefore: before.disabled,
      textIntact: text === document.detail,
      unlocked,
      end,
      enabledWithEndHidden: samples.filter((sample) => sample.enabled && endHidden(sample)).length,
      verdict
    })
  }

  const reload = openReader(workspace(13))
  await rendered(reload.win)
  let mark = reports.length
  await js(reload.win.webContents, 'setTimeout(() => location.reload(), 0); true')
  result.reload = { verdict: await verdictAfter(reload.count), traces: reports.slice(mark) }

  const crash = openReader(workspace(14))
  await rendered(crash.win)
  mark = reports.length
  crash.win.webContents.forcefullyCrashRenderer()
  result.crash = { verdict: await verdictAfter(crash.count), traces: reports.slice(mark) }

  const resized = openReader({ message: 'Resize', detail: Array.from({ length: 36 }, (_, i) => 'line ' + i).join('\\n'), approve: 'Approve', refuse: 'Refuse', close: 'Close' })
  await rendered(resized.win)
  await sleep(100)
  const small = await js(resized.win.webContents, STATE)
  resized.win.setContentSize(640, 1000)
  const unlockedByResize = await until('approve unlocked by resize', () => js(resized.win.webContents, UNLOCKED), (value) => value === true, 3000).then(() => true, () => false)
  if (unlockedByResize) await js(resized.win.webContents, CLICK('button.primary'))
  else resized.win.close()
  const resizeVerdict = await verdictAfter(resized.count)
  if (resizeVerdict.startsWith('none')) {
    resized.win.close()
    await verdictAfter(resized.count)
  }
  result.resize = { overflowBefore: small.scrollHeight > small.clientHeight, disabledBefore: small.disabled, unlockedByResize, verdict: resizeVerdict }

  const themed = openReader(workspace(15))
  await rendered(themed.win)
  const light = await until('light theme', () => js(themed.win.webContents, STATE), (state) => state.theme === 'light')
  nativeTheme.themeSource = 'dark'
  const dark = await until('dark theme', () => js(themed.win.webContents, STATE), (state) => state.theme === 'dark')
  await js(themed.win.webContents, CLICK('.modal-actions button.btn'))
  result.theme = { light: light.theme, dark: dark.theme, lightBackground: light.background, darkBackground: dark.background, verdict: await verdictAfter(themed.count) }

  await until('approval windows closed', () => BrowserWindow.getAllWindows().length, (n) => n === 0, 3000).then(
    () => undefined,
    (error) => report('probe', 'approval windows still open', error)
  )
  result.openWindows = BrowserWindow.getAllWindows().length
  result.partitions = partitions
  result.reports = reports
  return result
}

app.on('window-all-closed', () => {})
const watchdog = setTimeout(() => {
  writeFileSync(resultFile, JSON.stringify({ ...progress, ok: false, error: 'scenario watchdog expired', reports, verdicts }))
  app.exit(3)
}, 60000)
app.whenReady().then(scenario).then(
  (result) => {
    clearTimeout(watchdog)
    writeFileSync(resultFile, JSON.stringify(result))
    app.exit(0)
  },
  (error) => {
    clearTimeout(watchdog)
    writeFileSync(resultFile, JSON.stringify({ ok: false, error: String((error && error.stack) || error), reports, verdicts }))
    app.exit(2)
  }
)
`;

interface Rect {
  top: number;
  bottom: number;
  boxTop: number;
  boxBottom: number;
}

interface DocumentResult {
  scrollHeight: number;
  clientHeight: number;
  dpr: number;
  disabledBefore: boolean;
  textIntact: boolean;
  unlocked: boolean;
  end: Rect;
  enabledWithEndHidden: number;
  verdict: string;
}

interface Permissions {
  request: string;
  query: string;
}

interface ScenarioResult {
  ok: boolean;
  error?: string;
  frame: { mainFrame: string; subFrame: string; verdict: string };
  partition: { name: string; isDefault: boolean; isWired: boolean; persistent: boolean };
  permissions: Permissions;
  foreign: { own: string; call: string; permissions: Permissions };
  close: { verdict: string };
  documents: DocumentResult[];
  reload: { verdict: string; traces: string[] };
  crash: { verdict: string; traces: string[] };
  resize: { overflowBefore: boolean; disabledBefore: boolean; unlockedByResize: boolean; verdict: string };
  theme: { light: string; dark: string; lightBackground: string; darkBackground: string; verdict: string };
  openWindows: number;
  partitions: string[];
  reports: string[];
}

const root = mkdtempSync(join(tmpdir(), "kory-approval-window-"));
const tag = basename(root);
const children: ChildProcess[] = [];
const results = new Map<number, ScenarioResult>();
let xvfbBaseline = 0;

function electronBinary(): string {
  const pointer = join(ELECTRON_PACKAGE, "path.txt");
  if (!existsSync(pointer)) throw new Error(`electron is not installed: ${pointer} is missing (npm --prefix desktop ci)`);
  return join(ELECTRON_PACKAGE, "dist", readFileSync(pointer, "utf-8").trim());
}

function countXvfb(): number {
  if (!LINUX) return 0;
  return (spawnSync("pgrep", ["-x", "Xvfb"], { encoding: "utf-8" }).stdout ?? "").split("\n").filter((line) => line.trim()).length;
}

/** Processes whose command line carries this run's temp-dir name: the probe Electrons, their helpers, and xvfb-run. */
function countTagged(): number {
  if (process.platform === "win32") {
    const script = `@(Get-CimInstance Win32_Process -Filter "CommandLine like '%${tag}%'" | Where-Object { $_.ProcessId -ne $PID }).Count`;
    const out = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf-8", windowsHide: true });
    if (out.status !== 0) throw new Error(`process count failed: ${out.stderr}`);
    return Number(out.stdout.trim());
  }
  return (spawnSync("pgrep", ["-f", tag], { encoding: "utf-8" }).stdout ?? "").split("\n").filter((line) => line.trim()).length;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    if (process.platform === "win32" && child.pid !== undefined) {
      const killed = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      if (killed.status !== 0) child.kill("SIGKILL");
    } else if (LINUX && child.pid !== undefined) {
      process.kill(-child.pid, "SIGKILL");
    } else {
      child.kill("SIGKILL");
    }
  });
}

async function runScenario(probe: string, dpr: number): Promise<ScenarioResult> {
  const resultFile = join(root, `result-${dpr}.json`);
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [
    probe,
    resultFile,
    join(DESKTOP, "out", "main"),
    root,
    String(DOCUMENTS),
    `--user-data-dir=${join(root, `profile-${dpr}`)}`,
    ...(dpr === 1 ? [] : [`--force-device-scale-factor=${dpr}`]),
  ];
  const [command, argv] = LINUX ? ["xvfb-run", ["-a", electronBinary(), ...args, "--no-sandbox"]] : [electronBinary(), args];
  const child = spawn(command, argv, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, env, detached: LINUX });
  children.push(child);
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf-8")).slice(-3_000);
  });
  const deadline = Date.now() + 75_000;
  while (!existsSync(resultFile) && Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!existsSync(resultFile)) {
    throw new Error(`dpr ${dpr}: no scenario result (exitCode=${String(child.exitCode)}, signal=${String(child.signalCode)})\nstderr:\n${stderr || "(empty)"}`);
  }
  const result = JSON.parse(readFileSync(resultFile, "utf-8")) as ScenarioResult;
  if (!result.ok) throw new Error(`dpr ${dpr}: ${result.error}\nscenario: ${JSON.stringify({ ...result, partitions: undefined })}\nstderr:\n${stderr}`);
  return result;
}

beforeAll(async () => {
  const assets = approvalWindowAssets(join(DESKTOP, "out", "main"));
  for (const asset of [assets.html, assets.preload]) {
    if (!existsSync(asset)) throw new Error(`${asset} is missing: run \`npm --prefix desktop run build\` first`);
  }
  xvfbBaseline = countXvfb();
  writeFileSync(join(root, "probe.ts"), PROBE);
  writeFileSync(join(root, "frame.html"), '<!doctype html><html><body><iframe src="child.html"></iframe></body></html>');
  writeFileSync(join(root, "child.html"), "<!doctype html><html><body>child</body></html>");
  const built = await Bun.build({ entrypoints: [join(root, "probe.ts")], outdir: root, target: "node", format: "cjs", external: ["electron"], naming: "[name].cjs" });
  if (!built.success) throw new Error(built.logs.map(String).join("\n"));
  const probe = join(root, "probe.cjs");
  const runs = await Promise.all(DPRS.map((dpr) => runScenario(probe, dpr)));
  DPRS.forEach((dpr, index) => results.set(dpr, runs[index]!));
}, 120_000);

afterAll(async () => {
  await Promise.all(children.map((child) => stop(child)));
  rmSync(root, { recursive: true, force: true });
});

const scenario = (dpr: number): ScenarioResult => {
  const result = results.get(dpr);
  if (result === undefined) throw new Error(`dpr ${dpr}: the scenario did not run`);
  return result;
};

for (const dpr of DPRS) {
  describe(`dpr ${dpr}`, () => {
    test("the controller answers the reader's main frame and rejects a subframe of the same webContents", () => {
      const { frame, reports } = scenario(dpr);
      expect(frame.mainFrame).toBe("accepted");
      expect(frame.subFrame).toStartWith("rejected");
      expect(frame.subFrame).toContain("Approval window sender is not current");
      expect(frame.verdict).toBe("refuse");
      expect(reports).toContain("approval-window: Approval window sender was rejected");
    });

    test("another webContents carrying the reader preload is rejected while the reader itself is answered", () => {
      const { foreign, reports } = scenario(dpr);
      expect(foreign.own).toBe("accepted");
      expect(foreign.call).toContain("Approval window sender is not current");
      expect(reports.filter((line) => line === "approval-window: Approval window sender was rejected").length).toBe(2);
    });

    test("each reader runs in its own in-memory partition, the one the adapter wired", () => {
      const { partition, partitions } = scenario(dpr);
      expect(partition.name).toStartWith("approval-window:");
      expect(partition.isDefault).toBe(false);
      expect(partition.isWired).toBe(true);
      expect(partition.persistent).toBe(false);
      expect(new Set(partitions).size).toBe(partitions.length);
    });

    test("the reader's permission requests and checks are denied, unlike the default session", () => {
      const { permissions, foreign } = scenario(dpr);
      expect(foreign.permissions).toEqual({ request: "granted", query: "granted" });
      expect(permissions).toEqual({ request: "denied", query: "denied" });
    });

    test(`${DOCUMENTS} long workspaces are each reachable to their last character, Approve unlocking only at the bottom`, () => {
      const { documents } = scenario(dpr);
      expect(documents).toHaveLength(DOCUMENTS);
      documents.forEach((document, index) => {
        const label = `workspace ${index + 1}`;
        expect(document.dpr, label).toBe(dpr);
        expect(document.scrollHeight, label).toBeGreaterThan(document.clientHeight);
        expect(document.textIntact, label).toBe(true);
        expect(document.disabledBefore, label).toBe(true);
        expect(document.unlocked, label).toBe(true);
        expect(document.enabledWithEndHidden, `${label}: Approve was enabled while the last character was outside the region`).toBe(0);
        expect(document.end.top, label).toBeGreaterThanOrEqual(document.end.boxTop);
        expect(document.end.bottom, label).toBeLessThanOrEqual(document.end.boxBottom);
        expect(document.verdict, label).toBe("approve");
      });
    });

    test("closing the reader settles a refusal", () => {
      expect(scenario(dpr).close.verdict).toBe("refuse");
    });

    test("a reload after the first load settles a refusal and leaves a trace", () => {
      const { reload } = scenario(dpr);
      expect(reload.verdict).toBe("refuse");
      expect(reload.traces).toContain("approval-window: Approval window reload was refused");
    });

    test("a renderer crash settles a refusal and leaves a trace", () => {
      const { crash } = scenario(dpr);
      expect(crash.verdict).toBe("refuse");
      expect(crash.traces).toContain("approval-window: Approval window renderer crashed");
    });

    test("enlarging the window until the whole request fits unlocks Approve without scrolling", () => {
      const { resize } = scenario(dpr);
      expect(resize.overflowBefore).toBe(true);
      expect(resize.disabledBefore).toBe(true);
      expect(resize.unlockedByResize).toBe(true);
      expect(resize.verdict).toBe("approve");
    });

    test("the reader follows nativeTheme in both themes, and its Refuse button settles a refusal", () => {
      const { theme } = scenario(dpr);
      expect(theme.light).toBe("light");
      expect(theme.dark).toBe("dark");
      expect(theme.darkBackground).not.toBe(theme.lightBackground);
      expect(theme.verdict).toBe("refuse");
    });

    test("no reader window outlives its verdict", () => {
      expect(scenario(dpr).openWindows).toBe(0);
    });
  });
}

test("no probe Electron, helper or Xvfb survives the scenarios", async () => {
  await Promise.all(children.map((child) => stop(child)));
  const deadline = Date.now() + 5_000;
  let tagged = countTagged();
  while (tagged > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    tagged = countTagged();
  }
  const xvfb = countXvfb();
  console.log(`approval reader processes after the scenarios: ${JSON.stringify({ tagged, xvfbBaseline, xvfb })}`);
  expect(tagged).toBe(0);
  expect(xvfb).toBe(xvfbBaseline);
}, 15_000);
