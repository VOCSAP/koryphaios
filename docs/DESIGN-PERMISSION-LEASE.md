# Bail de permission : plan de lots 6dbebca2 et a76d8b4a

**Prochaine action : livrer le lot 1 après le lot 0 ; préparer le lot 3 Windows obligatoire avant le lot 2b. M0 est acquis, M3 reste à faire sur le vrai Deck.**

Statut : proposition de conception, pas une description de code livré. Mandat du lead du 2026-10-08. Aucun code de production modifié par ce dossier. Les valeurs de délai sont des objectifs de conception, pas des mesures de latence.

## Problem framing

**DÉDUIT du contrat**, carte `6dbebca2`, décision opérateur du 2026-10-07 à 23:44 : l'attente doit durer tant que la tuile vit, car un opérateur nomade ne doit pas revenir au terminal après trente minutes. Le bail répond à la vie du lancement, pas à l'identité Claude déclarée par le hook.

Deux limites doivent rester visibles :

1. **Décision opérateur A du 2026-10-08, rapportée par le lead dans la carte à 09:38** : plafond technique accepté à `2_147_400 s`, soit 24 jours 20 h 30. **M0 mesuré par le test-engineer, traces relues ci-dessous** : Claude Code 2.1.294 accepte aussi `2_147_484`, `4_294_968` et `99_999_999 s`, avec hook vivant puis verdict appliqué. L'extrapolation d'un overflow observé dans Bun vers le runner Claude était erronée et est retirée. La valeur retenue est une borne finie prudente choisie par l'opérateur, pas un maximum démontré du runner ; la tenue à cette durée réelle et au-delà n'est pas mesurée.
2. **DÉDUIT**, `approval-service.ts:73-86`, `broker.ts:9817-9840` : le token expire après 24 heures par défaut. Retirer seulement `PERMISSION_BUDGET_MS` et `HOOK_PERMISSION_DEADLINE_MS` laisserait une autre échéance. Le renouvellement du credential fait partie du lot d'attente durable.

Le changement est plus large qu'un remplacement de constantes : isolation des runs, cycle de vie du bail, annulation du hook et renouvellement du credential. Ne pas modifier les routes PTY, `AskUserQuestion`, les questions Notification ou la politique de permissions de Claude.

## Current structure

Les chemins abrégés ci-dessous sont relatifs au dépôt : `session-service.ts`, `pty-manager.ts`, `approval-runtime.ts` et `approval-service.ts` vivent dans `desktop/src/main/` ; `approval-hook.ts` et `approval-client.ts` dans `desktop/hooks/`.

| Frontière actuelle | Preuve et conséquence |
|---|---|
| Main vers processus de tuile | **DÉDUIT**, `session-service.ts:1471-1477,1556-1576` : `startPty` construit l'env et appelle `pty.spawn`. `CLAUDE_PEERS_DESK_SESSION=def.id` ne distingue pas deux lancements de la même tuile. |
| Credential partagé par les tuiles | **DÉDUIT**, `approval-runtime.ts:141-174`, `index.ts:579-585` : une clé est mintée à l'armement, le fichier est nommé par projet et `sessionRef` dérive du groupe. Deux runs du même projet partagent le fichier ; avec un scope partagé ils partagent aussi la cible de révocation. |
| Hook vers broker | **DÉDUIT**, `approval-hook.ts:211-270`, `approval-client.ts:128-181` : `add` rend `id + producer_secret`, puis `wait` attend par polls de 25 s avec signal d'annulation. Un retrait refusé 409 peut conduire à une dernière lecture puis à un verdict stdout. |
| Broker vers règlement | **DÉDUIT**, `broker.ts:8781-8825,9405-9495` : échéance absolue de trente minutes et détecteur de producteur absent sont deux mécanismes distincts. `HOOK_WAIT_STALE_MS=45_000` commence au dernier wait achevé ; un waiter parqué empêche le constat d'absence. |
| Identité du retrait | **DÉDUIT**, `broker.ts:9505-9523` : retrait ciblé par ligne, scope et secret producteur, réservé à une ligne non fusionnable. Le statut de retrait actuel est `answered_terminal`, même pour certains replis techniques. |

### Les quatre familles de fin de lancement

| Famille | Câblage à couvrir |
|---|---|
| Retrait des définitions | **DÉDUIT**, `session-service.ts:836-907,916-936,981-1004` : `remove`, `closeAll` et `restoreFrom` émettent `removed`, mais le retrait peut comporter une fermeture progressive. Révoquer au début de la fermeture acceptée, pas seulement après l'escalade. |
| Redémarrage | **DÉDUIT**, `session-service.ts:1248-1269`, `pty-manager.ts:67-68` : le respawn tue implicitement l'ancien PTY ; aucun besoin de passer par `removed`. Révoquer l'ancien handle avant cette séquence. |
| Arrêt du service et quit | **DÉDUIT**, `session-service.ts:619-628` : `stop` appelle `killAll` sans émettre `removed`. Il faut révoquer tous les handles avant le kill, sans dépendre d'un listener renderer. |
| Sortie spontanée | **DÉDUIT**, `session-service.ts:357-405`, `pty-manager.ts:128-139` : le processus courant peut sortir proprement ou en erreur ; le vieux callback PTY est déjà filtré par identité d'objet. Révoquer avant les deux branches de traitement de sortie. |

**DÉDUIT**, `session-service.ts:1491-1507,1556-1576` : les échecs de préparation/spawn sont des chemins supplémentaires de rollback, pas une cinquième façon de fermer une tuile vivante. Tout bail préparé doit y être révoqué.

## Options

Les coûts et risques suivants sont **SUPPOSÉS, estimations de conception**, non mesurés.

| Décision | Option recommandée | Alternative rejetée et compromis |
|---|---|---|
| Transport du bail | **A. Fichier local par lancement**, sans secret, publié atomiquement par main. Coût faible, aucune nouvelle route, révocation indépendante du broker. Déploiement réversible au lot précédent. | **B. Endpoint Deck** : meilleure possibilité de challenge fraîcheur, mais nouveau client, authentification et service réseau à maintenir ; une réponse déjà reçue reste sujette à la course avec stdout. **C. Entrée broker** : autorité distante plus forte si elle arbitre aussi les verdicts, mais change protocole et modèle de données et lie le nettoyage au réseau. |
| Identité du run | **A. UUID neuf au boot main**, transmis aux services et jamais persisté dans un workspace. | **B. Groupe, projet, PID ou `session_id`** : moins de plomberie, mais collisions de scope/worktrees, réemploi de PID ou identité non maîtrisée. Retour arrière possible seulement en abandonnant l'isolation garantie. |
| Sortie après perte de bail | **A. Exit 0, stdout vide**, retrait borné. Aucun refus fabriqué. | **B. `deny` automatique** : plus visible pour le moteur, mais transforme une panne/fermeture en décision de permission et contredit ADR 005. Coût faible, impact sémantique large. |
| Suppression des durées métier | **A. Suppression couplée au bail et au renouvellement du token**, maintien des petits timeouts réseau. | **B. Augmenter seulement trente minutes** : très bon marché mais ne répond pas au contrat ; ne corrige ni les orphelins ni les 24 heures du token. |
| Processus descendants | **A. Terminaison d'arbre Windows sur les fermetures commandées, plus bail coopératif**. Lot 3 obligatoire avant l'attente longue ; coût et blast radius concentrés dans le cycle de vie PTY. Retour arrière possible tant que les trente minutes restent actives. | **B. Bail seul** : plus petit changement et livrable intermédiaire utile, mais ne certifie pas la disparition du shell ; insuffisant pour clôturer le nettoyage OS. **C. Kill d'arbre seul, bail supprimé** : moins de polling, mais ne couvre ni la racine déjà morte ni le main figé, et extrapole Windows aux autres OS. |
| Identité OS de la terminaison | **A. Exiger une identité capturée avec le spawn et conservée jusqu'à la terminaison**, avec preuve Windows avant de promettre une fermeture sans tuer un autre processus. Surface native éventuelle explicitement à requalifier, pas préautorisée. | **B. Relire PID + CreationDate puis appeler taskkill** : moindre coût, précédent local Clodex, mais deux courses restent possibles, lors de la capture initiale et entre contrôle et usage. Une date cohérente ne prouve pas qu'on a capturé le processus créé. Ne pas déguiser ce best-effort en garantie ; aucun kill par nom. |

### Recommandation

Retenir le fichier local comme **signal de cycle de vie coopératif**, avec UUID de run et génération de lancement, et ajouter la terminaison d'arbre Windows comme responsabilité distincte du propriétaire PTY. La force décisive est la complémentarité : le kill agit tant que l'arbre est encore identifiable ; le bail peut arrêter un hook survivant après perte de cette racine ou arrêt des pulsations. Garder le lot 1 livrable avant le lot 3, sans supprimer les trente minutes ; rendre le lot 3 obligatoire avant 2b. Le credential reste un mécanisme d'autorisation séparé ; le bail n'accorde aucune permission et n'est pas une défense contre un processus compromis sous le même compte OS.

**DÉDUIT**, `approval-hook.ts:238-245,267-269` : un fichier relu juste avant stdout ne peut pas sérialiser deux processus. Le challenge indépendant du reviewer du 2026-10-08 réfute donc le contrat absolu « aucun verdict après la révocation physique ». Le contrat corrigé est **aucun verdict après observation de révocation/expiration**, avec détection bornée nominalement. Un verdict déjà accepté/émis peut gagner la course ; ne pas le prétendre annulé. Une garantie atomique contre cette course exigerait un arbitrage de décision et d'exécution, pas un meilleur polling. **DÉDUIT, avis indépendant du reviewer** : après restriction à ce contrat coopératif et ajout des gardes de génération, son second verdict est `TIENT` ; aucune preuve runtime du futur bail n'en découle.

## Target design & migration path

### 1. Identité, credential et coexistence : lot 0

**Contrat proposé** : `runId=randomUUID()` au boot main ; identité du bail = `(runId, def.id, launchId=randomUUID())`. Chaque restart, auto-resume effectif ou restauration qui spawne reçoit une nouvelle génération. Plusieurs permissions parallèles partagent le bail de leur lancement, mais chacune conserve son propre `id + producer_secret`.

Le fichier credential devient `<projectHash>-<runId>-session-approval.json`, en conservant le constructeur de nom et le hash de projet existants. `sessionRef` devient `window-<runId>` ; le groupe ne participe plus à cette identité. La révocation du runtime vise son `token_id` mémorisé, pas une valeur relue depuis un fichier modifiable. Le broker accepte déjà la révocation par token : **DÉDUIT**, `broker.ts:9865-9877`.

| Quand il y en a deux | Contrat proposé |
|---|---|
| Même projet, ou deux worktrees | UUID différents, chemins, clés, `tokenId` et `sessionRef` différents. Le quit A retire et révoque A seulement. |
| `--scope` partagé | Même groupe autorisé, mais UUID indépendants. Aucun partage involontaire de credential ou de bail. |
| Restart rapide de la même tuile | `def.id` inchangé, `launchId` neuf. Le tick, la révocation et le retrait tardifs de A ne résolvent jamais le handle B par simple id de tuile. |
| Une fenêtre sur l'ancien code | Elle garde son fichier et son `window-<groupPrefix>`. La nouvelle fenêtre n'écrit, ne supprime et ne révoque aucun de ces objets. Ne pas prétendre réparer les collisions entre deux fenêtres toutes deux anciennes. |

**Arbitrage du lead, 2026-10-08** : aucun mécanisme de nettoyage legacy dans ce lot. Retirer l'appel de nettoyage du fichier plat pour la nouvelle implémentation ; laisser intacts le plat et les anciens fichiers par projet. Le résidu de secret legacy sur disque reste explicite dans `a76d8b4a`. Le scan de suppression par **valeur du secret** porte sur les fichiers appartenant au nouveau run.

**Conflit documentaire explicite** : ce choix remplace le précédent de la carte et les attentes de `tests/desktop-approval-runtime-instance-scoping.test.ts:97-125,166-202`, qui exigent la suppression de certains legacy. L'égalité de projet n'est pas une preuve de propriété de fenêtre. Pas de nouveau détecteur de « legacy inutilisable », pas de migration.

### 2. Bail local et surveillance : lot 1

**Structure proposée** : un petit module commun de format/validation `desktop/shared/permission-lease.ts`, sans Electron ; un propriétaire `desktop/src/main/permission-lease-runtime.ts` ; un lecteur `desktop/hooks/permission-lease.ts`. Dépendances : main et hook dépendent du format, jamais le broker. Le contrat n'expose aucun secret, `tool_input`, chemin de transcript ni PID d'agent.

Fichier proposé : `<stateDir>/permission-leases/<runId>/<tileId>/<launchId>.json`. Les composants sont des UUID validés, jamais des chaînes de repo transformées en chemin. Descriptor env `KORY_PERMISSION_LEASE` avec chemin absolu et tuple attendu. Le hook ne reconstruit pas ce chemin à partir de son cwd. Taille du document bornée, version explicite, tuple complet, compteur `sequence` entier fini croissant et `writtenAtMs` fini. Le bail n'est pas écrit dans le dépôt ni sauvegardé avec le workspace.

Main garde des handles `{runId,tileId,launchId,revoked,...}`. La table du service peut être indexée par `tileId` parce que son propriétaire est un unique run, mais chaque opération différée vérifie l'identité complète du handle. Un tick A ne peut pas recréer A après révocation, ni écrire B. Écriture atomique synchrone du tick ; `revoked=true` est posé avant arrêt du timer et suppression du fichier. Un échec de suppression ne relance jamais la pulsation.

Les trois temps proposés, en millisecondes : pulse `2_000`, lecture `1_000`, fraîcheur `10_000`. Le lecteur :

1. Vérifie descriptor et tuple, refuse fichier absent/invalide et timestamp futur. À l'admission, exige une progression du compteur depuis sa première lecture, dans la fenêtre de fraîcheur, avant tout `add`. Un fichier ancien recopié n'est pas admis sur son seul mtime.
2. Suit la progression avec son horloge monotone locale, sans comparer deux `performance.now()` de processus différents. Vérifie aussi l'âge mural pour la suspension et le recul d'horloge. Une même séquence ne renouvelle pas le bail ; régression ou identité différente invalident.
3. Exécute le watchdog indépendamment du `wait` HTTP. La perte du bail abort le signal composé transmis aux appels réseau. Vérifie à nouveau après chaque await et avant tout sink de verdict.
4. Une invalidation observée est irréversible pour cette invocation du hook, même si un fichier ou une pulsation revient. Dispose le watchdog et les ressources dans un `finally`.

**Objectifs, non mesures** : révocation par suppression détectée en environ 1 s puis retrait plafonné à 2 s, soit sortie visée sous 3 s ; mort main ou arrêt de pulsation, sous 10 + 1 + 2 = 13 s après la dernière pulsation. Ces bornes supposent un processus et un disque local exécutables ; aucun SLA de temps réel pendant une suspension OS ou un blocage de l'event loop. À la reprise, un bail trop vieux ne doit pas autoriser un verdict avant la vérification d'expiration.

L'env est préparée dans `startPty` avant le spawn et neutralisée explicitement (`''`) lorsque non applicable. Le service révoque aussi un handle préparé si le spawn échoue. Ajouter la neutralisation dans `PtyManager` pour les spawns utilitaires sans descriptor. **DÉDUIT**, `approval-hook.ts:279-299`, `session-service.ts:1423-1424` : le hook ne dépend pas de `KORY_APPROVAL_MODULE` et ce flag décrit aussi des capacités de télémétrie. Ne pas réutiliser aveuglément ce flag pour décider de créer le bail ; viser les lancements Claude hôte. Sandbox hors périmètre : descriptor vide, aucun bail hôte monté ou copié dedans.

**Fermeture** : invalidation du handle avant toute émission `removed`, tout kill/respawn et tout effacement du runtime ; couverture des quatre familles listées plus rollback du spawn. Capturer le handle au début des fermetures asynchrones. Tester le retour tardif de fermeture/restart sur une génération remplacée.

### 3. Hook, abandon et durée : lots 1 et 2

Sans bail valide : pas de `add`, pas d'attente bloquante, stdout vide. Après perte du bail : ne plus interpréter de verdict, aborter le wait, tenter un seul `withdraw` pour **son** couple `id + producer_secret`, sous signal de nettoyage neuf plafonné à 2 s, puis sortir 0 sans stdout. Un 409 après cette perte n'ouvre **jamais** la dernière lecture décisionnelle.

Pour une panne technique alors que le bail reste valide, conserver le traitement 409 existant seulement tant que le bail et le plafond technique restent valides. La garde porte aussi sur les chemins d'exception et le dernier `writeDecision`, pas seulement sur le début de boucle.

**DÉDUIT**, `approval-hook.ts:211-222`, `broker.ts:8796-8801` : un `add` peut être commité au broker alors que l'abort empêche le hook de recevoir `id + producer_secret`. Aucun retrait ciblé n'est alors possible. Accepter le filet existant : ligne jamais attendue, devenue abandonnable après 45 s depuis sa création au prochain balayage/list/claim. Ne pas ajouter un identifiant client/idempotence dans ce lot ; ajouter le test commit-ambigu et ne pas promettre une disparition immédiate.

**DÉDUIT**, `broker.ts:9498-9523` : le retrait existant utilise `answered_terminal`. Recommandation minimale : conserver ce wire/status pour le retrait coopératif, sans affirmer qu'une réponse terminale a réellement eu lieu ; si le hook ne peut pas retirer, `hookProducerGone` produit `abandoned`. Ne pas inventer `withdrawn` ni changer le protocole de retrait dans ce chantier. Un statut terminal accepté entre-temps n'est pas réécrit.

**Broker proposé** : supprimer `HOOK_PERMISSION_DEADLINE_MS`, son prédicat et les branches qui raccourcissent/règlent le waiter sur cette échéance. Conserver `HOOK_WAIT_STALE_MS=45_000`, le plafond de chaque long poll et l'horodatage au début/à la fin. Sans retrait reçu, une ligne peut rester jusqu'à la fin du waiter puis 45 s, et jusqu'au prochain balayage/list/claim. Ne pas vendre « 13 s » comme délai de disparition garanti du Courrier : c'est l'objectif de sortie du hook.

**Plafond technique accepté, décision opérateur A du 2026-10-08** : `hooks.json timeout=2_147_400` secondes, soit 24 jours 20 h 30. C'est une borne prudente de service et de test, pas une contrainte 32 bits démontrée du runner. M0 prouve l'admission et le verdict après 60 s pour cette valeur, pas une attente effective de 25 jours. Une garde interne à `timeout - 30 s`, contrôlée par elapsed monotone et réveils courts, vise un retrait et un repli natif tracés avant la coupure externe. Ne pas programmer un unique long timer Bun pour cette garde. La marge de 30 s est un objectif, pas une garantie si le processus est suspendu ou bloqué.

**Aucune dépendance à un signal de terminaison** : M0 avec `timeout=5 s` coupe le hook sans événement `signal` ni `exit` enregistré par la sonde. Un `finally`, un handler SIGTERM ou un retrait HTTP ne constituent donc jamais la garantie de nettoyage en cas de coupure externe. Le watchdog et la garde interne assurent seulement le chemin coopératif ; `HOOK_WAIT_STALE_MS` reste le filet broker après mort sans retrait. Toute sortie contrôlée reste sans verdict, jamais `deny` fabriqué ; une coupure dure ne promet ni trace finale du hook ni retrait.

Alternative rejetée : 24 h ou 7 jours, plus simples à présenter mais réintroduisant une échéance nomade plus tôt sans bénéfice de sûreté établi. « Strictement infini » n'est pas le choix opérateur ; l'admission d'un très grand nombre ne prouve ni absence de plafond ni tenue pendant cette durée. Aucun renouvellement transparent d'une invocation PermissionRequest n'est conçu ici.

### 4. Renouvellement du credential : lot 2a, avant l'extension d'attente

**DÉDUIT**, `broker.ts:9845-9850` : le mint actuel remet `revoked_at=NULL` lors d'un conflit sur le token. Appeler ce mint périodiquement sans contrat supplémentaire permettrait à un renouvellement en vol de défaire un disarm.

Recommandation : réutiliser la route operator-signed `token-mint` avec une intention additive `renew_only`. Dans cette branche, aucun INSERT, aucune nouvelle clé, aucun reset de révocation ; seulement extension de `expires_at` d'un token existant, encore valable, non révoqué et portant exactement l'opérateur, la clé, le projet et le `sessionRef` attendus. Un token absent/expiré/révoqué échoue. L'UPDATE conditionnel et la révocation doivent rester ordonnés par le broker : si renew précède revoke, revoke gagne ; s'il suit, renew échoue. Le vieux comportement de mint reste compatible pour les anciens clients. Le nouveau broker annonce explicitement la capacité `renew_only` dans la réponse de mint, et le nouveau client l'exige avant d'activer le renouvellement : **DÉDUIT**, `broker.ts:9803-9853`, la branche actuelle ne teste pas cette intention et continuerait à faire son remint permissif. **Arbitrage du lead, 2026-10-08, spec `spec_2676035b`** : cette capacité conditionne uniquement le renouvellement périodique, jamais l'armement initial. Si le broker ne l'annonce pas, le Deck arme normalement et publie le credential initial de 24 h, sans timer de renouvellement, avec une unique trace `reportError` pour cet armement ; aucun renouvellement de secours par mint permissif. Le refus d'armement pour cette seule absence est écarté : couper le Courrier à cause d'un broker plus ancien serait pire que conserver l'expiration à 24 h.

Main conserve la paire courante en mémoire. Seulement si la capacité `renew_only` est annoncée, il renouvelle le même token toutes les 6 h pour un TTL de 24 h, sans réécrire le fichier ni changer ce que les hooks en attente ont déjà chargé. Sinon, le credential initial reste utilisable jusqu'à son expiration, sans promesse de continuité au-delà de 24 h. Un seul renouvellement en vol, retries bornés avant expiry, arrêt du timer au disarm, guards d'époque du runtime pour ignorer une réponse ancienne. Le disarm vise le token courant capturé avant effacement. Une échéance vraiment atteinte laisse échouer les hooks sans verdict ; ne pas ressusciter leur ancien token automatiquement.

Alternative rejetée : porter directement le TTL à trente jours. Cela cache la limite, conserve un credential utilisable plus longtemps après un crash et ne répond pas à un Deck vivant plus longtemps. Alternative changer la sémantique de tous les remints : impact plus large que la seule branche `renew_only`.

### 5. Processus, journalisation et zéro fantôme

#### M0 acquis, mais son périmètre n'est pas le Deck

**Mesures tierces du test-engineer du 2026-10-08, Claude Code 2.1.294 sous Windows**, kit `~/.agent-forge/scratch/b29a4ea4-L85/m0/`, hook de sonde et hôte node-pty, pas le vrai hook ni le main du Deck :

- `proc.kill()` et le kill dur de Claude laissent Bun et un bash encore vivants à 45 s, avec ou sans Oui préalable. `exec bun` ne retire pas les deux intermédiaires bash de l'arbre observé.
- `taskkill /PID <pty.pid> /T /F` **à la place de** `proc.kill()` a fermé tout l'arbre avant l'observation à 1,5 s, hôte vivant. La séquence taskkill puis proc.kill n'a pas été mesurée : c'est le contrat à valider, pas un résultat M0.
- Après kill dur de Claude, le PowerShell lancé avec `-Command` sort et le PTY émet `onExit` code 1 vers 1,4 s, mais Bun/bash restent. Le PID de la racine a déjà été réutilisé à l'observation de 1,5 s. Ne pas extrapoler à un shell interactif persistant.
- La mort du propriétaire du PTY a tout fermé avant l'observation à 1,5 s ; `/exit` propre ferme aussi l'arbre. **SUPPOSÉ** : le main Electron réel se comporte comme cet hôte. M3 doit le vérifier.

#### Responsabilités et quatre familles

**Contrat proposé Windows** : le service invalide le bail du lancement avant la fermeture ; le propriétaire PTY termine l'arbre tant que sa racine existe et lui appartient encore, puis libère les ressources node-pty. Ne pas attendre un retrait HTTP pour tuer l'arbre, et ne pas exiger que le hook ait exécuté son `finally`. Un kill réussi peut supprimer le producteur avant son retrait : le filet broker de 45 s reste nécessaire.

| Fin de lancement | Action proposée et limite |
|---|---|
| `remove`, `closeAll`, `restoreFrom` | Révoquer d'abord le bail capturé. Conserver la tentative de sortie propre de `remove` ; toute escalade dure passe par la terminaison d'arbre avant `proc.kill()`. Ne pas effacer l'identité OS avant règlement du nettoyage. |
| Restart et auto-resume avec remplacement | Révoquer A ; terminer l'arbre de A avant de spawner B. Toute continuation conserve l'objet A, jamais une résolution tardive par `tileId` susceptible de viser B. Un échec de terminaison ne se transforme pas en succès silencieux. |
| `stop` et quit commandé | Révoquer tous les baux ; attendre les terminaisons bornées des racines possédées avant la libération PTY et le quit. La propriété observée sur mort de l'hôte ne remplace pas ce chemin tant que le main est vivant. |
| Sortie spontanée propre ou crash | Révoquer le bail à `onExit`, code zéro comme non-zéro. Si la racine est déjà morte, ne pas lancer un taskkill tardif sur son ancien PID et ne pas prétendre retrouver les orphelins. Le hook encore exécutable doit observer le bail perdu ; la disparition de bash après sa sortie reste une preuve M3. |

**DÉDUIT**, `pty-manager.ts:67-68,128-139,219-233` : spawn tue aujourd'hui implicitement l'ancien objet, kill efface la table avant `proc.kill()`, et les vieux `onExit` sont filtrés par identité d'objet. Le nouveau nettoyage doit garder ces protections tout en conservant un handle local de l'objet en fermeture. Les rollbacks préparation/spawn suivent la même règle : révoquer le bail préparé ; nettoyer uniquement une racine effectivement créée et possédée.

#### Identité OS et frontière de preuve du lot 3

Capturer avec le spawn le PID natif et son `CreationDate`, dans l'objet `Spawned` lié au lancement, pas dans une table globale indexée seulement par PID. Revalider l'identité avant toute action ; refus et `reportError` si lecture absente, invalide ou différente. Même source et même précision pour la date au départ et au contrôle. Ne jamais accepter un PID du renderer, du hook ou du repo. Aucun kill par nom, aucun balayage d'anciens PID pour réparer une identité perdue.

**DÉDUIT**, `clodex-process-io.ts:387-400,649-674` : le précédent Clodex mesure une date par PowerShell puis appelle taskkill ; c'est une référence de validation et de journalisation, pas une preuve d'atomicité. M0 fait aussi deux opérations séparées. Deux courses doivent être nommées : un PID peut être réattribué avant sa toute première capture après `pty.spawn()`, ou entre revalidation et taskkill. Un handle ouvert trop tard ne répare pas la première course. UUID de génération et `CreationDate` ne suffisent donc pas à certifier qu'aucun autre processus ne sera tué.

**Porte de conception native, avant certification du lot 3** : prouver sur la version node-pty embarquée qu'une identité/possession OS peut être obtenue atomiquement avec la création et gardée jusqu'à la terminaison. Le mécanisme reste à mesurer : exposition/duplication du handle natif, ou confinement OS attaché dès la création. Ni addon natif ni Job Object ne sont préautorisés par ce dossier. Si nécessaire, requalifier explicitement l'effort avec le lead ; ce serait plus large qu'une ligne taskkill. Le simple couple relecture CIM puis taskkill reste un candidat best-effort mesuré pour le nettoyage, **pas** la garantie forte. Ne pas le promouvoir silencieusement en remplacement sûr.

**Orchestration proposée** : collecte et terminaison asynchrones, bornées, sans bloquer le main par un PowerShell synchrone par tuile. **DÉDUIT**, `pty-manager.ts:67,219,231`, `session-service.ts:619,916,981` : plusieurs APIs sont synchrones aujourd'hui ; rendre une terminaison asynchrone implique de propager son attente aux fermetures/respawns, pas de lancer taskkill en fire-and-forget puis tuer le parent. Le premier spawn doit rester visible immédiatement ; une fermeture durant l'acquisition d'identité attend sa résolution bornée ou signale son échec, sans réadopter un PID. **DÉDUIT**, `before-quit.ts:14-26,55-71` : les effets de quit peuvent déjà retourner une promesse ; l'ordre révoquer, terminer puis libérer doit être dans une chaîne attendue, pas deux effets parallèles. La libération finale `proc.kill()` ne doit pas réintroduire une résolution vers un PID réutilisé ; l'enchaînement exact fait partie de M3.

#### Bail maintenu, couverture par OS

Le kill d'arbre ne remplace pas le bail : **DÉDUIT des chemins ci-dessus et de M0**, après un crash de Claude le PTY peut déjà être mort lorsque main reçoit `onExit`, alors que le hook continue de vivre. La révocation de génération et le lecteur hook restent utiles. La pulsation couvre également main figé mais non mort, suppression du fichier impossible, fermeture OS refusée et suspension/reprise. Supprimer le heartbeat sur la seule preuve de mort de l'hôte abandonnerait ces cas.

**Réduction retenue de sa responsabilité**, pas de son protocole : le bail n'est pas un tueur d'arbres, ne garantit pas la sortie de bash et n'a pas à diagnostiquer le détail des processus. Conserver pulse/lecture/fraîcheur `2/1/10 s` et l'invalidation irréversible. Si tous les descendants meurent déjà sur crash main, il n'y a simplement plus de lecteur à nettoyer ; cela ne justifie ni un second superviseur natif kill-on-close pour ce seul cas, ni la suppression du filet coopératif.

**macOS/Linux** : pas de taskkill, pas de projection de `CreationDate` Windows. Conserver le chemin node-pty existant et le bail indépendant de l'OS. **SUPPOSÉ, non mesuré par M0** : comportement réel du groupe de processus, propagation des signaux et disparition du shell. Ne pas annoncer la même garantie de terminaison d'arbre ; demander M3 sur chaque OS visé avant d'y certifier l'attente longue. Un éventuel kill de groupe POSIX requiert une conception d'identité/possession séparée, pas un `kill(-pid)` ajouté par analogie. Le hook ne dépend d'aucun SIGTERM sur aucun OS.

#### M3 restant à exécuter

1. Vrai Deck et vrai `approval-hook` empaqueté : quatre familles, avec et sans Oui préalable, réseau coupé, code zéro/non-zéro. Mesurer séparément mort de Bun, mort de bash et état de la ligne Courrier.
2. Deux Deck, même projet/scope et deux worktrees ; restart A/B et deux permissions parallèles ; ancienne continuation incapable de tuer B ou de retirer sa ligne.
3. Sonde native minimale de possession : sortie immédiate au spawn, réemploi rapide de PID, fermeture avant acquisition, racine disparue entre contrôle et action ; cible terminée et processus témoin intact. Si seul PID puis CIM est disponible, la garantie forte n'est pas acquise.
4. Séquence réelle terminaison d'arbre puis libération PTY ; délai total et quit attendus, timeout/échec tracés ; aucun helper ou timer laissé en vol pouvant atteindre la génération suivante. Main réel tué et suspend/reprise, pas seulement l'hôte du harnais.
5. Mac/Linux pour chaque cible de livraison ; publier versions, commande exacte et lignes décisives. Ni le vert unitaire ni M0 sur une sonde ne remplacent ces preuves.

Journalisation proposée : `reportError` pour publication/révocation/renouvellement main ; hook vers le logger rotatif existant `createLogger`/`coreLogDir`, `mirrorToConsole:false`, sans secret ni payload de permission. **DÉDUIT**, `shared/logger.ts:18-30` : rotation et désactivation du miroir sont déjà configurables. Garder stdout exclusivement réservé au JSON de décision. Ne pas ajouter un journal illimité par hook ; les expirations et transitions sont tracées une fois, pas à chaque poll. Le puits complet de tous les anciens hooks n'est pas repris ici.

**56689093 : juste après, dans une vague d'exécution séparée.** Le bail se ferme indépendamment du problème de corrélation terminale. **DÉDUIT du contrat de carte**, `56689093` : identifier une invocation par `session_id + tool_name + tool_input` ne distingue pas deux appels identiques ; les payloads/ordre des événements restent à mesurer. Aucun retrait fondé sur l'égalité du texte. En parallèle du lot 0, seules les mesures de corrélation peuvent avancer.

**Décision opérateur B du 2026-10-08, rapportée par le lead dans la carte à 09:38** : le lot 2b attend la livraison de `56689093`. Les lots 0, 1 et 2a ne l'attendent pas. **DÉDUIT**, `approval-hook.ts:224-245` : tant qu'un hook continue de poller après Oui, le détecteur de producteur absent ne suffit pas à retirer la ligne ; retirer les trente minutes prolongerait ce résidu. Le bail et le kill d'arbre à la fermeture de tuile ne résolvent pas une réponse Oui dans une tuile toujours vivante. Aucun nouveau choix opérateur à demander sur cette dépendance déjà tranchée.

## Lots committables et tests

Les fichiers nouveaux sont des **cibles proposées**, pas des fichiers existants. Chaque commande ci-dessous est une commande de validation à exécuter par l'implémenteur, non un résultat déjà obtenu. Les builds de bundles seront faits par le développeur avec la commande du projet, sans éditer leurs octets à la main.

| Lot | Fichiers et périmètre | Tests ciblés et critères |
|---|---|---|
| **0 : a76d8b4a, isoler le run** | `desktop/src/main/index.ts`, `approval-runtime.ts`, `approval-service.ts` ; adapter les tests runtime et leur registre de portée. Aucun changement de clauses projet broker. | `bun test ./tests/desktop-approval-runtime-instance-scoping.test.ts` : même projet/worktrees/scope, tokenId ET sessionRef distincts, quit A conserve B, ancien fichier laissé octet pour octet, scan récursif par valeur du secret propre après disarm. `bun test ./tests/desktop-approval-runtime.test.ts`, `bun test ./tests/desktop-approval-runtime-project-key.test.ts`, `bun test ./tests/desktop-state-scope.test.ts`. Mutation chemin commun/ref commun doit rougir. |
| **1 : bail révocable, budget trente minutes conservé** | Nouveaux `desktop/shared/permission-lease.ts`, `desktop/src/main/permission-lease-runtime.ts`, `desktop/hooks/permission-lease.ts` ; `session-service.ts`, `pty-manager.ts`, `approval-hook.ts`, `approval-client.ts` si adaptation du signal, branche de shutdown de `index.ts` si nécessaire ; tests existants et nouveaux ; ADR 005/DESKTOP mis à jour pour le bail réellement livré. | Nouveaux `bun test ./tests/desktop-permission-lease.test.ts`, `bun test ./tests/desktop-permission-lease-lifecycle.test.ts`, `bun test ./tests/permission-lease-reader.test.ts`. Vérifier les quatre familles, rollback spawn, A/B générations, callback ancien, env utilitaire/sandbox vide, invalidation irréversible, timestamp futur, fichier invalide, polling annulant un fetch bloqué. `bun test ./tests/approval-hook.test.ts` : zéro add sans bail, zéro stdout après observation de perte, pas de late-read décisionnel, retrait propre et borné. |
| **2a : renouvellement sûr** | `broker.ts`, `shared/types.ts` (`ApprovalTokenMintRequest`), `approval-service.ts`, `approval-runtime.ts`, tests service/runtime/broker. Nouveau flag uniquement pour les nouveaux callers ; broker compatible requis pour activer le renouvellement, pas pour armer le client ni publier le credential initial. | `bun test ./tests/broker-approvals.test.ts` : renew même token sans réactivation, deux ordres renew/revoke, absent/expiré/autre scope refusés, comportement ancien mint préservé. Nouveau `bun test ./tests/desktop-approval-renewal.test.ts` : capacité présente, avance d'horloge au-delà de 24 h avec même clé, un appel en vol, stop/rearm et réponse tardive, réseau indisponible sans timer orphelin ; capacité absente, armement réussi et credential de 24 h publié, aucun timer, une trace `reportError`, aucun renouvellement par mint permissif. `bun test ./tests/desktop-approval-service-project-key.test.ts`. |
| **3 : correction OS Windows obligatoire avant 2b** | `pty-manager.ts`, `session-service.ts`, raccord quit dans `index.ts`/`before-quit.ts` si nécessaire ; module de possession/terminaison Windows testable sans Electron. Acquisition d'identité, terminaison d'arbre avant libération PTY, propagation des attentes aux quatre familles. Pas de modification de `shell-command.ts` pour tenter de supprimer un bash : M0 avec `exec bun` ne l'a pas supprimé. Primitive native à prouver avant de certifier l'identité forte ; ne pas engager un addon/Job Object sans requalification du lot. | Nouveau `bun test ./tests/desktop-permission-process-lifecycle.test.ts` : refus identité absente/divergente, capture initiale invalide, A/B et callbacks tardifs, attente avant respawn/quit, timeout et erreur tracés, autres OS inchangés. `bun test ./tests/desktop-before-quit.test.ts`. Puis M3 réel : Bun ET bash disparus, tuile témoin intacte ; seul un harnais natif peut prouver le réemploi PID. Aucun résultat M3 acquis ici. |
| **2b : retirer l'échéance métier** | `approval-hook.ts`, `desktop/deck-plugin/hooks/hooks.json`, `broker.ts`, `tests/approval-hook.test.ts`, `tests/broker-approvals.test.ts`, ADR 005 et `DESKTOP.md`. Dépend de M0 acquis, lots 1, 3 et 2a, M3 concluant, **et `56689093` livré**. | Les deux fichiers de tests précédents : ligne âgée de plus de 30 min encore réglable si wait vivant, producteur mort toujours abandonné après le détecteur de 45 s, waiter toujours résolu, pas de boucle serrée sur `expired_notif`, garde technique interne avec réveils courts et marge, ancien hook libre d'abandonner à trente minutes. Le nettoyage ne dépend d'aucun signal. Mutation réintroduisant chaque échéance doit rougir. |

**Ordre recommandé** : **M0 acquis -> commit 0 -> commit 1 -> commit 3 + M3 -> commit 2a -> `56689093` livré -> commit 2b -> M3 sur paquet final**. Le lot 3 n'est plus conditionnel ; sa place obligatoire est avant 2b, pas avant 1. Le lot 1 réduit déjà la survie du hook sans prétendre nettoyer tout l'arbre ; le bloquer sur une primitive native non prouvée retarderait ce bénéfice. **DÉDUIT, challenge indépendant du reviewer du 2026-10-08** : la proposition initiale « 3 obligatoire avant 1 » a reçu `TOMBE`, la séparation kill/bail `TIENT`. Le plan adopte cette correction ; ce verdict n'est pas une preuve runtime.

Les préparations de 3 et 2a peuvent avancer en parallèle après 0 ; 2a peut atterrir avant 3 si celui-ci attend sa preuve native. Le lead séquence les fichiers partagés. Si l'identité forte ou le nettoyage M3 restent indécidables, **1 et 2a restent livrables avec trente minutes ; 2b reste bloqué**. Aucune activation intermédiaire de l'attente longue ni nouveau flag n'est nécessaire. Ne pas déclarer la carte de nettoyage achevée sur le seul lot 1.

**Estimations SUPPOSÉES**, hors attente opérateur : M3 60 à 120 min par plateforme disponible, hors mise au point native ; lot 0 60 à 90 min ; lot 1 3 à 5 h ; lot 2a 2 à 3 h ; lot 2b 60 à 90 min. Lot 3 non estimé tant que sa primitive d'identité reste à prouver : Job Object ou évolution native node-pty constitueraient un chantier plus large, pas une retouche de `proc.kill()`.

## Preuves disponibles et limites

**MESURÉ dans cette session** : `bun test ./tests/approval-hook.test.ts` a rendu `63 pass`, `0 fail`, `198 expect() calls`, `Ran 63 tests across 1 file. [14.40s]`. C'est une référence du code actuel, pas une preuve du bail proposé. Aucun gate complet, build ou typecheck exécuté.

**M0, mesures du test-engineer, non rejouées par l'architecte** : spec `spec_c367b2b7`, Claude Code 2.1.294, Windows. Commande de sonde rapportée : `ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/electron.exe C:/Users/Olivier/.agent-forge/scratch/b29a4ea4-L85/m0/m0.cjs <id>`. Les sorties sont archivées dans `m0/res/<id>/summary.json` et `m0/res/<id>/log/h1.jsonl`. Elles ne certifient ni le vrai Deck ni le vrai `approval-hook`.

**MESURÉ ici : extraction des résultats archivés, pas nouvelle sonde OS.** Commande exécutée :

```text
bun C:/Users/Olivier/.agent-forge/scratch/b29a4ea4-L85/m0/extract.cjs LC-tree-pty LC-pty-kill LC-claude-exact LC-inner-exact LC-exit-typed
```

Lignes décisives, dans l'ordre des scénarios :

```text
close taskkill /PID 33268 (powershell.exe, the PTY root) /T /F -> exit 0 atMsAfterAnswer undefined
 +1.5s bun:14228- bash:46760- bash:13432- claude:13004- powershell:33268- lastHbAgeMs 2464 host=true
 +45s bun:42500+ bash:36512+ bash:24976- claude:37800- powershell:37296- lastHbAgeMs 1743 host=true
 +1.5s bun:34544+ bash:34904+ bash:43964- claude:43808- powershell:45972-R lastHbAgeMs 1424
=== LC-inner-exact: missing
 +5s bun:29212- bash:16972- bash:396- claude:26136- powershell:13744- lastHbAgeMs 5904
```

L'extracteur utilise `+` pour vivant, `-` pour mort, `-R` pour ancien PID réutilisé (`extract.cjs:3,20`). Le scénario `LC-inner-exact` est un nom absent, donc cette commande ne mesure pas la mort de l'hôte ; ce résultat repose sur le compte-rendu M0 du test-engineer. Ne pas créditer cinq mesures à quatre résultats.

**MESURÉ ici : lecture des archives timeout.** Commande exécutée : `jq '{id, samples: .out.samples, events: .out.afterRelease.hookEvents}' C:/Users/Olivier/.agent-forge/scratch/b29a4ea4-L85/m0/res/TO-5/summary.json C:/Users/Olivier/.agent-forge/scratch/b29a4ea4-L85/m0/res/TO-2147484/summary.json`. Dans `TO-5`, le prélèvement `atSec: 5` porte `"bunAlive": false`, et les seuls événements finaux sont `"start@0"`, `"stdin-eof@6"`. Dans `TO-2147484`, le prélèvement `atSec: 15` porte `"bunAlive": true`, puis `"release-seen:allow@15445"`, `"output-written@15446"`, `"exit@15446"`. Le test-engineer rapporte les verdicts également appliqués pour `TO-4294968` et `TO-99999999` après environ 15 s, pour `TO-2147483` après 30 s et pour `TO-2147400` après 60 s.

**Limites** : aucune attente de 25 jours mesurée ; aucune nouvelle sonde native exécutée pour cette révision ; pas de preuve de possession atomique d'un processus, de séquence taskkill puis proc.kill, de nettoyage du vrai Deck, ni de validation macOS/Linux. Le contrôle PID/date de M0 laisse une course check/use. L'ancienne justification par overflow du runner est réfutée, non conservée comme contrainte latente.

## Open questions for the supervisor

**Déjà tranché par l'opérateur le 2026-10-08** : A, plafond `2_147_400 s` accepté ; B, activation de 2b après `56689093`. Le dossier retire la justification erronée du plafond sans rouvrir ces choix.

1. **Preuve native du lot 3 à confier au test-engineer** : peut-on posséder la bonne racine dès sa création avec la version node-pty embarquée ? Si non, revenir au lead avec le coût d'une frontière native/Job Object avant d'implémenter. Ne pas remplacer cette preuve par une question abstraite « accepter le risque PID ? ». Le nettoyage d'arbre est obligatoire, sa sûreté d'identité n'est pas encore certifiée.
2. **Portée de validation** : désigner les hôtes macOS/Linux pour M3 si l'attente longue doit y être livrée. Sans mesure, garder ces plateformes explicitement non certifiées ; ne pas extrapoler la mesure Windows.

La fraîcheur courte traite suspension longue, disque défaillant et main figé comme perte de service avec repli natif quand le hook peut encore exécuter ce repli. Garder ce comportement conservateur, pas de prolongation automatique depuis le hook. Si le produit exige la continuité nomade après veille au-delà de dix secondes, cela modifie le contrat et nécessite une stratégie de reprise explicite ; les mesures sur mort de l'hôte ne tranchent pas cette question.
