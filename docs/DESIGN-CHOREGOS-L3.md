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
  - Les chemins `--plugin-dir` sandbox sont composés avant `buildSessionCommandLine`, sans réécriture de la commande (`session-command.ts:132-141`, `session-service.ts:1463-1505`).
  - `sandbox-service.ts:1183-1209` copie le `deck-plugin` de l'hôte dans le conteneur (`docker cp`, puis `chown`), sans montage.
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
- Retrait du filtre : gardé par le test de parité. L'effet sémantique du filtre (options minimatch d'electron-builder, `dot: true`) est mesuré une fois par un packaging jetable, et aucun test ne le garde. **MESURÉ par la revue** : le test empaqueté passe même sur un arbre qui livre les chemins du moteur, parce que `checkDir` ne lit que le premier niveau et que `EXACT_FILES` n'a pas d'entrée `mods`. Limite **DÉDUITE** : `!*/` ne couvre que la disposition `mods/<plugin>/`, pas un plugin rangé plus bas.

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

### K3c : interrupteur et câblage S2/I1, Koryphaios, developers

**Statut** : conception retenue, dispatch B1/B2 le 2026-10-22.

**Problème et structure actuelle** : appliquer S2 sans montage hôte et I1 sans interface avant L4. **DÉDUIT**, `session-service.ts`, `toRuntime` : cette méthode publie `exited` sans PTY ; la précédente proposition de publier un `starting` existant pendant la préparation était fausse. **DÉDUIT**, `create-session.ts:59-73,75-113`, `ipc.ts:778-796`, `workspace-service.ts:452-481` : des gates asynchrones précèdent déjà create/restart/restore, mais restore attend encore des approbations après son gate IPC. **DÉDUIT**, `index.ts:3158-3184` : `ensureSupervisor` appelle directement create/restart ; une préparation limitée aux gates sandbox manquerait les mods de ce superviseur hôte.

**Options et recommandation** :
- **Préparation A, rendre le spawn de SessionService asynchrone** : centralisation, mais changement d'état publié, continuations tardives et adaptation des gardes de scope. **Préparation B, étendre les gates existants**, recommandée : préserver le spawn synchrone et passer un résultat explicite déjà préparé ; coût borné aux orchestrateurs, au superviseur et à la consommation dans SessionService. Le restore attend sa préparation avant le remplacement des tuiles ; son coût est explicité ci-dessous. Réversible sans nouveau statut runtime.
- **Copies hôtes A, worker/préchauffage** : déplace aussi lectures/hachages, mais ajoute packaging et invalidation ; le préchauffage ne prouve pas l'état au spawn. **Copies hôtes B, retry asynchrone injectable**, recommandée : delta local de K3b, sans worker. **DÉDUIT**, `mods-working-copy.ts:55-70` : la Promise seule ne retire pas `Atomics.wait`. Les I/O synchrones restantes ne reçoivent aucune promesse de latence non mesurée.
- **CLI A, scanner la commande composée et traduire une table** : parseur supplémentaire sans preuve sur les expansions du shell. **CLI B, composer directement les chemins conteneur**, recommandée : plus de réécriture des flags de plugins ; refuser les flags utilisateur dans base ET args, sandbox seulement. Coût et rayon d'impact plus faibles ; le contrôle reste une cohérence de composition, pas une nouvelle barrière contre un shell arbitraire autorisé par l'opérateur.
- **Destination A, partagée root non inscriptible**, `/opt/kory-mods/<plugin>/<fingerprint>`, sans chown, retenue après la sonde transmise par le lead : copies mutualisées et intégrité contre `kory` pendant la session. **Destination B, writable par tentative** : permet les écritures auxiliaires du moteur, mais multiplie les copies et leur nettoyage sans intégrité entre agents du conteneur ; écartée. Le choix reste réversible au prochain lancement, sans remplacer une copie vivante. **MESURÉ, lecture du rapport**, `kleos-cli recall 32286` : `"Non mesure sous Linux root:root."` Le rapport décrit un chargement interactif réussi sous ACL Windows avec Claude 2.1.308 et la trace DEBUG `type root of <plugin> not laid: EPERM`. **SUPPOSÉ** : même tolérance sous Linux root:root ; la sonde Linux sur l'image reconstruite est une condition L4, pas une garantie déjà acquise.

**Fichiers et contrats**, découpés pour deux developers :

1. **K3c-A, prérequis indépendant déjà attribué** : `desktop/src/shared/types.ts`, `desktop/src/main/store.ts`, assainissement à la lecture dans `mods-working-copy.ts`, précision du commentaire des parents contrôlés. `shared/mods-fingerprint.ts` reste inchangé dans K3c : le préfixe de longueur est déjà en octets ; le test avec chemin accentué couvre ce contrat. Conserver ce lot sans le redessiner : champ global par plugin, défaut vide, seules les clés du verrou de valeur `=== true` comptent ; aucun réglage visible avant L4.
2. **K3c-B1, copies, gates et composition** : `mods-working-copy.ts`, `session-command.ts`, `create-session.ts`, `workspace-service.ts`, consommation synchrone dans `session-service.ts` ; câblage `ipc.ts`/`index.ts`, y compris `ensureSupervisor`. Rendre `ensureModWorkingCopy` asynchrone avec attente injectable pour les retries de rename, sans `Atomics.wait` sur le main ; conserver quarantaine, contrôles K3b et vérification du gagnant concurrent. Après chaque attente, revalider parents/destination avant mutation. Exposer la vérification sans réparation commune au dernier contrôle avant cp et avant spawn hôte. Composer directement la liste finale des plugins : embarqués dans leur ordre actuel, puis mods retenus ; omission de `deck-lead-plugin` en sandbox inchangée.
3. **K3c-B2, projection et identité moteur** : `sandbox-service.ts` pour publication/réutilisation des versions root, nettoyage des seuls staging propres, contrôle du namespace et signalement des staging orphelins dans `prepareMods`/`prepareModsRun` ; pour les mods, `ensure()` ne fait qu'épingler `readyContainerId` ; `sandbox-command.ts` pour chemins/argv validés et retrait de la réécriture des plugins. B2 expose les références de versions et la cible conteneur épinglée, sans toucher `index.ts`, `session-service.ts` ou les gates B1. Ne pas greffer les mods sur la signature/cache de `projectConfig` ni sur `PROJECTED_ENTRIES`.
4. **Tests existants** : `desktop-mods-working-copy`, `desktop-launch`, `desktop-create-session`, `desktop-session-service-write`, `desktop-workspace`, `desktop-sandbox-command`, `desktop-sandbox-service`. **DÉDUIT**, `tests/desktop-session-service-write.test.ts:18-75` et `sandbox-service.ts:277-278` : faux PTY et moteur injecté fournissent les points de test des consommateurs réels. Aucun scan de corps d'`index.ts`, aucun broker/PTY réel ajouté à la gate.

**Contrat de préparation B1/B2** :
- La lecture du verrou est paresseuse : elle n'a lieu que si au moins un mod est activé.
- Une tentative créée par le main porte `attemptId`, cible éventuelle et sélection assainie figée. Une copie hôte contient `{ plugin, fingerprint, hostDir }`, jamais un chemin du renderer/config. Le résultat explicite contient les chemins finaux retenus, diagnostics et, en sandbox, `{ engine, containerId }` avec références `{ plugin, fingerprint, containerDir }`. Passer ce résultat aux entrées create/restart/restoreFrom par un contrat interne non persisté ; le consommer sans attente dans `startPty`/le wrapper. `attemptId` sert uniquement à annuler une continuation, pas à nommer une copie publiée ou ses données. Le cache de versions publiées est indexé par moteur, id réel du conteneur, plugin et empreinte, jamais par cwd seul.
- `index.ts` résout `workRoot = join(app.getPath('userData'), 'mods')`, après initialisation Electron, en dev COMME en paquet. `modsDirFor` ne résout que la source distribuée. **DÉDUIT**, `mods-working-copy.ts:123-126,176-179` : le contrôle inclut `dirname(workRoot)` ; `desktop/mods` exposerait donc `desktop/package.json` au refus. Aucun repli dans le dépôt, `resources` ou à côté du plugin distribué.
- **Gates à couvrir** : create dans `createSessionWithWorktree`, après résolution du cwd et avant `service.create` ; restart dans `restartSessionGated`, avant `service.restart`, en conservant son attente de cleanup ; superviseur dans `ensureSupervisor`, avant ses deux appels directs. La préparation hôte n'est pas conditionnée à `!supervisor` ni à l'activation sandbox. Restore : garder le gate IPC de disponibilité/transcripts, mais préparer les plans dans `WorkspaceService.restore` APRÈS les approbations et AVANT `adoptScope`/`restoreFrom`, avec le snapshot déjà chargé ; le simple passage des cwd au gate IPC est insuffisant. Revalider l'opération et le verrou après cet await comme après les approbations existantes. **DÉDUIT**, `workspace-service.ts:458-481` : cela évite de préparer avant une attente humaine puis de recharger un autre snapshot.
- La préparation ne publie aucune nouvelle tuile ; les anciennes restent présentes pendant l'attente du restore. SessionService garde create/restoreFrom et le spawn synchrones, restart garde son API Promise. Passer aussi les refus structurels à la consommation synchrone : `reportError`, tuile `exited`, aucun PTY/script ; l'indisponibilité d'un mod reste une omission diagnostiquée, pas un arrêt de la tuile. Si un chemin de lancement oublie le plan requis, refuser explicitement plutôt que charger depuis la distribution. Aucun changement de `toRuntime` ou nouvel état. La découverte des transcripts reste post-spawn, non attendue. **DÉDUIT**, `session-service.ts`, `autoResume` : cette méthode envoie des touches au PTY existant, ce n'est pas un nouveau lancement à préparer.
- `attemptId` EST la génération : aucune seconde génération ni invalidation lors d'un changement d'interrupteur. Relire la sélection à la tentative suivante ; celle en cours conserve son snapshot. Enregistrer les tentatives en attente dans le propriétaire du lancement ; remove annule celles de sa cible, closeAll/stop/remplacement de workspace annulent les précédentes. Le changement de scope passe uniquement par restore : `restoreFrom` applique `cancelAllExcept` aux plans du restore, conservant ses plans propres et annulant ceux qu'il remplace. Une bascule sandbox n'annule pas les plans incompatibles : à la consommation, un mode ou une cible différents entraînent un refus structurel, une tuile `exited` et aucun PTY. Ne pas redéfinir `hasLiveSessions`. Vérifier l'identité de la tentative et de la session ciblée après les awaits, y compris le cleanup de restart. Deux demandes concurrentes pour le même restart rejoignent la même tentative dès le gate, pas seulement après la préparation. Aucun effet tardif d'une tentative annulée, nettoyage par sa référence seulement.
- **Coût du restore, modèle de conception et non benchmark** : pour N tuiles sandbox et M mods communs, matérialiser les copies hôtes communes et préparer les M versions conteneur une fois par lot ; M cp au premier remplissage, aucun cp d'une version déjà publiée conforme, puis N plans de consommation. Le contrôle hôte final reste immédiat avant CHAQUE cp réellement nécessaire. Préparation des versions séquentielle initialement ; latence avant remplacement = gate existant + préparation des M versions, pas N fois cette préparation. La branche writable écartée aurait imposé N × M cp. Les tuiles hôtes conservent chacune leur vérification finale avant spawn. Pas de durée annoncée sans sonde ni de queue attendant la découverte Claude.

**Projection S2, responsabilité de `sandbox-service.ts`** :
- Après disponibilité/authentification, capturer et valider l'id réel du conteneur ; épingler `{ engine, containerId }` pour la préparation et son lancement. Toutes les opérations de publication ciblent cet id, sans retomber sur le nom s'il disparaît. Faire passer explicitement du nom à cet id **`buildExecCommand`, `buildReadPidArgs`, `buildKillPidGroupArgs`**, ainsi que les nouveaux cp/exec mods. Conserver la cible du lancement par tuile pour cleanup, au lieu de relire le `launchInfo()` courant. **DÉDUIT**, `sandbox-service.ts`, `execCommand` et `cleanupSession` : `execCommand` épingle la cible par tuile dans `sessionTargets` et transmet `launch.containerId` à `buildExecCommand` ; `cleanupSession` utilise cette cible épinglée pour `buildReadPidArgs` et `buildKillPidGroupArgs`, sans relire le conteneur courant.
- Destination finale : `/opt/kory-mods/<plugin>/<fingerprint>`, root:root, lisible mais jamais inscriptible par `kory`. Revalider `plugin` et `fingerprint` avant les chemins ET aux constructeurs argv : `^[a-z0-9][a-z0-9-]{0,63}$`, `^[0-9a-f]{64}$`. Refuser un segment invalide plutôt que filtrer. Le nonce de staging, généré par le main, possède aussi une grammaire fermée. Ni montage supplémentaire, ni copie sous `/work`, `/kory-run` ou le volume auth.
- **Création exclusive, mais prémisse des montages partiellement rejetée** : pour une destination neuve, `exec --user root` et `mkdir` exclusif sans `-p`, puis création des sous-dossiers contrôlés. Pas de scanner générique de tous les ancêtres à chaque cp. **DÉDUIT**, `sandbox-command.ts:222-245` et `desktop/resources/sandbox/Dockerfile:22-27` : les binds du constructeur ne ciblent pas `/opt` et l'image de base utilise `kory`. Cependant `composeCustomDockerfile` ne refuse que `FROM` (`sandbox-command.ts:45-49`) : un fragment peut changer USER, permissions ou déclarer VOLUME. `prepareMods`/`prepareModsRun` vérifient donc le contrat du namespace réservé pour l'id réel épinglé par `ensure()` dans `readyContainerId` : `/opt` et `/opt/kory-mods` réels, root et non inscriptibles par l'agent, aucun mount recouvrant cette racine, exécution finale non-root. Sur un namespace existant, refuser un état non reconnu au lieu de le nettoyer/chowner en place. Ce contrôle circonscrit évite de présumer toutes les images personnalisées équivalentes à l'image stock.
- Pour une version absente : allouer un staging root exclusif sous le parent contrôlé du plugin, préparer ses parents, puis vérifier la copie hôte immédiatement avant cp, sans await intermédiaire. Même contrôle K3b de contenu/liste, liens, parents et fichiers moteur ; dérive = omission diagnostiquée. Copier SANS `-L` dans le staging, aucun chown, retirer les droits d'écriture non-root préservés par la copie. **DÉDUIT**, `sandbox-command.ts`, `buildCopyIntoArgs` : ce helper générique ajoute `-L`, il ne convient pas aux mods. Publier par renommage atomique du dossier complet vers le nom final, jamais par copie directe ou remplacement d'une version finale. Une collision concurrente ne vaut succès que si le gagnant est une version publiée conforme ; sinon refuser le mod. Échec cp/permissions/publication = aucune référence retournée.
- Le nom final est l'état publié : dans le namespace root contrôlé, seul le renommage atomique d'un staging complet peut le créer. Ne pas ajouter de reçu séparé dont l'écriture introduirait un second point de commit ; un crash avant renommage laisse uniquement un staging non consommable. Lors d'une réutilisation, contrôler les propriétaires, les modes et les types de tout l'arbre : aucun lien, aucun bit setuid, aucune écriture non-root ; une collision non conforme est refusée et signalée, jamais écrasée. La liste des fichiers n'est pas comparée et le contenu n'est pas revérifié dans le conteneur : son intégrité repose sur la publication root exclusive par ce protocole et sur la vérification hôte immédiatement avant cp. Ce modèle fait confiance au protocole root et à l'opérateur hôte, pas à l'agent non-root. Les défauts du namespace ou de l'utilisateur d'exécution sont des refus structurels du lancement, distincts de l'omission d'un mod indisponible. Conserver les versions publiées pendant la vie du conteneur, sans compteur de sessions ni suppression à l'annulation d'une tentative. Mutualiser les publications simultanées par `{ engine, containerId, plugin, fingerprint }` ; la collision entre deux Deck conserve le contrôle du gagnant. Nettoyer uniquement le staging créé par l'opération, après fin certaine de sa commande moteur, et tracer les erreurs. `prepareMods`/`prepareModsRun` ignorent et signalent les staging orphelins ; pas de balayage destructif fondé sur la seule absence dans la mémoire du Deck, car un autre Deck peut publier dans ce conteneur. Le balayage des copies par tentative disparaît avec cette branche ; une purge de staging étrangers attend une maintenance exclusive, hors K3c. Aucune remontée vers l'hôte ni action sur un conteneur remplaçant.

**Données du plugin** : **MESURÉ, lecture du rapport**, `kleos-cli recall 32286`, passage `CLAUDE_PLUGIN_DATA est indexe par nom@source` : le debugger rapporte le même dossier `plugins/data/<name>-inline` pour deux chemins différents sous Claude 2.1.308 Windows. Ce résultat contredit l'hypothèse d'un index par chemin ; ne pas créer de migration ou d'override de `CLAUDE_PLUGIN_DATA`. Le nom du manifeste et la source doivent rester stables. **SUPPOSÉ**, à confirmer avec la sonde Linux L4 : même comportement dans l'image reconstruite. Les données runtime du moteur sont distinctes du code projeté ; la destination du code hors volume auth ne promet pas d'isoler ces données entre projets.

**Composition directe, sans scanner de commande composée** :
- Résoudre les chemins AVANT `buildSessionCommandLine` : hôte = copies hôtes vérifiées ; sandbox = `SANDBOX_DECK_PLUGIN_DIR` puis destinations des versions publiées. `pluginFlags` émet chacun de ces chemins ; retirer `rewritePluginDirForContainer` du wrapper, ne pas lui ajouter de scanner/table. Aucun chemin utilisateur ne devient une entrée de projection. Préserver ordre et quoting des flags embarqués ; comparer les deux chemins hôtes via `canonicalPath` si une vérification d'identité est nécessaire.
- Sandbox seulement, contrôler base ET args avant composition sur le précédent `claudeSettingsIssue` : refus conservateur des graphies de `--plugin-dir` avec espace ou `=`, nom fragmenté par guillemets/échappements après normalisation, et des substitutions déjà refusées. Le contrôle porte sur les champs utilisateur, pas sur les settings JSON ni les flags générés par le Deck. Une mention littérale du flag dans ces champs peut donc être refusée conservativement. Même contrôle quand les mods sont éteints ; comportement hôte inchangé. Refus = trace `reportError`, tuile `exited`, aucun lancement. La reprise vérifie aussi les args stockés mais ne les ajoute pas à sa commande. **DÉDUIT**, `session-command.ts:104-114,203-218` : le précédent contrôle déjà base + args, alors que la branche reprise n'émet pas args.
- Ne pas présenter ce contrôle textuel comme une interprétation complète de Bash : globbing dans `/work`, profil de shell, wrapper ou commande arbitraire approuvée restent hors de sa preuve. **DÉDUIT**, `sandbox-command.ts:270-278,366-367` : le script porte un shebang `bash -l`, mais le builder l'appelle explicitement avec `bash <script>` ; le shebang seul ne prouve donc pas un login shell effectif. Les expansions du shell restent pertinentes dans les deux cas. Fermer cette autre frontière exigerait un contrat argv/liste blanche, pas un scanner supplémentaire de K3c.
- **DÉDUIT**, `sandbox-prompt.ts:19,96-107` : `composeAppendSystemPrompt` conserve une regex première occurrence sur un AUTRE flag. Ne pas annoncer la disparition de toute réécriture shell ; K3c retire seulement celle des plugins. Les contrôles de lecture du fichier de prompt restent en place.

**Capacité accordée par S2, règle hostile nº 5** : le code et les métadonnées projetés proviennent des seuls mods distribués, verrouillés, activés et vérifiés. Le motif opérateur « les mods viennent de nous » autorise cette entrée de code, pas un montage hôte ni une confiance dans les écritures de l'agent. Contrat retenu : code root non inscriptible, aucune copie de secrets/config supplémentaire, aucune remontée vers l'hôte, destination hors binds/volume auth. Limites : contrôle puis cp n'est pas un snapshot atomique contre le compte utilisateur hôte ; aucune isolation des agents entre eux ou de leurs données runtime ; aucune garantie de fermeture du shell utilisateur par le contrôle textuel des flags.

**Limite de preuve assumée, câblages Electron** : les câblages d'`index.ts` ne sont couverts que par le typecheck et la lecture, pas par une preuve comportementale sous Bun, qui ne peut pas importer ce point d'entrée Electron. Cela concerne la racine `userData/mods`, l'assainissement à la lecture, le vérificateur au spawn, le superviseur, `prepareModPlans` et le passage d'`engine`/`containerId` au wrapper. Les tests des modules consommateurs ne prouvent pas à eux seuls ces branchements ; les mutations ci-dessous portant sur ces câblages restent une limite de couverture, pas des mutations prouvées rouges.

**Acceptation**, comportements à prouver, pas résultats déjà mesurés :
1. **Activation et racines** : mods éteints, mêmes commandes normales fraîches/reprises et aucune préparation de mods ; allumés, hôte sous `userData/mods` en dev/paquet, sandbox sous `/opt/kory-mods`. Assainissement à la lecture, ordre des plugins, omission du plugin de rôle sandbox et absence de UI inchangés. Le durcissement des flags utilisateur sandbox est une exception intentionnelle à la parité des commandes, à nommer au commit.
2. **Gates et continuations** : retry suspendu par une attente injectée, event loop disponible ; fresh, restart, restore et superviseur passent leurs plans à la consommation synchrone. Une approbation restore différée précède la préparation ; pas de nouvelle tuile artificiellement `starting` pendant l'attente. Annulation par fermeture/scope/remplacement : aucun PTY tardif. Changement du seul interrupteur : snapshot courant conservé, prochaine tentative actualisée. Deux demandes du même restart ne préparent pas deux lancements ; deux Deck partagent le workRoot sans perdre le contrôle du gagnant de K3b. Auto-reprise par touches sans préparation inutile.
3. **Publication et réutilisation** : moteur injecté observant parents → contrôle hôte → cp sans `-L` → permissions root → publication → référence. Dérive avant cp ou échec de publication : aucune référence à une copie incomplète. Deux tuiles avec même mod/empreinte réutilisent la version root ; restore N tuiles ne multiplie pas les cp par N. Nouvelle empreinte séparée sans remplacer l'ancienne. Collision inconnue, lien, namespace inscriptible/monté ou exécution root : refus. Échec/annulation ne supprime ni version publiée ni staging étranger. Remplacement du conteneur : cp, exec final, lecture PID et kill ne touchent pas son remplaçant.
4. **Composition** : plusieurs plugins émis directement avec leurs chemins finaux, hôte et sandbox ; aucune réécriture première occurrence. Les flags utilisateur dans base ET args sont refusés en sandbox, graphies espace/égal/nue/doubles/apostrophes/fragmentées et substitutions du précédent incluses. Les settings JSON générés ne sont pas rescannés ; args de reprise jamais réémis. Hôte inchangé. La présence de réécriture du prompt n'est pas confondue avec la suppression de celle des plugins.
5. **Frontière et L4** : argv sans nouveau mount, sans `-L`, sans chown et hors auth/binds. Sonde interactive Linux sur image reconstruite : chargement effectif du module root non inscriptible, commande/agent et effet UI, échec d'écriture de code par `kory`, tolérance des fichiers moteur non créés, stabilité des données entre chemins. **MESURÉ, lecture du rapport**, `kleos-cli recall 32285` : `L'image koryphaios-sandbox:latest (build juillet) porte claude 2.1.220, qui rejette hooks.json a cle modules (hook-load-failed): image a reconstruire avant tout mod sandbox.` Ce diagnostic est celui du debugger, pas une sonde Linux répétée ici ; ne pas activer les mods sur cette image. **DÉDUIT**, `sandbox-projection.ts:20` : `PROJECTED_ENTRIES` contient `plugins`, donc une copie marketplace peut coexister avec le mod explicite. C1 et le double chargement restent des conditions L4.

**Mutations**, chacune attend un test comportemental rouge :
1. **Sélection** : défaut activé ; assainissement seulement à l'écriture ; racine de travail dérivée d'appPath ; mod perdu en reprise ; plugin de rôle ajouté en sandbox.
2. **Préparation** : retry ignorant l'attente ; plan omis sur superviseur/restore ; absence de vérification d'attemptId après await ; changement d'interrupteur annulant le snapshot ; découverte Claude attendue avant spawn ; préparation répétée pour chaque tuile du restore.
3. **Publication** : contrôle hôte déplacé avant les awaits ; `cp -L` ; droits d'écriture accordés à kory ; référence publiée avant fin du cp ; copie en place sur une version finale ; gagnant inconnu accepté ; segment invalide filtré silencieusement.
4. **CLI et identité** : chemin hôte envoyé à la composition sandbox ; contrôle des flags limité à args ; reprise réémettant args ; builder exec/PID/kill revenant au nom ou cleanup relisant la cible courante.
5. **Frontière et clôture** : copie dans le volume auth ; namespace inscriptible accepté ; suppression d'une version partagée à la fin d'une tuile ; purge d'un staging étranger lors de `prepareMods`/`prepareModsRun`. Les effets filesystem du moteur sont prouvés par la sonde Linux, pas par un scan textuel.

**Ordre de livraison** : K3c-A inchangé ; figer le contrat de plan et de cible entre B1/B2, puis travail parallèle ; B1 intègre les gates et `index.ts` après B2 ; gate commun une seule fois par le séquenceur. La contre-lecture doit attaquer la couverture des gates (superviseur inclus), la publication partagée/concurrente et le contrat `/opt` des images personnalisées. La sonde Linux et la reconstruction d'image restent nécessaires avant activation L4. Aucun retour à S1, montage hôte ou interface anticipée.

## Coût en tests

- Les trois lots se testent en module pur ou sur dossier temporaire : aucun broker, aucun `server.ts`, aucun PTY, aucun Electron enfant.
- Les tests étendent les fichiers existants (`desktop-launch`, `desktop-sandbox-command`, `desktop-sandbox-service`, `desktop-session-service-write`, `desktop-workspace`, `desktop-electron-builder-resources`), plus le fichier de K3b `desktop-mods-working-copy`, pour son nouveau module.
- Aucun scan textuel n'est nécessaire.
- Le packaging se mesure une fois, hors gate. Le test empaqueté existant reste en `skipIf` sans arbre.
- L3 ne lance aucun Claude CLI réel. La sonde isolée du moteur de conteneurs demandée par K3c reste hors gate et ne lance pas Claude. Avant L4, une session PTY sonde la propriété « le moteur écrit dans la copie de travail, la copie distribuée garde son empreinte ». La même sonde répond à une seconde question : un `tsconfig.json` planté change-t-il le rendu ? Cette sonde est une mesure isolée, consignée dans le corps du commit, pas un test de la gate.

## Clôture, hors L3 et décisions opérateur

**Clôture L3** : C3, K3a, K3b et K3c livrés ; verrou resynchronisé sans chemin du moteur ; interrupteur éteint par défaut ; commande inchangée tant qu'il l'est ; packaging mesuré une fois.

**Conditions pour allumer en L4, pas pour livrer L3** :
- Carte **ddd9a503** : reconstruire l'image sandbox avec une version de Claude chargeant les modules, puis mesurer en PTY interactif Linux le chargement de prosopon depuis une copie root:root non inscriptible par `kory`. **SUPPOSÉ** jusqu'à cette sonde : tolérance Linux aux écritures de types refusées, le résultat Windows ne suffit pas. Cette condition ne bloque pas la livraison complète de K3c, B1 et B2 inclus ; l'image actuelle incompatible est documentée dans le rapport debugger, Kleos #32285.
- Résultat C1 sur deux copies : prosopon installé par marketplace ET chargé par `--plugin-dir`.
- Ordre de chaîne avec mitos, quand mitos entrera au verrou.
- Sandbox : **DÉDUIT**, `desktop/src/main/sandbox-projection.ts:20`, `PROJECTED_ENTRIES` inclut `plugins`. Un prosopon installé par marketplace sur l'hôte serait donc copié dans le conteneur, même sous S1.
- Revue visuelle.

**Constat hors périmètre** : `deck-plugin` subit déjà l'écriture du moteur dans `resources/` en paquet. C'est un défaut préexistant, non traité par L3.

**D1, sandbox**, DÉCIDÉE par l'opérateur le 2026-10-22 : **S2**. Les mods sont projetés dans la sandbox par `docker cp` (« les mods viennent de nous, donc fiables »). S1 n'est plus retenu ; ce choix remplace S1 dans la recommandation ci-dessus. Le contrat S2 de K3c précise la projection et la réécriture qui en découlent.
- S1 : rendu stock en sandbox.
- S2, retenue : projection root partagée et composition directe des chemins.
- Refus d'activer les mods sur un espace de travail sandboxé, affiché dans l'interface.

**D2, forme de l'interrupteur**, DÉCIDÉE par l'opérateur le 2026-10-22 : **I1**. Aucune interface ni aucun réglage visible avant L4.
- I1, retenue : champ global sans interface jusqu'à L4.
- I2 : réglage visible dès L3.
- I3 : I2 plus une surcharge par session, sur le précédent de `autoResumeQuota`.

Aucune autre décision n'est nécessaire. Le retour à une copie chargée en place ou au montage dans le conteneur n'est pas une option ouverte par ce brief.
