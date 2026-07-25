# PLAN — Notifications mobiles & validation à distance

> Plan d'implémentation. Étude de faisabilité et justification des choix :
> `EXPLORATION-notifications-mobiles.md` (audit + addendum §7–§13). Ce document
> ne re-argumente pas les décisions, il les **exécute**.
>
> **Convention de cycle de vie** (CLAUDE.md) : les docs `PLAN-*` sont des
> documents de travail. À la livraison, le narratif part dans `CHANGELOG.md`,
> le résiduel dans `BACKLOG.md`, et **ce fichier est supprimé** — le détail
> reste dans l'historique git.

---

## 0. Cadre

### 0.1 Objectif

Permettre à l'opérateur d'**approuver, discuter ou rejeter par prompt libre**,
depuis son téléphone, les demandes bloquantes des agents de **n'importe quel
Deck**, sans réappairer à chaque session, avec un **cloisonnement strict par
identité opérateur**.

### 0.2 Périmètre par version

| | V1 (lots N0→N3) | V2 (lots N4→N5) |
|---|---|---|
| Canaux | Telegram | + Discord, + app Android/ntfy |
| Détection | hooks Claude Code + outil MCP + `attention.ts` | idem |
| Multi-PC | oui (identité opérateur partagée) | idem |
| Multi-compte OS | oui (étanche par construction) | idem |
| Compagnon en itinérance | non | Tailscale subnet router (doc, pas de code) |

### 0.3 Hors périmètre (explicitement non fait)

- Aucun endpoint entrant sur le PC ni sur le broker exposé à Internet.
- Pas de chiffrement de bout en bout du contenu des notifications (le texte
  transite en clair chez Telegram/Discord — voir §6.5, arbitrage assumé).
- Pas de réponse aux questions des CLIs non-Claude autrement que par
  injection PTY heuristique (`attention.ts`).
- Pas de « reprise » d'une session morte : si le PC s'éteint, l'approbation
  reste `pending` mais plus personne ne l'applique (elle expire).

### 0.4 Contraintes structurantes (rappel, toutes issues de l'audit)

1. **Un seul consommateur `getUpdates` par bot Telegram** → la passerelle vit
   dans le **broker**, pas dans le Deck.
2. **`hostname()` ne distingue pas deux comptes OS** → nouvel axe d'identité
   `operator_id`, dérivé d'une clé stockée dans l'app-state **par compte OS**.
3. **Aucun hook ne couvre `AskUserQuestion` / `ExitPlanMode`** → un outil MCP
   bloquant est indispensable pour les questions ouvertes.
4. **Le `timeout` de hook n'a pas de maximum documenté** → on ne bloque jamais
   24 h dans un hook ; blocage borné puis retour à la boîte native.
5. **Le texte de réponse revient dans un PTY** → assainissement obligatoire
   (entrée hostile, §6.3).
6. **Le texte de question vient d'un agent** → échappement obligatoire avant
   envoi à Telegram/Discord (§6.4).

---

## 1. Lots, dépendances, jalons

```
N0 identité opérateur (core + Deck)         ─┐
N1 socle approbations (broker)              ─┼─► N2 producteurs (hooks + MCP + Deck)
                                             │            │
                                             └────────────┴─► N3 passerelle Telegram
                                                                    │
                                                     N4 Discord ◄───┘
                                                     N5 App Android / ntfy
```

| Lot | Titre | Couche dominante | Livrable vérifiable seul |
|---|---|---|---|
| **N0** | Identité opérateur + enrôlement | core `shared/`, Deck main | 2 comptes OS ⇒ 2 `operator_id` ; enrôlement PC#2 par QR |
| **N1** | Socle approbations | `broker.ts` | `add`/`claim`/`wait`/`list` + TTL, testés en HTTP |
| **N2** | Producteurs d'approbations | hooks, `server.ts`, Deck main | une permission d'outil crée une approbation et se débloque sur verdict |
| **N3** | Passerelle Telegram | `notify/` + `broker.ts` | notif sur le téléphone, réponse libre appliquée |
| **N4** | Passerelle Discord | `notify/` | idem via modale |
| **N5** | App Android / ntfy | `desktop/mobile-shell/` | idem via l'app |

**Jalon utilisable minimal = N0+N1+N2+N3.** N2 seul est déjà utile (historique
des demandes bloquantes dans le Deck, sans mobile).

---

## 2. Décisions d'architecture figées (contrat)

Ces points ne se rediscutent pas pendant l'implémentation ; les changer
invalide le plan.

- **C-1 — Le broker est le seul arbitre.** Toute réponse passe par
  `POST /approval/claim`, un `UPDATE … WHERE status='pending'` en transaction.
  Premier arrivé gagne ; tous les autres reçoivent **409**.
- **C-2 — Le Deck n'émet aucune notification externe.** Il produit des
  approbations et consomme des verdicts. La passerelle est broker-side.
- **C-3 — Durabilité « park », jamais « drain ».** Modèle `graph_drafts` :
  pas de FK vers `peers`, snapshot texte de l'auteur, statut qui bascule,
  listing non destructif. Un redémarrage du broker ou du Deck ne perd rien.
- **C-4 — L'expiration ne concerne que la notification.** `pending` →
  `expired_notif` après TTL ; la session reste bloquée et reste répondable
  dans le Deck (un `claim` avec `via='deck'` est accepté sur `expired_notif`).
- **C-5 — Le fan-out est borné à un `operator_id`.** Aucune diffusion globale.
- **C-6 — Les harnais sont des constantes de code (règle C8).** Le prompt
  système qui instruit l'agent d'utiliser `ask_operator` n'est ni
  configurable par le dépôt ni par l'opérateur.
- **C-7 — Les secrets ne descendent jamais par l'environnement.** Clé
  opérateur transmise aux sessions par **fichier chmod-600**, exactement comme
  le secret de groupe (`buildScopeEnv` dans `desktop/src/main/scope.ts`).
- **C-8 — Aucune régression du contrat « le Deck ne lit pas le trafic peer ».**
  Les approbations sont un canal distinct des `messages`.

---

## 3. Modèle de données

### 3.1 Tables broker (à créer à côté de `graph_drafts`, `broker.ts` ~ligne 385)

```sql
-- Identité opérateur : une ligne par personne. Créée au premier /approval/add
-- ou au premier abonnement (TOFU, comme la validation de group_secret_hash).
CREATE TABLE IF NOT EXISTS operators (
  operator_id   TEXT PRIMARY KEY,          -- sha256(operator_key)[:16]
  auth_hash     TEXT NOT NULL,             -- sha256(operator_key), TOFU
  label         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

-- Abonnements : les canaux joignables pour cette identité.
CREATE TABLE IF NOT EXISTS operator_channels (
  id            TEXT PRIMARY KEY,
  operator_id   TEXT NOT NULL,
  kind          TEXT NOT NULL,             -- telegram | discord | ntfy
  address       TEXT NOT NULL,             -- chat_id | user_id | topic
  label         TEXT NOT NULL DEFAULT '',
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_uniq
  ON operator_channels(operator_id, kind, address);

-- Inventaire des PC autorisés à émettre au nom de l'opérateur (+ révocation).
CREATE TABLE IF NOT EXISTS operator_devices (
  operator_id   TEXT NOT NULL,
  host          TEXT NOT NULL,
  os_user_hash  TEXT NOT NULL,             -- hash salé, jamais le login en clair
  label         TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  PRIMARY KEY (operator_id, host, os_user_hash)
);

-- Le cœur : les demandes en attente.
CREATE TABLE IF NOT EXISTS pending_approvals (
  id             TEXT PRIMARY KEY,
  operator_id    TEXT NOT NULL,
  -- Origine (affichage + cloisonnement d'affichage, jamais d'autorisation)
  origin_host    TEXT NOT NULL,
  origin_user    TEXT NOT NULL,            -- os_user_hash
  project_key    TEXT NOT NULL,
  group_id       TEXT NOT NULL DEFAULT '',
  from_peer      TEXT NOT NULL DEFAULT '', -- snapshot texte, pas de FK (C-3)
  session_ref    TEXT NOT NULL DEFAULT '', -- id de tuile Deck, opaque
  -- Contenu
  kind           TEXT NOT NULL,            -- permission | question | plan
  title          TEXT NOT NULL,
  question       TEXT NOT NULL,
  options_json   TEXT NOT NULL DEFAULT '[]',
  -- Cycle de vie
  status         TEXT NOT NULL DEFAULT 'pending', -- pending|answered|expired_notif|abandoned
  answered_via   TEXT,                     -- deck|telegram|discord|ntfy
  answer_kind    TEXT,                     -- allow|deny|text
  answer_text    TEXT,
  created_at     TEXT NOT NULL,
  notif_expires_at TEXT NOT NULL,
  answered_at    TEXT,
  delivered_at   TEXT                      -- verdict consommé par le producteur
);
CREATE INDEX IF NOT EXISTS idx_approvals_operator
  ON pending_approvals(operator_id, status);
CREATE INDEX IF NOT EXISTS idx_approvals_project
  ON pending_approvals(project_key, status);

-- Corrélation message externe -> approbation (édition « déjà traitée »).
CREATE TABLE IF NOT EXISTS approval_messages (
  approval_id   TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  external_ref  TEXT NOT NULL,             -- message_id Telegram / Discord
  PRIMARY KEY (approval_id, channel_id)
);
```

### 3.2 Types protocole — `shared/types.ts`

Bloc `Approval*` calqué sur le bloc `GraphDraft*` (ligne ~458) :
`ApprovalKind`, `ApprovalStatus`, `Approval`, `ApprovalAddRequest/Response`,
`ApprovalClaimRequest/Response`, `ApprovalWaitRequest/Response`,
`ApprovalListRequest/Response`, `OperatorChannel`, `OperatorAuth`.

**Projection publique obligatoire** : `toPublicApproval()` — jamais
d'`instance_token`, de `from_token` ni de PID dans une réponse HTTP ou un
message externe (entrée hostile #2, §6.2).

### 3.3 Module pur partagé — `shared/approval.ts`

Testable sans I/O, utilisé par broker **et** server :
`validateApprovalPayload()` (limites : titre 200, question 4000, 10 options ×
200), `deriveOperatorId()`, `buildAuthProof()` / `verifyAuthProof()` (HMAC),
`sanitizeAnswerForPty()` (§6.3), `formatOrigin()`.

---

## 4. Protocole HTTP (broker)

Toutes les routes s'ajoutent au `switch (path)` de `broker.ts` (~ligne 1949),
handlers sur le modèle `handleGraphDraftAdd` (`{ result }` ou
`{ error, status }`).

| Route | Corps | Réponse | Notes |
|---|---|---|---|
| `POST /approval/add` | `auth`, `origin{host,os_user_hash,project_key,peer,session_ref}`, `kind`, `title`, `question`, `options[]`, `ttl_hours?` | `{ approval }` | TOFU de l'opérateur ; déclenche le fan-out (§5.4) |
| `POST /approval/wait` | `auth`, `id`, `timeout_sec` (≤ 300) | `{ approval }` ou `{ pending: true }` | **Long poll** : la requête est tenue ouverte jusqu'au claim ou au timeout |
| `POST /approval/claim` | `auth?`, `id`, `via`, `answer_kind`, `answer_text?` | `200 { approval }` / **409** `{ error: 'already-settled' }` | Atomique. `via='deck'` accepté aussi sur `expired_notif` (C-4) |
| `POST /approval/list` | `auth`, `project_key?`, `status?` | `{ approvals[] }` | Non destructif (C-3) |
| `POST /operator/channel-upsert` | `auth`, `kind`, `address`, `label`, `enabled` | `{ channel }` | Appelé par la passerelle à l'appairage |
| `POST /operator/channel-list` | `auth` | `{ channels[] }` | UI réglages du Deck |
| `POST /operator/device-upsert` | `auth`, `host`, `os_user_hash`, `label` | `{ device }` | Inventaire + révocation |

**Long poll (`/approval/wait`)** : registre en mémoire
`Map<approvalId, Array<(a:Approval)=>void>>` ; `claim` résout les attentes ;
un timer résout `{ pending: true }` à l'échéance. Le client re-poll. Le
redémarrage du broker fait simplement expirer les attentes → re-poll.

**Tunables** (pattern `Math.max(1, parseInt(process.env.X ?? "d", 10))`,
à documenter dans le tableau env du `README.md`) :

| Variable | Défaut | Rôle |
|---|---|---|
| `CLAUDE_PEERS_APPROVAL_NOTIF_TTL_HOURS` | `24` | `pending` → `expired_notif` |
| `CLAUDE_PEERS_APPROVAL_TTL_DAYS` | `30` | purge des lignes réglées |
| `CLAUDE_PEERS_APPROVAL_WAIT_MAX_SEC` | `300` | plafond du long poll |
| `CLAUDE_PEERS_TELEGRAM_TOKEN` | — | secret passerelle (ou fichier de conf chmod-600) |

Le balayage TTL rejoint `purgeOldMessages()` (~ligne 633) sous
`guardedInterval`, et son compteur s'ajoute à la réponse
`/admin/purge-messages` + la ligne de démarrage.

---

## 5. Lots détaillés

### Lot N0 — Identité opérateur et enrôlement

**Objectif** : faire exister « une personne » comme axe de première classe,
étanche entre comptes OS, partageable entre PC.

**Fichiers**
- `shared/approval.ts` (nouveau) — dérivation + preuve d'authenticité.
- `desktop/src/main/operator-identity.ts` (nouveau) — création/lecture de
  `operator.json` dans `join(app.getPath('userData'), APP_STATE_SUBDIR)`,
  clé chiffrée via `safeStorage` (pattern `provider-secrets.ts`).
- `desktop/src/main/scope.ts` — étendre `buildScopeEnv` : écrire la clé
  opérateur dans un **second fichier chmod-600** et exposer
  `CLAUDE_PEERS_APPROVAL_FILE` au PTY enfant (C-7). Neutraliser la variable
  héritée quand la fonctionnalité est désactivée.
- `desktop/src/main/ipc.ts` — `operator:info`, `operator:enrollToken`,
  `operator:enrollApply` (le dernier valide que la charge est bien une clé,
  et **jamais** un chemin).
- Renderer : dialogue « Lier ce PC » (QR affiché / QR scanné), dans les
  réglages.

**Étapes**
1. `operator_key` = 32 octets aléatoires au premier lancement ;
   `operator_id = sha256(key)[:16]`.
2. Preuve d'authenticité : `HMAC-SHA256(operator_key, canonical(body) ‖ nonce ‖ ts)`.
   Le broker vérifie, rejette hors fenêtre ±120 s, mémorise les nonces vus
   (cache borné) → **traite au passage B8** (rejeu) du backlog.
3. Enrôlement PC#2 : jeton one-shot éphémère contenant la clé, affiché en QR
   par PC#1 (durée de vie 2 min, consommé à la première utilisation — pattern
   `CompanionAuth.arm()` / `hello()`).
4. `os_user_hash = sha256(salt ‖ username)`, sel persistant par identité.

**Definition of Done**
- Deux comptes Windows sur la même machine produisent deux `operator_id`
  différents, vérifié par test.
- Un PC enrôlé partage l'`operator_id` et voit les mêmes canaux.
- Aucun secret dans `ps` / `/proc/<pid>/environ` (le transport est un fichier).

**Tests** : `tests/approval-identity.test.ts` (dérivation, HMAC, fenêtre de
rejeu, nonce rejoué → refus), `tests/desktop-operator-identity.test.ts`
(module pur à répertoire injectable, comme `inbox-store.ts`).

**Risque** : un utilisateur qui copie son profil d'un PC à l'autre duplique
l'identité — acceptable (c'est bien la même personne), mais l'inventaire
`operator_devices` doit alors montrer deux entrées.

---

### Lot N1 — Socle approbations (broker)

**Objectif** : la machine à états, sans aucun canal externe.

**Fichiers** : `shared/types.ts`, `shared/approval.ts`, `broker.ts`,
`README.md` (tableau env), `ARCHITECTURE.md`.

**Étapes**
1. DDL §3.1 à côté de `graph_drafts` + index.
2. Handlers `handleApprovalAdd/Wait/Claim/List` + `handleOperatorChannel*`.
3. Cases de routage dans le `switch (path)`.
4. Registre de long poll + résolution sur claim.
5. Balayage TTL dans `purgeOldMessages()` : `pending` échu →
   `expired_notif` ; réglées > `APPROVAL_TTL_DAYS` → DELETE. **Les `pending`
   ne sont jamais supprimées** (mêmes semantics que les drafts pending).
6. `toPublicApproval()` systématique en sortie.

**Definition of Done**
- Deux `claim` concurrents sur la même approbation : un 200, un 409.
- Un `claim` `via='deck'` sur `expired_notif` passe ; via un canal externe, non.
- `wait` se débloque en < 100 ms après un claim ; rend `{pending:true}` au
  timeout.
- Une approbation d'un autre `operator_id` n'est jamais listée.

**Tests** : `tests/broker-approvals.test.ts` avec `startBroker()` /
`post()` de `tests/_helper.ts` ; antidatage par écriture directe du fichier
SQLite (modèle `broker-message-ttl.test.ts`) pour l'expiration ; test de
concurrence sur le claim.

---

### Lot N2 — Producteurs d'approbations

**Objectif** : brancher les trois voies de détection et les trois chemins de
retour.

#### N2.a — Hooks Claude Code (permissions)

**Fichiers**
- `desktop/deck-plugin/hooks/hooks.json` — ajouter `PermissionRequest`,
  `PreToolUse` et `Notification` à côté du `SessionStart` existant.
- `desktop/hooks/approval-hook.ts` (nouveau, modèle
  `desk-backchannel-hook.ts` : gate sur variable d'environnement, lecture
  stdin JSON, exécution best-effort, `bun`).

**Comportement**
1. Gate : sans `CLAUDE_PEERS_APPROVAL_FILE`, **no-op silencieux** (une session
   hors Deck ne doit rien changer).
2. `POST /approval/add` avec `kind='permission'`, titre =
   `tool_name` + résumé de `tool_input`.
3. Boucle `POST /approval/wait` bornée par `APPROVAL_HOOK_BLOCK_SEC`
   (défaut **900 s**, configurable ; jamais 24 h — contrainte 4 du §0.4).
4. Verdict → sortie JSON :
   - `PermissionRequest` : `hookSpecificOutput.decision.behavior = allow|deny`
   - `PreToolUse` : `permissionDecision` + **`permissionDecisionReason`** =
     texte libre de l'opérateur (c'est le « rejeter avec un prompt »).
5. Timeout / broker injoignable → **sortie 0 sans décision** : la boîte native
   reste, la session reste bloquée, l'opérateur répond dans le Deck. Aucun
   fail-open : ne jamais émettre `allow` par défaut.
6. Le hook `Notification` (`permission_prompt`, `idle_prompt`,
   `agent_needs_input`) ne fait **que** signaler — il n'attend pas.

> **Point à lever en prototype (§9-R1)** : vérifier que Claude Code accepte
> un `timeout` de plusieurs centaines de secondes sur `PermissionRequest`, et
> observer le comportement réel au dépassement.

#### N2.b — Outil MCP `ask_operator` (questions ouvertes)

**Fichiers** : `server.ts` (entrée dans `TOOLS`, `case` dans le switch
CallTool, ligne dans le blob d'instructions), `shared/approval.ts`.

- `ask_operator(title, question, options?)` → `add` puis `wait` borné
  (~120 s), et si rien : retourne `{ ticket }` avec la consigne « rappelle
  `ask_operator_wait(ticket)` pour continuer d'attendre ».
  **Motif resumable obligatoire** : il ne faut pas dépendre du timeout d'outil
  MCP du client (§9-R2).
- `ask_operator_wait(ticket)` → même boucle, rend la réponse texte libre.
- La valeur de retour de l'outil **est** la réponse : aucune injection PTY.
- Description marquée `OPERATOR-GATED` ; la consigne d'usage est une
  **constante de code** (C-6), injectée par `--append-system-prompt-file`
  comme les rôles d'équipe.

#### N2.c — `attention.ts` en filet + chemin PTY

**Fichiers** : `desktop/src/main/attention.ts`, `session-service.ts`,
`index.ts`, `broker-client.ts`.

- Sur `attention` `waiting=true` **et** notifications actives pour ce projet :
  extraire le bloc question/options du buffer et `POST /approval/add`
  (`kind='question'`).
- Sur `waiting=false` (l'opérateur a répondu localement) : `claim` avec
  `via='deck'` → invalide les notifs distantes.
- Nouveau poller `pollApprovalVerdicts()` dans `index.ts`, **sur le timer
  `INBOX_POLL_MS` existant** (ligne 542, à côté de `pollGraphDrafts`) : les
  approbations `answered` non `delivered` sont appliquées par injection PTY
  après **re-vérification que la session est toujours en attente**, puis
  marquées délivrées.
- L'injection réutilise la mécanique de `quota.ts` (écriture PTY par le
  session service), avec `sanitizeAnswerForPty()` en amont (§6.3).

#### N2.d — Réglages (global + opt-out projet)

- `AppConfig` (`desktop/src/main/store.ts`, `DEFAULT_CONFIG`) : ajouter
  `mobileApprovals: false` (opt-in), à côté du `notifyAttention` existant.
- Opt-out **par projet** dans un fichier d'app-state dédié, modèle
  `sandbox-store.ts` (`projects[projectKey]`) — **jamais** dans le dépôt
  cloné (entrée hostile #1, §6.1).
- Règle : `effectif = mobileApprovals && !optOutProjet`. L'UI grise l'option
  projet quand le global est off (impossible d'activer localement).
- Locales : `desktop/locales/en.json`, `fr.json` **et** `EN_DEFAULTS` dans
  `desktop/src/main/i18n.ts` — les trois, sous peine d'échec de la parité.

**Definition of Done N2**
- Une demande de permission Bash crée une approbation ; un `claim` la
  débloque sans passer par le PTY.
- Une question ouverte via `ask_operator` rend le texte de l'opérateur dans
  le contexte de l'agent.
- Répondre dans la tuile invalide l'approbation (statut `answered`,
  `via='deck'`).
- Broker éteint : aucune session ne se bloque plus longtemps qu'aujourd'hui.

**Tests** : `tests/approval-hook.test.ts` (fonctions pures du hook : parsing
du payload, construction de la sortie JSON, gate d'environnement),
`tests/desktop-approval-inject.test.ts` (assainissement + re-vérification
d'état avant injection).

---

### Lot N3 — Passerelle Telegram (broker)

**Objectif** : le canal utilisable, de bout en bout.

**Fichiers (nouveaux)** : `notify/registry.ts` (abstraction
`NotificationChannel` + fan-out), `notify/telegram.ts` (I/O), `notify/format.ts`
(**pur, testé** : échappement HTML, découpe à 4096, encodage/décodage du
`callback_data` ≤ 64 octets), branchement dans `broker.ts`.

**Étapes**
1. Client `fetch` **zéro dépendance** : `sendMessage` (parse_mode HTML),
   `editMessageText`, `answerCallbackQuery`, boucle `getUpdates`
   (`allowed_updates: ["message","callback_query"]`, `timeout` 25–50 s,
   gestion de l'`offset`).
2. **Verrou d'instance unique** : un seul poller par token. Si un 409
   `Conflict` survient, journaliser explicitement « un autre consommateur
   utilise ce token » — c'est aussi un **signal de compromission** (§6.6).
3. Appairage : deep link `t.me/<bot>?start=<secret>` affiché en QR par le
   Deck ; le `/start <secret>` lie `chat_id` ↔ `operator_id` via
   `channel-upsert`. Secret one-shot, TTL court.
4. **Filtre d'autorisation** : tout update dont le `chat.id`/`from.id` n'est
   pas un canal connu est **ignoré avant toute écriture en base** (pas de
   remplissage par un inconnu).
5. Fan-out (C-5) sur les canaux `enabled` de l'`operator_id`, message titré
   par l'origine : `[bureau · koryphaios]`.
6. Réponses : bouton → `claim(allow|deny)` ; `ForceReply` /
   `reply_to_message` → `claim(text)`. Sur 409, répondre **« Validation
   expirée ou invalide / déjà traitée »**.
7. Sur claim gagné, éditer les messages des **autres** canaux
   (`approval_messages`) en « ✅ traitée via … » et retirer les boutons.

**Definition of Done**
- Deux PC émettent simultanément : deux notifications distinctes, répondables
  indépendamment, badges d'origine corrects.
- Répondre sur le téléphone après avoir répondu dans le Deck → message
  d'erreur, aucune double application.
- Un inconnu qui écrit au bot n'a aucun effet et ne crée aucune ligne.

**Tests** : `tests/notify-format.test.ts` (échappement, découpe, aller-retour
`callback_data`), `tests/broker-notify-routing.test.ts` (fan-out borné à
l'opérateur, filtre chat_id, 409 après claim) avec un canal factice injecté —
**aucun appel réseau réel dans la suite**.

---

### Lot N4 — Passerelle Discord

Même abstraction `NotificationChannel`. Gateway WSS
(identify → heartbeat jitteré → resume via `resume_gateway_url`/`seq`),
intents `GUILDS | DIRECT_MESSAGES`, WebSocket natif Bun (BUN.md), zéro
dépendance. Bouton → **modale** `Text Input` (≤ 4000 car.) pour le texte
libre. Doc opérateur : laisser « Interactions Endpoint URL » **vide**, créer
un serveur privé et y inviter le bot (contrainte du serveur mutuel).

### Lot N5 — App Android / ntfy

`desktop/mobile-shell/` : TODOs natifs MB6 (service foreground, biométrie,
`FLAG_SECURE`, pinning) + UnifiedPush via ntfy, motif **deux topics** (le
broker publie sur `notif`, s'abonne en sortant sur `replies`), appairage par
QR `{serveur, topics, token}`. Multi-hôtes en mode compagnon : remplacer
l'URL unique bootstrapée par une liste d'hôtes appairés + sélecteur.
Tailscale : **documentation seulement** (subnet router sur le serveur LAN ; le
SNAT par défaut laisse passer `isPrivateAddress` sans changement de code).

---

## 6. Sécurité — la grille des cinq entrées hostiles appliquée

| # | Entrée | Où elle apparaît ici | Traitement |
|---|---|---|---|
| **1** | Valeur d'un **dépôt cloné** | l'opt-out projet, le `project_key` | L'activation des notifications et les tokens de bot sont **globaux / app-state uniquement**. Un fichier du dépôt ne peut **jamais** activer un canal, changer une adresse ni fournir un token. |
| **2** | Champ traversant la **frontière HTTP du broker** | réponses `/approval/*` | `toPublicApproval()` : ni `instance_token`, ni `from_token`, ni PID. `origin_user` est un **hash**, jamais le login. |
| **3** | Argument IPC devenant **chemin/cwd** | `operator:enrollApply` | La charge d'enrôlement est validée comme **clé opaque**, jamais interprétée comme chemin. Aucun nouveau chemin filesystem n'entre par cette voie. |
| **4** | Chaîne produite par un **agent** | `title`/`question` partant vers Telegram/Discord | Échappement HTML systématique côté `notify/format.ts` ; troncature ; jamais de collage dans une commande. |
| **5** | Élément **monté dans un sandbox** | credential d'approbation en mode sandbox | **Jeton restreint par session** (§6.8), jamais la clé opérateur. |

### 6.8 Sandbox : jeton restreint, jamais la clé opérateur (arbitrage tranché)

La clé opérateur donne l'autorité de l'opérateur sur le broker : `claim`
compris. La projeter dans un conteneur — c'est-à-dire dans du code que le
sandbox postule compromis — permettrait à l'agent sandboxé de **répondre aux
approbations des AUTRES sessions**, y compris non sandboxées sur l'hôte
(auto-approuver un `rm -rf` qui attendait l'opérateur), et de rediriger les
notifications via `channel-upsert`. C'est une évasion d'autorité.

**Décision** : le Deck frappe un **jeton restreint par session**
(`approval_session_tokens`), seul élément projeté dans le conteneur. Sa
portée est close :

| Opération | Clé opérateur | Jeton de session |
|---|---|---|
| `add` pour SON `session_ref` | ✅ | ✅ |
| `add` pour un autre `session_ref` | ✅ | ❌ 403 |
| `wait` sur SON approbation | ✅ | ✅ |
| `claim` | ✅ | ❌ **403** |
| `channel-upsert` / `channel-list` | ✅ | ❌ 403 |
| `list` (toutes les approbations de l'opérateur) | ✅ | ❌ 403 |

Pire cas d'un agent sandboxé compromis : il inonde son opérateur de
notifications **émanant de sa propre session**. Nuisance, pas évasion. Le
jeton est révoqué à la fermeture de la session et expire avec elle.

Le même jeton sert à toutes les sessions (sandbox ou non) : le hook et
`ask_operator` n'ont jamais besoin de la clé opérateur — seul le Deck la
détient, et lui seul peut `claim`.

### 6.3 Entrée hostile supplémentaire, propre à ce lot : la réponse → PTY

La réponse vient d'un canal distant et est **tapée dans un terminal**.
`sanitizeAnswerForPty()` est **obligatoire** et doit : retirer les séquences
d'échappement ANSI et les caractères de contrôle ; **normaliser les
retours-chariot** (un `\r` ou `\n` intercalé validerait prématurément ou
enverrait plusieurs commandes) ; borner la longueur ; refuser une réponse
vide. La soumission finale (un seul `Enter`) est ajoutée par le code, jamais
par le texte reçu. Test dédié obligatoire.

### 6.4 Authenticité et rejeu

HMAC + nonce + horodatage sur toute écriture (`add`, `claim` authentifié,
`channel-*`). Sans cela, tout peer du LAN peut émettre une approbation au nom
d'autrui — le broker est sur un LAN de confiance mais le cloisonnement
opérateur perdrait tout sens. C'est aussi la réponse à **B8** du backlog.

### 6.5 Confidentialité — arbitrage assumé

Le titre et la question transitent en clair chez Telegram/Discord. Mitigations
retenues : n'envoyer **que** le bloc question (jamais l'écran complet, qui
contient des chemins et parfois des secrets), tronquer, et documenter le
compromis dans la doc opérateur. Un mode « notification aveugle » (« une
session attend », sans contenu) est une option de réglage souhaitable dès N3
si le coût est faible.

### 6.6 Secrets et révocation

Token de bot : fichier de conf broker **chmod-600** ou variable
d'environnement, jamais dans le dépôt, jamais dans un export, **jamais
journalisé**. Documenter la révocation (`/revoke` BotFather, « Reset Token »
Discord) et le signal de compromission (409 `Conflict` inattendu côté
Telegram).

### 6.7 Aucune erreur silencieuse

Chaque `catch` route vers le bon puits : `shared/logger.ts` côté core,
`reportError()` côté Deck main, `window.api.reportError` / `guarded()` côté
renderer. Les pollers et le long poll passent par `guardedInterval`. Un hook
qui échoue doit **journaliser côté broker** (le stderr d'un hook est invisible).

---

## 7. Vérification

**Avant chaque commit** (`TESTING.md` / skill `desktop-precommit`) :

```bash
bun test
bun build --target=bun broker.ts server.ts cli.ts --outdir=/tmp/cp-check
cd desktop && npm run typecheck        # si desktop/ touché
```

Plus la **parité de locales** (en.json / fr.json / `EN_DEFAULTS`).

**Nouveaux fichiers de test**

| Fichier | Couvre |
|---|---|
| `tests/approval-identity.test.ts` | dérivation, HMAC, fenêtre, rejeu |
| `tests/broker-approvals.test.ts` | CRUD, claim concurrent, TTL, cloisonnement |
| `tests/approval-format.test.ts` | échappement, découpe, `callback_data` |
| `tests/approval-hook.test.ts` | parsing payload, sortie JSON, gate env |
| `tests/desktop-approval-inject.test.ts` | assainissement PTY, re-vérification d'état |
| `tests/broker-notify-routing.test.ts` | fan-out borné, filtre chat_id, 409 |

**Validations manuelles** (à porter dans `BACKLOG.md` comme le fait le lot
sandbox — elles ne sont pas automatisables ici) :
- deux comptes OS sur un même PC : étanchéité réelle ;
- deux PC enrôlés émettant simultanément ;
- réponse mobile après réponse Deck → message d'erreur ;
- PC éteint 25 h → notif expirée, session toujours en attente et répondable ;
- inconnu écrivant au bot → aucun effet.

---

## 8. Documentation à mettre à jour

| Fichier | Ajout |
|---|---|
| `ARCHITECTURE.md` | section « Approbations distantes » (tables, routes, arbitrage, TTL) + les 4 variables d'env |
| `DESKTOP.md` | comportement Deck : réglages global/projet, producteurs, poller de verdicts |
| `README.md` | tableau des variables d'environnement |
| `desktop/docs/notifications.md` (nouveau) | doc **opérateur** : appairage, enrôlement d'un 2ᵉ PC, révocation, confidentialité |
| `desktop/docs/companion.md` | renvoi vers le mode validation + note Tailscale |
| `CHANGELOG.md` | à la livraison de chaque lot |
| `BACKLOG.md` | validations manuelles + résiduel V2 |

---

## 9. Risques et inconnues à lever

| Id | Risque | Impact | Levée |
|---|---|---|---|
| **R1** | Blocage long d'un hook `PermissionRequest` non spécifié (pas de max documenté) | la voie N2.a se dégrade | **Prototype avant N2** : mesurer le comportement réel à 300/900 s. Repli déjà prévu : boîte native + réponse dans le Deck |
| **R2** | Timeout d'outil MCP côté client | `ask_operator` coupé | Motif **resumable** (`ticket` + `ask_operator_wait`) dès la conception |
| **R3** | L'agent n'appelle pas `ask_operator` | questions ouvertes non notifiées | `attention.ts` reste le filet ; consigne en constante de code |
| **R4** | Fiabilité de l'extraction question/options du buffer PTY | notif pauvre ou fausse | Ne notifier que sur épisode `waiting` confirmé ; tronquer ; ne jamais deviner les options |
| **R5** | Purge Telegram des updates > 24 h (PC éteint) | réponses perdues | Cohérent avec le TTL notif ; documenté |
| **R6** | Le broker devient porteur d'un secret externe | surface nouvelle | chmod-600, hors logs, révocation documentée |
| **R7** | Deux Decks du **même** opérateur appliquant le même verdict | double injection | `delivered_at` + re-vérification d'état ; le `session_ref` cible une tuile précise |

---

## 10. Ordre d'exécution recommandé

1. **Prototype R1** (une journée, jetable) : un hook qui bloque et répond.
   Décide la valeur par défaut de `APPROVAL_HOOK_BLOCK_SEC`.
2. **N0** puis **N1** (indépendants du reste, entièrement testables).
3. **N2** — d'abord N2.c (le filet, qui valide la boucle complète avec le seul
   Deck), puis N2.a, puis N2.b.
4. **N3** — utilisable de bout en bout ; c'est le jalon « ça marche ».
5. **N4**, puis **N5**.
