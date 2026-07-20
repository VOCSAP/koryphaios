# Koryphaios Companion — Android shell (PLAN MB6)

A **thin Capacitor shell** whose only job is to reach the desktop app's
companion server over the LAN. It embeds **no UI of its own**: the interface is
served by the PC (the same renderer bundle as the desktop window), so the phone
is always exactly at the host's version — the whole point of the web-remoting
approach (voie C in `EXPLORATION-mobile-lan.md`).

This directory is a **scaffold**, not a built APK: building requires the
Android SDK + Gradle, which are not present in the CI/dev container. The web
assets, Capacitor config, and the native TODOs are laid out here so a machine
with Android tooling can `npm install && npx cap add android && npx cap run
android`.

## What the shell provides (and why it must be native, not a PWA)

The scenario is "launch agents, put the phone down for an hour, glance back":
Android kills a background browser tab's WebSocket within minutes, so a PWA
cannot survive a real dev session. The shell adds exactly the native pieces a
browser cannot:

1. **QR scanner** (`@capacitor/barcode-scanner` or ML Kit) → reads
   `https://<lan-ip>:<port>/#t=<token>` and loads it in the WebView.
2. **Certificate trust**: the host's self-signed cert is pinned on first pair
   (its fingerprint travels in the QR), so no browser warning and no MITM.
3. **Foreground service** holding the WebSocket alive while backgrounded; the
   web app switches to the *light channel* (`mode: light`) on
   `visibilitychange`, so only signal events (`session:attention`,
   `inbox:new`, `session:quota`, `broker:status`) flow — turned into Android
   notifications — not the full terminal stream.
4. **Biometric app lock** (EXPLORATION §5.5 bis, WhatsApp-style): on resume
   from background/lock, `BiometricPrompt` before the WebView is revealed;
   `FLAG_SECURE` on the activity blanks the recent-apps thumbnail and blocks
   screenshots (a terminal leaks paths/secrets).
5. **"Host disconnected" is native too**: when the socket drops (app closed on
   the PC), the shell shows the re-scan screen — the web overlay
   (`RemoteLinkOverlay`) covers the in-WebView case, the shell covers the
   cold-start case.

## Native TODOs (require Android tooling to implement)

- [ ] Foreground service + notification channel (`@capacitor/background-runner`
      or a small custom plugin).
- [ ] Biometric gate on `MainActivity.onResume` (`androidx.biometric`).
- [ ] `getWindow().addFlags(FLAG_SECURE)` in `MainActivity.onCreate`.
- [ ] Battery-optimisation exemption prompt at first run (so Doze does not
      suspend the service too aggressively).
- [ ] Cert pinning: parse the fingerprint from the QR, install a
      `X509TrustManager` that accepts only that cert for the paired host.

## Files

- `capacitor.config.ts` — app id, name, and the QR-bootstrap start page.
- `www/index.html` — the bootstrap page: scan a QR, then `location.href` to the
  host URL (the WebView then runs the host-served renderer).
- `package.json` — Capacitor deps (install on a machine with Android tooling).

The web app already speaks this shell's language: `remote-api.ts` reads the
`#t=` token, exchanges it for a per-run credential, and drives the light/full
channel on `visibilitychange`. The shell only needs to open the URL and provide
the four native capabilities above.
