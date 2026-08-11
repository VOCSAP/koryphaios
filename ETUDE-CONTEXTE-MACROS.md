# Étude — économie de contexte, macros sur événements, identité des peers

**Statut** : étude préalable, **aucun développement engagé**. Document de reprise
destiné à une équipe d'agents.
**Base de lecture** : branche `experimental`, commit `7089c16`.
**Étudié le** : 2026-08-11.
**Ce document** : analyse + conclusions + questions ouvertes. Le résidu ouvert
correspondant est aussi consigné dans `BACKLOG.md` §3.7 (commits `7aa0141`,
`e6664d9`) ; ce fichier-ci porte le raisonnement complet, le découpage en lots et
les points d'arbitrage, que le backlog ne peut pas contenir.

> Convention de lecture : les **faits** ont été vérifiés dans le code ou la
> documentation officielle et sont donnés avec leur pointeur (chemin + symbole,
> jamais `fichier:ligne` — une ligne bouge, un symbole non). Les
> **recommandations** sont marquées comme telles et n'engagent rien tant qu'elles
> ne sont pas arbitrées.

---

## 0. Résumé exécutif

Le besoin exprimé — « à 80 % de contexte, déclencher handoff + `/clear` +
rechargement » — met en jeu trois chantiers indépendants, dont un seul était
identifié au départ.

| # | Chantier | État initial | Ce que l'étude change |
|---|---|---|---|
| A | Mesurer le % de contexte par tuile | intention au backlog, avec une question ouverte | question tranchée (champs documentés) ; un blocage d'installation découvert ; source alternative promue socle |
| B | Identité des peers d'une équipe | supposé mineur (« les suffixes peuvent permuter ») | **panne systématique**, cause exacte identifiée, correctif sans verrou ; **préalable** au packaging roadmap |
| C | Macros déclenchées par événement | réduit à « une carte directive multi-étapes » | modèle complet ; le bus d'événements existe déjà ; un garde-fou manquant qui détruirait du travail |

**Décisions déjà prises par l'opérateur**

1. La souscription se règle **par filtre de cible** : `rôle` / `tuile` / `toutes`.
2. Pas de vue de rail dédiée aux événements — c'est trop anecdotique pour un
   onglet, et le journal existant fait déjà office d'historique.
3. Le handoff reste l'affaire de l'opérateur (Kleos, via son `CLAUDE.md` global) :
   l'application ne doit **jamais** connaître le système mémoriel employé, elle ne
   manipule que des prompts.

**Recommandation d'ordre de livraison** — voir §5. En une phrase : l'identité
d'abord (rien d'autre ne tient sans elle), les macros en déclenchement **manuel**
ensuite, la mesure, puis seulement l'automatisme.

---

## 1. Axe A — Lire le % de contexte de chaque agent

### 1.1 Faits

- **Rien ne mesure la fenêtre aujourd'hui.** `desktop/src/main/usage-service.ts`
  lit les quotas d'abonnement des CLI (fenêtres 5 h / 7 j) — grandeur sans rapport
  avec le contexte d'une session.
- **Les champs de contexte de la statusline existent et sont documentés.** Le JSON
  reçu sur stdin par la commande de statusline porte :
  `context_window.used_percentage`, `context_window.remaining_percentage`,
  `context_window.context_window_size` (200 000, ou 1 000 000 en contexte étendu),
  `context_window.total_input_tokens` / `total_output_tokens`,
  `context_window.current_usage{input_tokens, output_tokens,
  cache_creation_input_tokens, cache_read_input_tokens}`, `exceeds_200k_tokens`,
  ainsi que `session_id`, `transcript_path`, `model.id`, `cost.*` et
  `rate_limits.{five_hour,seven_day}`.
  → **La « vérif empirique des champs » que demandait le backlog est faite.**
- **`used_percentage` se calcule sur les entrées seules** :
  `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`, sans les
  sorties. Un calcul maison doit employer la même formule pour coïncider.
- **Cadence** : le script tourne au démarrage de session, à chaque nouveau message
  assistant, à la fin d'un `/compact`, au changement de mode de permission, et sur
  `refreshInterval` si on en pose un. Débounce 300 ms ; un run en cours est annulé
  si un nouveau déclencheur arrive. **Zéro token d'API consommé.**
- **BLOCAGE : un plugin ne peut pas embarquer de `statusLine`.** Le
  `settings.json` d'un plugin n'honore que les clés `agent` et
  `subagentStatusLine`. Le `deck-plugin` ne pourra donc pas livrer la jauge comme
  il livre ses hooks (`desktop/deck-plugin/hooks/hooks.json`).
- **`--settings` accepte un chemin ou du JSON en ligne, et FUSIONNE** : les clés
  fournies écrasent celles des fichiers de réglages pour la session, les clés
  omises gardent leur valeur. Fichier ≤ 2 Mio.
- **Aucun hook ne transporte de compteur de tokens.** Les charges utiles de hook
  (y compris `PostToolUse`, `Stop`, `PreCompact`) ne portent ni usage ni fenêtre —
  seulement `transcript_path`, ce qui ramène à la lecture du transcript.
- **Le Deck connaît déjà le chemin du transcript de chaque tuile** :
  `transcriptPath(home, cwd, id)` dans `desktop/src/main/session-transcript.ts`, et
  l'id réel courant via le back-channel `readDeskSessionId` dans
  `desktop/src/main/desk-session.ts` (fichier `desk-session-<token>.txt`, tenu à
  jour à travers les `/clear` par `desktop/hooks/desk-backchannel-hook.ts`).

### 1.2 Les deux sources, et laquelle je retiens

**Source B — queue du transcript JSONL — *socle recommandé***
La dernière entrée assistant porte son `usage` ; on relit les derniers kilo-octets
depuis la fin du fichier (précédent de lecture par la fin : la lecture des
rollouts codex dans `usage-service.ts`).

- *Pour* : zéro configuration opérateur, aucune clé de réglage écrasée, fonctionne
  sur toute tuile y compris avec un Claude Code plus ancien.
- *Contre* : format non contractuel (très stable en pratique) ; il faut connaître
  la taille de fenêtre (suffixe de modèle `[1m]`, déjà autorisé par
  `sanitizeFlagValue` dans `desktop/src/main/session-command.ts`) ; en mode sandbox
  le transcript est dans le conteneur (précédent d'accès :
  `desktop/src/main/sandbox-command.ts`, listage des `.jsonl` par `docker exec`).

**Source A — statusline — *surcouche opt-in***
Un script écrit `~/.claude/peers/context-<token>.json` puis **délègue l'affichage
au script d'origine de l'opérateur**, installé par `--settings '<json en ligne>'`
au spawn.

- *Pour* : chiffres officiels, gratuits, quasi temps réel ; ramène `rate_limits`
  au passage, que `usage-service` paie aujourd'hui en OAuth.
- *Contre* : écrase la clé `statusLine` de l'opérateur pour la session — le
  chaînage vers son script est **obligatoire**, pas optionnel (l'opérateur a déjà
  une statusline qui affiche son peer_id).

Les deux alimentent la même structure :
`TileContext { usedPercent, windowSize, tokens, at, source }`.

### 1.3 Pièges de mesure — à ne pas redécouvrir

1. **`current_usage` vaut `null`** avant le premier appel API **et de nouveau
   après un `/compact`**, jusqu'au prochain appel. `used_percentage` et
   `remaining_percentage` peuvent être `null` en début de session.
   **Ne jamais lire ce `null` comme 0 %** : un seuil qui se ré-arme sur une valeur
   absente rejoue sa macro indéfiniment. C'est le mode de panne n°1 de l'axe C.
2. Le pourcentage porte sur **la fenêtre**, pas sur le seuil d'auto-compact de
   Claude Code, qui est distinct. Le libellé de la jauge doit dire lequel il montre.
3. Les **sous-agents** (outil Task) ont leur propre contexte, invisible ici. Une
   jauge par tuile mesure la session principale, rien d'autre — à écrire dans
   l'info-bulle, sinon la jauge ment par omission sur un agent qui délègue.
4. `exceeds_200k_tokens` est un **seuil fixe**, indépendant de la taille réelle de
   fenêtre : inutilisable comme jauge en contexte étendu.

---

## 2. Axe B — L'identité des peers d'une équipe

C'est le chantier que l'étude initiale avait sous-estimé, et c'est le préalable de
tout le reste.

### 2.1 Le symptôme

Plusieurs agents dans un **même `cwd`** (c'est le but : une équipe architecte /
dev / reviewer sur le même projet). Chacun porte un id suffixé. Après une relance
d'une session, l'agent change d'id — `dev1` passe de `-6` à `-12`. Le team-lead ne
le sait pas, continue d'écrire à `-6`, **et l'équipe cesse de dialoguer sans
qu'aucune erreur ne soit levée nulle part**.

### 2.2 La cause exacte

- `sessionKey(host, cwd, groupId)` dans `broker.ts` = `sha256(host ‖ cwd ‖
  group_id)`, et la table `peer_sessions` a ce hash pour **PRIMARY KEY**. Il
  n'existe donc **qu'une seule ligne de mémoire d'identité par répertoire de
  travail**, alors qu'une équipe y pose délibérément N agents.
- La branche de collision de `/register` l'écrit elle-même :

  ```
  // Active collision: another process is already holding this session_key.
  // Mint a fresh peer with a derived id; do NOT touch peer_sessions
  // (the existing active row keeps the canonical session).
  ```

  → **Les tuiles 2..N n'écrivent jamais leur identité.** La voie
  dormant → résurrection — celle qui rend son nom à un peer qui revient — leur est
  **structurellement inaccessible**. Elles ne *peuvent* pas changer de peer_id au
  redémarrage : elles en changent **systématiquement**.
- `deriveDefaultId(host, cwd, groupId)` cherche le premier suffixe libre en
  interrogeant `peers` **sans filtrer le statut**. Les lignes dormantes gardent
  leur nom 24 h (purge en cascade au-delà). Donc chaque relance prend le cran
  suivant : `-6` → `-12` **n'est pas une permutation, c'est un compteur qui
  grimpe**.

### 2.3 Pourquoi il ne faut PAS de verrou de noms

L'intuition de l'opérateur est juste : un mécanisme de réservation d'ids
changerait le modèle d'attribution, multiplierait les cas de collision et
ouvrirait une surface d'usurpation. Ce n'est pas ce qu'il faut.

Le défaut est déjà nommé, mot pour mot, par la **première convention du dépôt**
(`CLAUDE.md`, « Who is actually running this ») : *keyed by what, and what happens
when there are two?*. `peer_sessions` est un **mémo**, pas un verrou, et il est
indexé sur trop peu. Deux tuiles dans un `cwd`, c'est exactement la « seconde
identité » que la convention décrit, avec le mode de panne qu'elle annonce :
silencieux.

### 2.4 Correctif recommandé

```
session_key = sha256(host ‖ cwd ‖ group_id ‖ slot)
              slot = CLAUDE_PEERS_DESK_SESSION, ou "" hors Deck
```

Une ligne par tuile au lieu d'une par répertoire. La voie dormant → résurrection,
**déjà écrite et déjà testée**, redonne alors son peer_id à chaque agent. Aucune
API de nommage nouvelle, aucun verrou, aucun changement de règle d'attribution. La
branche de collision ne se déclenche plus que sur un **vrai** doublon (même slot
réellement vivant), le cas pour lequel elle a été écrite. Hors Deck, `slot` est
vide : le hash est byte-identique à aujourd'hui.

**Analyse des trois risques redoutés**

| Risque | Effet réel |
|---|---|
| Usurpation | **Réduite.** Aujourd'hui déjà, connaître `(host, cwd, group_id)` suffit à se faire remettre par la voie de reprise un `instance_token` mémorisé : la clé courte est **déjà** une capacité au porteur. Ajouter le slot rend ce tir strictement plus difficile. Et cela n'accorde aucune capacité que `set_id` ne donne déjà (tout peer enregistré peut prendre n'importe quel nom libre du groupe). |
| Collisions | **Réduites.** La source dominante des suffixes qui grimpent, ce sont les lignes dormantes qui retiennent les noms ; une reprise réussie ne consomme aucun cran. |
| Migration | **Un dernier saut d'ids.** Les anciennes lignes cessent de correspondre. **Piège à éviter : ne pas prévoir de repli sur la clé courte** — il rendrait à la tuile B la ligne de la tuile A, donc son `instance_token`. Assumer une dernière rotation au premier lancement et la journaliser. |

### 2.5 Mitigation immédiate, sans toucher au core

`SessionService.pollPeerIds` (`desktop/src/main/session-service.ts`) émet déjà
`peer-resolved` avec une intention d'annonce à la **première** résolution.
L'étendre au **changement** suffit à débloquer l'équipe : le Deck annonce au
groupe « la tuile *dev1* répond désormais à `<nouvel id>` ». Le team-lead
l'apprend par le canal d'annonces qu'il écoute déjà (`/announce`, expéditeur
sentinelle `deck`), sans sondage et sans inférence.

À vérifier au passage : le texte doit rester une **constante de code** (règle C8),
seuls les ids étant interpolés — et ils sont contraints par `PEER_ID_REGEX`.

### 2.6 Étape suivante facultative — nommer les tuiles par leur rôle

Laisser le Deck proposer un peer_id au `/register` (`CLAUDE_PEERS_PEER_ID=dev1`,
injecté comme l'est déjà `CLAUDE_PEERS_DESK_SESSION`), honoré si le nom est libre
dans le groupe. Aucune capacité que `set_id` n'accorde déjà, mais l'échec doit
être **fermé** : un nom tenu par un peer **actif** se refuse et se journalise,
il ne se vole jamais. Un nom tenu par un peer **dormant** est le cas ambigu à
arbitrer (voir §6, question 3).

Bénéfice : la vue équipe et les cartes roadmap parlent enfin des rôles, pas de
`dev-pc-projet-12`.

### 2.7 Ce qui n'est PAS en cause

La chaîne magic-compact **ne ferme pas la session**. `runMagicCompact`
(`desktop/src/main/index.ts`) injecte `/magic-compact`, capture
`To enter the compacted session, run: /resume <uuid>` via
`parseMagicResume` + `SessionService.waitForOutput`, puis tape `/resume <uuid>`
**dans le même PTY**. Le processus, la tuile et le token
`CLAUDE_PEERS_DESK_SESSION` ne changent pas ; le hook SessionStart réécrit le
nouvel id dans le back-channel. Une tuile **seule** sur son `cwd` retrouve
d'ailleurs exactement son peer_id. Le problème est le partage de `cwd`, pas la
compaction.

**Contournement disponible dès maintenant, sans une ligne de code** : un worktree
par agent, ce que `TEAM_PLAYBOOK` (`desktop/src/main/team-embedded.ts`) prescrit
déjà (« one work stream = one agent = one worktree »). Un `cwd` distinct rend le
`session_key` unique par agent et supprime entièrement le symptôme.

---

## 3. Axe C — Macros sur événements

### 3.1 Intention retenue

`Événement → Macro`, la macro étant une **suite d'actions enregistrée par
l'opérateur**. Exemple canonique :

> **Événement** = contexte ≥ 80 %  **Action** = macro `handoff + clear + rechargement`

Avec trois déclencheurs pour la même macro : **manuel** (menu de tuile),
**événementiel** (souscription), **carte roadmap** (packaging).

### 3.2 Ce qui existe déjà et se réutilise tel quel

| Brique | Où | Ce qu'elle apporte |
|---|---|---|
| `SessionService.injectCommand` | `desktop/src/main/session-service.ts` | Échap + settle + texte + Entrée, **bloqué sur tuile idle** (`DIRECTIVE_IDLE_WAIT_MS` = 120 s) |
| `encodeInitialPromptKeystrokes` | `desktop/src/main/session-command.ts` | **Injection multi-lignes « paste-safe » déjà écrite** : bracketed paste, tous les ESC retirés, CR/CRLF → LF. Il manque seulement un `injectPrompt()` qui l'appelle hors du spawn |
| `SessionService.waitForOutput` | `desktop/src/main/session-service.ts` | Attente d'un motif dans le flux PTY, tampon glissant plafonné, ANSI retiré par `stripAnsi` |
| `SessionService.waitIdle` | `desktop/src/main/session-service.ts` | Détection de fin de tour (`thinking`) |
| `snippet-store.ts` / `template-store.ts` | `desktop/src/main/` | Patrons de stockage sur disque, résolution global ↔ projet, bornes de taille |
| Le journal | `desktop/src/main/journal.ts` | **C'est déjà le log d'événements** — rien à construire pour l'historique |

> Le backlog affirmait qu'une « variante d'injection paste-safe » restait à
> écrire. **Elle existe** (`encodeInitialPromptKeystrokes`, apparue avec le
> chantier de déplacement du prompt initial hors argv). Corriger cette croyance
> évite de réécrire une fonction déjà durcie contre l'injection d'échappements.

### 3.3 Le bus d'événements existe déjà

`SessionService` émet : `data`, `exit`, `thinking`, `quota`, `attention`,
`startup-ack`, `created`, `removed`, `peer-resolved`, `changed`. Les transitions
de roadmap sont déjà suivies par `watchDispatched` (`desktop/src/main/index.ts`)
et les états de verrou par le veilleur de locks inactifs.

**Il manque exactement une source — le seuil de contexte (axe A) — et une couche
d'abonnement.** Rien d'autre n'est à instrumenter. C'est ce qui rend l'idée
« vue Événements » beaucoup moins chère qu'elle n'en a l'air, et ce qui justifie
de ne pas lui dédier un onglet de rail.

Catalogue d'événements proposé pour le premier incrément :

| Événement | Source | Usage typique |
|---|---|---|
| `context.threshold` | axe A | la macro handoff |
| `session.attention` | `attention` | prévenir, jamais agir |
| `session.quota` | `quota` | pause / bascule de modèle |
| `session.exited` | `exit` | relance, nettoyage |
| `roadmap.item.done` | `watchDispatched` | `clear` à une frontière propre |
| `session.idle` (N minutes) | `thinking` + horloge | relance douce |

### 3.4 Les trois objets

| Objet | Où il vit | Patron à copier |
|---|---|---|
| **Macro** | un fichier par macro, global + projet, le projet masquant le global. **Le corps ne transite jamais par le broker.** | `template-store.ts` (JSON) + résolution global↔projet de `snippet-store.ts` |
| **Souscription** | règle `événement → filtre de cible → macro → garde-fous`, dans les *features* du projet, avec dérogation par tuile | schéma `autoResume` / `magicCompact` (`launch-config.ts`) |
| **Exécution** | un run par tuile, chaque étape tracée | le journal existant |

**Filtre de cible — décidé par l'opérateur** : `rôle` / `tuile` / `toutes`.
Conséquence de conception à ne pas manquer : `rôle` suppose qu'un rôle soit une
donnée de première classe de la tuile (aujourd'hui il n'existe qu'à travers le
profil d'agent au spawn et le nom de tuile). **C'est un petit chantier à part
entière** — voir §6, question 1.

### 3.5 Vocabulaire d'étapes, et la reprise après reset

Le point délicat n'est pas la séquence : c'est de savoir **quel** handoff
recharger. Deux formes, et le format doit couvrir les deux **sans que
l'application connaisse jamais le système mémoriel employé**.

```json
// Forme 1 — CAPTURE : l'agent annonce l'identifiant, la macro le récupère
{ "op": "prompt",  "text": "Génère un handoff. Termine ta réponse par exactement : HANDOFF-OK <id>" }
{ "op": "await",   "signal": "idle", "capture": "HANDOFF-OK ([A-Za-z0-9._-]{1,64})",
                   "as": "handoff", "timeout_s": 600 }
{ "op": "command", "text": "/clear" }
{ "op": "prompt",  "text": "Charge le handoff {{handoff}} et reprends." }

// Forme 2 — CONVENTION : la macro impose le chemin, il n'y a plus rien à capturer
{ "op": "prompt",  "text": "Écris ton handoff dans .kory/handoff-{{tile}}.md, rien d'autre." }
{ "op": "await",   "signal": "idle", "timeout_s": 600 }
{ "op": "command", "text": "/clear" }
{ "op": "prompt",  "text": "Lis .kory/handoff-{{tile}}.md et reprends." }
```

La forme 1 convient au dispositif de l'opérateur (Kleos appelé par les
instructions du `CLAUDE.md` global) ; la forme 2 convient à un handoff par
fichier. **Aucune des deux ne nomme Kleos dans le code.**

La capture n'est pas une invention : c'est exactement le mécanisme de
`runMagicCompact` (`waitForOutput` + regex sur un tampon débarrassé de l'ANSI).
**Avec la même précaution obligatoire** : la valeur capturée provient du texte
d'un modèle et repart **dans un terminal** (entrée hostile n°4 de `CLAUDE.md`).
Elle se revalide contre un jeu de caractères strict avant interpolation, comme
magic-compact revalide son uuid — et l'interpolation passe ensuite par
`encodeInitialPromptKeystrokes`, qui retire les ESC.

### 3.6 Garde-fous — la partie qui détruit du travail si elle est ratée

**G1 — `await idle` doit être plus strict que `thinking === false`.**
`SessionService.waitIdle` renvoie `true` dès que `thinking` retombe, **y compris
quand l'agent s'est arrêté pour poser une question de permission**. Enchaîner sur
`/clear` à ce moment-là détruit la tâche en cours. La condition doit être
`idle ET NON needsAttention ET NON rateLimited`, et l'étape doit **avorter** la
macro si l'attention se lève — pas patienter. Les deux états existent déjà dans le
runtime (`needsAttention`, `rateLimited`) et sont déjà émis (`attention`,
`quota`). **C'est une condition à écrire, pas une mesure à inventer.**

**G2 — verrou d'exécution indexé sur la TUILE, pas sur la macro.** Deux
souscriptions déclenchées par le même événement lanceraient sinon deux séquences
concurrentes dans le même terminal. (Application directe de la convention n°1 :
*keyed by what, and what happens when there are two?*)

**G3 — jamais pendant qu'une tuile tient un lock roadmap**, sauf macro
explicitement marquée « sûre en cours de tâche ».

**G4 — durée totale bornée, abandon si le PTY meurt, chaque étape journalisée avec
son issue** (`sent` / `busy-timeout` / `no-terminal` / `aborted-attention` / …).
Aucune étape ne doit pouvoir échouer en silence.

**G5 — prévisualisation avant armement** : montrer littéralement ce qui sera tapé,
cible par cible. Une macro qui s'arme sans que l'opérateur ait vu le texte est une
régression de confiance.

**G6 — hystérésis et verrou d'époque pour `context.threshold`** : armement à N %,
désarmement seulement à la redescente sous N−10 points **sur une mesure réelle**
(jamais sur un `null`, cf. §1.3), et **une seule exécution par époque de session**.
Pas de seuil d'urgence qui interrompe : au-delà de ~95 %, l'auto-compact de Claude
Code fait déjà le travail et interrompre coûte plus cher.

### 3.7 Provenance du texte — le point de sécurité structurant

Règle C8, présente dans tout le code (`directive.ts`, `dispatch.ts`,
`team-embedded.ts`) : *la frappe est toujours une constante de code ; la carte ne
fait que sélectionner laquelle*. Or la roadmap est partagée, écrite par les
agents, importable depuis un JSON, et le Deck **n'est pas encore un auteur prouvé**
côté broker (`resolveRoadmapAuthor` : `by='deck'` porte un token sentinelle, la
couche 2 est différée — voir `ARCHITECTURE.md`, « Author proof »).

Conséquence : **du texte libre porté par une carte serait une injection de prompt
inter-agents**, avec les droits de la tuile visée.

| Option | Principe | Verdict |
|---|---|---|
| P1 | Textes = constantes i18n du Deck ; la carte choisit un identifiant + des slots typés | Sûr, mais l'opérateur ne rédige pas ses macros → ne répond pas au besoin |
| **P2** | **Macro stockée côté Deck ; la carte ne porte qu'un `macro_id`** | **Retenu.** Un agent *déclenche*, n'*écrit* jamais. Le texte ne quitte pas le poste |
| P3 | Texte libre dans la carte | À écarter tant que la couche 2 n'est pas livrée **et** l'exécution restreinte aux cartes dont l'auteur prouvé est l'opérateur |

**Point d'honnêteté sur P2** : les snippets sont aujourd'hui délibérément
*fill-not-send* — insérés dans le champ de saisie, jamais exécutés
(`snippet-store.ts`). Une macro **soumet** le texte. C'est un choix assumé, à
écrire noir sur blanc dans le module : ce qui l'autorise est la **provenance**
(disque local, opérateur), pas le contenu.

### 3.8 Emplacements d'interface (pas de vue de rail)

- **Édition des macros et des souscriptions** : section dans la page Réglages
  (patron : les autres sections de réglages projet).
- **Déclenchement manuel** : entrée « Exécuter une macro → » dans le menu
  contextuel de la tuile.
- **Historique** : le journal existant, filtré sur la catégorie des macros.
- **Rappel `DESIGN.md`** : aucun contrôle ne garde son apparence native, aucun
  emoji — toute icône est un glyphe grec de `components/icons.tsx`. Le lot
  d'interface passe par la skill `deck-design`.

---

## 4. Ce qui a été corrigé par rapport aux croyances initiales

À faire lire à l'équipe avant qu'elle ne reparte des anciennes notes.

1. « Vérifier empiriquement les champs statusline » → **fait, ils sont
   documentés**. Le vrai obstacle est ailleurs : un plugin ne peut pas embarquer de
   `statusLine`.
2. « Il faut écrire une variante d'injection paste-safe » → **elle existe**
   (`encodeInitialPromptKeystrokes`).
3. « Enchaîner plusieurs cartes directives » → **ne séquence pas**.
   `runDirectiveWave` attend bien `execute()` carte par carte, mais
   `executeDirective` lance chaque cible en fire-and-forget et rend la main
   aussitôt : deux cartes consécutives se chevauchent. Il faut un runner d'étapes.
4. « magic-compact ferme et rouvre la session » → **non**, il tape `/resume` dans
   le même PTY.
5. « Les suffixes de peer_id peuvent permuter » → **ils changent systématiquement**
   pour toute tuile autre que la première du `cwd`, et le compteur grimpe.

---

## 5. Découpage en lots

Chaque lot est autonome et livrable seul. Les dépendances indiquées sont dures.

### Lot 0 — Identité (préalable)

**0a — Annonce de changement de peer_id.** Deck seul, aucun changement de core.
Étendre l'émission `peer-resolved` de `pollPeerIds` au cas « l'id a changé » et
annoncer au groupe. *Test* : le module pur qui décide « annoncer / ne pas
annoncer » (première résolution / changement / disparition), à la manière des
autres helpers purs déjà testés sous `bun test`.

**0b — Élargissement du `session_key` (core).** `sessionKey()` prend un `slot` ;
`server.ts` le transmet depuis `CLAUDE_PEERS_DESK_SESSION` (sanitisé par
`sanitizeSessionId`, déjà existant) ; `/register` inchangé par ailleurs.
*Tests* : slot vide → hash identique à l'existant (non-régression byte à byte) ;
deux slots différents dans un même `cwd` → deux lignes `peer_sessions`, deux
identités stables à travers un cycle dormant → resurrect ; slot identique et peer
réellement actif → la branche de collision fonctionne toujours.
*À auditer explicitement* (règle de couverture de `CLAUDE.md`) : **tous** les
appelants de `sessionKey`, pas seulement `/register`.

**0c — (optionnel) `CLAUDE_PEERS_PEER_ID` proposé au register.** Échec fermé.
Ne pas démarrer avant arbitrage de la question 3 (§6).

### Lot 1 — Macros en déclenchement manuel

`injectPrompt()` réutilisant `encodeInitialPromptKeystrokes` ; store de macros ;
runner séquentiel **par cible**, parallèle **entre cibles** ; garde-fous G1 à G5 ;
entrée de menu contextuel ; journalisation par étape.
*Tests* : le runner en module pur avec des dépendances injectées (patron
`dispatch.ts`) — enchaînement nominal, avortement sur `attention`, avortement sur
mort du PTY, verrou par tuile sous deux déclenchements concurrents, borne de
durée, revalidation d'une valeur capturée hostile.
*Dépend de* : rien.

### Lot 2 — Mesure du contexte (consultative)

Lecture du transcript par la fin, `TileContext`, jauge sur la tuile, info-bulle
disant ce qui est mesuré. **Aucune action automatique.**
*Tests* : le parseur (dernière entrée assistant, `usage` absent, fichier tronqué
au milieu d'une ligne, `null` après compaction, fenêtre 200 k vs 1 M).
*Dépend de* : rien.

### Lot 3 — Souscriptions événementielles

Couche d'abonnement sur le bus existant, filtre de cible `rôle` / `tuile` /
`toutes`, garde-fou G6 pour le seuil.
*Dépend de* : lots 1 et 2. **Le lot le plus risqué** — le seul dont une erreur
détruit du travail. À ne lancer qu'une fois G1 à G5 éprouvés en manuel.

### Lot 4 — Packaging en carte roadmap

`macro_id` sur la carte directive ; résolution des cibles à l'exécution.
*Dépend de* : lots 0 et 1. Sans le lot 0, une carte visant `dev1-6` devient un
no-op silencieux (chemin `missing` de `resolveDirectiveTargets`).

### Lot 5 — Statusline (surcouche opt-in)

Source A avec chaînage vers le script de l'opérateur ; récupération de
`rate_limits` au passage.
*Dépend de* : lot 2 (mêmes structures).

---

## 6. Questions ouvertes — arbitrage opérateur requis

1. **Le « rôle » comme donnée de première classe.** Le filtre de cible retenu
   (`rôle` / `tuile` / `toutes`) suppose qu'une tuile porte un rôle stable et
   nommé. Aujourd'hui, le rôle n'existe qu'implicitement (profil d'agent au spawn,
   nom de tuile libre). Faut-il : (a) un champ `role` explicite sur la définition
   de session, choisi au spawn et modifiable ; (b) dériver le rôle du profil
   d'agent embarqué ; (c) se contenter du nom de tuile comme rôle ? — **(a) est ma
   recommandation** : c'est ce qui permet ensuite de nommer les peers par leur rôle
   (§2.6) et de rendre les cartes lisibles.
2. **Seuil par défaut et politique de frontière.** 80 % est-il le bon armement ?
   Et la frontière d'exécution : item passé `done`, ou tuile idle sans lock depuis
   N minutes, ou les deux ? (Recommandation : les deux, en OU, avec la frontière
   `done` prioritaire.)
3. **Nom tenu par un peer *dormant*** (si le lot 0c est retenu) : le Deck peut-il
   le reprendre pour une tuile portant le même rôle ? Reprendre est commode et
   c'est exactement le cas « mon agent revient » ; refuser est plus sûr et laisse
   le suffixe grimper. À trancher avec le comportement actuel en tête : `set_id`
   **refuse** aujourd'hui de renommer par-dessus un dormant (409).
4. **Portée du store de macros** : global + projet avec masquage par le projet
   (comme les snippets), ou projet seul ? Le global permet de partager une macro
   entre projets ; il fait aussi voyager du texte qui sera **soumis** dans un
   terminal.
5. **Le handoff coûte cher, faut-il l'automatiser ?** Demander un handoff à 80 %
   d'une fenêtre de 200 k, c'est un tour complet sur ≈ 160 k tokens d'entrée relus,
   sur le modèle de l'agent. L'alternative à coût nul existe et est déjà prescrite
   par `TEAM_PLAYBOOK` : `clear` à une frontière + briefing dans le champ `context`
   de la carte suivante, relu par `roadmap_get`. Les deux méritent d'exister —
   mais **la souscription automatique devrait-elle déclencher le plus cher des
   deux par défaut ?** (Recommandation : non ; macro `clear`+`context` par défaut,
   macro handoff en choix explicite.)
6. **Sandbox.** La mesure de contexte et l'exécution de macros dans une tuile
   sandboxée nécessitent-elles d'être couvertes dès le premier incrément, ou
   peut-on livrer « hôte seulement » et le déclarer ? (Recommandation : déclarer,
   ne pas le laisser implicite — la jauge doit dire « indisponible en sandbox »
   plutôt que d'afficher un vide ambigu.)

---

## 7. Rappels de discipline pour l'équipe

- **Chaque nouveau validateur : énumérer ses chemins d'appel** (geste vivant,
  restauration d'état persisté, heuristique automatique, point d'entrée IPC), et
  rejeter `NaN` explicitement dans tout validateur numérique — un seuil comparé à
  `NaN` passe tous les tests d'encadrement.
- **Chaque garde-fou : auditer sa COUVERTURE, pas seulement sa sensibilité.** Un
  garde-fou qui mord sur le défaut connu et couvre la moitié du domaine passe au
  vert. Et la preuve doit être **dans le diff** : une sonde mesurée en rouge puis
  laissée hors du commit n'est pas un garde-fou.
- **Aucune erreur silencieuse** : `reportError()` côté main, `guarded()` côté
  renderer, `shared/logger.ts` côté core. `console.error` seul n'est pas une trace.
- **Un commit qui fait avancer une carte de roadmap la cite**, `Card <id8>.`, en
  première ligne du **corps** du message.
- **Comparer deux chemins : canonicaliser les deux** (`canonicalPath`) avant
  `===`, `startsWith` ou usage en clé de `Map`.
- **Aucun octet de contrôle littéral dans un fichier source** : `\x1b`, `\0`,
  `\x07` en échappements.
- Avant de committer : `bun test`, la vérification de compilation
  (`bun build --target=bun broker.ts server.ts cli.ts --outdir=…`) et
  `npm run typecheck` dans `desktop/` si touché — **une fois**, par celui qui
  séquence les commits (`TESTING.md`).
