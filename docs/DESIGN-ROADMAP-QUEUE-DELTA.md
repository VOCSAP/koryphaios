# Push atomique des deltas de file

Carte : `c149cc3c`. Statut : contrat accepté par l'opérateur (A1 et B1 ci-dessous). Les lots L1 (côté upstream), L2 (côté réplique) et L3 (producteurs de rang) sont implémentés ; L4 est implémenté, sauf les deux points rangés en cartes (changement d'URL amont d'une réplique, directive dans une vague occupée).

## Problème

Une réplique pousse aujourd'hui le rang d'une carte par la même requête que son contenu : `syncPushPass` envoie UNE requête `/roadmap/sync/push` par ligne marquée dirty, en séquence, et `handleRoadmapSyncPush` écrit une ligne par requête. Le reorder local est atomique (`handleRoadmapReorder`, une transaction), mais son transport ne l'est pas. Un échange de deux cartes passe donc par un état où l'upstream voit deux cartes au même rang, c'est-à-dire une vague (dispatch parallèle) que personne n'a demandée. Si la seconde ligne est refusée, l'état dure.

Un rang partagé reste un état légitime : c'est une vague. Le défaut à fermer est un rang partagé produit PAR ERREUR par le transport d'un reordonnancement.

Deux faits du code qui orientent la conception :

- Le plafond de 50 n'est pas un plafond de file : `SYNC_PUSH_BATCH = 50` borne la collecte de lignes dirty d'une passe, et `ROADMAP_REORDER_MAX = 500` borne les ids d'un reorder local. Aucune des deux valeurs ne doit devenir la taille d'une mutation de file.
- Le Deck soumet une file complète avec ses vagues. Découper cette soumission pour respecter un plafond de transport restreint le geste de l'utilisateur et réintroduit l'état intermédiaire.

La carte `2850488c` a mesuré le cas durable : un échange local pendant une édition amont du contenu de l'une des cartes finit à rang égal des deux côtés, parce que la règle « rang seul perdu si le contenu amont a bougé » s'applique ligne par ligne. Critère de la conception : une opération de rang ne dépend pas du `content_rev` de la carte, seulement de la révision de la file.

## Arbitrages rendus

- A1 : contrôle optimiste de la file, refus 409 visible, pas de bail TTL. La clé est la file du projet, pas le groupe ni le pair. Un bail pourra s'ajouter plus tard sans changer le delta.
- B1 : dépôt dans le broker local dès le geste, puis debounce du départ vers l'upstream. Une seule persistance. Pas de timer du Deck : la coalescence est le tick de synchro (les gestes faits avant l'envoi d'une entrée s'y ajoutent), et le délai ne retarde jamais la durabilité.
- Un conflit sur une mutation refuse la mutation entière (décision du 30 septembre) ; le blocage est visible, jamais silencieux.

## Contrat

### Identité

L'objet est la file d'un projet. Clé de révision : `project_key`, dans la base de l'upstream. Clé d'un reçu : `(replica_id, project_key, mutation_id)`. Deux Decks d'un même projet partagent la même révision.

### Enveloppe (route `/roadmap/sync/queue-delta`, upstream seulement)

`{ replica_id, project_key, mutation_id, expected_queue_rev, ops[] }`, authentifiée comme les autres routes de réplication (rôle `serve_replicas` et `broker_token`, refusée par une réplique).

Grammaire, relative, jamais en rangs absolus :

- `place { ids, before | after: ancre }` ou `place { ids, at: 'start' | 'end' }` : les cartes forment une NOUVELLE vague avant ou après la vague de l'ancre. Quitter une vague est un `place`.
- `join { ids, anchor }` : les cartes rejoignent la vague de l'ancre.
- `remove { ids }` : les cartes quittent la file. Une carte non en file est refusée.
- `clear` : vide la file, sans id.

Une ancre absente de la file, ou déplacée par l'opération même qui la nomme, est un refus nommé ; elle n'est jamais remplacée par la fin de la file. Les opérations s'interprètent dans l'ordre, chacune contre le résultat de la précédente. Les rangs 1..N sont recalculés par l'upstream.

La limite porte sur le delta, pas sur la file : au plus `QUEUE_DELTA_MAX_OPS` opérations et `QUEUE_DELTA_MAX_IDS` cartes nommées, contrôlées avant toute écriture. Une file de n'importe quelle taille se réordonne en une mutation.

### Une transaction

Dans l'ordre, dans une seule transaction SQLite :

0. lire la file du projet comme la lisent le dispatch et le reorder : les cartes `done` ou `archived` qui ont gardé un rang n'en font pas partie. Elles ne sont ni renumérotées, ni réécrites, ni dans le reçu, et un `remove` qui les vise est refusé (`not_queued`) ;
1. chercher le reçu `(replica_id, project_key, mutation_id)` AVANT de comparer la révision : le commit de la première tentative a lui-même rendu `expected_queue_rev` périmé pour son retry. Même hash de payload : rendre le reçu stocké avec `replayed: true`, sans rien appliquer. Autre hash : 409 `mutation_reused` ;
2. comparer `expected_queue_rev` à la révision courante du projet : 409 `queue_rev` avec la révision courante ;
3. vérifier que chaque carte nommée existe dans le projet (404 nommant la carte), puis les règles de file : `done` ou `archived` refusés (400), `inactive` refusé (403), une vague de plusieurs cartes ne contient pas de directive (400) ;
4. interpréter les opérations (400 avec l'index de l'opération et la carte) ;
5. refuser (409 `locked_upstream`, carte nommée) si une carte DÉPLACÉE ou RETIRÉE est work-lockée par un détenteur que cette réplique ne relaie pas. Une carte qui change seulement de numéro de rang, sans changer de place relative, n'est pas protégée par son verrou ;
6. écrire les rangs des cartes qui changent ;
7. insérer le reçu, avec la réponse, dans la même transaction.

Toute erreur annule tout ; un refus n'écrit rien, reçu compris. Le reçu n'est jamais purgé par un TTL : une réplique hors ligne plus longtemps que toute fenêtre de rétention doit recevoir la réponse à son retry, pas appliquer la mutation deux fois.

Le reçu garde l'identité de la mutation, son hash, la révision commise et, pour chaque carte déplacée, `{ id, queue, rev }` : jamais les lignes. Un reçu jamais purgé qui stockerait des lignes entières grossirait de toute la file à chaque mutation, et rejouerait une copie périmée.

Réponse 200 : `{ mutation_id, payload_hash, queue_rev, replayed, items }`, où `items` sont les cartes dont le rang a changé, projetées comme `/roadmap/sync/pull`. Sur un rejeu, `items` est relu sur les lignes COURANTES de ces cartes, pas sur l'état du premier commit.

### Révision de file

`roadmap_queue_state(project_key, rev)` compte les écritures de rang du projet. Elle est posée par TRIGGERS, pas par les handlers, pour la raison qui fait poser `rev` et `content_rev` par triggers : un appel de handler échoue ouvert le jour où un nouvel écrivain l'oublie. Quatre triggers : `AFTER UPDATE OF queue` quand la valeur change, `AFTER INSERT` d'une ligne ordonnée, `AFTER DELETE` d'une ligne ordonnée, et `BEFORE INSERT` quand la ligne de même id est ordonnée.

Le dernier existe pour `INSERT OR REPLACE` (l'import) : avec `recursive_triggers` désactivé, le remplacement supprime l'ancienne ligne sans déclencher de trigger de suppression. Mesuré sur SQLite 3.51.2 : le remplacement d'une carte ordonnée par une carte sans rang bouge la révision ; un `INSERT` simple refusé par la clé primaire ne la bouge pas (l'effet du trigger est annulé avec l'instruction) ; un remplacement qui change une carte de projet bouge la révision de l'ancien projet. Une écriture qui laisse le rang tel quel ne bouge rien.

Les deux tables portent un `project_key` et entrent donc dans la migration de casse (`scripts/migrate-project-key-case.ts`), qui les découvre par introspection. Cette migration ne fusionne jamais : deux casings d'un même projet dans l'une d'elles refusent tout le lancement sans rien écrire, si bien qu'aucune révision ne recule et qu'aucun reçu n'est perdu. Une seule casing est passée en minuscules avec la révision ou le reçu intacts.

La révision saute donc de plusieurs unités pour une transaction qui change plusieurs cartes : seule l'égalité compte. Un projet qui n'a jamais eu de carte ordonnée n'a pas de ligne, et sa révision se lit 0. `/roadmap/sync/pull` rend la table dans `queue_revs` : c'est la source de `expected_queue_rev` d'une réplique.

## Côté réplique

Le reorder d'une réplique (`/roadmap/reorder`) est reformulé en opérations relatives par `diffToDeltaOps`, entre la file locale d'avant le geste et la file demandée : seules les cartes qui ne peuvent pas rester à leur place (plus les nouvelles) sont nommées, chaque vague qui en porte une reçoit un `join` sur une carte qui reste, ou un `place` juste après la vague précédente, ou juste avant la première carte qui reste. Les ancres sont des voisines que l'auteur a vues : une carte qu'il n'a jamais vue garde sa place amont. `ids: []` donne un `remove` des seules cartes en file localement (`clear` reste dans la grammaire, sans producteur). Un geste sans effet n'écrit rien. Les autres écrivains de rang d'une réplique passent par le même journal : `roadmap_update` avec `queue` et la création avec `queue` (`rankMoveToDeltaOps` : `join` sur la vague qui porte ce rang, sinon `place` avant la première carte de la première vague de rang supérieur, et `place` en fin de file seulement au-delà de toutes les vagues : les rangs locaux gardent des trous (une carte terminale en laisse un) et l'amont numérote 1..N lui-même, donc le rang demandé ne se lit que par rapport aux vagues voisines ; `null` retire), dans la transaction de l'écriture. Un statut terminal n'est pas journalisé : le push de contenu porte le statut et l'amont vide le rang, alors qu'un `remove` serait refusé (`not_queued`). Une carte qui devient terminale (mise à jour, archivage, import, contenu tiré de l'amont, carte en conflit dont la ligne amont est terminale, résolution de conflit en faveur de l'amont) est retirée de l'entrée non envoyée qui la nomme, par la même réécriture que celle des limites, qui part des rangs amont après les opérations des entrées devant elle et ne touche que les cartes en file ici ou nommées par l'entrée. Une carte en conflit dont la ligne amont est terminale garde son statut et son rang locaux, mais `terminalForQueue` la traite comme terminale : un reorder fait pendant le conflit, la réécriture d'une entrée et un rang écrit sur une autre carte ne la nomment pas, et l'amont n'a donc rien à refuser. Un rang qui ferait entrer une directive dans une vague occupée, ou une carte dans la vague d'une directive, est refusé en 400 à l'écriture locale : l'amont le refuserait et l'entrée entière avec. L'attente d'une carte née ici dont le premier push est refusé en 4xx est dite dans `last_failure`. L'import n'écrit pas de rang en réplique (il garde celui de la carte). Le push de contenu ne porte plus `queue` pour une carte non terminale. La passe relit l'entrée avant de l'envoyer : un geste journalisé pendant l'aller-retour d'un autre projet part avec elle. L'entrée est écrite dans `roadmap_queue_outbox` dans la transaction du reorder local, avec les rangs que chaque carte avait avant le geste (`withheld`, l'ordre amont tel que la réplique le connaît). Un geste fait avant l'envoi du précédent AJOUTE ses opérations à l'entrée (chacune est écrite contre la file que la précédente a laissée) en gardant les rangs déjà rangés ; au-delà des limites d'un delta, l'entrée est réécrite comme la différence totale avec les rangs amont rangés, jamais tronquée. Un geste fait après l'envoi s'ajoute comme entrée.

- **Révision citée.** `expected_queue_rev` est la révision lue dans `roadmap_queue_upstream`, adoptée à la page finale d'un pull (une page intermédiaire annoncerait des rangs non reçus). `0` n'est lu que si `upstream_queue_revs_adopted` est posée : avant la première adoption rien ne part et l'entrée attend. L'adoption continue pendant le gel. Après le push de contenu d'une carte terminale du projet, couverte par le journal ou non, l'entrée suivante du projet attend la prochaine adoption : l'amont, qui vide le rang d'une carte terminale, a fait avancer sa révision. Après un acquittement, la révision de la réponse n'est jamais lue comme révision courante : la passe suivante commence par un pull dont la page finale adopte la courante, et une adoption manquée retient l'entrée (voir plus bas). Tant qu'une entrée du projet est envoyée sans réponse, le push de contenu d'une carte terminale qu'elle couvre attend son règlement (sauf une carte que l'amont n'a jamais vue : l'entrée l'attend). Cette attente (`queueRevStaleProjects`) est en mémoire seulement : après un redémarrage elle est vide, car la première passe commence par un pull dont la page finale adopte la révision courante. Une passe dont l'adoption n'a pas eu lieu (`queue_revs` refusé ou absent d'une page finale, ou pull arrêté au plafond de pages) n'envoie aucune entrée non envoyée : les révisions stockées peuvent être en retard sur l'amont, et l'entrée recevrait un 409 qui défait le geste. La retenue est dite, pas silencieuse : `queue_outbox.last_failure` porte « held: upstream queue revisions not adopted this pass (<raison>) » et le journal l'écrit une fois par entrée. Le drapeau vaut pour tous les projets de la passe : une clé invalide dans `queue_revs` retient donc les entrées de tous les projets, et c'est cette ligne qui le dit. Une entrée déjà envoyée repart quand même, avec la révision qu'elle a citée.
- **Ordre d'une passe.** Pull, contenu, deltas, verrous. Un delta dont une carte nommée n'a pas encore de base amont (née hors ligne) attend la fin de son push de contenu. Le push de contenu omet `queue` pour une carte couverte par une entrée, et un geste de rang seul remet `sync_dirty` à 0 : le rang voyage par la mutation.
- **Gel du pull.** Tant qu'un projet a une entrée, le pull n'écrit aucun de ses rangs, carte nouvelle comprise ; le rang tiré est rangé dans les entrées du projet, et `queue_replaced` ne compte rien.
- **Acquittement.** Les rangs de `items` sont appliqués, puis les rangs rangés pour les cartes que `items` ne contient pas, puis l'entrée est retirée. Un renvoi après réponse perdue garde le même `mutation_id` : l'amont répond par le reçu, rien n'est appliqué deux fois.
- **Refus.** 409 (`queue_rev`, `locked_upstream`, `mutation_reused`) et tout 4xx qui nomme une carte ou l'enveloppe : les rangs remis sont les rangs AMONT (ceux que l'entrée avait rangés, tenus à jour par les pulls gelés), jamais l'ordre d'un geste local précédent ; l'entrée est retirée avec les entrées suivantes du projet (elles sont écrites contre la file que ce refus annule ; le journal dit combien), `queue_replaced` compte les rangs remis, et le refus est dans le journal (`log.error`) et dans `queue_outbox.refused` du statut. Une entrée créée après l'envoi d'une autre hérite des rangs amont de celle-ci, et un acquittement les met à jour avec les rangs de `items` : deux refus de suite remettent bien l'ordre amont. Pas de rebase automatique.
- **Échec de livraison.** Une erreur de transport, un 5xx, un 408, 425 ou 429, et un 401, 403 ou 404 sans carte (route absente ou réplique refusée) ne sont pas un refus de la mutation : l'entrée reste avec le même `mutation_id`, l'erreur est écrite UNE fois par cause (statut HTTP et `mutation_id`, jamais le texte du corps, qui peut varier d'une réponse à l'autre) dans le journal ; le dernier échec est dans `queue_outbox.last_failure` du statut, effacé au premier envoi réussi, et `last_error` ne le porte pas ; il nomme les cartes terminales dont le push de contenu attend le règlement de l'entrée envoyée ; le projet suivant est traité, et la passe continue (verrous, documents de contexte, fédération), la réplique restant en ligne.

## Reste à faire

- L3 (fait côté broker : reorder, mise à jour et création avec rang, import, push de contenu) : le Deck parle à son broker local, donc l'IPC `roadmapReorder` ne change pas.
- L4 : régressions et redémarrage, ancien client contre nouveau broker et l'inverse. À la migration, ne pas inventer une révision zéro pour une file dont la base est inconnue.
- Ordre de déploiement : l'amont d'abord, les répliques ensuite. Un amont sans la route `/roadmap/sync/queue-delta` n'envoie pas non plus `queue_revs` (les deux sont nés ensemble) : la réplique garde chaque entrée dans son journal et `last_failure` dit « held: upstream queue revisions not adopted this pass (it is absent: the upstream predates queue-delta) ». Elle ne livre alors plus aucun rang écrit par `roadmap_update`, puisque le push de contenu n'en porte plus pour une carte non terminale. Il n'y a pas de repli vers `/roadmap/sync/push` : il réintroduirait les rangs partagés par erreur.
- Une entrée ne dépasse jamais `QUEUE_DELTA_MAX_OPS` par le `/reorder` (500 ids au plus). Au-delà de 500 cartes en file, atteint par `roadmap_update`, la réécriture peut dépasser la limite : l'amont refuse en 400, le refus est visible et les rangs amont reviennent. Le geste n'est pas découpé.

Une réplique plus ancienne qui pousse des rangs ligne par ligne par `/roadmap/sync/push` continue de fonctionner et reste non atomique : la garantie vaut pour le nouveau protocole.

## Ce qui reste du travail précédent

| Élément | Conserver | Remplacer ou retirer |
|---|---|---|
| Validation et attribution des écritures de réplique | oui | |
| Prévalidation puis transaction avec rollback | oui, c'est le motif de la route de delta | |
| Pré-gate par projet côté réplique, route legacy, 404 sans repli | oui, pour L2 et L3 | |
| Plafond de 50 sur un reorder | | retirer : `ROADMAP_REORDER_MAX` reste 500 |
| Collecte de lignes dirty comme unité atomique | | remplacer par la mutation identifiée |
| Parcage de toutes les cartes voisines sur un 4xx | | remplacer : un refus désigne la mutation, et la carte quand il le peut |
| ACK de rang par égalité de valeur (`queue IS ?`) | | remplacer : l'ACK confirme CETTE mutation, son hash et sa révision |
| Route `/roadmap/sync/push-batch` | | non reprise : le delta la remplace |

Un `4xx` métier localisable désigne la mutation et, quand il le peut, la carte ou l'index d'opération ; les erreurs d'enveloppe ne désignent pas une carte. Le `404` d'une route de synchronisation garde `stale_upstream`, sans repli.
