# Cartes de backlog — reprises d'intentic pour Kory

Date : 2026-08-17. Issu de l'étude `desktop/docs/etude-intentic.md` (analyse du dépôt
`intentic/intentic`, MIT). Ce fichier est un **staging de cartes proposées**, à verser
dans `BACKLOG.md` une fois validées. Chaque carte donne : pourquoi, périmètre, fichiers à
toucher, critères d'acceptation, décisions ouvertes.

Ordre d'attaque conseillé : **C1 (Shiki)** d'abord — la plus autonome — puis **C2
(brouillons d'environnement)**, puis **C3 (merge mémoire)**. **C4** et **C5** sont
consignées mais **non planifiées** (YAGNI / conditionnel).

---

## C1 — Coloration syntaxique du viewer (et des diffs) via Shiki

**Pourquoi.** La carte Phase D existante (`BACKLOG.md` 3.3) note « coloration via shiki ou
highlight.js en lazy-load ». intentic tranche le choix (shiki) et fournit une recette
éprouvée. Aucune entorse à la position lecture seule du Deck.

**Périmètre.**
- Coloration lecture seule dans l'explorateur de fichiers.
- Coloration du code dans les diffs (Git view / `DiffPanel`), en réutilisant la structure
  du colorizer maison existant.
- **Hors périmètre** : édition, Monaco, autocomplétion.

**Recette (références intentic).**
1. `createHighlighterCore` + `createJavaScriptRegexEngine({ forgiving: true })` (moteur
   regex JS, pas de WASM), thèmes `light-plus`/`dark-plus` en import dynamique.
   Réf. `_editor/ui/src/composables/useHighlighter.ts`.
2. Table de grammaires en **imports dynamiques littéraux** typée `satisfies` → un chunk
   par grammaire, langue inconnue = erreur de compilation. Réf. `_editor/ui/src/lib/shikiLangs.ts`.
3. Résolution fichier → langue en **module pur** (table d'extensions + noms exacts +
   repli shebang). Réf. `_editor/web/src/pages/workspace/fileType.ts`.
4. **Sortie HTML bi-thème** (couleur light inline + variable `--shiki-dark`) → bascule
   sombre/clair = flip CSS pur, zéro re-tokenisation.
5. Bornes mesurées : pas de coloration > ~512 Ko (cohérent avec notre cap de lecture
   512 Ko + `MAX_RENDER_LINES = 5000`), budget de tokenisation **global par fichier**
   (pas par ligne), warm-up d'une ligne jetable à chaque chargement de grammaire.

**Fichiers Kory à toucher.**
- `desktop/package.json` : ajouter `shiki` (+ `@shikijs/langs`, `@shikijs/themes`) — 1re
  dépendance de coloration, lazy-loadée.
- Nouveau module pur `desktop/src/shared/` (résolution langue + table grammaires) →
  testable sous `bun test`, conforme au découpage pur/impur.
- `desktop/src/renderer/src/components/ExplorerView.tsx` : brancher la coloration sur le
  viewer plain-text existant (le commentaire v1 « no syntax highlighting » y pointe déjà).
- `DiffPanel` (colorizer) : colorer le code des lignes avec les mêmes tokens Shiki.
- Locales si nouveaux libellés.

**Acceptation.**
- Un fichier `.ts`/`.py`/`.json` s'affiche coloré en lecture seule ; > 512 Ko → plaintext.
- La bascule thème ne re-tokenise pas (flip CSS).
- Une langue inconnue échoue à la compilation, pas au runtime.
- `bun test` du module pur vert ; typecheck desktop vert.

**Décisions ouvertes.** Aucune bloquante. Choix du lot initial de grammaires (démarrer
sur les langues réellement vues dans les projets).

---

## C2 — Brouillons d'environnement : rendre les installs `apt-get` réutilisables

**Pourquoi.** Trade-off déjà documenté (`sandbox.md`) : les conteneurs longue durée
accumulent de l'état installé à la main (`deck_sandbox_exec`) qu'aucun Dockerfile
n'enregistre → perdu au Rebuild. On veut convertir cette dérive en fragments enregistrés,
sans bloquer l'agent.

**Mécanisme (repris d'intentic, adapté à nos rails).**
1. **Un hook oriente sans bloquer.** Un `PreToolUse` (dans le deck-plugin, qui a déjà des
   hooks dans le conteneur) détecte les installs à portée image (`apt-get install`,
   `pip install`, `npm -g`) et émet **une note par tour** : « ceci meurt avec le
   conteneur ; dépose un fragment pour le rendre durable ». Les installs à portée projet
   (venv, `node_modules`) sont laissés tranquilles.
2. **Un fichier de brouillon par outil.** L'agent (ou un outil MCP dédié) écrit
   `environment.d/<outil>.Dockerfile` — jamais un fichier partagé (agents parallèles ne
   s'écrasent pas ; deux agents voulant ffmpeg convergent sur une entrée). **Dépôt keyé
   par conteneur sous l'app-state, jamais dans le repo cloné** (input hostile n° 1 + règle
   du keying).
3. **Compose + approbation par hash.** Le main compose brouillons + section custom
   existante en UNE proposition ; l'opérateur approuve **par hash** (tue le TOCTOU où
   l'agent modifie le contenu après revue). Validation : pas de `FROM` (déjà refusé par
   `composeCustomDockerfile`), pas de directive privilégiée.
4. **Rebuild hors-bande** (le conteneur ne se reconstruit pas lui-même) — chemin Build
   existant de SandboxView.

**Fichiers Kory à toucher.**
- Deck-plugin : ajouter le hook `PreToolUse` (motifs d'install) + sa projection dans le
  conteneur (`sandbox-projection.ts` / `sandbox-command.ts` connaissent déjà le deck-plugin).
- `desktop/src/main/deck-control.ts` (+ `desktop/mcp/deck-control-mcp.ts`) : nouvel outil
  superviseur `deck_sandbox_propose_env` (écrit un brouillon), sur le modèle de
  `deck_sandbox_exec`. Argv en un seul élément, jamais un shell hôte (input hostile n° 4).
- `desktop/src/main/sandbox-service.ts` / `sandbox-command.ts` : répertoire
  `sandbox-env-drafts/<containerName>` keyé conteneur ; `composeCustomDockerfile` réutilisé
  pour la compose ; contrôle par hash au moment de l'approbation.
- `desktop/src/renderer/src/components/SandboxView.tsx` : carte « brouillons
  d'environnement » (liste, aperçu de la compose, Approuver/Rejeter) ; réutiliser le
  pattern de la carte fragment custom.
- `desktop/src/shared/types.ts` + `ipc.ts` + preload + companion (checklist DeckApi) pour
  les nouveaux canaux `sandbox:env-*`.
- Locales fr/en.

**Acceptation.**
- Un `apt-get install X` dans un sandbox produit **une** note (pas une par commande) et un
  brouillon `environment.d/X.Dockerfile`.
- L'opérateur voit la carte, approuve → X entre dans l'image custom au prochain build ;
  rejette → brouillons purgés.
- L'approbation échoue proprement si le contenu a changé depuis la revue (mismatch de hash).
- Deux agents parallèles voulant X ne produisent pas deux brouillons contradictoires.
- Pas de `FROM` ni de directive privilégiée acceptés dans un brouillon.

**Décisions ouvertes.**
- Qui écrit le brouillon : outil MCP superviseur, ou hook côté agent, ou les deux ?
  (Recommandé : outil MCP, pour garder l'écriture côté main validée.)
- Complément possible (séparé) : **fragments nommés + tampons content-hash** dans l'image
  de base, pour ne rebuilder que ce qui a changé. À carder à part si souhaité.

---

## C3 — Vue de merge des mémoires agent (conteneur → hôte), ligne par ligne

**Pourquoi.** La mémoire **globale** de l'agent (`~/.claude/CLAUDE.md` + dossier mémoire)
vit dans le volume `kory-claude-auth`, **container-only** et partagé entre projets, jamais
reversée sur le `~/.claude` hôte. On veut pouvoir **reprendre sélectivement** ce que
l'agent a mémorisé, sans automatisme (qui gonflerait le fichier) et sans écrasement
destructif.

> Portée : **mémoire globale** uniquement. La mémoire **projet** (`<projet>/CLAUDE.md`,
> `<projet>/.claude/`) est déjà sur l'hôte en mode `mount` et repart par `git push` en mode
> `copy` — rien à faire.

**Point de sécurité (cadre la conception).** Reprendre un fichier du conteneur vers l'hôte
= écrire sur l'hôte du contenu produit par du code supposé compromis (**input hostile
n° 5**). D'où :
- **Manuel, ligne par ligne** — l'opérateur décide, jamais l'automate. C'est la garde.
- **Seulement des fichiers de mémoire = des données** (`CLAUDE.md`, `memory/*.md`).
  **Exclure** tout ce qui s'exécute / se fait confiance côté hôte (`settings.json`,
  `hooks/`, `.mcp.json`) → réutiliser `PROTECTED_PATHS` (`sandbox-protect.ts`) et la
  détection « host-only hooks » de `sandbox-projection.ts` (qui porte déjà une allow-list,
  utilisée aujourd'hui dans le sens hôte → conteneur au démarrage).
- **« Reprendre tout » = cherry-pick par hunk**, PAS un append (sinon doublons /
  gonflement). Non destructif par construction : on adopte une région, on n'ajoute pas.

**UI (design opérateur).**
- Une **vue à part dans SandboxView** (sous-onglet dédié) : deux colonnes — à gauche
  fichier mémoire **conteneur**, à droite fichier mémoire **hôte (global)** — diff
  rouge/vert par ligne, action **« reprendre »** par hunk + bouton **« reprendre tout »**.
- **Non systématique mais mis en avant** : badge « mémoire divergente » sur le glyphe
  Sandbox de la nav-rail (ou compteur sur la carte), sur le modèle du badge de drift
  existant, pour que l'utilisateur n'oublie pas de fusionner.
- **Direction unique assumée** : conteneur → hôte, revue. L'autre sens (hôte → conteneur)
  existe déjà à la projection de démarrage — ne pas créer de boucle qui s'écrase.

**Fichiers Kory à toucher.**
- `desktop/src/main/diff-service.ts` (+ `DiffPanel`) : étendre à une **comparaison à deux
  sources** (fichier conteneur lu via `docker exec cat` / `docker cp`, fichier hôte) avec
  **application par hunk** sur le fichier hôte.
- `desktop/src/main/sandbox-service.ts` / `sandbox-command.ts` : lecture du `~/.claude`
  conteneur (sous-ensemble mémoire de l'allow-list) ; écriture par hunk côté hôte via
  écriture atomique (`atomic-write.ts`).
- `sandbox-projection.ts` : réutiliser / exposer l'allow-list mémoire (et la deny-list
  `PROTECTED_PATHS`).
- `desktop/src/renderer/src/components/SandboxView.tsx` : nouvel onglet « Mémoire ».
- `NavRail.tsx` : état « mémoire divergente » (nouveau cran du glyphe Sandbox, via
  `sandbox:changed`).
- `shared/types.ts` + `ipc.ts` + preload + companion + locales.

**Acceptation.**
- Divergence entre `~/.claude` conteneur et hôte → badge visible, non bloquant.
- Vue diff deux colonnes, hunks rouge/vert, « reprendre » par hunk et « reprendre tout ».
- Une reprise n'introduit **pas** de doublon et n'écrase pas le reste du fichier hôte.
- `settings.json` / `hooks/` / `.mcp.json` **jamais** proposés à la reprise.
- Écriture hôte atomique ; erreur routée (`reportError`), pas de swallow.

**Décisions ouvertes (reviennent à l'opérateur).**
1. Portée : global d'abord ; onglet « projet » en second temps (utile surtout en mode
   `copy`) ? — recommandé : **global d'abord**.
2. Le volume auth étant partagé entre projets, la « mémoire conteneur » comparée est
   commune à tous les projets — à acter comme nature du global, pas un bug.

---

## C4 — (YAGNI) Isolation par mount namespace pour worktrees partagés dans un conteneur

**Statut : NON planifié — consigné pour ne pas le perdre.**

**Le problème qu'intentic corrige.** Quand plusieurs agents tournent **en parallèle dans
un même conteneur**, chacun dans son worktree git, un agent hérite d'un **chemin absolu**
(mémoire, CLAUDE.md, message : ex. `/work/src/foo.ts`). Mais `/work` pointe sur l'arbre
partagé, pas sur *son* worktree → son écriture **s'échappe** vers l'arbre commun, sans
passer par « land », sans attribution. Leur correctif : un **mount namespace par tour** où
le worktree **devient** `/work` (`SYS_ADMIN`), l'arbre réel restant à `/mnt/intentic-main`,
avec `node_modules`/`dist` en overlayfs (pour éviter que les hardlinks pnpm réécrivent la
source de l'arbre principal).

**Pourquoi YAGNI pour Kory.** Ne se justifie que si le team-lead fait tourner **plusieurs
worktrees en parallèle dans le même conteneur Docker** écrivant via chemins absolus. Tant
qu'un worktree = son conteneur (ou du séquentiel), la classe de bug n'existe pas. On
**tend à dire non**, mais ça dépend de comment le team-lead et son équipe décideront
d'opérer.

**À faire si un jour on y va.** Réévaluer cette carte ; en attendant, garder la classe de
bug documentée (un agent en worktree qui écrit via un chemin absolu dans l'arbre principal).

---

## C5 — (Conditionnel) Édition de fichiers dans le Deck via Monaco

**Statut : conditionnel — SSI une décision opérateur ouvre l'édition.**

Aujourd'hui le Deck est lecture seule par décision (« le Deck n'édite jamais de fichiers »).
**Cette carte ne s'active que si cette décision change.** Le cas échéant, l'implémentation
d'intentic est la référence validée (détails dans `etude-intentic.md` § 2.3) :

- `monaco-editor-core` (pas `monaco-editor`), zéro service de langage, **un seul worker**
  (editor worker, qui porte le diff).
- Coloration **toujours Shiki** via `@shikijs/monaco` — la carte C1 est réutilisée, pas
  jetée.
- Diff plein écran = `createDiffEditor` ; diffs inline légers restent maison.
- Import dynamique de Monaco au premier fichier code ouvert (mémoïsé).
- Override sécurité `monaco-editor-core>dompurify` à une version corrigée.

Tant que l'édition n'est pas décidée : **on ne tire pas Monaco**, C1 (Shiki seul) couvre le
besoin de lecture.
