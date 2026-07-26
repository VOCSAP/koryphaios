# EXPLORATION — Notifications mobiles & validation à distance

> Audit de faisabilité (2026-07-25, base `experimental` fe0e98e). Intention :
> **« Pouvoir via un téléphone mobile, approuver / discuter / rejeter les
> demandes des agents œuvrant dans n'importe quelle App Desktop, via un
> appairage d'équivalence Téléphone ↔ PC »** — appairage global par appareil
> (une fois par téléphone/PC), pas par session. Réponse par **prompt libre**,
> pas seulement oui/non. Sources : documentations officielles Discord,
> Telegram, Android/Firebase, ntfy, Pushover, Tailscale (URLs citées en fin de
> chaque section).

---

## 1. TL;DR — options recommandées par facilité de déploiement

| # | Option | Endpoint public côté PC ? | Texte libre ? | Setup utilisateur | Effort dev | Verdict |
|---|--------|---------------------------|---------------|-------------------|-----------|---------|
| 1 | **Telegram Bot (long polling)** | **Non** (HTTPS sortant uniquement) | ✅ natif (ForceReply / reply) | ~2 min (BotFather → coller le token) | **Faible** (~100 lignes de `fetch`, zéro dépendance) | **V1 recommandée** |
| 2 | **Discord Bot (Gateway WS)** | **Non** (WSS sortant uniquement) | ✅ (modale ≤ 4000 car. ou réponse DM) | ~5 min (app portail + token + serveur privé mutuel) | Moyen (protocole Gateway : identify/heartbeat/resume) | **V1.5** — même abstraction que Telegram, second canal |
| 3 | **App Android (Capacitor) + relais ntfy** | **Non** (pattern deux-topics : le PC publie ET s'abonne en sortant) | ✅ (composé dans notre app) | Faible-moyen (QR topic+token ; app à builder) | **Élevé** (natif Android : FGS, Doze, FCM du flavor Play) | **V2** — le candidat idéal, mais le plus coûteux |
| — | Tailscale (complément) | Non (overlay VPN) | n/a | Moyen (installer + login sur les 2 appareils) | Quasi nul (étendre `isPrivateAddress` à 100.64/10) | **Complément** du mode compagnon en itinérance |
| ✗ | FCM direct | Non, mais clé « sender » à héberger | — | **Très élevé** (projet Firebase + build APK par utilisateur, ou relais hébergé par le mainteneur) | Élevé | Écarté pour un projet OSS |
| ✗ | Pushover | Non pour l'envoi, **URL publique pour les callbacks** | ❌ aucun mécanisme | 4,99 $ + enregistrement d'app | Faible | Écarté (pas de réponse libre) |
| ✗ | LAN pur (WS persistant, sans relais) | Non (LAN only) | ✅ | Faible | Élevé (FGS + exemption batterie + OEM killers) | Écarté comme canal de **validation** (Doze ; et cesse de fonctionner hors du Wi-Fi — contraire au besoin) |

> **Révision du 2026-07-25 (addendum §7–§12)** — après questions sur la
> topologie réelle (broker = serveur LAN distant, multi-PC, multi-compte OS),
> deux points de ce tableau sont **amendés** : (1) la passerelle notifications
> vit dans le **broker**, pas dans le Deck → plus besoin d'« un bot par PC » ;
> (2) la détection des questions passe d'abord par les **hooks Claude Code**
> (déterministes), le scraping PTY devenant le filet de secours. Voir §7–§12.

**Réponse à la question réseau** : non, on n'est **pas** obligé d'exposer
publiquement quoi que ce soit. Les trois canaux retenus fonctionnent derrière
NAT car le PC n'a que des connexions **sortantes** : long polling HTTPS
(Telegram), WebSocket Gateway (Discord), publication + abonnement SSE/WS à un
serveur ntfy (app Android). Le « serveur public » existe toujours, mais c'est
celui du fournisseur (api.telegram.org, gateway.discord.gg, ntfy.sh ou un VPS
ntfy auto-hébergé) — jamais le PC de l'utilisateur.

---

## 2. Ce que le code sait déjà faire (base `experimental`)

L'essentiel de la plomberie existe ; le sujet est surtout un **nouveau canal de
transport + une machine à états d'approbation**, pas une refonte.

1. **Détection « needs you »** — `desktop/src/main/attention.ts` (C11) :
   buffer PTY ANSI-strippé par session, épisodes waiting=true/false, patterns
   `❯ 1.` (tool-permission, plan approval, AskUserQuestion) + trust prompt,
   fermeture sur cue « busy ». Limite v1 assumée : les questions texte libre
   sans menu ne sont pas détectées. C'est le **déclencheur** naturel des
   notifications sortantes ; il faudra en extraire le bloc question + options
   (le buffer contient le texte d'écran strippé) pour le corps de la notif.
2. **Chemin de retour** — le main process sait injecter des frappes dans le
   PTY d'une session (auto-resume quota : `quota.ts` émet `resume-due`, le
   session service tape `continue`). Une réponse distante = numéro d'option
   et/ou texte + Entrée, **après re-vérification** que la session est
   toujours en état `waiting` (l'écran a pu changer).
3. **Companion LAN** — `companion-server.ts` (MB1/MB2/MB5) : HTTPS+WS
   éphémère, LAN only (`isPrivateAddress`), QR à token one-shot → credential
   per-run, cert self-signed stable, révocation par appareil. Le *light
   channel* ne laisse déjà passer que les événements signaux
   (`session:attention`, `inbox:new`, `session:quota`, `broker:status`) —
   pensé pour devenir des notifications Android.
4. **mobile-shell/** (MB6) — scaffold Capacitor non buildé ; TODOs natifs
   (foreground service, biométrie + FLAG_SECURE, pinning cert, exemption
   Doze) déjà listés. Une seule URL hôte bootstrapée aujourd'hui.
5. **Broker** — singleton HTTP+WS+SQLite, déjà multi-host (mode HTTP +
   `broker_token`), avec des patterns de durabilité directement réutilisables
   (`graph_drafts` : statut pending/opened, listing non destructif, TTL).
   C'est le lieu naturel de la table `pending_approvals` (source de vérité du
   « premier répondeur gagne »).
6. **Config à deux étages** — `shared/config.ts` (global) +
   `.claude-peers.local.json` (projet) + settings app-state du Deck
   (pattern `sandbox.json`) : le modèle demandé « activation globale,
   désactivable par projet, pas activable localement si off global » a déjà
   son mécanisme.

---

## 3. Architecture cible commune (indépendante du canal)

Tout canal (Deck UI, companion LAN, Telegram, Discord, app Android) devient un
**consommateur/répondeur** d'une même entité `approval` :

```
attention.ts (waiting=true)
      │  extrait question + options du buffer
      ▼
Deck ──POST /approval/add──▶ Broker: pending_approvals
      │                       { id, project_key, group_id, session/peer_id,
      │                         question, options[], created_at,
      │                         status: pending|answered|expired_notif,
      │                         answered_via, answered_at, answer_text }
      ▼
Passerelle notifications (Deck) ──▶ canal choisi (Telegram/Discord/ntfy)
      ...
Réponse entrante (n'importe quel canal, y compris le Deck lui-même)
      │
      ▼
POST /approval/claim { id, via, answer }   ← transaction SQLite atomique
      ├─ status=pending  → answered ; le Deck injecte la réponse dans le PTY
      └─ sinon           → 409 → le canal affiche
                           « Validation expirée ou invalide / déjà traitée »
```

Décisions structurantes :

- **Single-consumer via le broker** : `claim` est un UPDATE conditionnel
  (`WHERE status='pending'`) dans une transaction — le premier répondeur
  gagne, tous les autres canaux reçoivent 409 et affichent le message d'erreur
  demandé. Une réponse donnée **dans le Deck** (ou directement au clavier dans
  la tuile) doit aussi « claim » : la fermeture d'épisode d'attention
  (waiting=false) claim l'approbation avec `via='deck'`, ce qui invalide les
  notifs distantes. Sur les canaux qui le permettent, la notif est alors
  éditée (Telegram `editMessageText`, Discord edit) en « ✅ déjà traitée ».
- **Expiration 24 h (notif seulement)** : un sweep broker (même pattern que
  `purgeOldMessages`) passe `pending` → `expired_notif` après
  `APPROVAL_NOTIF_TTL_HOURS` (défaut 24, surchargeable en **conf globale** —
  broker en mode HTTP partagé, sinon config utilisateur). La **session reste
  en attente** : seul l'état « répondable à distance » expire ; la question
  reste répondable dans le Deck (un claim `via='deck'` reste accepté sur
  `expired_notif`).
- **Activation** : interrupteur global dans les settings du Deck
  (Settings > Notifications) + opt-out par projet (fichier local projet ou
  réglage par-projet app-state, comme le sandbox). La logique est
  `effectif = global && !optOutProjet` — impossible d'activer localement si
  le global est off, conformément au besoin.
- **Qui porte la passerelle ?** Le **Deck** (main process) en V1 : c'est lui
  qui voit les épisodes d'attention et qui peut injecter la réponse. Cas
  multi-PC (deux Decks, un même bot) : voir §4.1 (Telegram n'admet qu'un
  seul consommateur `getUpdates` par token).
- **Sécurité transversale** : tokens de bot chiffrés au repos via
  `safeStorage` (pattern déjà en place pour les graphes K8 /
  `provider-secrets.ts`), jamais dans le repo ni la config projet ;
  journalisation de chaque claim (journal d'activité existant) ; le contenu
  des questions transite chez un tiers (Telegram/Discord) — à documenter
  comme trade-off de confidentialité (un écran de session peut contenir des
  chemins/secrets ; ne notifier que le bloc question, pas l'écran entier).

---

## 4. Analyse par canal (docs officielles)

### 4.1 Telegram Bot — la V1 (faisabilité : verte)

**Transport.** `getUpdates` en long polling est une requête HTTPS **sortante**
vers `api.telegram.org` — aucun endpoint entrant, NAT-friendly ; seul
`setWebhook` exigerait une URL publique, et les deux modes sont mutuellement
exclusifs. ([Bot API — getting updates](https://core.telegram.org/bots/api#getting-updates),
[getUpdates](https://core.telegram.org/bots/api#getupdates))

**UX.** Boutons inline (`callback_data` 1–64 octets, styles danger/success
depuis Bot API 10.x) pour les choix numérotés ; **ForceReply** (« act as if
the user has selected the bot's message and tapped 'Reply' ») +
`reply_to_message` pour corréler une **réponse texte libre** à la question
exacte — c'est le pattern canonique, natif, sans app à développer. Messages
≤ 4096 caractères (splitter au-delà) ; `parse_mode: HTML` recommandé pour du
texte machine (MarkdownV2 exige un échappement agressif).
`editMessageText`/`editMessageReplyMarkup` permettent de réécrire la notif en
« ✅ traitée / ⌛ expirée » et de retirer les boutons.
([formatting](https://core.telegram.org/bots/api#formatting-options),
[ForceReply](https://core.telegram.org/bots/api#forcereply))

**Setup utilisateur (~2 min).** @BotFather → `/newbot` → coller le token dans
le Deck. Pas de chat_id à chercher : les bots ne peuvent pas initier une
conversation, donc le Deck génère un deep link `t.me/<bot>?start=<secret>`
(payload ≤ 64 car.) affiché en QR ; le premier `/start <secret>` fournit
`chat.id`, persisté — c'est l'**appairage global** demandé (une fois par
compte Telegram, valable pour toutes les sessions et tous les projets).
([BotFather](https://core.telegram.org/bots/features#botfather),
[deep links](https://core.telegram.org/api/links#bot-links))

**Sécurité.** Le bot est trouvable publiquement et il n'y a pas de whitelist
API : le verrou est applicatif — **rejeter tout update dont
`chat.id`/`from.id` ≠ l'id appairé** (les ids sont authentifiés par Telegram,
non falsifiables via l'API). En privé 1-à-1, le bot reçoit tous les messages
quel que soit le privacy mode — rien à configurer.
([privacy mode](https://core.telegram.org/bots/features#privacy-mode))
Token fuité = contrôle du bot (lire les updates en attente — dont les réponses
de l'utilisateur —, envoyer de faux messages, poser un webhook qui détourne le
flux) mais **pas** d'accès au compte Telegram de l'utilisateur ; révocation
immédiate via `/revoke` BotFather. Effet de bord utile : un voleur qui
consomme `getUpdates` provoque des 409 côté Deck — signal de compromission.
([FAQ](https://core.telegram.org/bots/faq))

**Contraintes structurantes.**
- **Un seul consommateur `getUpdates` par token** (409 `Conflict` sinon) →
  la passerelle doit être unique. Deux Decks ouverts sur deux PCs : V1 = un
  bot par PC (2 min de setup supplémentaires, messages préfixés par l'hôte) ;
  V2 possible = déplacer la passerelle dans le broker partagé (déjà singleton
  en mode HTTP).
- Les updates non consommés sont **purgés après 24 h** côté Telegram — PC
  éteint > 24 h, les réponses en file sont perdues (cohérent avec notre
  expiration de notif à 24 h).
- Rate limits sans objet à notre volume (~1 msg/s par chat, 429+`retry_after`).

**Implémentation.** L'API est du HTTPS pur (`https://api.telegram.org/bot<token>/<method>`,
JSON) : un client complet (sendMessage, boucle getUpdates, editMessageText,
answerCallbackQuery) tient en ~100 lignes de `fetch` Bun/Node, **zéro
dépendance** — pas de surface supply-chain sur un composant qui manipule un
secret. (Alternative si middleware souhaité : grammY.)
([making requests](https://core.telegram.org/bots/api#making-requests))

### 4.2 Discord Bot — le second canal (faisabilité : verte)

**Transport.** Par défaut une app reçoit **tout par la Gateway WebSocket
sortante** (`wss://gateway.discord.gg`) : messages DM (`MESSAGE_CREATE`,
intent standard `DIRECT_MESSAGES`), clics de boutons et **soumissions de
modales** (`INTERACTION_CREATE`, aucun intent requis). L'« Interactions
Endpoint URL » est un **opt-in** mutuellement exclusif — il suffit de ne pas
le configurer (à écrire dans la doc utilisateur : ce champ doit rester vide,
sinon la Gateway cesse de recevoir les interactions). Les réponses aux
interactions partent en HTTPS sortant.
([Interactions overview](https://discord.com/developers/docs/interactions/overview),
[Receiving & responding](https://discord.com/developers/docs/interactions/receiving-and-responding),
[Gateway](https://discord.com/developers/docs/events/gateway))

**UX.** Boutons (5/ligne, label ≤ 80 car.) → au clic, ouverture d'une
**modale avec Text Input libre ≤ 4000 caractères** (valide en DM, aucune
restriction de contexte documentée) ; ou réponse DM en texte libre
(`message_reference` pour la corrélation). Messages ≤ 2000 caractères
(embeds jusqu'à 6000). Pas de threads en DM (utiliser un salon privé si le
threading importe un jour).
([Components](https://discord.com/developers/docs/components/reference),
[Modals](https://discord.com/developers/docs/components/using-modal-components))

**Setup utilisateur (~5 min).** Créer l'app sur le portail développeur, copier
le token, **créer un petit serveur privé personnel et y inviter le bot** — un
bot ne peut pas DM sans serveur mutuel (erreur 50278 « no mutual guilds ») ;
le Deck peut pré-générer l'URL OAuth2 d'invitation. **Aucun intent privilégié
nécessaire** : le contenu des messages est exempté dans les DMs avec l'app
(l'intent privilégié MESSAGE_CONTENT ne serait requis que pour du texte libre
dans un salon de serveur — self-service < 10 000 utilisateurs de toute façon).
([Getting started](https://discord.com/developers/docs/quick-start/getting-started),
[opcodes 50278](https://discord.com/developers/docs/topics/opcodes-and-status-codes),
[message content intent](https://discord.com/developers/docs/events/gateway#message-content-intent))

**Sécurité.** Token fuité = identité complète du bot (lire l'historique du DM
avec l'utilisateur, envoyer de faux messages) mais borné au serveur privé
d'un membre ; « Reset Token » invalide immédiatement. Inviter avec le minimum
de permissions (les DMs n'exigent aucune permission de serveur).

**Contraintes/multi-PC.** Contrairement à Telegram, plusieurs connexions
Gateway simultanées avec un même token sont possibles (sessions) — mais deux
Decks recevraient alors chaque événement en double ; le claim atomique du
broker rend le doublon inoffensif (le second reçoit 409). Limites de débit
sans objet (50 req/s global, 1000 identifies/24 h).
([Rate limits](https://discord.com/developers/docs/topics/rate-limits))

**Implémentation.** Plus lourde que Telegram : le protocole Gateway impose
identify + heartbeat jitteré + resume (`resume_gateway_url`/`seq`). Faisable
en ~200–400 lignes avec le WebSocket natif de Bun/Electron, zéro dépendance
(discord.js est fonctionnel mais lourd ; alternatives modulaires
`@discordjs/{core,ws,rest}`, Eris, Oceanic).

### 4.3 App Android maison — le candidat idéal, en V2 (faisabilité : orange)

Trois sous-variantes étudiées ; la question centrale est « comment réveiller
le téléphone écran éteint, et comment la réponse revient-elle au PC ? ».

**(a) LAN pur (WS persistant du mobile-shell) — écarté comme canal de
validation.** En Doze, Android **suspend tout accès réseau** et ignore les
wakelocks ; il faut un foreground service + type déclaré (Android 15 :
`dataSync` capé à 6 h/24 h → il faudrait `connectedDevice`/`specialUse`) +
exemption d'optimisation batterie, et les OEM (Xiaomi/Samsung…) tuent au-delà
des règles AOSP (dontkillmyapp.com). Et par définition, tout s'arrête en
quittant le Wi-Fi — contraire au besoin « validation depuis n'importe où ».
Le FGS reste pertinent pour le **mode compagnon** (usage actif, appareil en
main), pas pour l'attente passive de validations.
([Doze](https://developer.android.com/training/monitoring-device-state/doze-standby),
[FGS types](https://developer.android.com/develop/background-work/services/fgs/service-types),
[Android 15](https://developer.android.com/about/versions/15/behavior-changes-15))

**(b) FCM direct — écarté pour un projet OSS.** L'API HTTP v1 exige une clé
de compte de service Firebase côté « serveur » : impossible à distribuer dans
une app open source (quiconque la détient pousse vers toutes les
installations). Il faudrait soit un projet Firebase + build APK **par
utilisateur**, soit un relais hébergé par le mainteneur (c'est exactement ce
que ntfy fournit déjà). De plus `@capacitor/push-notifications` n'appelle pas
`pushNotificationReceived` app tuée pour les data-messages (service natif à
écrire), et FCM ne résout **pas** le chemin de retour (downstream only).
([FCM v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api),
[Capacitor push](https://capacitorjs.com/docs/apis/push-notifications))

**(c) Relais ntfy, pattern « deux topics » — la voie recommandée pour
l'app.** Architecture symétrique, tout en sortant :

```
PC ──POST https://ntfy/{topic-notif}──▶ ntfy ──push──▶ téléphone (app)
PC ◀──abonnement sortant WS/SSE {topic-replies}── ntfy ◀──POST── téléphone
```

- Le PC publie la notif (HTTP POST simple) et tient un abonnement **sortant**
  WS/SSE/JSON-stream sur le topic de réponses — aucun endpoint entrant nulle
  part. ([publish](https://docs.ntfy.sh/publish/), [subscribe API](https://docs.ntfy.sh/subscribe/api/))
- Côté téléphone : soit l'app ntfy officielle (flavor Play = vraie
  livraison FCM Doze-proof pour ntfy.sh ; auto-hébergé/F-Droid = FGS
  « instant delivery »), soit **notre app Capacitor via UnifiedPush** (ntfy
  est un distributeur UnifiedPush : notre app reçoit le push sans Firebase, et
  offre l'UI de réponse libre + le renvoi POST). Boutons d'action ntfy (3 max,
  `http` POST à corps prédéfini) = réponses en un tap (« Approuver ») ; le
  texte libre passe par l'UI de notre app (ou la barre de publication de
  l'app ntfy). ([UnifiedPush](https://docs.ntfy.sh/publish/#unifiedpush),
  [actions](https://docs.ntfy.sh/publish/#action-buttons))
- Auth : topics protégés par access tokens `tk_…` ; appairage = QR contenant
  `{serveur, topics, token}` — global par appareil, comme demandé. ntfy.sh
  gratuit : 250 msgs/jour, message ≤ 4096 o (largement suffisant) ; réserve de
  topics = tier payant (~5 $/mois) ; auto-hébergement AGPL gratuit sur un VPS
  (c'est le VPS qui est public, pas le PC).
  ([auth](https://docs.ntfy.sh/publish/#authentication),
  [limits](https://docs.ntfy.sh/publish/#limitations))
- Trade-off : confiance dans l'infra partagée ntfy.sh (ou opération d'un VPS) ;
  chiffrer/minimiser le contenu publié est souhaitable (ntfy n'a pas de E2EE).

**Effort** : c'est l'option qui demande le plus de travail (builder enfin le
mobile-shell + UnifiedPush + UI de réponse + service natif), d'où son
positionnement V2 — mais elle partage l'abstraction `approval` et le canal
serveur avec les V1, rien n'est jeté.

### 4.4 Compléments et écartés

- **Tailscale (complément du mode compagnon)** : overlay WireGuard qui rend
  PC et téléphone mutuellement joignables (IPs stables `100.x`) depuis
  n'importe où, sans port ouvert (relais DERP) — le companion LAN + QR
  actuels fonctionneraient **inchangés en itinérance**. Deux réserves : (1)
  `isPrivateAddress` filtre RFC1918/ULA, or le tailnet est en 100.64.0.0/10
  (CGNAT) → petite extension opt-in à prévoir ; (2) ça ne résout pas Doze —
  c'est un complément du mode compagnon (usage actif), pas un canal de
  validation. Plan gratuit personnel suffisant. ([tailscale.com/pricing](https://tailscale.com/pricing))
- **Pushover — écarté** : envoi trivial mais **aucune réponse texte libre**
  (le callback d'acquittement exige de surcroît une URL publique), client
  fermé, 4,99 $/plateforme. ([API](https://pushover.net/api))

---

## 5. Réponses aux questions posées

- **« Doit-on exposer publiquement les API pour Discord/Telegram ? »** Non.
  Les deux se consomment intégralement en connexions sortantes (long polling /
  Gateway WS) ; le webhook entrant est optionnel chez les deux et on ne
  l'utilise pas. Rien à ouvrir sur la box, pas de reverse proxy, pas de DDNS.
- **« Plusieurs App Desktop simultanées côté app Android (mode compagnon) ? »**
  Oui, faisable sans toucher au desktop : chaque Deck garde son companion
  server ; le mobile-shell doit passer d'« une URL bootstrapée » à une **liste
  d'hôtes appairés** `{url, credential, fingerprint cert}` alimentée par QR
  successifs, avec un switcher (et des notifs préfixées par l'hôte). Travail
  modéré, entièrement dans `mobile-shell/` + `remote-api.ts`. En mode
  **validation**, le multi-PC est encore plus simple : les approbations
  portent `host`/`project_key` et transitent par le canal serveur — pas
  d'appairage par PC côté téléphone (un bot Telegram par PC en V1, ou
  passerelle broker partagée en V2).
- **« Expiration 24 h »** : portée par le broker (source de vérité), défaut
  `APPROVAL_NOTIF_TTL_HOURS=24`, surchargeable en conf globale ; seule la
  notif expire (statut `expired_notif`, message édité « ⌛ expirée »), la
  session reste en attente et reste répondable dans le Deck.
- **« Réponse Deck vs mobile »** : claim atomique broker, premier arrivé
  gagne ; l'autre canal reçoit 409 → « Validation expirée ou invalide / déjà
  traitée », et la notif est éditée quand le canal le permet.
- **« Activation globale / opt-out projet »** : interrupteur global Settings
  du Deck + opt-out par projet ; `effectif = global && !optOutProjet`.

---

## 6. Découpage proposé

**Lot N1 — socle approbations (broker + Deck)** : table `pending_approvals` +
routes `add/claim/list` + sweep TTL ; extraction question/options depuis le
buffer d'attention ; claim `via='deck'` à la fermeture d'épisode ; injection
PTY de la réponse avec re-vérification `waiting`. *(Aucun canal externe encore
— déjà utile : historique des questions dans le Deck.)*

**Lot N2 — canal Telegram (V1 utilisateur)** : client `fetch` zéro-dépendance
(boucle getUpdates single-instance, sendMessage HTML, editMessageText,
answerCallbackQuery) ; appairage deep-link `?start=<secret>` en QR ; verrou
chat_id ; token via `safeStorage` ; Settings > Notifications (global +
opt-out projet) ; doc opérateur (révocation `/revoke`, un bot par PC).

**Lot N3 — canal Discord** : même abstraction `NotificationChannel`, client
Gateway (identify/heartbeat/resume) + REST ; boutons → modale texte libre ;
doc : laisser « Interactions Endpoint URL » vide, serveur privé mutuel.

**Lot N4 (V2) — app Android** : build du mobile-shell (TODOs MB6) +
UnifiedPush/ntfy deux-topics + UI de réponse + multi-hôtes compagnon ;
option Tailscale (extension `isPrivateAddress` opt-in).

---

*Rapports de recherche détaillés (agents du 2026-07-25) : Telegram Bot API
10.2, docs Discord (repo officiel discord-api-docs@main), docs
Android/Firebase/ntfy/Pushover/Tailscale — URLs citées in situ ci-dessus.*

---
---

# ADDENDUM — Chaîne de communication, détection, cloisonnement

> Rédigé après précisions sur la topologie cible : **le broker est un serveur
> LAN distant** (pas le loopback auto-spawné), plusieurs PC l'utilisent, et un
> même PC peut héberger plusieurs comptes OS. Cet addendum amende §1 et §6.

## 7. Comment l'app détecte la question — déterministe ET dynamique

La bonne réponse n'est pas « l'un ou l'autre » : **les deux, sur trois voies
complémentaires**, parce que les types de questions n'ont ni le même
déclencheur ni le même chemin de retour. Point clé découvert en vérifiant la
doc officielle : Claude Code expose des **hooks** qui rendent la détection
**déterministe**, sans scraper l'écran — et le Deck **embarque déjà un
plugin à hooks** (`desktop/deck-plugin/hooks/hooks.json`, aujourd'hui un seul
`SessionStart`), donc le canal d'installation est déjà en place et éprouvé.
([Hooks reference](https://code.claude.com/docs/en/hooks))

| Type de demande | Détection | Nature | Chemin de retour de la réponse |
|---|---|---|---|
| **Permission d'outil** (Bash, Edit, Write, MCP…) | hook **`PermissionRequest`** (se déclenche quand la boîte de permission apparaît ; reçoit `tool_name`, `tool_input`, `tool_use_id`, `cwd`, `session_id`) | déterministe, **structuré**, **bloquant** | le hook **retourne le verdict** : `hookSpecificOutput.decision.behavior` = `allow`/`deny` (+ `updatedInput` optionnel). Aucune injection PTY. |
| **Permission + consigne texte** | hook **`PreToolUse`** | déterministe, bloquant | `permissionDecision` (`allow`/`deny`/`ask`/`defer`) + **`permissionDecisionReason`, montré à Claude dans le transcript** → un « rejet avec prompt » remonte le texte de l'opérateur directement dans le contexte de l'agent |
| **Question ouverte de l'agent** (AskUserQuestion, validation de plan, « je fais A ou B ? ») | **outil MCP `ask_operator`** appelé par l'agent | dynamique (décidée par le LLM) | **la valeur de retour de l'appel d'outil EST la réponse** : texte libre injecté nativement dans le contexte, zéro frappe PTY |
| **Signal générique « l'agent attend »** | hook **`Notification`** (matchers `permission_prompt`, `idle_prompt`, `agent_needs_input`, `agent_completed`…) ; payload `{notification_type, message}` | déterministe, **non bloquant** | — signal seulement (sert à notifier, pas à répondre) |
| **Tout le reste / CLIs non-Claude** (codex, gemini, agy) | `attention.ts` (scraping PTY existant) | heuristique | injection de frappes dans le PTY (mécanique de `quota.ts`) |

**Pourquoi la voie MCP reste indispensable** : la doc ne documente **aucun
hook sur `AskUserQuestion` ni sur la validation de plan (ExitPlanMode)**.
C'est précisément le cas d'usage « réponse par prompt libre » du besoin → il
faut un outil MCP que l'agent appelle volontairement (harnais système :
« quand tu as une question bloquante et que le mode notification est actif,
appelle `ask_operator` au lieu de poser la question à l'écran »). Précédent
direct dans le repo : `graph_draft_prepare`/`graph_draft_send`, qui font déjà
« l'agent escalade une question bloquante vers l'opérateur ».

**Pourquoi garder `attention.ts`** : les hooks sont propres à Claude Code. Les
tuiles codex/gemini/agy n'en ont pas — le scraping reste le seul filet pour
elles, et il couvre aussi le cas « l'agent n'a pas joué le jeu de l'outil MCP ».

**Sémantique de blocage — le point à valider en prototype.** Le champ
`timeout` est configurable par hook (défaut **600 s** pour les hooks
`command`) et **aucun maximum n'est documenté** ; un blocage de plusieurs
heures est donc possible mais reste du terrain non spécifié. Recommandation :
**ne pas bloquer 24 h dans le hook**. On bloque une durée bornée
(10–30 min, configurable), et à l'expiration le hook rend la main → la boîte
de dialogue native reste affichée → **la session reste en attente et reste
répondable dans le Deck**. C'est exactement la sémantique demandée
(« la notif expire, pas la session »), obtenue gratuitement. La notif reste
par ailleurs vivante côté broker jusqu'à `APPROVAL_NOTIF_TTL_HOURS` : si la
réponse mobile arrive après la fin du blocage du hook, elle est appliquée par
le chemin de secours (injection PTY sur la boîte toujours ouverte).

## 8. La chaîne de bout en bout

```
┌── PC-A / compte OS "olivier" ────────────────────────────┐
│  Session agent (tuile Deck)                              │
│    ├─(a) hook PermissionRequest / PreToolUse  [bloquant] │
│    ├─(b) outil MCP ask_operator               [bloquant] │
│    ├─(c) hook Notification                    [signal]   │
│    └─(d) attention.ts (PTY)                   [fallback] │
│                      │                                   │
│              Deck main process                           │
└──────────────────────┼───────────────────────────────────┘
                       │ POST /approval/add
                       │ { operator_auth,                      ← QUI
                       │   origin:{host, os_user_hash,          ← D'OÙ
                       │           project_key, peer_id},
                       │   kind, question, options[], ttl }
                       ▼
        ┌─────────── BROKER (serveur LAN) ────────────┐
        │  pending_approvals  ← source de vérité      │
        │  operator_channels  ← abonnements par       │
        │                       identité opérateur    │
        │  SELECT … WHERE operator_id = :op           │
        └──────────────────────┬──────────────────────┘
                               │ fan-out (§10)
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
         Telegram          Discord         ntfy → App Android
              └────────────────┼────────────────┘
                               │ réponse (texte libre / bouton)
                               ▼
                    POST /approval/claim  ← UPDATE … WHERE status='pending'
                       200 = gagné  │  409 = « déjà traitée / expirée »
                                    ▼
                     push WS vers le peer/Deck d'origine
                                    ▼
   (a) verdict rendu au hook · (b) valeur de retour de l'outil MCP ·
   (c)/(d) frappes injectées dans le PTY après re-vérification de l'état
```

Deux remarques sur ce schéma :

- **Le broker est le seul arbitre.** Le `claim` est un `UPDATE … WHERE
  status='pending'` en transaction : premier arrivé gagne, tous les autres
  canaux (et le Deck lui-même) reçoivent 409. Répondre **dans le Deck** claim
  aussi (`via='deck'`), ce qui invalide et fait éditer les notifs distantes.
- **Le Deck n'est plus l'émetteur des notifications**, seulement le producteur
  d'approbations. C'est ce qui rend le multi-PC trivial (§11).

## 9. Cloisonnement : le modèle d'identité opérateur

**Constat qui impose un nouveau concept : `host` (hostname) ne suffit pas.**
Deux comptes Windows sur le même PC partagent le même `hostname()` — l'axe
d'identité actuel du broker (`host`, `cwd`, `group_id`, `peer_id`) ne
distinguerait donc pas A de B. Aucun des axes existants ne désigne une
**personne**. Il faut un axe supplémentaire, de première classe :

**`operator_key` / `operator_id`**

- `operator_key` = 32 octets aléatoires, générés au premier lancement,
  stockés **dans le répertoire app-state par utilisateur OS**
  (`%APPDATA%` sous Windows, `$XDG_CONFIG_HOME` ailleurs), chiffrés via
  `safeStorage` (pattern `provider-secrets.ts` / graphes K8).
- `operator_id` = `sha256(operator_key)[:16]` — la seule chose que le broker
  stocke et qui circule.
- **Le cloisonnement A/B sur un même PC est alors automatique et gratuit** :
  `%APPDATA%` est déjà par compte OS → A et B ont mécaniquement deux
  `operator_key` distincts, donc deux `operator_id`, donc deux jeux
  d'abonnements. B ne peut pas recevoir les notifications de A.
- **Authentification des écritures** : `POST /approval/add` et les routes
  d'abonnement portent `operator_auth = sha256(operator_key)`, TOFU-validé
  broker-side — exactement le pattern `group_secret_hash` de `/announce`
  (`handleAnnounce` valide le secret d'un groupe non-default, 401 sinon).
  Durcissement souhaitable (et qui traite au passage **B8** du backlog, le
  rejeu WS) : HMAC du corps + nonce + horodatage plutôt qu'un hash statique.
  Sans cela, un peer du LAN qui devine/observe un `operator_auth` peut émettre
  des approbations au nom d'autrui.

**Deux nouvelles tables broker** (mêmes conventions que `roadmap_items` /
`graph_drafts`) :

```
operator_channels(operator_id, kind, address, label, enabled,
                  created_at, last_used)
   kind ∈ telegram | discord | ntfy    address = chat_id | user_id | topic

operator_devices(operator_id, host, os_user_hash, label, last_seen)
   ← inventaire des PC autorisés à émettre au nom de l'opérateur
     (+ révocation « ce PC ne parle plus en mon nom »)
```

`os_user_hash` = hash salé du nom de compte OS : sert à **étiqueter** l'origine
sans exposer le nom d'utilisateur dans un message qui transite chez Telegram
ou Discord.

**Cas « A possède 2 PC, même téléphone / même serveur Discord »** — c'est un
**enrôlement**, pas un second appairage du téléphone : sur PC #2, « Lier ce PC
à mon identité » lit un QR affiché par PC #1 contenant l'`operator_key`
(one-shot, éphémère — le pattern exact du token d'appairage companion). Les
deux PC partagent alors le même `operator_id`, donc les **mêmes abonnements
déjà configurés** : rien à réappairer côté mobile, conformément au besoin
« appairage global une fois par appareil ».

**Émissions simultanées des 2 PC** : aucun conflit. Chaque approbation a son
`id` propre ; la corrélation de la réponse se fait par
`reply_to_message`/`callback_data` (Telegram) ou `custom_id` (Discord), jamais
par « la dernière question posée ». Les deux notifications arrivent sur le
téléphone et se répondent indépendamment. Le titre porte l'origine :

```
[bureau · koryphaios] Autoriser  Bash: rm -rf .worktrees/tmp ?
[portable · api-gateway] L'agent demande : quelle stratégie de migration ?
```

**Matrice de cloisonnement**

| Scénario | Même `operator_id` ? | Résultat |
|---|---|---|
| A et B, comptes OS différents, même PC | Non (app-state distinct) | **Étanche** — B ne voit rien de A |
| A sur PC #1 et PC #2 (enrôlés) | Oui | Un seul téléphone/Discord, notifs des 2 PC, badge d'origine |
| A avec 2 projets sur le même PC | Oui | Notifs des 2 projets ; opt-out par projet possible (§3) |
| Un peer LAN tiers qui bricole | — | Rejeté : `operator_auth` inconnu → 401 |

## 10. Routage : fan-out ou canal unique ?

**Recommandation V1 : fan-out sur tous les canaux actifs de l'opérateur.**
Le `claim` atomique rend le doublon inoffensif (le second canal reçoit 409),
et ça maximise la probabilité que la notif soit vue. Dès qu'un canal gagne, le
broker demande aux autres d'**éditer** leur message (« ✅ traitée via
Telegram ») — Telegram `editMessageText`, Discord edit de message ; ntfy ne
sait pas éditer, on y publie un message de clôture.

Variante V2 si le fan-out devient bruyant : **canal préféré + escalade**
(envoi sur le canal préféré, escalade aux autres après N minutes sans
réponse). Même schéma de données, juste une politique d'envoi différente.

Le fan-out reste **strictement borné à l'`operator_id`** : il n'y a jamais de
diffusion à « tous les canaux du broker ».

## 11. Où vit la passerelle : dans le broker (amende §4.1)

L'audit initial plaçait la passerelle dans le Deck, avec pour conséquence
« un bot Telegram par PC ». **Avec un broker LAN partagé et le besoin explicite
d'un seul téléphone/Discord pour 2 PC, la passerelle doit vivre dans le
broker** :

| | Passerelle dans le Deck | **Passerelle dans le broker** |
|---|---|---|
| Contrainte Telegram « un seul `getUpdates` par token » | violée si 2 Decks → 409 en boucle → **un bot par PC** | respectée : **un seul consommateur**, quel que soit le nombre de PC |
| Abonnements mobiles | dupliqués sur chaque PC | **centralisés**, partagés par tous les PC de l'opérateur |
| Stockage du token de bot | `safeStorage` par PC | fichier de conf broker chmod-600 (c'est **leur** serveur LAN) |
| PC éteint | notif perdue | le broker relaie quand même ; l'approbation attend |
| Complexité | passerelle dans un process Electron | **passerelle dans un daemon déjà singleton, déjà multi-host** |

Le broker est déjà un daemon singleton, déjà multi-host en mode HTTP
(`broker_url` + `broker_token`), avec les timers de balayage, le logger
rotatif et les patterns de durabilité — c'est son rôle naturel. Le Deck
redevient un simple producteur d'approbations et consommateur de verdicts.

*Conséquence sur les lots* : le lot **N2 (Telegram)** devient majoritairement
du travail **core** (`broker.ts` + un module passerelle), pas du travail
desktop. Le Deck n'y contribue que l'UI de réglages et l'affichage de
l'appairage (QR).

## 12. Tailscale : côté clients, pas « à côté du broker »

Tailscale est un **maillage** : le client s'installe **sur chaque appareil qui
doit joindre ou être joint**. Il n'y a pas de « serveur Tailscale » à déployer
à côté du broker. Pour cette topologie, trois précisions :

1. **Pour le canal de validation (Telegram/Discord/ntfy) : Tailscale est
   totalement inutile.** Tout passe par les serveurs du fournisseur, en
   sortant. C'est le point important — l'objectif principal du besoin ne
   demande aucun VPN.
2. **Pour le mode compagnon** (le téléphone charge l'UI servie par le Deck),
   la joignabilité nécessaire est **téléphone ↔ PC**, pas téléphone ↔ broker :
   le companion server tourne dans le Deck, sur le PC. Il faudrait donc
   Tailscale sur le téléphone **et sur chaque PC**.
3. **Variante recommandée pour un LAN avec serveur permanent : un seul
   *subnet router*.** Le serveur broker (déjà allumé en permanence) annonce le
   sous-réseau LAN ; le téléphone atteint alors **tous les PC et le broker via
   ce seul nœud**, sans installer Tailscale sur chaque PC.
   Détail qui tombe bien : par défaut le subnet router fait du **SNAT
   (masquerading)** — « a subnet device sees the traffic originating from the
   subnet router » — donc le Deck voit une adresse source **LAN privée**, et
   le filtre `isPrivateAddress` (RFC1918/ULA) du companion **passe sans
   modification de code**. Si on désactivait le SNAT
   (`--snat-subnet-routes=false`, **Linux uniquement**), la source deviendrait
   une adresse tailnet `100.64.0.0/10` (CGNAT) → il faudrait alors étendre
   `isPrivateAddress` (opt-in) **et** ajouter une route de retour côté LAN.
   ([Subnet routers](https://tailscale.com/docs/features/subnet-routers),
   [Disable subnet route masquerading](https://tailscale.com/docs/reference/troubleshooting/network-configuration/disable-subnet-route-masquerading))
4. **Contrepartie sécurité à acter** : avec le SNAT, tout le trafic tailnet
   arrive sous l'IP LAN du subnet router — le Deck ne peut plus distinguer le
   téléphone d'une autre machine du LAN par l'adresse. Le filtre IP redevient
   ce qu'il est déjà en réalité : une défense en profondeur, pas
   l'authentification. Celle-ci reste le **credential par appareil** délivré à
   l'appairage. À documenter explicitement si on recommande le subnet router.

## 13. Découpage révisé

**N1 — socle approbations + identité (core/broker)** : `operator_key` /
`operator_id` et son enrôlement multi-PC ; tables `pending_approvals`,
`operator_channels`, `operator_devices` ; routes `add`/`claim`/`list` +
authentification `operator_auth` (HMAC + nonce de préférence) ; sweep TTL
notif ; push WS du verdict vers le peer d'origine.

**N1b — producteurs d'approbations (desktop + core MCP)** : hooks
`PermissionRequest`/`PreToolUse`/`Notification` ajoutés au plugin embarqué
existant ; outil MCP `ask_operator` (bloquant, retour texte libre) ; branchement
d'`attention.ts` en filet de secours ; claim `via='deck'` quand l'opérateur
répond localement.

**N2 — passerelle Telegram (broker)** : client `fetch` zéro-dépendance
(getUpdates single-instance, sendMessage HTML, editMessageText,
answerCallbackQuery), appairage deep-link `?start=<secret>` liant `chat_id` ↔
`operator_id`, verrou `chat_id`, fan-out + édition des notifs concurrentes.

**N3 — passerelle Discord (broker)** : même abstraction `NotificationChannel`,
Gateway (identify/heartbeat/resume), boutons → modale texte libre.

**N4 (V2) — app Android** : mobile-shell + UnifiedPush/ntfy deux-topics,
multi-hôtes en mode compagnon, option subnet router Tailscale.

**Réglages transverses** : interrupteur global Deck + opt-out par projet
(`effectif = global && !optOutProjet`), `APPROVAL_NOTIF_TTL_HOURS` (défaut 24)
en conf **broker** puisque c'est lui qui balaie.

*Sources ajoutées : [Claude Code — Hooks reference](https://code.claude.com/docs/en/hooks),
[Tailscale — Subnet routers](https://tailscale.com/docs/features/subnet-routers),
[Tailscale — Disable subnet route masquerading](https://tailscale.com/docs/reference/troubleshooting/network-configuration/disable-subnet-route-masquerading).*
