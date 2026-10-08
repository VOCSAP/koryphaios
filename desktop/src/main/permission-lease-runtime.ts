import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  encodePermissionLeaseDescriptor,
  PERMISSION_LEASE_FRESHNESS_MS,
  type PermissionLeaseDescriptor,
  type PermissionLeaseDocument,
  type PermissionLeaseIdentity,
} from "../../shared/permission-lease";

export const PERMISSION_LEASE_PULSE_MS = 2_000;

type LeaseTimer = unknown;

export interface PermissionLeaseHandle extends PermissionLeaseIdentity {
  file: string;
  revoked: boolean;
  sequence: number;
  writtenAtMs: number;
  timer: LeaseTimer | null;
}

export interface PermissionLeaseRuntimeOptions {
  stateDir: string;
  runId: string;
  now?: () => number;
  setInterval?: (tick: () => void, delayMs: number) => LeaseTimer;
  clearInterval?: (timer: LeaseTimer) => void;
  rename?: (from: string, to: string) => void;
  reportError: (message: string, error: unknown) => void;
}

export class PermissionLeaseRuntime {
  private readonly handles = new Map<string, PermissionLeaseHandle>();
  private readonly now: () => number;
  private readonly schedule: (tick: () => void, delayMs: number) => LeaseTimer;
  private readonly cancel: (timer: LeaseTimer) => void;
  private readonly rename: (from: string, to: string) => void;
  private readonly reportError: (message: string, error: unknown) => void;

  constructor(private readonly options: PermissionLeaseRuntimeOptions) {
    this.now = options.now ?? Date.now;
    this.schedule = options.setInterval ?? ((tick, delayMs) => setInterval(tick, delayMs));
    this.cancel = options.clearInterval ?? ((timer) => clearInterval(timer as NodeJS.Timeout));
    this.rename = options.rename ?? renameSync;
    this.reportError = options.reportError;
  }

  createLease(tileId: string): PermissionLeaseHandle {
    this.revokeForTile(tileId);
    const launchId = randomUUID();
    const file = join(this.options.stateDir, "permission-leases", this.options.runId, tileId, `${launchId}.json`);
    const handle: PermissionLeaseHandle = {
      runId: this.options.runId,
      tileId,
      launchId,
      file,
      revoked: false,
      sequence: 0,
      writtenAtMs: 0,
      timer: null,
    };
    this.handles.set(tileId, handle);
    try {
      this.write(handle);
      handle.timer = this.schedule(() => this.pulse(handle), PERMISSION_LEASE_PULSE_MS);
      return handle;
    } catch (error) {
      this.revoke(handle);
      throw error;
    }
  }

  descriptor(handle: PermissionLeaseHandle): string {
    const descriptor: PermissionLeaseDescriptor = {
      file: handle.file,
      runId: handle.runId,
      tileId: handle.tileId,
      launchId: handle.launchId,
    };
    return encodePermissionLeaseDescriptor(descriptor);
  }

  revokeForTile(tileId: string): void {
    const handle = this.handles.get(tileId);
    if (handle) this.revoke(handle);
  }

  revokeAll(): void {
    for (const handle of [...this.handles.values()]) this.revoke(handle);
  }

  revoke(handle: PermissionLeaseHandle): void {
    if (handle.revoked) return;
    handle.revoked = true;
    if (handle.timer !== null) this.cancel(handle.timer);
    handle.timer = null;
    if (this.handles.get(handle.tileId) === handle) this.handles.delete(handle.tileId);
    try {
      rmSync(handle.file, { force: true });
    } catch (error) {
      this.reportError(`permission lease removal failed for ${handle.tileId}`, error);
    }
  }

  private pulse(handle: PermissionLeaseHandle): void {
    if (handle.revoked || this.handles.get(handle.tileId) !== handle) return;
    try {
      this.write(handle);
    } catch (error) {
      this.reportError(`permission lease pulse failed for ${handle.tileId}`, error);
      if (this.now() - handle.writtenAtMs > PERMISSION_LEASE_FRESHNESS_MS) this.revoke(handle);
    }
  }

  private permissionLeaseTemporaryFile(handle: PermissionLeaseHandle, sequence: number): string {
    return `${handle.file}.${sequence}.tmp`;
  }

  private write(handle: PermissionLeaseHandle): void {
    const document: PermissionLeaseDocument = {
      version: 1,
      runId: handle.runId,
      tileId: handle.tileId,
      launchId: handle.launchId,
      sequence: handle.sequence + 1,
      writtenAtMs: this.now(),
    };
    mkdirSync(join(this.options.stateDir, "permission-leases", handle.runId, handle.tileId), { recursive: true });
    const temporary = this.permissionLeaseTemporaryFile(handle, document.sequence);
    try {
      writeFileSync(temporary, JSON.stringify(document), { encoding: "utf8", mode: 0o600 });
      this.rename(temporary, handle.file);
    } catch (error) {
      try {
        rmSync(temporary, { force: true });
      } catch (cleanupError) {
        this.reportError(`permission lease temporary removal failed for ${handle.tileId}`, cleanupError);
      }
      throw error;
    }
    handle.sequence = document.sequence;
    handle.writtenAtMs = document.writtenAtMs;
  }
}
