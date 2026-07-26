# Native Android sources

`npx cap add android` **generates** the Gradle project under `android/` (which
is gitignored — it is a build artefact, not source). The files in this
directory are the parts Capacitor does not generate: they are copied into the
generated project, as documented in each file's header.

**They are not compiled here.** The container that builds this repository has
no Android SDK, so nothing under `android-src/` is checked by `bun test` or by
a typecheck. What *is* checked is everything they call into: the pairing
parsing, the host registry, the inbox reducer and the wire format all live in
`../src/` and in `notify/ntfy-protocol.ts`, under test. The Kotlin here is
deliberately thin for that reason — it moves bytes and manages Android
lifecycles, it does not decide anything.

## Install

```bash
cd desktop/mobile-shell
npm install
npm run build          # bundles src/ -> www/dist/app.js
npx cap add android
cp -r android-src/java/* android/app/src/main/java/
# then merge android-src/AndroidManifest-additions.xml into
# android/app/src/main/AndroidManifest.xml (the blocks are annotated)
npx cap sync
npx cap run android
```

## What each file is for

| File | Covers |
|---|---|
| `java/io/koryphaios/shell/MainActivity.kt` | `FLAG_SECURE`, biometric gate on resume |
| `java/io/koryphaios/shell/KoryphaiosShellPlugin.kt` | the `KoryphaiosShell` bridge `platform.ts` calls |
| `java/io/koryphaios/shell/ApprovalService.kt` | the foreground service that keeps listening in Doze |
| `java/io/koryphaios/shell/PinnedTrust.kt` | certificate pinning for companion mode |
| `AndroidManifest-additions.xml` | permissions and the service type declaration |

## The two traps these files exist to avoid

**Doze cuts the network with the screen off.** A WebView cannot listen
passively: Android suspends network access and ignores wakelocks. Only a
foreground service survives, and since Android 15 the `dataSync` type is capped
at 6 h per 24 h — a cap that would silently kill approvals overnight, which is
exactly when they matter. `ApprovalService` therefore declares
`connectedDevice`, which has no such cap and is the honest description of what
it does (it maintains a link to the operator's broker on their behalf). OEM
skins kill beyond AOSP rules, so the app also asks for a battery-optimisation
exemption on first pair.

**ntfy action buttons carry a fixed body.** They can express Approve and
Reject, and nothing else — no free text. So the notification posted by
`ApprovalService` carries the two actions natively AND a "Answer…" action that
opens the app on the request, which is where the compose box lives.
