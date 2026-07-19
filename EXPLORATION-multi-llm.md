# EXPLORATION — Support de LLM non-Anthropic dans les inférences de l'app

> Travail exploratoire (pas de code) mené depuis `experimental`. Question posée :
> aujourd'hui, est-ce que les agents, le superviseur, la roadmap et les actions
> d'inférence utilitaires (aide, baguette de contexte, digest, résumé…) peuvent
> tourner sur autre chose qu'Anthropic ? Et que faudrait-il pour rendre le
> modèle choisissable dans les options, avec quelles syntaxes CLI côté
> Codex / Gemini / LiteLLM / Ollama ?

## 1. État des lieux — inventaire des points d'inférence

Deux familles coexistent déjà sur `experimental` : une infrastructure
multi-provider complète (construite pour le graph chat, lot C24/C29) et une
série de points d'inférence encore câblés en dur sur `claude`.

### 1.1 Déjà multi-provider ✅

| Point d'inférence | Fichiers | Providers supportés |
|---|---|---|
| **Graph chat (fan-out)** | `desktop/src/main/model-adapters.ts`, `graph-engine.ts`, `GraphView.tsx` | `claude` / `codex` / `gemini` (CLI headless) + `local` (HTTP OpenAI-compat : Ollama, LiteLLM, vLLM, OpenRouter…) |
| **Catalogue de modèles** | `desktop/src/shared/models.ts`, `desktop/src/main/model-registry.ts` | Catalogue frontier curé en code (D10) + découverte dynamique des endpoints locaux (`/v1/models`, fallback Ollama `/api/tags`), provider frontier affiché seulement si son CLI est détecté sur la machine (D11) |
| **Secrets provider** | `desktop/src/main/provider-secrets.ts` | Clés API des endpoints locaux chiffrées au repos (safeStorage), trois zones de confiance (`apiKey` transient / `apiKeyEnc` au repos / `hasKey` côté renderer) |
| **Résumé auto des peers** (cœur claude-peers) | `shared/summarize.ts`, `shared/config.ts` | `anthropic` (Messages API) ou `openai-compat` (n'importe quel `/chat/completions`), sélection via `CLAUDE_PEERS_SUMMARY_PROVIDER` / `summary_base_url` / `summary_api_key` / `summary_model`, fallback heuristique |

Le sélecteur UI (`ModelPicker.tsx`) et le mécanisme de favoris
(`favKey`/`resolveFavorites`) sont **génériques** : ils consomment des
`ProviderCatalog` et produisent des `ModelTarget { cli, model, providerId? }`.
C'est la brique de réutilisation naturelle pour tout le reste.

### 1.2 Encore Anthropic-only ❌

| Point d'inférence | Fichier / ligne | Verrou actuel |
|---|---|---|
| **Aide (bouton « ? »)** | `desktop/src/main/help-assistant.ts:25-26` | `HELP_MODELS = ['haiku','sonnet','opus']`, défaut `haiku`, commande `claude -p` construite par `buildHelpCommand` ; le réglage Settings (`helpModel`, `store.ts:37`) ne propose que ces trois alias (`SettingsView.tsx:197`) |
| **Baguette de contexte roadmap (🪄)** | `desktop/src/main/context-wand.ts:20`, `ipc.ts:324-327` | `WAND_MODEL = 'haiku'` **épinglé en dur**, aucun réglage ; passe par `buildHelpCommand` donc `claude -p` uniquement |
| **Digest de reprise** | `desktop/src/main/digest.ts`, `ipc.ts:554-557` | Réutilise `buildHelpCommand` + `getConfig().helpModel` → Claude uniquement |
| **Juge du battle mode** | `graph-engine.ts:165` (`DEFAULT_JUDGE`), `GraphView.tsx:290` | Le **modèle** du juge est saisissable, mais le CLI est forcé `{ cli: 'claude' }` côté renderer — le moteur, lui, accepte n'importe quel `ModelTarget` (sauf `local`, non géré pour le juge : `buildAdapterCommand` est appelé directement) |
| **Sessions agents (tuiles)** | `session-command.ts`, `launch-config.ts:14` | `DEFAULT_LAUNCH_COMMAND = 'claude --dangerously-load-development-channels …'` ; le menu de création ne fusionne que le catalogue Anthropic (`CreateMenu.tsx:39-49`, `cli: 'claude'` forcé) ; suffixe `[1m]` spécifique Claude Code |
| **Superviseur (Home)** | `supervisor.ts` | Session Claude Code avec `--mcp-config` (deck-control) + `--append-system-prompt-file` |
| **Import de plan** | `import-plan.ts` | Session agent one-shot pilotée par prompt, dépend des outils MCP `roadmap_*` et de `/exit` |

**Réponse courte à la question posée : non.** Aujourd'hui seuls le graph chat
et le résumé des peers savent parler à autre chose qu'Anthropic. L'aide, la
baguette, le digest, le juge (côté UI), les agents et le superviseur sont tous
sur `claude`, et trois de ces points (aide, baguette, digest) sont en plus
restreints aux trois alias `haiku|sonnet|opus`.

## 2. Syntaxes headless vérifiées (équivalents de `claude -p`)

Vérifié dans la doc officielle / sources secondaires en juillet 2026. Les
adaptateurs existants (`model-adapters.ts`) sont **conformes** ; une
limitation documentée est devenue obsolète (voir Gemini).

### 2.1 Claude Code (référence)

```bash
claude -p '<question>' \
  --append-system-prompt-file "<ctx.md>" \
  --model haiku \
  --strict-mcp-config \
  --disallowedTools "Bash,Edit,Write,…"
```

Points clés : injection système par fichier, harnais read-only par déni
d'outils, `--model` accepte alias ou id complet.

### 2.2 Codex CLI (OpenAI) — `codex exec`

```bash
# prompt en argument positionnel
codex exec --sandbox read-only -m gpt-5.1-codex "…question…"
# prompt via stdin (le pattern actuel de l'app)
codex exec --sandbox read-only -m gpt-5.1-codex - < contexte.md
```

- Mode non-interactif : `codex exec` (session unique, réponse finale sur
  stdout, progression sur stderr). stdin lu quand `-` est passé ou qu'aucun
  argument prompt n'est fourni.
- Modèle : `-m` / `--model`.
- Sandbox : `--sandbox read-only | workspace-write | danger-full-access` —
  l'équivalent direct de notre harnais read-only existe (déjà utilisé).
- Sorties : `--json` (flux JSONL d'événements), `-o/--output-last-message
  <fichier>` (message final seul).
- Répertoire : `-C/--cd <dir>`.
- **Injection système (nouveau vs D5)** : `-c developer_instructions="…"`
  (ajoute au prompt système) et `-c model_instructions_file="/chemin"`
  (remplace le prompt système par un fichier) — un équivalent fonctionnel de
  `--append-system-prompt-file` existe donc, alors que l'adaptateur actuel
  compose tout dans le prompt stdin. Optionnel : le pattern stdin reste valide.
- Reprise : `codex exec resume --last` (sans équivalent de `--fork-session`).

### 2.3 Gemini CLI

```bash
gemini -p "…question…" -m gemini-3-flash --approval-mode plan
# ou en pipe (le -p s'ajoute au contenu stdin)
cat contexte.md | gemini -p "…question…" -m gemini-3-flash --approval-mode plan
```

- Mode headless : `-p/--prompt` (ou automatiquement en environnement
  non-TTY — c'est ce qui fait marcher l'adaptateur actuel en pur stdin).
  stdin est lu intégralement et le `-p` est **ajouté après** le contenu piped.
- Modèle : `-m/--model`.
- **Harnais read-only (invalide la limitation D6)** : `--approval-mode plan`
  est documenté comme mode lecture seule (valeurs : `default`, `auto_edit`,
  `yolo`, `plan`). Le commentaire de `model-adapters.ts:16-17` (« gemini has
  no reliable equivalent ») date de l'exploration C24 et n'est plus vrai.
  `--allowed-tools` permet en plus de restreindre les outils.
- Sorties : `--output-format json | stream-json` ; codes de sortie documentés
  (0 succès, 1 erreur, 42 erreur d'entrée, 53 limite de tours).
- Pas de flag d'injection système ; la composition système+contexte+question
  dans le prompt (pattern actuel) reste la bonne approche.

### 2.4 LiteLLM / Ollama / vLLM (HTTP, pas de CLI)

Le pattern retenu par C29 — HTTP direct plutôt qu'un CLI — est le bon et les
endpoints utilisés sont les endpoints documentés :

- Ollama : base `http://localhost:11434/v1`, `POST /v1/chat/completions`,
  `GET /v1/models` (compat OpenAI officielle ; clé API facultative — n'importe
  quelle chaîne). Le fallback natif `GET /api/tags` de `model-registry.ts`
  couvre les vieux Ollama sans `/v1/models`.
- LiteLLM proxy : `POST /v1/chat/completions`, `GET /v1/models`, auth
  `Authorization: Bearer <clé>` — exactement ce que fait
  `buildChatCompletionRequest` (`model-adapters.ts:117`).
- `chatCompletionsUrl` gère déjà les bases avec ou sans suffixe `/v1`.

Rien à changer sur cette famille.

## 3. Ce qu'il faudrait pour « choisir le modèle dans les options »

### 3.1 Lot A — inférences utilitaires (aide, baguette, digest, juge) : faisable à coût raisonnable

Toute la mécanique existe déjà ; il s'agit de généraliser le type du réglage
et de router vers les adaptateurs C24/C29 au lieu de `buildHelpCommand` :

1. **Réglage** : remplacer `helpModel: string` (`shared/types.ts:177`) par un
   `ModelTarget` (ou une clé favorite `providerId:modelId`), et ajouter un
   réglage distinct pour la baguette (aujourd'hui épinglée `haiku`) — l'idée
   « la baguette drafte, l'opérateur décide » reste un bon défaut, mais le
   modèle doit être choisissable (ex. un modèle local gratuit). Un troisième
   réglage pour le digest peut simplement hériter de celui de l'aide.
2. **UI Settings** : réutiliser `ModelPicker` + `getCatalogs()` (détection CLI
   + découverte locale) à la place du `<select>` en dur de
   `SettingsView.tsx:197`. Idem pour le juge dans `GraphView.tsx` (aujourd'hui
   un champ texte + `cli: 'claude'` forcé).
3. **Exécution** : router selon `target.cli` —
   - `claude` : chemin actuel (`buildHelpCommand`) inchangé ;
   - `codex` / `gemini` : `buildAdapterCommand` + `writeContextFile` avec le
     prompt composé (système + snapshot + question), comme le graph chat ;
   - `local` : `runHttpInference` (système et question déjà séparés — mapping
     direct).
4. **Harnais read-only par CLI** : `claude --strict-mcp-config
   --disallowedTools`, `codex --sandbox read-only`, `gemini --approval-mode
   plan` (mise à jour de D6), local = pas d'outils du tout (pur chat).
   ⚠️ Perte fonctionnelle assumée hors `claude`/`codex` : l'aide et la
   baguette utilisent Read/Grep/Glob pour se « grounder » dans le repo ; en
   HTTP local il n'y a pas d'outils, donc briefings moins ancrés — à
   documenter dans le help-text du réglage.
5. **Transcript de l'aide** : `buildHelpPrompt` (historique rejoué) est
   agnostique du provider — rien à faire.

Le juge `local` demande une petite retouche de `runInference`
(`graph-engine.ts:300`) qui appelle `buildAdapterCommand` sans traiter le cas
`cli: 'local'` (qui `throw` aujourd'hui).

### 3.2 Lot B — sessions agents et superviseur : chantier séparé, beaucoup plus lourd

Les tuiles agents ne sont pas de simples inférences : elles reposent sur des
capacités spécifiques de Claude Code que les autres CLIs n'offrent pas sous
la même forme :

- cycle de vie : `--session-id`, `--resume <id> --fork-session` (codex a
  `exec resume --last`, gemini n'a pas d'équivalent piloté par id) ;
- harnais : `--agent <profil>`, `--effort`, `--plugin-dir` (hook SessionStart
  du deck), `--append-system-prompt-file` (ancre du superviseur) ;
- outillage : serveurs MCP `claude-peers` (messagerie inter-agents),
  `deck-control` (pilotage de l'app par le superviseur) et `roadmap_*`.
  Codex et Gemini savent charger des serveurs MCP, mais toute la logique de
  configuration (fichiers `--mcp-config` générés, TOFU du broker, briefing)
  est écrite pour Claude Code ;
- suffixe `[1m]` (contexte 1M) : purement Claude.

Un agent Codex/Gemini « au rabais » (sans peers, sans roadmap, sans fork)
casserait le contrat de supervision. Recommandation : **exclure du présent
sujet** et, si le besoin se confirme, l'instruire comme une exploration
dédiée (probablement via le `launchCommand` configurable qui permet déjà de
lancer autre chose dans une tuile, mais sans intégration Deck).

### 3.3 Divers

- **Résumé peers** : déjà multi-provider ; éventuellement exposer les quatre
  champs `summary_*` dans l'UI Settings du desktop au lieu du seul fichier
  config/env.
- **Import de plan** : suit le lot B (c'est une session agent).
- `sanitizeModel` accepte déjà `[A-Za-z0-9._:-]` — couvre les tags Ollama
  (`llama3.1:8b`) et les ids Gemini/OpenAI. Le suffixe `[1m]` n'y passe pas,
  mais il ne concerne que les sessions (lot B).

## 4. Synthèse des décisions à prendre

| # | Question | Recommandation |
|---|---|---|
| 1 | Un réglage par action (aide / baguette / digest / juge) ou un réglage global « modèle utilitaire » ? | Un réglage « aide & digest » + un réglage « baguette » + le juge déjà par-graphe. Défauts actuels conservés (`haiku`) |
| 2 | Mettre à jour D6 pour Gemini (`--approval-mode plan`) ? | Oui — retirer la mention « no reliable equivalent » et passer le flag dans l'adaptateur |
| 3 | Utiliser `codex -c model_instructions_file` au lieu du prompt composé stdin ? | Non-bloquant ; le pattern stdin actuel marche. À envisager si les réponses codex régurgitent le contexte |
| 4 | Agents/superviseur non-Claude ? | Hors périmètre — exploration dédiée si le besoin se confirme (lot B) |

## Sources

- Codex CLI : `openai/codex` `docs/exec.md` → developers.openai.com/codex/noninteractive ; batterie de tests exec (gist alexfazio, 81 essais vérifiés flag par flag)
- Gemini CLI : `google-gemini/gemini-cli` `docs/cli/headless.md` (mode headless, `-p`, `--output-format`, codes de sortie) ; README (flags `-m`, `--approval-mode default|auto_edit|yolo|plan`, `--allowed-tools`, `-s`)
- Ollama : docs.ollama.com/api/openai-compatibility (`/v1/chat/completions`, `/v1/models`, base `:11434/v1`, clé facultative)
- LiteLLM : proxy OpenAI-compat (`/v1/chat/completions`, `/v1/models`, Bearer) — déjà le contrat implémenté et testé par `model-adapters.ts` / `model-registry.ts`
