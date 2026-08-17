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

---

## 4. Annexe (2026-08-11) — la voie inverse : un seul harness, N modèles

Revue complémentaire de deux projets qui prennent le problème multi-modèle à
l'envers de nodeterm : au lieu de N CLIs natifs côte à côte, **garder Claude
Code comme frontal unique et changer le moteur derrière**. Rapportée au
palier 1 multi-CLI (§3.1 du backlog), c'est une **troisième option** : des
tuiles « Claude Code sur modèle tiers » hériteraient de TOUT l'écosystème qui
bloque les tuiles non-Claude — push `claude/channel` de claude-peers, MCP,
hooks, skills, agents, supervisor — puisque le CLI reste Claude Code.

**Réserve transverse assumée d'entrée** : quand les comptes amont sont des
abonnements OAuth (Claude Pro/Max, ChatGPT, Gemini…), les utiliser hors de
leur client officiel est contraire aux CGU des fournisseurs (risque de ban de
compte). Le montage est par contre légitime avec de vraies clés API ou un
endpoint local (Ollama/LiteLLM — que le Deck sait déjà adresser en headless).

### 4.1 CLIProxyAPI ([router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI))

Proxy local en Go (port 8317) qui fait du pontage de protocoles :

- **Amont** : comptes fournisseurs par OAuth (`--claude-login`,
  `--codex-login`, `--antigravity-login` (Gemini), `--kimi-login`,
  `--xai-login`, + Gemini CLI/Qwen/iFlow ; tokens dans `~/.cli-proxy-api`),
  ou clés API / n'importe quel endpoint OpenAI-compatible déclaré en YAML.
  Multi-comptes, load-balancing, retry/failover.
- **Aval** : il expose les dialectes d'API de chaque écosystème
  (`internal/api/server_routes.go`) — Anthropic **`POST /v1/messages`** +
  `/v1/messages/count_tokens` (handler `ClaudeCodeAPIHandler` : c'est ce qui
  sert Claude Code), OpenAI `/v1/chat/completions` + `/v1/responses` (et
  l'alias `/backend-api/codex` pour brancher le CLI Codex tel quel), Gemini
  `/v1beta/models/*`, catalogue unifié `/v1/models`.
- **Au milieu** : des **translators bidirectionnels**
  OpenAI↔Gemini↔Claude↔Codex (`sdk/translator`, doc `docs/sdk-advanced.md`),
  streaming SSE et tool-calling compris. Routage **par nom de modèle**, alias
  configurables par provider, mapping des niveaux de thinking.

Branchement Claude Code : `ANTHROPIC_BASE_URL=http://127.0.0.1:8317` +
`ANTHROPIC_AUTH_TOKEN=<api-key du config.yaml>` ; le nom de modèle demandé
décide du backend (modèle claude → passthrough ; `gpt-*`/`gemini-*`/`glm-*` →
traduction). Signaux de zone grise à garder en tête : option
`identity-confuse` (brouille les identifiants de tracking Codex), README
annuaire de revendeurs de comptes/relais à -90 %.

### 4.2 CCS ([kaitranntt/ccs](https://github.com/kaitranntt/ccs), « Claude Codex Switch »)

Sur-couche npm (`@kaitranntt/ccs`, TypeScript/Bun) au-dessus de CLIProxyAPI :
un **gestionnaire de profils + runtimes**. `ccs glm`, `ccs codex`, `ccs
ollama`… lancent Claude Code (ou un autre runtime cible : Codex CLI, Droid)
avec l'environnement du profil. Ce qu'il documente utilement :

- **La recette exacte de l'override modèle** (`config/base-*.settings.json`,
  ~20 presets) : `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` +
  `ANTHROPIC_MODEL` + **`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`** —
  les trois derniers pour que les alias internes de Claude Code pointent tous
  vers le modèle tiers. Deux familles de profils : API directe (ex. GLM →
  `https://api.z.ai/api/anthropic`, endpoints Anthropic-compatibles des
  vendeurs, AUCUN proxy) et OAuth via le CLIProxy local (routes scopées
  `/api/provider/<x>` de leur fork `CLIProxyAPIPlus`).
- **Gestion du binaire** : CCS télécharge et pilote lui-même le binaire Go
  CLIProxyAPI (release GitHub, `src/cliproxy/binary-manager.ts` +
  `service-manager.ts`), dashboard web localhost:3000, suivi de quotas.
- **Hygiène d'env** : `stripAnthropicEnv` avant de lancer un profil compte
  natif (une `ANTHROPIC_BASE_URL` héritée d'un shell précédent détournerait
  silencieusement la session officielle vers le proxy) ; isolation
  multi-comptes Claude par `CLAUDE_CONFIG_DIR` par instance
  (`claude-extension-setup.ts`) — même besoin que les managed accounts de
  nodeterm.
- **Le plus instructif — la compensation des trous de capacité**
  (`src/utils/websearch-manager.ts`) : **WebSearch est un outil server-side
  Anthropic** — derrière un backend tiers, il disparaît. CCS provisionne pour
  ces profils un serveur MCP WebSearch **local** (Exa/Tavily/Brave/DuckDuckGo,
  fallback via les CLIs gemini/grok/opencode) dans `~/.claude.json`, idem
  analyse d'images et outillage navigateur. Preuve concrète que « le harness
  hérite » a des exceptions qu'il faut combler une à une.

À noter aussi : [claude-code-router](https://github.com/musistudio/claude-code-router)
(musistudio), routeur standalone du même genre, cité par CCS comme source de
son architecture de transformation SSE.

### 4.3 Lecture pour Kory

- **Ce que l'option 3 apporte** : multi-*modèle* sans multi-*CLI*. La tuile
  reste une session Claude Code — claude-peers (channel push compris), le
  deck-plugin, les skills/agents/hooks, le supervisor marchent sans un seul
  chantier de livraison. Le Deck contrôle déjà l'env au spawn
  (`create-session.ts`/`pty-run.ts`) : injecter les 6 variables du preset CCS
  par session suffit ; CCS lui-même (switcher interactif mono-terminal)
  n'apporte rien au Deck, ce sont ses *recettes* qui comptent.
- **Ce qu'elle ne règle pas** : la qualité effective du harness sur un modèle
  tiers. Les prompts système et l'outillage de Claude Code sont réglés pour
  Claude ; la parité tool-calling/thinking des translators est du best-effort ;
  les outils server-side (WebSearch, et le prompt caching dont la sémantique
  `cache_control` diffère chez les tiers) doivent être compensés
  (le WebSearch MCP local de CCS est la pièce à imiter). **À valider
  empiriquement avant tout code** : une tuile GLM/Kimi/Gemini exécute-t-elle
  correctement les tools MCP claude-peers, les hooks du deck-plugin, un
  dispatch du team-lead ? (Même esprit que les probes P1-P4 du superviseur
  Codex, §3.1.)
- **Positionnement vs les autres options du §3.1** : le nudge PTY reste la
  voie pour des tuiles *CLI natifs* (TUI codex/gemini authentiques, ToS
  propres) ; l'option 3 est la voie basse-friction pour du multi-*modèle*
  homogène ; ACP reste la voie propre long-terme. Elles ne s'excluent pas.
- **Périmètre sain pour Kory** : viser d'abord les backends à clé API ou
  locaux (GLM/Kimi/OpenRouter/Ollama — zéro problème de CGU, et pour les
  endpoints Anthropic-compatibles des vendeurs, même pas besoin de proxy :
  l'env suffit). Le montage « abonnements OAuth via CLIProxyAPI » reste un
  choix d'opérateur, pas un défaut de l'app.

---

## 5. Annexe (2026-08-15) — Munder Difflin : hive multi-CLI par fichiers

Revue de [chaitanyagiri/munder-difflin](https://github.com/chaitanyagiri/munder-difflin)
(v0.4.3, MIT) — concurrent direct du Deck : Electron + PTY/xterm enveloppant
**10 CLIs** (claude, agy, codex, grok, kimi, qwen, opencode, crush, pi,
copilot + custom), agents visualisés en avatars sur un plateau de bureau
Pixi.js, orchestrateur « god » (Michael), messagerie inter-agents et mémoire
persistante. Design source of truth : `HIVE.md` ; spec mémoire :
`MEMORY_GRAPH_SPEC.md`.

### 5.1 Leur architecture de communication (vs broker Kory)

Le « hive » est **un répertoire de fichiers plats sous git** — pas de broker :
`hive/agents/<id>/{identity.md, memory.md, inbox/, outbox/, cursor.json}` +
`registry.json` (roster), `board.md` (blackboard, scribe unique = god),
`tasks.json`, `log.jsonl`. Règles de robustesse : un JSON par message écrit en
temp+rename atomique, **single-writer-per-file** (un agent n'écrit que chez
lui ; le routeur du main process déplace outbox→inbox), **git commis par le
seul main process** (jamais par un agent — anti `.git/index.lock`).
Le broker SQLite de Kory couvre déjà tout ça en mieux (multi-machines,
groupes, auth) ; ce qui suit est ce qu'ils ont et pas nous.

### 5.2 Idées à prendre

1. **Trois étages d'observation par CLI, avec un plancher universel**
   (`shared/agentProvider.ts`, `BridgeDescriptor`) : hooks natifs (claude) →
   **shim de hooks** installé dans la config du CLI (agy/codex/pi/opencode/
   grok) → **sidecar reverse-proxy loopback** pour les CLIs SANS surface de
   hooks (qwen, crush) : la variable d'env `base_url` du CLI est pointée sur
   le sidecar, qui observe le trafic LLM et **synthétise** les mêmes
   événements (status/Stop/coût) que les shims. C'est le chaînon manquant du
   tableau nodeterm (§2.1) : une 3e voie d'observation pour le §3.1, qui rend
   « quand la tuile est-elle idle ? » répondable pour n'importe quel CLI.
2. **Le Stop hook comme point de livraison du courrier** (`HIVE.md` §5) : à
   la fin de chaque tour, le Stop hook POste sur la socket du harness ; s'il
   y a des messages non lus, la réponse est `{"decision":"block","reason":
   <messages>}` — l'agent continue de travailler et traite son courrier.
   Gardes : `stop_hook_active` (anti-boucle infinie), cap de `hops`.
   Pour Kory : un Stop hook du deck-plugin qui interroge le broker
   (`delivered=0`) ferait une **livraison de secours garantie fin-de-tour**
   sous le push `claude/channel` — et c'est le seul push « at-lifecycle »
   portable vers tout CLI à hooks bloquants.
3. **Garde d'injection « picker ouvert »**
   (`renderer/components/terminalAutomation.ts`) : ne jamais injecter dans un
   terminal dont la TUI affiche un picker slash-command (`/model`, `/mcp`,
   `/resume`… **nus** — `/model sonnet` avec argument ne bloque pas ; ils ont
   eu le bug du match sur premier token qui gelait la file à vie). Raffine
   directement la garde busy des directive cards / du nudge PTY (§3.1) :
   notre garde d'inactivité ne couvre pas ce cas.
4. **Circuit breaker coût/runaway** (`main/breaker.ts`) : Claude Code n'a pas
   de plafond en dollars (`--max-turns` seulement) ; ils imposent le leur —
   échelle **steer → constrain → stop**, une marche par battement, jamais de
   saut direct au kill, désescalade par battement sain, `hardStop` off par
   défaut ; signaux = coût/vélocité de tokens (diff d'échantillons cumulés,
   jamais un échantillon isolé), tempêtes d'erreurs/outils répétés, mtime
   sans progrès. Politique pure, séparée de l'enforcement. À rapprocher de
   notre suivi de quota : Kory n'a pas de garde-fou de dépense par agent avec
   escalade par messages correctifs.
5. **« Closing Time »** (`main/closingTime.ts`) : protocole d'arrêt sans
   perte — le lead broadcast la fermeture, chaque agent committe/parque son
   WIP, écrit état + prochaines étapes dans sa mémoire, répond
   `CLOSING-TIME-ACK` ; le lead envoie `CLOSING-TIME-COMPLETE` et l'app se
   ferme. Tout roule sur les rails existants (messagerie + réveil des idle) —
   le module n'injecte que le kickoff. Transposable quasi tel quel au Deck
   (megaphone + attente d'ACKs broker + close), là où notre fermeture de
   fenêtre perd le contexte de travail non committé.
6. **Mémoire par agent, markdown-first** : `memory.md` lu au démarrage,
   enrichi en continu, borné par réflexion/synthèse ; index sémantique
   **optionnel** en detect-and-degrade (CLI MemPalace ; no-op silencieux si
   absent — la mémoire markdown marche seule) ; panneau de recherche + graphe
   mémoire pour l'humain. Kory a la roadmap partagée mais rien de persistant
   par agent entre sessions ; la version minimale (fichier par peer_id +
   injection au spawn) serait peu coûteuse.
7. **Anti-livelock sémantique** (`HIVE.md` §4, FIPA-lite) : actes de parole
   (`request|inform|propose|query|agree|refuse|done`), seuls
   request/query/propose **obligent** une réponse, `hops` incrémenté à chaque
   réponse avec cap → escalade à l'orchestrateur au lieu de laisser deux
   agents boucler. Le broker Kory n'a aucun cap de ping-pong entre peers ;
   un champ `hops` + cap broker-side serait une piste (cf. le throttling
   natif du cross-session messaging, §rapport CC).
8. **Courrier jamais perdu en silence** : un message vers un agent
   non-livrable (CLI sans étage de réception, renderer indisponible) est
   **réadressé au god avec un sujet `[undeliverable — …relay this]`**
   (`hive.ts`) plutôt que droppé. Même philosophie que notre downgrade
   `channel`→`pty` des approbations, généralisée à tout le courrier.
9. **`context_window` réel via le statusLine hook** (`main/hooks.ts`) : le
   payload statusLine porte tokens ET taille réelle de fenêtre (200k vs 1M,
   « which nothing else exposes ») — plus simple et plus juste que le parsing
   de transcript de nodeterm pour le futur context-meter des tuiles.

### 5.2bis Zoom communication — le cycle de vie complet d'un message

Lecture de code ciblée (`hive.ts` routeur, `hooks.ts`, renderer
`useHive.ts`/`terminalAutomation.ts`), en ignorant tout le volet avatars.

**Émission** : l'agent écrit UN fichier JSON dans son `outbox/` (protocole
injecté au spawn : « NEVER write into another agent's folder — the
orchestrator delivers your outbox »). **Routage** : le main process **poll**
les outboxes (interval assumé, fs.watch jugé peu fiable sur macOS), déplace
vers les `inbox/` cibles, journalise, committe. Sémantique : `to` = agentId |
`god` | `broadcast` ; `to:"human"` → routé au god (proxy de l'humain) ;
jamais de livraison à soi-même ; un agent send-only ou un CLI sans étage de
réception → rebond au god avec sujet réécrit `[undeliverable — relay this]`.
Piège vécu : après une mise en veille, le timer du routeur n'était jamais
réarmé — god→worker et worker↔worker s'empilaient silencieusement ;
le resume ré-arme le poll ET flush le backlog immédiatement.

**Livraison dans la boucle de l'agent — l'étage clé.** Le principe :
**le terminal ne reçoit jamais le courrier, seulement un pointeur.** Le
message reste en fichier ; ce qui est éventuellement tapé dans le PTY est un
nudge court et constant (« You have new hive inbox message(s) — read your
inbox, act on them now… »). Trois mécanismes empilés :

1. **Drain au Stop hook** (claude ; codex réutilise le shim tel quel — payload
   « Claude-shaped » ; agy via shim traducteur ; opencode via plugin
   `session.idle` ; pi via extension) : fin de tour → POST sur la socket UDS →
   messages non lus → `{"decision":"block","reason":…}` → l'agent enchaîne.
2. **Nudge de réveil des idle** (renderer, poll) : dédup par **id du message
   le plus récent, pas par compteur** (un compteur oscille pendant un drain
   et re-nudge pour le même lot). Le nudge n'est PAS tapé directement : il
   est **mis en file** comme n'importe quel message opérateur.
3. **Un seul écrivain de PTY** (leur effect #4, la spec la plus aboutie du
   « nudge PTY » de notre §3.1) : la file d'un agent est drainée UN message à
   la fois, sous conditions cumulatives — idle ; hors pause de livraison
   (sauf « send now » manuel) ; hors grâce de boot (35 s après spawn, le
   temps de `/remote-control` + prompt d'orientation) ; **aucun brouillon
   utilisateur ni menu TUI ouvert** (pickers slash nus détectés, blocages
   expirant après 30 min — l'automation ne supprime jamais le texte de
   l'humain) ; cooldown 4,5 s par agent (le temps que les hooks re-flippent
   `working`) ; chaîne d'écriture par PTY (deux écrivains ne peuvent jamais
   entrelacer texte + Enter) ; bracketed paste **seulement multi-ligne**
   (agy traite les marqueurs comme du texte littéral sur une ligne) ;
   ack du message **après** succès des DEUX writes (texte puis `\r`), retries
   bornés à 3 puis drop AVEC warn (jamais de destruction silencieuse).
4. **Filet universel** : un agent `working` dont le PTY n'émet **aucun octet
   pendant 12 s** est basculé idle (un CLI ponté dont le signal de fin de
   tour ne tire jamais bloquerait sinon le nudge pour toujours ; un tour qui
   stream continue d'émettre et reste `working`).

**Discipline d'orchestration** (prompt du god, transposable au team-lead
Kory) : dispatch en contrat 4 volets — OBJECTIVE / OUTPUT / TOOLS /
BOUNDARIES — et « pass references (file paths, message ids, board sections),
not pasted content » ; vérifier le roster vivant AVANT de spawner et
préférer réutiliser un agent idle qui colle au rôle. Le heartbeat relance un
god silencieux **par son inbox**, jamais en tapant dans son PTY (« if he's
busy that would jam mid-step »).

**Lecture Kory** : c'est la validation en production de l'option « pull MCP +
nudge » du §3.1, avec le durcissement exact du chemin d'injection que nos
directive cards n'ont qu'en partie (garde brouillon/menu, dédup par id,
cooldown, chaîne mono-écrivain, ack après write, quiescence fallback). Le
découplage « courrier au broker, pointeur dans le PTY » est aussi la bonne
réponse au risque d'injection : le contenu d'un message ne transite jamais
par une frappe clavier.

### 5.2ter Arbitrages opérateur (revue du 2026-08-15)

Verdicts sur les idées du §5.2, décidés en revue :

- **1. Sidecar reverse-proxy — RETENU** (voie d'observation pour le §3.1).
  Compréhension validée : le CLI lit son URL d'API dans une variable d'env,
  on la pointe sur un proxy loopback, toutes les inférences le traversent, et
  l'état se dérive de façon déterministe (requête en vol = working, fin de
  réponse sans nouvelle requête = fin de tour synthétisée, `tool_calls` = les
  actions, `usage` = tokens). Limites à garder en tête : il voit le trafic
  API, pas la TUI (un prompt de permission clavier ressemble à de l'idle —
  d'où leur filet de quiescence PTY en complément) ; il est pull-only (rien
  ne peut être réinjecté dans le tour — le courrier passe quand même par le
  terminal) ; une forme de wire à la fois (OpenAI ou Anthropic).
- **2. Drain au Stop hook — NOTÉ, PAS RETENU.** Inbox vide = zéro coût (le
  hook rend la main sans tour supplémentaire) ; le tour payé n'existe que
  quand il y a du courrier, et c'est le traitement du message, payé aussi via
  un nudge. Mais le drain force le traitement immédiat en fin de CHAQUE tour
  (contexte complet re-facturé, cache aidant), là où le nudge laisse batcher
  à l'idle — et le nudge est multi-CLI par construction. Kory reste sur la
  voie nudge.
- **3. Garde picker/brouillon + durcissement de l'injection — À PRENDRE**
  (bugs réels vécus chez eux ; complète notre garde busy).
- **4. Circuit breaker de coût — MIS DE CÔTÉ** : Kory ne mesure aujourd'hui
  ni tokens ni coût ; sans cette télémétrie le breaker n'a pas d'entrées.
- **5. Closing Time — équivalent Kory existant** via la restauration de
  sessions Claude (`--fork-session`), qui remet l'agent exactement dans son
  état. Claude-only : à re-noter le jour des tuiles d'autres familles LLM.
- **6. Mémoire par agent — idem** : gérée nativement par Claude ; la valeur
  n'apparaît qu'avec d'autres familles de modèles.
- **7. Anti-livelock — RETENU comme pièce importante** (voir ci-dessous).
  Jamais de ping-pong incessant constaté en sessions longues réelles ; le
  vrai coût est la QUEUE de politesse, pas la boucle infinie.
- **8. Courrier jamais perdu (rebond `[undeliverable]` au lead) — À NOTER.**

**Anti-livelock, formulation retenue.** Le livelock n'est pas le deadlock :
personne n'est bloqué, les messages circulent, rien n'avance. Le scénario
concret : A envoie son résultat à B ; B répond « bien reçu, merci » ; or les
instructions serveur disent « RESPOND IMMEDIATELY […] reply using
send_message » — chaque message reçu OBLIGE une réponse, y compris une
réponse à une réponse, donc A répond « parfait, n'hésite pas », etc. Claude
a le jugement de s'arrêter après un ou deux tours, donc pas de boucle infinie
observée — mais chaque « bien reçu » est un tour LLM à contexte complet :
le coût réel est les 2-3 accusés de réception polis après chaque vraie
interaction. L'anti-livelock = des freins DÉTERMINISTES dans le transport,
pour que la terminaison ne dépende pas du jugement du modèle :
seuls `request`/`query`/`propose` appellent une réponse (`inform`/`done`
terminaux — le destinataire est explicitement autorisé à ne pas répondre) ;
compteur de `hops` par fil avec cap → escalade au lead ; idempotence par id.
Kory a déjà l'outil pour un cas (megaphone `deck` rendu « informational only
-- do not reply », réponse structurellement impossible) ; la généralisation
est un champ optionnel `expects_reply` sur `send_message`, rendu côté
`server.ts` en « no reply expected — do not acknowledge » quand il est faux,
plus un cap de hops broker-side. Précédent externe : le cross-session
messaging natif de Claude Code embarque les mêmes freins (rate-limit par
émetteur, drop des répétitions identiques, cap de file).

### 5.3 À ne pas prendre

- **Le hive-par-fichiers lui-même** : mono-machine, pas d'auth, pas de
  groupes ; notre broker le domine sur tout sauf la simplicité.
- **Le god agent comme guichet HITL** : leur choix assumé (« pas de file
  d'approbations séparée », les prompts de permission dans la session du god
  sont la porte) est plus faible que notre broker arbitre unique
  (`/approval/claim` conditionnel) + inbox opérateur + canaux téléphone.
- **Avatars Pixi.js** : parti-pris esthétique opposé à `DESIGN.md` (et un
  moteur de rendu de plus à maintenir).
- **Dépendance MemPalace** : leur propre doc note des benchmarks surestimés
  (audit indépendant) — d'où leur detect-and-degrade, la seule partie à
  imiter.
