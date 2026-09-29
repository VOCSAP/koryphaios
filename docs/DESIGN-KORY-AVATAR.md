# L'avatar Kory : un compagnon flottant, superviseur de tous les Decks du poste

## Statut

Brief ecrit le 2026-09-27 a la demande de l'operateur, apres son idee
inspiree de `aryan8434/claude-code-ai-face` (MIT : un visage anime par les
hooks de Claude Code, quatre etats, un serveur Node local, pas de tray, pas
de dialogue retour). Aucun code de production ecrit. Ce document cadre,
challenge, propose, et decoupe en paliers ; il ne tranche que ce qui est
mesurable. Les decisions qui reviennent a l'operateur sont listees en §10.

Deux tours de decisions (2026-09-27) : 1-8 au premier echange, 9-19 au
second (seance de questions sur ce brief). Les tranches du plan s'appellent
des **Paliers** (decision 9) : le mot Lot est reserve a l'objet partage
persiste cote broker (`CLAUDE.md`). Glossaire : `CONTEXT.md`.

Etiquettes : **MESURE** (commande executee, sortie citee), **DEDUIT** (lu
dans le code, chemin + symbole), **PROPOSE** (choix de l'architecte, a
ratifier), **DECIDE (operateur, 2026-09-27)** (tranche par l'operateur en
reponse aux questions de §10), **NON CONFIRME** (aucune source fiable en
session).

Toute MESURE restant a faire (§8, palier 0) se fait **sur le poste de
l'operateur**, jamais depuis une session cloud : la transparence, le tray, le
compositeur, la cle operateur cote broker et le CLI installe sont ceux du PC.

Vocabulaire : un **Deck** est une fenetre Kory (un processus Electron, un
`group_id`, un superviseur). L'**avatar** est le processus unique du poste
qui les federe. Aucun autre mot n'est introduit pour ces deux objets.

---

## 1. Le besoin, tel qu'exprime

L'operateur laisse tourner plusieurs Decks en autonomie et ne veut garder
sur son bureau qu'un seul objet : un personnage flottant qui

1. **se lit d'un coup d'oeil** : endormi si aucun agent ne travaille, anime
   si au moins un travaille, interrogatif si un element attend dans une inbox ;
2. **centralise l'inbox** de tous les Decks : un clic sur l'etat « question »
   ouvre la question, on y repond comme depuis l'inbox du Deck ;
3. **se laisse interroger** en texte libre, reflechit (« ... »), repond dans
   une bulle ; idealement une vraie session Claude Code invisible, dotee des
   outils Kory ;
4. **vit dans le tray** : masquer / premier plan / quitter, et d'autres
   gestes a proposer ;
5. reste **simple et intuitif**, dans la thematique Koryphaios, expressif.

---

## 2. Ce que le code fait aujourd'hui (l'assiette du projet)

Tout ce qui suit est **DEDUIT** du depot a `e7100c5`, sauf mention.

**Fenetres et processus.**
- Un Deck = un processus Electron = **une seule** `BrowserWindow`
  (`desktop/src/main/index.ts`, `createWindow`). Aucun `Tray`, aucun
  `alwaysOnTop`, aucun `frame:false`/`transparent`, aucun
  `requestSingleInstanceLock` dans `desktop/src` (**MESURE** : `grep`
  vide). L'absence de verrou mono-instance est VOULUE (`BACKLOG.md`, refus
  documente : un verrou fusionnerait deux Kory ouverts sur deux depots).
- Le seul element « flottant » existant est le « ? » de l'assistant d'aide,
  interne a la fenetre (`desktop/docs/help-assistant`).

**Broker et groupes.**
- **Un broker par poste**, loopback `:7899` par defaut (`shared/config.ts`,
  `loadConfig`), auto-spawne par le premier Deck (`broker-spawn.ts`,
  `ensureLoopbackBroker`). Modes `local` / `remote` / `replica`.
- Chaque Deck minte son `group_id = sha256(secret)[:32]` par lancement
  (`scope.ts`, `computeScope`), **le secret ne vit qu'en memoire du Deck**.
  Toutes les routes « Deck » du broker sont clees `(group_id,
  group_secret_hash)` (TOFU) ou `project_key`.
- Les **seules lectures inter-groupes** sont `GET /admin/peers` et
  `GET /group-stats`, gardees par le seul `BROKER_TOKEN` (souvent absent en
  loopback). Rien ne liste approbations, inbox ou brouillons de graphe a
  travers les groupes. Le WebSocket `/ws` est par `instance_token` d'un peer.
- Le broker **ne connait aucun Deck** : `grep deck_id broker.ts` -> 0
  (`DESIGN-NOTIFY-EVENTS.md` §7.6).
- **Un broker par poste n'est PAS la regle** (**MESURE**, 2026-09-27) : le
  poste de l'operateur n'a pas de `~/.claude-peers.db`, ses Decks tournent en
  mode `replica` vers le broker deploye sur le LXC. Chaque Deck n'a qu'UN
  broker client (`brokerMode()`, `shared/config.ts`) : loopback en
  `local`/`replica`, distant en `remote` ; mais deux Decks du meme poste
  peuvent viser deux brokers differents. L'avatar recoit donc l'URL du broker
  de chaque Deck au branchement (decision 16).

**Inbox (Courrier) et approbations.**
- `POST /operator-inbox {group_id, group_secret_hash, session_id}` : depuis le
  lot Courrier 1A, la lecture est **a curseur par `session_id`**
  (`operator_inbox_sessions`), donc **plusieurs lecteurs d'un meme groupe
  coexistent** sans se voler les messages (`broker.ts`,
  `handleOperatorInbox`). Un lecteur inconnu demarre a `MAX(id)` (Courrier
  vide, jamais de rejeu). C'est le fait qui rend l'agregation possible sans
  toucher au broker.
- Les approbations (`pending_approvals`) sont clees **`operator_id` +
  `project_key`**, jamais par groupe (`shared/approval-scope.ts`,
  `approvalWhere`). Le credential qui les regle est la cle Ed25519 de
  l'operateur, `operator.json`, portee **MACHINE** (`operator-identity.ts`).
  Le telephone appaire repond deja par `POST /approval/claim`, et c'est le
  Deck proprietaire qui livre le verdict dans son PTY (`pollApprovalVerdicts`,
  `buildKeystrokes`). Un second repondant local suit exactement ce chemin.
- Regle en vigueur (CLAUDE.md, decision operateur 2026-09-06) : approbations et
  notifications sont **LOCALES a la run Kory**, jamais persistees ni
  federees. `DESIGN-DECK-STATE-ISOLATION.md` §1 : « rien ne fuit d'une
  fenetre a l'autre », inbox clee par `group_id`.

**Signaux d'activite.**
- L'etat `activity: 'working' | 'idle' | 'unknown'` d'une tuile est calcule
  **dans le main du Deck** par la frequence des OSC 0 (`detect/activity.ts`,
  `ACTIVITY_IDLE_MS = 3000`, arbitrage `DESIGN-ACTIVITY-PREDICATE.md` :
  « la FREQUENCE decide, le CONTENU decore »). Contrainte ratifiee
  (`DESIGN-NOTIFY-EVENTS.md` §6.2) : **un seul predicat d'activite** dans le
  depot. L'avatar ne doit donc jamais en construire un second (ni par hooks,
  ni par lecture de titres) : il CONSOMME celui du Deck.
- Le broker ne porte qu'un `activity_status: active | sleep | closed` a
  granularite 30 min (`CLAUDE_PEERS_ACTIVITY_TIMEOUT_SEC = 1800`, bumpe sur
  envoi de message seulement). Inutilisable pour « endormi / travaille ».
- « Quelqu'un te reclame » (niveau A de la taxonomie
  `DESIGN-NOTIFY-EVENTS.md` §2 : A BLOQUE / B PERDU / C COURRIER) existe deja
  sous trois producteurs : hook `PermissionRequest` du plugin embarque, outil
  `ask_operator`, detecteur `attention.ts`. Deux regles ratifiees a
  respecter : **R1** (un etat leve par un capteur textuel a un extincteur
  non textuel) et **R2** (un delai n'est pas un extincteur : un episode
  non eteint devient VISIBLE COMME SUSPECT, il ne s'efface pas).

**Superviseur et inference headless.**
- Le superviseur est une session `claude` interactive dans une tuile, pilotee
  par un prompt systeme CODE-CONSTANT (`supervisor.ts`,
  `SUPERVISOR_SYSTEM_PROMPT`, regle C8), branchee sur un endpoint loopback
  `deck-control` (`deck-control.ts`, `startDeckControl`, Bearer par appelant,
  `mintCaller(label, allowedTools)` pour un jeton restreint) via un pont MCP
  stdio sans dependance (`desktop/mcp/deck-control-mcp.ts`, 18 outils
  `deck_*`), plus `server-deck.ts` (`ask_operator`, `graph_draft_*`,
  `roadmap_dispatch`).
- Les inferences one-shot (`utility-inference.ts`) spawnent
  `claude -p --append-system-prompt-file <ctx> --strict-mcp-config
  --disallowedTools ... < prompt`, ou `codex exec --sandbox read-only`,
  `gemini`, un endpoint local. Aucun usage de `-p --resume` ni du Claude
  Agent SDK dans le depot (seul `@modelcontextprotocol/sdk` en racine).
- **MESURE** (`claude --help`, CLI `2.1.283` installe dans le conteneur) :
  `--input-format <format>  Input format (only works with --print): "text"
  (default), or "stream-json" (realtime streaming input)` ;
  `--session-id <uuid>  Use a specific session ID for the conversation` ;
  `--replay-user-messages ... (only works with --input-format=stream-json and
  --output-format=stream-json)` ; `--include-hook-events` ;
  `--restricted` (retire Bash et les outils qui executent du code).

**Design.**
- `DESIGN.md` §5 : jamais d'emoji, glyphes SVG traces au trait
  (`stroke 1.5`, `currentColor`), metaphores grecques ; couleurs a sens fixe
  (§2) : or `--glow` = attention UNIQUEMENT, violet `#b678ff` = « needs you »,
  vert = running, ambre = warn, rouge banniere = panne. Badges existants
  utiles : `clepsydra` (attente / quota), `torchLit`/`torchOut` (lien
  distant), `laurel`, `warning`, `lock`. Le glyphe `agents` est deja un
  **masque de theatre**, `inbox` un caducee, `usage` une amphore.
- Aucune mascotte, aucun asset SVG de personnage : seulement les icones
  d'application PNG/ICNS/ICO (`desktop/build/`).

---

## 3. Challenge de l'idee : conditions d'utilisation et faisabilite

### 3.1 Conditions d'utilisation Anthropic

Source lue en session : `https://code.claude.com/docs/en/legal-and-compliance`
(citation rapportee par l'agent de recherche) :

> "OAuth authentication is intended exclusively for purchasers of Claude
> Free, Pro, Max, Team, and Enterprise subscription plans and is designed to
> support ordinary use of Claude Code and other native Anthropic
> applications." [...] "Developers building products or services that
> interact with Claude's capabilities, including those using the Agent SDK,
> should use API key authentication [...]. Anthropic does not permit
> third-party developers to offer Claude.ai login into their own
> applications, or to route requests through Free, Pro, or Max plan
> credentials on behalf of their users."

Consequences, par ordre de certitude :

1. **Interdit, clairement** : un « cerveau » d'avatar qui appellerait l'API
   Anthropic ou le **Claude Agent SDK** avec les credentials OAuth de
   l'abonnement de l'operateur. Ni l'un ni l'autre n'existe dans le depot
   aujourd'hui, et ce brief ne les introduit pas.
2. **Meme classe que l'existant** : un cerveau qui est **le binaire officiel
   `claude`**, lance par l'operateur sur son poste avec son propre login,
   comme le sont deja les tuiles interactives, le superviseur et les
   inferences `claude -p` (aide, baguette, digest, juge de graphe). L'avatar
   n'ajoute pas un mode d'acces, il ajoute UN processus `claude` de plus a
   ceux que Kory spawne deja pour cet operateur.
3. **NON CONFIRME** : si une session `claude -p` residente, invisible, qui
   vit des heures, entre encore dans « ordinary use of Claude Code ». La
   documentation ne definit pas le terme. Le brief reduit le doute par
   construction : la session ne consomme rien au repos (aucun tour sans
   question de l'operateur ou evenement explicite, jamais de poll par
   inference), et elle est **facultative** : l'avatar rend tout son service
   d'affichage et d'inbox sans cerveau (§7, palier A1/A2).
4. **OpenAI / autres** : aucune information confirmee en session sur les
   conditions d'OpenAI pour un usage equivalent de `codex exec`. L'operateur
   rapporte qu'OpenAI tolererait l'usage de ses abonnements dans OpenClaw ;
   ce n'est **NON CONFIRME** par aucune source lue ici, et une tolerance
   accordee a un produit tiers ne s'etend pas d'elle-meme a un autre. Le
   brief garde donc la meme posture pour les deux fournisseurs : le binaire
   officiel (`claude`, `codex`) lance par l'operateur, jamais l'API sous
   abonnement. La chaine
   `model-providers` existante permet de cibler `codex`, `gemini`, ou un
   endpoint local par cle API ; le cerveau de l'avatar doit passer par cette
   chaine (`config.<x>Target`, `sanitizeUtilityTarget`) plutot que d'inventer
   un adaptateur, ce qui laisse a l'operateur le choix du fournisseur et de sa
   conformite.

### 3.2 « Une session Claude Code classique, invisible » : faisable, et sans recapture

Le point que l'operateur redoutait (« un `claude -p` impliquerait une
recapture des tours precedents ») est leve par la **MESURE** de §2 :
`--input-format stream-json` avec `--output-format stream-json` en mode
`--print` maintient **un seul processus `claude` longue duree** qui recoit les
tours successifs sur stdin et emet ses evenements en JSON lignes. Le
`--session-id <uuid>` est choisi a l'avance, donc la conversation est aussi
reprenable par `--resume <uuid>` apres un redemarrage de l'avatar. Deux
consequences de conception :

- **La configuration MCP d'un processus `-p` est figee a son lancement.** Or
  l'avatar voit des Decks se brancher et se debrancher. Deux options :
  (a) relancer le processus avec `--resume` a chaque changement de flotte ;
  (b) **un seul pont MCP `avatar-control`** dont les outils prennent un
  argument `deck` et routent vers le `deck-control` du Deck vise, la table de
  routage vivant dans l'avatar et non dans la config MCP. **PROPOSE : (b).**
  Le pont reutilise le protocole et le code de `deck-control-mcp.ts`, un seul
  fichier de config, jamais reecrit.
- **Le cerveau (et lui seul, palier B1) parle a chaque Deck avec un jeton RESTREINT** minte par ce Deck
  (`mintCaller('avatar', allowedTools)`), jamais le jeton historique du
  superviseur local. La liste blanche est fixee cote Deck : le Deck decide ce
  que l'avatar peut faire chez lui, l'avatar ne peut pas l'elargir.
  **DECIDE (operateur, 2026-09-27)** : le jeton est **lecture seule**
  (`deck_list_agents`, `deck_list_sessions`, `deck_list_worktrees`,
  `deck_list_templates`, `deck_list_models`, `deck_list_presets`), aucun
  outil qui spawne, ferme, ecrit ou annonce. Consequence verifiee : l'avatar
  n'a pas besoin d'ecrire chez le Deck pour rendre son service. Parler a un
  agent passe par le broker (le peer `avatar` du groupe, §4.5, enregistre
  avec le secret recu au branchement) ; regler une approbation ou une question
  `ask_operator` passe par `/approval/claim` avec la cle operateur ; mettre
  une fenetre Deck au premier plan est une COMMANDE que le Deck vient
  CHERCHER (§4.4), jamais un appel entrant sur `deck-control`.
  **DECIDE (operateur, 2026-09-27, decision 12)** : ni le jeton ni
  `deck_control_url` ne font partie du branchement du palier A1 ; rien ne
  s'en sert avant le cerveau. Ils entrent au palier B1, porte par une
  nouvelle `protocol_version` du branchement (§3.5).
- **Compaction et contexte** : NON CONFIRME que l'auto-compaction du CLI
  s'applique en mode `--print` longue duree. A mesurer au palier 0 ; le repli
  est un `--resume` + `--fork-session` quand la session depasse un seuil de
  tours, exactement le geste de `session-command.ts` pour les tuiles.

### 3.3 « Il souscrit a tous les groupes du broker » : pas depuis le broker

Fait bloquant : les secrets de groupe **n'existent qu'en memoire de chaque
Deck**, le WS est par peer, et aucune route ne liste inbox ni approbations
inter-groupes. Trois architectures possibles :

| | Principe | Ce que cela coute | Verdict |
|---|---|---|---|
| **A. Les Decks se branchent sur l'avatar** (ce que l'operateur decrit litteralement) | Chaque Deck, au demarrage, trouve l'avatar (ou le lance) et lui remet `{deck_id, label, project_key, group_id, secret, deck_control_url, jeton restreint}` sur un endpoint loopback authentifie. L'avatar lit l'inbox de chaque groupe avec **son propre curseur** (`session_id` distinct), les approbations par `project_key` avec la cle operateur, et recoit les etats d'activite POUSSES par le Deck. | Un protocole Deck<->avatar nouveau ; un secret de groupe qui quitte la memoire de son Deck pour celle de l'avatar (meme poste, meme utilisateur OS). | **RETENU** (decisions 1 et 8). Ne touche au broker que pour le peer `avatar` (§4.5), respecte « approbations locales », et le branchement est un ACTE (voir 3.4). |
| B. Route admin broker « tout voir » | Nouvelles routes gardees par `BROKER_TOKEN`. | Contredit l'isolation par groupe et la regle « pas de store broker pour approbations/notifications » ; en mode `remote`/`replica` exposerait a distance ce qui doit rester local ; force un token la ou il n'y en a pas. | Ecarte. |
| C. L'avatar EST un Deck sans tuiles | Reutiliser `index.ts` avec un mode `--avatar`. | `index.ts` est monolithique (~3500 lignes), couple a la fenetre principale ; on heriterait de tout ce qu'un Deck fait (pollers, spawn du broker, etc.). | Ecarte en v1 ; garder la question d'un partage de MODULES (pas de processus). |

### 3.4 Contradiction avec une decision existante, a arbitrer par l'operateur

`DESIGN-DECK-STATE-ISOLATION.md` §1 (**decision operateur 2026-09-06**) : les
notifications sont clees par `group_id`, « melanger les inbox de deux
fenetres est inacceptable ». L'avatar fait exactement l'inverse, par
intention.

Lecture proposee, qui evite de rouvrir la decision : **le Deck ne change
pas**, son inbox reste isolee et ephemere. L'avatar est un **objet NOUVEAU
de portee MACHINE** (le bureau de l'operateur), alimente par un **branchement
explicite** de chaque Deck, c'est-a-dire un acte de selection, exactement la
lecture retenue pour l'appairage mobile (`DESIGN-NOTIFY-EVENTS.md` §7.10,
option B : « 3 kory = 3 gestes d'appairage »). Ici le geste est
automatique par defaut (reglage global `avatar.autoAttach`, desactivable par
projet : une fenetre peut refuser d'etre agregee, jamais forcer les autres a
l'etre, meme asymetrie que `mobileApprovals`). Chaque element affiche par
l'avatar porte l'etiquette de son Deck (label + `project_key`, le badge
`host · project` de `notify/format.ts` existe deja pour cela).

**DECIDE (operateur, 2026-09-27)** : lecture ratifiee. L'avatar est un objet
MACHINE ; le Deck reste isole et ephemere ; le branchement est le geste.

### 3.5 « Lance au demarrage d'une session Kory » : qui possede l'avatar ?

Pas de verrou mono-instance cote Deck, donc N Decks demarrent sans se
connaitre. **PROPOSE** : l'avatar est un **processus separe**, un par
utilisateur OS, decouvert et lance sur le modele exact du broker loopback
(`ensureLoopbackBroker` : sonder `/health`, sinon spawner detache, attendre
6 s). Fichier de rendez-vous `avatar.json` `{pid, port, token}` dans le
repertoire d'etat MACHINE, cree en `wx` avec reprise sur pid mort. Le premier Deck le lance, les
suivants s'y branchent. **DECIDE (operateur, 2026-09-27)** : l'avatar
**survit** a la fermeture du dernier Deck et ne se ferme que depuis le tray
(ou par la fin de session OS). Seul, il prend l'etat « Seul » de §4.2 (yeux
entierement fermes, orchestra vide), qui le distingue d'« Endormi » (des
Decks branches, aucun agent au travail).

**Version du protocole (DECIDE, decision 13).** L'avatar survit aux Decks,
donc a une mise a jour de Kory. Le branchement echange `protocol_version` :
un Deck plus recent demande a l'avatar de se fermer proprement et relance
le nouveau binaire ; un avatar plus recent accepte les versions anciennes
qu'il connait et refuse (en le tracant) les autres. Jamais de dialogue
silencieux entre deux versions.

Choix du conteneur : **Electron** (fenetre transparente sans cadre,
`alwaysOnTop`, `skipTaskbar`, `Tray`, `Notification`), embarque dans le meme
paquet `koryphaios` sous un second point d'entree (`kory --avatar`), pour
partager `@shared` (types, `bannerKind`-like arbitres purs) et les glyphes.
**Windows seulement pour la v1 de la fenetre du personnage (DECIDE,
decision 11)** : le branchement et le tray (palier A1) restent multi-OS,
la fenetre transparente (palier A2) ne vise que Windows ; Linux (compositeur)
et macOS sont differes. Risque a mesurer au palier 0 : le clic « a travers »
demande `setIgnoreMouseEvents` avec `forward` pour garder le survol.

### 3.6 « Endormi si tous les peers sont inactifs » : la source est le Deck, pas le broker

Le seul `working/idle` fiable vit dans le main de chaque Deck (§2). Le Deck
le pousse a l'avatar sur changement (pas de poll) avec un **compteur par
Deck** `{working, idle, unknown, waiting, exited, rateLimited}`. L'avatar
agrege ; il n'interprete jamais un octet de PTY. Les regles R1/R2
s'appliquent a l'agregat : un Deck qui cesse de pousser sans se detacher
n'efface pas ses etats, il les rend **suspects** (torche eteinte sur sa
pastille) ; le detachement explicite ou la mort du processus (probe
`process.kill(pid, 0)` cote avatar) est l'extincteur non textuel.

Le push sur changement est complété par la répétition du snapshot courant
toutes les 5 s. Après 15 s sans `/state` valide pour CE branchement, mesurées
par une horloge monotone locale à l'avatar, le Deck devient suspect. Le
retour d'un snapshot valide rétablit sa fraîcheur. Ces délais qualifient la
liaison, jamais l'activité des agents : les derniers compteurs sont
conservés, non remplacés par zéro. Un détachement explicite ou une mort de
processus confirmée retire le Deck ; un échec de probe non concluant ne
prouve pas sa mort. Les valeurs 5 s / 15 s sont les paramètres techniques
retenus pour A1, non une mesure de performance.

---

## 4. Le personnage : proposition de design

### 4.1 Metaphore

Κορυφαῖος est le **coryphee**, qui mene le choeur depuis l'orchestra. Deux
candidats serieux, tous deux deja dans le vocabulaire graphique du Deck :

**PROPOSE, en premier : le Masque du coryphee.** Un masque de theatre grec,
trace au trait comme les glyphes (mais rendu a 120-160 px, ou la regle des
13 px ne s'applique plus), dont **les yeux, les sourcils et la bouche** sont
les trois seules pieces animees. La force de la metaphore : le theatre grec
EXPRIME par le masque, et le passage tragique/comique est litteralement le
changement d'etat. Sous le masque, un **demi-cercle d'orchestra** ou se
tiennent les choreutes : une pastille par agent (ou par Deck quand ils sont
nombreux), qui pulse quand il travaille. Le nombre et le rythme des pastilles
donnent « combien, et a quel point ca travaille » sans un chiffre. Attention a
la regle 8 de `DESIGN.md` §5 (un meneur + N suiveurs vus de face = une
empreinte de patte) : l'orchestra est un ARC OUVERT vers le haut sous le
masque, pas des ronds au-dessus d'un grand rond ; verifier en monochrome sur
gris moyen avant toute couleur.

**Alternative : la Chouette d'Athena.** Plus immediatement « attachante »
(grands yeux, clignement, sommeil evident), mais plus generique : la chouette
est la mascotte de la moitie des outils de developpement, et elle ne dit rien
du choeur. A retenir si le masque, une fois dessine, lit mal a distance.

Ecartes : un Herme (deja le glyphe de repli des roles, et sans visage
mobile), une lyre (pas de visage), un personnage complet (trop de details
pour lire une expression a 120 px).

### 4.2 Table des etats (l'avatar ne connait que ceux-la)

Chaque etat a UNE source mecanique, UN extincteur non textuel, et une couleur
qui respecte `DESIGN.md` §2. La priorite d'affichage descend du haut vers le
bas ; un etat inferieur reste visible en badge quand un superieur occupe le
visage.

| Priorite | Etat | Ce que voit l'operateur | Source | Extincteur | Couleur |
|---|---|---|---|---|---|
| 1 | **Panne** : au moins un Deck branché a une liaison suspecte ou un broker injoignable | masque grisé, fissure ; seules les pastilles des Decks concernés portent `torchOut`, les autres restent actives | fraîcheur du `/state` par branchement ; `/health` par broker | snapshot valide pour la liaison ; `/health` OK pour le broker ; retrait explicite du Deck ou mort confirmée | rouge bannière `#a03030` |
| 2 | **Reclame** (niveau A) | sourcils leves, yeux tournes vers l'operateur, halo or, badge compteur ; petit rebond a chaque NOUVEL episode, puis immobile | approbation `pending` ; `ask_operator` ; `attention` du Deck | l'approbation quitte `pending` ; le Deck baisse `waiting` | or `--glow` (c'est SA couleur) |
| 3 | **Perdu** (niveau B) | masque tragique, une pastille grise avec `warning` ; pour un quota, une `clepsydra` | tuile `exited` non voulue ; `rateLimited` | relance de la tuile ; `resumeAt` atteint et tuile repartie | ambre `#e0b341` (quota), violet `#b678ff` (perdu) |
| 4 | **Courrier** (niveau C) | expression neutre, badge caducee avec compteur | messages inbox non lus (curseur avatar) | lecture depuis la bulle, ou `seen` propage par le Deck | accent `--accent` |
| 5 | **Travaille** | yeux qui parcourent, respiration reguliere, pastilles qui pulsent en rythme avec leur agent | compteur `working > 0` d'au moins un Deck | `working == 0` partout pendant `ACTIVITY_IDLE_MS` | vert `#3ec46d` sur les pastilles |
| 6 | **Endormi** | yeux mi-clos, respiration lente, orchestra a peine visible (les choreutes sont la, ils attendent) | `working == 0` partout, aucun etat 1-4, au moins un Deck branche | tout ce qui precede | `--fg-dim` |
| 7 | **Seul** | yeux **entierement fermes**, aucune respiration, orchestra VIDE, masque legerement incline | aucun Deck branche (**DECIDE**, 2026-09-27) | un `attach` | `--fg-dim`, plus sombre qu'Endormi |
| -- | **Accompli** (transitoire, 3 s) | laurier qui apparait et s'efface | une carte de roadmap passe `done` par un agent ; un lot se termine | minuterie (transitoire, PAS un etat : R2 ne s'applique pas a un ornement) | or, mais un ORNEMENT, pas un halo : ne pas confondre avec « Reclame » |
| -- | **Reflechit** (bulle) | « ... » anime DANS la bulle, jamais sur le visage | un tour du cerveau en cours | fin du tour, erreur, ou annulation | accent |

**DÉCIDÉ (opérateur, 2026-09-28, décision 20).** Le visage résume l'existence
d'une panne, pas une panne de tous les Decks. Un broker défaillant affecte
seulement les Decks qui l'utilisent ; une liaison Deck défaillante n'affecte
pas ses voisins. Les motifs de panne restent indépendants : un heartbeat
ne guérit pas un broker injoignable. Quand il ne reste aucun Deck branché,
l'état est « Seul ».

Regle de lecture : **le visage porte l'urgence, l'orchestra porte le volume,
les badges portent le detail**. Trois couches, trois questions (« dois-je
intervenir ? », « ca travaille beaucoup ? », « quoi exactement ? »).

Deux garde-fous de conception :
- **Aucun son par defaut.** Un son est un reglage explicite, par niveau, comme
  `notifyAttention` aujourd'hui.
- **Aucune notification OS doublee.** Quand l'avatar est visible, il REMPLACE
  les toasts OS que le Deck emet pour l'inbox et l'attention (le Deck sait
  qu'il est branche) ; quand il est masque, le Deck reprend ses toasts.
  **DECIDE (decision 14)** : « visible » = les trois a la fois : l'avatar
  annonce la capacite `inbox` au branchement (donc le palier A3 est livre),
  il n'est pas masque depuis le tray, il n'est pas en « ne pas deranger ».
  Un avatar recouvert par une autre fenetre compte comme visible (non
  mesurable de facon fiable ; le badge du tray prend le relais). Avant A3,
  les toasts du Deck ne changent pas. Une
  notification de trop detruit la valeur des autres (`DESIGN-NOTIFY-EVENTS.md`).

### 4.3 La bulle

Un clic sur l'avatar ouvre UNE bulle ancree au personnage, avec trois onglets
qui ne sont que les etats 2, 4 et le cerveau :

- **Reclame** : la file des approbations/questions de tous les Decks, une
  carte par element, l'etiquette du Deck en tete, navigation `<` `>` et
  compteur « 2 / 5 », les trois gestes existants (`allow` / `deny` /
  reponse texte) qui appellent `POST /approval/claim` avec la cle operateur
  MACHINE (comme le telephone), puis le Deck proprietaire livre le verdict
  dans le PTY comme aujourd'hui. Une question `ask_operator` EST une
  approbation de kind `question` : le `claim` porte la reponse texte et
  l'outil la rend a l'agent comme valeur de retour, sans frappe. Le composant
  de rendu est celui de `InboxPanel.tsx`, elargi ; on ne reinvente pas l'UI.
- **Courrier** : les messages des agents, memes gestes `seen`/`acked`.
  **DECIDE (operateur, 2026-09-27)** : un message LU dans l'avatar n'est pas
  lu dans le Deck (deux curseurs, deux journaux, `seen`/`acked` ne
  traversent pas) ; en revanche une **REPONSE** donnee d'un cote fait
  disparaitre la notification des deux cotes. Trois cas, trois mecanismes :
  - une approbation ou une question `ask_operator` : deja vrai par
    construction, `claim` la sort de `pending` broker-side et les deux
    lecteurs le voient au poll suivant ;
  - un message de Courrier repondu DANS LE DECK (`announceTo`) : le Deck
    pousse `{replied: <message id>}` a l'avatar sur le protocole de
    branchement, l'avatar retire le message de son compteur (il reste lisible
    dans l'onglet, marque « repondu depuis <deck> ») ;
  - un message repondu DANS L'AVATAR (`send_message` depuis le peer `avatar`
    du groupe vers l'expediteur, §4.5 ; l'agent voit une reponse de
    `avatar`) : l'avatar publie `{replied: <message id>}` dans le flux de
    commandes que le Deck vient chercher (§4.4), le Deck marque l'entree
    `acked` avec la mention « repondu depuis l'avatar ». Tant que le peer
    `avatar` n'est pas livre (palier A4), l'onglet Courrier de l'avatar est en
    LECTURE SEULE : pas de bouton repondre, plutot qu'un relais par `/announce`
    qui ferait parler le nom `deck`.
  `replied` est donc le SEUL etat qui traverse, dans les deux sens ; l'id de
  message du broker est la cle commune, le `group_id` la qualifie (deux
  Decks, deux groupes, jamais de collision d'id inter-groupes puisque l'id est
  global au broker, mais le message n'appartient qu'a un groupe).
- **Demander** : un selecteur de Deck (label + projet, ou « tous »), un
  champ texte libre, la reponse en bulle. **Sans cerveau**, le texte est
  envoye a l'INTERLOCUTEUR du Deck choisi depuis le peer `avatar` (§4.5) et
  la bulle affiche en fil, sous la question, les messages que cet
  interlocuteur adresse ensuite a `avatar`, pousses par le WebSocket.
  **Avec cerveau** (palier B1), le cerveau choisit lui-meme les
  Decks a interroger, attend leurs reponses et synthetise. Une commande `/`
  minimale : `/decks`, `/focus <deck>`, `/quiet 1h`.

`Echap` ou un clic ailleurs referme la bulle ; l'avatar seul reste.

### 4.4 Le tray

Ce que demande l'operateur, plus ce qui coute peu parce que la donnee est
deja la :

- Afficher / masquer l'avatar ; **premier plan** (bascule `alwaysOnTop`) ;
  **quitter**.
- **Un sous-menu par Deck branche** : label, projet, compteur
  travaille/reclame ; cliquer **met la fenetre du Deck au premier plan**.
  Le jeton `deck-control` etant lecture seule, la commande ne rentre pas par
  la : le Deck tient une connexion sortante vers l'avatar (WebSocket ou
  long-poll sur l'endpoint de branchement) et y recoit un flux de commandes
  qu'il a CONSENTIES a l'attache (`focus`, `replied`), enumere par une
  pick-list cote Deck. L'avatar ne peut rien demander qui ne soit dans cette
  liste. **Risque Windows, a mesurer au palier 0** : l'OS refuse qu'un
  processus en arriere-plan passe sa fenetre au premier plan ; le Deck qui
  recoit `focus` risque de ne faire que clignoter dans la barre des taches.
  A mesurer : le clic tray (l'avatar a alors le premier plan) peut-il ceder
  ce droit au processus du Deck ?
- **Ne pas deranger** 30 min / 1 h / jusqu'a demain : gele les rebonds et
  le halo, PAS les compteurs (R2 : l'etat reste visible, il cesse de bouger).
- **Verrouiller la position** / **taille** (S, M, L) / **opacite au repos**.
- **Demarrer avec la session** (`app.setLoginItemSettings`), off par defaut :
  l'avatar sans Deck n'a rien a montrer sauf s'il sait relancer un Kory.
- **Ouvrir un Kory recent** : la liste des derniers `projectDir`, un item par
  depot (le Deck sait deja lancer `kory <dir>`). C'est l'objet qui rend
  « demarrer avec la session » utile.
- Icone de tray a etat : masque endormi / eveille / avec un point or quand un
  Deck reclame. Le compteur dans le titre de l'icone (tooltip) et
  `setBadgeCount` la ou l'OS le supporte.

### 4.5 Le dialogue avec un Deck : le superviseur et le team-lead sont les interlocuteurs

**DECIDE (operateur, 2026-09-27).** L'avatar porte la voix de l'operateur vers
chaque Deck et en rapporte les nouvelles, pour deux gestes : **interroger**
(« ou en est le travail sur kleos ? ») et **instruire** (« on fait une pause,
arrete le travail »). Ses interlocuteurs sont **le superviseur et le
team-lead** du Deck, pas les autres peers. Ce n'est pas une interdiction
gardee par un guard : c'est la definition de qui est LEGITIME dans le dialogue
operateur / avatar, comme le superviseur est aujourd'hui le seul a qui le Deck
adresse ses acks de spawn et le team-lead le seul a qui il dispatche. L'UI
n'offre donc que ces cibles, et les outils du cerveau prennent un `deck`,
jamais un `peer_id`.

**Le canal : un peer `avatar` par groupe, cache, prouve par la cle operateur.**
(**DECIDE (operateur, 2026-09-27)**, a la place du relais par `/announce` +
inbox `operator` de la premiere version, cout broker accepte.)

La premiere version faisait transiter le dialogue par l'inbox `operator`.
L'operateur a objecte, a raison : **l'inbox est la boite d'ATTENTION de
l'humain, pas une messagerie**. Y faire passer « ou en est kleos ? » et sa
reponse noie les questions bloquantes sous du bavardage de statut, ce que
`DESIGN-NOTIFY-EVENTS.md` nomme comme le defaut qui detruit la valeur du
canal. Le dialogue prend donc le canal des peers :

- A chaque branchement, l'avatar s'enregistre (`POST /register`) dans le
  groupe du Deck avec le secret recu, sous `peer_id = 'avatar'`,
  `role = 'avatar'`, son propre `pid` (le nettoyage PID-dead du broker le
  reape s'il meurt), `host`, et tient le `/heartbeat`. Au detachement,
  `/disconnect`. Un `instance_token` par groupe, jamais expose (regle
  d'identite d'`ARCHITECTURE.md`).
- **Descendant** : `send_message(to_peer_id = <interlocuteur>)` depuis ce
  token, le message arrivant a l'agent comme un `<channel source="claude-peers">`
  ordinaire avec `from_peer_id = 'avatar'`. L'agent le voit donc EXACTEMENT
  comme un message de peer et repond par le reflexe qu'il a deja
  (`server.ts` : « reply now with send_message to its from_peer_id »). Le
  nom `deck`, sans boite, disparait du dialogue.
- **Montant** : la reponse arrive sur le WebSocket `/ws` que l'avatar ouvre
  avec son token, **poussee en temps reel** (plus de sondage, plus de latence
  de 10 s), et reste relisible par `/poll-messages`. La mecanique A du broker
  (repondre acquitte ce qu'on a recu) s'applique telle quelle.
- **L'inbox `operator` garde son role** : questions bloquantes,
  `ask_operator`, approbations, trouvailles. L'onglet Courrier de l'avatar la
  lit toujours par curseur ; le fil « Demander » ne la touche plus. Le
  double comptage de la premiere version n'existe plus.

**Ce que « cache » et « avatar » exigent du broker.** Trois changements,
petits mais reels, qui annulent la clause « ne modifie pas le broker » de §9 :

1. **`avatar` rejoint `RESERVED_PEER_IDS`** (`deck`, `operator`, `system`).
   Sans cela un agent peut `set_id('avatar')`, ou s'enregistrer sous ce nom
   avant que l'avatar ne se branche (l'avatar recevrait `avatar-2`), et
   parler au superviseur AVEC LA VOIX DE L'OPERATEUR : l'enveloppe dit qu'une
   instruction de l'avatar vaut consentement, ce nom est donc une identite
   sensible. `deriveDefaultId` et `set_id` refusent deja les noms reserves.
2. **Enregistrer un nom reserve exige une preuve** : `/register` sous
   `avatar` porte un `auth` Ed25519 de l'operateur (`buildAuthProof`, kind
   `operator`, celui de `approval-service.ts`), verifie par le broker.
   Precedent : la branche « nom reserve signe » de `resolveRoadmapAuthor`
   (`deck`/`operator`/`system`). **MESURE (2026-09-27)** : aucune activation
   prealable n'est requise. `authenticateOperator` (`shared/approval-scope.ts`)
   accepte au premier contact une cle qui s'auto-certifie (`operator_id` =
   empreinte de la cle), puis la persiste dans `approval_operators` apres
   verification de la signature ; les inscriptions suivantes doivent
   correspondre.
   **Mais c'est une faille ouverte** (carte 300a5665) : tout processus qui
   signe avec SA cle s'auto-certifie operateur. Le peer `avatar` parlant
   avec la Voix de l'operateur, le palier A4 attend que 300a5665 lie
   l'identite operateur a une cle epinglee.
3. **Un drapeau `hidden`** sur la ligne `peers`, pose a l'enregistrement du
   nom reserve, et **une projection qui EXCLUT** : `handleListPeers` (un
   agent ne le voit jamais, quel que soit le scope), les cibles d'un
   `/announce` de groupe, `/group-stats`, et le relais de federation
   (`/federation/sync` ne presente jamais un peer cache a l'upstream : sinon
   l'avatar d'un poste apparait aux agents d'un autre). Le ciblage direct
   `send_message('avatar')` reste resolu : cacher n'est pas rendre
   injoignable. `/admin/peers` le montre (diagnostic `cli.ts`). C'est une
   OMIT-projection, donc elle degrade en fuite : le test enumere chaque
   lecture de `peers` publiee et exige que `hidden = 1` en soit absent
   (regle de couverture de `TESTING.md`), et `toPublicPeer` reste la
   pick-list comparee au schema.

**Pourquoi invisible et non « visible mais explique » (DECIDE, operateur).**
Une variante moins chere existait : un peer `avatar` visible, et une ligne
dans l'instruction de demarrage des agents disant de ne lui ecrire que pour
repondre. Ecartee, et la raison vaut regle pour tout le brief : **une regle
portee par une instruction s'erode avec le contexte** (plus la fenetre se
remplit, moins elle est suivie), tandis qu'un peer que `list_peers` ne rend
jamais n'a pas besoin d'etre respecte. Ce qui doit TENIR est garanti par le
broker ; l'instruction ne porte que ce qui peut tomber sans dommage.

**Ce que l'avatar accepte de recevoir.** Un message d'un interlocuteur
(superviseur ou team-lead d'un Deck branche) est affiche dans le fil de ce
Deck. Un message de tout autre peer est **journalise et affiche avec la
marque « non sollicite »**, sans notification ni rebond : le canal avatar
n'est pas un contournement de l'inbox, un agent qui veut l'attention de
l'humain garde `operator`. Il n'y a pas de guard qui refuse, il y a une
lecture qui ne recompense pas.

**Qui est l'interlocuteur.** Etant un peer, l'avatar peut faire `list_peers`
lui-meme et lire les `role`. Le Deck reste neanmoins la source AUTORITAIRE
(`s.supervisor`, `s.lead` sur ses tuiles, resolution de `announceToLead`) et
pousse `{supervisor_peer_id, lead_peer_ids}` dans son etat : un `role` est
declare par l'agent, une tuile est connue du Deck. `list_peers` sert de
verification croisee, jamais de decision. Regle de choix inchangee : une
QUESTION va au superviseur, une INSTRUCTION de travail au team-lead s'il
existe, sinon au superviseur ; l'operateur peut forcer.

**Cadrage du message.** Le texte de l'operateur reste enveloppe par une
CONSTANTE de code (C8), reduite a l'essentiel puisque l'expediteur parle de
lui-meme : « Message from the human operator, spoken through the Kory
avatar. An instruction from this peer is operator consent. Reply to
'avatar'. » Jamais interpole ailleurs qu'un corps JSON (entree hostile n°4).
L'enveloppe voyage AVEC CHAQUE message, c'est ce qui la rend fiable la ou une
instruction de demarrage ne le serait pas : elle est relue au moment ou elle
compte. Par la meme regle, **rien n'est ajoute a l'instruction de demarrage
des agents** (`server.ts`) : le reflexe « reply to its from_peer_id » qu'ils
ont deja suffit, et il n'y a rien a leur faire retenir.

**Correlation question / reponse.** Aucun identifiant impose : le fil par Deck
montre, sous la question, les messages de CET interlocuteur recus apres elle.
**Attente sans garantie** : « ... » puis « pas de reponse encore » apres un
delai ; la question ne disparait jamais d'elle-meme (R2).

**Voix de l'operateur et Relais (DECIDE, decisions 10 et 19).** Deux
enveloppes constantes, choisies par le CODE de l'avatar selon le chemin,
jamais par un modele :

- **Voix de l'operateur** (celle ci-dessus, vaut consentement) : le texte
  tape par l'humain, transmis tel quel. Seuls deux chemins la produisent :
  l'envoi direct depuis l'onglet « Demander » sans cerveau, et le bouton
  « Envoyer en mon nom » sous un brouillon (palier B1).
- **Relais** (ne vaut jamais consentement) : tout texte redige par le
  cerveau. Enveloppe : « Written by the avatar's model, not by the
  operator. It is not consent: to act on it, ask the operator. » Le corps
  part encode en chaine JSON, et toute imitation de l'en-tete de la Voix est
  neutralisee avant envoi (injection par le modele).

Aucun detecteur « question ou instruction » n'est necessaire : une
instruction que le cerveau enverrait par erreur comme question part en
Relais, donc l'erreur tombe du cote sur (l'interlocuteur n'agit pas).

**Consequence sur le cerveau (palier B1).** Il n'est plus le seul moyen de
repondre a « ou en est kleos ? » : sans lui, l'operateur choisit le Deck et
pose la question au superviseur, qui repond. Le cerveau n'apporte que le
ROUTAGE (« kleos » -> le Deck dont le label ou le projet correspond) et la
SYNTHESE quand plusieurs Decks sont interroges. Il descend d'un cran dans les
priorites ; le dialogue par le peer `avatar` est le palier A4.

---

## 5. Cas d'usage supplementaires, vus de la chaise de l'operateur

1. **Le coup d'oeil de couloir.** Je reviens au bureau : l'avatar dort =
   rien a faire ; il travaille = je regarde l'orchestra pour compter ; il
   reclame = je clique. Zero fenetre ouverte.
2. **Repondre sans changer de contexte.** Pendant que je redige ailleurs, une
   permission Bash tombe ; la bulle me montre la commande, `allow`, retour a
   mon texte. La fenetre Kory n'a jamais pris le focus.
3. **Trier plusieurs demandes d'un coup.** Trois Decks, cinq questions ; la
   bulle les enfile par Deck, je les traite en sequence, le compteur descend.
4. **« Ou en est-on sur kleos ? »** Je choisis le Deck kleos dans la bulle,
   je pose la question ; le superviseur de ce Deck repond dans le fil. Avec
   le cerveau, je tape la phrase telle quelle et il trouve le Deck.
4b. **« On fait une pause, arretez. »** Meme bulle, cible « tous » : chaque
   team-lead (a defaut le superviseur) recoit l'instruction et fait ce que sa
   regle de consentement lui permet ; les reponses arrivent Deck par Deck.
5. **Reprendre la main sur un Deck precis** depuis le tray, sans chercher la
   fenetre derriere dix autres.
6. **Partage d'ecran / demo.** Un mode « discret » : l'avatar masque le
   contenu des bulles (titres et commandes des approbations) et ne montre que
   les compteurs, pour ne pas exposer un chemin ou une commande en reunion.
7. **Fin de journee.** L'avatar dort depuis 40 min et aucun Deck ne reclame :
   je peux fermer ; s'il est en « Perdu » quelque part, je sais qu'une tuile
   est morte avant de partir.
8. **Un poste, deux comptes OS.** Chaque compte a son avatar (repertoire
   d'etat par utilisateur, rien a coder : precedent `operator.json`).
9. **Le superviseur local reste le pilote.** L'avatar ne spawne rien ; il
   RELAIE la voix de l'operateur au superviseur ou au team-lead du Deck
   concerne (§4.5), qui gardent leur regle de consentement. Un seul cerveau
   decide par Deck.

---

## 6. A la place de l'avatar : ce dont j'ai besoin

1. **Savoir qui je suis** : un `avatar_id` minte par lancement, un port, un
   jeton, publies dans `avatar.json` ; savoir que je suis SEUL (verrou `wx`).
2. **Savoir qui est branche, et a qui parler** : pour chaque Deck `{deck_id
   minte par lancement, label, project_key, group_id, pid, deck_control_url,
   jeton restreint}` plus, dans chaque etat pousse, `{supervisor_peer_id,
   lead_peer_ids}` (§4.5) ; un battement de coeur ou une probe pid pour
   savoir qu'il vit encore ; un detachement explicite a sa sortie
   (`before-quit.ts`).
3. **Recevoir les etats sans les deviner** : les compteurs d'activite pousses
   par le Deck sur changement ; la liste `pending` des approbations par
   `project_key` ; le Courrier par curseur propre. Aucun octet de PTY, aucun
   titre de terminal.
4. **Pouvoir agir sur le bon objet** : la cle operateur pour `claim`
   (approbations et questions `ask_operator`) ; le peer `avatar` du groupe
   pour parler aux interlocuteurs et repondre a un message de Courrier ; le
   flux de commandes consenties pour mettre une fenetre Deck au premier plan.
   Jamais d'ecriture sur `deck-control`. Toujours resoudre l'OBJET (cette
   approbation, ce Deck, ce groupe) avant de verifier « puis-je agir sur
   LUI » (CLAUDE.md, « what happens when there are two? »).
5. **Un cerveau facultatif** : un processus `claude -p --input-format
   stream-json` (ou l'adaptateur d'un autre fournisseur), un prompt systeme
   code-constant qui dit ce que je suis (le superviseur GLOBAL, qui ne spawne
   pas, qui n'ecrit pas de code, qui delegue aux superviseurs locaux), un
   pont MCP `avatar-control` unique, `--restricted` ou `--disallowedTools`
   sur tout ce qui execute, `--strict-mcp-config`.
6. **Un journal** : `avatar.log` via le meme `shared/logger.ts`, un
   `reportError` local ; chaque `catch` trace (regle « no silent errors »).
7. **Une degradation qui se voit** : broker down, Deck muet, cerveau absent :
   trois visages distincts, pas un avatar qui dort par erreur.

---

## 7. Autres axes

- **D'autres personnages plus tard** (**DECIDE**, 2026-09-27 : le masque
  d'abord, d'autres « peaux » ensuite). Consequence de structure des le palier
  A2 : la machine d'etats (`shared/avatar-state.ts`, pure) ne connait aucun
  dessin ; un personnage est un module de RENDU qui recoit `AvatarState` et
  rien d'autre. Un second personnage ne touche ni les etats, ni le
  protocole, ni le tray. Un test exige que chaque peau rende les huit etats
  de §4.2 (couverture, pas seulement sensibilite).
- **Une v0 sans personnage** : le protocole de branchement + le tray seul
  (icone a etat, sous-menu par Deck, compteurs) livre deja les cas 1, 5 et 7
  de §5. Il permet de valider le protocole et l'agregation avant un pixel de
  dessin, et il vit meme si la transparence Linux decoit.
- **Le predicat unique** : la tentation sera d'utiliser les hooks
  `Stop`/`UserPromptSubmit`/`Notification` du CLI pour un « working » plus
  fin. Refuse par la contrainte §6.2 de `DESIGN-NOTIFY-EVENTS.md` : si ces
  hooks valent mieux, ils remplacent le predicat DU DECK, et l'avatar en
  herite ; jamais un second predicat cote avatar.
- **Mobile** : le compagnon LAN est par Deck (`companion-server.ts`), l'avatar
  est par poste. Le jour ou le telephone veut « tous les Kory du poste », c'est
  l'avatar qui devrait servir, pas N compagnons. Hors perimetre, mais a ne pas
  contredire par un choix de protocole (garder l'agregat serialisable).
- **Accessibilite** : chaque etat a aussi un TEXTE (tooltip, `aria-label`,
  titre de tray) : la couleur et l'animation ne sont jamais le seul canal.
- **Pas de persistance des elements** : l'avatar ne journalise ni approbations
  ni Courrier au-dela de sa vie (regle CLAUDE.md « locales par
  construction ») ; il ne persiste que ses reglages (position, taille, DND,
  autoAttach) en portee MACHINE.
- **Deux Decks sur le meme depot** : deux `deck_id`, deux `group_id`, un seul
  `project_key`, donc la liste `pending` par `project_key` est PARTAGEE ; les
  approbations portent `origin.group_id` et `session_ref` : l'avatar range
  par `group_id`, jamais par projet, sinon les deux Decks se confondent.

---

## 8. Ebauche de plan par paliers

Chaque palier est livrable et utile seul. Les skills du depot a lire sont
nommes ; les tests exigibles aussi.

Ordre recommande : 0, A1, A2, A4, A3, B1, B2. **Calendrier (DECIDE,
decision 15)** : apres le travail en vol et les cartes de libelles de
modele, les paliers 0 et A1 forment le Lot suivant ; A2 a B2 restent des
cartes `planned` hors file, rangees apres quelques jours d'usage de A1. A4 passe avant A3 parce que
le bouton « repondre » du Courrier et l'onglet « Demander » reposent sur le
peer `avatar` ; A3 livre avant A4 reste utile (lecture + `claim`) mais sans
reponse au Courrier.

### Palier 0 : mesures sur le poste de l'operateur (pas de code)

Toutes ces mesures se font SUR LE PC, jamais depuis une session cloud.

**Qui mesure (DECIDE, decision 17)** : des agents, sur le poste, avec une
instance d'ecran privee et des captures ; l'operateur ne fait qu'un geste :
regarder la planche des masques a 2 m et dire lequel se lit.

- **Cle operateur cote broker** : FAIT (§4.5, TOFU auto-certifiant). Plus
  rien a mesurer.
- **Transparence / always-on-top / tray** : une fenetre Electron
  `transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true` +
  `Tray` sur le poste reel, Windows seulement (decision 11) : clic-a-travers
  avec `setIgnoreMouseEvents(true, { forward: true })`, et passage au premier
  plan d'une autre fenetre depuis un clic tray (§4.4). Sortie : captures +
  verdict.
- **Auto-compaction du CLI en `--print` longue duree** : 50 tours sur un
  `claude -p --input-format stream-json --output-format stream-json
  --session-id <uuid>` avec le CLI installe sur le poste ; noter si un
  evenement de compaction apparait dans le flux et si `--resume <uuid>` reprend
  apres un kill du processus. Modele le moins cher (decision 17) ; si la
  compaction ne se declenche pas, gonfler les tours plutot que les multiplier.
- **Le masque** : dessiner masque + orchestra en monochrome a 120 px sur gris
  moyen, rendre les huit etats de §4.2, verifier a 2 m de l'ecran et contre
  la regle 8 de `DESIGN.md` §5 (empreinte de patte).

### Palier A1 : processus avatar, branchement, tray (sans personnage, sans inbox)

- `desktop/src/avatar/` : point d'entree `kory --avatar`, `avatar.json`
  (publie par le seul detenteur du bail `requestSingleInstanceLock` d'un
  userData dedie, sans reprise sur pid mort), endpoint
  loopback `POST /attach|/detach|/state` (Bearer, JSON, tailles bornees).
  Le branchement porte `protocol_version` (decision 13), `broker_url` du Deck
  (decision 16 ; l'identite d'un Deck branche inclut son broker) et son
  **nom** (decision 18) : nom de l'espace de travail s'il a ete sauvegarde,
  sinon nom du dossier du depot ; « (2) » en cas de doublon parmi les Decks
  branches ; renommable dans le Deck, transmis au branchement suivant ;
  l'infobulle porte le chemin complet et le broker. Ni jeton `deck-control`
  ni `deck_control_url` (decision 12, palier B1).
  Le branchement porte aussi `projectDir` (chemin complet, métadonnée) et
  `deckPid` (probe et cible du geste de premier plan). Sa clé est
  `{deckRunId, broker_url}`, où `deckRunId` est minté une fois par lancement
  du Deck, conservé aux reconnexions, jamais persisté. Un nouvel attach de
  cette même run remplace sa connexion, sans créer un deuxième Deck ; un
  autre lancement n'hérite pas de ses compteurs ni commandes. Ni le nom,
  ni le chemin, ni le groupe ne sont une clé de Deck.

  Le nom est celui du workspace courant sauvegardé, sauvegarde automatique
  incluse ; sinon c'est le nom du dossier. Aucun test sur `pinned`, aucune
  heuristique sur la forme du nom ne prétend identifier un nom humain.
  Un renommage explicite prend le pas sur le nom automatique ; la règle de
  transmission au branchement suivant reste inchangée.
- Cote Deck : `ensureAvatar()` au demarrage sur le modele de
  `ensureLoopbackBroker` ; pousser les compteurs
  d'activite (derives de `SessionRuntime`, pur et teste) ; ouvrir la
  connexion sortante qui recoit les commandes consenties (`focus` en A1,
  `replied` en A3), pick-list `AVATAR_COMMANDS` cote Deck ; `detach` dans
  `before-quit.ts` ; `avatar.autoAttach=true` par défaut globalement
  (décision 1, §3.4), avec opt-out projet prioritaire. Ne pas confondre ce
  réglage avec le démarrage à l'ouverture de session OS, off par défaut.
- Tray : icone a etat, sous-menu par Deck, DND, quitter. Aucune animation.
- Tests : pur `shared/avatar-state.ts` (agregation + priorite des etats, R1/R2
  : un Deck muet devient suspect, jamais efface ; zero Deck = « Seul », pas
  « Endormi ») ; `desktop-state-scope` classe `avatar.json` et
  `avatar-settings.json` en MACHINE ; un branchement de `protocol_version`
  inconnue est refuse et trace, jamais accepte en silence ; un doublon de nom
  prend « (2) » ; une panne est rendue PAR Deck (par broker), sans dégrader
  les autres Decks ; le visage résume la présence d'une panne ; une commande
  hors `AVATAR_COMMANDS` est rejetee et tracee.
- Gate Windows de premier plan : clic réel sur l'item Tray du Deck choisi,
  menu fermé, cession du droit via `AllowSetForegroundWindow(deckPid)`, puis
  commande consentie `focus`. Vérifier le PID de la fenêtre effectivement
  au premier plan, pas seulement le retour des API. Tester deux Decks du
  même projet ; le mauvais Deck ne doit jamais recevoir le focus.
  La preuve obtenue par clic dans une fenêtre ne ferme pas ce gate Tray.
  Un échec du geste reste visible et tracé, jamais annoncé comme un succès.
- Skills : `add-deck-view` (canal IPC), `error-reporting`.

### Palier A2 : le personnage et les etats

- Fenetre transparente sans cadre, `alwaysOnTop`, `skipTaskbar`,
  deplacable, position persistee, opacite au repos.
- SVG du masque + orchestra, animations CSS (`prefers-reduced-motion`
  respecte), les huit etats de §4.2 + « Accompli » et « Reflechit »,
  tooltips textuels ; machine d'etats pure separee du rendu (§7).
- Skill `deck-design` ; verifier §5 regle 8 (empreinte de patte).

### Palier A3 : inbox agregee

- L'avatar lit `POST /operator-inbox` par groupe avec son `session_id`, et
  `/approval/list` par `project_key` avec la cle operateur ; range par
  `group_id`.
- Bulle « Reclame » et « Courrier » sur `InboxPanel.tsx` reutilise et elargi ;
  `claim` par la cle operateur (approbations ET questions `ask_operator`) ;
  reponse a un message de Courrier depuis le peer `avatar` du groupe (palier A4 ;
  sans lui, l'onglet est en lecture seule) ; propagation `replied` dans les
  deux sens (§4.3) ; navigation entre elements ; suppression des toasts OS du
  Deck quand l'avatar est visible.
- Tests : le tri par `group_id` avec deux Decks meme projet ; un `claim` 409
  (le telephone a gagne) rend la carte « reglee ailleurs » et ne reste pas
  `pending` a l'ecran ; aucun payload avatar->Deck ne porte le secret d'un
  autre groupe ; un `replied` recu du Deck retire le message du compteur
  avatar sans le marquer `seen` ; un `seen` avatar ne produit AUCUN message
  vers le Deck.

### Palier A4 : le dialogue par le peer `avatar` (§4.5)

- **Broker (skill `add-broker-feature`)** : `avatar` dans
  `RESERVED_PEER_IDS` ; `/register` d'un nom reserve exige la preuve
  operateur (branche signee, precedent `resolveRoadmapAuthor`) ; colonne
  `hidden` + exclusion de `handleListPeers`, des cibles d'annonce de groupe,
  de `/group-stats` et de `/federation/sync` ; `toPublicPeer` inchange en
  pick-list. Rien dans l'instruction de demarrage de `server.ts`.
- **Avatar** : un peer par groupe branche (register, heartbeat, WS, disconnect
  au detachement, PID reel) ; onglet « Demander » : selecteur de Deck (ou
  « tous »), envoi par `send_message` sous l'enveloppe constante
  `AVATAR_VOICE_TEXT`, cible superviseur / team-lead selon question ou
  instruction, fil des reponses poussees par le WS, marque « non sollicite »
  pour les autres expediteurs.
- **Deck** : `supervisor_peer_id` et `lead_peer_ids` dans l'etat pousse,
  recalcules a chaque changement de tuile.
- Tests : un `set_id('avatar')` et un `/register` sans preuve sous ce nom
  sont refuses ; un peer `hidden` n'apparait dans AUCUNE lecture publiee de
  `peers` (enumeration des requetes, pas un seul cas) et n'est jamais relaye
  par `/federation/sync` ; `send_message('avatar')` depuis l'interlocuteur
  arrive ; la cible resolue pour `{question, instruction} x {lead present,
  lead absent, aucune session}` ; un texte d'operateur avec guillemets,
  retours a la ligne et `$(...)` arrive intact dans le corps JSON et nulle
  part ailleurs ; un Deck sans interlocuteur affiche « personne a qui parler
  dans ce Deck » plutot qu'un envoi perdu ; la mort de l'avatar rend ses peers
  dormants au balayage PID suivant.

### Palier B1 : le cerveau (routage et synthese)

- `avatar-brain.ts` : spawn via la chaine `model-adapters.ts` (cible
  `config.avatarTarget`, `sanitizeUtilityTarget`, `excludeKinds bridge`),
  prompt code-constant `AVATAR_SYSTEM_PROMPT` (regle C8), `--restricted`
  ou `--disallowedTools`, `--strict-mcp-config`, `--session-id` choisi,
  `--input-format stream-json`.
- Pont `avatar-control-mcp.ts` derive de `deck-control-mcp.ts`, outils
  `avatar_list_decks`, `avatar_deck_call(deck, tool, args)` (allow-list
  re-verifiee cote avatar PUIS cote Deck), `avatar_inbox_list`,
  `avatar_ask_deck(deck, text)`, qui envoie au superviseur sous l'enveloppe
  **Relais** et attend la premiere reponse avec un delai borne, et
  `avatar_draft_instruction(deck, text)`, qui N'ENVOIE RIEN : il affiche un
  brouillon dans la bulle, que seul le bouton « Envoyer en mon nom » fait
  partir comme **Voix de l'operateur** vers le team-lead (a defaut le
  superviseur). Aucun outil ne produit la Voix ; aucun ne prend un `peer_id`
  (decision 19, §4.5).
- Le Deck mint ici `mintCaller('avatar', AVATAR_READONLY_TOOLS)` (constante
  code, `deck_list_*` seulement, decision 4) et le transmet avec
  `deck_control_url` (re-valide loopback-only : entree hostile n°3) sous une
  nouvelle `protocol_version` (decision 12).
- `AVATAR_SYSTEM_PROMPT` est une constante de code, pas un fichier
  `agents/*.md` (modifiable par le depot : entree hostile n°1). Il dit ce
  qu'est l'avatar et pourquoi les instructions passent par un brouillon ; il
  n'est pas la garantie, les outils le sont.
- Bulle « Demander », « ... » pendant le tour, erreurs visibles (timeout,
  fournisseur absent, quota). **Desactive par defaut** (DECIDE, 2026-09-27) :
  l'onglet affiche le texte de §3.1 et le reglage qui l'active.
- Skill `model-providers`. Tests : le prompt contient la clause « ne spawne
  jamais, delegue au superviseur local » ; la config MCP n'est jamais
  reecrite pendant la vie du processus ; aucun outil MCP n'atteint le chemin
  de la Voix (enumeration des outils, pas un cas) ; un Relais dont le corps
  imite l'en-tete de la Voix arrive neutralise ; `AVATAR_READONLY_TOOLS`
  compare a la liste des outils `deck-control` refuse tout nom ne commencant
  pas par `deck_list_`.

### Palier B2 : confort

- Ouvrir un Kory recent, demarrer avec la session, mode discret, sons
  optionnels, `setBadgeCount`, raccourci global afficher/masquer.

---

## 9. Ce que ce brief ne fait PAS

- Il ne modifie le broker que pour le peer `avatar` (§4.5, palier A4) : un nom
  reserve, une preuve a l'enregistrement, un drapeau `hidden` et sa
  projection. Aucune route nouvelle, aucune table nouvelle, aucun store
  d'approbation ou de notification.
- Il ne donne a l'avatar aucun pouvoir de spawn ni de fermeture : ces gestes
  restent aux superviseurs locaux et a l'operateur dans le Deck.
- Il ne persiste ni approbation ni Courrier.
- Il ne cree pas de quatrieme mot pour Deck / avatar / superviseur.

---

## 10. Decisions de l'operateur (2026-09-27)

Les huit questions posees au fil de l'echange, et leur reponse. Chacune est
reportee a l'endroit du document qu'elle tranche.

1. **Agregation vs isolation** : ratifie. Le Deck reste isole, l'avatar est
   un objet MACHINE alimente par branchement explicite (§3.4).
2. **Vie de l'avatar** : il survit au dernier Deck ; etat « Seul », yeux
   entierement fermes (§3.5, §4.2 ligne 7).
3. **Acquittement croise** : `seen`/`acked` ne traversent pas ; une REPONSE
   donnee d'un cote eteint la notification des deux cotes (§4.3).
4. **Jeton `deck-control` de l'avatar** : lecture seule, `deck_list_*`
   uniquement ; toute action passe par le broker ou par le flux de commandes
   que le Deck vient chercher (§3.2, §4.4).
5. **Cerveau** : desactive par defaut, activable dans Settings avec le texte
   de §3.1 (§8, palier B1). La tolerance OpenAI rapportee pour OpenClaw reste
   NON CONFIRMEE et ne change pas la posture (§3.1 point 4).
6. **Personnage** : le masque du coryphee ; d'autres peaux plus tard, d'ou la
   separation etats / rendu exigee des le palier A2 (§7).
7. **Interlocuteurs** : l'avatar interroge et instruit le superviseur et le
   team-lead de chaque Deck, jamais les autres peers ; legitimite du dialogue,
   pas interdiction gardee ; interlocuteurs pousses par le Deck (§4.5).
8. **Canal du dialogue** : un peer `avatar` CACHE par groupe, a la place du
   relais par l'inbox `operator`, qui reste la boite d'attention ; cout
   broker accepte (`avatar` nom reserve, preuve operateur a
   l'enregistrement, drapeau `hidden` exclu de toute lecture publiee et de la
   federation, §4.5, palier A4). Variante « visible + instruction » ecartee :
   une regle portee par une instruction s'erode avec le contexte, une
   garantie broker non. La cle operateur : mesuree depuis (§4.5, TOFU).

Second tour (seance de questions sur ce brief) :

9. **Vocabulaire** : les tranches du plan sont des **Paliers** ; Lot reste
   l'objet partage persiste cote broker (`CONTEXT.md`).
10. **Voix et Relais** : seule la Voix de l'operateur vaut consentement ; ce
   que redige le cerveau est un Relais (§4.5).
11. **OS** : Windows seulement pour la fenetre du personnage en v1 ; tray et
   branchement multi-OS (§3.5).
12. **Jeton `deck-control`** : cree au palier B1, pas A1 (§3.2).
13. **Version du protocole** : echangee au branchement ; Deck plus recent =
   l'avatar redemarre ; version inconnue = refus trace (§3.5).
14. **Toasts du Deck** : coupes seulement si capacite `inbox` + avatar non
   masque + hors « ne pas deranger » (§4.2).
15. **Calendrier** : travail en vol d'abord, puis paliers 0 + A1 comme Lot
   suivant ; A2-B2 en cartes hors file (§8).
16. **Plusieurs brokers** : pris en charge des A1, `broker_url` fait partie
   de l'identite d'un Deck branche ; l'operateur est en mode `replica`
   (§2).
17. **Palier 0** : mesure par des agents, modele le moins cher pour la
   compaction ; l'operateur ne juge que la planche des masques (§8).
18. **Nom d'un Deck** : espace de travail, sinon dossier du depot, « (2) »
   en cas de doublon, renommable (§8, palier A1).
19. **Instructions du cerveau** : aucun outil ne produit la Voix ; le
   cerveau propose un brouillon, le bouton « Envoyer en mon nom » l'envoie ;
   prompt en constante de code (§4.5, palier B1).

Arbitrage complémentaire (2026-09-28) :

20. **Visage Panne : option A, choix opérateur.** Le visage passe à Panne
    dès qu'au moins un Deck branché a une liaison suspecte ou un broker
    injoignable. Seules les pastilles des Decks concernés portent
    `torchOut` ; les autres Decks ne sont pas dégradés, leur activité reste
    visible. Le visage résume la présence d'une panne, pas une panne de
    tous les Decks. Zéro Deck reste « Seul » (§4.2, §8 palier A1).

Reste ouvert, a mesurer au palier 0 SUR LE POSTE : transparence,
always-on-top, tray et passage au premier plan (Windows) ; auto-compaction d'un `claude -p --input-format stream-json` longue
duree et reprise par `--resume` ; lisibilite du masque a 120 px en monochrome.

Ce que l'echange a ecarte, pour ne pas le reproposer : une route admin
broker « tout voir » (§3.3 B) ; l'avatar comme Deck sans tuiles (§3.3 C) ;
le relais du dialogue par l'inbox `operator` (§4.5) ; un peer `avatar`
visible + instruction (§4.5) ; un second predicat d'activite cote avatar
(§7) ; la chouette, le Herme, la lyre, le personnage complet (§4.1) ; un TTL
qui efface un etat (R2) ; un son par defaut ; une notification OS doublee.
