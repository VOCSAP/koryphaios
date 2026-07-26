# Remote approvals (answering an agent from your phone)

> **Status.** All three channels — Telegram, Discord and **Parastatès**, the
> Koryphaios companion app — are connected from `Settings > Notifications`.
> Parastatès is built from source (`desktop/mobile-shell/`); there is no store
> listing yet.
> End-to-end testing on a real phone is still pending, so treat the first run
> as a trial.

When a session stops and waits for you — a tool-permission dialog, a plan to
approve, an open question — Koryphaios can register that as an **approval**
and let you answer it from somewhere other than the machine: your phone, over
Telegram, Discord, or Parastatès — the Koryphaios companion app.

Answering anywhere settles the question everywhere. If you answer in the Deck,
the phone notification becomes "already handled"; if you answer on the phone,
the Deck applies it to the session. The first answer wins and the others are
told so — there is no way to answer twice.

## What it does not do

- It does **not** freeze your sessions. A session that is waiting was already
  waiting; nothing new blocks. If nobody ever answers, nothing breaks — the
  session sits on its dialog exactly as it would without this feature.
- It does **not** expose your PC. Every channel is reached by an **outgoing**
  connection. No port is opened, no address is published, nothing on your
  machine becomes reachable from the internet.

## Turning it on

Two levels, and the global one always wins:

1. **Globally** — `Settings > Notifications > Remote approvals`. Off by
   default, because turning it on means the text of a question leaves your
   machine.
2. **Per project** — the same screen offers an opt-out for the current
   project. A project can only ever *restrict* what the global switch allows;
   you cannot enable a single project while the global switch is off.

## Your operator identity

Approvals are routed to a **person**, not to a machine. The first time you
enable the feature, the app mints an operator identity and keeps it in the
per-user application data folder. Two consequences worth knowing:

- **Two accounts on one PC are separate.** If two Windows/macOS/Linux accounts
  use Koryphaios on the same machine, each has its own identity, so one never
  receives the other's approvals.
- **Two PCs can share one identity.** That is what *linking* is for: your
  phone is paired once, and every linked PC reaches it. See
  [Linking a second PC](#linking-a-second-pc).

## The Channels screen

`Settings > Notifications > Channels` lists every supported channel with its
icon, its name, and a **Connect** / **Disconnect** button.

- **Connect** walks you through the enrolment for that channel and ends by
  pairing it to your operator identity.
- **Disconnect** removes the pairing. Approvals stop being sent there
  immediately; nothing else changes.

You can connect several channels at once. When you do, a question is sent to
all of them, and whichever you answer from settles it — the others update
themselves to say it has been handled.

---

## Connecting Telegram

You create your own bot; it talks only to you. Roughly two minutes.

1. In Telegram, open a chat with **@BotFather**.
2. Send `/newbot`, then give it a name and a username (the username must end
   in `bot`).
3. BotFather replies with an **API token** — a long string like
   `110201543:AAHdqTcv…`. Copy it.
4. In Koryphaios, click **Connect** on the Telegram row and paste the token.
5. The app shows a link and a QR code. Open the link (or scan it) and press
   **Start** in Telegram. That is the pairing: the app now knows which chat is
   yours, and ignores everyone else's.

**Answering.** Suggested answers appear as buttons. For anything else, just
**reply** to the message and type freely — your reply reaches the agent as
text.

**Notes.**
- Only *you* can drive the bot. Its username is public, so strangers can
  message it, but anything from a chat other than the paired one is discarded.
- The token is the bot's password: keep it out of screenshots and repositories.
  If it leaks, send `/revoke` to BotFather and reconnect.
- If your PC is off for more than 24 hours, Telegram drops queued replies. The
  question itself is not lost — answer it in the Deck.

---

## Connecting Discord

Discord needs one extra step Telegram does not: **a bot cannot send you a
direct message unless you share a server with it**. So the flow is *create a
bot, put it in a server you own, then talk to it in DM*. About five minutes.

1. Go to the Discord **Developer Portal** → **New Application**, name it
   whatever you like.
2. Open the **Bot** tab → **Reset Token** → copy the token. (This is what the
   app needs — not the application ID.)
3. Leave **Interactions Endpoint URL** empty. Filling it would make Discord
   deliver events to a public web address instead of to the app.
4. Create a private Discord server for yourself (the **+** button in the
   server list → *Create My Own*). One member is enough; it exists only to
   make you and the bot share a server.
5. In Koryphaios, click **Connect** on the Discord row and paste the token.
   The app builds the **invite link** for you (it reads the application id from
   the token, so you never copy it by hand) — open it and add the bot to the
   server you just created.
6. The app shows a short **pairing code**. Send it to the bot in a direct
   message. That binds the bot to your Discord account.

**Answering.** Each request comes with buttons. To answer in your own words,
press the free-text button and a small form opens — up to 4000 characters.

**Notes.**
- A **dedicated channel is optional.** Requests are delivered by direct
  message, which is both simpler and more private. The server exists purely to
  satisfy Discord's "shared server" rule.
- No privileged intent to enable: Discord lets a bot read message content in
  DMs with itself without any special permission. (That is only needed to read
  a *server channel*, which this setup does not use.)
- If the token leaks, use **Reset Token** in the portal and reconnect.

---

## Connecting Parastatès (the Koryphaios app)

**Parastatès** — *παραστάτης*, the chorus member who stands beside the leader —
is the Koryphaios companion app. It doubles as a notification channel, so you do
not need a third-party messenger — and it is the only channel where you can answer in
your own words without a third party reading it.

It works through **ntfy**, a small relay. Your PC *publishes* to it and
*subscribes* to it; so does your phone. Neither ever accepts an incoming
connection, which is why nothing on your machine becomes reachable.

1. Install Parastatès on your phone (built from `desktop/mobile-shell/` — see
   its README; there is no store listing yet).
2. In Koryphaios, click **Connect** on the **Parastatès** row.
   - **ntfy server** — `https://ntfy.sh` works as it is. Point it at your own
     server instead if you would rather the questions never touch someone
     else's infrastructure.
   - **Access token** — optional, and worth the two minutes on a shared
     server. See the warning below.
3. A QR code appears. Scan it with the app. Pairing is done.

That pairing is **global**: it survives app restarts and covers every project
and every session — you do not re-pair for each session. And unlike the
companion *screen mirror*, which needs the phone on the same Wi-Fi, this
reaches you anywhere.

**Answering.** Permission requests carry **Approve** and **Reject**, tappable
straight from the notification. For anything else, open the app and type: free
text is the one thing a notification button cannot carry, because its payload
is fixed when the message is sent.

**The QR is a credential, not a link.** It contains the two topic names and
your access token. Whoever photographs it can read your questions *and* answer
them. Scan it and close it, exactly like the multi-PC link code.

**Your topics are your lock.** Koryphaios generates two unguessable topic
names, one per direction, and mints fresh ones every time you reconnect — so
**Disconnect** followed by **Connect** stops a lost phone receiving anything
further.

**But it does not rotate your ntfy token.** If you configured one, the lost
device still holds a valid credential for your ntfy *account* — re-minting
topics cannot revoke something ntfy issued. To finish the job, revoke that
token on the ntfy side (`ntfy token remove`, or the account page on ntfy.sh)
and paste a fresh one when you reconnect. Treat the two steps as one
procedure: the topics are the lock, the token is the key to the building.
On a shared server such as ntfy.sh, an access token is what stops anyone who
learns a topic name from reading it; without one, the names are the only
secret. Note that read access to your notification topic implies the ability
to answer: the questions it carries contain the request identifiers.

**If your PC is off.** Nothing is lost while it is off — the *notification*
expires after 24 hours, but the session is still waiting and you can answer it
in the Deck.

---

## Linking a second PC

Your identity belongs to you, not to a machine. To have a second PC reach the
same phone and the same channels:

1. On the PC that is already set up: `Settings > Notifications` → **Show the
   link code**. A QR code appears. It carries your operator identity, so it is
   only fetched when you ask for it — hide it again as soon as the other
   machine has read it.
2. On the second PC: paste the same code into **Link this PC**.

Both machines now share one identity, so nothing needs re-pairing on the phone.
Requests are labelled with their origin — `bureau · koryphaios`,
`portable · api-gateway` — so you can tell concurrent questions from two PCs
apart. Answering one has no effect on the other.

## What travels, and what does not

Only the **question** is sent: the tool being requested and its arguments, or
the text of an open question, plus a short origin label. The terminal contents
are never sent.

That said, a question can legitimately contain a file path or a command line.
Content sent through Telegram or Discord passes through their servers in the
clear, as any message would; the same is true of a shared ntfy server. If a
project is sensitive, use the per-project opt-out — or run your own ntfy, which
is the one option here that keeps the text on infrastructure you control.

## Expiry and stale requests

A notification stops being answerable remotely after **24 hours** (your broker
administrator can change this). Only the *notification* expires — the session
is still waiting and you can still answer it in the Deck.

If you try to answer a request that has already been handled — from another
channel, or in the Deck — you get **"Validation expired or invalid / already
handled"**. That is the expected behaviour, not an error.

## Troubleshooting

**Nothing arrives on my phone.** Check, in order: the global switch is on; the
current project is not opted out; the channel shows as connected; the broker is
reachable (the status dot in the sidebar).

**Nothing arrives on the app when the screen is off.** Android suspends
background network access, so the app keeps a foreground service running — it
shows a permanent low-priority "Listening for approvals" notification. If that
notification is gone, the system killed it: grant the battery-optimisation
exemption the app asks for at pairing. Some manufacturers (Xiaomi, Samsung and
others) are more aggressive than Android itself; `dontkillmyapp.com` lists the
setting to change per brand.

**The app says a request is already handled.** Someone answered it first —
most often you, in the Deck. Because ntfy cannot edit a message it has already
delivered, the app is told by a second, silent message rather than by the
first one changing; that is why you may briefly see both.

**The Deck says a request was already handled.** Someone or something answered
it first — most often you, in the tile itself. Answering in the terminal
settles the approval too.

**I answered on my phone but the session did not move.** The answer is only
typed in if the session is *still* waiting on that prompt. If you had already
dealt with it locally, the remote answer is deliberately dropped rather than
typed into whatever is on screen now.

**I changed OS user / restored a profile and pairing is gone.** The identity
lives in the per-user application data. Re-enable the feature to mint a new
one, then reconnect the channels — or link this PC from another one that still
has the old identity.

See also: [companion.md](companion.md) for the phone *screen mirror* (a
different feature: same-Wi-Fi remote control), [settings.md](settings.md) for
where these options live, [sessions.md](sessions.md) for the "needs you"
detection that raises approvals.
