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
- [ ] Table `roadmap_items` (DDL §2.2 : scope `project_key`, **zéro FK vers
      peers/groups**, `tags`/`depends_on` en TEXT JSON, soft delete
      `deleted_at`, index `(project_key, status)`).
- [ ] Routes `POST /roadmap/list` (filtres kind/status/priority),
      `POST /roadmap/upsert` (création sans id / patch partiel avec id,
      timestamps + `updated_by` côté broker), `POST /roadmap/archive` —
      même middleware Bearer que l'existant.
- [ ] Types `RoadmapItem`, `RoadmapKind/Priority/Level/Status` dans
      `shared/types.ts`.
- [ ] Tests `tests/broker-roadmap.test.ts` (via `tests/_helper.ts`) : CRUD,
      filtres, isolation par `project_key`, **indépendance du cycle de vie**
      (purge d'un peer dormant / unregister ne touche pas ses items),
      archive réversible.

### M2 — MCP (`server.ts`)
- [ ] 5 tools : `roadmap_list` (rendu compact : id court, titre, badges),
      `roadmap_get`, `roadmap_add` (défauts : `priority=could`,
      `value=effort=medium`, `status=idea`), `roadmap_update` (patch partiel,
      transitions de statut), `roadmap_archive`.
- [ ] `project_key` : réutiliser `computeProjectKey` (`shared/summarize.ts`) ;
      fallback hash du `git_root`/cwd si pas de remote (§2.1).
- [ ] `created_by`/`updated_by` = peer_id courant, automatique.
- [ ] Paragraphe roadmap dans les instructions MCP (« consulte la roadmap en
      début de tâche, consigne bugs/dette découverts, tiens le statut à jour »).
- [ ] Tests tools (contre broker éphémère).

### M3 — Deck UI
- [ ] Rail de navigation **Agents | Roadmap** : état de vue dans `store.ts`
      + `App.tsx` ; « Agents » = Sidebar + TileArea actuels inchangés.
- [ ] Vue Roadmap : sections MoSCoW (Must/Should/Could/Won't) avec badges
      value/effort colorés + compteurs, second regroupement par statut,
      filtres kind/status, recherche.
- [ ] Panneau détail + formulaire création/édition opérateur
      (`created_by='deck'`), archivage/restauration.
- [ ] Main process : `roadmap-service.ts` (réutilise `resolveBrokerEndpoint`
      de `broker-client.ts`), IPC `roadmap:list|upsert|archive` (`ipc.ts`,
      `preload/index.ts`, `preload/index.d.ts`), polling 5 s quand la vue
      est ouverte.
- [ ] i18n en/fr.

### M4 — Liants
- [ ] « Lancer un agent sur cet item » : pré-remplit le CreateMenu avec un
      prompt C2 (titre + description + critères) et passe l'item
      `in_progress`.
- [ ] Annonce `/announce` optionnelle sur changement opérateur (mégaphone
      v0.3.4).
- [ ] `GET /roadmap/export?project_key=` (JSON versionnable) + commandes
      `bun cli.ts roadmap-export / roadmap-import` (migration local → broker
      central, sauvegarde).

### Done quand
- Un agent crée un item via `roadmap_add` → visible en live dans la Deck.
- Les items survivent à la fermeture de toutes les sessions, au redémarrage
  du broker et de la machine.
- Export/import JSON aller-retour sans perte.
- Suite `bun test` complète verte.

---

## C4 — Worktrees (~1-1,5 j)

**Objectif** : une session = un dossier + une branche ; parallélisme réel de
plusieurs agents sur le même repo (design §5).

### Jalons
- [ ] `desktop/src/main/worktree-service.ts` :
      `git worktree add <projet>/.worktrees/<nom> -b agent/<nom>`, `list`,
      `remove` — **jamais** de suppression automatique de branche.
- [ ] Option « dans un nouveau worktree » du `CreateMenu.tsx` (nom de branche,
      défaut dérivé du nom de session) ; cwd de la session = worktree.
- [ ] Badge branche `⎇` sur la ligne de session (`Sidebar.tsx`).
- [ ] À la fermeture de tuile : dialog « supprimer aussi le worktree ? »
      (ConfirmDialog existant), jamais automatique.
- [ ] Hook post-création configurable (ex. `bun install` / `npm install`).
- [ ] Doc : recommander `.worktrees/` dans le `.gitignore` des projets.
- [ ] Tests bun sur repo git jetable : add/list/remove, collision de branche,
      repo sans remote.

### Done quand
- 2 agents sur 2 worktrees du même repo travaillent sans se marcher dessus.
- La roadmap (C3) est partagée entre worktrees (même `project_key`).

---

## C5 — Session superviseur (~4-5 j) → v0.5.0

**Objectif** : rail **Home** avec une session Claude « chapeau » qui pilote
la Deck (spawn d'agents profilés, worktrees, templates) sans coder elle-même ;
coordination des agents via la messagerie peers existante (design §6).

### Jalons
- [ ] Endpoint de contrôle HTTP loopback dans le main Electron : port
      aléatoire, Bearer token régénéré à chaque lancement, exposant
      `SessionService`, `listAgents` (`agents.ts`), `template-store.ts`,
      worktree-service (C4).
- [ ] Serveur MCP stdio `deck-control` (style `server.ts`) : tools
      `deck_list_agents`, `deck_list_models`, `deck_list_presets`,
      `deck_spawn_session` (agent/model/effort/cwd/worktree/initial_prompt),
      `deck_list_sessions`, `deck_restart_session`, `deck_close_session`,
      `deck_create_worktree`, `deck_list_worktrees`, `deck_remove_worktree`,
      `deck_list_templates`, `deck_apply_template`, `deck_save_template`,
      `deck_announce`.
- [ ] Injection sélective : seule la tuile superviseur est lancée avec le
      `--mcp-config` généré (+ env URL/token) — les agents normaux ne voient
      jamais `deck-control`.
- [ ] Rail **Home** : tuile superviseur pleine largeur, spawnée à la première
      visite, absente de la liste « Agents » mais peer visible du groupe.
- [ ] Profil d'agent du superviseur sélectionnable (Settings, scan
      `.claude/agents` projet + `~/.claude/agents`) ; défaut
      `deck-supervisor.md` embarqué dans `deck-plugin/` (« tu pilotes la
      Deck ; tu ne codes pas ; deck_* pour l'app, roadmap_* pour le backlog,
      send_message pour coordonner »).
- [ ] Garde-fous : opérations destructives limitées aux objets créés par le
      superviseur, sinon ConfirmDialog opérateur ; plafond de spawn (8) ;
      token jamais écrit dans le repo/config projet.
- [ ] Tests : endpoint (auth, tools), injection sélective, garde-fous.

### Done quand
- Scénario cible : « Reprends le développement du repo » → le superviseur lit
  la roadmap (`roadmap_list`), liste les profils (`deck_list_agents`), crée
  des worktrees, spawne dev/reviewer avec prompts initiaux, et coordonne par
  `send_message` — le tout observable dans la Deck.

---

## Hors scope (décisions §2.6)

Ideation dédiée (devient un simple prompt d'agent + `roadmap_add` après C3),
Insights, Changelog généré, mémoire Graphiti, sync GitHub/GitLab/Linear
(le modèle garde la porte ouverte via `tags` / futur `external_url`).
