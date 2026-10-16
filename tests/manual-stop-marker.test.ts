import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { peersConfigPath } from "../desktop/src/main/broker-client.ts";
import {
  brokerStopMarkerPath,
  clearBrokerStopMarker,
  readBrokerStopMarker,
  writeBrokerStopMarker,
} from "../shared/broker-stop-marker.ts";
import { settingsFilePath } from "../shared/config.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function markerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cp-broker-stop-"));
  dirs.push(dir);
  return brokerStopMarkerPath(join(dir, "claude-peers", "config.json"));
}

test("the marker sits next to the global config.json", () => {
  expect(brokerStopMarkerPath(join("cfg", "claude-peers", "config.json"))).toBe(join("cfg", "claude-peers", "broker-stopped.json"));
});

test("an absent marker reads as not stopped", () => {
  expect(readBrokerStopMarker(markerPath())).toEqual({ stopped: false });
});

test("a written marker reads back as stopped, then clearing it reads as not stopped", () => {
  const path = markerPath();
  const marker = { stopped_at: "2026-10-16T19:00:00.000Z", by: "avatar-tray", killed_pid: 4242 };

  writeBrokerStopMarker(path, marker);
  expect(readBrokerStopMarker(path)).toEqual({ stopped: true, marker });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(marker);

  clearBrokerStopMarker(path);
  expect(readBrokerStopMarker(path)).toEqual({ stopped: false });
  clearBrokerStopMarker(path);
});

test.each([
  ["empty", ""],
  ["not JSON", "{stopped"],
  ["an array", "[]"],
  ["no stopped_at", JSON.stringify({ by: "avatar-tray", killed_pid: null })],
  ["a non-integer pid", JSON.stringify({ stopped_at: "2026-10-16T19:00:00.000Z", by: "avatar-tray", killed_pid: 1.5 })],
])("a malformed marker (%s) still reads as stopped, with the problem named", (_name, content) => {
  const path = markerPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);

  const reading = readBrokerStopMarker(path);
  expect(reading.stopped).toBe(true);
  expect(reading).toMatchObject({ marker: null, problem: expect.any(String) });
});

test("stopping twice rewrites the existing marker in place", () => {
  const path = markerPath();
  writeBrokerStopMarker(path, { stopped_at: "2026-10-16T19:00:00.000Z", by: "avatar-tray", killed_pid: 4242 });
  const second = { stopped_at: "2026-10-16T19:05:00.000Z", by: "avatar-tray", killed_pid: null };

  writeBrokerStopMarker(path, second);

  expect(readBrokerStopMarker(path)).toEqual({ stopped: true, marker: second });
  expect(readdirSync(join(path, "..")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("a write whose final rename fails throws and leaves no temporary file behind", () => {
  const path = markerPath();
  mkdirSync(path, { recursive: true });

  expect(() => writeBrokerStopMarker(path, { stopped_at: "2026-10-16T19:00:00.000Z", by: "avatar-tray", killed_pid: null })).toThrow();
  expect(readdirSync(join(path, "..")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("server.ts and the Deck resolve the same marker path, whatever the config environment", () => {
  const saved = { APPDATA: process.env.APPDATA, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  const restore = (key: "APPDATA" | "XDG_CONFIG_HOME", value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  try {
    for (const env of [
      { APPDATA: join("C:", "appdata"), XDG_CONFIG_HOME: undefined },
      { APPDATA: undefined, XDG_CONFIG_HOME: join("/", "xdg") },
      { APPDATA: undefined, XDG_CONFIG_HOME: undefined },
    ]) {
      restore("APPDATA", env.APPDATA);
      restore("XDG_CONFIG_HOME", env.XDG_CONFIG_HOME);
      expect(brokerStopMarkerPath(settingsFilePath()), JSON.stringify(env)).toBe(brokerStopMarkerPath(peersConfigPath(process.env)));
    }
  } finally {
    restore("APPDATA", saved.APPDATA);
    restore("XDG_CONFIG_HOME", saved.XDG_CONFIG_HOME);
  }
});

test("an unreadable marker (a directory) reads as stopped", () => {
  const path = markerPath();
  mkdirSync(path, { recursive: true });

  expect(readBrokerStopMarker(path)).toMatchObject({ stopped: true, marker: null, problem: expect.any(String) });
});
