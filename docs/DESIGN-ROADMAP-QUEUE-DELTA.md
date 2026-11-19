# Push atomique des deltas de file

Carte : `c149cc3c`. Statut : contrat accepté par l'opérateur (A1 et B1 ci-dessous). Le lot L1 (côté upstream) est implémenté ; L2 à L4 restent à faire.

## Problème

Une réplique pousse aujourd'hui le rang d'une carte par la même requête que son contenu : `syncPushPass` envoie UNE requête `/roadmap/sync/push` par ligne marquée dirty, en séquence, et `handleRoadmapSyncPush` écrit une ligne par requête. Le reorder local est atomique (`handleRoadmapReorder`, une transaction), mais son transport ne l'est pas. Un échange de deux cartes passe donc par un état où l'upstream voit deux cartes au même rang, c'est-à-dire une vague (dispatch parallèle) que personne n'a demandée. Si la seconde ligne est refusée, l'état dure.

Un rang partagé reste un état légitime : c'est une vague. Le défaut à fermer est un rang partagé produit PAR ERREUR par le transport d'un reordonnancement.

Deux faits du code qui orientent la conception :

- Le plafond de 50 n'est pas un plafond de file : `SYNC_PUSH_BATCH = 50` borne la collecte de lignes dirty d'une passe, et `ROADMAP_REORDER_MAX = 500` borne les ids d'un reorder local. Aucune des deux valeurs ne doit devenir la taille d'une mutation de file.
- Le Deck soumet une file complète avec ses vagues. Découper cette soumission pour respecter un plafond de transport restreint le geste de l'utilisateur et réintroduit l'état intermédiaire.

La carte `2850488c` a mesuré le cas durable : un échange local pendant une édition amont du contenu de l'une des cartes finit à rang égal des deux côtés, parce que la règle « rang seul perdu si le contenu amont a bougé » s'applique ligne par ligne. Critère de la conception : une opération de rang ne dépend pas du `content_rev` de la carte, seulement de la révision de la file.

## Arbitrages rendus

- A1 : contrôle optimiste de la file, refus 409 visible, pas de bail TTL. La clé est la file du projet, pas le groupe ni le pair. Un bail pourra s'ajouter plus tard sans changer le delta.
- B1 : dépôt dans le broker local dès le geste, puis debounce du départ vers l'upstream. Une seule persistance. Un timer du Deck retarde l'expédition, jamais la durabilité.
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

## Reste à faire

- L2 : journal local, ACK, refus et intégration du pull, qui écrit aujourd'hui `remote.queue` même en conflit. Le pull ne doit pas appliquer `remote.queue` aux cartes couvertes par un delta en attente. Scénarios à garder : pull avant push, push avant pull, attendu des deux côtés `A=2 B=1`. Réécrire l'assertion de `tests/broker-roadmap-replica.test.ts` qui épingle la « Limite acceptée » de `DESIGN-QUEUE-GLOBAL-ORDER.md`.
- L3 : producteurs du Deck (IPC `roadmapReorder` en opération relative), conversion des autres écrivains de rang, et les écritures de contenu dépendantes (une création sans laquelle l'opération serait impossible), reportées hors de L1.
- L4 : régressions et redémarrage, ancien client contre nouveau broker et l'inverse. Déployer le support upstream avant d'activer les nouveaux producteurs. À la migration, ne pas inventer une révision zéro pour une file dont la base est inconnue.

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
