import type { CapacitorConfig } from '@capacitor/cli'

// Koryphaios mobile shell (PLAN N5, ex-MB6).
//
// The app id says `companion` for history's sake — changing it would orphan
// every already-installed build — but the shell now carries TWO features:
// companion mode (the Deck-served UI over the LAN) and approvals mode (ntfy,
// reachable anywhere). Only the shell's own picker/approvals UI is bundled in
// www/; the companion interface still comes from the host, so the phone is
// always at that host's exact version.
const config: CapacitorConfig = {
  appId: 'io.koryphaios.companion',
  appName: 'Koryphaios',
  webDir: 'www',
  server: {
    // A paired Deck uses a self-signed cert, pinned natively from the
    // fingerprint in its QR (see android-src/PinnedTrust.kt). Cleartext stays
    // off: the QR parser refuses a plain-http host in the first place.
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
