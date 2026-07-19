# Plan — Observabilité des erreurs : logs roulants, filets de sécurité, bandeau broker

> Base : branche `experimental` (Deck 0.10.x, broker/core 0.8.x). Ce document est
> le plan de remédiation issu de la cartographie des plantages invisibles
> (audit 2026-07-19). Rien n'est implémenté ; chaque chantier `O*` est autonome
> et livrable séparément. Décisions cadres, actées avec l'opérateur :
>
> - **Pas de Sentry / SaaS externe** — le projet est local-first ; toute la
>   télémétrie reste sur disque, chez l'utilisateur.
> - **Logs roulants** des deux côtés (broker et Deck) : taille bornée, jamais
>   d'accumulation infinie.
> - **Toasts avec parcimonie** : réservés aux échecs d'une action directe de
>   l'utilisateur. Les erreurs systémiques passent par le journal, le fichier de
>   log et le **bandeau rouge « broker injoignable »** (chantier O5), pas par du
>   spam de toasts.
> - Zéro dépendance nouvelle : logger et rotation faits maison (~60 lignes),
>   cohérent avec la philosophie du repo (pas d'`electron-log`, pas de pino).

## 0. État des lieux (résumé de l'audit)

Constat transversal : **aucun fichier de log n'est écrit nulle part**. Toute
l'observabilité est du `console.error` vers un stderr qui (a) côté broker
spawné est perdu dès que le premier parent meurt (`server.ts:158` :
`stdio: ["ignore","ignore","inherit"]` + `unref()`), (b) côté app Electron
packagée n'existe pas. Le journal du Deck (`desktop/src/main/journal.ts`) est
un ring buffer mémoire de 500 entrées, **activité seulement** (aucun kind
d'erreur), **perdu à chaque fermeture** (`before-quit` ne le flush pas).

Points critiques par zone (fichier:ligne sur `experimental` au moment de l'audit) :

| # | Zone | Problème | Réf. |
|---|------|----------|------|
| A1 | broker | 4 timers SQLite sans try/catch hors du garde-fou HTTP → crash process sur `SQLITE_BUSY`/disque plein | `broker.ts:395,406,442,560` |
| A2 | broker/server | aucun `uncaughtException`/`unhandledRejection` (Bun quitte sur rejet non géré) | — |
| A3 | broker | séquences multi-statements non transactionnelles (état partiel si mort brutale) | `broker.ts:863-878`, `388-390` |
| A4 | core | `config.json` malformé silencieusement remplacé par les défauts | `shared/config.ts:83-92` |
| A5 | server | échec de notification MCP en poll fallback → message peer jamais remonté au LLM, sans trace | `server.ts:351-366` |
| B1 | Deck main | aucun `uncaughtException`/`unhandledRejection`/`render-process-gone`/`child-process-gone` | — |
| B2 | Deck main | `pty.spawn` non gardé, état muté avant le spawn → tuile zombie « starting » | `pty-manager.ts:41`, `session-service.ts:264-265` |
| B3 | Deck main | écritures disque silencieusement perdues ; pire cas : inbox opérateur (drain broker destructif) | `inbox-store.ts:54-59`, graph/workspace/template/snippet-store |
| B4 | Deck main | broker injoignable = silence total (polls avalés) | `index.ts:305-307,351-353`, `broker-client.ts:49-51` |
| B5 | Deck main | ~68 catch silencieux, 11 log-only, tous invisibles en app packagée | partout |
| C1 | renderer | aucun ErrorBoundary : un throw au render blanchit toute la fenêtre (vues siblings d'un seul arbre) | `App.tsx:140-189` |
| C2 | renderer | `init()` sans `.catch` → splash permanent si un invoke IPC de boot échoue | `App.tsx:53`, `store.ts:167` |
| C3 | renderer | aucun handler global `error`/`unhandledrejection` ; ~13 actions zustand en `await` nu | `store.ts:362-418` |
| C4 | renderer | webview browser sans `did-fail-load`/`render-process-gone` ; `loadURL().catch(() => {})` | `BrowserView.tsx:316-336` |
| C5 | renderer | contrat d'erreur IPC incohérent (throw / `null` / `{error}`) | `ipc.ts` |

Acquis réutilisables : `Toast.tsx` + `showToast` (à étendre), le journal + sa vue
+ son export, le multiplexeur pty gardé du preload (`preload/index.ts:33-51`),
la gestion propre des sorties pty inattendues.

---

## O1 — Logger roulant partagé (`shared/logger.ts`)

Socle des chantiers suivants. Un module unique, sans dépendance, utilisable par
le core (Bun) **et** par le main Electron (Node) — donc `node:fs` uniquement,
pas de `Bun.file` (même contrainte que `broker-client.ts`).

- API : `createLogger({ dir, name, maxBytes, maxFiles })` →
  `{ error, warn, info, child(prefix) }`. Une ligne par entrée :
  `2026-07-19T10:00:00.000Z ERROR [broker] message… {ctx json}`.
- **Rotation par taille** (demande opérateur — pas d'accumulation infinie) :
  à l'écriture, si `name.log` ≥ `maxBytes` (défaut **5 Mo**), shift
  `name.log → name.log.1 → … → name.log.{maxFiles-1}` (défaut **3 fichiers**,
  soit ~15 Mo bornés par process). Trim des `.log.N` orphelins au boot.
- Écriture **synchrone en append** (`appendFileSync`) : ordre garanti, dernier
  souffle capturable dans un handler `uncaughtException` ; le débit attendu
  (erreurs + événements de cycle de vie, pas du trafic requête) le permet.
  Échec d'écriture du log lui-même : fallback `console.error`, jamais de throw.
- Double sortie : fichier **et** console (comportement actuel conservé pour le
  dev, `bun broker.ts` au terminal).
- Emplacements par défaut :
  - core : `<dir config claude-peers>/logs/` (même résolution
    XDG/APPDATA que `config.json`, cf. `shared/config.ts` /
    `broker-client.ts:peersConfigPath`), override `CLAUDE_PEERS_LOG_DIR` ;
    fichiers `broker.log` et `server.log` ;
  - Deck : `app.getPath('logs')` (géré par Electron par plateforme),
    fichier `main.log` (chantier O3).
- Tests : rotation au franchissement du seuil, shift des N fichiers, trim au
  boot, fallback si dir non inscriptible (`tests/logger.test.ts`).

**Fichiers** : `shared/logger.ts` (nouveau), `tests/logger.test.ts` (nouveau).

## O2 — Durcissement broker + server (core)

- **broker.ts** :
  - `process.on('uncaughtException'/'unhandledRejection')` → log complet
    (stack) puis `process.exit(1)` (état SQLite protégé par WAL ; on préfère
    une mort loggée à un état zombie).
  - try/catch individuel sur les **4 timers** (A1) : log + le timer survit à
    l'itération ratée.
  - `db.transaction` autour des séquences multi-statements (A3) :
    `handleSendMessage`, `cleanStalePeers` (modèle : `handleRoadmapImport`,
    `broker.ts:1390`).
  - Remplacement des 8 `console.error` (préfixes incohérents `[broker]` /
    `[claude-peers broker]`) par le logger O1, préfixe unifié `[broker]` ;
    log de boot (banner) conservé.
- **server.ts** :
  - mêmes handlers process-level, routés vers le `log()` existant (l.176) +
    fichier `server.log` ;
  - A5 : quand `mcp.notification` échoue dans `pollFallback`
    (`server.ts:351-366`), logger l'échec (le message reste `delivered=0`,
    le poll suivant retentera — comportement conservé mais tracé) ;
  - le spawn du broker (`server.ts:158`) passe de `stdout:"ignore"` à
    `"ignore"` conservé **mais** le broker écrit désormais son propre fichier
    (O1) — plus de dépendance au stderr d'un parent mort.
- **shared/config.ts** (A4) : `readFileConfig` logue un warning explicite
  (chemin + erreur de parse) avant de retomber sur `{}` — le fallback reste,
  le silence disparaît.

**Fichiers** : `broker.ts`, `server.ts`, `shared/config.ts`,
`tests/broker-*.test.ts` (cas timer-survit-à-l'erreur).

## O3 — Fichier de log du Deck + journal enrichi

- Instance du logger O1 dans le main : `app.getPath('logs')/main.log`,
  mêmes bornes (5 Mo × 3).
- `process.on('uncaughtException'/'unhandledRejection')` dans `index.ts` :
  log + entrée journal ; on **ne quitte pas** (fenêtre + PTYs vivants valent
  mieux qu'un crash) sauf exception au boot avant `whenReady` → `dialog.showErrorBox`
  puis exit.
- `app.on('render-process-gone')` / `child-process-gone` / `unresponsive` :
  log + journal + proposition de reload de la fenêtre (dialog).
- **Journal** : nouveau `JournalKind: 'error'` ; les catch actuellement
  log-only (B5, ~11 sites) alimentent `journal.add('error', …)` **et** le
  fichier via un helper unique `reportError(scope, err)` (un seul point
  d'entrée : fichier + journal + éventuel event renderer). Les ~57 catch
  entièrement muets sont traités par zone : broker comms (O5), persistance
  (O6), pty (O6) ; le reste au fil de l'eau.
- **Flush du journal à la fermeture** : `before-quit` (`index.ts:884`) append
  `journal.toText()` dans `app.getPath('logs')/journal-<date>.log` (borné :
  suppression des exports de plus de 7 jours au boot). Le post-mortem d'un
  run ne s'évapore plus.
- Export manuel existant (`ipc.ts:397-407`) : garder, entourer le
  `writeFileSync` d'un try/catch → toast d'erreur (action utilisateur directe,
  usage légitime du toast).

**Fichiers** : `desktop/src/main/index.ts`, `journal.ts`, `ipc.ts`,
nouveau `desktop/src/main/log.ts` (binding du logger partagé),
`tests/desktop-journal.test.ts`.

## O4 — Filets renderer (ErrorBoundary, init, handlers globaux)

- **ErrorBoundary** (composant classe maison, ~40 lignes) à deux niveaux :
  racine (`main.tsx`) → écran « l'interface a planté » avec bouton reload +
  détail, et **par vue** autour de chaque sibling de `App.tsx:140-189` → la
  vue fautive affiche un panneau d'erreur local, les terminaux et les autres
  vues survivent. `componentDidCatch` → `window.api.reportError` (IPC vers
  `reportError` d'O3).
- `window.addEventListener('error' | 'unhandledrejection')` dans `main.tsx` →
  même IPC. Les rejets fantômes des ~13 actions zustand deviennent au minimum
  visibles dans le log (leur vrai traitement : O6).
- **`init()`** (`store.ts:167`, C2) : `.catch` → état `initError` dans le
  store ; le splash (`App.tsx:128`) affiche l'erreur + bouton « réessayer »
  au lieu de tourner à vide.
- Garde try/catch dans `subscribe()` du preload (`preload/index.ts:22-26`),
  aligné sur ce que `multiplex()` fait déjà pour les canaux pty.

**Fichiers** : `desktop/src/renderer/src/main.tsx`, `components/App.tsx`,
nouveau `components/ErrorBoundary.tsx`, `store.ts`,
`desktop/src/preload/index.ts`, `desktop/src/main/ipc.ts` (canal
`app:report-error`).

## O5 — Bandeau rouge « broker injoignable » + politique toast

Demande opérateur : signal **visuel, persistant, non intrusif** plutôt qu'une
pluie de toasts.

- **Détection (main)** : `broker-client.ts` gagne un petit tracker de santé
  alimenté par les appels existants (polls inbox/drafts de `index.ts:305,351`,
  announces) : ≥ 2 échecs consécutifs → `down`, 1 succès → `up` (hystérésis
  contre le clignotement). Chaque bascule est loggée (O3) + journalisée ;
  **aucun toast**.
- **Canal** : nouvel event `broker:status` main → renderer
  ({ up, since, lastError }), même motif `subscribe()` que `sessions:changed` ;
  état poussé à l'abonnement (pas seulement sur bascule) pour couvrir un
  renderer rechargé.
- **UI** : bandeau **rouge pleine largeur en haut de la fenêtre Deck**
  (au-dessus du contenu, sous l'éventuelle barre native) :
  « ⚠ Broker injoignable depuis HH:MM — dernière erreur : … », bouton
  « Réessayer » (déclenche un poll immédiat). Disparaît seul au retour du
  broker. Clés i18n EN/FR. Le bandeau est un composant générique
  (`StatusBanner`) pour accueillir plus tard d'autres états bloquants.
- **Politique toast** (actée) : ajout d'une variante `error` à
  `Toast.tsx`/`showToast` (actuellement `success|info`, clés i18n seulement) +
  support d'un message brut ; **usage réservé aux échecs d'action directe**
  (créer une session, sauver, exporter). Throttle : même clé ≤ 1 toast / 5 s.
  Les erreurs de fond (polls, timers, persistance auto) ne toastent jamais :
  fichier + journal + bandeau si systémique.

**Fichiers** : `desktop/src/main/broker-client.ts`, `index.ts`, `ipc.ts`,
`preload/index.ts`, `renderer/src/store.ts`, `components/App.tsx`,
nouveau `components/StatusBanner.tsx`, `components/Toast.tsx`,
`desktop/locales/en.json` + `fr.json`, `tests/desktop-broker-health.test.ts`
(tracker : hystérésis, bascules).

## O6 — Contrat IPC, actions store, durcissements ciblés

- **Contrat IPC unifié** (C5) : les handlers `ipcMain.handle` **throwent**
  (sérialisation Electron native) ; suppression progressive des retours
  `null`/`{error}` hétérogènes. Côté renderer, un wrapper unique
  `call(fn, { toastKey? })` catch → `reportError` + toast `error` throttlé si
  action utilisateur. Les ~13 actions zustand en `await` nu (C3) passent par
  ce wrapper.
- **pty.spawn gardé** (B2) : try/catch dans `session-service.ts` avec
  **rollback** du `defs.push`/`'starting'` posés avant le spawn ; l'erreur
  remonte à la tuile (état `'spawn-failed'` ou dialog) au lieu du zombie.
  `write` sur pty mort (`pty-manager.ts:102`) : log debouncé + retour `false`
  exploitable par la tuile.
- **Persistance** (B3) : les catch silencieux des stores
  (inbox/graph/workspace/template/snippet) passent par `reportError`.
  Cas inbox : **écrire sur disque avant** de considérer le drain acquis —
  si l'écriture échoue, ne pas drainer (re-fetch au poll suivant) ; à défaut
  (le drain broker étant destructif à la lecture), conserver le batch raté en
  mémoire et réessayer l'écriture au poll suivant.
- **Webview browser** (C4) : handlers `did-fail-load` (hors annulations
  utilisateur, code -3) et `render-process-gone` → écran d'erreur in-view avec
  « Recharger » ; suppression du `loadURL().catch(() => {})`.
- **provider-secrets** (`provider-secrets.ts:35`) : distinguer « pas de clé »
  d'« erreur keychain » — la seconde est loggée + signalée dans Settings.

**Fichiers** : `desktop/src/main/ipc.ts`, `session-service.ts`,
`pty-manager.ts`, `inbox-store.ts` (+ autres stores), `provider-secrets.ts`,
`renderer/src/store.ts`, `components/BrowserView.tsx`,
`tests/desktop-launch.test.ts` (rollback spawn), `tests/desktop-inbox-store.test.ts`.

---

## Ordre et lotissement

| Lot | Chantiers | Contenu | Risque |
|-----|-----------|---------|--------|
| 1 | O1 + O2 | logger roulant + broker/server durcis (le vecteur de crash invisible n°1) | faible — additif |
| 2 | O3 + O4 | log fichier Deck, journal `error` + flush, ErrorBoundary, init | faible |
| 3 | O5 | bandeau broker + variante toast `error` + politique | faible |
| 4 | O6 | contrat IPC, wrapper store, pty/persistance/webview | moyen — touche des chemins chauds, à tester tuile par tuile |

Chaque lot : `bun test` + smoke check + `npm run typecheck` (desktop) + parité
locales EN/FR (cf. `TESTING.md`). À la livraison du dernier lot, ce plan est
retiré dans l'entrée `CHANGELOG.md` du batch, selon la convention du repo.
