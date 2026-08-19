# Modele d'evenements des notifications d'agent (Kory)

Conception, 2026-08-19. Transport-agnostique par construction.
Auteur : agent architecte, sur dispatch de `desktop-7b2civn-koryphaios-15`.
Lecture seule sur le code ; aucun code de production ecrit.

**Nom du fichier.** `docs/` (sans slash initial) matche `desktop/docs/` : tout
NOUVEAU fichier depose la est silencieusement exclu de `git add`. MESURE :
`git check-ignore -v desktop/docs/design-notifications-events.md` ->
`.gitignore:70:docs/`. Precedent direct : `desktop/docs/design-courrier-lot1.md`,
livre le 2026-08-17, n'est ni dans l'index ni sur le disque
(`git ls-files --error-unmatch` -> `did not match any file(s) known to git` ;
absent de `ls desktop/docs/`). D'ou ce fichier a la RACINE.
MESURE : `git check-ignore -v DESIGN-NOTIFY-EVENTS.md` -> code de sortie 1
(non ignore).

---

## Deux regles generales, ratifiees

Elles precedent le reste parce qu'elles ne sont pas propres aux notifications :
elles enoncent le defaut que ce depot a paye trois fois (badge de quota fige,
`thinking` mort, badge d'attention collant). Ratifiees par le team-lead le
2026-08-19, a conserver au-dela de ce document.

> **R1. Un extincteur doit etre d'une classe de capteur au moins aussi robuste
> que le raiser. Un etat leve par un capteur TEXTUEL doit posseder EN PLUS un
> extincteur NON TEXTUEL.**
>
> Elle vaut mieux que les trois correctifs particuliers qu'elle remplace : les
> trois defauts cites ont la meme forme, un indicateur dont l'allumage est teste
> et dont l'extinction ne l'est pas. La sensibilite se verifie toute seule, la
> couverture de l'extinction jamais.

> **R2. Un delai d'expiration n'est PAS un extincteur.** Un episode non eteint
> au-dela d'un seuil devient **VISIBLE COMME SUSPECT**, il ne s'efface pas.
>
> Un TTL qui efface un operateur qui attend reellement fabrique exactement le
> mensonge d'interface que cette couche existe pour supprimer. Le repli correct
> est une surface de sante, pas un balai.

Tout le reste du document est l'application de R1 et R2 au cas des
notifications d'agent.

---

## Cadrage du probleme

L'operateur pilote une dizaine de tuiles et veut savoir, sans regarder,
laquelle reclame quelque chose. La question n'est pas « comment capter » :
Kory possede le pty, l'evenement d'exit, l'outil `ask_operator` et le Courrier.
La question est **quels etats meritent de traverser la frontiere de la machine,
qui les eteint, et sous quelle cle**.

Une force domine toutes les autres : **une notification de trop detruit la
valeur de toutes les autres**, et sous un transport pauvre elle n'est pas
retractable. Le cout d'un faux positif distant est donc structurellement
asymetrique face au cout d'un faux negatif.

---

## 1. Structure actuelle : inventaire des producteurs

Le classement utile n'est pas par nom d'etat mais par **classe de capteur**.
Un capteur TEXTUEL pourrit en silence a chaque bump du CLI ; un capteur
MECANIQUE (processus, octets, appel d'outil declare) ne le peut pas.

### Producteurs vivants et NON textuels -- on peut construire dessus

| Producteur | Ou | Nature | Etat |
|---|---|---|---|
| `ask_operator` / `ask_operator_wait` | `server.ts` (outil MCP) | PRODUCTEUR autoritaire : l'agent DECLARE qu'il est bloque et fournit le texte | vivant ; ne depend d'aucun motif d'ecran |
| Inbox operateur | broker (ligne sentinelle) -> `pollOperatorInbox` dans `index.ts`, `inbox-store.ts` | PRODUCTEUR (broker) + CONSOMMATEUR (`notifyInbox`, notification OS **non gatee**) | vivant ; drain destructif, duree de vie en cours de conception (cartes 1e81ee7b / 54b1c71a) |
| Brouillons de graphe | `pollGraphDrafts` dans `index.ts` | PRODUCTEUR + notification OS **non gatee** | vivant |
| Sortie de session | `session-service.ts`, `this.emit('exit', { id, exitCode, name })` | PRODUCTEUR mecanique (code de sortie du process) | vivant ; **journalise seulement**, aucune notification aujourd'hui |
| Recence d'octets pty | `session-service.ts`, `outputAt` pose dans `pty.on('data')`, lu par `lastOutputAt(id)` | PRODUCTEUR mecanique | MESURE HONNETE le 2026-08-17 sur CLI 2.1.233 (carte 8691dea3, appendice du debugger) : 0 evenement en 114-180 s au repos, 3 a 20 evenements/s en activite, gap max occupe 1129 ms -> facteur ~150, seuil de 3 s exploitable. Un seuil pourrit VISIBLEMENT (les deux classes se rapprochent), une regex pourrit INVISIBLEMENT. |

### Producteurs textuels -- surface de pourrissement

| Producteur | Ou | Etat mesure |
|---|---|---|
| `AttentionDetector` (bras de LEVEE) | `desktop/src/main/attention.ts`, `WAITING_PATTERNS` | deux motifs : `/❯\s*1\./` (glyphe, plausiblement vivant) et `/\bdo you trust the files\b/i` (**mort par vocabulaire depuis >= 3 versions**, releve carte bbc849f7) |
| `AttentionDetector` (bras d'EXTINCTION) | `attention.ts`, `BUSY_RE = /esc to interrupt\|[⠀-⣿]/i` | **litteral identique a `thinking.ts:BUSY_RE`**, le predicat que les cartes bbc849f7 / 8691dea3 declarent mort en production. L'arme `esc to interrupt` est composee a l'execution par Ink, donc absente du binaire ; l'arme braille n'a jamais ete mesuree independamment (voir U1). |
| `ThinkingDetector` / `r.thinking` | `thinking.ts` | **MORT en effet.** Ne pas construire dessus (consigne explicite du dispatch). Defaut supplementaire : son handler dans `session-service.ts` ne rappelle jamais `broadcast()`, seul handler de detecteur mutant `RuntimeState` a ne pas le faire. |
| `QuotaDetector` / `rateLimited` | `quota.ts` | SUSPECT : motifs jamais confrontes au binaire installe (carte fd1914cc) ; le libelle reste affiche apres reinitialisation (faux positif collant). |

### Affichages / consommateurs -- PAS des producteurs

- **Badge d'attention** : `RuntimeState.needsAttention` (`session-service.ts`),
  rendu par `Sidebar.tsx` et `TerminalTile.tsx`. Affichage + **geste
  d'extinction manuel** (`clearAttention`, cable preload -> ipc -> service).
- **Notification OS d'attention** : `index.ts`, `new Notification(...)`, gatee
  par `config.notifyAttention` (defaut `true`, `store.ts`). **Seule** des trois
  notifications OS a etre gatee ; celles de l'inbox et des brouillons de graphe
  ne le sont pas. MESURE : `grep -n "new Notification(" -r desktop/src/main/`
  -> `index.ts:957`, `index.ts:1003`, `index.ts:1160`.
- **Courrier local** : `pollPendingApprovals` -> canal `approvals:pending` ->
  `InboxPanel.tsx`. Affichage non destructif d'un stock broker existant.
- **Canaux distants** (`notify/registry.ts`, `telegram.ts`, `discord.ts`,
  `ntfy.ts`) : TRANSPORT. Hors de mon perimetre, mesure en parallele.
- **Journal** (`journal.ts`) : puits. Recoit deja `attention`, `session`,
  `quota`, `startup-ack`, `announce`.

### Etat des lieux mesure : les trois notifications OS d'aujourd'hui

C'est le point de depart de qui implementera, et c'est ce qui fonde la these
« les capteurs existent, le decideur manque ».

MESURE : `grep -n "new Notification(" -r desktop/src/main/` rend **exactement
trois** occurrences, toutes dans `desktop/src/main/index.ts`. Reperes par
symbole (jamais par `file:line` : une carte liee a un numero de ligne pourrit).

| # | Symbole englobant | Declencheur | Gatee ? | Cle ? | Extinction ? | Clic |
|---|---|---|---|---|---|---|
| 1 | handler anonyme de `service.on('attention', ...)` | `AttentionEvent{waiting:true}` du `AttentionDetector` | **OUI**, `config.notifyAttention` (defaut `true`, `store.ts`) | aucune : `{title: session.name, body: <fixe>}` | **aucune** : rien n'invalide la notification quand `waiting` repasse a faux | `session:focus` |
| 2 | `notifyInbox(batch)` | lot draine par `pollOperatorInbox` | **NON** | aucune ; regroupement ad hoc par taille de lot, corps tronque a 160 | **aucune** | `inbox:open` |
| 3 | bloc `fresh.length > 0` de `pollGraphDrafts()` | brouillon de graphe inedit, dedoublonne par le `Set` en memoire `notifiedDraftIds` | **NON** | l'`id` du brouillon, **local a la fonction et perdu au redemarrage** | **aucune** | `inbox:open` |

Ce que cette table etablit, et qui est la these du document :

1. **Trois regles differentes pour trois evenements.** Une gatee, deux non.
   Un dedoublonnage (le `Set` de 3), deux sans. Trois faconnages de titre
   distincts. Aucune de ces divergences n'est une decision : ce sont trois
   sites ecrits a trois moments.
2. **Aucune cle commune.** Aucun des trois ne porte `session_ref`,
   `state_kind` ni `episode_id`. Rien ne permet donc de dire que deux
   notifications parlent du meme episode, ni d'en adresser une pour l'eteindre.
3. **Aucune extinction, sur aucun des trois.** Meme le site 1, dont l'evenement
   source porte pourtant deja `waiting:false` : la retombee du drapeau est
   traitee (approbation reclamee, `waitingTiles` nettoye) mais la notification
   deja partie n'est pas concernee. C'est R1 non appliquee, en production.
4. **Le dedoublonnage du site 3 est en memoire et sans borne** : `notifiedDraftIds`
   ne survit pas a un redemarrage du Deck (rejeu possible) et ne se vide jamais
   (croissance sans borne). Symptome typique d'une regle posee au point d'usage
   plutot que dans une couche.
5. **Aucun des trois ne connait le niveau.** Un message d'agent non bloquant
   (site 2) et une session qui reclame une reponse (site 1) produisent la meme
   interruption, avec le meme poids.

Ces cinq points sont ce qu'une couche de decision resout **par construction**,
et qu'aucune retouche des trois sites ne resoudra separement : chaque retouche
locale y ajouterait une quatrieme regle.

### Ce que l'inventaire tranche

Une couche « decider quoi signaler » **n'existe pas**. Ce qui manque n'est aucun
capteur -- ils existent, plusieurs sont mecaniques et sains -- c'est le decideur.

Le pipeline d'approbation, lui, **existe deja et est complet** : `ask_operator`
lit un credential restreint par session, poste sur `/approval/add` avec
`session_ref` + `origin{host, os_user_hash, project_key, from_peer, group_id}`,
le broker route vers les canaux, la premiere reponse gagne et les autres sont
informees. **Toute conception qui reinventerait un canal parallele a cela est
un doublon.** La couche demandee doit ALIMENTER ce pipeline, pas le concurrencer.

---

## 2. La taxonomie

Trois niveaux, definis par **ce que l'operateur peut faire en les recevant**.
Ce critere est retenu contre le critere « gravite » : une notification a
laquelle on ne peut rien repondre depuis le telephone est une interruption
sans issue.

### Niveau A -- BLOQUE : la flotte n'avance pas sans toi

| Etat | Capteur | Traverse la machine ? |
|---|---|---|
| A1. Question bloquante declaree (`ask_operator`) | outil MCP, **declaratif** | **OUI, toujours** |
| A2. Ecran d'attente detecte (chooser, permission, plan) | `AttentionDetector`, **textuel** | **NON par defaut** -- voir l'arbitrage §2.1 |
| A3. Limite d'usage (session bloquee sur quota) | ~~`quota.ts`, textuel~~ -> **OSC 777** pour la levee, **front d'OSC 0** pour l'extinction | **OUI. Reintroduit le 2026-08-19** par decision de l'operateur, carte `f8082208` en `must`, **DECOUPLE de la relance automatique** : afficher qu'une session est bloquee et la relancer sont deux preoccupations distinctes, et rien ne dit qu'un equivalent de la reprise native existe pour les autres CLI. Voir la reserve U6' |

### Niveau B -- PERDU : rien ne viendra plus de cette tuile

| Etat | Capteur | Traverse la machine ? |
|---|---|---|
| B1. Sortie de session avec code != 0, non demandee par l'operateur | `emit('exit')`, **mecanique** | **OUI** |
| B2. Echec d'apparition d'une session lancee par le superviseur | `pendingSpawnAcks` dans `index.ts` | OUI, meme classe |

B est distinct de A parce qu'il n'y a **rien a repondre** : le rendu doit le
dire, et une notification de niveau B ne doit jamais offrir de boutons de
reponse. C'est aussi le seul niveau qui echappe a la regle d'extinction, pour
une raison structurelle : une tuile morte n'emettra plus jamais aucun signal,
donc elle ne peut pas s'auto-annoncer plus tard. Ne pas la signaler la rend
invisible pour toujours.

### Niveau C -- COURRIER : un agent t'adresse quelque chose sans etre bloque

| Etat | Capteur | Traverse la machine ? |
|---|---|---|
| C1. Message d'agent vers le peer `operator` | broker, mecanique | OUI, **groupe**, une notification par fenetre |
| C2. Brouillon de graphe depose | broker, mecanique | OUI, meme groupe que C1 |

### Exclusions, et pourquoi

Les exclusions comptent autant que les inclusions.

1. **Fin de tour / « Stop »** -- EXCLU. AgentPulse le classe deja « au repos »
   et non « termine », et ne notifie pas dessus ; la raison vaut a fortiori
   chez nous. Avec dix tuiles, la fin de tour est l'evenement le plus frequent
   du systeme et ne porte **aucune demande**. Son seul usage legitime est
   « toute la flotte est au repos », qui est **un** evenement pour N sessions,
   pas N evenements. Propose en option §2.2, jamais par defaut.
2. **Usage d'outil (PreToolUse / PostToolUse)** -- EXCLU sans reserve. Chez
   AgentPulse ils ne produisent que l'etat « en cours », jamais de notification.
   Chez nous, la mesure du 2026-08-17 les chiffre a 3-20 evenements/s.
3. **Transitions « thinking »** -- EXCLU. Producteur mort, et meme repare :
   c'est de l'information, pas une demande. L'operateur l'a d'ailleurs
   explicitement qualifie d'informatif lors de l'arret du dossier quota/thinking
   le 2026-08-13.
4. **Limite d'usage AVEC relance automatique** -- EXCLU. Le systeme se repare
   seul ; notifier une panne qui se resout est du bruit pur.
5. **Refus de sandbox** -- EXCLU du canal distant. Conception anterieure
   (cartes 9e529177 / 6e3863ef) : la violation ne peut etre que PREDICTIVE chez
   nous, donc elle n'est pas un fait. Reste au journal.
6. **Sante du broker** -- EXCLU. Deja porte par `StatusBanner`, et c'est une
   panne d'application, pas une demande d'une session. Une notification
   distante « ton broker est tombe » arrive precisement quand le canal qui
   devrait la porter est douteux.
7. **Mouvements de la roadmap** -- EXCLU. Aucune urgence, consultable.
8. **Verdict applique / question deja repondue** -- EXCLU comme alerte. C'est un
   **signal d'extinction**, pas un evenement (§3).

### 2.1 Arbitrage central : A2 franchit-il la frontiere de la machine ?

- **Option A -- A2 notifie a distance comme A1.** Couverture maximale : les CLI
  non-Claude et les questions posees a l'ecran sans passer par `ask_operator`
  sont couverts. Cout : le capteur est textuel, son bras « trust » est deja
  mort, son bras d'extinction partage le predicat que ce depot a mesure mort.
  Un faux positif part sur le telephone et, sous transport pauvre, **ne peut
  pas etre retire**. Risque eleve, reversibilite faible (on ne desapprend pas
  la mefiance).
- **Option B -- A2 reste LOCAL : badge de tuile, jamais de canal distant.**
  Seul A1, declaratif, franchit la machine. Cout : un agent bloque a l'ecran
  sans avoir appele `ask_operator` ne joint pas un operateur absent. Ce cout
  est **borne et deja le comportement d'aujourd'hui pour tout ce qui n'est pas
  une approbation** ; il est en outre reductible par une consigne agent
  (« appelle `ask_operator` plutot que de t'arreter sur une question »), qui est
  precisement ce que la description de l'outil dit deja mot pour mot.

**Recommandation : Option B.** Force decisive : l'asymetrie de retractabilite.
Un faux badge local coute un coup d'oeil et s'efface d'un clic
(`clearAttention` existe et est cable) ; un faux message sur le telephone est
definitif sous transport pauvre et taxe toutes les notifications suivantes.
La regle generale a inscrire : **seul un capteur DECLARATIF ou MECANIQUE
franchit la frontiere de la machine ; un capteur textuel ne pilote que de
l'affichage local.**

#### Consequence mecanique, tranchee le 2026-08-19

Le producteur de repli de `index.ts` -- l'appel `addApproval` pose dans le
handler de `service.on('attention', ...)`, sous le commentaire « Fallback
producer: sessions no hook covers » -- **perd son droit d'emettre une
approbation distante**.

Ce n'est ni une preference ni un effet de bord : c'est la regle appliquee a son
propre cas. `attention` est leve par un capteur TEXTUEL, donc il ne franchit pas
la frontiere de la machine. Accepter la regle et refuser cette consequence
rendrait la regle ornementale. **Accorde par le team-lead sur ce motif exact.**

Ce que ce producteur conserve : lever `needsAttention`, donc le badge de tuile
et le journal. Ce qu'il perd : `addApproval`, donc le telephone.

Variante admissible si la couverture des CLI non-Claude devait etre retablie
plus tard : conserver l'emission **derriere une temporisation de sejour** (§5,
regime pauvre), jamais en emission immediate. Le sejour ne rend pas le capteur
declaratif ; il borne seulement le cout d'un faux positif non retractable.

Point de vigilance pour l'implementation, pas pour la conception : le meme
handler tient `openApprovals` et s'en sert pour reclamer l'approbation quand le
drapeau retombe (`claimApproval` avec `answerKind: 'allow'`). Retirer l'emission
sans retirer cette comptabilite laisserait une table qui ne se remplit plus et
un chemin de reclamation qui ne s'execute plus. Les deux moities partent
ensemble ou pas du tout.

### 2.2 Option explicite, desactivee par defaut : « flotte au repos »

Un unique evenement de niveau C : la derniere tuile occupee est passee au
repos, mesure sur la recence d'octets (mecanique), avec un seuil de 3 s.
Un evenement pour N sessions. Eteint des qu'une tuile redevient occupee.
Non recommande pour la v1 : sa valeur depend entierement de U4.

---

## 3. La regle d'extinction

C'est la partie la plus importante et c'est la ou ce depot a deja paye.

### La regle

> **Tout etat notifiable a un proprietaire de remise a zero nomme, et ce
> proprietaire est d'une classe de capteur au moins aussi robuste que celui qui
> l'a leve. Un etat leve par un signal mecanique ne peut pas etre eteint par un
> signal textuel. Un etat leve par un signal textuel DOIT posseder en plus un
> extincteur non textuel.**

Corollaire, contre-intuitif et volontaire : **un delai d'expiration n'est PAS
un extincteur.** Eteindre par TTL efface un operateur qui attend reellement.
Un etat non eteint au-dela d'un seuil doit devenir **VISIBLE COMME SUSPECT**
(surface de sante), jamais efface. C'est le motif « garde fail-visible » deja
valide sur la carte bbc849f7.

### Trois couches, par etat

- **E1 SPECIFIQUE** -- le signal naturel de la fin de l'episode.
- **E2 MECANIQUE** -- repli qui ne depend d'aucun texte du CLI.
- **E3 OPERATEUR** -- geste manuel, dernier recours toujours disponible.

| Etat | E1 | E2 | E3 | Si aucun signal n'arrive jamais |
|---|---|---|---|---|
| A1 `ask_operator` | le broker marque `answered` (premiere reponse gagne, deja implemente) | sortie / suppression de la session (`emit('exit')`, `emit('removed')`) | rejet dans le Courrier | **reste ouvert, et c'est CORRECT** : l'agent est reellement bloque. Seul etat ou l'absence d'extinction n'est pas un defaut. |
| A2 badge local | `stillWaiting(st.buf)` devient faux | **manquant aujourd'hui** -- a ajouter : la session redevient occupee (recence d'octets) ou sort | `clearAttention` (cable) | AUJOURD'HUI : colle jusqu'a ce que ~4050 octets fassent glisser la fenetre `MAX_BUF`, ou jusqu'au geste manuel. **C'est exactement le defaut que le dispatch nomme.** |
| A3 quota (revu 2026-08-19) | ~~`quota-clear` textuel~~ : plus d'E1 propre, et c'est assume | **front d'OSC 0** : la session reemet, donc elle n'est plus bloquee. **Ne depend PAS de la relance automatique**, conformement au decouplage demande | dismiss | l'episode reste leve et devient VISIBLE COMME SUSPECT (R2). Le badge collant d'avant venait de ce que l'extinction etait textuelle ET unique |
| B1/B2 sortie | -- | -- | fermeture/relance de la tuile par l'operateur | etat ABSORBANT : pas d'extinction requise, mais garde de **non-repetition** obligatoire (un exit, une notification) |
| C1 courrier | l'operateur ouvre le Courrier | -- | marquer lu | ne doit PAS dependre du drain destructif ; voir cartes 1e81ee7b / 54b1c71a |

### Le defaut structurel mesure aujourd'hui

Pour A2, **E1 ET E2 sont tous les deux textuels** : `stillWaiting` utilise
`WAITING_PATTERNS`, `BUSY_RE` est le predicat mort. Seul E3, manuel, est sur.
Un commentaire de `attention.ts` annonce quatre extincteurs (A busy cue,
B `purgeScreenMemory`, C dismiss manuel, D glissement de fenetre) -- trois des
quatre dependent du vocabulaire du CLI. C'est la forme exacte de « s'allume et
ne s'eteint jamais » que le dispatch cite.

**Correctif de conception, minimal** : brancher la recence d'octets comme E2 de
A2 et A3. Le signal existe deja (`outputAt` pose dans `pty.on('data')` avant
tout `stripAnsi`), il est mecanique, il a ete mesure honnete, et il est LOCAL
des deux cotes (`waitIdle` a un seul appelant, le filtre `agents:stop-state`
un seul point de lecture -- mesure inscrite sur la carte 8691dea3). Ce n'est pas
une reouverture du dossier quota/thinking : on ne repare aucun predicat textuel,
on ajoute un extincteur d'une autre classe a cote.

**Surface de sante, obligatoire.** Un compteur par etat : nombre d'episodes
ouverts depuis plus de N minutes sans extinction, visible dans le journal. Ce
n'est pas du confort : c'est le seul mecanisme qui rendra VISIBLE la prochaine
mort silencieuse d'un capteur. La regle CLAUDE.md sur la couverture s'applique
ici a la lettre -- la sensibilite (« ca s'allume bien ») se teste toute seule,
la couverture de l'extinction, non.

---

## 4. L'identite

### Faits mesures qui ferment les raccourcis

- **`operator_id` ne distingue pas deux Decks.** `operator-identity.ts` le COPIE
  deliberement d'un poste a l'autre (`exportEnrolment` / `applyEnrolment`,
  en-tete : « un operateur est une personne, pas un appareil »).
- **`hostname()` ne distingue pas deux identites.** Deux comptes OS partagent le
  nom de machine ; precedent deja livre, inscrit dans CLAUDE.md.
- **Le broker ne connait aucun Deck.** `grep -c "deck_id\|deck_session" broker.ts`
  -> `0` (mesure du 2026-08-17).
- **Deux fenetres Deck sur un meme compte OS sont un cas NOMINAL** :
  `requestSingleInstanceLock` est absent du main.
- **Le pipeline d'approbation porte deja la bonne cle** : `session_ref` +
  `origin{host, os_user_hash, project_key, from_peer, group_id}`
  (`server.ts`, handler `ask_operator`).

### Cle proposee

Une notification est identifiee par le triplet
**`(session_ref, state_kind, episode_id)`**,
route vers **`operator_id`**, et qualifiee par **`(host, os_user_hash, project_key)`**.

- `operator_id` = **destinataire**, jamais cle de dedoublonnage.
- `session_ref` = **une execution de pty**, pas une tuile. Contrainte a
  respecter par qui le minte : une tuile relancee doit obtenir un NOUVEAU
  `session_ref`, sinon un episode deja eteint ressuscite au redemarrage.
- `state_kind` = une classe de la taxonomie (A1, A2, B1, C1...).
- `episode_id` = compteur monotone par `(session_ref, state_kind)`, incremente
  a chaque levee. C'est lui qui rend une extinction **adressable** : eteindre,
  c'est adresser le meme triplet.

### « Et quand il y en a deux ? »

| Deuxieme quoi | Ce qui se passe | Verdict |
|---|---|---|
| Deux Decks, meme personne, deux PC | `operator_id` identique -> les deux flux arrivent au meme telephone ; `session_ref` differe -> aucune collision de dedup | **Voulu.** Une personne, une boite. A ecrire comme decision, pas subir comme accident. Le rendu doit alors porter `host`, sinon l'operateur ne sait pas quelle machine parle. |
| Deux comptes OS sur un PC | `os_user_hash` differe -> deux identites par construction | Deja le modele du depot. Ne jamais retomber sur `hostname()` seul. |
| Deux fenetres Deck, meme compte | Chacune tient ses propres pty -> `session_ref` disjoints | Correct sans travail supplementaire, **a condition** que `session_ref` soit minte par spawn et non derive du nom de tuile. |
| Deux personnes, broker partage | `operator_id` differe -> routage separe ; le cloisonnement par `project_key` existe deja sur `/approval/list` (commit 93ecdfc) | Couvert. Reutiliser ce cloisonnement, ne pas en inventer un second. |
| Deux notifications pour le meme episode | Meme triplet -> la seconde **remplace**, jamais n'ajoute | Regle du modele. |

### Rejets explicites

`hostname()` seul, l'index ou le nom de tuile (renommable), `operator_id` seul,
et tout identifiant persiste dans l'etat applicatif du Deck (mesure : ne
distingue pas deux fenetres).

---

## 5. La degradation : transport pauvre vs riche

Frontiere a poser : **le DECIDEUR emet un evenement normalise ; le transport
choisit seulement ce qu'il sait en porter. Aucun adaptateur de transport ne
decide de rien.**

```
NotifyEvent {
  key:  { session_ref, state_kind, episode_id }
  route:{ operator_id }
  meta: { host, os_user_hash, project_key, session_name }
  tier: 'A' | 'B' | 'C'
  title, body, raisedAt
  answerable: boolean          // faux pour tout le niveau B
  extinguish: { on: 'answered' | 'busy-again' | 'exit' | 'manual' }
}
```

### Regime RICHE (session, outil, decision de permission dans le payload)

Tout le modele s'applique tel quel : dedup exact sur le triplet, extinction
adressable (retrait ou marquage « deja traite »), reponse depuis la
notification, `host` affiche pour desambiguer deux PC.

### Regime PAUVRE (un titre, un corps, aucun identifiant de session)

Le modele **ne change pas** ; seul le rendu degrade. Quatre regles :

1. **Le titre porte la cle.** Format contractuel, pas cosmetique :
   `<nom de session> -- <etat>` (et `<host>/<nom de session>` des que deux hotes
   sont enroles). C'est ce qui donne un regroupement par session sur les
   transports qui empilent par titre.
2. **Pas d'extinction possible -> pas d'emission d'un etat dont l'extinction
   est probable.** En regime pauvre, seuls A1, B1/B2 et C1/C2 sortent. A2 et A3
   ne sortent pas -- ce qui, avec l'arbitrage §2.1, est deja le defaut.
3. **Temporisation de sejour, pas fenetre de coalescence.** Si l'operateur
   exige malgre tout qu'un etat heuristique sorte en regime pauvre, il ne sort
   qu'apres N secondes ininterrompues (ordre de grandeur : 20 s), pour qu'un
   scintillement auto-resolu n'atteigne jamais le telephone. A distinguer
   explicitement d'une coalescence : AgentPulse n'en a deliberement aucune, et
   nous n'en introduisons pas non plus. Le sejour filtre un faux positif ; une
   coalescence retarde un vrai positif.
4. **Le niveau C se groupe.** Une notification par fenetre, compte dans le
   titre. C'est deja ce que fait `notifyInbox`.

### Ce qu'on perd et qu'on accepte en regime pauvre

Pas de marquage « deja traite », pas de reponse depuis la notification, pas
d'ordre garanti entre deux etats du meme episode. Aucun de ces trois n'est
requis pour la valeur centrale (« laquelle de mes dix tuiles me reclame quelque
chose »).

---

## Recommandation d'ensemble

**Ou vit le decideur ?**

- **Option A -- dans le main du Deck**, un service unique abonne aux producteurs
  existants (`session-service` events, sondage des approbations, sondage de
  l'inbox) qui emet `NotifyEvent`. Cout faible, entierement reversible, aucune
  modification du broker. Limite : ne decide rien quand le Deck est ferme.
- **Option B -- au broker**, le Deck ne remontant que de l'etat brut. Uniformise
  telephone et Deck. Cout : le broker n'a **aucune** notion de Deck ni de tuile
  (mesure), il faudrait l'en doter ; cela rouvre le probleme d'identite que la
  conception du Courrier a deja tranche.

**Recommandation : Option A**, avec le meme partage que la conception du
Courrier du 2026-08-17 : **le Deck DECIDE et DECLARE, le broker STOCKE et
EFFECTUE**. Force decisive : les etats a signaler qui ne sont pas deja connus
du broker (sortie de process, attente a l'ecran, flotte au repos) ne sont
observables que la ou vit le pty. La limite « Deck ferme » n'en est pas une
pour A1, deja porte de bout en bout par le broker.

Rien de tout cela n'exige un transport particulier. Le choix hooks / OSC ne
change aucune ligne de ce document ; il change seulement **quel regime de §5
s'applique** et **si U1/U2 restent des inconnues** (un capteur par hook les
rendrait sans objet, en substituant du declaratif a du textuel -- ce serait la
meilleure raison de le retenir, plus que sa richesse de payload).

---

## Alternatives ecartees

1. **Copier la machine a etats d'AgentPulse (5 hooks -> 4 etats, un seul
   notifiant).** Ecartee : elle reconstruit par hooks ce que Kory possede deja
   (le process, l'exit, l'outil declaratif). Ce qui est repris d'elle, en
   revanche : « Stop = au repos, pas termine », l'absence de coalescence, et un
   seul etat notifiant par defaut. Le SPEC.md d'AgentPulse diverge de son propre
   code sur trois points -- je n'ai pris que ce que le dispatch rapporte du code.
2. **Un etat « termine » notifiant.** Ecartee : voir exclusion 1. C'est la
   demande la plus spontanee et la plus destructrice de valeur.
3. **Extinction par TTL.** Ecartee : efface un operateur qui attend reellement.
   Remplacee par la surface de sante « episode ouvert depuis trop longtemps ».
4. **Reparer `BUSY_RE` pour rendre l'extinction de A2 fiable.** Ecartee :
   remplace un capteur textuel par un capteur textuel, donc remourra en silence,
   et rouvre un dossier que l'operateur a arrete le 2026-08-13. On ajoute un
   extincteur mecanique A COTE, on ne repare pas le textuel.
5. **Un niveau de severite par notification (info/warn/crit).** Ecartee au
   profit des trois niveaux definis par l'action possible : la severite se
   discute a l'infini, « qu'est-ce que je peux faire en la recevant » se tranche.
6. **Une file de notifications persistee cote Deck.** Ecartee comme prematuree :
   les stocks existent deja (`pending_approvals` cote broker, `inbox-store` cote
   Deck). En ajouter un troisieme reintroduit le probleme de duree de vie que
   les cartes 1e81ee7b / 54b1c71a sont en train de trancher.

---

## Inconnues a mesurer (nommees, pas supposees)

| # | Inconnue | Ce qu'elle decide | Qui peut la mesurer |
|---|---|---|---|
| U1 | ~~L'arme braille de `BUSY_RE` matche-t-elle encore ?~~ **RETIREE le 2026-08-19.** Le capteur d'activite se REMPLACE au lieu de se reparer (§6), ce qui est litteralement R1. Reparer `BUSY_RE` reintroduirait un capteur textuel a la place d'un capteur textuel. | -- | close |
| U1' | ~~Les trois chiffres du remplacement~~ **FERMEE le 2026-08-19** par M1a/M1b/M2/M3 (§6.6). Residu declare non bloquant : un seul profil de charge echantillonne cote occupe. | -- | close |
| U2 | ~~Le CLI rend-il encore ses choosers avec `❯ 1.` ?~~ **RETIREE le 2026-08-19** par la mesure du corps du payload (§6.4) : le bras de levee se remplace au lieu de se reparer. | -- | close |
| U2' | COUVERTURE du jeu de corps. **Partiellement fermee par M6** : 21 kinds / 11 corps, l'approbation de plan a le sien. Restent le menu `AskUserQuestion` (suppose, non declenchable) et la fin de tache longue (ni preuve d'existence ni d'absence). | Le grain de classification atteignable. Non bloquant : la table est d'enrichissement (§6.4), un corps inconnu leve un generique. | debugger |
| U3' | ~~Combien d'OSC 0 pendant l'ecran de confiance ?~~ **FERMEE le 2026-08-19** : `OSC0_COUNT 1` sur 130 622 ms. La forme retenue est « pas de tic soutenu depuis le spawn », jamais `count === 0` (§6.7). | -- | close |
| U4' | ~~Le bras `/❯\s*1\./` attrape-t-il l'ecran de confiance ?~~ **N'a jamais bloque la conception** ; couvert par la carte de balayage `2429ba4b`. | -- | delegue |
| U5' | ~~L'appairage doit-il mourir avec le Deck ?~~ **FERMEE le 2026-08-19 par l'operateur : OUI.** Option B retenue (§7.10). Mon prix en O(N) etait juste, son assiette etait fausse : N est le sous-ensemble CHOISI, et le geste est un acte de selection. | -- | close |
| U3 | Cout d'exposer `outputAt` par session hors du chemin chaud. Mesure connue : il existe, il est interne, `lastOutputAt(id)` a un seul consommateur (watcher de verrou, seuil 2 h). | Le cout reel de l'extincteur mecanique E2. | developpeur |
| U4 | Frequence reelle des fins de tour par tuile chez l'operateur. | Si l'option « flotte au repos » (§2.2) vaut 1/heure ou 50/heure. | operateur / telemetrie journal |
| U5 | Les canaux distants savent-ils RETIRER ou EDITER un message deja delivre (Telegram edit, Discord edit, ntfy) ? | Si « deja traite » est reel ou cosmetique, donc quel etat a le droit de sortir en regime pauvre. | **l'agent transport, pas moi** |
| U6 | ~~Le predicat de quota (`quota.ts`) tire-t-il encore ?~~ **SANS OBJET** : A3 est reintroduite sur les nouveaux capteurs (carte `f8082208`), on ne repare pas `quota.ts`, on le remplace. R1. | -- | close |
| U6' | **Quel corps OSC 777 porte la limite d'usage ?** M6 a lu 11 corps dans le binaire ; `Session paused` est le candidat plausible, mais c'est un **litteral lu dans le binaire, non mesure sur le fil**. | Si A3 a une levee mecanique, ou si elle retombe faute de corps identifie. **Bloquant pour `f8082208`, pas pour ce document.** | debugger. Et rappel : la table est d'ENRICHISSEMENT (§6.4), donc meme sans identifier le corps, la limite d'usage leve un niveau A generique -- elle n'est jamais silencieuse |

**U1' et U2 sont bloquantes pour toute implementation.** U2 decide si le niveau
A2 a un bras de LEVEE du tout ; U1' decide du capteur d'activite. U5 est
**mesuree en partie** (§6) et son residu est nomme en §6.4.

**Routage, 2026-08-19 (team-lead).** U5 est partie chez l'agent transport et a
rendu (§6). U1' et U2 sont chez le diagnostiqueur qui garde le harnais pty
chaud. Elles restent **declarees ici comme inconnues** jusqu'a ce que la mesure
revienne : un routage n'est pas une reponse.

**Ce qui retirerait U2, et ce qui ne le fera pas.** Une frequence d'emission ne
dira jamais qu'un agent ATTEND UN CHOIX plutot qu'il est simplement au repos :
l'activite et l'attente sont deux etats distincts et le capteur d'activite est
muet sur le second. Seul le CORPS du payload de notification pourrait retirer
U2, s'il distingue « permission requise » de « en attente d'entree ». C'est
l'item ouvert de §6.4, et il n'est pas mesure.

---

## 6. Contraintes venues du transport (mesure du 2026-08-19)

Le transport a ete mesure par un autre agent. Ce document reste
transport-agnostique : ce qui suit n'est retenu que dans la mesure ou cela
change une CONTRAINTE de conception.

### 6.1 Ce qui est acquis

Le canal de notification du CLI est lisible de bout en bout : ConPTY transmet
les sequences OSC verbatim, le CLI les emet, et le chemin de lecture de Kory ne
les detruit pas (les `stripAnsi` des detecteurs sont CSI-only, `\x1b\[`, donc
une OSC `\x1b]` n'est jamais touchee).

Propriete qui compte pour R1 : dans les captures, **les OSC sortent AVANT le
texte qui les entoure, en court-circuitant le tampon d'ecran**. Elles ne sont
donc pas sujettes au repaint partiel qui avait fait mentir `esc to interrupt`.
C'est ce qui les qualifie comme capteur **mecanique** et non textuel au sens du
classement de §1.

Payload reel : un titre et un corps, **aucun identifiant de session**. La
correlation vient du pty sur lequel les octets arrivent, que Kory possede deja.
**C'est exactement le regime PAUVRE de §5, et il est confirme comme le regime
nominal**, pas comme un cas degrade hypothetique.

### 6.2 Contrainte : UN SEUL predicat d'activite

Un second signal a ete mesure : le CLI reecrit en continu le titre du terminal
(OSC 0), sans reglage a forcer. Distinction a tenir fermement, et elle est de
la meme famille que R1 : **le CANAL est declaratif, le GLYPHE est textuel.**
Ne rien fonder sur l'identite du glyphe, qui changera comme
`esc to interrupt` ; fonder le predicat sur la **frequence d'emission**.

Trois chiffres manquent avant de pouvoir l'ecrire comme MESURE, et ils sont
commandes :

- **M1, le cote REPOS.** La mesure rapportee est celle du cote occupe. Le
  predicat repose sur l'autre moitie, affirmee et non chiffree. La sonde de
  recence d'octets n'est devenue credible qu'en fermant explicitement ce cote
  (0 evenement a 114 s ET a 180 s apres un vrai tour). Inclut une passe ou le
  FOCUS change, pour savoir si le focus seul repeint le titre.
- **M2, le GAP MAXIMAL** entre deux emissions pendant un outil long et
  silencieux. C'est le cas qui avait fait croire que la recence d'octets
  vieillissait, et son pire gap mesure (1129 ms) est le point de comparaison.
  Le regime nominal annonce (300 a 700 ms) laisse une marge bien plus etroite
  que le facteur ~150 de la recence d'octets.
- **M3, l'echo de frappe.** La recence d'octets classe « operateur en train de
  taper » comme occupe. Si OSC 0 ne s'y allume pas, c'est le gain reel.

**Contrainte de conception, independante du resultat : on n'en construit
QU'UN.** Soit M3 montre qu'OSC 0 remplace la recence d'octets, et il la
remplace vraiment ; soit il ne vaut pas mieux et on garde l'existant. Pas de
coexistence : deux predicats d'activite concurrents dans ce fichier sont la
divergence que ce depot paie en boucle -- c'est deja litteralement l'histoire
de `BUSY_RE` duplique en trois exemplaires.

**A inscrire meme si M3 est favorable :** le titre du terminal est une
**ressource partagee**. N'importe quel process de ce pty peut l'ecrire (shell,
pager, mode bash `!`, outil imbrique), et la carte 8691dea3 a recense **sept
ecrivains non coordonnes** sur ce meme pty. Le canal est declaratif sur
« quelqu'un a peint un titre », **jamais** sur « l'agent travaille ». Ne pas le
presenter comme plus autoritaire qu'il n'est.

### 6.3 Contrainte : forcer un reglage au lancement est une frontiere de confiance

La valeur par defaut du canal de notification n'emet rien sous Windows : Kory
doit forcer le reglage via `--settings` au lancement. **Ce n'est pas un drapeau
de confort.** Deux implications a traiter comme telles :

1. C'est un **argument de ligne de commande construit cote Deck**, donc
   l'entree hostile n°4 de CLAUDE.md (validation/encodage a la frontiere,
   jamais de collage de chaines). Il traverse `launch-config.ts`.
2. Il **croise la projection de settings du sandbox**
   (`sandbox-projection.ts` strippe les hooks host-only et genere un overlay).
   Un reglage injecte au lancement et un settings projete dans le conteneur
   sont deux ecrivains du meme objet : decider lequel gagne AVANT de cabler,
   pas apres.

Contrainte de robustesse, mineure mais reelle : la notification arrive seule
dans son chunk dans les captures, **et rien ne le garantit**. Bufferiser depuis
`\x1b]` jusqu'au terminateur ; ne jamais tester le chunk brut.

### 6.4 Le payload distingue les etats. Ce que cela retire, et ce que cela ne
retire pas

MESURE du 2026-08-19, octets bruts sur pty vivant, avec controle negatif
(`PERMISSION_PROMPT_SEEN true` + rendu ecran horodate montrant la boite
« Do you want to proceed? »), chaine prouvee vivante pendant la fenetre :

- invite de permission : `]777;notify;Claude Code;Claude needs your permission`
- attente d'entree : `]777;notify;Claude Code;Claude is waiting for your input`

Meme titre, **corps different**, toujours aucun identifiant de session.

**Ce que cela retire :** U2. Le bras de LEVEE de A2 n'a plus besoin de
`❯ 1.`. Le CANAL etant mecanique (§6.1), lever « quelque chose te reclame » est
desormais une operation de classe mecanique. C'est un vrai gain de classe, et
c'est encore R1 : on remplace le capteur au lieu de le reparer.

**Ce que cela ne retire PAS, et qu'il ne faut pas laisser passer en contrebande :
le corps est un capteur TEXTUEL.** « Claude needs your permission » est une
phrase, reformulable a la prochaine version exactement comme
`esc to interrupt`. La distinction que le team-lead a posee pour le glyphe vaut
mot pour mot ici : **le canal est declaratif, le corps est textuel.** Donc :

- **LEVER** un evenement de niveau A est mecanique. Fiable.
- **CLASSER** cet evenement dans un sous-type est textuel. Perissable.

**Regle de conception qui en decoule, et c'est la regle de couverture de
CLAUDE.md appliquee telle quelle : la table des corps doit etre une table
d'ENRICHISSEMENT, jamais une liste d'admission.** Un corps inconnu leve un
niveau A **generique**, il n'est jamais ignore. Une liste d'admission
degraderait en SILENCE a la prochaine reformulation (fail-open, le mode que ce
depot paie) ; une table d'enrichissement degrade en « on te previent mais on ne
sait pas de quoi il s'agit », qui est visible le jour meme.

**Residus de couverture, nommes et non mesures.** La sensibilite est prouvee sur
deux corps ; la COUVERTURE du domaine ne l'est pas.

- `❯ 1.` couvrait **trois** ecrans selon le commentaire de `attention.ts` :
  permission d'outil, approbation de plan, menu `AskUserQuestion`. Deux corps
  sont mesures. On ignore si « waiting for your input » couvre les deux autres
  ou si un troisieme corps existe.
- Le troisieme evenement (**fin de tache longue**) n'a pas pu etre mesure : le
  run a echoue, la tache s'etant terminee en 23 s. Aucune mesure ne dit qu'un
  corps existe, ni qu'il n'existe pas.
- **Rien ne dit ce qui est emis quand l'etat SE TERMINE.** Si le CLI n'emet rien
  a la retombee, l'episode leve par OSC n'a **aucun E1** : il ne lui reste que
  E2 mecanique et E3 manuel. Cela ne casse pas le modele -- c'est exactement le
  cas que R1 prevoit -- mais cela rend l'extincteur mecanique **obligatoire et
  non optionnel**.

### 6.5 Le CLI temporise deja, avec deux horloges. Trois consequences

MESURE, datation de chaque OSC a son evenement pty : permission a **+6001 ms**,
attente d'entree a **+60001 ms** (mesuree deux fois, sur deux runs distincts).
La notification n'est pas emise a l'instant de l'evenement.

1. **Le sejour du regime pauvre (§5, regle 3) ne doit PAS etre construit.** Il
   existe deja, en amont. En ajouter un empilerait 20 s sur 60 s. **Cette regle
   de §5 est donc retiree pour le transport OSC** et ne vaut que pour un
   transport qui n'aurait pas sa propre temporisation.
2. **Une minute de latence rend le split local/distant PLUS necessaire, pas
   moins.** Une attente d'entree signalee 60 s apres coup est acceptable pour un
   operateur absent et mauvaise pour un operateur assis devant l'ecran. Donc :
   **badge local depuis le capteur rapide, notification distante depuis le
   capteur lent mais mecanique.** C'est la meme frontiere que §2.1, atteinte par
   un autre chemin -- et deux raisonnements independants qui convergent sur la
   meme frontiere sont la meilleure preuve qu'elle est au bon endroit.
3. **Un cablage qui suppose l'immediatete se trompera de six secondes**, et de
   soixante dans l'autre cas. Toute correlation « cet OSC correspond a cet etat
   de la tuile » doit tolerer un decalage de cet ordre : correler sur le pty
   d'arrivee, jamais sur la simultaneite.

**Hierarchisation.** L'ecart 6 s / 60 s corrobore que « permission » est plus
urgent que « attente d'entree », ce qui va dans le sens de la taxonomie. **Ne
rien fonder dessus** : ce sont deux constantes d'un produit tiers, et elles
mesurent vraisemblablement « au bout de combien de temps supposer que tu es
parti », pas une valeur. Corroboration, pas fondation.

**Glyphe.** MESURE : pendant l'invite de permission affichee, le titre portait
le **meme glyphe qu'au repos**. Le glyphe ne signifie donc pas « au repos », il
signifie « ne streame pas en ce moment », et il couvre l'etat bloque-sur-invite.
Cela **renforce** §6.2 : le glyphe est encore moins informatif qu'estime, et
seule la FREQUENCE (M1/M2/M3) reste un objet de mesure legitime.

### 6.6 M1 a M4 : les chiffres, et le resultat central de tout le dossier

MESURES du 2026-08-19, capture continue, compteurs comparables entre eux, la
sonde comptant les EMISSIONS et ne lisant jamais le glyphe.

| # | Fenetre | Emissions OSC 0 | Controle negatif dans la fenetre |
|---|---|---|---|
| M1a | repos apres un vrai tour, 190 009 ms | **0** | 58 octets a t=111163 (la notification d'attente) : la chaine delivrait |
| M1b | repos + focusIn/focusOut + 2 redimensionnements, 45 016 ms | **0** | **12 078 octets** de repeinture : les gestes ont bien eu un effet |
| M2 | outil long et silencieux (`Running... 39s`) | gap max **1025 ms**, median 961, 10 pires entre 966 et 1025 | etat vise prouve au rendu ecran |
| M3 | frappe non soumise, 20 759 ms, 41 caracteres tapes puis effaces | **0** | **731 octets sur 51 evenements** (l'echo) : des octets circulaient |
| M4 | apres la reponse a l'invite | **6 mises a jour de titre**, et 0 OSC de notification | notification suivante a t=114368 : la sonde recevait toujours cette classe |
| M4' | pendant que l'invite etait AFFICHEE, 9 460 ms | **0** | -- |

#### Le resultat central

**OSC 0 (frequence) et OSC 777 (notification) sont deux capteurs qui repondent
a deux questions differentes, et aucun ne peut faire le travail de l'autre.**

- **OSC 0 en frequence** separe `occupe` de `pas occupe`. Il est **aveugle** a
  « quelque chose te reclame » : M4' mesure 0 emission pendant une invite
  affichee, exactement comme le repos. En nombre d'emissions, bloque-sur-invite
  et repos sont **indistinguables**.
- **OSC 777** dit « quelque chose te reclame », avec un corps qui precise quoi.
  Il est aveugle a l'activite.

Ils sont donc **complementaires, jamais redondants**, et cela ferme le modele :

> **La LEVEE d'un niveau A vient d'OSC 777, et de lui seul.
> L'EXTINCTION mecanique (E2) vient de la frequence d'OSC 0, et d'elle seule.
> La seule partie textuelle qui subsiste est la SOUS-CLASSIFICATION par le
> corps, qui est de l'enrichissement (§6.4) et ne conditionne rien.**

R1 est alors satisfaite sans compromis : levee mecanique, extinction mecanique,
et la couche perissable ne porte aucune decision. C'est la premiere fois dans ce
document que les deux moities d'un etat ont un capteur de la meme classe.

Verdict sur le point (d) du team-lead : sa lecture est **confirmee**. Le fait que
bloque-sur-invite et repos emettent tous deux zero ne contredit pas la
separation lever/classer, il la **demontre**.

#### E2 n'est plus hypothetique : M4 la mesure en train de tirer

M4 releve **6 mises a jour de titre apres la reponse a l'invite**. C'est
exactement l'evenement dont E2 a besoin. L'extincteur mecanique du cas
« permission repondue » est donc **observe**, pas suppose.

Detail de conception que ce chiffre impose : **E2 doit etre declenchee sur
FRONT** (« une emission OSC 0 est arrivee depuis que l'episode est leve »), et
**non sur NIVEAU** (« la tuile est actuellement occupee »). Une salve de six
emissions suivie de silence satisfait le front et **echoue** au niveau. Une E2
a niveau raterait donc precisement le cas mesure.

#### Le seuil (point (b) du team-lead)

Le rapport 1025 ms / 190 009 ms donne un facteur ~185, comparable au facteur
~150 qui avait rendu la recence d'octets exploitable. **Seuil retenu : 3 s**,
soit 2,9x au-dessus du pire gap occupe mesure -- et **la meme constante que
celle deja retenue pour la recence d'octets**, deliberement : deux constantes
d'oisivete differentes dans le meme fichier sont une divergence en attente.

Residu nomme, qui ne bloque pas : le cote occupe n'est echantillonne que sur
**un** profil de charge (outil long et silencieux). La campagne de recence
d'octets en couvrait **deux** (bash silencieux ET attente d'inference sans
streaming), et les cadences annoncees different selon le contexte (300 a 700 ms
en tour nominal, 961 a 1025 ms ici), donc la dispersion est reelle. Ce residu ne
bloque pas parce que son mode de panne est **VISIBLE** : si un profil non
echantillonne depasse 3 s, la tuile clignote vers « au repos » en plein travail,
ce qui se voit le jour meme. C'est la propriete des taux, opposee a celle des
regex.

#### Le point (a), et la raison pour laquelle je ne le confirme qu'a moitie

M3 est concluante sur le fait mesure : **la frappe fait circuler 731 octets sans
produire une seule emission OSC 0.** OSC 0 n'a donc pas l'artefact d'echo de la
recence d'octets. **Confirme.**

**Ce que j'infirme, c'est la conclusion « donc OSC 0 la remplace ».** Les deux
predicats ne repondent pas a la meme question :

- OSC 0 repond « **l'agent produit-il ?** »
- la recence d'octets repond « **ce pty est-il silencieux ?** »

Sur un pty a **sept ecrivains non coordonnes** (recense sur la carte 8691dea3),
ce sont deux questions distinctes, et l'artefact d'echo est la **bonne** reponse
a la seconde. La note du 2026-08-17 le disait deja : classer « operateur en
train de taper » comme occupe est « souhaitable pour une injection ».

DEDUIT, et c'est un avertissement pour plus tard, pas une regression
d'aujourd'hui : `waitIdle` (qui garde l'injection de directives et le soft stop)
lit `r.thinking`, donc il est **deja** ouvert en permanence -- rien ne se degrade
en changeant de capteur. Mais la carte 8691dea3 envisage explicitement de le
recabler sur un signal mecanique. **S'il est recable sur OSC 0, le gate laissera
injecter pendant que l'operateur tape**, puisque OSC 0 est muet a ce
moment-la. Direction de degradation : OUVERTE. C'est la forme que ce depot paie
le plus cher, et c'est exactement le piege des « consommateurs non affichants »
d'un predicat.

**Resolution, sans elargir le perimetre.** La contrainte « on n'en construit
qu'un » reste valide, mais elle s'applique **par question**, pas globalement :

1. **Un seul predicat d'ACTIVITE** : la frequence d'OSC 0. Il remplace la
   recence d'octets pour l'affichage, la notification et l'extinction E2.
   Aucune coexistence.
2. **`waitIdle` ne pose pas une question d'activite** : il demande « puis-je
   ecrire dans ce pty maintenant ». La carte 8691dea3 a **deja** tranche que
   l'arbitrage entre ecrivains concurrents « est un etat du main process
   (verrou ou file par tuile), pas un signal PTY ». Ce n'est donc pas un second
   predicat d'activite a construire, c'est un verrou, et il appartient a cette
   carte-la. **Hors perimetre de ce document ; nomme ici pour que le recablage
   ne se fasse pas par defaut sur le mauvais capteur.**

#### Etat d'U1'

**FERMEE** pour ce qu'elle devait decider (quel capteur d'activite retenir) :
M1a et M1b ferment le cote repos avec des controles negatifs forts, M2 donne le
pire gap, M3 tranche le discriminant. Reste le residu de profil de charge
ci-dessus, declare et non bloquant.

**Reste ouvert, et c'est peu :** la fin de tache longue comme troisieme corps
(ni preuve d'existence, ni preuve d'absence), et la couverture du jeu de corps
face aux trois ecrans que `❯ 1.` couvrait (U2').

### 6.7 L'ecran de confiance : ma cloture etait mal formulee, correction

M6 mesure que l'ecran de confiance (`Quick safety check: Is this a project you
created or one you trust?`) **n'emet aucune OSC 777** pendant 22 s d'affichage,
soit 3,6x le temporisateur de 6 s connu, avec controle negatif fort (rendu ecran
horodate avant toute frappe, 4 288 octets recus). C'est un etat qui reclame
l'operateur et qu'OSC 777 ne leve pas.

#### Ce que je corrige dans ma propre formulation

J'avais ecrit « la levee d'un niveau A vient d'OSC 777 **et de lui seul** ».
**Cette formulation est fausse**, et cet ecran le prouve. Elle confondait la
CLASSE du capteur (ce que R1 exige) avec l'IDENTITE d'un capteur particulier
(ce que R1 n'a jamais exige). La formulation correcte est celle que le team-lead
propose :

> **Toute levee vient d'un capteur MECANIQUE.** OSC 777 en est un ; il n'est pas
> le seul, et rien n'oblige un domaine a tenir dans un capteur unique.

C'est une instance exacte de la regle de couverture de CLAUDE.md appliquee a
notre PROPRE remplacement : la sensibilite du nouveau mecanisme est bonne, son
DOMAINE est plus petit que celui qu'il remplace. Le remplacement en bloc etait
le piege ; la regle, elle, tient.

#### Mais « on perdrait de la couverture » suppose qu'on en a. Mesure : non

- Le bras dedie de `attention.ts` est `/\bdo you trust the files\b/i`. Le texte
  vivant est `Is this a project you created or one you trust?`. **Il ne matche
  pas.** Mort par vocabulaire, comme le disait la carte bbc849f7.
- Le test du depot, `tests/desktop-attention.test.ts`, definit
  ``const TRUST_SCREEN = `Do you trust the files in this folder?` `` : une
  phrase nue, **sans `❯ 1.`**. Il ne passe donc que par le bras dedie. L'intention
  de conception etait bien « cet ecran est attrape par son libelle propre », et
  le test **fabrique lui-meme la chaine**, donc il ne peut structurellement pas
  remarquer que le libelle a change. Sensibilite verte, couverture jamais
  verifiee : la forme exacte que CLAUDE.md decrit.

**Verdict : le bras dedie est mort, donc OSC ne perd rien de ce cote. Il ne
repare simplement pas un trou preexistant.** Reste une seule inconnue pour
savoir si la perte est reelle : le bras `/❯\s*1\./` attrape-t-il l'ecran par
accident ? (U3' ci-dessous.) Et meme si oui, ce serait une couverture
**accidentelle** -- ce motif a ete ecrit pour « chooser numerote », et le
commentaire d'`attention.ts` dit explicitement que les questions en texte libre
sans menu ne sont PAS detectees. Faire reposer le cas de plus grande valeur sur
un appariement incident est une affirmation de couverture que personne n'a
auditee.

#### La bonne levee pour ce cas est mecanique, et ce n'est pas (h2)

**(h2) refutee dans sa forme.** MESURE : `StartupAckDetector`
(`desktop/src/main/startup-ack.ts`) n'est PAS un marqueur de demarrage
generique. C'est un detecteur **textuel a deux indices**
(`/loading\s*development\s*channels/i` ET
`/I\s*am\s*using\s*this\s*for\s*local\s*development/i`) sur **un dialogue
particulier**, qui n'apparait que si le lancement passe
`--dangerously-load-development-channels`. `session-service.ts` documente
d'ailleurs la limite : un lancement qui omet ce drapeau ne montre jamais le
dialogue, donc l'ack ne tire jamais. S'appuyer dessus rendrait la levee textuelle
ET dependante d'un drapeau de lancement.

**L'intuition derriere (h2) est juste, sa mise en oeuvre doit changer.** Le fait
mecanique disponible n'est pas « la session a atteint un marqueur », c'est
**« la session n'a jamais produit »** :

> **Nouvelle levee proposee, capteur mecanique, aucun texte : une session
> engendree qui n'a pas emis de tic OSC 0 soutenu dans les N secondes suivant
> son spawn n'a jamais commence a travailler.**

Proprietes qui la rendent preferable a un retour au textuel :

1. **Elle utilise le capteur deja retenu** (§6.6), donc aucun nouvel axe.
2. **Son domaine est PLUS GRAND que celui du bras textuel qu'elle remplace** :
   elle couvre l'ecran de confiance, le dialogue de consentement MCP, une invite
   de connexion, et tout ecran bloquant au demarrage que le CLI ajoutera
   ensuite -- sans connaitre aucun de leurs libelles. C'est la direction
   inverse du retrecissement de domaine, qui est precisement l'objection.
3. **Elle est de la meme famille que B1 (sortie).** Une session qui ne demarre
   jamais, comme une session morte, n'emettra plus jamais rien : si on ne
   l'annonce pas, elle est invisible pour toujours. Elle rejoint donc le niveau
   B (« rien ne viendra plus de cette tuile »), pas le niveau A.

**Sur (h1), et je reponds sur le modele plutot que par gout :** cet etat est
celui dont la duree de dommage attendue est la plus longue. Il survient
exactement au moment ou l'operateur lance une fournee et s'en va, et il est
**auto-perpetuant** -- une session bloquee au demarrage ne se debloque jamais
seule, contrairement a une invite de permission qui vit au moins dans une
session qui tourne. Ce n'est pas un cas marginal ; c'est structurellement le
pire. La conclusion de valeur du team-lead est donc soutenue par le modele.

#### Forme du predicat : tranchee par U3'

MESURE (sonde neuve, repertoire non approuve, `KEYSTROKES_SENT 0`, **130 622 ms**
assis sur le dialogue) : `OSC0_COUNT 1`, **une seule** emission a t=318 ms,
contenu `ESC]0;claude BEL`, et **aucune autre** sur les 130,3 s suivantes.
Contraste : **1 emission sur 130,6 s de blocage contre 66 sur 61 s d'activite**.

Controle negatif elegant, a retenir comme methode : apres 430 ms le flux devient
muet, donc un zero serait indistinguable d'un tuyau mort. Quatre
REDIMENSIONNEMENTS ont ete injectes a t=30, 63, 96 et 129 s -- un
redimensionnement **ne peut pas repondre au dialogue**, et M1b avait deja mesure
qu'il ne produit **aucune** OSC 0, donc il ne peut ni valider l'ecran ni
fabriquer le signal compte. Resultat : 18 383 octets et 1 134 CSI delivres aux
quatre instants, `OSC0_COUNT` reste a 1.

**Verdict : « aucune emission depuis le spawn » est FAUX (il y en a toujours
exactement une, tres tot, dans tous les runs). La forme a ecrire est « pas de
tic soutenu a ~960 ms sur une fenetre demarrant au spawn », cad le seuil de 3 s
de §6.6 applique depuis le spawn.** Un `count === 0` echouerait en permanence.

Attribution, au bon niveau de preuve : MESURE, cette emission unique est presente
dans tous les runs. DEDUIT et non tranche, elle vient probablement du CLI et non
de ConPTY (ConPTY emet le CHEMIN COMPLET du binaire pour un enfant node, or le
titre ici est le mot nu `claude`). **Peu importe qui l'emet : un compteur doit
tolerer cette premiere emission, ce qui est precisement pourquoi la forme « pas
de tic soutenu » est la seule sure.**

**Piege d'implementation, signale par la sonde :** cet ecran emet aussi **deux
OSC 8** (un hyperlien) a chaque peinture, 32 sur ce run, et ConPTY les REECRIT
en y collant son propre identifiant. **Un detecteur qui compterait `ESC]` sans
discriminer le NUMERO de l'OSC les compterait comme du signal** -- et ce bruit
est proportionnel au nombre de peintures, donc maximal precisement sur l'ecran
bloque qu'on cherche a detecter. Discriminer `]0;` (titre) de `]777;`
(notification) et de `]8;` (hyperlien) est une exigence, pas une optimisation.

#### Contrainte : le seuil de 60 s est un REGLAGE, pas une constante

MESURE (M6) : `messageIdleNotifThresholdMs` figure parmi les cles de reglages du
CLI et le code compare le delai a cette valeur. **Ne jamais coder 60 s en dur**
cote Kory : un operateur qui l'abaisse ou l'augmente desynchronise silencieusement
toute correlation temporelle.

Consequence sur §6.5, a lire comme une nuance et non un revirement : on ne
construit pas de sejour, **et on ne DEPEND pas non plus de celui du CLI**. Le
sejour tiers n'est pas un mecanisme de correction sur lequel s'appuyer, puisque
sa valeur ne nous appartient pas. En pratique l'impact porte sur les hypotheses
de LATENCE, pas sur le filtrage, OSC 777 etant un evenement discret et non un
niveau.

#### Validation retroactive de la regle d'enrichissement

M6 denombre **21 kinds pour 11 corps distincts**, dont **11 kinds partageant le
seul corps « Claude needs your permission »**. Nous en avions **trois** mesures.
Une liste d'admission batie sur ces trois aurait silencieusement laisse tomber
huit familles d'evenements, dont « une autre session demande ton approbation » et
« Claude veut utiliser ton navigateur ». Fail-open invisible, exactement ce que
la regle interdit.

Deux consequences supplementaires que ce denombrement impose :

- **Le corps n'est pas injectif sur les kinds** (11 -> 1). Il ne peut donc
  classer qu'a un grain GROSSIER, quoi qu'il arrive. Cela renforce
  « enrichissement seulement » au-dela de la question du pourrissement.
- **L'approbation de plan a un corps propre** (`Claude Code needs your approval
  for the plan`, prefixe different, ce n'est pas une variante) et le meme
  temporisateur a la milliseconde (+6002 contre +6001). Deux des trois ecrans que
  `❯ 1.` couvrait sont donc distinguables ; le troisieme
  (menu `AskUserQuestion`) reste une supposition fondee sur le partage de corps,
  pas une mesure -- l'outil n'a pas pu etre declenche.

---

## Points ouverts

### Tranche (conception)

**A2 en local seulement, et le repli `addApproval` perd le distant.** Accorde
par le team-lead le 2026-08-19, sur le motif que c'est une consequence mecanique
de la regle et non une preference. Detail en §2.1.

**P2 -- un interrupteur par TYPE de notification.** Tranche par l'operateur le
2026-08-19. Consequences inscrites : `config.notifyAttention` devient
l'interrupteur du type correspondant, les autres naissent a `true` pour ne rien
retirer a personne au premier lancement. Effet de structure a assumer : la table
des types cesse d'etre interne, elle devient un **contrat visible par
l'operateur**. Un type ajoute plus tard sans son interrupteur est alors un
defaut VISIBLE, pas un detail -- la couverture devient verifiable a l'oeil, ce
qui est rare et vaut d'etre preserve.

---

## 7. P1 : multi-Kory. Mesure, puis verdict

### 7.0 La question s'est renversee, et la mesure y repond mieux qu'a l'ancienne

**Premiere formulation (2026-08-19, matin).** « Si l'utilisateur a un Kory
ouvert sur deux PC, les DEUX Kory ont leurs PROPRES notifications, il n'y a PAS
de partage. » Lue comme une demande d'ISOLATION. Les sections 7.1 a 7.7
mesurent cette question et **restent valides telles quelles**.

**Formulation reelle (2026-08-19, apres precision de l'operateur).** Ce qu'il
veut est l'INVERSE, une **unification** : « on devrait pouvoir lier plusieurs
sessions Kory a l'app Android, en mode compagnon full plus validation, quel que
soit l'origine de l'instance kory (multi-pc, ou multi-kory sur un pc) », avec
« plusieurs appairages et un menu de basculement dans l'app Android ».

**Son axe n'a jamais ete la MACHINE, c'est l'INSTANCE KORY**, et il traite
multi-PC et multi-Kory-sur-un-PC comme le meme probleme. Consequence directe :
la conclusion « sa premisse est deja vraie par defaut » (§7.5) **devient
caduque** -- elle repondait a une question qu'il ne posait pas. Elle est
conservee ci-dessous parce que la MESURE qui la porte sert la nouvelle question.

**La demande se scinde en deux moities de statuts opposes, et c'est la
distinction du DOUBLE APPAIRAGE (§7.3) qui les separe.** §7.8 mesure les deux.

### 7.1 Mesure : le chemin complet, et sa cle a chaque etage

Toutes les lignes ci-dessous sont MESUREES par lecture du code nomme.

| Etage | Fichier / symbole | Keyed by | Deux quoi ? |
|---|---|---|---|
| L'agent leve | `server.ts`, handler `ask_operator` | credential de session (`session_ref`), qui porte `operator_id` | deux sessions = deux `session_ref`, aucun conflit |
| Stockage | `broker.ts`, table `pending_approvals` | PK `id`; colonnes `operator_id`, `origin_host`, `origin_user`, `project_key`, `group_id`, `session_ref`, `tile_ref` | l'origine EST enregistree, y compris l'hote |
| Lecture par le Deck | `broker.ts`, `handleApprovalList` | `(operator_id, project_key)`, `project_key` **obligatoire** (carte 4df14b5b) | **deux Decks de meme operateur sur le MEME projet voient la meme liste** |
| Choix des destinataires | `notify/registry.ts`, `fanOut(approval)` -> `store.bindingsFor(approval.operator_id)` | **`operator_id` SEUL** | rien ne filtre par hote, par Deck ni par projet |
| Table des liaisons | `broker.ts`, `approval_channels` | PK `id`, UNIQUE `(operator_id, kind, address)` | plusieurs adresses par (operateur, type) sont permises |
| Passerelle | `notify/registry.ts`, `slot(operatorId, kind)` | `(operator_id, kind)`, instance partageable avec comptage de references | **le precedent CLAUDE.md est CORRIGE** (voir 6.2) |
| Appairage du telephone | `broker.ts`, `onPair` + table `approval_pairing_codes(code PK, operator_id, kind, expires_at)` | **`operator_id`** | voir 6.3 |
| Identite | `desktop/src/main/operator-identity.ts` | fichier `operator.json` dans le repertoire d'etat applicatif, **per-OS-user** | voir 6.4 |
| Rendu | `notify/format.ts`, `originLabel(approval)` -> `host · project` | -- | **le desambiguateur multi-PC existe deja et ship** |

### 7.2 Le precedent cite en avertissement : mesure, il est corrige

L'en-tete de `notify/registry.ts` documente le defaut lui-meme et sa
correction : « KEYED BY (OPERATOR, KIND), NOT BY KIND ». La table
`approval_channel_secrets` a pour PK `(operator_id, kind)`, et `slot()` compose
`operator_id` + `kind`. Le partage volontaire d'un meme jeton de bot par deux
operateurs est traite explicitement : une seule instance enregistree sous deux
cles, arret **compte par references** pour qu'une deconnexion n'eteigne pas
l'autre. La direction d'autorisation recommandee par CLAUDE.md est appliquee :
`bindingFor(kind, address, operatorId)` resout l'objet PUIS demande si ce
demandeur peut agir dessus, au lieu de resoudre l'adresse vers « son »
operateur.

Verdict : **ce defaut-la n'est pas a re-craindre.** Le risque de cette zone est
ailleurs, et il est en 6.4.

### 7.3 A quoi le telephone s'appaire : reponse mesuree, et elle est DOUBLE

Il existe **deux appairages distincts**, de portees opposees. C'est la source
probable du malentendu.

1. **Canal de notification distant (Telegram / Discord / ntfy, dont l'app
   Parastates).** Symbole : `onPair` dans `broker.ts`, code consomme depuis
   `approval_pairing_codes`, liaison inseree dans `approval_channels`.
   **Cle : `operator_id`.** Le telephone s'appaire donc a une PERSONNE, ni a un
   Deck ni au broker. L'app Android recoit par ce chemin
   (`desktop/mobile-shell/android-src/java/io/koryphaios/parastates/ApprovalService.kt`).
2. **Compagnon LAN (le meme telephone, autre role).** Symbole :
   `CompanionServer` dans `desktop/src/main/companion-server.ts`. En-tete
   mesure : demarre **sur action explicite de l'operateur**, jeton d'appairage
   **a usage unique dans le QR** echange contre un credential **par execution**,
   **rien ne survit au processus**. **Cle : ce Deck-ci, cette execution-ci.**

**C'est exactement le cloisonnement par Deck que decrit l'operateur -- et il
existe deja, mais sur le compagnon LAN, pas sur les canaux distants.** Sa phrase
« si l'utilisateur appaire son telephone a Kory » decrit fidelement le geste (2)
et s'applique au systeme (1), qui n'a pas cette portee.

### 7.4 Ce que fait le code aujourd'hui pour « deux Decks »

Quatre cas, et ils ne donnent pas la meme reponse. C'est le coeur du rapport.

| Cas | `operator_id` | Comportement mesure | Conforme a la premisse ? |
|---|---|---|---|
| **Deux PC, sans « lier »** (defaut) | **differents** : `operator.json` vit dans le repertoire d'etat applicatif, per-OS-user, et est minte localement | Deck B n'a aucune liaison -> le telephone appaire depuis A ne recoit rien de B. Cloisonnement total. | **OUI, deja** |
| **Deux comptes OS sur un PC** | differents, sans une ligne de code pour le decider | Idem | **OUI, deja** |
| **Deux PC apres « Lier un second PC »** | **identique** (`exportEnrolment` / `applyEnrolment`, en-tete : « un operateur est une personne, pas un appareil ») | `fanOut` ne connait que `operator_id` -> les deux PC sonnent sur le meme telephone. Le badge `host · project` les distingue a la lecture. | **NON, et c'est le but declare de cette fonction** |
| **Deux fenetres Deck, meme compte OS** | **identique** (meme repertoire d'etat) | Meme telephone ; et si les deux fenetres sont sur le MEME projet, `handleApprovalList` etant keye `(operator_id, project_key)`, **chaque fenetre voit aussi les questions de l'autre dans son Courrier local** | **NON** |

Le dernier cas merite d'etre souligne : il ne demande **aucun** geste de liaison,
il ne traverse **aucun** reseau, et deux fenetres Deck sur un compte OS sont un
cas **nominal** (`requestSingleInstanceLock` est absent du main). C'est la
violation la plus accessible de la premisse, et elle est deja en production.

### 7.5 Verdict de faisabilite

Repondu dans les termes demandes (a / b / c / d) -- et la reponse honnete est
que la premisse se scinde en trois sous-questions de statuts differents.

- **(a) DEJA LE COMPORTEMENT ACTUEL** pour le cas que l'operateur decrit
  litteralement, « un Kory ouvert sur deux PC », tant qu'il n'a pas utilise
  « Lier un second PC ». Rien a faire, rien a concevoir. C'est le resultat
  principal.
- **(d) CONTRADICTOIRE AVEC UNE DECISION STRUCTURELLE DEJA PRISE** pour le cas
  ou il l'a utilisee. La fonction de liaison n'a pas d'autre finalite que de
  faire converger deux Decks vers une identite. Le cloisonnement par Deck et la
  liaison multi-PC sont la meme question posee dans deux sens ; on ne peut pas
  garder les deux. **Ce n'est pas a nous d'arbitrer, mais l'arbitrage porte sur
  la liaison, pas sur les notifications.**
- **(c) ATTEIGNABLE AU PRIX D'UN PORTEUR D'ETAT NOUVEAU** pour le cas des deux
  fenetres Deck sur un compte, et pour le cas lie si l'operateur veut le
  cloisonner malgre tout. Detail du prix en 6.6.

### 7.6 Le prix reel de respecter la premisse, y compris le prix cache

Si l'operateur maintient le cloisonnement par Deck **partout**, voici ce qu'il
en coute. Ce document ne recommande pas de changer sa premisse : il en donne le
prix.

**Prix visible.**

1. **Un axe d'identite nouveau : un `deck_id`.** Il n'existe pas
   (`grep -c "deck_id\|deck_session" broker.ts` -> `0`), et aucun des
   identifiants presents ne peut en tenir lieu : `operator_id` est une personne,
   `hostname()` est partage par deux comptes OS, un id persiste dans l'etat
   applicatif est partage par deux fenetres. Il doit donc etre **minte par
   lancement de Deck et jamais persiste** -- exactement la cle deja retenue pour
   la duree de vie du Courrier, ce qui est un precedent utilisable et non un
   invention.
2. **Trois etages a re-keyer**, pas un : la liaison
   (`approval_channels`, aujourd'hui `(operator_id, kind, address)`), la
   selection des destinataires (`fanOut`, aujourd'hui `operator_id` seul), et la
   lecture du Courrier (`handleApprovalList`, aujourd'hui
   `(operator_id, project_key)`). Re-keyer un seul des trois produit une
   incoherence silencieuse entre ce que le telephone recoit et ce que le Deck
   affiche.
3. **La liaison multi-PC devient sans objet** et doit etre retiree ou
   redefinie, sinon elle reste une fonction dont le seul effet est de violer la
   regle.

**Prix cache, et c'est celui qui coute.**

4. **Un Deck ferme ne peut plus rien delivrer.** Aujourd'hui, une approbation
   levee par un agent survit a la fermeture du Deck : elle est durable
   broker-side et le telephone la recoit quand meme. Si la liaison est keyee par
   un `deck_id` minte par lancement, **relancer Kory invalide la liaison**, donc
   les notifications d'un agent lance juste avant un redemarrage n'arrivent
   nulle part. Il faut alors soit re-appairer le telephone a chaque lancement
   (inacceptable), soit persister le `deck_id` -- ce qui le rend a nouveau
   partage par deux fenetres et **fait retomber dans le defaut initial**.
   C'est la tension centrale, et elle n'a pas de solution gratuite.
5. **Le geste d'appairage se multiplie par le nombre de machines.** Aujourd'hui
   un appairage couvre l'operateur ; avec un cloisonnement par Deck il en faut
   un par Deck, chacun avec son propre jeton de bot ou son propre sujet ntfy.
   Pour Telegram cela veut dire **un bot par Deck** : le broker ne peut pas
   partager un jeton entre deux liaisons rivales (un seul consommateur
   `getUpdates` par jeton, contrainte deja documentee dans
   `notify/registry.ts`).
6. **On perd le desambiguateur au profit d'un cloisonnement plus cher.** Le
   badge `host · project` de `notify/format.ts` resout deja le probleme que le
   cloisonnement cherche a resoudre -- savoir de quelle machine vient la
   demande -- pour un cout nul et sans nouvel axe d'identite.

**Option intermediaire, si le besoin reel est « ne pas melanger » et non
« cloisonner ».** Un filtre de reception par `host`, cote destinataire :
`pending_approvals.origin_host` est deja enregistre et deja rendu. Cela
n'introduit qu'une preference, pas un axe d'identite, et laisse la delivrance
survivre a la fermeture du Deck. Ce n'est pas la premisse de l'operateur, c'est
le voisin le moins cher.

### 7.7 Question a l'operateur, une seule ~~CADUQUE~~

~~La fonction « Lier un second PC » doit-elle exister ?~~ **Sans objet depuis
la precision de l'operateur (§7.0)** : il ne veut pas cloisonner, il veut lier.
La fonction va donc dans le sens de sa demande au lieu de la contredire.

### 7.8 Multi-Kory : mesure des deux moities

#### Moitie NOTIFICATION : acquise pour le cas qu'il decrit, avec trois collisions nommees

MESURE. `originLabel(approval)` (`notify/format.ts`) rend
`` `${host} · ${project}` ``, ou `project` est le DERNIER segment de
`origin.project_key` decoupe sur `/`, `\` et `:`. `project_key` vient de
`normalizeRemoteUrl` (`shared/project-key.ts`), qui normalise l'URL du remote
git en cle stable **cross-PC** (`github.com/vocsap/koryphaios`). Il est utilise
par les **trois** adaptateurs (`renderTelegram`, `renderDiscord`, et directement
dans `ntfy.ts`).

Sur son exemple exact -- « kory sur ce repo, et kory sur Kleos » -- les deux
libelles sont donc `<host> · koryphaios` et `<host> · kleos` : **distincts, et
sans une ligne a ecrire**. Combine au fait que le canal distant est keye par
`operator_id` (§7.1), plusieurs Kory d'une meme personne convergent DEJA vers un
seul telephone, en restant distinguables. **La lecture du team-lead est
confirmee.**

**Trois collisions, parce qu'« acquis » sans ses bords est une affirmation de
couverture :**

1. **Meme basename, proprietaires differents.** `.pop()` ne garde que le dernier
   segment : `github.com/a/tools` et `github.com/b/tools` rendent tous deux
   `tools`. Collision silencieuse.
2. **Depot sans remote git.** `resolveProjectKey` retombe sur `local:<hash>` ;
   le decoupage sur `:` rend `<hash>`. Distinct, mais **illisible** pour un
   humain sur un telephone.
3. **Deux fenetres, meme projet, meme hote.** Libelle identique par
   construction. C'est le residu, et c'est exactement le cas de la carte
   `efd9dbfc` (voir plus bas).

#### Moitie PILOTAGE : c'est la qu'est le travail. Quatre mesures

1. **Le compagnon supporte DEJA plusieurs appairages, mais dans l'autre sens.**
   MESURE : `CompanionAuth` (`desktop/src/shared/companion.ts`) tient
   `creds: Map<string, CompanionDevice>`, avec `listDevices()`, `revoke(id)`,
   `revokeAll()`. La multiplicite implementee est **N telephones vers 1 Kory**.
   La demande est **1 telephone vers N Kory**, qui n'est pas la meme relation et
   n'est portee par rien cote Deck.
2. **Le jeton par execution n'est PAS un accident, c'est une posture de
   securite.** MESURE, en-tete de `companion-server.ts` : « ephemeral session
   mode -- Off by default; nothing survives the process (closing the app
   revokes) ». Et `arm(token)` « invalidates the previous one AND all creds » :
   chaque nouveau QR **efface tous les appairages existants**, `start()`
   appelant `stop()` puis `arm()`. Ce n'est donc pas une consequence de « un
   seul appairage etait prevu » : **c'est une decision de securite explicite**,
   et la changer est un arbitrage de securite, pas un refactor.
3. **Aucun porteur d'etat n'existe pour « la liste des Kory connus de ce
   telephone », d'aucun cote.** MESURE : l'etat du compagnon est en memoire
   (`private state`), par serveur, efface a chaque re-arm ; et le broker ne
   connait aucun Deck (`grep -c "deck_id\|deck_session" broker.ts` -> 0).
   **Cette liste ne peut vivre que SUR LE TELEPHONE.** Ce n'est pas un pis-aller :
   c'est le seul participant qui voit les N instances.
4. **Le mode demande existe deja des deux cotes.** MESURE : `ClientCtx.mode` est
   `'full' | 'light'`. Et « compagnon full **plus validation** » correspond a
   deux transports vers la meme app -- WebSocket LAN pour le pilotage, canal
   distant pour l'approbation. **C'est deja l'architecture.**

#### L'identite, et elle n'a toujours pas de solution gratuite

Une entree de la liste cote telephone a besoin d'un identifiant **stable ENTRE
deux lancements** (sinon la liste se vide a chaque relance) et **distinct ENTRE
deux fenetres du meme compte**. Mesure de chaque candidat existant :

| Candidat | Stable entre deux lancements ? | Distinct entre deux fenetres d'un compte ? |
|---|---|---|
| Empreinte du certificat (`companion-cert.json` dans l'etat applicatif) | **OUI**, persistee exprès | **NON** : fichier per-OS-user, donc partage |
| Port d'ecoute | **NON** : `server.listen(0, ...)`, port ephemere assigne par l'OS | oui |
| Adresse LAN | oui-ish (DHCP) | **NON** : meme hote |
| Credential d'appareil | **NON** : en memoire, efface par `arm()` | oui |
| `operator_id` | oui | **NON** : per-OS-user |

**Aucun champ existant ne satisfait les deux exigences.** C'est litteralement le
cout cache n°4 de §7.6, deplace du canal distant vers le compagnon, et **dans
les memes termes** : ce qui est stable ne distingue pas, ce qui distingue n'est
pas stable.

**Option A -- cle composite `(empreinte du certificat, project_key)`.** Zero
porteur d'etat nouveau : les deux champs existent, sont persistes et voyagent
deja. L'empreinte apporte la stabilite entre deux lancements, `project_key`
apporte la distinction entre deux Kory -- **et c'est exactement l'axe de
l'operateur**, qui parle de « kory sur ce repo, et kory sur Kleos ». Residu :
ne distingue pas deux fenetres sur le MEME projet du meme hote.

**Option B -- un `deck_id` persiste par fenetre, avec resolution de collision.**
Couvre tout, au prix d'un axe d'identite nouveau, d'une persistance et d'un
protocole de collision (deux fenetres qui demarrent ensemble doivent negocier).
C'est le prix deja instruit en §7.6, inchange.

**Recommandation : Option A.** Force decisive : son unique residu est
**exactement** le residu de la moitie notification (collision 3 ci-dessus) et
celui de la carte `efd9dbfc`. Un seul residu qui se manifeste par trois
symptomes est le signe que le modele est au bon endroit -- et il se traite une
fois, plus tard, si l'operateur constate qu'il ouvre reellement deux fenetres
sur un meme projet. Option B paie aujourd'hui pour un cas qui n'est pas celui
qu'il decrit.

### 7.9 La regle de duree de vie de l'operateur dissout la tension, et revele un defaut

**Decision de l'operateur, 2026-08-19 :** « LES NOTIFS NE VIVENT QUE DURANT LA
DUREE DE L'APP DECK KORY. Choix assume ; si reprise de session, l'utilisateur
est devant son PC, il repondra lui-meme sans passer par l'app. »

#### Ce que cela dissout

Mon cout cache n°4 (§7.6) posait : un identifiant minte par lancement invalide
la liaison a chaque relance, donc **soit** re-appairer a chaque lancement
(que je qualifiais d'inacceptable), **soit** persister, ce qui rend
l'identifiant partage par deux fenetres et fait retomber dans le defaut
initial.

**La branche que je jugeais inacceptable est le comportement voulu.** La tension
n'avait pas de solution gratuite parce qu'elle reposait sur une exigence que
l'operateur n'a jamais eue. Erreur de ma part, pas de la mesure : j'avais fixe
un critere de qualite a sa place.

#### Ce n'est pas une simplification, c'est une REUTILISATION

La regle est **mot pour mot** celle deja tranchee pour la duree de vie du
Courrier (cartes `1e81ee7b` / `54b1c71a`) : cle = un identifiant de session
minte en memoire **a chaque lancement du Deck, jamais persiste**, le Deck
DECLARE et le broker EFFECTUE. **Le meme mecanisme sert les deux objets.**

A noter comme un vrai travail et non comme un acquis : `pending_approvals` n'a
**aucune** borne de duree de vie aujourd'hui (mesure §7.1, les lignes survivent
au Deck). Appliquer sa regle veut dire **ajouter** cette borne, pas en retirer
une.

#### A contre B, refait avec la contrainte levee

- **Branche « l'appairage MEURT aussi a chaque lancement »** -> **B devient
  strictement meilleur.** Un `deck_id` minte par lancement distingue
  parfaitement deux fenetres, et son unique cout (ne pas survivre a la relance)
  **est desormais le comportement souhaite**. Le residu d'A disparait pour zero.
- **Branche « l'appairage SURVIT »** -> **A reste preferable.** B exigerait
  alors un `deck_id` persiste plus un protocole de collision entre deux fenetres
  qui demarrent ensemble, cad le prix de §7.6 inchange.

**Prix cache de sa propre decision, que je dois lui donner puisque mon role est
de chiffrer et non de preferer :** si l'appairage meurt aussi, le geste de
re-appairage est **en O(N)** -- un QR par Kory, a chaque lancement -- et ce N
est precisement ce que la fonction existe pour faire grandir. Trois Kory, c'est
trois scans par lancement. C'est le seul argument serieux en faveur d'un
appairage persistant, et il vaut d'etre pose avant qu'il ne tranche.

Rappel de mesure utile a cet arbitrage : le canal DISTANT persiste deja
(`approval_channels`, keye `operator_id`) et n'est pas concerne ; seul le
compagnon LAN meurt, **par posture de securite explicite** (§7.8). Les deux
moities n'ont donc pas la meme duree de vie aujourd'hui, et sa decision porte
clairement sur les APPROBATIONS.

#### Le defaut que son raisonnement revele : une reponse a un peer mort est PERDUE EN SILENCE

MESURE, chemin complet.

1. `deliverApprovalAnswer` (`broker.ts`) route **par `reply_token`**, cad le
   jeton d'instance, via `recordMessageTx`.
2. `recordMessageTx` ne fait **aucun controle d'existence** : `insertMessage`
   insere, point.
3. `wsPool.get(reply_token)` rend `undefined` pour un peer mort -> **aucun
   push**, et le code n'en tire rien.
4. Le `catch` de `deliverApprovalAnswer` ne peut pas tirer : `PRAGMA
   foreign_keys = ON` (broker.ts) **est** actif, mais un peer ferme passe
   d'abord en `status = 'dormant'` **en gardant sa ligne** (`cleanStalePeers`
   phase 1). La contrainte est donc satisfaite et l'insertion reussit.
5. Le message reste `delivered = 0` et **personne ne le lira jamais**. Il
   disparait plus tard, soit par `purgeOldUndeliveredStmt`, soit avec son peer
   via `purgeDormantPeerTx`, qui supprime d'abord tous ses messages.

**Verdict : ni refus, ni file exploitable, ni trace. Perte silencieuse,
differee.** C'est un defaut a part entiere, et il merite d'etre nomme plutot
qu'absorbe par la regle.

**La regle de l'operateur le ferme PARTIELLEMENT, pas entierement.** Elle couvre
le cas « le Deck a ete ferme ». Elle **ne couvre pas** le cas ou une SEULE
session meurt pendant que le Deck reste ouvert (agent plante, tuile fermee par
l'operateur) : l'approbation reste ouverte, le peer est mort, la reponse se perd
exactement de la meme facon.

**Bonne nouvelle mesuree, qui repond a la crainte n°2 de l'operateur** (« si les
id sont reattribues, une reponse n'a plus de sens pour la nouvelle session ») :
**la mauvaise livraison est impossible**. Le routage se fait par jeton
d'instance, pas par `peer_id`, et `upsertPeerSession` attribue un **nouveau**
jeton a une session restauree (`ON CONFLICT ... DO UPDATE SET instance_token =
excluded.instance_token`). Une reponse ancienne ne peut donc pas atterrir sur
une session neuve qui aurait repris le meme nom. Elle est perdue, pas egaree --
ce qui est le bon ordre de gravite.

**Hypothese que j'ai formee puis REFUTEE avant de l'ecrire comme un fait**, pour
qu'elle ne soit pas re-derivee : `recordMessageTx` appelle
`updateLastActivity` sur le destinataire, j'ai donc suppose qu'une reponse
non livrable rafraichissait son propre destinataire mort et repoussait sa purge.
**Faux** : `updateLastActivity` ecrit `last_activity_at`, alors que la purge des
dormants filtre sur `last_seen`. Pas d'auto-entretien.

**Rapport a la carte `4a606edd`** (un message vers un destinataire non livrable
disparait en silence) : **meme puits, point d'entree different**. Cette carte
vise le courrier agent-a-agent ; ici c'est `deliverApprovalAnswer`. Les deux
convergent sur `recordMessageTx`. **Note actionnable pour cette carte : placer
le rebond au PUITS PARTAGE (`recordMessageTx`) et non chez l'appelant
`send_message`, sinon la reponse d'approbation restera silencieuse alors meme
que la carte sera livree et verte.** C'est la question de couverture de
CLAUDE.md appliquee au correctif plutot qu'au defaut.

Sa taxonomie de trois etats (dormant-mais-susceptible-de-revenir / actif-sans
etage-de-reception / inexistant) s'applique telle quelle. Le cas mesure ici est
le premier en apparence (`status = 'dormant'`) et le troisieme en realite (le
processus est mort et ne reviendra jamais sous ce jeton) : **une garde qui se
fierait au seul `status` classerait ce cas dans « a reessayer » et ne rebondirait
jamais.**

### 7.10 U5' tranchee : OPTION B. Consequences

**Decision de l'operateur, 2026-08-19 :** l'appairage meurt avec le Deck, comme
les approbations. « L'appairage reste un geste manuel, que l'utilisateur consent
a porter en mobile son travail. Toutes les fenetres kory n'ont pas forcement
vocation a etre appairees. Donc 3 kory = 3 gestes d'appairage = me convient
parfaitement. »

#### Mon prix en O(N) etait juste, son ASSIETTE etait fausse

Je chiffrais N = le nombre de Kory OUVERTS. **N est en realite le nombre de Kory
que l'operateur VEUT sur son telephone**, cad un sous-ensemble choisi. Et
l'appairage n'est pas une formalite subie mais **un acte de SELECTION** : « je
porte ce travail-ci en mobile ». Sous cette lecture, le geste par lancement
n'est pas un cout a amortir, **c'est le mecanisme par lequel l'intention
s'exprime**. A inscrire sous cette forme, parce que la nuance porte la
conception : un appairage ephemere n'est pas une limitation acceptee faute de
mieux.

#### Consequences

1. **Option B retenue** : identifiant de fenetre minte par lancement, jamais
   persiste. Son unique cout mesure (ne pas survivre a la relance) est desormais
   le comportement VOULU **sur les deux objets**, approbations et appairage.
   Meme cle que la duree de vie du Courrier : un mecanisme, trois objets.
2. **Le residu d'A disparait.** Deux fenetres du meme compte sur le meme projet
   deviennent distinguables. Voir la requalification de `efd9dbfc` ci-dessous.
3. **La posture de securite du compagnon n'a plus a etre levee** : elle est
   alignee avec la decision, elle n'est plus un obstacle. C'est le point que le
   team-lead m'a demande de verifier avant de l'ecrire, et la verification
   change sa formulation (ci-dessous).
4. **La liste vit sur le telephone, et c'est une liste de SESSIONS.** Confirme,
   avec une reserve (ci-dessous).

#### Verification demandee : la separabilite est REELLE, mais pas ou on la cherche

Le team-lead ecrivait « ce qui reste a lever est uniquement la relation N
telephones vers 1 Kory ». **La mesure deplace la conclusion.**

MESURE : `arm()` est appele **une seule fois**, dans `start()`, juste apres avoir
minte un `pairingToken` neuf. Ce n'est pas un effacement par appairage, c'est
**une epoque de confiance par execution du serveur** : le serveur redemarre,
donc les credentials d'avant ne valent plus. Rien dans ce code ne suppose « un
seul Kory ».

Et la raison de fond : **`CompanionServer` EST un seul Kory par construction**.
C'est un serveur par instance de Deck ; il n'a **aucune** notion des autres.
La multiplicite « N telephones » vit du cote Deck, la multiplicite « N Kory »
vit du cote telephone. **Ce sont deux axes sur deux cotes differents, donc il n'y
a rien a separer : ils ne sont jamais melanges.** La relation N telephones vers 1
Kory n'a pas besoin d'etre levee non plus, elle est simplement orthogonale.

**Le travail cote Deck n'est donc pas de lever une posture : il est
d'IDENTIFIER.** Une seule chose manque, et elle est mesurable.

MESURE, charge utile du QR (`CompanionDialog.tsx`) :
`` `${info.url}/#t=${info.pairingToken}${info.certFingerprint ? `&f=${...}` : ''}` ``
soit **URL LAN + jeton d'appairage + empreinte du certificat**. Il ne porte
**ni identifiant d'instance, ni libelle lisible**. Sans ajout, le menu de
basculement du telephone afficherait une liste de `https://192.168.x.y:PORT`,
sans moyen de distinguer koryphaios de kleos -- cad le cas d'usage meme de la
fonction. **Le QR doit porter le `deck_id` de l'Option B et un libelle
(`project_key` suffit, il est deja calcule).** C'est tout le travail cote Deck.

**Piege a ne pas laisser passer :** deux Kory du meme compte OS partagent le
fichier `companion-cert.json`, donc **presentent la MEME empreinte** sur deux
ports differents. Commode pour l'epinglage (un seul pin couvre les deux), mais
cela confirme que **l'empreinte ne peut pas etre la cle d'une entree** -- ce qui
est exactement pourquoi l'Option A avait ce residu et pourquoi B le supprime.

#### Point 4 : ca tient, avec une reserve qui est R2 sur un troisieme objet

Oui : avec un identifiant minte par lancement, la liste du telephone est une
liste de **sessions**, pas d'appareils. Elle se vide legitimement et le menu ne
montre que du vivant.

**Reserve.** Le telephone ne peut pas SAVOIR qu'un Kory est mort ; il constate
seulement que la connexion tombe. Si une entree morte **disparait**, l'operateur
ne peut plus distinguer « je n'ai jamais appaire ce Kory » de « il s'est ferme ».
C'est **R2 applique a la liste du telephone** : une entree perimee doit devenir
**VISIBLE COMME MORTE**, avec son libelle conserve, et non s'effacer. Le geste de
re-appairage part alors de l'entree grisee, ce qui rend aussi le cout en O(N)
plus lisible : l'operateur voit exactement ce qu'il doit rescanner.

#### Sur la carte `efd9dbfc` : requalifiee une seconde fois

Premiere requalification (avant U5') : de **defaut** a **question d'etiquetage**,
puisque voir plusieurs Kory dans une meme boite est VOULU.

**Seconde requalification, apres U5' :** l'Option B **fournit** l'identifiant de
fenetre qui manquait. La carte n'est donc plus une dette a traiter separement :
elle est **resolue par la conception, pour zero cout additionnel**, du moment que
le `deck_id` accompagne l'approbation comme il accompagne l'appairage. Ce qui
reste a faire est de l'AFFICHER, et les lignes de `pending_approvals` portent
deja `session_ref` et `tile_ref` pour le grain fin. **La carte devrait etre
close ou reduite a « afficher le deck_id dans le Courrier », et surtout ne pas
redemander un cloisonnement, qui contredirait l'operateur.**

---

## 8. Etat du document : FERME le 2026-08-19

Ce document est complet pour ce qu'il devait produire : une taxonomie, un
inventaire des producteurs, une regle d'extinction avec un proprietaire nomme
par etat, une cle d'identite, et deux regimes de degradation. Aucune conception
n'y reste suspendue a une mesure absente.

### Ce qui est TRANCHE

| Sujet | Decision | Par qui |
|---|---|---|
| R1, extincteur d'une classe au moins aussi robuste que le raiser | ratifiee, en tete du document | team-lead |
| R2, un TTL n'est pas un extincteur | ratifiee ; appliquee a trois objets (episode, badge, liste du telephone) | team-lead |
| A2 local seulement, le repli `addApproval` perd le distant | accorde comme CONSEQUENCE de R1 | team-lead |
| Un interrupteur par TYPE de notification | retenu ; `notifyAttention` migre, les autres naissent a `true` | operateur |
| Levee mecanique, classification textuelle d'ENRICHISSEMENT | tranchee, validee retroactivement par 21 kinds / 11 corps | mesure M6 |
| Capteur d'activite : frequence d'OSC 0, seuil 3 s, extinction SUR FRONT | tranche | mesures M1 a M5 |
| « Session jamais demarree » : pas de tic soutenu depuis le spawn, jamais `count === 0` | tranche | mesure U3' |
| Les notifs ET l'appairage meurent avec le Deck | tranchee | operateur |
| Multi-Kory : Option B, identifiant de fenetre minte par lancement | tranchee (U5') | operateur |
| A3 limite d'usage reintroduite, DECOUPLEE de la relance automatique | tranchee, carte `f8082208` | operateur |

### Ce qui reste OUVERT

Aucun de ces points ne bloque la lecture ni la mise en oeuvre du modele. Ils
bloquent des cartes precises, pas la conception.

| # | Ouvert | Bloque quoi | Chez qui |
|---|---|---|---|
| U2' | Couverture du jeu de corps : menu `AskUserQuestion` (suppose, non declenchable) et corps de fin de tache longue (ni preuve d'existence ni d'absence) | Le GRAIN de classification. **Rien d'autre** : la table est d'enrichissement, un corps inconnu leve un generique | debugger |
| U6' | Quel corps porte la limite d'usage (`Session paused` est un litteral binaire, non mesure sur le fil) | La carte `f8082208` seulement | debugger |
| R1 | Residu de profil de charge du seuil : quatre profils mesures, tous sous 1028 ms, marge 2,9x | Rien. Mode de panne VISIBLE (la tuile clignote vers « au repos » en plein travail) | non bloquant, declare |
| R2 | Le QR doit porter le `deck_id` et un libelle (§7.10) | La mise en oeuvre du basculement | conception faite, reste a implementer |
| R3 | Perte silencieuse d'une reponse vers un peer mort | Carte `9f48d84b`, avec la note de couverture posee sur `4a606edd` | carde |

### Ce que ce document ne fait PAS

Il ne choisit aucun transport, ne conçoit pas d'installeur, ne conçoit pas le
basculement cote Android, et ne contient aucun code de production. Les mesures de
transport n'y figurent que la ou elles changent une contrainte de conception.

### Cartes que ce document alimente

`f8082208` (badge de quota decouple), `9f48d84b` (perte silencieuse),
`4a606edd` (rebond au puits partage), `2429ba4b` (balayage des tests qui
fabriquent une chaine tierce), `efd9dbfc` (requalifiee deux fois, §7.10),
`1e81ee7b` / `54b1c71a` (meme cle de duree de vie), `8691dea3` (verrou
d'ecriture, distinct du predicat d'activite).
