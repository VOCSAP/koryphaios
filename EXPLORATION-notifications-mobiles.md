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
