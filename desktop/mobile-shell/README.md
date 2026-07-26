# Parastatès — the Koryphaios companion app

*παραστάτης*, the chorus member who stands beside the leader: Koryphaios leads
the chorus, Parastatès stands next to it.

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
bun test tests/mobile-shell-*.test.ts       # 71 cases, no device needed
bunx tsc --noEmit -p desktop/mobile-shell/tsconfig.json
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
- **Restarting the APP does not ask for a new QR; restarting the DECK does.**
  That asymmetry is not an accident: the desktop's `CompanionAuth.arm()` wipes
  every credential each time the companion server starts, and the QR token is
  single use. So closing the Deck genuinely ends the remote session. Killing
  the app does not — the credential lives on, and the entry keeps its address
  and its pin.

  Making that true takes a round trip worth knowing about, because it spans
  the one boundary that is not under test. The credential is minted by the
  host into the WebView's `sessionStorage`, which dies with the app. The
  native viewer therefore copies it out (polling briefly — it appears during
  the WebSocket handshake, not at page load) and leaves it in a flat drop box,
  `koryphaios.companion.lastcred`. The shell folds it into its list on boot
  and on every resume (`absorbPendingCredential`). The Kotlin writes one
  value and knows nothing about the list; every rule about the list stays in
  TypeScript, under test.

## Approvals mode: reachable anywhere

Scanning the QR from `Settings > Notifications > Parastatès` stores the
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

## Building it

The toolchain (JDK 17, Android SDK, the two Gradle dependencies Capacitor does
not bring) and the step-by-step are in **[`BUILDING.md`](../../BUILDING.md) §5**
— one place, so they cannot drift from the desktop instructions next to them.

Field checks that need a real phone are listed in `BACKLOG.md` §3.2.
