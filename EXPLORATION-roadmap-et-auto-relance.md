# Exploration : Roadmap partagée, auto-relance quota, worktrees, superviseur

> Document d'exploration (pas un DESIGN figé). Étudie des fonctionnalités vues
> dans des repos publics et leur transposition dans claude-peers / la Deck :
>
> 1. **Roadmap** — saisie / suivi / listing de features, bugs, dette, idées,
>    persistés au fil des sessions, visibles dans la Deck ET manipulables par
>    les agents (inspiré de [B1tMaster/Auto-Claude](https://github.com/B1tMaster/Auto-Claude),
>    fork d'AndyMik90/Aperant).
> 2. **Auto-relance quota** — reprise automatique des sessions bloquées par la
>    limite horaire d'usage (inspiré de [henryaj/autoclaude](https://github.com/henryaj/autoclaude)).
> 3. **Worktrees** (§5) — sessions isolées dans des working trees git séparés.
> 4. **Session superviseur** (§6) — une session Claude Code « chapeau » qui
>    pilote la Deck elle-même (spawn d'agents, worktrees, templates, roadmap).
>
> Recherche effectuée le 2026-07-14 sur les sources des deux repos + le code
> claude-peers v0.3.4.
>
> **Suivi d'exécution** : le plan de travail multi-sessions (jalons,
> checkboxes, journal) vit dans [`PLAN-v0.4.md`](./PLAN-v0.4.md).

---

## 1. Ce que font réellement les deux repos étudiés

### 1.1 Auto-Claude (B1tMaster fork, upstream Aperant) — la Roadmap

Stack : Electron (React/TS, Zustand, XState) + backend **Python** lancé en
sous-processus, agents pilotés par `claude_agent_sdk`. Points factuels vérifiés
dans les sources :

- **Modèle de données** (`shared/types/roadmap.ts`) : une `Roadmap` par projet
  (vision, `targetAudience`, phases, features). Chaque `RoadmapFeature` porte :
  - `priority: 'must' | 'should' | 'could' | 'wont'` — **MoSCoW** (le
    "must have / nice to have" de la capture d'écran) ;
  - `impact: 'low' | 'medium' | 'high'` — la "value" ;
  - `complexity: 'low' | 'medium' | 'high'` — l'effort ;
  - `status: 'under_review' | 'planned' | 'in_progress' | 'done'`,
    `rationale`, `acceptanceCriteria[]`, `userStories[]`, `dependencies[]`,
    `linkedSpecId` (lien vers une tâche Kanban), `taskOutcome` (retour du
    cycle de vie de la tâche vers la roadmap).
  - Pas de champ `kind` bug/dette : chez eux, la roadmap ne contient QUE des
    features ; bugs/dette passent par "Ideation" et le Kanban.
- **Persistance** : fichiers **JSON dans le working tree**
  (`.auto-claude/roadmap/roadmap.json` etc.), pas de base. L'Electron main fait
  la conversion snake_case (disque) ↔ camelCase (TS).
- **Interaction agents ↔ roadmap** : PAS de MCP. L'agent générateur (Python,
  `roadmap_runner.py`) est *prompté* pour écrire `roadmap.json` directement
  avec ses tools fichiers (schéma JSON imposé par le prompt). Leur serveur MCP
  maison n'expose que des tools de progression de tâches. L'édition manuelle
  passe par IPC Electron (`ROADMAP_SAVE`, `ROADMAP_UPDATE_FEATURE`).
- **Roadmap → exécution** : `ROADMAP_CONVERT_TO_SPEC` transforme une feature en
  spec (`.auto-claude/specs/NNN/`) exécutée depuis le Kanban ; la complétion de
  la tâche ré-alimente `taskOutcome` sur la feature.

Autres modules de leur sidebar (cf. capture) : **Kanban Board** (tâches/specs,
colonnes backlog → ai_review → human_review → done), **Ideation** (idées
générées par IA en 3 catégories, convertibles en tâches), **Insights** (chat
codebase), **Changelog** (génération de release notes), **Context** (index
projet + mémoires), **Worktrees** (isolation git par build + merge assisté),
**GitHub/GitLab Issues**, mémoire cross-session (Graphiti).

### 1.2 henryaj/autoclaude — l'auto-relance quota

TUI **Go** (Bubble Tea) qui tourne DANS un pane tmux et surveille les autres
panes de la même fenêtre. Mécanisme vérifié dans les sources — 100 %
scraping d'écran + injection clavier, aucun appel API :

1. **Détection** : toutes les **3 s**, `tmux capture-pane -p` sur chaque pane,
   puis regex sur le texte :
   ```
   (?i)hit\s+your\s+limit.*resets?\s+(\d{1,2}(?::\d{2})?\s*[ap]m)   # "You've hit your limit · resets 10pm (Europe/London)"
   (?i)limit\s+reached.*resets?\s+(\d{1,2}(?::\d{2})?\s*[ap]m)      # "limit reached ∙ resets 2pm"
   (?i)(?:hit\s+your\s+limit|limit\s+reached).*resets?\s+(\d{1,3})m\b  # "Limit reached (resets 8m)"
   ```
   + fallbacks sans capture d'heure (`you've hit your limit`, `limit reached`,
   `rate limited`).
2. **Quand relancer** : l'heure de reset est parsée depuis le message même
   (formats `3pm`, `10:30am`, variante "minutes" = now+N ; heure passée de
   plus d'1 h → +24 h ; timezone imprimée ignorée, heure locale supposée).
   Si l'heure est inconnue (fallback) → retente toutes les **15 min**.
3. **Relance** : le process Claude Code reste vivant à son prompt ; l'outil
   injecte `Escape` (ferme le menu `/rate-limit-options`), attend 100 ms, tape
   le mot littéral **`continue`**, puis `Enter`. Pas de `--resume`, pas de
   redémarrage de process. Un seul envoi par épisode de limite
   (flag `ContinueSent`, réarmé quand un nouvel épisode commence).
4. **Opt-in par pane** (off par défaut), toggle au clavier.

---

## 2. Proposition A — Roadmap dans claude-peers + Deck

### 2.1 Décision structurante : où vivent les données ?

| Option | Pour | Contre |
|---|---|---|
| **A. Broker (SQLite + endpoints HTTP + tools MCP)** — recommandé | Concurrence sérialisée (N agents qui CRUD en même temps) ; les sessions ont DÉJÀ le serveur MCP claude-peers branché (zéro config en plus) ; la Deck a déjà un `broker-client` HTTP ; partage multi-PC en mode HTTP ; push WS possible | Données hors du repo git (hors historique) ; en mode local, base par machine |
| B. Fichier JSON dans le repo (modèle Auto-Claude, `.claude-peers/roadmap.json`) | Versionné git, portable, lisible sans outillage | Écritures concurrentes de N agents = corruption/conflits ; la Deck devrait faire du file-watching ; pas de multi-PC sans push/pull |
| C. Nouveau serveur MCP dédié | Séparation des responsabilités | Un process de plus par session, une entrée `.mcp.json` de plus, et il faudrait de toute façon un stockage partagé derrière (= le broker) |

**Recommandation : Option A.** Notre scénario central — plusieurs agents d'une
même Deck qui créent/modifient des items pendant que l'opérateur les regarde —
est exactement ce que le broker sait déjà faire (sérialisation SQLite, HTTP,
auth Bearer, WS). L'option B reste disponible plus tard comme **export/import
JSON** (versionner un instantané dans le repo), le meilleur des deux mondes.

**Scope des items : `project_key`, pas `group_id`.** Les groupes de la Deck
sont éphémères (secret random par fenêtre) — une roadmap scopée groupe
disparaîtrait à chaque relance. Le broker reçoit déjà `project_key` (remote
git normalisé, ex. `github.com/vocsap/claude-peers-mcp`) à chaque `/register`
et sait matcher deux clones du même repo sur deux PC. La roadmap d'un projet
est donc partagée par toutes les sessions travaillant sur ce repo, quel que
soit leur groupe. Fallback quand il n'y a pas de remote git : hash du
`git_root`/cwd (même logique que le reste du code). En mode HTTP,
`broker_token` protège l'accès comme pour le reste.

### 2.2 Modèle de données proposé

Adapté d'Auto-Claude, aplati (pas de phases/milestones en v1) et étendu avec
`kind` (demande explicite : feature / bug / dette / idée) :

```ts
type RoadmapKind     = 'feature' | 'bug' | 'debt' | 'idea' | 'chore'
type RoadmapPriority = 'must' | 'should' | 'could' | 'wont'      // MoSCoW
type RoadmapLevel    = 'low' | 'medium' | 'high'                 // value & effort
type RoadmapStatus   = 'idea' | 'planned' | 'in_progress' | 'done' | 'archived'

interface RoadmapItem {
  id: string                 // uuid, immuable
  project_key: string        // scope (remote git normalisé)
  kind: RoadmapKind
  title: string
  description: string        // markdown libre
  rationale: string          // pourquoi / valeur métier ("value" texte)
  priority: RoadmapPriority
  value: RoadmapLevel        // impact (leur "impact")
  effort: RoadmapLevel       // complexité (leur "complexity")
  status: RoadmapStatus
  tags: string[]             // libre ("ui", "broker", "v0.4"...)
  depends_on: string[]       // ids d'autres items
  created_by: string         // peer_id ou 'deck' (opérateur)
  updated_by: string
  created_at: number
  updated_at: number
}
```

**Format physique** : une table dans la base SQLite existante du broker
(`bun:sqlite`, WAL — `/var/lib/claude-peers/peers.db` sur Linux/macOS,
`~/.claude-peers.db` sur Windows, surchargable via `CLAUDE_PEERS_DB` /
`config.json`). Un item = une ligne ; `tags` et `depends_on` en colonnes TEXT
JSON :

```sql
CREATE TABLE IF NOT EXISTS roadmap_items (
  id          TEXT PRIMARY KEY,          -- uuid
  project_key TEXT NOT NULL,
  kind        TEXT NOT NULL,             -- feature|bug|debt|idea|chore
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  rationale   TEXT NOT NULL DEFAULT '',
  priority    TEXT NOT NULL DEFAULT 'could',
  value       TEXT NOT NULL DEFAULT 'medium',
  effort      TEXT NOT NULL DEFAULT 'medium',
  status      TEXT NOT NULL DEFAULT 'idea',
  tags        TEXT NOT NULL DEFAULT '[]',      -- JSON array
  depends_on  TEXT NOT NULL DEFAULT '[]',      -- JSON array d'ids
  created_by  TEXT NOT NULL DEFAULT '',        -- peer_id ou 'deck' -- texte libre, PAS de FK
  updated_by  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT                              -- soft delete (archivage réversible)
);
CREATE INDEX IF NOT EXISTS idx_roadmap_project ON roadmap_items(project_key, status);
```

**Indépendance du cycle de vie des sessions — par construction** :

1. **Aucune foreign key vers `peers`/`groups`/`peer_sessions`.** Contrairement
   à `messages` (FK `from_token → peers` + cascade à la purge d'un peer
   dormant), `created_by`/`updated_by` sont de simples instantanés texte du
   `peer_id` au moment de l'écriture : une trace d'attribution, pas un lien.
   Le peer peut être purgé ou renommé, la ligne ne bouge pas.
2. **Scope = `project_key`**, propriété stable du repo — pas des groupes
   (éphémères côté Deck) ni des sessions.
3. **Aucun timer de nettoyage ne touche la table** : `cleanStalePeers`,
   `sweepInactivePeers` et le TTL messages restent scopés peers/messages.
   Pas de TTL roadmap ; la suppression publique est un archivage
   (`deleted_at`), réversible depuis la Deck.
4. La base survit au redémarrage du broker et de la machine (fichier WAL
   relu tel quel), comme les groupes TOFU aujourd'hui.

Limite assumée : en mode local la durabilité est *par machine* ; le partage
multi-PC passe par un broker commun (mode HTTP), et l'export JSON (§2.3)
fournit l'instantané versionnable/sauvegardable.

### 2.3 API broker (nouvelles routes, style existant)

- `POST /roadmap/list` — `{ project_key, filters?: { kind?, status?, priority? } }`
  → `{ items: RoadmapItem[] }`
- `POST /roadmap/upsert` — création (sans `id`) ou patch partiel (avec `id`).
  Le broker timestamp et journalise `updated_by`.
- `POST /roadmap/archive` — `{ id, by }` (le "delete" public).
- (plus tard) `GET /roadmap/export?project_key=` → JSON versionnable.

Même middleware Bearer-token que les routes actuelles. Conflits : politique
last-write-wins par champ patché suffit en v1 (les agents patchent des champs
disjoints la plupart du temps).

### 2.4 Tools MCP (dans le serveur claude-peers existant)

Ajouter au `server.ts` existant plutôt que créer un second MCP : chaque session
Deck l'a déjà, et le serveur connaît déjà cwd/git_root/`project_key`/broker.
Namespace clair pour éviter la confusion avec la messagerie :

| Tool | Rôle |
|---|---|
| `roadmap_list` | Lister (filtres kind/status/priority/tag). Rendu compact : id court, titre, badges. |
| `roadmap_get` | Détail complet d'un item (description, rationale, dépendances). |
| `roadmap_add` | Créer. Champs requis : kind, title. Le reste a des défauts (`priority=could`, `value=medium`, `effort=medium`, `status=idea`). `created_by` = peer_id courant, automatique. |
| `roadmap_update` | Patch partiel par id (dont transitions de statut : un agent qui commence un item le passe `in_progress`, etc.). |
| `roadmap_archive` | Archiver (= supprimer, réversible). |

Le prompt d'instructions du serveur MCP (celui qui décrit déjà la messagerie
peers) gagne un paragraphe : « le projet a une roadmap partagée ; consulte-la
en début de tâche, crée un item quand tu découvres un bug/de la dette, mets à
jour le statut de ce que tu traites ». C'est ce qui fait « vivre » la roadmap
au fil des sessions, comme le fait le prompt d'Auto-Claude avec son schéma JSON.

### 2.5 Deck : navigation « menus » + vue Roadmap

Restructuration de la sidebar demandée :

- Un **rail de navigation** (fin, icônes + libellés) au-dessus du contenu de la
  sidebar : **Agents** | **Roadmap** — extensible (le pattern Auto-Claude :
  Kanban, Ideation… pourront s'y brancher plus tard).
- **Agents** = exactement la sidebar + TileArea actuelles (aucun changement
  fonctionnel, juste un conteneur).
- **Roadmap** = nouvelle vue dans le `main-pane` :
  - liste groupée **par priorité MoSCoW** (comme la capture d'Auto-Claude :
    sections Must/Should/Could/Won't, badges effort & value colorés, compteur
    par section) avec un second regroupement possible **par statut** (mini
    kanban) ;
  - filtres kind/status/tags, recherche plein-texte ;
  - panneau de détail + formulaire création/édition (l'opérateur aussi peut
    saisir, `created_by='deck'`) ;
  - **« Lancer un agent sur cet item »** : pré-remplit le create-menu avec un
    prompt initial contenant l'item (titre, description, critères) et passe
    l'item `in_progress` — l'équivalent léger de leur roadmap→spec→kanban ;
  - rafraîchissement : polling HTTP 5 s quand la vue est ouverte (simple, pas
    de nouveau canal WS en v1).
- Côté main process : `roadmap-service.ts` (fetch broker, même résolution
  d'endpoint que `broker-client.ts`) + IPC `roadmap:list/upsert/archive` +
  i18n en/fr.

La Deck reste non-peer : elle consomme les routes HTTP comme elle POSTe déjà
`/announce`. Synergie v0.3.4 : optionnellement, une modification opérateur
peut être annoncée au groupe via `/announce` (« item X passé en must »).

### 2.6 Autres features d'Auto-Claude : verdict pour la Deck

| Feature | Intérêt | Verdict |
|---|---|---|
| **Worktrees** (session dans un git worktree isolé) | Fort — plusieurs agents sur le même repo sans se marcher dessus ; s'intègre bien au create-menu (cwd = worktree créé à la volée) | **Candidat sérieux**, exploration séparée |
| **Ideation** (idées générées par IA, convertibles en items) | Moyen — chez nous c'est un simple prompt d'agent qui appelle `roadmap_add` ; pas besoin d'un module dédié | Gratuit une fois la roadmap en place (un agent + consigne) |
| **Kanban de tâches/specs** | Le statut des items donne déjà une vue kanban légère | Couvert par la vue Roadmap groupée par statut |
| **Insights** (chat codebase) | Faible — ouvrir une tuile Claude fait déjà ça | Non |
| **Changelog généré** | Faible — un prompt suffit | Non (éventuel template d'agent) |
| **Context/Memories (Graphiti)** | Lourd (infra graphe) | Non, hors scope |
| **GitHub/GitLab/Linear sync** | Réel mais gros ; `externalId/externalUrl` dans leur modèle montre la voie | Plus tard ; le champ `tags` + un futur `external_url` gardent la porte ouverte |

### 2.7 Découpage & effort (roadmap)

1. **M1 — Broker** : table + 4 routes + tests (`broker-roadmap.test.ts`). ~1 j.
2. **M2 — MCP** : 5 tools dans `server.ts` + instructions + tests. ~1 j.
3. **M3 — Deck** : rail de navigation + vue Roadmap (liste MoSCoW, CRUD,
   détail) + IPC + i18n. ~2-3 j.
4. **M4 — Liants** : « lancer un agent sur cet item », annonce optionnelle,
   export JSON. ~1 j.

---

## 3. Proposition B — Auto-relance quota des sessions

### 3.1 Transposition : plus simple chez nous que chez eux

autoclaude doit faire du `tmux capture-pane` parce qu'il est extérieur aux
terminaux. **La Deck possède déjà le flux PTY de chaque tuile** et a même déjà
un précédent exact : `ThinkingDetector` (scraping ANSI-strippé du flux pour
détecter busy/idle). L'auto-relance est le même pattern avec des regex
différentes et une action de sortie.

### 3.2 Design : `QuotaDetector` dans le main process

Nouveau module `desktop/src/main/quota.ts`, branché dans `SessionService` à
côté du `ThinkingDetector` (`pty.on('data')`) :

- **Buffer glissant par session** (~4 Ko, ANSI strippé). Différence clé avec
  capture-pane : notre flux arrive en chunks, le message peut être coupé en
  deux — d'où le buffer roulant plutôt qu'un test chunk par chunk.
- **Regex** : reprendre telles quelles les 3 familles d'autoclaude (formats
  ancien « limit reached ∙ resets 2pm », nouveau « You've hit your limit ·
  resets 10pm (Europe/London) », variante minutes « resets 8m ») + fallbacks
  prudents avec word-boundaries. Isolées dans le module + tests unitaires
  (`quota.test.ts` avec fixtures de vrais écrans), pour survivre aux
  changements de copy de Claude Code.
- **Parsing du reset** : mêmes règles éprouvées — formats `3pm` / `10:30am` /
  `3 pm` en heure locale ; heure passée de plus d'1 h → lendemain ; variante
  minutes → now+N ; indétectable → réessai périodique (15 min).
- **Action à l'échéance** (le process Claude est vivant, cas dominant —
  Claude Code ne quitte pas sur quota) :
  ```
  pty.write(id, '\x1b')        // Escape : ferme le menu /rate-limit-options
  (100 ms)
  pty.write(id, 'continue')
  pty.write(id, '\r')
  ```
  Un seul envoi par épisode (flag par session, réarmé sur nouvel épisode).
  Garde-fou : n'injecter que si la session est toujours détectée rate-limited
  juste avant l'envoi (l'utilisateur a pu relancer à la main entre-temps).
- **Cas session morte** (crash pendant l'attente) : v2 — combiner avec
  `SessionService.restart(id)` (fork-resume existant) puis injection du
  prompt une fois le peer_id résolu. Hors v1.

### 3.3 UX

- **Opt-in**, comme autoclaude : toggle global dans Settings (« Relancer
  automatiquement au reset du quota ») + override par session (menu
  contextuel de la ligne sidebar). Défaut : off.
- **État visible** : nouveau statut visuel `rate-limited` (dot orange) + badge
  « reprise à 15:00 » sur la ligne et la tuile ; toast à la relance
  effective. i18n en/fr.
- Événement IPC `session:quota` (même canal de diffusion que
  `session:thinking`).

### 3.4 Limites assumées (héritées du mécanisme)

- Dépend du texte affiché par Claude Code → à couvrir par des tests à
  fixtures et un module facilement patchable.
- La timezone imprimée est ignorée (heure locale supposée) — même compromis
  qu'autoclaude, acceptable pour un poste de travail.
- `continue` littéral comme prompt de reprise : suffisant, c'est exactement
  ce qu'un humain tape.

### 3.5 Effort

Petit et isolé : module + branchement SessionService + toggle settings + badge
UI + tests ≈ **1-2 jours**. Aucun impact broker/MCP.

---

## 5. Proposition C — Worktrees : des sessions isolées sur le même repo

### 5.1 C'est quoi, un worktree git ?

Un clone git a normalement UN répertoire de travail. `git worktree` permet
d'attacher au même clone (même `.git`, même historique, mêmes objets)
**plusieurs répertoires de travail**, chacun sur sa propre branche :

```bash
git worktree add ../mon-repo--fix-login -b fix-login   # crée le dossier + la branche
git worktree list                                      # les worktrees du clone
git worktree remove ../mon-repo--fix-login             # supprime le dossier (la branche reste)
```

Chaque worktree est un dossier complet et autonome (on peut y builder, y
lancer des tests, y ouvrir un éditeur) mais il partage l'historique : un
commit fait dans un worktree est immédiatement visible des autres. Deux
worktrees ne peuvent pas être sur la même branche (garde-fou git). Coût
quasi nul : pas de re-clone, les objets sont partagés.

### 5.2 Pourquoi c'est central pour le multi-agent

Aujourd'hui, deux tuiles Deck sur le même projet travaillent **dans le même
dossier** : deux agents qui codent en parallèle se marchent dessus (diffs
mélangés sur la même branche, `git status` pollué, builds concurrents,
checkout impossible). C'est LA limite du parallélisme actuel.

Avec worktrees : chaque agent reçoit son propre dossier + sa propre branche ;
l'intégration se fait ensuite par les moyens git normaux (merge/rebase/PR),
éventuellement par un agent « intégrateur ». C'est exactement le modèle
d'Auto-Claude : chaque tâche de build s'exécute dans un worktree (« your main
branch stays safe »), avec résolution de conflits assistée par IA au retour.

### 5.3 Intégration Deck proposée

- **Create-menu (avancé)** : une option « ➕ dans un nouveau worktree » avec un
  nom de branche (défaut dérivé du nom de session : `agent/<nom>`). Le main
  process exécute `git worktree add <racine>/.worktrees/<nom> -b <branche>`
  (dossier sous `.worktrees/`, à ajouter au `.gitignore` du projet) puis
  spawne la session avec `cwd = <worktree>`.
- **Sidebar** : badge branche sur la ligne de session (le `row-sub` affiche
  déjà le cwd en tooltip ; ajouter `⎇ fix-login`).
- **Fermeture** : à la suppression de la tuile, proposer « supprimer aussi le
  worktree ? » (`git worktree remove`, la branche est conservée). Jamais
  automatique : le travail non mergé doit survivre à la fermeture.
- **Synergies fortes avec l'existant** :
  - `project_key` = remote git normalisé → identique dans tous les worktrees
    du même repo → **la roadmap (§2) est automatiquement partagée** entre la
    session sur `main` et celles dans les worktrees ;
  - le `peer_id` par défaut dérive du cwd → chaque worktree-session a un nom
    de pair distinct et lisible ;
  - groupe de la fenêtre inchangé (le scope est forcé par env, pas par cwd).
- **Points d'attention** : dépendances non partagées (un `node_modules` par
  worktree → prévoir un hook post-création configurable, ex. `bun install`) ;
  repos sans remote (fallback project_key déjà prévu §2.1) ; Windows : chemins
  longs sous `.worktrees/` à surveiller.

Effort : ~1 à 1,5 jour (service worktree + create-menu + badge + cleanup +
tests sur repo jetable).

---

## 6. Proposition D — Session « superviseur » : Claude pilote la Deck

### 6.1 L'idée

Un rail de navigation **Home** avec une session Claude Code « chapeau »,
pleine fenêtre, qui ne code pas elle-même mais **pilote l'application** :
scanner le repo, lire la roadmap, spawner les bons agents avec les bons
profils (`team-lead`, `dev`, `reviewer`, `devops`, `debugger`…), créer des
worktrees, appliquer/créer des templates, superviser l'avancement.

Cas d'usage cible :

> « Reprends le développement du repo actuel » → le superviseur scanne les
> fichiers, appelle `roadmap_list`, choisit les items `must` non traités,
> crée un worktree par item, spawne `dev` et `reviewer` dessus avec un prompt
> initial, puis coordonne par messages peers.

### 6.2 Constat clé : 70 % du mécanisme existe déjà

Le superviseur est **une tuile Claude Code normale** spawnée par la Deck, dans
le même groupe forcé que les autres. Or tout membre du groupe a déjà, via le
MCP claude-peers : `list_peers` (voir les agents et leurs `summary`),
`send_message` (leur donner des instructions, recevoir leurs réponses),
`set_summary`. **La coordination inter-agents est donc déjà résolue** — c'est
le cœur du produit. Ce qui manque, c'est uniquement le bras « piloter l'app » :
spawner/fermer des tuiles, créer des worktrees, manipuler les templates.

À noter : Claude Code sait déjà spawner des sous-agents *internes* (tool
Agent), mais ils sont invisibles et meurent avec le tour. Ce que veut
l'opérateur ici, c'est des **tuiles réelles, observables, persistantes** —
d'où le passage par la Deck.

### 6.3 Mécanisme proposé : un MCP « deck-control » réservé au superviseur

1. **Endpoint de contrôle dans le main process Electron** : petit serveur HTTP
   loopback (`127.0.0.1`, port aléatoire, Bearer token régénéré à chaque
   lancement) qui expose en interne les services existants (SessionService,
   template-store, futur worktree-service). Même patron que le broker : la
   Deck sait déjà faire ça proprement.
2. **Serveur MCP stdio `deck-control`** (nouveau fichier, ~200 lignes, même
   style que `server.ts`) : traduit des tools MCP en appels HTTP vers cet
   endpoint. URL + token passés par env au spawn.
3. **Injection sélective** : SEULE la tuile superviseur est lancée avec
   `--mcp-config <fichier généré>` branchant `deck-control` (+ env). Les
   agents normaux ne l'ont pas → séparation des privilèges nette : un `dev`
   ne peut pas fermer les tuiles des autres.

**Surface de tools v1 :**

| Tool | Effet (via services existants) |
|---|---|
| `deck_list_agents` | Scan `.claude/agents` projet + `~/.claude/agents` (= `listAgents()`, déjà écrit) — **le dossier de profils de l'opérateur est donc vu tel quel** |
| `deck_list_models` / `deck_list_presets` | `resolveLaunchConfig()` (déjà écrit) |
| `deck_spawn_session` | `SessionService.create({name, agent, model, effort, cwd, worktree?, initial_prompt?})` |
| `deck_list_sessions` | `SessionService.list()` (nom, peer_id, statut, thinking, cwd) |
| `deck_restart_session` | `SessionService.restart()` |
| `deck_close_session` | `SessionService.remove()` — garde-fou : cf. §6.5 |
| `deck_create_worktree` / `deck_list_worktrees` / `deck_remove_worktree` | worktree-service (§5) |
| `deck_list_templates` / `deck_apply_template` / `deck_save_template` | template-store (déjà écrit) |
| `deck_announce` | mégaphone `/announce` existant |

La roadmap n'apparaît pas ici : le superviseur l'a déjà par les tools
`roadmap_*` du MCP claude-peers (§2.4). Chaque brique reste à sa place.

### 6.4 Prérequis transverse : le prompt initial au spawn

Pour « spawne le dev avec l'item #12 en consigne », il faut pouvoir attacher
un prompt initial à une création de session. Le type `LaunchPreset.prompt`
existe déjà dans `launch-config.ts` (« used by the UI, M5 ») **mais n'est
câblé nulle part**. Deux voies :

- **Argument positionnel** : `claude "<prompt>"` démarre l'interactif avec le
  prompt soumis — le plus simple et déterministe ; passe par
  `buildSessionCommandLine` (attention au quoting shell, déjà géré pour
  `--model "opus[1m]"`).
- **Injection PTY différée** : écrire `prompt + \r` quand la session est
  prête (peer_id résolu). Utile pour le resume, mais plus fragile (timing).

Recommandation : positionnel pour le spawn frais, et ce chantier débloque
d'un coup les presets M5, le « Lancer un agent sur cet item » de la roadmap
(§2.5) et le superviseur.

### 6.5 Garde-fous

- **Token par fenêtre + injection sélective** : seule la tuile Home a le MCP
  de contrôle ; le token ne traverse jamais le repo ni la config projet.
- **Opérations destructives** (`deck_close_session`, `deck_remove_worktree`) :
  politique v1 = autorisées uniquement sur les objets que le superviseur a
  lui-même créés (le contrôle endpoint tague `created_by: 'supervisor'`) ;
  pour le reste, la Deck affiche un ConfirmDialog à l'opérateur (IPC existant).
- **Plafond de spawn** (ex. 8 tuiles) pour éviter l'emballement.
- Pour ses tools fichiers/bash, le superviseur reste une session Claude Code
  normale : les modes de permission de l'opérateur s'appliquent.

### 6.6 UX

- Rail de navigation : **Home | Agents | Roadmap** (extension naturelle du
  rail proposé §2.5).
- **Home** = la tuile superviseur pleine largeur, spawnée à la première
  visite. Son profil d'agent est **sélectionnable** (Settings) parmi le scan
  `.claude/agents` — l'opérateur peut donc pointer son `team-lead` maison —
  avec en défaut un profil `deck-supervisor.md` embarqué dans le plugin dir de
  la Deck (instructions : « tu pilotes la Deck ; tu ne codes pas toi-même ;
  utilise deck_* pour l'app, roadmap_* pour le backlog, send_message pour
  coordonner »).
- La ligne du superviseur n'apparaît pas dans la liste « Agents » (c'est le
  chef d'orchestre, pas un musicien) mais il EST un peer visible des agents.

### 6.7 Effort

- Endpoint contrôle + MCP deck-control + injection sélective : ~2 j.
- Rail Home + tuile pinnée + profil superviseur embarqué : ~1 j.
- Prompt initial au spawn (§6.4, prérequis partagé) : ~0,5 j.
- Garde-fous + tests : ~1 j.
  Total ≈ 4-5 j, APRÈS worktrees (§5) et idéalement après la roadmap (§2),
  que le superviseur consomme.

---

## 7. Explorations de suite (2026-07-14, après livraison C1-C5)

### 7.1 Vue Worktrees dans le rail (→ PLAN C6)

À quoi elle sert concrètement : **voir et gérer les worktrees que les agents
utilisent** — aujourd'hui ils n'apparaissent qu'indirectement (badge ⎇ des
sessions) ; un worktree dont la session est fermée devient invisible et
s'accumule dans `.worktrees/`.

- **Contenu** : une ligne par worktree du repo (`listWorktrees` existe déjà) :
  branche, chemin, marqueur « main », **session Deck attachée** (match
  `session.cwd`), et un état git enrichi — sale ? (`git status --porcelain`),
  dernier commit (sujet + date), avance/retard vs la branche principale.
  Les worktrees **orphelins** (sans session vivante) sont mis en évidence :
  c'est le cas d'usage n°1, le nettoyage après merge.
- **Actions** : créer un worktree (sans session), ouvrir une session dedans
  (create avec `cwd` = worktree — permet de *reprendre* un worktree orphelin),
  supprimer (réutilise `removeWorktree` : jamais forcé, branche conservée),
  copier le chemin.
- **Intégration** : 4ᵉ vue du rail (le `NavRail` est extensible par
  construction) ; `worktree-service.ts` gagne un `worktreeStatus()` ;
  IPC `worktree:list`. Le superviseur voit déjà tout ça via
  `deck_list_worktrees` — cette vue est le miroir opérateur.

### 7.2 Import d'un fichier de plan → briques de roadmap (→ PLAN C7)

Question : script déterministe ou délégation à un agent ? **Verdict : agent.**
Un plan généré par Claude Code est de la prose structurée libre ; en extraire
des items et *juger* kind/priority/value/effort est exactement un travail de
LLM — un parseur markdown ne tiendrait que sur un format rigide et casserait
sur le reste. Et l'infrastructure existe déjà intégralement : tools
`roadmap_*` (C3) + prompt initial au spawn (C2) + auto-fermeture des tuiles
sur exit propre (v0.3.3).

- **UX** : bouton « Importer un plan » dans la vue Roadmap → file picker →
  la Deck spawne un **agent d'import one-shot** avec un prompt C2 :
  « Lis `<fichier>`, extrais les items de travail, crée-les via `roadmap_add`
  (estime kind/priority/value/effort, tag `import` + nom du plan, reporte les
  dépendances évidentes dans depends_on), affiche un résumé de ce que tu as
  créé, puis tape /exit. » La tuile apparaît, travaille sous les yeux de
  l'opérateur, et se ferme seule. Zéro nouveau canal, ~0 code backend.
- **Variante superviseur** : quand le superviseur tourne, la même demande
  peut lui être faite à la main (« lis X et importe-le dans la roadmap ») —
  gratuit dès aujourd'hui. Le bouton dédié reste plus simple et sans état.
- **Écarté** : le parseur déterministe (fragile, jugement impossible) ; on ne
  le reconsidérerait que pour un format de plan strict qui n'existe pas.

### 7.3 Harness du superviseur personnalisable (→ PLAN C8)

Question : comment étendre durablement le rôle du superviseur sans le hook
`UserPromptSubmit` ? L'intuition est la bonne : ce hook injecte du contexte
**à chaque tour** (vérifié) — trop lourd et au mauvais niveau. Les leviers
vérifiés dans la doc Claude Code :

| Levier | Niveau | Vérifié |
|---|---|---|
| `--append-system-prompt-file <path>` | **System prompt**, une fois, toute la session — **fonctionne en interactif** | ✅ doc CLI |
| Profil d'agent (`.claude/agents/*.md`) | Le corps **remplace** le system prompt | ✅ doc subagents |
| Instructions MCP (deck-control `initialize`) | Contexte, déjà en place | ✅ |
| Briefing C2 (prompt initial) | Premier message, déjà en place | ✅ |
| `UserPromptSubmit` | Contexte **par tour** | ✅ (écarté) |

**Design retenu (révisé après retour opérateur — décision sécurité)** : le
harness du superviseur n'est **pas configurable du tout**, ni par fichier
opérateur ni par profil d'agent. Menace : le superviseur détient les pouvoirs
`deck_*` (spawner jusqu'à 8 agents briefés) ; un `supervisor.md` lu depuis le
projet ou un profil d'agent (dont le corps **remplace** le system prompt)
permettrait à un repo cloné de détourner silencieusement la session qui
pilote l'app (exfiltration, spawns malveillants). Donc :

1. Le rôle vit dans **deux constantes du code** (`SUPERVISOR_SYSTEM_PROMPT`
   + `SUPERVISOR_BRIEFING`), avec une consigne explicite de refus de
   détournement.
2. L'ancrage se fait quand même **au niveau system prompt** (le bon niveau,
   `--append-system-prompt-file` vérifié en interactif) mais via un fichier
   **généré par l'app depuis la constante et réécrit à chaque spawn** — un
   fichier trafiqué sur disque est écrasé. Re-passé au resume (comme
   `--effort`/`--mcp-config`).
3. L'option `supervisorAgent` de Settings (livrée en C5) est **retirée**
   pour la même raison.
4. Même principe pour le prompt de l'agent d'import de plan (C7) : constante
   dans le code, jamais un template configurable.

Limite assumée et documentée : l'opérateur au clavier peut toujours taper ce
qu'il veut dans le terminal du superviseur — le verrou protège contre le
détournement *silencieux* (fichiers portés par un repo, config), pas contre
l'utilisateur légitime de sa propre machine ; c'est le bon périmètre.

### 7.4 Bouton d'aide flottant « ? » (→ PLAN C9)

Assistant de compréhension/décision contextuel, volontairement séparé du
superviseur (son contexte n'a pas à être chargé d'aide à l'usage) :

- **Mécanisme** : chaque question = une invocation `claude -p` jetable,
  lancée par le main process à travers le même shell de login que les
  sessions (résolution du binaire `claude` via PATH ; un marqueur de
  démarrage strippe le bruit des profils — nvm/conda — du stdout capturé).
- **Contexte** : system prompt = constante du code (règle C8) + « vue
  active » + instantané JSON composé par l'app (roadmap → items compacts ;
  agents/home → liste des sessions). Continuité du popup par rejeu des 4
  derniers échanges dans le prompt (le CLI est sans état).
- **Lecture seule TECHNIQUE, pas seulement promptée** : `--strict-mcp-config`
  sans mcp-config = zéro serveur MCP chargé (ni claude-peers ni
  deck-control), `--disallowedTools` sur tout ce qui mute (Bash/Edit/Write/
  Task/Web...). Read/Grep/Glob restent disponibles pour ancrer les réponses
  dans le repo. Le prompt dit en plus « tu ne peux pas agir ; explique
  comment l'opérateur ou le superviseur peut le faire ».
- **Options** : toggle du bouton + modèle (défaut **haiku**, coût/latence)
  dans Settings > Général, et les deux aussi via clic droit sur le bouton.

## 8. Recommandation d'ensemble (mise à jour)

Ordre de valeur/risque croissant, chaque étape rendant la suivante plus utile :

1. **Auto-relance quota** (§3) : petite, isolée, valeur immédiate. ~1-2 j.
2. **Prompt initial au spawn** (§6.4) : minuscule, débloque presets M5,
   roadmap→agent et superviseur. ~0,5 j.
3. **Roadmap** (§2) M1→M4 : broker + MCP d'abord, UI ensuite. ~5-6 j.
4. **Worktrees** (§5) : parallélisme réel des agents. ~1-1,5 j.
5. **Superviseur** (§6) : la couche d'orchestration qui capitalise sur tout
   ce qui précède (roadmap à lire, worktrees à créer, agents à spawner,
   messagerie peers pour coordonner). ~4-5 j.

Ideation devient gratuit après la roadmap ; Insights/Changelog/Graphiti/sync
issues restent écartés ou reportés.
