// Companion pairing (LAN, screen mirroring) is deliberately separate from the
// approvals pairing (broker+ntfy, reachable anywhere): separate storage,
// lifecycles and threat models, so losing one never costs the operator the
// other.
// The stored credential is only a resume hint, not a real secret: the desktop
// wipes every credential on each companion-server start and the QR token is
// single-use, so this buys back reconnecting after an app kill during the same
// Deck run — nothing more.
// When refused, the entry survives (address and pin still correct) and only a
// fresh scan is needed.

import { isPrivateHost } from "../../../shared/net.ts";
import { COMPANION_CRED_STORAGE_KEY } from "../../src/shared/companion.ts";
import { readJson, writeJson, type KeyValueStore } from "./storage.ts";

/** Companion hosts live under their own key — see the split above. */
export const HOSTS_KEY = "koryphaios.companion.hosts";
export const SELECTED_KEY = "koryphaios.companion.selected";

/**
 * Drop box the NATIVE side writes a harvested credential into.
 *
 * The credential is minted by the host and lands in the WebView's
 * sessionStorage, which dies with the app. The native viewer reads it back out
 * and leaves it here — a single flat value — rather than editing the host list
 * itself: that keeps every rule about the list in this module, under test,
 * instead of restating it in Kotlin that nothing here compiles.
 */
export const PENDING_CRED_KEY = "koryphaios.companion.lastcred";

/**
 * Drop box for a certificate digest the native viewer observed.
 *
 * Same shape and same reason as the credential one: the viewer learns the
 * digest during the TLS handshake, and the list rules stay here. It exists
 * because trust-on-first-use is only safe if the first use is actually
 * REMEMBERED — otherwise "no fingerprint yet" means "accept anything, forever".
 */
export const PENDING_PIN_KEY = "koryphaios.companion.lastpin";

/** A phone that has collected more Decks than this is misconfigured. */
export const MAX_HOSTS = 12;

export interface PairedHost {
  /** Origin, e.g. `https://192.168.1.20:8443`. Identity of the entry. */
  url: string;
  /** What the operator sees in the selector. Defaults to the host:port. */
  label: string;
  /**
   * SHA-256 of the host's certificate, hex, lowercase. The Deck's cert is
   * stable across launches, so this pins the entry for good; empty when the
   * Deck that issued the QR predates the fingerprint being carried in it.
   */
  fingerprint: string;
  /** Resume credential, see the note above. Empty when there is none. */
  credential: string;
  addedAt: number;
  lastSeenAt: number;
}

export interface HostsState {
  hosts: PairedHost[];
  /** URL of the selected entry, or "" when none. */
  selected: string;
}

/** What a scanned companion QR yields. */
export interface CompanionQr {
  url: string;
  token: string;
  fingerprint: string;
}

/**
 * Parse a companion QR: `https://<lan-ip>:<port>/#t=<token>[&f=<sha256>]`.
 *
 * HOSTILE INPUT: this is bytes off a camera. Anyone can print a QR, so the
 * only reason it is safe to navigate to the result is that it must be HTTPS on
 * a PRIVATE address — a QR cannot send the shell to an arbitrary site on the
 * internet, and it cannot downgrade the transport.
 */
export function parseCompanionQr(raw: string): CompanionQr | null {
  const text = String(raw ?? "").trim();
  if (!text || text.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  // HTTPS only: the companion server is TLS with a self-signed cert, and a
  // plain-http QR would be a downgrade, not a legacy host.
  if (url.protocol !== "https:") return null;
  if (!isPrivateHost(url.hostname)) return null;

  // The token rides in the FRAGMENT so it is never sent to the server as part
  // of an HTTP request — keep reading it from there.
  const frag = new URLSearchParams(url.hash.replace(/^#/, ""));
  const token = (frag.get("t") ?? "").trim();
  if (!token || token.length > 512) return null;
  const fingerprint = normalizeFingerprint(frag.get("f") ?? "");
  return { url: url.origin, token, fingerprint };
}

/** Accept `AA:BB:…` or bare hex; store lowercase hex without separators. */
export function normalizeFingerprint(raw: string): string {
  const hex = String(raw ?? "")
    .toLowerCase()
    .replace(/[^0-9a-f]/g, "");
  return hex.length === 64 ? hex : "";
}

/** Re-exported so the QR parser and the ntfy server check agree by construction. */
export { isPrivateHost as isPrivateHostname };

export function loadHosts(store: KeyValueStore): HostsState {
  const hosts = readJson<PairedHost[]>(store, HOSTS_KEY, []);
  const clean = Array.isArray(hosts) ? hosts.filter(isPairedHost).slice(0, MAX_HOSTS) : [];
  const selected = store.get(SELECTED_KEY) ?? "";
  return {
    hosts: clean,
    // A selection pointing at an entry that is gone is no selection.
    selected: clean.some((h) => h.url === selected) ? selected : (clean[0]?.url ?? ""),
  };
}

function isPairedHost(x: unknown): x is PairedHost {
  if (!x || typeof x !== "object") return false;
  const h = x as Record<string, unknown>;
  return typeof h.url === "string" && h.url.startsWith("https://");
}

function persist(store: KeyValueStore, state: HostsState): HostsState {
  writeJson(store, HOSTS_KEY, state.hosts);
  store.set(SELECTED_KEY, state.selected);
  return state;
}

/**
 * Record a scanned host, or refresh the one already known at that address.
 *
 * Re-scanning an existing Deck must NOT create a second entry: the QR is how
 * the operator refreshes a token after the desktop app restarted, which is the
 * common case. The label and any stored credential survive the refresh; the
 * fingerprint is only overwritten when the new QR actually carries one.
 */
export function addHost(
  store: KeyValueStore,
  qr: CompanionQr,
  now: number,
  label = ""
): HostsState {
  const state = loadHosts(store);
  const existing = state.hosts.find((h) => h.url === qr.url);
  if (existing) {
    if (qr.fingerprint) existing.fingerprint = qr.fingerprint;
    if (label) existing.label = label;
    existing.lastSeenAt = now;
    return persist(store, { hosts: state.hosts, selected: qr.url });
  }
  const host: PairedHost = {
    url: qr.url,
    label: label || defaultLabel(qr.url),
    fingerprint: qr.fingerprint,
    credential: "",
    addedAt: now,
    lastSeenAt: now,
  };
  // Oldest-first eviction, so a phone that has met many Decks keeps the ones
  // it actually uses instead of refusing to pair a new one.
  const hosts = [...state.hosts, host]
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_HOSTS);
  return persist(store, { hosts, selected: qr.url });
}

export function defaultLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function removeHost(store: KeyValueStore, url: string): HostsState {
  const state = loadHosts(store);
  const hosts = state.hosts.filter((h) => h.url !== url);
  const selected = state.selected === url ? (hosts[0]?.url ?? "") : state.selected;
  return persist(store, { hosts, selected });
}

export function selectHost(store: KeyValueStore, url: string): HostsState {
  const state = loadHosts(store);
  if (!state.hosts.some((h) => h.url === url)) return state;
  return persist(store, { hosts: state.hosts, selected: url });
}

/** Remember a resume credential the WebView obtained for this host. */
export function rememberCredential(
  store: KeyValueStore,
  url: string,
  credential: string,
  now: number
): HostsState {
  const state = loadHosts(store);
  const host = state.hosts.find((h) => h.url === url);
  if (!host) return state;
  host.credential = String(credential ?? "").slice(0, 512);
  host.lastSeenAt = now;
  return persist(store, state);
}

/**
 * Fold a natively-harvested credential into the host list, then clear it.
 *
 * This is what makes "restarting the app does not ask for a new QR" true. The
 * viewer reads the credential out of the WebView once the bridge is up and
 * leaves it in the drop box; the shell picks it up on its next boot or resume.
 * A credential for a host that has since been forgotten is discarded, not
 * resurrected as a new entry.
 */
export function absorbPendingCredential(store: KeyValueStore, now: number): HostsState {
  const raw = store.get(PENDING_CRED_KEY);
  if (raw === null) return loadHosts(store);
  store.remove(PENDING_CRED_KEY);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return loadHosts(store);
  }
  if (!parsed || typeof parsed !== "object") return loadHosts(store);
  const { url, credential } = parsed as Record<string, unknown>;
  if (typeof url !== "string" || typeof credential !== "string" || !credential) {
    return loadHosts(store);
  }
  return rememberCredential(store, url, credential, now);
}

/**
 * Adopt a certificate digest the viewer observed on first connection.
 *
 * Trust-on-first-use is only a bounded risk if the first use PINS. An entry
 * that keeps an empty fingerprint accepts any certificate on every later
 * navigation, which is not "a downgrade in the first second" but a permanent
 * one — and it is the state every host paired before the QR carried `&f=` is
 * in. Never overwrites an existing pin: that decision belongs to a re-scan,
 * not to whatever certificate was just served.
 */
export function absorbPendingPin(store: KeyValueStore, now: number): HostsState {
  const raw = store.get(PENDING_PIN_KEY);
  if (raw === null) return loadHosts(store);
  store.remove(PENDING_PIN_KEY);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return loadHosts(store);
  }
  if (!parsed || typeof parsed !== "object") return loadHosts(store);
  const { url, fingerprint } = parsed as Record<string, unknown>;
  if (typeof url !== "string" || typeof fingerprint !== "string") return loadHosts(store);
  const pin = normalizeFingerprint(fingerprint);
  if (!pin) return loadHosts(store);

  const state = loadHosts(store);
  const host = state.hosts.find((h) => h.url === url);
  if (!host || host.fingerprint) return state;
  host.fingerprint = pin;
  host.lastSeenAt = now;
  return persist(store, state);
}

/**
 * Drop a credential the host refused, keeping the entry.
 *
 * The address and the pin are still correct — only the ephemeral half died, so
 * the operator needs a fresh QR, not a fresh pairing.
 */
export function forgetCredential(store: KeyValueStore, url: string): HostsState {
  const state = loadHosts(store);
  const host = state.hosts.find((h) => h.url === url);
  if (!host || !host.credential) return state;
  host.credential = "";
  return persist(store, state);
}

export function selectedHost(state: HostsState): PairedHost | null {
  return state.hosts.find((h) => h.url === state.selected) ?? null;
}

/**
 * The URL to open in the WebView for a host.
 *
 * A fresh token rides in the FRAGMENT, which is never sent to the server as
 * part of an HTTP request — that is why the desktop puts it there and why the
 * shell keeps it there. A resume needs no fragment at all: the credential is
 * seeded into sessionStorage instead (see `companionResumeScript`).
 *
 * With neither, there is nothing to try and the caller must ask for a scan.
 */
export function navigationUrl(host: PairedHost, token = ""): string | null {
  if (token) return `${host.url}/#t=${encodeURIComponent(token)}`;
  if (host.credential) return `${host.url}/`;
  return null;
}

/**
 * The JavaScript the native shell evaluates in the WebView BEFORE the page's
 * own script runs, to resume a host without a fresh QR.
 *
 * `connectRemoteApi` already boots from a stored credential alone — it only
 * throws when it finds neither a `#t=` token nor a credential — so seeding the
 * key it reads is enough, and nothing on the desktop side changes. Generated
 * here rather than hand-written in Kotlin so the escaping is unit-tested and
 * the storage key comes from the shared constant instead of a second literal.
 *
 * Returns "" when the host has no credential to seed.
 */
export function companionResumeScript(host: PairedHost): string {
  if (!host.credential) return "";
  // JSON.stringify handles the quoting AND the escaping; `</` is broken up so
  // the string can never terminate a surrounding <script> element.
  const value = JSON.stringify(host.credential).replace(/<\//g, "<\\/");
  const key = JSON.stringify(COMPANION_CRED_STORAGE_KEY);
  return `try{sessionStorage.setItem(${key},${value})}catch(e){}`;
}
