# ADR 002 : suivi des tâches déléguées par le broker

Statut : **ratifié**, carte `ba30b865-35f3-4068-abf5-823412e61eb6`. Ratification opérateur transmise par le team-lead le 2026-09-30 : 3 relances et 5 minutes de silence par défaut, chacun surchargeable par environnement et réglage ; suivi refusé sans inbox. Le lead fixe l'échéance maximale à 4 heures par défaut, surchargeable de la même manière. Les bornes et modalités techniques ci-dessous sont les choix de conception de cet amendement, pas des chiffres attribués à l'opérateur. Conception uniquement ; aucun changement de code n'est livré par cet ADR.

Les paragraphes **Décision de conception** sont normatifs, pas des descriptions du logiciel livré. `MESURÉ` désigne une commande exécutée ; `DÉDUIT` une conclusion tirée des sources citées ; `SUPPOSÉ` une propriété non vérifiée.

## Problem framing

**Contrat opérateur**, source : `roadmap_get ba30b865`, lu intégralement le 2026-09-30. Bob délègue à Alice avec une échéance facultative en secondes. Chaque tâche a sa propre identité ; un ACK ne clôt rien. Alice peut clôturer explicitement, ou Bob le fait après rapprochement avec ses tâches ouvertes. Le broker réveille Bob à échéance, limite les relances et escalade vers l'inbox opérateur. Les jobs sont durables ; en replica leur autorité reste sur le broker qui livre à Bob. Aucun appel agent bloquant n'est ajouté.

**DÉDUIT : deux limites changent la taille du chantier.** Les miroirs fédérés sont actuellement identifiés par un nom réutilisable (`broker.ts:7670-7689`), et un push WS est volontairement sans acquittement de lecture (`broker.ts:2734-2737`). Le contrat peut garantir une émission durable et une escalade indépendante du modèle, pas garantir qu'une notification déclenche effectivement une inférence. Une fédération sûre exige plus qu'une table et un timer.

**Décision de conception :** livrer d'abord un suivi local complet, refusant explicitement les participants distants ; ouvrir la fédération seulement après son lot d'identité et de transport. Cette livraison intermédiaire ne clôt pas la carte entière.

## Current structure

| Frontière | Constat et preuve |
|---|---|
| Agent vers broker | **DÉDUIT :** `send_message` décrit seulement `to_peer_id`, `message`, `expects_reply` (`server.ts:532-553`) ; le handler transmet le token local et le texte à `/send-message` (`server.ts:1697-1733`). Le broker résout la cible active dans le groupe de l'émetteur (`broker.ts:2658-2703`). |
| Stockage et livraison | **DÉDUIT :** `recordMessageTx` insère le message, actualise l'activité et acquitte les messages précédents du répondant (`broker.ts:2111-2119`). Les FK de `messages` pointent vers `peers` (`broker.ts:610-620`). Les suppressions de pairs suppriment aussi leur courrier et leur session (`broker.ts:1734-1738`, `2479-2481`). L'état d'une tâche ne peut dépendre de `messages.delivered`. |
| Rendu entrant MCP | **DÉDUIT :** WS et poll de repli appellent `renderInbound` (`server.ts:390`, `457`). `check_messages` et le résultat de `wait_for_message` passent par `formatInboundLine` (`server.ts:1790`, `1872`, `1379-1386`). Le rendu commun ajoute les notes de réception et celles propres au rôle team-lead (`shared/inbound-framing.ts:93-98`). |
| Identité locale | **DÉDUIT :** le renommage ne change pas `instance_token` (`broker.ts:2521-2524`), la résurrection le conserve (`2322-2348`) et une collision active en crée un neuf (`2351-2380`). Le secours par session Claude refuse plusieurs candidats (`2276-2295`). `ARCHITECTURE.md:214-242` distingue identité interne et nom public, mais le code de purge est déterminant : la purge ordinaire supprime aussi `peer_sessions`, donc ne promettre aucune reprise après cette purge. |
| Federation et inbox | **DÉDUIT :** le relais ne transporte actuellement que source, cible nommée et texte (`shared/types.ts:832-837`), et les messages entrants n'ont pas de référence stable de l'émetteur (`795-807`). L'inbox est refusée en groupe sans secret (`broker.ts:8225-8232`) ; une nouvelle session de Courrier commence au `MAX(id)` courant, sans replay du passé (`2010-2025`, `8282-8288`). |

### Correction du précédent « No reply expected »

**DÉDUIT :** la note peer `PEER_NO_REPLY_NOTE` est ajoutée **à l'émission**, par `composeOutboundMessage` (`shared/message-framing.ts:20-21`, `49-57` ; `server.ts:1732`). Elle n'est donc pas un précédent de lookup entrant. En revanche, `renderInbound` constitue bien le point commun où greffer le rappel demandé. Il faut lui fournir un contexte structuré du broker : sa signature actuelle ne reçoit que nom, texte et rôle (`shared/inbound-framing.ts:93`).

## Options et Recommendation

### 1. Surface agent : étendre ou ajouter des outils

- **Option A :** `deadline_sec`, `task_id`, `task_action` sur `send_message`, et `open_tasks_with` sur `check_messages`. Coût : validation conditionnelle et deux modes de lecture distincts. Risque : mal comprendre une clôture sans message ; les résultats doivent distinguer « message envoyé » et « tâche close ». Réversibilité : champs additifs, appels existants inchangés. Rayon d'impact : les deux handlers et leurs schémas.
- **Option B :** conserver l'envoi avec échéance, ajouter `task_list` et `task_close`. Coût : deux outils présents à chaque tour ; clôture accompagnée d'un rapport en deux appels. Bénéfice : sémantique plus explicite, schémas moins conditionnels. Risque : rapport envoyé sans le deuxième appel. Réversibilité : retrait d'outils publiés plus coûteux ; rayon d'impact supplémentaire sur les allowlists d'outils.

**Décision de conception : A.** La marge mesurée autorise les deux options : ne pas prétendre que B est impossible. A préserve une opération atomique « transmettre le rapport et demander la clôture » et évite deux outils. Le libellé court sera dérivé des 30 premiers points de code utiles du message initial, plutôt qu'un cinquième argument public.

#### Mesure du budget

**MESURÉ :** `bun test ./tests/peer-mcp-surface-budget.test.ts` :

```text
 8 pass
 0 fail
 36 expect() calls
Ran 8 tests across 1 file. [38.00ms]
```

**DÉDUIT :** ce garde compte des **caractères de source**, sans les lignes de commentaires, pas des tokens ni les octets JSON réellement envoyés au modèle ; plafond 19 000 (`tests/peer-mcp-surface-budget.test.ts:10-38`).

**MESURÉ :** sonde hors dépôt préparée par le test-engineer, lue puis exécutée par l'architecte :

```text
bun run C:/Users/Olivier/.agent-forge/scratch/measure-surface-v2.ts
bytes=106976 sha256=578c0a22c4542e8f0f9f991cd9829843e319acb311067971319b429c0fbcebfc
on-disk endings: pure CRLF
```

La sonde copie les extracteurs du test, substitue les schémas uniquement en mémoire et vérifie l'unicité des ancres. Le jeu LF est une normalisation du fichier lu, pas une exécution CI.

| Variante mesurée | Total CRLF | Ajout CRLF | Marge / 19 000 | Total LF normalisé |
|---|---:|---:|---:|---:|
| Actuel | 17 006 | 0 | 1 994 | 16 642 |
| A, outils existants | 17 849 | 843 | 1 151 | 17 468 |
| B, deux outils dédiés | 18 153 | 1 147 | 847 | 17 752 |

Ligne décisive de A, sortie verbatim :

```text
  result   instructions=2165 TOOLS=15684 total=17849 margin=1151 delta=+843
```

Périmètre exact de A mesuré : trois propriétés ajoutées, suppression du `required` global de `send_message`, ajout du mode de lecture à `check_messages`, descriptions ci-dessous ; bloc `instructions` inchangé. Les validations détaillées restent côté broker et dans les erreurs, pas recopiées dans les instructions MCP.

```text
send_message, ajout de description :
 deadline_sec tracks a task. task_id cites/rearms it; task_action close explicitly closes it, with or without a message. ACKs never close tasks.

deadline_sec : number
 Seconds until due; omitted = no task, or no rearm with task_id.
task_id : string
 Task UUID; omit to create, cite to reply/rearm/close.
task_action : string, enum ["close"]
 Explicit close; task_id alone never closes.

check_messages, ajout de description :
 open_tasks_with lists tasks instead of draining messages; use * for all my open tasks.
open_tasks_with : string
 List my open tasks for this peer, without draining messages.
```

**SUPPOSÉ :** le nombre de tokens effectifs et l'impact sur la réussite des modèles n'ont pas été mesurés. Le test du schéma final reste exigible ; cette sonde n'est pas un test d'un handler implémenté.

### 2. Rappel : hook ou rendu MCP

- **Option A, hook entrant :** lookup CLI depuis la configuration de la machine. Coût et rayon d'impact : distribution du hook et d'une CLI authentifiée sur chaque environnement. Risque : divergence de configuration ; réversibilité facile, mais la couverture dépend du client. **SUPPOSÉ :** le déclenchement exact de `UserPromptSubmit` pour tous les modes de livraison n'a pas été vérifié ici.
- **Option B, rendu MCP :** le broker fournit les tâches ouvertes de Bob chez l'émetteur ; le serveur MCP compose la note dans le rendu commun. Coût : extension des enveloppes de livraison et du rendu. Risque principal : oublier un chemin de livraison. Réversibilité additive ; aucun hook ni processus CLI par message.

**Décision de conception : B.** Le broker possède les identités et la vérité des tâches ; le MCP possède le texte destiné au modèle. Aucune recherche de UUID dans la prose et aucun classement par LLM côté broker.

### 3. Durabilité et identité

- **Option A :** job rattaché au couple de noms ou au message initial, supprimé avec le pair. Coût faible. Risque : deux tâches confondues, héritage par homonyme, disparition au TTL du courrier. Une migration réparatrice ne peut reconstituer sûrement l'ancien propriétaire.
- **Option B :** UUID par tâche, participants liés par identités internes, état indépendant du courrier, snapshots de noms. Coût : une petite machine d'états et une gestion explicite des orphelins. Réversibilité : stockage additif ; rayon d'impact limité localement mais étendu au protocole pour le distant.

**Décision de conception : B**, sans FK destructrice vers `peers`. Aucun transfert automatique à un nouveau token, à une tuile homonyme, à un même rôle, ni à un même répertoire.

### 4. Autorité en replica

- **Option A :** suivre le job sur l'upstream ou chez Alice. Moins d'état sur le broker de Bob, mais dépendance au lien réseau pour le réveiller ; contraire à l'exigence de localisation. Déplacer ultérieurement l'autorité exposerait des doubles minuteurs.
- **Option B :** un seul propriétaire, le broker de Bob ; les autres brokers ne transportent que des enveloppes corrélées et des reçus de délégation. Coût : références stables, négociation de capacités et déduplication aux sauts. Risque : ancien saut qui ignore les champs. Réversibilité : activation seulement après négociation positive ; aucun job synchronisé par la roadmap.

**Décision de conception : B.** La tolérance à la coupure réseau et la localisation de l'escalade sont les forces décisives.

### 5. Relances et fin du silence

- **Option A :** notifier une fois à chaque échéance et attendre Bob, avec un compteur de relances. Coût faible ; mais si Bob ne traite pas la première notification, le compteur n'avance jamais. Réversibilité facile, défaut silencieux.
- **Option B :** même notification, plus une échéance indépendante de réaction du délégant ; arrêt et escalade s'il ne réarme ni ne clôt. Coût : une transition temporelle supplémentaire. Risque : escalade alors que Bob travaille encore ; délai affiché et configurable côté opérateur, pas extensible sans borne par l'agent.

**Décision de conception : B.** Profil ratifié : trois relances réelles maximum et cinq minutes pour que Bob décide après une échéance, **par défaut**, avec surcharges bornées selon G. Le plafond d'une échéance vaut quatre heures par défaut ; ce plafond ne constitue pas une échéance implicite pour les messages qui n'en demandent pas.

## Target design & migration path

### A. Contrat agent et autorisation

**Décision de conception :** les outils existants prennent les formes suivantes. Les noms ci-dessous sont des exemples, les UUID retournés doivent être réutilisés intégralement.

| Intention | Appel | Effet |
|---|---|---|
| Déléguer | `send_message(to_peer_id="alice", message="Auditer la reprise…", deadline_sec=600)` | Envoi et création d'une tâche ; retourne `task_id`, libellé, échéance absolue, compteur `0/max_rearms` (0/3 par défaut) et profil effectif figé. |
| ACK ou progression | `send_message(to_peer_id="bob", message="ACK", task_id="uuid")` | Citation seulement. Ni clôture, ni report d'échéance. Un ACK sans UUID a le même effet sur le job : aucun. |
| Rendre et clôturer | `send_message(to_peer_id="bob", message="Rapport…", task_id="uuid", task_action="close")` | Alice remet son résultat et demande explicitement la clôture. Bob peut aussi clôturer en son nom. |
| Clôturer sans nouveau message | `send_message(task_id="uuid", task_action="close")` | Clôture seule ; aucune tentative de résolution d'un nom actif ni message vide artificiel. |
| Relancer après échéance | `send_message(to_peer_id="alice", message="Relance…", task_id="uuid", deadline_sec=600)` | Bob seul, état `overdue`, incrémente le compteur et réarme la même tâche. |

Lecture séparée : `check_messages(open_tasks_with="alice")` rend les tâches **déléguées par l'appelant**, sans lire ni acquitter le courrier. `check_messages(open_tasks_with="*")` rend toutes ses tâches non closes, y compris escaladées ou sans destinataire. L'appel sans argument garde strictement son effet actuel de lecture du courrier.

Règles de frontière :

1. Résoudre l'objet `task_id` dans le groupe de l'appelant authentifié, puis contrôler le participant. Un UUID n'est pas une autorisation. Les sentinelles ne sont pas des appelants ; une tâche ne cible ni `operator`, ni `deck`, ni soi-même. Création/réarmement réservés à Bob ; clôture permise à Bob ou à l'Alice liée à CETTE tâche, sans restriction de rôle `team-lead`.
2. Sans `task_id`, `deadline_sec` crée un job dont le UUID est minté par le broker propriétaire, jamais choisi par l'agent ; sans les deux, l'envoi demeure ordinaire. `task_action` impose `task_id`. UUID inconnu : erreur, jamais création de remplacement. Avec `task_id` seul et un message : citation, jamais clôture implicite. `deadline_sec` et `task_action=close` ensemble : erreur.
3. Si un message est envoyé, `message` et `to_peer_id` restent obligatoires au runtime. Sur tâche existante, le broker résout d'abord les participants stockés ; un nom fourni doit désigner l'autre participant courant, sinon erreur avec le nom courant. La clôture sans message n'exige ni nom ni pair actif. Un message et une mutation locale de tâche sont atomiques : aucune clôture réussie si le rapport associé est refusé.
4. `deadline_sec` : entier sûr, fini, de 1 à `max_deadline_sec` inclus (14 400 secondes, soit 4 heures, par défaut), sans coercition ; invalide, `NaN`, booléen, chaîne ou dépassement : refus avant l'envoi. L'échéance part de l'acceptation durable par le broker de Bob, même si une livraison distante attend le réseau. À la création, le broker applique le profil effectif de G ; au réarmement, le profil figé dans la tâche, jamais l'environnement du MCP ni un plafond choisi par Alice. Les limites et validations sont partagées dans un module pur.
5. Maximum proposé : 100 tâches non closes par délégant et groupe. La liste complète tient donc dans une réponse bornée ; tri par échéance puis UUID. Pour filtrer un ancien nom, comparer les snapshots des tâches du propriétaire, sans réattribuer la tâche au porteur actuel du nom ; rendre l'identité courante ou « disparu », l'état, le libellé, l'échéance et le compteur. Deux tâches chez Alice restent deux lignes. Deux incarnations portant le même nom restent deux identités distinctes.

**Décision de conception :** utiliser des routes HTTP internes distinctes malgré la surface MCP compacte : `/delegations/list` pour la lecture non destructive, `/delegations/close` pour la clôture seule, et `/send-message` pour l'envoi accompagné d'une opération. Même validateur et même contrôle d'autorité pour la clôture seule et la clôture accompagnée ; pas de logique de sécurité dupliquée. `myInstanceToken` reste dans `server.ts`, jamais dans un résultat agent.

**Décision de conception :** le MCP dérive `task_label` du texte initial avant `composeOutboundMessage` : espaces normalisés, contrôles retirés, 30 points de code Unicode, suffixe d'ellipse si tronqué. Ce champ HTTP interne est revalidé et borné par le broker ; un client HTTP créant une tâche doit aussi le fournir. Il est conservé une fois à la création. Refuser un texte utile ou un libellé vide. Ne pas ajouter un argument agent pour ce champ ni déplacer le framing existant. Le libellé n'est ni une clé ni une preuve et n'est pas interprété comme instruction.

### B. Rappel déterministe à réception

**Décision de conception :** le broker projette un `delegation_context` public sur les enveloppes destinées au MCP. Il contient, selon le message : la référence de tâche explicitement validée, son état, ou `open_from_recipient_to_sender` avec total et au plus cinq `{task_id, label, due_at, status}`. Aucun token ni référence interne d'autorité n'est exposé.

Lorsqu'un message ordinaire d'Alice arrive à Bob sans référence de tâche validée, le broker cherche les tâches non closes dont Bob est délégant et l'identité authentifiée d'Alice est déléguée. Le MCP ajoute :

> Alice a 2 tâches ouvertes de ta part : [UUID, libellé, état]… Vérifie si ce message en termine une ; si oui, clos-la explicitement avec send_message(task_id=…, task_action="close"). Un ACK ne clôt rien. Liste complète : check_messages(open_tasks_with="alice").

La note ne prétend pas que le rapport est suffisant et ne clôt jamais automatiquement. Un UUID écrit dans le texte libre ne la supprime pas. Une citation structurée inconnue ou ne concernant pas ces deux participants ne devient pas une citation valide.

**Décision de conception :** étendre le rendu commun vers un objet de message typé, sans accès réseau dans `shared/inbound-framing.ts`. Fournir le contexte depuis les trois producteurs broker : push immédiat, replay WS et poll/peek. Recalculer les tâches ouvertes au moment de la projection ; ne pas stocker un rappel textuel figé. Préserver ce contexte dans les candidats de `wait_for_message` et dans `formatInboundLine` : le quatrième chemin agent ne doit pas le perdre.

**DÉDUIT :** un waiter peut consommer la frame avant l'appel ordinaire à `renderInbound` (`server.ts:377-383`, `445-450`) ; tester seulement les deux appels directs serait donc insuffisant.

**Décision de conception :** la note s'applique à tout délégant, pas seulement à un rôle. Elle coexiste avec `expects_reply=false`, qui dispense d'un ACK mais pas du rapprochement/clôture. Une tâche déjà close peut encore figurer dans une ancienne notification ; la clôture répétée est idempotente et rend l'état courant. Pas de promesse de fraîcheur après émission de la frame.

### C. Tables SQLite et machine d'états

**Décision de conception :** créer `delegated_tasks`, indépendante de `messages`, sans FK de suppression vers `peers`.

| Colonnes logiques | Contrat |
|---|---|
| `task_id`, `group_id`, `owner_broker_id` | UUID aléatoire de tâche, groupe authentifié, UUID persistant du broker propriétaire. PK `task_id` ; toute requête d'autorisation vérifie aussi le groupe. |
| `delegator_token`, `delegate_kind`, `delegate_binding`, snapshots des deux `peer_id`, `label` | Token local de Bob ; Alice locale = token local, Alice distante = référence stable du § F. Union discriminée, pas de mélange nom/token/ref. Tokens exclusivement internes à la DB et aux frontières déjà authentifiées. |
| `status`, `due_at_ms`, `decision_due_at_ms`, `rearm_count`, `generation` | `armed`, `overdue`, `escalated`, `orphaned`, `delivery_failed`, `closed`. Temps UTC absolus ; compteur `0..max_rearms` ; génération monotone pour invalider un ancien événement d'échéance. |
| `max_rearms`, `lead_silence_sec`, `max_deadline_sec` | Snapshot du profil effectif à la création, validé selon G. Les modifications ultérieures de réglage ou d'environnement ne changent pas les engagements d'une tâche existante. |
| `created_at`, `updated_at`, `closed_at`, `closed_by_binding`, `terminal_reason`, `escalation_result` | Audit minimal et état d'escalade explicite : émission, impossibilité de routage ou absence de consommateur détectée. Ni texte intégral de rapport, ni journal conversationnel supplémentaire. |

Index : `(status, due_at_ms)` pour les tâches armées ; `(status, decision_due_at_ms)` pour les retards ; `(group_id, delegator_token, status)` pour les listes ; index sur le délégué pour le rappel. Les snapshots ne servent jamais à une jointure d'autorisation.

**Décision de conception :** une table `delegation_events` sert de registre/outbox technique borné par les opérations de tâche : `event_id` UUID, `task_id`, `generation`, `kind`, liaison de destination, enveloppe bornée, état de transport et timestamps. Unicité `(task_id, generation, kind)` pour `due` et `escalate`. Pour les opérations relayées, l'UUID d'événement est aussi la clé d'idempotence du saut. Les détails de transport ne deviennent pas un second job métier.

Pour une opération locale, transaction unique : validation de l'état courant, mutation de la tâche, insertion du message s'il existe, réservation de l'événement. Commit **avant** WS. Pour une opération distante, mutation du job propriétaire et écriture de l'outbox sont atomiques ; les tentatives réseau conservent le même `event_id`. La réception déduplique avant toute mutation et avant tout nouveau message. La DB ne reste jamais en transaction pendant un `await` réseau.

**Décision de conception :** fermer signifie retirer immédiatement la tâche du balayage et des listes ouvertes, pas effacer sa preuve. Garder un tombstone 30 jours après clôture et conserver la déduplication au moins aussi longtemps que toute enveloppe peut être rejouée. Après expiration de ce délai, un ancien `task_id` inconnu reste refusé. Les tâches non closes ne sont pas purgées par le TTL du courrier. Un événement d'alerte périmé par une clôture ou une nouvelle génération ne doit plus être rejoué comme alerte active.

### D. Balayage, plafond et escalade

**Décision de conception :** `sweepDelegatedTasks(now)` au démarrage puis toutes les 15 secondes via `guardedInterval`, batches de 100 ordonnés par échéance/UUID, sans timer individuel par tâche. Une erreur laisse l'itération suivante reprendre ; le log broker reçoit l'erreur. Aucun appel `sleep` ou `wait_for_message` n'est nécessaire au suivi.

1. `armed`, échéance atteinte, compteur inférieur au `max_rearms` figé : passer à `overdue`, poser `decision_due_at_ms = due_at_ms + lead_silence_sec * 1000`. Si ce délai est déjà écoulé, appliquer directement l'étape 3, sans réveil de relance périmé. Sinon insérer une notification durable à Bob depuis la sentinelle Deck et la pousser après commit. Texte : « Aucune clôture explicite d'Alice pour [UUID, libellé] ; échéance dépassée. Vérifie le résultat, clos ou relance avec une nouvelle échéance. Escalade à [heure absolue], soit dans [temps restant], sans décision. » Afficher la durée réellement restante, pas une constante « 5 min ». Ne pas dire « pas de nouvelle » : un ACK ou un point d'étape a pu arriver.
2. Bob réarme une tâche `overdue` **avant** `decision_due_at_ms` : envoi d'une véritable relance à Alice, compteur +1, génération +1, `armed`, nouvelle échéance, suppression logique de l'attente de décision. Le handler contrôle l'heure et le plafond même si le sweep n'a pas encore tourné. Un deuxième réarmement concurrent ne renouvelle pas une tâche déjà `armed` : résultat de conflit, pas nouvelle prolongation. Pas de réarmement préventif illimité ni de réarmement après escalade.
3. `armed` expire avec compteur égal à `max_rearms`, ou `overdue` atteint `decision_due_at_ms` sans décision : `escalated`, une seule émission vers l'inbox opérateur du **groupe et broker de Bob**, et information durable à Bob si son identité existe encore. Avec `max_rearms=0`, la première échéance déclenche directement cette escalade, sans invitation à relancer. Détail : tâche, libellé, participants/snapshots, dernière échéance, compteur/plafond, motif, et information que le broker ne relancera plus. Le broker ne relance jamais directement Alice à la place de Bob.
4. `closed` gagne contre tout événement pas encore émis ; après émission, aucune prétention de retirer un message déjà vu. Une clôture autorisée reste possible après `escalated`, `delivery_failed` ou `orphaned` et rend alors `closed` sans nouvelle notification. Un ACK ou `messages.delivered=1` ne modifie aucune transition. Une erreur de quota renvoie vers `check_messages(open_tasks_with="*")` pour examiner et clore les entrées non résolues.
5. Identité locale de Bob **ou** d'Alice supprimée, ou disparition définitive d'une liaison distante établie : une tâche encore `armed`/`overdue` passe à `orphaned` avant le traitement temporel, arrête son minuteur, tente une escalade locale unique et laisse une trace. Informer Bob seulement si sa liaison existe ; pas d'insertion violant la FK `messages.to_token`. Un groupe toujours présent ne répare pas une identité absente. Une identité dormante ou une coupure réseau ne constitue pas à elle seule une disparition définitive. Les tâches déjà escaladées/en échec restent sans minuteur et sans nouvelle escalade ; leur listing expose la disparition actuelle. Livraison distante définitivement refusée : `delivery_failed`, information à Bob et arrêt du minuteur concerné ; aucune annonce mensongère « Alice est en retard » pour une délégation refusée.

**Décision de conception :** avant de traiter une échéance, résoudre l'expiration de son transport. L'alerte porte toujours l'état observé : accepté par le broker destinataire, en attente de transport, ou refusé/expiré ; jamais « lu par Alice ». Un envoi non acheminé à son horizon devient `delivery_failed` plutôt qu'un reproche de retard à Alice.

**Décision de conception :** `max_rearms=N` signifie **un envoi initial + au plus N nouveaux envois de relance**, pas N réveils arbitraires ; N vaut trois par défaut. Les retries réseau d'un même événement ne consomment pas ce compteur et ne créent pas de nouvelles échéances. Les horloges restent absolues : ni arrêt de broker, ni tick tardif, ni reprise n'accordent une nouvelle fenêtre de silence ; cette règle borne aussi la durée maximale du cycle de relance. Un événement de transport ne peut rester en retry au-delà de son horizon annoncé : au plus l'échéance de la tâche pour une création/relance et 7 jours pour un résultat/clôture ; expiration visible au propriétaire, jamais `ok: closed` fictif.

**DÉDUIT :** la mécanique A peut acquitter un message de réveil lorsque Bob envoie n'importe quel autre message (`broker.ts:2095-2117`), et le WS reste fire-and-forget. **Décision de conception :** l'échéance indépendante de réaction doit donc lire l'état de la tâche, jamais la lecture du message. Elle protège contre un réveil non traité ; elle ne prouve pas que Bob l'a lu.

#### Inbox locale, sans promesse de présence humaine

**Décision de conception :** refuser la création d'une tâche suivie dans un groupe où `groupMayCarryOperatorInbox` est faux, avec une erreur explicite ; les messages sans échéance restent inchangés. Ne pas contourner la séparation du groupe `default` en créant une inbox globale.

**DÉDUIT :** un groupe avec secret ne prouve pas qu'un Deck consomme son inbox, et le curseur d'une nouvelle session commence après le courrier déjà déposé (`broker.ts:2010-2025`, `8282-8288`). **Décision de conception :** le résultat de création et d'escalade distingue « route inbox disponible » et « lecture humaine non garantie ». Une absence de consommateur connue est tracée et exposée dans l'état de tâche ; pas de boucle ni replay au prochain Deck. Les notifications restent des messages locaux soumis aux règles du Courrier, jamais des jobs répliqués. Ne pas refaire émettre une ancienne escalade parce qu'un nouveau Deck apparaît.

Le besoin « l'opérateur doit nécessairement être réveillé même sans Deck attaché » dépasserait ce contrat : ni l'existence d'un groupe ni SQLite ne fournissent un consommateur humain.

### E. Disparition, renommage et redémarrage

**Décision de conception :** séparer disponibilité et identité.

| Événement | Sort de la tâche |
|---|---|
| `/clear`, MCP redémarré, reprise sur le même token | Maintien. La tâche n'est pas attachée à la mémoire du modèle ; le prochain rappel inclut UUID et libellé. La reprise exacte dépend du broker, pas du texte de `peer_id`. |
| `set_id` ou nouveau nom avec token inchangé | Maintien. Afficher le nom courant, conserver le snapshot d'origine ; le listing global `*` permet de retrouver la tâche sans connaître l'ancien nom. |
| Alice dormant | Aucun succès déduit. Échéance maintenue, Bob averti avec la disponibilité constatée. Un réarmement qui exige un nouvel envoi à une Alice indisponible échoue sans repousser le délai d'escalade. Une clôture explicite de Bob reste possible. |
| Bob dormant, puis purgé | Tant que le token existe, courrier durable de réveil et délai d'escalade normal. Après purge, une tâche encore planifiable devient `orphaned` ; une tâche déjà escaladée/en échec reste sans minuteur et expose la disparition. Aucune attribution à un homonyme. L'enregistrement demeure consultable administrativement. |
| Nouveau token, nouvelle DB distante, groupe différent | Pas d'héritage. L'ancienne tâche reste non résolue/orpheline chez son propriétaire ; créer une tâche nouvelle si le travail doit être redispatché. Aucun rebind automatique par host/cwd, rôle, nom de tuile ou session Claude. La réinitialisation de la DB propriétaire détruit ses tâches : la durabilité couvre un redémarrage conservant SQLite, pas un effacement de la base. |

**DÉDUIT :** une collision active est une nouvelle identité même avec même répertoire (`broker.ts:2351-2380`) ; à l'inverse, le secours `cc_session_id` peut retrouver une identité quand la clé primaire de session change (`2276-2295`). **Décision de conception :** consommer le résultat de cette résolution existante, pas reproduire une deuxième heuristique dans les tâches.

**Décision de conception :** le retrait d'un pair ne détruit pas la tâche. Le balayage détecte les références introuvables ; les deux sites de suppression de pairs doivent faire l'objet de tests d'intégration, même sans nouvelle FK. Les tâches `orphaned` et `delivery_failed` sont des échecs non résolus, pas des succès. Une éventuelle réattribution administrative signée est hors de cette première surface : la reprise automatique serait plus dangereuse que cet état visible.

#### E1. Fin d'un run Kory et groupe conservé

**DÉDUIT :** `computeScope` crée un secret aléatoire sans `--scope`, mais dérive le groupe du scope explicite (`desktop/src/main/scope.ts:71-83`). La restauration d'un workspace **custom** reprend son groupe si le scope lancé correspond, ou si son secret a été mémorisé (`scope.ts:94-103`, `desktop/src/main/index.ts:2878-2886`). Un workspace éphémère ou un secret custom perdu produit au contraire un nouveau groupe. La formule raccourcie « restaurer un workspace garde le groupe » ne vaut donc pas universellement. Les numéros/noms de pairs ne sont pas une identité stable d'un run à l'autre ; seul un token réellement repris par le broker permet la continuité décrite ci-dessus.

**DÉDUIT :** le Deck lance aujourd'hui son broker loopback en `detached`, puis `unref` (`desktop/src/main/index.ts:1370-1372`). Le plan d'arrêt stoppe ses timers et le service (`3396-3434`) ; `SessionService.stop()` tue les PTY (`desktop/src/main/session-service.ts:586-595`). Ce plan ne contient pas d'arrêt du broker. **Dépendance de cycle de vie : carte `a7067102-68a6-4181-b04f-ac2d746e766c`**, encore `planned`, file 9 à la lecture `roadmap_get a7067102` du 2026-09-30 ; son volet ouvert traite le broker survivant à Kory. Cet ADR ne livre pas ce correctif et ne doit pas retirer le détachement à sa place.

**Décision de conception :** aucun arrêt de fenêtre ne vaut clôture explicite, et aucune tâche n'est attribuée au prochain occupant d'un groupe.

| Cas | Effet sur les jobs ouverts |
|---|---|
| Aujourd'hui : Kory ferme, broker propriétaire survivant | SQLite et le sweep restent autoritaires. Les pairs passent dormants selon la détection existante ; les échéances continuent, puis l'escalade intervient ou la disparition définitive produit `orphaned`. Le Courrier n'étant plus attaché, la lecture humaine n'est pas garantie. Les anciennes alertes ne sont ni repoussées ni réémises au prochain Deck. |
| Après `a7067102` : le broker propriétaire s'arrête avec Kory | Conserver SQLite, tâches, snapshots et déduplication ; arrêter l'exécution, pas transformer en `closed` ni supprimer les jobs. Aucun réveil n'est possible pendant l'arrêt. Au prochain démarrage sur la même DB, réconcilier la disponibilité des pairs avant le sweep, vérifier les liaisons, puis traiter les temps UTC écoulés. Si la fenêtre de décision a expiré, escalader directement plutôt que donner cinq nouvelles minutes. Si l'identité a disparu, `orphaned` prime. Sans redémarrage, les jobs restent persistés mais non exécutés. |
| Broker distant ou partagé qui reste légitimement vivant | Même sémantique que le broker survivant : la fermeture d'un Deck n'autorise pas l'arrêt du service de tous les autres. Le correctif `a7067102` doit établir la propriété du processus ; cet ADR ne suppose pas que tous les brokers meurent avec une fenêtre. |
| Nouveau run avec groupe différent | Les tâches restent dans l'ancien groupe sur le broker propriétaire. Le nouveau run ne les récupère ni par nom de pair, ni par projet, ni par répertoire. Les anciennes liaisons suivent les règles dormant/disparu, sans notification transférée au nouveau groupe. |
| Nouveau run, même groupe (`--scope` ou workspace custom restaurable), ancien pair absent | La recherche de la liaison enregistrée échoue même si le groupe existe encore : tâche planifiable vers `orphaned`, arrêt du job et motif explicite. Un nouveau `peer_id`, ou même un nom réutilisé avec token neuf, n'hérite de rien. Si l'ancien token n'est que dormant, appliquer dormant, pas disparu ; si le broker reprend réellement ce token, appliquer maintien. |

**Décision de conception :** la réconciliation au démarrage utilise le nettoyage existant des pairs locaux à processus mort avant le premier sweep de tâches ; les pairs distants conservent leurs règles de heartbeat et de grâce réseau, sans être déclarés disparus parce que leur annuaire n'a pas encore été resynchronisé. Une liaison existante mais indisponible reste soumise à ses échéances, une liaison définitivement supprimée devient orpheline. Au démarrage, coalescer les événements périmés vers le seul état actuel ; ne pas rejouer toutes les échéances manquées. Une tâche dont l'escalade a déjà été émise ne génère pas un nouveau courrier à cause du run suivant. Si l'escalade devient due pour la première fois au redémarrage, son émission unique respecte le curseur courant du Courrier, sans garantie de lecture. La persistance du **job** n'introduit donc ni persistance inter-run d'une notification opérateur, ni replay d'inbox.

### F. Federation : prérequis non optionnel pour les participants distants

**DÉDUIT :** garder seulement le token d'un miroir serait faux : `upsertMirror` réemploie la ligne portant le même nom (`broker.ts:7671-7689`), et `applyFederationTx` attribue aussi l'émetteur par nom (`7812-7838`). Le relais aval conserve le nom dans sa file (`7895-7900`). Un nouveau pair reprenant ce nom pourrait donc recevoir un ancien travail ou sembler autorisé à le clore.

**Décision de conception :** le lot distant ajoute une référence de transport stable `peer_ref`, opaque et non secrète, stampée par l'upstream. Elle n'est **jamais** une preuve d'appelant à elle seule, n'est pas un `instance_token` public et ne modifie pas l'identité portable des agents.

#### F1. Dérivation et migration

- Pair natif upstream : hash SHA-256 avec séparation de domaine de `(upstream_broker_id, "delegation-native-v1", group_id, instance_token)`.
- Pair relayé : hash SHA-256 avec séparation de domaine de `(upstream_broker_id, "delegation-relay-v1", group_id, relay_id, relay_ref)`. **DÉDUIT :** la liaison `(relay_id, relay_ref)` est stable dans le lookup upstream (`broker.ts:5593-5595`), tandis que son token interne est recréé après suppression (`5626-5635`). Hacher ce dernier briserait une continuité qui existe déjà.
- Stocker `upstream_id` et `peer_ref` sur les miroirs ; les inclure dans `FederatedPeer`, `assigned` et l'attribution des messages, pas dans les résultats MCP publics. Mettre à jour les pick-lists explicitement ; aucun spread de ligne DB.
- Les miroirs nouveaux s'apparient par `(group_id, upstream_id, peer_ref)`. Migration de l'unicité par nom obligatoire : un ancien nom peut être repris par une nouvelle ref sans réactiver l'ancien miroir ni violer l'index. Conserver les anciens miroirs comme tombstones dormants avec leur identité, libérer leur alias upstream courant avant de créer le nouvel occupant, et conserver une unicité des alias **courants**. Les anciennes lignes sans ref ne peuvent jamais fonder une autorisation de tâche ; ne pas inventer leur ref à partir du nom.

**DÉDUIT :** l'index actuel unique sur `(group_id, upstream_peer_id)` (`broker.ts:606`) entre en conflit avec la coexistence de deux incarnations portant successivement le même nom. Une simple colonne supplémentaire sans migration de l'index ne suffit pas.

#### F2. Routage et autorité uniques

**Décision de conception :** toute enveloppe de tâche transporte `owner_broker_id`, `task_id`, `event_id`, `generation`, opération, références de participants et libellé borné. Le broker d'origine estampille l'émetteur depuis l'appelant authentifié ; les clients ne choisissent jamais `from_peer_ref`. L'upstream authentifie le relais et la ligne `(relay_id, relay_ref)` avant de produire la référence publique correspondante.

**DÉDUIT :** `BROKER_ID` et `REPLICA_ID` sont deux UUID persistés séparément (`broker.ts:1021-1028`, `6847-6853`), et le sync actuel ne présente que le second (`shared/types.ts:809-815`). **Décision de conception :** ajouter `broker_id` à la requête de sync et conserver upstream l'association unique `replica_id -> broker_id`, sous les mêmes contrôles d'accès que le relais. Refuser une substitution silencieuse de cette association ; une nouvelle DB doit se présenter comme une nouvelle identité de replica. Pour un propriétaire replica, vérifier que l'origine de la création correspond à cette association et que Bob est bien une ligne relayée par ce replica. Pour un propriétaire natif, `owner_broker_id` est le `BROKER_ID` local. Ne jamais inférer un broker à partir du nom de Bob. Absence de `broker_id` ou association refusée : seules les délégations sont refusées ; la découverte des pairs, la roadmap et le courrier ordinaire continuent sous leur contrat existant.

`/federation/send` reçoit obligatoirement `to_peer_ref` pour les messages de tâche. Il résout la référence dans le groupe, pas le seul nom. Si le nom fourni correspond désormais à une autre référence, refuser ou corriger explicitement vers le pair retrouvé par référence ; **ne jamais livrer au nouveau porteur du nom**. Le même contrôle s'applique à la file hors ligne : la destination de l'événement est figée à l'acceptation, pas relue sur un miroir pouvant avoir changé de nom.

Un seul `delegated_tasks` fait autorité : celui de Bob. Si Bob est local au replica, ni l'upstream ni le replica d'Alice ne créent un deuxième minuteur. Si Bob est natif upstream, l'upstream est propriétaire. Les propriétaires ne sont pas déduits du rôle ou du broker le plus central.

**Décision de conception :** pour permettre à Alice de citer/clore après un `/clear`, son broker conserve un **reçu sans minuterie**, `delegation_receipts(owner_broker_id, task_id, group_id, delegate_binding, owner_route, label, generation, expires_at)`, clé primaire `(owner_broker_id, task_id)`. Le reçu est construit à partir d'une délégation authentifiée reçue, jamais d'un texte agent. `owner_route` est un descripteur de routage interne (broker propriétaire et référence de Bob), **jamais une URL, un host ou une commande fourni par un message**. Il sert à router la clôture sans message, n'autorise pas une réattribution et ne constitue pas une copie du job. Une clôture distante est une enveloppe adressée au propriétaire : seul ce dernier vérifie `from_peer_ref == delegate_binding`, groupe et tâche avant de muter l'état.

Les reçus sont plafonnés à 100 actifs par `(group_id, delegate_binding)` et à 20 000 par broker ; la saturation refuse visiblement l'acceptation de la délégation et remonte au propriétaire. Le propriétaire inscrit dans l'enveloppe `created_at` et `receipt_expires_at = created_at + 45 jours`, repris par le reçu et le registre upstream après validation ; ni le broker d'Alice ni un retry ne repartent de leur heure locale de réception. Plafond de rétention non surchargeable, sans prolongation par répétition ni réarmement. Avec les bornes du § G, le cycle planifiable maximal et son transport tiennent dans `(1 + 10) * 24 h + 10 * 1 h + 7 jours = 18 jours 10 heures`, sous 45 jours. Le calcul inclut les fenêtres de décision et suppose leur ancrage absolu imposé en D ; un redémarrage n'allonge pas cet horizon. Après 45 jours, une tâche escaladée/orpheline peut rester ouverte chez Bob, mais Alice reçoit une erreur de reçu expiré au lieu d'une fausse clôture transmise ; Bob garde la clôture locale. Après confirmation de clôture, supprimer le contenu actif et conserver le minimum de déduplication 30 jours. Une réception par `task_id` seul résout tous les candidats du groupe pour l'appelant : zéro = inconnu, plusieurs = erreur d'ambiguïté exigeant le destinataire pour distinguer les propriétaires, jamais `LIMIT 1`. La tâche locale de Bob conserve la priorité de résolution uniquement si sa liaison et l'opération correspondent ; en cas de conflit réel avec un reçu, refuser plutôt que choisir. Un UUID aléatoire n'est pas une justification pour ignorer une collision fabriquée à la frontière.

Le résultat MCP d'Alice dit « clôture transmise/en attente » tant que le broker propriétaire ne l'a pas confirmée ; une réponse de relais `ok:true` n'est pas une preuve de clôture. La confirmation métier revient comme événement corrélé, sans nouvelle tâche et sans ACK demandé au modèle. Bob peut toujours clôturer localement son propre job, même pendant la coupure.

#### F3. Transport, retries et versions

**DÉDUIT :** le courrier fédéré actuel joint la cible à `peers` et exige `p.status = 'active'` (`broker.ts:5675-5685`) ; son stockage a une FK vers le pair (`618-619`). Ce transport seul ne peut appliquer une clôture chez Bob dormant ou purgé.

**Décision de conception :** distinguer deux canaux logiques sur la federation existante :

1. Les messages de délégation et les rapports **sans clôture** portent leur contexte dans le relais, `messages`, `FederatedMessage`, puis WS/poll/peek. Ils restent soumis aux règles de livraison de pair. Les champs d'identité sont stampés, pas inférés du texte. Un rapport accompagné d'une clôture prend exclusivement le canal 2, sans deuxième envoi en parallèle.
2. Les **opérations de tâche et confirmations métier** transitent par une file broker-adressée `federation_delegation_events`, indépendante de `messages` et sans FK vers un pair. Clé de déduplication `(origin_broker_id, event_id)`, propriétaire/route de destination vérifié par l'association F2, groupe, enveloppe bornée, date d'expiration et état d'acquittement. Un champ arbitraire `destination_broker_id` ne donne pas le droit de déposer un événement : il faut une création autorisée ou un reçu authentifié et la liaison des participants. L'upstream peut vérifier le registre de délégation `(owner_broker_id, task_id, delegate_ref)` créé lors de son transit initial ; ce registre n'a pas de minuteur.
3. Le replica envoie ses événements sortants dans des tableaux bornés `delegation_events` du sync ; l'upstream applique immédiatement ceux dont il est destinataire et stocke ceux d'un autre replica. Une confirmation métier vise le broker d'Alice et termine son reçu ; ce destinataire n'est pas nécessairement le propriétaire du job. Il retourne les événements adressés au **broker** demandeur même si sa liste de pairs actifs est vide, sous le contrôle de son `replica_id`, de son `broker_id` et du groupe épinglé. Cette branche ne dépend ni du filtre de pairs actifs ni du `to_ref` du courrier. `delegation_acks` est distinct des ACK de messages ; seuls les événements durablement reçus/appliqués sont acquittés. Les groupes ayant des tâches actives restent présentés par le replica même sans pair actif, sans permettre de pinner un groupe nouveau par ce seul mécanisme.
4. Une opération avec rapport est une seule enveloppe : le broker propriétaire applique clôture et insertion du rapport dans la même transaction, puis confirme. Le corps du rapport et un snapshot d'émetteur stampé et borné (`peer_ref`, nom, host, cwd, summary) voyagent dans cette enveloppe ; si le miroir de l'émetteur manque, le recréer par référence stable, jamais par nom. La réception ne dépend donc pas de sa présence dans l'annuaire actif. Le contrôle ne doit pas attendre un deuxième message arrivé par un autre chemin. Bob dormant avec ligne locale : transaction possible et tâche close immédiatement. Bob purgé : une clôture seule reste possible par Alice authentifiée ; une clôture accompagnée d'un rapport impossible à déposer est refusée explicitement, sans succès de clôture fictif. La confirmation métier peut retourner au broker d'Alice même si Alice est devenue dormante.
5. L'outbox garde chaque événement jusqu'à acquittement durable ; la file upstream ne rejoue pas une mutation à la reconnexion. Quotas proposés : 20 000 événements en attente par broker, 200 par batch, charge de texte au plus la limite de message existante. Saturation avant acceptation = refus visible sans mutation locale annoncée réussie. Expiration et refus font l'objet d'un événement corrélé ou, si sa route est impossible, d'un état terminal et d'une trace locale. Aucune boucle de retry sans horizon.

Cette extension est un canal de **contrôle de tâche**, pas une federation de notifications opérateur. Les envois distants suivis utilisent l'outbox durable de leur broker d'origine, y compris lorsqu'un réseau est actuellement disponible. Déduplication à l'upstream et au broker propriétaire. Une attribution manquante ou une enveloppe mal formée ne peut jamais clore une tâche. Un texte éventuellement livré sans corrélation doit porter une erreur visible de suivi ; jamais une réussite silencieuse. Une coupure ne déplace ni le job ni son échéance. Le rappel à Bob et l'escalade restent locaux et fonctionnent sans upstream.

**Décision de conception :** capacité positive `delegations_v1` sur le protocole client/broker et sur les deux sens de federation sync. Absence = fonctionnalité non prise en charge. L'upstream conserve les capacités du dernier sync par `replica_id`, les remplace entièrement à chaque sync et efface `delegations_v1` si elle n'est plus annoncée. Il transmet `FederatedPeer.caps` pour chaque route : capacité du replica porteur pour une ligne relayée, capacité propre pour un pair natif. Il annonce aussi dans le sync les capacités par route broker pour les opérations dont Bob est dormant et absent de l'annuaire actif ; la clé est l'association de F2, pas un nom de pair. Avant chaque création, relance ou clôture relayée, vérifier les capacités locales et celles connues de toute la route ; revérifier au saut agissant contre le dernier sync, pas seulement à la création du reçu. Une route sans preuve positive refuse l'opération suivie **avant** de créer un job ou d'émettre le message. Les capacités d'un replica sont remplacées par celles de la requête de sync **en cours avant de composer sa réponse**, dans la même transaction. Leur snapshot porte `as_of` ; au-delà de la grâce de fédération, un lien muet ne fonde plus une création ou relance neuve. Un événement déjà durable peut attendre le retour d'une annonce positive, dans son horizon borné, mais n'est pas livré à un consommateur rétrogradé. Une erreur de capacité reste visible ; elle ne devient jamais une réussite silencieuse. Avant première synchronisation de capacités, refus explicite. Les messages ordinaires restent compatibles.

**DÉDUIT :** le contrat actuel de federation ne comporte pas cette annonce (`shared/types.ts:809-837`) ; un vieux serveur peut donc accepter le texte tout en ignorant un champ inconnu. Ne pas traiter `ok:true` ou la présence de la route comme une preuve de support.

Déploiement : upstream d'abord avec capacité et réception additive, replicas ensuite, puis MCP utilisant les nouveaux arguments. N'activer le distant qu'après capacité positive de toute la route. Un downgrade suspend les envois suivis, expose le motif et laisse les jobs déjà propriétaires s'échelonner localement ; il ne les réplique pas ailleurs. Changer d'upstream ou réinitialiser sa DB change la référence de transport : orphelin visible, jamais héritage par nom.

### G. Réglages, précédence et application effective

**DÉDUIT :** le core lit le fichier global `%APPDATA%/claude-peers/config.json` ou `$XDG_CONFIG_HOME/claude-peers/config.json` (repli `~/.config/claude-peers/config.json`), avec clés snake_case et environnement prioritaire (`shared/config.ts:64-97`, `153-214`). Le broker appelle `loadConfig` à son initialisation (`broker.ts:255`). Le panneau Broker du Deck possède déjà un écrivain main-side de ce fichier, à clé bornée, verrou et écriture atomique (`desktop/src/main/peers-config-store.ts:77-122`) ; sa projection vers le renderer emploie des clés camelCase (`28-55`). C'est un autre stockage que l'`AppConfig` du Deck (`desktop/src/main/store.ts:96-132`).

#### Options et verdict

- **Option A : fichier core édité depuis les réglages Broker, application au démarrage du propriétaire.** Coût : trois champs, validateur partagé, projection de l'effectif et écrivain typé. Risque : confondre « enregistré » et « appliqué », ou écrire le fichier du poste pour un broker distant ; les gardes ci-dessous l'interdisent. Réversibilité additive. Rayon d'impact : politique globale du broker, seulement les nouvelles tâches.
- **Option B : politique mutable par groupe via une nouvelle route d'administration.** Bénéfice : effet immédiat, réglage distant. Coût et risque supérieurs : nouvelle autorité d'écriture, conflit entre deux Decks du même groupe, stockage et protocoles de mise à jour. Rayon d'impact : nouveau contrôle d'administration partagé. Réversibilité plus coûteuse après exposition de cette API.

**Décision de conception : A.** Un réglage est bien disponible dans le Deck pour le broker local/replica dont il peut éditer la configuration ; un broker distant se règle sur **son hôte**, par le même fichier core ou son environnement de service. Pas de route d'écriture runtime ajoutée à cette carte. En remote, le Deck présente l'effectif en lecture seule et ne prétend pas modifier le distant en écrivant localement. Ne pas dupliquer ces valeurs dans `AppConfig`, une configuration de projet, un template, une variable de session MCP ou un profil de groupe.

#### Noms et bornes normatives

| Paramètre | Variable du processus broker | Clé persistée du fichier core | Clé de réglage/projection Deck (`PeersConfigSummary`) | Défaut | Min..max inclus |
|---|---|---|---|---:|---:|
| Nombre de relances, hors envoi initial | `CLAUDE_PEERS_DELEGATION_MAX_REARMS` | `delegation_max_rearms` | `delegationMaxRearms` | 3 | 0..10 |
| Silence du délégant après échéance, secondes | `CLAUDE_PEERS_DELEGATION_LEAD_SILENCE_SEC` | `delegation_lead_silence_sec` | `delegationLeadSilenceSec` | 300 | 15..3 600 |
| Maximum d'une échéance demandée, secondes | `CLAUDE_PEERS_DELEGATION_MAX_DEADLINE_SEC` | `delegation_max_deadline_sec` | `delegationMaxDeadlineSec` | 14 400 | 1..86 400 |

**Décision de conception :** ces maxima sont des plafonds durs non surchargeables. Zéro relance signifie escalade à la première échéance ; zéro silence ou zéro échéance sont refusés. La borne de silence de 15 secondes correspond à une période de balayage, sans promettre une précision à la seconde. Le maximum configurable de 24 heures permet une hausse explicite du défaut 4 heures sans revenir à un suivi multi-semaines par échéance. Les bornes sont des arbitrages techniques de cet ADR, distincts des valeurs par défaut ratifiées.

#### Flux de configuration et validation

1. **Autorité : le broker propriétaire de Bob.** À son démarrage, résoudre chaque valeur avec précédence `env du broker > fichier core de cet hôte > défaut`. Le Deck ne calcule pas l'effectif depuis son propre environnement ; l'environnement d'un service distant ou celui d'un broker déjà adopté peut être différent. Le MCP vérifie seulement la forme et les bornes dures ; le plafond configurable est contrôlé par le propriétaire. En replica, ni les réglages de l'upstream ni ceux du broker d'Alice ne remplacent le snapshot de Bob.
2. **Validation : un module pur partagé.** Fichier/IPC : type `number`, `Number.isSafeInteger` et `Number.isFinite`, bornes incluses ; chaînes, booléens, `null`, décimaux, `NaN`, infinis refusés. Environnement : chaîne décimale entière stricte avant conversion, puis mêmes contrôles ; chaîne vide, suffixe d'unité, notation non entière et dépassement refusés, jamais `parseInt` permissif ni clamp. Absence seule = héritage ; une valeur présente invalide ne devient pas silencieusement le défaut. Le writer refuse avant toute écriture, conserve l'ancien fichier et signale l'erreur via le journal/toast existant. Au démarrage, une configuration de suivi invalide bloque les **nouvelles créations de tâches**, expose le diagnostic et laisse le broker partagé servir ses autres fonctions ; clôtures, listes et jobs existants continuent avec leurs snapshots validés. Ne pas utiliser le lecteur tolérant du core pour transformer une configuration illisible en profil présenté comme valide : cette fonctionnalité doit conserver l'erreur de lecture/parsing, tout en laissant la politique de disponibilité historique des autres fonctions inchangée.
3. **Écrivain Deck :** étendre `peers-config-store.ts` et la chaîne IPC dédiée, avec une opération typée `peersConfig:setDelegationPolicy` / `setDelegationPolicy`, contenant uniquement les trois valeurs nommées, jamais une clé arbitraire ni un chemin fourni par renderer/companion. Résoudre le chemin côté main, revalider, relire sous le verrou et écrire atomiquement les seules clés autorisées ; conserver `broker_url`, tokens et toutes les autres clés. Classer ce nouveau canal dans les surfaces companion et les droits IPC. Un import du validateur pur est à préférer à trois validations divergentes. Les réglages sont globaux au **broker**, pas privés au run qui ouvre le panneau.
4. **Effectif distinct de l'enregistré :** ajouter une projection non secrète `delegation_policy` à `/health`, produite par le broker : disponibilité pour les nouvelles tâches, valeurs effectives, origine de chaque valeur (`env`, `file`, `default`), bornes et diagnostics assainis. Pour le broker loopback, une empreinte non secrète du chemin de configuration canonique permet au main de vérifier qu'il édite bien le fichier lu par ce processus ; canoniser les deux côtés de la même manière, sans exposer chemin ni secret au renderer. Un broker adopté pointant un autre fichier reste en lecture seule. Le Deck affiche séparément valeur enregistrée et valeur active ; il n'annonce « appliqué » qu'à partir de la réponse du propriétaire. Variable prioritaire : signaler le masquage du réglage fichier. Broker ancien/injoignable : effectif inconnu, jamais inféré du fichier. Mode remote : pas d'écriture locale présentée comme un réglage distant.
5. **Application : redémarrage explicite du broker requis**, sans arrêt forcé d'un broker partagé par ce panneau. Le statut reste « enregistré, redémarrage du broker requis » jusqu'à lecture de l'effectif attendu ; relancer seulement Kory ne suffit pas si le broker est adopté ou survit. Au premier lancement, le broker lit directement le fichier ; le Deck ne projette pas ces réglages dans l'environnement des agents. À la création d'une tâche, figer les trois valeurs dans `delegated_tasks` et les retourner au délégant. Au réarmement, garder ce snapshot, y compris le plafond d'échéance : un changement ultérieur ne réécrit pas les règles de cette tâche. Le redémarrage avec une nouvelle configuration ne supprime ni ne prolonge les anciens jobs.

**Décision de conception :** la validation couvre aussi les erreurs d'environnement du broker lancé depuis une entrée MCP globale : `index.ts:1365-1370` combine actuellement environnement Deck et `entryEnv` avant le spawn. Seul l'effectif remonté par le broker tranche ; la simple valeur du panneau ou d'un shell local ne constitue pas une preuve d'application.

## Découpe en lots livrables et tests exigibles

Les fichiers de test nouveaux ci-dessous sont des **cibles proposées**, pas des fichiers dont l'existence est affirmée. Chaque contributeur lance uniquement son fichier ciblé. La suite complète, le smoke build et les typechecks appartiennent au séquenceur, une fois par lot de commits.

### Lot 1 : noyau local et échéance complète

**Livrable :** types/validation pure `shared/delegated-task.ts`, tables et index, création atomique avec envoi, liste non destructive, clôture, réarmement, balayage et escalade locale. Ajouter le chargement des trois réglages core, snapshots et projection effective `/health` selon G. Dans `shared/config.ts`, faire porter par la lecture du fichier un résultat structuré valeur/origine/erreur avant le repli historique vers `{}` ; `loadConfig` expose séparément l'état de la politique de délégation, tandis que les autres champs conservent leur repli. Ne pas relire trois fois le fichier ni perdre l'erreur avant de construire cette politique. Pour l'empreinte de fichier, placer la fonction commune de liaison canonique dans un module `shared/` sans dépendance desktop ; tester sa parité avec `canonicalPath` du Deck sur lien symbolique, casse Windows et chemin court 8.3, y compris fichier encore absent (parent canonique). Une différence reste un refus d'édition, pas un repli vers comparaison brute. Routes internes disponibles ; participants distant/relayé refusés tant que F n'est pas livré. Les appels ordinaires sont inchangés. Pas de travail visuel dans ce lot ; le réglage fichier/environnement est déjà effectif côté broker.

Tests proposés : `tests/delegated-task.test.ts`, puis `tests/broker-delegated-task.test.ts` dans des appels distincts.

1. Deux tâches Bob vers Alice, deux Bob homonymes dans deux groupes ; tiers et sentinelle refusés ; nombres invalides, plafond de tâches, label Unicode. Message sans échéance : zéro job. ACK, citation seule et acquittement du courrier : zéro clôture.
2. Clôture par chacun des deux participants ; close-only sans pair actif ; inconnu, mauvaise cible et mauvaise paire refusés ; transaction annulée si rapport invalide ; double clôture idempotente.
3. Horloge injectée ou lignes antidatées : un seul rappel par génération, 15 secondes de granularité attendue sans assertion de temps réel fragile ; réarmement concurrent unique ; initial + trois relances au défaut, puis une escalade ; profils 0 et 10 relances ; Bob muet, escalade après délai figé ; un réarmement après ce délai est refusé même avant le prochain tick. Aucune boucle en cas d'échec d'inbox.
4. Redémarrage sur la même DB avant/après commit et avant/après push : aucun double job ni oubli d'échéance ; pas de nouvelle fenêtre de silence après interruption longue, escalade directe si elle a expiré. Changer les trois réglages avant restart ne modifie pas les snapshots des anciennes tâches. Erreur SQLite tracée et prochain tick encore exécuté.
5. Rename/reprise même token ; collision active token neuf ; purge et unregister des deux participants ; groupe conservé mais ancien pair disparu, avec un homonyme nouveau : `orphaned`, zéro routage au nouveau pair. Groupe nouveau : zéro transfert. Couvrir les deux durées de vie du broker de E1, sans revendiquer `a7067102` livré ; aucune FK en erreur. Groupe sans inbox refusé ; nouveau curseur Courrier ne rejoue pas une vieille escalade.

**Tests de configuration exigibles dans le même lot :** défauts 3/300/14400, chacune des trois surcharges par fichier puis environnement, précédence et source remontées ; min et max inclus, valeurs juste hors bornes, `NaN`, infinis, fractions, booléens, chaînes JSON, environnement vide ou à suffixe rejetés. Configuration illisible/invalide : nouvelles créations refusées avec diagnostic, messagerie et clôture des tâches existantes préservées. Un MCP sans l'environnement du broker accepte la forme d'une échéance de 8 heures lorsque le broker est configuré à 12 heures ; le défaut 4 heures la refuse côté propriétaire.

### Lot 2 : surface MCP et rappel dans tous les chemins

**Livrable :** arguments mesurés, accusés explicites, projections broker, enforcer de rendu typé, note de rapprochement et passage dans les waiters. Étendre le panneau Broker existant et sa chaîne main/preload/types/companion pour les trois réglages de G ; pas de nouvel écran de suivi. Mettre à jour la documentation du contrat et des variables, sans recopier les règles dans les instructions.

Tests proposés : `tests/peer-delegated-task-framing.test.ts`, `tests/server-delegated-task.test.ts` ; rejouer séparément `tests/peer-mcp-surface-budget.test.ts`.

1. Un vrai échange MCP créé sans attendre, puis appel d'un autre outil encore possible ; pas de long-poll caché. ACK et rapport sans UUID laissent le job ouvert et ajoutent le rappel attendu.
2. WS direct, replay WS, fallback peek, `check_messages`, waiter déjà enregistré et peek opportuniste du waiter : même note et mêmes identités ; aucune perte du contexte structuré. Vérifier le câblage, pas seulement la fonction pure de rendu.
3. `expects_reply=false` et rappel coexistent sans demander un ACK ; Bob n'a aucune tâche chez cet émetteur, aucun rappel ; note bornée à cinq entrées avec total exact et liste complète accessible.
4. `check_messages(open_tasks_with=…)` n'appelle pas le drain et ne modifie pas `delivered`. `*` retrouve tâches d'anciens noms et états escaladés. Les erreurs de capability sont visibles, aucun ancien broker n'est annoncé comme ayant créé un job.
5. Budget réel inférieur ou égal à 19 000 pour LF et CRLF ; anciens appels inchangés, résultat close-only non présenté comme un envoi ; un changement concurrent de schéma doit refaire la mesure.

**Tests Deck supplémentaires proposés :** `tests/desktop-delegation-settings.test.ts`, en invocation ciblée séparée. Sauvegarde atomique des trois clés sans altérer les autres ; valeurs invalides et nom de clé/path injecté refusés main-side ; source env signalée, enregistré distinct de l'effectif ; effet observé seulement après redémarrage du vrai broker ; remote et broker loopback lisant un autre fichier en lecture seule ; broker ancien/injoignable = effectif inconnu. Deux Decks utilisant le même broker observent le même profil global, sans qu'un run écrase une copie privée dans `AppConfig`.

### Lot 3 : identité et capacités fédérées, activation distante encore fermée

**Livrable :** `peer_ref`, migration des miroirs/index, association `replica_id -> broker_id`, capacités end-to-end publiées et révoquées par route, routage par référence et garde sur chaque saut. Pas encore de job distant accepté. C'est la couture la plus risquée ; elle mérite un lot séparé de la machine d'états.

Tests proposés : `tests/broker-federation-peer-ref.test.ts`, intégration avec upstream et deux replicas isolés.

1. Rename puis nouvelle incarnation reprenant le nom, deux fois de suite ; aucune réactivation de l'ancien sujet ni passe de sync bloquée par l'unicité. Deux pairs même host/cwd et deux groupes, aucun choix par `LIMIT 1` ambigu.
2. Nom repris entre annuaire et envoi, ainsi qu'avant vidange de la file hors ligne : refus ou routage vers la bonne ref, jamais vers l'homonyme. Message d'un émetteur absent de l'annuaire : attribution stable ou refus de corrélation.
3. Ligne relayée purgée upstream puis réintroduite sous même `(relay_id, relay_ref)` : même ref ; nouveau token d'origine : nouvelle ref. Changement d'upstream/DB : aucune continuité implicite.
4. Upstream ancien, replica cible ancien, capability absente, premier sync non effectué, downgrade : refus du suivi sans dégrader la messagerie ordinaire. Aucun token/PID dans directory, messages ni MCP.
5. Les routes n'acceptent jamais une `peer_ref` déclarée comme authentification ; émetteur estampillé par le broker ; mauvais groupe et substitution de destinataire refusés.

### Lot 4 : suivi distant de bout en bout

**Livrable :** enveloppes de tâche adressées au broker indépendamment des pairs actifs, reçus non planificateurs bornés, outbox/déduplication, confirmation de clôture et activation du suivi distant après négociation. La carte entière n'est clôturable qu'ici, sauf réduction explicite de périmètre par l'opérateur.

Tests proposés : `tests/broker-delegation-federation.test.ts`, puis `tests/server-delegated-task.test.ts` ciblé sur le rendu de résultat distant.

1. Bob replica/Alice upstream, Bob upstream/Alice replica, Bob replica A/Alice replica B : job sur le seul broker de Bob ; zéro job planificateur sur les autres ; tâche, label et référence traversent les deux directions.
2. Alice rend et clôt, Bob clôt sans Alice, Alice ACK seulement, réponse sans UUID ; le rappel de rapprochement fonctionne à réception sur le broker de Bob. Une référence falsifiée ne clôt rien.
3. Crash après acceptation upstream avant réponse, relecture de sync, doublon de clôture et réarmement concurrent : pas de double compteur, pas de double rapport, état final déterministe. Résultat « en attente » tant que la confirmation métier n'est pas obtenue.
4. Coupure réseau pendant l'échéance : Bob réveillé localement, puis escalade locale unique ; aucune notification opérateur fédérée ; reconnexion après clôture : pas de relance ressuscitée.
5. Bob dormant avec zéro pair actif relayé : Alice clôt, le broker propriétaire applique sans attendre la reprise de Bob. Bob purgé : close-only autorisé pour l'Alice liée, rapport impossible refusé explicitement. Refus permanent, expiration de transport, purge d'Alice et remplacement homonyme : état visible non résolu, jamais attribution automatique. Combiner limites de files/reçus, TTL, collision de UUID entre deux propriétaires, substitution de `broker_id` et downgrade de capacités entre création et clôture. Au profil maximal 10/3600/86400, vérifier la borne 18 jours 10 heures et le reçu expirant 45 jours après création ; ni retry, ni relais tardif, ni restart n'allongent cette expiration. Les réglages différents chez Alice et sur l'upstream ne changent ni ce reçu ni le profil propriétaire de Bob.

## Confrontation et points ouverts pour le superviseur

**DÉDUIT, confrontation indépendante :** l'explorer `desktop-7b2civn-koryphaios-3` a contesté l'emploi d'un token de miroir, puis retenu le principe étendu sous cinq exigences : migration de l'index de nom, référence contrôlée au saut agissant, transport dans les deux sens, capacité positive de chaque côté, dérivation spécifique aux lignes relayées. Les sources correspondantes sont exposées en F. Une seconde confrontation a fait expliciter trois autres points : association des deux UUID de broker, transport indépendant du pair dormant et propagation des capacités. L'explorer a déclaré ces trois objections fermées après lecture de F2/F3 ; quatre précisions non bloquantes de compatibilité, confirmation, rapport atomique et fraîcheur des capacités ont été intégrées ensuite. Aucun test comportemental de cette fonctionnalité future n'a été exécuté par l'explorer ; le verdict n'est pas une preuve d'implémentation.

**DÉDUIT, audit de contrat indépendant :** le reviewer `desktop-7b2civn-koryphaios-10` a rendu `REMPLI` sur les neuf exigences de la carte dans la version précédant ces précisions de fédération. Il n'a pas réaudité le delta final ; ne pas présenter son verdict comme une certification de toute la dernière version.

**Ratification reçue par le canal du team-lead le 2026-09-30 :** profil **3 relances, 5 minutes de décision, échéance maximale 4 heures**, tous trois surchargeables par variable d'environnement et réglage ; suivi refusé sans inbox. Il ne reste pas de demande de ratification de ces valeurs. L'absence de garantie de lecture humaine sans Courrier, la configuration globale au broker et son application après redémarrage sont explicitement exposées dans D, E1 et G.

**DÉDUIT, confrontation de l'amendement :** l'explorer `desktop-7b2civn-koryphaios-3` a retenu fichier core, précédence et snapshot, mais réfuté une édition locale présentée comme réglage d'un broker remote ; il a demandé une lecture de l'effectif et une prise en compte des bornes dans les reçus. G impose donc remote en lecture seule, projection du propriétaire et état enregistré/appliqué séparé ; F2 conserve un horizon fixe compatible avec les maxima techniques. Son contrôle documentaire de l'amendement a ensuite rendu `REMPLI`, sans trou bloquant ; les précisions de lecture stricte, de parité des chemins et de nettoyage local avant sweep ont été intégrées après ce contrôle et n'ont pas été réauditées. Cette confrontation est une lecture de conception, pas un test de la future chaîne de réglages. La carte `a7067102` est la dépendance du changement de durée de vie du broker, pas un prérequis au maintien des jobs sur SQLite : les deux cas restent couverts.

**Limite assumée de livraison :** le lot local peut être exploitable avant la fédération, mais « en replica, toutes les cibles distantes fonctionnent » ne sera vrai qu'après les lots 3 et 4. Aucun rattachement par nom en attendant. Les garanties de notifications locales au run et les anciennes règles de Courrier restent intactes ; ni nouveau système de replay opérateur ni identité portable de pair ne sont introduits.
