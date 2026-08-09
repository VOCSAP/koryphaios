# EXPLORATION — nodeterm : communication inter-terminaux & multi-CLI

Revue du repo [eneskirca/nodeterm](https://github.com/eneskirca/nodeterm)
(v0.2.40, Electron + canvas React-Flow de terminaux tmux/xterm hébergeant
Claude Code, Codex, Gemini CLI et opencode), menée le 2026-08-09 pour répondre
à la question : **comment nodeterm gère-t-il la communication entre terminaux
et entre CLIs de modèles hétérogènes, et qu'est-ce qui est transposable au
Deck de Kory ?** Alimente directement `BACKLOG.md` §3.1 (tuiles Codex/Gemini,
livraison de messages inter-agents non-Claude).

Les références `fichier:ligne` ci-dessous pointent dans le repo nodeterm.

---

## 1. Le constat central

**nodeterm n'a PAS résolu le push de messages vers un agent hétérogène — il
l'a évité par design.** Il n'existe aucun bus de chat agent↔agent : toute la
communication inter-agents est *médiée par l'hôte* et repose sur trois
familles de mécanismes, tous compatibles avec n'importe quel CLI parce
qu'aucun ne dépend d'un protocole propre à un agent :

1. **Pull** : un agent lit le contexte d'un autre à la demande (context-link).
2. **Fichier + argv au lancement** : le contexte voyage par fichier sur
   disque, le prompt initial par ligne de commande (handoff, spawn-team).
3. **Push restreint et confirmé** : trois cas seulement injectent du texte
   dans le composer d'un agent vivant, dont un seul agent→agent — et il exige
   une confirmation humaine.

Le commentaire de `Canvas.tsx:5685-5691` assume ce choix : le push
automatique de notes dans les membres d'une équipe fraîchement spawnée a été
**reverté** comme « the exact intrusion that push was reverted for ».

C'est le miroir inverse de Kory : le canal peers de Kory est *push-first*
(WS → protocole `claude/channel`, propre à Claude Code), ce qui est
précisément ce qui bloque les tuiles non-Claude (`BACKLOG.md` §3.1). nodeterm
démontre qu'un multi-CLI riche (spawn, statut, équipes, dépendances,
transfert de contexte) est livrable **sans** équivalent de channel — et que
la seule brique vraiment intransposable est celle que Kory a en plus.

---

## 2. Les mécanismes de nodeterm, en détail

### 2.1 Observation des agents : hooks natifs → normalisation

Aucun parsing de sortie terminal pour le statut. Chaque CLI est instrumenté
par **son propre mécanisme d'extension**, tous convergeant vers un unique
script POSIX managé (`~/.nodeterm/agent-hooks/<agent>.sh`) qui `curl` le JSON
brut du hook vers un serveur HTTP loopback interne à l'app (port éphémère,
token bearer comparé en temps constant, réponse toujours 204 pour ne jamais
bloquer l'agent — `hook-server.ts`).

| CLI | Seam d'installation | Événements | Particularités |
|---|---|---|---|
| claude | bloc `hooks` de `~/.claude/settings.json` | 9 (SessionStart, UserPromptSubmit, Stop, StopFailure, Notification, PermissionRequest, SessionEnd, Pre/PostToolUse) | commande gardée par `if [ -r … ]` car un hook UserPromptSubmit non-zéro **bloque le prompt** |
| codex | `~/.codex/hooks.json` **+ entrées de confiance sha256 dans `config.toml`** | 6 | codex ≥0.129 refuse un hook dont le `trusted_hash` ne matche pas ; hash canonique-JSON rétro-ingéniéré (`codex-trust.ts:90`), append-only car la confiance est indexée par position |
| gemini | bloc `hooks` de `~/.gemini/settings.json` | 4 (noms propres : BeforeAgent/BeforeTool/AfterTool/AfterAgent) | pas d'état waiting/blocked |
| opencode | **plugin JS** `~/.config/opencode/plugins/nodeterm-status.js` | bus `event` catch-all | pas de hooks du tout ; dédup des `message.updated` re-émis après idle |

Le tout est normalisé (`shared/agents/normalize.ts`) en un unique
`NormalizedAgentEvent` avec `state: 'working' | 'waiting' | 'blocked' |
'done'`, plus des signaux de réparation : sweep « working périmé » à 20 min,
inférence d'interruption sur Esc/Ctrl-C (claude n'émet aucun hook sur
annulation), holdoff de 3 s contre les hooks parallèles tardifs.

**Approbations à distance** : quand `PermissionRequest` arrive, le script
managé écrit la demande dans `~/.nodeterm/pending/<id>.json` puis **poll un
fichier-réponse** `<id>.answer` (0,5 s, timeout fail-open) ; la réponse de
l'app (ou d'un téléphone via SSH) est un write atomique de fichier. Le canal
de réponse est un fichier précisément pour marcher au travers de SSH sans
tenir une connexion HTTP.

### 2.2 Injection de texte dans un terminal : deux chemins distincts

- **Ligne de lancement dans un shell frais** — `deliverCommand`
  (`command-delivery.ts:48`) : écrit la commande sans Enter, **vérifie l'écho**
  (tail-match 24 chars après strip ANSI), Ctrl-U + réécriture en cas de
  mismatch (3 tentatives puis fail-open), Enter seulement après vérification.
  Motivé par un rapport de terrain : l'init zsh/ZLE flush le tty et avale une
  partie d'une ligne écrite en aveugle (« 3 agents d'équipe spawnés, aucun
  démarré »).
- **Texte dans un agent TUI vivant** — `PtyManager.sendText`
  (`pty-manager.ts:1925`) : sonde `tmux display-message '#{bracket_paste_flag}'`
  puis, si le TUI a demandé le bracketed paste, **une seule écriture atomique**
  `send-keys -l 'ESC[200~ texte ESC[201~ \r'` (`paste-injection.ts`). Écrire
  texte puis Enter en deux frappes fait la course avec l'heuristique de collage
  du composer, qui absorbe l'Enter comme du contenu collé au lieu de soumettre.
  Fonctionne détaché (tmux par nom de session) et à travers SSH (one-liner
  `if bracket_paste_flag …` construit côté hôte).

Le prompt initial d'un agent ne passe **jamais** par frappe : il voyage en
argv (`claude '<prompt>'`, `codex '<prompt>'`, `gemini '<prompt>'`) ou en
`--prompt` (opencode, dont l'argument positionnel est un chemin projet) —
champ déclaratif `promptInjectionMode` de `AGENT_CONFIG`
(`shared/agents/config.ts:21`).

### 2.3 Communication agent→agent

- **context-link (pull, le canal principal)** : une arête entre deux nœuds
  agents écrit un document de liens par nœud ; l'agent lit à la demande via un
  shim `sh`+`curl` (`nodeterm-context list|summary|transcript|terminal`)
  posté sur le serveur loopback. **Autorisation par le document** : le
  requérant est identifié par son `NODETERM_NODE_ID`, et ne peut lire que les
  nœuds listés dans *son* document — détenir le token du serveur ne suffit
  pas. La découverte est par instructions : SKILL.md pour claude, bloc à
  marqueurs mergé dans `~/.codex/AGENTS.md` / `~/.gemini/GEMINI.md` /
  `~/.config/opencode/AGENTS.md` pour les autres. Zéro MCP dans tout le repo.
- **Les trois push** : note de découverte de lien (sautée si la cible est
  `working`, formulée auto-désamorçante — « No action needed now » — sinon
  gemini lançait une investigation non sollicitée) ; push d'une sticky note
  (agents seulement, une ligne, tronquée à 2000) ; verbe `write` de
  canvas-control (agent A tape dans le nœud B) — **dialogue de confirmation
  humaine obligatoire**, idem `close`.
- **`--after` (dépendances)** : un nœud peut être « armé » — sa commande de
  lancement est mise en attente et **tire quand toutes ses dépendances
  atteignent `done`** (front busy→idle observé par les hooks). Seuls les
  agents à hooks peuvent être attendus. C'est l'orchestration séquentielle de
  nodeterm : la « communication » est l'événement de complétion, pas un
  message.
- **canvas-control** : API HTTP loopback + shim sh, verbes `open-agent
  --agent claude|codex|gemini|opencode --prompt …`, `spawn-team` (≤8 rôles,
  chacun son prompt argv, groupés et re-liés au spawner), `verify` (panneau
  de reviewers par lentille + juge armés en `--after`), `open-worktree`, etc.
  Équivalent fonctionnel du `deck-control` MCP de Kory, mais **CLI-agnostique**
  puisque n'importe quel agent sachant lancer `sh` peut l'appeler.

### 2.4 Handoff : transfert de conversation inter-CLI

Le seul endroit où les formats des différents CLIs se rencontrent
(`src/main/handoff/`) :

1. **Localiser** le transcript natif par sessionId capturé via hooks —
   `~/.claude/projects/<proj>/<sid>.jsonl`, `~/.codex/sessions/Y/M/D/rollout-*<sid>.jsonl`,
   `~/.gemini/tmp/<proj>/chats/session-*.jsonl` (header en 1re ligne).
2. **Rendre** chaque format JSONL propriétaire vers un **Markdown lingua
   franca** (`## User/Assistant` = frontière de message, `### Tool …` = bloc
   outil ; le format gemini est event-sourcé et doit être *rejoué* :
   `$set`/`$push.messages`).
3. **Budgéter** (`budget.ts`) : 150 000 chars (~40k tokens) ; 80 % pour une
   **queue verbatim** coupée à une frontière de message, le reste pour un
   digest une-ligne-par-message des débuts (les rafales d'outils collapsées en
   « N tool blocks omitted ») ; en cas de troncature le rendu complet est
   écrit à côté (`-full.md`) avec la consigne « grep-le, ne le lis pas en
   entier ». Motivé par un échec observé : codex lisait un handoff de
   plusieurs Mo, compactait, et oubliait la consigne.
4. **Livrer** : fichier `<cwd>/.nodeterm/handoff-<node>-<ts>.md` (écrit sur
   l'hôte distant pour un projet SSH), nouvelle tuile du CLI cible dont le
   prompt argv dit « lis ce fichier, fais un récapitulatif, puis **STOP** » —
   transfert de *contexte*, pas de *contrôle* ; la source reste vivante.

Directions : claude ↔ codex ↔ gemini bidirectionnel ; opencode cible
seulement. Gouverné par la liste `TRANSFER_SOURCE_CAPABLE`.

### 2.5 Dégradation par listes de capacités

Toutes les features par-CLI sont des **listes de membres const**
(`config.ts:56-93`) : `SUBAGENT_CAPABLE = ['claude']`,
`CONTEXT_LINK_CAPABLE = [les 4]`, `TRANSFER_SOURCE_CAPABLE = [claude, codex,
gemini]`, `PERMISSION_MODE_CAPABLE = ['claude']`, etc. Un agent custom
n'appartient à aucune liste et n'obtient que spawn + titre + statut process.
Chaque table (resume, exit-sequence, permission-flag) est déclarative :
`resumeCommand()` → `codex resume <sid>` / `claude --resume <sid>` /
`gemini --resume <sid>` / `opencode --session <sid>`.

### 2.6 Ce que le « relay » n'est pas

Le relay de nodeterm est du **multi-joueur humain↔humain** (deux desktops
partagent un canvas via un tunnel E2EE). Aucun rapport avec l'inter-agents ;
canvas-control n'est d'ailleurs pas exposé au travers du relay.

---

## 3. Transposition à Kory

### 3.1 Ce que la revue conforte : l'option « nudge PTY » du backlog

Le backlog §3.1 hésitait entre PTY-scraping (voie rapide) et tuiles ACP (voie
propre). nodeterm apporte deux éléments de décision :

- **Le pull MCP suffit côté agent.** Codex et Gemini savent parler MCP stdio
  en pull : `check_messages` de claude-peers leur est donc accessible tel
  quel. La brique manquante n'est que le *réveil*.
- **Le réveil par injection PTY est un pattern éprouvé et outillé**, pas un
  hack : sonde `bracket_paste_flag` + injection atomique
  `ESC[200~ … ESC[201~ \r` (jamais texte-puis-Enter en deux frappes), garde
  d'inactivité (ne jamais injecter dans une tuile `working` ou `blocked`),
  message auto-désamorçant. Kory possède déjà les deux moitiés : l'injection
  gardée des directive cards (`/clear` dans les tuiles ciblées, garde busy)
  et le statut par tuile. Le « nudge » est littéralement une directive card
  système : *« You have N pending peer messages — run check_messages »*
  injectée quand la tuile non-Claude passe idle et que le broker a du
  `delivered=0` pour elle.

Concrètement, pour le palier 1 multi-CLI, la pile nodeterm-compatible est :

1. tuile codex/gemini spawnée avec le serveur MCP claude-peers configuré en
   pull (`[mcp_servers]` codex / settings gemini) ;
2. statut par hooks natifs (voir 3.2) pour connaître idle/busy ;
3. nudge PTY gardé pour matérialiser le push ;
4. les messages `deck` (megaphone) et l'annonce de join passent par le même
   nudge — le rendu « informational only » restant côté serveur MCP.

L'ACP reste la voie propre si l'on accepte de perdre la TUI native (une
session ACP est headless, le Deck rendrait la conversation) ; nodeterm prouve
qu'on peut livrer un multi-CLI utile **avant** ce chantier, en gardant les
xterm natifs.

### 3.2 À reprendre quasi tel quel

- **La carte des seams d'instrumentation par CLI** (§2.1) — en particulier la
  recette codex `hooks.json` + `trusted_hash` (canonical-JSON sha256,
  append-only, écrire le TOML en dernier), non triviale et déjà
  rétro-ingéniérée. Kory en aura besoin pour savoir quand une tuile codex est
  idle (condition du nudge) et pour l'équivalent des approval-hooks.
  Attention aux pièges documentés : événements gemini à noms propres (et sans
  état blocked), claude sans hook sur interruption (inférence Esc + settle),
  holdoff contre les hooks parallèles, sweep anti-working-fantôme.
- **La table déclarative de spawn** : `AGENT_CONFIG { launchCmd,
  promptInjectionMode, color }` + `resumeCommand()` + listes de capacités.
  Le champ `cli` de `deck_spawn_session` existe déjà ; cette forme est la
  bonne cible pour l'ouvrir au-delà de `claude`, et les listes de membres
  donnent la dégradation propre (peers-push Claude-only, supervisor
  Claude-only au début, etc.).
- **La livraison écho-vérifiée de la ligne de lancement** (`deliverCommand`) :
  attendre le calme du shell, vérifier l'écho, Ctrl-U + retry, fail-open.
  À comparer avec ce que fait `pty-run.ts` aujourd'hui ; le cas d'échec
  (init zsh qui avale la ligne) est réel.
- **Le handoff par fichier budgété** (§2.4) : localisation + rendus
  Markdown + budget queue-verbatim/digest. Deux usages Kory : transfert d'une
  session Claude vers une tuile codex/gemini (continuité de contexte
  inter-CLI), et robustification du magic-compact / des passations
  supervisor→agent. La constante « 150k chars, 80 % tail, frontière de
  message, fichier complet à côté » est une recette directement réutilisable.

### 3.3 À ne pas chercher chez nodeterm

- **Un équivalent de channel/push** : il n'y en a pas ; c'est l'avance de
  Kory, pas son retard. Le broker + WS push de Kory reste supérieur pour les
  tuiles Claude ; le nudge n'est que le pont vers les autres CLIs.
- **Le relay** : hors sujet (collaboration humaine).
- **Le shim sh+curl comme transport agent→hôte** : Kory a déjà mieux (MCP
  pour les outils, hooks pour les événements). Une exception à garder en
  tête : le shim est l'option de repli universelle pour un CLI custom sans
  support MCP — même philosophie que le bloc d'instructions mergé dans
  `AGENTS.md`/`GEMINI.md`, qui est aussi la façon dont nodeterm *documente*
  ses outils aux agents non-Claude (à retenir pour exposer les usages
  claude-peers à codex/gemini).

### 3.4 Différences structurelles à garder en tête

| | nodeterm | Kory |
|---|---|---|
| Transport agent→hôte | HTTP loopback + shim sh/curl | MCP stdio (server.ts) + hooks |
| Push hôte→agent | injection PTY confirmée/gardée uniquement | WS + `claude/channel` (Claude-only) |
| Inter-agents | pull context-link + `--after` + fichiers | broker claude-peers (messages routés, groupes TOFU) |
| Multi-CLI interactif | 4 CLIs + customs, natif | Claude-only (headless multi-CLI déjà là) |
| Multi-machines | SSH/tmux par nœud, hooks via tunnel socket unix | broker HTTP partagé (`broker_url`) |
| Orchestration | spawn-team + verify + `--after`, pilotée par l'agent | supervisor/team-lead + dispatch + graph, pilotée Deck/broker |

Le modèle broker de Kory est plus riche en messagerie ; le modèle nodeterm
est plus riche en hétérogénéité de CLIs. Les deux sont composables : rien
dans le broker n'est propre à Claude *sauf* la livraison push finale — et
c'est exactement le maillon que le nudge PTY remplace.
