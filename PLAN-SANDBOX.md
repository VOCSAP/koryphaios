# PLAN-SANDBOX — Mode sandbox Docker pour les sessions du Deck

Statut : **M1 en cours** (branche `claude/sandbox-sessions-docker-b3vo47`).
Chantier id : `SBX1`…`SBX9` (référencés dans les commentaires de code).

## 1. Intention

Offrir un mode « sandbox » activable par projet : les sessions Claude Code ne
s'exécutent plus directement sur le poste mais dans un conteneur Docker/Podman
dédié au projet, créé à la demande, **persistant** (arrêté à la fermeture du
Deck, jamais détruit automatiquement), avec le répertoire projet monté dedans.
Le superviseur reste sur le poste et pilote l'environnement (installer une
dépendance, etc.). Analogie assumée : le cycle de vie d'un LXC Proxmox
(créer → installer → travailler → jeter *volontairement*), fourni en local par
le moteur de conteneurs.

Ce que le sandbox protège : le reste du poste (credentials, autres
répertoires, système). Ce qu'il ne protège pas : le répertoire projet monté
(c'est voulu — le travail doit atterrir sur le poste ; le mode « copie
éphémère » M3 couvre le cas où même le projet doit être isolé).

## 2. Modèle d'objets (rappel Docker)

| Objet | Rôle ici | Cycle de vie |
| --- | --- | --- |
| Image | modèle outillé (git, bun, node, Claude CLI, user `kory`) | construite une fois (`desktop/resources/sandbox/Dockerfile`), jamais « démarrée » |
| Conteneur `kory-sbx-<hash12>` | l'environnement de travail d'UN projet | créé au premier besoin, `stop` à la fermeture du Deck, `rm` **uniquement** sur action opérateur |
| Volume nommé `kory-claude-auth` | `~/.claude` du conteneur : credentials + état CLI | global, partagé par tous les conteneurs, survit à tout `rm` |
| Bind mount `<projectDir>` → `/work` | le code | suit le conteneur |
| Bind mount `<stateDir>/sandbox-run` → `/kory-run` | scripts de lancement générés par le Deck (voir §5) | interne, best-effort |

- **Nommage déterministe** : `kory-sbx-` + sha256(projectDir normalisé)[0..12].
  Sert aussi de découverte (« un conteneur existe-t-il pour ce projet ? ») et
  permet N fenêtres Deck sur N repos en parallèle sans collision. Labels
  `kory.sandbox=1` + `kory.project=<dir>` pour la vue de gestion.
- Le conteneur tourne sur `sleep infinity` ; chaque session est un
  `docker exec` dedans. Les worktrees vivent sous `<projectDir>/.worktrees`
  (`worktree-service.ts:59`) donc dans le mount — mapping de chemin trivial
  hôte → `/work/…`.

## 3. Authentification (volume, pas conteneur)

Décision : l'authentification est portée par le **volume** `kory-claude-auth`,
monté sur `~/.claude` dans chaque conteneur de travail. Il n'y a pas de
« conteneur d'authentification » persistant — la vue rail présente le volume
comme une carte « Authentification » avec son état. Conséquences :

- Un seul login pour tous les projets ; survit au `rm` du conteneur.
- La contrainte « on ne peut pas arrêter le conteneur d'auth si un conteneur
  de travail tourne » se traduit par : **le volume d'auth ne peut être purgé
  (déconnexion) tant qu'un conteneur de travail est démarré** — garde
  implémentée côté main.

### Cinématique premier démarrage (SBX3)

1. L'opérateur active le mode sandbox (bouton) ou demande au superviseur.
2. Le Deck `ensure()` le conteneur du projet (create + start si besoin), puis
   sonde l'auth : `docker exec … test -s ~/.claude/.credentials.json`.
3. Non connecté → **modale bloquante** « Première utilisation : connexion
   requise » ; *Suivant* ouvre un terminal PTY (xterm, patron `DockTerminal`)
   exécutant `docker exec -it <ctn> claude` — le flow de login standard du CLI
   (URL OAuth ouverte dans le navigateur du poste, code recollé).
4. Le Deck sonde le fichier de credentials toutes les 2 s ; dès qu'il existe,
   la modale se ferme, le PTY est tué, toast **succès**.
5. **Tant que l'auth n'est pas faite, aucun agent ne spawne** : garde dure
   dans `SessionService.create()` (erreur explicite) + garde renderer qui
   rouvre la modale. Sans cela, chaque tile afficherait sa propre invitation
   de login — pénible et confus.
6. Déconnexion détectée plus tard (tokens expirés après un long arrêt) : le
   spawn échoue sur la même garde → même cinématique, relancée.
7. Vue rail : bouton **Ré-authentifier** disponible à tout moment (relance la
   modale sur le conteneur du projet courant).

## 4. Toggle + gardes (SBX2)

- Réglage **par projet** (fichier `sandbox.json` sous l'app-state, clé
  `computeDeckProjectKey(projectDir)` — patron `launch-approvals.json`, PAS un
  champ AppConfig global qui fuiterait entre projets, PAS un fichier du repo :
  activer le sandbox est une décision de confiance opérateur, règle
  « entrées hostiles » n°1 de CLAUDE.md).
- Le flip est **refusé si `service.hasLiveSessions()`** (le prédicat existant,
  `session-service.ts:261`) — main-side, pas seulement UI. Le renderer affiche
  un `ConfirmDialog` avant tout flip accepté (texte explicite sur ce que le
  mode couvre). Le mode ne s'applique qu'aux **nouveaux** spawns (on ne
  téléporte pas un PTY vivant).
- Le **superviseur est exclu du sandbox** (`def.supervisor === true`) : c'est
  le pilote côté poste (choix produit §1) et son harnais MCP pointe sur le
  binaire Electron hôte + un port loopback (`supervisor.ts`) qui n'existent
  pas dans le conteneur.

## 5. Spawn d'une session sandboxée (SBX1)

Point d'insertion unique : `SessionService.startPty` (`session-service.ts:632`)
— la commande finale est construite là, le PTY hôte n'y voit que du feu
(xterm, détecteurs thinking/quota/attention inchangés).

- `SessionService` gagne un injecté `getSandbox()` (miroir de `getScopeEnv`).
- Quand le sandbox est actif : le Deck écrit un **script de lancement**
  `<stateDir>/sandbox-run/cmd-<sessionId>.sh` (exports d'env + `cd` + `exec
  <commande claude>`) et la commande PTY devient
  `docker exec -it <ctn> bash /kory-run/cmd-<sessionId>.sh`.
  Motif : le script évite tout double-échappement PowerShell→bash (la
  commande passe par `powershell -Command` sous Windows, `shell-command.ts`),
  et rend le wrapping **testable sous bun** (`sandbox-command.ts`, pur).
- Mapping d'env dans le script (pas de `-e`) :
  - `CLAUDE_PEERS_BROKER_URL=http://host.docker.internal:<port>` — le
    `server.ts` du conteneur rejoint le broker de l'HÔTE (mode HTTP v0.3,
    `shared/config.ts:154`) au lieu d'en auto-spawner un isolé ; il REFUSE
    d'ailleurs l'auto-spawn sur URL non-loopback (`server.ts:152`), ce qui
    transforme une mauvaise config en erreur franche plutôt qu'en broker
    fantôme. Docker Desktop (Win/mac) fait suivre `host.docker.internal`
    jusqu'au loopback hôte ; moteur Linux natif : `--add-host
    host.docker.internal:host-gateway` est passé au create, mais le broker
    doit alors écouter au-delà du loopback (`CLAUDE_PEERS_BIND_HOST`) —
    documenté, M2 pour l'automatisation + token.
  - Scope/groupe : `CLAUDE_PEERS_FORCE_GROUP_NAME` + `CLAUDE_PEERS_FORCE_GROUP`
    (valeur inline) ; la variante `…_FORCE_GROUP_FILE` (fichier temp hôte
    chmod 600, `scope.ts`) est **retirée** — chemin hôte inexistant côté
    conteneur.
  - `CLAUDE_DECK_DESIGN_URL` réécrit `127.0.0.1` → `host.docker.internal`
    (même logique broker) ; `CLAUDE_PEERS_DESK_SESSION` inchangé.
- `cwd` : hôte → conteneur par préfixe (`<projectDir>` → `/work`). Le `cwd`
  node-pty reste le chemin hôte (sans incidence).

## 6. Vue rail « Docker » (SBX4)

Nouvelle vue `DeckView: 'sandbox'` (label rail : **Docker**), chaîne complète
`add-deck-view` (union → glyphe → mobile-views `desktop-only` → NavRail →
App.tsx → i18n ×3 → interface.md). Glyphe : **pithos** (la jarre de Diogène —
un conteneur qu'on habite), stroke-only 24-grid, registre `GLYPHS`.

Contenu :
1. **Carte mode** (projet courant) : toggle on/off (ConfirmDialog + garde
   sessions actives), état du moteur (docker/podman détecté, version, ou
   « non installé » + lien d'installation), état du conteneur du projet.
2. **Carte authentification** (le volume) : connecté / non connecté /
   indéterminé, bouton **Ré-authentifier** (toujours actif), purge des
   credentials refusée si un conteneur de travail est démarré.
3. **Liste des conteneurs `kory-sbx-*`** (tous projets) : projet (label),
   état, image, taille, actions **Démarrer / Arrêter / Supprimer /
   Reconstruire** (rm + create, l'anti-dérive). Gardes : pas de stop/rm du
   conteneur du projet courant avec des sessions actives ; rm = ConfirmDialog
   danger. Les noms passés aux actions sont re-validés main-side contre
   `/^kory-sbx-[0-9a-f]{12}$/` + label `kory.sandbox` (jamais une string
   arbitraire vers le CLI docker — entrée hostile n°3).
- Fermeture de l'app : `docker stop` best-effort des conteneurs du projet
  (jamais `rm`).

## 7. Compagnon, mode Web, superviseur

- **Compagnon : transparent.** Le téléphone parle au main process hôte par
  WS (`companion-server.ts`) ; PTY, git, diff, explorer s'exécutent côté hôte
  sur le répertoire monté. Aucune conf particulière. Seule décision : les
  nouveaux canaux `sandbox:*` reçoivent leurs tiers `CHANNEL_TIERS` et les
  actions de confiance (`set-enabled`, actions conteneur, auth) rejoignent
  `REMOTE_BLOCKED_CHANNELS` — un téléphone appairé ne bascule pas le mode.
- **Mode Web (browser embarqué) : un seul besoin, publier les ports.** La
  webview hôte navigue librement (`BrowserView.tsx:389`, aucun traitement
  spécial de localhost) ; un dev-server dans le conteneur est joignable en
  `http://localhost:<port>` dès lors que le port est publié au **create**
  (`-p 127.0.0.1:p:p`). Liste par projet dans `sandbox.json` (défaut 3000,
  5173, 8080) ; changement de liste ⇒ action Reconstruire (limitation Docker :
  pas de publication à chaud). L'URL persistée `config.browserUrl` continue de
  marcher telle quelle.
- **Superviseur pilote de l'environnement** : M2 ajoute l'outil MCP
  `deck_sandbox_exec` (déclaration `deck-control-mcp.ts`, case `dispatch`,
  capacité `DeckControlDeps` — patron §8 du rapport deck-control) pour
  « ajoute cette dépendance à l'instance » ⇒ `docker exec` journalisé,
  restreint au conteneur du projet courant.

## 8. Sécurité (mapping « quatre entrées hostiles »)

1. Valeur du repo cloné : le mode sandbox, l'image et les ports viennent
   exclusivement du store opérateur (app-state) — rien du repo. Si un jour un
   template/projet veut proposer une image : gate `launch-approval` clé
   `<projectKey>::sandbox`.
2. Frontière broker : inchangée (le conteneur est un client HTTP comme un
   autre ; token broker à généraliser en M2).
3. Args IPC → chemin/cible : noms de conteneurs re-validés par regex + label ;
   aucun `dir` nouveau n'est accepté (le service ne prend que des noms).
4. Sortie d'agent → commande : `deck_sandbox_exec` (M2) validera commande et
   conteneur cible côté Deck ; jamais de collage de string du superviseur
   dans un shell hôte.

Cas particulier : **ne jamais monter le `~/.claude` du poste** dans le
conteneur (un hook malveillant écrit par un agent s'exécuterait plus tard côté
hôte). La config opérateur est **projetée par copie** (M2) dans le volume,
credentials préservés ; jetable avec le conteneur.

## 9. Jalons

### M1 — cette branche (SBX1–SBX5)
- [x] Plan (ce fichier).
- [ ] `sandbox-command.ts` (pur, testé bun) : nommage, mapping chemins/env,
  builders d'args docker, script de lancement, wrap exec.
- [ ] `sandbox-service.ts` (exec DI) : détection moteur, ensure/start/stop/
  rm/rebuild/list, sonde auth, stop à la fermeture.
- [ ] `sandbox-store.ts` (pur) : `{ [projectKey]: { enabled, ports } }`.
- [ ] Intégration `SessionService` (getSandbox, garde create, wrap startPty,
  superviseur exclu) + garde toggle main-side.
- [ ] IPC `sandbox:*` + DeckApi + manifest compagnon + preload.
- [ ] Renderer : vue Docker, modale d'auth (PTY), ConfirmDialogs, toasts,
  glyphe pithos, i18n ×3.
- [ ] `desktop/resources/sandbox/Dockerfile` + `desktop/docs/sandbox.md` +
  interface.md + DESKTOP.md + BACKLOG (reliquat M2/M3).

### M2 — confort & intégration profonde
- Projection de la config Claude opérateur (CLAUDE.md global, agents, skills,
  hooks avec overlay Linux `sandbox-overrides/`) dans le volume à chaque
  démarrage, credentials préservés.
- `deck_sandbox_exec` (superviseur) + journalisation.
- Broker : génération d'un `broker_token` + `CLAUDE_PEERS_BIND_HOST` piloté
  pour le moteur Linux natif ; badge de dérive d'image (« créé il y a N
  semaines ») dans la vue.
- Podman : détection déjà prévue M1, tests réels + doc.
- Auto-build de l'image depuis le Dockerfile embarqué (PTY de build dans la
  vue Docker).

### M3 — mode « copie éphémère »
- Clone local côté hôte (`git clone --local` → temp dir) + allowlist de
  globs gitignorés à copier (`sandbox.copyIgnored`, config opérateur — jamais
  `.env`/node_modules par défaut) ; le temp dir est ce qui est monté.
- Sorties : push branche, patch, cherry-pick vers le repo réel ; DiffPanel
  continue de lire le temp dir hôte.
- Backend distant (hôte SSH / LXC Proxmox via API) sur le même wrapper de
  commande, modèle clone/push.

## 10. Questions ouvertes / à valider sur poste réel
- Perf bind mount `C:\…` → conteneur (9p/virtiofs WSL2) sur gros repos ;
  recommandation `\\wsl$` à documenter après mesure.
- Nom exact du fichier credentials selon version CLI (`.credentials.json`
  aujourd'hui) — la sonde teste le chemin, à revalider à chaque bump CLI.
- `host.docker.internal` → loopback hôte : OK Docker Desktop Win/mac ;
  matrice Podman/OrbStack/Colima à établir.
- Publication de ports à chaud impossible : UX « Reconstruire pour appliquer
  les ports » à confirmer à l'usage.
