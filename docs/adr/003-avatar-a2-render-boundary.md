# Avatar A2 : frontière de rendu et capacités de présentation

Statut : contrat de conception pour la carte `8fb62e61`, sur mandat du team-lead. Les décisions opérateur sur les sept faces, le mouvement et la planche sont celles de la carte. Ce document ne prouve pas leur implémentation. Le découpage est dans `docs/DESIGN-AVATAR-A2-LOTS.md`.

Les prescriptions ci-dessous sont normatives. Les constats sur l'existant portent leur provenance ; les résultats de sonde délégués ne sont pas des mesures rejouées par l'auteur.

## Problem framing

Le personnage doit rendre les états A1 sans devenir un second interprète de l'activité ni un client privilégié du Deck. Son déplacement exige une capacité locale de présentation, pas une ouverture du contrôle des sessions. La fenêtre peut disparaître ou être recréée sans perdre la machine d'états, les branchements ou le Tray.

## Current structure

- DÉDUIT : `desktop/src/main/avatar-entry.ts:47-48,82-90` construit une instance `AvatarState`, l'injecte dans le serveur et dans le Tray. `desktop/src/shared/avatar-state.ts:118-139` calcule le visage et les pannes par Deck ; le résultat copie les snapshots.
- DÉDUIT : `avatar-state.ts:4,43-48` définit sept faces et un `AvatarSummary` de données. La classe contient aussi des Maps et une horloge (`:87-97`) ; elle n'est pas le contrat à transporter au renderer.
- DÉDUIT : `desktop/src/main/avatar-tray.ts:112,134-170` détient le DND en mémoire et relit l'état sur un intervalle. `desktop/src/main/avatar-settings.ts:28-39,49-52` reconstruit puis réécrit uniquement autoAttach et projects : y mêler des réglages A2 expose ces derniers à leur suppression par un Deck A1.
- DÉDUIT : `desktop/src/preload/index.ts:78-110` expose sessions, PTY et configuration. `desktop/electron.vite.config.ts:14-18,28-32,47` sépare les entrées main et preload, mais déclare une seule entrée HTML renderer. A2 doit compléter cette chaîne sans importer l'application Deck.

## Options

### Frontière renderer

- **A : renderer et preload dédiés.** Deux entrées de build supplémentaires et un petit contrat partagé ; dépendances bornées au personnage. Réversible en retirant cette fenêtre, sans changer le protocole de branchement. Risque principal : oublier un artefact dans le paquet, à tester au lancement réel.
- **B : mode Avatar dans l'entrée renderer Deck, avec bridge restreint distinct.** Moins d'entrées HTML, mais branche spéciale dans le démarrage et les types de l'application. Rayon d'impact plus large ; risque de dépendance implicite au store ou aux services du Deck. Extraction ultérieure plus coûteuse. Réutiliser le preload `DeckApi` complet n'est pas une variante autorisée de B.

### Persistance

- **A : étendre avatar-settings.json.** Un fichier de moins, mais tous ses écrivains doivent préserver les champs d'apparence, y compris les binaires Deck déjà lancés ; migration et déploiement couplés.
- **B : avatar-appearance.json distinct.** Un fichier MACHINE et son validateur supplémentaires ; l'avatar en est le seul écrivain. Rayon d'impact local, suppression/réinitialisation indépendante des opt-out et d'autoAttach.

## Recommendation

Retenir la frontière A et la persistance B. La séparation des capacités prime sur l'économie d'une entrée HTML. Publier le résultat de l'unique machine A1 ; ne jamais réhydrater une deuxième machine dans le renderer. La lecture reste sans effet métier ; le déplacement et le hit-test sont deux capacités explicites de présentation.

Le challenge indépendant du reviewer `desktop-7b2civn-koryphaios-7` confirme cette frontière sous réserve de cibler l'émission et de garantir l'initialisation et le désabonnement. Ce verdict ne remplace pas les tests natifs de L3.

## Target design & migration path

### 1. Autorité et données

```text
Decks -> serveur avatar -> AvatarState unique
                              |
                         summary() en main
                              |
                  contrôleur de présentation main
                      /                   \
                    Tray            avatar-view:state
                                          |
                               conteneur renderer dédié
                                          |
                                peau pure (AvatarSummary)
```

Le contrôleur possède l'horloge de rafraîchissement, le DND, les préférences et la fenêtre courante. Le serveur et la sonde broker conservent leurs producteurs A1. La publication prend un seul `summary()` et fournit cette même valeur logique au Tray et à la fenêtre. Conserver au minimum le rafraîchissement A1 toutes les cinq secondes : le passage à suspect doit être publié même quand aucun Deck n'émet. Publier aussi un état initial et les changements de présentation. Ne pas ajouter un deuxième poll d'activité dans le renderer.

L'enveloppe locale contient `generation`, `revision`, `summary` et `presentation`. `generation` identifie la fenêtre, `revision` croît dans la vie du contrôleur. `summary` est une projection explicite des champs de `AvatarSummary`, sans spread d'un registre d'attache. Les éléments gardent leur identité `{deckRunId, broker_url}`, jamais le nom ou le projet. `broker_url` est une métadonnée d'identité non fiable, pas une cible réseau fournie au renderer. Ne pas ajouter PID, projectDir, certificat, Bearer, rendez-vous, endpoint de contrôle ou données d'approbation.

`presentation` contient seulement les valeurs nécessaires au conteneur : position courante x/y en DIP pour l'origine du glisser, mode de mouvement, DND actif, taille choisie, verrouillage, opacité, thème et visibilité. Aucun chemin de fichier de réglages n'y figure. La peau reçoit uniquement `summary`, sans API, paramètres de fenêtre ni réglages. Les priorités, `torchOut`, compteurs et `unread` ne sont pas recalculés dans la peau. La réduction de mouvement est une politique du conteneur ; elle ne modifie pas le résumé.

L'A2 affiche les sept faces d'`AvatarFace`. Les données `unread > 0` sont couvertes par les fixtures de la peau, sans introduire un producteur Courrier en A2. Accompli relève de B2, avec sa source d'événements à spécifier ; Reflechit relève de B1 et de sa bulle. Aucune extension d'`AVATAR_PROTOCOL_VERSION`, d'`AVATAR_COMMANDS` ou des messages Deck vers avatar.

### 2. Bridge dédié et sécurité

Un seul objet `window.api`, typé `AvatarViewApi`, dans ce renderer. Il ne s'agit pas d'une extension de `DeckApi`. Le preload ne révèle ni `ipcRenderer` ni le paramètre événement Electron. Types dans `desktop/src/shared/avatar-view.ts`, preload dédié, handlers locaux dans le module de fenêtre avatar. Aucun handler dans `ipc.ts` du Deck, aucun routage companion et aucun ajout à `COMPANION_MANIFEST`.

| Capacité | Canal | Contrat |
| --- | --- | --- |
| `getState()` | `avatar-view:get-state` | Lecture, équivalent tier 0 ; renvoie la dernière enveloppe complète. |
| `onState(callback)` | `avatar-view:state` | Événement main vers la seule fenêtre courante ; retourne un désabonnement. |
| `setPosition(x, y)` | `avatar-view:set-position` | Présentation locale, équivalent tier 1 ; position DIP uniquement. |
| `setPointerInside(inside)` | `avatar-view:pointer-inside` | Présentation locale, équivalent tier 1 ; booléen strict, active ou retire le hit-test du seul personnage. |
| `reportError(message)` | `avatar-view:report-error` | Diagnostic borné, scope main constant ; aucun paramètre de chemin, niveau ou sink. |

L'initialisation abonne avant de lire le snapshot. Le conteneur ignore toute enveloppe de révision plus ancienne et toute génération périmée. Le démontage désabonne ; la recréation détruit les abonnements de la fenêtre précédente. L'émetteur doit être **le webContents de la fenêtre courante et sa frame principale** ; une autre fenêtre, une sous-frame et une ancienne fenêtre ne peuvent appeler aucun de ces canaux. Vérifier l'identité à chaque appel, pas seulement à l'abonnement.

La fenêtre utilise `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, sans webview, contenu distant ou import de `remote-api`. Navigation et création de nouvelles fenêtres sont refusées. CSP : ressources locales nécessaires au renderer uniquement, pas de scripts inline ni de connexions broker ; aucune interpolation de chaîne d'agent dans HTML ou JavaScript. Les messages/labels restent du texte. Ce bridge n'est ni une route agent ni un canal d'approbation.

Les handlers de présentation sont une entrée hostile renderer vers main. Ils ne peuvent modifier que la fenêtre avatar capturée en main, jamais un identifiant de fenêtre fourni par l'appelant. Le classement tier 1 décrit leur pouvoir ; la garde effective est le contrôle d'émetteur, de frame et des arguments. `reportError` borne les messages à 2 048 caractères et limite les répétitions ; erreurs de chargement et `render-process-gone` sont aussi tracées directement en main pour ne pas dépendre d'un renderer vivant.

### 3. Survol et glisser

Le fond transparent ignore la souris avec `setIgnoreMouseEvents(true, { forward: true })`. Le conteneur détermine le survol de la zone interactive du masque à partir des mouvements transférés ; le booléen `setPointerInside` ne transporte ni sélecteur ni rectangle arbitraire. Le main traduit ce booléen vers l'état d'ignorance de sa seule fenêtre. Le fond transparent ne devient pas une surface de clic ; prévoir l'orchestra et les infobulles dans le test de couverture de cette zone.

Le glisser utilise `pointerdown`, `setPointerCapture`, puis une position absolue calculée depuis l'origine du geste. Pendant la capture, le conteneur maintient la fenêtre interactive, même si le pointeur quitte le masque ; il ne réactive pas le clic à travers au milieu du glisser. `pointerup`, `pointercancel` et perte de capture terminent le geste et rétablissent le hit-test d'après la position actuelle du pointeur. Aucune région `-webkit-app-region: drag`. Le verrouillage et le masquage sont vérifiés en main : ils refusent le déplacement même si le renderer continue d'émettre.

`setPosition` accepte exactement deux nombres finis. Rejeter `NaN`, infinis, chaînes, objets et arguments supplémentaires ; ne pas convertir silencieusement. Le main sélectionne l'écran disponible, borne x/y à sa `workArea` en tenant compte de la taille **qu'il possède**, et applique uniquement la position. N'accepter ni width/height ni écran, URL ou chemin fournis par le renderer. Coalescer les déplacements en conservant la dernière position, sans file croissante. La persistance est temporisée et vidée à la fermeture ; une erreur laisse une trace.

Le canal de survol est distinct du canal de déplacement : « position uniquement » interdit au glisser de redimensionner la fenêtre, mais ne suffit pas à armer le hit-test. Le booléen de survol n'autorise ni commande Deck ni réglage de transparence/opacité arbitraire.

### 4. Cycle de vie et écrans

Créer le contrôleur après obtention du singleton et initialisation du serveur. La fenêtre n'existe que sous Windows ; Tray et branchement restent multi-OS. Première utilisation : visible, alwaysOnTop actif, taille moyenne. Montrer sans activer, après chargement réussi et premier snapshot. Le menu conserve afficher/masquer, premier plan, verrouiller, tailles S/M/L, opacité au repos, DND, mouvement et Quitter.

Masquer ne ferme ni serveur ni branchement ; les animations sont suspendues. Aucun Deck conserve Seul, sans respiration ni orchestra. Aucun masquage automatique sur Seul. Fermer la fenêtre par un geste de fenêtre équivaut à masquer ; Quitter est une action du processus et conserve le nettoyage A1.

**Un reload est une recréation.** Interdire le rechargement/HMR en place pour ce renderer. Sur demande explicite de reload, crash ou rechargement de développement : invalider la génération, détruire les listeners et la fenêtre, puis créer un nouvel objet fenêtre et charger une seule fois son document. Ne jamais rappeler `loadFile` ou `reload` sur la fenêtre vivante. Aucun changement d'état de la peau ne navigue. Un crash est tracé et laisse le Tray disponible ; la restauration passe par l'action Afficher, sans boucle automatique infinie. L'état de l'avatar et les réglages survivent à la fenêtre.

`avatar-appearance.json` est versionné et classé MACHINE, écrit atomiquement par le seul avatar. Il conserve `visible`, `alwaysOnTop`, `positionLocked`, `size`, `idleOpacity`, `motion` et l'échéance absolue DND. Le choix `motion` est strictement `continuous | transitions | none`, défaut `continuous`. La lecture valide le schéma et chaque nombre fini ; une valeur illisible utilise un défaut sûr avec trace, jamais une fenêtre perdue hors écran. Les Decks n'écrivent pas ce fichier.

Les positions sont indexées par identifiant d'écran avec zone utile de référence et coordonnées locales en DIP. L'identifiant est un indice de restauration, pas une garantie matérielle permanente. Vérifier l'écran courant et clampler ; écran absent : choisir un écran disponible, sans écraser la position de l'écran absent. Le redimensionnement relève exclusivement du main, sur changement de taille choisie ou d'écran/DPI ; revalider la taille nominale après cette transition. Pendant le glisser, ne pas réémettre la taille dans chaque mouvement. Les écrans à coordonnées négatives sont valides ; une `workArea` plus petite que le personnage exige une réduction main qui le garde accessible.

### 5. Politique de mouvement

Le conteneur applique une priorité déterministe : fenêtre masquée ou DND actif, puis préférence OS reduced-motion, puis choix du menu. La première branche suspend toutes les animations ; DND éteint le halo, sans changer le visage ni les compteurs.

| Choix | OS sans réduction | OS avec réduction |
| --- | --- | --- |
| `continuous` (défaut) | Animation autorisée par la face ; Seul reste immobile. | Fondus brefs lors des transitions, sans déplacement ni boucle. |
| `transitions` | Transition de face bornée à une seconde, puis statique. | Fondus brefs lors des transitions, sans déplacement ni boucle. |
| `none` | Aucune animation. | Fondus brefs lors des transitions, sans déplacement ni boucle. |

L'OS prime donc aussi sur la valeur `none`, conformément à la règle opérateur « l'emporte sur le réglage ». Un changement de préférence ne rejoue pas les épisodes passés. Les fondus durent au plus 200 ms ; aucun rattrapage à la sortie de DND ou au retour de visibilité. Les changements de compteur ou les snapshots identiques ne sont pas des transitions de face. A2 ne déduit pas l'identité d'un nouvel épisode depuis `waiting`.

Le choix persiste, pas l'état effectif imposé par l'OS. Un changement de préférence OS s'applique en direct. Le thème de la fenêtre se règle dans son conteneur/CSS, sans forcer `nativeTheme.themeSource` du processus et modifier ainsi l'observation du thème de la barre des tâches par le Tray.

## Preuves et limites de la sonde Windows

DÉDUIT du rapport délégué de l'explorer `desktop-7b2civn-koryphaios-3`, carte `8fb62e61` : Electron 43.1.1, Windows 11, écran principal 2560×1440 à 100 %. Les artefacts sont dans `~/.agent-forge/scratch/avatar-a2-probe/out/`. L'auteur n'a pas rejoué ces sondes ; l'explorer n'a pas conservé l'historique shell. Les commandes ci-dessous sont **reconstruites**, pas des commandes attestées par un journal.

Invocation reconstruite : `PROBE_MODE=<mode> PROBE_TAG=<tag> PROBE_ANIM=<animation> desktop/node_modules/electron/dist/electron.exe <dossier-sonde>` ; `PROBE_SCALE` sert aux essais fractionnaires. Les relevés rapportés sont :

| Artefact / essai | Ligne décisive rapportée | Portée |
| --- | --- | --- |
| `reload.json`, mode reload | `R2_after_reload_same_window -> {"under:mousemove":16}` ; après recréation `{"under:mousemove":15,"avatar:mousemove":12}` | Le rappel de setIgnoreMouseEvents après reload ne restaure pas le transfert. |
| `run3.json`, S4_drag_js | `before {"x":500,"y":300} after {"x":580,"y":350}` | Décalage 80,50 exact dans ce run ; click100 et run2 échouent, cause non isolée. |
| `cost_none.json`, mode cost/none | `{"wallSec":25.523,"totalCpuPctOneCore":0.367,"totalWsMB":278.7}` | Avatar seul, une exécution. |
| `cost_light.json`, mode cost/light | `{"wallSec":25.453,"totalCpuPctOneCore":15.347,"totalWsMB":284.6}` | Animation transform 2 s à 60 fps ; pourcentage d'un cœur, pas de la machine. |
| `cost_steps.json`, mode cost/steps | `{"wallSec":25.444,"totalCpuPctOneCore":7.860,"totalWsMB":286.2}` | Sprite d'environ 10 fps ; pas le dessin final. |

SUPPOSÉ, non établi par ces mesures : coût GPU, vrais DPI Windows 125/150 %, écrans à échelles mixtes, stabilité de l'identité physique des écrans. Le second écran existe mais n'a pas été visé. `--force-device-scale-factor` est une émulation : les tailles relevées divergent de 1 à 4 px, ce qui motive la séparation position/taille sans prouver la correction finale.

DÉDUIT du rapport : le test de souris doit utiliser une entrée native `SendInput`, pas seulement `SetCursorPos`, qui ne provoque pas les mouvements transférés dans la sonde. Les pixels transparents d'une fenêtre non ignorée captent les clics : le comportement n'est pas un hit-test alpha automatique.

## Validation exigible

Le périmètre et les limites des gardes L1-L3 sont normatifs dans `docs/DESIGN-AVATAR-A2-LOTS.md`. La livraison ne peut invoquer le succès de la sonde pour sauter le test d'interaction réel de son propre paquet. Si un DPI réel n'est pas disponible, le rapport doit porter NON VALIDÉ pour cette configuration, jamais transformer l'émulation en preuve.

MESURÉ sur l'existant A1 : `bun test ./tests/desktop-avatar-state.test.ts` donne `7 pass`, `0 fail`, `26 expect() calls`. Ce résultat ne couvre aucun renderer, IPC ou réglage A2.
