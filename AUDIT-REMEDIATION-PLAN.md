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

### Lot 2 — Companion (device management)
- [ ] Liste d'appareils appairés + révocation manuelle + « déconnecter tous ».
- [ ] Notification de connexion d'un appareil sur le Deck.

### Lot 3 — Broker transparent (partiel)
- [x] **B2** garde `Origin` (rejette toute requête portant un `Origin` non-loopback ; les clients natifs server.ts/CLI n'envoient pas d'`Origin` → transparent). Pas de Host allow-list (incompatible avec un bind 0.0.0.0 sans config).
- [x] **M-SEC-1** comparaisons constant-time (`safeEqual` via `timingSafeEqual`) : `broker_token` + les 3 sites `group_secret_hash`.
- [x] **M-LOG-1** écritures atomiques (temp+rename) : `store.ts` (config/sessions), `graph-store.ts`, `inbox-store.ts`, `scope-secrets.ts` (helper `atomic-write.ts`) + `shared/peer-cache.ts` (helper pid-scoped).
- [ ] **B1 + NF-A** projections publiques `peers`/`messages` — **EN ATTENTE DÉCISION OPÉRATEUR** (voir ci-dessous).

## ⚠️ Point à trancher — B1/NF-A (fuite d'`instance_token`)

Le correctif *transparent* de B1 (le broker cesse d'exposer `instance_token`/`from_token`,
et résout `from_peer_id` côté serveur pour poll/peek) **change le format de fil broker↔server.ts**.
Dans la topologie de l'opérateur (**broker central + plusieurs postes clients**), une mise à jour
échelonnée (broker à jour, client pas encore) casserait la résolution des messages.
→ Décision requise : (a) mise à jour coordonnée broker+clients en une fois, ou (b) rollout en deux
phases (d'abord ajouter `from_peer_id` sans retirer `from_token`, retrait au release suivant).
B1 est par ailleurs une menace **d'initié LAN** (basse priorité dans le modèle de confiance).

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
- **B1/NF-A non implémenté** : en attente de la décision de rollout de l'opérateur (cf. section ci-dessus).
