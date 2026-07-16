# PLAN — Contexte roadmap, baguette magique, snippets (C20-C22)

> **Document de travail multi-sessions**, même règles que
> [`PLAN-v0.4.md`](./PLAN-v0.4.md) : lire en début de session, cocher les
> jalons, compléter le journal en fin de session, vérifs systématiques avant
> commit (`bun test`, smoke check
> `bun build --target=bun broker.ts server.ts cli.ts --outdir=/tmp/cp-check`,
> `npm run typecheck` dans `desktop/`).
>
> Ce document contient AUSSI le design (brainstorm du 2026-07-16) — il n'y a
> pas de doc d'exploration séparé pour ce lot.

---

## Journal d'avancement

| Date | Session / auteur | Chantier | Fait | Reste / notes |
|---|---|---|---|---|
| 2026-07-16 | session exploration | — | Brainstorm validé par l'opérateur, création du plan. | Implémenter C20 → C21 → C22, livraison en un seul lot. |
| 2026-07-16 | session autonome (même session) | C20, C21, C22 | Lot complet : colonne `context` (migration + upsert + import/export + tools MCP + instructions + dispatch + prompt de lancement + éditeur/détail Deck + snapshot d'aide), prompt d'import C7 ajusté, `context-wand.ts` (constante C8, haiku épinglé, harness C9) + IPC `roadmap:wand` + bouton 🪄, `snippet-store.ts` + IPC + bouton ⚡ ContextMenu + `SnippetsDialog`, i18n en/fr + EN_DEFAULTS, styles. Versions core 0.7.0 / desktop 0.8.0, CHANGELOG + CLAUDE.md. Tests : broker-roadmap-context (4), desktop-snippet-store (5), desktop-context-wand (4), dispatch étendu ; fix du test template-store périmé depuis le rename v0.7.0. bun test 393/393, smoke check + typecheck node/web verts. | Validations manuelles UI au premier lancement réel (🪄 sur un vrai item, insertion ⚡ fill-not-send). |

---

## §1 — Design (brainstorm consigné)

### 1.1 Le problème : le dispatch actuel est insuffisant pour un agent frais

En se projetant comme l'agent qui reçoit un item (dispatch C15 ou « Lancer un
agent sur cet item » C3-M4), il reçoit : titre, kind/priority/value/effort/
status, description, rationale, tags, depends_on — puis `roadmap_get` renvoie
les mêmes champs. En pratique `description` et `rationale` sont courts
(« quoi » et « pourquoi » en une phrase). Ce qui manque systématiquement :

- **critères d'acceptation** — quand est-ce « done » ?
- **frontières de scope** — ce qu'il ne faut *pas* toucher ;
- **pointeurs** — fichiers/modules concernés, pattern existant à imiter ;
- **décisions déjà prises** — approche retenue/écartée hors-session. C'est
  l'info la plus précieuse et la seule que l'agent ne peut PAS retrouver en
  explorant le repo.

Un agent peut re-dériver les pointeurs en explorant (coût en temps/tokens à
chaque item) ; il ne peut jamais re-dériver les intentions de l'opérateur.

### 1.2 Décisions

- **Champ `context` dédié** sur `roadmap_items`, distinct de
  description/rationale. Sémantique : description = quoi, rationale =
  pourquoi, **context = briefing d'implémentation pour l'agent** (objectif,
  contraintes, pointeurs, critères d'acceptation, décisions prises).
  Éditable à la création ET a posteriori.
- **Compatibilité C8** : pas de conflit. La règle C8 verrouille le *cadrage*
  des prompts (constantes code) ; `context` est une *donnée d'item*, au même
  niveau de confiance que description/rationale qui transitent déjà dans le
  dispatch. Il est rendu comme un champ délimité (« Context (operator
  briefing): ... »), jamais comme une instruction qui remplacerait le contrat
  de workflow.
- **Les agents remplissent `context` eux-mêmes** via `roadmap_add`/`
  roadmap_update` (le tool schema + les instructions MCP expliquent comment) :
  l'agent qui découvre un bug écrit le briefing pour le futur agent qui le
  corrigera. C'est le chemin nominal ; la baguette magique (C21) couvre la
  création manuelle par l'opérateur.
- **Baguette magique = `claude -p` harnaché en dur** (patron C9
  help-assistant) : system prompt **constante code** qui force le bon patron
  de briefing (Objective / Constraints / Pointers / Acceptance criteria),
  lecture seule technique (`--strict-mcp-config` + `--disallowedTools`),
  ancré repo (Read/Grep/Glob disponibles, cwd = projectDir), modèle **haiku**
  fixé. Le résultat remplit le textarea, reste éditable, n'est JAMAIS
  auto-sauvé — l'opérateur relit et valide.
- **Fraîcheur** : un contexte généré à la création peut être périmé au
  dispatch (le code a bougé). Pas de mécanisme automatique en v1 ; la
  baguette est re-invocable à tout moment depuis l'éditeur d'item.
- **Snippets = prompts réutilisables**, portée hiérarchique **projet >
  global** (même patron que `template-store.ts` : fichiers dans
  `<globalConfigDir>/snippets` et `<projectDir>/.claude/claude-peers/
  snippets`). Format : un fichier `.md` par snippet (nom de fichier = nom du
  snippet, contenu = le prompt) — éditable à la main, diffable, partageable
  via git côté projet. À nom égal, le projet masque le global.
- **Insertion fill-not-send** : le sélecteur de la tuile insère via
  `term.paste(text)` (bracketed-paste → onData → PTY), ce qui remplit le
  champ de saisie de Claude Code **sans soumettre**. Jamais d'auto-submit :
  un snippet projet versionné est du texte contrôlé par le repo ; l'opérateur
  voit toujours le texte avant d'envoyer.

### 1.3 Reporté (hors lot)

- Raccourci clavier + palette fuzzy pour les snippets (v1 = bouton de tuile).
- Sélecteur de snippets dans la `MessageBar` (annonces) et le champ contexte.
- Variables de snippets (`{branch}`, `{peer}`...) — attendre un besoin réel.
- Horodatage/péremption du contexte généré.
- Actions Deck déterministes pour les rituels (« pause peers » en un bouton) —
  complémentaire des snippets, pas concurrent.

---

## C20 — Champ `context` de bout en bout (~1 j)

**Objectif** : chaque item de roadmap peut porter un briefing
d'implémentation qui suit l'item jusqu'à l'agent (dispatch, launch,
`roadmap_get`), rempli par les agents comme par l'opérateur.

### Jalons
- [x] Broker (`broker.ts`) : colonne `context TEXT NOT NULL DEFAULT ''`
      (CREATE TABLE + migration `ALTER TABLE` idempotente, patron C15) ;
      `handleRoadmapUpsert` (create + patch partiel), `handleRoadmapImport`
      (préservé au round-trip export/import).
- [x] Types : `shared/types.ts` (racine) `RoadmapItem.context` +
      `RoadmapUpsertRequest.context` ; miroir desktop
      `desktop/src/shared/types.ts` (`RoadmapItem`, `RoadmapUpsertFields`).
- [x] `server.ts` : paramètre `context` sur `roadmap_add`/`roadmap_update`
      (description du schema = comment écrire un bon briefing),
      `formatRoadmapItemDetail` l'affiche, instructions MCP (section SHARED
      ROADMAP) demandent de le remplir. Bump version 0.7.0 (core).
- [x] Deck : `composeDispatchText` (dispatch.ts) et `composeItemPrompt`
      (RoadmapView) portent le contexte comme champ délimité ; éditeur d'item
      avec textarea `context` (placeholder semi-structuré Objectif /
      Contraintes / Pointeurs / Critères) ; vue détail l'affiche ;
      `helpSnapshot` (ipc.ts) l'inclut (tronqué) pour l'assistant d'aide.
- [x] i18n en/fr (+ EN_DEFAULTS si applicable).
- [x] Tests : `tests/broker-roadmap-context.test.ts` (défaut '', create,
      patch préserve/écrase, round-trip export/import) ; extension
      `tests/desktop-dispatch.test.ts` (le dispatch porte le contexte).

### Done quand
- [ ] Un item créé avec contexte par un agent (`roadmap_add`) arrive au
      team-lead avec le briefing dans le message de dispatch.
- [x] `bun test` + smoke check + typecheck desktop verts.

---

## C21 — Baguette magique (context wand) (~0,5 j)

**Objectif** : depuis l'éditeur d'item, générer/compléter le champ `context`
par un passage Haiku lecture seule ancré dans le repo — pour les créations
manuelles, sans jamais déposséder l'opérateur (résultat éditable, non sauvé).

### Jalons
- [x] `desktop/src/main/context-wand.ts` : `WAND_SYSTEM_PROMPT` **constante
      code** (règle C8) forçant le patron Objective / Constraints / Pointers /
      Acceptance criteria, sortie = le seul contenu du champ, langue de
      l'item, conservation des décisions du brouillon opérateur ;
      `buildWandPrompt(draft)` ; `WAND_MODEL = 'haiku'` fixé. Réutilise
      `buildHelpCommand`/`runHelp` de `help-assistant.ts`
      (`--strict-mcp-config` + `--disallowedTools`, cwd = projectDir).
- [x] IPC `roadmap:wand` (ipc.ts) + `DeckApi.roadmapWand` (preload/types) :
      entrée = brouillon {title, kind, description, rationale, context},
      champs cappés ; sortie = texte proposé.
- [x] `RoadmapView.tsx` : bouton 🪄 sur le champ contexte de l'éditeur
      (état busy, erreurs dans la zone d'erreur existante) ; le résultat
      remplace la valeur du textarea, sauvegarde uniquement via le bouton
      Save existant.
- [x] i18n en/fr.
- [x] Tests : `tests/desktop-context-wand.test.ts` (patron imposé par le
      system prompt, composition du prompt avec/sans brouillon, caps).

### Done quand
- [ ] Depuis l'éditeur d'un item, 🪄 produit un briefing structuré ancré
      dans les fichiers du projet ; rien n'est écrit au broker sans Save.
- [x] `bun test` + typecheck verts.

---

## C22 — Snippets (prompts réutilisables) (~0,5-1 j)

**Objectif** : écrire une fois les micro-prompts récurrents (« met en pause
les peers, je ferme la session »), les réutiliser depuis chaque tuile en un
clic, portée projet > global.

### Jalons
- [x] `desktop/src/main/snippet-store.ts` (patron `template-store.ts`) :
      dirs `<globalConfigDir>/snippets` + `<projectDir>/.claude/
      claude-peers/snippets`, un `.md` par snippet (safeBase), liste projet
      d'abord + masquage global à nom égal, garde-fous delete (extension +
      dossier autorisé), fichiers > 64 Ko ignorés.
- [x] IPC `snippet:list|save|delete` + `DeckApi.listSnippets/saveSnippet/
      deleteSnippet` (preload/types).
- [x] `TerminalTile.tsx` : bouton ⚡ dans la barre de la tuile → `ContextMenu`
      listant les snippets (projet puis global) + « Gérer... » ; sélection →
      `term.paste(text)` + focus terminal (**fill-not-send**).
- [x] `SnippetsDialog.tsx` : gestion (liste, créer, éditer nom/portée/texte,
      supprimer) ; renommage/changement de portée = write nouveau + delete
      ancien.
- [x] i18n en/fr + styles.
- [x] Tests : `tests/desktop-snippet-store.test.ts` (write/list/ordre/
      masquage/delete gardé/64 Ko).

### Done quand
- [ ] Un snippet global ET un snippet projet apparaissent dans le menu de la
      tuile, s'insèrent dans le champ de saisie de Claude Code sans le
      soumettre ; le projet masque le global à nom égal.
- [x] `bun test` + typecheck verts.

---

## Périmètre transverse du lot

- `import-plan.ts` (C7) : le prompt d'import demande de remplir `context`
  pour chaque item créé (briefing tiré du plan : objectif, contraintes,
  pointeurs cités par le plan, critères, décisions actées) — reste une
  constante code.
- Versions : core `claude-peers` 0.6.0 → 0.7.0 (schéma + tools),
  desktop `koryphaios` 0.7.0 → 0.8.0. CHANGELOG + CLAUDE.md mis à jour.
- Livraison : un seul lot (une PR), branche `claude/roadmap-context-prompts-jmjswu`.
