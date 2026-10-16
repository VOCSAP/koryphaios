// A broker the operator stopped on purpose stays stopped until Start clears
// this marker: every launcher reads it before spawning. A marker that cannot be
// read or parsed still means stopped, so a corrupted file never relaunches a
// broker the operator turned off.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const BROKER_STOP_MARKER_FILE = "broker-stopped.json";

export interface BrokerStopMarker {
  stopped_at: string;
  by: string;
  killed_pid: number | null;
}

export type BrokerStopReading =
  | { stopped: false }
  | { stopped: true; marker: BrokerStopMarker }
  | { stopped: true; marker: null; problem: string };

export function brokerStopMarkerPath(configPath: string): string {
  return join(dirname(configPath), BROKER_STOP_MARKER_FILE);
}

function parseMarker(raw: string): BrokerStopMarker | string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    return `not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "not a JSON object";
  const { stopped_at, by, killed_pid } = value as Record<string, unknown>;
  if (typeof stopped_at !== "string" || !stopped_at) return "stopped_at is missing";
  if (typeof by !== "string") return "by is missing";
  if (killed_pid !== null && !(typeof killed_pid === "number" && Number.isSafeInteger(killed_pid) && killed_pid > 0)) {
    return "killed_pid is neither null nor a positive integer";
  }
  return { stopped_at, by, killed_pid };
}

export function readBrokerStopMarker(markerPath: string): BrokerStopReading {
  let raw: string;
  try {
    raw = readFileSync(markerPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { stopped: false };
    return { stopped: true, marker: null, problem: `cannot be read: ${e instanceof Error ? e.message : String(e)}` };
  }
  const parsed = parseMarker(raw);
  return typeof parsed === "string" ? { stopped: true, marker: null, problem: parsed } : { stopped: true, marker: parsed };
}

export function writeBrokerStopMarker(markerPath: string, marker: BrokerStopMarker): void {
  mkdirSync(dirname(markerPath), { recursive: true });
  const temporary = `${markerPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(marker));
  try {
    renameSync(temporary, markerPath);
  } catch (e) {
    rmSync(temporary, { force: true });
    throw e;
  }
}

export function clearBrokerStopMarker(markerPath: string): void {
  rmSync(markerPath, { force: true });
}
