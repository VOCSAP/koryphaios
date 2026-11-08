import type { BrokerMode } from "./broker-config.ts";
import type { WriterGeneration } from "./peer-cache.ts";

export type SignalProbe = (pid: number, signal: 0) => unknown;

const processProbe: SignalProbe = (pid, signal) => process.kill(pid, signal);

/**
 * True when the process exists. EPERM means it exists under another account.
 * A pid that is not a positive integer is never alive: kill(0, 0) signals the
 * caller's whole process group and would succeed.
 */
export function pidExists(pid: number, probe: SignalProbe = processProbe): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    probe(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

export interface PeerPid {
  host: string;
  pid: number;
}

export interface PeerOrigin {
  relay_id: string | null;
  via: string | null;
}

/** A row the broker registered itself, as opposed to one relayed or mirrored from another broker. */
export function isLocalRow(row: PeerOrigin): boolean {
  return row.relay_id === null && row.via === null;
}

/** The broker can only probe a pid that lives on its own host. */
export function relayPidAlive(row: PeerPid, brokerHost: string, probe?: SignalProbe): boolean {
  return row.host === brokerHost && pidExists(row.pid, probe);
}

/** The form a relay sends as `pid_generation` and the sweep compares against a fresh measure. */
export function canonicalWriterGeneration(generation: WriterGeneration): string {
  return generation.platform === "win32"
    ? JSON.stringify({ platform: generation.platform, pid: generation.pid, creationUtc: generation.creationUtc })
    : JSON.stringify({
        platform: generation.platform,
        pid: generation.pid,
        startToken: generation.startToken,
        bootId: generation.bootId,
      });
}

export type MeasureGeneration = (pid: number) => Promise<WriterGeneration | null>;

export type SweepCandidate = PeerPid & PeerOrigin & { pid_generation: string | null };

/** The cheap half of the sweep exemption: everything that needs no measure of the process. */
export function mayStayActiveWithoutHeartbeat(
  mode: BrokerMode,
  row: SweepCandidate,
  brokerHost: string,
  probe?: SignalProbe
): boolean {
  return mode !== "remote" && isLocalRow(row) && row.pid_generation !== null && relayPidAlive(row, brokerHost, probe);
}

/**
 * Sweep exemption: a local relay whose pid is alive AND still the process that
 * registered keeps its peer active without heartbeat. A row without a stored
 * generation, or one the platform cannot measure, gets no exemption: a reused
 * pid would otherwise keep a dead relay's row active.
 */
export async function keepsActiveWithoutHeartbeat(
  mode: BrokerMode,
  row: SweepCandidate,
  brokerHost: string,
  measure: MeasureGeneration,
  probe?: SignalProbe
): Promise<boolean> {
  if (!mayStayActiveWithoutHeartbeat(mode, row, brokerHost, probe)) return false;
  const measured = await measure(row.pid);
  return measured !== null && canonicalWriterGeneration(measured) === row.pid_generation;
}

export interface ResumeCandidate extends PeerPid, PeerOrigin {
  group_id: string;
  pid_generation: string | null;
}

export interface ResumeClaim extends PeerPid {
  group_id: string;
  pid_generation: string | null;
}

export type ResumeRefusal = "not_local" | "group" | "host" | "pid" | "generation" | "pid_dead";

/**
 * Rules R1 to R3 of a resume by token. A row that carries a generation refuses
 * a claim without one, so omitting the field cannot skip the comparison.
 */
export function resumeRefusal(
  row: ResumeCandidate,
  claim: ResumeClaim,
  brokerHost: string,
  probe?: SignalProbe
): ResumeRefusal | null {
  if (!isLocalRow(row)) return "not_local";
  if (row.group_id !== claim.group_id) return "group";
  if (row.host !== claim.host) return "host";
  if (row.pid !== claim.pid) return "pid";
  if (row.pid_generation !== null && row.pid_generation !== claim.pid_generation) return "generation";
  if (row.host === brokerHost && !pidExists(claim.pid, probe)) return "pid_dead";
  return null;
}
