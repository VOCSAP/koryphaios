# Familles MCP : contrat de conception

## 1. Décision et périmètre

[MESURÉ documentaire] `kleos-cli recall 37743` fixe les familles et leurs audiences : `kory-deck = pilotage (deck_* et roadmap_dispatch), Kory seulement, team-lead et superviseur`. `kleos-cli context "MCP familles arbitrages finaux" --limit 5`, décision 37756, précise : `le team-lead recoit TOUT kory-deck (les 20 outils deck_* plus roadmap_dispatch), meme perimetre d'outils que le superviseur`.

**Contrat accepté :** partition physique par responsabilité ; communication et roadmap globales ; opérateur et pilotage réservés aux leads/superviseurs Kory ; démo spécialisée avec navigateur et les deux globaux filtrés, sans opérateur ni pilotage. Le lead reçoit toute la surface de pilotage et le même plafond de caractères que le superviseur. Les protections internes aux actions restent applicables : même outil offert ne signifie pas mêmes objets autorisés.

[MESURÉ documentaire, même commande, décision 37756] La portée de sécurité est explicitement limitée : `le cloisonnement worker est garanti par la configuration MCP geree par Kory, le refus cote broker d'un appel HTTP forge reste la carte 8853e643`. Les contrats W/L ci-dessous ne sont pas un certificat de confinement d'un shell compromis.

[SUPPOSÉ, contrat de réalisation] Le document spécifie la cible et ses portes de livraison, pas une implémentation déjà livrée. Migration additive, retrait après preuve hôte et sandbox ; aucune migration des données roadmap prévue. Les approbations de commande restent indépendantes du canal conversationnel opérateur et locales au run Kory.

## 2. Structure actuelle et frontières à conserver

| Constat | Source et conséquence |
|---|---|
| [DÉDUIT] Le cœur possède l'identité et la réception | `ARCHITECTURE.md:5-11` décrit register/WS/disconnect ; `server.ts:2602-2851` utilise son état de session pour l'auteur, le projet, les preuves et les accusés roadmap. Extraire les cartes exige un contexte explicite. |
| [DÉDUIT] Le rendez-vous sibling actuel est lié à la tuile | `server-deck.ts:87-110` lit `CLAUDE_PEERS_DESK_SESSION` ; `shared/peer-cache.ts:171-181` n'écrit rien sans ce jeton. Ce mécanisme ne suffit pas à démontrer le fonctionnement hors Kory. |
| [DÉDUIT] Pilotage main et dispatch broker ont des preuves distinctes | `supervisor.ts:133-159` sépare les transports ; `server.ts:1867-1882` utilise l'instance sibling pour dispatch. Le serveur commun ne fusionne pas leurs credentials. |
| [DÉDUIT] Les approbations possèdent leur propre producteur | `approval-hook.ts:309-341` appelle add/wait ; `approval-client.ts:49-84,139-154` construit `/approval/*`, `reply_route: hook` et la signature de session. Ne pas retirer les credentials du hook worker. |
| [DÉDUIT] La démo requiert un lot d'agent, pas un renommage | `demo-driver.ts:60-77,115-126` produit une configuration navigateur et lance un runner headless strict. Le type d'agent embarqué demandé doit disposer de son montage, prompt et skill. |

[SUPPOSÉ, structure recommandée] Les modules partagés portent schémas, handlers et contexte injecté ; les entrypoints portent transport et registre fermé. `server.ts` reste seul propriétaire de register/WS/heartbeat/disconnect. Aucun companion ne s'enregistre, même si le cœur est absent.

```text
Session Claude Code
  claude-peers -> identité + réception -> broker
  kory-roadmap -> identité sibling à chaque appel -> broker /roadmap/*
  Lead/superviseur Kory seulement :
    kory-operator -> identité/run -> broker local
    kory-deck -> deck_* + caller token -> Deck main
              -> roadmap_dispatch + instance sibling -> broker local
  Agent démo seulement :
    demo-browser -> capacité navigateur dédiée -> demo-control

PermissionRequest hook/module -> client signé -> /approval/*
                                (aucun passage par kory-operator)
```

## 3. Registre exhaustif et matrice des profils

[DÉDUIT, `server.ts:807-1286`, `desktop/mcp/deck-control-mcp.ts:68-278`, `desktop/mcp/demo-browser-mcp.ts:24-76`] Les noms existants proviennent des registres actuels. [SUPPOSÉ, contrat cible] Chaque outil appartient à une seule famille ; `notify_operator` est ajouté et remplace le dépôt conversationnel via `send_message('operator')`.

| Code | Serveur et portée | Outils |
|---|---|---|
| C | `claude-peers`, global | `list_peers`, `send_message`, `check_messages`, `wait_for_message`, `whoami`, `set_summary`, `set_id`, `list_groups`, `switch_group` |
| R | `kory-roadmap`, global | `roadmap_list`, `roadmap_get`, `roadmap_add`, `roadmap_update`, `roadmap_append_context`, `roadmap_archive` |
| O | `kory-operator`, lead/superviseur Kory | `ask_operator`, `ask_operator_wait`, `notify_operator`, `graph_draft_prepare`, `graph_draft_send` |
| D | `kory-deck`, lead/superviseur Kory | `deck_spawn_session`, `deck_spawn_team`, `deck_close_session`, `deck_run_directive`, `deck_team_playbook`, `deck_team_agents`, `deck_list_agents`, `deck_list_models`, `deck_list_presets`, `deck_list_sessions`, `deck_sandbox_exec`, `deck_restart_session`, `deck_close_all`, `deck_create_worktree`, `deck_list_worktrees`, `deck_remove_worktree`, `deck_list_templates`, `deck_apply_template`, `deck_save_template`, `deck_announce`, `roadmap_dispatch` |
| V | `demo-browser`, hors familles, agent démo | `demo_read`, `demo_navigate`, `demo_click`, `demo_type`, `demo_wait` |

[SUPPOSÉ, règles de composition] `P` désigne le filtre historique `CLAUDE_PEERS_TOOLS` ; `H` la restriction du harnais/profil après migration des noms qualifiés ; `DroitDeck` le filtre/grant de contrôle. Toutes les cellules autorisées restent intersectées avec H et les vérifications internes de l'action. « Global » désigne l'installation utilisateur, sans annuler une désactivation explicite ou un lancement strict.

| Profil | C | R | O | D | V |
|---|---|---|---|---|---|
| Hors Kory | P(C) | P(R) | Non | Non | Non |
| Worker Kory, solo compris | P(C) | P(R) | Non | Non | Non |
| Team-lead avec pont accordé | P(C) | P(R) | P(ask/graph), notification selon P(send_message) | Tous les `deck_*` selon DroitDeck ; dispatch selon P | Non |
| Superviseur | P(C) | P(R) | P(ask/graph), notification selon P(send_message) | Tous les `deck_*` selon DroitDeck ; dispatch selon P | Non |
| Agent démo embarqué | P(C) | P(R) | Non | Non | V, capacité dédiée |

[SUPPOSÉ, règle de montage] Un profil portant le nom team-lead sans pont accordé reste sur la ligne worker pour O/D ; son nom seul ne permet pas de minter un caller. Une fois le pont accordé, sa dotation est la totalité de D, sous les filtres explicites et protections internes.

[SUPPOSÉ, contrat de retrait] Le worker perd la destination volontaire `operator` et ne reçoit aucun remplacement O. Il conserve les communications entre pairs et la roadmap sous son nouveau préfixe. `send_message('operator')` doit être refusé avant transport dans C, pour tous les profils ; les leads utilisent O. Les approbations, notifications automatiques des hooks et escalades système restent hors de ce retrait.

[DÉDUIT, `ARCHITECTURE.md:69-77`, `server.ts:2743-2744,2785-2792`] Les tâches suivies peuvent escalader et les cartes portent directives/queue : la fermeture des outils D ne signifie pas disparition de tout effet indirect sur le Deck.

## 4. Installation des deux MCP globaux

| Option | Coût, risque, réversibilité, rayon d'impact |
|---|---|
| [SUPPOSÉ] A : un launcher à modes sous deux entrées MCP | Nouveau routage de bootstrap et garde des modes invalides ; risque de démarrer le cœur par défaut. Rollback des arguments. Conserver une compatibilité `server.ts` ou adapter aussi la découverte du broker. |
| [SUPPOSÉ] B : deux entrypoints minces dans la même distribution | Futur `server-roadmap.ts` à packager, modules métier partagés, aucun routeur de modes. Bootstrap séparé et retrait ciblé de la nouvelle entrée avant extinction legacy. Impact moindre sur l'installation existante. |

**[SUPPOSÉ, recommandation] Retenir B : `server.ts` et `server-roadmap.ts`, même paquet/révision, deux clés utilisateur.** [DÉDUIT, `README.md:140,207`, `desktop/src/main/broker-spawn.ts:57-70`] L'installation documentée pointe sur `server.ts` ; le Deck en dérive `broker.ts`. Conserver cette entrée évite une modification incidente de découverte.

[SUPPOSÉ, commandes cibles après P0, pas commandes déjà exécutées] :

```sh
claude mcp add --scope user --transport stdio claude-peers -- bun <installation>/server.ts
claude mcp add --scope user --transport stdio kory-roadmap -- bun <installation>/server-roadmap.ts
```

[SUPPOSÉ, contrat d'installation] Préserver `claude-peers` et ajouter `kory-roadmap` dans `~/.claude.json`, sur la même révision. Ne pas supposer qu'un `mcp add` remplace une clé existante : comparer, sauvegarder les entrées concernées, refuser les collisions inconnues et migrer explicitement les entrées personnalisées. Aucun token d'instance statique dans cette configuration. Même broker, groupe, projet et domaine P pour les deux processus.

[SUPPOSÉ, limites] Le CLI utilisé reste `claude mcp add` ; cette carte n'invente pas un installateur dans le CLI diagnostic. Une roadmap sans sibling utilisable refuse ses opérations avec une erreur explicite, sans identité de secours. Le plugin Kory n'est pas installé globalement pour rendre les deux MCP globaux utilisables.

[SUPPOSÉ, projection] Les bundles O/D/V restent distribués par Kory. Un lancement strict ou sandbox reçoit explicitement C/R si la configuration utilisateur n'y est pas accessible, avec les chemins de son environnement ; jamais deux cœurs pour compenser l'héritage. Ne pas monter le home ni l'app-state complet, préserver les exclusions de secrets et les validations main.

[DÉDUIT, `desktop/hooks/roadmap-guard-hook.ts:18-21,60-61`] Le garde sélectionne les noms qualifiés : un nouveau préfixe non déclaré échappe au traitement. [SUPPOSÉ, migration obligatoire] Migrer ensemble profils `tools:`, restrictions CLI, prompts/skills, matchers de `desktop/deck-plugin/hooks/hooks.json`, dispatch interne du garde, instructions et gardes d'ack. Les gardes acceptent temporairement les deux préfixes, sans servir les deux alias à la même session. Qualifier aussi les références des profils et outils hors dépôt avant retrait.

## 5. Identité, rendez-vous P0 et filtres

### Rendez-vous d'identité

[SUPPOSÉ, invariant] Une session possède une identité et un seul écrivain de présence. Les companions relisent à l'appel un snapshot cohérent de broker, pair, instance, groupe, projet et génération active. `set_id`, `switch_group`, restart/resume doivent actualiser cette vue. Pas de credential conservé seulement au boot, projet vide, recomputation divergente ou auteur inventé.

| Option | Arbitrage |
|---|---|
| [SUPPOSÉ] Étendre le fichier sibling avec une clé commune réellement prouvée | Option préférée : petit delta, patron existant sous Kory. Le jeton de tuile reste utilisable sous Kory ; hors Kory, ni SID ni PPID n'est certifié sans P0. La clé de rendez-vous n'est pas une preuve d'autorité. |
| [SUPPOSÉ] Launcher de Claude injectant une clé aléatoire commune | Repli à soumettre si P0 échoue : plus déterministe sous son contrôle, mais change le lancement utilisateur et ne couvre pas automatiquement toute session Claude Code. Ne pas imposer ce coût silencieusement. |

[DÉDUIT, `shared/peer-cache.ts:262-279`] Le nettoyage protège certains fichiers périmés mais le contrat signale qu'un token reste résolvable sans filtre de statut aval. [SUPPOSÉ, nouveau lecteur] Refuser fichier absent, incomplet, ambigu, writer mort et génération périmée. Un PID vivant ne protège pas de sa réutilisation. Aucun registre supplémentaire, aucune recherche du premier pair par cwd et aucun second `/register`.

**[SUPPOSÉ, porte P0] Avant toute mise en service globale de R**, exécuter une sonde isolée avec deux MCP d'une session hors Kory, puis deux sessions dans le même cwd : fresh, `/clear`, reconnexion d'un seul MCP, crash du cœur, reprise/redémarrage. Observer des discriminants non secrets et l'auteur reçu par un broker de test. Exiger une clé commune aux siblings vivants, distincte entre lancements et sans réemploi du credential d'une génération morte. Couvrir Windows et la projection sandbox ; une observation de l'environnement Bash ne suffit pas. Une divergence bloque P1, pas le travail Kory indépendant de P2.

### Autorisations et restrictions

[SUPPOSÉ, contrat] Surface finale = registre de famille ∩ plafond du montage géré ∩ filtre historique de l'outil, puis H. Même ensemble dans `tools/list`, `tools/call` et les instructions. Le site de montage décide la famille, pas une chaîne `role` fournie par l'agent. Un plafond O/D absent ou invalide refuse la surface. Transporter un ensemble vide explicitement, sans dépendre d'une variable Windows vide.

[SUPPOSÉ, mapping] C/R et ask/graph gardent P ; notification hérite de P(send_message), seulement dans un montage O autorisé ; dispatch garde P(roadmap_dispatch) et l'instance sibling, jamais `DECK_CONTROL_TOKEN`. Les vingt `deck_*` gardent DroitDeck et le caller token main. Le plafond lead est élargi à vingt, mais une restriction explicite H/P/DroitDeck reste restrictive et les contrôles internes d'objet restent en place. Le plafond de rôle du lead ne limite pas cette surface à quatre outils.

[SUPPOSÉ, portée] P absent signifie tous les outils de son domaine, vide signifie zéro, liste signifie intersection. Une interdiction ne devient pas permission par changement de préfixe. Une configuration de montage n'est pas une nouvelle ACL broker : le traitement d'appels HTTP forgés demeure `8853e643`.

## 6. Lots et portes de livraison

[SUPPOSÉ, organisation] Branche dédiée et checkout isolé, déployables pour broker/CLI et artefacts Deck. Conserver les révisions et configurations permettant le retour arrière. Aucun basculement du checkout partagé et aucun retrait legacy avant preuve sur les environnements concernés.

### Préparation et paire globale

| Lot | Dépendances et fichiers principaux | Preuve de sortie | Déployable seul ? |
|---|---|---|---|
| P0 : rendez-vous | Aucune ; lifecycle `server.ts`, `server-deck.ts`, `shared/peer-cache.ts`, configurations hôte/sandbox, sonde isolée | Protocole de §5, clé et génération réellement démontrées ; inventaire des installations et profils à migrer | Non, préalable bloquant du global |
| P1 : paire globale opt-in | P0 ; `server.ts`, futur `server-roadmap.ts`, handlers/contexte partagés, `shared/peer-cache.ts`, README/packaging, tests allowlist/identité/ack, `tests/peer-mcp-surface-budget.test.ts`, `.claude/rules/mcp-surface.md` | R fonctionne avec même auteur/verrou/projet que C ; un seul register/WS. Graphe d'import de R n'atteignant jamais `server.ts`, même transitivement ; sonde runtime complémentaire sans `/register`. Migration des profils/hooks et nouvelle métrique de budget | Oui, pilote cohérent ; legacy conservé mais masqué dans les pilotes pour éviter les doublons |

### Kory et démo

| Lot | Dépendances et fichiers principaux | Preuve de sortie | Déployable seul ? |
|---|---|---|---|
| P2 : O/D hôte additif | Identité Kory actuelle, indépendant de la clé hors Kory ; `server-deck.ts`, handlers `server.ts`, `desktop/mcp/deck-control-mcp.ts`, `supervisor.ts`, `team-lead-bridge.ts`, `session-command.ts`, packaging/profils, `tests/deck-mcp-surface-budget.test.ts`, `.claude/rules/mcp-surface.md` | Notification positive signée ; O/D séparés ; lead et superviseur reçoivent D20 + dispatch. Grants/montages alignés, contrôles internes d'objet conservés ; dispatch sous P et preuve sibling ; L et A vérifiés ; budget lead aligné superviseur | Oui sur hôte pilote avec profils/bundles cohérents ; W complet non revendiqué tant que le dépôt legacy worker subsiste |
| P3 : agent démo embarqué | P1 + P2 ; `demo-driver.ts`, `demo-control.ts`, `desktop/mcp/demo-browser-mcp.ts`, montage de session, agent/skill/prompt embarqués | Lead lance le type démo ; C/R filtrés + V, sans O/D ; scénario reçu et résultat rendu au lead ; capacité dédiée révoquée à l'arrêt ; deux démos ne partagent pas implicitement un fichier/token | Oui après dépendances ; l'ancien driver reste disponible jusqu'à preuve du remplaçant |

### Sandbox et retrait

| Lot | Dépendances et fichiers principaux | Preuve de sortie | Déployable seul ? |
|---|---|---|---|
| P4 : projection sandbox | P1 + P2, coordination `427d057f` ; `sandbox-service.ts`, `sandbox-projection.ts`, `sandbox-copy.ts`, `session-service.ts`, ressources plugin/configs ; P3 pour démo sandbox | Matrice fresh/resume worker/lead/superviseur sur artefacts réels ; C/R, identités et projets corrects ; O/D seulement où prévus ; approbation worker sans O ; runtimes/chemins/capacités correctement projetés | Oui pour habiliter l'environnement, sans retrait legacy fondé sur la seule source |
| P5 : retrait et clôture | P1/P2 déployés, P4 prouvé, profils/hooks/configs migrés ; `server.ts`, vieux entrypoints/exports/montages, instructions/docs/gardes ; preuve P3 pour retrait du driver | C ne sert plus R/O/D ; `send_message('operator')` refusé ; W/L/A exécutés ; registre exact et contrôles positifs sur bundles servis ; vieux montages `deck-lead`/`deck-control` retirés ; démo remplacée pour clôture complète | Non indépendamment des preuves ; rollback coordonné binaires + profils/configs + broker compatible |

[SUPPOSÉ, séquence] P0 réduit d'abord l'incertitude ; P1/P2 se réalisent séparément ; P3 suit leurs capacités ; P4 ferme la matrice puis P5 retire. Une session ancienne n'est pas migrée par modification d'un fichier sur disque : recréer les sessions pilotes concernées. Le rollback restaure une combinaison cohérente, pas seulement un script.

## 7. Contrats de test et mutations source

[SUPPOSÉ, critères à implémenter] Les témoins sont des obligations futures, pas des résultats acquis. Étendre les fichiers des modules existants ; nouveau fichier seulement pour nouveau module/harnais. Muter en miroir. Combiner configuration réellement produite, handlers réels et sonde des artefacts livrés ; ne pas remplacer ces preuves par un scan de texte.

### W : aucun canal conversationnel opérateur pour un worker

[SUPPOSÉ] Sur configuration worker fresh/resume, profil embarqué/externe, P absent/vide/explicitement permissif : aucune entrée O, aucun nom O ni consigne l'offrant. Appeler directement chacun des cinq noms avec la politique worker : refus avant transport, y compris prepare local et wait. Tester plafond absent/malformé. Dans C, destination `operator` refusée et zéro dépôt ; destination pair positive. Dans O, lead autorisé et notification signée constituent le contrôle positif.

| Mutation source | Assertion discriminante |
|---|---|
| W1 : monter O pour un worker ou remplacer son plafond vide par le registre | Configuration et ensemble exact refusent l'élargissement |
| W2 : retirer le garde de `tools/call` sans changer `tools/list` | Appels directs de chaque nom refusés, zéro effet |
| W3 : restaurer le dépôt sentinel de C ou supprimer son refus pré-transport | `send_message('operator')` échoue sans `/send-message`, pair ordinaire fonctionne |
| W4 : exempter prepare local ou wait du contrôle | Ces deux appels restent refusés, pas seulement les créations de dépôt |

[SUPPOSÉ, harnais] Tests de composition dont `tests/desktop-team-lead-bridge.test.ts`, `tests/deck-mcp-tools-allowlist.test.ts`, `tests/server-tools-allowlist.test.ts` et tests du module extrait. W3 ferme seulement après P5, pas dès P2 additif.

### L : aucun outil de pilotage pour un worker

[SUPPOSÉ] Configuration worker sans D ni caller de contrôle minté ; liste vide et appel direct de chaque nom D refusé, dispatch inclus. Lead et superviseur : vingt `deck_*` + dispatch disponibles sous leurs filtres ; main continue de refuser les objets/actions interdits à ce caller, notamment la fermeture de tuiles protégées. Parcourir le registre complet pour couvrir le prochain outil ajouté.

| Mutation source | Assertion discriminante |
|---|---|
| L1 : donner montage/grant lead à un worker | Configuration worker et refus main pour caller non accordé |
| L2 : enlever le garde d'appel ou ne filtrer que la liste | Tous les appels directs cachés refusés |
| L3 : filtrer dispatch par DroitDeck ou union P/DroitDeck | Lead privé de dispatch par P reste privé, même DroitDeck permissif, zéro `/dispatch-request/add` |
| L4 : remplacer la preuve sibling par le token de contrôle | Fake broker exige le token sibling distinct, positif autorisé et négatif mauvais token |

[SUPPOSÉ, conservation des protections] Ajouter un contrôle négatif des objets protégés : retirer le garde main empêchant un lead de fermer une tuile lead/superviseur doit rendre ce test rouge, même avec l'outil offert. La même surface que le superviseur ne doit pas effacer cette différence d'autorité.

[SUPPOSÉ, harnais] Tests du compositeur, `tests/desktop-deck-control.test.ts`, `tests/deck-mcp-tools-allowlist.test.ts` et du handler dispatch extrait. Le témoin dispatch prouve son credential et son filtre MCP, pas une nouvelle ACL broker.

### A : approbations de commande sans kory-operator

[SUPPOSÉ] Configuration worker cible sans O, vrai `PermissionRequest`, credential/bail valides, aucun processus MCP opérateur. Observer `/approval/add` puis `/approval/wait`, signature, `kind: permission`, `reply_route: hook` et retour de verdict allow puis deny. Refuser les transports inattendus. Couvrir aussi le producteur module lorsqu'il fait partie du lancement supporté.

| Mutation source | Assertion discriminante |
|---|---|
| A1 : conditionner credential/armement du hook worker à O | Approbation fonctionnelle malgré absence d'O |
| A2 : passer par notify/ask ou déposer un message au lieu d'une approbation | Routes, signature et type de requête attendus |
| A3 : ne plus monter le hook worker | Test de configuration de lancement, en plus du test du handler |
| A4 : notifier sans attendre/rendre la décision | Verdict réellement retourné au hook, allow et deny |

[SUPPOSÉ, harnais] `tests/approval-hook.test.ts`, `tests/desktop-approval-module.test.ts` et test existant du montage de lancement. Le test du handler seul ne détecte pas la suppression du hook dans la tuile.

[SUPPOSÉ, gardes communs] Classification exhaustive du registre, ensemble exact par profil, schémas et instructions cohérents ; un nom non classé échoue au lieu de disparaître. Identité : companion seul sans register, sibling mort refusé, attribution R = pair C. Transport des filtres absent/vide/inconnu réellement testé sous Windows ; préfixes H et projections sandbox vérifiés sur les artefacts chargés.

## 8. Budgets et conditions de clôture

[SUPPOSÉ, métrique cible] `JSON.stringify(tools).length + instructions.length`, en caractères, pas en tokens. Les valeurs ci-dessous sont des projections de conception à revalider sur les handshakes des artefacts livrés, pas des surfaces cibles déjà mesurées. Les instructions doivent rester dans l'enveloppe ; ne pas gagner un vert en perdant un outil.

| Serveur | Projection / enveloppe | Plafond cible proposé |
|---|---|---|
| C | Schémas 4 499 + instructions redistribuées 728 = 5 227 ; instructions ≤1 000 donnent ≤5 499, avant nettoyage soustractif de send_message | 5 600 |
| R | Schémas 7 196 + instructions redistribuées 957 = 8 153 ; instructions ≤1 100 donnent ≤8 296 | 8 400 |
| O | Schémas existants 2 538 + notification candidate/séparateur 219 = 2 757 ; instructions ≤400 donnent ≤3 157 | 3 423 |
| D, lead ET superviseur | Base de la surface superviseur 10 507 + dispatch/séparateur 291 = 10 798, avant ajustement supplémentaire des instructions | **11 000 pour les deux**, mesure effective de chaque profil avant livraison |
| V | Base 2 285 si schémas/transport/instructions inchangés ; prompt/skill agent hors métrique de ce serveur | 2 285 si texte inchangé, sinon décision explicite après mesure |

[DÉDUIT, `tests/peer-mcp-surface-budget.test.ts:13-37,49-53`] Le garde cœur actuel mesure de la source avec un plancher 8 000 et un plafond 19 000 : il ne suit pas automatiquement les deux registres JSON. [SUPPOSÉ, P1] Remplacer la métrique par les registres/handshakes C/R, avec leurs ensembles exacts et les assertions comportementales transférées au bon propriétaire. Ne pas comparer ou sommer ces métriques incompatibles.

[MESURÉ documentaire, `kleos-cli recall 37735`, extrait] `Le plafond de caracteres du lead peut etre releve`. [SUPPOSÉ, application de l'arbitrage final] Le cap lead est celui du superviseur : 11 000. P2 modifie le garde et documente l'exception à `.claude/rules/mcp-surface.md` qui dit de ne jamais relever le plafond ; réduction utile des descriptions bienvenue, mais pas préalable bloquant.

[SUPPOSÉ, clôture] Les quatre familles et la démo sont utilisables dans leurs profils autorisés ; P0 est démontré ; les sessions hôte/sandbox chargent les bons artefacts ; W/L/A sont exécutés avec leurs contrôles positifs ; restrictions et protections internes sont conservées ; anciens chemins retirés après migration et rollback documenté. Le gate complet appartient au responsable du séquencement des commits, pas à chaque lot.
