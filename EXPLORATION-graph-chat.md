# EXPLORATION — Graph chat & battle mode (C23-C28)

> **Document de travail multi-sessions** (même contrat que PLAN-v0.4.md : design
> ET pilotage d'exécution dans ce fichier ; cocher les jalons et tenir le
> journal en fin de session). Ce plan **prend le relais** de l'entrée « Battle
> chat multi-modèles » de la section *Reportés* de PLAN-v0.4.md.
>
> Vérifs systématiques avant commit : `bun test`, smoke check
> `bun build --target=bun broker.ts server.ts cli.ts --outdir=/tmp/cp-check`,
> `npm run typecheck` dans `desktop/`.

## 1. Inspiration & idée directrice

Démo observée (capture opérateur, 2026-07-16) : un canvas de chat en graphe où
chaque échange avec le LLM est un **nœud** — les nœuds user et assistant
alternent le long d'arêtes, chaque nœud assistant porte le modèle qui l'a
produit (`claude-opus-4-8`, `gemini-3.1-pro`, `gpt-5-5`…), l'utilisateur peut
brancher un « what if ? » n'importe où, créer un nœud vide, y **connecter N
nœuds** comme parents et lancer l'inférence dessus (croisement de branches,
référencé `@node-id` dans la démo).

Idée directrice de la combinaison avec le battle chat (reporté au
PLAN-v0.4) : **le battle mode cesse d'être une feature à part et devient un
motif du graphe.** Un prompt adressé à X modèles produit X nœuds assistant
frères (fan-out) ; si le mode battle est actif, un nœud **juge** est créé
automatiquement avec les X réponses pour parents et produit la synthèse
arbitrée. Sinon les X nœuds restent des feuilles librement explorables. La
variante « panel de review multi-modèles » notée au PLAN est couverte par le
même motif (un battle dont le nœud racine porte un plan/diff — C28).

## 2. Décisions structurantes

- **D1 — Le graphe est la source de vérité, pas les sessions CLI.** Chaque
  nœud assistant est produit par UNE invocation headless *stateless*
  (`claude -p` / `codex exec` / `gemini`) dont le contexte est **recompilé
  depuis le graphe** (linéarisation des ancêtres) à chaque inférence. Aucun
  `--resume` : le resume n'a pas d'équivalent portable chez Codex/Gemini, et
  surtout une session ne peut pas absorber l'historique d'une autre — ce
  modèle interdirait le merge, qui est le cœur de la feature. Conséquences :
  cross-CLI trivial (répondre avec Gemini à une branche commencée avec
  Claude), branchement = créer un enfant, merge = nœud à N parents,
  rejouable/inspectable. Prix assumé : chaque inférence renvoie tout le
  contexte (pas de cache de session), et les nœuds n'ont pas d'état d'agent.
- **D2 — DAG, pas arbre.** Les nœuds de croisement/merge ont N parents. Un
  ajout d'arête n'est accepté que s'il ne crée pas de cycle (le parent ne
  doit pas être un descendant du nœud).
- **D3 — Rendu du merge : documentaire, jamais fausse conversation.** Deux
  branches divergentes se contredisent souvent (c'est le but d'un « what
  if »). On ne les aplatit PAS en faux historique linéaire : déduplication
  par le **tronc commun** (ancêtres partagés, façon merge 3 voies git) rendu
  une seule fois, puis chaque delta de branche dans une **section étiquetée**,
  avec un system prompt qui explique la structure (« un tronc, N explorations
  divergentes qui ne se connaissent pas »).
- **D4 — Prompts = constantes code (règle C8).** Les trois system prompts
  (chat linéaire, merge, juge) sont des CODE CONSTANTS dans
  `graph-engine.ts`, jamais configurables opérateur/repo.
- **D5 — Le contexte compilé voyage par FICHIER, jamais sur la ligne de
  commande.** Un contexte de 50 k chars exploserait la limite Windows
  (~32 k) et frôlerait ARG_MAX. Claude : system prompt constant + contexte
  dans le fichier `--append-system-prompt-file`, la question (courte, cap
  8 k) en argument positionnel — même patron que l'aide C9. Codex/Gemini :
  prompt complet composé dans un fichier passé par stdin (`< "file"` POSIX,
  `Get-Content -Raw "file" |` PowerShell).
- **D6 — Harness lecture seule (patron C9), par CLI.** Claude :
  `--strict-mcp-config` + `--disallowedTools` (Read/Grep/Glob restent
  disponibles pour ancrer les réponses dans le projet). Codex :
  `--sandbox read-only`. Gemini : pas d'équivalent fiable connu — l'adaptateur
  ne passe aucun flag d'écriture et la limite est documentée (inférence pure
  attendue ; à durcir si le CLI expose un jour un mode read-only).
- **D7 — Persistance desktop-locale, par projet.** Contrairement à la roadmap
  (broker, partagée avec les agents), le graph chat est un outil opérateur :
  JSON sous `<userData>/config/graphs/<sha256(project_key)[:16]>.json`
  (project_key = `computeDeckProjectKey`, donc stable à travers les
  worktrees/clones du même remote). Les fonctions du store prennent le
  dossier en paramètre (testables sous bun sans Electron, patron
  snippet-store).
- **D8 — Budget de tokens avec dégradation explicite.** Sous
  `GRAPH_MAX_CONTEXT_CHARS` (60 k, comme l'aide C9) tout passe verbatim —
  le cas nominal (2 branches × ~10 nœuds) tient largement. Au-delà :
  élision des échanges les plus anciens de chaque branche (les K derniers
  restent verbatim) avec un marqueur `[… N earlier exchanges elided …]`.
  La compression par nœud *digest* (résumé LLM d'une branche) est le
  chantier C28, pas la v1. L'**inspecteur de contexte** (bouton « voir ce
  qui sera envoyé ») rend la compilation non-opaque.

## 3. Modèle de données (`desktop/src/shared/graph.ts`)

```ts
type GraphNodeType = 'user' | 'assistant' | 'judge'   // + 'digest' en C28
type GraphCli = 'claude' | 'codex' | 'gemini'
interface ModelTarget { cli: GraphCli; model: string } // model '' = défaut CLI

interface GraphNode {
  id: string            // court, aléatoire (base36)
  type: GraphNodeType
  parents: string[]     // [] pour une racine
  text: string          // prompt (user) ou réponse (assistant/judge)
  x: number; y: number  // position canvas (layout manuel, cf. démo)
  createdAt: number
  cli?: GraphCli        // assistant/judge
  model?: string
  status?: 'ok' | 'error'
  error?: string
  durationMs?: number
}

interface GraphDoc {
  id: string; name: string
  nodes: GraphNode[]
  createdAt: number; updatedAt: number
}
```

Opérations pures (mêmes fichiers, unit-testées) : `ancestorsOf` (BFS
remontant), `wouldCreateCycle` (connexion de parents), `linearize` (tri
topologique du sous-graphe ancêtre, départage chronologique `createdAt`
puis `id` — déterministe), `mergePartition(nodes, heads)` → tronc commun
(intersection des ensembles d'ancêtres, linéarisé) + un delta linéarisé par
head. La partition se calcule sur les **parents immédiats** du nœud
d'inférence : 0-1 parent → transcript linéaire ; ≥2 parents → rendu merge D3.

## 4. Compilation & inférence (`desktop/src/main/graph-engine.ts`)

- `compileContext(doc, nodeId)` → `{ system, prompt }` : choisit le rendu
  (linéaire / merge) selon les parents, applique le budget D8. Transcript :
  une ligne d'en-tête par nœud (`[user]` / `[assistant claude/sonnet]` /
  `[judge]`) suivie du texte. Exposé tel quel à l'UI par `graph:compile`
  (inspecteur de contexte).
- `runInference(deps, doc, nodeId, targets, battle, judge?)` : fan-out
  `Promise.allSettled` sur les adaptateurs (un nœud assistant par cible,
  `status:'error'` + message en cas d'échec, l'échec d'une cible ne bloque
  pas les autres) ; si `battle` et ≥2 réponses ok → compilation du prompt
  juge (contexte commun + réponses étiquetées A/B/C anonymisées du nom du
  modèle pour limiter le biais, mapping révélé dans le nœud) et un nœud
  `judge` avec les N assistants pour parents. Juge par défaut :
  `{ cli:'claude', model:'sonnet' }`, cible modifiable dans l'UI.
- Positions des nœuds créés : éventail horizontal sous le nœud prompt
  (layout manuel ensuite, comme la démo).

## 5. Adaptateurs headless (`desktop/src/main/model-adapters.ts`)

Généralisation du squelette C9 (`runHelp` reçoit un `timeoutMs` optionnel —
300 s ici, les contextes longs + modèles lents dépassent les 120 s de
l'aide) :

| CLI | Commande (POSIX) | Contexte | Read-only |
|---|---|---|---|
| claude | `claude -p '<question>' --append-system-prompt-file "<f>" [--model m] --strict-mcp-config --disallowedTools …` | fichier system | technique (C9) |
| codex | `codex exec --sandbox read-only [-m m] - < "<f>"` | fichier → stdin | `--sandbox read-only` |
| gemini | `gemini [-m m] < "<f>"` | fichier → stdin | documenté (D6) |

`model` est validé `[A-Za-z0-9._:-]` (il voyage sur la ligne de commande) ;
`''` omet le flag. Tout passe par `buildShellInvocation` (shell login
non-interactif) + marqueur anti-bruit de profil, comme l'aide.

## 6. UI (`desktop/src/renderer/src/components/GraphView.tsx`)

Nouvelle vue de rail `graph` (icône 🕸, entre Roadmap et Worktrees).

- **Colonne gauche** : graphes du projet (créer / renommer / supprimer).
- **Canvas custom** (pas de dépendance : SVG pour les arêtes bézier, divs
  positionnées pour les nœuds — cohérent avec l'appli, zéro lib graphe) :
  pan (drag fond), zoom (molette), drag de nœud (positions persistées,
  sauvegarde debouncée `graph:save`).
- **Nœuds** : en-tête (icône type + cli/model + id court), texte clampé,
  sélection (clic), multi-sélection (shift-clic), état erreur visible.
- **Actions sur sélection** (panneau latéral) : *Répondre* (enfant user),
  *Nouveau nœud depuis la sélection* (nœud user avec les N sélectionnés en
  parents = croisement/merge), *Connecter un parent* (avec refus de cycle),
  *Inférer* (cases à cocher cibles claude/codex/gemini + champ modèle,
  toggle **battle** + cible juge), *Inspecter le contexte* (modal, sortie
  de `graph:compile`), *Supprimer* (feuilles uniquement — pas de cascade
  silencieuse).
- Pendant l'inférence : spinner sur le nœud prompt, l'IPC `graph:infer`
  retourne le doc mis à jour (les nœuds partiels en erreur restent visibles).

IPC : `graph:list`, `graph:create`, `graph:delete`, `graph:save` (doc entier,
validé côté main par un parseur de shape façon `parseTemplate`),
`graph:compile`, `graph:infer`.

## 7. Chantiers

### C23 — Modèle + moteur pur + persistance (~1 j) — FAIT
- [x] `shared/graph.ts` : types, `ancestorsOf`, `wouldCreateCycle`,
      `linearize`, `mergePartition`, id generator.
- [x] `main/graph-store.ts` : load/save par projet (dossier en paramètre,
      patron snippet-store), parseur de shape.
- [x] Tests : cycles refusés, linéarisation déterministe, partition tronc +
      deltas sur le cas « 2 branches de 10 nœuds », round-trip persistance.

### C24 — Adaptateurs headless multi-CLI (~0,5 j) — FAIT
- [x] `runHelp` : paramètre `timeoutMs` optionnel (défaut inchangé).
- [x] `main/model-adapters.ts` : builders claude/codex/gemini (D5/D6),
      helper stdin-fichier POSIX/PowerShell, validation `model`.
- [x] Tests : commandes générées par plateforme, quoting, modèle invalide
      rejeté, fichier de contexte écrit.

### C25 — Compilation + prompts constants + IPC (~1 j) — FAIT
- [x] `main/graph-engine.ts` : 3 system prompts CONSTANTS (chat/merge/juge),
      `compileContext` (linéaire + merge + budget D8), `runInference`
      (fan-out, nœuds erreur, juge).
- [x] IPC `graph:*` + preload + types `DeckApi`.
- [x] Tests : rendu linéaire, rendu merge (tronc unique + sections + system
      merge), budget/élision, prompt juge (étiquettes anonymisées), fan-out
      avec un faux binaire (patron desktop-help).

### C26 — Vue Graph (canvas) (~1,5 j) — FAIT (validation UI restante)
- [x] `GraphView.tsx` : liste de graphes, canvas pan/zoom/drag, nœuds/arêtes,
      sélection + multi-sélection, panneau d'actions, inspecteur de contexte,
      i18n en/fr, styles.
- [x] Rail : `DeckView 'graph'` + entrée NavRail.
- [ ] Validation manuelle au premier lancement réel (pas de test UI).

### C27 — Battle mode (~0,5 j) — FAIT
- [x] UI cibles multiples + toggle battle + cible juge (défaut sonnet).
- [x] Câblage `runInference` battle (déjà côté moteur en C25) + positions en
      éventail + nœud juge stylé (couronne 🏆 / badge « battle »).
- [x] Test : battle avec 1 seule réponse ok → pas de juge (dégradation).

### C28 — Reportés (could, à reconsidérer après usage réel)
- Nœuds **digest** : compression LLM (haiku) d'une branche au-delà du budget,
  recette persistée sur le nœud (rejouable si le budget change).
- Nœuds **artefact** (plan/diff en racine) → le battle devient le « panel de
  review multi-modèles » du PLAN-v0.4.
- Export/import de graphe (JSON), coût par nœud (dépend du reporté OTEL).

## 8. Hors scope (décisions)

- **Sessions persistantes / tools d'écriture dans les nœuds** : contraire à
  D1/D6. Un futur type de nœud « agent » (adossé à une vraie session tuile)
  reste envisageable, mais c'est un autre objet.
- **Layout automatique du DAG** : la démo assume le placement manuel ; un
  auto-layout par colonnes pourra venir après usage.
- **Partage broker / multi-opérateur** : le graphe est un outil opérateur
  local (D7) ; rien n'empêche un export plus tard.

## Journal d'avancement

| Date | Session / auteur | Chantier | Fait | Reste / notes |
|---|---|---|---|---|
| 2026-07-16 | session exploration (graph chat) | — | Brainstorm capture démo + création du plan C23-C28 ; PLAN-v0.4 amendé (le reporté « battle chat » pointe ici). | Implémenter C23 → C27. |
| 2026-07-16 | session exploration (graph chat) | C23-C27 | Lot complet : shared/graph.ts (DAG, linéarisation, mergePartition, parseGraphDoc), graph-store.ts (persistance par project_key), model-adapters.ts (claude/codex/gemini, contexte par fichier, runHelp timeoutMs), graph-engine.ts (3 prompts constants, compilation linéaire/merge, budget + élision, fan-out allSettled, juge anonymisé + légende), IPC graph:* + preload + types, GraphView.tsx (canvas SVG sans dépendance, pan/zoom/drag, multi-sélection, croisement, connect-parent anti-cycle, inspecteur de contexte, battle UI), i18n en/fr + EN_DEFAULTS, journal kind graph. 35 tests neufs (4 suites), bun test 428/428, smoke check + typecheck node/web verts. Desktop bump 0.9.0. | Validation manuelle UI (C26) au premier lancement réel ; C28 (digest, nœuds artefact, export) reporté. |
