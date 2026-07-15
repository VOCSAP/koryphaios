# PLAN v0.4+ — Roadmap, worktrees, superviseur, auto-relance quota

> **Document de travail multi-sessions.** Le design et les décisions
> d'architecture vivent dans [`EXPLORATION-roadmap-et-auto-relance.md`](./EXPLORATION-roadmap-et-auto-relance.md)
> (référencé ci-dessous par §) — ce fichier ne les re-explique pas, il pilote
> l'exécution.
>
> **Règles d'usage** (pour l'opérateur et les sessions Claude qui reprennent
> le travail) :
> - Lire ce fichier en début de session ; cocher les jalons et compléter le
>   **journal d'avancement** en fin de session.
> - Un chantier = une branche/PR dédiée ; ce plan est mis à jour dans la même
>   PR que le code qu'il suit.
> - Respecter l'ordre C1 → C5 sauf décision contraire notée au journal
>   (chaque chantier rend le suivant plus utile ; C2 est prérequis de C3-M4
>   et C5 ; C4 est prérequis de C5).
> - Vérifs systématiques avant commit : `bun test`, smoke check
>   `bun build --target=bun broker.ts server.ts cli.ts --outdir=/tmp/cp-check`,
>   `npm run typecheck` dans `desktop/`.

---

## Journal d'avancement

| Date | Session / auteur | Chantier | Fait | Reste / notes |
|---|---|---|---|---|
| 2026-07-14 | exploration initiale | — | Exploration + design validés, création du plan | Démarrer C1 |
| 2026-07-14 | session exploration (suite) | C1 | C1 complet : quota.ts, branchement session-service, toggle global + override par session, IPC session:quota, dot orange + badge + toast, i18n en/fr, 16 tests fixtures. bun test 280/280, typecheck node+web verts. Desktop bump 0.3.5. | C1 à valider à la main sur un vrai épisode de limite (test end-to-end impossible en CI). Ensuite : C2. |
| 2026-07-14 | session exploration (suite) | C2 | C2 complet : prompt positionnel au spawn frais (quotePromptArg par plateforme), SessionDef.prompt persisté, champ « Prompt initial » + presets câblés dans CreateMenu, i18n, 5 tests. bun test 285/285, typecheck verts. | Vérif visuelle du champ au prochain lancement de l'app. Ensuite : C3 (roadmap, M1 broker). |
| 2026-07-14 | session exploration (suite) | C3-M1/M2 | Table roadmap_items + routes /roadmap/list\|upsert\|archive (8 tests) ; 5 tools MCP roadmap_* dans server.ts (préfixes d'id, fallback project_key local:) + instructions agents. bun test 293/293, tsc core vert. | M3 (UI Deck) puis M4 (liants). |
| 2026-07-14 | session exploration (suite) | C3-M3/M4 | Rail Agents\|Roadmap + RoadmapView (MoSCoW, CRUD, détail, poll 5 s), roadmap-service.ts (project_key miroir de server.ts) + IPC, « Lancer un agent sur cet item » (prompt C2 + in_progress + annonce), export/import JSON + cli roadmap-export/import. Versions bump 0.4.0 (core + desktop). | C3 code complet ; vérif visuelle UI au premier lancement réel. Ensuite : C4 (worktrees). |
| 2026-07-14 | session exploration (suite) | C4 | worktree-service.ts (add/list/remove, jamais force ni suppression de branche), champ branche du menu avancé (création côté IPC, cwd = worktree), badge ⎇, dialog de nettoyage à la fermeture, hook worktreeInit en arrière-plan, 6 tests repo jetable. | Vérif manuelle 2 agents / 2 worktrees. Ensuite : C5 (superviseur). |
| 2026-07-14 | session exploration (suite) | C5 | deck-control.ts (endpoint loopback + garde-fous ownership/cap), MCP stdio sans dépendance (build:mcp -> deck-plugin/mcp), supervisor.ts (--mcp-config généré + briefing C2), rail Home + HomeView (spawn lazy), profil sélectionnable Settings, filtres Agents/tuiles, 5 tests dont MCP stdio de bout en bout. Desktop bump 0.5.0. **Tous les chantiers C1-C5 sont codés.** | Validations manuelles restantes (C1 épisode réel, C3 UI, C4 2 worktrees, C5 scénario cible) au premier lancement réel de l'app. |
| 2026-07-14 | session exploration (suite) | — | Exploration C6/C7/C8 (EXPLORATION §7) : vue Worktrees, import de plan par agent one-shot, harness superviseur via --append-system-prompt-file (vérifié doc CC). **Dogfooding réel de C3** : items C6/C7/C8 créés via les tools roadmap_* de cette session (broker auto-spawné) puis exportés par `cli.ts roadmap-export` → `roadmap-seed-v0.6.json` (re-keyé github.com/vocsap/claude-peers-mcp), importable sur ton poste : `bun cli.ts roadmap-import roadmap-seed-v0.6.json`. | Prochain chantier au choix : C6 ou C7 (C8 traité). |
| 2026-07-14 | session exploration (suite) | C8 | Verrouillage du harness superviseur (décision sécurité opérateur) : SUPERVISOR_SYSTEM_PROMPT constante code ancrée via --append-system-prompt-file (fichier régénéré à chaque spawn, écrasé si trafiqué, re-passé au resume), retrait de l'option supervisorAgent de Settings, prompt d'import C7 verrouillé par la même règle. bun test 313/313. | C6 (vue Worktrees) et C7 (import de plan) restent à implémenter. |
| 2026-07-14 | session exploration (suite) | C9 | Bouton d'aide flottant : help-assistant.ts (claude -p jetable, system prompt constante code + snapshot de la vue, --strict-mcp-config + --disallowedTools = lecture seule technique, marqueur anti-bruit de profil), popup de chat HelpAssistant.tsx, options Settings + clic droit (toggle, modèle défaut haiku), 8 tests dont faux binaire claude. | Validation manuelle : réponse ancrée dans la vue Roadmap au premier lancement réel. Restent : C6, C7. |
| 2026-07-14 | session exploration (suite) | — | Brainstorm orchestrateur consigné (EXPLORATION §7.5) : chantiers C10-C19 au PLAN (team-lead, attention, inbox opérateur, diff/review, journal, file->lead, checkpoints, digest, composeur templates, hardening launchCommand) + reportés (battle chat, OTEL, GitHub sync) et écartés (presets permissions). | Implémentation autonome : C6 -> C7 -> C10 -> ... -> C19. |

---

## C1 — Auto-relance quota (~1-2 j) → v0.3.5

**Objectif** : une session bloquée par la limite d'usage reprend seule à
l'heure de reset annoncée (design §3, mécanisme hérité de henryaj/autoclaude).

### Jalons
- [x] `desktop/src/main/quota.ts` : `QuotaDetector` sur le modèle de
      `thinking.ts` — buffer glissant ~4 Ko ANSI-strippé par session,
      3 familles de regex (« hit your limit … resets 10pm »,
      « limit reached ∙ resets 2pm », « resets Nm ») + fallbacks prudents à
      word-boundaries ; parsing reset : `3pm` / `10:30am` / `3 pm` en heure
      locale, passé > 1 h → +24 h, variante minutes → now+N, inconnu →
      réessai périodique 15 min.
- [x] Branchement `session-service.ts` : feed sur `pty.on('data')` à côté du
      `ThinkingDetector` ; à l'échéance, re-vérifier l'état rate-limited puis
      injecter `pty.write('\x1b')` → 100 ms → `write('continue')` →
      `write('\r')` ; **un seul envoi par épisode** (flag réarmé sur nouvel
      épisode) ; clear sur exit/remove.
- [x] Opt-in : toggle global dans `AppConfig` (`desktop/src/shared/types.ts`
      + `SettingsView.tsx`) + override par session (ContextMenu de
      `Sidebar.tsx`). **Défaut : off.**
- [x] UI : IPC `session:quota` (même patron que `session:thinking` dans
      `ipc.ts` / `preload/index.ts` / `store.ts`), dot orange `rate-limited`
      + badge « reprise à HH:MM » (sidebar + tuile), toast à la relance,
      i18n `desktop/locales/en.json` / `fr.json` (+ `EN_DEFAULTS` de
      `main/i18n.ts`).
- [x] Tests bun à fixtures (vrais écrans de limite, dont le menu
      `/rate-limit-options`) : détection, parsing des heures, cas limites
      (12am/12pm, passé <1 h), one-shot par épisode, message coupé entre
      deux chunks PTY — `tests/desktop-quota.test.ts` (16 cas).

### Done quand
- [ ] Une session limitée avec le toggle on reprend seule à l'heure annoncée
      (**validation manuelle opérateur** sur un vrai épisode de limite).
- [x] Toggle off = comportement strictement identique à aujourd'hui
      (état/injection entièrement gardés par le flag).
- [x] `bun test` (280/280) + typecheck desktop (node+web) verts.

---

## C2 — Prompt initial au spawn (~0,5 j)

**Objectif** : pouvoir attacher un prompt de démarrage à une création de
session (design §6.4) — débloque les presets M5, « Lancer un agent sur cet
item » (C3-M4) et le superviseur (C5).

### Jalons
- [x] `CreateSessionInput.prompt` + `SessionDef.prompt` dans
      `desktop/src/shared/types.ts` (persisté : un restart frais d'une session
      expirée jamais utilisée rejoue le prompt ; un resume jamais).
- [x] `session-command.ts` : argument positionnel sur le spawn **frais
      uniquement**, ajouté en dernier ; quoting single-quote par plateforme
      (`quotePromptArg` : POSIX `'\''`, PowerShell `''` — inerte pour `$`,
      backticks et retours à la ligne dans les deux shells).
- [x] `session-service.ts` : `input.prompt` → `def.prompt` →
      `buildSessionCommandLine` (branche fraîche).
- [x] `LaunchPreset.prompt` câblé dans `CreateMenu.tsx` (pré-remplit le champ,
      dernier preset gagnant) + champ « Prompt initial » libre (textarea),
      i18n en/fr + EN_DEFAULTS.
- [x] Tests `buildSessionCommandLine`/`quotePromptArg` dans
      `tests/desktop-launch.test.ts` : position, apostrophes/`$`/backticks/
      newlines, quoting win32, resume sans prompt, prompt vide.

### Done quand
- [x] Un preset avec `prompt` ouvre une session qui démarre sur ce prompt
      (pré-rempli menu avancé → arg positionnel ; à confirmer visuellement).
- [x] Un resume ne rejoue jamais le prompt initial (testé).

---

## C3 — Roadmap partagée (~5-6 j) → v0.4.0

**Objectif** : backlog persistant par projet (feature/bug/dette/idée, MoSCoW,
value/effort), stocké broker, manipulé par les agents via MCP, visualisé et
édité dans la Deck (design §2 ; DDL et indépendance du cycle de vie : §2.2).

### M1 — Broker
- [x] Table `roadmap_items` (DDL §2.2 : scope `project_key`, **zéro FK vers
      peers/groups**, `tags`/`depends_on` en TEXT JSON, soft delete
      `deleted_at`, index `(project_key, status)`).
- [x] Routes `POST /roadmap/list` (filtres kind/status/priority/tag),
      `POST /roadmap/upsert` (création avec défauts / patch partiel avec id ;
      un statut ≠ archived restaure un item archivé), `POST /roadmap/archive`
      — même middleware Bearer que l'existant.
- [x] Types `RoadmapItem`, `RoadmapKind/Priority/Level/Status` + requêtes/
      réponses dans `shared/types.ts`.
- [x] Tests `tests/broker-roadmap.test.ts` (8 cas) : CRUD + défauts, enums,
      filtres + isolation par `project_key`, archive réversible,
      **indépendance du cycle de vie** (l'unregister de l'auteur ne touche
      pas ses items).

### M2 — MCP (`server.ts`)
- [x] 5 tools : `roadmap_list` (vue groupée MoSCoW, ids courts 8 chars),
      `roadmap_get`, `roadmap_add` (défauts : `priority=could`,
      `value=effort=medium`, `status=idea`), `roadmap_update` (patch partiel,
      transitions de statut), `roadmap_archive`. Résolution d'id par préfixe
      unique.
- [x] `project_key` : `computeProjectKey` existant ; fallback stable
      `local:<sha256(git_root||cwd)[:16]>` si pas de remote (§2.1).
- [x] `created_by`/`updated_by` = peer_id courant, automatique.
- [x] Paragraphe roadmap dans les instructions MCP (« consulte la roadmap en
      début de tâche, consigne bugs/dette découverts, tiens le statut à jour »).
- [x] Tests : la logique serveur est couverte par les tests broker (M1) ; les
      handlers MCP sont des wrappers fins, même convention que les tools
      messagerie existants (pas de test MCP-stdio dédié dans le repo).

### M3 — Deck UI
- [x] Rail de navigation **Agents | Roadmap** (`NavRail.tsx`, état `view` dans
      `store.ts`, `App.tsx`) ; « Agents » = Sidebar + TileArea inchangés,
      **maintenus montés** (display:none) pour garder les xterm/PTY vivants.
- [x] Vue Roadmap (`RoadmapView.tsx`) : sections MoSCoW avec badges
      value/effort/statut colorés + compteurs, filtre kind, toggle archivés.
      (Recherche plein-texte : reportée, non bloquante.)
- [x] Panneau détail + formulaire création/édition opérateur
      (`created_by='deck'`), archivage (ConfirmDialog) / restauration.
- [x] Main process : `roadmap-service.ts` (réutilise `resolveBrokerEndpoint`,
      miroir du project_key de server.ts, remote normalisé + fallback
      `local:`), IPC `roadmap:list|upsert|archive`, polling 5 s quand la vue
      est visible. Tests `tests/desktop-roadmap-service.test.ts` (6 cas dont
      la cohérence du project_key avec le core et l'aller-retour broker réel).
- [x] i18n en/fr + EN_DEFAULTS (~55 clés).

### M4 — Liants
- [x] « Lancer un agent sur cet item » : bouton du panneau détail → CreateMenu
      pré-rempli (prompt C2 composé de l'item + annonce d'arrivée « works on
      roadmap item: … ») ; l'item passe `in_progress` au spawn et l'agent est
      chargé de tenir le statut via ses tools roadmap ; bascule sur la vue
      Agents.
- [x] Annonce au groupe : couverte par l'annonce d'arrivée pré-remplie du flux
      « Lancer un agent » (décision : pas de checkbox d'annonce sur chaque
      édition opérateur — bruit sans valeur ; reconsidérer si besoin réel).
- [x] `GET /roadmap/export?project_key=` (JSON versionnable, archivés inclus)
      + `POST /roadmap/import` (ids/timestamps/auteurs préservés, re-keying
      supporté) + commandes `bun cli.ts roadmap-export / roadmap-import` ;
      le CLI envoie désormais le Bearer token configuré.

### Done quand
- [ ] Un agent crée un item via `roadmap_add` → visible en live dans la Deck
      (**validation manuelle opérateur** au premier lancement réel).
- [x] Les items survivent à la fermeture de toutes les sessions, au redémarrage
      du broker et de la machine (testé : unregister de l'auteur, base fichier).
- [x] Export/import JSON aller-retour sans perte (testé, y c. idempotence).
- [x] Suite `bun test` complète verte.

---

## C4 — Worktrees (~1-1,5 j)

**Objectif** : une session = un dossier + une branche ; parallélisme réel de
plusieurs agents sur le même repo (design §5).

### Jalons
- [x] `desktop/src/main/worktree-service.ts` : `createWorktree`
      (`git worktree add <projet>/.worktrees/<nom> -b <branche>`),
      `listWorktrees` (--porcelain), `removeWorktree` — **jamais** de
      suppression de branche, **jamais** de --force (le refus git sur un
      worktree sale est remonté tel quel).
- [x] Champ « Branche de worktree » du menu avancé `CreateMenu.tsx`
      (placeholder `agent/<nom>`, vide = pas de worktree ; exclusif avec le
      dossier custom) ; le worktree est créé dans le handler IPC
      `sessions:create` puis cwd de la session = worktree.
- [x] Badge branche `⎇` dans le sous-titre de la ligne (`Sidebar.tsx`),
      `SessionDef.worktree = { path, branch }` persisté.
- [x] À la fermeture de tuile : second ConfirmDialog « supprimer aussi le
      worktree ? », jamais automatique ; toast si git refuse.
- [x] Hook post-création `worktreeInit` (launch config globale/locale,
      ex. `bun install`) exécuté en arrière-plan, jamais bloquant ; préservé
      par la sauvegarde Settings.
- [x] Doc : `.worktrees/` à gitignorer (README desktop + help du champ).
- [x] Tests `tests/desktop-worktree.test.ts` (6 cas) sur repo jetable :
      create/list/remove, collision de branche, worktree sale refusé,
      main tree refusé, sanitisation des noms.

### Done quand
- [ ] 2 agents sur 2 worktrees du même repo travaillent sans se marcher
      dessus (**validation manuelle opérateur**).
- [x] La roadmap (C3) est partagée entre worktrees (même `project_key`,
      dérivé du remote — identique dans tous les worktrees par construction).

---

## C5 — Session superviseur (~4-5 j) → v0.5.0

**Objectif** : rail **Home** avec une session Claude « chapeau » qui pilote
la Deck (spawn d'agents profilés, worktrees, templates) sans coder elle-même ;
coordination des agents via la messagerie peers existante (design §6).

### Jalons
- [x] Endpoint de contrôle HTTP loopback (`deck-control.ts`, injecté/testable) :
      port aléatoire, Bearer token par lancement, un endpoint `POST /call`
      dispatchant vers SessionService / agents / templates / worktrees /
      announce.
- [x] Serveur MCP stdio `deck-control` **sans dépendance**
      (`desktop/mcp/deck-control-mcp.ts`, JSON-RPC newline-delimited, buildé en
      `deck-plugin/mcp/deck-control-mcp.mjs` par `npm run build:mcp`, exécuté
      par le binaire Electron en mode Node — fonctionne packagé comme en dev) :
      14 tools `deck_*` (agents/models/presets, spawn avec
      agent/model/effort/prompt/worktree_branch/announce, list/restart/close
      sessions, create/list/remove worktrees, templates list/apply/save,
      announce).
- [x] Injection sélective : seule la tuile superviseur reçoit le
      `--mcp-config` généré (`supervisor.ts`, env URL/token par serveur MCP) ;
      re-passé au resume (comme `--effort`) ; superviseur exclu de la capture
      workspaces/templates (le token ne vit qu'un lancement d'app).
- [x] Rail **Home** : tuile superviseur pleine largeur (`HomeView.tsx`,
      maintenue montée), spawn lazy à la première visite (bouton manuel après
      une fermeture volontaire), absente de la liste Agents et de la grille,
      mais peer visible du groupe.
- [x] Profil d'agent sélectionnable (Settings > Général, scan
      `.claude/agents`) **par-dessus** un briefing intégré livré en prompt
      initial C2 (décision : briefing C2 + instructions du MCP plutôt qu'un
      `deck-supervisor.md` embarqué — pas de dépendance au support des agents
      de plugin, comportement garanti).
- [x] Garde-fous : destructif limité aux objets créés par le superviseur
      (Sets ownership dans deck-control), apply_template append-only, plafond
      de 8 sessions vives au spawn, token hors repo/config/env global.
- [x] Tests `tests/desktop-deck-control.test.ts` (5 cas) : auth 401, dispatch,
      ownership close/remove, spawn cap, fichier --mcp-config, et aller-retour
      MCP stdio réel (initialize/tools list/tools call/refus gardé).

### Done quand
- [ ] Scénario cible : « Reprends le développement du repo » → le superviseur
      lit la roadmap, liste les profils, crée des worktrees, spawne
      dev/reviewer briefés et coordonne par `send_message`
      (**validation manuelle opérateur** au premier lancement réel).

---

## C6 — Vue Worktrees dans le rail (~1 j) → v0.6

**Objectif** : voir et gérer les worktrees que les agents utilisent —
notamment les orphelins qui s'accumulent après fermeture des tuiles
(design : EXPLORATION §7.1).

### Jalons
- [ ] `worktree-service.ts` : `worktreeStatus(path)` — sale ?
      (`git status --porcelain`), dernier commit (sujet + date).
- [ ] IPC `worktree:list` (liste + statut + session Deck attachée par match
      de cwd) ; DeckApi + preload.
- [ ] `WorktreesView.tsx` (4ᵉ vue du rail) : lignes branche/chemin/session/
      état, orphelins mis en évidence, actions créer / ouvrir une session
      dedans (cwd = worktree, reprise d'orphelin) / supprimer (ConfirmDialog,
      jamais forcé) / copier le chemin. i18n en/fr + EN_DEFAULTS.
- [ ] Tests : worktreeStatus sur repo jetable (propre/sale), match session.

### Done quand
- [ ] Un worktree orphelin est visible, reprenable (nouvelle session dedans)
      et supprimable depuis la vue.

## C7 — Import d'un plan → briques roadmap (~0,5-1 j) → v0.6

**Objectif** : bouton « Importer un plan » (fichiers de plan générés par
Claude Code) qui crée les items roadmap correspondants. **Décision : pas de
parseur déterministe** — extraction et jugement kind/priority/value/effort
délégués à un agent one-shot (EXPLORATION §7.2).

### Jalons
- [ ] Bouton « Importer un plan » dans l'en-tête de `RoadmapView.tsx` →
      `dialog.showOpenDialog` (fichier .md) via IPC.
- [ ] Prompt d'import : **constante dans le code de l'app** (décision C8 —
      jamais un template configurable, pour éviter tout détournement) :
      lire le fichier, `roadmap_add` par item (tags `import` + nom du plan,
      depends_on évidents), résumé, `/exit` (la tuile s'auto-ferme, v0.3.3).
- [ ] Spawn de l'agent one-shot via le create existant (C2) ; bascule vue
      Agents pour l'observer ; i18n.
- [ ] Test : composition du prompt (pur) ; le flux complet reste une
      validation manuelle (agent réel).

### Done quand
- [ ] Importer `PLAN-v0.4.md` produit des items cohérents dans la vue.

## C8 — Harness superviseur **verrouillé** (~0,5 j) — FAIT

**Objectif révisé** (décision sécurité opérateur, EXPLORATION §7.3) : ancrer
le rôle du superviseur au niveau **system prompt**, mais depuis des
**constantes du code uniquement** — aucun fichier opérateur/repo, aucun
profil d'agent : une personnalisation permettrait à un repo cloné de
détourner silencieusement la session qui pilote l'app.

### Jalons
- [x] `SUPERVISOR_SYSTEM_PROMPT` (constante code, avec consigne de refus de
      détournement) + `writeSupervisorSystemPrompt()` : fichier généré dans
      l'app-state et **réécrit à chaque spawn** (un fichier trafiqué est
      écrasé).
- [x] `appendSystemPromptFile` dans `session-command.ts` (même patron que
      `mcpConfig` : émis sur frais ET resume) + `SessionDef` + spawn
      superviseur.
- [x] **Retrait** de l'option `supervisorAgent` de Settings (livrée en C5,
      invalidée par la décision : un profil d'agent remplace le system
      prompt).
- [x] C7 verrouillé par la même règle : le prompt de l'agent d'import sera
      une constante du code (jalon reformulé dans C7).
- [x] Tests : flags frais + resume (`desktop-launch`), régénération du
      fichier écrasant une altération (`desktop-deck-control`).

### Done quand
- [x] Le rôle du superviseur est défini exclusivement par le code de l'app,
      ancré au system prompt, ré-ancré à chaque spawn/resume.

---

## C9 — Bouton d'aide flottant « ? » (~1 j) — FAIT

**Objectif** : un assistant de compréhension/décision contextuel (« quelle
brique traiter ? », « à quoi sert cette vue ? ») en invocations `claude -p`
jetables, **sans toucher au contexte du superviseur** (EXPLORATION §7.4).

### Jalons
- [x] `help-assistant.ts` : system prompt = **constante du code** (règle C8)
      + vue active + instantané JSON composé par l'app ; commande `claude -p`
      via le shell de login (marqueur de démarrage strippant le bruit des
      profils du stdout) ; continuité popup par rejeu des 4 derniers échanges.
- [x] Lecture seule **technique** : `--strict-mcp-config` (zéro MCP chargé)
      + `--disallowedTools` Bash/Edit/Write/Task/Web... (Read/Grep/Glob
      restent pour ancrer les réponses dans le repo) + consigne « tu ne peux
      pas agir » dans le prompt.
- [x] IPC `help:ask` — snapshot **multi-vues** (roadmap_items compacts +
      description tronquée, sessions, git_worktrees ; chaque partie dégrade
      en note d'erreur), vue active signalée : une question roadmap posée
      depuis la vue Agents reste ancrée. Les données viennent de l'app (mêmes
      lectures broker/git que les vues), PAS de tools MCP — c'est ce qui rend
      la lecture seule compatible avec des réponses informées.
      `HelpAssistant.tsx` : bouton flottant + popup de chat (transcript
      local, Entrée pour envoyer).
- [x] Options : toggle `helpButton` + modèle `helpModel` (défaut **haiku**)
      dans Settings > Général ET via clic droit sur le bouton (menu
      contextuel : choix du modèle, masquer).
- [x] Tests `tests/desktop-help.test.ts` (8 cas) : prompt/troncature/
      transcript, flags de verrouillage, fallback modèle, aller-retour réel
      contre un faux binaire `claude` (dont bruit de profil strippé et
      erreur remontée).

### Done quand
- [ ] Une question posée depuis la vue Roadmap reçoit une réponse ancrée
      dans les items affichés (**validation manuelle opérateur**).

---

## Lot « orchestrateur IA » (décisions EXPLORATION §7.5) — ordre d'implémentation

Ordre logique : C6 → C7 → C10 (fondation team-lead) → C11 → C12 → C13 →
C14 → C15 → C16 → C17 → C18 → C19. C10 est prérequis de C15/C18 et du volet
notification de C6/C13.

## C10 — Rôle team-lead + annonce ciblée (~1 j)

**Objectif** : un team-lead désigné par fenêtre, que la Deck peut notifier de
façon ciblée (fondation de C15, C18, et des notifications d'intégration).

### Jalons
- [ ] `SessionDef.lead?: boolean` — source de vérité explicite, capturé dans
      workspaces ET templates ; unicité garantie par `SessionService`
      (désigner dé-désigne l'ancien) ; badge 👑 sidebar.
- [ ] Pose : coche « team-lead » du menu avancé (pré-cochée si le nom
      d'agent/session matche `leadPattern` configurable — défaut `team-lead`
      — ET qu'aucun lead n'existe) + clic droit « désigner comme team-lead ».
- [ ] Broker : `/announce` accepte `to_peer_id?` (annonce ciblée à UN peer du
      groupe, sentinel `deck`, no-reply inchangé) + tests.
- [ ] Deck : `announceToLead(text)` (helper main) — no-op sans lead, sauf
      session active unique (annonce avec mention « aucun team-lead
      désigné »).

## C11 — Détection « a besoin de toi » + notifications système (~1 j)

### Jalons
- [ ] `attention.ts` (patron quota.ts) : détection des écrans d'attente de
      Claude Code (prompt de permission, question, menu de plan) dans le flux
      PTY ; épisode clos dès reprise d'activité.
- [ ] Badge « ⏸ t'attend » (sidebar + tuile) + `Notification` Electron
      (titre = nom de session), throttle par session ; toggle global
      `notifyAttention` (défaut on) dans Settings.
- [ ] Tests fixtures (écrans réels de permission/question).

## C12 — Inbox opérateur (~1-1,5 j)

### Jalons
- [ ] Broker : pair réservé `operator` (`__operator__`, miroir du sentinel
      deck) ; `send_message` vers `operator` route vers ce token dans le
      groupe de l'émetteur ; route `POST /operator-inbox` (group_id +
      secret_hash) qui rend et marque délivrés les messages ; `set_id` refuse
      `operator` ; tests.
- [ ] `server.ts` : instructions MCP — « operator = l'humain devant la Deck ;
      envoie-lui les questions bloquantes ; il ne répond pas par ce canal ».
- [ ] Deck : poll de l'inbox (10 s), panneau inbox (badge non-lus sur le
      rail) + notification système par message ; réponse de l'opérateur via
      mégaphone/annonce ciblée existants.

## C13 — Vue Diff / Review (~2 j)

### Jalons
- [ ] `diff-service.ts` : `git status --porcelain` + `git diff` (+ diff vs
      branche principale pour un worktree) parsés, par session/worktree.
- [ ] Panneau Diff (depuis la vue Worktrees C6 et le clic droit d'une
      session) : fichiers touchés, +/- ; diff colorisé simple.
- [ ] « Faire relire par un agent » : spawn one-shot (patron C7, prompt
      constante code) qui lit le diff et poste sa review en s'adressant au
      team-lead (C10) s'il existe, sinon en commentaire dans sa tuile.
- [ ] Tests : parse du diff sur repo jetable.

## C14 — Journal d'activité (~0,5-1 j)

### Jalons
- [ ] Accumulateur d'événements dans le main (spawn/exit/quota/attention/
      worktree/annonces/intégrations/dispatch), ring buffer par fenêtre.
- [ ] Vue « Journal » (rail) : fil chronologique filtrable ; export texte.
- [ ] Tests : accumulation + cap du buffer.

## C15 — File d'attente → dispatch au team-lead (~1 j, requiert C10)

### Jalons
- [ ] Roadmap : champ `queue INTEGER NULL` (position en file) — broker +
      types + upsert + tests ; « mettre en file / retirer » dans la vue
      Roadmap (section File d'attente ordonnée).
- [ ] Dispatch : bouton « envoyer le premier au team-lead » + auto-dispatch
      du suivant quand un item en file passe `done` (annonce ciblée C10,
      contenu = item complet, consigne de tenir le statut).
- [ ] Sans lead : bouton grisé avec explication (pas d'auto-magie).

## C16 — Checkpoints git (~0,5 j)

### Jalons
- [ ] Avant tout spawn dans un dossier au working tree sale : `git stash
      create` + `git update-ref refs/claude-peers/checkpoint-<ts>` (aucune
      pollution d'historique ni du working tree) ; entrée journal (C14) avec
      le sha et la commande de restauration.
- [ ] Liste des checkpoints dans la vue Journal ; purge des plus vieux (>7 j).
- [ ] Tests sur repo jetable.

## C17 — Digest de reprise (~1 j)

### Jalons
- [ ] Config **globale uniquement** `digest.sources` (fichiers/globs +
      commandes, résolus/exécutées dans le projectDir) + surcharges
      `digest.perProject[project_key]` ; défauts : snapshot C9 + `PLAN*.md`.
- [ ] `askDigest` : prompt = constante code (règle C8) + snapshot + sorties
      des sources (cap de taille par source) → `claude -p` (patron C9,
      lecture seule technique).
- [ ] UI : bouton « 📋 Résumé de reprise » dans le popup d'aide + entrée de
      menu ; affiché comme un échange du popup.
- [ ] Tests : résolution des sources (globaux/commandes/perProject), caps,
      refus de toute source venant d'une config projet.

## C18 — Composeur de templates (~1,5-2 j, requiert C10)

### Jalons
- [ ] Vue/fenêtre Templates : liste (supprimer/dupliquer) + « créer » /
      « éditer » SANS spawner ; chaque entrée = champs du menu avancé
      (agent, modèle, effort, args, prompt initial, worktree, annonce,
      couleur, coche lead — un seul lead par template).
- [ ] Rendu hiérarchique : lead en haut centré, l'équipe en dessous.
- [ ] À l'application : le lead du template devient celui de la fenêtre s'il
      n'y en a pas déjà.
- [ ] Tests : shape template étendue (lead), round-trip compose→apply.

## C19 — Hardening launchCommand projet (~0,5 j)

### Jalons
- [ ] À la résolution d'un `launchCommand` venant de la config PROJET :
      confirmation opérateur à la première utilisation (dialog), hash
      approuvé mémorisé par project_key dans l'app-state ; refus → fallback
      config globale ; entrée journal.
- [ ] Tests : approbation/refus/changement de commande (hash différent).

---

## Reportés (à ne pas perdre)

- **Battle chat multi-modèles** (could) : N CLIs (claude -p / gemini /
  codex exec) en parallèle + modèle juge ; le squelette technique est C9
  (`runHelp` généralisé en adaptateurs). Variante notée, sans doute plus
  utile : **panel de review multi-modèles** sur un plan/diff plutôt que du
  chat libre. À reconsidérer après le lot orchestrateur.
- **Suivi de consommation** (tokens/coût par session via télémétrie OTEL de
  Claude Code + collecteur local) : utile, infra plus lourde.
- **Sync GitHub Issues ↔ roadmap** : la porte reste ouverte (`tags`, futur
  `external_url`).

## Écartés (décisions)

- **Presets de permissions par profil au spawn** (wont) : les définitions
  d'agents dédiées de l'opérateur portent déjà leurs limites de tools.
- **Parseur déterministe de plans** (C7) : jugement impossible sans LLM.
- **Harness superviseur/import configurable** (C8) : sécurité — constantes
  code uniquement.

---

## Hors scope (décisions §2.6)

Ideation dédiée (devient un simple prompt d'agent + `roadmap_add` après C3),
Insights, Changelog généré, mémoire Graphiti, sync GitHub/GitLab/Linear
(le modèle garde la porte ouverte via `tags` / futur `external_url`).
