# Plan de remédiation — audit sécurité koryphaios / claude-peers

Suivi vivant de l'implémentation des correctifs de `AUDIT-SECURITE-MAINTENANCE.md`.
Branche : `claude/security-maintenance-audit-rxakng` (base `experimental`).

## Modèle de menace validé avec l'opérateur

- Usage principal : **broker sur serveur LAN + postes clients sur le même LAN de confiance.**
- Companion : **axe de déploiement réel, LAN de confiance uniquement.**
- Repo public → un tiers *pourrait* l'exposer en WAN. Le durcissement WAN est **bienvenu s'il est gratuit ou peu coûteux**, mais **jamais prioritaire** et ne doit rien faire « tout revoir ».
- Risque le plus concret pour un repo public : **RCE via dépôt cloné** (indépendant du réseau) → priorité n°1.

## Décisions de design actées

- **B5 `worktreeInit`** : réutiliser le gate d'approbation C19 (`launch-approval.ts`), **par projet**.
  Un `worktreeInit` issu du config **projet** est approuvé une fois par `project_key`+hash
  (mémorisé dans l'état applicatif opérateur, **jamais** dans le repo). Refus → pas d'exécution.
  Donne les « deux mondes » (projet X approuvé / projet Y jamais) sans flag de mode séparé.
  Garde-fou non négociable : la décision de confiance vit **hors du repo**.
- **B4 templates** : `command`/`args` d'un template **projet** passent par le même gate C19.
- **B9 `config:set`** : valider/whitelister `projectDir` ; réévaluer l'approbation C19 au changement de projet.
- **Companion (device management)** — retenu : liste des appareils + **révocation manuelle** +
  « déconnecter tous », **notification de connexion** sur le Deck, reboot Kory efface les cred (déjà le cas).
  **Écarté par l'opérateur** : expiration idle des cred (sessions longues), tier-limiting B10
  (le mobile pilote l'app, son cred est de confiance). Biométrie mobile opt-in = couche front mobile, hors périmètre backend ici.
  Note assumée : mobile volé *déverrouillé* + biométrie off + resté sur LAN = contrôle jusqu'à
  fermeture d'app / reboot Kory / **révocation manuelle** (la soupape de sûreté).
- **B10 tiers** : reporté (hors périmètre, décision opérateur).
- **B7/B8 (resume + WS proof-of-possession) / B3 (auth default group)** : menaces d'initié LAN →
  basse priorité, non traitées dans ce lot (le lot B1 tarit déjà la circulation des tokens).

## Lots

### Lot 1 — RCE dépôt-cloné (priorité) ✅ FAIT
- [x] **B6** sanitiser `agent`/`model` (allow-list `sanitizeFlagValue` + double-quote) avant le shell.
      `args` reste un fragment shell mais n'est plus atteignable que par une source autorisée (menu / template approuvé / companion de confiance). *Transparent.*
- [x] **B5** `worktreeInit` projet → gate C19 (résolu une fois au boot, valeur approuvée injectée dans tous les spawns).
- [x] **B4** `command`/`args` d'un template **projet (local)** → gate C19 par contenu ; templates globaux (opérateur) non gatés. + **M-SEC-9** containment `templateSource` sur `template:read`/`apply`.
- [x] **B9** `config:set` rejette tout override de `projectDir` (jamais un réglage runtime). projectDir fixé au boot → pas de re-gate nécessaire.

### Lot 2 — Companion (device management) ✅ FAIT (UI à vérifier visuellement)
- [x] `CompanionAuth` : suivi des appareils (id non-secret, addr, pairedAt, lastSeenAt), `listDevices` / `revoke(id)` / `revokeAll` (pur, testé).
- [x] `CompanionServer` : `cred` stocké par client ; `listDevices` / `revokeDevice` (ferme la socket = kill switch) / `revokeAllDevices` ; `onDeviceConnected`.
- [x] IPC `companion:devices|revoke|revoke-all` + event `companion:device-connected` ; **tous remote-bloqués** (tier 3) — un téléphone ne peut jamais lister/révoquer.
- [x] Preload + `DeckApi` + manifeste + tiers + parité i18n (en/fr/EN_DEFAULTS).
- [x] `CompanionDialog` : section liste d'appareils + boutons Révoquer / Tout révoquer + refresh sur connexion/révocation. CSS ajouté.
- [x] Notification de connexion : entrée journal (déjà) + broadcast `companion:device-connected` pour un toast.
- Note : modèle **un seul appareil actif à la fois** (le ré-armement du QR invalide les creds précédents — comportement existant, non modifié). Multi-appareils = décision de design séparée.
- ⚠️ **UI renderer à valider visuellement** par l'opérateur (impossible à lancer/vérifier ici) — logique backend+IPC couverte par tests + typecheck.

### Lot 3 — Broker transparent (partiel)
- [x] **B2** garde `Origin` (rejette toute requête portant un `Origin` non-loopback ; les clients natifs server.ts/CLI n'envoient pas d'`Origin` → transparent). Pas de Host allow-list (incompatible avec un bind 0.0.0.0 sans config).
- [x] **M-SEC-1** comparaisons constant-time (`safeEqual` via `timingSafeEqual`) : `broker_token` + les 3 sites `group_secret_hash`.
- [x] **M-LOG-1** écritures atomiques (temp+rename) : `store.ts` (config/sessions), `graph-store.ts`, `inbox-store.ts`, `scope-secrets.ts` (helper `atomic-write.ts`) + `shared/peer-cache.ts` (helper pid-scoped).
- [x] **B1 + NF-A** projections publiques `peers`/`messages` — **FAIT** (mise à jour coordonnée broker+client validée par l'opérateur).

## ✅ B1/NF-A — traité (mise à jour coordonnée broker + client)

Décision opérateur : mise à jour **coordonnée** broker + client (option a). Comme broker.ts et
server.ts sont dans le même paquet, la mise à jour se fait en bloc → pas de skew.
Le format de fil change (breaking, assumé) : `instance_token`/`pid`/`client_pid` ne sortent plus
de `list-peers`/`admin/peers` ; `from_token`/`to_token` ne sortent plus de `poll`/`peek` (le broker
résout `from_peer_id` côté serveur). Le PID client n'est plus affiché dans `list_peers` (info locale).

## Journal d'implémentation

### Lot 1 — RCE dépôt-cloné (fait)
- `session-command.ts` : ajout `sanitizeFlagValue` (allow-list `[A-Za-z0-9._:@/[\]-]`, ≤128, bloque tout métacaractère shell ; brackets permis pour la forme modèle `[1m]`).
- `session-service.ts` : `create()` applique `sanitizeFlagValue` à agent/model + double-quote les deux ; commentaire sur l'invariant `args`.
- `launch-config.ts` : ajout `projectWorktreeInit` / `globalWorktreeInit`.
- `create-session.ts` : `createSessionWithWorktree` reçoit `worktreeInit` en paramètre (valeur approuvée) au lieu de le relire depuis le config projet.
- `template-store.ts` : ajout `templateSource` (containment global/local, M-SEC-9).
- `shared/template.ts` : ajout `templateHasShellFields`.
- `index.ts` : gate C19 pour worktreeInit au boot (`approvedWorktreeInit` + `getWorktreeInit`) ; helper `resolveTemplateInputs` (containment + approbation par contenu pour templates locaux) ; `setConfig` rejette `projectDir` (B9) ; helpers `approvalsFile` / `isFrLocale` ; deck-control deps câblés (spawn/worktree/applyTemplate).
- `ipc.ts` : `IpcDeps` reçoit `getWorktreeInit` + `resolveTemplateInputs` ; handlers `sessions:create`, `worktree:create`, `template:apply`, `template:read` câblés ; import `templateSource` + type `TemplateInput`.
- Tests ajoutés : `sanitizeFlagValue` (pass/reject), `templateHasShellFields`, `templateSource` (containment), `projectWorktreeInit`/`globalWorktreeInit`.
- Vérif : `bun test tests/desktop-*.test.ts` → 388 pass / 0 fail ; `npm run typecheck` (node+web) → clean.

### Lot 3 — Broker transparent (fait, sauf B1)
- `broker.ts` : `safeEqual` (constant-time) appliqué au bearer + aux 3 compares de `group_secret_hash` (M-SEC-1) ; `forbiddenByOrigin` (B2) branché avant l'auth dans le handler fetch.
- `atomic-write.ts` (nouveau) : `writeFileAtomic` (temp+rename) ; adopté par `store.ts`, `graph-store.ts`, `inbox-store.ts`, `scope-secrets.ts`.
- `shared/peer-cache.ts` : `writeCacheAtomic` (temp pid-scopé + rename) sur les 2 sites.
- Tests ajoutés : garde Origin (403 cross-origin, 200 loopback, 200 sans Origin, 401 mauvais token).
- Vérif : `bun test` complet → 554 pass / 0 fail ; smoke build `broker/server/cli` OK ; typecheck desktop clean.
### Lot 3 — B1/NF-A (fait)
- `shared/types.ts` : `PublicPeer` (Omit instance_token/pid/client_pid), `DeliveredMessage` (from_peer_id + meta, sans tokens) ; `PollMessagesResponse.messages` → `DeliveredMessage[]`.
- `broker.ts` : helpers `toPublicPeer` + `resolveSenderMeta` + `toDeliveredMessage` ; `handleListPeers` → `PublicPeer[]` ; `/admin/peers` projeté ; `poll`/`peek` renvoient `DeliveredMessage[]`.
- `server.ts` : `pollFallback` + `check_messages` lisent `from_peer_id`/meta (plus de round-trip `/list-peers`) ; `formatPeer` en `PublicPeer` (PID retiré de l'affichage) ; fetches `PublicPeer[]`.
- Tests broker mis à jour (identification par `peer_id`) + assertions de non-fuite (instance_token/pid/client_pid/from_token/to_token `undefined`). Suite complète 557 pass ; smoke build + typecheck clean.

### Lot 2 — Companion device management (fait)
- `shared/companion.ts` : `CompanionAuth` passe de `Set<cred>` à `Map<cred, CompanionDevice>` ; ajout `listDevices`/`revoke`/`revokeAll` ; id d'appareil non-secret (`d<seq>`).
- `shared/types.ts` : type `CompanionDevice` + 3 méthodes DeckApi + 1 event.
- `companion-server.ts` : `cred` par `ClientCtx` ; `listDevices`/`revokeDevice`(ferme socket)/`revokeAllDevices` ; dep `onDeviceConnected`.
- `index.ts` : câblage `onDeviceConnected` (broadcast) + IPC `companion:devices|revoke|revoke-all`.
- `preload/index.ts` : `companionDevices`/`companionRevoke`/`companionRevokeAll` + `onCompanionDeviceConnected`.
- Manifeste + `REMOTE_BLOCKED_CHANNELS` (3 nouveaux) + `CHANNEL_TIERS` (tier 3) mis à jour.
- `CompanionDialog.tsx` + `styles.css` : UI liste + révocation. i18n en/fr/EN_DEFAULTS.
- Tests : `listDevices`/`revoke`/`revokeAll` (modèle mono-appareil). Suite desktop 391 pass ; typecheck clean ; parité i18n OK.
