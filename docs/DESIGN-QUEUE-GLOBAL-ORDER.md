# Ordre de dispatch global : conception revisee (carte f12e34f1)

Revision 2 du 2026-09-09, apres quatre arbitrages relayes par le team-lead.
La revision 1 est conservee dans ses parties intactes ; ce qui tombe est nomme
en §1, avec sa raison.

Etiquetage : MESURE (commande jouee, sortie citee), DEDUIT (lu dans le code,
`fichier:ligne`), SUPPOSE (non verifie).

---

## 1. Ce que la revision change, ce qu'elle ne change pas

Les quatre arbitrages ne portent pas sur le meme objet. Deux tiennent, un doit
etre amende, un est deja viole par du code livre.

| # | Arbitrage | Verdict | Ou |
|---|---|---|---|
| 1 | Le mode mixte est supprime, l'ordre est toujours global | **Sans objet** : le mode mixte n'a jamais existe dans le document | §1.1 |
| 1bis | Reordonner exige de DETENIR LE VERROU du lot | **Infaisable tel quel** : le lot n'existe pas comme objet | §2 |
| 2 | Le predicat de verrou coupe en deux | **Tenable, et moins cher que prevu** -- mais ce n'est pas un refactor | §3 |
| 3 | Detenir un lot donne autorite sur ses cartes | **Tenable a une granularite plus petite, disponible aujourd'hui** | §2.4 |
| 4 | Le TTL reste en filet, reutiliser `workspace-lock.ts` | **Le filet existe deja et il est meilleur ; la contrainte de heartbeat local est deja violee** | §4 |

### 1.1 Le mode mixte n'a jamais existe dans ce document

MESURE : `grep -c -i "mixte" docs/DESIGN-QUEUE-GLOBAL-ORDER.md` -> `0`.

La revision 1 ne concoit aucune bascule ordre global / ordre local selon l'etat
du verrou, aucune fusion permanente, aucune poussee a la liberation. Elle part
de l'arbitrage OPTION A et ne le rediscute pas (revision 1, en-tete). L'option
F-B de son §3 n'est pas un mode mixte : c'est un ENREGISTREMENT unique de
l'ordre local au moment du basculement, avant qu'il ne soit remplace.

Consequence pratique : l'arbitrage 1 ne retire rien. Il AJOUTE une exigence
d'autorisation qui n'etait pas dans le perimetre. C'est le §2.

### 1.2 Ce qui reste valide sans modification

- **§0** (le precedent existe et il est double), **§2** (la boucle converge, et
  le cas non convergent des quatre branches de `applyPulledRow`), **§3.4** (les
  `sync_base` deja stockes deviennent illisibles), **§4** (amont d'abord,
  replicas ensuite ; cle `queue` absente = « ne touche pas la colonne »),
  **§6** (la sonde) : inchanges, repris tels quels ci-dessous en §5 et §7.
- **§1.2, le defaut D2** : `/roadmap/reorder` ouvre sa transaction par
  `UPDATE roadmap_items SET queue = NULL WHERE project_key = ?`.
  DEDUIT, `broker.ts:4239-4243`, relu integralement pour cette revision. Le
  handler reste un REMPLACEMENT DE TOUT L'ORDRE DU PROJET. Prerequis confirme.

### 1.3 Ce qui change dans la revision 1

- **§3, la fusion.** Le bloquant « nombre de replicas » est LEVE : l'operateur
  repond UN SEUL poste. Arbitrage operateur (V3) : pas d'enregistrement F-B --
  l'ordre des postes existants se reclasse a la main.
- **§5, le decoupage.** Passe de 3 lots a 4, avec l'autorisation en lot 4 et
  non en prerequis. §6 ci-dessous.

---

## 2. Le verrou de reordonnancement

### 2.1 Le lot n'existe pas, et cela n'est pas une question de vocabulaire

MESURE, arbre entier hors `node_modules`/`dist`/`out` :

    grep -rn -E "lot_id|roadmap_lots|/roadmap/lot" --include=*.ts --include=*.tsx .
    -> 5 occurrences, TOUTES dans tests/broker-roadmap-route-coverage.test.ts,
       et toutes citant une route /roadmap/lot/reorder PROPOSEE, jamais ecrite.

Zero occurrence en code produit. Aucune table, aucune colonne, aucune route.
MESURE : `ls WORKFLOW-LOTS-DESIGN.md` -> `No such file or directory` (le
`.gitignore` du depot exclut ce nom a toute profondeur, donc le document de
conception des lots n'est pas non plus sur ce checkout).

La carte `011d3547` qui porte les lots est en statut `idea`, effort `high`, et
depend de deux autres cartes (`39c40571`, `c33a5968`).

**Donc « reordonner un lot exige d'en detenir le verrou » ne designe aucun objet
existant.** Ce n'est pas un desaccord de conception : il n'y a rien a
verrouiller, et rien qui dise quelles cartes appartiennent a quoi.

Deuxieme point, qui compte autant : `011d3547` a DEJA tranche ce sujet, deux
fois. Le 2026-08-02 : « Pas de verrou propre au lot : les cartes en ont deja
un. » Le 2026-08-25, amendement operateur : le lot prend un **verrou
d'EXECUTION** porte par `group_id`, distinct de la reservation portee par
`operator_id`, et « ce n'est qu'a son traitement qu'il empeche qu'elle soit
modifiee live ». L'arbitrage 1bis est donc la SUITE de `011d3547`, pas une
exigence de `f12e34f1`. Le placer en prerequis de la synchronisation de `queue`
reviendrait a bloquer une perte quotidienne mesuree (`broker.log` : 2026-09-07,
09-08, et deux fois le 09-09) derriere une carte `idea` non commencee.

### 2.2 Ce que `/roadmap/reorder` verifie aujourd'hui : rien

MESURE : `sed -n '4139,4275p' broker.ts | grep -c -E "locked|matchesLockOwner"`
-> `0`. Le handler a ete lu en entier (`broker.ts:4139-4275`) : il valide
`project_key`, la taille, les doublons, l'existence, `done`/`archived`,
`inactive`, la forme de `waves` -- et **aucun verrou**.

Consequence directe, disponible aujourd'hui : un reorder peut deplacer, ou
desenfiler, le rang d'une carte qu'un agent d'un AUTRE groupe est en train de
travailler. C'est exactement l'obligation symetrique de l'arbitrage 3, un cran
plus bas, et elle ne demande aucun objet nouveau.

### 2.3 Options

**Option V-A -- l'autorite se DERIVE des cartes, aucun objet nouveau.**
Un reorder est refuse (409) s'il modifie le rang d'une carte `locked = 1` dont
`locked_group` n'est pas celui de l'appelant. Les cartes libres restent
reordonnables par tous. Cout : un predicat dans le handler, reutilisant les
colonnes `locked`/`locked_group` deja peuplees et deja balayees. Aucune table,
aucune route, aucune synchronisation, aucun TTL a concevoir. Reversibilite :
totale. Angle mort : deux postes qui reordonnent des cartes LIBRES en meme temps
ne sont pas departages -- le dernier ecrit gagne.

**Option V-B -- un verrou d'ordre broker, cle `project_key`.**
Nouvel objet : ligne detentrice (`peer_id`, `group`, jeton), routes
acquire/release, clause de balayage, relais cross-poste, entree au contrat de
synchronisation. Couvre l'angle mort de V-A. Cout : eleve, et il tombe droit
dans la regle « keyed by what, and what happens when there are two ? » de
CLAUDE.md -- cle par `project_key`, il declare qu'il existe UN ordre par projet,
alors que N lots auront N ordres. Il devra donc etre RE-CLE sur `lot_id` a
l'arrivee de `011d3547`, et la colonne `queue` elle-meme avec lui.

**Option V-C -- attendre `011d3547`.** Vocabulaire juste, cout nul a court
terme, mais la perte de rang mesuree continue quatre jours par semaine pendant
ce temps.

### 2.4 Recommandation : V-A maintenant, V-B avec les lots et jamais avant

La force qui tranche est le nombre de postes. Avec **un seul poste** (mesure
operateur), V-B ne protege de rien aujourd'hui : il n'existe pas de second
reordonnanceur a exclure. Ce qui peut mordre des aujourd'hui, en revanche, c'est
un reorder qui pietine une carte verrouillee -- et c'est precisement ce que V-A
ferme, avec les colonnes existantes, sans re-cle future : une carte membre d'un
lot restera une carte verrouillee, donc le predicat de V-A survit intact a
l'arrivee des lots et devient une des deux moities de l'obligation symetrique.

L'autre moitie -- « on ne peut pas verrouiller un lot dont une carte est deja
tenue par un autre groupe » -- est un controle a l'ACQUISITION, donc un
instantane. Si rien ne l'accompagne cote carte, il se degrade : rien n'empeche
une carte d'etre revendiquee par un autre groupe APRES la prise du verrou de lot,
puisque la garde d'ecriture de carte (`broker.ts:3503-3531`) ignore les lots. La
garantie de l'arbitrage 3 exige donc les DEUX cotes, et V-A est celui qui existe
deja. A porter tel quel dans le briefing de `011d3547`.

---

## 3. Le predicat coupe en deux

### 3.1 Etat mesure : il n'y a pas deux questions, il n'y en a qu'une

MESURE : `grep -rn "matchesLockOwner" --include=*.ts .` (hors `node_modules`,
`dist`) -> deux sites de code produit seulement, `broker.ts:3518`
(`handleRoadmapUpsert`) et `broker.ts:3835` (`handleRoadmapArchive`). Les autres
occurrences sont l'import, des commentaires et des tests.

Les deux repondent a la MEME question : « puis-je ecrire / revendiquer ». Il
n'existe aujourd'hui **aucun site** qui reponde a « puis-je liberer ou
reprendre ».

DEDUIT, `broker.ts:3503-3513` : liberer, c'est ecrire `status` different de
`in_progress`, et la garde se declenche sur `body.status !== undefined`. Au point
de garde, une liberation et une ecriture de statut sont **indiscernables**.

Donc couper le predicat en deux n'est pas un refactor d'un embranchement
existant : c'est **creer une intention** que le protocole ne porte pas. Sans
elle, les deux predicats ne peuvent pas etre choisis.

### 3.2 La capacite demandee existe deja, et elle est PLUS large

DEDUIT, `broker.ts:3520-3525` : la garde est contournee par
`body.force === true && author.proven`, sans aucune comparaison de groupe.
DEDUIT (`server.ts`, `roadmapProof()` etale sur les quatre sites d'ecriture
roadmap du serveur MCP) : tout agent reel est `proven`.

**Aujourd'hui, n'importe quel agent prouve, de n'importe quel scope, libere
n'importe quel verrou en ajoutant un champ.** L'arbitrage 2 (« sous le meme
scope tout le monde peut liberer, depuis un autre scope refus ») n'ouvre donc
aucune porte : il en RESTREINT une. C'est une bonne nouvelle sur l'effort, et un
changement de nature sur le deploiement : c'est une RESTRICTION d'API, donc
clients d'abord, broker en dernier.

### 3.3 Forme recommandee

1. **Une intention explicite.** Un champ `release: true` sur `/roadmap/upsert`,
   plutot qu'une route nouvelle : la surface companion (`companion.ts`) et les
   appelants ne bougent pas. Il ne doit PAS etre confondu avec `force` -- `force`
   revendique une certitude et vole a un tiers, `release` rend un verrou dans son
   propre scope. Deux champs, deux predicats, deux messages d'erreur.
2. **`matchesLockOwner` inchange** pour la question ECRITURE (couple
   `peer_id` + `locked_group`), y compris son fail-open documente sur
   `existingLockedGroup === null` (`shared/roadmap-lock.ts:197-207`).
3. **Un predicat de PORTEE, groupe seul**, pour `release` (et pour une reprise) :
   `existingLockedGroup === byLockedGroup`. Sur `existingLockedGroup === null`
   (ligne anterieure a la migration), **fail-CLOSED**, a l'inverse de
   `matchesLockOwner`. La raison est asymetrique et doit etre ecrite dans le
   code : le predicat d'ecriture fail-open pour ne pas refuser au vrai
   proprietaire sa propre carte -- il a une victime nommee ; le predicat de
   liberation n'en a pas, le cout d'une liberation ratee est nul (le balayage TTL
   du §4 reste), celui d'un verrou vole en silence ne l'est pas.
4. **Restreindre `force`** au meme mouvement : sinon la restriction du point 3
   est decorative, contournee par un champ.

### 3.4 Le cas que la conception doit nommer : quel « meme scope »

CLAUDE.md (regle ecrite ce jour) : le `group_id` d'une session Deck est le RUN
Kory, et cette isolation est un DEFAUT, pas une garantie -- avec `--scope` ou une
restauration de workspace, le groupe est IDENTIQUE d'un run a l'autre.

**Cette conception suppose le cas `--scope` / restauration**, c'est-a-dire le
pire : deux runs peuvent partager le groupe et etre vivants en meme temps. Sous
cette hypothese, la liberation par groupe seul permet a un run B de liberer le
verrou d'un agent vivant du run A. C'est le meme fail-open que `e344fa79` a ferme
un cran plus bas (l'homonyme `peer_id`), remonte au niveau du groupe.

Ce cout est ACCEPTE, et voici ce qui le rend acceptable -- a livrer avec :
- une liberation ne detruit rien : la carte retombe en `planned`, elle est
  reprenable ;
- une REPRISE (`release` + revendication) doit re-estampiller `locked_by`,
  `locked_group` et `locked_by_token`, de sorte que la prochaine ecriture de
  l'ancien detenteur echoue en 409 BRUYANT, au lieu que deux agents travaillent
  la meme carte en croyant chacun la tenir. C'est cette propriete, et non le
  predicat, qui rend la regle du groupe seul supportable.

---

## 4. Le TTL : le filet existe deja, et il est meilleur que celui demande

### 4.1 Ce qui est deja livre

DEDUIT, `broker.ts:1638-1717` (`releaseStaleLocks`, arme toutes les
`LOCK_SWEEP_SEC`) : **trois clauses**, pas un TTL nu.

1. TTL d'inactivite : aucune ecriture sur la carte depuis `LOCK_TTL_SEC`
   (defaut 21600 s, `broker.ts:249`).
2. Detenteur disparu : `NOT EXISTS` sur `peers` joint par
   `peer_id + project_key`, **avec le terme de groupe**
   (`locked_group IS NULL OR p.group_id IS locked_group`, `broker.ts:1706`) et
   une vivacite `status = 'active' OR last_seen >= now - LOCK_GRACE_SEC`
   (defaut 600 s).
3. Expiration du park (`LOCK_PARK_TTL_SEC`), qui mord meme si le detenteur vit.

Un verrou de portee `remote` (miroir d'un verrou amont) est exempte des trois,
dans un helper partage, « so a fourth clause inherits the exemption »
(`broker.ts:1645-1650`).

Donc la crainte « ne concois pas un TTL nu » vise un objet qui n'existe pas : le
verrou de carte a deja deux signaux de vivacite combines plus une exemption de
portee. La citation demandee, c'est celle-la.

### 4.2 `workspace-lock.ts` : la FORME se reutilise, les ENTREES n'existent pas

DEDUIT, `desktop/src/main/workspace-lock.ts:105-113` : `isLockLive` combine
`startedAt < bootInstant - 2000 ms`, `heartbeat <= now - staleMs`, et sur
indecision retombe sur `isPidAlive(pid)`.

Deux obstacles a la reutilisation litterale :

- **Les entrees.** `roadmap_items` stocke `locked_by`, `locked_group`,
  `locked_by_token`, `locked_at`. Ni `pid`, ni `host`, ni `startedAt`. Les trois
  signaux du predicat sont des faits de PROCESSUS LOCAL ; le broker ne les tient
  que par jointure sur `peers` -- ce que la clause 2 du §4.1 fait deja, en
  remplacant `isPidAlive` par la presence du pair.
- **La frontiere.** `workspace-lock.ts` est un module `desktop/`, bati par
  electron-vite/npm ; `broker.ts` tourne sous bun. Une importation croisee est un
  risque d'empaquetage, pas une economie. Le precedent du depot pour ce cas est
  `shared/roadmap-lock.ts` : module pur, sans I/O, consomme des deux cotes.

**Recommandation.** Ne pas dupliquer `isLockLive` dans le broker. Le seul signal
que `workspace-lock.ts` apporte et que la clause 2 n'a pas est l'**instant de
boot** (il distingue « le pair a disparu » de « la machine a redemarre »). Il
n'a de valeur que pour un detenteur same-host. Si le lot 4 introduit un verrou
d'ordre detenu par un Deck (option V-B, differee), c'est a ce moment-la qu'on
extrait le predicat vers `shared/`, jamais avant : aujourd'hui il n'aurait aucun
appelant.

### 4.3 REFUTATION : la contrainte « heartbeat contre le broker LOCAL » est deja violee, par du code livre

C'est le point le plus dur de cette revision.

DEDUIT, `broker.ts:1611-1627` (`RELAY_HEARTBEAT_FRESH`) et `broker.ts:5338-5346`
(`relayHoldsLock`) : un verrou tenu par l'agent d'un REPLICA est RELAYE cote
amont. Il n'a la-bas ni ligne `peers`, ni ecriture locale rafraichissant
`updated_at`. Son unique signal de vivacite est `lock_relay_seen`, « rewritten by
every claim of its replication pass ». Le commentaire l'ecrit noir sur blanc :
« Once the replica goes quiet for LOCK_GRACE_SEC the lock falls exactly like an
abandoned local one. »

Autrement dit : **le battement d'un verrou de replica EST la passe de
replication, donc il bat contre l'amont, par construction.** Une coupure reseau
de `LOCK_GRACE_SEC` (600 s par defaut) fait tomber cote amont le verrou d'un
agent qui travaille -- exactement le mode d'echec que l'arbitrage 4 veut
interdire.

DEDUIT et non mesure, un cran plus loin : la liberation cote amont est un
changement de contenu (`status` -> `planned`, `locked` -> 0) ; la passe de pull
la rapporte au replica a la reconnexion, et `isSweepOnlyStatusChange` (cite en
revision 1 §3.4) l'auto-resout sans conflit operateur. Le verrou serait donc
retire au poste coupe, silencieusement, a son retour.

**Ce que j'en conclus.** La contrainte de l'arbitrage 4 n'est pas une consigne
pour la conception a venir : c'est un DEFAUT existant du relais de verrou, hors
perimetre de `f12e34f1`, et qui merite sa propre carte. Elle ne peut pas etre
« respectee » par ce lot, puisque ce lot n'introduit aucun heartbeat. Le
formuler comme une exigence de conception ferait croire qu'elle est satisfaite.

C'est la mesure la plus rentable a faire avant d'ecrire quoi que ce soit :
deux brokers, `SYNC_TICK_MS` court et `CLAUDE_PEERS_LOCK_GRACE_SEC` a quelques
secondes, prendre un verrou cote replica, couper, attendre, verifier cote amont
puis a la reconnexion. La sonde a deux brokers du §7 fournit deja tout le
harnais.

---

## 5. La fusion (revision 1 §3), mise a jour

Le bloquant est leve : **un seul poste**. La fusion initiale est donc un
non-evenement, et l'option F-A (fusion automatique par report du bloc local) est
d'autant plus a ecarter -- son risque redhibitoire (avec N replicas, l'ordre
final depend de l'ordre des montees de version) se paierait pour un benefice nul.

**Arbitrage operateur (V3) : pas de F-B.** L'amont gagne, sans enregistrement
prealable de l'ordre local -- l'ordre des postes existants se reclasse a la
main.

Sous V3, `queue` ne rejoint jamais `RoadmapSyncContent` (§6) : le point de
detail de la revision 1 §3.4 sur `parseSyncContent` et les `sync_base` deja
stockes est SANS OBJET, aucune tolerance de parseur n'est necessaire.

---

## 6. Decoupage en lots (revision V3)

Quatre lots, ordre obligatoire, les lots 2 et 3 dans la meme livraison. Le
lot 2 ne prend plus la forme du §5 ci-dessus : `queue` NE REJOINT PAS
`ROADMAP_SYNC_CONTENT_FIELDS`. Un changement de rang doit rester SALE sans
jamais VERSIONNER le contenu -- deux notions que `roadmap_content_rev_au`
confondait avant V3 -- donc `queue` voyage par un trigger et un chemin de push
qui lui sont propres, et `ROADMAP_SYNC_CONTENT_FIELDS`, `pickSyncContent`,
`contentEquals`, `isSweepOnlyStatusChange` et `parseSyncContent` restent
INTACTS.

| # | Lot | Contenu | Pourquoi ici |
|---|---|---|---|
| 1 | **Reparation de `/roadmap/reorder`** | D1 (refuser sans `waves`) ; D2 (refuser un `ids` qui ne couvre pas l'ensemble enfile du projet) ; **V-A** (refuser le deplacement du rang d'une carte verrouillee par un autre groupe) ; appelants corriges AVANT le broker | prerequis du lot 2 : sans D2, un poste qui reordonne son sous-ensemble efface l'ordre des autres des que `queue` est pousse |
| 2 | **`queue` synchronise par un chemin separe (V3)** | trigger SQL `roadmap_queue_dirty_au` (`AFTER UPDATE OF queue`, `WHEN old.queue IS NOT new.queue AND NOT applying`, `SET sync_dirty = 1` seul, ne touche jamais `content_rev`) ; `RoadmapSyncPushItem` gagne un champ `queue?: number \| null` OPTIONNEL, hors du pick-list de contenu -- l'optionnalite est ce qui preserve le rang amont sur un push qui omet la cle ; `validatePushItem` valide `queue` (entier positif ou null, rejet de `NaN`) ; `syncPushPass` ajoute `queue: row.queue` a l'item pousse ; le SET et l'INSERT amont de `/roadmap/sync/push` ecrivent la colonne (l'INSERT forcait `NULL` en dur, c'est le trou reel ferme par ce lot) | apres le 1 |
| 3 | **Capteur** | pas d'instantane de l'ordre local a la bascule : l'ordre des postes existants se reclasse a la main ; `queue_replaced` et son toast restent en l'etat (mecanisme inchange, frequence residuelle -- voir §8bis) | meme livraison que le 2 |
| 4 | **Liberation par la portee** | champ `release` explicite ; predicat de portee groupe-seul, fail-CLOSED sur `locked_group` null ; re-estampillage a la reprise ; **restriction de `force`** ; clients d'abord, broker en dernier | independant des trois premiers ; c'est une RESTRICTION de ce qui est ouvert aujourd'hui, donc il ne bloque rien |

**Resolu (V6) :** `applyPulledRow` derivait sa branche fast-forward / conflit
du seul booleen `sync_dirty`, qui sous V3 devient vrai aussi pour un
changement de RANG seul. Une carte dont le rang etait sale localement et dont
le CONTENU bougeait independamment en amont (deux changements disjoints)
tombait alors dans la branche de conflit au lieu du fast-forward. Corrige par
deux hunks qui comparent le CONTENU au CONTENU, dans le meme espace (jamais
`content_rev` contre `sync_base_rev`, deux compteurs d'espaces differents qui
peuvent coincider par hasard sur une paire neuve) : `dirty` compare le
contenu local a son propre `sync_base` parse ; `recordPushDivergence` laisse
passer sans conflit un push refuse pour `content` dont le contenu local
egale deja son `sync_base`.

**Limite acceptee, reduite.** Le reorder d'une replique ne passe plus par le
push ligne a ligne : il est journalise dans `roadmap_queue_outbox` dans la
transaction qui l'ecrit, puis envoye par `/roadmap/sync/queue-delta` apres la
passe de contenu (`DESIGN-ROADMAP-QUEUE-DELTA.md`, « Cote replique »). Il ne
depend plus du contenu des cartes : une edition amont ne fait plus perdre le
rang local, et un echange de deux cartes finit au meme ordre des deux cotes
quel que soit l'ordre du pull et du push. Tant que le journal d'un projet
n'est pas vide, le pull n'ecrit aucun rang de ce projet. Un refus de l'amont
remet les rangs amont, et `queue_replaced` compte ces rangs remis : la perte
d'un ordre local n'est jamais silencieuse.

Ce qui reste de la limite : un rang ecrit par un autre chemin que le reorder
(upsert avec `queue`, import) part encore par `/roadmap/sync/push`, et pour
ces cartes UNE LIGNE AMONT LIVREE PAR LE PULL AVANT QUE LE PUSH DU RANG N'AIT
ETE ACQUITTE ecrase le rang local, y compris quand ce push a ete refuse parce
que le contenu avait bouge. Le contrat reste celui du compteur
`queue_replaced` existant : toute ligne amont livree par le pull ecrase alors
le rang local, et le toast informe l'operateur.

Une seule ligne tiree n'ecrase pas le rang local : l'echo du propre push de la
replique, une fois ce push acquitte, quand il rend exactement le rang que ce
push a envoye et un `content_rev` egal a la base acquittee. Un rang deplace
localement pendant l'aller-retour survit alors et part au push suivant, et
`queue_replaced` ne bouge pas. Le rang envoye est retenu en memoire, par
carte : apres un redemarrage, ou si l'amont a lui-meme deplace le rang entre
temps, la regle ci-dessus s'applique sans exception.

**Hors de ce decoupage, a porter ailleurs :**
- Le verrou d'ordre broker (option V-B) part dans le briefing de `011d3547`,
  avec l'obligation symetrique et la note de re-cle `project_key` -> `lot_id`.
- Le heartbeat de relais qui bat contre l'amont (§4.3) merite sa propre carte.
- `handleRoadmapImport` fait un `INSERT OR REPLACE` sans verification de verrou
  (carte `40ddf1f5`, deja ouverte) : tant qu'il vit, toute garde de verrou est
  contournable par ce chemin.

### Surfaces a ne pas oublier

- `validatePushItem` (`broker.ts`) valide desormais `queue` : entier positif
  ou null, rejet de `NaN` et des non-entiers -- meme predicat que celui de
  `/roadmap/upsert`, partage via `isValidQueueRank` (`shared/roadmap-queue.ts`).
- `desktop/src/shared/companion.ts:71` expose `roadmap:reorder` au canal
  companion : sous un ordre global, un client distant reordonne pour tous les
  postes. Le predicat V-A du lot 1 s'applique a ce chemin aussi.

### Sans objet sous V3

Ces points, mesures sous la forme anterieure ou `queue` rejoignait
`ROADMAP_SYNC_CONTENT_FIELDS`, ne s'appliquent plus : la structure meme qu'ils
visaient a corriger n'existe pas sous V3.

- **N2** (test `tests/desktop-roadmap-sync-service.test.ts`, assertion
  `.not.toContain("queue")` sur les cles de la base commune) : reste CORRECTE
  telle quelle, `queue` n'entre jamais dans `RoadmapSyncContent`.
- **N3** (les commentaires "fifteen columns" citant `ROADMAP_SYNC_CONTENT_FIELDS`,
  cote coeur et cote Deck, plus `roadmap_content_rev_au`) : restent VRAIS,
  aucune edition. Seuls trois commentaires decrivant l'ANCIEN comportement
  ("queue is never pushed") ont ete reecrits : le SET du push, le compteur
  `syncQueueReplacedTotal`, le toast du renderer.
- **N5** (tolerance de `parseSyncContent` aux `sync_base` anterieurs) :
  `parseSyncContent` n'a pas change de contrat, aucune migration necessaire.
- **Cle i18n `roadmap.sync.field.queue`** : `conflictFieldDiffs`
  (`desktop/src/shared/roadmap-sync.ts`) boucle exclusivement sur
  `ROADMAP_SYNC_CONTENT_FIELDS` ; `field` ne peut structurellement jamais
  valoir `'queue'`, la cle ne sera jamais demandee.

---

## 7. Ce que la sonde doit rendre apres correctif

Reproduction a deux vrais brokers, reutilisee telle quelle (`tests/_helper.ts
startBroker`, amont `SERVE_REPLICAS=1`, replica `OFFLINE_REPLICA=1` +
`SYNC_TICK_MS=150`, bases `mkdtemp` separees, attente de `pending_push === 0`
avant tout controle negatif).

- CASE A (`queue` seule) : le rang survit, et devient visible cote amont.
- CASE B (`status` + `queue`) : le rang **survit** et apparait cote amont.
  Assertion centrale du lot 2.
- CASE C (le passant) : le rang de la carte non nommee survit apres plusieurs
  allers-retours.
- CASE D (ferme D2) : le poste A range 5 cartes, le poste B en range 2 qu'il est
  seul a connaitre ; apres convergence, les 7 rangs existent des deux cotes.
- CASE E (convergence) : apres une ecriture de rang, aucune ligne sale au bout de
  3 passes.
- CASE F, nouveau (ferme V-A) : un reorder emis par le groupe G2 qui deplace le
  rang d'une carte verrouillee par G1 est refuse 409 ; le meme reorder sur des
  cartes libres passe. Montre ROUGE contre le code actuel d'abord --
  `handleRoadmapReorder` ne lit aucun verrou aujourd'hui.
- CASE G, nouveau (lot 4) : `release` depuis un pair du meme groupe libere ;
  depuis un autre groupe, refus ; et apres reprise, l'ecriture de l'ancien
  detenteur echoue en 409.

---

## 8. Ce qui reste SUPPOSE

- **Le heartbeat de relais (§4.3).** Que la liberation amont d'un verrou relaye
  revienne effacer le verrou local a la reconnexion est DEDUIT de
  `broker.ts:1611-1627` et de `isSweepOnlyStatusChange`, **pas reproduit**.
  C'est la premiere mesure a faire, et elle peut ouvrir une carte a elle seule.
- **La completude de `src.all`** dans les constructeurs de charge du Deck
  (`buildAppendToQueue` lit `queuedItems(src.all)`,
  `desktop/src/shared/workflow.ts:541`). Si cette liste est un sous-ensemble
  FILTRE, le Deck declenche D2 lui-meme a chaque glisser-deposer sous filtre.
  Premiere chose a mesurer dans le lot 1.
- **Le recensement des appelants de `/roadmap/reorder` hors Deck** (CLI, MCP,
  scripts). Exige par le briefing de la carte, non refait ici : les 4 sites
  connus sont les sites Deck, pas l'ensemble.
- **Que tout agent reel soit `proven`** (§3.2) est DEDUIT de `roadmapProof()`
  cote `server.ts`, non rejoue dans cette session. Si un chemin d'ecriture non
  prouve subsiste, la restriction de `force` du lot 4 change de gravite.
- **L'asymetrie inverse** (l'amont porte deux rangs que le replica n'a pas)
  reste expliquee par le filtre `rev > curseur` du pull (`broker.ts:5161`),
  DEDUITE, pas reproduite.
- **Que le cas suppose au §3.4 soit le bon.** La conception prend le pire
  (`--scope` / restauration : groupes identiques entre runs). Si l'operateur
  garantit qu'aucun `--scope` explicite ni aucune restauration de workspace n'est
  employe, la liberation par groupe seul devient sans risque et le
  re-estampillage a la reprise peut etre allege.
