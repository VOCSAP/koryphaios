# Brief — ce que Kory reprend de herdr

Analyse comparative de [herdr](https://github.com/herdrdev/herdr) (commit
`1c76079`, 2026-08, licence Apache-2.0) et plan d'adoption en six chantiers.
But du document : pouvoir démarrer n'importe lequel des chantiers sans refaire
l'analyse — chaque section cite les mécanismes herdr source et les fichiers
Kory cibles.

> Convention CLAUDE.md : les ids `H1`…`H6` ci-dessous servent à ce brief et aux
> messages de commit/cartes roadmap. **Ne pas les recopier en tag dans des
> commentaires de code** (les ids de chantier en commentaire sont un artefact
> historique, plus jamais ajoutés).

## 1. Ce qu'est herdr, en une page

Herdr n'est **pas un bus de messages** : c'est un multiplexeur de terminaux
Rust (façon tmux) dont le serveur d'arrière-plan possède les PTYs ; le TUI et
la CLI s'y rattachent. Son agnosticisme LLM tient à un choix d'architecture :
**toute la coordination passe par le terminal**, jamais par un protocole propre
au LLM. Mécanismes, avec leurs sources :

- **Détection d'état par manifests** (`src/detect/manifests/*.toml`, moteur
  `src/detect/manifest.rs`) : ~20 manifests par agent (claude, codex, gemini,
  cursor, grok, opencode…) décrivant des règles région+regex+priorité qui
  classent un pane en `working` / `blocked` / `idle` / `unknown`. Les régions
  sont sémantiques : `osc_title`, `osc_progress`,
  `bottom_non_empty_lines(N)`, `prompt_box_body`,
  `after_last_horizontal_rule`, `whole_recent`,
  `last_non_empty_above_prompt_box`. Chaque règle peut porter des gardes
  `not`/`any`/`all`, un drapeau `skip_state_update` (écran transitoire :
  transcript viewer, model picker), et des drapeaux `visible_working` /
  `visible_blocker` / `visible_idle`. Manifests versionnés
  (`version`, `min_engine_version`), catalogue distant
  (`https://herdr.dev/agent-detection/index.toml`,
  `src/detect/manifest_update.rs`) avec override local, et un mode `explain`
  (`DetectionExplain`) qui dit quelle règle a matché et pourquoi.
- **OSC comme signal prioritaire, mais de façon ASYMÉTRIQUE** (formulation
  corrigée le 2026-08-26 après lecture du manifest ; la version précédente de
  cette puce disait « la règle la plus haute priorité lit le titre OSC », ce
  qui est vrai et incomplet, et c'est l'omission qui a failli faire porter le
  moteur de travers -- voir §2 bis). Dans `src/detect/manifests/claude.toml`,
  DEUX règles lisent la même région `osc_title` à des rangs opposés :
  `osc_title_working` (spinner braille/demi-cercles) est à `priority = 1100`,
  le rang le plus haut du fichier ; `osc_title_idle` (glyphe `✳`) est à
  `priority = 250`, sous **toutes** les règles `blocked` du même manifest
  (`live_blocked_form` et `dynamic_workflow_prompt` à 980,
  `bash_permission_prompt` à 850, `generic_permission_prompt` à 840,
  `legacy_no_prompt_blocker` à 300). Herdr ne se sert donc jamais du titre
  pour trancher `idle` contre `blocked` : il ne s'en sert comme signal d'idle
  que si rien d'autre n'a matché. L'entrée du moteur est un triplet
  `{ screen, osc_title, osc_progress }` (`DetectionInput`,
  `src/detect/manifest.rs`), **trois chaînes, aucun horodatage ni compteur** :
  herdr classe par CONTENU seul, jamais par fréquence d'émission. Chaînes
  vides = comportement pré-OSC. Le seul usage du temps dans tout herdr est un
  anti-rebond de la transition `working -> idle`
  (`should_hold_working_to_idle`, `src/pane/agent_detection.rs`), pas un
  prédicat d'activité.
- **Prompt inter-agents = injection terminal encadrée**
  (`herdr agent prompt <name> "..." --wait`, skill `skills/herdr/SKILL.md`) :
  collage bracketed-paste + Enter différé, avec trois garde-fous :
  `agent_blocked` (refus d'injecter si l'écran est un dialogue
  d'approbation/question), `agent_prompt_stalled` (aucun changement d'état
  observé sous 5 s ⇒ erreur au lieu d'attente infinie,
  `AGENT_PROMPT_EFFECT_TIMEOUT_MS` dans `src/api/wait.rs`), et `--wait` qui
  attend le premier état stable (`idle`/`done`/`blocked`).
- **Primitives d'attente** : `agent wait --until <state>`,
  `pane wait-output --match/--regex --timeout`, API socket JSON avec
  abonnements (`pane.agent_status_changed`, `pane.output_matched` —
  `src/api/schema/events.rs`, `src/api/subscriptions.rs`).
- **Sémantique vu/pas-vu** : `done` = même état sous-jacent qu'`idle`, mais le
  travail s'est terminé pendant que l'onglet n'était **pas affiché** dans l'UI
  focalisée. Focaliser l'onglet (ou le cibler par une commande focus) le marque
  « vu » ; une lecture CLI ne le marque pas. C'est le « never hunt for the
  stuck one » du README.
- **Resume par agent-kind** (`src/agent_resume.rs`) : persiste un session-ref
  par agent (`claude --resume <id>`, équivalents) pour relancer les agents
  après redémarrage du serveur.
- **Skill discipliné** : garde d'environnement (`HERDR_ENV=1` sinon stop), « le
  binaire installé est l'autorité pour la syntaxe » (`--help` plutôt que
  syntaxe mémorisée), IDs lus dans le JSON des réponses, interdiction de
  fermer ce qu'on n'a pas créé.

## 2. Périmètre — ce qu'on ne copie PAS

Kory possède déjà le **plan de contrôle** que herdr n'a pas : messagerie
routée multi-machines avec groupes TOFU, delivery hardening, roadmap partagée,
canal opérateur/annonces, Deck. Herdr apporte le **plan d'observation**
(détection agnostique, attente, garde-fous d'injection). On ne reprend donc
ni le serveur de terminaux persistant, ni le remote attach ssh, ni le système
de plugins, ni le TUI. Le resume par agent-kind (`agent_resume.rs`) est noté
en §5 (hors périmètre immédiat, recouvre partiellement
`checkpoint-service.ts`).

État Kory au moment de l'analyse (branche `experimental`) :

- La détection Deck est **codée en dur pour Claude Code** :
  `desktop/src/main/attention.ts` (`BUSY_RE = /esc to interrupt|[⠀-⣿]/i`,
  `WAITING_PATTERNS`), `quota.ts`, `startup-ack.ts` — regex inline en TS,
  buffers roulants ANSI-strippés par session, alimentés par
  `session-service.ts`. Or le Deck lance déjà codex/gemini/opencode
  (`model-registry.ts` `FRONTIER_BINS`, `session-kind.ts`) : ces tiles n'ont
  **aucune** détection d'attention/activité.
- `activity_status` du broker (`shared/types.ts`,
  `broker.ts` `handleListPeers`) est purement basé sur la récence
  (`active`/`sleep`/`closed`) — aucun état de cycle de vie
  (working/blocked/idle).
- Le canal peers est MCP-only (`server.ts` stdio) : un agent non-MCP dans un
  tile ne participe pas au réseau.
- `check_messages` est le seul mode pull ; aucun outil bloquant « attendre une
  réponse ».

## 2 bis. Mesures locales du 2026-08-26 (à lire avant H1 et H2)

Section ajoutée après arbitrage du team-lead, sur la copie locale de herdr
(`kory-spike/herdr-master`, pas de `.git`, manifest claude `version =
"2026.08.21.1"`). Elle ne réorganise rien : elle inscrit quatre faits que le
corps du brief ne portait pas et qui changent la conception de H1 et de H2.

### 2 bis.1 Les trois OSC ne sont pas le même objet, ni la même caution

Le mot « OSC » recouvre trois séquences distinctes, et les deux documents de
conception de ce dépôt n'en couvrent pas les mêmes. Table de correspondance,
à garder sous les yeux en lisant H1 et H2 :

| Séquence | Ce qu'elle porte | Mesurée par | Statut chez nous |
|---|---|---|---|
| `OSC 0` / `OSC 2` (titre) | le glyphe de spinner, réécrit pendant le travail | herdr (contenu) **et** `DESIGN-NOTIFY-EVENTS.md` (fréquence **et** contenu) | seul objet où les deux lectures se rencontrent |
| `OSC 9;4` (progress) | un état de progression standard | herdr seul | **aucune mesure locale**, zéro occurrence dans `DESIGN-NOTIFY-EVENTS.md` |
| `OSC 777` (notification) | « quelque chose te réclame », avec un corps qui précise quoi | `DESIGN-NOTIFY-EVENTS.md` seul (21 kinds vers 11 corps) | capteur mécanique de levée, **absent de herdr** |

Conséquence à ne pas laisser passer : la liste des régions v1 de H1 met
`osc_title` et `osc_progress` **au même rang de confiance**, alors que le
second n'a **aucune** mesure locale derrière lui. Il est repris sur la foi de
herdr seul. À traiter comme une hypothèse à vérifier au premier manifest qui
s'en sert, pas comme un acquis.

Ce que la mesure locale invalide, et seulement cela : `DESIGN-NOTIFY-EVENTS.md`
établit que pendant une invite de permission affichée, le titre portait le
**même glyphe qu'au repos**. Donc `absence de spinner => idle` est mort comme
règle de haut rang. Rien n'y contredit `spinner => working`. C'est exactement
le partage que les rangs 1100 / 250 de herdr encodent déjà (§1), et c'est
pourquoi le portage doit conserver ces rangs plutôt que d'éviter le contenu.

### 2 bis.2 herdr n'a aucun OSC 777 : sa détection de `blocked` est textuelle

Mesuré sur la copie locale : les seules occurrences de `777` dans les sources
Rust sont des masques de permissions `0o777` et une séquence CSI de taille de
fenêtre ; **zéro** dans `src/detect/manifests/`. Toute la détection de
`blocked` de herdr repose donc sur du grattage d'écran textuel
(`contains = ["do you want to proceed?"]`, `["esc to cancel"]`,
`["waiting for permission"]`...).

Or nous disposons d'un capteur que herdr n'a pas : `OSC 777`, mécanique,
spécifié dans `DESIGN-NOTIFY-EVENTS.md`. **Importer les règles `blocked` des
manifests telles quelles serait une régression de classe de capteur**, et ce
dépôt a déjà payé deux fois cette classe (une regex morte par changement de
vocabulaire du CLI ; le motif `do you trust the files` de
`desktop/src/main/attention.ts`, `detectWaiting`, mort depuis au moins trois
versions du binaire).

**Décision (team-lead, 2026-08-26) : repli strict.** `OSC 777` est
l'AUTORITÉ pour lever `blocked`. Les règles `blocked` portées depuis les
manifests sont un repli de rang inférieur, jamais l'autorité.

**Nuance obligatoire, sans laquelle « repli » se lit « accessoire ».** Pour
les agent-kinds qui n'émettent pas d'`OSC 777` -- vraisemblablement tous sauf
claude, non mesuré -- le grattage textuel est le SEUL capteur disponible : le
repli y devient l'unique source. Le manifest doit donc porter la CONFIANCE du
capteur et pas seulement sa priorité, et les consommateurs doivent traiter les
deux directions différemment. C'est l'asymétrie déjà documentée dans
`desktop/src/main/attention.ts` : le prédicat de LEVÉE (`detectWaiting`) est
délibérément conservateur dans la direction du non-déclenchement, parce qu'une
levée manquée est bornée et une fausse levée n'est qu'un scintillement ; le
prédicat d'EXTINCTION (`stillWaiting`) ne réutilise PAS ce prédicat, parce que
« lever et éteindre sont des décisions opposées sous incertitude » et
qu'éteindre sous incertitude **perd un opérateur qui attend vraiment**.
Transposée ici : une garde d'injection peut refuser sur un `blocked` de
confiance basse ; un affichage qui EFFACE un état ne doit jamais s'y fier.
Reprendre cette formulation, ne pas en inventer une autre.

Corroboration indépendante, mesurée sur `grok.toml` : le commentaire de la
règle `background_work_chip_working` dit que Grok **éteint** ses signaux OSC
busy pendant que du travail de fond tourne, et la règle existe précisément
pour rattraper ce trou par l'écran. Un capteur OSC seul est donc
structurellement insuffisant, et le repli écran est une nécessité, pas une
commodité.

### 2 bis.3 Le prix mesuré de l'abandon du catalogue distant

H1 écarte le catalogue distant de manifests, et cette décision tient (surface
réseau, entrée hostile). Ce qui manquait, c'est son PRIX, et la copie locale
le donne : le dépôt herdr embarque ses manifests dans
`src/detect/manifests/` **et** sert les mêmes sous `website/agent-detection/`.
Comparés répertoire à répertoire au même instantané, ils divergent déjà :
20 manifests de chaque côté, un seul fichier différent (`grok.toml`) plus un
`index.toml` présent uniquement côté servi.

Sur ce fichier, la copie SERVIE est en retard : `version 2026.07.16.1` contre
`.2` embarquée, et il lui manque une règle entière,
`background_work_chip_working`, à la priorité la plus haute du fichier. Une
règle sur vingt manifests a donc dérivé à l'intérieur d'une seule release, et
la règle en cause n'est pas cosmétique.

Deux conséquences pour nous :

- l'override local dans le répertoire de config utilisateur est la **seule**
  soupape quand un CLI change d'UI entre deux de nos releases. À traiter comme
  un chemin de première classe (documenté, testé), pas comme une commodité de
  dépannage ;
- la dérive a fait passer `min_engine_version` de `2` à `3` : une règle
  nouvelle a exigé un moteur nouveau. Notre format de manifest doit donc
  porter la même notion de version de moteur, et un manifest exigeant un
  moteur plus récent que le nôtre doit être **refusé bruyamment**. Sans cela,
  un override local trop récent charge à moitié, en silence.

## 3. Les six chantiers

Ordre recommandé et dépendances en §4. Chaque chantier est livrable seul.

### H1 — Moteur de détection à manifests (le gros morceau)

**But.** Remplacer les regex Claude-only codées en dur par un moteur générique
piloté par des manifests par agent-kind, pour que `working`/`blocked`/`idle`
existent sur tout tile (claude, codex, gemini, opencode…), et que l'ajout d'un
agent ou l'adaptation à un changement d'UI soit une édition de données, pas de
code.

**Design proposé.**

- Nouveau module `desktop/src/main/detect/` : moteur pur (aucun import
  electron/node-pty, testable sous bun — même discipline que
  `session-kind.ts`) + manifests par agent.
- **Format JSON, pas TOML** : pas de nouvelle dépendance côté Electron, et les
  manifests herdr se transposent mécaniquement (mêmes clés : `id`, `state`,
  `priority`, `region`, `regex`/`line_regex`/`contains`, `any`/`all`/`not`,
  `skip_state_update`, `visible_*`). Chaque manifest porté depuis herdr garde
  un en-tête d'attribution (voir §6 licence).
- Régions v1 (sous-ensemble suffisant pour les manifests claude/codex/gemini) :
  `osc_title`, `osc_progress` (fournis par H2), `bottom_non_empty_lines(N)`,
  `whole_recent`. `prompt_box_body` et `after_last_horizontal_rule` en v2 si
  les faux positifs l'exigent. L'extraction de régions travaille sur le
  buffer roulant ANSI-strippé existant (pattern `quota.ts` : `MAX_BUF`,
  `feed()`), PAS sur une grille d'écran — herdr a un vrai screen model, nous
  avons un flux ; les régions « bottom » se calculent sur les dernières lignes
  non vides du buffer. `screen-model.ts` (qui sait déjà reconnaître le prompt
  idle sur fixtures) est le candidat naturel pour héberger l'extraction si le
  buffer brut ne suffit pas.
- États : `working` / `blocked` / `idle` / `unknown`. (`done` est un overlay
  Deck-side, chantier H6, pas un état du moteur — même découpage que herdr.)
- Consommateurs : `attention.ts` devient un consommateur de l'état `blocked`
  (en **conservant** son asymétrie raise/clear documentée — lever le drapeau
  sous certitude faible est bénin, l'effacer sous certitude faible perd un
  opérateur qui attend ; cette logique reste, seule la source des cues
  change). `session-service.ts` alimente le moteur là où il alimente déjà
  `quota.feed`/attention.
- Sélection du manifest : par `session-kind`-like résolu au spawn (le Deck
  sait quel CLI il lance — `resolveClaudeLaunch` gèle déjà ce genre de fait
  dans RuntimeState au spawn ; même discipline, généralisée à un
  `agentKind`).
- Debug : reprendre l'idée `explain` de herdr — un canal IPC read-only
  renvoyant `{ state, matchedRule, evaluatedRules }` pour une session, branché
  plus tard sur un panneau dev du Deck. Indispensable pour maintenir des
  manifests regex sans deviner.
- **Pas de catalogue distant** (différence assumée avec herdr) : manifests
  embarqués + override dans le répertoire de config utilisateur
  (`$XDG_CONFIG_HOME/koryphaios/detect/*.json`) uniquement. Un fetch distant
  rejouerait la surface M-SEC-4 (SSRF/endpoint non validé, cf. `BACKLOG.md`)
  pour un bénéfice différable. **Jamais** de manifest lu depuis le dépôt
  cloné (entrée hostile n°1 du tableau CLAUDE.md : un repo ne doit pas
  pouvoir reprogrammer la détection — un manifest malveillant masquerait un
  `blocked` d'approbation, cf. H4).
- Tests : fixtures d'écran par agent-kind (le repo herdr et
  `screen-model.ts` montrent le format), une fixture par règle portée, plus
  les cas « transitoires » (transcript viewer, model picker). Règle de
  couverture CLAUDE.md : le moteur est un mécanisme de gate — auditer ce qui
  produit un SOUS-ENSEMBLE silencieux (manifest absent pour un kind lancé ⇒
  état `unknown` explicite, jamais `idle` par défaut) et ce qui étend le
  domaine sans le toucher (nouvel agent-kind ajouté à `FRONTIER_BINS` sans
  manifest ⇒ test de parité entre les deux listes).

**Contraintes de portage -- mesures du 2026-08-26.** Quatre contraintes qui ne
sont pas des préférences de style : chacune ferme un chemin où le moteur se
dégrade en silence.

1. **Le portage TOML vers JSON conserve les priorités À LA RÈGLE PRÈS.** Ce
   n'est PAS l'évitement du contenu du titre qui rend le mécanisme herdr
   valide, c'est le RANG : `osc_title -> working` en tête (1100 dans
   `src/detect/manifests/claude.toml`), `osc_title -> idle` en queue (250),
   sous toutes les règles `blocked` (980 / 850 / 840 / 300). Voir §2 bis.1
   pour la mesure locale qui l'exige. Un porteur qui renumérote « pour
   simplifier », ou qui range les deux règles `osc_title` côte à côte parce
   qu'elles partagent une région, casse la détection **sans qu'aucun test ne
   bouge** : la règle idle remonterait au-dessus des règles blocked et une
   session bloquée s'afficherait au repos. Le test de portage doit donc
   comparer les priorités règle par règle avec la source, pas seulement
   vérifier que le manifest charge.
2. **La FRÉQUENCE n'entre pas dans le moteur (v1, étanchéité totale).** Une
   région est une projection PURE d'un instantané ; une fréquence d'émission
   est un état TEMPOREL PAR SESSION. Faire entrer le second dans le premier
   introduirait un état keyé par session dans un moteur qui n'en a pas, et la
   question de `CLAUDE.md` (« keyé par quoi, et que se passe-t-il quand il y
   en a deux ? ») n'aurait aucune réponse propre ici. La testabilité pure est
   l'argument numéro un de ce chantier ; on ne l'échange pas contre une
   commodité. Le prédicat d'activité par fréquence reste où
   `DESIGN-NOTIFY-EVENTS.md` le met : en amont, séparé. Un pont reste possible
   plus tard sous forme d'une région SYNTHÉTIQUE booléenne calculée HORS
   moteur et passée en entrée, jamais d'une région native qui lirait une
   horloge.
3. **Un fichier de manifest par agent-kind, nommé par le kind, et rien d'autre
   dans ce fichier** (découpage validé par l'opérateur le 2026-08-26, calqué
   sur `src/detect/manifests/*.toml`). Conséquence de couverture, qui est la
   règle de `CLAUDE.md` appliquée telle quelle : un agent-kind lançable sans
   fichier correspondant doit rendre `unknown` EXPLICITE et **jamais `idle`
   par défaut**. Le test de parité doit valoir dans les DEUX directions --
   un kind lançable sans manifest (le moteur est aveugle sur une tuile réelle)
   ET un manifest sans kind lançable (règles mortes que personne ne remarquera
   plus jamais). La liste des kinds lançables se lit dans `FRONTIER_BINS`
   (`desktop/src/main/model-registry.ts`) et `desktop/src/main/session-kind.ts`.
   L'en-tête d'attribution Apache-2.0 est par fichier (§6).
4. **La liste des régions v1 ci-dessus est INSUFFISANTE, mesuré.** L'inventaire
   des `region =` sur les 20 manifests herdr donne : `whole_recent` 43 usages,
   `bottom_non_empty_lines(N)` 42, `osc_title` 16, `osc_progress` 4,
   `top_non_empty_lines(N)` 2, `after_last_prompt_marker` 2,
   `after_last_horizontal_rule` 2, `prompt_box_body` 1,
   `last_non_empty_above_prompt_box` 1. L'affirmation « sous-ensemble
   suffisant pour les manifests claude, codex, gemini » est fausse pour deux
   des trois : `claude.toml` porte quatre règles hors v1
   (`last_non_empty_above_prompt_box`, `prompt_box_body`,
   `after_last_horizontal_rule` deux fois), et parmi elles **sa seule règle
   `idle` et deux de ses règles `blocked`** ; `codex.toml` en porte trois
   (`after_last_prompt_marker` deux fois, `top_non_empty_lines(20)`), et ces
   deux noms de région ne figurent **nulle part** dans ce brief, ni en v1 ni
   en v2. Seul `gemini.toml` tient en v1 (deux règles, `whole_recent`
   uniquement). Le chiffrage de H1 doit donc inclure l'extension du moteur aux
   régions manquantes avant tout portage de `claude` ou `codex`, et
   **le chargement d'un manifest citant une région inconnue doit ÉCHOUER
   BRUYAMMENT** : une région absente ne produit pas d'erreur naturelle, elle
   produit une règle qui ne matche jamais, donc un manifest silencieusement
   dégradé. Bonne nouvelle en regard : le balayage ouvert des clés d'expression
   réellement utilisées par les 20 manifests (sans liste blanche) ne rend rien
   d'autre que ce que ce brief énumère déjà, plus deux clés de niveau fichier,
   `aliases` et `updated_at`.

**Fichiers.** Nouveaux : `desktop/src/main/detect/engine.ts`,
`detect/regions.ts`, `detect/manifests/*.json`,
`desktop/tests/detect-*.test.ts` + fixtures. Modifiés : `session-service.ts`
(feed + agentKind au spawn), `attention.ts` (consommer `blocked`),
`shared/types.ts` (état exposé au renderer), tuile côté renderer (badge —
passer par le skill `deck-design`).

**Risques / questions ouvertes.** (a) Les regex herdr sont calées sur leur
screen model (lignes dépliées) ; sur notre buffer de flux, certaines règles
« bottom » verront des redraws partiels — prévoir un lissage (n'acter un
changement d'état qu'après k occurrences ou t ms, herdr fait pareil via la
cadence de son renderer). (b) Divergence de versions des CLIs : nos manifests
vivront au rythme de nos releases sans catalogue distant — accepté, l'override
local couvre l'urgence. (c) Le portage TOML→JSON doit être testé règle par
règle, pas en bloc.

### H2 — Extraire les séquences OSC du PTY

**But.** Un signal working/idle quasi gratuit, résistant aux redraws : Claude
Code met son spinner dans le titre OSC et émet l'OSC progress ; d'autres CLIs
émettent le progress standard (`9;4`).

**Design proposé.** Petit parseur d'états OSC dans le chemin de données PTY
(`pty-manager.ts` `proc.onData` → `handleData`) : suivre `ESC ] 0/2 ; title
BEL/ST` et `ESC ] 9 ; 4 ; state ; progress BEL/ST`, retenir par session le
dernier titre et le dernier progress (deux strings, pas d'historique). Le
strip ANSI actuel (`ANSI_RE` dans `attention.ts`/`quota.ts`) ne couvre que le
CSI — les OSC doivent être capturées AVANT strip, dans un module partagé,
et le strip étendu pour les retirer du buffer texte. Sortie : le triplet
`DetectionInput` de H1. Livrable avant H1 (même seul, il fiabilise `BUSY_RE` :
titre-spinner ⇒ busy).

**Le parseur doit sortir un triplet ÉTENDU, incluant `OSC 777` (ajouté le
2026-08-26).** Tel qu'écrit ci-dessus, ce chantier ne suit que `0/2` et `9;4`,
c'est-à-dire les deux séquences que herdr consomme -- et herdr n'a aucun
`OSC 777` (§2 bis.2). Or `OSC 777` est le capteur mécanique de levée spécifié
par `DESIGN-NOTIFY-EVENTS.md`, et c'est lui qui débloque la carte `f8082208`.
Conséquence chiffrée : **livrer H2 sans `777` laisse `f8082208` bloquée et
impose de rouvrir le parseur, donc de livrer deux fois.** Le coût marginal est
d'une branche dans un parseur qu'on écrit de toute façon.

**Ce chantier est de l'INGÉNIERIE, pas de la mesure (vérifié le 2026-08-26).**
Le `context` de la carte `f8082208` porte déjà les mesures : corps `OSC 777`
par famille et table de 21 kinds vers 11 corps ; cadence de réécriture du
titre d'environ 960 ms, gap maximal 1028 ms sur quatre profils de charge,
contre zéro émission sur 190 secondes de repos ; seuil retenu 3 s ; et le
piège « extinction SUR FRONT, jamais SUR NIVEAU », parce qu'une réponse à une
invite produit une salve de six émissions puis le silence. Lire cette carte
AVANT de démarrer, et ne pas refaire la campagne. Réserve à reprendre telle
quelle : la valeur `auto` de `preferredNotifChannel` n'émet aucun octet de
notification, donc Kory doit forcer le canal via `--settings` au lancement, ce
qui est un argument de ligne de commande construit côté Deck, donc l'entrée
hostile n°4 du tableau de `CLAUDE.md`.

Deux sites JETTENT aujourd'hui les OSC au lieu de les capturer, et ce sont les
deux points d'entrée du chantier : `desktop/src/main/screen-model.ts` les
saute explicitement dans sa boucle d'échappement, et `ANSI_RE`
(`desktop/src/main/attention.ts` et `desktop/src/main/quota.ts`) ne couvre que
le CSI, donc les OSC survivent telles quelles dans le buffer texte de ces deux
détecteurs.

**Fichiers.** Nouveau `desktop/src/main/detect/osc.ts` (pur, testable bun).
Modifiés : `session-service.ts` (brancher sur handleData), `attention.ts` /
`quota.ts` (strip élargi ou consommation du texte déjà nettoyé).

**Risques.** Séquences OSC fragmentées entre deux chunks PTY — le parseur doit
être incrémental (état de continuation par session), avec un cap de longueur
(une OSC jamais terminée ne doit pas accumuler).

### H3 — Publier le cycle de vie des pairs dans le broker

**But.** Qu'un agent sache si son pair est `working`/`blocked`/`idle` AVANT de
lui envoyer un message, et que l'opérateur voie d'un coup d'œil « lequel est
coincé ». Complète `activity_status` (récence) sans le remplacer.

**Design proposé.**

- Colonne `lifecycle` (`working|blocked|idle|unknown`, défaut `unknown`) +
  `lifecycle_at` sur `peers` ; portée par `/heartbeat` (payload étendu,
  rétro-compatible : champ absent = pas de changement) ou par une route dédiée
  `/set-lifecycle` calquée sur `/set-summary` (préférer la route dédiée : le
  heartbeat de `server.ts` est un timer aveugle, l'événement lifecycle est
  poussé au changement).
- **Deux sources, par ordre de fiabilité** : (1) le Deck rapporte pour ses
  tiles (il détient l'état H1) — mapping tile→peer via `peer-state.ts` /
  `workspace-session-map.ts`, écriture via `broker-client.ts` ; (2) pour un
  pair hors Deck, `server.ts` peut auto-rapporter une approximation
  (outil MCP appelé récemment ⇒ `working`) — v2, pas bloquant.
- Projection : ajouter le champ à `PublicPeer`. **Attention au précédent
  fail-open** : `PublicPeer` est un `Omit<Peer, ...>` et `toPublicPeer`
  rest-spread — le champ sortira automatiquement, c'est voulu ici, mais le
  choix doit être écrit dans le commit (règle « toPublicPeer est le canonical
  fail-open » de CLAUDE.md).
- Surfaces : `list_peers` (MCP, ligne par pair), vue Peers du Deck, et le
  résumé `from_summary` des messages entrants si peu coûteux.
- Règle multi-identité de CLAUDE.md : la clé est `instance_token` (le pair),
  jamais l'hôte ni le peer_id — deux sessions d'un même humain ont deux
  lifecycles.

**Fichiers.** `broker.ts` (route + colonne + migration + projection),
`shared/types.ts`, `server.ts` (exposition list_peers), `desktop/src/main/`
(`peer-state.ts`, `broker-client.ts`, consommation renderer). Suivre le skill
`add-broker-feature` pour la chaîne complète.

**Risques.** Staleness : un Deck tué sans `/disconnect` laisse un `working`
gelé — `lifecycle_at` + le même seuil que `ACTIVITY_TIMEOUT_MS` doivent faire
retomber l'affichage sur `unknown` (calculé à la lecture, comme
`activity_status`, plutôt qu'un sweep de plus).

### H4 — Garde-fous d'injection et primitives d'attente

**But.** Côté Deck : ne plus injecter à l'aveugle dans un tile. Côté MCP : un
agent qui pose une question ne doit plus poller `check_messages` en boucle.

**Design proposé, trois pièces indépendantes.**

- **Garde `agent_blocked`** : toute injection programmatique dans un PTY
  (dispatch de cartes `dispatch.ts`, `executeDirective` dans `index.ts`,
  supervisor via deck-control) consulte l'état H1 avant d'écrire. `blocked` ⇒
  refus journalisé (pas d'écriture : répondre à la place de l'opérateur à un
  dialogue d'approbation est exactement ce que les gates sécurité
  interdisent), l'appelant décide (re-queue ou remontée opérateur). Sans H1,
  version minimale : réutiliser le drapeau `attention.ts` existant (claude
  uniquement) — déjà utile.
- **Détection `stalled`** : après injection, si aucun cue busy n'apparaît sous
  ~5 s (constante, cf. herdr `AGENT_PROMPT_EFFECT_TIMEOUT_MS`), journaliser et
  marquer la dispatch douteuse au lieu de la croire livrée. S'insère dans le
  contrat existant de `dispatch.ts` (« resolving means DISPATCHED, not
  completed » — le stalled-check raffine précisément ce point documenté).
- **Outil MCP `wait_for_message`** (`server.ts`) :
  `{ timeout_sec (cap serveur, ex. 300), from_peer_id? }`, résout dès qu'un
  message (du pair filtré, sinon quiconque) arrive — implémentation : attendre
  la frame WS déjà poussée par le broker, fallback poll périodique
  `/poll-messages` (les deux chemins existent). Retour : le(s) message(s) ou
  `{ timed_out: true }`. Documenter dans la description d'outil que l'agent
  doit préférer cet outil à une boucle `check_messages`. Un
  `wait_for_peer --until idle|blocked` façon herdr n'a de sens qu'après H3 —
  v2.

**Fichiers.** `desktop/src/main/dispatch.ts`, `index.ts`, `supervisor.ts` /
`deck-control.ts` (garde + stalled) ; `server.ts` (+ types partagés) pour
l'outil wait ; tests bun sur les trois.

**Risques.** Timeout MCP côté client Claude Code : caper `timeout_sec` sous la
limite de timeout d'outil du client et le dire dans la description. Le garde
`blocked` ne doit jamais bloquer l'OPÉRATEUR humain (frappe clavier directe
non concernée — seuls les chemins programmatiques passent par le garde).

### H5 — Surface CLI vers le bus pour agents non-MCP

**But.** Le mécanisme d'agnosticisme central de herdr : la CLI comme
dénominateur commun. N'importe quel agent capable d'exécuter une commande
shell (codex, gemini, opencode…) doit pouvoir participer au réseau de pairs
sans MCP.

**Design proposé.**

- Sous-commandes `cli.ts` (déjà le point d'entrée diagnostic) : `peer-join
  [--group G] [--id NAME]` (POST `/register`, écrit l'identité — token inclus
  — dans un fichier d'état sous le répertoire de config, chmod 600, chemin
  imprimé), `peer-send <peer_id> <text>`, `peer-check [--wait N]`,
  `peer-whoami`, `peer-leave`. Résolution broker/groupe par
  `shared/config.ts` (`brokerUrl`, `resolveGroup`) — déjà partagée avec
  `server.ts`, rien à inventer.
- Identité : un join = un pair de plein droit (heartbeat au fil des appels ;
  accepter qu'un pair CLI passe `sleep` entre deux commandes — H3 l'affichera
  honnêtement). Fichier d'état par session shell (`KORY_PEER_STATE` env
  var > défaut par cwd+pid), pour que deux tiles du même repo soient deux
  pairs (règle multi-identité CLAUDE.md).
- Côté Deck : au spawn d'un tile non-claude, injecter l'env nécessaire
  (`CLAUDE_PEERS_*`, groupe du workspace). **La vérification annoncée ici a
  été faite le 2026-08-17 et son résultat est négatif** (détail et symboles
  dans l'append de la carte `1a7792b9`, re-vérifié le 2026-08-26) : la
  mécanique supposée n'existe pas sous cette forme, `SessionDef`
  (`desktop/src/shared/types.ts`) ne porte aucun champ d'environnement et
  `create-session.ts` n'en manipule aucun ; le seul point d'injection réel
  est `sessionEnv`, construit en dur dans `SessionService.startPty`
  (`desktop/src/main/session-service.ts`) et passé à `PtyManager.spawn`
  (`desktop/src/main/pty-manager.ts`) comme unique source de son `extraEnv`.
  Le volet Deck de ce chantier n'est donc PAS nul : il faut porter les
  variables jusqu'à `sessionEnv`, ce que la formulation précédente laissait
  croire acquis.
- Un skill façon `skills/herdr/SKILL.md` (garde d'env, « la CLI installée est
  l'autorité », IDs lus dans les réponses JSON) publié pour les agents qui
  savent charger des skills ; pour les autres, une ligne dans le prompt
  système du template de tile suffit.
- **Sécurité** : c'est une nouvelle surface agent-facing (entrée hostile
  n°2/n°4 du tableau CLAUDE.md). Le token reste dans le fichier d'état, jamais
  en argument de commande (visible dans `ps`) ; `peer-send` traite le texte
  comme opaque (pas d'interpolation shell — args exec-style).

**Fichiers.** `cli.ts`, `shared/config.ts` (si un helper manque),
`desktop/src/main/session-service.ts` (`sessionEnv`), nouveau skill
`.claude/skills/kory-peer/`. Tests : bun sur les sous-commandes contre un
broker de test (pattern des tests broker existants).

**Risques.** Le polling CLI n'a pas de push : `peer-check --wait` est un
long-poll de confort, pas une garantie de latence — l'écrire dans le skill.

### H6 — Distinction idle / done (vu / pas-vu)

**But.** Sur un Deck à N tiles, « terminé pendant que tu ne regardais pas »
est l'information qui manque : aujourd'hui un tile fini redevient
visuellement identique à un tile idle depuis une heure.

**Design proposé.** Overlay Deck-side au-dessus de l'état H1 (ou, sans H1, de
l'heuristique busy actuelle) : transition `working → idle` pendant que le tile
n'est PAS le tile focalisé/visible ⇒ marquer `done` (badge discret, style via
`deck-design`) ; focaliser le tile efface la marque. Reprendre la règle herdr :
une lecture programmatique (supervisor, digest) ne marque PAS « vu » — seul le
focus opérateur compte. État en mémoire renderer/store, persistance inutile
(un restart efface, acceptable v1).

**Fichiers.** Store renderer + composant tuile + `styles.css` (skill
`deck-design` — pas de nouveau contrôle natif, glyphe grec pour le badge,
pas d'emoji), petite plomberie `session-service.ts` → renderer si l'état H1
vit main-side.

**Risques.** Aucun sérieux ; c'est le chantier le moins cher et il rend H1
visible à l'opérateur.

## 4. Ordre et dépendances

```
H2 (OSC) ──▶ H1 (moteur manifests) ──▶ H3 (lifecycle broker) ──▶ H4.wait_for_peer (v2)
                    │                          │
                    ├─▶ H6 (done/vu)           └─▶ (affichage Peers/Deck)
                    └─▶ H4 gardes (version minimale possible AVANT H1 via attention.ts)
H5 (CLI bus) : indépendant de tout le reste.
H4.wait_for_message : indépendant (n'attend que server.ts).
```

Démarrages rapides possibles dès maintenant, sans dépendance : **H2** (petit,
pur, testable), **H4.wait_for_message**, **H5**. Le chemin critique de valeur
est H2→H1→H3.

Effort grossier : H1 large ; H3, H4, H5 moyens ; H2, H6 petits.

## 5. Hors périmètre (noté, pas perdu)

- **Resume par agent-kind** (herdr `agent_resume.rs`) : persister le
  session-ref par tile (`claude --resume <id>`, équivalents codex/gemini)
  pour relancer après restart du Deck. Recouvre partiellement
  `checkpoint-service.ts` — à instruire séparément.
- Catalogue distant de manifests (assumé non repris, cf. H1).
- `pane wait-output --match` générique pour le supervisor (utile, mais
  attendre de voir si H4 ne suffit pas).
- Sources de lecture multiples (`visible`/`recent`/`recent-unwrapped`/
  `detection`) : sans screen model complet, non transposable tel quel.

## 6. Licence

Herdr est sous **Apache-2.0**. Tout manifest ou regex porté depuis
`src/detect/manifests/` doit conserver une attribution (en-tête du fichier
JSON : « rules derived from herdr <URL>, Apache-2.0 ») et le dépôt doit
mentionner herdr dans les notices si on embarque leurs règles. Le code moteur
est réécrit (TS, modèle de flux différent), pas traduit ligne à ligne.
