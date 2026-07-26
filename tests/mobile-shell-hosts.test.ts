// COMPANION multi-host registry of the Android shell (PLAN N5).
//
// The Android build does not exist in this container, so the shell's decision
// logic lives in pure modules and is verified here. The load-bearing property
// is the SPLIT: companion pairing and approval pairing must never touch each
// other's state.

import { describe, expect, test } from "bun:test";
import {
  absorbPendingCredential,
  addHost,
  companionResumeScript,
  defaultLabel,
  forgetCredential,
  HOSTS_KEY,
  isPrivateHostname,
  loadHosts,
  MAX_HOSTS,
  navigationUrl,
  normalizeFingerprint,
  parseCompanionQr,
  PENDING_CRED_KEY,
  rememberCredential,
  removeHost,
  selectedHost,
  selectHost,
  SELECTED_KEY,
} from "../desktop/mobile-shell/src/paired-hosts.ts";
import { MemoryStore } from "../desktop/mobile-shell/src/storage.ts";
import { COMPANION_CRED_STORAGE_KEY } from "../desktop/src/shared/companion.ts";

const FP = "a".repeat(64);
const T0 = 1_700_000_000_000;

function qr(url: string, token = "tok", fingerprint = FP): string {
  return `${url}/#t=${token}${fingerprint ? `&f=${fingerprint}` : ""}`;
}

describe("parseCompanionQr (hostile: bytes off a camera)", () => {
  test("reads the origin, the token and the fingerprint", () => {
    expect(parseCompanionQr(qr("https://192.168.1.20:8443"))).toEqual({
      url: "https://192.168.1.20:8443",
      token: "tok",
      fingerprint: FP,
    });
  });

  test("accepts a QR from a Deck that carries no fingerprint yet", () => {
    expect(parseCompanionQr("https://192.168.1.20:8443/#t=tok")).toEqual({
      url: "https://192.168.1.20:8443",
      token: "tok",
      fingerprint: "",
    });
  });

  test("refuses a downgrade to plain http", () => {
    expect(parseCompanionQr("http://192.168.1.20:8443/#t=tok")).toBeNull();
  });

  test("refuses a public address: a printed QR cannot redirect the shell", () => {
    expect(parseCompanionQr("https://evil.example.com/#t=tok")).toBeNull();
  });

  test("refuses a QR with no token, junk, and an oversize payload", () => {
    expect(parseCompanionQr("https://192.168.1.20:8443/")).toBeNull();
    expect(parseCompanionQr("hello")).toBeNull();
    expect(parseCompanionQr(`https://192.168.1.20:8443/#t=${"x".repeat(3000)}`)).toBeNull();
  });

  test("accepts a tailnet address, so roaming works without a code change", () => {
    expect(parseCompanionQr("https://100.101.102.103:8443/#t=tok")?.url).toBe(
      "https://100.101.102.103:8443"
    );
  });

  test("refuses the 100.x range that is NOT CGNAT", () => {
    expect(isPrivateHostname("100.63.0.1")).toBe(false);
    expect(isPrivateHostname("100.128.0.1")).toBe(false);
    expect(isPrivateHostname("100.64.0.1")).toBe(true);
  });
});

describe("normalizeFingerprint", () => {
  test("accepts colon-separated and bare hex, rejects the wrong length", () => {
    expect(normalizeFingerprint("AA:BB")).toBe("");
    expect(normalizeFingerprint(FP.toUpperCase())).toBe(FP);
    expect(normalizeFingerprint(FP.replace(/(..)/g, "$1:").slice(0, -1))).toBe(FP);
    expect(normalizeFingerprint("zz")).toBe("");
  });
});

describe("the host list", () => {
  test("a scan adds an entry and selects it", () => {
    const store = new MemoryStore();
    const state = addHost(store, parseCompanionQr(qr("https://192.168.1.20:8443"))!, T0);
    expect(state.hosts).toHaveLength(1);
    expect(state.selected).toBe("https://192.168.1.20:8443");
    expect(state.hosts[0]!.label).toBe("192.168.1.20:8443");
    expect(state.hosts[0]!.fingerprint).toBe(FP);
  });

  test("several Decks coexist, and the selector picks between them", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://192.168.1.20:8443"))!, T0, "bureau");
    addHost(store, parseCompanionQr(qr("https://192.168.1.30:8443"))!, T0 + 1, "portable");
    const state = selectHost(store, "https://192.168.1.20:8443");
    expect(state.hosts).toHaveLength(2);
    expect(selectedHost(state)?.label).toBe("bureau");
  });

  test("re-scanning a known Deck refreshes it instead of duplicating it", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://192.168.1.20:8443"))!, T0, "bureau");
    rememberCredential(store, "https://192.168.1.20:8443", "cred-1", T0);
    const state = addHost(store, parseCompanionQr(qr("https://192.168.1.20:8443", "tok2"))!, T0 + 5);
    expect(state.hosts).toHaveLength(1);
    // The label and the resume credential survive a token refresh.
    expect(state.hosts[0]!.label).toBe("bureau");
    expect(state.hosts[0]!.credential).toBe("cred-1");
    expect(state.hosts[0]!.lastSeenAt).toBe(T0 + 5);
  });

  test("a re-scan without a fingerprint does not erase the pin", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://192.168.1.20:8443"))!, T0);
    const state = addHost(store, parseCompanionQr("https://192.168.1.20:8443/#t=tok2")!, T0 + 1);
    expect(state.hosts[0]!.fingerprint).toBe(FP);
  });

  test("removing the selected host falls back to another", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://192.168.1.20:8443"))!, T0);
    addHost(store, parseCompanionQr(qr("https://192.168.1.30:8443"))!, T0 + 1);
    const state = removeHost(store, "https://192.168.1.30:8443");
    expect(state.hosts).toHaveLength(1);
    expect(state.selected).toBe("https://192.168.1.20:8443");
  });

  test("removing the last host leaves no selection", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://192.168.1.20:8443"))!, T0);
    const state = removeHost(store, "https://192.168.1.20:8443");
    expect(state.hosts).toHaveLength(0);
    expect(state.selected).toBe("");
    expect(selectedHost(state)).toBeNull();
  });

  test("the list is capped, evicting the least recently seen", () => {
    const store = new MemoryStore();
    for (let i = 0; i < MAX_HOSTS + 3; i++) {
      addHost(store, parseCompanionQr(qr(`https://192.168.1.${10 + i}:8443`))!, T0 + i);
    }
    const state = loadHosts(store);
    expect(state.hosts).toHaveLength(MAX_HOSTS);
    expect(state.hosts.some((h) => h.url === "https://192.168.1.10:8443")).toBe(false);
    expect(state.hosts.some((h) => h.url.endsWith(`.${10 + MAX_HOSTS + 2}:8443`))).toBe(true);
  });

  test("a corrupted preference degrades to 'nothing paired', never to a crash", () => {
    const store = new MemoryStore({ [HOSTS_KEY]: "{not json", [SELECTED_KEY]: "https://x" });
    expect(loadHosts(store)).toEqual({ hosts: [], selected: "" });
  });

  test("entries that are not hosts are dropped on load", () => {
    const store = new MemoryStore({ [HOSTS_KEY]: JSON.stringify([{ url: "ftp://x" }, null, 42]) });
    expect(loadHosts(store).hosts).toHaveLength(0);
  });

  test("a selection pointing at a vanished host resolves to the first one", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://192.168.1.20:8443"))!, T0);
    store.set(SELECTED_KEY, "https://192.168.9.9:8443");
    expect(loadHosts(store).selected).toBe("https://192.168.1.20:8443");
  });

  test("selecting an unknown host is a no-op", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://192.168.1.20:8443"))!, T0);
    expect(selectHost(store, "https://192.168.9.9:8443").selected).toBe("https://192.168.1.20:8443");
  });

  test("defaultLabel falls back to the raw string for a bad URL", () => {
    expect(defaultLabel("not a url")).toBe("not a url");
  });
});

describe("the resume credential", () => {
  test("the native drop box is folded into the host list", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://192.168.1.20:8443"))!, T0);
    // What the native viewer leaves behind after harvesting it from the page.
    store.set(
      PENDING_CRED_KEY,
      JSON.stringify({ url: "https://192.168.1.20:8443", credential: "cred-1" })
    );
    const state = absorbPendingCredential(store, T0 + 1);
    expect(state.hosts[0]!.credential).toBe("cred-1");
    // Consumed: absorbing twice must not resurrect a stale value later.
    expect(store.get(PENDING_CRED_KEY)).toBeNull();
  });

  test("restarting the app does not ask for a new QR", () => {
    // The whole point of the drop box, expressed as the operator sees it.
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://192.168.1.20:8443"))!, T0);
    store.set(
      PENDING_CRED_KEY,
      JSON.stringify({ url: "https://192.168.1.20:8443", credential: "cred-1" })
    );
    absorbPendingCredential(store, T0 + 1);

    // App killed and relaunched: nothing in memory, everything from storage.
    const afterRestart = loadHosts(store);
    const host = selectedHost(afterRestart)!;
    expect(navigationUrl(host)).toBe("https://192.168.1.20:8443/");
    expect(companionResumeScript(host)).toContain('"cred-1"');
  });

  test("but a Deck restart does: its credentials are wiped, so the QR is back", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://192.168.1.20:8443"))!, T0);
    rememberCredential(store, "https://192.168.1.20:8443", "cred-1", T0);
    // The host refused the resume — `CompanionAuth.arm()` cleared it.
    const state = forgetCredential(store, "https://192.168.1.20:8443");
    expect(navigationUrl(selectedHost(state)!)).toBeNull();
  });

  test("a credential for a forgotten host is discarded, not resurrected", () => {
    const store = new MemoryStore();
    store.set(
      PENDING_CRED_KEY,
      JSON.stringify({ url: "https://192.168.9.9:8443", credential: "cred-1" })
    );
    expect(absorbPendingCredential(store, T0).hosts).toHaveLength(0);
  });

  test("a corrupted or empty drop box changes nothing and is cleared", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://192.168.1.20:8443"))!, T0);
    for (const junk of ["{oops", "[]", JSON.stringify({ url: "https://192.168.1.20:8443" })]) {
      store.set(PENDING_CRED_KEY, junk);
      expect(absorbPendingCredential(store, T0).hosts[0]!.credential).toBe("");
      expect(store.get(PENDING_CRED_KEY)).toBeNull();
    }
  });

  test("an absent drop box is not an error", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://192.168.1.20:8443"))!, T0);
    expect(absorbPendingCredential(store, T0).hosts).toHaveLength(1);
  });

  test("a refused credential is dropped but the entry survives", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://192.168.1.20:8443"))!, T0);
    rememberCredential(store, "https://192.168.1.20:8443", "cred-1", T0);
    const state = forgetCredential(store, "https://192.168.1.20:8443");
    expect(state.hosts).toHaveLength(1);
    expect(state.hosts[0]!.credential).toBe("");
    // The address and the pin are still right: only a fresh QR is needed.
    expect(state.hosts[0]!.fingerprint).toBe(FP);
  });

  test("remembering against an unknown host changes nothing", () => {
    const store = new MemoryStore();
    expect(rememberCredential(store, "https://192.168.9.9:8443", "c", T0).hosts).toHaveLength(0);
  });

  test("a fresh token wins over a stored credential", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://192.168.1.20:8443"))!, T0);
    rememberCredential(store, "https://192.168.1.20:8443", "cred-1", T0);
    const host = selectedHost(loadHosts(store))!;
    expect(navigationUrl(host, "fresh")).toBe("https://192.168.1.20:8443/#t=fresh");
    // The token rides in the fragment, so it never reaches the server by HTTP.
    expect(navigationUrl(host, "fresh")).toContain("#t=");
  });

  test("a resume needs no fragment at all, and no credential means no URL", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://192.168.1.20:8443"))!, T0);
    expect(navigationUrl(selectedHost(loadHosts(store))!)).toBeNull();
    rememberCredential(store, "https://192.168.1.20:8443", "cred-1", T0);
    expect(navigationUrl(selectedHost(loadHosts(store))!)).toBe("https://192.168.1.20:8443/");
  });

  test("the seeding script targets the key the web app actually reads", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://192.168.1.20:8443"))!, T0);
    rememberCredential(store, "https://192.168.1.20:8443", "cred-1", T0);
    const script = companionResumeScript(selectedHost(loadHosts(store))!);
    expect(script).toContain(JSON.stringify(COMPANION_CRED_STORAGE_KEY));
    expect(script).toContain('"cred-1"');
    // It must never throw inside the WebView: a private-mode storage error
    // would otherwise abort the page before the app boots.
    expect(script.startsWith("try{")).toBe(true);
  });

  test("the seeding script escapes a hostile credential", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://192.168.1.20:8443"))!, T0);
    rememberCredential(store, "https://192.168.1.20:8443", '</script><script>alert(1)//', T0);
    const script = companionResumeScript(selectedHost(loadHosts(store))!);
    expect(script).not.toContain("</script>");
    expect(script).toContain("<\\/script>");
  });

  test("no credential means no script to run", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://192.168.1.20:8443"))!, T0);
    expect(companionResumeScript(selectedHost(loadHosts(store))!)).toBe("");
  });
});
