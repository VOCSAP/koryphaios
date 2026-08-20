# Changelog

## desktop -- la poignee de redimensionnement passe sur le cadre de la lane Workflow, et trois gardes ferment une carte qui etait annulable en silence

Fichiers : `desktop/src/renderer/src/components/WorkflowLane.tsx`, `desktop/src/renderer/src/styles.css`, `tests/desktop-css-tokens.test.ts`, `DESIGN.md`. Carte `ba3d2456`.

**L'arbitrage annonce avait DEUX issues, la bonne etait une troisieme.** La carte posait le choix entre une poignee a marge negative, qui serait clippee de moitie puisque `.wf-lane` porte `overflow: hidden` pour son rayon de 8px, et une revision de cet `overflow`. Ni l'une ni l'autre : la lane passe `position: relative` et la poignee `position: absolute` avec `top/left/right` a 0. Une boite absolue a `top: 0` est entierement DANS la boite de clip, donc rien n'est rogne et l'entete ne bouge pas d'un pixel. Effet secondaire non prevu et souhaitable : le clip arrondit les extremites de la bande au rayon du cadre, si bien qu'elle se lit comme la barre du cadre et non comme un rectangle colle. A retenir pour les prochaines cartes de ce type : quand l'arbitrage se resume a "consommer du flux" contre "casser le clip", chercher d'abord la sortie par le positionnement absolu.

**La carte etait REVERSIBLE EN SILENCE, et c'est la revue par mutation qui l'a montre.** Remettre les deux fichiers a HEAD, donc annuler la livraison en entier, laissait `tests/desktop-workflow.test.ts` a 55 pass / 0 fail. Raison structurelle mesuree : ce fichier n'importe QUE `desktop/src/shared/workflow.ts`, et un balayage `grep -rln wf-resize` sur l'arbre ne rend que le composant, la feuille de style et un artefact de build ignore. Aucun test ne lisait le JSX ni le CSS de cette lane. Pire mutation trouvee : `.wf-lane` prive de `position: relative` fait remonter la poignee absolue au bloc conteneur initial, ce qui produit une bande de 6px `row-resize` en haut de la FENETRE entiere, puisque ni `.roadmap-view`, ni `.roadmap-body`, ni `.roadmap-main` ne declarent de `position`. Verte.

**Trois assertions de bloc dans `tests/desktop-css-tokens.test.ts`, chacune mesuree ROUGE d'abord**, plus un extracteur `ruleBlock()` qui jette quand le selecteur est introuvable, pour qu'un renommage ne passe pas en pass silencieux. Un mutant reste vert et c'est correct : `z-index` ramene a 0 ne change rien, un element absolu etant peint apres les items flex de toute facon. Mutant equivalent, rien a reprocher. Restent non gardes l'ordre des noeuds JSX, hors de portee d'un test CSS-only et fiche en carte `33a699de`, et la case de validation manuelle de `BACKLOG.md` qui couvre douze verifications sous une seule coche, fichee en `a0d60a23`.

**Trou ferme au passage, il etait nomme dans la carte :** `initialLaneHeight` delegue desormais a `clampLaneHeight`, prouve par l'epreuve avec un config empoisonne a 5000 qui rend 501 au relancement. Juge a l'ecran et pas au typecheck : Deck construit depuis l'arbre, broker prive, instance Electron jetable, capture agrandie en sombre et en clair. `elementFromPoint` confirme que les quatre boutons de l'entete repondent sur leur bord SUPERIEUR comme en leur centre, la bande ne couvrant que les 6px de padding. `DESIGN.md` gagne l'archetype, premiere poignee sur cadre de l'application.

## core + scripts -- la casse du `project_key` est normalisee ET MIGREE en production, par un script qui decouvre ses tables au lieu de les enumerer

Fichiers : `shared/project-key.ts`, `scripts/migrate-project-key-case.ts` (nouveau), `tests/migrate-project-key-case.test.ts` (nouveau), `tests/project-key-normalize.test.ts` (nouveau), `tests/peer-mcp-surface-budget.test.ts`, `tests/desktop-approval-scope-discipline.test.ts`, `.github/workflows/desktop-build.yml`. Carte `69e5a3e0`.

**`normalizeRemoteUrl` minusculait le host mais laissait `owner/repo` dans sa casse d'origine**, donc deux clones de casses differentes calculaient deux `project_key` distincts pour un meme depot, sans aucun signal : depuis la carte `4df14b5b`, une cle fausse ne leve pas, elle rend une liste vide. Option retenue, normaliser a l'ECRITURE et migrer, contre normaliser a la lecture : un site touche au lieu de quinze, et aucun index degrade.

**La carte enumerait QUATRE tables porteuses, il y en a CINQ.** `approval_session_tokens` est ajoutee par `ALTER TABLE`, donc invisible a un balayage des `CREATE TABLE`, et `shared/approval-scope.ts` compare `project_key` entre elle et `pending_approvals` : migrer l'une sans l'autre produisait un refus silencieux. Le script ne prend donc AUCUNE liste. Il interroge le schema, migre ce qu'il trouve, sans exclusion, et refuse s'il decouvre moins de tables que la source n'en declare.

**Trois defauts trouves par revue par mutation, tous invisibles en vert.** `LOWER()` de SQLite est ASCII seulement la ou `.toLowerCase()` est Unicode : le runtime aurait calcule `.../ete` la ou la migration ecrivait `.../EtE`, laissant la ligne orpheline puis la declarant propre, soit une TROISIEME cle que plus aucun code ne produit. Nul sur `github.com`, non nul sur tout hebergeur auto-heberge, or `project_key` existe pour etre cross-host. Le mode `--write` etait casse DEPUIS L'ORIGINE, `bun:sqlite` jetant sur un objet d'options ne portant que `readonly: false` : invisible parce que tous les tests visaient `:memory:`, qui accepte cette forme. Et le fixture de test enumerait quatre tables, reproduisant dans le materiel de test le defaut meme que le script existe pour supprimer ; il derive maintenant du schema reel.

**MIGRATION EXECUTEE le 2026-08-20, a froid.** 375 lignes reecrites sur 4 tables, totaux par table identiques avant et apres, donc aucune ligne perdue ni fusionnee. Verification avec CONTROLE NEGATIF : la nouvelle cle rend 241 cartes, l'ancienne en rend 0. Le piege WAL n'etait pas theorique : au moment de la sauvegarde, `peers.db` faisait 5,2 Mo et `peers.db-wal` 4,7 Mo, donc pres de la moitie de la base vivait dans le journal et une copie du seul `.db` aurait rendu un fichier valide et ampute, sans message. La garde de collision a mordu une fois, sur la seule table ephemere : une session deja passee au code neuf avait ecrit la forme minuscule a cote des anciennes. Resolution ciblee, les 75 lignes historiques intactes.

**Rouge preexistant corrige au passage, et ce n'etait pas l'off-by-one qu'il paraissait.** La sonde `tests/peer-mcp-surface-budget.test.ts` echouait d'UN caractere. `server.ts` est integralement en CRLF (1975 paires, zero saut de ligne nu) et l'insertion du meta-test utilisait un saut de ligne nu, ce qui coupait une paire existante en deux. Le defaut etait dans l'insertion du test, pas dans `stripCommentLines` : ajuster le nombre attendu aurait fige une mesure fausse dans un plafond qui arbitre une decision de conception en cours, la surface etant a 17831 sur 19000.

## spike -- `PostToolUse` peut porter une injection filtree, et son cout n'est PAS repaye a chaque tour

Aucun fichier du depot. Materiel hors arbre. Carte `36897798`, qui debloque `3817a84f` et `8eb6d71e`.

**Le resultat INVERSE ce que la lecture de la doc laissait craindre.** Quatre faits mesures sur Claude Code 2.1.236. La RECEPTION est prouvee : le modele a cite la chaine opaque du marqueur deux fois de lui-meme, quatre minutes AVANT le seul message utilisateur qui la contienne, donc elle ne peut venir que du canal. Le texte est injecte UNE fois et ne reapparait jamais ensuite, alors que dans le meme transcript un hook `UserPromptSubmit` re-injecte son bloc a CHAQUE tour, quatre sur quatre : le cout est donc BORNE, et le defaut qui disqualifiait `Stop` n'est pas partage. Le `matcher` filtre AVANT d'executer le script, controle negatif fait, donc cout nul sur non-match. Enfin, contrainte dure : le texte ne franchit PAS la frontiere sous-agent, alors que le script tourne bien pour ses appels d'outil et que `session_id` reste celui du parent.

**Lecon de methode, elle a failli coder une absence pour un fait.** Le rendu intermediaire concluait depuis "le marqueur ne reapparait jamais", ce qui est compatible avec "il n'est jamais arrive". Les deux mondes ont des consequences opposees, l'un bornant un cout et l'autre tuant le canal. La reception a ete prouvee separement, par relecture d'un transcript deja sur disque, sans nouveau geste de l'operateur.

## repo + docs -- la racine ne porte plus que ses points d'entree, et le runbook de migration devient un playbook

Fichiers : `.gitignore`, `CLAUDE.md`, `runbooks/broker-db-migration.md` (nouveau, depuis `RUNBOOK-PROJECT-KEY-MIGRATION.md`), `docs/DESIGN-APPROVAL-SCOPE.md`, `docs/DESIGN-NOTIFY-DECIDER.md`, `docs/DESIGN-NOTIFY-EVENTS.md` (les trois deplaces depuis la racine), `broker.ts`, `shared/approval-scope.ts`, `tests/desktop-approval-scope.test.ts`, `tests/desktop-approval-scope-discipline.test.ts`, `tests/migrate-project-key-case.test.ts`.

**Le runbook etait ecrit pour un geste unique, et il a servi ; il devient un playbook general.** Trois corrections que l'execution reelle a imposees. L'ORDRE etait faux : il deplacait les surfaces de deploiement AVANT de migrer, ce qui fabrique la collision sur laquelle l'execution a bute, une session lancee entre les deux ecrivant la nouvelle forme dans une base encore ancienne. Le playbook prescrit desormais de migrer d'abord, broker arrete. Le piege WAL est documente avec sa MECANIQUE et non comme une consigne : `broker.ts` force `journal_mode = WAL` au boot mais n'enregistre aucun handler `SIGTERM` et n'appelle `db.close()` nulle part, donc `docker stop` ne garantit AUCUN checkpoint ; la garantie vient de "rien n'ecrit pendant la copie" plus "les trois fichiers sortent ensemble". Et `stack.sh` est un piege dans ce contexte : `update` rebuild ET redemarre, `stop` fait un `compose down` qui arrete aussi les autres services de la LXC.

**Les trois briefs de conception sont DEPLACES, pas supprimes, et la mesure a tranche.** La politique ecrite dans `CLAUDE.md` retire les docs de travail en laissant le detail a l'historique git. Elle ne s'applique pas ici : ces trois-la sont cites depuis le code de PRODUCTION, `broker.ts` et `shared/approval-scope.ts`, plus trois tests. Un pointeur faux coute plus cher qu'une absence de pointeur, puisqu'un lecteur qui suit une reference, ne trouve rien et conclut qu'elle est perimee cesse de faire confiance au commentaire meme quand sa conclusion tient. Les sept citations sont corrigees dans le meme commit.

**`/docs/` sort du `.gitignore`, et `CLAUDE.md` portait deux affirmations devenues fausses.** Elle nommait `/docs/` comme exclu, ce qui ne l'est plus, et sa liste ne disait pas que ces motifs, depourvus de slash, sont NON ANCRES au sens de gitignore(5) et mordent a n'importe quelle profondeur : c'est exactement ce qui avait fait perdre un document de conception, carte `70e29bc6`. Les documents d'exploration qui vivaient dans `docs/` ont ete sortis de l'arbre au prealable, hors du depot, puisqu'etant non suivis ils n'etaient recuperables nulle part. `WORKFLOW-LOTS-DESIGN.md` n'est PAS deplace : il est gitignore par son nom, dans le bloc des notes locales, avec `BACKLOG-ORDER.md`. Dans un clone frais ces deux fichiers n'existent pas, donc la racine SUIVIE passe de 15 a 12 fichiers `.md`.

**Piege d'outillage rencontre et contourne, il vaut pour tout le depot sous Windows :** `.gitignore` est stocke avec des fins de ligne mixtes, et `sed`, `grep` comme l'outil d'edition suppriment tous les CR sous MSYS. Un retrait d'UNE ligne produisait un diff de 69 lignes. Corrige en passant par un script Python en mode binaire. Verifier `git diff --numstat` apres toute edition mecanique d'un fichier a CRLF.

## tests -- les corps d'approbation envoyes par le Deck ont enfin un temoin, et la revue par mutation a trouve deux trous qu'aucun des sept verts ne montrait

Fichiers : `tests/desktop-approval-service-project-key.test.ts`. Carte `32ce0217`.

**La carte annoncait trois appels sans temoin ; le balayage en a trouve QUATRE.** `git show 8fb9558 -- desktop/src/main/approval-service.ts` ajoute `project_key` a quatre sites, pas trois : `mintSessionToken` manquait a l'enumeration. Rappel de la lecon : une carte est une mesure DATEE, l'enumeration qu'elle porte se re-balaie au lieu de se recopier. Les quatre temoins sont prouves rouge-d'abord, chacun par retrait du champ au site correspondant, chaque mutation defaite par edition ciblee et non par `git checkout`, l'identite du fichier de production verifiee apres chaque restauration.

**Trou trouve par mutation, invisible dans le diff : un corps bien forme envoye a la MAUVAISE ROUTE passait vert.** Les deux tests preexistants de `/approval/list` n'assertaient aucune url. Remplacer `/approval/list` par `/approval/delivered` dans `fetchUndeliveredVerdicts`, puis par `/approval/claim` dans la branche expiree de `fetchPendingApprovals`, laissait sept verts sur sept ; le second mutant expediait en prime un `status:'expired_notif'` a une route destructrice. Les deux assertions manquantes sont posees et les mutations rejouees apres correctif sont bien rouges. Les assertions d'url passent de `toContain` a `endsWith` : avec `toContain`, une route renommee en sur-chaine restait verte.

**Second trou : un test qui ne mesurait rien.** Celui annonce comme garde anti-contamination entre deux `deps` n'appelait aucune fonction de production et n'inspectait jamais les appels sortants ; son unique assertion comparait deux litteraux distincts, donc aucune mutation ne pouvait le faire mordre. Instance exacte de la regle du depot : un commentaire qui AFFIRME une garantie doit etre cable a ce qui l'applique. Il appelle desormais la fonction deux fois et une mutation simulant une fuite le fait rougir.

**Ce que ce lot ne ferme pas, et qui part en cartes.** La couverture 7/7 des corps sortants est tenue A LA MAIN : un huitieme `signedPost` qui oublierait `project_key` partirait vert (carte `bc912722`, avec le piege deja nomme -- une garde naive "tout `signedPost` porte `project_key`" serait fausse, quatre routes identity sont legitimement exemptees). Cote broker, la garantie "omission du scope impossible a formuler" de `8fb9558` ne couvre que la famille scope : `/approval/token-mint` passe par `authenticateOperator`, jamais par `resolveProjectKey`, et son exigence est un `if` ecrit a la main (carte `c02fb269`).

## desktop -- creer une carte ne vous arrache plus vers son detail, et le toast qui la remplace ne peut plus deborder de la fenetre

Fichiers : `desktop/src/renderer/src/components/RoadmapView.tsx`, `desktop/src/main/i18n.ts`, `desktop/locales/en.json`, `desktop/locales/fr.json`, `desktop/src/renderer/src/styles.css`. Carte `f11e9e6a`.

**`save()` ouvrait le detail de la carte apres CHAQUE enregistrement, creation comprise.** La distinction se lisait pourtant deja dans le brouillon : `draft.id` est indefini a la creation et defini a l'edition. Une seule condition suffit donc, sans discriminant par chemin d'appel. La creation ne pose plus `setSelectedId` et rend un toast NOMINATIF qui cite le titre ; l'edition garde `setSelectedId` et son toast d'avant, octet pour octet. Le domaine a ete re-mesure plutot que repris de la carte : sur les dix appels a `roadmapUpsert` du renderer, neuf passent un `id` et sont donc des editions, un seul peut creer. La question ouverte de la carte, un toast en rafale sur creation par un AGENT, est SANS OBJET et le reste : `save()` n'est atteignable que depuis la modale de formulaire, un agent qui fiche une carte passe par le broker et ne traverse jamais ce code. Le discriminant d'origine qu'elle envisageait n'a pas ete paye.

**Le slot `toast` du store porte une cle i18n nue et n'a AUCUN canal de parametres.** Le texte nominatif est donc interpole cote appelant et envoye par le canal RAW deja existant, celui de `reportError`, plutot que d'ajouter un canal de parametres au store pour un seul consommateur. Contrepartie assumee et bornee : un changement de locale pendant les quatre secondes d'affichage ne retraduit pas ce toast-la.

**`.toast` n'avait ni largeur maximale ni retour a la ligne, et c'est ce changement-ci qui le rendait dangereux.** Tant que les toasts etaient des phrases fixes, l'absence de borne ne se voyait pas ; un toast qui cite un titre ecrit par l'operateur a une largeur variable, et avec `transform: translateX(-50%)` un toast plus large que la fenetre deborde des DEUX cotes et perd ses propres extremites. Borne posee a `min(560px, calc(100vw - 48px))`, avec `overflow-wrap: anywhere`. Ce n'est pas une correction opportuniste : sans elle, la carte introduisait le defaut.

**Verifie a l'ecran, pas seulement au typecheck.** Deck construit depuis l'arbre de travail, broker prive sur une base temporaire, instance Electron jetable pilotee en CDP. Avec un titre volontairement long : aucune modale de detail ouverte, toast replie sur deux lignes, largeur 560 dans une fenetre de 1384, entierement contenu. La carte creee reste trouvable deux fois plutot qu'une, le toast la nomme et la colonne BACKLOG la montre : ne plus ouvrir le detail ne devait pas vouloir dire disparaitre sans trace.

## repo + core + tests + docs -- quatre lots de la meme vague : `.gitignore` ancre, cadrage de reception unifie, sonde pty rendue deterministe, deux conceptions livrees sans code

Fichiers : `.gitignore`, `CLAUDE.md`, `ARCHITECTURE.md`, `desktop/src/main/team-embedded.ts`, `server.ts`, `shared/inbound-framing.ts` (nouveau), `shared/message-framing.ts`, `tests/peer-inbound-framing.test.ts` (nouveau), `tests/peer-message-framing.test.ts`, `tests/server-inbound-framing-delivery.test.ts` (nouveau), `tests/desktop-pty-coalescing.test.ts`, `tests/pty-harness/coalescing-probe.cjs`, `DESIGN-APPROVAL-SCOPE.md` (nouveau), `DESIGN-NOTIFY-DECIDER.md` (nouveau). Cartes `70e29bc6`, `e3f8065d`, `dd388182`, `63d73bde`, `1def56da`.

**La regle `.gitignore` pour `docs/` etait ecrite sans aucun slash avant la fin, donc non ancree au sens de git : elle mordait a toute profondeur et avalait aussi `desktop/docs/` pour tout nouveau fichier.** Un document de conception livre le 2026-08-17 a ete perdu ainsi, jamais commite. Correctif : `/docs/`. La ligne voisine `docs/exploration/`, deja ancree, devenait redondante et a ete supprimee. Piege documente dans `CLAUDE.md` : `git check-ignore` saute tout chemin deja suivi, donc tester une regle sur un voisin deja indexe repond toujours "not ignored" et masque le bug.

**Sept symboles de rendu quittent `server.ts`, qui n'exporte rien et lance `main()` au scope module, vers `shared/inbound-framing.ts`.** Les trois chemins de reception (poussee WebSocket, poll de secours, outil MCP `check_messages`) consomment desormais le meme enforceur ; le troisieme reimplementait le branchement en ligne. `DECK_NO_REPLY_NOTE` interdisait par ailleurs de contacter tout autre pair, alors que le texte de dispatch demande a l'agent de deleguer par `send_message` : deux constantes se contredisaient dans le meme message livre. La note adopte la semantique d'`OPERATOR_ANSWER_NOTE`. Restent, chacune avec un referent reel, l'interdiction d'accuser reception et celle de viser la sentinelle `deck`, qui n'est pas routable. Deux copies de la meme phrase dans `team-embedded.ts`, a onze lignes d'ecart, fusionnees en une constante.

**Ce que ce lot ne ferme pas :** la divergence par CLASSE d'emetteur est fermee structurellement, la divergence par CHEMIN ne l'est pas -- `renderInbound` prend deux `string` nus, rien dans les types ne distingue un texte cadre d'un texte brut. La poussee WS, chemin nominal, etait debranchable sans qu'aucun test rougisse et elle est desormais epinglee par test ; le poll de secours ne l'est pas.

**Pas de carte pour ce troisieme lot : rouge ouvert herite de la vague precedente.** Le test de coalescence pty echouait a 13-14 %, taux mesure deux fois a deux niveaux. La sonde retente desormais le seul drapeau soumis a la course, cinq essais, sortie anticipee au premier succes ; les autres verifications restent a chaque tentative sans retry -- cout 5,45 s typique, 16,27 s au pire mesure. Second defaut corrige : la sonde classait ses chunks par position dans un tableau plat, donc un seul evenement non deterministe faisait tomber les deux drapeaux et accusait a tort une phase saine. L'en-tete declare desormais que le fichier ne garde AUCUNE ligne de production : mutation faite, la ligne produit revenue a sa forme d'avant `90c2a8e` laisse le test vert. Il caracterise ConPTY ; la propriete produit est attestee ailleurs, par `desktop-inject-command-write-check` et `desktop-launch`, que l'en-tete nomme.

**Deux conceptions, aucun code.** Pour les notifications : `pending_approvals` est deja borne, donc la decision de l'operateur ajoute une cause au lieu d'inventer une borne ; le statut cible est `abandoned` et non `expired_notif`, parce que ce dernier reste reclamable par le Deck et enverrait une reponse vers un peer mort ; les interrupteurs doivent etre PLATS parce que `loadConfig` fait un spread superficiel et qu'un objet imbrique rendrait `undefined` pour un type ajoute apres coup, soit une notification muette en production et verte en test. Pour les approbations : dans `handleApprovalAdd`, `project_key` vient du corps de la requete alors qu'`operator_id` vient du credential, donc le filtre de scope porte sur une dimension declaree par la partie filtree -- portee bornee : inter-projets pour une meme personne, jamais inter-operateurs.

## desktop -- la reprise automatique de quota du Deck se desactive pour une session Claude Code sur le chemin par defaut

Fichiers : `desktop/src/main/session-kind.ts` (nouveau), `desktop/src/main/session-service.ts`, `desktop/src/shared/types.ts`, `desktop/src/renderer/src/components/Sidebar.tsx`, `desktop/src/renderer/src/components/TerminalTile.tsx` (commentaire seul), `desktop/src/main/i18n.ts`, `desktop/locales/en.json`, `desktop/locales/fr.json`, plusieurs `tests/desktop-*.test.ts`. Carte `fd1914cc`.

**Le CLI Claude Code possede desormais sa propre reprise automatique de quota** (reglage `autoContinueAtUsageLimit`, mesure a `true` par defaut en v2.1.235). La propre relance du Deck devenait alors un second relanceur, injectant dans le meme prompt que le premier.

**Pour une session Claude Code qui suit le reglage global (aucune surcharge par session), le Deck desactive maintenant ses deux moities** : il arrete d'alimenter son detecteur de quota ET d'injecter la reprise. Les autres CLIs (codex, gemini, agents personnalises) restent inchanges. Une surcharge explicite par session, posee depuis le menu contextuel de la barre laterale, l'emporte toujours et retablit les deux moities pour cette tuile.

**Le predicat qui decide si une session lance le CLI `claude`, `isClaudeLaunch` dans `session-kind.ts`, est deliberement genereux plutot qu'etroit.** Il reconnait n'importe quel jeton de la ligne de commande, pas seulement le premier, ce qui couvre `npx claude`, `wsl claude` ou `docker exec ... claude`. Un faux positif se degrade de facon VISIBLE (la tuile reste simplement arretee, l'operateur le remarque et bascule la surcharge) ; un faux negatif double l'injection en SILENCE dans un terminal actif. Le predicat penche donc du cote du faux positif.

**Le resultat est fige au demarrage du processus (spawn), jamais recalcule en direct** : changer la commande de lancement globale pendant qu'une session Claude Code tourne deja ne peut pas la faire basculer de camp sous elle-meme.

**Consequence a connaitre : sur le chemin par defaut, une tuile Claude Code n'affiche plus aucun statut de quota** (limite atteinte / heure de reprise), y compris dans la vue mobile -- c'est le prix accepte pour desactiver la detection et pas seulement l'injection.

## core -- `send_message` gagne un champ optionnel `expects_reply`, pour ne plus obliger un accuse de reception

Fichiers : `server.ts`, `shared/message-framing.ts` (nouveau), `tests/peer-message-framing.test.ts` (nouveau), `tests/broker-expects-reply-delivery.test.ts` (nouveau). Carte `3d3c7d40`. `broker.ts` n'est pas touche.

**Une vraie interaction entre deux pairs se prolongeait de deux a trois tours d'accuse de reception, chacun un tour d'inference complet a pleine longueur de contexte.** Le nouveau champ booleen optionnel `expects_reply` sur l'outil MCP `send_message` laisse l'emetteur dispenser explicitement le destinataire de cet accuse.

**Absent (ou `true`), rien ne change : le texte envoye est identique, octet pour octet, au comportement d'avant ce lot.** Passe a `false`, l'EMETTEUR (jamais le destinataire) ajoute au texte une note de code constante, `PEER_NO_REPLY_NOTE`, qui dit au destinataire qu'il peut agir sur le message mais ne doit envoyer ni confirmation, ni remerciement, ni accuse de reception.

**La composition se fait a l'emission, pas a la reception, ce qui explique que `broker.ts` et le schema de sa table `messages` restent intacts.** Le broker continue de transporter une chaine opaque, sans migration. Cela offre trois proprietes par construction plutot que par vigilance : aucune migration de schema ; une retro-compatibilite structurelle (un destinataire sur un build plus ancien recoit un texte ordinaire, puisque la note EST le texte) ; et la note atteint les trois chemins de reception du destinataire (le push WebSocket et le scrutin de repli, qui passent tous deux par `renderInbound`, et l'outil `check_messages`, qui re-implemente ce branchement separement).

**Le champ est valide par identite booleenne stricte (`expectsReply !== false`), jamais par verite (truthiness).** Un modele qui serialise ses arguments envoie parfois la chaine litterale `"false"`, que tout test de veracite lit comme VRAI -- une coercion aurait pu inverser le sens du champ dans un sens ou dans l'autre.

**La note n'est jamais appliquee quand la cible est l'operateur.** Le canal `operator` existe precisement pour recevoir une reponse humaine ; y attacher "ne repondez pas" contredirait l'objet meme du canal.

**`PEER_NO_REPLY_NOTE` est un libelle NOUVEAU, pas une reprise d'un des libelles deja livres** (`DECK_NO_REPLY_NOTE`, `OPERATOR_ANSWER_NOTE`), decision validee en revue : le candidat le plus proche, `DECK_NO_REPLY_NOTE`, interdit aussi de contacter tout autre pair, ce qui serait faux ici -- l'emetteur n'a pas a restreindre a qui le destinataire peut parler.

## desktop -- un test guard sur DOM reel prouve enfin ce que le docstring de l'emetteur du Courrier promettait

Fichiers : `tests/desktop-inbox-sender-dom.test.ts` (nouveau), `desktop/src/renderer/src/inbox-sender.ts`. Carte `5bffb7b9`.

**Le contrat de rendu de l'emetteur d'une question du Courrier n'etait garde que par un balayage de source, et ce balayage ne mordait pas.** `tests/desktop-inbox-sender.test.ts` verifiait que `InboxPanel.tsx` mentionne bien `resolveApprovalSender()` dans son texte source ; il ne verifiait jamais que ce que cette fonction renvoie finit reellement dans le DOM affiche. La mutation temoin le prouve : inserer `return res.raw || '?'` en premiere ligne du bloc `if (e.kind === 'approval')` de `senderOf()` rend tout le JSX en-dessous inatteignable, et la suite reste 12 reussites sur 12, zero echec.

**Le nouveau test monte le vrai composant et lit le DOM reel**, sur les trois formes que `senderOf()` peut produire pour un emetteur d'approbation : resolu (le nom seul, sans `<code>`), non resolu avec une valeur brute non vide (texte de repli plus la valeur brute dans un vrai element `<code>`), et non resolu avec une valeur vide (texte de repli seul, sans `<code>`). Mesure rouge sous deux mutations independantes avant d'etre livre vert.

**Le docstring de `resolveApprovalSender()` pointe desormais ce qui applique et ce qui garde son contrat**, au lieu d'affirmer une garantie sans dire ou elle est tenue : il nomme `senderOf()` dans `InboxPanel.tsx` comme seul point qui transforme l'union renvoyee en DOM, et ce nouveau test comme sa garde.

**Deux formes restent non couvertes, a dessein plutot que par oubli.** Le titre de la modale de reponse rend le meme emetteur par la meme fonction, donc seul un refactor qui les ferait diverger romprait la couverture actuelle sans qu'aucun test ne le voie. Et l'echappement HTML d'une valeur brute hostile a l'interieur du `<code>` n'est pas exerce par ce lot.

## broker + desktop -- deux fenetres du Deck sur deux depots differents ne se recoivent plus les questions bloquantes l'une de l'autre

Fichiers : `broker.ts`, `desktop/src/main/approval-runtime.ts`, `desktop/src/main/approval-service.ts`, `tests/_helper.ts`, `tests/approval-hook.test.ts`, `tests/broker-approval-reply.test.ts`, `tests/broker-approvals.test.ts`, `tests/broker-ntfy-channel.test.ts`, `tests/server-ask-operator.test.ts`. Carte `4df14b5b`.

**Le bug n'etait pas une collision, c'etait une union.** Deux fenetres du Deck ouvertes sur deux depots differents recevaient toutes les deux TOUTES les questions bloquantes des deux depots, jamais celles d'une seule au detriment de l'autre. Cause : `handleApprovalList` dans `broker.ts` ne filtrait que sur `operator_id`, avec une limite de 500 lignes. La colonne `project_key` existait deja et etait ecrite de bout en bout par plusieurs ecrivains ; personne ne la lisait pour decider quoi servir.

**`project_key` devient obligatoire sur `/approval/list`.** Absent ou vide, la requete est refusee avec un 400 et une trace ecrite (jamais servie comme une liste vide silencieuse) : le choix du refus bruyant est delibere, une liste vide muette aurait masque la panne au lieu de la signaler. Cote application, le champ rejoint le contrat de dependances du service d'approbations (`ApprovalDeps` dans `approval-service.ts`), aliment desormais par les deux consommateurs de la route : celui qui recupere les questions en attente, et celui qui recupere les verdicts non delivres. Ce second consommateur n'etait pas dans le perimetre initial du correctif et a ete trouve en phase de mesure -- sans lui, la clause obligatoire aurait fait refuser chaque scrutin de verdicts, et un verdict rendu depuis un telephone n'aurait plus jamais ete applique a une session, en silence.

**Un helper de test partage, `approvalListBody()` dans `tests/_helper.ts`, porte desormais ce champ**, plutot que de le dupliquer litteralement a chaque site d'appel des cinq fichiers de test touches.

**Deploiement : redemarrer l'application avant le broker, jamais l'inverse.** Dans cet ordre, la fenetre de risque est nulle : l'ancien broker accepte encore le champ en option. Dans l'ordre inverse, le nouveau broker refuse tous les `/approval/list` d'une application pas encore mise a jour avec un 400 trace -- la vue Courrier cesse de se rafraichir et les verdicts telephone cessent de s'appliquer -- mais rien n'est perdu et l'ajout d'approbations continue de fonctionner normalement.

## desktop (experimental) -- une tuile qui affiche un dialogue modal n'est plus tapee dedans, par aucun des gestes qui peuvent l'atteindre

Fichiers : `desktop/src/main/session-service.ts`, `desktop/src/main/agent-stop.ts`, `desktop/src/main/ipc.ts`, `desktop/src/main/screen-model.ts`, `desktop/src/main/i18n.ts`, `desktop/src/shared/types.ts`, `desktop/src/renderer/src/components/AgentStopControls.tsx`, `desktop/locales/en.json`, `desktop/locales/fr.json`, `tests/desktop-inject-command-modal-guard.test.ts`, `tests/desktop-agent-stop-visibility.test.ts`, `tests/desktop-agent-stop.test.ts`, `tests/desktop-screen-model.test.ts`, `tests/pty-harness/mini-screen.cjs`, `tests/pty-harness/replay-fixture.cjs`, `tests/pty-harness/esc-role-probe.cjs`, `tests/pty-harness/idle-redraw-probe.cjs`, `tests/pty-harness/busy-silence-probe.cjs`, `tests/pty-harness/fixtures/prompt-idle-with-esc.json`, `tests/pty-harness/fixtures/draft-typed-with-esc.json`, `tests/pty-harness/fixtures/slash-menu-with-esc.json`. Cartes `5dbf3255`, `63ca372f`, `120148eb`.

**Une tuile qui affiche un dialogue modal n'est plus tapee dedans, par aucun des trois gestes qui peuvent l'atteindre.** Une directive de commande (par exemple `/clear` ou `/compact`), un arret souple et desormais une pause refusent tous d'ecrire sur une tuile dont l'ecran ressemble a un dialogue ouvert, au lieu d'y envoyer un octet a l'aveugle -- ce refus n'existait pour AUCUN des trois avant ce lot, qui le cree en meme temps qu'il le rend visible. Ce sont deux apports distincts du meme lot, et ils meritent d'etre nommes separement : le refus lui-meme (la garde geometrique de `screen-model.ts`, deja consultee par l'injection de directive et l'arret souple, et desormais aussi par la pause), et sa VISIBILITE dans le rapport d'arret, avec son propre compte et sa propre offre d'escalade vers l'arret dur -- sans quoi un rapport d'arret montrant soudain un compte de refus resterait incomprehensible. L'arret dur, lui, reste deliberement NON garde : son contrat est de terminer la session, de force, tout de suite -- un CLI qui quitte est dans le contrat de ce mode, ce n'est pas un defaut de ce lot.

**Le discriminant modal mesure une RELATION entre deux positions, jamais la presence d'un glyphe.** Sur un ecran normal, le curseur reel se trouve exactement une ligne au-dessus du marqueur chevron du compositeur ; sur le dialogue de confiance/configuration, ce meme chevron est aussi peint, mais le curseur reel se trouve trois lignes plus bas, sur le pied de page "Enter pour confirmer, Echap pour annuler". Deux mesures de terrain ont motive une garde plutot qu'un choix entre deux gestes candidats : un Echap nu envoye sur ce dialogue fait QUITTER le CLI ; un collage sans Echap sur ce meme dialogue CONFIRME l'option deja selectionnee, au nom de l'operateur. Les deux gestes sont destructeurs, dans des directions differentes -- deviner lequel serait le plus sur n'est pas une option, d'ou un refus plutot qu'un arbitrage.

**La grille qui lit l'ecran a une asymetrie de cout, et l'ancien defaut etait du mauvais cote.** L'adressage utilise par le CLI pour positionner le curseur est absolu : une grille PLUS GRANDE que le terminal reel preserve la geometrie exactement, une grille plus petite la detruit DEFINITIVEMENT -- une fois qu'une coordonnee tombe hors grille, chaque futur positionnement vers elle se fige sur la meme case fausse. L'ancien defaut, 120 colonnes sur 40 lignes, rendait ce cas frequent et non exceptionnel : toute tuile de plus de 40 lignes, c'est-a-dire une fenetre du Deck maximisee a police normale, refusait TOUTE injection a vie, en donnant a l'operateur une explication FAUSSE (son ecran ressemblait a un dialogue ouvert alors qu'il ne l'etait pas). Le defaut est desormais volontairement demesure, et la grille suit maintenant le redimensionnement reel de chaque tuile au lieu de rester figee au demarrage.

**Une mesure anterieure tenue pour acquise sur ce depot est REFUTEE, et il faut le dire franchement plutot que la laisser se perimer en silence.** Elle affirmait que le CLI redessine sa ligne d'activite par un repaint partiel meme au repos -- une hypothese qui, si elle avait tenu, aurait permis un filet de securite bon marche fonde sur le silence prolonge. Deux sondes de terrain, `tests/pty-harness/idle-redraw-probe.cjs` et `tests/pty-harness/busy-silence-probe.cjs`, la contredisent sur le binaire installe (Claude Code 2.1.233) : zero octet ecrit en 180 secondes au repos, contre un ecart maximal de 1,16 seconde pendant un tour occupe, soit un facteur d'environ 150. C'est un fait de VERSION et non une simple formulation : il ne peut donc pas pourrir en silence dans un commentaire, il doit etre RE-MESURE a chaque bascule du binaire installe, qui se met a jour automatiquement chaque jour.

**Ce lot livre UNE garde sur les NEUF que compte la carte `63ca372f`, et il faut le dire pour ne pas laisser croire le chantier clos.** Restent non livrees : le refus du picker slash nu, le refus du brouillon de l'operateur (aujourd'hui explicitement NON bloquant), la deduplication par id, un cooldown par agent, une chaine mono-ecrivain qui protegerait TOUS les ecrivains d'un meme octet destructeur sur une meme tuile et non seulement l'injection et l'interruption, le collage conditionnel au mode bracketed-paste, un accuse de reception avec retries bornes et un abandon trace, une grace de demarrage, et un filet de quiescence. Ce dernier est desormais DEBLOQUE par la mesure du paragraphe precedent : le rapport zero-octet-au-repos etablit qu'un seuil de silence est un signal honnete d'inactivite sur ce binaire, ce qui n'etait pas acquis avant la mesure.

Cartes `5dbf3255` et `120148eb` fermees par ce lot. Carte `63ca372f` AVANCEE, non close.

## desktop + broker (experimental) -- une question bloquante sans emetteur devient une tuile resolue ou un repli visible, jamais un point d'interrogation

Fichiers : `desktop/src/main/approval-runtime.ts`, `desktop/src/renderer/src/inbox-sender.ts`, `desktop/src/renderer/src/components/InboxPanel.tsx`, `broker.ts`, `desktop/src/main/i18n.ts`, `desktop/locales/en.json`, `desktop/locales/fr.json`. Carte `55c5470e`.

**Ce n'etait pas intermittent.** L'operateur signalait deux occurrences observees, en pensant a un defaut occasionnel. La cause etait structurelle : cent pour cent des questions bloquantes issues du hook Notification de Claude Code affichaient un sender "?", depuis l'introduction du credential de session, sur toute fenetre du Deck. Le meme rapport notait aussi le libelle brut du hook affiche comme contenu de la question -- ce lot ne touche pas ce second symptome (le texte de la question elle-meme reste celui du hook), seul l'emetteur est corrige ici.

**Une question sans emetteur est pire qu'une autre entree mal formee : elle est inactionnable par construction.** Une question bloquante ne peut etre ni acquittee ni ignoree, seulement repondue ou declinee : c'est le seul type d'entree du Courrier qui force une reponse. Sans savoir qui la pose, l'operateur ne peut pas savoir quelle tuile debloquer.

**Le credential de session est UN PAR FENETRE, jamais par tuile, et cette portee dicte ou chaque champ doit vivre.** Y ecrire un emetteur a l'ecriture du credential aurait cree un singleton keye par trop peu : une fenetre porte plusieurs tuiles, la premiere valeur ecrite mentirait sur toutes les autres. La cle de projet, elle, est reellement une propriete de fenetre : elle se pose desormais a la source, au moment ou le credential est ecrit. L'emetteur, lui, ne se pose jamais a la source : il se RESOUT, au moment d'afficher chaque question, contre les tuiles que le Deck tient reellement en vie a cet instant precis. On resout l'objet, la tuile, avant de se demander a qui elle appartient.

**Le repli est desormais explicitement non fiable, jamais confondu avec un nom resolu.** L'identifiant de tuile transmis par le hook est une metadonnee qui vient d'un agent spawn, donc non fiable par nature : un agent pourrait y placer un texte concu pour se lire comme un nom de tuile legitime. Ce n'est jamais affiche comme tel. Une tuile introuvable produit un repli visiblement marque "non resolu", borne en longueur et nettoye de ses caracteres de mise en forme, parce que laisser un agent choisir le texte qui s'affiche comme emetteur d'une question a laquelle l'operateur est force de repondre serait le pire mode de defaillance possible ici.

**Une route qui ne journalise que son cas d'erreur est aveugle exactement quand on en a besoin.** Le broker ne journalisait jusqu'ici que la reutilisation d'une question deja en attente pour une meme tuile, jamais l'ajout nominal d'une question neuve. C'est precisement ce qui a rendu les deux occurrences signalees introuvables par horodatage dans les journaux : la route existait, mais son chemin normal ne laissait aucune trace.

**Une piste a ete ecartee : resoudre l'emetteur via le peer_id claude-peers.** Elle aurait exige un canal de communication entierement neuf entre l'agent et le Deck, mesure absent du code existant a trois endroits distincts. La tuile locale du Deck, deja transmise et deja re-validee au moment de repondre, suffisait.

## desktop (experimental) -- le code lu dans le Deck est enfin colore, dans l'explorateur comme dans les diffs

Fichiers : `desktop/src/shared/code-lang.ts`, `desktop/src/renderer/src/highlight.ts`, `desktop/src/renderer/src/components/CodeTokens.tsx`, `desktop/src/renderer/src/components/ExplorerView.tsx`, `desktop/src/renderer/src/components/DiffPanel.tsx`, `desktop/src/renderer/src/styles.css`, `desktop/package.json`, `tests/desktop-code-lang.test.ts`, `tests/desktop-explorer-selection-dom.test.ts`, `tests/desktop-happy-dom-teardown.test.ts`, `tests/happy-dom-restore-probe.ts`, `tests/desktop-tile-area.test.ts`, `DESIGN.md`

**Les deux surfaces de lecture de code du Deck sont colorees, en lecture seule.** Ouvrir un fichier dans l'explorateur affichait jusqu'ici du texte brut aligne sur une gouttiere de numeros de ligne ; il est desormais colore par grammaire, avec la gouttiere, la selection et les gestes Expliquer et Creer une tache inchanges. Dans les diffs, la structure ajout et retrait etait la seule couleur presente et le code restait en noir et blanc ; desormais les deux couches coexistent, le marqueur plus ou moins et le fond teinte continuent de dire ce qui change pendant que le code apres le marqueur porte les couleurs de sa langue. La langue suit le fichier du hunk, donc un diff multi-fichiers colore chaque section avec la bonne grammaire. Vingt-huit langages sont couverts, choisis sur le recensement reel des extensions du depot complete des langages courants ; tout le reste retombe proprement en texte brut, comme avant. Carte `526665f7`.

**Le choix d'integration a ete arbitre au chiffre, pas a l'impression, et le chiffre reserve une surprise.** L'import complet de Shiki emet 10 105 784 octets sur 389 chunks ; le chemin fine-grained retenu, c'est-a-dire le coeur, le moteur d'expressions regulieres JavaScript, deux themes et les grammaires en imports dynamiques litteraux, en emet 2 490 746 sur 43. Soit 7 615 038 octets de moins, environ 75 pour cent. Le detail contre-intuitif merite d'etre retenu pour les prochains arbitrages de ce genre : le chunk d'ENTREE de l'import complet est plus PETIT que celui du fine-grained, 143 052 octets contre 185 124, parce que le premier differe aussi le chargement de ses themes la ou le second les paie une fois au demarrage. Qui arbitre sur le seul poids d'entree choisit donc l'option qui pese trois fois plus sur le disque. Chaque grammaire est un chunk separe, charge au premier fichier de ce langage et jamais avant.

**La bascule clair vers sombre ne recalcule rien.** Shiki tokenise une fois et emet les deux themes d'un coup : la couleur claire en style en ligne sur le jeton, la couleur sombre dans une propriete personnalisee que la feuille de style echange selon le theme. La mesure faite sur l'application lancee est sans ambiguite : sur le meme noeud, 23 502 spans avant et 23 502 apres, seule la couleur calculee change, de rgb(106, 153, 85) a rgb(0, 128, 0), sur le seul changement d'attribut de theme. Aucune retokenisation, aucun second moteur, aucun clignotement. Consequence a connaitre avant de toucher a cette regle : son mot-cle important est porteur, un style en ligne bat n'importe quel selecteur, c'est le seul moyen pour la variante sombre de gagner.

**Une contrainte de rendu peu evidente est desormais gardee par un test, et non par un commentaire.** L'explorateur deduit la plage de lignes selectionnee du texte du Range, qui concatene les noeuds texte et ne synthetise rien pour une frontiere de bloc. Les sauts de ligne doivent donc rester de vrais noeuds texte entre les jetons. Rendre une balise de bloc par ligne, qui est le refactor naturel et la forme qu'utilise le reste de l'application, ferait disparaitre silencieusement chaque saut de ligne d'une selection : lignes 3 a 4 deviendrait lignes 3 a 3, sans erreur nulle part, avec la compilation, le build et tous les autres tests au vert. Le nouveau test rejoue le geste complet sur un DOM reel et sa morsure a ete prouvee par mutation avant livraison : le rendu par blocs fait rougir trois tests sur trois, dont celui qui montre le Range rendant une ligne au lieu de deux. La mutation a ete restauree.

**Trois limites sont assumees et ecrites sur place.** Le garde de couverture des langages balaye CE depot, alors que l'explorateur ouvre des worktrees et des repertoires de session arbitraires : il mesure un proxy du domaine, pas le domaine, et l'affirme dans son propre commentaire ; ce qu'il achete reste reel, le jour ou ce projet accueille un langage non cartographie l'echec est bruyant au lieu d'un viewer silencieusement gris. La vraie garde fermee est ailleurs, dans le typage de la table de grammaires, ou un langage sans grammaire ne compile pas. Le budget de tokenisation est un plafond de caracteres par requete et non un budget de temps, parce que la tokenisation est synchrone et ne peut pas etre interrompue en cours ; au-dela du plafond les deux surfaces gardent le texte brut. Enfin le garde de selection couvre la structure de rendu, pas le choix du composant : recabler l'affichage sur autre chose lui echappe par construction.

**Le controle final a trouve un defaut de ce lot, et il ne rougissait aucun fichier de ce lot.** `tests/desktop-explorer-selection-dom.test.ts` monte un DOM happy-dom pour rejouer le geste de selection, et il appelait `GlobalRegistrator.register()` sans jamais defaire. Bun executant tous les fichiers de test dans UN SEUL processus, `globalThis.fetch` restait celui de happy-dom pour tout le reste de la suite, et ce fetch la applique la politique de meme origine, ce que le fetch natif de Bun ne fait pas. Chaque suite ulterieure parlant a un serveur qu'elle venait de lancer sur 127.0.0.1 etait donc refusee en Cross-Origin Request Blocked, puis expirait a 30 ou 60 secondes. La suite complete passait de 1 echec en 166 secondes a 19 echecs, 11 erreurs et 961 secondes, avec 20 404 lignes de refus d'origine. Le cout reel de ce defaut n'est pas la panne, c'est l'ATTRIBUTION : aucun des 18 echecs supplementaires n'etait dans un fichier que la vague avait touche, ils etaient tous dans la famille qui lance son propre serveur, et le tally etait reproductible a l'octet pres sur trois executions, ce qui les a fait imputer a des serveurs MCP vivants pendant trois controles. Ce qui a tranche est une comparaison a trois points et non une lecture de code : HEAD dans un arbre de travail propre rend 1931 reussites pour 1 echec en 166 secondes, les 169 fichiers d'avant la vague rejoues sur l'arbre COURANT rendent 1935 pour 2 en 163 secondes, ce qui disculpe le code produit, et la suite complete rend 1989 pour 19 en 961 secondes. Le defaut se reproduit sur DEUX fichiers isoles : ce test plus `tests/server-ask-operator.test.ts` donnent 5 echecs, 4 erreurs et 7 109 lignes de refus en 300 secondes sans le teardown, contre 10 reussites, zero refus et 3,6 secondes avec.

**Le precedent existait, documente au long, et il a ete copie a moitie.** `tests/desktop-tile-area.test.ts` prend un instantane des descripteurs de `globalThis` avant d'enregistrer happy-dom puis les restaure tous sauf neuf noms lies au dispatch d'evenements, et son commentaire nomme explicitement le risque pour les suites broker. Le nouveau test avait repris de lui la forme du pont React et ses imports dynamiques, mais pas cette restauration. Le correctif retenu est l'API `unregister()` de la bibliotheque, attendue, qui rend les globals a la SORTIE du fichier.

**Cette restauration de globals ne rendait pas le SLOT, et la CI l'a montre en echouant sur un ordre d'execution different.** Le registrator garde un drapeau interne : tant qu'il vaut vrai, tout autre `register()` leve "Happy DOM has already been globally registered". Restaurer les descripteurs a la main rend les globals mais pas ce drapeau, donc `tests/desktop-tile-area.test.ts` gardait le verrou jusqu'a la fin du processus. Invisible tant que l'ordre etait alphabetique, ce qui le faisait passer apres les deux autres fichiers montant un DOM. La CI ne trie pas pareil : ordre releve dans son journal, desktop-journal, desktop-tile-area, desktop-graph-adapters, desktop-digest, contre un ordre strictement alphabetique en local. tile-area y passant en deuxieme, il faisait echouer AU CHARGEMENT `tests/desktop-explorer-selection-dom.test.ts` et la garde elle-meme, alors que la commande de la CI rejouee en local rendait zero conflit. La lecon de forme depasse happy-dom et est ecrite sur place : L'ORDRE D'EXECUTION DES FICHIERS DE TEST N'EST PAS GARANTI, et toute propriete qui tient parce qu'un fichier passe avant un autre tient par accident.

**La garde a ete resserree en consequence, et sa sonde comportementale sortie du processus partage.** Le parcours n'accepte plus la restauration de descripteurs comme teardown, puisqu'elle ne rend pas le slot : le seul marqueur admis est `unregister(`, exige de tout fichier `.ts` du repertoire de tests et non des seuls `.test.ts`, un helper partage prenant le slot exactement pareil. Surtout, la sonde qui verifie l'EFFET, a savoir que `register()` remplace reellement `globalThis.fetch` avant que `unregister()` le rende, vit desormais dans `tests/happy-dom-restore-probe.ts` et tourne dans un processus bun NEUF, avec des codes de sortie distincts par mode d'echec. La premiere version de cette sonde affirmait `isRegistered === false` au demarrage, ce qui est precisement une hypothese sur l'ordre : elle passait en local et rougissait en CI. Dans un processus neuf, l'etat de depart est connu. Morsure des deux moities prouvee par reproduction avant correctif : un fichier temporaire triant avant les autres et enregistrant sans rendre le slot faisait 4 conflits, 4 echecs et 2 erreurs ; le meme fichier rendant le slot donne 23 reussites, zero conflit et zero refus d'origine.

## broker (experimental) -- la lecture du Courrier operateur cesse d'etre destructive

Fichiers : `broker.ts`, `tests/broker-operator-inbox.test.ts`. Le mecanisme
de lecture non destructive (curseur par session, cle primaire composite,
branchement retro-compatible) porte la carte `54b1c71a` ; la route de purge
et les deux correctifs de securite qui l'accompagnent portent, d'apres les
commentaires du code lui-meme, la carte `1e81ee7b` (son volet broker) --
les deux avancent dans le meme commit, sur les memes tables.

**Le drain n'efface plus le courrier d'un autre Deck.** Avant ce lot,
`/operator-inbox` selectionnait par jeton de destinataire et identifiant de
groupe SEULEMENT, puis marquait tout comme delivre : avec deux Deck ouverts
sur le meme groupe, le premier a interroger mangeait tout, sans que rien ne
le signale. Une nouvelle table `operator_inbox_sessions` porte desormais un
curseur de lecture PAR SESSION de Deck (cle primaire composite identifiant
de session + identifiant de groupe). Le champ d'identifiant de session est
OPTIONNEL sur la route de drain : absent, le comportement legacy est
STRICTEMENT inchange, ce qui preserve la compatibilite avec un broker
partage interroge par un Deck plus ancien, ou par un simple appelant
`send_message`. Un identifiant de session d'un type autre que chaine est
desormais refuse explicitement (erreur), plutot que de retomber
SILENCIEUSEMENT sur le comportement destructif legacy.

**Une nouvelle route de purge, a deux portees.** La portee session fait
d'abord avancer le curseur de l'appelant jusqu'au dernier message connu du
groupe, puis supprime tout ce qui est en-dessous du curseur le PLUS BAS
parmi les sessions VIVANTES du groupe : elle ne peut donc jamais manger le
non-lu d'un autre Deck. La portee "ids" est une suppression immediate et
ciblee, independante de tout curseur ; une liste d'identifiants non vide
mais sans aucun entier est desormais refusee (erreur explicite) au lieu de
rendre un succes vide indiscernable d'un "deja supprime".

**Deux correctifs de securite**, la partie la plus importante de ce lot.
D'abord : un detenteur du secret d'un groupe A pouvait, en nommant
simplement l'identifiant de session d'un groupe B, faire avancer
DEFINITIVEMENT et SILENCIEUSEMENT le curseur de lecture de ce groupe B --
et donc rendre aveugle sa session Deck a son propre courrier non lu --
parce que les deux instructions SQL qui deplacent un curseur ne portaient
pas l'identifiant de groupe dans leur clause de restriction, alors que les
identifiants de message vivent dans un espace numerique GLOBAL unique.
Ensuite : le ramasse-miettes qui reap les sessions mortes avant de calculer
le plancher de purge n'avait, lui, AUCUNE cle de groupe -- il supprimait
donc dans TOUS les groupes a la fois -- et il etait atteignable SANS AUCUNE
PREUVE d'appartenance a un groupe existant, parce qu'un secret de groupe
valide pour un groupe JAMAIS VU est accepte par construction (le modele
TOFU du broker autorise une action DANS un groupe, il n'atteste jamais que
ce groupe EXISTE). Les deux instructions portent maintenant l'identifiant
de groupe dans leur clause de restriction, et la route de purge refuse
d'agir sur un groupe qui ne s'est jamais enregistre.

**La regle generale qui en decoule**, pour tout futur contributeur : toute
route qui INSERE une ligne portant un identifiant de groupe fourni par
l'appelant, ou qui SUPPRIME sans identifiant de groupe dans sa clause de
restriction, doit apporter sa PROPRE preuve que ce groupe existe. Les
routes anterieures a ce lot sont sures STRUCTURELLEMENT et non par
vigilance : toutes leurs ecritures sont derriere une lecture deja
restreinte au groupe, sur des tables qu'un groupe inexistant ne peut pas
peupler.

**Le delai de peremption des sessions mortes passe de 5 minutes a 24
heures.** Cinq minutes reapait un Deck simplement ENDORMI (veille,
suspension) comme s'il etait mort, lui faisant perdre son propre curseur
et donc son propre non-lu au reveil.

## desktop (experimental) -- le Courrier vit desormais le temps d'une session du Deck, et l'autorisation atteint enfin l'agent

Deux cartes avancees dans un seul commit, parce qu'elles touchent les memes
fichiers aux memes endroits : `c7df3781` (un bug visible d'autorisation) et
`1e81ee7b` (volet Deck du meme lot Courrier que l'entree broker ci-dessus).
Fichiers principaux : `desktop/src/main/index.ts`, `desktop/src/main/ipc.ts`,
`desktop/src/main/inbox-session.ts` (nouveau), `desktop/src/main/inbox-store.ts`,
`desktop/src/renderer/src/components/InboxPanel.tsx`,
`desktop/src/renderer/src/components/approval-verdict.ts` (nouveau).

**Un bug visible corrige : autoriser ou refuser une approbation depuis le
Courrier n'atteignait pas la tuile de l'agent**, qui continuait d'attendre
une validation deja donnee du point de vue de l'operateur. Cause reelle :
le Courrier routait TOUT clic d'option comme du TEXTE LIBRE -- un clic sur
l'option d'autorisation tapait litteralement le mot "Allow" dans le
terminal, la ou le menu interactif du CLI attend une simple validation de
touche. Le bouton de refus dedie etait le seul controle correct de la
modale. Un module pur (`approval-verdict.ts`) decide desormais du type de
verdict a partir du GENRE de l'approbation (`permission` contre
`question`), jamais de l'etiquette de son bouton -- une etiquette en
anglais n'est pas un identifiant de verdict stable. Les questions posees
par un agent (`ask_operator`) gardent le comportement texte, qui est
CORRECT pour elles : leur reponse repart en message vers l'agent et n'est
jamais tapee dans un terminal ; un correctif uniforme les aurait cassees.

**Le Courrier vit desormais le temps d'une session du Deck.** Un
identifiant de session est mint EN MEMOIRE au demarrage et jamais persiste
sur disque -- le persister collisionnerait entre deux fenetres du meme
compte ouvrant le meme Deck, un cas nominal ici -- et il est REMINT a
chaque changement de groupe actif, parce que le curseur cote broker ne
migre jamais son groupe sur un identifiant de session reutilise. La purge
est cablee sur les TROIS gestes qui remettent le plan de travail a zero :
nouveau plan de travail, restauration reussie d'un plan de travail, et
application d'un modele en mode remplacement -- ce troisieme chemin avait
ete oublie de l'enonce de conception initial et a du etre retrouve
separement. Le journal local est tronque au MEME instant que la purge
distante cote broker, y compris quand l'appel broker echoue : sauter l'une
des deux moities laisse le defaut lisible comme non corrige, soit par des
entrees mortes qui restent a l'ecran, soit par un broker qui continue de
grossir pour d'autres Deck ayant deja lu au-dela.

**Une suppression manuelle**, troisieme etat distinct de Fermer (laisse
l'entree, le non-lu reste non-lu) et d'Acquitter (un simple drapeau d'etat
local, ne supprime jamais rien) : restreinte aux messages d'un pair
uniquement -- une question bloquante ne peut pas etre supprimee sous
l'agent qui l'attend, et cette restriction est garantie par le TYPE des
entrees plutot que par une garde d'execution.

**Le prix assume, et sa raison** : un message envoye pendant que le Deck
etait FERME ne sera pas affiche. Ce n'est pas considere comme une perte,
parce que les agents ne vivent pas en arriere-plan mais AVEC le Deck : si
le Deck meurt, les sessions meurent avec lui, donc une reponse tardive
n'aurait de toute facon jamais atteint son emetteur -- et apres redemarrage
elle aurait meme ete reattribuee au mauvais destinataire, puisque
l'identifiant de session change a chaque lancement.

**Les gardes ajoutees sont le vrai livrable de ce second volet.** Un test
scanne le code source de `ipc.ts` pour DECOUVRIR tout gestionnaire qui
remet le plan de travail a zero et exige qu'il appelle la purge -- le
domaine est trouve par balayage du fichier reel, jamais liste en dur,
sans quoi il serait aveugle par construction au prochain chemin de reset
ajoute. La logique de session et de purge a par ailleurs ete extraite dans
des modules purs (`inbox-session.ts`) pour devenir testable sous Bun sans
dependre d'Electron.

## desktop (experimental) -- le repertoire de lancement du sandbox cesse d'etre partage entre projets

Carte `e35b2791`. Ce lot prolonge celui juste dessous (commit `18aebc4`,
cartes `6e3863ef` et `9e529177`), qui avait ferme l'evasion du sandbox vers
l'HOTE : celui-ci ferme l'evasion entre CONTENEURS d'un meme operateur.

**L'evasion cross-projet fermee.** Le repertoire de lancement (`/kory-run`,
qui porte `cmd-<sessionId>.sh`, le script que le pty execute via `docker exec`)
n'etait keye par rien, alors que le repertoire de copie voisin, `sandbox-copies`,
inclut deja le nom du conteneur. Il existait donc UN SEUL repertoire pour
toutes les sessions et tous les projets sandboxes d'un operateur, bind-monte
en LECTURE-ECRITURE dans CHAQUE conteneur. Comme tous les conteneurs tournent
sous le meme utilisateur, un agent sandboxe compromis pouvait reecrire le
script de lancement d'une session d'un AUTRE PROJET et obtenir l'execution de
code dans son conteneur au prochain demarrage. Le repertoire du back-channel
des pairs portait la meme construction, avec un vecteur moindre puisqu'il ne
porte que de la donnee, jamais un script execute. Les deux repertoires sont
desormais keyes par le nom du conteneur, sur le modele deja correct de
`sandbox-copies`.

**L'asymetrie de purge est un choix, pas un oubli.** Les deux repertoires
nouvellement keyes sont purges a la suppression ou au rebuild de leur
conteneur -- leur contenu se regenere sans cout (script rejoue a chaque
demarrage, cache pairs repeuple a la connexion). Le repertoire de copie,
lui, n'est jamais purge par ce geste : le clone y est conserve EXPRES pour
eviter un re-clone au conteneur suivant. Purger les deux de la meme facon
serait une regression deguisee en durcissement.

**La purge elle-meme est fail-closed.** Une suppression ou un rebuild peut
viser le conteneur d'un AUTRE projet, dont une autre fenetre du Deck peut
faire tourner une session en ce moment meme -- le Deck n'a pas de verrou
d'instance unique, donc deux fenetres sur deux projets sont deux processus
qui partagent le meme repertoire de donnees applicatives. Le conteneur est
supprime dans tous les cas ; seule la purge du repertoire est conditionnee
a ce que le conteneur ne tournait pas au moment de l'action.

**Le signal de rebuild porte desormais sa raison.** Un conteneur cree avant
ce correctif garde son ancien montage partage jusqu'a un rebuild explicite.
La vue Docker le detecte et affiche desormais deux lignes distinctes selon
la cause -- protection binds manquants (`missing-protection-binds`, deja
existant) et repertoire de lancement partage (`shared-run-dir`, nouveau) --
jamais fondues en un message generique : un operateur lisant le libelle de
protection pendant un incident de partage cross-projet le classerait a tort
dans le confort plutot que dans l'incident de securite.

**La detection contourne un piege mesure sur les representations de
chemin.** La destination du bind ne change pas entre l'ancien et le nouveau
montage, seule la source change, et le meme `docker inspect` peut rendre
DEUX representations differentes du meme chemin dans UN SEUL appel (une
forme `C:\...` et une forme `/run/desktop/mnt/host/c/...`, mesure sur Docker
Desktop Windows, 2026-08-14). Une egalite de chemin est donc impossible ; la
detection teste que la source CONTIENT le nom du conteneur, un jeton
hexadecimal sans separateur qui survit a l'identique dans les deux
representations.

## desktop (experimental) -- le mode mount protege son propre projet, et le preavis atteint l'agent avant son premier prompt

Deux cartes livrees ensemble, `6e3863ef` (sous-politique de protection du
montage) et `9e529177` (audit securite + preavis lisible) : poser une garde
sans retour lisible aurait produit un agent qui perd son temps a contourner un
`EPERM` muet, et un operateur recevant un rapport de protection faux.

**L'evasion fermee.** En mode mount (le mode par defaut), le projet de
l'operateur etait monte en lecture-ecriture sans aucune sous-politique : un
agent sandboxe pouvait ecrire `.git/hooks/pre-commit`, `.mcp.json` ou
`.claude/settings.json`, executes ou fait confiance par l'HOTE au prochain
commit ou a la prochaine ouverture du projet. La liste des chemins desormais
proteges recoit un bind `:ro` imbrique par-dessus le montage read-write ;
`.git/hooks`, `.claude/agents`, `.vscode`, `.idea` (entre autres repertoires)
sont montes en lecture seule de facon INCONDITIONNELLE -- Docker fabrique les
niveaux intermediaires manquants, donc un bind repertoire ne devient jamais
fail-open quand la liste grandit -- tandis que les fichiers (`.mcp.json`,
`.git/config`, `.gitmodules`...) ne le sont que s'ils existent deja comme
fichier, un bind sur un fichier absent fabriquant sinon un repertoire
parasite dans le projet reel de l'operateur.

**Le preavis est predictif, jamais reactif.** Rien cote hote ne peut observer
un refus subi a l'interieur du conteneur, donc l'agent recoit la liste des
chemins proteges (jamais celle des chemins sautes -- asymetrie deliberee :
notre doctrine suppose l'agent compromis, une carte des trous ne lui sert a
rien et sert beaucoup a un attaquant) AVANT son premier prompt, via un fichier
de prompt compose. Le preavis nomme explicitement la consequence la plus
frequente : `.git/config` en lecture seule casse `git push -u origin
<branche>` et `git remote add`.

**Un bug exhume au passage.** Le flag `--append-system-prompt-file` traversait
`wrap()` intact en portant un chemin HOTE que le conteneur ne peut pas ouvrir :
un role d'equipe embarque et sandboxe (`deck-control.ts`) tournait donc sans
son ancrage de role, sans que rien ne le signale. La composition du prompt et
du preavis en UN seul fichier (le flag est singulier) corrige ce bug au
passage.

**Trois durcissements issus de l'audit de securite (carte `9e529177`) :**
controle de containment (`isWithinDir`, symlinks inclus) avant toute lecture
du fichier de prompt hote -- ce chemin devient un vecteur d'exfiltration
potentiel des lors que `wrap()` en lit desormais le contenu ; inversion du
defaut de `parseMounts`, qui coercait silencieusement toute valeur non
booleenne (chaine, champ absent) vers "protege" au lieu de "lecture-ecriture",
un fail-open qui aurait supprime le signal de rebuild sur un bind pourtant
inscriptible ; et validation de forme du `sessionId` avant son interpolation
dans une ligne de commande, en defense en profondeur.

**Les conteneurs deja en vol** crees avant cette sous-politique ne portent
aucun bind de protection et le restent jusqu'a un rebuild explicite -- la vue
Docker le detecte et le signale.

## desktop + broker (experimental) -- le pair declare un BESOIN, plus jamais un transport : `ask_operator` cesse de refuser, et le Courrier devient l'outil qui traite

Deux cartes formant un lot indissociable : `469f3176` (`ask_operator` devient la
voie unique de question bloquante) et `8fdac3dd` (refonte du Courrier : liste
pair/heure/chevron, modale, Ack distinct de la fermeture). Elles partagent le
chemin de reponse vers le pair et la semantique de drain ; les traiter separement
aurait fait ecrire deux fois la meme plomberie.

**Le gate etait a l'envers.** `ask_operator` refusait avec « Remote approvals
are not enabled for this session » precisement quand il n'y avait PAS de canal
distant, c'est-a-dire dans le cas le plus favorable : l'operateur devant son
ecran. L'absence de mobile doit DEGRADER vers le Courrier local, jamais refuser.
L'axe retenu est BLOQUANT contre NON BLOQUANT, jamais local contre mobile : le
pair declare qu'il a besoin de l'humain, Kory seul decide ou la question
s'affiche et si elle part sur un telephone. `send_message('operator')` est
conserve tel quel comme voie non bloquante, par decision explicite.

**Le verrou n'etait pas une architecture, c'etait un `if`.** Le broker acceptait
deja un claim signe operateur sans aucun mobile (`/approval/claim` exige
`auth.kind === 'operator'` verifie contre `approval_operators`, sans secret de
groupe ni canal distant), et `SESSION_ALLOWED` autorisait deja `add`+`wait` pour
une identite de session. Le seul blocage etait
`if (config.mobileApprovals) { approvals.arm() }` dans le demarrage du Deck :
`arm()` est le seul endroit qui pose l'identite, dont depend `deps()`, dont
depend tout claim local. `mobileApprovals` redevient donc ce qu'il aurait
toujours du etre, un choix de TRANSPORT duplique, et cesse d'etre une condition
d'EXISTENCE. L'armement est extrait dans `armApprovalsAtStartup(approvals)`,
dont la signature ne prend aucun parametre de forme `mobileApprovals` : la
signature ne peut plus porter la condition. Il reste UN site d'appel dans le
demarrage du Deck ou un `if` enveloppant la rebrancherait, garde par un scan de
texte dont la portee est de 200 caracteres -- residu connu, mesure, et accepte
comme tel.

**Et l'armement inconditionnel a d'abord ouvert un trou avant de le fermer.**
Rendre l'armement systematique a mis un chemin de regeneration d'identite sur le
demarrage de TOUT operateur, y compris ceux qui n'ont jamais active la moindre
notification mobile. Une identite illisible n'est donc regeneree QUE si le
trousseau repond ; s'il est seulement indisponible -- session verrouillee, DPAPI
en vrac, profil OS migre -- l'armement abandonne ce run et l'identite reste
intacte, car un `null` de dechiffrement ne prouve pas une corruption. Et toute
regeneration renomme d'abord l'ancien fichier en `.bak-<horodatage>`, avec un
suffixe incremente qui rend la collision impossible plutot qu'improbable : la
cle privee precedente n'est jamais detruite. Sans quoi une indisponibilite
passagere du trousseau aurait suffi a orpheliner les appairages telephone et a
rendre non reclamables les questions bloquantes en attente -- des agents arretes
pour de bon, par le lot cense les debloquer.

**Deux stocks separes, fusionnes seulement a l'ecran.** Les questions bloquantes
vivent dans `pending_approvals` (table persistee, correlation par UUID,
`reply_route`/`reply_token` deja cables vers le pair exact) ; le Courrier vit
dans `messages` via `/operator-inbox`. Ils ne se croisent jamais. La fusion est
purement visuelle, ce qui evite toute migration de schema et decouple la voie
bloquante du drain destructif de l'inbox -- defaut reel, preexistant, laisse
hors perimetre et carde a part (`54b1c71a`).

**Trois familles d'entrees, et Ack n'a pas le meme sens sur les trois.** Message
d'un pair (repondable, non correle, reponse par `inboxReply`), evenement sans
destinataire (non repondable, aucun champ de reponse affiche), et question
bloquante (repondable ET correlee, sa reponse debloque un agent arrete). Sur
cette derniere, **Ack est absent, pas grise** : `AckableInboxEntry` l'exclut a
la compilation, parce qu'acquitter une question bloquante laisserait un agent
en attente indefinie. Le geste equivalent est DECLINER, qui est une reponse :
il resout le ticket et signifie a l'agent qu'il n'aura rien. Un message dont le
pair emetteur a disparu est acquittable mais pas repondable.

**Fermer n'acquitte pas**, et les trois etats (non lu / vu en attente /
acquitte) sont persistes cote Deck, donc verifiables apres un redemarrage : si
la fermeture acquittait, l'operateur perdrait tout message ouvert sans avoir le
temps de le traiter, et le bouton Ack n'aurait aucune raison d'exister. La cle
d'ack porte l'horodatage et pas seulement l'identifiant broker, pour qu'une base
recreee ne fasse pas masquer un message neuf par un ack ancien.

**Le badge du rail cesse d'etre un compteur de session.** Il derive desormais de
l'etat persiste, via un producteur unique que les deux barres APPELLENT au lieu
de resommer chacune de leur cote : il n'y a plus qu'UN SEUL endroit ou lire le
compte. Consequence directe et voulue : ouvrir
le volet ne remet plus rien a zero, une entree quitte le badge quand elle est
ACQUITTEE, et dix entrees non lues en base donnent bien un badge non nul au
demarrage a froid, la ou l'ancien compteur affichait zero. Dans le meme esprit
que « fermer n'acquitte pas » : ouvrir non plus. Un futur « tout marquer comme
lu » devra etre un acquittement de masse explicite, jamais un effet de bord de
l'ouverture.

**Et le passe a du etre repris**, sinon le premier lancement apres ce lot aurait
affiche un badge a plusieurs centaines : l'historique persiste va jusqu'a 500
entrees, dont aucune n'avait d'etat d'acquittement puisque celui-ci n'existait
pas. A la PREMIERE hydratation seulement -- condition testee sur l'ABSENCE du
fichier d'etat, jamais deduite d'une lecture qui echoue -- les entrees deja
presentes sont donc seedees comme acquittees : elles precedent la
fonctionnalite, et sous le modele precedent l'ouverture du volet les avait deja
toutes remises a zero. Un fichier d'etat CORROMPU, lui, existe : le seed ne s'y
declenche pas, et un incident disque ne peut donc pas se transformer en
acquittement de masse de tout ce que l'operateur n'avait pas traite.

**`approvals:reply` et `approvals:decline` sont bloques pour un compagnon
distant**, alors que `inbox:reply` reste au meme palier que `roadmap:assign`.
La distinction n'est pas la cible mais la nature de ce qui transite : ces deux
canaux ne transmettent pas un message, ils rendent un VERDICT HUMAIN qu'un agent
arrete consomme pour agir. Le risque deja accepte dans ce depot (un compagnon
appaire agit avec l'autorite de l'operateur envers un pair nomme) avait ete pris
sur des actions dont le destinataire garde son jugement ; ici il ne l'a plus,
par construction. Consequence assumee : un operateur absent de son Deck ne
debloque un agent que par le canal mobile enrole, dont l'authentification passe
par le credential d'approbation signe et non par l'appairage compagnon.

**Le plancher interdit de REPONDRE a distance, pas de LIRE.** Le flux des
questions en attente part vers tout compagnon authentifie : le texte de la
question, l'hote, le `project_key` et le `session_ref` traversent donc le LAN,
alors que le geste de reponse, lui, est refuse. L'asymetrie est volontaire --
lire n'est pas consentir, et un operateur qui consulte depuis son telephone doit
pouvoir juger de l'urgence avant de rejoindre son Deck -- mais elle est ecrite
ici pour qu'elle ne soit pas prise plus tard pour un oubli et « corrigee » dans
un sens ou dans l'autre.

**Deux residus connus, ecrits plutot que decouverts.** La famille EVENEMENT est
rendue par l'interface mais **aucun canal ne l'emet aujourd'hui** : elle attend
la carte `3817a84f` (verrou abandonne). Et le credential de session etant herite
AU SPAWN, une session ouverte AVANT l'armement reste refusee jusqu'a sa
relance ; le texte de refus nomme desormais cette cause reelle et sa remediation,
au lieu d'annoncer une absence d'approbations distantes qui n'est plus le sujet.

## desktop (experimental) -- le volet Agents se replie, et ce repli devient l'implementation de reference du patron

Deux cartes formant un lot : `079f034d` (controle de repli du volet Agents) et
`19f5ab5b` (nettoyage du bandeau de ce meme volet).

**Le patron du volet repliable existait comme REGLE dans `DESIGN.md` sans
aucune implementation.** Les deux surfaces qu'il citait, le panneau de filtres
de la Roadmap et la liste de conversations du Graphe, montent et demontent leur
panneau conditionnellement, c'est-a-dire exactement ce que la regle interdit :
un panneau qui disparait emporte le controle qui le ferait revenir. Le volet
Agents est donc la premiere mise en oeuvre, et `DESIGN.md` la designe desormais
comme celle a copier. `<aside className="sidebar">` reste monte en permanence ;
seule une classe modificatrice change sa largeur. Le controle occupe le meme
pixel dans les deux etats, seul son glyphe change de sens : un diptyque a
charniere (`GLYPH_ACTIONS.panelFold` / `panelUnfold`), deux entrees plutot
qu'un miroir CSS, pour que le cadre et sa charniere ne bougent pas.

**L'etat replie est persiste**, sur le meme canal que `sidebarWidth`
(`AppConfig.sidebarCollapsed`, `updateConfig`) : faire survivre la largeur d'un
volet mais pas son repli scinderait le cycle de vie d'une meme geometrie. Une
configuration ecrite avant ce champ le recoit a `false` par le spread de
`DEFAULT_CONFIG`, il n'y a aucune migration a jouer.

**Replie, chaque ligne ne garde que ses signaux vivants** : le point d'activite
et le laurier team-lead, alignes a gauche et non centres, pour que la colonne
de points reste droite quand une ligne porte un badge. La bande fait 58 px,
somme mesuree de sa ligne la plus large, pas un chiffre repris d'ailleurs, et
la barre de defilement y est supprimee : une barre native de 15 px vole un
tiers d'une bande de cette largeur, alors que l'operateur travaille a onze
pairs, donc la liste defile dans le cas nominal. Masquer la barre ne desactive
pas la molette. Le composant d'envoi de message est le seul bloc conserve monte
et simplement masque : son brouillon vit dans un `useState`, le demonter
detruisait en silence le texte deja tape.

**Le bandeau survit vide.** Le nom d'espace qu'il imprimait etait une chaine
unique deja portee integralement par le titre de la fenetre ; le bouton Espaces
rejoint la barre d'actions a cote de la jarre sandbox, ou il a le sens d'une
action et non d'un titre. Quatre controles ne tenant plus dans les 260 px par
defaut, l'espacement de cette barre a ete resserre de 16 px sur la geometrie,
jamais sur le libelle, et la rangee peut se replier a la largeur minimale
plutot que de peindre hors du volet. La cle i18n `app.brand`, devenue sans
producteur, a ete supprimee des trois fichiers de locale plutot qu'ajoutee a la
liste des orphelines toleree par `tests/desktop-i18n.test.ts` : cette liste ne
peut que retrecir, et une assertion materialise desormais cette phrase qui
n'etait qu'un commentaire.

**Trois defauts que ni le typecheck ni la suite ne voient** ont ete trouves en
lancant l'application et en mesurant des positions a l'ecran : un bandeau qui
passait de 52 a 48 px selon la presence d'un bouton, donc un controle de repli
qui glissait de 2 px (un SVG inline reserve une ligne avec descente, corrige
sur l'en-tete du volet) ; un point d'activite qui se decalait de 9 px sur la
seule ligne portant un laurier ; et la jarre sandbox qui peignait hors du volet
a la largeur minimale.

## core + desktop (experimental) -- le parcage et la liberation des verrous gagnent leurs routes, l'archivage d'une carte parquee est refuse partout

Deux cartes livrees ensemble, `aaf4537d` et `bc0ccb17`, parce que l'une ne
peut pas partir sans l'autre : `aaf4537d` donne enfin un producteur au
parcage, `bc0ccb17` ferme la garde d'archivage sur ce producteur.

**Les routes POST /roadmap/lock-park et /roadmap/lock-release manquaient.**
`lock_parked_at` n'etait pose a une valeur non nulle par aucun chemin, et les
moities Pause et Hard Stop de l'en-tete appelaient des routes absentes. Le
contrat n'est pas invente ici, il est repris de l'appelant deja livre
(`roadmap-service.ts` `lockPark`/`lockRelease`) : meme corps `{project_key,
peer_ids, by}` signe operateur, meme reponse `{parked|released, failed}` de
peer_ids.

**La garde `refusesParkedArchive` n'etait cablee que sur la route archive,
pas sur l'upsert dont le statut cible est `archived`.** Elle l'est desormais,
avec le meme refus 409 et non un no-op silencieux sur `deleted_at`, qui
aurait ete du fail-open deguise. Les deux cartes partaient ensemble parce que
la faille etait latente faute de producteur : livrer le parc sans la garde
l'aurait armee dans le commit meme qui livrait le parc.

**Trois portes de service fermees, toutes mesurees avant correction :**
- deux upserts successifs par un tiers -- le premier, non archivant,
  nullifiait le parc sans jamais consulter la garde, le second archivait
  librement, y compris depuis une ecriture non signee se declarant avec le
  champ libre `by` valant le peer_id du proprietaire du verrou. Le parc n'est
  plus efface que par son proprietaire ou par son expiration.
- `lock-park` volait un parc etranger -- re-parquer a son nom puis archiver
  donnait le meme resultat net. La route est desormais symetrique de
  `lock-release`, qui refusait deja.
- `lock-release` cassait le parc d'un autre operateur, ce qui contournait en
  deux appels la garde livree ici. La restriction ne mord que sur les lignes
  parquees : une carte simplement verrouillee reste liberable par tout geste
  operateur prouve, Hard Stop garde sa largeur.

**Un decalage de fuseau a ete introduit puis retire pendant la livraison
elle-meme.** La route ecrivait `datetime('now')`, un UTC naif que
`Date.parse` lit comme heure locale ; avec un TTL de parc inferieur a
l'offset, le parc mourait a la seconde ou il etait pose. La route ecrit
maintenant l'ISO, et `isParked` normalise une chaine sans marqueur de zone,
parce que la route n'est pas le seul producteur possible : l'import restaure
des valeurs venues d'ailleurs. Fait structurant, `bun test` force `TZ=UTC`,
donc la suite est aveugle par construction a cette classe de defaut : la
sonde de non-regression passe un `TZ` non-UTC explicite au processus enfant
et devient vacante si on le retire.

**Troncature silencieuse remplacee par un refus bruyant.** Les deux routes
empruntaient `MAX_DIRECTIVE_TARGETS=16` et rendaient la liste coupee, si bien
que les peer_ids au-dela n'apparaissaient ni dans `parked` ni dans `failed`
et se lisaient comme "rien a faire". Cap dedie `LOCK_BATCH_MAX_TARGETS=64`,
refus 400 au-dela, verifie avant `cleanPeerIds` sur les deux routes.

**La garde de couverture des routes est etendue** avec un bucket
`OPERATOR_GUARDED_PROBES` distinct, attendu a 403 et jamais fondu dans les
sondes 401 : une route identite-prouvee mais privilege-operateur-manquant
rend 403, pas 401.

Les preuves HTTP vivent dans des fichiers prefixes `broker-`, exclus
deliberement du glob de collecte de la CI : elles ne sont rejouees que par le
gate local, tout comme la normalisation de fuseau, qu'une cellule pure ne
peut pas prouver puisque `bun test` force `TZ=UTC`.

## core + desktop (experimental) -- la vague 1 du backlog, le verrou de carte et l'identite de l'operateur, integralement livree

Douze commits sur deux journees, 2026-08-11 et 2026-08-12 : `664081a`,
`0ff6e8d`, `b07199f` (trois regressions desktop, aucune cartee), `1e5cd1f`
(carte `e7b364dc`), `f32a86d` (documentation du design system), `26d0cf5`
(carte `6aa32af4`), `d838333` (carte `fc444eda`), `681cc03` (carte `438c15e3`),
`626974d` (carte `c8ee5732`), `d75fcf8` (carte `78bf378d`), `5ba88d3` (carte
`edefff05`), `a79d30b` (carte `1d9f25e5`).
Cartes closes : `e7b364dc`, `6aa32af4`, `fc444eda`, `438c15e3`, `c8ee5732`,
`78bf378d`, `edefff05`, `1d9f25e5`. Cartes ouvertes par ces deux journees :
`7dde9434`, `c787fd07`, `6aef4c54`, `b2fdb93f`, `c374c332`, `89e313bc`,
`0955abf9`, `ba58fb12`, `40a1cea9`, `9722ea04`, `f44b5227`, `a583c908`,
`7fabbd10`.

**La vague 1 est close et le chemin critique est debloque (card `edefff05`).**
La garde de signature livree precedemment authentifiait QU'UN operateur
signe, jamais LEQUEL : `resolveRoadmapAuthor` verifiait `auth.operator_id`
puis le jetait, et la ligne n'enregistrait que `updated_by = 'deck'`. Trois
cartes du chantier workflow (`011d3547`, `c33a5968`, `aaf4537d`) attendaient
de savoir LEQUEL ; les construire sur l'etat precedent aurait ete les
construire sur une identite absente de la ligne. La colonne
`roadmap_items.operator_id` existe desormais, TEXT nullable. Consequence a
retenir : la vague 3 n'est plus bloquee.

**La semantique est arbitree, parce qu'elle contraint les cartes suivantes.**
La colonne enregistre le DERNIER OPERATEUR AYANT SIGNE UNE ECRITURE, ce
n'est PAS une revendication de propriete : la propriete reste `locked_by` et
`locked_at`. Corollaire ecrit pour la suite : la carte des lots (`011d3547`)
devra stocker la reservation sur le LOT et non sur la carte. Une ecriture
d'agent ordinaire PRESERVE la valeur via `COALESCE(?, operator_id)` ; le
balayage de verrou perime l'efface, comme il efface deja `locked_by`, parce
qu'un balayage TTL n'est signe par personne. Et `handleRoadmapReorder`
N'ESTAMPILLE PAS, exclusion desormais ecrite dans le code : ses trois UPDATE
portent sur N lignes d'un coup, donc estampiller ferait porter a des
dizaines de cartes jamais ouvertes la marque du dernier signataire, et une
attribution que tout le monde porte n'attribue plus rien.

**Le resultat de methode du batch vaut plus que le code : le faux-vert
`COALESCE`.** Sur un `UPDATE ... SET col = COALESCE(?, col)`, une cellule de
test qui verifie seulement la PRESERVATION par une ecriture qui ne fournit
pas la valeur reste VERTE meme si la colonne n'est jamais ecrite,
`COALESCE(NULL, x) = x` etant indistinguable de "ne rien ecrire". Mesure :
deux chemins couverts par une telle cellule rendaient zero echec au retrait
de la production. Seule une cellule qui STAMPE sur une ligne VIERGE mord.
C'est en generalisant cette forme que la revue a trouve le trou de
`handleRoadmapReorder`, qu'aucun diff ne montrait.

**La lecon jumelle du 2026-08-11**, deja dans les corps de commit mais a
redire ici : garder sur l'EFFET d'une ecriture trouve ce que garder sur ses
CHAMPS ne peut pas trouver. Le vrai defaut de la carte `e7b364dc` a ete
trouve par une enumeration exhaustive du produit croise du predicat, 540
cellules, ancienne forme contre nouvelle, resultat `regressions=0
widened=4`. Les quatre cellules refermees etaient une ecriture
d'enrichissement de contexte par un tiers, sans `status` ni `locked` dans le
corps, qui effacait le verrou en ecrivant un champ sans rapport. Septieme
chemin de liberation.

**Trois fonctions pures extraites, meme patron.** `shared/roadmap-lock.ts`
(`e7b364dc`), `shared/project-key.ts` (`6aa32af4`), et `ownsLock()` cote Deck
(`438c15e3`). La raison structurelle est la meme a chaque fois et merite
d'etre dite une fois : `broker.ts` n'est pas importable en test, il n'exporte
rien et lance `Bun.serve` au niveau module, donc toute logique qu'on veut
prouver unitairement doit sortir en module pur.

**`438c15e3`, annoncee basse gravite, a coute sept rondes**, et la lecon est
que la profondeur d'une carte est proportionnelle au risque que son
CORRECTIF introduit, pas au defaut d'origine. Le geste decisif : `own()`
etait la porte apparente mais `ensureCurrent()` la court-circuitait, `own()`
n'etant jamais atteint quand `currentId` est deja pose ; le remede prescrit
par la revue sur `own()` seul n'aurait donc rien ferme.

**`1d9f25e5` et la forme du correctif.** `selectUndeliveredCapped` filtrait
sur `to_token` seul. Plutot que de relire la ligne `peers` et de tracer une
branche "introuvable", le handshake, qui faisait DEJA cette lecture pour
verifier `status = 'active'`, rend desormais `group_id` et le passe : une
seule lecture, plus de branche morte, et une garantie portee par la
signature a deux arguments au lieu d'un commentaire affirmant l'ordre
d'execution.

**Le volet desktop du 2026-08-12 (card `c8ee5732`).** Entree de menu de
portee LISTE qui copie le tableau `peer_id = role` de tous les agents, la ou
l'operateur retapait onze lignes a chaque deploiement de template et ou une
transcription fautive cassait le routage de `send_message` en silence.

**Un fait d'environnement a inscrire, parce qu'il reapparaitra a chaque
gate** (card `ba58fb12`). `tests/desktop-commit-closure-check.test.ts` echoue
sur les postes portant un `core.hooksPath` global. Ce n'est pas git qui
refuse le commit, c'est bun qui TUE le process git au timeout de hook de
5000 ms pendant le `beforeEach`, le hook global (scan gitleaks) faisant
passer le build du fixture de 1,632 s a 9,472 s. `spawnSync` rend alors
`status != 0` avec stdout et stderr VIDES, et le message accuse un commit
innocent qui varie d'un run a l'autre. Neutralise, le fichier rend 57 pass.

Gate passe deux fois le 2026-08-11 (1605 puis 1617 pass / 2 skip / 0 fail sur
138 fichiers), une fois a la sequence de fin de journee (1649 pass / 2 skip /
0 fail sur 142 fichiers), et le 2026-08-12 **1686 pass / 2 skip / 0 fail sur
146 fichiers**, smoke build propre, typecheck desktop vert sur les deux
tsconfig, `check-commit-closure` vert.

## core + desktop (experimental) — filtrage et recherche de la roadmap, et trois regressions desktop closes au passage

Six commits : `872d951`, `5d50c86`, `eb0b62a`, `cef321e`, `fdf53ca`, `bcfb463`.
Cartes closes : `15952e09`, `3b0fda5f`, `b8d65b24`. Cartes ouvertes par la
session : `438c15e3`, `019f7b37`, `77682683`.

**Filtrage broker (card `15952e09`).** `roadmap_list` n'exposait que 5 filtres
sur 15 champs ; un agent rapatriait 115 cartes pour en garder une. Le filtrage
vit desormais cote broker, seul moteur SQL possible, donc aucune divergence
entre la surface agent et la surface operateur. FTS5 en contenu externe (le
`content_rowid` est ecrit explicitement, car l'alignement porte sur le rowid
implicite et non sur l'id TEXT), trois triggers, et un rebuild au demarrage
qui rend la desynchronisation impossible a travers un redemarrage ; l'import
fait son propre rebuild en fin de transaction, un `INSERT OR REPLACE` ne
declenchant pas le trigger `DELETE` sans `recursive_triggers`. La recherche par
prefixe d'id passe volontairement A COTE de FTS5 : un tokenizer decoupe un
uuid et rend des correspondances partielles absurdes, une clause `LIKE` bornee
suffit. Une valeur de filtre inconnue rend une erreur, jamais zero resultat
(zero sur une faute de frappe serait un faux negatif silencieux) ; la
validation des tags porte sur l'ensemble du projet, archives comprises. Les
compteurs de facettes se calculent sur l'ensemble de reference et non sur le
resultat deja filtre, sans quoi un compteur retombe a lui-meme des qu'un
filtre est actif.

**Recherche et panneau de filtres desktop (card `3b0fda5f`).** La vue Roadmap
gagne une recherche texte, un panneau lateral de filtres a facettes et des
jetons de criteres actifs, sans implementer de moteur : tout le predicat vit
dans le broker ci-dessus. Le danger n'etait pas le filtrage mais le
reordonnancement de la queue, qui n'envoie pas l'item deplace mais recalcule
la liste COMPLETE des ids depuis le state React ; une source filtree aurait
donc desenfile silencieusement toutes les cartes masquees. `QueueSource` isole
cette source non filtree. Une premiere tentative avait marque ce type par une
`interface` a `unique symbol` : elle laissait passer un spread
(`{ ...source, all: filtre }` compile), et ce meme spread echappait AUSSI a un
balayage de discipline puisqu'il ne nomme pas la fabrique -- garde et
surveillance partageaient l'angle mort. Une classe a membre prive refuse le
litteral ET le spread ; seul un cast subsiste, et lui est greppable.
`RoadmapList` n'est pas une seconde vue mais la mise en page mobile de la
meme vue de rail, et consomme desormais le meme hook.

**Auto-save de workspace (card `b8d65b24`).** La restauration de session ne
fonctionnait plus : l'auto-save gardait sur `SessionService.list()` (qui
inclut le supervisor) et serialisait `captureSessions()` (qui l'exclut), donc
tout instant supervisor-seul ecrivait `sessions: []`, detruisant le snapshot
que l'auto-save etait cense proteger. La garde vit dans `saveAuto` plutot
qu'au call site, car `saveAuto` a cinq appelants et un seul comptait la bonne
population -- sur la mauvaise liste.

**Icone de l'application.** Kory etait packagee avec l'icone Electron par
defaut. La serie change de traitement par PALIER DE TAILLE et non par
plateforme (le plateau jusqu'a 64 inclus, une silhouette nue en dessous) :
un critere par plateforme aurait de toute facon livre les deux traitements
sur les deux plateformes, un meme OS affichant l'icone a plusieurs tailles.
Pointer un DOSSIER comme source aurait tout annule : la lecture de
`doConvertIcon` dans `app-builder-lib` montre qu'une entree repertoire fait
deriver toutes les tailles du plus grand PNG. Le `.icns` est construit a la
main plutot que par ImageMagick, qui ecrit le fichier avec un code de sortie
0 en ne conservant SILENCIEUSEMENT qu'une seule frame -- empiler six PNG y
donne le meme resultat qu'en empiler un. Le verificateur re-parse le fichier
produit sans reutiliser la logique d'ecriture, sans quoi il validerait sa
propre erreur.

**Echelle EFFORT, cran du milieu.** `medium` heritait de la couleur de texte
par defaut, seul cran sans couleur sur une echelle sinon rouge/vert. L'orange
retenu evite deux pieges : `var(--glow)` est configurable par l'operateur et
reserve au halo d'attention (une echelle ORDONNEE dont un cran suit une
preference n'est pas un theme, c'est un bug), et l'ambre voisin est deja
porte par le statut `in_progress`.

**Trouve seulement a l'ecran, apres typecheck, tests et revue tous verts.**
Trois defauts de ce lot : une regle CSS du bouton d'effacement du champ de
recherche qui debordait geometriquement la boite de clip du panneau (invisible
et incliquable des qu'on saisissait du texte) ; un etat vide de la vue
Roadmap qui annoncait "la roadmap est vide, ajoutez des cartes" alors que
cent quinze cartes existaient ; et, exhume au passage sans etre corrige, les
trois echelles de pilules (effort, valeur, statut) qui tombent sous le seuil
de lisibilite WCAG en theme clair -- suivi en card `77682683`.

Deux defauts ouverts par la session : `438c15e3` (`WorkspaceService.own()`
ignore le booleen rendu par `acquireLock()`, donc un Deck peut entretenir le
verrou d'un autre en croyant le posseder) et `019f7b37` (`sessions.json` est
ecrit a chaque changement de session et lu par personne depuis le retrait de
la restauration automatique).

## core (experimental) — an operator-authored roadmap write must prove the operator (card `39c40571`, layer 2)

Four commits, `29bff61` then `6f7b5d3`, `5ceaba3`, `8029eb1`. Layer 1
(`bbd8f17`) had closed the peer-to-peer axis and said so in its own test
header: a bare `by: 'deck'` stayed accepted, because the deck sentinel matches
no peer row and there was nothing to prove against. That was the last unproven
author, and it was the valuable one -- `'deck'` names the HUMAN, and `proven`
is what walks the work-lock guard.

**What shipped.** A `'deck'`-authored write now carries an Ed25519 operator
proof, routed through `resolveApprovalAuth` rather than verified beside it, so
the path inherits the signature check, the nonce replay guard and the operation
table in one move. `roadmap-write` joins `ApprovalOperation` and is deliberately
left OUT of `SESSION_ALLOWED` -- an allow-list, so it fails CLOSED, and a
sandboxed agent holding a session token is refused by that table (403) instead
of by a rule re-typed at the call site. Deck side, the identity loads LAZILY at
the first signature: it could not come from `ApprovalRuntime`, whose `arm()` is
gated by `config.mobileApprovals`, which would have made a phone-notification
toggle the on/off switch of the shared roadmap.

**Migration needs no enrolment.** A machine that never enrolled has no identity
file, so the first signature mints one. `operator_id` is the digest of the
public key, which travels with the payload and is therefore covered by the
signature, so first contact self-certifies.

**The domain was swept, not copied from the card.** The card named
`handleRoadmapUpsert`; `resolveRoadmapAuthor` has FOUR callers (upsert, archive,
reorder, import) and the guard is wired to all four. A second sweep, from the
SQL writes rather than from the function, returned the same client domain plus
`releaseStaleLocks` -- the internal TTL pass, which writes on nobody's behalf
and is legitimately outside the guard.

**A complete bypass was found in review, and closed.** The first commit was
defeated in three requests with no signature at all: `POST /register` with
`host: 'deck'` and `cwd: '/'` in a FRESH group minted a peer literally named
`deck` holding a real, non-sentinel `instance_token`; an upsert authored
`by: 'deck'` with that token was accepted 200 and overwrote a card locked by
someone else. Two links, both fixed:

- **Order was the guard.** The token branch of `resolveRoadmapAuthor` returned
  `proven: true` BEFORE the new deck branch was reached, so layer 2 was only
  ever consulted by bodies WITHOUT a token. The name now decides which rule
  applies, so the name is tested before any credential is honoured.
- **`deriveDefaultId` never consulted `RESERVED_PEER_IDS`.** Three call sites
  used it (import, `set_id`, `cleanPeerIds`); the fourth path -- the one that
  MINTS a name at `/register`, from a caller-supplied `host` and `cwd` -- was
  not wired. It now suffixes rather than refuses, so a machine whose hostname
  really is `deck` registers as `deck-1` instead of being excluded from the
  product by its name.

A third guard was added on the author's own initiative and kept: a token whose
RESOLVED `peer_id` is reserved is refused too, because the mint fix cannot act
backwards and a live database may already carry a row named `deck`. That is the
migration path of the fix, not scope creep.

**The refusal names the remedy, and the remedy is tested.** The first wording
prescribed re-registering; that does not work, and the commit's own resume probe
proved it (session resume is keyed on `session_key`, and the dormant branch
returns the `peer_id` READ FROM THE ROW). Worse, an assertion pinned the wrong
wording. The message now points at `set_id`, states that reconnecting will NOT
rename, and the test pins the prescription in both directions
(`toContain("set_id")` and `not.toContain("re-register")`). The reserved-author
branch is keyed on `RESERVED_PEER_IDS` rather than on `'deck'` alone, so
`operator` and `system` are gated by construction, and the probe iterates the
set instead of a hand-typed list.

Known and left open: `by` is not case-normalised, so `by: 'Deck'` escapes the
reserved-name check. No privilege follows (the lock exemption compares `'deck'`
exactly and `proven` stays false), so the cost is attribution spoofing only --
filed rather than bundled into a batch already reviewed three times.

## desktop (experimental) — graph-view geometry, workflow-lane parallelism, and the argv-truncation bug

Four operator requests on the Graph view and the Workflow lane, all shipped:

- **Nav rail order** -- Roadmap now sits between Home and Agents, Graph right
  after Agents and above Browser (`NavRail.tsx`'s `VIEWS` table); the mobile
  tab order (`mobile-views.ts`) follows the same key order.
- **Resizable graph nodes** -- `GraphNode` gained optional `w`/`h` (default =
  the existing `GRAPH_NODE_W`/`GRAPH_NODE_H` constants, so old docs render
  unchanged); every site that used to read the constants directly now goes
  through `nodeW(n)`/`nodeH(n)` (rendering, edge anchors, `fitView`,
  `findFreeSpot`'s overlap check, the engine's fan-out placement). Standard
  edge/corner handles, visible on hover, extend the existing drag state
  machine with a `resize` kind instead of relying on native CSS `resize`
  (which does not survive the canvas's `transform: scale(zoom)`).
- **Wire-drag to connect** -- a small port on each node, drag to an empty
  spot opens a pre-wired create-form at that point, drag onto another node
  adds a `depends_on` link (cycle-checked, same guard the "Accrocher" button
  already used). Pure renderer change; the connect button stays alongside it.
- **Battle prompt truncation on Windows (argv, card `07dc42c0`)** -- root
  cause: the operator's prompt text rode the command line
  (`claude -p <prompt>`); legacy PowerShell rebuilds that command line for
  the native binary without re-escaping embedded `"`, so
  `CommandLineToArgvW` re-parses one of the prompt's own quotes as an
  argument delimiter and truncates everything after it -- invisible in the
  inspector, which shows the (correct) file side of the request. Fixed by
  moving the prompt off argv entirely onto stdin/file, the same path already
  used for context (`model-adapters.ts`, `utility-inference.ts`,
  `demo-driver.ts`); the silent 8000-character prompt cap on that path is
  gone with it. The fresh-tile initial prompt (`session-command.ts`, a PTY
  path, not a spawned subprocess) got its own follow-up fix: typed as
  bracketed-paste keystrokes once the tile's startup-ack fires, instead of
  composed on argv.

The Workflow lane picked up the parallel gestures it was missing:

- a **vertical resize handle** on the lane's top edge (persisted height,
  clamped, hidden in fullscreen/collapsed), imitating the scrollbar-thumb
  pointer-capture pattern already in the same file;
- a **"Nettoyer" button** that empties the dispatch queue in one atomic
  `roadmap:reorder([])` call -- confirmed via `ConfirmDialog`, wording
  explicit that it only dequeues (no roadmap item is deleted, locked
  in-progress heads are untouched);
- **roadmap dependencies now close transitively at enqueue time**: dropping
  a card onto the lane (or queuing it from its detail modal) pulls its
  `depends_on` closure in ahead of it, in topological order, in the same
  atomic reorder -- and the detail modal's dependency badges became a real
  editor (clickable titles, remove, cycle-checked add-picker) instead of
  read-only 8-character ids;
- **queue waves**: parallelism no longer requires sharing a dependency.
  Stacking onto a target with nothing to share degrades to a plain
  insertion instead of refusing the gesture; a full wave mechanic follows
  (`42edc88b`, phases 1-3) letting several cards share a queue rank as a
  lane column, with `depends_on` validating that order instead of deriving
  it (an intra-wave or backward-wave edge shows as a violation, same red
  edges the lane already had) and auto-dispatch honoring the wave barrier;
- **multi-dispatch** (`5852c074`) sends a whole head wave to the team-lead
  in one announce instead of one card at a time, the lead already knowing
  how to read (`roadmap_get`) and delegate (`send_message`) each id.

Full exploit-chain detail and the design alternatives considered for the
argv fix live in git history; the one residual (manual Windows end-to-end
confirmation) is tracked in `BACKLOG.md`.

## mobile-shell — Parastatès moves to Capacitor 8, and its QR scanner is wired to a plugin that exists

`desktop/mobile-shell` could not be installed. `package.json` asked for
`@capacitor/barcode-scanner: ^2.0.0` next to `@capacitor/core: ^6.0.0`, and
every 2.x of that scanner peers on core `>= 7.0.0` — so `npm install` had never
resolved, in any version of this file. It went unnoticed because `android/` is
generated rather than committed and the suite runs on the TypeScript alone: the
directory was, as its README said, a scaffold.

**Capacitor 6 → 8** (`core`, `android`, `cli`, `preferences` on `^8`, scanner on
`^3.1.0`). Going to 7 would have cost the same JDK jump and the same
documentation rewrite while stopping one major short. The five packages move
together by necessity: the scanner's major is tied to Capacitor's by its peer
range, so a partial bump is unsatisfiable. What it changes:

- toolchain: JDK 17 → **21**, compileSdk/targetSdk 34 → **36**, minSdk 22 →
  **29**, Node ≥ 20 → **≥ 22** for the `cap` CLI. `BUILDING.md` §5 now derives
  those numbers from `@capacitor/android/capacitor/build.gradle` and says so,
  because that table drifted once already. The floor is raised from the 24
  Capacitor 8 defaults to, but not because of `@capacitor/barcode-scanner`
  3.1.0's `io.ionic.libs:ionbarcode-android` dependency, whose own floor is 26
  and would already refuse a lower manifest merge: `CompanionWebView`'s
  certificate pinning calls `SslCertificate.getX509Certificate()`, API 29+,
  which is what actually determines 29 as the project's real floor;
- the 790 lines of Kotlin in `android-src/` are untouched. They reach Capacitor
  through six symbols (`BridgeActivity`, `Plugin`, `PluginCall`,
  `PluginMethod`, `JSObject`, `annotation.CapacitorPlugin`), all still present
  in 8.4.2; the rest is plain Android;
- `minSdk` 29 closes a gap `BACKLOG.md` §3.2 had recorded as unreachable:
  `shouldOverrideUrlLoading(WebView, WebResourceRequest)` is API 24+, so on the
  old 22–23 floor the origin check in `onPageStarted` carried the WebView
  alone. It no longer does anywhere;
- `npm audit` goes from 6 findings (5 high, 1 critical) to 0.

**The QR scanner never ran.** `platform.ts` read
`window.Capacitor.Plugins.BarcodeScanner` and called `.scan()`; the package
registers as `CapacitorBarcodeScanner` and exposes `scanBarcode(options)`. The
lookup returned `undefined`, so both pairing flows fell through to the
`prompt()` fallback meant for a browser — silently, on a device as much as on a
desktop. Fixed, with the plugin name and the shape of the call spelled out in a
comment, since nothing in the suite can catch this class of mistake: the tests
only ever exercise the fallback branch.

**Parastatès has now been compiled.** `MB6` had stood since N5 as the one lot
whose proof was reading rather than execution: 790 lines of Kotlin, reviewed,
never once put through a compiler. `assembleDebug` now produces a 55 MB debug
APK (up from an earlier 35 MB measurement at a lower `minSdk`: AGP stores dex
uncompressed once `minSdk` >= 28), and getting there cost exactly what that
entry predicted it would.

Three of the four gaps were in `BUILDING.md` §5.2, which described a procedure
nobody had executed end to end. The project `cap add android` generates is
**Java-only**, so the Kotlin plugin has to be added by hand or the `.kt` files
are copied in and never compiled — the build goes green while the app has none
of its native capabilities. `cap add android` also generates its own
`MainActivity.java` beside the `MainActivity.kt` you copy in, and Kotlin stops
on the `Redeclaration`. And `androidx.webkit` no longer needs a hardcoded
version at all: Capacitor 8 already carries `androidxWebkitVersion` (1.14.0) in
`variables.gradle`.

The fourth was a real source bug, of the kind only a compiler finds:
`CompanionWebView.kt` declared **two** `companion object` in the same class,
one holding `open()` and one holding `CRED_KEY`. Kotlin allows one. The class
could never have compiled, in any configuration, since the day it was written.
`BACKLOG.md` §3.2 said the Kotlin was proven by reading and the TypeScript by
1043 tests; this is what that distinction is worth in practice.

The `hint` argument the v3 API requires is inlined as ALL (17) rather than
`QR_CODE` (0), and the reasoning is in the code: the value crosses into Kotlin
as an ordinal into an enum that lives in a prebuilt AAR, where an out-of-range
ALL degrades to "no format constraint" while a wrong 0 would silently select
another format and never scan — on a device only. Importing the plugin's enum
instead would pull `html5-qrcode` into a 15 KB dependency-free bundle.

## core + desktop (experimental) — the app is named Parastatès, and both reviews landed

A code review and a security review ran over the whole N5 lot. Nine of their
findings were real; the fixes ship here with the naming, in one batch.

**The app is Parastatès** — παραστάτης, the chorus member who stands beside the
leader. Koryphaios leads the chorus; this one stands next to it. The app id
becomes `io.koryphaios.parastates` (the family namespace stays: it is a
satellite, not a separate product) and the deep-link scheme `parastates://`.
Both are moved now because neither can move after a store listing exists.
Storage keys keep the `koryphaios.` prefix on purpose — they name the
ecosystem, not the app, and they are invisible.

### The security findings

**Certificate pinning was documented, not implemented.** The companion viewer
accepted ANY certificate whenever a host entry had no fingerprint, on every
navigation, forever. The class that would have implemented trust-on-first-use
(`PinnedTrust.kt`) was never instantiated by anything — dead code claiming a
security property, which is worse than none because it reads as done. It is
deleted, and the write-back it promised now exists: the digest served on a
first connection is recorded and pinned from then on, never overwriting an
existing pin. This mattered most for hosts paired before the QR carried `&f=`
at all — for them, "no fingerprint yet" was a permanent MITM window on the LAN,
against a channel that is a remote-control socket into the Deck.

**The credential seeding had one guarded path and one unguarded one.** The
`addDocumentStartJavaScript` path is scoped to the paired origin; the
`onPageStarted` fallback ran for whatever page had started loading, so a
redirect or an in-page link handed the companion credential to the destination.
Both are now origin-checked, and a `shouldOverrideUrlLoading` keeps the viewer
on its one host — it is a control channel, not a browser.

**The ntfy token rode inside published action buttons.** The inline
justification was that reading the notification topic already discloses the ids
needed to answer. That is true of *answering* and false of the token: an ntfy
`tk_…` is an ACCOUNT credential, so the relay was caching a copy of it in a
message anyone who learned the topic could read. Our own notification buttons
never used it — they read the token from app-private storage — so dropping it
costs only one-tap answering from the official ntfy client on a token-protected
server. The related documentation lie is corrected too: re-minting topics does
NOT rotate the token, so `Disconnect`/`Connect` alone never was the whole kill
switch for a lost phone.

### The code-review findings

**`notify/registry.ts` contained two literal NUL bytes**, so git classified the
file as binary: the entire multi-operator rewrite was undiffable, unmergeable
and invisible to `grep`. The separator is right (it mirrors
`DOMAIN_OPERATOR_ID`); writing it as the escape `\0` instead of an embedded
byte is the whole fix.

**The phone could never confirm its pairing.** The broker published its
acknowledgement with an empty `click`, and the app routes on the deep link and
drops anything without one. So the ack — and, worse, the *refusal* — were
discarded: the operator watched "waiting for confirmation" forever and the
one-shot code stayed on the device. There is now a `parastates://paired/<0|1>`
link and a message kind for it, so a refusal shows as a refusal.

**The `since` cursor advanced on keepalives.** They are continuous and real
answers are rare, so the last id before a disconnect was almost always a
keepalive — an id the message cache cannot resolve. The resume was therefore
broken in the common case, not the rare one. The filter now precedes the
assignment. The old test asserted the buggy value; it asserts the right one.

**Two operators sharing a Discord bot token got two gateways.** The
shared-instance guard tested `isReady()`, and a Discord gateway is only ready
once its socket is OPEN — so during connect or reconnect backoff the guard
missed, a second consumer opened on the same token, and the first became
unreachable. Presence in the table is the test; it is removed exactly when the
gateway stops.

**A failed reconnect destroyed a working channel.** Connect overwrote the
sealed config, stopped the running gateway, then deleted the row on failure —
so one click with the relay briefly unreachable cost the operator their paired
channel and left `configured: false, paired: 1`. It now vets the candidate
before touching anything, and a test reproduces the old destruction.

Also: `stop()` no longer parks an HTTP handler for the full reconnect backoff;
`disconnect()` in the renderer surfaces its failure instead of clearing the
spinner while the channel is still live; the enrolment form no longer carries a
half-typed ntfy token across to Telegram; the origin badge can no longer eat
the agent's title; pairing codes went from 32 to 96 bits and stale ones are
swept; and the two disagreeing private-address predicates became one
(`shared/net.ts`) — a self-hosted ntfy on a tailnet was refused as "not local"
while the companion accepted the identical address.

**None of these tests ran in CI.** The matrix only globbed `tests/desktop-*`,
and its `paths:` filter did not include `notify/`, `shared/` or `broker.ts` —
so 140 unit tests never executed on any OS. Fixed, and the mobile shell now has
a tsconfig: it was in no type-checked project at all, which is precisely the
wrong state for the one module whose justification is that broker and phone
cannot drift.

Four tests that could not fail were replaced by tests of the invariant they
named. 1034 -> 1043.

## core (experimental) — a shared broker really serves several operators

Two defects that only appear when one broker serves more than one operator
identity — the normal case on a box shared by a team, or on one PC with two OS
accounts. Both were pre-existing: Telegram and Discord have carried them since
N3/N4, and ntfy merely inherited them.

**The gateway table was keyed by channel KIND, not by (operator, kind).** So the
second operator to enrol a channel replaced — and stopped — the first one's
gateway. Telegram then failed cleanly (their bot never ran, so nothing arrived);
ntfy failed confusingly, because the notification topic came from the binding
while the reply topic came from the adapter's config: the question reached the
phone and the answer went to a topic nobody was subscribed to. Availability
only, never confidentiality — inbound routing resolves by address and the broker
still refused to settle another operator's approval — but silent, which is worse
than loud.

Keying per operator is not enough on its own, though: two operators may enrol
the **same bot token** deliberately, one person with two OS accounts and one
bot. Telegram allows exactly one `getUpdates` consumer per token, so a gateway
each would make them fight over the updates forever. `broker.ts` therefore
digests the sealed config and shares one instance between the slots that resolve
to the same transport; stopping is reference-counted, so disconnecting one
operator never cuts the other. For ntfy the digest covers the whole config, so
two operators on one ntfy account still get a subscription each — their topics
differ, and each needs its own.

**The authorisation question was asked in the wrong direction.** An inbound
answer resolved the sender's address to "its" operator, then compared. That is
equivalent to the right check only while an address belongs to exactly one
operator — which stops being true the moment one person points two operator
identities at one chat account, exactly what sharing a bot means. `SELECT …
WHERE address = ?` then `.get()` picked one of the two rows, so roughly half the
answers were refused as "already handled" in front of a perfectly valid request.
It now resolves the APPROVAL first and asks "is this address paired *for that
approval's owner*". Same guarantee, stated so it survives a second identity.
`isPairedAddress` remains as what adapters actually wanted — a cheap pre-filter
to drop strangers — and says in its own comment that it is not the gate.

One guard came out of writing the test for it: an ntfy pairing code was
redeemable on **any** topic, including another operator's. Since a topic is a
secret the broker mints (unlike a chat id, which the provider supplies and any
chat may legitimately present), a code is now only redeemable on the transport
it was issued for. Without it, redeeming Alice's code on Bob's topic bound Alice
to that topic, and an answer published there would have authorised against her
approvals.

1034 tests. ntfy's two-operator path is covered end to end against the stub on
loopback; the same-address case is not, and cannot be — an ntfy address is a
per-operator topic, so the collision is not constructible there. It needs two
real bots, and is listed in `BACKLOG.md` §3.1 bis.

## core + desktop (experimental) — the Koryphaios app as a third approval channel

Telegram and Discord already delivered a waiting session's question to a phone.
Both hand the text to somebody else's servers on the way. The third channel
does not: the **Koryphaios Android app**, reached through **ntfy** — a relay
small enough to self-host on a VPS, at which point the question never leaves
infrastructure the operator controls.

**Why a relay at all, when the phone is often on the same Wi-Fi.** Because
Doze. With the screen off, Android suspends network access and ignores
wakelocks, so a LAN socket dies within minutes — and the whole point is
answering from a train. FCM was the other candidate and is unusable for an
open-source app: pushing to it requires a Firebase service-account key on the
sending side, which cannot be shipped in a repository without handing everyone
the ability to push to every installation. ntfy is the relay that already
solved that, and it is AGPL.

**Two topics, both legs outgoing.** The broker publishes questions on one
topic and holds a streaming GET on the other; the phone does the mirror image.
Nothing anywhere accepts an incoming connection — the same property Telegram's
long poll and Discord's gateway socket have, kept deliberately. The topics ARE
the secret (24 random bytes each, and an optional ntfy access token), and they
are **re-minted on every reconnect**, which is what makes `Disconnect` →
`Connect` an actual kill switch for a lost phone rather than a gesture.

**The constraint that shaped the design: ntfy cannot edit a delivered
message.** Telegram and Discord settle a losing copy by rewriting it in place;
here that is impossible. So `settle` publishes a *closing* message keyed on the
approval id, at minimum priority, and the app cancels its own notification on
it. Without that, a question already answered in the Deck would sit on the
phone looking actionable — precisely the failure the settle rule exists to
prevent. The second constraint: an ntfy action button carries a **fixed** body.
Approve and Reject can be buttons; "use the staging bucket instead" cannot.
That single fact is why the app has a screen of its own instead of leaning on
the official ntfy client.

**One wire format, not two.** `notify/ntfy-protocol.ts` is used by the broker
*and* bundled into the Android app, so the two ends cannot drift. Making it
bundlable meant moving `stripControl`/`truncate` into a dependency-free
`shared/text.ts` — the protocol no longer drags `node:crypto` into a WebView.
The app bundle comes out at ~14 KB with no Node builtin in it, which is the
proof rather than the claim.

**The app carries two features that must not be confused.** *Companion* mirrors
a Deck's UI over the LAN: it needs proximity, and there is now one entry **per
Deck**, built up by successive QR scans with a selector — nothing changed on
the desktop side, each Deck keeps serving its own companion server. *Approvals*
reaches the operator anywhere through the broker, is tied to an **operator
identity** rather than a machine, and must work with no Deck reachable at all.
Separate storage, separate lifecycles, separate threat models; a test holds the
property directly, because the tempting simplification — one pairing list — is
exactly the bug.

One desktop change was genuinely required, and only one: pinning needs the
certificate's fingerprint, so `CompanionInfo` now reports it and the companion
QR carries it as `&f=`. The certificate is stable across launches and is shown
to every visitor, so publishing its digest costs nothing and turns "accept any
self-signed certificate" into "accept exactly this one". Resuming a host needed
no desktop change at all: `connectRemoteApi` already boots from a stored
credential alone, so the shell seeds the key it reads — now a shared constant
instead of two literals in two projects.

**What is honest about the Android half.** `mobile-shell/android-src/` holds
the Kotlin Capacitor does not generate: the foreground service, notification
actions, the biometric gate, `FLAG_SECURE`, certificate pinning. **None of it
is compiled here** — this container has no Android SDK — which is exactly why
it decides nothing: it moves bytes and manages lifecycles, while every rule
lives in TypeScript under `bun test`. Expect corrections on the first build on
a tooled machine. The service declares `connectedDevice` rather than
`dataSync`, deliberately: the latter is capped at 6 hours per 24 since Android
15, and would take the channel down overnight, silently, which is when a long
run is most likely to be waiting.

1017 tests at delivery (+131). ntfy is the first channel whose *nominal* path
is covered rather than just its failure path: its protocol is small enough to
stand up locally, so a stub ntfy on loopback exercises pairing, fan-out, a
phone answer settling an approval, a second answer losing the race, and an
answer aimed at another operator's approval going nowhere. What no test covers:
the real ntfy.sh, a real phone, and all of Android. Those checks are listed in
`BACKLOG.md` §3.1 bis and §3.2. Operator documentation:
`desktop/docs/notifications.md`; the shell's own README covers the two modes.

## core + desktop (experimental) — remote approvals: answer a waiting session from your phone

Long sessions stop and wait: a tool-permission dialog, a plan to approve, an
open question. Until now that meant walking back to the machine. An agent's
blocking question can now reach the operator over **Telegram** or **Discord**,
and the answer comes back as **free text** — not a yes/no.

**The broker is the sole arbiter.** `POST /approval/claim` is a conditional
`UPDATE ... WHERE status='pending'`, so exactly one caller wins and every other
gets 409. That single line is what makes "answered in the Deck" and "answered
on the phone" mutually exclusive; the losing copies are rewritten to "handled
via X" and lose their buttons, so nothing stale keeps looking actionable.
Approvals are parked with the `graph_drafts` durability model (no FK, plain
snapshots, status flips, non-destructive listing): neither a broker nor a Deck
restart loses one. Only the NOTIFICATION expires (24 h, tunable) — the session
stays blocked and the Deck can still settle it.

**A new identity axis, because `hostname()` names a machine, not a person.**
Two OS accounts on one PC share a hostname, so routing by host would hand
account B's approvals to account A. `operator_id` is the digest of an Ed25519
PUBLIC key; the broker stores that half only, so the binding is self-certifying
(another key for a known id would need a collision) and reading the broker's
SQLite file lets nobody act as anyone. Proofs carry a nonce and a timestamp and
are single-use, which closes backlog **B8** (replay) for this endpoint family
rather than inheriting it. The compartmentalisation itself costs no code: the
app-state directory is already per OS user, so two accounts mint two
identities. Two PCs, conversely, can share one identity by scanning a one-shot
link code — the phone is paired once, for the person.

**Two credential classes, deliberately asymmetric.** The operator key (Deck
only) is alone in being able to `claim` — the operation that authorises a tool
call. A per-session token, handed to spawned agents *including inside a sandbox
container*, may only `add` and `wait`. Worst case for a compromised sandboxed
agent: it spams its own operator with notifications. Had it held the operator
key it could have answered OTHER sessions' approvals, including non-sandboxed
ones on the host — a clean authority escape.

**Three producers, because the kinds of question differ.** The embedded
plugin's `PermissionRequest` hook fires only when a dialog actually appears
(`PreToolUse` would fire on every tool call) and carries a structured payload,
which beats scraping the screen. It does NOT block: Claude Code is already
waiting on its own dialog and keeps waiting, so holding the hook process open
for minutes bought nothing and raised a question — how long may a hook legally
block? — that the documentation does not answer. The `ask_operator` /
`ask_operator_wait` MCP tools cover open questions, which no hook reaches
(there is none for `AskUserQuestion` or plan approval); the tool's return value
IS the answer, and a ticket makes waiting resumable so no single call depends
on the client's timeout. `attention.ts` remains the net for CLIs without hooks.
Everything fails CLOSED: no credential, broker down or budget spent yields no
decision at all, and the native dialog stands.

**Two return paths, and the split is not stylistic.** A permission dialog is
NOT closed by an incoming message — the UI loop is blocked on a keypress and
the message merely queues (verified in use). So `reply_route` is an explicit
field: `channel` hands the answer to the peer as an ordinary claude-peers
message from the reserved `operator` sentinel when the agent is at its prompt;
`pty` types it in when the agent sits on a modal, or when the CLI has no push
channel at all (codex and gemini have no `claude/channel` equivalent). A
`channel` route whose peer is not active is downgraded to `pty` at creation
rather than accepting a route that can never deliver. This is what makes the
feature reach sessions the Deck does not own: a plain `claude` in a terminal,
or one on another machine sharing the broker. On the agent side the message
gets its own framing — actionable, but explicitly not to be acknowledged, or
every settled approval would drop an "ok, doing it" into the operator's inbox.
The global no-reply instruction is untouched; as the existing
`DECK_NO_REPLY_NOTE` comment says, the nuance rides in the rendered content.

**Gateways in the broker, tokens enrolled from the app.** Telegram allows
exactly one `getUpdates` consumer per token, so the gateway must be a singleton
— the broker, not the N Decks. But requiring shell access to the broker host to
paste a token was not an experience worth shipping, and many operators do not
have that access. The token therefore travels once over an operator-signed
route and is sealed with AES-256-GCM beside the database; it is never read
back, only a four-character hint of it. Both transports are OUTGOING (long
polling, Gateway WebSocket): no port is opened, no address published. Telegram
pairs through a deep link rendered as a QR; for Discord the app reads the
application id straight from the token to build the invite URL, so the operator
never copies it from the portal — and that link is shown FIRST, because without
a mutual server a bot cannot DM anyone (error 50278).

**Hostile inputs, each named.** The question text comes from an AGENT and
reaches a third-party renderer, so it is escaped (Telegram in HTML mode: three
characters, against MarkdownV2's eighteen and its silent 400s). The answer comes
from a remote channel and ends up typed into a terminal, so every CR/LF
collapses to a space and the submitting Enter is added by the code — a remote
answer can never submit early nor run a second command. `reply_token` joins
`instance_token`/`from_token`: it enters by `add`, lives in the database, never
returns. And four of the five new IPC channels are blocked for a paired phone:
one of them exports the enrolment payload, which CONTAINS the operator private
key, and a single companion pairing must not become a permanent identity theft.

**Three defects the tests found on the way.** `deriveOperatorId` and
`deriveTokenId` shared a hash space (domain separation added). The hook's
`idle_prompt` and the Deck's attention detector raised TWO approvals for one
screen, so the phone rang twice (a tile can only wait on one thing at a time —
a second raise now returns the first). And the verdict poller's "still waiting"
check only recognised Deck-raised approvals, so every hook verdict would have
been silently dropped.

886 tests at delivery (+159), none of which touches the network: the gateways
are exercised with a fake channel, against a real broker, a real peer
WebSocket, the hook as a real subprocess and the MCP tool over real JSON-RPC
stdio. Real-world validation — the two bots, cross-channel arbitration, two OS
accounts, two linked PCs — is listed in `BACKLOG.md` §3.1 bis. Operator
documentation: `desktop/docs/notifications.md`. The mobile app as a third
channel (lot N5) is not started. *(It is, now — see the entry above.)*

## desktop (experimental) — sandbox hardening: nine review findings, one of them a sandbox escape

A code review of the sandbox lot found nine real defects. All are fixed, each
with a regression test — the first round shipped green tests that could not
have caught any of them, because they covered the pure modules while every bug
lived in the INTERACTIONS between them.

**The escape (critical).** The host `~/.claude/peers` was bind-mounted
read-write into every container so the containerized `server.ts` could write
its session-id back-channel. That let a sandboxed agent overwrite the
back-channel file of a NON-sandboxed tile: `readDeskSessionId` returned the
file's content verbatim (only the *token* was sanitized, never the value) and
`session-command.ts` interpolated it unquoted as `--resume ${id}` — payload
executing in the HOST shell. Three locks now, because one of them will
eventually be wrong: containers get a Deck-owned `sandbox-peers/` dir instead
of the host one (host tiles are simply out of reach), `readDeskSessionId`
drops anything outside the `[A-Za-z0-9-]{1,64}` shape the core guarantees, and
both id flags are quoted. `SessionService` resolves the back-channel/peer-cache
dir per session, so the supervisor keeps the host dir it needs.

**Silent wrongness (high).** `mapHostPathToContainer` fell back to `/work` for
any path not textually under the mount — combined with the new `canonicalPath`
on worktrees, a symlinked project prefix (macOS `/var`) ran every worktree
session in the project ROOT. It now returns null and the spawn is refused with
a trace, and the mount source is canonicalized so the comparison matches in the
first place. `walkProjectFiles` followed symlinks (`statSync`, no visited set),
so copy-mode globs could pull files from outside the repo and a
self-referential link spun the main process forever — the file cap could not
help, a link loop yields no files. It now uses `lstatSync`, skips links
outright and bounds visits. `ensure()` reused a container whose `/work` mount
belonged to the other work mode, so a failed rebuild after switching to
*ephemeral copy* left agents writing the real tree while the UI said otherwise;
the mount is now compared and the container recreated when stale.

**Broken features (medium).** `transcriptsFor` returned `[]` — a positive
claim of "no transcript" — for any cwd never refreshed, and the cache was only
warmed for the project root: every worktree resume silently started fresh. It
returns null (= "ask the host") and the cache is warmed for the cwd each
session will really use, including on workspace restore. `resetCopy` rm -rf'd
the live bind-mount source without recreating the container, leaving `/work`
on a deleted inode; it now recreates. Published ports were a fixed list
identical for every project with no UI to change them, so a second sandboxed
project could never start — the ports are now editable in the Docker view, an
explicitly empty list is honoured, and the collision is named in the error.

**Dead code and noise (low).** Auth "Disconnect" guarded on "no container
running" while the wipe itself is a `docker exec` needing one — mutually
exclusive states, so no call could ever succeed; it now guards on live
sessions. And `[A-Za-z]:[\\/]` matched the `s:/` inside `https://`, flagging
every hook containing a URL as un-runnable in the container.


## desktop (experimental) — green CI on all three runners (M-MNT-4)

`desktop-build` had been red on macOS and Windows for weeks (8 failing tests
on Windows, 4 on macOS, 1 on Linux) with no diagnosis written down. All of it
is fixed; the causes were three distinct things, only one of which was a test
artifact.

**A real product bug on symlinked paths.** `worktree-service` compared its own
`resolve()`d paths against the ones **git** reports, and git always reports the
REAL path. On macOS `/var` is a symlink to `/private/var`, on Windows a path can
arrive as an 8.3 short name (`C:\Users\RUNNER~1\…`) — so `removeWorktree`
answered *"not a worktree of this repo"* for a worktree it had just created, and
the Worktrees view could not attach a session to its worktree. Every comparison
now goes through `canonicalPath` (`realpathSync.native`, falling back to
`resolve` for paths that do not exist so a missing path still yields the
caller's own error). `ipc.ts` uses it on the session side of the
worktree↔session match too, for the same reason. This was invisible on Linux
because its tmpdirs are not symlinked — so the suite now creates a symlinked
repo prefix explicitly and drives create/list/remove through it, a test that
fails without the fix on any OS.

**Two POSIX-shaped assertions.** The digest suite probed the working directory
with `pwd` (no such builtin in cmd.exe) and compared with `dir.split("/")`; it
now prints the cwd through node and compares canonically. The utility-inference
suite matched the stdin redirection with `/< "file"$/`, which is the POSIX form
— the PowerShell form (`Get-Content -Raw "file" | …`) is equally correct, so the
assertion accepts either and asserts the document contract instead of one OS's
syntax.

**Two tests that are POSIX by construction.** The `runHelp` round-trips pin
`platform: "linux"` and drive a `#!/bin/sh` fixture through `shell: "/bin/sh"`;
there is no `/bin/sh` to run them against on Windows and they assert nothing
about it. They are now skipped there — and rather than leave Windows less
covered, two new OS-agnostic tests exercise the same executor (marker
stripping, stdout capture, rejection on a command that cannot run) with
constructs that behave identically in sh and PowerShell.


## desktop (experimental) — Sandbox mode M2/M3: operator config projection, supervisor exec, ephemeral copy mode

Second sandbox lot: the remaining design is folded into this entry (the
working plan file was consolidated away per repo convention). The remote
SSH/Proxmox backend was ABANDONED — Docker covers the need.

**Your workflow travels into the container (M2).** At every container start
the Deck COPIES the operator's `~/.claude` allow-list — global `CLAUDE.md`,
`agents/`, `skills/`, `plugins/`, `settings.json` — into the sandbox
(`sandbox-projection.ts`, `docker cp`), and the Docker view reports exactly
what landed. Copy, never mount, and the header says why: a mounted
`settings.json` would let a sandboxed agent write a hook that later executes
on the HOST, a clean escape. Hooks that cannot run under Linux (PowerShell,
`.ps1/.bat/.exe`, `C:\…`) are detected and listed, with a
`~/.claude/sandbox-overrides/` overlay to supply Linux equivalents (a
same-named entry there wins); overlay files that are not projectable are
reported instead of silently ignored.

**The supervisor manages the environment (M2).** New `deck_sandbox_exec`
tool: "add this dependency to the instance" runs inside the project's
container, in `/work`, with the agent's command line passed as ONE argv
element to the CONTAINER's bash — it never reaches a host shell (hostile
input #4). Refused when sandbox mode is off, 5-min cap, clipped output,
journaled.

**Honest environment reporting (M2).** The broker bridge is no longer guessed
from the platform: the view curls `/health` FROM inside the container and
reports what happened, with the `CLAUDE_PEERS_BIND_HOST` fix spelled out when
a native Linux engine can't reach the host. The image is probed
(`image inspect`) and buildable in one click — `docker build` on the shipped
Dockerfile runs in a real utility PTY so the build log is readable — and a
drift badge appears when the image was rebuilt after the container was
created. Resume now works inside the sandbox: transcripts live in the auth
volume, so the Deck lists them container-side (`find …/projects/<container
cwd>`) and `SessionService` consults that instead of the host's — surviving
even a container rebuild. Plus auth "Disconnect" (refused while a sandbox
container runs).

**Ephemeral copy mode (M3).** A per-project work mode: instead of the real
tree, the Deck mounts a throwaway `git clone --local` of it, so agents cannot
touch the project at all and work leaves through git (the clone's `origin` IS
the local repo). Because a clone only carries tracked files, an operator
allow-list of gitignored globs is copied on top (planning notes, local
fixtures) — with a hard deny-list that always wins (`.env*`, keys/certs,
`.ssh`, `.aws`, `node_modules`, `.venv`, `.git`) and unmatched globs surfaced
so a typo is visible. The pre-spawn gate now returns the EFFECTIVE project
root, so tile cwds and `git worktree add` land inside the mounted clone.

Settings moved to a single guarded `sandbox:patch-settings` channel (enable,
work mode, ports, globs — all trust-changing, all refused while sessions
run, all `REMOTE_BLOCKED`). Docs: `desktop/docs/sandbox.md` rewritten,
overview/sessions/settings/supervisor-team/faq updated, both READMEs.
Residual is field validation only — the checklist lives in `BACKLOG.md`
§3.8. The remote SSH / Proxmox backend once sketched for M3 is dropped: the
local engine covers the need.

## desktop (experimental) — Sandbox mode M1: sessions in a persistent per-project Docker container (SBX1–SBX5)

New 🏺 **Docker** rail view + per-project toggle: with sandbox mode on, every
NEW session runs inside a persistent container (`kory-sbx-<sha256(projectDir)
[0..12]>`, project bind-mounted rw at `/work`, idling on `sleep infinity`) —
the tile PTY simply runs `docker exec` and every detector (thinking, quota,
attention) works unchanged. The wrap goes through a per-session launch script
under a Deck-owned `/kory-run` mount (no PowerShell→bash double-quoting; env
translated by pure, bun-tested `sandbox-command.ts`: FORCE_GROUP file→inline,
loopback URLs→`host.docker.internal`). Sessions inside reach the HOST broker
via an injected `CLAUDE_PEERS_BROKER_URL` (server.ts refuses to auto-spawn on
non-loopback, so a bad bridge fails loudly); the host `~/.claude/peers` dir is
bind-mounted so peer-id discovery and the desk-session back-channel keep
working. The supervisor stays host-side (exempt by design — it pilots the app).

Auth is a shared named volume (`kory-claude-auth` on `~/.claude`): ONE CLI
login covers every project and survives container removal. First spawn with
no credentials opens a blocking modal — Next embeds an xterm running `claude`
in the container, the Deck polls the credentials file, closes the modal and
toasts on success; agents cannot spawn until then (`sandboxGate` in the
shared create path throws `sandbox-auth-required`, mapped renderer-side to
the modal — no login prompt per tile, ever). Re-authenticate lives in the
Docker view.

Lifecycle is Proxmox-LXC-like on purpose: containers are created lazily,
**stopped** (detached) at app close, **never** auto-removed; the Docker view
lists every `kory-sbx-*` container (all projects, labels `kory.sandbox` /
`kory.project`) with start/stop/rebuild/remove — all gated like the toggle on
`hasLiveSessions()`, names re-validated main-side against the generated shape
(hostile input #3). Settings (`enabled`, published dev-server ports for the
embedded browser) live in operator app-state `sandbox.json` keyed by
`computeDeckProjectKey` — never the repo. Image built once from
`desktop/resources/sandbox/Dockerfile` (debian + bash/git/bun + claude CLI,
user `kory`). Companion is transparent (all channels execute host-side; the
sandbox trust flips are `REMOTE_BLOCKED`). Design + M2/M3 milestones:
this entry; operator docs: `desktop/docs/sandbox.md`; field-validation
checklist: `BACKLOG.md` §3.8. Also fixes the calendar-rotted `desktop-log` prune test
(fixture age now anchored on the test's fixed clock).

## desktop (experimental) — Browser REC: screen recording + agent-driven demo scenarios

The embedded browser's toolbar gains a **REC** button: a modal picks the
capture scope — browser pane only (canvas-crop pipeline over the window
stream, pure math in `shared/recording.ts`) or the whole Koryphaios window —
and the clip lands under app-state `recordings/` as MP4 (when the Chromium
runtime muxes it) or WebM, path in a toast. `getDisplayMedia` is answered
main-side with the Deck's OWN window only (`setDisplayMediaRequestHandler` —
no OS picker, the renderer can never capture another surface); while
recording, the button pulses red with an elapsed timer and the browser rail
entry carries a red dot from every view.

The modal's optional **scripted scenario** makes the tool film itself being
useful: the operator describes what to show, picks a model (claude CLI only,
Sonnet default, remembered in `config.demoTarget` — the picker is in the
modal, not a hidden supervisor prompt), and ONE throwaway `claude -p` drives
the embedded page while the pane records, auto-stopping on completion. The
agent's whole capability surface is five `demo_*` MCP tools (structured
`demo_read`, `demo_navigate`, real-input `demo_click`/`demo_type`,
viewer-pacing `demo_wait`) served by a NEW per-run loopback endpoint + Bearer
token (`demo-control.ts` + `demo-browser-mcp.mjs`, mirroring deck-control but
least-privilege: never the supervisor token, 120-step cap, 64 KiB payloads).
Harness = C8 code constant (`demo-driver.ts`, scenario framed as data, every
file/shell/web tool disallowed); agent-supplied selectors/texts enter page
scripts JSON-encoded only (`browser-drive-scripts.ts`, bun-tested against
breakout payloads) and navigation is http(s)-only. Stopping the recording
cancels the run (killable child, login-shell PATH). deck-control was NOT
extended: the demo agent piloting a web page and the supervisor piloting the
app are different trust domains. Suite: demo-control dispatch/auth/step-cap +
stdio bridge end-to-end, script-builder escaping, command/harness composition
(tamper-overwrite included); pending real-runtime validations in
`BACKLOG.md` §2.

## desktop + core (experimental) — Directive cards: supervised context/token economy (CT)

A new roadmap kind **`directive`** turns the shared roadmap into a lever for
context-window economy across a team of sessions. A directive card carries a
closed-enum command — `clear` (free, zero-inference context reset; system
prompt / CLAUDE.md / MCP / skills survive), `compact` (summarize in place, one
inference on the target's own model), or `magic_compact` — plus an explicit
`target_peer_ids` list. When the card reaches the head of the operator's
dispatch queue, the **Deck itself types the command into the targeted
sessions' terminals** (the autoResume keystroke precedent: Escape → settle →
command → Enter, gated on the tile being idle so a reset never lands
mid-turn); agents never execute directives. Decide vs execute is split by
design: queueing a card is open to the operator (Workflow lane) and to the
team-lead / supervisor (`roadmap_add`, kind `directive`), but the injected
text is always a CODE CONSTANT (`directive.ts` DIRECTIVE_KEYS) chosen from the
re-validated enum — a manipulated lead can at worst trigger a spurious `/clear`
(C8 / three-hostile-inputs #2: broker fields re-validated Deck-side, never
typed verbatim). The conveyor belt drains leading directive cards before the
next work item, so a `clear` placed (or `depends_on`-wired) after an item runs
at that boundary; hand-off briefings for the next item ride the item's
`context` field, not the directive.

`magic_compact` prefers the aerovato Magic-compact plugin (deterministic,
zero-inference transcript compaction): the Deck injects `/magic-compact`,
captures the `/resume <id>` banner from the tile's own output (ANSI-tolerant,
strict-UUID), and re-enters the compacted session IN PLACE — option A, the
process never restarts so the peer_id and the launch harness are preserved —
falling back to standard `/compact` on the plugin's shim-failure message, a
timeout, or when the plugin is absent/disabled. Per-machine **feature flags**
(`resolveFeatures`): `magicCompact` (`auto`|`on`|`off`) reaches a PTY so the
GLOBAL config decides enablement and a project-local (clonable) config may only
restrict it to `off`; `handoff` (`file`|`kleos`|`off`) is advisory. Core:
broker `roadmap_items` gains `directive` + `target_peer_ids` (migration,
validation, sanitized peer-id list capped at 16, export/import); the
`roadmap_add`/`roadmap_update`/`roadmap_list` MCP schemas, the team playbook and
the supervisor briefing all learn the concept. UI: a distinct dashed-violet
card in the Workflow lane, a generic directive item in the editor (command
dropdown + live-peer target multiselect, work-only fields hidden), and the
detail modal, with EN/FR locale parity. Chantier ids: `CT1`…`CT7`
(chantiers CT1–CT7); the deferred `clear`+briefing / context-gauge increment
(CT6) and the option-A empirical checks live in `BACKLOG.md`.

## desktop (experimental) — Usage-limits modal (amphora rail button)

One rail button (amphora glyph — the level left in the jar), one foreground
modal stacking the subscription quota gauges of every DETECTED frontier CLI:
Claude Code (session 5 h + weekly all-models + weekly per-model + extra-usage
credits via `api.anthropic.com/api/oauth/usage`), Codex (5 h + weekly via
`codex app-server` JSON-RPC, local session-rollout fallback flagged stale) and
Antigravity (gemini/3p pools × 5h/weekly via cloudcode-pa
`retrieveUserQuotaSummary`, OS-keyring OAuth blob). Design decisions: a single
unified modal (comparison at a glance) rather than a per-provider submenu or
brand icons in the Greek-glyph rail; Gemini CLI deliberately excluded
(individual accounts cut by Google on 2026-06-18, migrated to Antigravity —
operator decision); all endpoints are reverse-engineered community mechanisms
(CodexBar / openusage / Usage-Monitor), an operator-approved risk mitigated by
per-provider degraded states ('not-connected' / 'error' / stale) and a 3-min
main-side cache (the Anthropic endpoint 429s aggressive polling). Tokens never
cross the IPC boundary. Chain: `usage-service.ts` → `usage:read` (tier 0) →
`UsageLimitsModal.tsx`; gauges amber past 70 %, red past 90 %.

Second wave of the lot: (1) **Antigravity as a model provider** — `agy` joins
the frontier catalog (GraphCli `antigravity`, provider id `antigravity`,
sigil `△`), executed headless through a "read this context file" instruction
+ `--add-dir` (no system/stdin flag documented) with `--print-timeout`, and
ALWAYS under a PTY (`pty-run.ts`, injected as `runTty`) because `agy -p`
hangs without a TTY (agy#318) and drops piped stdout (agy#76); model names
ship with their effort suffix ("Gemini 3 Pro (High)") through the dedicated
`sanitizeAntigravityModel` (double-quoted, spaces legal). Gemini CLI stays
wired unchanged for org accounts. (2) **The amphora becomes a gauge** — its
liquid level is the mean REMAINING session quota of the providers the app
run actually draws down (live tiles + marked inference targets,
`markProviderUsed` / `usedProviders` in the snapshot, math in
`shared/usage.ts`), polled every 5 min renderer-side through the 3-min main
cache; tone green / amber (≤30 %) / red (≤10 %) via `.usage-*` classes,
sanctioned as the one data-fill exception to the stroke-only glyph rule
(DESIGN.md §5).

## desktop (experimental) — Workflow lane: the dispatch queue as a visual chain

The roadmap view splits horizontally: kanban on top, a new **Workflow lane**
below (`WorkflowLane.tsx`) drawing the dispatch queue as a left-to-right chain
of linked cards. Design decisions: positions are DERIVED, never stored, and
hierarchy-first — the column is the `depends_on` depth inside a connected
component (parallel branches of an N:1/1:N fan-in stack vertically in the
same column, like the graph view's layout transposed), while unrelated
components chain left-to-right by queue rank so a dependency-free queue stays
a flat conveyor (`desktop/src/shared/workflow.ts`, pure + bun-tested) — the
lane and the kanban can never drift, and the shared broker schema needs no
coordinates. A grid-assisted stack gesture (drop a card clearly above/below
another: dashed ghost slot) makes it a parallel sibling by adopting the
target's dependencies (sanitized, cycle-checked) — never offered between
dependency-related cards (they cannot run in parallel: the card slides
sideways, and an insertion that would wrong-side a link previews it live in
red, link and card borders alike); an expand button opens the lane as a
fullscreen foreground modal. Reorders commit through one new atomic broker route
(`POST /roadmap/reorder`: ids in order → queue 1..N in a transaction, others
unqueued, 500-id cap) instead of N racy upserts. Interactions: HTML5 drop from
the board (insertion caret), in-lane drag to reorder, a port to pull
`depends_on` links between cards (cycle-checked) or into the void (create-form
opens pre-wired; cancelling creates nothing), right-click to create at a slot,
red edges + click-for-why panel when the queue order breaks a dependency, a
warning badge for dependencies neither scheduled nor done, locked in_progress
cards shown as frozen chain heads, wheel/button zoom with auto-fit down to a
floor then a thin proportional scrollbar. The old flat queue list is replaced
by the lane (same dispatch button); the card context menu now toggles
queue/unqueue.

## desktop (experimental) — Greek glyph icon set, attention glow, button-style pass

Full iconography overhaul born from the CSS audit (DESIGN.md): the emoji rails
become a hand-drawn Greek-glyph SVG set (VS Code activity-bar contrast,
mythological metaphors — temple, theatre mask, labyrinth, caduceus…), extended
to generic action icons (`GLYPH_ACTIONS`), semantic badges (`GLYPH_BADGES`:
laurel lead, Themis scales judge, crossed xiphos battle, clepsydra waiting,
Olympic torch for the remote link) and coloured roadmap kind marks
(`GLYPH_KINDS`). The `.is-glowing` attention pulse gains a configurable colour
(Settings > Appearance, `--glow`, gold default). DESIGN.md + the `deck-design`
skill document the drawing rules; a generic `.btn` archetype closed the
unstyled-button gaps (Reload, worktree actions, offline-banner Dismiss + red
rail dot).

### To adjust with the operator (visual pass pending)
- **Mobile roadmap sheet actions**: provisional glyph choices — archive box
  (🗃), up-arrow "lift" (🎈), theatre mask for "assign to an agent" (🚀).
  Review on a real render and re-pick metaphors where they read poorly.
- Densest glyphs to eyeball at small sizes: caduceus, theatre mask, scales,
  oil lamp (roadmap "idea"), clepsydra.

## desktop (experimental) — Files & Git rail views (PLAN-git-explorer GX1–GX8)

Two new READ-ONLY navigation-rail views born from the "VSCode git view"
brainstorm. Design decisions: the Git view observes but never writes (no
stage/commit/branch, direct or delegated — the agents own the git workflow);
the file viewer ships without syntax highlighting in v1 (shiki/highlight.js
noted as the v2 candidates, PLAN-git-explorer.md phase D).

### Added
- **± Git view (GX1–GX3).** SCM-style promotion of the C13 DiffPanel: pick a
  worktree (attached-session badge) or a live session's dir on the left, read
  its diff on the right — branch-vs-main + uncommitted sections, clickable
  per-file numstat narrowing to a single file's diff (`collectFileDiff`, new
  `diff:collect-file` channel, tier 0), 10 s poll, the one-shot review agent
  button. Untracked files render through `git diff --no-index /dev/null`.
  Paths crossing the renderer/companion boundary are containment-checked
  (`isRepoRelative`).
- **📁 Files view (GX4–GX6).** Lazy read-only explorer + plain-text viewer
  (line-number gutter, 5 000-line render cap). New pure module
  `explorer-service.ts`: realpath containment (symlink escapes rejected),
  `.git` hidden, 512 KB read cap, NUL-sniff binary detection. The browsable
  roots (`explorer:roots/list/read`, tier 0) are re-validated main-side on
  every call: project dir + worktrees + live session cwds, nothing else.
- **Selection → assistant / roadmap (GX7–GX8).** Selecting code in the viewer
  offers "❓ Explain" (help assistant opens prefilled, the snippet travels as
  `code_selection` inside the app-composed SYSTEM snapshot — capped 20 KB,
  `sanitizeHelpSelection`, never on the command line) and "🗺 Create a task"
  (roadmap create form prefilled: kind debt, status planned, snippet quoted;
  saving stays an explicit operator action). Store seeds: `helpSeed` /
  `roadmapSeed`.
- **Security hardening (GX-SEC, from the branch's own security review).** The
  diff handlers (`diff:collect`, `diff:collect-file`, `diff:review`) now
  re-validate their `dir` argument against the same work-dir allow-set as the
  explorer (project dir + worktrees + session cwds), factored into one
  `workDirRoots`/`requireWorkDir` helper shared by both feature areas —
  closing an arbitrary-file-read the `git diff --no-index` content fallback
  could otherwise reach with an attacker-chosen `dir` (tier-0 channel,
  companion-reachable). The `--no-index` fallback is additionally gated on a
  realpath containment check (`realpathWithin`) so a committed symlink in a
  cloned repo cannot dump a file outside the tree.
- Docs: `interface.md` (rail table + two view sections), `DESKTOP.md`
  highlight, `PLAN-git-explorer.md` (status tracked per phase; phase D =
  highlighting, not started). Tests: `desktop-explorer.test.ts`, per-file
  diff + selection-sanitizer cases in `desktop-diff.test.ts` /
  `desktop-help.test.ts`.

## desktop (experimental) — reference documentation for the assistants

### Added
- **Reference documentation (`desktop/docs/`).** 14 markdown pages covering
  the whole app for the end user AND the built-in assistants: overview &
  concepts, interface tour, sessions, workspaces/templates, supervisor &
  team spawning, roadmap, browser/design mode, graph chats, communication
  (megaphone/inbox/journal), help assistant & digest, mobile companion, a
  full settings/configuration reference, and a troubleshooting FAQ. Shipped
  in packaged builds via `extraResources` (like `locales/`); integrity
  (index completeness + link resolution) is guarded by
  `tests/desktop-docs.test.ts`.
- **Help assistant grounding.** `buildHelpSystemPrompt` gains an
  app-computed `docsDir` pointer (`resolveDocsDir`: resourcesPath when
  packaged, app dir in dev) rendered as a "Reference documentation" section,
  and the claude utility adapter grants read access to that directory via
  `--add-dir` (`AdapterInput.addDir`, threaded through
  `runUtilityInference`). The read-only harness is unchanged; local HTTP
  endpoints keep answering from the snapshot alone.
- **Supervisor docs pointer.** `buildSupervisorSystemPrompt(docsDir?)`
  appends an app-generated paragraph pointing the supervisor at the same
  directory for "how does the app work / how do I configure it" questions.
  The role definition stays a code constant (C8 rule): only the PATH is
  app-computed, and omitting it yields the byte-identical previous anchor.

## desktop v0.13.0 (experimental) — supervisor team spawn (PLAN-team-spawn TS1–TS7)

The supervisor can now compose and spawn whole agent teams from the roadmap or
an operator request, per `EXPLORATION-team-spawn.md` (decisions §8) and
`PLAN-team-spawn.md`. v1 is Claude-only; the `cli` field is contract-frozen
(only `claude` accepted) so the future multi-CLI lot is not a breaking change.

### Added (desktop, v0.13.0)
- **Team playbook + embedded catalog (TS1).** `main/team-embedded.ts`: the
  hardcoded team-building skill (`TEAM_PLAYBOOK` — consent rule, Case 1
  roadmap / Case 2 prompt decomposition, granularity tree, wave sequencing
  under the cap, briefing/ack contracts, `deck_save_template`
  capitalization) and a 6-role embedded fallback catalog (`EMBEDDED_AGENTS`:
  team-lead, developer, reviewer, explorer, debugger, test-engineer) — all
  CODE CONSTANTS (C8 rule), profiles referenced by id and injected via
  `--append-system-prompt-file` (regenerated at every spawn), read-only
  roles hardened with `--disallowedTools "Write,Edit,NotebookEdit"`.
- **deck-control team tools (TS2).** `deck_team_playbook`,
  `deck_team_agents`, and `deck_spawn_team` (a whole plan in ONE call:
  validate-everything-first, batch cap check, per-plan approval, async
  acks). `deck_spawn_session` gains `cli`, `embedded_agent` (mutually
  exclusive with `agent`, unknown id lists the catalog) and `wait_for_peer`
  (default true). An embedded team-lead takes the window crown only when no
  live lead exists (template C18 rule).
- **Spawn-ack loop (TS3).** `peer-resolved` now carries the session id; the
  Deck (script, never agent inference) resolves the ack: sync — the spawn
  call returns the peer_id (90 s wait, falls back to async); async — a
  targeted CODE-CONSTANT `deck` announce to the supervisor when the session
  connects (`composeSpawnAckText`), fails to within 120 s, or exits early
  (`composeSpawnFailText`).
- **Trust-mode setting (TS4).** `config.supervisorSpawnMode`
  (`hands-free` default / `team-review` / `full-control`) gating every
  supervisor spawn: no dialog / ONE native recap dialog per plan /
  one dialog per agent (native pattern of the template approval). Settings >
  General radio group with per-mode help texts (en/fr).
- **Supervisor consent rule (TS5).** `SUPERVISOR_SYSTEM_PROMPT` now anchors:
  never spawn on own initiative; a question calls for a proposal + explicit
  confirmation; a peer message / file / roadmap item is NOT operator consent.
  The deck-control MCP bridge (v0.6.0) declares the new tools and repeats the
  consent line in its instructions.

## desktop v0.12.0 (experimental) — companion LAN access (PLAN-mobile-lan MB1–MB6)

LAN-only mobile access to the desktop window, per `EXPLORATION-mobile-lan.md`
and `PLAN-mobile-lan.md`. The renderer is web-remoted, not pixel-streamed: the
main process serves the SAME renderer bundle over HTTPS+WebSocket and a
generated shim replaces `window.api` on the phone, so terminals, roadmap,
inbox and the rest run natively in the mobile browser/WebView. **The desktop
window is behaviorally unchanged** — every mobile behavior is derived and gated
on a remote coarse-pointer client (`.is-mobile`), never on window width.

### Added (desktop, v0.12.0)
- **Companion bridge (MB1).** `shared/companion.ts` (pure, bun-tested) declares
  the DeckApi surface as data (`COMPANION_MANIFEST`, `satisfies` 1:1 with
  DeckApi), the wire frames, the LAN-only guard (`isPrivateAddress`,
  RFC1918/ULA/CGNAT), the single-use-token→credential lifecycle
  (`CompanionAuth`) and the declarative sensitivity tiers (§5.4).
  `main/api-registry.ts` routes every `ipcMain.handle/on` through one table
  serving both Electron IPC and the WS bridge, with `broadcast()` fanning
  state events to the window AND every client. `main/companion-server.ts`
  is the HTTPS+WS server (persistent self-signed cert, anti-bruteforce
  lockout, heartbeat). `renderer/src/remote-api.ts` is the WS `window.api`
  shim (reconnect, host-death watchdog, light/full channel).
- **Compagnon button + pairing (MB2).** A 📱 rail button (desktop only) opens
  a QR-code dialog (`CompanionDialog.tsx`); one-shot token bound to the app
  run, exchanged for a per-run credential; closing the app revokes everything
  (ephemeral session model, §5.5).
- **Mobile shell (MB3).** Bottom-tab nav (`MobileNav`), bottom sheets
  (`MobileSheet`), agents pager with session chips + xterm key bar
  (`MobileAgents`/`KeyBar`), `visualViewport` refit. Same stores/IPC, CSS
  gated on `.is-mobile`.
- **Mobile roadmap + floating basket (MB4).** `RoadmapList.tsx`: one column
  at a time (status tabs + counters), action sheet mirroring the desktop
  right-click menu, and the long-press→seize→detach floating basket
  (`shared/hold-gesture.ts`, bun-tested). Same five roadmap IPC calls.
- **Light background channel (MB5).** Backgrounded clients drop `pty:data`/
  `session:thinking`, keep the signal events; `bufferedAmount` backpressure
  guard on the terminal stream.
- **Android shell scaffold (MB6).** `mobile-shell/` — thin Capacitor shell
  (QR scan → WebView on the host URL), with the native TODOs (foreground
  service, biometric app lock + `FLAG_SECURE`, cert pinning) documented. Not
  built here (needs Android SDK); never bundled into the desktop package.

## core v0.9.0 + desktop v0.11.0 -- 2026-07-19

Error observability (PLAN-observabilite-erreurs O1-O6, plan retired into this
entry): the audit of invisible crashes found ad-hoc `console.error` everywhere,
no log file on either side, no process-level nets, and an activity journal
that evaporated at quit. Both sides now own bounded rolling logs, every layer
has a designated error sink (the "No silent errors" convention in CLAUDE.md +
the `error-reporting` skill), and the Deck surfaces failures deliberately:
journal for background errors, throttled toasts for direct actions, a
persistent red banner for the broker-down state. No Sentry/SaaS: everything
stays on the operator's machine (local-first decision).

### Added (core, v0.9.0)
- **Rolling file logger (O1).** `shared/logger.ts` (node-fs only, no deps):
  size-rotated `<name>.log` (5 MiB × `maxFiles=3`, boot trim, synchronous
  appends so an uncaughtException handler can flush a last line), console
  mirror for terminal runs, `coreLogDir()` resolving `<config dir>/logs`
  (override `CLAUDE_PEERS_LOG_DIR`). The broker writes `broker.log` — it
  previously spawned with stdout ignored and `unref()`, so once its spawner
  died its diagnostics went nowhere; `server.log` sits behind server.ts's
  existing `log()` helper (stdout untouched: it carries the MCP protocol).
- **Process-level nets + guarded timers (O2).** `uncaughtException`/
  `unhandledRejection` log-then-exit(1) in broker.ts and server.ts (Bun exits
  on unhandled rejections — now with a trace). The four broker maintenance
  timers (`cleanStalePeers`, `sweepInactivePeers`, `releaseStaleLocks`,
  `purgeOldMessages`) run through `guardedInterval`: they execute outside the
  HTTP handler's try/catch, so a transient SQLite error (BUSY, disk full) was
  the most likely invisible-crash vector; it now skips the iteration and logs.
- **Transactions on multi-statement sequences (O2).** `recordMessageTx`
  (message insert + activity refresh + heuristic ack) and `purgeDormantPeerTx`
  (FK-ordered deletes) — an abrupt broker death mid-sequence no longer leaves
  partial state. Handler 500s keep the stack in broker.log (clients only got
  the message). A malformed `config.json` is reported (path + parse error)
  before booting on defaults instead of being silently discarded;
  `pollFallback` notification failures log once per message.

### Added (desktop, v0.11.0)
- **main.log + central `reportError` (O3).** `src/main/log.ts`: rolling
  `main.log` under `app.getPath('logs')`; `reportError(scope, msg, err)` fans
  out to file + console (dev) + a new journal `error` kind, so the Journal
  view doubles as the operator's error console. The ~7 log-only catches of
  index.ts (announce, dispatch, auto-save, design endpoint…) and the silent
  persistence catches (config/session store, provider keys, worktree init)
  now route through it. The journal itself flushes to `journal-<date>.log`
  at quit (pruned after 7 days) instead of evaporating with the process.
- **Crash nets (O3/O4).** Main: `uncaughtException`/`unhandledRejection`
  log-and-continue once ready (live PTYs beat a crash), errorbox + exit
  before; `render-process-gone` journals and offers a reload;
  `child-process-gone` is logged. Renderer: `ErrorBoundary` at the root and
  around every top-level view — the views are siblings of one tree, so one
  view's render crash used to blank the whole window, terminals included;
  window-level `error`/`unhandledrejection` forward to main.log; `init()`
  failure shows a bilingual retry splash instead of spinning forever;
  preload `subscribe()` callbacks are guarded like `multiplex()` already was.
- **Broker-down banner + toast policy (O5).** `BrokerHealthTracker`
  (2-consecutive-failure hysteresis, fed by the operator-inbox poll) pushes
  `broker:status` to a persistent full-width red `StatusBanner` (outage time,
  last error, Retry forcing an immediate poll), self-dismissing on recovery —
  an outage is a state, not an event, so it is a banner and never toasts.
  `showToast` gains an `error` variant with raw-text support, throttled to
  one per key per 5 s, and is documented as reserved for direct user-action
  outcomes.
- **Guarded actions & hardened edges (O6).** Every mutating store action goes
  through `guarded()`: an IPC rejection logs + toasts instead of silently
  no-oping the click as an unhandled rejection. `pty.spawn` is wrapped (bad
  cwd / missing shell used to leave a pushed-but-never-broadcast zombie def;
  the tile now shows exited and Restart retries) and writes into a dead PTY
  are reported once per session. Operator-inbox batches whose disk write
  failed are re-queued for the next poll (the broker drain is destructive —
  that queue is the only remaining copy). Graph save/list/create/delete
  failures surface in the in-view notice; the embedded browser paints an
  in-frame error with Reload on `did-fail-load`/`render-process-gone`; a
  provider key that fails to decrypt (keychain change) is reported instead of
  masquerading as "no key stored".

## desktop v0.10.3 -- 2026-07-17

### Added (desktop, v0.10.3)
- **Graph conversations encrypted at rest (K8).** `graph-store.ts` accepts
  the safeStorage-backed `SecretCipher` (same injected surface as the C29
  provider keys / D8 scope secrets): the per-project graphs file becomes an
  `{ v, cipher: 'safeStorage', payload }` envelope instead of clear JSON.
  Legacy clear files keep loading and are re-encrypted on the first
  `graph:list` (`migrateGraphsAtRest`); when the OS keychain is unavailable
  (Linux without a keyring) the store falls back to clear text rather than
  breaking the feature. An undecryptable file (OS key changed) yields an
  empty list, never a crash. Deliberately NO server-side storage: the broker
  is shared-token + possibly remote, so operator conversations stay on the
  operator's machine (operator decision on top of D7).

## desktop v0.10.2 -- 2026-07-17

### Added (desktop, v0.10.2)
- **Priority quick-switch (K7).** The MoSCoW chip on each kanban card opens a
  styled dropdown (context-menu look, colored rows, ✓ on the current level)
  to change the priority without opening the detail modal. Metadata write:
  allowed even on locked cards (the broker guard only protects status/lock).

## desktop v0.10.1 -- 2026-07-17

Roadmap card context menu & direct assignment (K6).

### Added (desktop, v0.10.1)
- **Card context menu (K6).** Right-click on a kanban card: ✏️ Edit… (opens
  the edit modal; also reachable via a pencil button in the detail modal's
  header, which replaces the old Edit action button), ⏳ Add to dispatch
  queue, ▶ Process now…, 🗑 Delete (archives — the data model keeps deletion
  a reversible archive, same confirmation dialog). Entries grey out when the
  item is locked, closed or already queued. Reuses the generic `ContextMenu`.
- **Process now (K6).** A dialog lists the window's live agents (peer_id
  resolved, supervisor excluded, 👑 marks the lead): picking one sends the
  item as a TARGETED announce (`composeAssignText`, CODE CONSTANT — full item
  + take-it-now contract), moves it to in_progress (unqueued; the lock still
  arrives when the agent claims it) and journals the assignment
  (`assignRoadmapItem`, IPC `roadmap:assign`). The "＋ New agent on this
  item…" button falls through to the existing launch flow.

## core v0.8.0 + desktop v0.10.0 -- 2026-07-17

Roadmap kanban & agent work-lock (PLAN-ROADMAP-KANBAN K1-K5, plan retired
into this entry): the Roadmap view becomes a status-column kanban board, and
the broker learns to distinguish items *really being worked on* (locked by an
agent) from items merely queued as in_progress.

### Added (core, v0.8.0)
- **Agent work-lock (K2).** `roadmap_items` gains `locked`/`locked_by`/
  `locked_at` (plain-text peer_id snapshot, no FK — rides the existing `by`
  field of every upsert, zero extra round-trip). A non-`deck` author writing
  `status=in_progress` claims the lock; leaving in_progress (or archiving)
  releases it; an explicit `locked: true|false` upsert field overrides. While
  locked, status writes / lock claims by anyone but the owner or `deck` are
  refused with 409 (`force: true` bypasses); non-status writes (context
  enrichment, tags) stay open to everyone. The `roadmap_*` MCP tool
  descriptions and channel instructions carry the contract ("in_progress =
  actually working, planned = releases"), and item renderings show `🔒 owner`.
- **Stale-lock sweep (K2).** `releaseStaleLocks` (every
  `CLAUDE_PEERS_LOCK_SWEEP_SEC=60`) unlocks and drops an item back to
  `planned` (attribution `lock-sweep`) when the item saw no write for
  `CLAUDE_PEERS_LOCK_TTL_SEC=21600`, or when no active peer carries the
  owner's peer_id for the item's project and the lock is older than
  `CLAUDE_PEERS_LOCK_GRACE_SEC=600`.
- **Deck announcements harden the no-reply contract (K4).**
  `DECK_NO_REPLY_NOTE` now also forbids messaging *any other peer* about an
  announcement (agents used to greet newcomers via send_message).

### Added (desktop, v0.10.0)
- **Kanban board (K1).** `RoadmapView.tsx` reworked: one column per status
  (idea/planned/in_progress/done, + archived behind the existing toggle),
  MoSCoW priority as a colored chip + in-column sort, native HTML5 drag &
  drop between columns. Dropping on done asks for confirmation (the item
  will no longer be picked up); a locked card is greyed, dash-bordered,
  non-draggable and badged `🔒 locked_by`. The dispatch-queue strip and the
  create/edit form (now a modal) are unchanged in behavior.
- **Detail modal (K5).** Clicking a card opens a Trello-style foreground
  modal (`RoadmapItemModal.tsx`): badge grid, titled sections for
  description / rationale / context rendered as markdown, dependencies,
  authorship, and the action bar. `markdown.ts` is an injection-safe
  tokenizer (token tree only, React escapes every text node; supported:
  headings, lists, fences, inline code/bold/italic, links surfaced but never
  navigated) — no markdown dependency added.
- **Operator stop (K3).** ⏹ Stop on a locked item, after confirmation,
  sends a CODE-CONSTANT notice (`composeStopText`, C8 rule) through the live
  supervisor when there is one (targeted announce; the supervisor relays,
  verifies and reports back through the operator inbox) or broadcasts to the
  group, then unlocks the item back to `planned` (`stopRoadmapItem`,
  IPC `roadmap:stop`). Toasts distinguish supervisor / broadcast / no-peer.
- **Idle-lock watcher (K2).** `SessionService` tracks `lastOutputAt` per
  PTY; a minute-tick watcher releases locks owned by local tiles whose
  terminal printed nothing for 2 h. Complements the broker sweep (the
  heartbeat keeps an idle session `active`), and only for sessions this
  Deck can observe.
- **Join announces are explicitly no-reply (K4).** `composeJoinAnnounce`
  appends "do NOT reply, do NOT greet or message the new peer" — the
  broker-side deck note only forbade replying to `deck`.

## docs -- 2026-07-16

- **Working plans retired.** `PLAN-v0.4.md`, `PLAN-context-et-snippets.md`,
  `EXPLORATION-roadmap-et-auto-relance.md` and `EXPLORATION-graph-chat.md`
  (all chantiers shipped) are deleted; their per-batch narratives live in
  this file, and the still-open deferred items (graph digest/artefact nodes,
  graph export + per-node cost, OTEL consumption tracking, GitHub Issues
  sync, the C23-C29 manual UI validation) moved to `roadmap-seed-v0.9.json`
  (`bun cli.ts roadmap-import roadmap-seed-v0.9.json`).
- **CLAUDE.md rewritten for a public repo.** The version-history narrative is
  replaced by a current-state overview (core architecture, protocol
  invariants, desktop overview, checks & conventions); pointers to the
  deleted plans and machine-specific examples are gone. `Cxx` ids in code
  comments now resolve through this changelog.

## desktop v0.9.0 -- 2026-07-16

Graph chat & battle mode (EXPLORATION-graph-chat C23-C27): a canvas view
where every exchange is a node — branch "what if" explorations anywhere,
cross N branches into one prompt node, fan a prompt out to several headless
CLIs, and let a judge node arbitrate a battle.

### Added (desktop, v0.9.0)
- **Graph data model + engine (C23).** `shared/graph.ts`: DAG of typed nodes
  (user / assistant / judge, N parents for cross/merge nodes), pure ops
  (ancestors, cycle refusal, deterministic topological linearization,
  three-way-style `mergePartition` — common trunk + per-branch deltas) and
  shape validation. Per-project persistence (`graph-store.ts`) under the app
  state dir, keyed by the deck project_key (stable across worktrees/clones).
- **Headless CLI adapters (C24).** `model-adapters.ts` generalizes the C9
  skeleton: `claude -p` (context via `--append-system-prompt-file`,
  `--strict-mcp-config` + `--disallowedTools`), `codex exec --sandbox
  read-only` and `gemini` (context file fed through stdin, POSIX redirection
  or PowerShell `Get-Content -Raw` pipe). The compiled context always travels
  by FILE (never the command line); `model` strings are sanitized; `runHelp`
  gains an optional timeout (300 s for inference).
- **Context compilation + inference (C25).** `graph-engine.ts`: three CODE
  CONSTANT system prompts (linear chat, merge, judge — C8 rule). 0-1 parents
  → labeled linear transcript; 2+ parents → documentary merge rendering
  (trunk once + labeled divergent branch sections, never a fake linear
  conversation). 60k-char budget with explicit elision markers. Fan-out via
  `Promise.allSettled` (a failed target yields an error node, never blocks
  siblings). IPC `graph:list/create/delete/save/compile/infer` + journal kind
  `graph`.
- **Graph view (C26).** New 🕸 rail view: per-project graph list,
  dependency-free canvas (SVG bezier edges + positioned cards, pan/zoom/drag,
  manual layout), multi-selection, reply / node-from-selection (cross) /
  connect-parent (cycles refused) / leaf-only delete, and a context inspector
  showing exactly what will be sent. i18n en/fr.
- **Battle mode (C27).** Check several CLIs on a prompt node: one answer node
  per target; with battle ON and ≥2 successful answers, a 🏆 judge node
  (default claude/sonnet, configurable) compares the ANONYMIZED answers,
  picks the strongest and produces the merged answer — the model mapping is
  revealed in a legend after the verdict. Degrades gracefully to no judge
  with <2 answers.
- **Unified model picker (C29).** One `ModelPicker` shared by the graph
  fan-out (multi-select chips) and the agents' advanced create menu (single,
  Anthropic ∪ launch-config models): expandable provider sections
  (Anthropic / OpenAI / Gemini + local endpoints), a separator, and
  star-pinned favorites persisted in the app config (`providerId:modelId`
  keys, pin order). Frontier providers only appear when their CLI is
  detected on the machine (login-shell `command -v` / `Get-Command`, cached,
  re-detect button in Settings); frontier model lists are CURATED IN CODE
  (`FRONTIER_CATALOG`, the one constant to bump — the OAuth CLIs expose no
  dynamic listing) while local OpenAI-compatible endpoints (Ollama, LiteLLM,
  vLLM…) are discovered dynamically (`/v1/models`, Ollama `/api/tags`
  fallback). New Settings > Models section manages local endpoints (name,
  base URL, optional API key, discovered-model count). Local targets run as
  a new `cli:'local'` through a direct `/v1/chat/completions` call from the
  main process — the API key never reaches the renderer or a command line.
- **Provider API keys encrypted at rest (C29/D12).** Local-provider Bearer
  tokens go through Electron `safeStorage` (`provider-secrets.ts`, same
  cipher surface as scope secrets): the renderer only ever sends a transient
  `apiKey` when the operator (re)types one ('' = forget, ⊘ button) and only
  ever receives a `hasKey` marker — `config:get/set/changed` are sanitized;
  the config file stores `enc:<base64>` blobs (explicit `plain:` fallback
  when no OS keyring), decrypted in main memory only at discovery/inference
  time. A corrupt blob (OS key change) degrades to "no key stored".

## v0.7.0 -- 2026-07-16

The "briefed agents" batch (PLAN-context-et-snippets C20-C22): roadmap items
carry an implementation briefing that travels to the agent, a magic-wand
assistant drafts it for manual creations, and recurring operator prompts
become reusable snippets.

### Added (core: broker / server, v0.7.0)
- **Roadmap `context` field (C20).** `roadmap_items.context TEXT NOT NULL
  DEFAULT ''` (idempotent migration): the implementation briefing for the
  agent that will pick the item up later — objective, constraints/scope
  boundaries, file pointers, acceptance criteria, decisions already made
  (description = what, rationale = why, context = how/where). Settable
  through `/roadmap/upsert` (partial-patch semantics), preserved by
  archive and export/import. `roadmap_add`/`roadmap_update` expose it,
  `roadmap_get` shows it, and the MCP instructions ask agents to ALWAYS
  fill it (the agent that discovers a bug writes the briefing for the
  future agent that fixes it).

### Added (desktop, v0.8.0)
- **Context in the Deck (C20).** Item editor textarea with a
  semi-structured placeholder (Objective / Constraints / Pointers /
  Acceptance criteria), detail panel block, and the briefing travels as a
  delimited data field in both agent hand-offs: the C15 queue dispatch to
  the team-lead (`Context (operator briefing): ...`) and the "Launch an
  agent on this item" prompt. The plan-import agent (C7) is instructed to
  fill `context` for every item it creates, quoting the plan's specifics.
  The help-assistant snapshot includes it (truncated).
- **Context wand (C21).** 🪄 button on the editor's context field: one
  throwaway read-only `claude -p` (pinned haiku, same locked harness as
  the help assistant — code-constant system prompt, `--strict-mcp-config`,
  `--disallowedTools`) drafts the briefing grounded in the project files
  (Read/Grep/Glob), preserving the operator's draft decisions. The result
  only fills the textarea — nothing is saved until Save.
- **Snippets (C22).** Reusable prompts as one `.md` file each, global
  (`<globalConfigDir>/snippets`) or project
  (`<projectDir>/.claude/claude-peers/snippets`, shadows global on a name
  collision, shareable via git). New ⚡ tile button opens a menu that
  pastes the snippet into Claude Code's input field through xterm's
  bracketed-paste path — **fill-not-send**, never auto-submitted — plus a
  manage dialog (create / edit / rename / change scope / delete).

### Fixed
- `tests/desktop-template-store.test.ts` still asserted the pre-rename
  `claude-peers-desk` global dir (stale since the v0.7.0 desktop rename).
- `desktop/package-lock.json` re-synced with the `kory` bin alias.

## v0.6.0 -- 2026-07-15

The "AI orchestrator" batch (PLAN C6-C19): the Deck grows from a session
container into a cockpit for a small agent team — a designated team-lead, an
operator inbox, diff review, an activity journal, a dispatch queue, git
checkpoints, a resume digest, a template composer, and two security gates.

### Added (core: broker / server)
- **Targeted announce (C10).** `POST /announce` accepts `to_peer_id` to
  deliver a Deck message to ONE active peer of the group (the team-lead
  notification path); 404 when the target is missing/dormant. Same reserved
  `deck` sender and no-reply semantics.
- **Operator inbox (C12).** New reserved sentinel `__operator__`/`operator`
  (dormant, never listed, never purged; `set_id` refuses the name).
  `send_message` to `operator` parks the message on the sentinel in the
  sender's group; new `POST /operator-inbox` (TOFU group auth) drains and
  marks them delivered. `server.ts` MCP instructions present 'operator' as
  the human in front of the Deck (questions, results, blockers).
- **Roadmap dispatch queue (C15).** `roadmap_items.queue INTEGER NULL`
  (idempotent migration): 1-based dispatch-queue position, settable through
  `/roadmap/upsert` (positive integer or null), preserved by export/import.

### Added (desktop, v0.6.0)
- **Worktrees view (C6)** in the rail: every worktree with branch, dirty
  count, last commit and the attached Deck session; orphans can be resumed
  into a new session or removed (never forced, branch kept).
- **Plan import (C7).** "Import a plan" in the Roadmap view: a file picker
  plus a ONE-SHOT agent (code-constant prompt) that converts the plan into
  deduplicated roadmap items, then exits.
- **Team-lead (C10).** One 👑 per window (`SessionDef.lead`, uniqueness
  enforced, captured in workspaces/templates): create-menu checkbox
  (suggested by the configurable `leadPattern`), right-click designation,
  and `announceToLead` targeted notices.
- **"Needs you" detection (C11).** `attention.ts` spots Claude Code waiting
  screens (permission chooser, trust prompt) in the PTY stream: ⏸ badge in
  the sidebar/tile plus a clickable system notification (toggle
  `notifyAttention`).
- **Operator inbox (C12).** 10 s drain of `/operator-inbox`, per-batch
  system notification, ✉ rail button with unread bubble and a read-only
  panel (replies go through the existing megaphone).
- **Diff / review (C13).** `diff-service.ts` collects uncommitted changes
  plus branch-vs-main commits (worktrees, merge-base); DiffPanel from the
  Worktrees view or a session's right-click; "Have an agent review this"
  spawns a one-shot reviewer that reports to the team-lead via
  `send_message` when one is live.
- **Activity journal (C14).** In-memory ring buffer (500 entries) narrating
  spawns/exits, quota episodes, attention screens, worktree operations,
  announces, dispatches, reviews and checkpoints; filterable 📜 rail view
  with plain-text export.
- **Dispatch queue (C15).** Roadmap items can be queued (⏳ #n) and sent to
  the team-lead one by one (full item + status contract, code-constant
  message); when a dispatched item turns `done`, the next queued one is
  auto-dispatched (20 s watcher). Button greyed with an explanation while
  no lead is designated.
- **Git checkpoints (C16).** Before an agent spawns into a DIRTY tree:
  `git stash create` anchored under `refs/claude-peers/checkpoint-<ts>` (no
  history/working-tree pollution), journal entry with the sha and the
  `git stash apply` restore command, 7-day purge. Fresh worktrees skip it.
- **Resume digest (C17).** 📋 button in the help popup: one read-only
  `claude -p` briefing (C9 harness) grounded in the app snapshot plus
  configured sources (files/globs + commands). Sources are read from the
  GLOBAL config only (`digest.sources`, `digest.perProject[project_key]`) —
  never from a project config, which would mean arbitrary command execution
  on clone; commands still run with cwd = projectDir.
- **Template composer (C18).** Create/edit/duplicate templates WITHOUT
  spawning (manage mode of the template picker): per-entry advanced fields
  (agent, model, effort, args, initial prompt, fresh-worktree branch,
  announce, colour) and a single-lead crown; hierarchical rendering (lead
  top-center). Applying routes through the worktree-aware path, and the
  template's lead only becomes the window's when none exists yet.

### Security
- **Project launchCommand gate (C19).** A `launchCommand` carried by the
  repo's `.claude/claude-peers/config.json` no longer runs silently: a
  first-use warning dialog shows the command; approval stores its sha256
  per project_key in the app state (a changed command asks again), refusal
  falls back to the global command and persists nothing. Journal entry
  either way.
- The C8 code-constant rule extends to every new agent prompt (plan import,
  reviewer, dispatch message, digest, help) — none is operator- or
  repo-configurable.

## v0.5.0 (desktop) -- 2026-07-14

### Added
- **Supervisor session (PLAN C5).** A new **Home** rail view hosts a full-width
  Claude Code session that PILOTS the Deck instead of coding: it reads the
  repo, consults the shared roadmap, spawns briefed agent tiles and coordinates
  them through the existing peers messaging. Spawned lazily on the first Home
  visit (manual start button after an intentional close). Its role definition
  is **locked in the application code**: a system-prompt anchor
  (`--append-system-prompt-file`, re-passed on resume) regenerated from a code
  constant at every spawn (a tampered file is overwritten) plus a short C2
  kickoff prompt -- deliberately NOT operator- or repo-configurable (no
  `supervisor.md`, no agent profile), so a cloned repository can never
  silently repurpose the session that pilots the app.
- **deck-control bridge.** The main process starts a loopback HTTP control
  endpoint (random port + per-launch Bearer token, `deck-control.ts`) and the
  supervisor is the ONLY session launched with a generated `--mcp-config`
  pointing at a dependency-free MCP stdio server
  (`desktop/mcp/deck-control-mcp.ts`, built to `deck-plugin/mcp/*.mjs`, run by
  the Electron binary as Node). 14 tools: `deck_list_agents/models/presets`,
  `deck_spawn_session` (agent/model/effort/prompt/worktree_branch/announce),
  `deck_list_sessions`, `deck_restart_session`, `deck_close_session`,
  `deck_create_worktree`, `deck_list_worktrees`, `deck_remove_worktree`,
  `deck_list_templates`, `deck_apply_template` (append-only),
  `deck_save_template`, `deck_announce`.
- **Guardrails.** Destructive tools (close session, remove worktree) only work
  on objects the supervisor itself created; template application never
  replaces/closes existing tiles; live sessions are capped at 8 on
  `deck_spawn_session`; the control token never touches the repo, project
  config or normal sessions. `--mcp-config` is re-passed on resume (like
  `--effort`), and the supervisor is excluded from workspace/template capture
  (its token only lives for the current app launch).
  Tests: `tests/desktop-deck-control.test.ts` (dispatch, auth, guards, and an
  end-to-end MCP stdio round-trip against a live control endpoint).
- **Floating "?" help assistant (PLAN C9).** A floating button (all views)
  opens a chat popup where each question runs a throwaway `claude -p` with an
  app-generated system prompt: the code-constant role (C8 rule) plus the
  active view and a JSON snapshot of what it shows (roadmap items, session
  list). The assistant is TECHNICALLY read-only, not just prompt-constrained:
  `--strict-mcp-config` loads zero MCP servers and `--disallowedTools` denies
  every mutating tool (Read/Grep/Glob stay, so answers can be grounded in the
  repo). Popup continuity replays the last 4 exchanges; a start marker strips
  login-profile noise from the captured output. Options in Settings > General
  and via right-click on the button: hide it, pick the model (default
  `haiku`). New `desktop/src/main/help-assistant.ts` +
  `tests/desktop-help.test.ts`.

## v0.4.0 -- 2026-07-14

### Added
- **Shared per-project roadmap (broker, C3-M1).** New `roadmap_items` table in
  the broker SQLite DB and three routes: `POST /roadmap/list` (filters
  kind/status/priority/tag, archived hidden by default), `POST /roadmap/upsert`
  (create with defaults or partial patch; a status change away from `archived`
  restores the item) and `POST /roadmap/archive` (reversible soft delete via
  `deleted_at`). Items are scoped by `project_key` (normalized git remote), NOT
  by group, and carry no FK to peers/groups — `created_by`/`updated_by` are
  plain-text peer_id snapshots — so their lifecycle is fully independent of
  sessions: no cleanup timer touches the table (`tests/broker-roadmap.test.ts`).
- **Roadmap MCP tools (C3-M2).** `server.ts` exposes `roadmap_list` (MoSCoW-
  grouped overview), `roadmap_get`, `roadmap_add` (only title required),
  `roadmap_update` (partial patch) and `roadmap_archive`. Ids accept unique
  8-char prefixes. Author stamps use the session's peer_id automatically;
  repos without a git remote fall back to a stable `local:<hash>` project key.
  The MCP instructions now tell agents to consult the roadmap at task start,
  record discovered bugs/debt, and keep item statuses current.
- **Deck roadmap view (C3-M3).** New navigation rail (Agents | Roadmap) on the
  left of the window; the agents view stays mounted (PTYs/xterm alive) while
  the roadmap is shown. The roadmap view groups items by MoSCoW priority with
  value/effort/status badges and tags, filters by kind, optional archived
  display, a detail panel and full operator CRUD (`created_by='deck'`); it
  polls the broker every 5 s while visible so agent writes appear live. Main
  process `roadmap-service.ts` mirrors server.ts's project-key resolution
  (normalized git remote, else the same `local:<hash>` fallback) so the Deck
  and its agents always see the same roadmap (`tests/desktop-roadmap-service.test.ts`).
- **Launch an agent on an item (C3-M4).** The item detail panel can spawn a
  session pre-filled with a composed initial prompt (uses the C2 positional
  prompt) and a join announcement; the item is flagged `in_progress` at spawn
  and the agent is instructed to keep its status current via the roadmap tools.
- **Roadmap export/import (C3-M4).** `GET /roadmap/export?project_key=` returns
  a versionable JSON snapshot (archived included); `POST /roadmap/import`
  bulk-imports it preserving ids, statuses, authors and timestamps (re-keying
  to a target project supported). New CLI commands `bun cli.ts roadmap-export`
  / `roadmap-import` (the local -> central broker migration path). The CLI now
  sends the configured Bearer token on all requests.
- **Worktree sessions (C4).** The advanced create menu takes a worktree branch
  name: the Deck runs `git worktree add <projectDir>/.worktrees/<name> -b
  <branch>` and spawns the session inside it, so parallel agents on the same
  repo never step on each other (one dir + one branch each; the roadmap stays
  shared since `project_key` derives from the remote, identical across
  worktrees). The sidebar row shows a `⎇ branch` badge; closing the tile
  offers (never forces) to remove the worktree — the branch and its commits
  are always kept, and git's dirty-tree refusal is surfaced, not overridden.
  Optional `worktreeInit` command in the launch config (e.g. `bun install`)
  runs in the background inside each fresh worktree. New
  `desktop/src/main/worktree-service.ts` + `tests/desktop-worktree.test.ts`.

## v0.3.5 (desktop) -- 2026-07-14

### Added
- **Quota auto-resume (opt-in).** When a tile hits Claude's usage limit, the
  Deck now detects the rate-limit screen in the PTY stream (rolling
  ANSI-stripped buffer; old "limit reached ∙ resets 2pm", new "You've hit your
  limit · resets 10pm (TZ)" and "resets Nm" formats, plus conservative
  fallbacks), parses the printed reset time (local clock; >1h past rolls to
  tomorrow; unknown time retries every 15 min), and once it passes injects
  `Escape` → `continue` → `Enter` — one shot per episode, exactly what a human
  would type. Off by default: global toggle in Settings > General
  (`autoResumeQuota`), overridable per session from the sidebar right-click
  menu (`SessionDef.autoResume`). The tile/sidebar dot turns orange while
  limited, with an "auto-resume at HH:MM" badge and a toast on injection
  (`session:quota` IPC event). New `desktop/src/main/quota.ts` +
  `tests/desktop-quota.test.ts` (PLAN-v0.4 C1).
- **Initial prompt at spawn.** A session can now be created with a prompt that
  is submitted to Claude as its positional argument on the fresh launch —
  never re-played on resume (`--resume` restores the conversation). New
  "Initial prompt" field in the advanced create menu; launch presets'
  `prompt` field (declared since M5, previously unwired) now pre-fills it.
  Quoting is platform-aware (POSIX `'\''` vs PowerShell `''`), covered in
  `tests/desktop-launch.test.ts`. Groundwork for roadmap→agent and the
  supervisor (PLAN-v0.4 C2).

## v0.3.4 -- 2026-06-03

### Added
- **Deck outbound announcements (`POST /announce`).** The desktop Deck can now
  broadcast one-way, fire-and-forget system messages to every active peer in a
  group: an automatic join announcement (with the newcomer's `peer_id` and its
  agent/model/effort) when a session's peer_id resolves, and free-text operator
  messages from a sidebar message bar (Send button). Both go through a single
  `/announce` endpoint.
- **Reserved system sender.** Announcements are stored from a non-routable
  sentinel (`from_token = '__deck__'`, `from_peer_id = 'deck'`), backed by one
  permanently-dormant reserved peer row so the `messages.from_token` FK resolves.
  The reserved row never appears in `list_peers`/`group-stats` and is exempt from
  the dormant TTL purge.
- **No-reply guarantee.** `server.ts` renders any `from_peer_id == 'deck'` message
  with an English "informational only -- do not reply" framing (WS push, fallback
  poll and `check_messages`), neutralising the channel's default reply nudge.
  Replies are also impossible: `send_message` toward `deck` finds no active
  target. `set_id` refuses the reserved names `deck` / `system`.

## v0.3.2.1 -- 2026-05-16

### Fixed
- **Broker crash-loop on dormant-peer purge (FK violation).** `cleanStalePeers`
  and `handleUnregister` deleted a peer row without first clearing the rows in
  `messages` that referenced it via `from_token`. Both `messages.from_token`
  and `messages.to_token` are FKs to `peers.instance_token`, so any peer that
  had sent at least one message would crash the `DELETE FROM peers` with
  `SQLiteError: FOREIGN KEY constraint failed` (errno 787). On a long-running
  broker this surfaced as a restart loop once the first dormant-with-history
  peer hit the TTL cutoff. Both DELETE paths now run
  `DELETE FROM messages WHERE from_token = ? OR to_token = ?` before deleting
  the peer (previously only `to_token = ? AND delivered = 0` was cleared, which
  covered neither `from_token` nor delivered receive-side history).
- Semantic change to be aware of: a purged peer's message history is now
  removed in full (both sent and received, regardless of `delivered`). This is
  required by the FK and is consistent with the v0.3.x model where messages
  have no lifetime independent of their peers.
- Regression covered by `tests/broker-fk-cleanup.test.ts` (sender purge via
  TTL, and direct `/unregister` of a peer with sent messages).

## v0.3.2 -- 2026-05-15

### Added
- New opt-in env var `CLAUDE_PEERS_STATUS_LINE_CACHE` (default off). When set to
  `1`/`true`/`yes`/`on` (case-insensitive), `server.ts` writes the active
  `peer_id` to `$HOME/.claude/peers/peer-id-<cwd_key>.txt` after every
  successful `/register` (initial and on group switch). This is the file
  consumed by status-line scripts such as `~/.claude/status-line.sh:get_peer_id`.
  Off by default because the cache is only useful for users who wire a
  status-line and most users will not want `server.ts` to litter `$HOME`.
- New module `shared/peer-cache.ts` exposing `computeCwdKey()`,
  `isPeerIdCacheEnabled()`, and `writePeerIdCache()`. The key derivation matches
  the bash logic exactly: non-alphanumeric (and non-hyphen) chars replaced with
  `_`, last 40 chars kept, with an explicit offset to avoid the MSYS2 bash 5.2
  `${str: -N}` quirk. Best-effort writes (FS failures do not break `/register`).

### Removed
- **SessionEnd bash hook** (`hook-session-end-peers.sh`), its installer
  (`install-hook.ts` + `--uninstall` flag), and the now-unused broker endpoint
  `POST /disconnect-by-cli-pid` (and its `DisconnectByCliPidRequest`/`Response`
  types). Rationale: the hook never fired at a useful moment on Windows
  (Claude Code detaches the hook so `$PPID = 1`, never matched a real peer),
  and on Linux/macOS it only duplicated the work that `server.ts`'s
  SIGTERM/stdin EOF handler already does. The broker-side safety nets
  (`cleanStalePeers` every 30s for same-host PIDs, `sweepInactivePeers` every
  60s for stale heartbeats >120s) cover every realistic crash scenario. Worst
  case for a crashed cross-host peer: ~180s before it flips dormant.
- Test files dropped along with the hook: `tests/hook-session-end.test.ts`,
  `tests/install-hook.test.ts`, `tests/broker-list-peers-by-host.test.ts` (the
  latter was a v0.3.2-internal experiment that never shipped to main).

### Note on upgrade

If a previous v0.3.1 install registered the hook in your `~/.claude/settings.json`
under `hooks.SessionEnd`, that entry now points at a non-existent script and
will be a silent no-op. To clean it up, remove the entry and delete
`~/.claude/hooks/session-end-peers.sh` (or `hook-session-end-peers.sh` depending
on how it was installed). No data loss, no DB migration.

### Fixed
- **Bug C -- status-line `peer_id` segment empty or stale.** Previously,
  `~/.claude/status-line.sh:get_peer_id` read a cache that only the deleted v0.2
  SSH client (`client.ts`) used to write, so on v0.3+ status-lines either showed
  nothing (fresh cwd) or a stale id from a v0.2 session. Users who set
  `CLAUDE_PEERS_STATUS_LINE_CACHE=1` now get a fresh cache file refreshed on
  every `/register`.

## v0.3.1 -- 2026-05-14

### Added
- Auto-disconnect on Claude Code session end via three mechanisms:
  - SessionEnd hook (`hook-session-end-peers.sh`) POSTs `/disconnect-by-cli-pid`.
  - `server.ts` self-shutdown on stdin EOF.
  - Broker `sweepInactivePeers` safety net (60s timer, 120s stale threshold).
- New env vars: `CLAUDE_PEERS_ACTIVE_STALE_SEC` (default 120), `CLAUDE_PEERS_DORMANT_SWEEP_SEC` (default 60).
- New broker endpoint: `POST /disconnect-by-cli-pid`.
- New DB column: `peers.claude_cli_pid INTEGER`.
- Installer: `bun install-hook.ts` (idempotent, supports `--uninstall`).

### Changed
- Hook script is now bash (.sh), installed under `~/.claude/hooks/session-end-peers.sh`
  for consistency with other Claude Code hooks (kleos pattern). The installer
  (`bun install-hook.ts`) copies it from the repo to the user's hooks directory and
  registers a `bash <path>` command in settings.json.

### Removed
- SSH deployment mode and `client.ts` (use HTTP mode or local-only).
- `CLAUDE_PEERS_REMOTE` env var.
- `tests/server-handshake.test.ts`, `tests/client-config.test.ts`.

### Fixed
- Windows: `server.ts` `BROKER_SCRIPT` path resolution via `fileURLToPath` (local-only mode now works on Windows).
- Cross-host peers no longer flap to `dormant`: `cleanStalePeers` now restricts its `process.kill(pid, 0)` liveness check to peers whose `host` matches the broker's `os.hostname()`. Foreign peers (HTTP mode, client on another machine) are reaped via the heartbeat sweep instead. Previously, all remote peers were flipped dormant on every 30s tick because their Windows/macOS PIDs were probed against the Linux broker's process table.
- New env var `CLAUDE_PEERS_CLEAN_INTERVAL_SEC` (default 30) to tune the `cleanStalePeers` interval.
