# PLAN — Vue Git & Explorateur de fichiers (GX1…GX8)

> Issu du brainstorm « navigation trail : vue git + explorateur » (branche
> `experimental`). Décisions opérateur actées :
> - **Vue Git STRICTEMENT read-only.** La délégation de commit (v2 envisagée
>   pendant le brainstorm) est **rejetée** — aucun `git add/commit/branch`
>   depuis le Deck, ni direct ni délégué.
> - **Explorateur sans coloration syntaxique en v1** (texte brut + numéros de
>   ligne). v2 notée : coloration via **shiki ou highlight.js** (lazy-load),
>   voir « Phase D » ci-dessous.
> - Bascule du mode `-p` de l'assistant : **sans objet** (pas de quota séparé
>   `-p` vs interactif d'après la doc officielle — costs.md) ; aucun chantier.
>
> Ids de chantier : `GX1`…`GX8`. Phasage A → C implémenté dans ce lot ;
> phase D notée, non implémentée.

## Statut

| Phase | Chantiers | Statut |
|---|---|---|
| A — Vue Git rail (read-only) | GX1, GX2, GX3 | ✅ implémenté |
| B — Explorateur (v1 sans coloration) | GX4, GX5, GX6 | ✅ implémenté |
| C — Sélection → assistant / roadmap | GX7, GX8 | ✅ implémenté |
| D — Coloration syntaxique (shiki / highlight.js) | — | ⏸ non lancé (v2) |

## Phase A — Vue Git dans le navigation rail

Promotion du DiffPanel C13 (modal ponctuel) en vue permanente du rail,
read-only. Le modal existant est conservé (vue Worktrees + menu contextuel de
session) ; la vue rail est une surface d'observation continue.

### GX1 — `diff-service.ts` : diff par fichier

- `collectFileDiff(dir, path, base?)` : diff unifié d'UN fichier —
  section branche (`git diff base...HEAD -- <path>`) quand `base` est fourni,
  puis section uncommitted (`git diff HEAD -- <path>`) ; fichier untracked →
  `git diff --no-index /dev/null <path>` (exit code 1 = diff trouvé, accepté).
  Cap `DIFF_TEXT_MAX`, même shape `{ text, truncated }`.
- Le `path` renderer passe par `execFile` en tableau d'args avec séparateur
  `--` : jamais interpolé dans un shell.
- Tests bun : extension de `tests/desktop-diff.test.ts` (tracked modifié,
  untracked, binaire, cap).

### GX2 — Câblage IPC / DeckApi

Checklist DESKTOP.md complète : `DeckApi.collectFileDiff` (`shared/types.ts`),
handler `diff:collect-file` (`ipc.ts`, réutilise `diffBase`),
`COMPANION_MANIFEST` + `CHANNEL_TIERS` (tier 0, lecture) dans
`shared/companion.ts`, bridge `preload/index.ts`. Le shim compagnon
(`remote-api.ts`) est piloté par le manifest — rien à toucher.

### GX3 — `GitView.tsx` + rail

- `DeckView` gagne `'git'` ; entrée rail `±` entre browser et roadmap
  (`NavRail.tsx`) ; montage dans `App.tsx` sous `ErrorBoundary scope="git"`
  (desktop + client remote desktop ; layout mobile non couvert, comme graph).
- Colonne gauche : cibles = worktrees du projet (`listWorktrees`, avec badge
  session attachée) + cwd de sessions vivantes hors worktrees (dédup).
- Colonne droite : résumé `collectDiff` (sections branche / uncommitted,
  numstat par fichier) ; clic fichier → diff du fichier seul
  (`collectFileDiff`) rendu par le colorizer de lignes existant (style
  DiffPanel) ; bouton « tout voir » = diff complet. Refresh manuel + poll
  10 s quand la vue est active. Bouton « review » réutilisé (`reviewDiff`).
- Read-only assumé : AUCUNE action stage/commit/branch dans cette vue.
- i18n `git.*` (en.json, fr.json, `EN_DEFAULTS`).

## Phase B — Explorateur de fichiers

### GX4 — `explorer-service.ts` (nouveau module main, pur)

- Node builtins uniquement (testable bun). `resolveWithin(root, rel)` :
  résolution + containment `realpath` (les symlinks qui s'échappent de la
  racine sont rejetés) ; `.git` masqué du listing.
- `listExplorerDir(root, rel)` : entrées `{ name, dir, size }`, dossiers
  d'abord, tri alpha ; pas de récursion (lazy par répertoire).
- `readExplorerFile(root, rel)` : cap 512 Ko (`truncated`), détection binaire
  (octet NUL dans les 8 premiers Ko), retour `{ content, truncated, binary,
  size }`.
- Tests bun : `tests/desktop-explorer.test.ts` (containment, symlink escape,
  binaire, cap, tri).

### GX5 — Câblage IPC / DeckApi

- `explorer:roots` / `explorer:list` / `explorer:read` (tier 0). SÉCURITÉ :
  la racine passée par le renderer est re-validée côté main à CHAQUE appel
  contre l'ensemble autorisé recalculé (projectDir + worktrees + cwd des
  sessions vivantes) — un client compagnon ne peut pas lire hors de ces
  racines.
- `DeckApi.explorerRoots/explorerList/explorerRead`, manifest + tiers +
  preload, comme GX2.

### GX6 — `ExplorerView.tsx` + rail

- `DeckView` gagne `'files'` ; entrée rail 📁 ; `ErrorBoundary scope="files"`.
- Arbre à gauche (expansion lazy, état par chemin relatif), viewer à droite :
  gouttière de numéros de ligne + `<pre>` de contenu (sélection texte
  naturelle, les numéros ne se copient pas), cap d'affichage 5 000 lignes
  avec bandeau « tronqué », binaire → message dédié. Sans coloration (v1).
- i18n `files.*`.

## Phase C — Sélection → assistant / roadmap

### GX7 — « Expliquer ce code » (assistant)

- Type partagé `HelpSelection { file, startLine, endLine, text }` (texte
  cappé ~20 Ko côté main).
- `askHelp` gagne un 4ᵉ paramètre optionnel `selection` (même canal
  `help:ask`) ; le handler l'injecte dans le snapshot système
  (`data.code_selection`) — le code voyage par FICHIER
  (`--append-system-prompt-file`), jamais sur la ligne de commande (cap
  `MAX_PROMPT_ARG_CHARS` intouché). Prompt système : CODE CONSTANT inchangé
  (règle C8 : contexte généré par l'app).
- Store : `helpSeed { question, selection } | null` + `openHelpAssistant()` ;
  `HelpAssistant.tsx` consomme le seed (ouvre le popup, préremplit la
  question, chip `fichier:l1-l2` détachable, joint la sélection à l'envoi).
- `ExplorerView` : capture de sélection dans le viewer (mouseup, lignes
  calculées par offsets) → barre d'actions « ❓ Expliquer » / « 🗺 Tâche ».

### GX8 — « Créer une tâche » (roadmap)

- Store : `roadmapSeed { title, kind, description } | null` +
  `openRoadmapDraft(seed)` (bascule la vue roadmap) ; `RoadmapView` consomme
  le seed en préremplissant son formulaire de création (kind `debt`, statut
  `planned`, description = fichier:lignes + bloc de code markdown).
  L'enregistrement reste une action explicite de l'opérateur (comme le wand).

## Phase D — Coloration syntaxique (v2, NON lancée)

Décision notée pour plus tard : coloration du viewer (et des diffs ?) via
**shiki** (grammaires TextMate, qualité VSCode) ou **highlight.js**, en
lazy-load pour ne pas alourdir le bundle compagnon. Première dépendance de
rendu du projet — à trancher quand l'usage de la phase B/C sera prouvé.
Prévoir aussi : virtualisation des très gros fichiers, recherche dans le
fichier.

## Hors périmètre (rappels)

- Pas d'écriture git (décision opérateur : read-only strict, délégation
  rejetée).
- Pas d'écriture fichier dans l'explorateur (lecture seule).
- Layout mobile compagnon : les deux vues ne sont pas ajoutées au shell
  mobile (même statut que graph/browser) ; le client remote DESKTOP les a via
  le shim manifest.
- Assistant `-p` : aucun changement de mode (prémisse quota invalidée).
