import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const rendererDep = join(REPO, "desktop", "node_modules", "qrcode-generator");

function runProbe(lines: string[]): unknown {
  expect(
    existsSync(rendererDep),
    `the App probe imports the renderer tree, which needs ${rendererDep}: run npm install in desktop/ first`,
  ).toBe(true);
  const dir = mkdtempSync(join(tmpdir(), "operator-trust-app-probe-"));
  try {
    const probe = join(dir, "probe.ts");
    writeFileSync(probe, lines.join("\n"));
    const tsconfig = join(REPO, "desktop", "tsconfig.web.json");
    const r = Bun.spawnSync([process.execPath, `--tsconfig-override=${tsconfig}`, "run", probe]);
    expect(r.exitCode, `probe failed: ${r.stderr.toString()}`).toBe(0);
    return JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const storePath = resolve(import.meta.dir, "../desktop/src/renderer/src/store.ts").replaceAll("\\", "/");
const appPath = resolve(import.meta.dir, "../desktop/src/renderer/src/components/App.tsx").replaceAll("\\", "/");
const harnessPath = resolve(import.meta.dir, "../desktop/tests-support/react-test-harness.ts").replaceAll("\\", "/");

test.each([["desktop"], ["mobile"]] as const)("App, %s shell: Details on the banner opens the dialog", (shell) => {
  const out = runProbe([
    "import { GlobalRegistrator } from '@happy-dom/global-registrator';",
    "GlobalRegistrator.register();",
    "const api = new Proxy({}, { get: (_t, key) => {",
    "  if (typeof key !== 'string') return undefined;",
    "  if (key.startsWith('on')) return () => () => {};",
    "  if (key === 'reportError') return () => {};",
    "  return () => Promise.resolve(undefined);",
    "} });",
    "(window as unknown as { api: unknown }).api = api;",
    `const { act, React, createRoot } = await import(${JSON.stringify(harnessPath)});`,
    `const { useDeck } = await import(${JSON.stringify(storePath)});`,
    `const { App } = await import(${JSON.stringify(appPath)});`,
    "const el = document.createElement('div');",
    "document.body.appendChild(el);",
    "const root = createRoot(el);",
    "useDeck.setState({ config: {} as never });",
    "await act(async () => root.render(React.createElement(App)));",
    // init() runs from App's first effect and recomputes `mobile`, so the shell is chosen after it.
    `await act(async () => useDeck.setState({ config: {} as never, mobile: ${shell === "mobile"}, operatorTrustStatus: { state: 'not-trusted', fingerprint: 'a'.repeat(64) } }));`,
    "const before = !!el.querySelector('.operator-trust-modal');",
    "const details = [...el.querySelectorAll('.status-banner-action')].find((b) => b.textContent === 'banner.operatorDetails') as HTMLButtonElement | undefined;",
    "await act(async () => details?.click());",
    "console.log(JSON.stringify({ shell: el.querySelector('.app-mobile') ? 'mobile' : 'desktop', details: !!details, before, after: !!el.querySelector('.operator-trust-modal') }));",
    "process.exit(0);",
  ]);
  expect(out, "the dialog opens from the banner in this shell").toEqual({
    shell,
    details: true,
    before: false,
    after: true,
  });
});
