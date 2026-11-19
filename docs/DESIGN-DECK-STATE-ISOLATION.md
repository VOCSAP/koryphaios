# Isolation des etats du Deck : deux Kory, un seul disque

## Statut

Brief ecrit le 2026-09-06 pour un lot d'implementation ULTERIEUR. Il fixe la
regle de portee de chaque etat que le Deck persiste, l'inventaire complet des
fichiers concernes, le mecanisme de nettoyage, la garde qui rend la classe
fail-closed, et l'ordre des lots. Deux fuites sont deja confirmees (§4).

Etiquettes : **MESURE** (commande executee, sortie citee), **DEDUIT** (lu dans
le code, `file:line`), **DECIDE** (arbitrage ; ceux marques « operateur,
2026-09-06 » sont tranches, les autres proposes par l'architecte et listes
en §10).

---

## 1. Le besoin

L'operateur lance plusieurs Kory simultanement, generalement sur des depots
distincts (Koryphaios, AiDex, Kleos). Exigence : **rien ne fuit d'une fenetre
a l'autre** -- visibilite des peers, roadmap, graphe, notifications, et tout
le reste. Deux Kory sur le MEME depot tolerent des etrangetes, mais le cas
doit rester couvert proprement, un `group_id` unique etant deja minte par
fenetre.

**DECIDE (operateur, 2026-09-06)** -- les notifications sont clees par
`group_id`, jamais par projet : melanger les inbox de deux fenetres est
inacceptable. Leur duree de vie est celle de la session Kory, ce qui est
DEJA la regle du flux vivant (un `session_id` d'inbox est minte en memoire et
jamais persiste, donc un redemarrage repart d'un curseur vierge).

**DECIDE (operateur, 2026-09-06)** -- cette ephemerite est INCONDITIONNELLE :
un scope `custom` ne conserve pas davantage son inbox qu'un scope `ephemeral`.
Le `group_id` d'un scope personnalise est stable, mais les PEERS derriere ne
le sont pas -- une nouvelle session Kory mint de nouveaux `peer_id`, et rien
ne garantit qu'un message conserve corresponde encore a un agent vivant ni au
travail en cours. Garder l'inbox inviterait a repondre a une question sans
rapport avec ce que fait le peer qui porte aujourd'hui ce nom. La stabilite de
la CLE ne vaut pas stabilite des IDENTITES qu'elle indexe : c'est la meme
regle que celle qui interdit de traiter un `peer_id` comme une identite
portable (`docs/DESIGN-PEER-FEDERATION.md` §1).

---

## 2. Ce que le code fait aujourd'hui

**DEDUIT** (`desktop/src/main/scope.ts:70-84`) -- `computeScope(projectDir,
scopeId?)` : un `scopeId` fourni donne un scope `custom` (reproductible), son
absence un `randomUUID()` `ephemeral`. `groupId = sha256(secret)[:32]`. Donc
DEUX fenetres Kory, meme sur le meme depot, portent deux `group_id`
differents ; et une MEME fenetre relancee sans scope explicite en porte un
nouveau a chaque demarrage.

**DEDUIT** -- l'isolation ne repose sur AUCUNE separation physique : les deux
fenetres partagent

- un seul **broker loopback** (une base SQLite unique portant tous les groupes
  et tous les projets ; l'isolation y est un filtre `WHERE`, pas un fichier) ;
- un seul **repertoire de donnees Electron**, `app.getPath('userData')`, dont
  le sous-dossier d'etat est `APP_STATE_SUBDIR = 'config'`
  (`migrate-data-dir.ts:23`).

**DEDUIT** -- les sondages du Deck vers le broker portent tous une cle :
`fetchOperatorInbox` prend `groupId` + `secret` (TOFU broker-side),
`fetchGraphDrafts` et `fetchDispatchRequests` prennent `projectKey`
(`index.ts:1299`, `:1804`), `/announce` porte `group_id` +
`group_secret_hash`. **Le flux vivant est donc sain.** Ce qui fuit est la
persistance LOCALE de ce flux.

**MESURE** (`grep "regHandle('inbox:history'" desktop/src/main/ipc.ts`) --
`ipc.ts:1517-1518` : le canal rend `loadInboxHistory(join(userData,
APP_STATE_SUBDIR))`, le fichier ENTIER, sans filtre.

---

## 3. Le modele : trois portees, une seule question a se poser

**DECIDE** -- avant d'ecrire quoi que ce soit sous `userData`, une seule
question : *deux fenetres Kory doivent-elles voir la meme valeur ?*

| Portee | Signification | Cle | Duree de vie |
|---|---|---|---|
| **SESSION** | ce que CETTE fenetre a vecu | `group_id` | la fenetre (nettoye a la sortie, balaye si orphelin) |
| **PROJET** | ce qui appartient au depot, quelle que soit la fenetre | `project_key` | durable |
| **MACHINE** | ce qui appartient a l'operateur et a son poste | aucune | durable |

Regle derivee, et c'est elle qui compte : **une portee SESSION dont la cle est
absente n'est pas « globale par defaut », c'est une fuite.** Les trois portees
sont explicites ; l'absence de cle n'en est pas une quatrieme.

Corollaire sur la duree de vie : un `group_id` ephemere change a chaque
demarrage, donc un fichier clee par groupe **s'accumule** si rien ne le
supprime. Toute portee SESSION exige son mecanisme de nettoyage (§6) --
sans quoi le correctif d'isolation cree une fuite de disque.

---

## 4. Inventaire

Tout ce que le Deck ecrit sous `userData/config/` (plus les etats hors
`userData` pour completude). Colonne « verdict » : **OK** = clee correctement,
**FUITE** = portee SESSION sans cle, **DEBAT** = a trancher, **BRUIT** =
dernier-ecrivain-gagne sans fuite de contenu.

| Fichier / etat | Contenu | Cle actuelle | Portee correcte | Verdict |
|---|---|---|---|---|
| `inbox-history.json` (`inbox-store.ts:14`) | messages operateur draines, `{id, from, text, sentAt}` | **aucune** | SESSION | **FUITE** |
| `inbox-ack.json` (`inbox-store.ts:116`) | etat d'acquittement par entree | **aucune** | SESSION | **FUITE** |
| `review-pending.json` (`ipc.ts:407`) | revue de diff en attente | **aucune** | PROJET (tranche, §11 Q2) | **FUITE** |
| `sessions.json` (`store.ts:117`) | liste des tuiles, ecrite par `persist()` (`session-service.ts:1542`) | **aucune** | -- | **BRUIT** : ecriture seule, la restauration passe par les workspaces (`session-service.ts:280`) |
| `config.json` (`store.ts:116`) | reglages de l'app | aucune, VOULU | MACHINE | OK (verrou fichier livre) |
| `graphs/graphs-<hash(project_key)>.json` (`graph-store.ts:43`) | graphes persistes | `project_key` | PROJET | OK |
| `approvals.json` (`index.ts:442`) | reglages d'approbation | `project_key` | PROJET | OK |
| `launch-approvals.json` (`index.ts:315`) | commandes de lancement approuvees | `project_key` | PROJET | OK |
| `sandbox.json` (`sandbox-service.ts:349`) | etat du sandbox | `project_key` | PROJET | OK |
| `scope-secrets.json` (`scope-secrets.ts:26`) | secrets de scope chiffres, `{ [groupId]: blob }` | **`group_id`** | SESSION | OK -- **le precedent a imiter** |
| `<token>-session-approval.json` (`approval-runtime.ts:37`) | credential de session | derivee de `project_key` | PROJET | OK, lacune residuelle deja notee dans le fichier |
| `operator.json` (`operator-identity.ts:22`) | identite Ed25519 de l'operateur | aucune, VOULU | MACHINE | OK |
| `companion-cert.json` (`companion-server.ts:180`) | certificat auto-signe | aucune, VOULU | MACHINE | OK -- mais deux fenetres qui ouvrent le companion se disputent le port (§10 Q3) |
| `<prefix><callerId>.json` team-lead MCP (`team-lead-mcp-sweep.ts:20`) | configs MCP du superviseur | derivee de `project_key` | PROJET | OK, l'accumulation entre deux fenetres du meme depot est documentee |
| workspaces (`<projectDir>/.claude/koryphaios/`, et l'ancien `.claude/claude-peers/` lu et entretenu sur place) | tuiles sauvegardees | hors `userData` | PROJET | OK par construction |
| cache peer-id (`~/.claude/peers/`) | `peer-id-<cwd>-<session>.txt` | cwd + session CC | -- | OK |
| journal / logs | `broker.log`, `server.log`, journal d'activite | aucune | MACHINE | a verifier (§10 Q4) |

### 4.1 Les deux fuites, decrites precisement

**F1 -- inbox operateur.** `InboxMessage` (`desktop/src/shared/types.ts:1584`)
ne porte ni groupe ni projet ; `loadInboxHistory(stateDir)` rend tout ; le
canal `inbox:history` le sert au renderer sans filtre. Consequence : les
messages que les agents d'AiDex adressent a l'operateur apparaissent dans le
panneau du Kory ouvert sur Kleos. Deux effets secondaires du meme defaut : le
plafond `INBOX_HISTORY_CAP = 500` fait **evincer** l'historique d'un projet par
le trafic de l'autre, et `inbox-ack.json` etant lui aussi commun, acquitter
d'un cote marque de l'autre.

**F2 -- revue de diff.** `review-pending.json` porte UNE revue en attente pour
toute la machine (`readReviewState(file)` / `clearReviewState(file)`,
`ipc.ts:444-470`). Deux fenetres se remplacent l'une l'autre, et la revue
ouverte dans un depot peut s'afficher dans l'autre.

### 4.2 Ce que le correctif ne doit PAS casser

Les portees PROJET listees OK sont voulues : deux Kory sur le meme depot
partagent roadmap, graphe, approbations et workspaces. La regle « meme depot =
meme etat de projet » reste vraie ; seule la portee SESSION se separe.

---

## 5. Mecanisme retenu pour la portee SESSION

**DECIDE** -- un fichier par groupe, dans un sous-dossier dedie, sur le modele
exact de `scope-secrets.json` (deja clee par `groupId`, §4) :

```
userData/config/sessions/<groupId>/inbox-history.json
userData/config/sessions/<groupId>/inbox-ack.json
```

- `<groupId>` est deja un sha256 tronque a 32 hex : sur du nom de fichier, sans
  echappement, sans collision de casse.
- Un sous-dossier par groupe plutot qu'un suffixe : le nettoyage devient un
  `rm -r` d'un repertoire, et un futur etat de portee SESSION s'y ajoute sans
  nouvelle regle.
- Les fonctions de `inbox-store.ts` prennent deja `stateDir` en parametre : le
  changement est **un seul appelant** a modifier par fonction, pas une
  reecriture. Les signatures deviennent `(sessionDir)` ou le Deck passe
  `sessionStateDir(stateDir, groupId)`.

**DECIDE** -- aucun etat de portee SESSION ne survit a la fermeture, quel que
soit le genre de scope (§1). Le dossier est un cache de la session en cours,
jamais un historique.

**DECIDE** -- pas de migration des fichiers existants. Le contenu actuel est un
melange non attribuable de plusieurs groupes : le repartir serait deviner. Le
fichier historique est **supprime** au premier demarrage qui applique la
nouvelle disposition, avec une ligne de journal disant combien d'entrees ont
ete jetees. Un historique de notifications deja lues n'a pas la valeur d'un
reglage ; le rejouer faussement attribue serait pire que le perdre.

---

## 6. Duree de vie et nettoyage

C'est la moitie du lot, pas un detail : sans elle, l'isolation fabrique une
fuite de disque (un dossier par demarrage de Kory).

**DECIDE** -- trois regles cumulatives :

1. **Sortie propre** : a la fermeture de la fenetre, le dossier de son groupe
   est supprime -- `ephemeral` comme `custom`, sans exception (§1 : la
   stabilite de la cle ne vaut pas stabilite des peers indexes). Aucune
   branche conditionnelle sur `scopeKind` : une seule regle, donc aucun
   chemin ou un etat survivrait par omission.
2. **Balayage au demarrage** : tout dossier de `sessions/` dont le `mtime` est
   plus vieux que `KORY_SESSION_STATE_TTL_DAYS` (defaut 7) est supprime. C'est
   le filet des sorties non propres (crash, arret machine) -- le seul chemin
   par lequel un dossier survit a sa fenetre. La presence d'un secret dans
   `scope-secrets.json` n'exempte RIEN : ce fichier sert a rejoindre un
   groupe, pas a conserver ce qu'il a recu.
3. **Jamais pendant qu'une autre fenetre tourne** : le balayage ne supprime que
   des dossiers dont le `mtime` est plus vieux que le TTL, jamais « tous les
   groupes que je ne connais pas » -- une seconde fenetre vivante possede un
   groupe que celle-ci ignore, et le supprimer effacerait son inbox sous ses
   pieds. C'est l'instance exacte de la regle « et s'il y en a deux ? » de
   `CLAUDE.md`.

---

## 7. Ce que ce lot ne resout PAS

**Le dernier-ecrivain-gagne subsiste** sur les fichiers de portee MACHINE et
PROJET partages par deux fenetres. Cleer n'est pas verrouiller : deux fenetres
sur le MEME depot ecrivant `approvals.json` se perdent toujours une
modification l'une l'autre. Le verrou fichier inter-processus livre pour
`config.json` (`peers-config-store.ts`) est le patron a generaliser, mais c'est
un lot distinct dont l'urgence est moindre : il n'y a pas de fuite, seulement
une perte, et seulement entre deux fenetres du meme depot.

**Le verrou mono-instance Electron** (`requestSingleInstanceLock`) reglerait la
classe entiere par construction -- un seul processus ecrivain. Il est REFUSE
ici : il transformerait deux `kory` lances dans deux depots en deux fenetres
d'un meme processus, ce qui remet en cause `parseCliContext`, la portee des
sessions et le modele « une fenetre = un scope » sur lequel tout ce brief
repose. A n'envisager qu'avec son propre brief.

---

## 8. La garde : rendre la classe fail-closed

**DECIDE** -- le vrai livrable n'est pas la correction des deux fuites, c'est
qu'une TROISIEME ne puisse pas naitre en silence. Sans garde, le prochain
magasin ecrit sous `stateDir` sans cle reproduira le defaut, et rien
n'echouera.

Test de discipline (`tests/desktop-state-scope.test.ts`), sur le modele du
test de pick-list de `toPublicPeer` livre avec la federation :

1. Balayer `desktop/src/main/**/*.ts` pour tout litteral de nom de fichier
   ecrit sous `stateDir` / `APP_STATE_SUBDIR` (les appels a `writeFileAtomic`,
   `writeFileSync` et les constantes `FILE` / `*_FILE` de chaque module).
2. Exiger que CHAQUE nom trouve figure dans une table de classification
   `STATE_SCOPES: Record<string, { scope: 'session'|'project'|'machine',
   reason: string }>` portee par le test, avec une raison d'au moins N
   caracteres -- une classification sans motif n'est pas une decision.
3. Exiger que tout fichier classe `session` vive sous `sessions/<groupId>/`
   (verification sur le chemin construit, pas sur le nom seul).
4. **Prouver que la garde mord** : une mutation (ajouter un fichier non classe,
   deplacer un fichier `session` hors du dossier par groupe) doit rendre le
   test rouge. Cette preuve est DANS le diff, pas dans une sonde jetee --
   `TESTING.md` : « une sonde mesuree rouge puis laissee hors du commit n'est
   pas une garde ».

Audit de COUVERTURE de la garde elle-meme, a documenter dans le test : le
balayage par litteraux echoue OUVERT sur un nom de fichier CALCULE
(`` `${prefix}-${id}.json` ``). Deux noms de ce genre existent deja
(`approvalCredFileName`, `teamLeadMcpConfigFileName`) : ils doivent etre
classes par leur FONCTION constructrice, et le test doit exiger que toute
fonction rendant un nom sous `stateDir` figure elle aussi dans la table.

---

## 9. Tests fonctionnels

Au-dela de la garde de discipline, trois tests de comportement (modules purs,
repertoires injectes -- aucun import d'electron, conformement aux suites
`desktop-*` existantes) :

1. **Isolation** : deux `groupId` distincts, une entree ecrite dans chacun ;
   chaque lecture ne rend que la sienne. Assertion nommant ce qu'elle garde :
   « l'inbox d'un groupe n'est jamais lue par un autre ».
2. **Plafond par groupe** : le cap de 500 s'applique PAR groupe, un groupe
   bavard n'evince pas l'historique d'un autre.
3. **Nettoyage** : un dossier ephemere est supprime a la sortie propre ; un
   dossier orphelin plus vieux que le TTL est balaye ; un dossier orphelin
   RECENT (une autre fenetre vient de demarrer) SURVIT -- c'est le cas « et
   s'il y en a deux ? », a poser rouge d'abord.

---

## 10. Lots d'implementation, dans l'ordre

| Lot | Contenu | Pourquoi cet ordre |
|---|---|---|
| **A** | `sessionStateDir(stateDir, groupId)` + bascule de `inbox-history.json` et `inbox-ack.json` + suppression du fichier historique + tests 9.1 et 9.2 | ferme F1, la fuite que l'operateur juge inacceptable |
| **B** | Nettoyage (§6) + test 9.3 | sans lui, A fait grossir le disque a chaque demarrage ; A et B ne devraient pas etre separes de plus d'un lot |
| **C** | `review-pending.json` bascule en portee PROJET, clee par `project_key` comme `approvals.json` | ferme F2 |
| **D** | Garde de discipline (§8) + classification des fichiers existants | rend la classe fail-closed ; en dernier parce qu'elle exige que A a C aient fixe la disposition |
| **E** | Documentation : `DESKTOP.md` (une regle de portee), `BACKLOG.md` (items coches, residuels du §7) | -- |

Lot A + B est le minimum livrable coherent. D est ce qui empeche le probleme
de revenir et ne doit pas etre repousse indefiniment.

---

## 11. Arbitrages et questions restantes

| # | Question | Proposition | Alternative |
|---|---|---|---|
| Q1 | Un scope `custom` conserve-t-il son inbox entre deux lancements ? | **TRANCHE (operateur, 2026-09-06) : NON**, l'ephemerite est inconditionnelle -- la cle est stable, les peers qu'elle indexe ne le sont pas (§1) | -- |
| Q2 | Portee de `review-pending.json` | **TRANCHE (operateur, 2026-09-06) : PROJET** (`project_key`) -- une revue de diff appartient au depot, pas a la fenetre, et la retrouver au redemarrage a de la valeur | -- |
| Q3 | Deux fenetres ouvrant le companion (📱) | hors perimetre, a verifier separement : elles se disputent un port et un certificat | traiter dans ce lot |
| Q4 | Journal d'activite et logs | a inventorier : je ne les ai pas audites, ils sont probablement de portee MACHINE et sans fuite de contenu sensible entre projets | -- |
| Q5 | `sessions.json` (ecriture seule, legacy) | le supprimer : plus rien ne le lit, il ne fait qu'ajouter une ecriture concurrente | le laisser, inerte |
| Q6 | TTL de balayage | 7 jours | plus court (24 h) : le dossier ne survit qu'a une sortie non propre (Q1), donc un TTL court ne fait perdre que le rattrapage d'un crash suivi d'une semaine sans relancer |

---

## 12. Refuse ou differe

- **Verrou mono-instance Electron** : refuse ici (§7), a cadrer separement.
- **Verrou fichier generalise a tous les magasins partages** : differe (§7) --
  perte silencieuse entre deux fenetres du meme depot, jamais une fuite entre
  depots ; priorite moindre.
- **Migration du contenu de l'inbox existante** : refusee (§5) -- non
  attribuable, donc devinee.
- **Cloisonner la base du broker par groupe** (un fichier SQLite par groupe) :
  refuse. Le broker est un demon de MACHINE servant plusieurs groupes et
  plusieurs projets par construction, et ses filtres `WHERE` sont deja
  audites route par route. Cloisonner casserait la federation, la roadmap
  partagee et le mode replica pour un gain nul.
