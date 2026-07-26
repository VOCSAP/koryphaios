# Koryphaios — Android shell

One app, **two features that must not be confused** (PLAN N5).

|  | Companion | Approvals |
|---|---|---|
| What it is | the Deck's UI, mirrored on the phone | answering a waiting session |
| Reaches you | on the **same Wi-Fi** as that Deck | **anywhere**, through the broker + ntfy |
| Needs a Deck running | yes — it serves the UI | **no** |
| Paired with | one entry **per Deck** | one **operator identity** |
| Pairing lives in | `koryphaios.companion.*` | `koryphaios.approvals.*` |

A device can do both. They are still two pairings, two lifecycles and two
threat models: forgetting every Deck must not cost you your approvals, and
unpairing approvals must not forget your Decks. A test holds that property
(`tests/mobile-shell-approvals.test.ts`).

## This directory is a scaffold, not an APK

Building needs the Android SDK + Gradle, which are not present in the CI/dev
container. What *is* verified here is everything that decides anything:

```bash
bun test tests/mobile-shell-*.test.ts       # 62 cases, no device needed
cd desktop/mobile-shell && npm run build    # proves the bundle builds
```

The wire format is not restated in this directory: `src/` imports
`notify/ntfy-protocol.ts` — the module the **broker** uses — so the two ends
cannot drift. That import is why `stripControl`/`truncate` live in a
dependency-free `shared/text.ts`: the protocol has to bundle into a WebView,
where `node:crypto` does not exist. The built bundle is ~14 KB and pulls in no
Node builtin.

## Layout

```
src/            decision logic — pure, under `bun test`
  storage.ts          the persistence seam (Preferences / localStorage / Map)
  paired-hosts.ts     COMPANION: the multi-host registry + QR parsing
  approval-pairing.ts APPROVALS: the ntfy pairing
  approval-inbox.ts   APPROVALS: the reducer over received messages
  ntfy-client.ts      the phone's two legs to ntfy (foreground)
  platform.ts         the native seam, with a browser fallback for each call
  app.ts              DOM wiring only
www/            index.html + the built bundle (www/dist is gitignored)
android-src/    the Kotlin Capacitor does not generate — see its README
```

## Companion mode: several Decks

Successive QR scans build a list of `{url, label, certificate fingerprint,
resume credential}` with a selector. Nothing changes on the desktop side —
each Deck keeps serving its own companion server, and it does not know or care
that the phone knows others.

Two details that are easy to get wrong:

- **Re-scanning a known Deck refreshes it, it does not duplicate it.** The QR
  is how you get a fresh token after the desktop app restarted; that is the
  common case, not a new pairing.
- **The stored credential is a resume hint, not a permanent key.** The
  desktop's `CompanionAuth.arm()` wipes every credential each time the
  companion server starts, and the QR token is single use. So the credential
  buys back "put the phone down, pick it up an hour later" across an app kill,
  and nothing more. When it is refused the entry survives — the address and
  the pin are still right, only a fresh QR is needed.

## Approvals mode: reachable anywhere

Scanning the QR from `Settings > Notifications > Koryphaios mobile` stores the
ntfy relay and the two topics, then publishes the pairing code so the broker
binds the topic to your operator identity. From then on:

- questions arrive on the notification topic — as an Android notification when
  the foreground service is running, in the app's list either way;
- **Approve / Reject** are one tap, from the notification or the list;
- **free text** is typed in the app. It cannot be a notification action: an
  ntfy action button carries a *fixed* body (EXPLORATION §4.3c). That single
  constraint is why this screen exists rather than leaning on the official
  ntfy app.

Answering is publishing on the replies topic. Whether the answer *wins* is the
broker's decision, never the phone's (C-1); a request answered elsewhere is
retired by the closing message the broker publishes, because ntfy cannot edit
a delivered one.

## What is native, and why it has to be

| Capability | Why a WebView cannot |
|---|---|
| Foreground service (`connectedDevice`) | Doze suspends network access and ignores wakelocks. `dataSync` is capped at 6 h/24 h since Android 15 — it would die overnight, silently |
| Notification actions | the app is not running when the request arrives |
| Certificate pinning | the WebView's only hook is `onReceivedSslError`, and its default is to cancel |
| `FLAG_SECURE` + biometric gate | a terminal leaks paths and sometimes secrets into the recent-apps thumbnail |
| Battery-optimisation exemption | OEM skins kill beyond AOSP rules (dontkillmyapp.com) |
| QR scanning | camera access |

Each has a documented degradation when the plugin is absent, so the whole flow
can be walked through in a plain browser: `scanQr` falls back to a prompt,
`startApprovalService` returns false (foreground-only operation),
`openHost` navigates without pinning.

## Build on a machine with Android tooling

```bash
cd desktop/mobile-shell
npm install
npm run build            # src/ -> www/dist/app.js
npx cap add android
cp -r android-src/java/* android/app/src/main/java/
# merge android-src/AndroidManifest-additions.xml into the generated manifest
npx cap sync
npx cap run android
```

Field checks that need a real phone are listed in `BACKLOG.md` §3.2.
