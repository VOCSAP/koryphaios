import type { CapacitorConfig } from '@capacitor/cli'

// Parastates — the Koryphaios companion app (PLAN N5, ex-MB6).
//
// παραστάτης — the chorus member who stands beside the leader. The app id keeps
// the `io.koryphaios` namespace because this is a satellite of Koryphaios, not
// a separate product; it is changed now, before any store listing exists, since
// an app id cannot move afterwards without orphaning installs.
//
// The shell carries TWO features: companion mode (the Deck-served UI over the
// LAN) and approvals mode (ntfy, reachable anywhere). Only the shell's own
// picker/approvals UI is bundled in www/; the companion interface still comes
// from the host, so the phone is always at that host's exact version.
const config: CapacitorConfig = {
  appId: 'io.koryphaios.parastates',
  appName: 'Parastatès',
  webDir: 'www',
  server: {
    // A paired Deck uses a self-signed cert, pinned natively from the
    // fingerprint in its QR (android-src/…/CompanionWebView.kt). Cleartext
    // stays off: the QR parser refuses a plain-http host in the first place.
    cleartext: false,
    androidScheme: 'https'
  },
  android: {
    // A terminal shows paths/secrets: block screenshots + recent-apps preview.
    // (FLAG_SECURE is also set natively in MainActivity as defense in depth.)
    allowMixedContent: false
  }
}

export default config
