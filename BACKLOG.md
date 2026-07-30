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
- [ ] **Nœuds redimensionnables + tirage de fil (vue Graphe, card `a0f2e983` /
      `cdbf310c`)** — couvert par tests purs (`nodeW`/`nodeH`, clamp
      `parseGraphDoc`, `findFreeSpot`) ; gestes réels à valider à l'écran :
  - poignées de redimensionnement visibles au survol sur les bords/coins du
    nœud, curseurs `ns/ew/nwse/nesw-resize`, snap grille, et non-régression
    de l'ancrage des arêtes + du fan-out du moteur à une taille custom ;
  - port de tirage de fil (survol du nœud) : glisser vers le vide ouvre le
    formulaire de création pré-positionné, glisser vers un nœud existant crée
    la dépendance (refus de cycle affiché), sans déclencher le drag du nœud
    sous-jacent.
- [ ] **Battle -- troncature du prompt sur Windows (fix argv, card
      `07dc42c0`)** — root cause confirmée et test de régression bun en place
      (`buildAdapterCommand` ne porte plus de texte opérateur sur argv,
      `session-command`/`session-service` pour le prompt de tuile fraîche).
      Reste l'E2E manuel Windows (PowerShell legacy) :
  - un prompt battle/graphe contenant guillemets doubles, guillemets simples
    et sauts de ligne doit arriver complet au modèle (plus de troncature au
    premier `"` non apparié) ;
  - même vérification pour le prompt initial d'une tuile fraîche (frappé en
    PTY via bracketed-paste) : le texte arrive complet ET la saisie reste
    utilisable ensuite dans la tuile ;
  - vérifier `utility-inference.ts` (question du help « ? » et du wand
    roadmap) et `demo-driver.ts` (scénario REC) avec un texte contenant `"`.
- [ ] **Auto-ack de l'avertissement dev-channels (session 2026-07-24, issue
      anthropics/claude-code#42486)** — logique testée
      (`desktop-startup-ack.test.ts` : détection deux-cues, frontières de chunk,
      ANSI, frame repaint ConPTY sans espaces, ré-armement, non-déclenchement
      sur le dialogue consent MCP). Validation terrain faite par sonde PTY
      (audit 2026-07-28) : libellés exacts confirmés, un seul `\r` valide
      l'option 1, settle 350 ms suffisant. Cause du non-déclenchement observé
      identifiée et corrigée : ConPTY (Windows) retient le premier écran plein
      jusqu'au resize suivant → kicks resize mêmes-dimensions post-spawn dans
      `pty-manager.ts`, et regexes tolérantes aux espaces encodés `\x1b[1C`
      dans `startup-ack.ts`. Reste :
  - Vérifier dans le Deck réel le déclenchement pour TOUS les chemins de spawn
    (create opérateur, superviseur, template, restart/fork-resume) et l'entrée
    journal 📜 — sans aller-retour de vue, désormais.
  - Réajuster si Anthropic modifie le wording ou résout l'issue (flag `--yes`
    / persistance).
- [ ] **Lot Browser REC + scénario démo (session 2026-07-24)** — dispatch,
      escaping, harness et bridge MCP sont testés (`desktop-recording`,
      `desktop-demo-control`, `desktop-browser-drive`, `desktop-demo-driver`) ;
      reste tout le runtime réel :
  - **Enregistrement manuel** : modale + bouton REC + badge rail deux thèmes ;
    `getDisplayMedia` réellement servi par `setDisplayMediaRequestHandler`
    (fenêtre propre) ; **crop du panneau** — l'heuristique `computeCropRect`
    (largeur 1:1, surplus vertical = chrome haut) est à vérifier par OS
    (barre de titre Windows/Linux, notch macOS) ; MP4 réellement muxé par
    l'Electron embarqué (sinon repli WebM attendu) ; qualité/taille à 6 Mbps ;
    arrêt via fermeture de fenêtre en cours d'enregistrement.
  - **Scénario démo** : run réel `claude -p --mcp-config` (bridge
    `demo-browser-mcp.mjs` sous `ELECTRON_RUN_AS_NODE`) sur un vrai site ;
    `sendInputEvent` frappe/clic sur des inputs React contrôlés ; annulation
    par REC stop pendant le run (kill + sauvegarde du partiel) ; timeout 5 min
    et cap 120 étapes en conditions réelles ; pacing du DEMO_SYSTEM_PROMPT à
    ajuster à l'usage (beats trop rapides/lents).
  - **Démo README Kory** : produire le clip final (scope fenêtre entière +
    superviseur orchestrant une équipe) sur un poste avec sessions Claude
    authentifiées, puis l'intégrer au `README.md` (mp4 uploadé via GitHub).
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
  - **Poignée de redimensionnement vertical** (bord haut, curseur
    `ns-resize`, card `14f14ce1`) : tirer vers le haut agrandit la lane,
    hauteur persistée puis clampée correctement à la restauration, poignée
    absente en plein écran et replié.
  - **Bouton « Nettoyer »** (card `204ff198`) : désactivé quand la file est
    vide, confirmation `ConfirmDialog` dont le libellé dit explicitement
    qu'aucun item roadmap n'est supprimé (retour au kanban) et que les têtes
    verrouillées `in_progress` restent affichées.
  - **Éditeur de dépendances dans le modal de détail** (card `93c0f1cc`) :
    titres cliquables, croix de retrait, picker d'ajout filtré (pas soi-même,
    pas done/archived, cycle refusé) ; et **fermeture transitive à
    l'enqueue** : déposer une carte à dépendances dans la lane (ou la
    "envoyer en file" depuis le modal) doit amener toute sa chaîne
    `depends_on` avec elle, dans le bon ordre.
  - **Vagues de queue / parallélisme sans dépendance partagée** (card
    `42edc88b`) : empiler sur une cible sans dépendance ne doit plus jamais
    refuser le geste (dégrade en insertion simple, plus de toast
    `roadmap.wf.stackNone`) ; les cartes de même rang doivent apparaître
    comme une colonne (vague) de la lane, une arête intra-vague ou vers une
    vague antérieure doit s'afficher en violation, et l'auto-dispatch ne doit
    faire partir la vague suivante que si ses dépendances sont satisfaites.
  - **Multi-dispatch d'une vague entière au team-lead** (card `5852c074`) :
    bouton dédié qui envoie tous les ids de la première vague en un seul
    announce, dé-queue groupé, et vérifier que le spawn d'un agent
    supplémentaire décidé par le lead passe bien par une confirmation
    opérateur.
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
    même panneau) puis C (kill+respawn), détaillées dans l'historique git.
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
- [ ] **Étude ACP (Agent Client Protocol) comme socle de la livraison de
      messages inter-agents pour les tuiles non-Claude** (session 2026-07-24).
      Problème : le protocole `claude/channel` (injection push d'un message peer
      dans une session en cours) est **propre à Claude Code**. Codex n'a AUCUN
      équivalent — MCP y est strictement *pull* (`[mcp_servers.*]`, aucun push /
      channel documenté ; le seul push est `notify`, SORTANT, sur
      `agent-turn-complete`). Un peer Codex devrait donc être *instruit*
      d'appeler `check_messages`, ce qui est fragile. **ACP** (Zed, JSON-RPC sur
      stdio, v1 stable, Apache-2.0) standardise la relation hôte↔agent-de-code :
      c'est l'HÔTE qui pilote la boucle de tours, donc le Deck pourrait livrer un
      message du broker comme un tour, en push, pour n'importe quel CLI, SANS
      flag channels. Adaptateurs : Claude (`claude-code-acp`), Gemini CLI
      (`--experimental-acp`), Codex (communautaires — à vérifier). **Trade-off à
      trancher** : une session ACP est *headless* (l'hôte rend la conversation) —
      les tuiles Codex/Gemini cesseraient d'être des xterm affichant la TUI
      native pour devenir des vues de chat rendues par le Deck ; gros chantier
      UX, mais coexiste avec les tuiles PTF Claude (où channels + TUI marchent).
      À cadrer AVANT le code du palier 1 multi-CLI ci-dessus : soit PTY-scraping
      (nudge `/check_messages` tapé dans la tuile, comme les directive cards —
      voie rapide), soit tuiles ACP (voie propre). Vérifier l'état réel des
      adaptateurs ACP Codex et le rendu headless attendu.
- [ ] **A2A (Agent2Agent, Linux Foundation)** : PAS pour les tuiles (conçu pour
      des agents *servicisés* durables et adressables, endpoint HTTP + Agent
      Card ; nos sessions sont éphémères et le broker fait déjà le transport). À
      ne considérer que si le broker doit un jour parler à des agents hébergés
      hors de la machine/LAN.

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

### 3.1 bis Approbations distantes (lots N0→N4, livrés 2026-07-26)

> Le code est couvert par 886 tests, mais **aucun ne touche le réseau** : les
> passerelles sont vérifiées avec un canal factice, et le test « token refusé »
> passe justement *parce que* `getMe` échoue hors ligne. Tout ce qui suit
> demande un vrai poste, un vrai bot et un vrai téléphone.

Validation Telegram :
- [ ] `/newbot` → coller le token → le QR s'affiche → `/start` depuis le
      téléphone → la ligne passe « Connecté · @bot · 1 appairé ».
- [ ] Une demande de permission arrive avec ses deux boutons ; Approuver
      débloque bien la session.
- [ ] Une réponse en **texte libre** (répondre au message) parvient à l'agent.
- [ ] Un message SANS reply-to reçoit l'invite « répondez directement au
      message », et ne règle rien.
- [ ] Un inconnu qui écrit au bot n'a aucun effet et ne crée aucune ligne.

Validation Discord :
- [ ] Portail → token → l'URL d'invitation générée ouvre bien l'ajout au
      serveur privé → code d'appairage en DM → « Connecté ».
- [ ] Boutons Approuver / Rejeter, et la **modale** de texte libre (≤ 4000 c.).
- [ ] Vérifier qu'un « Interactions Endpoint URL » rempli casse la réception
      (le message d'erreur doit être compréhensible).
- [ ] Sans serveur mutuel : l'erreur 50278 doit être lisible dans les logs.

Broker partagé par plusieurs opérateurs (corrigé, à valider avec de vrais bots) :

> Couvert automatiquement pour ntfy (deux opérateurs contre le faux serveur
> local). Ce qui suit exige de vrais bots, donc le terrain.

- [ ] **Deux tokens de bot DIFFÉRENTS, deux opérateurs** (Telegram, puis
      Discord) : les deux passerelles tournent **en même temps**, chacun reçoit
      ses propres demandes. Avant correction, le second enrôlement arrêtait le
      premier.
- [ ] **Le MÊME token de bot pour deux opérateurs** (un seul bot, deux comptes
      OS) : **une seule** passerelle démarre. Sur Telegram, l'ABSENCE de 409
      `Conflict` dans les logs est le signe que le partage a eu lieu — un 409
      signifierait deux consommateurs, donc un partage raté.
- [ ] Même cas, **même compte de messagerie** : les demandes des deux identités
      arrivent dans la MÊME conversation, distinguées par le badge d'origine
      (`bureau · projet` vs `portable · projet`), et **répondre à l'une règle
      bien celle-là**. C'est le cas qui échouait : une réponse sur deux était
      refusée en « déjà traitée » devant une demande parfaitement valide. Non
      couvert automatiquement — pour ntfy une adresse est un topic unique par
      opérateur, la collision n'y est pas constructible.
- [ ] Toujours même token partagé : **déconnecter un opérateur** ne coupe pas
      l'autre (arrêt à compteur de références).

Arbitrage et cloisonnement :
- [ ] Répondre dans le Deck → la notif du téléphone devient « traitée via
      deck » et perd ses boutons ; y répondre ensuite affiche
      « Validation expirée ou invalide / déjà traitée ».
- [ ] Les deux canaux connectés simultanément : la copie du perdant est bien
      réécrite.
- [ ] **Deux comptes OS sur le même PC** : étanchéité réelle des approbations.
- [ ] **Deux PC liés** émettant en même temps : deux notifications distinctes,
      badges d'origine corrects, réponses indépendantes.

Chemins de retour :
- [ ] Voie `channel` : une question ouverte réglée depuis le téléphone arrive
      dans la session comme message peer, **sans aucune frappe**.
- [ ] Voie `pty` : un dialogue de permission est bien refermé par la frappe.
- [ ] Une session `claude` lancée **hors Deck** (terminal simple + MCP) reçoit
      sa réponse — c'est le cas que le lot N2.e débloque.
- [ ] PC éteint > 24 h : la notif expire, la session reste répondable dans le
      Deck.

Validation app Koryphaios / ntfy (lot N5) :

> Ce lot est le seul dont le chemin nominal est couvert automatiquement : un
> faux ntfy tourne sur la boucle locale (`tests/broker-ntfy-channel.test.ts`),
> et l'appairage, le fan-out, la réponse gagnante, la perdante et le
> cloisonnement C-5 y passent pour de vrai. Ce qu'aucun test ne couvre : le
> vrai ntfy.sh, un vrai téléphone, et **tout Android** (pas de SDK ici).

- [ ] `Connect` sur la ligne « Parastatès » avec `https://ntfy.sh` :
      le QR s'affiche, la ligne passe « Connecté · ntfy.sh ».
- [ ] Idem contre un **ntfy auto-hébergé** (le cas qui garde les questions
      chez soi), avec et sans jeton d'accès `tk_…`.
- [ ] Une adresse `http://` publique est refusée avec un message lisible ;
      `http://192.168.x.x:8080` est acceptée.
- [ ] Un jeton d'accès invalide : la connexion échoue et **ne laisse aucune
      ligne configurée** derrière elle.
- [ ] Scan du QR par l'app → la ligne passe « 1 appairé » avec le nom de
      l'appareil, et l'app affiche « Paired ».
- [ ] `Disconnect` puis `Connect` : les topics changent, **l'ancien téléphone
      devient sourd** (c'est le coupe-circuit du téléphone perdu — à vérifier
      pour de bon avec l'ancienne app encore installée).
- [ ] Boutons **Approve / Reject** depuis la notification Android, écran
      verrouillé.
- [ ] **Texte libre** depuis l'app : parvient à l'agent, assaini.
- [ ] Réponse dans le Deck d'abord → le message de clôture arrive et
      **la notification du téléphone disparaît** (ntfy ne sait pas éditer :
      c'est le mécanisme de remplacement, à voir fonctionner).
- [ ] Les trois canaux connectés en même temps : une seule question, trois
      copies, une seule gagne, les deux autres se réécrivent.
- [ ] Quota ntfy.sh (250 messages/jour) : vérifier le comportement en cas de
      dépassement — chaque approbation coûte 1 message + 1 clôture.

Validation Android (aucun test possible ici — pas de SDK) :
- [ ] **Le pinning refuse bien un certificat qui change.** Ouvrir un Deck
      appairé (pin enregistré), puis effacer l'état applicatif du Deck pour
      qu'il régénère un certificat : la connexion doit être **refusée**, pas
      acceptée en silence. C'est le test du write-back TOFU — sans lui, une
      entrée sans empreinte acceptait n'importe quel certificat, indéfiniment.
- [ ] **Un lien hors hôte quitte la WebView compagnon** (ouverture dans le
      navigateur système) et n'emporte pas le credential : taper un lien
      externe depuis le renderer servi par le Deck.
- [ ] **Le scanner QR ouvre réellement la caméra** — la dépendance
      `@capacitor/barcode-scanner` est déclarée mais jamais exercée ici ; sans
      elle, l'app retombait sur un `prompt()` demandant de retaper 250 à 450
      caractères à la main.
- [ ] Le projet **compile** (`cap add android` + copie de `android-src/`).
- [ ] **Écran éteint 8 h** : une approbation arrive toujours. C'est LE test du
      choix `connectedDevice` plutôt que `dataSync` (plafonné à 6 h/24 h) ;
      un échec vers la 6ᵉ heure signerait un mauvais type de service.
- [ ] Même essai sur un OEM agressif (Xiaomi/Samsung), exemption d'optimisation
      batterie accordée puis refusée.
- [ ] Redémarrage du téléphone : le service repart, l'appairage survit.
- [ ] `FLAG_SECURE` : la vignette des applis récentes est bien noire, la
      capture d'écran refusée.
- [ ] Verrou biométrique au retour d'arrière-plan ; refus ⇒ l'app se ferme.
- [ ] **Pinning** : ouvrir un Deck appairé passe sans avertissement ; le même
      Deck après effacement de son état applicatif (nouveau certificat) doit
      être **refusé** et non accepté silencieusement.
- [ ] Multi-hôtes : deux Decks appairés, le sélecteur ouvre le bon ; re-scan
      d'un Deck connu ne crée pas de doublon.
- [ ] **Reprise sans QR — le tour complet, qui traverse la seule frontière non
      testée.** Ouvrir un Deck, **tuer l'app**, la relancer, rouvrir le même
      Deck ⇒ **aucun scan demandé**. C'est le test de la récupération du
      credential côté natif (`CompanionWebView.harvestCredential`, sondage
      après la poignée de main WebSocket) et de son réamorçage
      (`addDocumentStartJavaScript`). En cas d'échec, regarder d'abord si
      `koryphaios.companion.lastcred` est écrit dans les préférences.
- [ ] Inversement : **redémarrer le Deck** ⇒ re-scan bien demandé. Attendu,
      pas un bug : `arm()` invalide tous les credentials, donc fermer le Deck
      coupe réellement la session distante.
- [ ] Appareil sans `DOCUMENT_START_SCRIPT` (WebView ancienne) : le repli
      `onPageStarted` amorce-t-il encore à temps ?
- [ ] Les deux appairages sont bien indépendants **sur l'appareil** : oublier
      tous les Decks n'ôte pas les approbations, et inversement.

Robustesse et exploitation :
- [ ] Broker redémarré : les passerelles repartent seules (`startConfiguredChannels`).
- [ ] Redémarrer un second broker avec le même token Telegram → le 409
      `Conflict` doit apparaître dans les logs comme prévu.
- [ ] `Déconnecter` arrête bien la passerelle et supprime le secret.
- [ ] Rendu de l'écran `Settings > Notifications` en thème clair ET sombre.

### 3.2 Mobile LAN

- [x] **N5 — l'app mobile comme canal d'approbation** : livré. Canal ntfy
      deux-topics côté broker, ligne « Parastatès » active dans
      l'enrôlement, redécoupage compagnon / approbation et multi-hôtes dans
      `mobile-shell/`. Validations terrain ci-dessus (§3.1 bis).
- [x] **MB6 — coquille Android : COMPILE** (2026-07-29, poste Windows avec SDK
      36 + JDK 21). `assembleDebug` produit un APK debug de 55 Mo (35 Mo à un
      `minSdk` plus bas ; AGP stocke le dex non compressé dès `minSdk` >= 28).
      Le Kotlin d'`android-src/` est désormais vérifié par la machine, plus
      seulement relu. Reste à valider : l'exécution sur device (§ ci-dessous).

      Ce que le premier build a effectivement trouvé, à comparer aux
      prédictions qui suivaient :
  - **Un vrai bug source** : `CompanionWebView.kt` déclarait **deux**
    `companion object` dans la même classe (`open()` et `CRED_KEY`). Kotlin
    n'en autorise qu'un. La classe n'aurait jamais pu compiler, dans aucune
    configuration, depuis le jour où elle a été écrite. Corrigé.
  - **Trois lacunes de `BUILDING.md` §5.2**, procédure que personne n'avait
    exécutée de bout en bout : le projet généré est Java-only (plugin Kotlin à
    ajouter, sinon les `.kt` ne sont jamais compilés et le build passe au vert
    avec une app sans aucune capacité native), le `MainActivity.java` généré
    entre en collision avec le `MainActivity.kt` copié, et `minSdk` doit
    monter à 26 (le barcode-scanner tire `ionbarcode-android`, plancher 26 ;
    porté depuis à 29, cf. `BUILDING.md` §5.2). Les trois sont documentées.

      Prédictions d'origine, conservées pour mémoire :
  - **Dépendances Gradle** : `androidx.biometric` et `androidx.webkit` ne
    viennent pas avec Capacitor et sont à ajouter (documentées dans
    `android-src/README.md`). Omission trouvée en re-vérifiant, corrigée.
  - **Signatures d'API** : les versions d'`androidx.*` bougent ; un
    `WebViewFeature`/`BiometricPrompt` renommé se verra à la compilation.
  - ~~**`shouldOverrideUrlLoading(WebView, WebResourceRequest)` est API 24+**
    alors que le plancher Capacitor est 22 : sur 22–23 c'est la garde
    d'origine de `onPageStarted` qui porte seule la protection.~~ **Résolu**
    par le passage à Capacitor 8 : le plancher est désormais 29, donc la
    garde forte s'applique sur tout le parc supporté et `onPageStarted` n'est
    plus seul nulle part. Le trou n'était pas colmaté, il était hors de
    portée.
  - **Le scan QR natif n'a jamais tourné.** `platform.ts` cherchait le plugin
    sous `BarcodeScanner` avec une méthode `scan()` ; il s'enregistre sous
    `CapacitorBarcodeScanner` et expose `scanBarcode(options)`. Le lookup
    renvoyait `undefined`, donc les DEUX appairages retombaient sur le
    `prompt()` prévu pour le navigateur — sans erreur, sur device comme
    ailleurs. Corrigé, mais la correction est du même niveau de preuve que le
    reste de cette section : relue, pas exécutée. Premier test terrain à
    faire, avec le `hint` (cf. le commentaire de `BARCODE_HINT_ALL`).
  - **Le paquet `io.koryphaios.parastates`** doit correspondre à l'`appId` du
    `capacitor.config.ts` dans le projet généré.
- [ ] **Icône et identité de l'app** : le service utilise encore les drawables
      système (`stat_sys_warning`, `stat_notify_sync`). Un glyphe grec au
      standard `DESIGN.md` §5 est à dessiner, en densités Android.
- [ ] **Distribution** : aucun listing store. Décider APK signé + F-Droid, ou
      rester « build depuis les sources ».
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

### 3.7 Cartes directives — increments différés (CT6)

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

### 3.8 Sandbox Docker — validation terrain (implémentation terminée)

Le mode sandbox est **entièrement implémenté** (toggle et mode de travail par
projet, conteneur persistant `kory-sbx-<hash>`, volume d'auth partagé + modale
de login bloquante, vue rail Docker, wrapping `docker exec`, projection de la
config opérateur, `deck_sandbox_exec`, resume côté conteneur, mode copie
éphémère). Narratif de conception : les deux entrées « Sandbox mode » du
`CHANGELOG.md`. Doc opérateur : `desktop/docs/sandbox.md`.

> **Backend distant (SSH / LXC Proxmox) : ABANDONNÉ** (décision opérateur,
> 2026-07-25). Docker couvre le besoin ; la piste Proxmox était une analogie
> de départ, pas une exigence. Ne pas la rouvrir sans nouveau besoin explicite.

Reste **uniquement de la validation sur poste réel** — rien n'est testable en
CI (pas de moteur de conteneurs, pas d'affichage). À dérouler sur Windows +
Docker Desktop en priorité, c'est la cible principale :

**Mise en route**
- [ ] Détection moteur : Docker Desktop présent / arrêté / absent → les trois
      libellés de la carte Mode sont-ils justes (et le lien d'installation
      visible quand rien n'est détecté) ?
- [ ] **Build de l'image** depuis la vue (`Construire l'image`) : le log
      défile dans le terminal de la modale, la fin met le badge à « présente »,
      fermer en cours de build ne laisse pas d'image à moitié construite.
- [ ] Image absente → un spawn est refusé avec le message explicite (et pas un
      échec silencieux de conteneur).

**Authentification (le point le plus sensible)**
- [ ] Premier spawn sandbox → la **modale bloquante** s'ouvre, *Suivant* lance
      le terminal, le flow OAuth du CLI aboutit (URL ouverte dans le navigateur
      du poste, code recollé), la modale se ferme seule et le toast apparaît.
- [ ] **Aucune invitation de login n'apparaît dans les tuiles d'agent** — c'est
      toute la raison d'être de la garde.
- [ ] Deuxième projet (autre fenêtre Deck) : démarre **déjà authentifié**
      (volume partagé), sans repasser par la modale.
- [ ] `Ré-authentifier` relance la cinématique à tout moment ; `Déconnecter`
      est refusé tant qu'un conteneur sandbox tourne, accepté sinon.
- [ ] Simuler l'expiration (déconnecter puis spawner) → même cinématique.

**Cycle de vie**
- [ ] Fermer l'app → le conteneur est **arrêté, pas supprimé** (`docker ps -a`).
- [ ] Rouvrir le lendemain → `docker start` et les sessions repartent avec ce
      qui avait été installé à la main dedans.
- [ ] Deux projets en parallèle → deux conteneurs, aucun conflit de nom/port.
- [ ] `Reconstruire` recrée depuis l'image (état manuel perdu, badge de dérive
      qui disparaît) ; `Supprimer` demande confirmation et ne touche ni au
      volume d'auth ni au dossier projet.
- [ ] Toutes les actions sur le conteneur du projet courant sont refusées tant
      qu'une session tourne (message clair, pas un échec muet).

**Intégration**
- [ ] **Pont broker** : badge « joignable » sur Docker Desktop ; messagerie
      entre pairs, inbox opérateur et roadmap fonctionnent depuis une session
      sandboxée. Sur moteur Linux natif, vérifier que la consigne
      `CLAUDE_PEERS_BIND_HOST` affichée suffit à passer au vert.
- [ ] **Resume** : fermer l'app avec des sessions actives, rouvrir, restaurer
      l'espace → les conversations reprennent (et survivent à un
      `Reconstruire`, les transcripts étant dans le volume).
- [ ] **Mode Web** : dev-server lancé par un agent sandboxé sur un port publié
      → visible dans la vue Browser en `http://localhost:<port>`.
- [ ] **Compagnon** : appairer un téléphone pendant qu'une session sandboxée
      tourne → tuiles, diff et git restent corrects ; les canaux `sandbox:*`
      de confiance sont bien refusés côté distant.
- [ ] **`deck_sandbox_exec`** : demander au superviseur « installe X dans le
      sandbox » → exécution dans le conteneur, sortie remontée, entrée journal.

**Projection de la config opérateur**
- [ ] Le `CLAUDE.md` global, les agents et les skills sont bien actifs dans une
      session sandboxée (les vérifier depuis l'agent lui-même).
- [ ] Les hooks Windows sont listés comme non exécutables, et un équivalent
      déposé dans `~/.claude/sandbox-overrides/` est bien pris à la place.
- [ ] Vérifier qu'aucun `.credentials.json` hôte n'a été copié dans le
      conteneur (`docker exec <ctn> ls -la ~/.claude`).

**Mode copie éphémère**
- [ ] Bascule `Copie éphémère` → conteneur recréé, clone présent, sessions et
      `git worktree add` atterrissent dans le clone (pas dans le vrai dépôt).
- [ ] Les globs gitignorés configurés (ex. `PLAN-*.md`) arrivent dans le clone ;
      un glob sans correspondance est bien signalé.
- [ ] **Aucun secret ne voyage** : poser un `.env` et un `node_modules` dans le
      projet, demander `**` en glob, vérifier qu'ils ne sont PAS dans le clone.
- [ ] Le vrai dossier projet reste intact après une session qui écrit beaucoup.
- [ ] Sortie du travail : `git push origin <branche>` depuis une session
      sandboxée ramène bien la branche dans le dépôt réel.
- [ ] `Réinitialiser le clone` repart d'un clone propre.

**Performance / confort**
- [ ] Mesurer un `git status` et un build dans un projet monté depuis `C:\…`
      vs le même projet placé dans le système de fichiers WSL2 — documenter
      l'écart dans `desktop/docs/sandbox.md` si l'écart est notable.
- [ ] Matrice moteurs : Podman Desktop, et si possible OrbStack / Colima
      (résolution de `host.docker.internal`, `--add-host`, `docker cp`).

**Résiduels connus (à trancher à l'usage, pas des bugs)**
- [ ] Changer la liste des ports publiés impose un « Reconstruire » (limite
      moteur). Voir si un reverse-proxy hôte ou `--network=host` (Linux)
      offrirait une UX moins brutale.
- [ ] `detectHostOnlyHooks` ne scanne que les champs `command` de
      `settings.json` ; les permissions/env qui référencent des chemins hôte
      ne sont pas détectées. À élargir si l'usage le montre.
- [ ] `projectionSignature` sature son budget de 5000 entrées dans `plugins/`
      (~12k fichiers chez l'opérateur) : un changement profond dans plugins/
      peut ne pas déclencher de re-projection (contournement : Reconstruire).

**Lot personnalisation & parité de config (2026-07-27) — implémenté, à tester
sur poste réel** (roadmap broker `f29b1917` / `50ac8683` / `0da2bf11` +
retours opérateur ; conception : décisions « pas de docker-compose éditable »
et « pas de traduction auto Windows -> Linux des hooks », voir handoffs Kleos
#232/#233) :
- [ ] **Générateur d'overlay** (« Générer la config sandbox », carte
      projection) : overlay écrit sans les hooks host-only, toast avec le
      compte, confirm avant écrasement d'un overlay existant, warnings de
      hooks disparus au spawn suivant.
- [ ] **Image personnalisée** : éditer le fragment Dockerfile, Construire
      (tag `koryphaios-sandbox-custom`, FROM refusé dans le fragment),
      « Utiliser pour ce projet », puis retour à l'image de base via le champ
      image.
- [ ] **Encart limites d'isolation** (carte projection) + section
      « Isolation limits » de `desktop/docs/sandbox.md` : relire, valider le
      wording.
- [ ] **Warm-up hors spawn** : au démarrage de l'app (sandbox actif) et après
      un build d'image, le conteneur est créé/projeté en arrière-plan — le
      1er agent doit arriver en ~2 s ; si un `ensure()` dépasse 1,5 s, une
      ligne `sandbox: ensure took …` détaille les étapes dans le journal.
- [ ] **Purge/chown root** : plus aucun `rm: Permission denied` dans la
      console dev à la projection ; `plugins/installed_plugins.json` du
      conteneur appartient à kory (`docker exec <ctn> ls -la ~/.claude/plugins`).
- [ ] **Carte « Conteneur de ce projet »** (sous la carte Mode) :
      démarrer/arrêter sans scroller, « Préparer le conteneur » quand il
      n'existe pas.
- [ ] **Indicateurs** : pithos du rail en bleu quand le conteneur du projet
      tourne (événement `sandbox:changed` désormais réellement émis) ;
      pastille sandbox 3 états dans la barre d'actions de la vue Agents
      (gris -> vue Docker, ambre -> démarrage 1 clic, bleu -> vue Docker).
- [ ] **Login onboarding complet** : la modale de connexion ne se ferme plus
      à l'apparition des credentials mais à la fin de l'onboarding
      (`hasCompletedOnboarding`) ; vérifier qu'un nouvel agent n'affiche plus
      « Select login method » après un login mené au bout.

**Encore à implémenter (nice-to-have v2, roadmap broker `4085b661` — ne pas
démarrer sans besoin confirmé)**
- [ ] **Sidecars** (DB, redis…) déclarés dans la config GLOBALE de l'app,
      créés/arrêtés avec le conteneur sandbox et attachés à un réseau docker
      dédié. Contraintes actées : jamais depuis le repo cloné (hostile input
      #1), cycle de vie via CLI docker direct (pas de compose), re-validation
      main-side des noms/images/ports, pas de host network. Prérequis
      conseillé : l'image personnalisée couvre déjà une partie du besoin.

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
