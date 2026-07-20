import type { CapacitorConfig } from '@capacitor/cli'

// Thin companion shell (PLAN MB6). No bundled web UI beyond the QR-bootstrap
// page in www/: once a host is scanned, the WebView navigates to the
// PC-served renderer, so the app is always at the host's exact version.
const config: CapacitorConfig = {
  appId: 'io.koryphaios.companion',
  appName: 'Koryphaios Companion',
  webDir: 'www',
  server: {
    // The host uses a self-signed cert; allow it (pinning is enforced natively
    // once paired — see README native TODOs). LAN only.
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
