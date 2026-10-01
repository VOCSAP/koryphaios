# Avatar A2 : machine d'états de la fenêtre et de ses positions

Statut : **conception proposée pour `db34d743`**, sur mandat du team-lead. Aucun code de production livré par cet ADR. L'activation reste interdite avant clôture de cette carte, puis relève de L3.

Convention de lecture : **DÉDUIT / prescription** identifie une décision de conception fondée sur les sources citées, pas une garantie déjà implémentée. Les tables de transitions et de garde sont normatives. **MESURÉ** désigne uniquement les commandes effectivement exécutées ci-dessous. **SUPPOSÉ** désigne une propriété non vérifiée. Les constats concernent l'arbre de travail lu le 2026-10-01, pas un commit supposé immuable.

## Problem framing

DÉDUIT : le gestionnaire de fenêtre, le contrôleur de position et la présentation portent des états séparés (`avatar-window.ts:190-199`, `avatar-position-controller.ts:23-28`, `avatar-presentation.ts:59-64`). Le problème n'est pas seulement l'annulation de promesses : une demande de position n'est pas une position appliquée, et une préférence enregistrée n'est pas l'autorité courante.

DÉDUIT / prescription : concentrer la politique de création, visibilité, verrouillage et position dans **un réducteur pur main**. Electron, timers, publication et fichier deviennent ses adaptateurs. Conserver `AvatarState` comme unique autorité A1 des faces ; cette machine ne calcule aucune activité, aucun compteur et aucun visage.

### Rapport au contrat 003

DÉDUIT : 003:54,74,84-100 exige déjà une autorité main, la garde de mobilité, la recréation et une fermeture utilisateur équivalant à masquer. Le présent ADR précise leur réalisation ; il ne change ni les sept faces, ni `AvatarViewApi`, ni les options de sécurité, ni les règles de mouvement, ni la frontière Windows.

DÉDUIT / prescription : **précisions contractuelles explicites**, à appliquer conjointement avec 003 :

1. « Persistance vidée à la fermeture » (003:86) signifie écrire les positions **déjà appliquées**, jamais appliquer une demande encore en attente pendant une fermeture, un crash ou un quit. Le `flush()` actuel ne peut pas conserver sa sémantique move-puis-persist.
2. Le crash conserve l'intention `visible` et ne recrée rien automatiquement. La phrase de 003:96 sur la recréation lors d'un crash se lit avec sa dernière phrase : la nouvelle création attend **Afficher**. Un reload explicite peut recréer immédiatement, sans changer `visible`.
3. « Zéro persist » dans les cas d/e de la carte signifie zéro persistance **de la position refusée**. Masquer, fermer ou verrouiller doit néanmoins enregistrer le réglage correspondant. Un fichier unique peut contenir `visible:false` et une ancienne position P1 légitimement appliquée.
4. La promotion autorise l'identité IPC avant son premier envoi de snapshot, mais pas le mouvement avant l'état prêt. Une requête initiale `getState()` arrivant pendant le chargement attend cette promotion ou échoue sur invalidation ; elle n'obtient pas un accès privilégié à une fenêtre future.
5. « Créer le contrôleur après obtention du singleton et initialisation du serveur » (003:92) se lit comme une contrainte sur la **fenêtre**, pas sur l'objet réducteur. Écart nommé : dans `startAvatar`, `assembleAvatar` construit le contrôleur avant `startAvatarServer`, parce que le serveur consomme l'état A1 créé par le même assemblage. Ce contrôleur n'émet aucune allocation de fenêtre avant `RestoreRequested` (§9), émis après le registre et le Tray ; le Tray, seule source de `ShowRequested`/`ReloadRequested`, est lui-même créé après le registre. Toute émission plus précoce d'un de ces trois événements rouvrirait l'écart.

DÉDUIT / prescription : ces précisions ne doivent pas être présentées comme un changement silencieux de 003. **LIMITE NOMMÉE du cas c : unicité prioritaire sur restauration en double panne.** Le cas c garantit une recréation après échec de publication/show si l'ancienne ressource peut être détruite ou attestée détruite. S'il y a aussi échec de destruction et impossibilité d'attester sa disparition, la machine reste révoquée plutôt que violer « au plus une fenêtre vivante » : current=null, trace et aucune nouvelle allocation. Ce cumul de pannes est testé séparément et ne doit pas être dissimulé dans la formule « recréation toujours possible ».

DÉDUIT, provenance de décision : cet arbitrage a été **ratifié par le team-lead `desktop-7b2civn-koryphaios-2` dans son message du 2026-10-01 à 13:43:04Z**. Le watchdog à 2 s peut confirmer une disparition dont closed a été manqué ; si la ressource reste vivante, un retry explicite est nécessaire, sans contourner la preuve de disparition. Aucune édition de 003 ni de la carte n'est effectuée ici.

## Current structure

Tous les chemins abrégés de cette section sont sous `desktop/src/main/`.

| Constat | Provenance et raisonnement |
| --- | --- |
| DÉDUIT : promotion non transactionnelle | `avatar-window.ts:298-313` affecte `window = next` avant `onGeneration` et `showInactive`, mais le catch ne retire que `pendingWindow` ; une exception après promotion peut donc laisser `current()` non nul. |
| DÉDUIT : close ne remonte pas l'intention | `avatar-window.ts:279-285` appelle seulement `hideWindow`; `avatar-entry.ts:102-108` autorise le mouvement d'après `appearance`, objet distinct. |
| DÉDUIT : dette appliquée perdue | `avatar-position-controller.ts:44-50` exige encore `canApply()` et `applied == latest` pour persister ; hide/lock ou une nouvelle demande peuvent effacer l'écriture d'un move réussi. |
| DÉDUIT : faux succès et autorité disque | `avatar-window.ts:346-348` fait un no-op sans fenêtre ; `avatar-entry.ts:78-91` publie pourtant la position. `avatar-appearance.ts:140-147` relit le disque et renvoie un état complet, réassigné dans l'entrée (`:86,154`). |
| DÉDUIT : troisième copie de présentation | `avatar-presentation.ts:59-64,77-81,103-106` conserve et modifie sa propre apparence. `avatar-bootstrap.ts:18-27` instancie cette copie. La projection explicite des données A1 (`avatar-presentation.ts:24-54`) est, elle, réutilisable. |

DÉDUIT : `avatar-window.ts:91-117,155-180` vérifie l'objet `webContents`, la frame principale et les arguments ; `:128-153` borne les diagnostics renderer. Ce bridge doit être conservé et raccordé à la nouvelle autorité, pas réécrit en contrôle de fenêtre arbitraire.

DÉDUIT : `avatar-entry.ts:173-190` séquence nettoyage IPC, flush, destruction et release A1. La nouvelle fermeture doit rester à ce point d'assemblage, sans déplacer la responsabilité de libérer serveur, registre ou singleton dans le réducteur.

## Options

| Option | Coût, risque, réversibilité et rayon d'impact |
| --- | --- |
| **A : conserver deux contrôleurs, partager un getter et ajouter des callbacks** | DÉDUIT / évaluation : moins de changements initiaux ; il faut pourtant ajouter identité de fenêtre, acquittement du move, invalidation et dette d'écriture au contrôleur de position, puis synchroniser la présentation. Les chemins lus ci-dessus répartissent déjà ces obligations. Risque de retrouver la même politique dans plusieurs callbacks ; petits patches réversibles, mais dépendances croisées difficiles à auditer. |
| **B : un réducteur pur et un interpréteur local d'effets** | DÉDUIT / évaluation : remplacement borné de la politique L1 et adaptation de la présentation/persistance. Davantage de travail initial ; une table permet de traiter les courses sans exécuter Electron. Risque déplacé vers le câblage de l'interpréteur, donc tests d'intégration injectée obligatoires. Réversible tant que la fenêtre reste dormante ; aucun changement Deck, broker, A1 ou peau. |

## Recommendation

**DÉDUIT / prescription : retenir B.** La force décisive est la séparation entre intention, opération exécutée et résultat durable. Un getter partagé ne porte ni l'identité de l'objet déplacé ni la dette de persistance. Ne pas introduire de bibliothèque de machines d'états : une union discriminée, une fonction de réduction et un interpréteur injectable suffisent à exprimer ce contrat.

DÉDUIT, avis délégué et non mesure rejouée : le challenge indépendant du peer debugger `desktop-7b2civn-koryphaios-5` rend **TIENT sous conditions**. Ses objections sont intégrées : position appliquée indexée par token, aucun no-op natif crédité comme succès, événement natif distinct d'un résultat d'effet, destruction sans attente silencieuse infinie. Ce verdict ne prouve pas l'implémentation.

## Target design & migration path

### 1. Une autorité et des adaptateurs sans politique concurrente

DÉDUIT / prescription, fondement : frontières de 003:40-58 et copies relevées ci-dessus.

```text
Menus / IPC authentifié / callbacks natifs / résultats d'effets
                              |
                 dispatch sérialisé en main
                              |
            reduce(state, event) -> {state, effects, reply}
                              |
          interpréteur : registre token -> ressource native
             /          |           |             \
        Electron      timers     snapshot disque   publication
                                                  /         \
                                                Tray      AvatarView

AvatarState A1 -> un summary par rafraîchissement -> projection existante
État du réducteur -> présentation de cette même publication
```

DÉDUIT / prescription : le réducteur ne reçoit ni `BrowserWindow`, ni callback, ni promesse, ni timer, ni accès disque, ni horloge implicite. L'heure, la topologie et les données externes nécessaires sont des valeurs d'événements. L'interpréteur exécute des commandes ; leurs résultats reviennent sous forme d'événements, **sans relire `isVisible()`, la position native ou le fichier comme autorité**. Un acquittement prouve uniquement que la commande a réussi selon l'adaptateur, pas une vérité nouvelle choisie par Electron.

| Partie de l'état | Contrat normatif, DÉDUIT / prescription |
| --- | --- |
| `appearance` | Snapshot validé une fois au démarrage : `visible`, verrouillage, autres préférences et positions mémorisées. Toutes les modifications ultérieures passent par des événements. Un échec d'écriture ne remplace jamais ce snapshot par des défauts disque. |
| `lifecycle` | Union décrite ci-dessous ; aucune paire indépendante `window/pendingWindow/creating/disposed`. Le registre natif ne contient que la ressource détenue par cette union. |
| Identités | `windowToken` monotone dans la vie du contrôleur, jamais réutilisé, alloué avant `Create`. Il sert de `generation` publique lors de la promotion ; les trous de numérotation sont licites. `operationId` pour chaque effet acquitté, `moveEpoch` et `timerId` pour les échéances. Les callbacks natifs capturent le token seulement ; ils n'inventent pas un numéro d'opération. |
| Position | `requested` = dernier déplacement admis, avec token, epoch et placement borné. `applied` = dernier placement exécuté pour **ce token**. `appearance.positions` = positions applicables à la restauration, mises à jour seulement après application réussie. `persisted` = révision/snapshot dont l'écriture a réussi, jamais l'égalité avec la dernière demande. |
| Publication / durabilité | `viewRevision` croît pour toute publication. `appearanceRevision` croît à toute modification persistable ; une seule écriture de snapshot complet à la fois et une dette bornée, représentant l'état le plus récent, pas une file de patches. Un timer de move et un timer de persistance au maximum. |

**Identité et multiplicité.** DÉDUIT / prescription : le token identifie une tentative d'objet natif dans **ce contrôleur**, pas un écran, un humain, un Deck ou un chemin. À deux callbacks d'objets successifs, leurs tokens restent distincts. La barrière de destruction limite le registre à une ressource vivante ; aucun singleton global indexé par PID ou chemin n'est ajouté. Le registre d'écran existant garde ses clés d'écran, sans prétendre qu'elles constituent une identité physique permanente (003:100).

### 2. États, commande courante et exécution

DÉDUIT / prescription : les états du cycle de vie sont les suivants. Les sous-étapes de `loading` et `promoting` sont discriminées, pas des booléens optionnels combinables arbitrairement.

| État | Ressource et droits |
| --- | --- |
| `unavailable` | Plateforme non Windows ou activation non accordée. Aucun effet de fenêtre ; les réglages et le Tray peuvent fonctionner. |
| `absent` | Aucun objet détenu, restauration autorisée sur demande explicite. Inclut l'absence après crash ; `visible` peut rester vrai. |
| `loading(token, allocating | document)` | Token réservé puis objet créé caché ; chargement unique en cours. Pas de mouvement renderer, pas de `showInactive`, pas de `current()`. |
| `promoting(token, prepare | publish | show)` | Document chargé ; identité promue pour les lectures IPC. Placement initial et options main, premier snapshot, puis éventuel show, **dans cet ordre et acquittés séparément**. Mouvement renderer encore refusé. |
| `ready(token)` | Objet courant ; visible ou caché selon `appearance.visible`. Mouvement admissible uniquement si visible et non verrouillé. |
| `retiring(token, destination, retirementId)` | Objet révoqué : `current() === null`, aucun move ni show autorisé. Seuls destruction, constat de disparition et écriture de dette appliquée subsistent. Destination = absent, remplacement ou arrêt. |
| `stopped` | Arrêt terminal sans ressource ; aucune demande ne réactive la fenêtre. Les acquittements retardés ne recréent rien. |

DÉDUIT / prescription : `current()` est une projection de `promoting | ready` vers le handle du **même token**, jamais « le dernier handle non nul ». Une ressource manquante pour une opération native produit un échec explicite. Aucun `?.setPosition()` crédité comme move réussi.

DÉDUIT / prescription : le dispatch installe le nouvel état **avant** d'exécuter ses effets. L'interpréteur traite une seule opération synchrone à la fois, sans `await` entre sa validation et son appel natif. Les callbacks réentrants sont mis en file ; le résultat de l'opération synchrone en cours est réduit avant de vider cette file. Cela donne un point d'ordre précis : move terminé avant hide réentrant = position appliquée à conserver ; hide traité avant démarrage du move = aucun move.

DÉDUIT / prescription : chaque effet encore à lancer porte son permis `(token, operationId ou epoch, étape attendue)`. L'interpréteur vérifie que ce permis figure encore dans l'état ; l'annulation d'un timer ne suffit pas. Les effets différés retirés par une transition ne s'exécutent pas. Une complétion `loadFile` ne fait elle-même ni publication, ni promotion, ni show : elle émet seulement `LoadSucceeded/LoadFailed(token)`.

DÉDUIT / prescription : création et montage initial des listeners sont synchrones et possèdent la ressource immédiatement après le constructeur. Une exception de préparation après allocation déclenche sa retraite ; une exception de constructeur sans ressource revient à `absent` avec trace. Ne pas entourer seulement `await loadFile` d'un catch.

### 3. Familles d'événements et table de cycle de vie

DÉDUIT / prescription : les événements exposés à l'assemblage sont `ShowRequested`, `HideRequested`, `LockChanged`, `ReloadRequested`, `RestoreRequested` (§9), `QuitRequested`, `AppearanceChanged`, `PositionRequested`, `PointerChanged` et `RefreshRequested`. Les événements internes sont des unions typées : allocation/chargement, résultat d'effet, `NativeCloseRequested`, `NativeClosed`, `RendererGone`, échéances move/persist/destruction. `AppearanceChanged` exclut **visible, positionLocked et positions** : ces champs ne contournent pas leurs transitions dédiées.

DÉDUIT / prescription : toute entrée native est d'abord comparée au token détenu. Une entrée d'un token ancien est sans effet, sauf un diagnostic borné ; elle ne révoque ni le token actuel ni ses timers. `EffectSucceeded/Failed` précise une espèce d'effet et un numéro d'opération attendu. Une nouvelle espèce doit être classée explicitement dans les deux tables, pas absorbée par un défaut permissif.

Légende normative : `=` conserve le cycle de vie ; `R` demande retraite ; `C` démarre une allocation autorisée ; `I` ignore un événement obsolète ; `X` refuse une commande ; `fin` signifie dernière intention de destination. Tous les effets éventuels doivent respecter les permis ci-dessus.

| Événement, token valide si requis | unavailable | absent | loading | promoting | ready | retiring | stopped |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ShowRequested` | X | visible=true, C | visible=true, = | visible=true, poursuivre étape | visible=true, publish puis show acquitté | sauf arrêt : visible=true, fin=remplacement ; si bloqué, `RetryCleanup` | X |
| `HideRequested` | réglage seulement | visible=false | visible=false ; finir caché | visible=false ; révoquer show non lancé, finir caché | visible=false ; publier et hide | visible=false ; fin conservée, sauf arrêt | X |
| `LockChanged(value)` | réglage seulement | réglage | réglage | réglage | réglage | réglage sauf arrêt | X |
| `ReloadRequested` | X | C sans changer visible | R vers remplacement | R vers remplacement | R vers remplacement | sauf arrêt : fin=remplacement ; si bloqué, `RetryCleanup`, sinon coalescer | X |
| `QuitRequested` | flush puis stopped | flush puis stopped | R vers arrêt | R vers arrêt | R vers arrêt | fin=arrêt, irréversible | = |
| `Allocated(token)` | I | I | document ; Load une fois | I | I | ne pas charger ; Destroy ressource détenue | I |
| `LoadSucceeded(token)` | I | I | promoting/prepare | I | I | I | I |
| Échec allocation/load ou `LoadWatchdogExpired` | I | I | absent si aucun handle, sinon R vers absent ; trace | I | I | trace sans changer fin | I |
| Succès prepare/publish-vue-de-promotion/show | I | I | I | étape suivante ; dernière étape -> ready | résultat show attendu seulement | I | I |
| Échec prepare/publish-vue-de-promotion/show | I | I | I | R vers absent ; trace ; current=null | show échoué -> R vers absent ; trace | I | I |
| `RendererGone(token)` | I | I | R vers absent | R vers absent | R vers absent | trace bornée ; fin conservée | I |
| `NativeCloseRequested(token)` | I | I | comme Hide ; annuler close natif | comme Hide ; annuler close natif | comme Hide ; annuler close natif | destruction interne, aucun Hide | I |
| `NativeClosed(token)` | I | I | perte inattendue : absent, trace | perte inattendue : absent, trace | perte inattendue : absent, trace | acquitter disparition ; absent, C ou stopped selon fin | I |
| `DestroyReturned(token, op)` sans exception | I | I | I | I | I | = ; **ne prouve pas la disparition**, garder la barrière et le watchdog | I |
| Échec / échéance Destroy | I | I | I | I | I | tracer ; effet `CheckDestroyed(token, op)` | I |
| `CheckDestroyedSucceeded(true)` | I | I | I | I | I | même acquittement que NativeClosed, sans Hide | I |
| `CheckDestroyedSucceeded(false)` / échec de sonde | I | I | I | I | I | si sonde false issue de RetryCleanup et budget=1 : consommer budget, Destroy une fois et armer un nouveau watchdog identifié ; sinon rester bloqué/révoqué, tracer ; garder le watchdog déjà armé | I |

DÉDUIT / prescription : `RetryCleanup` est l'action des deux cellules Show/Reload × retiring bloqué, pas une autorisation de créer. Elle lance CheckDestroyed avec un budget d'**un** nouvel essai Destroy. Si la sonde est true, acquitter et poursuivre la destination ; si false, consommer le budget avant Destroy et armer un nouveau watchdog de retraite identifié. Si la sonde lève, tracer et rester bloqué. Une erreur de ce Destroy peut déclencher sa sonde de constat, mais ne recharge pas le budget. Les anciennes échéances sont révoquées. Une commande utilisateur ne crée donc pas une boucle de destruction.

DÉDUIT / prescription : compléter la table de cycle par ces événements transversaux. Les résultats move/persist et leurs échéances sont définis dans la table de position, section 5 ; ils ne changent pas le cycle de vie. Aucune famille ne doit tomber dans un `default` non classé.

| Événement transversal | unavailable | absent | loading | promoting | ready | retiring | stopped |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `AppearanceChanged(patch)` | Réglages, persist/publish | Idem | Idem ; prepare prend les dernières valeurs | Réglages, persist/publish, effets tokenisés | Idem | Réglages sans effet natif, sauf arrêt | X |
| `PointerChanged(inside)` | X | X | X | X | Authentifier ; visible requis ; hit-test de 003 | X | X |
| `RefreshRequested` | Tray | Tray | Tray | Tray et vue promue | Tray et vue courante | Tray | I |
| `GeometryChanged(snapshotMain)` | Mémoriser | Mémoriser | Mémoriser pour prepare | Révoquer demande/epoch, reprendre prepare | Révoquer demande/epoch, passer à prepare | Mémoriser pour remplacement | I |
| Succès hide/hit-test/options natifs | I | I | I | Acquitter op attendue | Acquitter op attendue | I | I |
| Échec hide/hit-test/options natifs | I | I | I | Tracer, R vers absent | Tracer, R vers absent | Tracer, aucun changement ; poursuivre Destroy | I |
| Résultat `PublishTray` | Acquitter ou tracer | Idem | Idem | Idem, **aucune retraite** | Idem | Idem | I |
| Résultat `PublishView` ordinaire | I | I | I | Si op attendue, acquitter ou tracer | Idem | I | I |
| `PositionRequested` | X | X | X | X | Table position : visible et non verrouillé requis | X | X |
| `MoveDue` | I | I | I | I | Table position : permis et mobilité requis | I | I |
| Résultat du move renderer | I | I | I | I | Table position : opération attendue | I | I |
| `PersistDue` / flush-applied | Table position | Idem | Idem | Idem | Idem | Idem | I |
| Résultat Persist | Table position : writeId attendu | Idem | Idem | Idem | Idem | Idem | I |

DÉDUIT / prescription : `PublishTray`, `PublishView` ordinaire et `PublishView` de promotion sont des effets **distincts**, avec résultats séparés. Une erreur du Tray est tracée sans retirer la fenêtre ni interrompre la publication vue. Une erreur vue ordinaire conserve le snapshot et attend le prochain refresh ; une erreur vue lors de la promotion retire l'objet. Les résultats de move renderer n'arrivent normalement qu'en ready, puisque leur acquittement synchrone précède le traitement des événements réentrants. Un faux résultat tardif ailleurs ne peut créer de dette.

DÉDUIT / prescription : `pointerInside` appartient au réducteur. Le remettre à **false** au hide, au close utilisateur, à l'entrée en retraite et à tout nouveau token. `prepare` arme par défaut `setIgnoreMouseEvents(true, { forward: true })` avant toute apparition. Un effet hit-test calculé avant hide ne retrouve aucun permis après show ; seul un nouveau `PointerChanged` authentifié peut rendre le masque interactif. Un échec de réarmement en hide entraîne la retraite ; en retraite, tracer cet échec et poursuivre Destroy, pas conserver une fenêtre pour un nettoyage de pointeur.

DÉDUIT / prescription : `GeometryChanged` est une entrée **main uniquement**, pas un nouveau canal renderer. L'événement garde une place explicite pour les raccords taille/topologie de L3 ; ce lot teste sa révocation et ses effets injectés, pas le DPI natif. La préparation ne réutilise pas un `applied` d'une ancienne géométrie. Deux choix sont possibles : publier ce changement comme un rafraîchissement ordinaire, moins strict mais susceptible de laisser le renderer calculer un drag avec une ancienne origine, ou imposer la même barrière prepare/publish que lors d'une promotion. **Retenir la barrière**, donc assumer qu'un échec de publication vue après changement géométrique retire aussi la fenêtre. Le token ne change pas pour cette préparation du même objet.

DÉDUIT / prescription : masquer, verrouiller, fermer, entrer en retraite ou perdre l'objet incrémente `moveEpoch` et supprime `requested`, **pas la dette appliquée**. `LockChanged(false)` ne rejoue aucun mouvement annulé. `NativeClosed` inattendu n'invente pas un close utilisateur ; seule la demande `close` non interne prend la transition Hide.

DÉDUIT / prescription : une destruction est marquée interne dans l'état **avant** `Destroy(token)`. L'adaptateur `close` consulte cet état avec le token : s'il n'est pas en retraite, il appelle immédiatement `preventDefault()` et dispatch `NativeCloseRequested(token)` ; sinon il ne masque pas. **Les listeners close et closed restent attachés jusqu'à l'acquittement de disparition** ; les autres peuvent être révoqués auparavant. Détacher closed avant Destroy supprimerait la preuve attendue par la machine. Le registre ne libère la ressource qu'à `NativeClosed` ou à un résultat explicite « déjà détruite » de l'adaptateur. Ce dernier est un acquittement de nettoyage, jamais une lecture d'autorité de visibilité.

DÉDUIT / prescription : garder un watchdog de destruction borné et injectable, défaut proposé **2 000 ms**. À l'échéance, ou si Destroy lève, tracer et **exécuter CheckDestroyed immédiatement**, sans attendre un clic Afficher. `isDestroyed() === true` acquitte la disparition et permet le remplacement déjà demandé ; false ou une exception garde la barrière fermée. Pas de boucle automatique de sondage : une commande explicite Afficher/Reload peut retenter ensuite le nettoyage. Si la destruction reste impossible, la restauration attend le nettoyage ou le redémarrage : **limite assumée de vivacité, pas timeout qui autorise deux fenêtres**.

DÉDUIT / prescription : ajouter un watchdog de chargement par token, défaut proposé **15 000 ms**, injectable dans les tests. À l'échéance, `LoadWatchdogExpired` trace, invalide la promotion et rejette l'IPC initial en attente ; retraite sans relance automatique. Les durées 2 000/15 000 ms sont des budgets techniques proposés, pas une mesure de latence ni un engagement de performance. Succès, retraite et quit annulent leurs échéances ; un callback déjà prêt reste neutralisé par son token/timerId.

DÉDUIT / prescription : Quit effectue le flush et une tentative de destruction, rapporte leurs erreurs et laisse le nettoyage A1 puis la sortie processus terminer ; ne pas bloquer éternellement la libération A1 sur ces watchdogs. En `retiring(destination=arrêt)`, toutes les nouvelles commandes utilisateur sont refusées ; seuls résultats, cleanup, flush et quit idempotent sont traités.

DÉDUIT, documentation externe consultée via `searxng_search` : [Electron BrowserWindow.destroy](https://www.electronjs.org/docs/latest/api/browser-window) documente « it guarantees the closed event will be emitted » et l'absence d'événement `close` pour `destroy()`. Cette source motive la barrière ; elle ne remplace ni les doubles fautifs ni L3 sur la version livrée.

### 4. Visibilité : une seule réponse pour le Tray, le renderer et l'IPC

DÉDUIT / prescription : **`state.appearance.visible` est l'unique autorité de visibilité voulue**. `selectCanMove(state)` exige `lifecycle=ready`, ce booléen et `!positionLocked`. L'authentification IPC exige en plus l'objet courant et sa frame principale. L'absence après crash n'écrit pas `visible:false` : elle interdit déjà le mouvement par le cycle de vie.

DÉDUIT / prescription : `ShowRequested`/`HideRequested` et un close utilisateur changent cette même valeur, invalident les mouvements à annuler et émettent une publication et une écriture de snapshot. Une panne disque est tracée, laisse la dette, mais ne réautorise pas le déplacement. La présentation et le menu lisent des sélecteurs de cet état, jamais une copie mutable ou le retour de `writeAvatarAppearance`.

DÉDUIT / prescription : `getState()` renvoie la dernière enveloppe cohérente, sans appeler un nouveau `summary()` ni déclencher une nouvelle publication. `RefreshRequested` prélève une seule fois le résumé A1 dans l'adaptateur de publication, garde sa projection explicite et fournit cette même valeur au Tray et au conteneur. Le rafraîchissement temporel A1 existant est conservé ; le renderer n'ajoute aucun poll. Une publication de présentation prend les champs de **son snapshot de machine**, pas une closure d'apparence antérieure.

DÉDUIT / prescription : pour l'initialisation subscribe-puis-get de 003:74, l'interpréteur rattache le `getState()` précoce à une promesse de promotion par token. **Une seule invocation IPC en attente est admise par token** ; les suivantes sont refusées tant que la première attend. Partager une promesse tout en accumulant ses awaiters ne serait pas une borne. Vérifier le handle et la frame de la seule ressource en chargement avant d'attendre, puis **revérifier l'identité courante avant de rendre le snapshot**. Invalidation = rejet et libération du slot ; pas de tableau de requêtes en croissance. Les autres handlers restent refusés tant qu'ils ne satisfont pas leur état autorisé. Le chargement du document ne doit pas attendre lui-même cette requête pour produire `LoadSucceeded`.

DÉDUIT / prescription : l'ancien callback `onGeneration` est remplacé par la publication de promotion. Pour les tests et la migration, un callback injecté qui lève à cet endroit équivaut à `PublishFailed(token, op)` : retrait immédiat, `current()===null`, destruction puis `absent`. `showInactive` obéit au même contrat d'échec, y compris lors d'un réaffichage.

### 5. Position demandée, appliquée, persistée

DÉDUIT / prescription, fondement : 003:84-100 et défauts de `avatar-position-controller.ts:30-50`.

| Événement / transition | Condition | Nouvel état et effets |
| --- | --- | --- |
| `PositionRequested(x,y)` | Émetteur courant, arguments finis exacts, `selectCanMove` | Calculer le placement à partir d'une topologie et taille main ; remplacer `requested`, armer un seul timer move (16 ms par défaut). Ne modifier ni `applied` ni les positions à écrire. |
| Même demande refusée | Mauvaise identité, caché, verrouillé, pas ready, invalide | Rejeter l'IPC ; aucun changement de demande, d'applied, de dette ou de timer de persistance. |
| `MoveDue(timerId, token, epoch)` | Identifiants actifs, demande présente, mobilité encore autorisée | Émettre `SetNativePosition(token, op, x, y)` ; consommer cette demande. Le déplacement ne transmet jamais width/height. |
| Échéance move périmée | Timer annulé mais callback déjà prêt, mauvais token/epoch | Aucun effet, même si la fenêtre est redevenue visible/non verrouillée entre-temps. |
| `MoveSucceeded(token, op, placement)` | Résultat de l'opération synchrone démarrée sur ce token | Affecter `applied` ; mettre à jour les positions mémorisées de l'écran concerné ; augmenter révision d'apparence ; publier ; armer persistance unique (500 ms par défaut). |
| `MoveFailed(token, op)` | Opération attendue | Tracer ; conserver l'ancien applied et sa dette. Ne jamais persister la nouvelle demande ni effacer P1 parce que P2 a échoué. |
| Hide / lock / close / retraite | Tous états concernés | Annuler demande et timer move ; révoquer epoch ; conserver les positions déjà appliquées. Les réglages persistables peuvent déclencher immédiatement leur snapshot, qui inclut cette dette. |
| `PersistDue(timerId)` / flush | Dette d'apparence existante | Écrire un snapshot complet issu du réducteur. **Aucune garde visible/locked ici.** Flush ne déclenche pas de move. |
| `PersistSucceeded(writeId, revision)` | Identité d'écriture attendue | Acquitter la révision écrite seulement ; ne remplacer aucun champ courant par le retour disque. Une révision plus récente demeure sale. |
| `PersistFailed(writeId)` | Identité d'écriture attendue | Tracer et conserver la dette. Pas de boucle immédiate ; retenter à la prochaine modification persistable ou au flush explicite/quit. |

DÉDUIT / prescription : le writer est synchrone comme le writer atomique actuel, appelé avec un snapshot complet validé, et ne relit plus le fichier. Cette restriction garde le petit interpréteur local ; passer ultérieurement à des écritures async exigerait de garder une seule écriture en vol et le contrôle de révision, pas de paralléliser les patches. Une position refusée ne peut pas entrer dans le snapshot par une closure de `latest`.

DÉDUIT / prescription : `applied` est réinitialisé à chaque **nouveau token**, contrairement aux positions mémorisées. `promoting/prepare` applique toujours le placement de restauration au nouvel objet avant snapshot et show, même s'il a les mêmes x/y que l'objet détruit. Le succès de préparation établit `applied` pour ce token. Si le clamp ou le choix d'écran change la restauration, il met à jour seulement l'entrée de l'écran **effectivement sélectionné**, après succès, et crée sa dette de persistance ; l'entrée de l'écran absent reste intacte. Une restauration identique n'impose pas une écriture redondante. Un échec empêche la promotion finale. L'application n'est pas attestée par un événement natif `move` : aucun acquittement sans numéro d'opération ne peut inventer un move réussi.

DÉDUIT / prescription : conserver `clampAvatarPlacement` et les helpers purs de `avatar-window-placement.ts:22-55`. Le clamp d'ingress de `avatar-entry.ts:105-107` qui ne déduit pas la taille doit céder la place à ces helpers. La topologie vient de main, pas du renderer. Les coordonnées locales par écran et les conversions absolues DIP restent celles prescrites par 003:100 ; tester les conversions et la restauration, ne pas créditer la précision DPI native avant L3. Toute évolution de topologie/tailles invalide une demande calculée pour l'ancienne géométrie ; son traitement système ne doit pas passer pour un drag renderer autorisé malgré le verrou.

### 6. Les sept ordonnancements et leurs contre-épreuves

DÉDUIT / prescription : chaque ligne teste **la réduction et le vrai interpréteur injectable**, avec événements contrôlables. Le maximum de ressources vivantes est mesuré à chaque étape, pas uniquement à la fin. « Persist P » signifie qu'une position P entre dans le snapshot écrit, pas seulement qu'une méthode nommée persist est appelée.

| Cas | Ligne de transition et trace attendue | Négatif à faire rougir dans un miroir privé |
| --- | --- | --- |
| **a** reload/destroy pendant load | `loading(g1) -> retiring(g1)` ; résolution tardive load(g1) = I ; disparition g1 avant Create(g2), ou aucun Create après Quit. Aucun publish/show g1. | Retirer le contrôle de token/étape à `LoadSucceeded` : la résolution ancienne promeut ou montre g1 et l'assertion doit échouer. Tester reload et quit séparément. |
| **b** crash ancien pendant création nouvelle | `loading(g2) + RendererGone(g1) = I`. Aucun changement du token, de la promesse de promotion ou de la demande g2. | Faire traiter tout `RendererGone` comme crash courant : g2 doit alors perdre sa promotion et le test rougir. |
| **c** exception après promotion | `promoting(g) + PublishFailed/ShowFailed -> retiring(g) -> absent` ; current=null dès l'échec ; Afficher suivant peut créer g2 après disparition. | Catch qui ne retire que loading : le courant reste orphelin. Deux injections distinctes : callback de publication/onGeneration et showInactive. |
| **d** close utilisateur | `ready(g) + NativeCloseRequested -> ready(g), visible=false` ; preventDefault, publish false, snapshot false. Une demande ultérieure échoue sans move ni ajout de position à écrire. | Rebrancher close sur le seul hide natif : visible reste vrai et le vrai handler IPC doit accepter à tort le move, donc test rouge. |
| **e** demande puis hide/lock avant move | `requested(P) -> annulation/epoch++` ; callback conservé artificiellement puis déclenché = I. Zéro SetNativePosition, aucune P dans le fichier. | Réintroduire un timer capturant P qui appelle directement move d'après la visibilité au moment du tick, hors permis de la machine. Tester aussi hide puis show, lock puis unlock avant le tick : la demande révoquée ressuscite et le test doit rougir. Le retrait isolé d'un garde redondant n'est pas une contre-épreuve suffisante. |
| **f** P1 appliquée puis hide/lock avant persist | `MoveSucceeded(P1) -> dette(P1)` ; hide/lock conserve la dette. P2 refusée ne la remplace pas. Ajouter P2 admise avant hide mais jamais appliquée ; flush écrit P1, jamais P2. | Réintroduire `canMove` ou `applied == requested` dans persist : P1 disparaît et le test doit rougir. Tester aussi l'échec natif de P2 après succès P1. |
| **g** destruction interne | `ReloadRequested/QuitRequested -> retiring` **avant** Destroy. Un close/closed réentrant n'émet pas Hide ; visible demeure son intention initiale. | Retirer la distinction retiring du close : le double émet close au destroy, visible devient false et l'assertion doit échouer. Couvrir intention initiale true et false. |

DÉDUIT / prescription : deux variantes supplémentaires interdisent une fausse conformité : `move P -> crash -> Afficher -> même P` doit appliquer P à g2 ; `SetNativePosition` visant un handle absent doit produire un échec explicite, jamais un applied/persist. La reprise g2 inclut un premier snapshot avant show.

**Garde de la LIMITE NOMMÉE c, DÉDUIT / prescription :** injecter l'échec de publication ou show, puis Destroy qui lève et isDestroyed qui reste false. Exiger current=null, trace et **zéro nouvelle allocation**, y compris après la première sonde. Trois branches : (1) isDestroyed devient true au watchdog à 2 s, la disparition est acquittée, mais une retraite issue du seul crash/échec revient à absent sans auto-relance ; (2) une demande de remplacement déjà explicite attendait, le watchdog true permet ce remplacement ; (3) la sonde reste false, puis un Afficher/Reload explicite déclenche RetryCleanup, avec au plus un nouvel essai Destroy. Même ce retry n'alloue rien si la disparition n'est toujours pas attestée. Le négatif supprime la barrière sur timeout et doit rougir sur le compteur de fenêtres vivantes. Tester aussi un closed manqué malgré destruction effective, et close/closed synchrones pendant Destroy, avec leurs listeners réellement attachés.

### 7. Périmètre de garde fixé avant développement

DÉDUIT / prescription : le domaine des gardes est **l'union de cycle de vie × l'union d'événements**, complétée par visibilité, verrouillage, token actuel/périmé et dette de position. Une table de classification exhaustive dérivée des types exige une case pour chaque couple : transition testée, refus testé, ou événement périmé testé. Ne pas recopier une liste partielle de sept scénarios et l'appeler couverture de la machine. Une case I doit prouver l'absence d'effets ; une case X doit prouver le rejet observable.

| Niveau | Garde exigée | Limite de cette garde |
| --- | --- | --- |
| Réducteur | Matrice complète des deux tables ; état gelé en entrée ; même `(state,event)` donne même sortie. Invariants après chaque événement : au plus un token détenu, aucune mobilité hors ready/visible/non verrouillé, aucune dette créée par demande seule. | Ne prouve ni que dispatch est appelé ni que l'adaptateur suit les sorties. |
| Interpréteur | Faux natif avec load différé/réordonné, destruction sync/retardée/en échec, callbacks réentrants ; faux timers capables de tirer après cancel ; journal complet effets/identités. Les sept lignes ci-dessus et création partiellement fautive passent par cet interpréteur réel. | Un double qui émet toujours closed instantanément ne couvre pas le watchdog ; un double qui ne lève jamais ne couvre pas c. |
| IPC et publication | Chaque canal existant : bonne fenêtre/frame, étrangère, sous-frame, ancienne génération ; close via vrai listener puis vrai setPosition. GetState pendant load, promotion, invalidation ; initial snapshot avant show ; résumé A1 identique pour les deux sorties. | N'établit pas que le geste est humain ni que la sandbox native est active. |
| Persistance | Fichier temporaire réel, writer atomique, reload de son contenu pour l'assertion seulement. Échecs injectés, retries, P1 conservée et P2 absente, préférence changée sans rollback disque, écran négatif/restauration de nouveau token. | N'établit pas une durabilité après panne matérielle ou kill avant écriture ; ce contrat n'introduit ni journal transactionnel ni fsync supplémentaire. |
| Couverture et raccords | Un négatif par cas a-g, plus ajout d'une nouvelle variante d'état/événement : la classification doit refuser l'oubli. Test comportemental de l'assemblage bootstrap/entry injectable : aucun ancien writer/getter indépendant ne décide le move. | Le typage ferme le domaine, pas la justesse des attentes ; le contrôle source seul ne prouve pas ce raccord. |

DÉDUIT / prescription : mutations uniquement dans un miroir privé, avec identité du snapshot copié, preuve `applied=true`, baseline verte non vide, rouge sur l'assertion attendue, puis contrôle restauré vert. Ajouter une variante inconnue et une variante du même genre doit exiger la couverture, pas rester vert. Le gate de types est exécuté par l'intégrateur ; si une sonde ciblée prouve l'exhaustivité, elle doit vérifier le diagnostic attendu et disposer d'un contrôle positif.

**Limite nommée, SUPPOSÉ tant que L3 n'a pas mesuré :** « succès de l'effet natif » ne prouve pas la position physique Windows, l'absence de dérive DPI, le transfert souris, le chargement du preload dans le paquet ou le rendu visible. Le présent lot ne ferme aucune de ces garanties. La barrière d'unicité sacrifie volontairement la restauration immédiate si la disparition d'une ressource n'est pas attestée. Une écriture disque en échec interdit d'annoncer la préférence durable, sans révoquer la préférence active.

### 8. Garder, remplacer, retirer : ownership developer

DÉDUIT / prescription : un seul développeur possède ce lot main, séquencé en quatre étapes ci-après. Les fichiers de cette table sont des cibles de migration, pas une annonce de création réalisée.

| Fichier | À conserver | À remplacer / retirer |
| --- | --- | --- |
| `avatar-window.ts` | Interfaces injectables, options sécurisées, garde sender/frame/arguments, diagnostics bornés, refus navigation et fenêtres secondaires | `pendingWindow`, `creating`, `disposed`, token et Set de destruction comme politique autonome. Garder un adaptateur tokenisé exécutant les effets et émettant les événements ; aucun show/hide hors effet. |
| Nouveau `avatar-window-state.ts` | Types métier existants par imports de type | Réducteur, unions, sélecteurs, projection de mobilité et tables de classification. Aucun import runtime Electron/fs/log/timers. |
| Nouveau `avatar-window-controller.ts` | Assemblage injectable du bridge et de l'adaptateur natif | Dispatch, permis d'effets, registre de ressource, timers, promesse de promotion et fermeture ; aucune deuxième décision visible/locked. |
| `avatar-position-controller.ts` | Tests/scénarios de coalescence et paramètres 16/500 ms | Retirer ce contrôleur autonome ; sa politique entre dans le réducteur, ses timers dans l'interpréteur. Ne pas garder un `flush()` qui déplace avant d'écrire. |
| `avatar-position-guard.ts` | Messages de rejet utiles aux appelants | Remplacer le prédicat portant seulement sur `AvatarAppearance` par le sélecteur de la machine ; supprimer le module si plus aucun appel réel. Vérifier les références avant suppression. |
| `avatar-entry.ts` | Singleton, serveur, broker probe, Tray, focus et release A1 | Construire un contrôleur, injecter les ports, traduire menus/IPC en événements ; retirer le `let appearance` réassigné et le contrôleur position indépendant. Quit appelle shutdown/flush-applied du contrôleur. Aucun Show/Reload de production ajouté dans ce lot. |
| `avatar-appearance.ts` | Schéma, défauts, validation, classification MACHINE, lecture initiale, écriture atomique et traces | Writer de **snapshot complet**, sans relecture du disque ni retour réaffectable comme autorité. Adapter les tests d'écriture et tous les appelants recensés. |
| `avatar-presentation.ts` / `avatar-bootstrap.ts` | Projection explicite A1, création d'un seul AvatarState, logique DND/thème, même résumé vers sorties | Retirer la copie mutable visible/locked/position et les setters concurrents. Lire le snapshot du réducteur ; conserver au besoin une façade de publication, mais seulement comme projection/cache d'enveloppe. |
| `avatar-window-placement.ts` | Helpers purs de clamp/restauration | Les consommer au vrai raccord position/préparation ; conversions écran explicites selon 003. Ne pas modifier les règles DPI par conjecture. |
| Tests ciblés | `desktop-avatar-view-ipc`, `desktop-avatar-position-controller`, `desktop-avatar-position-guard`, `desktop-avatar-appearance`, `desktop-avatar-bootstrap`, `desktop-avatar-presentation`, `desktop-avatar-window-placement` | Migrer les attentes de flush et gardes, ajouter `desktop-avatar-window-state.test.ts` et `desktop-avatar-window-lifecycle.test.ts`. Déplacer les fixtures de cycle hors du seul test IPC si cela rend la matrice lisible. |

DÉDUIT / prescription, plan incrémental :

1. **Réducteur et contrat de ports.** Implémenter la matrice et les sélecteurs, avec leurs tests ciblés. Conserver l'ancien raccord dormant jusqu'à l'étape suivante ; ne pas instancier deux machines concurrentes.
2. **Interpréteur + bridge.** Déplacer la politique existante vers le dispatch, tester load/crash/promotion/retraite et le close via les vrais handlers injectés. Remplacer le contrôleur de position et son flush dans la même étape ; pas de compatibilité qui laisse deux autorités actives.
3. **Persistance + présentation + assemblage.** Snapshot writer, initialisation unique, sorties dérivées, quit borné. Tester l'échec disque sans rollback de visible/locked et la dette P1. Conserver la fenêtre dormante dans `avatar-entry.ts` ; l'activation n'est pas une preuve de ce lot.
4. **Garde et livraison.** Exécuter séparément chaque fichier ciblé modifié, négatifs a-g en miroir, revue indépendante. Remettre les risques inter-fichiers et la liste des changements à l'intégrateur pour son unique gate complet. L3 peut ensuite activer et vérifier le paquet natif, après clôture de `db34d743`.

### 9. Amendement L3, carte `8fb62e61` : restauration au démarrage

DÉDUIT, `onShow` dans `avatar-window-state.ts` : `ShowRequested` écrit `visible:true` avant d'allouer ; l'émettre au démarrage écraserait un `visible:false` persisté par un close ou un Masquer (cas d). Trois options : (i) un test de `appearance.visible` dans `avatar-entry`, donc un lecteur hors réducteur, contraire au §4 ; (ii) un événement dédié du réducteur ; (iii) une allocation à la construction de la machine, donc avant le registre (`assembleAvatar` précède `claimAvatarRegistry` dans `startAvatar`). **Retenu par le lead : (ii), `RestoreRequested`.**

DÉDUIT / prescription : `RestoreRequested` s'ajoute aux événements exposés du §3. Il n'alloue que si `lifecycle=absent`, `appearance.visible===true` et `lastToken===0`, c'est-à-dire tant que cette machine n'a encore alloué aucune fenêtre. Il ne modifie jamais `appearance`, ne bouge aucune révision, n'émet ni écriture ni publication, et ne répond jamais `rejected`.

| Événement | unavailable | absent | loading | promoting | ready | retiring | stopped |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `RestoreRequested` | I | si visible et `lastToken===0` : C sans changer visible, réponse `accepted` ; sinon `=`, réponse `none`, aucun effet | I | I | I | I ; fin conservée, pas de `RetryCleanup` | I |

DÉDUIT / prescription : ligne de classification `RestoreRequested: row('I', 'T', 'I', 'I', 'I', 'I', 'I')`. La case `unavailable` est **I et non X** : hors Windows, l'absence de fenêtre est l'état normal, pas un refus de commande ; réponse `none`, aucun effet `trace`, aucun `reportError`. `stopped` est I pour la même raison : un démarrage qui croise un Quit n'a personne à qui répondre. Le témoin de la case T d'`absent` porte `visible:true` et `lastToken=0`.

DÉDUIT / prescription, **double réception** : le second `RestoreRequested` est sans effet dans tous les états. Le garde est `lastToken===0`, consommé par `startAllocation`, qui incrémente `lastToken`, sans nouveau champ d'état. Écartés : aucun garde (un second envoi après crash réallouerait, contre la branche 1 de la limite c, « sans auto-relance ») ; un booléen consommé en tout état (les cases I modifieraient l'état, contre le contrat I du §7). Conséquence assumée : un `ShowRequested` ou un `ReloadRequested` reçu avant lui le neutralise aussi, la commande explicite prime.

DÉDUIT / prescription, émission : `avatar-entry` appelle `controller.dispatch({ kind: 'RestoreRequested' })` une seule fois, en dernière instruction de `startAvatar`, donc après le contrôle `owner` qui suit `claimAvatarRegistry` et après la création du Tray. `dispatch` et non `requireReply` : aucune réponse ne lève. Une fenêtre n'existe ainsi jamais sans registre détenu ni sans sa surface Quitter.

Ligne ajoutée à la matrice du §6 :

| Cas | Ligne de transition et trace attendue | Négatif à faire rougir dans un miroir privé |
| --- | --- | --- |
| **h** restauration au démarrage | `absent, visible=true, lastToken=0 + RestoreRequested -> loading(g1)` : un seul `allocate`, zéro `writeSnapshot`, `appearance` inchangée. Avec `visible=false` : état identique, zéro effet. En `unavailable` : réponse `none`, zéro trace. Second envoi après `RendererGone(g1)` et retour à `absent` : zéro `allocate`. | (1) Router l'événement vers `onShow` : le `visible:false` persisté passe à true et un `writeSnapshot` part. (2) Retirer `lastToken===0` : le second envoi après crash alloue g2. (3) Reprendre en `unavailable` le rejet de `onShow` : la réponse `rejected` fait rougir la case I. |

**Limite nommée, DÉDUIT `beginPrepare` et `onGeometry` dans `avatar-window-state.ts` :** au démarrage sans aucun écran, `RestoreRequested` alloue et charge g1, puis `prepare` trace « Avatar placement requires an available display » et retire vers `absent`. `lastToken` vaut alors 1 : un écran qui apparaît ensuite ne recrée rien, puisque `GeometryChanged` en `absent` ne fait que mémoriser. La fenêtre reste absente jusqu'à **Afficher**, ce qui est la règle « sans auto-relance », pas un défaut à corriger par un second envoi.

MESURÉ, `bun test ./tests/desktop-avatar-window-state.test.ts -t "h: "` : `4 pass`, `0 fail`, `60 expect() calls`. Les quatre tests de la ligne h couvrent le réducteur et son harnais, pas le raccord `avatar-entry`. Leurs trois négatifs sont rapportés tués en miroir par les peers developer et reviewer, selon le message du team-lead du 2026-10-01 à 17:18:41Z ; ils n'ont pas été rejoués pour cet amendement. SUPPOSÉ : l'apparition native au démarrage reste à mesurer par L3.

## État des preuves à la livraison de conception

DÉDUIT, avis délégué : contrôle contractuel indépendant du peer debugger `desktop-7b2civn-koryphaios-5`, verdict final **CONFORME, documentation seule**, message du 2026-10-01 à 13:45:55Z. Les trois bloqueurs initiaux et le résiduel de retry ont été levés par sa relecture ; sa dernière demande d'expliciter le nouveau watchdog dans la cellule de retry est intégrée. Ce contrôle porte sur le contrat de conception, pas sur les tests futurs ou le runtime. Les agents spécialisés challenger/contract-auditor n'étaient pas exposés dans l'inventaire de cette session ; la contradiction et le contrôle ont été sollicités par le canal peer.

| Étiquette | Commande exacte | Sortie décisive et portée |
| --- | --- | --- |
| MESURÉ | `bun test ./tests/desktop-avatar-view-ipc.test.ts` | `7 pass`, `0 fail`, `57 expect() calls`. Socle existant uniquement, pas une preuve de la machine proposée. |
| MESURÉ | `bun test ./tests/desktop-avatar-position-controller.test.ts` | `4 pass`, `0 fail`, `10 expect() calls`. Socle existant uniquement, notamment pas la conservation de P1 après hide/lock. |

DÉDUIT : le test close actuel (`tests/desktop-avatar-view-ipc.test.ts:352-380`) observe hide/show/destroy, mais pas la remontée vers l'apparence ou le refus IPC après close. Les tests position lus (`tests/desktop-avatar-position-controller.test.ts:62-116`) couvrent la demande interdite avant move et l'échec du move initial, pas la dette P1 suivie de P2. Cela explique pourquoi ces résultats verts ne clôturent pas d/f.

SUPPOSÉ, non exécuté : succès des nouveaux tests, des contre-épreuves et du futur raccord. Aucun négatif de l'ADR n'est annoncé réalisé. Aucun gate global, typecheck, build ou essai Electron natif n'a été lancé pour ce dossier de conception.
