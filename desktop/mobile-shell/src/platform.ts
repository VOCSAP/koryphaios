// The seam between the shell's logic and the device (PLAN N5 / MB6).
//
// Everything native is reached through this file, and everything in it has a
// browser fallback, for one practical reason: the Android SDK is not present
// in the CI/dev container, so the whole flow has to be exercisable in a plain
// browser. What cannot be faked (a foreground service surviving Doze) is
// declared here as a capability the app reads, and degraded gracefully.

import type { KeyValueStore } from "./storage.ts";
import { MemoryStore } from "./storage.ts";

interface CapacitorPlugins {
  Preferences?: {
    get(o: { key: string }): Promise<{ value: string | null }>;
    set(o: { key: string; value: string }): Promise<void>;
    remove(o: { key: string }): Promise<void>;
  };
  /**
   * `@capacitor/barcode-scanner`.
   *
   * The name matters and is not the package name: the plugin calls
   * `registerPlugin("CapacitorBarcodeScanner", …)`, so that — not
   * `BarcodeScanner` — is the key it lands under in the registry. Getting it
   * wrong is silent: the lookup returns `undefined` and `scanQr` falls back to
   * `prompt()` forever, on a device as in a browser.
   */
  CapacitorBarcodeScanner?: {
    scanBarcode(o: { hint: number }): Promise<{ ScanResult?: string }>;
  };
  /** Our own plugin — see android-src/. Absent in a browser. */
  ParastatesShell?: {
    startApprovalService(o: { server: string; topic: string; token: string }): Promise<void>;
    stopApprovalService(): Promise<void>;
    openHost(o: { url: string; fingerprint: string; seedScript: string }): Promise<void>;
    deviceName(): Promise<{ name: string }>;
  };
}

declare global {
  interface Window {
    Capacitor?: { Plugins?: CapacitorPlugins };
  }
}

function plugins(): CapacitorPlugins {
  return (typeof window !== "undefined" && window.Capacitor?.Plugins) || {};
}

/**
 * A synchronous store backed by an async one.
 *
 * Capacitor Preferences is promise-based, so the app hydrates once at start-up
 * and writes through afterwards. Keeping the seam synchronous is what lets the
 * state modules be plain functions over a snapshot instead of a chain of
 * awaits — and what makes them testable with a Map.
 */
export class WriteThroughStore implements KeyValueStore {
  private readonly memory: MemoryStore;

  constructor(
    initial: Record<string, string>,
    private readonly flush: (key: string, value: string | null) => void
  ) {
    this.memory = new MemoryStore(initial);
  }

  get(key: string): string | null {
    return this.memory.get(key);
  }

  set(key: string, value: string): void {
    this.memory.set(key, value);
    this.flush(key, value);
  }

  remove(key: string): void {
    this.memory.remove(key);
    this.flush(key, null);
  }

  /**
   * Adopt a value written OUTSIDE this store, without echoing it back.
   *
   * The native viewer writes the harvested credential straight to the
   * preferences while the shell is backgrounded, so the in-memory copy is
   * stale on resume. Flushing here would just write back what we read.
   */
  hydrate(key: string, value: string | null): void {
    if (value === null) this.memory.remove(key);
    else this.memory.set(key, value);
  }
}

const KNOWN_KEYS = [
  "koryphaios.companion.hosts",
  "koryphaios.companion.selected",
  // Written by the NATIVE viewer between two runs of this code, so it has to
  // be hydrated like the rest — the app reads it on boot and on every resume.
  "koryphaios.companion.lastcred",
  "koryphaios.companion.lastpin",
  "koryphaios.approvals.pairing",
  "koryphaios.approvals.inbox",
];

/** Hydrate the store: Capacitor Preferences on device, localStorage in a browser. */
export async function openStore(): Promise<KeyValueStore> {
  const prefs = plugins().Preferences;
  if (prefs) {
    const initial: Record<string, string> = {};
    for (const key of KNOWN_KEYS) {
      try {
        const { value } = await prefs.get({ key });
        if (value !== null) initial[key] = value;
      } catch {
        /* a missing key is not an error */
      }
    }
    return new WriteThroughStore(initial, (key, value) => {
      void (value === null ? prefs.remove({ key }) : prefs.set({ key, value })).catch(() => undefined);
    });
  }

  if (typeof localStorage !== "undefined") {
    const initial: Record<string, string> = {};
    for (const key of KNOWN_KEYS) {
      const value = localStorage.getItem(key);
      if (value !== null) initial[key] = value;
    }
    return new WriteThroughStore(initial, (key, value) => {
      try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch {
        /* private mode / quota: the session still works, it just forgets */
      }
    });
  }
  return new MemoryStore();
}

/**
 * Re-read one key that something outside this process may have changed.
 *
 * Only the native viewer's credential drop box needs this today; it is written
 * while the shell is backgrounded, so the shell must go back to the source on
 * resume rather than trust its snapshot.
 */
export async function reloadKey(store: KeyValueStore, key: string): Promise<void> {
  if (!(store instanceof WriteThroughStore)) return;
  const prefs = plugins().Preferences;
  if (prefs) {
    try {
      const { value } = await prefs.get({ key });
      store.hydrate(key, value);
    } catch {
      /* a missing key is not an error */
    }
    return;
  }
  if (typeof localStorage !== "undefined") store.hydrate(key, localStorage.getItem(key));
}

/**
 * Inlined value of CapacitorBarcodeScannerTypeHintALLOption.ALL rather than
 * importing the plugin's enum, which would pull html5-qrcode (its web
 * implementation) into an otherwise 15 KB dependency-free bundle.
 * ALL rather than QR_CODE (0), even though a pairing QR is all this app ever
 * scans: the hint crosses to Kotlin as an ordinal into a prebuilt-AAR enum, and
 * an out-of-range ALL degrades to "scan everything" while a wrong 0 silently
 * selects some other format and the QR then never scans, on device only.
 * 0 is also falsy, so any `hint || default` on the way through would erase it —
 * nothing in the current chain does that, but ALL costs nothing and does not
 * depend on it staying that way.
 */
const BARCODE_HINT_ALL = 17;

/**
 * Scan a QR. Falls back to a prompt so both pairing flows can be walked
 * through in a browser with no camera.
 */
export async function scanQr(message: string): Promise<string | null> {
  const scanner = plugins().CapacitorBarcodeScanner;
  if (scanner) {
    try {
      const res = await scanner.scanBarcode({ hint: BARCODE_HINT_ALL });
      return res?.ScanResult ?? null;
    } catch {
      // A cancelled scan is not an error worth surfacing.
      return null;
    }
  }
  return typeof prompt === "function" ? prompt(message) : null;
}

export async function deviceName(): Promise<string> {
  try {
    const name = await plugins().ParastatesShell?.deviceName();
    if (name?.name) return name.name;
  } catch {
    /* fall through */
  }
  return "phone";
}

/**
 * Ask the native side to keep listening while the screen is off.
 *
 * This is the piece a browser cannot have: Doze suspends network access and
 * ignores wakelocks, so passive listening needs a foreground service with a
 * declared type. `dataSync` is capped at 6 h/24 h since Android 15, hence the
 * service declares `connectedDevice` (see android-src/). When the plugin is
 * absent the app still works — in the foreground only, which is the honest
 * degradation rather than a silent one.
 */
export async function startApprovalService(o: {
  server: string;
  topic: string;
  token: string;
}): Promise<boolean> {
  const shell = plugins().ParastatesShell;
  if (!shell) return false;
  try {
    await shell.startApprovalService(o);
    return true;
  } catch {
    return false;
  }
}

export async function stopApprovalService(): Promise<void> {
  try {
    await plugins().ParastatesShell?.stopApprovalService();
  } catch {
    /* nothing to stop */
  }
}

/**
 * Open a paired Deck.
 *
 * Native: the shell installs a TrustManager pinned to `fingerprint`, seeds the
 * resume credential, and navigates. Browser: a plain navigation, which is
 * enough to exercise the flow but trusts the cert the browser trusts.
 */
export async function openHost(o: {
  url: string;
  fingerprint: string;
  seedScript: string;
}): Promise<void> {
  const shell = plugins().ParastatesShell;
  if (shell) {
    await shell.openHost(o);
    return;
  }
  if (o.seedScript && typeof sessionStorage !== "undefined") {
    // Same-origin only in a browser, so this is best effort: the host page
    // will simply ask for a fresh QR when it cannot resume.
    try {
      // eslint-disable-next-line no-new-func
      new Function(o.seedScript)();
    } catch {
      /* ignore */
    }
  }
  window.location.href = o.url;
}
