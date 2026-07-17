# Étude de faisabilité — Roadmap en kanban, verrouillage d'items, bouton Stop, annonces & fiche détail

> Base : branche `experimental` (Deck 0.9.0, broker/core 0.7.0). Aucune contrainte de
> migration/compatibilité (produit non utilisé en production). Ce document est une
> étude : rien n'est implémenté.

## 0. État des lieux — ce que l'écran Roadmap affiche aujourd'hui

Puisque tu ne peux pas le vérifier visuellement : **l'écran actuel n'est PAS un
kanban**. `RoadmapView.tsx` affiche :

- une **liste verticale groupée par priorité MoSCoW** (Must / Should / Could / Won't),
  chaque item étant une carte (icône de kind, titre, badges value/effort/**statut**/tags) ;
- au-dessus, un **bandeau « Dispatch queue »** (items mis en file par l'opérateur,
  bouton « Send first to team-lead ») ;
- au clic sur une carte, un **panneau latéral droit** (`<aside class="roadmap-detail">`)
  avec le détail : badges, description / rationale / context en **texte brut**
  (pas de rendu markdown alors que les champs sont documentés « free markdown »),
  méta création/màj, boutons (Launch an agent, Queue, Edit, Archive) ;
- le même panneau latéral sert de **formulaire** création/édition ;
- le statut (`idea | planned | in_progress | done | archived`) n'apparaît que comme
  **badge** sur la carte — il n'y a **aucune colonne par état ni drag & drop**.

Le view poll le broker toutes les 5 s (`roadmap:list` IPC → `POST /roadmap/list`),
les agents écrivent dans la même table via les tools MCP `roadmap_*` de `server.ts`.

**Conclusion d'état des lieux : tout ce que tu demandes est un vrai chantier de
refonte de la vue + une extension du modèle de données pour le lock. Rien n'existe
déjà pour le kanban, le lock ou le stop ; le panneau détail existe mais est rudimentaire.**

---

## 1. Chantier A — Vue kanban par statut

### Faisabilité : ✅ simple, 100 % renderer (aucun changement broker/core)

- **Colonnes = statuts** : `idea`, `planned`, `in_progress`, `done` (libellés déjà
  traduits : clés i18n `roadmap.status.*` EN/FR existantes). `archived` reste hors
  board, accessible via le toggle « Show archived » existant (colonne dédiée = bruit).
- La priorité MoSCoW devient un **tri + pastille de couleur** dans chaque colonne
  (les couleurs `rm-prio-*` existent déjà). L'alternative « swimlanes » (lignes
  MoSCoW × colonnes statut) est écartée : complexe et illisible sur petite fenêtre.
- Le bandeau **Dispatch queue** reste au-dessus du board (il est transversal aux
  statuts idea/planned).
- **Drag & drop natif HTML5** (`draggable` + `onDragOver`/`onDrop` par colonne),
  aucune dépendance à ajouter — cohérent avec le zéro-dépendance du repo (le
  drag-réordonnancement de la sidebar est déjà fait maison). Le drop appelle le
  `roadmapUpsert({ id, status })` existant, puis `refresh()`.

### Règles de déplacement demandées

| Mouvement | Comportement |
|---|---|
| n'importe quelle colonne → `done` | **`ConfirmDialog`** (composant existant, déjà utilisé pour l'archivage) : « L'item ne sera plus traité » ; drop annulé si refus |
| `in_progress` **verrouillé** → ailleurs | carte **grisée**, `draggable=false`, badge 🔒 + tooltip « verrouillé par un agent » (dépend du chantier B) |
| `in_progress` non verrouillé → ailleurs | libre (c'est précisément la distinction « file d'attente » vs « réellement en cours ») |
| vers `in_progress` à la main | autorisé, ne pose **pas** de lock (le lock ne vient que d'un agent) |

### Fichiers touchés

- `desktop/src/renderer/src/components/RoadmapView.tsx` — refonte (extraction
  conseillée : `RoadmapBoard` / `RoadmapCard` internes, le fichier fait déjà 636 lignes).
- `desktop/src/renderer/src/styles.css` — nouvelles classes `.rm-board`, `.rm-col`,
  `.rm-col-head`, `.rm-card-locked`, `.rm-drop-over`… (~150 lignes). Colonnes en
  flex/grid, scroll vertical par colonne, `overflow-x` géré.
- `desktop/src/main/i18n.ts` (EN_DEFAULTS) + `desktop/locales/en.json` + `fr.json`
  (parité testée par `desktop-i18n.test.ts`) — ~10 clés : confirmation « done »,
  tooltips lock/drag, en-têtes éventuels.

---

## 2. Chantier B — Verrouillage « lock by agent »

### Faisabilité : ✅ mais une décision de conception à trancher (attribution)

Objectif : distinguer les items **réellement en cours** (un agent y travaille, plus
personne d'autre n'y touche) des items in_progress « en file d'attente ».

#### 2.1 Modèle de données (broker, source de vérité partagée multi-machines)

Tu demandes un **booléen** `lock_by_agent`. Je recommande de garder cette sémantique
booléenne côté UX, mais de stocker **trois colonnes** dans `roadmap_items` :

```sql
locked     INTEGER NOT NULL DEFAULT 0   -- le booléen demandé
locked_by  TEXT                          -- peer_id snapshot (pas de FK, comme created_by)
locked_at  TEXT                          -- ISO, pour le TTL
```

**Pourquoi `locked_by` alors que tu voulais éviter la mécanique d'enregistrement ?**
Ta crainte (chaque membre d'une équipe s'enregistre/désenregistre = protocole
coûteux en tokens) ne s'applique pas ici : chaque écriture roadmap porte **déjà**
un champ `by` (peer_id de l'auteur). Quand un agent passe l'item `in_progress`,
le broker peut remplir `locked_by = by` **gratuitement**, sans aucun aller-retour
supplémentaire ni protocole d'équipe : il y a **un seul propriétaire de lock**
(le peer qui a pris l'item, en général le team-lead ou l'agent lancé sur l'item),
jamais une liste. Ce champ est ce qui rend la **libération automatique ciblée**
possible (« le peer X est-il encore actif ? ») et permet d'afficher « 🔒 verrouillé
par olivier-pc-foo » dans l'UI — le bonus que tu trouvais intéressant, sans le coût.

#### 2.2 Pose du lock

Deux mécanismes cumulables, je recommande les deux :

1. **Auto-lock broker** (robuste, indépendant du prompt) : dans
   `handleRoadmapUpsert`, toute transition `status → in_progress` par un auteur
   **non-`deck`** pose `locked=1, locked_by=by, locked_at=now`. Toute transition
   quittant `in_progress` (done, planned, archived) efface le lock.
2. **Contrat de prompt** : les textes qui cadrent les agents sont mis à jour pour
   expliciter « passe l'item in_progress quand tu commences réellement (cela le
   verrouille), remets-le planned si tu abandonnes » :
   - `composeItemPrompt` (RoadmapView, bouton « Launch an agent »),
   - `composeDispatchText` (`desktop/src/main/dispatch.ts`),
   - les instructions MCP + descriptions des tools `roadmap_*` dans `server.ts`.

Cas particulier : le bouton « Launch an agent » du Deck passe aujourd'hui l'item
`in_progress` immédiatement avec `by='deck'` → il ne poserait **pas** de lock
(auteur deck), et c'est correct : l'item est « soumis » mais le lock arrive quand
l'agent commence réellement (son premier `roadmap_update`). Entre les deux, l'item
est in_progress-non-verrouillé = file d'attente réelle, exactement ta distinction.

#### 2.3 Application du lock (qui est bloqué, et où)

- **UI (Deck)** : carte grisée + non draggable ; dans la fiche détail, statut non
  éditable et actions restreintes ; badge 🔒 avec `locked_by` + ancienneté. Un
  bouton « Force unlock » (avec confirmation) reste disponible en secours —
  l'échappatoire manuelle que tu décris passe normalement par le bouton Stop
  (chantier C).
- **Broker (garde dure, recommandée)** : `handleRoadmapUpsert` refuse (409
  « item locked by X ») une tentative de passage `in_progress` (ou toute écriture
  de statut) par un **auteur différent de `locked_by`**, sauf `by='deck'` ou champ
  explicite `force:true`. C'est ce qui garantit « aucune autre session ne vienne
  traiter cet item » y compris pour des sessions CLI hors Deck / autres machines.
  `server.ts` renvoie l'erreur telle quelle à l'agent, qui comprend.

#### 2.4 Libération automatique — la double surveillance que tu décris

Deux signaux, deux emplacements :

1. **État du peer côté broker** (couvre toutes les sessions, y compris hors Deck) :
   un sweep `releaseStaleLocks` dans `broker.ts` (même modèle que `cleanStalePeers` /
   `sweepInactivePeers`, timer + ENV) : pour chaque item `locked=1`,
   - si `locked_by` n'a **aucun peer actif** sur le `project_key` de l'item
     (les peers portent déjà `project_key` et `status active/dormant`, entretenu par
     heartbeat 120 s + sweep 60 s) depuis plus qu'un délai de grâce → unlock
     (l'item reste `in_progress`, ou repasse `planned` — à trancher, je recommande
     `planned` pour qu'il soit clairement « à reprendre ») ;
   - **TTL absolu** : `locked_at` plus vieux que `CLAUDE_PEERS_LOCK_TTL_HOURS`
     (défaut proposé : 6 h, configurable) sans aucune écriture sur l'item → unlock.
     C'est le filet de sécurité pour le cas « session ouverte mais agent parti
     ailleurs » que le heartbeat ne détecte pas (le MCP server heartbeat même
     quand Claude ne fait rien).
2. **Activité de la session côté Deck** (ton « si du contenu terminal est
   modifié ») : `SessionService` voit déjà tout le flux PTY (`data` events, il
   alimente les détecteurs thinking/quota/attention). Ajouter un `lastOutputAt`
   par session est trivial. Un watcher dans `index.ts` (comme `watchDispatched`,
   tick ~1 min) croise : item locké + `locked_by` correspond au `peerId` d'une
   session du Deck + aucune sortie terminal depuis X h → unlock via
   `upsertRoadmap(by:'deck')` + entrée journal.
   **Limite assumée** : ce signal ne couvre que les sessions spawnées par CE Deck
   sur CETTE machine ; les sessions distantes/CLI retombent sur le sweep broker (1).

Verdict : ta double surveillance est faisable telle quelle. Le sweep broker est le
mécanisme d'autorité (fonctionne toujours), le watcher Deck est un raffinement qui
détecte plus finement l'inactivité *réelle* — je propose de livrer (1) d'abord et
(2) en second temps.

#### 2.5 Fichiers touchés

| Fichier | Changement |
|---|---|
| `broker.ts` | 3 `ALTER TABLE` idempotents ; auto-lock/unlock + garde 409 dans `handleRoadmapUpsert` ; sweep `releaseStaleLocks` + timer + ENV ; `rowToRoadmapItem` |
| `shared/types.ts` | `RoadmapItem` +3 champs ; `RoadmapUpsertRequest` + `locked?`/`force?` |
| `server.ts` | descriptions/params des tools `roadmap_*` (contrat lock), affichage 🔒 dans `formatRoadmapItemLine/Detail`, instructions MCP |
| `desktop/src/main/session-service.ts` | `lastOutputAt` par session |
| `desktop/src/main/index.ts` | watcher d'inactivité Deck (phase 2) |
| `desktop/src/main/dispatch.ts` | `composeDispatchText` (contrat lock) |
| `desktop/src/renderer/src/components/RoadmapView.tsx` | grisé/badge/blocage drag |
| tests | nouveau `tests/broker-roadmap-lock.test.ts` (pose, garde 409, sweep, TTL) ; màj `broker-roadmap.test.ts`, `desktop-dispatch.test.ts` |
| docs | `ARCHITECTURE.md` (section roadmap + ENV), `CHANGELOG.md` |

---

## 3. Chantier C — Bouton « Stop » sur un item in_progress

### Faisabilité : ✅, toute l'infrastructure existe

But : l'opérateur dit « on arrête de traiter cet item » → les agents sont prévenus,
l'item est déverrouillé, et l'opérateur a un retour.

Flux proposé (bouton ⏹ sur la carte in_progress verrouillée + dans la fiche détail,
avec `ConfirmDialog`) → IPC `roadmap:stop(id)` → dans `index.ts` :

1. **Route « superviseur » (ta préférence, pour le retour utilisateur)** : si une
   session superviseur est vivante (PLAN C5 ; Home la spawne à la demande), le Deck
   lui envoie un **announce ciblé** (mécanique `announceToLead` existante, ciblage
   par `to_peer_id`) : « l'opérateur demande l'arrêt du travail sur l'item X ;
   préviens les peers concernés, vérifie l'arrêt, rends compte à l'opérateur ».
   Le retour arrive par l'**operator inbox** (PLAN C12 : `send_message` vers
   `operator`, drainé toutes les 10 s, notification système + panneau Inbox —
   tout existe déjà). Le superviseur dispose des tools claude-peers et roadmap.
2. **Fallback broadcast** : pas de superviseur vivant → `/announce` de groupe
   direct (« stop work on roadmap item X (id) — acknowledge to operator »),
   toast + journal.
3. **Déverrouillage** : je recommande que le Deck déverrouille **immédiatement**
   (`locked=0`, statut → `planned`) au moment du stop, sans attendre un ack :
   déterministe, l'opérateur reprend la main tout de suite, et le stop EST
   l'action manuelle qui lève le lock dans ton modèle. (Alternative : attendre
   l'ack de l'agent avec timeout — plus « propre » mais plus fragile ; non
   recommandée en v1.)

⚠️ Règle C8 du projet : le texte du message de stop doit être une **constante de
code** (comme `composeDispatchText`), jamais un template opérateur/repo →
`composeStopText(item)` dans `dispatch.ts`.

Fichiers : `ipc.ts` (+ handler), `preload/index.ts` + `index.d.ts`
(+ `window.api.roadmapStop`), `index.ts` (routage superviseur/fallback + unlock +
journal), `dispatch.ts` (`composeStopText` + test), `RoadmapView.tsx` (bouton +
confirm), i18n (~6 clés), `tests/desktop-dispatch.test.ts`.

---

## 4. Chantier D — Announce d'arrivée de peer : « ne pas répondre »

### Faisabilité : ✅ trivial (texte seul)

Diagnostic : les messages `/announce` portent déjà la note serveur
`DECK_NO_REPLY_NOTE` (« do NOT reply, do not send_message toward "deck" ») —
mais elle n'interdit que de répondre **au Deck**. Or les instructions MCP du canal
disent par ailleurs « RESPOND IMMEDIATELY » aux messages entrants : les agents
saluent donc le **nouveau peer** via `send_message` (c'est le trou que tu observes).

Correctif à deux niveaux :

1. `desktop/src/shared/announce.ts` → `composeJoinAnnounce` : ajouter une phrase
   explicite du type *« Notification only: do NOT reply, do NOT greet or message
   the new peer about this. Just continue your current task. »* (anglais, comme
   tout le cadrage agent). Test : `tests/desktop-announce.test.ts`.
2. Optionnel mais recommandé : renforcer `DECK_NO_REPLY_NOTE` dans `server.ts`
   (« do not message *anyone* about this announcement ») pour couvrir tous les
   broadcasts deck, pas seulement les joins.

---

## 5. Chantier E — Fiche détail ergonomique (panel ou pop-up)

### Faisabilité : ✅ ; recommandation : **modal** (pop-up avant-plan)

Le panneau latéral existe déjà mais : texte brut non mis en forme, largeur fixe
~340 px, pas de hiérarchie visuelle. Avec le passage en kanban, les colonnes
consomment la largeur → un panneau latéral permanent comprimerait le board. Je
recommande donc la **modal type « carte Trello »** : clic sur une carte → overlay
avant-plan, large, fermable (✕ / Échap / clic hors zone). Le formulaire
d'édition peut suivre le même chemin (modal) ou rester tel quel en v1.

Contenu proposé : en-tête (icône kind, titre, pastille priorité) ; grille de méta
(statut, value, effort, queue, 🔒 locked_by + depuis quand) ; sections titrées
Description / Rationale / Context (briefing agent) avec **rendu markdown** ;
dépendances cliquables (`depends_on` existe dans le modèle mais n'est même pas
affiché aujourd'hui) ; pied attribution created/updated ; barre d'actions
(Launch agent, Queue, Stop si locké, Edit, Archive).

**Point d'attention markdown** : les champs sont du markdown écrit par des
*agents* — le rendu doit être **échappé** (pas d'injection HTML dans le renderer
Electron). Le repo est volontairement quasi zéro-dépendance (seul `node-pty` en
runtime) : plutôt qu'ajouter `marked` + sanitizer, je propose un **mini-renderer
interne** (~120 lignes : titres, gras/italique, listes, `code`, blocs de code,
liens neutralisés ou ouverts via le browser embarqué), pur et testé sous
`bun test` — dans l'esprit des helpers existants.

Fichiers : nouveau `RoadmapItemModal.tsx` (ou section de RoadmapView), nouveau
`desktop/src/renderer/src/markdown.ts` (+ test), `styles.css` (~100 lignes),
i18n (~5 clés).

---

## 6. Décisions à trancher (avec mes recommandations)

1. **Attribution du lock** : booléen pur vs booléen + `locked_by`/`locked_at`
   implicites (zéro coût token). → **Reco : avec attribution implicite**, sinon
   ni libération ciblée ni affichage « verrouillé par X » ne sont possibles.
2. **Garde côté broker** (409 pour un non-propriétaire) en plus du grisé UI.
   → **Reco : oui**, c'est la seule vraie garantie multi-sessions/multi-machines.
3. **Statut après unlock auto / stop** : rester `in_progress` ou repasser
   `planned`. → **Reco : `planned`** (l'item redevient visiblement « à prendre »).
4. **Stop** : unlock immédiat par le Deck vs attendre l'ack agent.
   → **Reco : immédiat** (v1), l'ack arrive quand même via l'inbox opérateur.
5. **Détail** : modal vs panneau élargi. → **Reco : modal** (compatible kanban).
6. **TTL du lock** : valeur par défaut (proposé 6 h) + ENV
   `CLAUDE_PEERS_LOCK_TTL_HOURS` / `CLAUDE_PEERS_LOCK_SWEEP_SEC`.

## 7. Séquencement proposé

| Phase | Contenu | Dépendances | Ampleur |
|---|---|---|---|
| 1 | Kanban (colonnes statut, DnD, confirm → done) + modal détail + markdown + announce no-reply | aucune (renderer + 1 helper) | moyenne |
| 2 | Lock : schéma broker, auto-lock/garde, tools/prompts, UI grisée + badge | — | moyenne |
| 3 | Libération auto : sweep broker (peer dormant + TTL), puis watcher d'inactivité Deck | phase 2 | moyenne |
| 4 | Bouton Stop (route superviseur + fallback broadcast + unlock + journal) | phases 2–3 | petite/moyenne |

Chaque phase laisse le produit fonctionnel ; les phases 1 et 2 sont indépendantes
et parallélisables. Vérification transverse à chaque phase : `bun test` (suite
broker + desktop), `bunx tsc --noEmit` (core), `npm run typecheck` (desktop),
parité i18n (`desktop-i18n.test.ts`), et màj `ARCHITECTURE.md` / `CHANGELOG.md`.

## 8. Verdict global

Tout est faisable avec l'infrastructure en place, sans nouvelle dépendance et sans
migration : le kanban est une refonte de vue pure ; le lock s'appuie sur le champ
`by` déjà présent sur chaque écriture roadmap et sur les états peers déjà
entretenus par le broker ; le stop réutilise l'announce ciblé (C10), le
superviseur (C5) et l'inbox opérateur (C12) ; l'annonce no-reply est un correctif
de texte. Le seul vrai choix structurant est le point 6.1 (attribution implicite
du lock) — le reste est de l'exécution.
