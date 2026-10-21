# Choregos : L3, distribution des mods par le Deck

Date : 2026-10-22. Carte : f732182b. Statut : proposition de découpage. L3 distribue la copie épinglée et câble son chargement derrière un interrupteur inactif. Il n'active rien : l'activation et sa validation visuelle relèvent de L4. Fichier séparé de `DESIGN-CHOREGOS-L2.md`, parce que L2 est clos et commité. Une section ajoutée à ce brief mêlerait un lot fermé et un lot ouvert dans le même document.

## Problème et contraintes acquises

Une tuile doit pouvoir charger un plugin de `desktop/mods/` sans jamais écrire dans la copie distribuée, en dev comme en paquet, et sans rien changer tant que l'interrupteur est éteint.

- **MESURÉ**, append f732182b du 2026-10-20 à 13:01 (developer 2) : une session interactive lancée avec `--plugin-dir` écrit `tsconfig.json` et `.claude-plugin/types/*` dans le dossier du plugin, et réécrit `.claude-plugin/types/.gitignore`.
- **MESURÉ**, `ls` et `cat` sur `desktop/deck-plugin` : le plugin Deck subit déjà cette écriture. `hooks/hooks.json` déclare `"modules": ["./kory-module.mjs"]`. `.claude-plugin/types/claude-code/index.d.ts` et `tsconfig.json` sont présents sur disque, et ce dernier est ignoré par `desktop/.gitignore:24` (`git check-ignore -v`).
- **DÉDUIT**, `tests/desktop-mods.test.ts:22-28,44-48` : le test d'empreinte hache tout fichier présent sous `desktop/mods/<plugin>`. Un `--plugin-dir` sur la copie suivie le ferait passer au rouge.
- Décisions à respecter :
  - ab5ae18c : `MIN_SUPPORTED`. Le plugin rend lui-même le rendu stock sous la version minimale, donc Kory n'ajoute aucun test de version.
  - Règle 1 du CLAUDE.md : un interrupteur ne se lit jamais dans le dépôt cloné.
  - Règle 5 : ce qui entre dans un conteneur est copié, jamais monté.

## Structure actuelle et frontières

- **DÉDUIT**, `desktop/electron-builder.yml:9-11,16-32` : `files` n'embarque que `out/**` et `package.json`. `extraResources` livre `locales`, `docs`, `deck-plugin`, `deck-lead-plugin`, `sandbox` et `avatar-tray`, mais pas `mods`. Aujourd'hui, rien n'empaquette `desktop/mods`, conformément à la mesure du reviewer.
- **DÉDUIT**, `desktop/src/main/session-command.ts:30-36` : `deckPluginDirFor` et `deckLeadPluginDirFor` résolvent `join(isPackaged ? resourcesPath : appPath, <nom>)`. `desktop/src/main/index.ts:568-591` refait `existsSync` à chaque spawn et signale une absence une fois par épisode (`createMissingDirTracker`, `session-command.ts:143`).
- **DÉDUIT**, `session-command.ts:116-133`, flags de plugin :
  - `pluginFlags` émet un `--plugin-dir` par entrée.
  - `pluginDirsForTile` place `deck-plugin` en premier et omet le plugin de rôle dans une tuile sandboxée (`rolePluginOmitted`, signalé par `index.ts:595-600`).
  - Les flags sont émis au lancement frais comme à la reprise (`:205`, `:208`).
- **DÉDUIT**, sandbox :
  - `index.ts:953-956` applique `rewritePluginDirForContainer` à la ligne de commande.
  - `sandbox-command.ts:167-169` le fait avec une regex sans drapeau `g`, qui ne remplace que le PREMIER `--plugin-dir`, par `SANDBOX_DECK_PLUGIN_DIR` (`~/.claude/deck-plugin` dans le conteneur, `:68,74,84`).
  - `sandbox-service.ts:1183-1209` copie le `deck-plugin` de l'hôte dans le conteneur (`docker cp`, puis `chown`), sans montage.
  - Conséquence : un second `--plugin-dir` arriverait dans le conteneur avec un chemin HÔTE illisible.
- **DÉDUIT**, configuration globale : `AppConfig` (`desktop/src/shared/types.ts:330` et suivantes), défauts dans `desktop/src/main/store.ts:29` et suivantes. Précédent d'opt-in éteint : `autoResumeQuota: false` (`store.ts:63`), avec surcharge par session (`types.ts:381-384`).
- **MESURÉ**, `ls` sur le clone local de choregos : aucun dossier `docs/`. Je n'ai donc pas trouvé le protocole C1 « deux copies » prévu par `DESIGN-CHOREGOS-L2.md:38`, ni son résultat.

## Options et recommandation

Trois choix indépendants.

**Où charger.**
- **A, la copie distribuée directement**, comme `deck-plugin`. Le moins coûteux. Écarté : le moteur écrit dans l'arbre suivi en dev, ce qui fait passer l'empreinte au rouge. En paquet, l'écriture modifie l'installation. **SUPPOSÉ** : elle échoue sur un AppImage (squashfs en lecture seule) et altère un bundle macOS signé.
- **B, copie de travail par run** (`userData/mods/run-<id>/`). Recopiée à chaque démarrage, sans vérification de réutilisation. Coût caché : nettoyer les runs morts suppose de savoir si un autre Deck vit encore. Or `sandbox-service.ts:1425` atteste qu'aucun verrou d'instance unique n'existe.
- **C, copie de travail adressée par contenu** (`userData/mods/<plugin>/<empreinte>/`). Le code est immuable et vérifié avant chaque spawn. Deux Deck de même version partagent le même dossier vérifié ; deux versions coexistent sans s'écraser. Pas de nettoyage en L3, puisqu'un autre Deck peut encore utiliser une ancienne empreinte. La croissance reste bornée par le nombre de mises à jour.

**Sandbox.**
- **S1, omettre les mods dans une tuile sandboxée**, sur le précédent du plugin de rôle, avec un signalement par épisode. Le rendu y reste stock et la ligne de commande du conteneur ne change pas.
- **S2, projeter la copie de travail dans le conteneur**, par `docker cp` comme `deck-plugin`. Il faut alors remplacer la regex par une table exacte hôte vers conteneur, flag par flag. On obtient la parité, mais on touche le cycle de projection et la réécriture de toutes les tuiles sandboxées.

**Interrupteur.**
- **I1** : un champ global par plugin dans `AppConfig`, éteint par défaut, sans interface en L3.
- **I2** : I1 plus un réglage visible dès L3.
- **I3** : I2 plus une surcharge par session.

**Recommandation : C + S1 + I1.** Deux forces décident. Interrupteur éteint, la ligne de commande doit rester identique à l'octet près ; allumé, aucun fichier non vérifié contre le verrou ne doit être chargé. C est la seule option qui vérifie ce qui est réellement chargé au moment du spawn. S1 garde la commande du conteneur intacte. I1 laisse à L4 l'interface d'activation, qui est précisément son objet.

## Conception cible

```
desktop/mods (dev) | resources/mods (paquet)        -- modsDirFor
   | vérifié contre choregos.lock.json (empreinte complète)
   v
userData/mods/<plugin>/<empreinte>/                 -- copie de travail
   | le moteur y écrit tsconfig.json et .claude-plugin/types/**
   v
pluginDirsForTile(..., modsActivés, sandboxed)      -- --plugin-dir après deck-plugin,
                                                       frais ET reprise
```

- **Chemins du moteur** : `tsconfig.json` à la racine du plugin et `.claude-plugin/types/**`. Ils sont définis UNE fois, dans une constante `ENGINE_PATHS` du module d'empreinte partagé, que `scripts/sync-mods.ts`, le filtre de K3a et la vérification de K3b importent tous.
- **Ensembles disjoints par construction** (révision du 2026-10-22, revue sécurité, B1) :
  - **MESURÉ par la revue**, `.claude-plugin/types/.gitignore` figure à la fois au verrou et parmi les chemins du moteur : `modsFingerprint` recalculé donne l'égalité au verrou sur l'ensemble complet, et l'inégalité une fois les chemins du moteur retirés.
  - **DÉDUIT**, cause : `isDistributable` accepte tout le préfixe `.claude-plugin/` (`scripts/sync-mods.ts:64-65`). Conséquence : le filtre de K3a produirait une copie dont l'empreinte diffère du verrou, donc des mods qui ne se chargeraient jamais en paquet.
  - **MESURÉ**, `git ls-files` dans choregos : `plugins/prosopon/.claude-plugin/types/.gitignore` et `plugins/mitos/.claude-plugin/types/.gitignore` sont suivis.
  - Correctif : `sync-mods` REFUSE tout fichier amont situé sous `ENGINE_PATHS`. Aucun fichier distribué n'est alors un chemin du moteur, et l'empreinte de la copie complète égale celle de la copie privée de ces chemins. Ce refus impose le lot C3 côté choregos, puis une resynchronisation du verrou.
- **Vérification de la copie distribuée** : empreinte complète, égale à celle du verrou. Elle refuse un lien, comme le test actuel.
- **Vérification de la copie de travail** :
  - Hors chemins du moteur, la liste de fichiers doit être exactement celle de la copie distribuée, avec le même contenu. Un fichier en trop est une dérive. C'est le cas qui compte : `bin/`, `.mcp.json`, `agents/`, `skills/`, `commands/` ou `settings.json` seraient chargés par le moteur sans figurer au verrou.
  - `lstat` sur CHAQUE entrée, dossiers compris : un lien ou une jonction est une dérive.
  - Les chemins du moteur ne sont pas inertes. Le `tsconfig.json` écrit par le moteur fait `extends` vers `.claude-plugin/types`, et le Bun embarqué lit le tsconfig le plus proche. **SUPPOSÉ**, d'après la revue : son effet sur le chargeur de hooks. Donc `tsconfig.json` racine absent, ou égal octet pour octet à la forme `extends` unique que le moteur écrit ; toute autre valeur est une dérive.
  - La forme `extends` délègue tout à `.claude-plugin/types/tsconfig.json`. Ce fichier n'est donc toléré que s'il passe une liste blanche (révision du 2026-10-22, tentative 3).
    - **MESURÉ**, `cat` sur `desktop/deck-plugin/tsconfig.json` et `desktop/deck-plugin/.claude-plugin/types/tsconfig.json`, arbre de types d'en-tête « Written by Claude Code 2.1.306 » :
      - la racine vaut `{"extends": "./.claude-plugin/types/tsconfig.json"}` ;
      - le fichier délégué n'a que deux clés de premier niveau, `compilerOptions` et `include` (`["../../hooks", "../../types", "../../tests"]`).
    - Clés de `compilerOptions` admises, celles mesurées : `target`, `lib`, `module`, `moduleResolution`, `strict`, `noUncheckedIndexedAccess`, `noEmit`, `skipLibCheck`, `jsx`, `jsxFactory` (valeur `"h"` exigée), `jsxFragmentFactory` (valeur `"Fragment"` exigée), `typeRoots` (`["."]`), `types`.
    - Premier niveau : seulement `compilerOptions` et `include`, avec `include` égal à la liste mesurée.
    - Dérive explicite : `paths`, `baseUrl`, `jsxImportSource`, un `extends` dans ce fichier, et toute autre clé.
    - Les autres fichiers de `.claude-plugin/types/**` sont des déclarations `.d.ts`, tolérés.
    - Limite assumée : la liste vient d'une seule version du CLI. Une clé ajoutée par une version future rend le plugin non chargé (rendu stock) et signalé, ce qui échoue fermé et visible.
  - Une dérive part par un `rename` atomique vers `<empreinte>.drift-<aléa>`, puis une matérialisation neuve (staging puis `rename`) et un signalement par épisode. Jamais de suppression récursive, ni en place ni en repli. Une suppression ne libère rien de plus qu'un `rename` : sous Windows, un fichier ouvert par une tuile vivante d'un autre Deck bloque les deux, `rename` du dossier compris (**SUPPOSÉ**, selon le mode de partage `FILE_SHARE_DELETE` de l'ouvreur). Elle détruirait en plus une copie qu'une tuile vivante utilise. Si le `rename` est refusé, le plugin n'est pas chargé pour ce spawn et l'échec est signalé.
  - Une course entre deux Deck se résout en revérifiant le dossier gagnant. Si la rematérialisation échoue, le plugin n'est pas chargé et le signalement part une fois par épisode : le rendu reste stock, sans danger.
- **Segments de chemin** : le nom de plugin suit `^[a-z0-9][a-z0-9-]{0,63}$`. Il est refusé dès l'écriture du verrou par `sync-mods`, et revalidé côté Deck avant tout `join`. L'empreinte suit `^[0-9a-f]{64}$`, revalidée de même.
- **Une seule définition de l'empreinte** : `modsFingerprint`, la normalisation CRLF et la liste distribuable sortent de `scripts/sync-mods.ts` vers un module pur partagé par le script et par le Deck. Deux copies d'une règle de hachage divergent.
- **Portée de la vérification** : c'est un contrôle de cohérence, pas une barrière contre le compte utilisateur, qui peut déjà modifier `~/.claude`. Sa valeur : ce qui est chargé AU SPAWN est ce qui a été verrouillé. La fenêtre entre vérification et usage court jusqu'à la fin de la session, pas seulement jusqu'au spawn : skills, agents et commands sont chargés paresseusement, la reprise relit le dossier, et `<plugin_root>/bin` reste sur le PATH. La règle de liste exacte couvre ces chemins au spawn, pas pendant la session. En S2, ce qui serait copié dans le conteneur serait aussi vérifié.
- **Effet de l'interrupteur** : il est lu à chaque spawn, frais ou reprise. Une tuile vivante garde son jeu de plugins jusqu'à son prochain lancement.
- **Joignabilité de l'interrupteur** : « sans interface » ne veut pas dire « injoignable ». **DÉDUIT**, `desktop/src/main/ipc.ts:739` : `config:set` accepte un `Partial<AppConfig>`, et `desktop/src/shared/companion.ts:521` le classe au tier 3. L'assainissement (clé présente au verrou, valeur `=== true`) se fait donc à la LECTURE, à chaque spawn, et pas seulement à l'écriture.

## Lots exécutables

### C3 : chemins du moteur hors du dépôt, Choregos, developer

Prérequis de la resynchronisation de K3b. Supprimer `plugins/prosopon/.claude-plugin/types/.gitignore` et `plugins/mitos/.claude-plugin/types/.gitignore`, et les remplacer par des règles du `.gitignore` racine qui ignorent `plugins/*/.claude-plugin/types/` et `plugins/*/tsconfig.json`. Ainsi, un développeur du plugin ne commite toujours pas les types générés.

**Acceptation** : aucun fichier suivi sous un chemin du moteur ; une session `--plugin-dir` sur un plugin du dépôt laisse `git status` propre.

**Mutation** : une règle racine retirée ; les types générés apparaissent alors dans `git status`.

### K3a : résolution et packaging, Koryphaios, developer

**Fichiers** :
- `desktop/src/main/session-command.ts` : `modsDirFor`, placé à côté de `deckPluginDirFor`.
- `desktop/electron-builder.yml` : entrée `extraResources` de `mods` vers `mods`, avec un filtre qui exclut les chemins du moteur. Le YAML ne peut pas importer `ENGINE_PATHS` : un test importe la constante et exige que les motifs du filtre en soient la traduction exacte.
- `tests/desktop-electron-builder-resources.test.ts` : liste des entrées connues, et parité du filtre avec `ENGINE_PATHS`.
- `tests/desktop-launch.test.ts` : résolution.

**Acceptation** :
- En dev, le chemin est `<appPath>/mods` ; en paquet, `<resourcesPath>/mods`.
- Le YAML liste `mods`, et le test de complétude des sources reste vert.
- Un packaging unique vers un dossier jetable (`.claude/rules/electron-packaging.md`, jamais `desktop/dist`) montre `resources/mods` avec le verrou et les fichiers du plugin, sans aucun chemin du moteur. Ce résultat figure dans le corps du commit.

**Mutations** :
- Ternaire inversé dans `modsDirFor`.
- Entrée `mods` retirée du YAML.
- Un chemin ajouté à `ENGINE_PATHS` sans son motif dans le YAML : le test de parité passe au rouge.
- Le filtre retiré n'est visible que par le test empaqueté (`skipIf` sans arbre) : le dire dans le corps du commit, ne pas le présenter comme gardé par la gate.

### K3b : copie de travail, Koryphaios, developer + test-engineer

**Fichiers** :
- Nouveau module pur `desktop/src/main/mods-working-copy.ts`, en builtins Node seulement.
- Module d'empreinte partagé, qui porte `ENGINE_PATHS` et les deux motifs de segment, réexporté par `scripts/sync-mods.ts`.
- `scripts/sync-mods.ts` : refus d'un fichier amont sous `ENGINE_PATHS`, refus d'un nom de plugin hors motif à l'écriture du verrou. Puis resynchronisation du verrou sur le commit choregos qui porte C3.
- Nouveau `tests/desktop-mods-working-copy.test.ts`, autorisé puisqu'il couvre un nouveau module source.
- `tests/desktop-mods.test.ts` : chemin d'import, et cas de refus de `sync-mods` sur les dépôts-fixtures hostiles existants.

**Acceptation**, sur dossiers temporaires :
- Copie distribuée conforme : elle est matérialisée, puis réutilisée sans recopie au second appel.
- Copie distribuée qui dérive du verrou : refusée.
- Lien dans la copie distribuée : refusé.
- Copie CRLF : même empreinte.
- `types/` et `tsconfig.json` écrits par le moteur, sous leur forme `extends` : copie réutilisée, sans recopie.
- `tsconfig.json` racine d'un autre contenu : dérive.
- `.mcp.json`, `bin/x` ou `agents/x.md` ajouté : dérive.
- Lien ou jonction, sur un fichier comme sur un dossier : dérive.
- Toute dérive : dossier renommé en `<empreinte>.drift-<aléa>`, copie neuve, signalement unique.
- `rename` de la dérive refusé (injecté) : plugin non chargé, échec signalé, dossier intact, aucune suppression.
- `.claude-plugin/types/tsconfig.json` mesuré : toléré. Même fichier avec `paths`, `baseUrl`, `jsxImportSource`, `extends`, une clé inconnue, `jsxFactory` différent de `"h"` ou `include` différent : dérive.
- Amont portant `.claude-plugin/types/.gitignore` : `sync-mods` refuse.
- Nom de plugin `../x` ou majuscule, au verrou ou relu par le Deck : refusé avant tout `join`. Empreinte hors motif : refusée.
- Deux verrous d'empreintes différentes : deux dossiers qui coexistent.
- Deux matérialisations concurrentes : le même dossier vérifié.
- Staging abandonné : ignoré.

**Mutations** :
- Comparaison au verrou supprimée.
- Fichier en trop accepté.
- Chemins du moteur comptés comme du code : recopie à chaque spawn, détectée par l'identité des fichiers.
- Clé réduite au nom du plugin : deux versions s'écrasent.
- Lien suivi au lieu d'être refusé (`stat` à la place de `lstat`).
- Suppression récursive en place au lieu du `rename`.
- Refus de `ENGINE_PATHS` retiré de `sync-mods` : la fixture amont qui porte `types/.gitignore` rend le test rouge.
- Revalidation du nom de plugin retirée côté Deck.
- `tsconfig.json` racine toléré quel que soit son contenu.
- Liste blanche du `tsconfig.json` délégué remplacée par une liste noire (`paths` seul) : une clé inconnue passe.
- Suppression récursive en repli d'un `rename` refusé.

### K3c : interrupteur et câblage, Koryphaios, developer

**Fichiers** :
- `desktop/src/shared/types.ts` : champ par plugin dans `AppConfig`.
- `desktop/src/main/store.ts` : défaut vide.
- Assainissement à la LECTURE, à chaque spawn (seules les clés du verrou de valeur `=== true` comptent), puisque `config:set` reste joignable.
- `desktop/src/main/sandbox-command.ts` : `rewritePluginDirForContainer` REFUSE (exception + `reportError`) une commande qui porte plus d'un `--plugin-dir`. **DÉDUIT**, `:167-169` : aujourd'hui, elle ne réécrit que le premier et échoue donc ouverte.
  - Le comptage couvre TOUTES les formes que le CLI accepte : `--plugin-dir=x`, `--plugin-dir x` sans guillemets, entre guillemets doubles ou entre apostrophes (révision du 2026-10-22, tentative 3, CWE-184).
  - **DÉDUIT par la revue**, `session-command.ts:209-211` : `args` vient APRÈS `pluginFlags` et la base AVANT. La regex actuelle `--plugin-dir "[^"]*"` ne voit pas ces formes.
  - Changement de comportement, à écrire dans le corps du commit : une tuile sandboxée dont la base ou les arguments portaient déjà un `--plugin-dir` ne démarre plus, avec une trace.
- `session-command.ts` : `pluginDirsForTile` reçoit les mods activés.
- `index.ts` : matérialisation et signalement par épisode, aucune décision.
- `tests/desktop-launch.test.ts` et `tests/desktop-sandbox-command.test.ts`.

**Acceptation** :
- Interrupteur éteint : commande identique à l'octet près à celle d'aujourd'hui, au lancement frais comme à la reprise.
- Interrupteur allumé : `--plugin-dir "<copie de travail>"` après `deck-plugin`, dans les deux modes.
- Tuile sandboxée : mods omis et signalés. Après réécriture, tout `--plugin-dir` de la commande conteneur vaut `SANDBOX_DECK_PLUGIN_DIR`.
- Clé inconnue, valeur non booléenne ou nom de type chemin (`"../x"`) : ignorés, y compris s'ils ont été écrits par `config:set`.
- Commande à deux `--plugin-dir` passée à la réécriture conteneur : refusée, tuile marquée sortie avec une trace.
- Tuile sandboxée dont les `args` portent `--plugin-dir=x`, `--plugin-dir x` ou `--plugin-dir 'x'` : refusée.
- Tuile sandboxée dont la base porte `--plugin-dir` : refusée.

**Mutations** :
- Défaut à `true`.
- Flag oublié à la reprise.
- Branche sandbox qui garde les mods : un chemin hôte passe dans le conteneur.
- Assainissement fait seulement à l'écriture : une valeur posée par `config:set` passe.
- Mod placé AVANT `deck-plugin` : la réécriture vise alors le mod, et le chemin hôte de `deck-plugin` fuit.
- Réécriture conteneur qui accepte deux `--plugin-dir`.
- Comptage limité à la forme entre guillemets doubles : `--plugin-dir=x` dans les `args` passe.

**Ordre** : C3 avant la resynchronisation de K3b ; K3a et K3b en parallèle, K3c ensuite. Seul K3c touche `index.ts`, et uniquement pour transmettre des valeurs. La décision vit dans `pluginDirsForTile`, une fonction pure, ce qui évite toute extraction de corps dans `index.ts`.

## Coût en tests

- Les trois lots se testent en module pur ou sur dossier temporaire : aucun broker, aucun `server.ts`, aucun PTY, aucun Electron enfant.
- Les tests étendent les fichiers existants (`desktop-launch`, `desktop-sandbox-command`, `desktop-electron-builder-resources`), plus un seul fichier neuf, pour le nouveau module.
- Aucun scan textuel n'est nécessaire.
- Le packaging se mesure une fois, hors gate. Le test empaqueté existant reste en `skipIf` sans arbre.
- L3 ne lance aucun CLI réel. Avant L4, une session PTY sonde la propriété « le moteur écrit dans la copie de travail, la copie distribuée garde son empreinte ». La même sonde répond à une seconde question : un `tsconfig.json` planté change-t-il le rendu ? Cette sonde est une mesure isolée, consignée dans le corps du commit, pas un test de la gate.

## Clôture, hors L3 et décisions opérateur

**Clôture L3** : C3, K3a, K3b et K3c livrés ; verrou resynchronisé sans chemin du moteur ; interrupteur éteint par défaut ; commande inchangée tant qu'il l'est ; packaging mesuré une fois.

**Conditions pour allumer en L4, pas pour livrer L3** :
- Résultat C1 sur deux copies : prosopon installé par marketplace ET chargé par `--plugin-dir`.
- Ordre de chaîne avec mitos, quand mitos entrera au verrou.
- Sandbox : **DÉDUIT**, `desktop/src/main/sandbox-projection.ts:20`, `PROJECTED_ENTRIES` inclut `plugins`. Un prosopon installé par marketplace sur l'hôte serait donc copié dans le conteneur, même sous S1.
- Revue visuelle.

**Constat hors périmètre** : `deck-plugin` subit déjà l'écriture du moteur dans `resources/` en paquet. C'est un défaut préexistant, non traité par L3.

**D1, sandbox** :
- S1, recommandée : rendu stock en sandbox.
- S2 : projection et table de réécriture, en lot séparé.
- Refus d'activer les mods sur un espace de travail sandboxé, affiché dans l'interface.

**D2, forme de l'interrupteur** :
- I1, recommandée : champ global sans interface jusqu'à L4.
- I2 : réglage visible dès L3.
- I3 : I2 plus une surcharge par session, sur le précédent de `autoResumeQuota`.

Aucune autre décision n'est nécessaire. Le retour à une copie chargée en place ou au montage dans le conteneur n'est pas une option ouverte par ce brief.
