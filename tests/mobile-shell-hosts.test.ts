// COMPANION multi-host registry of the Android shell (PLAN N5).
//
// The Android build does not exist in this container, so the shell's decision
// logic lives in pure modules and is verified here. The load-bearing property
// is the SPLIT: companion pairing and approval pairing must never touch each
// other's state.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  absorbPendingCredential,
  absorbPendingPin,
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
  PENDING_PIN_KEY,
  rememberCredential,
  removeHost,
  selectedHost,
  selectHost,
  SELECTED_KEY,
} from "../desktop/mobile-shell/src/paired-hosts.ts";
import { MemoryStore } from "../desktop/mobile-shell/src/storage.ts";
import { COMPANION_CRED_STORAGE_KEY } from "../desktop/src/shared/companion.ts";
import { extractParenBody } from "./_braced-body.ts";

const FP = "a".repeat(64);
const T0 = 1_700_000_000_000;

function qr(url: string, token = "tok", fingerprint = FP): string {
  return `${url}/#t=${token}${fingerprint ? `&f=${fingerprint}` : ""}`;
}

describe("parseCompanionQr (hostile: bytes off a camera)", () => {
  test("reads the origin, the token and the fingerprint", () => {
    expect(parseCompanionQr(qr("https://10.0.0.20:8443"))).toEqual({
      url: "https://10.0.0.20:8443",
      token: "tok",
      fingerprint: FP,
    });
  });

  test("accepts a QR from a Deck that carries no fingerprint yet", () => {
    expect(parseCompanionQr("https://10.0.0.20:8443/#t=tok")).toEqual({
      url: "https://10.0.0.20:8443",
      token: "tok",
      fingerprint: "",
    });
  });

  test("refuses a downgrade to plain http", () => {
    expect(parseCompanionQr("http://10.0.0.20:8443/#t=tok")).toBeNull();
  });

  test("refuses a public address: a printed QR cannot redirect the shell", () => {
    expect(parseCompanionQr("https://evil.example.com/#t=tok")).toBeNull();
  });

  test("refuses a QR with no token, junk, and an oversize payload", () => {
    expect(parseCompanionQr("https://10.0.0.20:8443/")).toBeNull();
    expect(parseCompanionQr("hello")).toBeNull();
    expect(parseCompanionQr(`https://10.0.0.20:8443/#t=${"x".repeat(3000)}`)).toBeNull();
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
    const state = addHost(store, parseCompanionQr(qr("https://10.0.0.20:8443"))!, T0);
    expect(state.hosts).toHaveLength(1);
    expect(state.selected).toBe("https://10.0.0.20:8443");
    expect(state.hosts[0]!.label).toBe("10.0.0.20:8443");
    expect(state.hosts[0]!.fingerprint).toBe(FP);
  });

  test("several Decks coexist, and the selector picks between them", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://10.0.0.20:8443"))!, T0, "bureau");
    addHost(store, parseCompanionQr(qr("https://10.0.0.30:8443"))!, T0 + 1, "portable");
    const state = selectHost(store, "https://10.0.0.20:8443");
    expect(state.hosts).toHaveLength(2);
    expect(selectedHost(state)?.label).toBe("bureau");
  });

  test("re-scanning a known Deck refreshes it instead of duplicating it", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://10.0.0.20:8443"))!, T0, "bureau");
    rememberCredential(store, "https://10.0.0.20:8443", "cred-1", T0);
    const state = addHost(store, parseCompanionQr(qr("https://10.0.0.20:8443", "tok2"))!, T0 + 5);
    expect(state.hosts).toHaveLength(1);
    // The label and the resume credential survive a token refresh.
    expect(state.hosts[0]!.label).toBe("bureau");
    expect(state.hosts[0]!.credential).toBe("cred-1");
    expect(state.hosts[0]!.lastSeenAt).toBe(T0 + 5);
  });

  test("a re-scan without a fingerprint does not erase the pin", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://10.0.0.20:8443"))!, T0);
    const state = addHost(store, parseCompanionQr("https://10.0.0.20:8443/#t=tok2")!, T0 + 1);
    expect(state.hosts[0]!.fingerprint).toBe(FP);
  });

  test("removing the selected host falls back to another", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://10.0.0.20:8443"))!, T0);
    addHost(store, parseCompanionQr(qr("https://10.0.0.30:8443"))!, T0 + 1);
    const state = removeHost(store, "https://10.0.0.30:8443");
    expect(state.hosts).toHaveLength(1);
    expect(state.selected).toBe("https://10.0.0.20:8443");
  });

  test("removing the last host leaves no selection", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://10.0.0.20:8443"))!, T0);
    const state = removeHost(store, "https://10.0.0.20:8443");
    expect(state.hosts).toHaveLength(0);
    expect(state.selected).toBe("");
    expect(selectedHost(state)).toBeNull();
  });

  test("the list is capped, evicting the least recently seen", () => {
    const store = new MemoryStore();
    for (let i = 0; i < MAX_HOSTS + 3; i++) {
      addHost(store, parseCompanionQr(qr(`https://10.0.0.${10 + i}:8443`))!, T0 + i);
    }
    const state = loadHosts(store);
    expect(state.hosts).toHaveLength(MAX_HOSTS);
    expect(state.hosts.some((h) => h.url === "https://10.0.0.10:8443")).toBe(false);
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
    addHost(store, parseCompanionQr(qr("https://10.0.0.20:8443"))!, T0);
    store.set(SELECTED_KEY, "https://10.0.0.9:8443");
    expect(loadHosts(store).selected).toBe("https://10.0.0.20:8443");
  });

  test("selecting an unknown host is a no-op", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://10.0.0.20:8443"))!, T0);
    expect(selectHost(store, "https://10.0.0.9:8443").selected).toBe("https://10.0.0.20:8443");
  });

  test("defaultLabel falls back to the raw string for a bad URL", () => {
    expect(defaultLabel("not a url")).toBe("not a url");
  });
});

describe("trust on first use actually pins", () => {
  test("a digest observed on first connection becomes the pin", () => {
    // Without this write-back, an entry with no fingerprint accepted ANY
    // certificate on every later visit — permanently, for every Deck paired
    // before the QR carried one. That is a MITM window, not a first-second one.
    const store = new MemoryStore();
    addHost(store, parseCompanionQr("https://10.0.0.20:8443/#t=tok")!, T0);
    expect(loadHosts(store).hosts[0]!.fingerprint).toBe("");

    store.set(
      PENDING_PIN_KEY,
      JSON.stringify({ url: "https://10.0.0.20:8443", fingerprint: FP })
    );
    const state = absorbPendingPin(store, T0 + 1);
    expect(state.hosts[0]!.fingerprint).toBe(FP);
    expect(store.get(PENDING_PIN_KEY)).toBeNull();
  });

  test("an existing pin is never overwritten by whatever was just served", () => {
    // Re-pinning on sight would make the pin meaningless: an attacker's
    // certificate would simply replace the real one.
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://10.0.0.20:8443"))!, T0);
    store.set(
      PENDING_PIN_KEY,
      JSON.stringify({ url: "https://10.0.0.20:8443", fingerprint: "b".repeat(64) })
    );
    expect(absorbPendingPin(store, T0 + 1).hosts[0]!.fingerprint).toBe(FP);
  });

  test("a malformed digest, an unknown host and junk all change nothing", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr("https://10.0.0.20:8443/#t=tok")!, T0);
    for (const junk of [
      "{oops",
      JSON.stringify({ url: "https://10.0.0.20:8443", fingerprint: "nothex" }),
      JSON.stringify({ url: "https://10.0.0.9:8443", fingerprint: FP }),
    ]) {
      store.set(PENDING_PIN_KEY, junk);
      expect(absorbPendingPin(store, T0).hosts[0]!.fingerprint).toBe("");
      expect(store.get(PENDING_PIN_KEY)).toBeNull();
    }
  });
});

describe("a tapped notification opens its request on the selected host", () => {
  const OTHER = "https://10.0.0.20:8443";
  const SELECTED = "https://10.0.0.21:8443";
  const ID = "0bc8cbab-3a77-440d-b5ea-d1bc649e2907";
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  function pairedPrefs(credential: string): Record<string, string> {
    const store = new MemoryStore();
    for (const url of [OTHER, SELECTED]) addHost(store, parseCompanionQr(qr(url))!, T0);
    if (credential) rememberCredential(store, SELECTED, credential, T0);
    return { [HOSTS_KEY]: store.get(HOSTS_KEY)!, [SELECTED_KEY]: store.get(SELECTED_KEY)! };
  }

  /** Boots the real shell against a fake device, the native plugin handing each pending id over once. */
  async function onDevice(
    prefs: Record<string, string>,
    pending: string,
    run: (device: { opened: string[]; tap: (id: string) => Promise<void>; shown: () => string }) => void | Promise<void>,
    failure?: Error
  ): Promise<void> {
    const { boot } = await import("../desktop/mobile-shell/src/app.ts");
    const node = () => ({
      className: "",
      textContent: "",
      children: [] as { className: string; textContent: string }[],
      append(...added: { className: string; textContent: string }[]) {
        this.children.push(...added);
      },
      replaceChildren() {
        this.children = [];
      },
    });
    const nodes: Record<string, ReturnType<typeof node>> = { tabs: node(), view: node() };
    const listeners: Record<string, () => void> = {};
    const opened: string[] = [];
    const g = globalThis as { window?: unknown; document?: unknown };
    const saved = { window: g.window, document: g.document };
    g.document = {
      hidden: false,
      getElementById: (id: string) => nodes[id],
      createElement: node,
      addEventListener: () => {},
    };
    g.window = {
      addEventListener: (name: string, listener: () => void) => {
        listeners[name] = listener;
      },
      Capacitor: {
        Plugins: {
          Preferences: {
            get: async ({ key }: { key: string }) => ({ value: prefs[key] ?? null }),
            set: async ({ key, value }: { key: string; value: string }) => void (prefs[key] = value),
            remove: async ({ key }: { key: string }) => void delete prefs[key],
          },
          ParastatesShell: {
            deviceName: async () => ({ name: "phone" }),
            openHost: async ({ url }: { url: string }) => void opened.push(url),
            takeApprovalId: async () => {
              if (failure) throw failure;
              const approvalId = pending;
              pending = "";
              return { approvalId };
            },
          },
        },
      },
    };
    try {
      await boot();
      await settle();
      await run({
        opened,
        tap: async (id) => {
          pending = id;
          listeners["parastatesApproval"]!();
          await settle();
        },
        shown: () =>
          nodes.view!.children
            .filter((c) => c.className === "notice")
            .map((c) => c.textContent)
            .join(),
      });
    } finally {
      g.window = saved.window;
      g.document = saved.document;
    }
  }

  test("at launch, then again while the app is already open", async () => {
    await onDevice(pairedPrefs("cred-1"), ID, async ({ opened, tap }) => {
      expect(opened).toEqual([`${SELECTED}/#a=${ID}`]);
      await tap("second-request");
      expect(opened).toEqual([`${SELECTED}/#a=${ID}`, `${SELECTED}/#a=second-request`]);
    });
  });

  test("a credential the viewer harvested since launch is used", async () => {
    const prefs = pairedPrefs("");
    await onDevice(prefs, "", async ({ opened, tap }) => {
      prefs[PENDING_CRED_KEY] = JSON.stringify({ url: SELECTED, credential: "cred-2" });
      await tap(ID);
      expect(opened).toEqual([`${SELECTED}/#a=${ID}`]);
    });
  });

  test("an id from an Intent that the Deck would refuse opens nothing", async () => {
    await onDevice(pairedPrefs("cred-1"), "a&t=forged", async ({ opened, tap, shown }) => {
      await tap("x".repeat(65));
      expect(opened).toEqual([]);
      expect(shown()).toBe("");
    });
  });

  test("with no paired host nothing opens and nothing is reported", async () => {
    await onDevice({}, ID, ({ opened, shown }) => {
      expect(opened).toEqual([]);
      expect(shown()).toBe("");
    });
  });

  test("a native failure is shown in the shell", async () => {
    await onDevice(
      pairedPrefs("cred-1"),
      ID,
      ({ shown }) => {
        expect(shown()).toContain("bridge down");
      },
      new Error("bridge down")
    );
  });
});

// A source scan: bun cannot import the Kotlin and the test run does not compile
// it, so a rename on one side would otherwise be silent.
describe("the Android side, read as text", () => {
  const read = (path: string) => readFileSync(new URL(`../desktop/mobile-shell/${path}`, import.meta.url), "utf8");
  const kotlin = (name: string) => read(`android-src/java/io/koryphaios/parastates/${name}.kt`);
  const plugin = kotlin("ParastatesShellPlugin");
  const platform = read("src/platform.ts");

  function only(source: string, anchor: RegExp): string {
    const found = [...source.matchAll(anchor)];
    expect(found).toHaveLength(1);
    return found[0]![1]!;
  }

  test("the plugin method the shell calls exists", () => {
    const methods = [...plugin.matchAll(/@PluginMethod\s+fun (\w+)\(/g)].map((m) => m[1]);
    expect(methods).toContain(only(platform, /const res = await plugins\(\)\.ParastatesShell\?\.(\w+)\(\);/g));
  });

  test("the key the plugin resolves is the one the shell reads", () => {
    expect(only(plugin, /JSObject\(\)\.put\("(\w+)", approvalId\)/g)).toBe(
      only(platform, /return res\?\.(\w+) \?\? "";/g)
    );
  });

  test("the event the activity fires is the one the shell listens for", () => {
    expect(only(kotlin("MainActivity"), /triggerWindowJSEvent\("(\w+)"\)/g)).toBe(
      only(platform, /window\.addEventListener\("(\w+)", listener\)/g)
    );
  });

  test("the activity a notification tap lands on is not exported", () => {
    const manifest = read("android-src/AndroidManifest-additions.xml");
    const block = only(manifest, /(<activity\s+android:name="\.ApprovalTapActivity"[^>]*>)/g);
    expect(block, "any app could hand the shell an approval id through an exported ApprovalTapActivity").toContain(
      'android:exported="false"'
    );
  });

  test("the notification targets that activity with an immutable PendingIntent", () => {
    const service = kotlin("ApprovalService");
    const opening = "PendingIntent.getActivity(";
    expect(service.split(opening), "one PendingIntent opens the app from a notification").toHaveLength(2);
    const args = extractParenBody(service, service.indexOf(opening) + opening.length - 1, true);
    expect(args, "the approval id must enter through the non-exported activity").toContain(
      "Intent(this, ApprovalTapActivity::class.java)"
    );
    expect(args, "a mutable PendingIntent lets its holder rewrite the approval id").toContain(
      "PendingIntent.FLAG_IMMUTABLE"
    );
  });

  test("the exported activity reads nothing from its Intent", () => {
    expect(
      kotlin("MainActivity"),
      "MainActivity is exported: an approval id read from its Intent can come from any app"
    ).not.toMatch(/\bget\w*Extras?\b|\bextras\b/);
  });
});

describe("the resume credential", () => {
  test("the native drop box is folded into the host list", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://10.0.0.20:8443"))!, T0);
    // What the native viewer leaves behind after harvesting it from the page.
    store.set(
      PENDING_CRED_KEY,
      JSON.stringify({ url: "https://10.0.0.20:8443", credential: "cred-1" })
    );
    const state = absorbPendingCredential(store, T0 + 1);
    expect(state.hosts[0]!.credential).toBe("cred-1");
    // Consumed: absorbing twice must not resurrect a stale value later.
    expect(store.get(PENDING_CRED_KEY)).toBeNull();
  });

  test("restarting the app does not ask for a new QR", () => {
    // The whole point of the drop box, expressed as the operator sees it.
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://10.0.0.20:8443"))!, T0);
    store.set(
      PENDING_CRED_KEY,
      JSON.stringify({ url: "https://10.0.0.20:8443", credential: "cred-1" })
    );
    absorbPendingCredential(store, T0 + 1);

    // App killed and relaunched: nothing in memory, everything from storage.
    const afterRestart = loadHosts(store);
    const host = selectedHost(afterRestart)!;
    expect(navigationUrl(host)).toBe("https://10.0.0.20:8443/");
    expect(companionResumeScript(host)).toContain('"cred-1"');
  });

  test("but a Deck restart does: its credentials are wiped, so the QR is back", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://10.0.0.20:8443"))!, T0);
    rememberCredential(store, "https://10.0.0.20:8443", "cred-1", T0);
    // The host refused the resume — `CompanionAuth.arm()` cleared it.
    const state = forgetCredential(store, "https://10.0.0.20:8443");
    expect(navigationUrl(selectedHost(state)!)).toBeNull();
  });

  test("a credential for a forgotten host is discarded, not resurrected", () => {
    const store = new MemoryStore();
    store.set(
      PENDING_CRED_KEY,
      JSON.stringify({ url: "https://10.0.0.9:8443", credential: "cred-1" })
    );
    expect(absorbPendingCredential(store, T0).hosts).toHaveLength(0);
  });

  test("a corrupted or empty drop box changes nothing and is cleared", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://10.0.0.20:8443"))!, T0);
    for (const junk of ["{oops", "[]", JSON.stringify({ url: "https://10.0.0.20:8443" })]) {
      store.set(PENDING_CRED_KEY, junk);
      expect(absorbPendingCredential(store, T0).hosts[0]!.credential).toBe("");
      expect(store.get(PENDING_CRED_KEY)).toBeNull();
    }
  });

  test("an absent drop box is not an error", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://10.0.0.20:8443"))!, T0);
    expect(absorbPendingCredential(store, T0).hosts).toHaveLength(1);
  });

  test("a refused credential is dropped but the entry survives", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://10.0.0.20:8443"))!, T0);
    rememberCredential(store, "https://10.0.0.20:8443", "cred-1", T0);
    const state = forgetCredential(store, "https://10.0.0.20:8443");
    expect(state.hosts).toHaveLength(1);
    expect(state.hosts[0]!.credential).toBe("");
    // The address and the pin are still right: only a fresh QR is needed.
    expect(state.hosts[0]!.fingerprint).toBe(FP);
  });

  test("remembering against an unknown host changes nothing", () => {
    const store = new MemoryStore();
    expect(rememberCredential(store, "https://10.0.0.9:8443", "c", T0).hosts).toHaveLength(0);
  });

  test("a fresh token wins over a stored credential", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://10.0.0.20:8443"))!, T0);
    rememberCredential(store, "https://10.0.0.20:8443", "cred-1", T0);
    const host = selectedHost(loadHosts(store))!;
    expect(navigationUrl(host, "fresh")).toBe("https://10.0.0.20:8443/#t=fresh");
    // The token rides in the fragment, so it never reaches the server by HTTP.
    expect(navigationUrl(host, "fresh")).toContain("#t=");
  });

  test("a resume needs no fragment at all, and no credential means no URL", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://10.0.0.20:8443"))!, T0);
    expect(navigationUrl(selectedHost(loadHosts(store))!)).toBeNull();
    rememberCredential(store, "https://10.0.0.20:8443", "cred-1", T0);
    expect(navigationUrl(selectedHost(loadHosts(store))!)).toBe("https://10.0.0.20:8443/");
  });

  test("an approval id rides in the fragment beside the token, and alone on a resume", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://10.0.0.20:8443"))!, T0);
    rememberCredential(store, "https://10.0.0.20:8443", "cred-1", T0);
    const host = selectedHost(loadHosts(store))!;
    const id = "0bc8cbab-3a77-440d-b5ea-d1bc649e2907";
    expect(navigationUrl(host, "fresh", id)).toBe(`https://10.0.0.20:8443/#t=fresh&a=${id}`);
    expect(navigationUrl(host, "", id)).toBe(`https://10.0.0.20:8443/#a=${id}`);
  });

  test("an approval id the Deck would refuse is dropped, the host still opens", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://10.0.0.20:8443"))!, T0);
    rememberCredential(store, "https://10.0.0.20:8443", "cred-1", T0);
    const host = selectedHost(loadHosts(store))!;
    expect(navigationUrl(host, "", "a&t=forged")).toBe("https://10.0.0.20:8443/");
    expect(navigationUrl(host, "fresh", "x".repeat(65))).toBe("https://10.0.0.20:8443/#t=fresh");
  });

  test("the seeding script targets the key the web app actually reads", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://10.0.0.20:8443"))!, T0);
    rememberCredential(store, "https://10.0.0.20:8443", "cred-1", T0);
    const script = companionResumeScript(selectedHost(loadHosts(store))!);
    expect(script).toContain(JSON.stringify(COMPANION_CRED_STORAGE_KEY));
    expect(script).toContain('"cred-1"');
    // It must never throw inside the WebView: a private-mode storage error
    // would otherwise abort the page before the app boots.
    expect(script.startsWith("try{")).toBe(true);
  });

  test("the seeding script escapes a hostile credential", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://10.0.0.20:8443"))!, T0);
    rememberCredential(store, "https://10.0.0.20:8443", '</script><script>alert(1)//', T0);
    const script = companionResumeScript(selectedHost(loadHosts(store))!);
    expect(script).not.toContain("</script>");
    expect(script).toContain("<\\/script>");
  });

  test("no credential means no script to run", () => {
    const store = new MemoryStore();
    addHost(store, parseCompanionQr(qr("https://10.0.0.20:8443"))!, T0);
    expect(companionResumeScript(selectedHost(loadHosts(store))!)).toBe("");
  });
});
