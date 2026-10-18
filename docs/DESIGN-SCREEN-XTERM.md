# Écran main fondé sur xterm

Carte 9128a5d9. Proposition de conception, pas une autorisation de modifier les règles métier.

## 1. Problème et périmètre

Remplacer l'émulation de `screen-model.ts`, conserver les verdicts de HEAD et fermer la garde tant que le miroir n'a pas traité tout le flux reçu. Le remplacement est plus large qu'un changement de constructeur : `write` est asynchrone, un callback peut laisser une séquence ouverte, et les approbations lisent également cet écran.

La décision opérateur « C puis B » porte le remplacement du modèle avant la reprise des règles. Le premier lot ne corrige ni le brouillon numéroté e1370313, ni `attention.ts`, ni la définition d'un sélecteur. Il ne promet pas que le CLI acceptera une commande simplement parce que `pty.write` l'a écrite.

Légende : **MESURÉ** identifie une exécution avec commande et sortie ; **DÉDUIT** une lecture de source citée ; **SUPPOSÉ** une propriété non vérifiée. Les paragraphes marqués **Contrat proposé** sont des exigences de conception, non des garanties déjà livrées.

## 2. Structure actuelle

**MESURÉ** : `git -C C:/Users/Olivier/workspace/koryphaios rev-parse --short HEAD` donne `3b5c2fb`. `git -C C:/Users/Olivier/workspace/koryphaios status --short`, avant rédaction, donne ` M .claude/settings.json`. Cette modification ne fait pas partie du travail.

| Frontière | Lecture et conséquence |
|---|---|
| PTY vers consommateurs | **DÉDUIT**, `pty-manager.ts:130-132,230-257` : le spawn commence en 80×24 ; le préambule précédant le marqueur de démarrage peut être retiré avant l'événement `data`. Le miroir doit suivre le flux distribué, pas un second flux brut. |
| Distribution main | **DÉDUIT**, `session-service.ts:354-364` : `emit('data')` précède les détecteurs puis `screenGuard.feed`. Une invalidation nécessaire à une garde synchrone doit précéder la publication à des consommateurs réentrants. |
| Écran actuel | **DÉDUIT**, `screen-model.ts:26,188,267-327` : grille synchrone, création paresseuse 400×200, remplacement complet sur resize, suppression par id. `inspectInjectGuard` lit lignes, colonnes et curseur, pas l'ordre de peinture (`:197-254`). |
| Injections | **DÉDUIT**, `tile-injector.ts:116-156` : inspection avant ESC, attente de stabilisation, puis texte soumis sans nouvelle inspection. `session-service.ts:1726-1745` inspecte aussi pour `pause`, pas pour `hard`. |
| Autres lecteurs | **DÉDUIT**, `session-service.ts:889-909,1307-1308` et `index.ts:1294-1300` : fermeture gracieuse et réponses aux approbations consomment l'écran. Dans la branche non-permission des approbations, « aucun dialogue détecté » autorise ; remplacer un écran en retard par `null` ne constitue donc pas une fermeture suffisante. |

**DÉDUIT**, `TerminalTile.tsx:56-65,72-85,120-125` : le renderer possède son xterm, le redimensionne avant l'IPC PTY, reçoit les événements `data` et renvoie les réponses `onData` au PTY. Le miroir main ne doit jamais brancher ses propres réponses terminal sur le PTY : les deux émulateurs répondraient au même DSR.

**DÉDUIT**, `session-service.ts:594-595,634-644,854-866,928-941,1013-1022,1539-1549` : PTY utilitaires, arrêt global, suppression, restauration et respawn sont des frontières à traiter explicitement. L'id de tuile seul ne distingue pas deux vies successives ; les callbacks xterm devront capturer l'objet de vie, et non rechercher simplement le même id.

## 3. Options et recommandation

### Paquet

- **Option A : `@xterm/headless` 5.5.0.** Paquet dédié, dépendance supplémentaire et deux installations déclaratives à maintenir (desktop, tests racine). **DÉDUIT**, README du paquet installé `:3-5,23-25` : l'usage Node sans DOM est explicite, mais le paquet est annoncé expérimental ; dédié ne veut pas dire API stable. Portée limitée à l'adaptateur main. Retour arrière simple tant que les règles métier restent séparées. Risque principal : compatibilité de l'état privé nécessaire à la barrière syntaxique, commun aux deux options.
- **Option B : `@xterm/xterm` 5.5.0 sans `open()`.** Pas de nouvelle famille de dépendance ; version du moteur renderer réutilisée. **MESURÉ par la sonde §8** : construction et parsing sans DOM fonctionnent sous Bun. En revanche, cette mesure ne constitue pas un engagement amont sur l'usage serveur du paquet navigateur. Le paquet est aujourd'hui en `devDependencies`, pas une garantie de présence dans le main empaqueté (`desktop/package.json:38-48`). Même coût de migration asynchrone que A.

**Recommandation : A, headless 5.5.0 exactement.** La frontière explicitement sans DOM décide, pas une prétendue impossibilité de B : B fonctionne dans la sonde. Déclarer headless côté desktop pour le runtime et côté racine pour les tests. Épingler également le renderer sur la version effectivement comparée, 5.5.0 ; une montée de version doit revalider ensemble les moteurs et l'adaptateur privé. Ne pas installer `latest` implicitement.

### Fraîcheur et séquences coupées

- **Option A : lecture synchrone qui refuse tant que le miroir est indisponible.** Révisions soumises/appliquées, génération et barrière syntaxique locale. Préserve les contrats synchrones `pause` et classification ; coût de migration contenu. Peut refuser une action alors qu'un callback va bientôt arriver : dégradation visible, préférable à une injection dans un écran périmé.
- **Option B : propager `await drain()` dans tous les lecteurs.** Moins de refus transitoires, mais changement des contrats de pause, approbations et fermeture. L'attente peut être invalidée par un nouveau chunk entre deux continuations ; elle ne résout ni une séquence ouverte ni les deux écritures séparées de l'injecteur. Plus grande portée, retour arrière plus coûteux.

**Recommandation : A.** `drain()` est un outil de replay/test, pas un permis d'écrire obtenu à l'avance. Garder le résultat externe `clear | modal` pendant la migration et donner aux refus techniques une raison distincte, sans les confondre avec un vrai sélecteur.

### Reconnaître une séquence incomplète

- **Option A : petit adaptateur privé versionné.** Lire seulement le repos du parseur et du décodeur de chaînes ; champ absent ou forme inconnue ferme la garde avec trace. Très peu de code métier, mais dépendance assumée à des détails privés de 5.5.0.
- **Option B : second automate ANSI de framing.** Évite les champs privés, mais doit rester équivalent à xterm pour ESC/CSI/OSC/DCS, annulations, C1 et décodage. Une divergence silencieuse peut ouvrir la garde. Plus cher à maintenir ; réintroduit une partie du problème retiré.

**Recommandation : A, à ratifier explicitement.** Aucun accès privé ailleurs que dans un adaptateur isolé ; aucun appel à `writeSync`, aucune modification du parseur. Une API publique amont équivalente pourra remplacer cet adaptateur sans modifier les consommateurs. Ne pas livrer seulement la barrière de callbacks en attendant : elle est insuffisante, démonstration §8.

## 4. Contrat proposé : moteur et lectures

### Objet et API

Une entrée `ScreenGuard` représente **une vie PTY d'une tuile**, avec un objet propriétaire unique. Elle possède son Terminal, dimensions appliquées, compteurs `submitted`/`applied`, faute éventuelle, budget d'entrée, resize en attente et cache de snapshot. Ce n'est ni un état partagé par peer id, ni un cache par cwd. Aucun état ne survit au PTY.

Séparer trois surfaces :

1. **Écrivain** : création avec dimensions réelles, `feed(id, string)`, demande de resize, destruction. Une entrée absente ne renaît pas par un callback ancien. Tout flux d'une vie non initialisée reste indisponible.
2. **Lecture** : union explicite `ready(snapshot)` ou `unavailable(reason)`. Un snapshot contient génération, révision, dimensions, lignes copiées et curseur. Ne pas exposer les objets `IBufferLine` vivants.
3. **Règles** : `inspectInjectGuard(snapshot)` reste synchrone et conserve la décision métier de HEAD. La façade transforme `unavailable` en `modal` avec raison technique (`screen-pending`, `sequence-incomplete`, `resize-pending`, `screen-fault`, etc.).

`feed` invalide d'abord le cache et augmente `submitted`, avant tout événement externe. `Terminal.write` reçoit un callback capturant propriétaire et révision. Le callback d'une ancienne vie ne publie rien. Une lecture n'est `ready` que si : vie actuelle, aucune faute, `submitted === applied`, aucun resize en attente, parseur au repos et décodeur sans continuation. La copie des lignes peut être paresseuse, une seule fois par révision, plutôt que reconstruite à chaque chunk.

**MESURÉ**, §8 : en 5.5.0, `_core._inputHandler._parser.currentState` est accessible et vaut encore 1, 3 ou 4 après un callback d'une séquence coupée. **DÉDUIT**, source map du paquet installé, `src/common/input/TextDecoder.ts:49-95` : `StringToUtf32._interim` conserve un surrogate haut entre appels. Le contrat d'entrée reste `string`, comme le PTY actuel ; ne pas étendre implicitement à `Uint8Array` sans couvrir aussi son décodeur.

**Contrat proposé** : l'adaptateur ne déclare le repos que pour `currentState === 0` et `_stringDecoder._interim === 0`, après vérification de leur présence et type. Forme inconnue : faute durable de cette vie, diagnostic unique, jamais `undefined ?? 0`. Tests positifs et négatifs de cette capacité sur le vrai paquet.

Lecture des lignes : buffer **actif**, `getLine(baseY + y)` pour `0 <= y < rows`, `translateToString(true)`, curseur relatif `cursorY/cursorX`. Conserver les lignes vides pour la géométrie. `allowProposedApi: true`, `scrollback: 0`, pas d'addon DOM, pas de handler `onData` vers le PTY. Aligner les options de largeur Unicode avec le renderer ; ne pas introduire un addon Unicode dans un seul moteur.

**DÉDUIT**, typings headless `:917-1036` : le buffer actif distingue normal/alternate, le curseur est relatif à `baseY`, et les références de lignes ne doivent pas être gardées après mise à jour. Le main observe la page terminal courante, pas une position de scroll opérateur du renderer.

### Limite exacte de la garantie

**Contrat proposé** : `ready` signifie « tous les caractères reçus par le main pour cette vie ont été traités, sans continuation connue ». Cela ne signifie ni fin de frame applicative, ni TUI stable pour toujours, ni absence de données encore dans ConPTY, ni acceptation de la commande par le CLI. Un screen reader ne peut pas garantir ces événements futurs. Ne pas ajouter un délai arbitraire pour prétendre terminer une séquence ouverte.

## 5. Contrat proposé : cycle de vie et consommateurs

### Création, resize, destruction

- Initialiser le miroir à partir des dimensions **effectivement passées au spawn**, avant de distribuer ses premières données. Le chemin commun de spawn doit annoncer cette information au service ; ne pas dupliquer un autre défaut 400×200. Les PTY utilitaires doivent être explicitement couverts par ce chemin ou explicitement exclus des lecteurs automatiques, jamais créés paresseusement à une taille inventée.
- Valider dimensions finies, entières et positives avant toute mutation main/PTY. Un resize ferme immédiatement la garde et augmente `resizeEpoch`. Appliquer resize xterm et resize PTY dans le même tour synchrone, sans attendre un drain. Une opération soumise à xterm avant resize peut donc être parsée après lui, comme dans le renderer actuel ; ne pas prétendre préserver un ordre atomique octets/dimensions qui n'existe pas dans cette architecture.
- Après resize réel, ne réouvrir qu'après callback d'un write **soumis post-resize**, rattrapage de toute la file, repos syntaxique et géométrie valide ; un callback pré-resize ne suffit jamais. Employer `Terminal.resize`, pas recréer une grille : conserver les buffers normal/alternate et laisser xterm exécuter `?1049h/l`. Un resize identique est un no-op. Les erreurs de resize doivent être remontées par le propriétaire du PTY pour invalider le miroir, pas absorbées comme une réussite.
- À exit, kill/remplacement, restore et stop : retirer d'abord l'autorité de publication, annuler les travaux possédés, vider cache/file, appeler `dispose`. Répéter l'opération est sans effet. Un même id respawné possède une autre identité d'objet. Ne pas dépendre d'un callback final après `dispose` pour libérer l'état.

**Choix resize** : A, resize immédiat et epoch invalidant, conserve la commande PTY réactive et limite la portée au main ; risque résiduel, renderer et miroir peuvent parser des chunks de part et d'autre du resize à des instants différents. B, ordonner strictement octets et resize dans les deux moteurs, exige aussi un protocole renderer avec acquittements et change le chemin visuel ; coût et portée nettement supérieurs, migration moins réversible. **Recommandation : A pour ce lot.** Attendre seulement le drain du main tout en laissant le renderer redimensionner librement ne réalise pas B et peut affamer un flux continu. Tester les divergences de transition et conserver le refus post-resize ; si les captures démontrent une ouverture dangereuse malgré celui-ci, bloquer le lot et concevoir B, pas un délai correcteur. Aucune promesse d'identité pixel par pixel pendant la transition.

### Table de migration des lecteurs

| Lecteur | Modification contractuelle |
|---|---|
| `TileInjector.injectCommand` | Revalider juste avant ESC **et** après `settleMs`, immédiatement avant texte+Enter, sans `await` entre la dernière lecture et cette écriture. Capturer la vie PTY en entrée et vérifier qu'elle n'a pas changé. Réexaminer aussi attention/quota au second point. Conserver `refused-modal`, raison technique dans le log. |
| `SessionService.interrupt('pause')` | Garde synchrone fermée sur indisponibilité ; `hard` conserve son contrat destructif explicite. |
| `SessionService.remove` / fermeture gracieuse | Un état indisponible n'autorise pas `/exit` à l'aveugle. Conserver le repli vers destruction explicite ; recontrôler les écritures différées de la séquence de fermeture, pas seulement son entrée. |
| `screenLines` puis approbations dans `index.ts` | Remplacer la lecture nullable par le résultat de disponibilité. Sur `unavailable`, tenir/refuser selon la fenêtre de dépôt existante, pour permission **et** non-permission. Ne jamais appeler `permissionDialogShown(null)` comme preuve d'absence. Revalider à la dernière écriture si le chemin contient une attente. |
| `attention.ts`, quota, startup ack, entrées humaines | Ne pas convertir ces mécanismes dans ce lot. Leur flux actuel reste distinct ; le miroir ne devient pas un filtre global de toutes les touches. Documenter cette portée, sans prétendre que chaque `pty.write` du produit est maintenant protégé. |

## 6. Contrat proposé : bornes et pannes

Le scrollback nul borne l'historique de lignes, pas la file d'entrée ni les chaînes OSC/DCS partielles.

**MESURÉ par le test-engineer**, `bun C:/Users/Olivier/AppData/Local/Temp/xterm-probe-9128a5d9/overflow.mjs` : empiler des blocs sans rendre la main provoque `error: write data discarded, use flow control to avoid losing data`. Avaler cette erreur puis classifier l'écran donnerait une autorisation fondée sur des données perdues.

**Contrat proposé** : borne en unités UTF-16 et compte de chunks, avant admission à xterm ; réserve globale du service et réserve par vie. Point de départ à valider : 1 Mi d'unités en attente par tuile, 8 Mi globalement, 4096 chunks par tuile, 1 Mi d'unités reçues sans retour du parseur au repos. Les plafonds ne sont pas des mesures de charge normale. Un chunk trop grand est refusé avant appel, pas découpé pour contourner le budget. Borner aussi les cellules allouables ; au-delà du plafond convenu, miroir indisponible sans empêcher l'opérateur d'utiliser son terminal visible.

Sur dépassement, exception de `write`, lecture impossible ou callback local défaillant : fermer immédiatement cette vie, libérer l'émulateur, tracer via `reportError('screen', ...)` une fois par faute. Ne pas réinitialiser automatiquement sur le chunk suivant : un suffixe de flux ne reconstruit pas l'état terminal perdu. Réactivation par nouveau PTY ; une récupération sur repaint demanderait un protocole séparé et prouvé. Les données continuent vers renderer/détecteurs tant que le PTY vit.

Le retard normal ferme la garde sans journaliser chaque chunk. Une faute durable est une erreur de fond au Journal, pas une rafale de toasts. Tests exigés : aucune exception sortant du handler PTY pour les entrées adverses spécifiées, diagnostics présents et aucune publication par callback ancien. **SUPPOSÉ** : l'absence universelle de bug interne asynchrone dans xterm n'est pas démontrée ; un `try/catch` autour de `write` ne capture pas une exception ultérieure dans son propre timer. Les filets process existants ne doivent pas être remplacés par un catch global qui continuerait avec un miroir douteux.

## 7. Dépendances et réalisation

**DÉDUIT**, `package.json:15-26`, `desktop/package.json:31-49` : le dépôt a deux manifests ; xterm navigateur est déjà déclaré aux deux niveaux. **DÉDUIT**, `.github/workflows/desktop-build.yml:85-93` : l'installation racine est distincte de celle du desktop. Déclarer headless aussi aux tests racine ; ne pas déplacer les tests purs vers l'intégration seulement pour cacher une dépendance manquante.

**MESURÉ par le test-engineer** : import nommé accepté sous Bun, mais import ESM nommé direct refusé sous Electron/Node par `SyntaxError: Named export 'Terminal' not found`. Le bridge de module doit donc utiliser l'interop CJS vérifiée (`import headless from '@xterm/headless'`, puis `Terminal`), ou un `require` typé. **DÉDUIT**, `desktop/tsconfig.node.json:24` : `esModuleInterop` est activé. Le résultat du bundler reste à vérifier, pas à déduire du seul test Bun.

### Lots proposés

1. **Adaptateur et preuves** : paquet exact, bridge CJS, snapshots, détection du repos, faute et limites. Tests du vrai moteur et de callbacks contrôlés. Pas de raccordement automatique tant que le paquet empaqueté et l'état privé ne sont pas prouvés.
2. **Raccordement atomique des consommateurs** : vie PTY/dimensions, distribution avant publication, resize, injecteur aux deux sinks, pause, fermeture et approbations. Retirer l'émulateur maison. Faire migrer les tests synchrones avec le moteur dans le même lot ; ne pas livrer un intervalle où des lecteurs considèrent un buffer ancien comme actuel.
3. **Qualification et retrait des compatibilités** : captures, adverses, charge, cycle de vie, artifact Electron ; aucune dérive silencieuse du manifeste. Le séquenceur exécute une seule fois le gate global du lot. Les exécutants ne lancent que leurs fichiers ciblés.
4. **Règles ultérieures** : reprendre e1370313, puis la convergence des observations de `attention.ts` et 25165245 avec leurs propres critères. Pas d'élargissement implicite du lot 9128a5d9.

Fichiers de tests à migrer identifiés par AiDex, puis à revalider sur l'arbre lors de la réalisation : `desktop-screen-model.test.ts`, `desktop-inject-command-modal-guard.test.ts`, `desktop-attention.test.ts`, `desktop-osc.test.ts`, et le lecteur `desktop-approval-defer.test.ts`. Les assertions métier restent ; les helpers de replay deviennent asynchrones et attendent aux checkpoints, jamais avec un sleep fixe. Ajouter les tests négatifs `pending -> refus`, `partial -> refus`, `fault -> refus`, callback d'ancienne vie, resize pendant parsing et second sink après ESC.

## 8. Mesures et qualification restante

Les sondes sont hors dépôt dans `C:/Users/Olivier/AppData/Local/Temp/xterm-probe-9128a5d9/`. Aucun `npm install` dans `desktop/` n'est autorisé pour ces mesures. Les fichiers jetables ne sont pas les futurs tests de régression ; la réalisation devra en conserver les comportements dans les tests versionnés.

### Mesures décisives

- **MESURÉ par le test-engineer**, `bun install --cwd C:/Users/Olivier/AppData/Local/Temp/xterm-probe-9128a5d9` : `+ @xterm/headless@5.5.0` et `+ @xterm/xterm@5.5.0`. Bun 1.3.13. **MESURÉ par ses commandes** `bun C:/Users/Olivier/AppData/Local/Temp/xterm-probe-9128a5d9/smoke.mjs headless` et `bun C:/Users/Olivier/AppData/Local/Temp/xterm-probe-9128a5d9/smoke.mjs xterm` : les deux se construisent et parsèment sans DOM ; `SYNC after write(no cb): row0 = "" cursorX = 0`, puis après callback `row0 = "hello" cursorX = 5`. La file est réellement asynchrone.
- **MESURÉ, rejoué par l'architecte**, `bun C:/Users/Olivier/AppData/Local/Temp/xterm-probe-9128a5d9/guardcmp.mjs` : `fixtures compared 31 verdict points 73` puis `xterm != manifest: 0 | xterm != model (state): 0 | rule differs (incl. same state): 0`. Le compteur de règles concerne les checkpoints ; les 73 états incluent les fins. Ce résultat ne mesure pas encore les nouveaux refus de disponibilité ni les resizes en cours de flux.
- **MESURÉ, rejoué par l'architecte**, `ELECTRON_RUN_AS_NODE=1 C:/Users/Olivier/workspace/koryphaios/desktop/node_modules/electron/dist/electron.exe C:/Users/Olivier/AppData/Local/Temp/xterm-probe-9128a5d9/split.mjs` : `runtime node-like v24.18.0 | electron 43.1.1` ; `A2 mid-CSI state = 4 (row0 before J: "keep" ) after J row0 = "" state after = 0`. Le callback est passé alors que l'effacement reste incomplet. OSC et surrogate coupés sont aussi recollés dans cette sonde.
- **MESURÉ par le test-engineer**, `bun C:/Users/Olivier/AppData/Local/Temp/xterm-probe-9128a5d9/fixtures.mjs` : `TOTAL files 32 rows 767 headless!=renderer rows 0 headless!=model rows 7 cursor diff h/r 0 h/m 1`. Les deux xterm coïncident sur ce corpus ; la grille maison diffère. Le manifeste de verdicts ne couvre que 31 fichiers, conformément à l'exclusion actuelle du replay : ne pas confondre les deux ensembles.

### Coût exploratoire, pas un seuil déjà accepté

**MESURÉ par le test-engineer**, commandes `bun C:/Users/Olivier/AppData/Local/Temp/xterm-probe-9128a5d9/cost.mjs headless N 20`, avec `N` égal à 1, 8 ou 32, corpus de captures répété par tuile, 120×40, scrollback 0 :

| Tuiles | Volume déclaré par la sonde | Temps total | RSS en charge | Delta RSS/base |
|---:|---:|---:|---:|---:|
| 1 | 4,1 Mo | 114 ms | 215,8 Mo | +61 Mo |
| 8 | 33,2 Mo | 500 ms | 245,0 Mo | +90 Mo |
| 32 | 132,8 Mo | 1755 ms | 345,5 Mo | +191 Mo |

Les volumes comptent les caractères du corpus, pas une mesure du débit réseau UTF-8. RSS inclut le runtime, corpus, allocations transitoires et terminaux ; diviser le delta par N ne donne pas la mémoire résidente d'une tuile.

**MESURÉ par le test-engineer**, comparaison complémentaire à dimensions égales, commandes `bun C:/Users/Olivier/AppData/Local/Temp/xterm-probe-9128a5d9/cost.mjs headless 32 20` et `bun C:/Users/Olivier/AppData/Local/Temp/xterm-probe-9128a5d9/cost.mjs model120 32 20`, deux passages : headless 1882/1671 ms, CPU user 1891/1906 ms, RSS 348,3/347,8 Mo ; modèle 2752/2785 ms, CPU user 2563/3015 ms, RSS 295,3/288,0 Mo. Le premier comparatif au modèle par défaut 400×200 n'est pas une comparaison à dimensions égales. Ces deux passages ne suffisent pas à établir un budget de production.

**MESURÉ par le test-engineer**, `bun C:/Users/Olivier/AppData/Local/Temp/xterm-probe-9128a5d9/lifecycle.mjs headless 100` : `after 100 cycles heap=5.4MB rss=190MB`. **SUPPOSÉ** : absence de fuite durable non prouvée ; une autre sonde garde un heap élevé après dispose et n'a pas départagé rétention par le harnais et GC différé.

### Plan de qualification et seuils proposés

1. Rejouer captures à leur chronologie et dimensions, puis rafales de redessin plein écran, en 1/8/32 tuiles. Deux tailles au minimum : 120×40 et 240×80. Mesurer le vrai adaptateur avec copie/lecture des snapshots, et le main Electron avec renderer actif, pas seulement le parseur sous Bun. Cinq répétitions après échauffement ; isoler baseline et delta.
2. Mesurer CPU user+system, RSS/heap au repos/en charge/après destruction, délai réception->snapshot prêt, retard de boucle main p95/p99 et délai resize. Exercer stop/respawn pendant charge et cycles create/feed/dispose avec références relâchées. Les lectures du détecteur font partie du coût.
3. **Seuils proposés à ratifier** : zéro donnée perdue silencieusement, zéro ouverture sur état indisponible, zéro divergence de verdict non expliquée ; à charge interactive 8 tuiles, p99 réception->prêt et retard main < 50 ms ; à 32 tuiles, < 100 ms. Pour le corpus borné ci-dessus, sur la même machine : CPU total ≤ 1,5 fois le modèle à dimensions égales, delta RSS supplémentaire ≤ 96 MiB à 32 tuiles. Après échauffement de cycles identiques : hausse heap retenu ≤ 1 MiB par 100 cycles sur trois lots. Ne pas imposer ces temps à la CI comme des sleeps/timeout métier.
4. Si budget dépassé : optimiser fréquence de snapshot et admission avant d'introduire un worker. **Alternative** worker par service, non par tuile : protège la boucle main mais ajoute protocole, identité et retard de publication. À ouvrir uniquement sur mesure ; ce serait un lot architectural supplémentaire, pas un détail du remplacement.

## 9. Acceptation fonctionnelle et suite des cartes

**Contrat proposé** : conserver `tests/_fixture-verdicts.ts` comme oracle explicite de HEAD. Tout écart est listé fixture/checkpoint/avant/après/raison et validé séparément, jamais accepté par régénération massive du manifeste. Vérifier la totalité du domaine de fixtures, dont les exclusions intentionnelles ; un nouveau fichier non classé doit faire échouer le test de couverture.

Reprendre le patch adverse `C:/Users/Olivier/.agent-forge/scratch/e1370313-attempt3.patch` comme **source de scénarios**, pas comme code à réappliquer : ED0/ED1 préservent les portions de ligne appropriées, IL/DL déplacent la géométrie, sortie de `?1049` retrouve le picker principal. Les assertions de `rowStamp/cellStamp` du patch sont internes à l'ancienne tentative et ne doivent pas être simulées par des stamps de callbacks. Ajouter découpage à chaque frontière de ESC/CSI/OSC/DCS, surrogate haut/bas, `CSI 1.5 L`, resize pendant backlog, vie remplacée avant callback et dépassements de budget. Vrais sélecteurs : toujours refusés.

**DÉDUIT**, patch adverse `:401-448,505-548` et `screen-model.ts:226-250` : les tests d'ordre de peinture visaient une nouvelle règle, alors que HEAD refuse tout picker visible. Changer d'émulateur ne démontre pas comment distinguer un écho numéroté d'un picker qui ressemble à cet écho. e1370313 doit retrouver ses trois captures numérotées et ses contre-exemples synthétiques, puis faire l'objet d'un choix de règle distinct. Ne pas réintroduire une émulation des déplacements de stamps à côté de xterm.

Pour `attention.ts` : observer ensuite des snapshots prêts, avec temps/révision d'observation et sémantique explicite lors d'indisponibilité. Conserver dans le premier lot le détecteur de flux existant. La carte 25165245 garde son propre oracle : première peinture trust réellement visible avant réponse, délai D, neuf captures en horloge virtuelle, aucun événement tardif entre réponse et vrai chooser. Le xterm main est un support de cette conception, pas une preuve que le problème lexical « folderEnter » ou la cadence D est corrigé. Ne pas modifier D, latch et garde d'injection au nom de cette carte.

## 10. Décisions ouvertes et limite de livraison

À ratifier par le superviseur/opérateur avant réalisation : **headless exact 5.5.0 avec adaptateur privé à échec fermé**, et **budgets de qualification proposés**. Le choix recommandé est explicite ; aucune nécessité d'un nouveau moteur maison n'est démontrée.

Restent des preuves de réalisation : import dans l'artefact Electron réellement construit/empaqueté, couverture de la barrière syntaxique (dont décodeur), resize couplé PTY/moteur, charge interactive et rétention après dispose. `ELECTRON_RUN_AS_NODE` prouve le chargement par le runtime Electron sans DOM, pas le packaging ni la réactivité d'un Deck ouvert.

Aucune suite globale, aucun smoke build global, aucun typecheck global ni installation dans desktop n'appartient à cette conception. Le gate global appartient au séquenceur au moment du lot de code.

### Résultat du challenge indépendant

La thèse initiale « callback + compteurs suffisent » est **réfutée**, et n'est pas la recommandation de ce document. Le reviewer a aussi reproduit la seule inspection avant les deux écritures et signalé l'ouverture de la branche d'approbation non-permission sur écran absent. Les corrections de conception sont la barrière parser+decoder, la revalidation au second sink, la disponibilité typée et l'identité de vie. Son objection au resize différé a conduit au choix immédiat avec epoch et limite explicite ci-dessus. Sa demande de provenance de peinture concerne e1370313 : elle n'est pas intégrée à 9128a5d9, qui conserve les refus conservateurs de HEAD.

**DÉDUIT, relecture indépendante du présent brief §3-6 et §9** : « Aucun bloqueur de conception résiduel [...] la variante viable est rendue sans contradiction, et la provenance de peinture est correctement sortie de 9128a5d9 vers e1370313. » Ce verdict porte sur la cohérence de conception, pas sur une réalisation absente.

**MESURÉ par le reviewer**, `bun test ./tests/desktop-tile-injector.test.ts` : `11 pass`, `0 fail`, `35 expect() calls`. `bun test ./tests/desktop-screen-model.test.ts` : `42 pass`, `0 fail`, `86 expect() calls`. Ce sont des baselines du code actuel, pas une validation du design à implémenter. Ajouter `desktop-tile-injector.test.ts` aux fichiers ciblés du lot.

### Sources amont consultées

- https://xtermjs.org/docs/guides/flowcontrol/ : file asynchrone et saturation.
- https://xtermjs.org/docs/guides/hooks/ : callback après traitement d'un chunk, distinct d'une séquence complète.
- https://github.com/xtermjs/xterm.js/issues/6234 : demande d'exposition publique du repos syntaxique ; une discussion amont n'est pas une API livrée en 5.5.0.
- Sources 5.5.0 `src/common/parser/EscapeSequenceParser.ts`, `src/common/InputHandler.ts`, `typings/xterm-headless.d.ts` ; extraits pertinents consultés, pas revue exhaustive de xterm.
