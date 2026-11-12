import { validatePeerTelemetrySnapshot, type PeerTelemetrySnapshot } from "./peer-telemetry.ts";

export interface PeerTelemetryLink {
  instanceToken: string;
  operatorId: string;
  runRef: string;
  groupId: string;
  deskSessionHash: string;
  capabilityHash: string;
}

export interface PeerTelemetryLaunch extends Omit<PeerTelemetryLink, "instanceToken"> {}

export interface PeerTelemetryPublish extends PeerTelemetryLaunch {
  snapshot: PeerTelemetrySnapshot;
}

export interface PeerTelemetryRun {
  operatorId: string;
  runRef: string;
  groupId: string;
}

export type PeerTelemetryPublishResult =
  | { outcome: "updated" }
  | { outcome: "unchanged" }
  | { outcome: "stale" }
  | { outcome: "conflict" }
  | { outcome: "unattributed" }
  | { outcome: "ambiguous" }
  | { outcome: "closed" };

export interface PeerTelemetryRegistry {
  register(link: PeerTelemetryLink): void;
  publish(input: PeerTelemetryPublish): PeerTelemetryPublishResult;
  stop(launch: PeerTelemetryLaunch): void;
  forgetOwner(instanceToken: string): void;
  forgetRun(run: PeerTelemetryRun): void;
  runs(): PeerTelemetryRun[];
  telemetryFor(instanceToken: string): PeerTelemetrySnapshot | null;
}

export interface PeerTelemetryRegistryDeps {
  isLive(instanceToken: string): boolean;
}

export const MAX_CLOSED_LAUNCHES_PER_DESK = 32;
export const MAX_CLOSED_DESKS_PER_RUN = 32;

interface ClosedDesk {
  launches: Set<string>;
  wholeDesk: boolean;
}

interface ClosedRun {
  run: PeerTelemetryRun;
  desks: Map<string, ClosedDesk>;
  wholeRun: boolean;
}

function runKey(run: PeerTelemetryRun): string {
  return `${run.operatorId}\u0000${run.runRef}\u0000${run.groupId}`;
}

function launchKey(link: Omit<PeerTelemetryLink, "instanceToken">): string {
  return `${runKey(link)}\u0000${link.deskSessionHash}\u0000${link.capabilityHash}`;
}

function sameSnapshot(a: PeerTelemetrySnapshot, b: PeerTelemetrySnapshot): boolean {
  return (
    a.model === b.model &&
    a.modelId === b.modelId &&
    a.contextPct === b.contextPct &&
    a.contextWindow === b.contextWindow &&
    a.observedAt === b.observedAt
  );
}

export function createPeerTelemetryRegistry(deps: PeerTelemetryRegistryDeps): PeerTelemetryRegistry {
  const links = new Map<string, PeerTelemetryLink>();
  const snapshots = new Map<string, PeerTelemetrySnapshot>();
  const closed = new Map<string, ClosedRun>();

  const isClosed = (launch: PeerTelemetryLaunch): boolean => {
    const entry = closed.get(runKey(launch));
    if (entry === undefined) return false;
    if (entry.wholeRun) return true;
    const desk = entry.desks.get(launch.deskSessionHash);
    return desk !== undefined && (desk.wholeDesk || desk.launches.has(launch.capabilityHash));
  };

  const candidates = (key: string): string[] => {
    const tokens: string[] = [];
    for (const [token, link] of links) {
      if (launchKey(link) === key && deps.isLive(token)) tokens.push(token);
    }
    return tokens;
  };

  const clearLaunch = (key: string): void => {
    for (const token of candidates(key)) snapshots.delete(token);
  };

  return {
    register(link): void {
      if (isClosed(link)) {
        links.delete(link.instanceToken);
        snapshots.delete(link.instanceToken);
        return;
      }
      const prior = links.get(link.instanceToken);
      links.set(link.instanceToken, link);
      if (!prior || launchKey(prior) !== launchKey(link)) clearLaunch(launchKey(link));
    },
    publish(input): PeerTelemetryPublishResult {
      if (isClosed(input)) return { outcome: "closed" };
      const tokens = candidates(launchKey(input));
      if (tokens.length === 0) return { outcome: "unattributed" };
      if (tokens.length !== 1) {
        clearLaunch(launchKey(input));
        return { outcome: "ambiguous" };
      }
      const token = tokens[0]!;
      const current = snapshots.get(token);
      if (!current) {
        snapshots.set(token, input.snapshot);
        return { outcome: "updated" };
      }
      if (input.snapshot.observedAt < current.observedAt) return { outcome: "stale" };
      if (input.snapshot.observedAt === current.observedAt) {
        return sameSnapshot(current, input.snapshot) ? { outcome: "unchanged" } : { outcome: "conflict" };
      }
      snapshots.set(token, input.snapshot);
      return { outcome: "updated" };
    },
    stop(launch): void {
      const key = launchKey(launch);
      const rk = runKey(launch);
      let entry = closed.get(rk);
      if (!entry) {
        entry = {
          run: { operatorId: launch.operatorId, runRef: launch.runRef, groupId: launch.groupId },
          desks: new Map(),
          wholeRun: false,
        };
        closed.set(rk, entry);
      }
      if (!entry.wholeRun) {
        let desk = entry.desks.get(launch.deskSessionHash);
        if (!desk) {
          desk = { launches: new Set(), wholeDesk: false };
          entry.desks.set(launch.deskSessionHash, desk);
        }
        if (!desk.wholeDesk && !desk.launches.has(launch.capabilityHash)) {
          if (desk.launches.size >= MAX_CLOSED_LAUNCHES_PER_DESK) {
            desk.wholeDesk = true;
            desk.launches.clear();
            let wholeDesks = 0;
            for (const d of entry.desks.values()) if (d.wholeDesk) wholeDesks++;
            if (wholeDesks > MAX_CLOSED_DESKS_PER_RUN) {
              entry.wholeRun = true;
              entry.desks.clear();
            }
          } else desk.launches.add(launch.capabilityHash);
        }
      }
      for (const token of candidates(key)) snapshots.delete(token);
    },
    forgetOwner(instanceToken): void {
      links.delete(instanceToken);
      snapshots.delete(instanceToken);
    },
    forgetRun(run): void {
      const key = runKey(run);
      closed.delete(key);
      for (const [token, link] of links) {
        if (runKey(link) === key) {
          links.delete(token);
          snapshots.delete(token);
        }
      }
    },
    runs(): PeerTelemetryRun[] {
      const found = new Map<string, PeerTelemetryRun>();
      for (const [key, entry] of closed) found.set(key, entry.run);
      for (const link of links.values()) {
        found.set(runKey(link), { operatorId: link.operatorId, runRef: link.runRef, groupId: link.groupId });
      }
      return [...found.values()];
    },
    telemetryFor(instanceToken): PeerTelemetrySnapshot | null {
      const link = links.get(instanceToken);
      if (!link || isClosed(link)) return null;
      const tokens = candidates(launchKey(link));
      if (tokens.length !== 1 || tokens[0] !== instanceToken) return null;
      return snapshots.get(instanceToken) ?? null;
    },
  };
}

export type PeerTelemetryRefusalReason = "invalid" | "stale" | "conflict";

export const MAX_REPORTED_TELEMETRY_REFUSALS = 8;

export interface PeerTelemetryImportResult {
  refusedCount: number;
  refused: { token: string; reason: PeerTelemetryRefusalReason }[];
}

export interface PeerTelemetryImportCache {
  applyNamespace(namespace: string, directory: ReadonlyMap<string, unknown>): PeerTelemetryImportResult;
  removeToken(namespace: string, token: string): void;
  removeNamespace(namespace: string): void;
  read(namespace: string, token: string): PeerTelemetrySnapshot | null;
}

function copySnapshot(snapshot: PeerTelemetrySnapshot): PeerTelemetrySnapshot {
  return {
    model: snapshot.model,
    modelId: snapshot.modelId,
    contextPct: snapshot.contextPct,
    contextWindow: snapshot.contextWindow,
    observedAt: snapshot.observedAt,
  };
}

export function createPeerTelemetryImportCache(): PeerTelemetryImportCache {
  const directories = new Map<string, Map<string, PeerTelemetrySnapshot>>();

  return {
    applyNamespace(namespace, directory): PeerTelemetryImportResult {
      const current = directories.get(namespace);
      const next = new Map<string, PeerTelemetrySnapshot>();
      const refused: PeerTelemetryImportResult["refused"] = [];
      let refusedCount = 0;
      const refuse = (token: string, reason: PeerTelemetryRefusalReason): void => {
        refusedCount++;
        if (refused.length < MAX_REPORTED_TELEMETRY_REFUSALS) refused.push({ token, reason });
        const visible = current?.get(token);
        if (visible) next.set(token, visible);
      };
      for (const [token, raw] of directory) {
        const snapshot = validatePeerTelemetrySnapshot(raw);
        if (!snapshot) {
          refuse(token, "invalid");
          continue;
        }
        const visible = current?.get(token);
        if (visible && snapshot.observedAt < visible.observedAt) {
          refuse(token, "stale");
          continue;
        }
        if (visible && snapshot.observedAt === visible.observedAt && !sameSnapshot(visible, snapshot)) {
          refuse(token, "conflict");
          continue;
        }
        next.set(token, copySnapshot(snapshot));
      }
      directories.set(namespace, next);
      return { refusedCount, refused };
    },
    removeToken(namespace, token): void {
      const directory = directories.get(namespace);
      if (!directory) return;
      directory.delete(token);
    },
    removeNamespace(namespace): void {
      directories.delete(namespace);
    },
    read(namespace, token): PeerTelemetrySnapshot | null {
      const snapshot = directories.get(namespace)?.get(token);
      return snapshot ? copySnapshot(snapshot) : null;
    },
  };
}
