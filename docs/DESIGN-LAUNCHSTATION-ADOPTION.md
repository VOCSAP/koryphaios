# Brief — ce que Kory reprend de Launch Station (démarrer le projet courant)

Analyse de [JakeMawson/launchstation](https://github.com/JakeMawson/launchstation)
(README lu le 2026-09-14, app macOS Swift, aucune dépendance tierce) et plan
d'adoption en six chantiers. Même format que `DESIGN-HERDR-ADOPTION.md` :
chaque chantier cite le mécanisme source et les fichiers Kory cibles, pour
pouvoir démarrer sans refaire l'analyse. Base : branche `experimental`
(`79e3f92`). Ce brief est un PLAN, à réviser sur le poste avant tout code ;
rien de ce qu'il décrit n'existe encore dans le dépôt.

> Convention CLAUDE.md : les ids `LS1`…`LS6` servent à ce brief et aux messages
> de commit/cartes roadmap. Ne pas les recopier en tag dans des commentaires de
> code.

## 0. Intention de départ (opérateur, 2026-09-14)

Kory embarque un navigateur (`🌐 Browser`, `BrowserView.tsx`). L'opérateur
veut un bouton dans l'UI qui **démarre le projet dans lequel Kory est lancé**
(typiquement : un serveur de dev qui sert une page web) et l'affiche dans ce
navigateur, comme Launch Station démarre ses launchers et ouvre leur URL.

Trois attentes explicites :

1. Savoir COMMENT lancer l'app du projet, et stocker cette information sur le
   poste : dans le repo ou dans le profil utilisateur (`%APPDATA%`), au choix
   le plus pertinent. **Décision : fichier local dans le repo** (section 3).
2. Une **aide à la construction** de ce fichier : l'opérateur peut l'écrire à
   la main, ou un agent le génère. Un **skill dans le playbook de Kory**
   (le plugin `desktop/deck-plugin/`, chargé dans chaque tuile via
   `--plugin-dir` et projeté dans les sandboxes) explicite le format attendu
   pour qu'un agent le suive.
3. Le **port est dynamique**, comme les endpoints loopback du Deck
   (`demo-control.ts`, `deck-control.ts` : `listen(0)`), pour que deux Decks
   Kory lancés en parallèle sur le même projet ne se bloquent pas.

## 1. Ce qu'est Launch Station, en une page

Launch Station n'est **pas un détecteur** : rien n'y est deviné. L'opérateur
déclare chaque commande une fois, l'outil la catalogue, l'exécute et possède
son cycle de vie. Quatre pièces :

| Pièce | Rôle (README) |
|---|---|
| Démon LaunchAgent `com.jakemawson.launchstation.service` | « sole database writer, API server, manifest generator, and lifecycle owner » ; API HTTP loopback, bearer token aléatoire (mode 0600) |
| CLI `~/bin/launch` + app SwiftUI | ne touchent jamais la base ; elles appellent l'API du démon |
| SQLite `~/Library/Application Support/Launch Station/launcher.sqlite3` | « durable source of truth », côté poste, jamais dans le repo |
| Miroir `<project>/launch_details.md` | projection en lecture seule (mode 0444, schéma `com.launchstation/launch-details-v1`, hash SHA-256) « intended for agents and humans to read when they need to discover how that project is started » |

Mécanismes à connaître :

- **Projet** = un répertoire initialisé (`launch init . --project-name X`),
  idempotent ; depuis un sous-dossier, « project resolution chooses the
  nearest initialized ancestor ».
- **Launcher** = nom global unique + projet + description + tags + une liste
  ORDONNÉE d'actions, dont « exactly one primary action; runtime arguments
  are passed only to that action ». Cinq types d'action : `process`
  (exécutable + tableau d'arguments, « safest for exact argument
  boundaries »), `shell` (`/bin/zsh -lc`), `app`, `url`, `ios`.
- **Ports gérés** : `--port auto` demande un port libre à un outil tiers de
  l'auteur (`codex-port`) ; le runner mappe `CODEX_PORT`/`CODEX_HOST` sur les
  variables `PORT`/`HOST` (noms configurables par `--port-env`/`--host-env`) et
  substitue `${PORT}`/`${HOST}` (aussi `{port}` et `{{port}}`) dans la
  commande, l'URL d'ouverture et l'URL de santé.
- **Readiness** : « a readiness URL succeeds on HTTP 200–399 »,
  `--ready-timeout` 1 à 600 s (défaut 30). Une action requise qui ne devient
  pas prête ferme celles déjà démarrées.
- **Environnement** : « stable baseline PATH » (`~/bin`, dossiers système,
  Homebrew), PAS l'environnement du démon ; variables ajoutées explicitement
  (`--env K=V`, `--inherit-env NAME`) ; `CODEX_*` réservés et refusés.
- **Cycle de vie** : « at most one active primary session plus any number of
  explicitly requested additional sessions » ; chaque processus dans sa propre
  session/groupe, identité = PID + date de naissance du PID ; arrêt
  `SIGINT` → `SIGTERM` → `SIGKILL` sur ce groupe vérifié, « never process
  name or port alone ».
- **Launchers composés** (question de l'opérateur) : un launcher dont
  plusieurs actions s'enchaînent, par exemple base de données (ordre 0), API
  (ordre 10, port auto), front Vite (ordre 20, port auto). « Actions run in
  ascending order and stop in reverse order. Earlier successful actions expose
  their resolved endpoint values to later actions » via
  `LAUNCH_STATION_ACTION_<TOKEN>_HOST|PORT|URL` : le front reçoit
  `--env 'VITE_API_URL=${LAUNCH_STATION_ACTION_API_URL}'`. Une action
  `--optional` peut échouer sans faire tomber la session. C'est le mécanisme
  « stack complète en un clic ». **Hors périmètre v1** ici (section 5) : le
  format de la section 3 est conçu pour l'accueillir plus tard sans casser
  la v1 (tableau d'actions ordonnées).

## 2. Ce que Kory a déjà (à réutiliser, pas à réinventer)

| Besoin | Existant | Fichier |
|---|---|---|
| Config projet lue depuis le repo | `.claude/claude-peers/config.json` (`launchCommand`, `presets`, `worktreeInit`, `features`), fusion global → local | `desktop/src/main/launch-config.ts` |
| Gate d'approbation d'une commande issue d'un repo cloné | sha256 par `project_key`, dialogue une fois, refus = repli ; déjà appliqué à `launchCommand`, `worktreeInit` (clé suffixée `::worktreeInit`) et aux templates locaux | `desktop/src/main/launch-approval.ts`, `index.ts` (~l. 3002 et 3035), fichier PROJECT `launch-approvals.json` classé dans `tests/desktop-state-scope.test.ts` |
| Port dynamique loopback | `server.listen(opts.port ?? 0, '127.0.0.1', …)` | `demo-control.ts:157`, `deck-control.ts:885`, `companion-server.ts:211` |
| Navigateur embarqué + barre d'outils | `browser-toolbar` (JSX ~l. 1520), URL par défaut `http://localhost:3000` (`initialUrl`), mémorisée dans `config.browserUrl` (`store.ts:77`), navigation via `wv.loadURL(url)` | `desktop/src/renderer/src/components/BrowserView.tsx` |
| Chaîne main ↔ renderer (IPC, tiers, registre companion) | skill `add-deck-view` | `ipc.ts`, `api-registry.ts`, `shared/companion.ts`, `preload` |
| Skills livrés aux tuiles | `desktop/deck-plugin/skills/roadmap-card/SKILL.md` (frontmatter `name`/`description`, contrat de champs) ; le `name` du plugin est load-bearing pour les agents forkés | `desktop/deck-plugin/.claude-plugin/plugin.json`, `tests/desktop-deck-plugin-agent-refs.test.ts` |
| Erreurs / journal | `reportError()` main, `window.api.reportError` renderer, `journal.add('session', …)` | skill `error-reporting` |
| Sandbox | item BACKLOG « Mode Web : dev-server lancé par un agent sandboxé sur un port publié → visible dans la vue Browser » | `desktop/docs/sandbox.md`, `BACKLOG.md` |

**Collision de nom à éviter.** `launchCommand` désigne déjà, dans tout le
code, la commande qui lance le CLI de l'AGENT dans un PTY. Le nouveau concept
s'appelle **serve** partout (fichier, service, canaux IPC, skill) : « un nom
par concept » (CLAUDE.md, règle Lot/Workflow/Vague).

## 3. Choix arrêtés et pistes écartées

Arrêtés (session 2026-09-14, opérateur) :

1. **Déclaration dans le repo**, fichier dédié
   `<project>/.claude/claude-peers/serve.json` (pas un champ de `config.json`,
   pour que le hash d'approbation ne couvre que cette commande et que le skill
   puisse écrire un fichier entier sans toucher au reste). Partageable,
   lisible par les agents, versionnable. Contrairement à Launch Station, pas
   de SQLite : sa base existe parce qu'un démon partage l'état entre une app
   et une CLI, ce que Kory n'a pas ; le précédent local est un JSON par
   `project_key` (`graph-store.ts`, `launch-approvals.json`).
2. **La décision de confiance ne vit jamais dans le repo** : entrée hostile
   n°1 du CLAUDE.md, gate `launch-approval.ts`, clé
   `${projectKey}::serve`, hash sur le JSON canonique du fichier.
3. **Port dynamique** alloué par le Deck (`listen(0)` sur `127.0.0.1`, fermé,
   puis passé à la commande), substitué dans `${PORT}`. Le port fixe reste
   possible (`"port": 5173`) mais n'est pas le défaut.
4. **Aide à la construction par un skill** dans `desktop/deck-plugin/skills/`
   (section LS5), pas par une inférence utilitaire cachée : un agent lit les
   fichiers du projet, propose, écrit le fichier, et c'est l'opérateur qui
   approuve au premier lancement.

Écartés :

- Stockage dans `userData` seul : invisible aux agents et aux collègues, et
  un second Deck sur le même repo ne le verrait que par `project_key`. Peut
  revenir comme REPLI si l'opérateur refuse de committer (question ouverte 8.1).
- Détection automatique silencieuse (`package.json` → `npm run dev`) : Launch
  Station ne le fait pas, et une commande devinée qui tourne sans validation
  est une exécution de code non consentie.
- Démon séparé propriétaire des processus : le main d'Electron joue ce rôle,
  la portée est « pour la durée de ce run Kory » comme les approbations.
- Manifeste `launch_details.md` généré : le fichier `serve.json` EST déjà
  lisible par les agents ; un miroir Markdown n'apporte rien en v1.

### Format proposé de `serve.json` (contrat du skill LS5)

```json
{
  "version": 1,
  "name": "Storefront dev server",
  "actions": [
    {
      "name": "web",
      "cwd": "frontend",
      "command": "npm run dev -- --host ${HOST} --port ${PORT} --strictPort",
      "port": "auto",
      "url": "http://${HOST}:${PORT}/",
      "health": "http://${HOST}:${PORT}/",
      "readyTimeoutSec": 30,
      "env": { "BROWSER": "none" },
      "inheritEnv": ["PATH", "HOME", "NVM_DIR"]
    }
  ],
  "primary": "web"
}
```

Règles du contrat (à figer avec le skill) :

- `version` obligatoire (1). `actions` : v1 accepte EXACTEMENT une action ;
  un fichier à plusieurs actions est refusé avec un message clair (« composé
  non supporté »), pas ignoré en silence. `primary` obligatoire dès qu'il y a
  plus d'une action.
- `command` : chaîne exécutée par le login-shell de l'opérateur
  (`buildShellInvocation`, comme `pty-run.ts`), c'est le type `shell` de
  Launch Station. Pas de type `process` en v1 : une seule forme, un seul
  chemin de validation.
- `cwd` : relatif au projet, contenu dans le projet (`resolveWithin`), jamais
  absolu.
- `port` : `"auto"` (défaut) ou entier 1024–65535 ; `NaN` et hors plage
  refusés. `HOST` vaut toujours `127.0.0.1` en v1.
- `${HOST}`/`${PORT}` : seule syntaxe de substitution (pas `{port}` ni
  `{{port}}`) ; substitués dans `command`, `url`, `health`, valeurs de `env`.
- `env` : noms `[A-Z_][A-Z0-9_]*`, `PORT`/`HOST` réservés et refusés ;
  `inheritEnv` : noms hérités de l'environnement du Deck, tout le reste est
  coupé (baseline PATH comme Launch Station, décision 8.3).
- `health` : facultatif, défaut = `url` ; prêt sur 200–399 ; `readyTimeoutSec`
  1–600, défaut 30.
- Champs inconnus : refusés (un champ mal orthographié ne doit pas tomber en
  silence sur un défaut).

## 4. Chantiers

### LS1 — Lecture, validation, approbation (`serve-config.ts`)

- Nouveau `desktop/src/main/serve-config.ts` : `readServeConfig(projectDir)`
  → objet validé ou `{ error }` tracé par `reportError`, jamais `null` muet.
  Tout rejet nomme le champ. `NaN` rejeté explicitement (règle « nouveau
  validateur »).
- Approbation : `resolveApprovedServe({ projectKey: \`${key}::serve\`,
  … })` sur le modèle exact du bloc `worktreeInit` de `index.ts` ; hash du
  JSON canonique (clés triées) pour qu'une modification du fichier redemande.
  Le dialogue montre `command`, `cwd`, `env` : c'est ce qui va au shell.
- Tests : `tests/desktop-serve-config.test.ts` (valide, chaque champ
  refusé, `NaN`, action multiple refusée, champ inconnu refusé, hash stable
  à l'ordre des clés). Aucun nouveau fichier d'état : `launch-approvals.json`
  est réutilisé.

### LS2 — Propriétaire du processus (`serve-service.ts`)

- Nouveau `desktop/src/main/serve-service.ts`, injectable (spawn, allocateur
  de port, fetch) pour rester bun-testable sans Electron.
- `allocatePort()` : `net.createServer().listen(0, '127.0.0.1')`, lecture du
  port, fermeture. Fenêtre de course acceptée et documentée : le serveur du
  projet peut échouer à `bind` si un tiers prend le port entre-temps ;
  `--strictPort` recommandé par le skill, et l'échec remonte comme erreur de
  démarrage, pas comme succès sur un autre port.
- Spawn : `detached: true` (groupe de processus propre), stdout/stderr vers
  un journal borné sous l'état SESSION (`sessions/<groupId>/serve.log`,
  à classer dans `desktop-state-scope.test.ts`), `cwd` résolu par
  `resolveWithin`, env = `inheritEnv` ∪ `env` ∪ `{HOST, PORT}` uniquement.
- Readiness : sondage `health` toutes les 500 ms jusqu'à 200–399 ou
  `readyTimeoutSec` ; échec → arrêt du processus + erreur nommant l'URL et
  le dernier statut.
- Arrêt : `SIGINT` sur le groupe (`-pid`), puis `SIGTERM` après 3 s, puis
  `SIGKILL` après 3 s ; Windows : `taskkill /T /F` (pas de groupe POSIX ;
  à vérifier sur le poste, question 8.4). Identité = PID + `spawn` time
  mémorisés ; on ne signale jamais un PID retrouvé par nom ou par port.
- Invariant : **une instance par (projet, fenêtre Deck)** ; un second
  `start` renvoie l'état courant. Deux Decks sur le même projet = deux
  processus sur deux ports, par construction (port dynamique). Arrêt de tout
  serveur à `before-quit`.
- Tests : `tests/desktop-serve-service.test.ts` avec spawn factice :
  substitution, readiness OK/timeout, escalade des signaux dans l'ordre,
  second start idempotent, quit ferme tout.

### LS3 — Canal IPC `serve:*` (skill `add-deck-view`)

- `DeckApi` : `serveStatus()`, `serveStart()`, `serveStop()`, événement
  `serve:changed` (`idle | starting | ready | failed | stopping`, `url`,
  `port`, message d'erreur). Tier : trusted, PAS exposé au compagnon en v1
  (démarrer un processus depuis un téléphone est une décision à part).
- Handlers dans `ipc.ts` : l'argument est le projet courant du Deck, jamais
  un `dir` fourni par le renderer (entrée hostile n°3).
- Supervision : pas d'outil `deck_serve_*` en v1 (question 8.5).

### LS4 — Bouton et état dans le navigateur (`BrowserView.tsx`, skill `deck-design`)

- Dans `browser-toolbar` : un bouton **Démarrer le projet** (glyphe grec SVG
  dans `icons.tsx`, pas d'emoji) qui devient **Arrêter** une fois prêt, avec
  un badge d'état (`starting` animé, `ready`, `failed` en rouge sémantique
  DESIGN.md). Sur `ready` : `wv.loadURL(url)` et mise à jour de
  `config.browserUrl` comme le fait `onNavigate`.
- Sans `serve.json` : le bouton ouvre un panneau « aucune déclaration »
  avec deux actions : « Écrire le fichier moi-même » (ouvre le chemin) et
  « Demander à un agent » (pré-remplit le prompt de la tuile dockée, ou du
  superviseur, avec l'invocation du skill LS5 ; rien n'est auto-soumis, même
  règle que le picker d'élément).
- i18n : clés `serve.*` dans `i18n.ts` avec parité de locale (`TESTING.md`).
- Mobile : vue desktop-only (`mobile-views.ts`), cohérent avec LS3.

### LS5 — Skill `project-serve` dans le playbook (`desktop/deck-plugin/skills/`)

- `desktop/deck-plugin/skills/project-serve/SKILL.md`, frontmatter `name` /
  `description` (déclencheurs : « comment démarrer ce projet », « configure
  le serveur de dev pour Kory », « écris le serve.json »). Pas de `agent:` en
  v1 (pas de fork, le skill guide la session courante) ; si un sous-agent
  est ajouté plus tard, respecter la règle du `name` load-bearing pinée par
  `tests/desktop-deck-plugin-agent-refs.test.ts`.
- Contenu : (a) le contrat de la section 3 recopié, champ par champ ; (b) la
  méthode : lire `package.json` (`scripts.dev`/`start`), `vite.config.*`,
  `pyproject.toml`, `Makefile`, `docker-compose.yml`, `README` ; choisir UNE
  commande de dev ; forcer host/port par les flags du framework (Vite
  `--host --port --strictPort`, Next `-H -p`, Django `runserver
  ${HOST}:${PORT}`, `python -m http.server ${PORT} --bind ${HOST}`,
  Rails `-b -p`) ; (c) écrire le fichier et dire à l'opérateur qu'il devra
  approuver au premier clic ; (d) ce que l'agent ne fait JAMAIS : approuver,
  lancer le serveur lui-même « pour vérifier », mettre un `cwd` hors projet,
  un port fixe sans raison, ou une commande qui télécharge/installe.
- Test : `tests/desktop-deck-plugin-serve-skill.test.ts` vérifie que le
  contrat du skill et le validateur LS1 acceptent/refusent les mêmes
  exemples (les exemples du skill sont parsés par `readServeConfig`), pour
  que les deux ne dérivent pas.

### LS6 — Mode sandbox

- Un Deck en mode sandbox ne doit pas lancer la commande sur l'hôte : le
  serveur du projet tourne dans le conteneur, le port est PUBLIÉ, et le
  navigateur pointe `http://localhost:<port publié>` (item BACKLOG « Mode
  Web »). Cela touche `sandbox-command.ts` (entrée hostile n°5 : la commande
  est re-validée main-side avant le CLI du moteur).
- v1 : le bouton est désactivé en sandbox avec le message « démarrage hôte
  refusé en mode sandbox », tracé dans le journal ; LS6 est un lot séparé
  qui reprend LS2 avec un runner conteneur. Ne pas livrer LS4 sans cette
  garde.

Ordre : LS1 → LS2 → LS3 → LS4 (avec la garde LS6) → LS5. LS5 peut être
écrit en parallèle dès que le contrat de la section 3 est figé.

## 5. Hors périmètre (explicitement)

- Launchers composés (plusieurs actions ordonnées, endpoints propagés) :
  le format les accueille (`actions[]`, `primary`), le runner v1 les refuse.
- Types `app`, `url`, `ios` de Launch Station.
- Miroir Markdown généré, catalogue global multi-projets, CLI `kory serve`.
- Exposition au compagnon mobile et outil superviseur.

## 6. Guards à auditer (TESTING.md, « coverage, pas sensibilité »)

- Le validateur LS1 fail-CLOSED : un champ inconnu ou un type faux refuse le
  fichier ; le test mute chaque champ.
- L'approbation couvre `command` + `cwd` + `env` + `inheritEnv` (tout ce qui
  atteint le shell) : muter `env` seul doit redemander l'approbation.
- `resolveWithin` sur `cwd` testé avec un préfixe symlinké (règle
  « canonicalize both »).
- L'escalade d'arrêt ne signale que le groupe mémorisé : test avec un PID
  recyclé factice.

## 7. Cartes roadmap à créer (skill `roadmap-card`)

Une carte par chantier LS1…LS6, plus une carte parent « Serve : démarrer le
projet courant dans le navigateur » qui cite ce brief. Le commit qui livre un
chantier porte `Card <id8>.` en tête de corps.

## 8. Questions ouvertes à trancher sur le poste

1. Repli `userData` (par `project_key`) quand l'opérateur ne veut pas
   committer `serve.json` : v1 ou plus tard ? Si v1, l'ordre de précédence
   est repo > userData, et le fichier userData n'a PAS besoin d'approbation
   (écrit par l'opérateur, pas cloné).
2. Le hash d'approbation sur le fichier entier oblige à ré-approuver après un
   simple changement de `readyTimeoutSec`. Alternative : hasher uniquement
   les champs shell (`command`, `cwd`, `env`, `inheritEnv`). Recommandation :
   champs shell seulement, avec un test qui énumère la liste.
3. Baseline d'environnement : couper tout sauf `inheritEnv` (Launch Station)
   rend `nvm`/`pyenv` pénibles ; passer par le login-shell de l'opérateur
   (`buildShellInvocation`, comme `pty-run.ts`) résout `PATH` mais hérite
   tout. Recommandation : login-shell + `inheritEnv` documenté comme
   « variables supplémentaires », pas comme liste blanche.
4. Windows : arrêt par `taskkill /T /F` sans étape `SIGINT` ; vérifier que
   Vite/Next ferment proprement leurs fichiers de cache. Test cross-platform
   à écrire selon `TESTING.md`.
5. Faut-il un outil superviseur `deck_serve_start/stop` pour que le
   superviseur ouvre le site après un déploiement d'équipe ? Probablement
   utile, mais après LS4.
6. Le bouton vit-il seulement dans la barre du navigateur, ou aussi sur la
   tuile d'un agent (bouton `🌐` de tuile) ? Recommandation : barre du
   navigateur seule en v1, l'état étant par projet et non par agent.
