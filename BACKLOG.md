# Backlog centralisé — reste à faire / à vérifier

Fichier unique regroupant tout ce qui reste **ouvert** (à faire, à valider, à
décider) dans le repo. Il consolide les fichiers de plan / exploration / audit
de la racine. Le narratif de ce qui est **livré** vit dans `CHANGELOG.md` (par
lot) ; ce fichier ne garde que le **résiduel**.

> ⚠️ **Datation.** Les items sécurité viennent de l'audit du **2026-07-20**
> (base `experimental`). Depuis, plusieurs lots ont été livrés (team-spawn,
> multi-llm lot A, mobile-lan, Git/Files GX). **Chaque item sécurité ouvert
> est donc à RE-VÉRIFIER sur le code courant avant traitement** — certains ont
> pu être corrigés par un lot ultérieur. Les items marqués « différé (décision
> opérateur) » sont des choix assumés, pas des oublis.

Sources consolidées (fichiers désormais **supprimés** — détail complet des
chaînes d'exploitation et des alternatives de design dans l'historique git) :
les anciens `AUDIT-SECURITE-MAINTENANCE.md`, `AUDIT-REMEDIATION-PLAN.md`,
`PLAN-mobile-lan.md`, `PLAN-team-spawn.md`, `EXPLORATION-multi-llm.md`,
`EXPLORATION-team-spawn.md`, `EXPLORATION-mobile-lan.md`,
`PLAN-git-explorer.md`, ainsi que les seeds de roadmap différée
`roadmap-seed-v0.9.json` (items ci-dessous) et `roadmap-seed-v0.6.json`
(C6/C7/C8, **entièrement livrés** — rien à porter). Le narratif livré vit dans
`CHANGELOG.md`. Le mécanisme d'import roadmap (`bun cli.ts roadmap-import`)
reste disponible pour recréer un seed depuis l'historique git au besoin.

---

## 1. Sécurité — audit (à re-vérifier avant action)

### 1.1 Déjà traité (rappel, ne rien refaire)

Lots de remédiation livrés (`AUDIT-REMEDIATION-PLAN.md`) : **B1/NF-A** (projections
publiques peers+messages), **B2** (garde Origin), **B4** (gate templates projet),
**B5** (gate `worktreeInit`), **B6** (`sanitizeFlagValue` agent/model), **B9**
(`config:set` rejette `projectDir`), **M-SEC-1** (compares constant-time),
**M-SEC-9 / Desktop N3** (containment `template:read/apply`), **M-LOG-1**
(écritures atomiques), **companion device management** (liste + révocation +
notification). Plus, hors audit : **GX-SEC** (validation `dir` des handlers
diff/explorer + garde realpath — lot Git/Files).

### 1.2 Différé par décision opérateur (assumé)

- [ ] **B3** — groupe `default` non authentifié + endpoints admin en GET.
- [ ] **B7** — flux « resume » = prise d'identité sans secret `(host,cwd,group)`.
- [ ] **B8** — détournement/rejeu de socket WebSocket (auth statique, pas de nonce).
- [ ] **B10 / M-SEC-5** — `CHANNEL_TIERS` déclarés mais **jamais appliqués**
      (un appairage = accès équivalent-opérateur). *Multiplicateur des RCE ;
      différé car « le mobile pilote l'app, son cred est de confiance ».*

> Modèle de menace validé : broker + clients sur **LAN de confiance** ;
> companion LAN uniquement. Priorité n°1 assumée = **RCE via dépôt cloné**
> (déjà traité, B4/B5/B6). Le durcissement WAN/initié-LAN est « bienvenu si peu
> coûteux », jamais prioritaire.

### 1.3 Ouvert — MAJEUR (re-vérifier puis trancher)

- [ ] **M-SEC-2** — mode HTTP : aucun TLS imposé (tokens/messages en clair).
- [ ] **M-SEC-3** — `ANTHROPIC_API_KEY` exfiltrée vers un endpoint OpenAI-compat tiers (fallback à supprimer).
- [ ] **M-SEC-4** — `summarize` `base_url` non validée (`http://` + surface SSRF).
- [ ] **M-SEC-6** — fenêtre principale sans garde `will-navigate` (bridge exposé si navigation hors app).
- [ ] **M-SEC-7** — handlers IPC sans validation de `senderFrame` alors que `webviewTag` est actif.
- [ ] **M-SEC-8** — `<webview>` `sandbox=no` sans clamp `will-attach-webview`.
- [ ] **M-SEC-10** — clés provider persistées en clair sur Linux sans keyring (refuser / opt-in).
- [ ] **M-SEC-11** — payloads broker non bornés (`maxRequestBodySize`, caps par champ, rate-limit).
- [ ] **M-SEC-12** — messages de canal injectés comme instructions haute priorité (cadrer en donnée non fiable).
- [ ] **M-LOG-2** — `handleRegister` non atomique → TOCTOU sur l'unicité `peer_id`.
- [ ] **M-LOG-3** — `handleUnregister` non transactionnel (suppression partielle possible).
- [ ] **M-LOG-4** — verrou workspace : TOCTOU + pas de vérif de propriété (`wx`/`O_EXCL`).
- [ ] **NF-D** — autorité roadmap dérivée du champ client `by:"deck"` (forgeable → usurpation opérateur).
- [ ] **NF-E** — `/roadmap/import` : `items` non borné + écrasement par id (cap + credential + create-only).
- [ ] **NF-F** — `pid` client non fiable pour la vivacité (`process.kill(pid,0)` sur pid fourni).

### 1.4 Ouvert — MINEUR (durcissement / robustesse)

Sécurité : N-SEC-1 (500 fuite l'exception brute), N-SEC-2 (perms du fichier secret
de groupe), N-SEC-3 (validation `group_id` + hash NULL non-default), N-SEC-4 (temp
graph-draft prévisible), N-SEC-5 (heuristic-ack marque des tiers `delivered`),
N-SEC-6 (deadline d'auth WS), N-SEC-7 (contenu messages/résumés en clair dans les
logs), N-SEC-8 (`announce:send` remote-atteignable), N-SEC-9 (whitelist des clés
`config:set`), **N-SEC-10** (containment `delete*` par `realpath`, pas `resolve` —
proche de la règle GX-SEC), N-SEC-11 (CORS `*` sur endpoint design), N-SEC-12
(static serve compagnon fragile si `decodeURIComponent` ajouté).

Logique : N-LOG-1 (gardes NaN sur `parseInt`), N-LOG-2 (timeout HTTP broker au
boot), N-LOG-3 (réentrance `cleanup` SIGINT+SIGTERM), N-LOG-4 (`whoami.summary`
toujours vide), N-LOG-5 (`switch_group` incomplet), N-LOG-6 (garde de type sur
`body` désérialisé).

---

## 2. Validations visuelles / E2E en attente (Electron non lançable en CI)

Tout est couvert par tests + typecheck ; seul le rendu réel reste à valider par
l'opérateur sur une machine avec affichage.

- [ ] **Vues Git (±) et Files (📁)** — validation visuelle + calcul de plage de
      lignes de la sélection à l'usage (`PLAN-git-explorer.md`, lot GX).
- [ ] **UI device-management du companion** — liste + boutons révoquer / tout
      révoquer (`AUDIT-REMEDIATION-PLAN.md` Lot 2, « ⚠️ UI à valider »).
- [ ] **Pont mobile LAN de bout en bout** — essai réel « téléphone sur le
      Wi-Fi » (`PLAN-mobile-lan.md`) : le serveur companion se lie à une
      interface LAN absente du conteneur.
- [ ] **UI graph chat + picker de modèles (lots C23-C29)** — validations
      manuelles au premier lancement réel (`roadmap-seed-v0.9.json`) : canvas
      graphe (pan/zoom/drag, branchement, croisement, inspecteur de contexte),
      battle avec juge, picker (accordéon providers, favoris ★, détection
      CLIs), Settings > Modèles avec un endpoint Ollama/LiteLLM réel
      (découverte + inférence + clé chiffrée safeStorage + bouton ⊘).
- [ ] **Lot limites d'usage + Antigravity (session 2026-07-22)** — vérifs
      terrain, aucune n'est couverte par les tests (endpoints et binaires
      réels inaccessibles en CI) :
  - **Modale limites** : rendu deux thèmes ; fermeture clic extérieur / croix
    / Échap ; états dégradés réels (« non connecté », « indisponible »,
    valeurs « stale » Codex) ; bouton ↻ (contourne bien le cache 3 min).
  - **Provider Claude** : appel réel de `api.anthropic.com/api/oauth/usage`
    avec un compte connecté — les 4 blocs s'affichent (session 5 h, hebdo
    tous modèles, hebdo par modèle : vérifier le nom réel du champ
    `seven_day_*` renvoyé pour un plan Fable, crédits extra) ; pas de 429 au
    poll 5 min (le User-Agent vient de `claude --version` : vérifier la
    valeur sondée) ; token expiré + Claude Code fermé → « non connecté ».
  - **Provider Codex** : handshake réel `codex app-server`
    (initialize/initialized puis `account/rateLimits/read`) ; couper
    l'app-server pour vérifier le repli fichier de session (mention stale).
  - **Provider Antigravity (quota)** : lecture keyring réelle — macOS
    (`security`, service `gemini` / compte `antigravity`, blob
    go-keyring-base64) et Linux (`secret-tool`) ; extraction du
    client_secret depuis le binaire `agy` (sinon var
    `KORY_ANTIGRAVITY_CLIENT_SECRET`) puis refresh OAuth ; buckets réels
    `gemini-5h/weekly` + `3p-*` (le format a déjà changé une fois côté
    Google).
  - **Amphore-jauge** : lisibilité du niveau à 20 px (deux thèmes), teintes
    vert/ambre/rouge, tooltip « X% restant » ; providers « utilisés » : une
    tuile vivante → quota Claude seul, puis un fan-out graph multi-provider
    → la moyenne bascule.
  - **Provider Antigravity (modèles)** : voir §3.1bis (ids `agy models`,
    approbation lecture fichier en `-p`, rendu PTY).
- [ ] **Workflow lane (roadmap, branche `claude/roadmap-workflow-visual-m3qr0x`)**
      — canvas dérivé (`WorkflowLane.tsx` + `shared/workflow.ts`), couvert par
      tests purs + broker, jamais rendu à l'écran. À valider sur une vraie
      machine :
  - Lisibilité du losange A→B/A→C→D (fan-in/fan-out empilé dans la même
    colonne) à densité réelle, en thème clair ET sombre.
  - Geste de drag : glisser une carte du kanban vers la lane (caret
    d'insertion), réordonner en glissant dans la lane, empiler une carte
    au-dessus/en-dessous d'une autre (slot fantôme pointillé) pour créer un
    parallélisme — vérifier que le slot ne s'affiche JAMAIS entre deux
    cartes liées par une dépendance (`dependsRelated`) et que la carte
    glisse alors latéralement.
  - Preview rouge en direct pendant le drag : lien + bords des deux cartes
    quand l'insertion survolée mettrait une carte du mauvais côté d'un lien
    (`slotConflicts`) — l'arête doit suivre le fantôme de la carte déplacée.
  - Lien tiré depuis le port d'une carte : vers une autre carte (dépendance,
    cycle refusé avec toast), et dans le vide (modale de création
    pré-remplie ; Annuler ne doit rien créer).
  - Clic sur une arête committée (violation de dépendance déjà persistée) :
    panneau d'explication + bouton « supprimer la dépendance ».
  - Zoom molette/boutons, auto-fit jusqu'au plancher (0.55×) puis
    apparition de la scrollbar fine proportionnelle ; bouton plein écran
    (modale avant-plan 92vw×86vh) et retour.
  - Carte verrouillée (agent en `in_progress`) : bien figée en tête de
    chaîne, non déplaçable, non empilable.
  - Filtre "kind" du kanban : la lane doit continuer à voir/réordonner la
    file complète (non filtrée) — vérifier qu'aucun item n'est perdu au
    reorder pendant qu'un filtre est actif.
- [ ] **Cartes directives (CT, branche `claude/context-token-optimization-4n7aqh`)**
      — logique couverte par tests purs (broker directive, `directive.ts`,
      `resolveFeatures`, parsing magic-compact) + typecheck ; l'injection PTY et
      le rendu ne sont jamais exercés en CI. À valider sur une vraie machine :
  - Carte directive de bout en bout : créer une carte kind `directive`
    (dropdown commande + multi-sélection des peers vivants), la mettre en file,
    dispatcher, et vérifier que `/clear` (puis `/compact`) est bien saisi dans
    le terminal de CHAQUE peer ciblé — et d'aucun autre — quand la carte atteint
    la tête de file ; garde d'inactivité (aucune injection pendant que la tuile
    est busy).
  - **Option A magic-compact — vérification empirique CRITIQUE** : que la forme
    argument `/resume <id>` est honorée dans le TUI des versions CC visées
    (process non redémarré → peer_id et harness conservés), et que le harness de
    démarrage (`--append-system-prompt-file`, serveurs MCP) survit au switch de
    session in-app. Si A régresse : basculer sur l'option B (`restart` fork-resume,
    même panneau) puis C (kill+respawn), déjà documentées dans `PLAN-DIRECTIVES.md`.
  - **Fiabilité de la capture de la bannière `/resume <id>`** (surgi de la
    revue de code) : `parseMagicResume` s'appuie sur `stripAnsi` (ancré ESC) +
    une regex tolérant un écart de 240 car. entre « to enter the compacted
    session » et `/resume <uuid>`. À confronter à la **vraie sortie du plugin** :
    séquences OSC-8 (hyperliens), re-wrap du terminal, sortie fragmentée sur
    plusieurs chunks PTY (le scanner bufferise 64 Ko glissants — vérifier que la
    bannière n'est jamais coupée par la troncature du buffer), et layout exact du
    message. Ajuster la regex / le `stripAnsi` si un cas réel échappe.
  - **Timing sous cible occupée** : le scanner n'est armé qu'APRÈS l'injection
    (le budget `MAGIC_TIMEOUT_MS` = 160 s démarre à l'injection, pas pendant
    l'attente d'inactivité) ; vérifier sur une tuile réellement busy que la
    bannière est bien capturée dans le budget et qu'aucun repli `/compact`
    prématuré ne se produit pendant que `/magic-compact` tourne encore.
  - Détection du plugin magic-compact avec / sans installation
    (`<CLAUDE_CONFIG_DIR|~/.claude>/plugins`), le layout on-disk réel du plugin
    (marketplace vs repos), et le repli `/compact` sur message de shim ou timeout.
  - Rendu visuel de la carte directive (cadre pointillé violet, chips cibles,
    badge commande) en thème clair ET sombre ; éditeur (champs work-only masqués).
  - **peer_id à travers l'option B** (multi-sessions même cwd+groupe) : seule la
    session canonique du `session_key` récupère son identité — voir résiduel core
    §3.7 (intégrer `CLAUDE_PEERS_DESK_SESSION` dans le `session_key`).
  - **Carte directive ciblant des peers répartis sur PLUSIEURS Decks** (même
    broker/projet, cas multi-PC) — correction, pas sécurité : chaque Deck exécute
    la file partagée. La carte est marquée `done` par le premier Deck qui la
    traite (injecte SES cibles vivantes), ce qui peut la retirer de la file avant
    qu'un second Deck ait injecté LES SIENNES → certaines cibles ratent le reset.
    À vérifier / décider : soit restreindre une carte directive aux peers d'un
    seul Deck, soit coordonner le `done` (n'archiver qu'une fois toutes les cibles
    connues traitées, p.ex. via un accusé par peer). Le double-traitement d'une
    MÊME tuile est impossible (une tuile vit dans un seul Deck), donc pas de
    double-injection ; le risque est l'inverse (injection manquée).

---

## 3. Fonctionnalités différées (v2 / vNext)

### 3.1 Multi-CLI (agents & superviseur non-Claude)

- [ ] **Tuiles agents Codex / Gemini** (team-spawn palier 1) : le champ `cli`
      de `deck_spawn_session` existe déjà (seul `claude` accepté). Prérequis :
      dérouler les validations terrain §4.4 avant tout code
      (`EXPLORATION-team-spawn.md`, `EXPLORATION-multi-llm.md`).
- [ ] **Superviseur Codex** (`EXPLORATION-multi-llm.md` §4) — non lancé, gardé
      derrière des validations :
  - Étape 1 (prototype manuel) : P1-P4 (bridge MCP over stdio, reprise session, quoting).
  - Étape 2 (sécurité) : V1 (token dans `ps`), V2 (`mcp_servers` du config opérateur), V3 (aplatissement multi-lignes du prompt + test quoting POSIX/PowerShell), V4 (bridge orphelin / token périmé).
  - Étape 3 (code, si P1-P4 passent) : M1 `buildCodexSupervisorArgs`, M2 variante de commande superviseur par CLI, M3 choix du CLI superviseur (réglages/menu Home), M4 journal/i18n/docs. M5 = dégradations assumées (back-channel `/clear`, quota auto-resume).
- [ ] **Décision #3** (`EXPLORATION-multi-llm.md`) : passer codex à
      `-c model_instructions_file` si les réponses régurgitent le contexte
      (non-bloquant aujourd'hui).

### 3.1bis Limites d'usage (lot livré — résiduel)

- [x] **Antigravity comme provider de MODÈLES** — livré (2e vague du lot) :
      catalogue + adapter `agy -p` sous PTY (`pty-run.ts`), cf. CHANGELOG.
      Résiduel à VALIDER sur un vrai poste : (a) les ids de modèles exacts via
      `agy models` (liste curatée depuis la reco, non vérifiée terrain) ;
      (b) que la lecture du fichier de contexte passe sans approbation en
      mode `-p` (sinon : timeout visible dans le nœud) ; (c) le rendu PTY
      (artefacts ANSI/CR nettoyés par `pty-run.ts`).
- [ ] **Windows : lecture du keyring Antigravity** non implémentée (Credential
      Manager sans lecture scriptable) — le provider s'affiche « non
      connecté » sous Windows. Piste : addon natif ou `powershell` + DPAPI.
- [ ] **Refresh token Antigravity** : le client_secret OAuth (public, flow
      installed-app, mais bloqué par le secret-scanning GitHub) n'est PAS dans
      le repo — extrait à l'exécution du binaire `agy` (scan `GOCSPX-…`) ou
      fourni via `KORY_ANTIGRAVITY_CLIENT_SECRET`. Si l'extraction casse
      (binaire obfusqué/rotation Google), le refresh se désactive et le token
      stocké est utilisé tel quel — vérifier après chaque mise à jour majeure
      d'Antigravity.
- [x] **Badge d'alerte sur le bouton amphore** : remplacé (2e vague, demande
      opérateur) par la jauge amphore — niveau = quota session restant moyen
      des providers utilisés, teinte verte/ambre/rouge, poll 5 min à travers
      le cache 3 min. À VALIDER visuellement (lisibilité du niveau à 20 px,
      deux thèmes).
- [ ] **Gemini CLI (comptes orga Code Assist)** : exclu par décision opérateur
      (compte perso migré Antigravity). Si un besoin orga apparaît, le provider
      `retrieveUserQuota` de gemini-cli se greffe dans `usage-service.ts` sur
      le même modèle.

### 3.2 Mobile LAN

- [ ] **MB6 — coquille Android** : scaffold `mobile-shell/` livré mais **non
      buildé** (pas de SDK ici). TODOs natifs du `mobile-shell/README.md` :
      service foreground, verrou biométrique + `FLAG_SECURE`, pinning cert.
- [ ] **M3e — mode fil de la vue Graph sur mobile** : reporté (Graph absent de
      la nav mobile v1).
- [ ] **PWA (v2)** : manifest + icône pour « installation » sur l'écran d'accueil.
- [ ] **Doc opérateur README** : démarrage de l'accès companion + avertissement cert.

### 3.3 Git / Explorateur de fichiers — Phase D

- [ ] **Coloration syntaxique** du viewer (et des diffs ?) via **shiki** ou
      **highlight.js** en lazy-load (`PLAN-git-explorer.md` phase D).
- [ ] **Virtualisation** des très gros fichiers + **recherche dans le fichier**.

### 3.4 Team spawn — confort

- [ ] **Dialog « Revue d'équipe » riche (renderer)** : la v1 utilise le dialog
      natif ; une vue dédiée pourra suivre si l'usage le réclame
      (`PLAN-team-spawn.md`).

### 3.5 Graph chat — nœuds v-next (seeds `roadmap-seed-v0.9.json`, ex-C28)

- [ ] **Nœuds digest** : au-delà du budget (`GRAPH_MAX_CONTEXT_CHARS`), la
      compilation élide les échanges anciens ; un nœud digest les remplacerait
      par un résumé LLM (haiku, harnais C9 lecture seule), recette persistée
      sur le nœud (rejouable). Insertion dans `renderSection`
      (`graph-engine.ts`), sans changer le contrat `compileContext`.
- [ ] **Nœuds artefact = panel de review multi-modèles** : un nœud racine
      portant un diff/fichier (cap 150 Ko, voyage par fichier de contexte D5,
      réutilise `collectDiff`) sur lequel lancer un battle → N reviews + juge.
- [ ] **Export/import JSON d'un graphe + coût par nœud** : round-trip d'un
      `GraphDoc` (import OBLIGATOIREMENT via `parseGraphDoc`, pas de secrets
      exportés) ; `meta.cost` par nœud quand dispo (local via `usage`, CLIs via
      la télémétrie OTEL ci-dessous).

### 3.6 Télémétrie & intégrations (seeds `roadmap-seed-v0.9.json`, reporté v0.4)

- [ ] **Suivi tokens/coût par session (OTEL)** : télémétrie OTEL de Claude Code
      + collecteur local ; infra plus lourde, à ré-évaluer. Alimente aussi le
      coût par nœud du graph chat.
- [ ] **Sync GitHub Issues ↔ roadmap partagée** : le modèle `roadmap_items`
      garde la porte ouverte (tags + futur champ `external_url`).

### 3.7 Cartes directives — increments différés (CT6, ex-`PLAN-DIRECTIVES.md`)

- [ ] **Directive `clear_briefing`** : le Deck lance le digest existant
      (`digest.ts` via `utility-inference.ts`, Haiku par défaut) sur des sources
      bon marché, injecte `/clear`, puis saisit le briefing comme premier prompt
      — zéro inférence côté team-lead. Nécessite une variante d'injection
      « paste-safe » (bracketed-paste / écritures fragmentées) pour un briefing
      multi-lignes.
- [ ] **Jauge de contexte par tuile (consultative)** : % de contexte via le
      canal fichier-cache de la statusline (précédent `CLAUDE_PEERS_STATUS_LINE_CACHE`)
      + un seuil qui ARME l'insertion d'une directive à la prochaine frontière
      `done` (jamais un reset en plein milieu de tâche). Vérif empirique des
      champs JSON statusline (`context_window_used/total`) selon la version CC.
- [ ] **peer_id stable à travers un fork-resume (core)** : intégrer le token
      stable `CLAUDE_PEERS_DESK_SESSION` dans le `session_key` claude-peers (ou
      re-poser le peer_id via `set_id` après restart) pour le cas multi-sessions
      même cwd+groupe (option B de la chaîne magic-compact). Chantier core séparé.
- [ ] **`handoff` flag — consommation** : `resolveFeatures().handoff`
      (`file`|`kleos`|`off`) est résolu mais pas encore consommé par le texte du
      playbook ; le câbler quand l'increment plan-file/Kleos (CT6) atterrit
      (le `handoff='file'` ajoute l'instruction de maintien d'un fichier de plan,
      `kleos`/`off` la retirent).

---

## 4. Maintenance / dette technique

- [ ] **M-MNT-1** — la suite broker/serveur (~76 cas `tests/broker-*`,
      `server-*`, `config-*`) **ne tourne jamais en CI** (seul `desktop-*` y
      passe). *Fort ROI, faible coût.* Ajouter un job `bun test` cœur + smoke
      build sur les chemins cœur.
- [ ] **M-MNT-2** — config éparpillée : ~20 `parseInt(process.env…)` hors de
      `config.ts` à rapatrier (env > fichier > défaut, validation centralisée).
- [ ] **M-MNT-3** — fonctions surdimensionnées (`handleRegister` ~150 l,
      `handleRoadmapUpsert` ~170 l) à découper.
- [ ] **Dérive documentaire** (N-MNT-11) : réaligner versions/docs
      (`package.json` vs mentions de version dans la doc).
- [ ] **Duplication & perfs** (N-MNT-1..10) : TOFU secret de groupe ×3, DELETE
      cascade ×2, trames WS ×3, `safeBase`/`normalizeRemoteUrl` dupliqués ;
      index SQLite manquants (`(delivered, sent_at)`), purge des `delivered=1`,
      busy-poll `discoverRealId`/`pollPeerIds` → fs-watch, `statSync` par ligne
      de log. *Détail dans `AUDIT-SECURITE-MAINTENANCE.md` §3.*

---

## Notes d'entretien de ce fichier

- Cocher/retirer un item quand il est livré (et l'ajouter au `CHANGELOG.md`).
- Réf des ids (B*, M-*, N-*, NF-* côté audit ; MB*, TS*, GX*, P*/V*/M* côté
  plans/explorations) : le détail des chaînes d'exploitation et des décisions
  de design est dans l'**historique git** des fichiers supprimés (et le
  narratif livré dans `CHANGELOG.md`).
