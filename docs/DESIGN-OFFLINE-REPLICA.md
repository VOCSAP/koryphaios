# Mode replica : broker local repliquant un broker distant (roadmap hors ligne)

## Statut

Brief ecrit le 2026-09-05 a partir d'un brainstorm operateur/architecte. Il
fixe les decisions et le contrat de protocole que le lot d'implementation
suit ; les arbitrages non tranches sont listes en §9, les extensions
refusees ou differees en §10 (et dans `BACKLOG.md`).

Etiquettes : **MESURE** (commande executee, sortie citee), **DEDUIT** (lu dans
le code, `file:line`), **DECIDE** (arbitrage operateur du 2026-09-05).

---

## 1. Le besoin et ce que le code fait aujourd'hui

Un operateur configure `broker_url` vers un broker central (plusieurs PC sur
une meme roadmap) et doit pouvoir travailler HORS de ce reseau sans VPN.
Attendu : aucune interruption pour les agents de la machine, roadmap lisible
et modifiable, reconciliation a la reconnexion, conflits arbitres par
l'operateur.

**MESURE** (`server.ts:175-205`) -- `ensureBroker()` leve une exception quand
`broker_url` n'est pas loopback et est injoignable : le MCP claude-peers de
chaque session meurt au demarrage. Aucun repli.

**DEDUIT** (`desktop/src/main/roadmap-service.ts`, `roadmap-data.ts:76-97`) --
le Deck ne persiste rien : il interroge `/roadmap/list` toutes les 5 s. Il
n'existe donc AUCUNE base locale a reconcilier ; il faut d'abord en creer une.

**DEDUIT** (`broker.ts:179-183`) -- le broker lit lui-meme `loadConfig()` :
`broker_url` et `broker_token` sont deja visibles du processus broker.

**DEDUIT** (`tests/_helper.ts:33`) -- `startBroker(env)` lance un broker par
processus avec des variables d'environnement propres : deux brokers dans un
meme test (upstream + replica) sont possibles sans nouveau harnais.

---

## 2. Architecture retenue : un broker local, l'upstream devient sa source

**DECIDE** -- Option A. En mode `replica`, les clients (`server.ts`, Deck,
`cli.ts`) parlent TOUJOURS a `127.0.0.1:<port>`. Le broker local porte la
replication vers `broker_url` (son *upstream*) en tache de fond. Une coupure
reseau est invisible des clients ; les peers d'une meme machine continuent de
se parler.

Option B (failover client : primaire distant, secours local) est REFUSEE :
elle impose une bascule visible (re-enregistrement, nouveau `instance_token`,
reconnexion WS) dupliquee dans trois clients, et perd tout message emis
pendant la fenetre de bascule.

### 2.1 Trois modes explicites, `replica` en opt-in

| Mode | Config | Comportement |
|---|---|---|
| `local` | pas de `broker_url` | inchange : broker loopback auto-spawne |
| `remote` | `broker_url` distant | inchange : clients directs sur le distant, echec si injoignable |
| `replica` | `broker_url` + `offline_replica: true` | broker local auto-spawne, `broker_url` devient son upstream, clients sur loopback |

**DECIDE** -- l'URL distante est une condition NECESSAIRE, pas suffisante :
inferer la replication de la seule presence de `broker_url` imposerait un
SQLite local, un demon et une synchro a tous les utilisateurs `remote`
existants. `offline_replica` (fichier) / `CLAUDE_PEERS_OFFLINE_REPLICA=1`
(env) est un booleen unique.

Regles derivees :

- `brokerMode(config)` dans `shared/config.ts` est la SEULE fonction qui
  decide du mode. `brokerUrl(config)` renvoie loopback sauf en mode `remote`.
- `resolveBrokerEndpoint()` (`desktop/src/main/broker-client.ts`) applique la
  meme regle ; un test de parite pose les trois combinaisons de part et
  d'autre.
- `ensureBroker()` (`server.ts`) garde sa garde `isLoopbackBrokerUrl` : en
  mode `replica` l'URL client EST loopback, donc le spawn local est permis
  sans autre changement. Le broker spawne relit la meme config et se decouvre
  replica.
- Un broker en mode `replica` refuse de demarrer (exit 1, message explicite)
  si son upstream est absent, inanalysable, ou loopback SUR SON PROPRE PORT :
  se repliquer sur soi-meme est une erreur de config, pas un cas a tolerer.
  Un upstream loopback sur un autre port reste permis : c'est la topologie
  deux-brokers-sur-une-machine, et celle des tests a deux brokers.
- Un broker `replica` refuse (403) de SERVIR les routes `/roadmap/sync/*`
  reservees a l'upstream : pas de chainage, pas de cycle.
- `/health` expose `mode` et, en replica, `upstream_online`.

### 2.2 Perimetre des tables

| Table | Politique v1 |
|---|---|
| `roadmap_items` | REPLIQUEE (contenu + file + verrous, voir §3-§5) |
| `peers`, `messages` | locales au broker (federation = §10) |
| `pending_approvals`, `dispatch_requests`, `graph_drafts`, operator inbox | locales : le Deck qui les consomme est sur la meme machine |

Consequence assumee : pendant une coupure, une approbation levee par un agent
local ne peut pas etre repondue depuis un autre Deck ni via un canal de
notification tenu par l'upstream.

### 2.3 Perimetre de replication

**DECIDE (2026-09-05)** -- une replica miroite TOUS les projets de son
upstream, pas seulement celui du Deck qui l'a demarree : le pull est
`rev > cursor` sur la table entiere, sans filtre `project_key`. Accepte : un
broker replica sert potentiellement plusieurs projets, `RoadmapSyncStatus`
(`conflicts`, `pending_push`) est donc un compteur GLOBAL au broker, pas par
projet. Seul le badge du rail Deck (§9) est filtre par projet courant --
`/roadmap/sync/conflicts` prend deja `project_key` en entree (§7) pour cet
usage. Filtrer le pull par projet cassait le cas multi-projets d'un seul
upstream sans rien simplifier cote protocole.

---

## 3. Modele de revision : entiers monotones, jamais des dates

**DECIDE** -- les deux dates (locale / broker) proposees au brainstorm sont
remplacees par des revisions entieres. **MESURE** (`broker.ts:1154`) -- le
code note deja que `updated_at` melange `datetime('now')` SQLite et ISO-8601 ;
deux horloges machine s'ajoutent en replica. Une egalite de timestamps est un
test qui rate en silence. De plus `updated_at` est deja le champ d'arbitrage
du sweep des verrous : le reutiliser couplerait deux mecanismes.

### 3.1 Colonnes ajoutees a `roadmap_items` (un seul schema, deux roles)

| Colonne | Role | Sens |
|---|---|---|
| `rev INTEGER NOT NULL DEFAULT 0` | les deux | bump a TOUT changement de colonne (curseur de pull) |
| `content_rev INTEGER NOT NULL DEFAULT 0` | les deux | bump a un changement de CONTENU (§3.2) |
| `sync_base_rev INTEGER` | replica | `content_rev` upstream de la base ; NULL = jamais synchronisee |
| `sync_base TEXT` | replica | JSON des champs de contenu a la base (fusion a trois voies) |
| `sync_dirty INTEGER NOT NULL DEFAULT 0` | replica | contenu modifie localement depuis la base |
| `sync_state TEXT NOT NULL DEFAULT 'clean'` | replica | `clean` / `conflict` |
| `sync_remote TEXT` | replica | JSON de la ligne upstream au moment du conflit |
| `lock_scope TEXT` | replica | `local` / `global` / `contested` / `remote` / `release_pending` ; NULL sinon |
| `lock_relay TEXT` | upstream | `replica_id` qui porte ce verrou pour un agent distant |
| `lock_relay_seen TEXT` | upstream | dernier heartbeat du relais (ISO) |
| `lock_contested_by TEXT NOT NULL DEFAULT '[]'` | upstream | JSON `["<peer_id>@<replica_id>", ...]` |
| `lock_release_owner TEXT` | replica | `locked_by` au moment de la relache locale : le trigger de relache tourne apres que `locked_by` est NULL, et l'upstream refuse une relache dont il ne peut pas apparier l'owner |

Plus une table `roadmap_sync_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)`
portant `rev_seq`, `replica_id`, `upstream_cursor`, `applying` (remis a `0`
a chaque demarrage : un flag reste colle ferait taire le marquage dirty) et
`mode` (lu par les triggers de portee de verrou, actifs seulement en replica).

Toute colonne ajoutee entre dans `ROADMAP_IMPORT_COLUMNS` (`shared/types.ts`) :
le test de discipline compare la liste au schema vivant et echoue sinon.

### 3.2 Colonnes de CONTENU (les 15 qui decident d'un conflit)

`kind, title, description, rationale, context, priority, value, effort,
status, tags, depends_on, deleted_at, directive, target_peer_ids, inactive`.

EXCLUS du contenu, et pourquoi :

- `queue` : ordre PAR PROJET, pas attribut de carte (§4).
- `locked*`, `lock_parked*`, `lock_relay*`, `lock_contested_by` : protocole
  separe (§5). Sinon chaque prise de verrou salit la carte et fabrique des
  conflits fantomes.
- `updated_by`, `updated_at`, `created_by`, `created_at` : voyagent AVEC le
  contenu mais ne le definissent pas. **DEDUIT** (`broker.ts:3569-3589`) --
  un simple reorder tamponne `updated_by`/`updated_at` ; les compter comme
  contenu rendrait toute reorganisation de file upstream conflictuelle.
- `operator_id` : ne traverse JAMAIS la frontiere (preuve de signature, §6).

### 3.3 Triggers SQLite : la couverture par construction

**DECIDE** -- `rev`, `content_rev` et `sync_dirty` sont tamponnes par des
triggers `AFTER INSERT` / `AFTER UPDATE` sur `roadmap_items`, pas par un
helper appele depuis chaque handler. Un helper echoue OUVERT le jour ou un
nouveau chemin d'ecriture l'oublie ; un trigger couvre `/upsert`, `/archive`,
`/append-context`, `/reorder`, `/import`, le sweep et tout handler futur.

**DECIDE (2026-09-05)** -- la promesse "un trigger couvre tout handler futur"
est SURESTIMEE pour `/roadmap/import` : la route ecrit par `INSERT OR
REPLACE`, qui ne declenche QUE le trigger `AFTER INSERT` (SQLite traite un
REPLACE comme un DELETE puis un INSERT, jamais un UPDATE). Le bump
`content_rev`/`sync_dirty` de la clause `AFTER UPDATE OF <15 colonnes>` ne
tourne donc jamais sur un import qui ecrase une carte existante. Correction :
`/roadmap/import`, cote handler, compare le contenu ecrit a l'ancien avant le
`INSERT OR REPLACE` et pose `sync_dirty = 1` explicitement quand il differe --
seule route ou le trigger ne suffit pas, et donc seule ou un bump manuel est
justifie plutot qu'un helper generalise.

- `AFTER INSERT` : `rev = content_rev = next(rev_seq)`.
- `AFTER UPDATE` (toute colonne hors `rev`, `content_rev`, `sync_*`,
  `lock_relay_seen`) : `rev = next`.
- `AFTER UPDATE OF <15 colonnes de contenu> WHEN au moins une differe` :
  `content_rev = next`, et `sync_dirty = 1` sauf si `applying = '1'` dans
  `roadmap_sync_meta` (ecriture de synchro en cours).
- `AFTER UPDATE OF locked WHEN OLD.locked = 1 AND NEW.locked = 0 AND
  OLD.lock_scope IN ('local','global','contested')` : `lock_scope =
  'release_pending'`, `lock_release_owner = OLD.locked_by` -- toute relache
  locale (explicite, changement de statut, sweep) est ainsi propagee upstream
  sans lister les chemins.
- `AFTER INSERT WHEN locked = 1` et `AFTER UPDATE OF locked, locked_by` (prise
  ou changement d'owner) : `lock_scope = 'local'`. Une carte peut NAITRE
  verrouillee (creee `in_progress` par un agent). Les trois triggers de portee
  sont conditionnes a `mode = 'replica'` ET `applying <> '1'`, pour qu'un
  verrou miroir pose par le pull ne soit jamais relu comme une prise locale.

`PRAGMA recursive_triggers` est OFF par defaut : l'UPDATE du trigger ne
re-declenche pas les triggers. Un test l'affirme (une ecriture = exactement
un bump).

### 3.4 Les trois cas, sans horloge

| Etat local | Upstream | Action |
|---|---|---|
| `sync_dirty = 1`, `upstream.content_rev === sync_base_rev` | inchange | push (fast-forward) |
| `sync_dirty = 0`, `upstream.content_rev !== sync_base_rev` | avance | pull, `sync_base_rev = upstream.content_rev` |
| `sync_dirty = 1`, `upstream.content_rev !== sync_base_rev` | avance | **conflit**, arbitrage operateur |

`sync_base_rev IS NULL` (carte creee hors ligne, ou carte locale anterieure
au mode replica) : push avec `expected_content_rev = null` ; l'upstream
insere si l'id est inconnu, repond 409 s'il existe (conflit).

### 3.5 Pas de fusion automatique par champ

**DECIDE** -- une carte cloturee (`status` done/archived, `deleted_at`) d'un
cote et enrichie de l'autre est TOUJOURS un conflit dur : `status` et
`deleted_at` sont semantiques, pas independants. Le conflit est au niveau
carte. La fusion a trois voies n'existe que comme RESOLUTION explicite
(`merge_reopen`, §7), jamais comme regle automatique.

Une seule auto-resolution : un conflit dont la ligne upstream porte
`updated_by = 'lock-sweep'` (le sweep a remis `in_progress -> planned` pendant
la coupure) est resolu `local` sans intervention, avec une ligne de journal.
Sans elle, chaque carte en cours cote replica remonterait en conflit a chaque
reconnexion a cause du seul sweep.

**DECIDE (2026-09-05)** -- condition resserree apres revue adversariale :
l'auto-resolution ne s'applique QUE si le contenu upstream ne differe du
`sync_base` local QUE par la transition `status: in_progress -> planned` (les
14 autres colonnes de contenu identiques a la base). Tout autre champ
different a cote de ce `status` reste un conflit dur, arbitre normalement.
Le piege que ce resserrement ferme : `updated_by = 'lock-sweep'` dit
seulement que le sweep a ete le DERNIER a ecrire la ligne upstream, pas
qu'il en a ete le SEUL ecrivain -- un humain ayant edite la description
juste avant que le sweep ne passe (liberant le verrou en meme temps) verrait
son edition silencieusement ecrasee par l'auto-resolution `local` si la
regle ne portait que sur l'auteur de la derniere ecriture.

---

## 4. File de dispatch : l'upstream l'emporte

**DECIDE** -- `queue` n'est jamais poussee. Au pull, la valeur upstream
remplace la locale sur chaque ligne recue. Consequences assumees :

- une carte creee et mise en file hors ligne arrive upstream avec
  `queue = null` : a replacer a la main ;
- les reorganisations hors ligne sont perdues, PAS silencieusement : une
  ligne de journal `info` par reconnexion avec le nombre de positions locales
  ecrasees. (Le toast Deck correspondant est differe, §10.)

Hors ligne, la file locale reste pleinement fonctionnelle pour le dispatch
local ; la regle ne s'applique qu'a la reconnexion.

---

## 5. Verrous : portee locale / globale, relais par le broker local

**DECIDE** -- l'interet d'une roadmap partagee est que A voie la carte
verrouillee par B et ne puisse pas la prendre : le verrou DOIT se propager a
l'upstream. Mais **MESURE** (`broker.ts:1180-1230`) -- la deuxieme clause du
sweep relache tout verrou dont `locked_by` n'est aucun peer actif ou vu
depuis `LOCK_GRACE_SEC` (600 s) sur CE broker. Les agents d'une replica ne
sont pas enregistres upstream : un verrou pousse tel quel serait balaye au
premier passage. D'ou le relais :

- Upstream, un verrou d'agent distant est porte par le **broker replica**
  (`lock_relay = replica_id`, `lock_relay_seen` = dernier tick), `locked_by`
  gardant le `peer_id` de l'agent en texte pour l'affichage,
  `locked_by_token = NULL` (le token de l'agent ne traverse jamais).
- La clause 2 du sweep exempte `lock_relay IS NOT NULL AND
  datetime(lock_relay_seen) >= datetime('now', -LOCK_GRACE_SEC)`.

**DECIDE (2026-09-05)** -- la clause 1 (TTL 6 h sans ecriture sur l'item)
exempte ELLE AUSSI tout verrou relaye dont `lock_relay_seen` est frais (meme
garde que la clause 2), pas seulement la clause 2 comme ecrit initialement :
une carte verrouillee par un agent replica peut rester `in_progress` plus de
6 h sans ecriture (revue longue, agent en pause) sans que le TTL la libere
tant que le heartbeat de relais est vivant -- sinon la clause 1 relacherait
un verrou legitime que la clause 2 venait justement d'exempter, rendant
l'exemption de la clause 2 inoperante des que le TTL expire. La replica
reste la seule autorite sur les verrous de SES agents : c'est son propre
sweep local (§5.1), pas le TTL upstream, qui decide de leur relachement.
- Quand la replica coupe, le relais se tait, la grace s'ecoule, le sweep
  relache : Bob n'est pas bloque des jours par une machine absente. C'est la
  semantique actuelle « silence du proprietaire = verrou abandonne ».

### 5.1 Machine a etats `lock_scope` (cote replica)

| A la reconnexion, verrou local sur X | Upstream | Resultat |
|---|---|---|
| `local` (pris hors ligne) | libre | `global` |
| `local` | tenu par Bob | `contested` ; Bob voit `lock_contested_by` |
| `global` (pris en ligne, puis coupure) | repris par Bob entre-temps | `contested` |
| `global` | toujours a nous ou libre | `global` (re-assertion) |
| `contested` | libere par Bob | `global` |
| `release_pending` | -- | `release` envoye, puis NULL |

Un seul algorithme : a chaque tick, TOUT verrou local de portee `local`,
`global` ou `contested` passe par `/roadmap/sync/lock action=claim` ; la
reponse fixe la portee. `release_pending` passe par `action=release`.

### 5.2 Verrous distants vus par la replica

Un verrou upstream tenu par un tiers arrive au pull sur une carte non
verrouillee localement : la replica pose `locked = 1, locked_by, locked_group,
locked_by_token = NULL, lock_scope = 'remote'`. La garde de verrou existante
bloque alors les agents locaux (le but). Le sweep LOCAL exempte
`lock_scope = 'remote'` (rafraichi par le pull, pas par un heartbeat de peer).
Quand l'upstream montre la carte libre, la replica efface le verrou `remote`.
Une carte verrouillee localement (`local`/`global`/`contested`) ignore les
colonnes de verrou recues.

---

## 6. Frontiere de confiance

**DECIDE (2026-09-05)** -- section reecrite apres revue adversariale : la
version initiale ("l'upstream fait confiance au relais", `deck`/`operator`
conserves tels quels) ouvrait une usurpation d'attribution triviale --
n'importe quelle replica pouvait pousser `updated_by: 'operator'` ou
`updated_by: 'deck'` et l'upstream l'aurait affiche comme une ecriture
locale legitime.

- La replica s'authentifie aupres de l'upstream par `broker_token` (Bearer),
  comme tout client HTTP. Elle est donc de confiance AU NIVEAU DU TOKEN --
  mais ce niveau ne couvre PAS l'attribution individuelle (voir plus bas).
- Les routes de replication `/roadmap/sync/pull|push|lock` sont refusees 403
  si l'upstream n'a PAS de `broker_token` CONFIGURE : sans token, n'importe
  quel processus loopback pourrait se faire passer pour une replica de
  confiance -- c'est une garde SUPPLEMENTAIRE, specifique a la replication,
  qui s'ajoute au Bearer ordinaire, elle ne le remplace pas.

  **DECIDE (2026-09-05)**, precision apres revue adversariale : `/roadmap/
  sync/status` n'est dispensee QUE de cette garde-la (elle n'exige pas que
  l'upstream ait un token configure pour repondre, contrairement a
  pull|push|lock). Elle reste soumise au controle Bearer GENERIQUE du
  broker (`unauthorizedIfToken` dans `broker.ts`), qui s'applique a TOUTE
  route hors `/health` des qu'un `broker_token` est configure sur CE
  broker -- l'enonce initial ("reste accessible sans token, comme
  `/health`") etait faux : `/health` a une exemption explicite dans le
  `fetch` handler, `/roadmap/sync/status` n'en a aucune. Un appelant sans
  Bearer valide contre un broker qui a un token configure recoit donc 401
  sur `/roadmap/sync/status` comme sur n'importe quelle autre route.
- `locked_by_token` et `operator_id` ne traversent jamais la frontiere, dans
  aucun sens : la projection des lignes de `/roadmap/sync/pull` est une
  pick-list (jamais un rest-spread), et un test affirme l'absence du champ.
  `operator_id` upstream : valeur existante conservee ou NULL, jamais celle
  de la replica -- inchange.
- `/roadmap/sync/push` re-valide `created_by`/`updated_by` par
  `normalizeAuthorIdentity` (charset `[a-z0-9:_-]`) puis reattribue :
  - un nom qui est une identite RESERVEE (`deck`, `operator`) ou un `peer_id`
    deja enregistre COTE UPSTREAM est stocke `via:<replica8>:<name>`
    (`replica8` = 8 premiers caracteres du `replica_id`) -- la provenance
    reste lisible sans permettre l'usurpation ;
  - un nom inconnu de l'upstream (agent local a la replica, jamais vu
    upstream) est conserve tel quel : c'est un pair legitime qui n'a
    simplement pas de presence upstream (federation = §10) ;
  - au pull, la replica retire son PROPRE prefixe `via:<replica8-local>:`
    des lignes qu'elle recoit (ses propres ecritures relues via l'upstream
    ne doublent pas le prefixe a chaque aller-retour). Un `via:<autre8>:`
    d'une AUTRE replica est laisse tel quel : c'est une attribution
    legitime a tracer, pas a masquer.

  **DECIDE (2026-09-05)**, modele de provenance precise honnetement apres
  revue adversariale -- ce que `via:<replica8>:<name>` garantit et ce qu'il
  NE garantit PAS :
  - le prefixe est ASSERTE par la replica qui relaie, pas verifie
    independamment : l'upstream lui fait confiance AU NIVEAU DU TOKEN
    (meme niveau que le reste de §6), pas au niveau de l'identite
    individuelle qu'il porte -- une replica compromise mais dont le token
    reste valide peut mentir sur le `<name>` qu'elle relaie, exactement
    comme elle pourrait deja le faire pour un pair inconnu (branche
    precedente).
  - l'upstream REFUSE (400) un `created_by`/`updated_by` pousse qui porte
    DEJA un prefixe `via:<autre8>:` (usurpation de la provenance d'une AUTRE
    replica). Un `lock-sweep` pousse est REECRIT comme un nom reserve
    (`via:<replica8>:lock-sweep`) et non refuse : le sweep local d'une
    replica est un evenement reel qui doit voyager, mais sous ce prefixe il
    ne qualifie jamais l'auto-resolution d'un autre broker (§3.5 lit le
    `updated_by` brut, donc seul le sweep de l'upstream lui-meme compte).
    Sans cette garde, une replica pourrait forger `updated_by: 'lock-sweep'`
    pour faire passer sa propre ecriture comme eligible a l'auto-resolution
    silencieuse d'une AUTRE replica au prochain conflit.
  - un `created_by`/`updated_by` qui porte DEJA le PROPRE prefixe
    `via:<replica8>:` de la replica qui pousse (rejoue d'une ligne deja
    relayee) est conserve TEL QUEL, idempotent -- il n'est jamais
    re-enveloppe (`via:X:via:X:name`).
  - un nom inconnu de l'upstream AU MOMENT DU PUSH est stocke verbatim
    (branche precedente) ; c'est un TOCTOU assume : si ce `peer_id`
    s'enregistre plus tard cote upstream, les lignes deja poussees avant
    son enregistrement restent verbatim et se lisent comme une ecriture
    upstream native, alors qu'elles viennent bien de la replica. Aucune
    reecriture retroactive n'est prevue -- seule une NOUVELLE ecriture
    apres l'enregistrement du peer declenche le prefixage.
- Une carte verrouillee upstream par un holder que la replica ne relaie pas
  (`lock_scope` local absent de la carte, verrou upstream tenu par un tiers)
  refuse tout `push` dessus : 409 `{ error: 'conflict', reason:
  'locked_upstream', item }`. Cote replica ce refus se presente comme un
  conflit ordinaire (§3.4/§8) -- l'operateur ne peut alors que prendre la
  version upstream (`resolve remote`) tant que le verrou tient : c'est le
  mecanisme qui remplace un "ils resoudront au commit/push/pull" implicite
  par un arbitrage explicite dans le Deck plutot qu'un ecrasement silencieux.
- `/roadmap/sync/resolve` est une ecriture Deck : signee `by='deck'` via
  `resolveRoadmapAuthor`, comme `/roadmap/upsert` -- inchange, c'est une
  ecriture LOCALE a la replica, jamais relayee telle quelle upstream.
- `/roadmap/sync/conflicts` projette les DEUX cotes (local et `sync_remote`)
  a travers la MEME pick-list que `/roadmap/sync/pull` : un champ absent du
  pull (`locked_by_token`, `operator_id`) est absent de la vue conflit, sans
  liste separee a maintenir.
- Les routes `/roadmap/sync/*` sont des routes ordinaires du `switch` : le
  Bearer s'applique, et `replica_id` est un identifiant (uuid persiste dans
  `roadmap_sync_meta`), pas un secret.

---

## 7. Contrat de protocole (`shared/types.ts`, bloc `RoadmapSync*`)

Toutes en `POST`, JSON, `{ error, status }` en echec comme les autres routes.

| Route | Corps | Reponse |
|---|---|---|
| `/roadmap/sync/pull` | `{ replica_id, since_rev, limit? }` | `{ items: RoadmapSyncRow[], next_rev }` -- lignes `rev > since_rev`, ordre `rev`, `limit <= 500` (defaut 500) ; `next_rev` = plus grande `rev` renvoyee ou `since_rev` |
| `/roadmap/sync/push` | `{ replica_id, item: RoadmapSyncPushItem, expected_content_rev }` | 200 `{ item: RoadmapSyncRow, rev, content_rev }` (jamais un `RoadmapItem` : il porterait `locked_by_token`) ; 409 `{ error: 'conflict', item }` si `content_rev` upstream differe (ou ligne existante avec `expected = null`) ; 409 `{ error: 'conflict', item: null }` si `expected != null` et ligne absente ; 409 `{ error: 'conflict', reason: 'locked_upstream', item }` si la carte est verrouillee upstream par un holder non relaye par cette replica (§6) ; 403 si l'upstream n'a pas de `broker_token` configure (§6) |
| `/roadmap/sync/lock` | `{ replica_id, id, action: 'claim'\|'release', owner: { peer_id, group_id } }` | claim : 200 `{ scope: 'global', item }` ou 409 `{ scope: 'contested', item }` ; release : 200 `{ released: boolean, item }` |
| `/roadmap/sync/status` | `{}` | `RoadmapSyncStatus` (replica) ; `{ mode: 'upstream' }` ou `{ mode: 'local' }` sinon |
| `/roadmap/sync/conflicts` | `{ project_key }` | `{ items: RoadmapConflict[] }` |
| `/roadmap/sync/resolve` | `{ id, choice: 'remote'\|'local'\|'merge_reopen', by, auth... }` | `{ item }` |

Semantique de `push` : applique les 15 colonnes de contenu + `updated_by`,
`updated_at`, `created_by`, `created_at` (celles-ci seulement a l'insertion).
Ne touche ni `queue`, ni les colonnes de verrou, ni `operator_id`. Refuse la
carte verrouillee upstream par un holder non relaye (§6, `locked_upstream`).
`created_by`/`updated_by` transmis sont reattribues avant ecriture selon la
regle du §6 (`via:<replica8>:<name>` pour une identite reservee ou un
`peer_id` deja connu de l'upstream, conserve tel quel sinon).

Semantique de `lock claim` : autorise si la carte est libre OU si
`lock_relay === replica_id AND locked_by === owner.peer_id` (re-assertion) ;
pose `lock_relay`, `lock_relay_seen = now`, retire l'owner de
`lock_contested_by`. Sinon 409 et ajoute `"<peer_id>@<replica_id>"` a
`lock_contested_by` (deduplique). `release` n'efface que si le relais et
l'owner correspondent ; sinon retire seulement l'entree contestee.

Semantique de `resolve` :

- `remote` : contenu upstream applique (`applying = 1`), `sync_base_rev =
  remote.content_rev`, `sync_base` = ce contenu, `sync_dirty = 0`,
  `sync_state = 'clean'`, `sync_remote = NULL`.
- `local` : contenu local conserve, `sync_base_rev = remote.content_rev`,
  `sync_base` = contenu remote, `sync_dirty = 1`, `clean` -> pousse au tick
  suivant en fast-forward (ou re-conflit si l'upstream a encore bouge :
  correct).
- `merge_reopen` : fusion a trois voies champ par champ dans
  `shared/roadmap-sync.ts` (pure) -- `local` si `local != base`, sinon
  `remote` ; les deux ont change et different : `local` gagne (documente).
  Puis `status = 'in_progress'` si l'un des deux cotes l'etait, sinon
  `'planned'` ; `deleted_at = null`. Meme suite que `local`.

---

## 8. Boucle de replication (cote replica)

Un seul passage en vol a la fois (pas de `setInterval` qui se chevauche : un
`setTimeout` re-arme a la fin de chaque passage). Cadence
`CLAUDE_PEERS_SYNC_TICK_MS` (defaut 5000). En echec, backoff x2 jusqu'a 60 s
puis retour a la cadence nominale au premier succes. Etat `online` avec
hysteresis (2 echecs consecutifs -> offline, 1 succes -> online), transitions
journalisees UNE fois chacune (`shared/logger.ts`), jamais a chaque tick.

**DECIDE (2026-09-05)** -- l'upstream d'une replica DOIT avoir un
`broker_token` configure (§6) : sans lui, TOUTES les routes de replication
(pull, push, lock) repondent 403 des le premier appel. Ce 403-la n'a rien a
voir avec le 403 par-carte du push (ci-dessous) : il touche le PASSAGE
ENTIER (le pull lui-meme echoue, il n'y a donc rien a synchroniser), la
replica le traite comme un upstream INJOIGNABLE et il compte pour la
hysteresis `online`/`offline` comme une panne reseau -- ce n'est pas une
exception a la regle "seuls le reseau et les 5xx comptent pour offline",
c'est un echec DE PASSAGE plutot qu'un refus D'UNE CARTE. Cote broker, le
demarrage de la replica journalise une erreur EXPLICITE des ce premier
echec (plutot que de laisser le backoff generique masquer la cause) : un
operateur qui a oublie le token le voit nomme dans les logs, au lieu de
decouvrir une replica "hors ligne" sans explication apparente.

Ordre d'un passage :

1. **Pull** en boucle tant que `items.length === limit`. Par ligne recue :
   - absente localement -> insertion (`applying`), `sync_base_rev =
     content_rev`, `sync_base` = contenu, `queue` upstream, verrou `remote`
     si verrouillee upstream ;
   - presente, `sync_dirty = 0`, `clean` -> contenu ecrase (`applying`),
     base mise a jour, `queue` et verrou `remote` appliques ;
   - presente, `sync_dirty = 1`, `upstream.content_rev === sync_base_rev` ->
     seul le contenu n'a pas bouge upstream : `queue`/verrou appliques,
     contenu local intact ;
   - presente, `sync_dirty = 1`, `content_rev` differe -> conflit
     (`sync_state`, `sync_remote`), sauf regle `lock-sweep` (§3.5) ; `queue`
     appliquee quand meme ;
   - deja en conflit -> `sync_remote` rafraichi ;
   - localement `remote`-verrouillee et libre upstream -> verrou efface.
   `upstream_cursor = next_rev` apres chaque page appliquee.
2. **Push** des lignes `sync_dirty = 1 AND sync_state = 'clean'` avec
   `expected_content_rev = sync_base_rev`. Sur 200 : `UPDATE SET
   sync_base_rev = ?, sync_base = ?, sync_dirty = CASE WHEN content_rev = ?
   THEN 0 ELSE sync_dirty END` (le `content_rev` lu avant l'envoi : une
   ecriture locale survenue pendant l'aller-retour reste dirty et repart au
   tick suivant avec la bonne base). Sur 409 : conflit avec l'item renvoye
   (y compris `reason: 'locked_upstream'`, §6).

   **DECIDE (2026-09-05)** -- un push refuse par un 4xx AUTRE que 409 (400
   payload invalide, etc. -- le 403 sans token amont est un echec de PASSAGE,
   voir plus haut) est isole PAR CARTE : la ligne fautive est journalisee une
   fois par carte et par message (pas a chaque tick si l'erreur persiste),
   comptee `refused` dans `RoadmapSyncStatus`, `last_error` nomme la derniere
   raison ; la passe CONTINUE sur les cartes suivantes et ne bascule jamais
   `online = false` pour cette seule cause -- seuls un echec reseau ou un 5xx
   comptent pour la hysteresis online/offline (une erreur de payload sur une
   carte ne dit rien de la joignabilite de l'upstream).

   **DECIDE (2026-09-05)**, precision de cadence -- une ligne `refused` est
   EXCLUE du lot de push du tick suivant (elle ne repart pas immediatement se
   refaire refuser) et repasse sur une cadence PLUS LENTE dediee aux lignes
   refusees, pour qu'une carte durablement invalide ne monopolise pas chaque
   passage au detriment des lignes saines.
3. **Verrous** : `claim` pour `local`/`global`/`contested`, `release` pour
   `release_pending` ; `lock_scope` mis a jour d'apres la reponse. Un `claim`
   ou `release` refuse par un 4xx (hors 409 `contested`, une reponse
   normale) est compte `refused_locks` dans `RoadmapSyncStatus`, meme
   traitement que les pushs refuses (isole par carte, cadence de retry
   ralentie, jamais de bascule offline pour cette seule cause).

Au premier demarrage : `replica_id = randomUUID()` persiste ; `upstream_cursor
= 0` -> pull integral. Le predicat « a pousser » est `sync_state = 'clean' AND
(sync_dirty = 1 OR sync_base_rev IS NULL)`, un seul fragment SQL partage par
la passe et par le compteur `pending_push` du status : les lignes locales
preexistantes (jamais synchronisees) partent comme nouvelles (`expected =
null`) sans avoir a etre dirty. Le push n'applique ni la garde de verrou ni
la garde `inactive` (une edition hors ligne deviendrait a jamais
impoussable) ; `/roadmap/sync/lock` applique la garde `inactive`.

**DECIDE (2026-09-05)** -- semantique de l'instantane de statut : `refused`
(pushs) et `refused_locks` (claims/releases) sont publies dans
`RoadmapSyncStatus` a la FIN de chaque passage, aux cotes de `online` et
`last_error` -- un seul instantane coherent, jamais des compteurs mis a jour
au milieu d'un passage en cours que le Deck pourrait lire a mi-chemin.

---

## 9. Deck

- Sondage sur le tick `INBOX_POLL_MS` existant : `/roadmap/sync/status` puis,
  si `mode === 'replica'`, `/roadmap/sync/conflicts` du projet courant ;
  diffusion `roadmap:sync` seulement au changement (signature), comme
  `pollGraphDrafts`. En mode `local`/`upstream`, un seul appel `status` au
  demarrage puis plus rien.
- Rail : badge numerique sur l'entree Roadmap = nombre de conflits (meme
  `nav-rail-badge` que l'inbox, filtre au projet courant via
  `/roadmap/sync/conflicts`, §2.3). Banniere d'etat (ton info, pas erreur)
  tant que `online = false` en mode replica : « broker distant injoignable,
  travail hors ligne, N modifications en attente ».
- Cartes : `sync_state = 'conflict'` -> cerclage `--danger` ; `lock_scope =
  'remote'` -> glyphe verrou existant avec le titre « verrou distant (peer) »
  ; `lock_scope = 'contested'` -> cerclage d'avertissement.
- Modale de resolution : champs qui different seulement, transition de
  `status` mise en evidence, trois actions (`remote`, `local`,
  `merge_reopen`). Aucun controle natif, aucun emoji (`DESIGN.md`).
- Le miroir `RoadmapItem` du Deck (`desktop/src/shared/types.ts`) et
  `sanitizeRoadmapItem` (pick-list) gagnent `sync_state`, `lock_scope`,
  `lock_contested_by` avec defauts surs.

**DECIDE (2026-09-05)**, ajouts issus de la revue adversariale :

- Banniere d'etat : quand plusieurs conditions coexistent, priorite
  d'affichage `broker local injoignable` (cas degrade le plus grave, rien ne
  synchronise) > `N conflits a arbitrer` > `N pushs refuses` > info hors
  ligne simple (`online = false` sans conflit ni refus). Le libelle
  « N conflits a arbitrer » s'affiche des que `RoadmapSyncStatus.conflicts >
  0`, meme `online = true` (un conflit ne se resout pas tout seul en
  revenant en ligne). `last_error` (§8) est rendu dans le detail de la
  banniere quand present.
- Nouvelle categorie Settings « Broker » dans le Deck : affiche le mode
  (`local`/`remote`/`replica`), l'URL amont, et si un token est configure
  (jamais le token lui-meme) ; porte une case a cocher qui ecrit
  `offline_replica` dans le MEME fichier `config.json` de claude-peers que
  lisent `server.ts`/`cli.ts` (§ README, "Sessions outside Kory") -- pas un
  reglage Deck-only. Desactivee (grisee, avec l'explication) quand le mode
  est force par l'environnement (`CLAUDE_PEERS_OFFLINE_REPLICA` deja
  positionne) ou quand aucun `broker_url` n'est configure (rien a repliquer,
  §2.1). Le changement s'applique aux brokers/sessions demarres APRES
  l'ecriture -- pas de bascule a chaud d'un broker deja lance (§2.1 :
  `ensureBroker()` decouvre son mode a son propre demarrage).

---

## 10. Refuse ou differe (repris dans `BACKLOG.md`)

- **Federation peers/messages** (relais des enregistrements et messages
  inter-machines via la replica) : phase 2, gros lot -- DEVENU LE PREMIER
  item de `BACKLOG.md` §3.9 apres la revue adversariale.
  **DECIDE (2026-09-05)** -- en v1, la messagerie inter-PC est locale a la
  machine EN MODE REPLICA, MEME EN LIGNE (pas seulement pendant une
  coupure) : l'operateur a valide ce compromis en connaissance de cause, en
  echange de la continuite hors ligne de la roadmap -- peers et messages
  restent portes par le broker loopback de chaque machine, jamais relayes
  vers l'upstream tant que la federation n'est pas livree.
- **Fusion automatique par champ** : refusee (§3.5).
- **Toast Deck « N positions de file perdues »** : journal seul en v1.
- **Grace de vivacite a 1 h** : non retenue. A 600 s, une carte dont l'agent a
  plante est liberee en 10 min ; a 1 h elle bloque l'equipe une heure.

  **DECIDE (2026-09-05)** -- correction : l'enonce "le broker local... ne
  relache rien" etait FAUX. Le sweep LOCAL de la replica relache
  normalement les verrous `local`/`global`/`contested` (memes regles
  qu'un broker `local`/`remote` ordinaire, §5.1) ; SEUL le verrou de
  portee `remote` (miroir d'un verrou tenu par un tiers upstream, §5.2) en
  est exempte -- il n'est pas "a lui" a relacher, il suit l'etat upstream.
  La tolerance a la coupure porte donc uniquement sur les verrous relayes
  upstream (§5, exemption `lock_relay_seen`), pas sur une supposee
  inertie generale du sweep local.
- **Confiance relais pour `operator_id`** : jamais transmis ; si un besoin de
  provenance operateur inter-brokers apparait, il passera par une signature
  verifiable upstream, pas par un champ declare.
- **Outil MCP exposant `lock_contested_by` aux agents natifs** : l'annotation
  est stockee et visible du Deck ; l'exposition aux agents est a mesurer.
- **Le Deck ne demarre pas le broker loopback lui-meme**, en mode local
  comme en mode replica : c'est une session (`server.ts`, via
  `ensureBroker()`) qui le fait naitre au demarrage. **DECIDE (2026-09-05)**
  -- consequence assumee, listee ici en suivi : un Deck ouvert sans aucune
  session active ne peut pas lire la roadmap replica (pas de broker
  loopback vivant a interroger) -- c'est exactement le comportement deja en
  vigueur en mode `local` aujourd'hui, pas une regression introduite par ce
  lot. Faire demarrer le broker depuis le Deck lui-meme (independamment de
  toute session) reste a cadrer separement.
