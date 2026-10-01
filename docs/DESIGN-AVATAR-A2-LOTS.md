# Avatar A2 : étapes de réalisation et périmètres de garde

Contrat : carte `8fb62e61`, `docs/DESIGN-KORY-AVATAR.md` §4.2, §7 et §8 A2, ADR `docs/adr/003-avatar-a2-render-boundary.md`. Ce découpage prescrit le travail ; il ne déclare aucune étape implémentée. Les chemins qualifiés de nouveaux sont des cibles de réalisation, pas des fichiers dont l'existence est affirmée.

## Problem framing

Livrer un personnage Windows branché sur les sept faces A1, sans changement du protocole Deck vers avatar. Le choix du masque reste une validation visuelle : on peut réaliser les frontières et le conteneur sans attendre le dessin, mais on ne peut ni livrer une silhouette provisoire ni valider sa lisibilité à la place de l'opérateur.

## Current structure

DÉDUIT : `desktop/src/main/avatar-entry.ts:47-90` assemble l'état, serveur, sonde et Tray. `desktop/src/shared/avatar-state.ts:118-139` décide déjà la priorité de toutes les faces. `desktop/src/main/avatar-tray.ts:134-160` porte le rafraîchissement ; les nouvelles sorties doivent partager son autorité, pas ajouter une machine renderer. Les entrées de build sont déclarées dans `desktop/electron.vite.config.ts:14-18,28-32,47`.

## Options

- **Un développeur : L1, puis L2, puis L3.** Coordination minimale et même propriétaire des raccords. Le délai de planche peut bloquer la deuxième étape ; aucun gain à fabriquer un masque de remplacement en attendant. Rayon d'impact et garde inchangés.
- **Deux développeurs : L1 et partie structurelle de L2 en parallèle, puis assemblage L3.** Réduit l'attente mais exige le gel préalable du DTO et une propriété explicite des fichiers communs. Réversible avant assemblage ; risque principal de divergence des interfaces et des locales.

## Recommendation

Deux développeurs si disponibles : développeur main sur L1, développeur rendu sur L2 avec le web-designer pour la planche. Un seul intégrateur possède L3 et séquence les commits et le gate global. Un développeur seul suit les mêmes étapes en série, sans changer leurs critères de sortie.

## Target design & migration path

```text
Contrat ADR + union AvatarFace
           |                    nouvelle planche -> choix opérateur
           +-> L1 main                          |
           +-> L2 structure -> L2 peau finale <--+
                    \           /
                     L3 assemblage + Windows
```

### L1 : autorité main, fenêtre, bridge et réglages

**Dépendance :** contrat ADR fixé ; aucune dépendance au dessin final. L1 peut utiliser une fixture visuelle uniquement dans un test privé. La fenêtre de production n'est pas activée avant L3.

**Périmètre des fichiers :**

| Groupe | Fichiers |
| --- | --- |
| Contrat et logique, nouveaux | `desktop/src/shared/avatar-view.ts`, `desktop/src/main/avatar-presentation.ts`, `desktop/src/main/avatar-appearance.ts`, `desktop/src/main/avatar-window-placement.ts` |
| Adaptateur et bridge, nouveaux | `desktop/src/main/avatar-window.ts`, `desktop/src/preload/avatar.ts` |
| Raccords A1 | `desktop/src/main/avatar-entry.ts`, `avatar-tray.ts`, `avatar-tray-menu.ts`, `avatar-quit-handler.ts` si le nettoyage fenêtre l'exige ; conserver le contrat de release du serveur/singleton |
| Build et textes | `desktop/electron.vite.config.ts`, `desktop/locales/en.json`, `desktop/locales/fr.json`, `desktop/src/main/i18n.ts` ; un seul écrivain des trois fichiers de textes, y compris les textes fournis par L2 |
| Gardes | nouveaux `tests/desktop-avatar-presentation.test.ts`, `desktop-avatar-appearance.test.ts`, `desktop-avatar-window-placement.test.ts`, `desktop-avatar-view-ipc.test.ts` ; adapter `desktop-avatar-tray-menu.test.ts`, `desktop-avatar-quit-handler.test.ts`, `desktop-avatar-launch.test.ts`, `desktop-state-scope.test.ts` selon les raccords |

Les fichiers sans chemin complet dans une cellule gardent le répertoire du premier fichier de cette cellule. Les fichiers de logique pure n'importent ni Electron ni le renderer ; les adaptateurs natifs sont injectables pour les tests ciblés.

**Livrable :** un contrôleur alimente Tray et fenêtre depuis un même résumé ; DND et mouvement viennent de `avatar-appearance.json`. Le nouveau bridge expose seulement lecture, position, survol borné et diagnostic, selon l'ADR. La génération de fenêtre change sur recréation. Les fonctions de placement restent indépendantes de l'API native. Les méthodes mutantes de `AvatarState` et le protocole Deck n'ont pas à être étendus.

**Périmètre de garde :**

1. **Producteur vers sorties.** Exécuter un vrai `AvatarState` sous horloge injectée et constater le même résumé dans le Tray et l'émetteur fenêtre. Couvrir état initial, attache, détachement, broker défaillant indépendant d'un heartbeat, suspect sans événement entrant, aucun Deck et deux identités partageant un projet ou un nom. Un événement déclaré sans émission doit rendre le test rouge.
2. **Tous les handlers du bridge.** Comparer les canaux enregistrés à l'allow-list typée d'`AvatarViewApi`, puis exercer chaque handler pour fenêtre courante/frame principale, fenêtre étrangère, sous-frame et génération détruite. Tester les clés exactes de la projection en injectant des métadonnées/credentials dans l'objet source : ils ne traversent pas. Une nouvelle méthode doit être classée lecture, présentation ou diagnostic, jamais autorisée par défaut.
3. **Position et hit-test.** Valeurs finies acceptées ; NaN, infinis, chaînes, paramètres supplémentaires et tentative width/height refusés. Clamp avec coordonnées négatives, zone utile réduite, écran absent, déplacement bloqué quand verrouillé ou masqué. Vérifier sur l'adaptateur qu'un glisser ne reçoit que x/y et que le survol n'agit que sur la fenêtre courante. Coalescence bornée, dernière position conservée.
4. **Persistance et cycle de vie.** Fichier MACHINE distinct, validation des trois modes, défaut continu, DND à échéance absolue et expiration après redémarrage ; corruption tracée ; lecture/écriture n'altérant pas autoAttach/opt-out. Recréation détruit l'ancienne fenêtre avant nouvel objet, un crash conserve le Tray, aucune boucle de relance, fermeture/quit libèrent les listeners et timers. Afficher/masquer et zéro Deck ne détachent rien.
5. **Couverture de la garde.** Tester comportement et câblage, pas seulement la présence des noms dans les sources. Contre-épreuves requises : mauvaise fenêtre acceptée, taille issue du renderer, retrait d'un champ de projection, suppression d'une sortie, deuxième lecteur de DND et reload en place. Réaliser les mutations dans un miroir privé, pas dans le checkout partagé.

**Limite nommée :** ces tests injectés prouvent la politique et les appels d'adaptateur, pas l'application de la sandbox Electron, le transfert souris Windows, la lisibilité ni le chargement du preload dans le paquet. Le contrôle des émetteurs protège l'objet fenêtre ; il ne prouve pas qu'un appel de présentation vient d'un geste humain. Un renderer compromis reste capable de déplacer sa propre fenêtre dans les bornes accordées. L3 ferme les garanties natives, pas L1.

**Exécution ciblée :** lancer séparément chaque fichier de test ajouté ou modifié, par exemple `bun test ./tests/desktop-avatar-view-ipc.test.ts`. Rapporter les commandes et les compteurs. Aucun gate complet par le développeur non intégrateur.

### L2 : conteneur, peau, textes et géométrie du Tray

**Dépendances :** DTO et surface `AvatarViewApi` de L1 figés avant le travail parallèle. Planche nouvelle de deux ou trois silhouettes, chacune avec les sept faces et orchestra en arc, puis sélection par l'opérateur **avant de figer les chemins du masque et les ressources finales**.

**Ce qui démarre avant la planche :** abonnement/révision/désabonnement, conteneur et politique de mouvement, matrice de fixtures issue d'`AvatarState`, textes des sept faces, registre de peaux et interface de géométrie partagée. La fixture neutre sert aux tests, n'est pas le personnage livré. Le contour final, la zone interactive réelle, les animations du dessin, l'orchestra, les captures de lisibilité et les PNG Tray attendent le choix.

**Périmètre des fichiers :**

| Groupe | Fichiers |
| --- | --- |
| Entrée renderer dédiée, nouveaux | `desktop/src/renderer/avatar.html`, `desktop/src/renderer/src/avatar/main.tsx`, `AvatarApp.tsx`, `AvatarShell.tsx`, `skins.ts`, `MaskSkin.tsx`, `motion.ts`, `avatar-api.d.ts` sous `desktop/src/renderer/src/avatar/` |
| Géométrie, nouveau | `desktop/src/shared/avatar-mask-geometry.ts` : données pures de dessin communes au personnage et à la génération Tray ; ni état métier ni dépendance au DOM |
| Styles et glyphes | `desktop/src/renderer/src/styles.css`, `desktop/src/renderer/src/components/icons.tsx` seulement si un glyphe requis manque ; réutiliser warning, clepsydra, caducée et torchOut, pas un jeu externe |
| Tray dérivé | `scripts/avatar-tray/`, `desktop/resources/avatar-tray/`, `desktop/src/main/avatar-tray-icon.ts` ; géométrie issue du personnage avec détail réduit, toutes variantes clair/sombre et tailles conservées |
| Gardes et livrables visuels | nouveaux `tests/desktop-avatar-skin.test.ts`, `desktop-avatar-motion.test.ts` ; adapter `desktop-avatar-tray-icon.test.ts` et `desktop-avatar-theme-source.test.ts` si nécessaire ; planche et sources dans `docs/design/avatar-a2/` |

`styles.css` reste la feuille de référence. Isoler les règles du conteneur sous une classe racine avatar, avec fond de page transparent ; ne pas monter le store ou `App.tsx` du Deck. Les tokens clair/sombre restent communs. La géométrie partagée ne doit pas importer la peau depuis le main. Les libellés de L2 sont remis au propriétaire L1 des trois fichiers de locales, sans écritures concurrentes.

**Livrable :** sept visages distincts, un texte par face, badges des états inférieurs, orchestra par Deck conservant les pannes locales, visage Panne agrégé. Seul : yeux entièrement fermés et orchestra vide ; Endormi : mi-clos avec Decks présents. Peau pure, politique dans le conteneur. Le Tray dérive ensuite ses ressources de la géométrie retenue ; son nombre de variantes ne doit pas imposer au personnage de fusionner des faces.

**Périmètre de garde :**

1. **Domaine exhaustif de peaux et de faces.** L'enregistrement des peaux est la source du parcours, le domaine des faces provient du type de production avec contrôle d'exhaustivité compilé. Produire chaque résumé par `AvatarState` ; un test de rendu et de texte par combinaison, sans se satisfaire d'un SVG non vide. L'ajout d'une peau ou d'une face doit exiger sa couverture, pas modifier manuellement une seconde liste de sept fixtures silencieusement incomplète.
2. **Sémantique combinée.** Panne d'un seul Deck avec un autre actif ; Reclame prioritaire sur Perdu/Courrier/Travaille mais badges conservés ; Courrier injecté sans nouveau producteur ; Seul distinct d'Endormi ; valeurs agrégées exactes. Identité des pastilles = couple run/broker, pas indice, label ou projet.
3. **Matrice mouvement.** Trois valeurs × deux préférences OS × sept faces, étendue par masqué/DND et transitions. Tester résultat effectif, durée bornée, absence de boucle en mode transitions et reduced-motion, pas de respiration Seul, pas de rejeu sur heartbeat/compteur, réapparition ou sortie DND. L'OS prime sur les trois choix, y compris `none` ; DND/masquage suspendent tout. Le test appelle le code consommé par le conteneur, pas une table dupliquée.
4. **Rendu réel.** Captures des sept faces sur gris moyen, monochrome, à taille nominale, thèmes clair/sombre, avec lecture à deux mètres par l'opérateur. Contrôle explicite de la règle anti-empreinte de patte. Examiner les styles calculés et les animations actives dans un Electron privé pour prouver que les classes du conteneur gouvernent réellement la peau.
5. **Tray dérivé.** Générer les ressources depuis la même source géométrique ; vérifier fichiers, dimensions 16/32 et variantes thème, images non vides, mapping `summary.face` et changement d'image. Jugement à taille réelle requis : l'image 120 px ne valide pas le Tray 16 px.

**Limite nommée :** le typage ferme le domaine, pas la justesse du dessin. Un test DOM ne prouve ni distinction perceptive ni mouvement CSS effectif ni coût CPU. Les captures ne prouvent pas le hit-test Windows. Le succès d'une génération d'images ne prouve pas leur présence dans le paquet. Ces limites vont à la validation visuelle et à L3 ; aucune moyenne de screenshots ne remplace la décision opérateur.

**Exécution ciblée :** `bun test ./tests/desktop-avatar-skin.test.ts` et `bun test ./tests/desktop-avatar-motion.test.ts`, puis fichiers Tray effectivement modifiés, un appel ciblé par fichier. Les tests DOM contaminant les globals doivent suivre l'isolation de processus du projet.

### L3 : assemblage, paquet Windows et validation native

**Dépendances :** L1 et L2 livrés, planche sélectionnée, raccords d'interface conformes, ressources Tray générées. Reprendre l'ownership des fichiers communs avant toute édition. La sonde oriente les choix mais ne clôt aucun test du binaire livré.

**Périmètre des fichiers :**

| Groupe | Fichiers |
| --- | --- |
| Assemblage | `desktop/src/main/avatar-entry.ts`, `desktop/src/main/avatar-window.ts`, `desktop/electron.vite.config.ts`, `desktop/electron-builder.yml` seulement si le paquet l'exige |
| Documentation | `DESKTOP.md`, `desktop/docs/interface.md`, `docs/DESIGN-KORY-AVATAR.md` pour précision du contrat si nécessaire, compte rendu de validation dans `docs/design/avatar-a2/` |
| Tests de raccord | nouveaux `tests/desktop-avatar-window-lifecycle.test.ts`, `tests/desktop-avatar-renderer-package.test.ts`, fixture native `tests/fixtures/avatar-a2-electron.cjs` ; tests A1 ciblés des raccords effectivement modifiés |

**Périmètre de garde :**

1. **Paquet réel et frontière.** Lancer le binaire Windows construit dans un profil privé, vérifier qu'il charge l'entrée et le preload avatar, qu'il rend les sept faces et n'expose pas les méthodes `DeckApi`. Prouver rejet d'un appel depuis une autre fenêtre et une sous-frame, refus de navigation, absence de liaison companion. Ne pas prendre un scan des options BrowserWindow pour une preuve de sandbox native.
2. **Interactions réelles.** `SendInput` et témoins DOM dans la fenêtre sous-jacente : clic extérieur au masque transmis, survol du masque reçu, clic dans la zone interactive capté, drag exact, fin/cancel/perte de capture, verrouillage, release hors fenêtre. Répéter après afficher/masquer, recréation, crash et changement de face/tailles. Un curseur déplacé par `SetCursorPos` seul ne valide pas le transfert. Reproduire au moins les scénarios JS ayant échoué dans click100/run2, sans attribuer leur échec à une cause non isolée.
3. **Écrans/DPI et persistance.** 100 %, vrais 125/150 % OS, écrans mixtes, passage entre écrans, coordonnées négatives, retrait/reconnexion et restauration après redémarrage. Comparer position et taille observées à celles attendues ; un drag ne doit pas accumuler de dérive. Un essai émulé est nommé émulé. Configuration indisponible = NON VALIDÉE, à remonter au lead avant clôture.
4. **Usage et performances.** Aucun Deck, deux Decks, un broker en panne, DND expirant, masquage, réapparition, choix de mouvement conservé au redémarrage et reduced-motion live. Comparer visuellement Tray/personnage depuis le même état. Relever le coût du dessin final pour continu/transitions/aucune et masqué : fenêtre de mesure, nombre d'exécutions, CPU en pourcentage d'un cœur, mémoire, matériel. Ne pas transformer le chiffre de sonde en seuil garanti, ni le pourcentage d'un cœur en pourcentage machine. Quitter libère le singleton et le rendez-vous sans fermer les Decks.
5. **Gate d'intégration.** L'intégrateur exécute une seule fois le gate complet prévu par `TESTING.md`, après les étapes ; les suites complètes passent par le test-runner du projet. Il conserve les traces du paquet testé et les checksums. Les développeurs des étapes n'exécutent que leurs fichiers ciblés et remettent les risques inter-fichiers au gate commun.

**Limite nommée :** preuve native bornée au matériel, OS, version Electron, moniteurs et échelles consignés. Pas de garantie générale sur tous les GPU, changements de topologie ou versions Windows. La mesure de charge ne permet pas de promettre une consommation identique ailleurs ; le réglage trois modes reste offert indépendamment du résultat. La fermeture d'A2 exige que tout reste NON VALIDÉ soit visible au lead, pas absorbé dans un « tests verts ».

## Attribution des surfaces communes

Le DTO partagé appartient à L1 jusqu'au gel, puis toute modification passe par accord des deux développeurs. `avatar-entry.ts`, build, Tray-menu et locales ont un seul propriétaire L1, transféré à L3 pour l'assemblage. La géométrie, les ressources et scripts Tray appartiennent à L2 ; ne pas écraser les changements d'un autre chantier présent sur ces mêmes chemins. `avatar-state.ts`, `avatar-protocol.ts`, `avatar-counters.ts` et le broker ne reçoivent aucune extension A2. Une nécessité de changer ce périmètre revient au lead avec sa raison, pas à un élargissement implicite de l'étape.

## État des preuves à l'écriture

MESURÉ : `bun test ./tests/desktop-avatar-state.test.ts` donne `7 pass`, `0 fail`, `26 expect() calls`. Ce test porte seulement sur A1. Les fichiers de tests A2 nommés ci-dessus sont des livrables prescrits, pas des tests annoncés verts. La liste des limites de la sonde déléguée et sa provenance figurent dans l'ADR.
