# ADR 007 : épingler l'autorité opérateur dans le domaine d'administration du broker

Statut : **Acceptée (2026-10-15, opérateur, option A)**, carte `300a5665-7b6b-4b8f-b2a4-990c5dbf0bcc`. L'option A désigne la portée « strict partout » du §8, avec provisioning explicite hors HTTP et politique statique multi-clés (option technique C du §3). Dépendance de `b7ee3194` L3. Aucun code livré par cet ADR.

**Décision acceptée : politique statique multi-clés, provisionnée hors HTTP, vérifiée par le broker dans toutes les topologies.** Ne pas conserver l'auto-certification en remote. Reporter l'enrôlement en ligne, pas le refus des clés inconnues.

Les paragraphes **CONTRAT PROPOSÉ** prescrivent la cible, ils ne décrivent pas l'existant. Les constats portent `DÉDUIT`, `MESURÉ` ou `SUPPOSÉ`. Les estimations sont des hypothèses, pas des mesures.

## 1. Problème et limites de la garantie

**DÉDUIT**, `shared/approval-scope.ts:224-268` : la branche opérateur prend une clé connue dans `approval_operators`, sinon la clé présentée dont le condensat correspond à l'identifiant, vérifie la signature puis insère cette identité. Cela prouve la possession de la clé, pas l'autorisation d'agir comme opérateur. L'ajout d'un contrôle à la seule route de contexte laisserait la même décision d'autorité incorrecte aux autres consommateurs.

**SUPPOSÉ au sens du présent rapport, mesure reçue et non rejouée** : le lead et le security-auditor rapportent une sonde sur `14a9f40`, clé fabriquée par un pair du groupe, `POST /context/transaction` renvoyant 200 puis réservation du Deck renvoyant 409. La preuve est consignée dans le contexte de `300a5665`. Cet ADR ne revendique pas cette exécution comme sa propre mesure.

**DÉDUIT**, `broker.ts:2796-2833` : la transaction vérifie le secret du groupe puis l'identité opérateur avant de résoudre la réservation. Un secret de groupe connu de l'agent ne distingue donc pas cet agent du Deck. **DÉDUIT**, `broker.ts:4350-4374` : les auteurs réservés de la roadmap obtiennent `operator_id` par le même authentificateur.

### Frontière de menace, sans promesse supplémentaire

**CONTRAT PROPOSÉ :** le palier protège un broker honnête contre un appelant HTTP qui connaît le secret du groupe et possède ses propres clés, mais ne peut ni modifier la politique, ni lire la clé privée opérateur, ni remplacer le processus broker. Cela couvre notamment le pair distant et l'agent sandboxé seulement si ces capacités leur sont effectivement retirées.

**DÉDUIT**, `desktop/src/main/index.ts:402-405`, `operator-identity.ts:65-71,115-133,163` : le Deck utilise `safeStorage`, accepte aussi une représentation `plain:` et demande un mode de fichier `0600`. Le code seul ne prouve pas les ACL effectives du poste ni une isolation entre processus du même utilisateur.

**MESURÉ documentaire**, appel `mcp__crawl4ai-rag__scrape_urls({"url":"https://www.electronjs.org/docs/latest/api/safe-storage","return_raw_markdown":true})` : documentation officielle, section API synchrone Windows, « content is protected from other users on the same machine, but not from other apps running in the same userspace ». Ce n'est pas une sonde de déchiffrement sur ce poste. La même documentation distingue macOS (Keychain par application) et Linux (protection dépendante du backend).

**CONTRAT PROPOSÉ :** l'isolation par compte OS est une condition d'exploitation : droits privés sur la clé, le répertoire de politique et ses parents, compte de service administré pour le remote. Elle peut séparer deux utilisateurs, pas le Deck d'un agent hôte auquel le même utilisateur a accordé l'écriture de ces fichiers ou le contrôle du processus. Le loopback n'est pas une identité. Ne pas annoncer « agent hôte compromis neutralisé » par cet ADR. Une séparation de compte/service ou un confinement effectif est nécessaire pour cette garantie plus forte.

**SUPPOSÉ, non audité ici** : droits réels Windows/POSIX, protection des exécutables du service, configuration TLS distante et capacités de chaque sandbox. Leur validation relève du déploiement. Aucune clé privée ne doit être montée dans une sandbox.

## 2. Structure actuelle et décisions à respecter

| Frontière actuelle | Constat sourcé |
|---|---|
| Authentification commune | **DÉDUIT**, `shared/approval-scope.ts:166-205,224-275` : `createApprovalAuth` dépend d'un adaptateur SQL et du cache de nonces ; il retourne une identité réutilisée pour construire les scopes. |
| Classe session contre opérateur | **DÉDUIT**, `shared/approval.ts:229-256` : seuls `add`, `wait`, `withdraw` sont autorisés à une session. Le reste de l'enum est operator-only. Conserver cette séparation. |
| Identité locale | **DÉDUIT**, `operator-identity.ts:115-169,178-222` : identité stockée sous le répertoire d'état du Deck ; identifiant dérivé de la clé ; l'enrôlement inter-poste copie la partie privée et conserve donc la même identité. |
| Démarrage/adoption | **DÉDUIT**, `desktop/src/main/index.ts:1444-1491,3499-3500` : le Deck vérifie `/health`, peut adopter le broker, démarre celui-ci avant l'armement des approbations. `server.ts:194-212` peut également lancer le broker sans passer par le Deck. |
| Réponse par téléphone | **DÉDUIT**, `shared/approval-scope.ts:362-374`, `broker.ts:10902-10932` : un scope peut provenir de l'approbation résolue, puis de son appairage, sans signature opérateur HTTP. Une révocation ne peut donc pas se limiter à la branche `proof.kind === "operator"`. |

**DÉDUIT**, `shared/config.ts:104-116` : la configuration globale a une racine par compte/profil, avec `%APPDATA%` sous Windows et `$XDG_CONFIG_HOME` ou `~/.config` sous Unix. **DÉDUIT**, `broker.ts:294,558` : la base est sélectionnée séparément par la configuration. Ne pas déduire l'autorité d'une ligne présente dans cette base.

**DÉDUIT**, `broker.ts:7148-7169,7190-7225` : le push de réplication passe par les gardes upstream/Bearer, réécrit les auteurs relayés et n'a pas l'identité du signataire d'origine. L'épinglage local ne devient pas une preuve opérateur de bout en bout sur l'upstream. La réplication reste une autre relation de confiance, à son niveau de token. Ne pas répliquer la politique avec les cartes.

### Conflits documentaires explicites

**DÉDUIT**, `ARCHITECTURE.md:116-123` : la liaison clé/identifiant est décrite comme auto-certifiée. Cette propriété cryptographique reste vraie, mais ne doit plus être assimilée à l'autorisation. **DÉDUIT**, `ARCHITECTURE.md:176-198` : plusieurs opérateurs par broker sont déjà prévus ; un singleton `operator_id` ne respecte pas cette frontière.

**CONTRAT PROPOSÉ :** respecter la décision de `CLAUDE.md`, « Approvals and operator notifications are LOCAL by construction ». La persistance proposée est celle de la confiance administrative, pas des demandes ni des notifications. Aucun replay d'approbations au redémarrage du Deck, aucune fédération des demandes. Ne pas utiliser cet ADR pour étendre l'approbation au broker distant partagé. En mode remote, la politique distante protège les routes opérateur qui y existent, notamment la roadmap ; la disponibilité du Courrier local n'est pas refondue ici.

**DÉDUIT**, `index.ts:613-617`, `approval-runtime.ts:235-248` : les deux chargeurs peuvent remplacer une identité illisible par une nouvelle. Avec un épinglage, cette auto-réparation devient un refus d'autorisation. Il faut retirer cette rotation implicite dans le même palier, y compris le cas connu `be4ae042`, plutôt que conseiller d'autoriser automatiquement chaque nouvelle clé.

## 3. Options et arbitrage

Les coûts ci-dessous sont **SUPPOSÉS**, estimations d'implémentation et de tests ciblés ; ils excluent le gate commun et le déploiement manuel de chaque serveur.

| Option | Coût | Risque et rayon d'impact | Réversibilité |
|---|---:|---|---|
| A. Identifiant/clé dans l'environnement au spawn du Deck | 4 à 6 h | Petite modification, mais broker adopté, spawn par `server.ts` et remote non couverts ; l'auteur du premier spawn choisit l'autorité. | Facile à retirer ; risque de maintenir deux régimes d'authentification. |
| B. Politique locale écrite automatiquement par le Deck ; remote inchangé | 10 à 14 h | Ferme une partie du HTTP local, mais première écriture encore à justifier, collision de deux Decks ; auto-certification distante laissée exploitable. | Format récupérable, mais dette de sécurité et migration de comportement par topologie. |
| C. Politique statique multi-clés administrée hors HTTP, refus strict partout | **14 à 18 h** | Migration visible des brokers/fixtures ; un opérateur oublié est refusé. Pas de nouveau protocole d'administration réseau. | Ajout/retrait administré de clés, format versionné ; retour arrière par ancien binaire déconseillé car il rouvre la faille. |
| D. C plus enrôlement/révocation en ligne par autorité déjà épinglée | 20 à 28 h au total | Résout l'exploitation multi-postes, mais ajoute délégation d'administration, concurrence, rejeu, récupération et rotation en ligne. | C reste le socle ; surface HTTP supplémentaire à maintenir. |

**RECOMMANDATION : C.** La force décisive est de retirer l'auto-certification sans inventer maintenant un second protocole d'autorité. Le remote est précisément un cas où la séparation OS rend l'épinglage utile ; le laisser ouvert n'est pas un palier de fermeture de cette faille. L'enrôlement dynamique peut attendre.

**Challenge indépendant :** lecture seule par le security-auditor, verdict `TIENT` sous réserve du modèle de menace ; objection centrale retenue : aucune politique inscriptible par le même compte OS ne constitue une séparation Deck/agent hôte. Autres corrections intégrées : démarrage par `server.ts`, rotation implicite, broker adopté non provisionné et fixtures déjà auto-certifiées. Ce verdict n'est pas une mesure d'exécution.

## 4. Contrat proposé : politique, identité et première clé

### 4.1 Autorité et modèle de données

**CONTRAT PROPOSÉ :** ajouter `shared/operator-trust.ts`, sans Electron ni SQL, pour parser/valider la politique et répondre `trustedOperator(operator_id)`. Le broker charge ce module et injecte le résolveur dans `ApprovalAuthDeps`. Le Deck ne fournit jamais la décision de confiance dans un corps HTTP.

Politique v1 : fichier `operator-trust.json`, **frère de la configuration globale du broker**, pas dans le dépôt ni sous un `userData` choisi par un appelant. Contenu : version et liste de clés publiques Ed25519 autorisées, avec libellé administratif facultatif. Les identifiants sont dérivés, pas déclarés indépendamment. Valider toute la liste avant de l'activer, rejeter les clés malformées, les types cryptographiques inattendus et les doublons d'identifiant associés à des matériaux différents. Une entrée invalide invalide le fichier entier ; aucune réduction silencieuse en sous-ensemble.

L'ensemble en mémoire est indexé par `operator_id`, avec la clé publique complète comme valeur. Vérifier le matériau complet lors des correspondances ; un condensat tronqué n'est pas à lui seul la politique. `approval_operators` reste un registre technique/observé, **jamais la source d'autorisation**. Ne pas importer ses anciennes lignes dans la politique.

Le domaine d'autorité v1 est le **profil d'administration du broker** : deux brokers lancés avec la même racine globale utilisent volontairement le même ensemble de clés, indépendamment de leurs bases/ports. Pour deux domaines d'autorité distincts, utiliser deux profils de service isolés, de préférence deux comptes OS ; ne pas attribuer implicitement un domaine par cwd, groupe, URL ou `operator_id`. Cette limite évite de créer un catalogue de brokers et une procédure de sélection dans ce palier.

Aucune variable `CLAUDE_PEERS_*`, entrée MCP, requête, configuration de dépôt ou paramètre renderer ne peut remplacer le contenu ni choisir un fichier alternatif de politique. Les variables OS déjà utilisées pour localiser le profil restent dans le périmètre de confiance du lancement du service ; elles ne sont pas une protection face au même utilisateur capable de relancer le processus. L'injection d'un chemin temporaire pour les tests est une dépendance interne, pas un drapeau « permissif » de production.

### 4.2 Racine de la première clé, par topologie

| Topologie | Première clé | Broker déjà actif |
|---|---|---|
| Local | L'administrateur du profil OS provisionne explicitement la clé publique du Deck dans le fichier global, hors HTTP, avant activation des fonctions opérateur. | Même fichier et même règle ; le Deck ne remplace pas la politique du broker adopté. |
| Replica | Même provisioning sur le profil du broker loopback. La clé de l'upstream et le Bearer de réplication n'enrôlent personne localement. | Même refus d'une identité absente ; pas de récupération de confiance depuis la synchronisation. |
| Remote | L'administrateur de l'hôte/service distant reçoit **la clé publique seulement**, vérifie son empreinte par le canal administratif choisi, installe la politique puis redémarre le service. | Ajout explicite dans ce profil, puis redémarrage contrôlé. Aucun POST de première clé, même avec le token broker ou le secret de groupe. |

**CONTRAT PROPOSÉ :** l'outillage administratif v1 peut être un sous-ensemble local de `cli.ts` : lecture/validation du fichier public exporté, initialisation exclusive, affichage des empreintes et validation d'une politique préparée. Il n'appelle pas une API d'enrôlement et ne lit pas la clé privée. Une commande exécutée par un agent du même compte n'est pas magiquement « humaine » : sa puissance vient des droits OS, limite déjà explicitée.

Initialisation : création exclusive du fichier absent, jamais écrasement ni union implicite ; en concurrence, un seul writer réussit, l'autre relit et signale l'écart. Changements ultérieurs v1 : un administrateur prépare la politique complète, la valide, effectue un remplacement atomique sous maintenance et redémarre le broker. Pas de read-modify-write concurrent automatisé. Le contrôle des droits porte aussi sur le répertoire parent ; sous Windows vérifier les ACL, ne pas assimiler `0600` à leur preuve.

Le Deck charge/crée son identité une fois après disponibilité du chiffrement et avant son handshake opérateur. Un fichier existant illisible bloque cette identité, sans nouvelle clé. Un fichier absent peut conduire à une première création, mais cette création **n'autorise pas** la clé dans la politique. Plusieurs processus partageant le même `userData` doivent créer exclusivement puis relire le gagnant, pas se remplacer mutuellement. Les chemins de signature roadmap et d'armement réutilisent ce même contrat d'identité.

### 4.3 Deux Decks, deux identités, clé copiée

| Situation | Réponse contractuelle |
|---|---|
| Deux Decks, même clé copiée | Même principal opérateur. Aucune distinction de poste ni révocation de la seule copie n'est possible. Les tokens restent liés à leurs sessions/runs, pas fusionnés par cet ADR. |
| Deux Decks, deux clés | Deux entrées autorisées, ajoutées explicitement. Le deuxième Deck non inscrit reste refusé ; la présence du premier ne lui donne pas le droit de s'ajouter. |
| Deux identités d'une même personne | Deux principaux distincts. L'autorisation ne se déduit ni du nom, ni du hostname, ni du compte de notification commun. |
| Deux opérateurs autorisés, même broker | Ils possèdent les pouvoirs opérateur globaux déjà portés par les routes roadmap, y compris leurs exceptions de verrou. L'épinglage n'introduit pas un RBAC ou une propriété exclusive des groupes. Pour les approbations, préserver les scopes de l'objet propriétaire. |

**CONTRAT PROPOSÉ :** inscrire une clé revient donc à accorder l'autorité opérateur de ce domaine, pas à autoriser une seule tuile. Si plusieurs humains mutuellement non fiables doivent partager le broker, cette politique globale ne suffit pas : il faut une décision distincte sur les pouvoirs par groupe/projet.

## 5. Contrat proposé : application, panne et révocation

### 5.1 Garde centralisée et chemins dérivés

1. `authenticateOperator` garde l'allow-list d'opérations par classe. Pour une preuve opérateur, résoudre la clé **dans la politique**, puis vérifier la signature et le nonce. La clé du corps ne peut jamais enrôler ni remplacer celle de la politique. Si présente, elle doit correspondre au principal autorisé.
2. Mettre à jour `approval_operators` seulement après cette validation. Pour une session, vérifier aussi que le propriétaire du token est encore autorisé, puis garder révocation, expiration, liaison session/projet et signature. Un ancien token d'un opérateur jamais épinglé n'est pas un droit acquis.
3. Pour les réponses par gateway, résoudre l'approbation, vérifier que son propriétaire est autorisé, puis vérifier l'appairage de cette identité et régler l'objet. Ne pas démarrer les gateways d'identités non autorisées. La confiance doit être contrôlée au règlement, pas seulement à leur démarrage.
4. Les anciennes identités et données ne sont pas supprimées ni promues à la migration. Désactiver les tokens des propriétaires non autorisés pour éviter leur résurrection lors d'un futur réajout ; leurs notifications ne doivent plus être émises. Ne pas faire de transfert automatique de propriété.

**DÉDUIT**, `shared/approval.ts:229-256` et appelants directs de `authenticateOperator` dans `broker.ts:2812,4355,10484,10589,10619,10651,10706` : les sept sites recensés ne sont pas sept opérations distinctes ; la couverture comprend `context-transaction`, `roadmap-write`, `claim`, `list`, `channels` et `mint-token`, plus les appels transitifs de la couche de scope. Conserver un inventaire dérivé des usages au moment d'implémenter, pas une garde limitée à ces numéros de ligne.

### 5.2 États et erreurs observables

| État | Comportement contractuel |
|---|---|
| Politique absente | Broker utilisable pour les fonctions non privilégiées ; actions opérateur et dérivées refusées `503 operator-trust-unconfigured`. Aucun apprentissage au premier appel. |
| Politique illisible/invalide | `503 operator-trust-invalid`, trace dans le logger broker ; aucun retour à une ancienne liste ou à l'auto-certification. |
| Politique valide, clé absente | `403 operator-not-trusted`. Une signature invalide reste `401`. Liste vide explicite = aucune autorité. |
| Broker ancien/adopté | Le nouveau Deck refuse d'activer le chemin destructif L3 tant que le protocole de confiance n'est pas annoncé et qu'une preuve de sa propre identité n'a pas été acceptée. Erreur opérateur visible, pas seulement journal. |
| Modification du fichier | V1 est un snapshot de démarrage. Effet **au redémarrage contrôlé**, pas promesse de révocation instantanée. Ne pas introduire un watcher ou un cache TTL dans ce palier. |

**CONTRAT PROPOSÉ :** ajouter `operator_trust_version: 1` et un état non sensible (`ready`, `unconfigured`, `invalid`) à `/health`. Ajouter `POST /operator/check`, nouvelle opération `operator-check` absente de `SESSION_ALLOWED`, vérifiant une preuve signée par la même fonction centrale et répondant seulement pour le principal appelant (`operator_id`, version de protocole). Cette vérification ne modifie pas la politique ; la consommation du nonce et la trace `last_seen` restent permises. Aucun dump des clés ni de chemin local dans la réponse. Le signal health aide au diagnostic de version ; il **n'authentifie pas le serveur**. Les opérations réelles refont toujours leur garde. Une réponse 200 de n'importe quel processus qui occupe le port n'est pas une preuve de provisioning.

Le refus doit passer par `reportError` et le canal visible d'erreur existant du Deck. L'échec d'autorité n'empêche pas de démarrer toute l'application, mais désactive l'action qui exige cette autorité. L3 doit vérifier la disponibilité **avant toute frappe de `/clear`**, et rester bloquée sur un broker non compatible. Ne pas redémarrer silencieusement un broker adopté qui peut servir un autre Deck. Ce verrou ne couvre que le `/clear` d'une transaction avec dépôt de contexte : `clear` et `clear_reload` sans dépôt n'exercent aucune autorité broker et ne perdent aucun dépôt.

### 5.3 Rotation et compromission

**CONTRAT PROPOSÉ :** v1 conserve une administration hors ligne. Rotation normale : ajouter la nouvelle clé, garder explicitement l'ancienne le temps de terminer ses demandes dans le run courant, puis retirer l'ancienne et redémarrer. La nouvelle identité ne peut pas réclamer les approbations de l'ancienne ; les scopes restent intacts. Si le Deck ne peut plus utiliser l'ancienne, proposer de terminer/abandonner/reposer les demandes par les mécanismes existants, jamais de les réattribuer en SQL.

Compromission : retrait immédiat de la clé, redémarrage contrôlé, refus de tous ses tokens et de ses réponses gateway, sans grâce. Les opérations déjà terminées ne sont pas annulées par une révocation ; les approbations en attente restent sans nouveau verdict automatique. Une copie de la même clé est révoquée en même temps sur tous ses postes dans ce domaine.

Deux options de rotation ultérieure : conserver ce mode administratif (coût faible, interruption opérateur explicite), ou ajouter un protocole en ligne (coût et nouveaux pouvoirs). Recommandation v1 : **mode administratif**, puisque la conservation de l'ancien `operator_id` sous une nouvelle clé nécessiterait de découpler identité et clé, modification plus large que l'épinglage.

## 6. Palier L3 et migration

**CONTRAT PROPOSÉ :** le plus petit palier sain n'est pas « strict local, permissif remote », mais « strict partout, administration statique ». Si le déploiement distant est différé, un broker remote mis à jour mais non provisionné refuse les fonctions opérateur ; on peut livrer L3 pour les seuls brokers déjà stricts/provisionnés, sans déclarer la carte de sécurité entièrement déployée.

Laisser un ancien remote en service peut être une dérogation opérationnelle explicite, limitée dans le temps, mais constitue une **dette de sécurité**, pas une propriété du correctif. Ne pas ajouter un flag de compatibilité qui réactive le TOFU. Ne pas lever la dépendance L3 sur la seule présence d'un fichier ou d'un commit : le broker effectivement ciblé doit exécuter le garde.

Migration proposée :

1. Préparer les clés publiques et les politiques par domaine, vérifier les empreintes hors HTTP ; ne pas exporter les anciennes lignes `approval_operators` comme liste de confiance.
2. Installer le palier strict et ses fixtures explicites ; déployer/provisionner les brokers, vérifier une identité admise et une clé inconnue refusée avant de rouvrir les fonctions opérateur.
3. Installer le chargeur Deck non rotatif et le diagnostic d'adoption ; armer les tokens uniquement après acceptation de l'identité. Prévoir l'interruption contrôlée des approbations pendant cette maintenance.
4. Autoriser L3 sur un couple Deck/broker compatible ; répéter la vérification sur chaque remote utilisé. Aucun gain de confiance n'est transmis automatiquement à l'upstream.

## 7. Lots committables et validation

**SUPPOSÉ :** 14 à 18 h pour le palier statique, contre la première estimation 12 à 16 h ; la marge additionnelle couvre l'identité non rotative et les voies héritées session/gateway. Si le besoin inclut séparation OS de toutes les tuiles hôte, ce chiffrage ne couvre pas ce chantier.

| Lot | Livrable et fichiers | Estimation |
|---|---|---:|
| 1. Contrat de politique et administration locale | Nouveau `shared/operator-trust.ts`, extraction minimale du chemin global dans `shared/config.ts`, commandes locales dans `cli.ts`, tests de validation/provisioning, procédure `runbooks/operator-trust.md`. Contrat prêt mais pas encore revendiqué actif. | 3 à 4 h |
| 2. Garde broker et migration de confiance | `shared/approval-scope.ts`, `broker.ts`, fixtures `tests/_helper.ts`, tests d'intégration opérateur/contexte/roadmap et gateway. Garde active sans option permissive, diagnostic health et vérification signée. Adapter les fixtures dans ce même commit. | 5 à 6 h |
| 3. Identité et adoption Deck | `desktop/src/main/operator-identity.ts`, `approval-runtime.ts`, `broker-spawn.ts`, `index.ts`, signataire roadmap si nécessaire ; tests ciblés de création concurrente, panne keychain, adoption et démarrage. Ferme les régénérations implicites du chemin utilisé, sans refonte du coffre. | 4 à 5 h |
| 4. Contrat d'exploitation et verrou L3 | `ARCHITECTURE.md`, `DESKTOP.md`, `runbooks/operator-trust.md`, tests de compatibilité/topologies et point d'activation L3 dans le lot contexte du développeur. Vérification hostile indépendante puis déploiement séquencé. | 2 à 3 h |

Les lots 2 et 3 doivent être prêts avant activation opérateur sur le poste ; le lot 1 seul ne ferme pas la faille. Le commit de garde centralisée doit rester cohérent avec toutes les fixtures qui signaient jusqu'ici sans provisioning.

Extension D, **SUPPOSÉ : 6 à 10 h supplémentaires**, après usage de C : autoriser une clé déjà épinglée à proposer une nouvelle clé avec preuve de possession, liaison au domaine du broker, version attendue de politique, anti-rejeu et journal ; décider auparavant si chaque opérateur peut administrer les autres. Garder le bootstrap/récupération hors HTTP et ne pas réutiliser l'ancien export de clé privée comme enrôlement d'une nouvelle identité.

### Matrice minimale pour le développeur et le reviewer

1. **Authentification et non-promotion.** Clé fraîche refusée avant/après la clé légitime, même secret de groupe ; clé présente seulement dans `approval_operators` refusée ; positif réellement provisionné ; signature/nonce/mauvais matériau toujours refusés. Chaque opération de l'enum classée et chaque route revendiquant un auteur réservé couverte.
2. **Objets et dérivés.** Les trois opérations de session restent restreintes à leurs objets ; propriétaire non épinglé refusé ; téléphone de propriétaire retiré ne règle rien ; deux identités appairées à la même adresse gardent des scopes distincts.
3. **Topologies et concurrence.** Local, replica et remote, broker lancé par Deck ou `server.ts`, adopté ancien/non provisionné, politique invalide, deuxième Deck avec clé distincte, deux créations simultanées de politique et deux créations d'identité avec même `userData`.
4. **Rotation et L3.** Panne keychain sans changement de clé ; ajout de B ne transfère pas les demandes de A ; retrait de A effectif après redémarrage ; absence de `/clear` avant reconnaissance positive du garde ; clé copiée traitée comme un seul principal.
5. **Contrôle négatif de câblage.** En miroir isolé, retirer le lookup de confiance doit faire échouer les tests HTTP hostiles, pas seulement un test du parseur. Retirer le contrôle du propriétaire de token/gateway doit faire échouer leurs tests spécifiques. Préparer les politiques par l'outil hors HTTP de test, jamais par un premier POST.

Fichiers existants à cibler selon le lot : `tests/desktop-approval-scope.test.ts`, `tests/broker-approvals.test.ts`, `tests/broker-context-deposit.test.ts`, `tests/broker-roadmap-lock.test.ts`, `tests/desktop-broker-spawn.test.ts`, `tests/desktop-approvals.test.ts`, `tests/desktop-approval-runtime.test.ts`. Exécuter chaque fichier touché séparément ; le séquenceur garde l'unique suite complète, le smoke build et le typecheck. Aucun test exécuté pour cet ADR documentaire ; aucun résultat futur n'est revendiqué vert.

## 8. Arbitrages opérateur

Ratification du 2026-10-15 transmise par le lead : portée A « strict partout », provisioning explicite hors HTTP et politique statique multi-clés. Les alternatives ci-dessous restent documentées ; aucun arbitrage supplémentaire sur la rotation n'est déduit de cette ratification.

| Question | Options | Recommandation |
|---|---|---|
| Portée de livraison | A : strict partout et maintenance remote ; B : strict local/replica, remote explicitement désactivé pour les actions opérateur jusqu'au provisioning ; C : remote auto-certifié résiduel. | **A acceptée le 2026-10-15**. Voir la nuance réplique/remote ci-dessous. Refuser C comme clôture de la carte. |
| Nombre et pouvoir des identités | A : une seule clé ; B : plusieurs clés avec les pouvoirs opérateur actuels ; C : plusieurs clés avec RBAC par groupe/projet. | **B**, cohérent avec les scopes actuels. C est un chantier supplémentaire si les humains ne se font pas confiance. |
| Bootstrap local et administration | A : provisioning explicite hors HTTP de toute première clé ; B : le Deck initialise automatiquement un fichier absent ; C : enrôlement dynamique par clé déjà autorisée après bootstrap hors HTTP. | **A pour v1**. B réduit la friction mais fait dépendre le choix initial du premier processus local ; C apporte du confort après fermeture du trou. |
| Rotation des demandes en attente | A : fenêtre de coexistence explicite de deux clés, sans transfert ; B : révocation immédiate sans grâce et demandes à reprendre ; C : identité stable indépendante de la clé avec migration des propriétaires. | **A en maintenance normale, B en compromission**. C dépasse l'épinglage minimal. |

**Nuance de portée, DÉDUIT, À CONFIRMER par mesure dans le lot 1 :** en mode réplique, les actions opérateur des clients de cette réplique passent par le broker **LOCAL** (`shared/config.ts:378-398`). Pour les écritures roadmap de ce chemin, le broker distant ne reçoit que la synchronisation sous Bearer, pas la preuve opérateur d'origine (`broker.ts:7148-7225`). L'inscription de la clé opérateur sur le distant ne sert donc qu'aux clients qui s'y branchent directement en mode **remote** ; elle n'est pas requise pour leur seul usage via la réplique. Cette précision concerne les actions opérateur, pas l'ensemble des échanges de fédération.

**Prochaine action : dispatcher les quatre lots, avec confirmation mesurée de la nuance réplique/remote dans le lot 1, sans attendre un protocole d'enrôlement en ligne.**
