# Plugins de rendu et de liens dans un repo separe (cartes f732182b, 574feb89, a56967de)

Statut : conception de l'architecte, 2026-10-19, CLI mesuree 2.1.303. Brief non
commite par l'auteur, aucune ligne de production. Il REVISE
`docs/DESIGN-READABLE-PLUGIN.md` : le contrat de rendu V1 (sections 3 a 6 de ce
brief), la garde et les pieges qu'il decrit restent valables ; ce qui change est
le VEHICULE (section 4 a 7 ci-dessous).

Etiquettes : MESURE (commande + sortie decisive), DEDUIT (lecture, `fichier:ligne`),
SUPPOSE (non verifie).

Decision operateur recue (via le lead, 2026-10-19) : UN repo, un DOSSIER par
plugin, publie comme marketplace ; on l'ajoute une fois puis on installe et
active chaque plugin separement, l'un sans l'autre. Aucune dependance entre
plugins. Les deux premiers : le rendu lisible, un mod de liens cliquables.

## 1. Phase 1 : mesures

| # | Question | Resultat |
|---|---|---|
| a1 | Un mod peut-il emettre un lien OSC 8 ? | OUI. DEDUIT `claude-code.d.ts:5778-5800` et `:9982-9992` : le composant `Link` est "an OSC 8 span on the terminal (else its text then the URL in dim)", `href` de tout schema, 2048 car. max. `Markdown` dessine aussi ses propres hyperliens (`:5833-5878`), n'accepte que `https:`, `http:`, `file:` (le reste est dessine en texte), et `onLinkPress` ne s'applique que la ou la surface rapporte les clics (terminal plein ecran) : inutilisable dans la PTY du Deck. |
| a2 | Claude Code en emet-il deja ? | OUI, MESURE : `grep -c 'u001b\]8;' tests/pty-harness/fixtures/*` puis `grep -l` donne 19 fixtures sur 34 ; payload `\u001b]8;id=u-1vz5ewn%...;https://claude.ai/code/session_...?from=cli\u001b\\` (lien `/rc`, `channels-warning-conpty-win.json`) et `https://code.claude.com/docs/en/security` (`permission-bash-2.1.291.json`). Terminateur `ESC \`, parametre `id=`. Le texte d'un message assistant n'en porte pas dans les fixtures : les fixtures de tour n'ont aucune URL, donc cette question reste NON MESUREE pour `Markdown` (SUPPOSE : le moteur lie une URL ecrite par l'agent). |
| b1 | xterm.js du Deck | MESURE : `@xterm/xterm` 5.5.0, `@xterm/headless` 5.5.0, `@xterm/addon-web-links` 0.11.0 (`desktop/node_modules/@xterm/*/package.json`). Aucun `linkHandler` dans `desktop/src` (aucune occurrence, recherche sur tout `desktop/src`). |
| b2 | Que fait un clic OSC 8 aujourd'hui ? | DEDUIT `node_modules/@xterm/xterm/src/browser/OscLinkProvider.ts:72-89` et `:114-128` : sans `linkHandler`, seuls `http:`/`https:` sont cliquables, le clic ouvre un `confirm("...WARNING: This link could potentially be dangerous")`, puis `window.open()` VIDE. Dans le Deck, `setWindowOpenHandler` (`desktop/src/main/index.ts:3310-3315`) passe `about:blank` a `safeExternalUrl` (`external-url.ts:20-31`, http/https seulement) : refus journalise `refused to open a non-http(s) external link`. Donc un lien `/rc` ou "docs" natif de Claude Code produit AUJOURD'HUI un dialogue de confirmation puis rien (a confirmer a l'ecran : non lance, pas de GUI). Les URL en TEXTE brut passent par `WebLinksAddon` (`TerminalTile.tsx:84`, `SandboxTerminal.tsx:63`), qui marche. Un lien `file:` est ignore (`allowNonHttpProtocols` absent). |
| c | Scan OSC de `screen-model.ts` (carte 496ed818) | PREMISSE TOMBEE. MESURE : `Glob **/screen-model*` donne "No files found" sur tout l'arbre ; `git log -- desktop/src/main/screen-model.ts` dernier commit `8504815 feat(screen): la garde d'injection lit l'ecran xterm...`. L'ecran est maintenant un vrai `@xterm/headless` (`xterm-screen.ts:184-186`) dont le parseur est a etat ; `read()` rend `unavailable/sequence-incomplete` tant qu'une sequence est ouverte (`xterm-screen.ts:325-329`), donc la garde FERME au lieu de lire une grille corrompue. La carte 496ed818 decrit du code supprime : proposition de la fermer ou de la requalifier (decision du lead). |
| c2 | Un flux riche en OSC 8 change-t-il un verdict ? | Les attributs de lien d'xterm ne sont pas du texte : `inspectInjectGuard` (`xterm-screen.ts:358-419`) ne lit que `lines`, `cursor`, `chevrons`. MESURE : `bun test ./tests/desktop-xterm-screen.test.ts` donne `82 pass, 0 fail` et l'oracle rejoue des fixtures qui contiennent des OSC 8 natifs (liste ci-dessus). Les detecteurs sur flux PTY retirent l'OSC avec un terminateur `BEL` ou `ESC \` (`quota.ts:25-31`, `detect/safe-strip.ts:116-143`, `attention.ts:25-29`), borne 4096 > 2048 d'un `href`. NON MESURE : une sonde dediee (OSC 8 fragmente a chaque frontiere) : le test existant `feedAtEveryBoundary` (`desktop-xterm-screen.test.ts:61,132-136`) ne couvre que l'OSC 0 ; les hooks de cette session ont refuse tout script de sonde ad hoc (ecriture de fichier de code, `bun -e`), je n'ai pas contourne. Cout : ajouter 2 lignes `OSC 8 BEL` / `OSC 8 ST` a la table de ce test, 10 minutes. |
| d1 | Submodule et worktrees | MESURE (depot temporaire, `git worktree add` + `submodule add`) : dans le worktree le dossier du submodule est VIDE (0 entree), `git submodule status` affiche `-8df1d23...` (non initialise). Apres `git submodule update --init` dans le worktree, `git worktree remove <wt>` (sans `--force`, comme `removeWorktree`) ECHOUE : `fatal: working trees containing submodules cannot be moved or removed`. DEDUIT `worktree-service.ts:68-76` (`git worktree add`, aucune init) et `:99-110` (`git worktree remove`, "never --force"). |
| d2 | CI | DEDUIT : trois `actions/checkout@v7` a changer (`desktop-build.yml:64`, `desktop-release.yml:26`, `commit-closure.yml:21`), deux d'entre eux sur matrice windows/macos/ubuntu ; `with: submodules: true` suffit pour un submodule PUBLIC. Plus important : `desktop-build.yml:117-129` installe le CLI epingle `@anthropic-ai/claude-code@2.1.293` et verifie la version, alors que tout ce travail est mesure sur 2.1.303. Un plugin valide sur 2.1.303 n'est donc pas valide dans NOTRE CI, tant que les deux ne sont pas alignes. |
| d3 | extraResources depuis un chemin de submodule | `electron-builder.yml:16-26` liste `from: deck-plugin`, `from: deck-lead-plugin` (dossiers relatifs a `desktop/`). SUPPOSE : un `from` de submodule marche, mais le fichier `.git` du submodule serait copie dans le paquet sans `filter: ["!.git"]` ; a mesurer avec `electron-builder --dir -c.directories.output=/tmp/x` (recette `rules/electron.md`), 15 minutes. |
| d4 | Licence et visibilite | MESURE : `gh repo view --json visibility,licenseInfo` donne `{"licenseInfo":{"key":"mit",...},"visibility":"PUBLIC"}`. Le repo des plugins doit etre PUBLIC et MIT : un submodule PRIVE casserait `git clone --recurse-submodules` pour tout tiers et exigerait un jeton dans les 3 jobs de CI. Le mod tiers `readable-layout` (reference de depart) est MIT : sa notice suit tout code repris. |

Autre point trouve en passant (DEDUIT `partition-pure-tests.ts:57`) : la CI
n'enumere que `tests/*.test.ts` ; un `bun test` nu en local descendrait en
revanche dans un dossier de plugin peuple et y decouvrirait des `*.test.tsx`
qui ne tournent que sous `claude plugin test` (meme piege que dans le brief
precedent, section 3.1).

Aucune de ces mesures ne remet en cause la ratification (plugin opt-in, garde
inchangee, repli `next(e)`). Deux faits changent la conception : l'ecran n'est
plus le `screen-model.ts` de la carte 496ed818, et le clic OSC 8 est
aujourd'hui casse dans le Deck pour des liens que Claude Code emet de lui-meme.

## 2. Forces

- Le repo des plugins doit etre utilisable SANS Kory et evoluer sans lui.
- Kory doit pouvoir PROUVER, sur la version exacte qu'il embarque, que la garde
  reste `clear` : la preuve ne peut pas vivre dans le repo des plugins (elle y
  dupliquerait la garde et pourrait deriver).
- Les deux evoluent ensemble : un changement de plugin et le changement Kory qui
  en depend doivent tenir dans un commit Kory.
- Le Deck cree des worktrees par agent et un gate (tests, build, typecheck) y
  tourne ; le paquet doit etre present, hors reseau, sur 3 OS, dans le
  conteneur sandbox.
- Une marketplace installe un plugin en COPIANT SON SEUL DOSSIER (SUPPOSE, doc
  officielle : les chemins sortant du dossier ne sont pas resolus apres
  installation ; a verifier a la premiere sonde du repo). Donc aucun code
  partage entre plugins, et aucune dependance declaree.

## 3. Partage des responsabilites

| Repo des plugins | Kory |
|---|---|
| Le rendu (hooks `ui.render`), la table `CERTIFIED`, le repli `next(e)` | Preuve que la garde reste `clear` contre le VRAI `xterm-screen.ts` sur le snapshot epingle (grille synthetique, puis corpus reel, lots 1 et 2) |
| `marketplace.json` a N entrees, un dossier par plugin, versions par plugin | Le cablage : `--plugin-dir` (troisieme et quatrieme dossier), `extraResources`, reecriture sandbox, defaut desactive, langue des etiquettes |
| `claude plugin validate` et `claude plugin test` de chaque plugin, sa CI, ses tests de rendu | Clic OSC 8 : `linkHandler`, validation MAIN-side du href (entree hostile), apercu d'image, journal des refus |
| Le CONTRAT ECRIT des exigences de Kory (section 5) : invariants testables par plugin, sans reproduire la garde | Link provider xterm pour les CLI SANS mod (chemins, `chemin:ligne`, URL) |
| Le README d'installation autonome (`/plugin install ... --marketplace`) | Le pin (SHA du repo + empreinte par plugin), la regle de promotion, le CLI epingle de la CI |

Principe : le repo des plugins affirme ses propres invariants ; Kory seul
affirme "la garde reste clear". Aucun test du repo des plugins n'importe ou ne
copie `inspectInjectGuard`.

## 4. Mecanisme de dependance

- **Option A -- submodule git** (`desktop/mods` pointe sur le repo). Pour : SHA
  epingle par le superprojet, standard, un commit Kory deplace le pointeur.
  Contre (MESURE d1, DEDUIT d2) : dossier vide dans chaque worktree d'agent ;
  une fois initialise, `removeWorktree` echoue (le Deck ne force jamais) ; trois
  checkouts de CI a modifier ; un gate qui lit le paquet est rouge dans un
  worktree neuf et vert dans un worktree peuple (mode de defaillance a deux
  etats) ; `bun test` nu descend dans les tests du plugin ; `.git` a exclure du
  paquet. Cout de mise en oeuvre ~1 jour, cout RECURRENT chaque worktree.
  Reversible : oui.
- **Option B -- snapshot epingle et suivi par git** : le dossier du plugin
  (fichiers distribuables seulement : `.claude-plugin/`, `hooks/`, README,
  LICENSE ; jamais les tests) est copie sous `desktop/mods/<plugin>/` par un
  script, avec un fichier de verrou `{repo, commit, plugins:{nom:{version,
  empreinteArbre}}}`. Un test du gate recalcule l'empreinte depuis le disque et
  la compare au verrou : toute edition a la main ou derive est rouge. Pour : zero
  etat supplementaire (worktree, CI, build, sandbox, `bun test` : identiques a
  `deck-lead-plugin`, deja suivi sans build) ; l'ordre de mise a jour reste
  atomique (un commit Kory = script + verrou + code consommateur). Contre :
  copie de quelques fichiers dans l'arbre ; un script de synchro (~80 lignes) et
  un test a maintenir ; la source de verite est ailleurs, il faut s'interdire
  d'editer la copie (le test le fait respecter). Reversible : OUI, et gratuit :
  le chemin `desktop/mods/<plugin>` est identique si on passe plus tard en
  submodule.
- **Option C -- `git subtree --squash`**. Pour : outil standard, pas de script.
  Contre : aucune detection d'edition locale divergente, commits de fusion
  contraires a la discipline "stage par nom", poussee amont delicate.
- **Option D -- installation marketplace dans `~/.claude`** (le chemin de
  l'utilisateur autonome). Rejetee comme mecanisme DE KORY : etat global de
  l'operateur, aucune garantie que la version installee soit celle sur laquelle
  la preuve de garde a ete faite, le sandbox copie `~/.claude`, et le meme nom
  charge deux fois est un cas non tranche (doc : `--plugin-dir` remplace ; bug
  ouvert #72369 : l'inverse). Reste le chemin documente pour qui n'utilise pas
  Kory.

**Recommandation : option B.** Force decisive : les modes de defaillance MESURES
du submodule tombent sur le travail quotidien du Deck (worktrees par agent,
suppression sans force), alors que B n'en ajoute aucun et se convertit en A sans
toucher un consommateur. A n'est pas ecartee par principe : si l'operateur la
veut malgre ce cout, la liste des changements est celle de la section 4 (A).
Preuve de l'ecart avec l'attente de l'operateur : il a cite le submodule
"sans doute" ; c'est un arbitrage a lui, pas une contrainte technique.

Mode de developpement conjoint (sans submodule) : la synchro accepte un
`--from <dossier local>` ; en developpement seulement, une variable d'environnement
peut faire pointer `--plugin-dir` sur un depot vivant, refusee quand l'app est
empaquetee (SUPPOSE a ratifier : c'est une entree d'environnement operateur,
pas une entree hostile).

## 5. Disposition du repo des plugins et contrat

```
<repo>/
  .claude-plugin/marketplace.json     name, owner, plugins[]: une entree par dossier, source "./plugins/<nom>"
  plugins/<nom>/                      AUTONOME : rien n'est importe hors de ce dossier
    .claude-plugin/plugin.json        name, version propre, aucun champ `dependencies`
    hooks/hooks.json                  { "modules": ["./register.tsx"] }
    hooks/register.tsx, hooks/*.ts    cablage + modules PURS
    tests/*.test.tsx                  lances par `claude plugin test plugins/<nom>`
    README.md
  CONTRACT.md                         exigences de Kory, ids stables, une ligne testable chacune
  .github/workflows/ci.yml            matrice par plugin : validate + test, CLI epingle
  LICENSE (MIT), README.md            installation autonome, une ligne par plugin
```

Regles : (1) un plugin ne depend d'aucun autre et n'importe rien hors de son
dossier (la table de versions `CERTIFIED` est DUPLIQUEE dans chaque plugin ;
un test de CI verifie que les copies sont identiques, pour que la derive soit
rouge et non silencieuse) ; (2) nom de plugin distinct du mod tiers
`readable-layout` et de tout nom de plugin Kory, pour eviter le cas "meme nom
charge deux fois" ; (3) chaque plugin se verifie seul : `claude plugin validate`
et `claude plugin test` sur SON dossier ; (4) version par plugin, tag par plugin
(`<nom>-vX.Y.Z`), le verrou de Kory epingle le COMMIT, pas un tag mobile.

`CONTRACT.md` (ids stables, citables par le nom d'un test) :
- R1 aucune ligne produite ne commence par `╭`/`╰` ET finit par `╮`/`╯` ; seuls
  les glyphes `┌┐└┘─│` encadrent ;
- R2 aucune ligne produite ne matche `^\s*❯\s+\d+\.` ;
- R3 aucune ligne produite ne fait exactement `columns` de large en `─` seuls
  ou avec un libelle central (regle de fin de tour a `columns - 2`) ;
- R4 aucun message de limite/quota n'est capture (reste en rendu natif) ;
- R5 aucun glyphe de spinner en tete de ligne produite ;
- R6 version : egalite exacte sur `SessionVersion.base`, absente/`-dev`/inconnue
  = repli `next(e)` ;
- R7 echec ouvert : toute erreur = `next(e)` ; aucun acces reseau ni
  processus ; lecture du systeme de fichiers limitee a `stat`/existence ;
- R8 liens : seulement `http:`, `https:`, `file:`, 2048 car. max ; jamais de
  schema propre au plugin, jamais d'execution a la lecture.

Le repo teste R1 a R8 sur la SORTIE de ses propres arbres (predicats triviaux,
sans la grille xterm). Le verdict `clear` vient de Kory (section 3).

## 6. Composition de deux plugins sur le meme composant

Les deux plugins veulent `AssistantMessage` : le rendu le CADRE, les liens
reecrivent son TEXTE. Faits : `next(e)` "resolves to a plain-data tree" ou a ce
que repond le plugin dessous (`claude-code.d.ts:9773-9780`, DEDUIT) ; un hook
qui retourne un arbre sans appeler `next` est terminal. Donc :

- le plugin de liens ne retourne JAMAIS un arbre pour `AssistantMessage` : il
  reecrit `e.props.text` et appelle `next({ ...e, props })` ;
- le plugin de rendu lit le texte dans l'`e` qu'il recoit ;
- cela ne marche que si le plugin de liens est EXTERIEUR (appele d'abord).
  L'ordre de chaine entre deux plugins est NON MESURE (SUPPOSE : le premier
  charge repond). Sonde du lot 2 : deux plugins factices, trois modes de
  chargement (deux `--plugin-dir` dans les deux ordres ; marketplace avec deux
  installations) ; regle de decision : si l'ordre est maitrise par Kory (ordre
  des `--plugin-dir`), Kory le fixe ; s'il ne l'est pas pour l'utilisateur
  autonome, le README dit l'ordre et le plugin de rendu degrade en cadre sans
  liens, jamais en erreur. Les deux plugins restent installables seuls : chacun
  est correct sans l'autre.
- Alternative a mesurer au meme moment : le plugin de rendu appelle d'abord
  `await next(e)` et encadre l'arbre recu (ordre sans importance) ; non retenue
  par defaut car la forme de l'arbre natif (glyphe `●`, marges) n'est pas
  mesuree.

## 7. Le mod de liens : premiere forme (pas de conception detaillee)

- Hook `ui.render` sur `AssistantMessage` (surface terminal, version
  certifiee) : une fonction PURE `linkify(texte, contexte)` reperage de
  (1) URL `http(s)`, (2) chemins de fichiers absolus ou relatifs au `cwd` avec
  extension, avec `:ligne` optionnel ; (3) pas de balayage dans les blocs de
  code. Un chemin n'est lie que s'il EXISTE (`$.fs.stat`, une fois par chemin
  et par message, plafond de N chemins) : on ne fabrique pas un lien vers un
  nom invente par l'agent.
- Sortie : du markdown `[libelle](file:///abs/chemin)` / `[...](https://...)`
  rendu par `Markdown` natif (donc OSC 8 emis par le moteur) ; aucun schema
  propre ; `href` borne a 2048 car. Autonome : un terminal compatible OSC 8 rend
  le lien cliquable sans Kory.
- Kory (lots separes, section 8) : `linkHandler` avec `allowNonHttpProtocols`
  et `activate` qui NE FAIT RIEN lui-meme : il envoie le href a MAIN, qui valide
  (entree hostile 3 et 4 : l'agent ecrit la chaine) : http(s) -> `safeExternalUrl`
  puis `openExternal` ; `file:` -> `realpath` contenu dans l'ensemble des
  dossiers de travail (`requireWorkDir`/`resolveWithin`), jamais `shell.openPath`
  sur un executable : liste blanche d'extensions (images -> apercu, texte/markdown
  -> visionneuse, le reste -> `showItemInFolder`).
- Le meme `activate` couvre aussi les OSC 8 NATIFS de Claude Code (lien `/rc`,
  docs) : c'est le correctif du defaut b2 et il n'attend aucun plugin.

## 8. Decoupage revise des lots de f732182b

| Lot | Contenu | Depend de |
|---|---|---|
| M0 | Creer le repo (public, MIT), `marketplace.json`, CI (CLI epingle aligne), `CONTRACT.md`, squelette du plugin de rendu portant le contrat de `DESIGN-READABLE-PLUGIN.md` (tests `claude plugin test` du repo) | decision operateur sur le nom du repo et des plugins (hors mod tiers) |
| L1 | Cote Kory : script de synchro + verrou + test d'empreinte ; preuve "garde inchangee, verdict clear" sur grille synthetique dans le vrai `createXtermScreen` avec importation du module pur du snapshot ; AUCUNE activation | M0 |
| L2 | Corpus reel + oracle (`_fixture-verdicts.ts`) ; sonde quota ; sonde "deux copies" (`--plugin-dir` vs installe) ; sonde de chaine a deux plugins (section 6) ; regle de promotion ; alignement CLI CI 2.1.293 / certifie | L1 |
| L3 | Distribution Deck : dossiers `--plugin-dir` supplementaires, `extraResources`, defaut DESACTIVE, langue des etiquettes depuis la locale ; correctif de `rewritePluginDirForContainer` (non global) | L1 (L2 pour l'activation) |
| L4 | Revue visuelle, validation de l'operateur, activation | L2, L3 |
| L5a | Plugin de liens dans le repo (premiere forme section 7) | M0, independant de L1-L4 |
| L5b | Deck : `linkHandler` + validation MAIN + journal ; corrige les OSC 8 natifs (b2) | AUCUNE : livrable des maintenant |
| L5c | Apercu d'image (volet ou fenetre) pour les chemins images valides | L5b |
| L5d | Link provider xterm pour les CLI sans mod | L5b (partage la validation MAIN) |

`574feb89` exige toujours du lot 1 : `classifyAssistant` asynchrone, `BlockKind`
ferme, `CERTIFIED` a capacites, un rig de capture dans le temps ; en plus :
une capacite par plugin (`layout`, `links`), la meme table dupliquee et
verifiee identique par la CI du repo.

## 9. Hors perimetre / entrees hostiles

- Le href d'un lien est ecrit par l'agent : entree hostile 3 et 4, valide cote
  MAIN a chaque appel, jamais cote renderer.
- Le script de synchro lit un depot et ecrit dans l'arbre : il refuse tout
  chemin hors de `desktop/mods/` et tout fichier de test.
- Le repo des plugins ne recoit aucun secret ; sa CI n'a pas besoin de jeton.

## 10. Questions ouvertes pour le lead / l'operateur

1. Option B (snapshot + verrou) plutot que submodule : l'operateur arbitre
   (section 4). Si submodule : l'estimation est ~1 jour plus le correctif de
   `removeWorktree`, et la liste d1/d2/d3.
2. Noms du repo et des plugins (hors `readable-layout`).
3. Fermer ou requalifier 496ed818 (code supprime).
4. Aligner le CLI de la CI (2.1.293) sur la version certifiee (2.1.303), ou
   certifier 2.1.293 : impose avant que la CI du repo des plugins ne serve de
   preuve.
5. L5b en premier ? Il corrige un defaut visible aujourd'hui et ne depend de rien.
