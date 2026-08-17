# Étude — ce que Kory peut reprendre du dépôt intentic/intentic

Date : 2026-08-17. Base d'analyse : `intentic/intentic` @ HEAD (clone shallow), comparé à
Kory branche `experimental` (`f1338b7`). intentic est sous licence MIT : reprendre ou
adapter des mécanismes (voire du code) est permis, avec attribution.

intentic est un « workspace co-piloté d'agents de code » : un daemon sandbox par
utilisateur (conteneur Docker sur le matériel de l'utilisateur), piloté directement
depuis le navigateur via un tunnel sortant, avec fleet board, worktrees git par agent,
revue de diff avant atterrissage. Le recouvrement conceptuel avec le Deck est fort —
mais leurs choix d'implémentation diffèrent assez pour que la comparaison soit féconde.

Ce document couvre les deux focales demandées (sandbox / outils dans le sandbox,
éditeur + coloration) puis un tour des autres features candidates.

---

## 1. Sandbox : installation d'outils

### 1.1 Où en sont les deux systèmes

| | Kory (`experimental`) | intentic |
|---|---|---|
| Techno | Docker/Podman via argv, 1 conteneur par projet, `sleep infinity` + `docker exec` | Docker pur, 1 conteneur par utilisateur/projet, daemon Node en PID 1 |
| Posture | non privilégié, binds `:ro` de protection, volume auth partagé | non privilégié par défaut + directives runtime allow-listées (`--privileged`, `NET_ADMIN`, `--gpus`), `SYS_ADMIN` pour namespaces de montage par tour |
| Outils, build | image de base (`resources/sandbox/Dockerfile`) | image de base dont le socle apt a été choisi **en minant les transcripts** pour `command not found` |
| Outils, opérateur | 1 fragment Dockerfile custom global (textarea, `FROM` refusé) | « packs » = fragments Dockerfile nommés, cuits dans l'image OU appliqués en overlay, avec tampon content-hash `/opt/packs/<name>` |
| Outils, agent | `deck_sandbox_exec` (installe à chaud, dérive assumée, badge de drift + Rebuild) | l'agent **propose** `.intentic/environment.d/<tool>.Dockerfile`, l'opérateur approuve (hash anti-TOCTOU), rebuild hors-bande |
| Extensions | déck-plugin projeté (9 fichiers) | `contributes.environment` (fragments RUN/ENV-only validés) + `contributes.bin` (répertoires préfixés au PATH de l'agent, sans rebuild) |

### 1.2 Le mécanisme intentic à reprendre en priorité : les brouillons d'environnement

C'est exactement le chaînon manquant entre notre fragment custom (opérateur seul) et
`deck_sandbox_exec` (dérive non enregistrée). Chez intentic :

1. Un hook `PreToolUse` détecte un install à portée image (`apt-get install`,
   `pip install`, `npm -g`) et **oriente sans bloquer** : une note (1 par tour) rappelle
   que l'install meurt avec le conteneur et qu'un brouillon est la voie durable.
   Les installs à portée projet (venv, node_modules) sont laissés tranquilles.
2. L'agent écrit un fichier **par outil** — `environment.d/ffmpeg.Dockerfile` — jamais un
   fichier partagé : des agents parallèles ne s'écrasent pas, et deux agents voulant
   ffmpeg convergent sur la même entrée.
3. Le daemon compose les brouillons + la section déjà approuvée en UNE proposition ;
   l'opérateur approuve **par hash** (« mismatch » tue le TOCTOU où l'agent modifie le
   contenu après revue) ; validation : pas de `FROM`, pas de directive runtime.
4. Le rebuild est hors-bande (le conteneur ne peut pas se reconstruire lui-même).
5. Un skill cuit dans l'image explique tout ça à l'agent, avec la consigne clé :
   *« Keep going with the task — drafting is not a blocking handover »* (installe à chaud
   pour finir la tâche, ET dépose le brouillon pour la pérennité).

**Transposition Kory.** Le grain et les gardes existent déjà chez nous :

- Dépôt des brouillons : PAS dans le repo cloné (input hostile n° 1) — un sous-répertoire
  keyé par conteneur sous l'app-state (règle du keying, `sandbox.md` § répertoires), écrit
  soit via un nouvel outil MCP `deck_sandbox_propose_env` (dispatch `deck-control.ts` +
  outil dans `deck-control-mcp.ts`), soit via un hook du deck-plugin.
- Revue : une carte dans `SandboxView` qui affiche la composition (fragments proposés +
  `sandbox-custom.dockerfile` actuel), approve = append au fragment custom + Build ;
  reject = purge des brouillons. Réutiliser `composeCustomDockerfile` (le refus de `FROM`
  y est déjà) ; ajouter le contrôle par hash au moment de l'approbation.
- Le nudge côté agent : le deck-plugin a déjà des hooks dans le conteneur
  (SessionStart/PermissionRequest) ; un PreToolUse sur les motifs d'install est le même
  véhicule.
- Bénéfice direct sur un trade-off déjà documenté chez nous (`sandbox.md`) : « les
  conteneurs longue durée accumulent de l'état installé à la main qu'aucun Dockerfile
  n'enregistre ». Les brouillons convertissent cette dérive en fragments enregistrés,
  et le badge de drift devient actionnable (« 3 brouillons en attente » plutôt que
  « 12 jours de dérive »).

### 1.3 Autres idées sandbox, par ordre d'intérêt

- **Fragments nommés + tampons content-hash** (packs). Éclater notre textarea unique en
  fragments par outil, chacun tamponné (`sha256` du contenu écrit dans l'image). À la
  compose, un fragment dont le tampon correspond est omis → un rebuild ne reconstruit que
  ce qui a changé, et « déjà cuit / à appliquer » devient dérivé du contenu, jamais
  déclaré. Deux propriétés inférées chez eux, à copier : `overlayable` (un `COPY` ⇒
  bake-only) et l'interdiction de mentionner le token de directive runtime même en
  commentaire (leurs exécuteurs de rebuild greppent le token).
- **Socle d'image guidé par les données.** Miner nos journaux/transcripts pour
  `command not found` avant d'élargir l'apt de l'image de base ; documenter aussi les
  exclusions volontaires (leur règle : « un outil présent sous le mauvais nom coûte plus
  de tours qu'un outil absent », cf. `fd`).
- **Sidecars (backlog `4085b661`)** : leur réponse est un moteur Docker **imbriqué**
  (dormant dans l'image, réveillé par `--privileged` via directive approuvée), jamais le
  socket hôte. Pour Kory, `--privileged` contredit notre posture ; notre piste backlog
  (docker CLI direct, réseau dédié, config globale) reste la bonne — mais leur invariant
  « le socket Docker de l'hôte n'est JAMAIS monté » mérite d'être écrit tel quel dans
  `sandbox.md`.
- **Directives optionnelles sondées côté hôte** (GPU) : une capacité optionnelle absente
  est retirée au lancement plutôt que fatale. Utile le jour où on expose un toggle GPU.
- **`workspace-setup`** : détection pure lockfile → recette d'install
  (`pnpm-lock.yaml` → `pnpm install`, etc., `packageManager` prioritaire mais
  whitelist-é car il devient une commande shell). Petit module pur, testable sous
  `bun test`, qui donnerait un bouton « préparer le sandbox » honnête (état
  `unsupported` quand le gestionnaire n'est pas dans l'image — nommer le binaire
  manquant plutôt qu'offrir un install qui échouera).
- **Volume d'historique hors de portée de l'agent.** Chez eux, snapshots git (60 s + par
  tour), journaux et clés vivent sur `/history`, monté hors `/work`, donc hors d'un
  `rm -rf` d'agent. Chez nous `checkpoint-service` et les transcripts gagneraient la même
  garantie si on les adosse à un volume par conteneur distinct de `/work` — à mettre en
  regard du résiduel connu « volume auth partagé entre projets ».

---

## 2. Éditeur / coloration syntaxique

### 2.1 Ce qu'ils font

- **Monaco (`monaco-editor-core` 0.55.1)**, PAS le paquet complet : zéro service de
  langage, zéro IntelliSense, UN seul worker (l'editor worker, qui porte l'algo de diff).
  Override sécurité notable : `monaco-editor-core>dompurify` forcé à 3.4.13.
- **Toute la coloration vient de Shiki 4.4.1** via `@shikijs/monaco` : moteur regex
  **JavaScript** (pas de WASM → rien à configurer côté bundler), ~40 grammaires
  TextMate en imports dynamiques littéraux, thèmes `light-plus`/`dark-plus`.
- Le même highlighter singleton colore l'éditeur, les blocs `<Code>`, les cartes d'outils
  du chat et les extraits de recherche — rien ne peut dériver.
- Diff plein écran = `createDiffEditor` de Monaco ; mais les diffs inline du chat sont un
  LCS maison borné rendu en `<pre>` — « monter un diff editor par carte de transcript est
  bien trop lourd ».
- Garde-fous mesurés : > 512 Ko → pas de grammaire (modèle plaintext) ; > 2 Mo → viewer
  fenêtré lecture seule ; budget de tokenisation global par fichier (pas par ligne, car
  la 1re ligne paie la compilation des regex de la grammaire) ; warm-up d'une ligne
  jetable à chaque chargement de grammaire (sinon la 1re ligne réelle dépasse le budget
  de `vscode-textmate` et sort mal colorée).

### 2.2 Recommandation pour Kory : Shiki seul, pas Monaco

Notre position v1 est déjà actée (« le Deck n'édite jamais de fichiers », viewer
lecture seule) et la carte Phase D (`BACKLOG.md` 3.3) note précisément
« coloration via shiki ou highlight.js en lazy-load ». intentic tranche le choix :
**shiki**, avec une recette complète et éprouvée à transposer telle quelle —
sans embarquer Monaco, qui ne se justifierait que pour de l'édition (décision
opérateur, pas décision technique).

Recette concrète (fichiers de référence chez eux) :

1. `createHighlighterCore` + `createJavaScriptRegexEngine({ forgiving: true })`,
   thèmes en import dynamique — `_editor/ui/src/composables/useHighlighter.ts`.
2. Table de grammaires en **imports dynamiques littéraux** typée `satisfies`
   (`_editor/ui/src/lib/shikiLangs.ts`) : le bundler émet un chunk par grammaire, et
   `lang="dockerfile"` (id inexistant, le vrai est `docker`) devient une erreur de
   compilation. Module pur → testable sous `bun test`, conforme à notre découpage
   pur/impur.
3. Résolution fichier → langue en module pur (`fileType.ts`) : table d'extensions,
   noms exacts (`.npmrc`, `makefile`…), repli shebang. Se branche dans
   `ExplorerView.tsx` sans toucher `explorer-service`.
4. **Sortie HTML bi-thème** (couleur light inline + variable `--shiki-dark`) : la bascule
   sombre/clair est un flip CSS pur, zéro re-tokenisation.
5. Reprendre leurs bornes : pas de coloration au-delà de ~512 Ko (cohérent avec notre
   cap de lecture 512 Ko + `MAX_RENDER_LINES = 5000`), budget de tokenisation global,
   warm-up par grammaire.
6. Diffs : garder la structure de notre colorizer maison de `DiffPanel`, en colorant le
   code des lignes avec les mêmes tokens Shiki. Leur choix « pas de Monaco dans les
   cartes de chat » valide qu'à notre échelle un diff maison borné suffit.

Coût estimé : une dépendance légère lazy-loadée (`shiki/core` + grammaires à la
demande), aucun changement d'architecture, aucune entorse à la position lecture seule.

### 2.3 Monaco : validé UNIQUEMENT si l'on ouvre l'édition

Le choix ci-dessus (shiki seul) tient tant que le Deck reste **lecture seule**. Le jour
où une décision opérateur ouvrirait l'**édition** de fichiers dans le Deck, alors la
coloration seule ne suffit plus et l'implémentation d'intentic devient la référence à
suivre — validée, pas juste observée :

- **`monaco-editor-core`, pas `monaco-editor`** : on n'embarque QUE la surface
  d'édition/diff, zéro service de langage, zéro IntelliSense.
- **UN seul web worker** (l'editor worker, qui porte l'algo de diff). Pas de workers
  TS/JSON/CSS/HTML — c'est ce qui garde les Mo de services de langage hors du bundle.
- **La coloration reste Shiki**, injectée dans Monaco via `@shikijs/monaco` : le même
  highlighter singleton sert le viewer lecture seule, l'éditeur et les diffs → rien ne
  peut diverger. Autrement dit, l'étape 2.2 n'est pas jetée si on passe à l'édition,
  elle est réutilisée.
- **Diff plein écran = `createDiffEditor` de Monaco** ; mais les diffs inline légers
  (cartes de chat) restent un diff maison borné — Monaco par carte est trop lourd.
- **Import dynamique de Monaco au premier fichier code ouvert** (mémoïsé) : les vues
  image/pdf/binaire ne le tirent jamais dans le bundle.
- Override sécurité à ne pas oublier : `monaco-editor-core>dompurify` forcé à une
  version corrigée (c'est le sanitizer que l'éditeur passe sur le markdown rendu).

Tant que l'édition n'est pas décidée, ce paragraphe reste **conditionnel** : on ne tire
pas Monaco pour de la lecture seule. La carte de backlog correspondante (voir
`backlog-intentic.md`) porte cette condition explicitement.

---

## 3. Autres features observées, candidates à adaptation

Par intérêt décroissant pour Kory :

1. **Suppression des notifications par présence** (`idleEverywhere`). Chez eux, toute
   notification push est supprimée tant que quelqu'un est présent et actif sur le
   sandbox — « un tour que tu regardes finir ne t'apprend rien ». Notre registre notify
   (ntfy/Telegram/Discord) pourrait être gaté par la présence opérateur (fenêtre
   focalisée + activité récente), ce qui réduirait le bruit Parastatès sans rien retirer.
2. **Effets « ce que ça va ajouter » avant d'accorder.** Leurs capabilities déclarent
   leurs conséquences comme données (`skill`, `secret`, `image`, `runtime`, `process`…)
   rendues en panneau AVANT l'ajout. Pattern directement applicable à nos cartes
   Sandbox/companion : afficher les conséquences dérivées (nouveau mount, nouveau
   binaire dans l'image, hook activé dans le conteneur) au moment de l'approbation,
   dérivées du même code qui les applique — jamais une liste à maintenir à part.
3. **Lanes dérivées, pas stockées** (fleet board Attention/Actif/Terminé). Une seule
   projection pure `laneOf({status, attention})`, feuille, sans store — parce que lire
   `status` seul avait fait diverger board et rail à l'écran. Chez nous : dériver le
   regroupement des tuiles (et le tri « qui a besoin de toi ») d'une unique fonction pure
   sur l'état session + détecteur d'attention, plutôt que des heuristiques par vue.
   Détail qui compte : « terminé sans atterrissage » est rangé dans *Terminé*, pas dans
   *Attention* — « le router vers Attention apprendrait aux gens à ignorer cette lane ».
4. **Journal de tours + reprise après mort du daemon.** Tout tour en vol est journalisé
   (hors de portée de l'agent) et effacé quand il se règle ; ce qui reste au boot est
   exactement ce sous quoi le process est mort, re-jouable (opt-in, < 6 h, sinon marqué
   `interrupted` — jamais silencieux). Chez nous : un marqueur équivalent par session
   (keyé conteneur) permettrait au Deck, au redémarrage, de distinguer « session finie »
   de « tuée par le crash/quit » et de proposer une reprise — on a déjà l'auto-resume
   quota, c'est la même famille.
5. **Isolation par namespace de montage** : le worktree d'un agent est bind-monté
   PAR-DESSUS `/work` dans un mount namespace par tour (`SYS_ADMIN`), parce que des
   chemins absolus hérités (CLAUDE.md, mémoires, messages) fuyaient hors du worktree.
   Lourd à transposer, mais la classe de bug existe chez nous aussi (agent en worktree
   qui écrit via un chemin absolu dans l'arbre principal) — à minima, la documenter.
6. **Provenance des hunks** : « land » (l'atterrissage d'un worktree) est la seule porte
   qui enregistre quel agent a produit quoi ; le panneau Changes teinte les hunks par
   agent. Pertinent si notre GitView évolue vers une revue multi-worktrees.
7. **Vault de secrets hors `/work` + injection env par tour** : les credentials ne sont
   jamais dans un fichier lisible par l'agent ; le manifeste porte un marqueur. Le seed
   TOTP ne peut par construction pas être référencé dans un template env (échec de parse).
   Nos scope-secrets/provider-secrets sont proches ; la règle « le manifeste lisible ne
   contient jamais le secret, seulement un marqueur » est la bonne formulation à retenir.
8. Hors périmètre Kory à ce stade : marketplace d'extensions (registre de pointeurs
   sha-pinnés — beau design, mais nous n'avons pas d'écosystème tiers), moteur de
   recherche `iq`, catalogue multi-CLI (`agent-catalog`) — nous sommes Claude-Code-only
   par choix, gate de release CI, Doorbell/webchat.

---

## 4. Synthèse

- **Outils dans le sandbox** : reprendre le cycle *steer → draft par outil → compose →
  approve par hash → rebuild hors-bande*. C'est la pièce qui transforme notre dérive
  assumée (`deck_sandbox_exec`) en état enregistré, et elle se pose sur des rails déjà
  existants (fragment custom, deck-plugin hooks, SandboxView, règle du keying par
  conteneur). Compléments faciles : fragments nommés + tampons content-hash, socle
  d'image guidé par les `command not found` réels.
- **Coloration** : shiki, moteur regex JS, grammaires en imports littéraux typés,
  HTML bi-thème, bornes de taille — la Phase D a maintenant une implémentation de
  référence, sans Monaco et sans toucher à la position lecture seule.
- **Au-delà** : gating des notifications par présence, effets-avant-approbation, lanes
  dérivées d'une projection pure, journal de tours — quatre patterns peu coûteux et
  bien alignés avec nos règles (pur/impur, pas d'erreur silencieuse, approbations).
