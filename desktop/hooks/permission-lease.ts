import { readFileSync } from "node:fs";
import {
  decodePermissionLeaseDescriptor,
  PERMISSION_LEASE_FRESHNESS_MS,
  parsePermissionLeaseDocument,
  samePermissionLeaseIdentity,
  type PermissionLeaseDescriptor,
  type PermissionLeaseDocument,
} from "../shared/permission-lease";

export const PERMISSION_LEASE_READ_MS = 1_000;

type LeaseTimer = unknown;

export interface PermissionLeaseReaderOptions {
  readFile?: (file: string) => string;
  wallNow?: () => number;
  monotonicNow?: () => number;
  setInterval?: (tick: () => void, delayMs: number) => LeaseTimer;
  clearInterval?: (timer: LeaseTimer) => void;
  reportError: (message: string, error: unknown) => void;
}

export interface PermissionLeaseReader {
  readonly signal: AbortSignal;
  isActive(): boolean;
  waitForAdmission(): Promise<boolean>;
  dispose(): void;
}

class LeaseReader implements PermissionLeaseReader {
  private readonly controller = new AbortController();
  private readonly readFile: (file: string) => string;
  private readonly wallNow: () => number;
  private readonly monotonicNow: () => number;
  private readonly schedule: (tick: () => void, delayMs: number) => LeaseTimer;
  private readonly cancel: (timer: LeaseTimer) => void;
  private readonly reportError: (message: string, error: unknown) => void;
  private readonly admission: Promise<boolean>;
  private resolveAdmission: ((admitted: boolean) => void) | null = null;
  private timer: LeaseTimer | null = null;
  private active = true;
  private admitted = false;
  private sequence: number;
  private progressedAt: number;

  constructor(
    private readonly descriptor: PermissionLeaseDescriptor,
    first: PermissionLeaseDocument,
    options: PermissionLeaseReaderOptions
  ) {
    this.readFile = options.readFile ?? ((file) => readFileSync(file, "utf8"));
    this.wallNow = options.wallNow ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? performance.now;
    this.schedule = options.setInterval ?? ((tick, delayMs) => setInterval(tick, delayMs));
    this.cancel = options.clearInterval ?? ((timer) => clearInterval(timer as NodeJS.Timeout));
    this.reportError = options.reportError;
    this.sequence = first.sequence;
    this.progressedAt = this.monotonicNow();
    this.admission = new Promise((resolve) => {
      this.resolveAdmission = resolve;
    });
    this.timer = this.schedule(() => this.tick(), PERMISSION_LEASE_READ_MS);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  isActive(): boolean {
    return this.active;
  }

  waitForAdmission(): Promise<boolean> {
    if (this.admitted) return Promise.resolve(true);
    if (!this.active) return Promise.resolve(false);
    return this.admission;
  }

  dispose(): void {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
  }

  private tick(): void {
    if (!this.active) return;
    const document = this.readCurrent();
    if (!document) {
      this.invalidate();
      return;
    }
    if (document.sequence < this.sequence) {
      this.invalidate();
      return;
    }
    if (document.sequence > this.sequence) {
      this.sequence = document.sequence;
      this.progressedAt = this.monotonicNow();
      if (!this.admitted) {
        this.admitted = true;
        this.resolveAdmission?.(true);
        this.resolveAdmission = null;
      }
      return;
    }
    if (this.monotonicNow() - this.progressedAt > PERMISSION_LEASE_FRESHNESS_MS) this.invalidate();
  }

  private readCurrent(): PermissionLeaseDocument | null {
    let raw: string;
    try {
      raw = this.readFile(this.descriptor.file);
    } catch (error) {
      this.reportError("permission lease read failed", error);
      return null;
    }
    const document = parsePermissionLeaseDocument(raw);
    if (!document || !samePermissionLeaseIdentity(document, this.descriptor)) return null;
    const now = this.wallNow();
    if (document.writtenAtMs > now || now - document.writtenAtMs > PERMISSION_LEASE_FRESHNESS_MS) return null;
    return document;
  }

  private invalidate(): void {
    if (!this.active) return;
    this.active = false;
    this.dispose();
    this.controller.abort();
    this.resolveAdmission?.(false);
    this.resolveAdmission = null;
  }
}

export function createPermissionLeaseReader(
  value: string | undefined,
  options: PermissionLeaseReaderOptions
): PermissionLeaseReader | null {
  const descriptor = decodePermissionLeaseDescriptor(value);
  if (!descriptor) return null;
  const readFile = options.readFile ?? ((file: string) => readFileSync(file, "utf8"));
  let raw: string;
  try {
    raw = readFile(descriptor.file);
  } catch (error) {
    options.reportError("permission lease read failed", error);
    return null;
  }
  const first = parsePermissionLeaseDocument(raw);
  const wallNow = options.wallNow ?? Date.now;
  if (
    !first ||
    !samePermissionLeaseIdentity(first, descriptor) ||
    first.writtenAtMs > wallNow() ||
    wallNow() - first.writtenAtMs > PERMISSION_LEASE_FRESHNESS_MS
  ) {
    return null;
  }
  return new LeaseReader(descriptor, first, { ...options, readFile, wallNow });
}
