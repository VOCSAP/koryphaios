# Capture des champs d'une session : workspaces et templates

Brief de conception pour les cartes `b313f0c3` (restauration de workspace),
`8aa66817` (porte d'approbation des templates) et `0b9e0b07` (role dans les
templates). Ecrit le 2026-08-25 par l'architecte, a la demande du team-lead,
sur arbitrage. Aucun code de production n'a ete touche.

Chaque affirmation porte une etiquette : **MESURE** (commande executee),
**DEDUIT** (lu dans le code, `file:line` cite), **SUPPOSE** (non verifie).

## Statut au 2026-08-25 11:40 -- deux choses ont bouge depuis la redaction

1. **Le lot A est LIVRE** (commit `e63a57d`, carte `09d54a29`) : la
   restauration d'un espace de travail est desormais gatee comme un template,
   sur deux predicats distincts (`workspaceHasShellFields` pour `args`,
   `workspaceHasUntrustedCwd` pour `cwd`). Le §2.2 et le §7 ont ete corriges
   en consequence ; ils decrivaient l'etat d'avant.
2. **La question du §3 est tranchee** : le role n'est PAS une autorisation.
   L'operateur a abandonne le 2026-08-25 l'autorisation par le role au profit
   d'un VERROU D'EXECUTION sur le lot (carte `011d3547`). Le §3 et le lot E
   ont ete corriges. Les lots B, C et D ne dependaient pas de cette reponse et
   restent valides tels quels.

---

## 1. La decision a prendre

`toWorkspaceSessions` (`desktop/src/main/workspace-session-map.ts:23-31`) est
une pick-list de 6 champs. Le round-trip perd 9 champs de `SessionDef`. Le
team-lead propose de remplacer la pick-list par une partition explicite en deux
ensembles commentes -- CAPTURE et EXCLU-PAR-SECURITE -- et demande si le
compilateur peut refuser un 17e champ non classe.

Ce document repond a trois choses : ou se trouve reellement la frontiere de
confiance, comment la fermer par le type, et dans quel ordre livrer.

---

## 2. Structure actuelle

### 2.1 Ce que la pick-list capture

**DEDUIT** (`workspace-session-map.ts:23-47`) : capture `sessionId`, `name`,
`cwd`, `args`, `color`, `position`. Rebatit `id`, `createdAt` localement et
force `command: ''`.

### 2.2 Deux champs captures ont un pouvoir maximal

**DEDUIT** -- `args` est du code shell.
`buildSessionCommandLine` (`session-command.ts:193-195`) fait
`line += ' ' + extra` sur `input.args`, sans encodage.
`buildShellInvocation` (`shell-command.ts:41-58`) passe cette ligne a
`powershell -NoProfile -Command <line>` ou `<shell> -l -c <line>`.
C'est exactement pour cela que la porte d'approbation des templates existe :
`templateHasShellFields` (`template.ts:129-133`) declare `args` "appended
verbatim to the login-shell command line" et exige une approbation pour un
template LOCAL.
**ETAT D'ORIGINE, CORRIGE DEPUIS** -- au moment de la redaction,
`workspace-service.ts:378-420` (`restore`) n'appelait aucune porte
d'approbation : ni `isApproved`, ni `launch-approval`. Un workspace du depot
livrait donc du shell sans le garde-fou que les templates ont.
**MESURE 2026-08-25 11:40** -- ce trou est ferme : `git show --stat e63a57d`
("gater la restauration d'un espace de travail comme un template, sur deux
classes de danger distinctes", carte `09d54a29`), et
`grep -n "approv" desktop/src/main/workspace-service.ts` rend desormais la
porte `args` (:119-124, :443) et la porte `cwd` (:130, :455), avec deux cles
d'approbation namespacees. Le raisonnement du §2.2 reste la trace de POURQUOI
cette porte existe ; il ne decrit plus un manque.

**DEDUIT** -- `cwd` etend l'ensemble autorise des repertoires.
`ipc.ts:797` : `for (const s of service.list()) add(s.cwd, s.name)`. Les cwd des
sessions VIVANTES constituent l'allow-set que `requireWorkDir` (`ipc.ts:802`)
oppose aux canaux explorer/diff. Un `cwd` venu d'un fichier de workspace du
depot devient donc, une fois la session restauree, une racine lisible.
C'est le precedent GX-SEC nomme dans CLAUDE.md (entree hostile #3).

**DEDUIT** -- rien ne valide le contenu.
`isWorkspace` (`workspace-store.ts:96-104`) ne verifie que `typeof id ===
'string'` et `Array.isArray(sessions)`. Aucun champ de `WorkspaceSession` n'est
valide, ni type ni forme.

**DEDUIT** -- `command` n'est PAS capture (`workspace-session-map.ts:41`,
`command: ''`). Cette omission est porteuse : `command` remplace le binaire de
lancement. Ce n'est pas une perte a corriger, c'est une exclusion a nommer.

### 2.3 Le `.gitignore` n'est pas une defense

**DEDUIT** (`workspace-store.ts:71-90`) : `ensureWorkspacesDir` ecrit
`workspaces/` dans `.claude/claude-peers/.gitignore`. C'est NOTRE hygiene, pas
une garantie : gitignore n'empeche pas un depot de SUIVRE un fichier, et un
fichier suivi arrive dans le clone. L'app ne peut pas distinguer un workspace
ecrit par l'operateur d'un workspace livre par le depot.

### 2.4 Les templates ne consomment pas `SessionDef`

**DEDUIT** (`template.ts:48-56`) : `toTemplate` prend un `DefLike` declare
localement, sous-ensemble structurel de 7 champs. Ajouter un champ a
`SessionDef` est donc INVISIBLE cote templates -- aucun mecanisme de type ne
peut y mordre tant que cette duplication existe.
**MESURE** : `grep -n "^import" desktop/src/shared/types.ts` ne rend rien --
`types.ts` n'importe rien du tout. La regle "module pur, pas d'alias `@shared`"
n'oblige donc pas `DefLike` : un `import type { SessionDef } from './types'`
resoudrait sous `bun test` exactement comme celui de
`workspace-session-map.ts:9`.

---

## 3. Le fait qui deplace le probleme : une decision operateur posterieure

La carte `0b9e0b07`, append du **2026-08-24 21:35**, porte un arbitrage de
l'operateur :

> LE ROLE DOIT ETRE ENREGISTRE PAR LE TEMPLATE, QUELLE QUE SOIT SA PORTEE,
> GLOBALE COMME LOCALE. [...] pas de porte d'approbation dediee.
> RISQUE ACCEPTE : en cas d'entree hostile, le pire est un melange des roles
> entre le broker, le client et ce que l'operateur a en tete.
> [...] le futur code de routage par role ne doit JAMAIS traiter le role comme
> une AUTORISATION : router vers, oui ; autoriser a faire, non.

La carte `a2f61172`, append du **2026-08-24 18:38** (trois heures plus tot),
dit l'inverse :

> Le role ne sert plus seulement a INFORMER les autres peers : il devient la
> base d'une AUTORISATION. Le broker lira ce role dans sa propre table pour
> decider si un peer a le droit d'ecrire le champ `queue` d'une carte.

**Ces deux decisions ne peuvent pas etre vraies ensemble.** La plus recente
(21:35) tranche que le role n'est pas une autorisation ; la premiere (18:38)
fonde le lot 2 de `7defe381` dessus. C'est une question pour l'operateur, pas
pour la conception, et elle conditionne `b313f0c3` :

- si le role N'EST PAS une autorisation, l'argument de securite qui justifie de
  l'exclure des workspaces tombe -- il a deja ete ecarte pour les templates,
  avec le meme risque, par la meme personne, pour la meme raison ergonomique
  (11 gestes manuels par application) ;
- si le role EST une autorisation, alors `0b9e0b07` doit etre rouverte avant
  d'etre livree, parce qu'un template de depot poserait cette autorisation.

L'operateur a lui-meme borne sa decision : *"PERIMETRE INCHANGE : la capture de
workspace n'est PAS couverte par cette decision et garde son comportement
actuel jusqu'a arbitrage separe."* Le present document est cet arbitrage
separe, et il ne pouvait pas etre rendu sans la reponse ci-dessus.

**REPONSE OBTENUE LE 2026-08-25 : le role n'est PAS une autorisation.**
L'operateur abandonne l'autorisation par le role au profit d'un verrou
d'execution sur le lot (carte `011d3547` : `operator_id` porte la reservation,
`group_id` porte le verrou, aucun role requis). C'est la branche "si le role
N'EST PAS une autorisation" ci-dessus : **l'argument de securite qui justifiait
d'exclure `role` des workspaces tombe**, et les workspaces peuvent suivre la
meme ouverture que les templates (capture, `sanitizeRole` obligatoire, meme
risque accepte). Le lot C s'en trouve simplifie. Deux reserves qui subsistent :
`lead` n'est pas `role` et reste une cible de dispatch (§4.3), et un workspace
n'a pas de portee globale, ce qui reste le seul ecart reel avec les templates.

---

## 4. Refutation de l'arbitrage propose

### (1) "La pick-list est une frontiere de securite mal nommee" -- REFUTE

Elle n'est pas une frontiere juste par accident sur l'axe securite et fausse
ailleurs. Elle est fausse **dans les deux sens** :

| champ | pouvoir | statut actuel | verdict |
|---|---|---|---|
| `cwd` | etend l'allow-set explorer/diff (`ipc.ts:797`) | **capture** | faux positif |
| `args` | shell verbatim (`session-command.ts:193`) | **capture** | faux positif |
| `command` | remplace le binaire | exclu | correct, par accident |
| `role`, `lead` | identite / routage | exclus | correct, mais contredit par l'arbitrage du 21:35 |
| `effort`, `prompt`, `autoResume`, `worktree` | aucun | exclus | faux negatif |

La selection de ces 6 champs ne correspond a aucune politique. Il n'y a pas de
frontiere mal nommee : il n'y a pas de frontiere.

### (2) "Partition explicite dans le mapper" -- IDEE JUSTE, EMPLACEMENT FAUX

Trois objections.

**a. Un mapper de persistance n'est pas un point de confiance.** La question de
securite n'est pas "quels champs persister" mais "quels champs un fichier
d'ORIGINE DEPOT a le droit de poser sur une session qui va etre lancee". La
reponse depend de l'origine, que le mapper ne connait pas. Mise dans le mapper,
la regle doit etre dupliquee dans `template.ts` -- et elle y a deja diverge
(les templates capturent `lead`, les workspaces non).

**b. Nommer "EXCLU-PAR-SECURITE" des champs deja exclus en amont fabrique un
faux pointeur.** `supervisor`, `mcpConfig` et `appendSystemPromptFile` ne
peuvent pas atteindre `toWorkspaceSessions` : `captureSessions` filtre
`!d.supervisor` en amont (mesure figurant dans la carte). Les classer
"exclus ici par securite" affirme une garantie que ce code ne porte pas --
exactement le defaut que CLAUDE.md nomme (`PinnedTrust.kt`, `KNOWN_FIELDS`).
Ils doivent porter une classe distincte : *absent par construction de l'entree*.

**c. La partition rend gratuitement du perimetre.** Si l'enforcement passe a
l'ingestion, le mapper redevient libre de capturer `effort`, `prompt`,
`autoResume`, `worktree` -- quatre pertes reelles corrigees sans debat.

### (3) "Rendre la perte visible" -- VALIDE, avec deux corrections

Oui : le silence est la faute. Deux precisions.

- L'annonce doit enumerer ce que **la porte a laisse tomber**, pas ce qu'un
  developpeur croit qu'elle laisse tomber. Sinon c'est une seconde enumeration,
  qui derivera de la premiere. Elle doit etre **produite par la porte**.
- Elle doit couvrir `lead` autant que `role` (deux autorisations, mesure de la
  carte), et proposer un geste operateur -- jamais une re-application
  automatique, qui reintroduirait le chemin non-operateur.

### Piste B -- toujours refusee, avec un argument nouveau

La carte demande un argument NOUVEAU pour rouvrir B. En voici un, contre :
d'apres la mesure (a) de la carte, seule **une** session sur N est reprise sur
sa ligne ; les N-1 autres obtiennent un `peer_id` NEUF et laissent une ligne
dormante. Ne plus effacer ne restaure donc rien pour les N-1 : leur role vit sur
une ligne que plus personne ne regarde, et qui expire en 24 h. **B corrige une
session sur N** tout en reintroduisant l'heritage silencieux. Le rapport
cout/benefice est pire que ce que la carte supposait.

---

## 5. Fermeture par le type : oui, c'est possible

Toutes les lignes de cette section sont **MESUREES** avec
`desktop/node_modules/.bin/tsc --noEmit --strict --target es2022
--moduleResolution bundler --module esnext <probe>.ts`, tsc **5.9.3**, sur des
sondes hors depot (`C:/tmp/arch-b313f0c3-probe/`).

### 5.1 L'oubli d'un champ ne compile pas

Forme : `Record<keyof SessionDef, FieldClass>`. Sonde `p1-missing.ts`, champ
`proxyProfile` ajoute au type et non classe :

```
p1-missing.ts(27,14): error TS2741: Property 'proxyProfile' is missing in type
'{ id: "exclude-local"; name: "capture"; ... }' but required in type
'Record<keyof SessionDef, FieldClass>'.
```

Forme `as const satisfies` (necessaire pour deriver les unions, cf. 5.2),
sonde `p3-satisfies.ts` :

```
p3-satisfies.ts(34,12): error TS1360: Type '{ readonly id: "exclude-local"; ... }'
does not satisfy the expected type 'Record<keyof SessionDef, FieldClass>'.
  Property 'proxyProfile' is missing in type '{ ... }' but required in type
  'Record<keyof SessionDef, FieldClass>'.
```

### 5.2 Le sens inverse est ferme aussi

Un champ renomme ou supprime de `SessionDef` alors que la table le classe
encore, sonde `p2-unknown.ts` :

```
p2-unknown.ts(14,3): error TS2353: Object literal may only specify known
properties, and 'legacyRole' does not exist in type
'Record<keyof SessionDef, FieldClass>'.
```

### 5.3 Les unions derivees sont exactes

Sonde `p6-show2.ts`, qui force tsc a enumerer :

```
error TS2739: ... missing the following properties from type
'{ name: 1; color: 1; cwd: 1; sessionId: 1; effort: 1; }'
error TS2740: ... missing the following properties from type
'{ id: 1; role: 1; command: 1; args: 1; lead: 1; createdAt: 1; }'
```

Donc `KeysOfClass<'capture'>` et `KeysOfClass<'authority' | 'local'>` sont
utilisables comme unions de cles reelles, pas seulement comme documentation.

### 5.4 La table est CABLEE, pas decorative

Deux branchements, tous deux mesures.

Lecture -- le mapper ne voit que les champs captures
(`defs: readonly Pick<SessionDef, CapturedKey>[]`), sonde `p4-clean-map.ts` :

```
p4-clean-map.ts(51,13): error TS2339: Property 'role' does not exist on type
'Pick<SessionDef, CapturedKey>'.
```

Ecriture -- le def reconstruit ne peut pas porter un champ exclu, sonde
`p7-restore-guard.ts` :

```
p7-restore-guard.ts(68,3): error TS2322: Type 'string' is not assignable to
type 'undefined'.
```

Ce message est faible. Avec un marqueur nomme (`p8-brand.ts`), il devient
parlant :

```
p8-brand.ts(50,3): error TS2322: Type 'string' is not assignable to type
'ExcludedFromWorkspaceCapture'.
```

### 5.5 On peut meme forcer la CLASSE depuis le TYPE du champ

Un champ marque `Authority<string>` ne peut plus etre classe `capture` :

```ts
declare const AUTHORITY: unique symbol
export type Authority<T> = T & { readonly [AUTHORITY]?: true }
type ForcedClass<K extends keyof SessionDef> =
  NonNullable<SessionDef[K]> extends Authority<unknown> ? 'authority' : FieldClass
type PolicyMap = { [K in keyof SessionDef]-?: ForcedClass<K> }
```

Sonde `p8-brand.ts`, `role: 'capture'` dans la table :

```
p8-brand.ts(33,3): error TS2322: Type '"capture"' is not assignable to type '"authority"'.
```

**MESURE, et c'est le point important** : le marquage ne coute rien en amont.
Dans la meme sonde, `const def: SessionDef = { ..., role: 'developer' }` et
`const read: string | undefined = def.role` compilent tous deux sans erreur --
le brand optionnel reste assignable dans les deux sens.

### 5.6 Deux pieges mesures, a ne pas redecouvrir

- **Une intersection dont une propriete devient `never` est reduite a `never`
  ENTIERE** (tsc 5.9.3). La sonde `p4` a produit 9 erreurs parasites parce que
  `Pick<..., CapturedKey | 'id'>` et `{ [K in ExcludedKey]?: never }` se
  recouvraient sur `id`. Les ensembles doivent etre disjoints : d'ou la
  troisieme classe `local` (regenere a la restauration) plutot que deux.
- **Un `satisfies` en echec empoisonne les unions derivees** : `ClassMap[K]`
  devient un type d'erreur, `any extends C ? K : never` rend `K` dans les deux
  branches, et toutes les cles tombent dans toutes les classes. Consequence
  pratique : la premiere erreur a corriger est toujours celle de la table ; les
  suivantes sont du bruit.

### 5.7 Ce que le type ne peut PAS faire, franchement

Le compilateur rend la classification **TOTALE**. Il ne la rend pas **JUSTE** :
un futur agent peut classer `capture` un champ dangereux. 5.5 ne referme cela
que pour les champs dont l'auteur a pense a marquer le type -- ce qui deplace
l'oubli d'un cran sans le supprimer. C'est structurellement le meilleur
disponible : la totalite est verifiable, la justesse est un jugement.
La contre-mesure n'est pas un test de discipline (meme famille de fail-open),
c'est que la classe `capture` soit celle qui **rende un champ visible dans une
porte d'approbation** : un champ mal classe devient alors bruyant, pas
silencieux.

---

## 6. Frontiere : un seul mecanisme, ou deux ?

**Verdict : UNE table de pouvoir, DEUX portes.**

Ce qui doit etre partage -- la classification du POUVOIR d'un champ. `lead` ne
change pas de nature selon qu'il arrive par un template ou par un workspace.
Deux tables divergeront ; elles ont deja diverge (`lead` capture par les
templates, pas par les workspaces).

Ce qui ne peut pas etre partage -- la DECISION. Trois raisons mesurees :

1. **Les domaines different.** `TemplateSession` porte `agent`, `model`,
   `worktreeBranch`, `announce` (`template.ts:17-38`), qui n'existent pas sur
   `SessionDef` ; `WorkspaceSession` porte `cwd`, `claudeSessionId`, `position`
   (`workspace-store.ts:31-39`), qu'un template exclut deliberement. Le domaine
   commun est `CreateSessionInput` (`types.ts`), pas `SessionDef`.
2. **Les origines different.** Un template a TROIS portees (globale = operateur,
   locale = depot, importee) -- `template-store.ts:28`/`:48`. Un workspace n'a
   qu'une origine : le depot. La porte des templates a donc une branche
   "confiance" qui n'a aucun sens cote workspace.
3. **L'etat de l'art differe.** Les templates ont deja une porte
   (`index.ts:1810-1845`), fail-open sur 2 champs regardes sur ~11
   (carte `8aa66817`). Les workspaces n'en ont aucune.

Consequence sur le decoupage : `b313f0c3`, `8aa66817` et `0b9e0b07` sont
**trois cartes** (trois resultats visibles distincts) qui partagent **un
prealable** (la table). Ce n'est pas un lot unique : `0b9e0b07` est deja
arbitre par l'operateur et peut partir sans la table.

---

## 7. Lots recommandes

**Lot A -- `cwd` et `args` d'un workspace restaure. LIVRE le 2026-08-25,
commit `e63a57d`, carte `09d54a29`. Ne pas le reprendre.**
Deux champs deja captures, aucune porte, un shell et un allow-set au bout
(§2.2). La reserve que je posais ici -- *"chaine lue, pas reproduite, a
reproduire avant de qualifier la severite"* -- a ete levee par qui a livre :
le message de commit rapporte la reproduction jusqu'a l'argv, un point-virgule
dans `args` survivant intact dans le payload de `sh -l -c` comme dans celui de
`powershell -Command`. Deux predicats et deux cles d'approbation distincts ont
ete retenus, ce qui est plus fin que ce que ce document proposait.

**Lot B -- la table de classes + la fermeture par le type. Aucun changement de
comportement.**
Une table `Record<keyof SessionDef, FieldClass>`, les unions derivees, le
mapper type sur `Pick<...>`, le def restaure type contre un marqueur nomme
(§5). Corrige au passage le faux pointeur `types.ts:73` (`lead` "captured in
workspaces and templates" -- **MESURE dans la carte** : zero occurrence cote
workspaces). Fait tomber `DefLike` au profit d'un import de `SessionDef`
(§2.4). Prealable de C et D, pas de A.

**Lot C -- `b313f0c3` proprement dit.**
Rendre `effort`, `prompt`, `autoResume`, `worktree` (aucun pouvoir, perte
seche). Annoncer ce que la porte a laisse tomber, `role` ET `lead`, avec un
geste de re-pose (§4.3). Le sort de `role`/`lead` eux-memes depend de la
question du §3.

**Lot D -- `8aa66817`.**
Inverser la porte des templates : cle et apercu derives d'une pick-list
explicite des champs inoffensifs issue de la table du lot B, pour qu'un 12e
champ echoue FERME. Depend de B.

**Lot E -- TRANCHE, plus bloquant.**
`7defe381` lot 2 ne sera pas une autorisation par le role : l'operateur a
retenu un verrou d'execution sur le lot (`011d3547`). Les contraintes mesurees
qui survivent a cet abandon sont dans `docs/DESIGN-QUEUE-WRITE-AUTHORITY.md`
(domaine reel des ecritures sensibles, chemin du refus, grain CHAMP de la
fermeture par le type, troisieme surface `handleRoadmapImport`).

Ordre restant : B d'abord ; C et D en parallele apres B. A est livre, E sort
du perimetre de ce document.

---

## 8. Questions ouvertes pour l'operateur

1. ~~**Le role est-il une autorisation ?**~~ **REPONDU le 2026-08-25 : non**
   (verrou d'execution, carte `011d3547`). Voir §3.
2. **Reste ouvert** : les workspaces capturent-ils `role` ET `lead`, ou `role`
   seul ? La reponse au point 1 ouvre `role` par coherence avec les templates,
   mais `lead` designe la cible des annonces et du dispatch, et un fichier du
   depot qui la designe reste un pouvoir -- que la nouvelle porte de `e63a57d`
   ne couvre pas (elle regarde `args` et `cwd`, pas `lead`).
3. ~~**La porte manquante cote workspace**~~ **REPONDU : livree** (`e63a57d`,
   carte `09d54a29`). Voir §7 lot A.
4. **Reste ouvert** : la porte livree regarde deux champs. Si le lot B pose la
   table de classes, la cle et l'apercu de cette porte doivent-ils en deriver,
   pour qu'un champ dangereux ajoute plus tard echoue FERME plutot que d'etre
   simplement absent du predicat ? C'est le meme defaut fail-open que le lot D
   corrige cote templates.

---

## 9. Sondes

Les sept sondes tsc de la §5 vivent hors du depot, dans
`C:/tmp/arch-b313f0c3-probe/` (`p1-missing.ts`, `p2-unknown.ts`,
`p3-satisfies.ts`, `p4-clean-map.ts`, `p5-show-unions.ts`, `p6-show2.ts`,
`p7-restore-guard.ts`, `p8-brand.ts`). Elles ne sont pas un garde-fou : rien ne
les rejouera. Qui livre le lot B doit porter l'equivalent dans le depot, sous
forme d'un test de compilation negatif (`// @ts-expect-error` sur une table
incomplete), sans quoi la preuve du §5 n'existe que dans ce document.
