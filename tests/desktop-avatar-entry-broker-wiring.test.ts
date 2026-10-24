import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { brokerStopDialogOptions, confirmedStop } from "../desktop/src/main/avatar-broker-wiring.ts";
import { AVATAR_TRAY_COPY } from "../desktop/src/main/avatar-tray-copy.ts";
import { extractParenBody } from "./_braced-body.ts";

const ENTRY = resolve(import.meta.dir, "../desktop/src/main/avatar-entry.ts");
const source = (): string => readFileSync(ENTRY, "utf8").replace(/\r\n/g, "\n");
const code = (): string => new Bun.Transpiler({ loader: "ts" }).transformSync(source());

function braced(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  throw new Error("unterminated");
}

function entryConfirm(dialog: unknown): (details: unknown) => Promise<boolean> {
  const text = source();
  const anchor = text.indexOf("const brokerControl = createAvatarBrokerControl({");
  const marker = "    confirm: async (details) => ";
  const start = anchor < 0 ? -1 : text.indexOf(marker, anchor);
  if (start < 0) throw new Error("avatar-entry.ts: the broker control confirm callback is unavailable");
  const body = braced(text, start + marker.length);
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(`export const f = async (details: any) => ${body}`).replace("export const f = ", "return ");
  return new Function("dialog", "brokerStopDialogOptions", "confirmedStop", "AVATAR_TRAY_COPY", "locale", js)(
    dialog, brokerStopDialogOptions, confirmedStop, AVATAR_TRAY_COPY, "en"
  ) as (details: unknown) => Promise<boolean>;
}

test("the Avatar's stop confirmation shows the Cancel-first dialog and stops only on the explicit Stop", async () => {
  const shown: Array<Record<string, unknown>> = [];
  let response = 1;
  const confirm = entryConfirm({ showMessageBox: async (options: Record<string, unknown>) => { shown.push(options); return { response }; } });
  const details = { url: "http://127.0.0.1:7899", pid: 42, decks: 1 };
  expect(await confirm(details)).toBe(false);
  response = 0;
  expect(await confirm(details)).toBe(true);
  expect(shown[0]).toMatchObject({ defaultId: 1, cancelId: 1, noLink: true });
});

test("the Avatar re-reads the manual stop from both the broker probe and the Tray, and asks /health on the inspected port", () => {
  const js = code();
  expect(js).toMatch(/brokerUrls:\s*probeBrokerUrls\(refreshManualStop,/);
  expect(js).toMatch(/summary:\s*trayBrokerSummary\(refreshManualStop,/);
  expect(js).toMatch(/brokerHealth:\s*\(port\)\s*=>\s*fetchBrokerHealth\(port,/);
});

test("the Avatar server resolves its broker allow-list through the link policy", () => {
  const entry = code();
  const start = entry.indexOf("server = await startAvatarServer(");
  expect(start, "avatar-entry.ts: server startup anchor is unavailable").toBeGreaterThanOrEqual(0);
  const body = extractParenBody(entry, entry.indexOf("(", start));
  expect(body).toContain("allowedBrokerUrls: () => avatarAllowedBrokerUrls(resolveBrokerEndpoint().url)");
});
