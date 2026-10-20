# Plugin de rendu lisible : contrat et lot 1 (cartes f732182b, 574feb89)

Statut : conception de l'architecte, 2026-10-19, CLI mesuree 2.1.303. Brief
non commite par l'auteur. Aucune ligne de production n'est ecrite ici : les
signatures ci-dessous sont un CONTRAT, pas du code.

Etiquettes : MESURE (commande + sortie), DEDUIT (lecture de code, `fichier:ligne`),
SUPPOSE (non verifie).

REVISE le 2026-10-19 : le VEHICULE (emplacement `desktop/readable-plugin/`,
paquet dans ce repo) est remplace par un repo separe a marketplace ; voir
`docs/DESIGN-MODS-REPO.md`. Le contrat de rendu V1, la garde et les pieges
ci-dessous restent valables.

## 1. Cadrage

Ratifie par l'operateur (carte f732182b, append du 2026-10-18, Kleos #29674) :
cadres a coins DROITS, `ScreenGuard` INCHANGE, paquet autonome opt-in, version
minimale supportee (decision operateur du 2026-10-20, carte ab5ae18c, qui remplace
la table de versions certifiees), garantie bornee au corpus de captures. Le lot 1 livre le
CONTRAT et un PROTOTYPE chargeable seul, sans cablage Deck.

## 2. Precedents du depot (lus avant de dessiner)

| Precedent | Ce qu'il donne | Ce qu'il ne donne pas |
|---|---|---|
| `desktop/deck-lead-plugin/` (2 fichiers suivis, aucun build) | Un second `--plugin-dir` autonome, suivi par git, copie tel quel par `extraResources` (`desktop/electron-builder.yml`, entree `deck-lead-plugin`), nom de dossier fige par `DECK_LEAD_PLUGIN_DIRNAME` (`desktop/src/main/session-command.ts:18`). | Aucun module `hooks.json` : skills seulement. |
| `desktop/deck-plugin/` + `desktop/hooks/kory-module.ts` | Un module de mods charge par `modules` dans `hooks/hooks.json`. Ses `.mjs` sont des artefacts de `bun build`, NON suivis (`git ls-files desktop/deck-plugin` ne liste que `plugin.json`, `hooks.json`, `skills/`). | Le bundle n'existe que parce que le module importe `src/shared/*`, hors du dossier. |
| `tests/desktop-kory-module-plugin-validate.test.ts` | Garde qui lance le VRAI `claude plugin validate --json` sur une copie temporaire, exemption explicite `KORY_SKIP_PLUGIN_VALIDATE=1`. | Aucun test de comportement du rendu. |
| `desktop/src/main/xterm-screen.ts:358-419` (`inspectInjectGuard`) | Les regles exactes que le rendu doit respecter (section 5). | |
| Mod tiers `readable-layout` (MIT, hors depot) | Hooks `ui.render` sur `UserMessage`, `AssistantMessage`, `TurnDuration`; un fichier de test `claude plugin test`. | Cadres `round`, aucune table de versions, bold colore par parseur maison. |

MESURE : `claude plugin validate --json <readable-layout>` rend `"success": true`
et liste `ui.render{component=UserMessage|AssistantMessage|TurnDuration}`.
MESURE : `claude plugin test <readable-layout>` rend `15 pass`, `0 fail`,
`Ran 15 tests across 1 file. [0.72s]` (1,0 s en mur) sur `claude 2.1.303`. Ce
mod importe un fichier frere (`./markdown`) et ses tests passent : le chargeur
resout des imports relatifs internes au dossier.

## 3. Options de vehicule et recommandation

- **A. Paquet autonome SANS build** (`desktop/readable-plugin/`, sources TS/TSX
  chargees telles quelles, suivies par git). Une source, un artefact : la source
  EST l'artefact. Aucun import hors du dossier. Reversible (supprimer le dossier).
- **B. Paquet autonome avec `bun build`** comme `deck-plugin`. Ajoute un artefact
  non suivi, une etape de build, la regle `$ passe a une fonction const` que le
  test de validation existant a du verrouiller apres bundling, et le piege de
  l'ordre des exports entre versions de bun. Aucun gain : rien a bundler.
- **C. Module dans `deck-plugin`** (ce que l'architecte recommandait pour les
  autres mods, Kleos #20140). Ecarte par la ratification : desactivation
  independante, et un second module `ui.render` dans le meme plugin que les
  approbations lierait leur cycle de vie.

**Recommandation : A.** Force decisive : le paquet n'importe rien hors de son
dossier, donc il n'a aucune raison d'etre bundle ; la copie packagee, la copie
installee hors Kory et la copie du depot sont le meme arbre d'octets.

## 4. Contrat du paquet (lot 1)

### 4.1 Arborescence

```
desktop/readable-plugin/
  .claude-plugin/plugin.json     name, version, description, userConfig.labels
  hooks/hooks.json               { "modules": ["./register.tsx"] }  (une seule cle)
  hooks/register.tsx             cablage seul : 3 hooks ui.render + session.start
  hooks/layout.ts                PUR : classification, constantes de cadre, regle de fin de tour
  hooks/versions.ts              PUR : version minimale supportee, par capacite
  tsconfig.json                  { "extends": "./.claude-plugin/types/tsconfig.json" } (comme deck-plugin)
  README.md                      installation hors Kory, quoi desactiver
```

Pas de `tests/` DANS le paquet : voir 6.3 (piege `bun test`). Pas de
`types/index.d.ts` : le paquet ne range rien dans `$.state` au lot 1.
`.claude-plugin/types/` est ecrit par le moteur et ignore par un `.gitignore`
`*` interne (precedent : `desktop/deck-plugin/.claude-plugin/types/.gitignore`).

`plugin.json` :
- `name` : `kory-readable-layout`. Le nom EST l'identite de chargement (section 7).
  Eviter tout nom contenant `claude` : `claude plugin validate` signale deja
  « reserved » pour `claude-peers-deck-backchannel` (tolere par le test existant).
- `userConfig.labels` : `string`, `options: ["en","fr"]`, `default: "en"`. Le
  Deck imposera `fr` au lot 3 depuis sa locale ; le defaut neutre sert l'install
  hors Kory. Valeur inconnue -> `en` (`resolveLabels`).
- Aucune cle `author`/`homepage` copiee du mod tiers. Ecrire le code depuis CE
  contrat ; si une ligne est reprise du mod tiers, conserver sa notice MIT.

### 4.2 Hooks `ui.render` exacts

Chaque hook : `($, e, next)` asynchrone, premiere ligne = les gardes communes,
toute garde ratee -> `return next(e)` (rendu stock).

Gardes communes, dans cet ordre :
1. `e.surface === 'terminal'`.
2. `typeof` de chaque prop utilisee (`text` et `word` : string ; `durationMs` :
   number fini). Echec -> stock (derive d'API a l'interieur d'une version supportee).
3. `isSupported(base, 'layout')` (4.3) vrai, `base` lu dans `await $.session.version()`.
4. `(e.viewport?.columns ?? 80) >= MIN_FRAME_COLUMNS` (40). Sous 40 colonnes : stock.
   Valeur choisie parce que la mesure du lead couvre 40, 80 et 120 : en dessous,
   non mesure, donc stock (DEDUIT : echec ouvert vers le rendu natif).

| Composant | Gardes propres | Rendu |
|---|---|---|
| `UserMessage` | `e.props.origin.kind === 'composer'` ; `text.trim() !== ''`. Notifications de taches, messages de pairs, canaux : stock. | `frame(label.user, 'suggestion', <Text>{text.trim()}</Text>)` |
| `AssistantMessage` | `text.trim() !== ''` ; puis `mustStayStock(text)` -> stock ; puis `isSummary === true` -> ligne attenuee ; sinon cadre. | cadre `frame(label.assistant, 'claude', <Markdown text={text.trim()} />)` ou ligne attenuee (4.4) |
| `TurnDuration` | `word` string non vide, `durationMs >= 0`. | `turnRule(...)` dans un `Text dimColor wrap="truncate-end"`, `marginTop 1` |

`isFirstOfReply` et `onScreen` ne servent pas au lot 1 (V1 : tout bloc non
resume est encadre, ratifie).

### 4.3 Version minimale et repli

Decision operateur du 2026-10-20 (carte ab5ae18c) : la certification EXACTE est
abandonnee. La CLI se met a jour presque chaque jour, et l'egalite exacte laissait
le plugin inactif chez l'operateur (2.1.304 contre 2.1.303 certifiee). Une version
egale ou superieure a un minimum valide active le plugin ; si une mise a jour
casse le rendu, on fait une passe de reparation (le repli R7 limite l'impact).

`versions.ts` (pur, ne depend pas du module `claude-code` a l'execution, livre
dans choregos@67d3fe6) :

```ts
export type Capability = 'layout'              // 574feb89 ajoutera 'finalTurn'
export const MIN_SUPPORTED: Readonly<Record<Capability, string>> = {
  layout: '2.1.303',
}
export function isSupported(base: string | undefined, capability: Capability): boolean
```

- Cle = `SessionVersion.base` de `await $.session.version()` (type :
  `claude-code.d.ts:12252-12272`, `version: () => Promise<SessionVersion>` ligne
  2919), lue comme une release `MAJOR.MINOR.PATCH` et comparee NUMERIQUEMENT,
  composant par composant, au minimum de la capacite (2.1.40 est inferieur a
  2.1.303). MESURE sur session reelle : 2.1.303 et 2.1.304 rendent `base` egal a
  `version`.
- `base` absent, illisible, suffixe `-dev` (`2.1.304-dev` n'est pas une release)
  ou inferieur au minimum -> `false`.
- Un minimum par capacite : le minimum de `layout` ne dit rien de `finalTurn`
  (point d'extension de 574feb89).
- `supported($)` memoise la PROMESSE dans une variable du module (constante pour
  un processus ; un rechargement la recree). Rejet de `$.session.version()` ->
  `false` ET `$.ui.log(msg, { to: 'debug' })` (pas de silence). Passer `$` a des
  `function` declarees, pas a des `const` fleches (regle de `claude plugin
  validate` rappelee par `tests/desktop-kory-module-plugin-validate.test.ts:27`).
- Version non supportee : un hook `session.start` appelle `supported($)` une fois
  et leve UN toast (`$.ui.toast`) « version X non supportee, rendu natif », une
  seule fois par processus. Sans lui le plugin « ne fait rien » sur une CLI trop
  ancienne ou de developpement sans qu'aucune trace ne le dise.
- Un hook de module en echec ou au-dela de 10 s est SAUTE, un arbre invalide est
  remplace par le rendu du moteur avec une ligne de debug (reference.md,
  « Drawing: ui.render »). Le repli est donc natif ; le paquet n'ajoute aucun
  `try/catch` qui masquerait une erreur.

Cout de maintenance a assumer (DEDUIT) : une mise a jour de la CLI reste active
sans certification ; une casse constatee se repare dans le plugin, et le minimum
n'est releve que si une version ancienne ne peut plus etre servie.

### 4.4 Rendu V1

Cadre (`frame`) :
- `<Box flexDirection="column" marginTop={1}>` contenant
  `<Box flexDirection="column" borderStyle={GUARD_SAFE_BORDER} borderColor={couleur} paddingX={1}>{corps}</Box>`
  et le titre : `<Box position="absolute" top={0} left={2}><Text color={couleur} bold>{` ${label} `}</Text></Box>`.
- `GUARD_SAFE_BORDER = 'single'` : constante exportee de `layout.ts`, utilisee par
  le dessin ET par les tests. Glyphes attendus du style `single` : coins
  `┌ ┐ └ ┘` (U+250C 2510 2514 2518), horizontale `─` (U+2500), verticale `│`
  (U+2502). Jamais `round`/`bold`/`double`/`classic`.
- Ligne du haut attendue : `┌─ Vous ─────…─┐`.
- Largeur : celle de la colonne du transcript (le `Box` colonne s'etire) ; texte
  interieur sur `columns - 4`. Retour a la ligne : celui d'ink (`Text` par defaut,
  `Markdown` natif) ; un mot plus long que la largeur est coupe par ink DANS le
  cadre. Aucun parseur maison, aucune coloration du gras (ratifie).
- Libelles : `en` -> `You` / `Claude` ; `fr` -> `Vous` / `Claude`. Table figee
  `LABELS`, jamais lue depuis les props.
- Couleurs : `suggestion` (utilisateur), `claude` (assistant), noms de theme
  valides dans le mod tiers (assertions de son test).

Ligne attenuee (`isSummary`) :
- `<Box paddingLeft={2}><Markdown text={text.trim()} dimColor /></Box>`, aucune
  marge haute, AUCUN glyphe de tete. Pas de `·` ni de `*` (cf. `SPINNER_HEAD_RE`,
  `desktop/src/main/detect/busy.ts:32`), pas de `❯`. Corps `Markdown` et non `Text`
  pour que 574feb89 reutilise la meme fonction pour les blocs intermediaires.

Regle de fin de tour (`turnRule`) :
- `width = columns - 2` ; `label = " ✻ {word} for {duree} "` ; ligne =
  `──` + label + `─` x (width - len(label) - 2), tronquee a `width` points de code.
  `duree` : `Ns` ou `Nm Ss` (secondes arrondies, minimum 1).
- `word` : espaces blancs ramenes a un seul espace, borne a 24 caracteres.
- Invariant : la ligne ne fait JAMAIS `columns` points de code (la regle
  `composer-geometry` exige `[...line].length === cols` pour un bord haut,
  `xterm-screen.ts:367-368`), et ne commence pas par `✻`, ne contient ni
  `(Ns ·`, ni `↓ N tokens`, ni `· thinking)` (`SPINNER_CUE_RE`, `busy.ts:24`).

### 4.5 Ce qui DOIT rester en rendu stock

| Cas | Pourquoi | Garde |
|---|---|---|
| Version non supportee, surface non terminal, `< 40` colonnes | repli | gardes communes |
| `UserMessage` dont `origin.kind !== 'composer'` | notifications et messages de pairs ont un habillage du moteur | garde propre |
| `AssistantMessage` qui ressemble a un message de limite | la detection de `quota.ts` lit le flux PTY nettoye (`quota.ts:38-55`) : `hit\s+your\s+limit`, `resets?\s+...` utilisent `\s+` qui ne traverse pas `│`. Mesure du lead : coupe en deux lignes d'un cadre, le message n'est plus detecte. | `mustStayStock(text)` |

`mustStayStock(text)` : vrai si `text` fait au plus 400 caracteres, au plus 3
lignes, et contient (insensible a la casse) `limit`, `resets`, `rate limit`,
`quota`, `overloaded` ou `usage`. Sur-correspondre ne coute qu'un message court
non encadre ; sous-correspondre casse la reprise automatique. Direction d'erreur
choisie : stock. Ne PAS la remplacer par un seuil de longueur seul (l'operateur
veut qu'une reponse finale courte reste encadree, carte 574feb89).

## 5. Contraintes lues dans la garde et les detecteurs

(DEDUIT, `desktop/src/main/xterm-screen.ts:358-419`.) Verdict `modal` si :
1. une ligne verifie `^\s*❯\s+\d+\.` hors rangee d'echo (`xterm-screen.ts:110,385`)
   -> aucune ligne emise par le paquet ne commence par `❯` ;
2. une ligne commence (apres `trimStart`) par `╭` et une ligne finit par `╮`, ET
   une autre commence par `╰` et finit par `╯` (`:392-402`) -> coins droits
   seulement. Effet de bord DEDUIT : une ligne de corps d'un cadre commence par
   `│`, donc un texte de modele qui dessine `╭…╮` DANS un cadre ne declenche plus la
   regle (a confirmer en capture, lot 2) ;
3. la geometrie du composeur (`:404-416`) ne regarde que les lignes autour du
   curseur : le paquet ne touche pas au composeur.

Detecteurs sur le flux PTY : `quota.ts` (section 4.5), `busy.ts` (4.4, regle de
fin de tour), `attention.ts` et `permission-dialog.ts` n'utilisent `❯` que pour des
selecteurs de dialogue (DEDUIT, `attention.ts:44,63,71`, `permission-dialog.ts:17`) :
la disparition de l'echo `❯ texte` d'un message utilisateur encadre ne les prive
d'aucun signal.

## 6. Preuve : lot 1 contre lot 2

### 6.1 Ce que le lot 1 prouve SANS capture reelle

Fichier : `tests/desktop-readable-plugin.test.ts` (nouveau module source, donc
nouveau fichier de test ; le test de validation du kory-module reste inchange).

1. **Grille synthetique dans le vrai `createXtermScreen`**, verdict par
   `inspectInjectGuard` : on compose [lignes de transcript synthetiques construites
   avec le jeu de glyphes `single`] + [composeur au repos pris d'une fixture REELLE
   `clear` de `tests/_fixture-verdicts.ts`], a 40, 80 et 120 colonnes. Corps testes :
   texte simple, liste numerotee `1. a`, texte contenant `❯ 1. oui`, texte contenant
   un cadre `╭──╮ / ╰──╯` du modele, URL plus longue que la largeur, cadre
   utilisateur + cadre assistant + ligne attenuee + regle de fin de tour. Attendu :
   `{ state: 'clear' }` partout.
2. **Controle positif** (sans lui le test peut etre rouge ou vert pour la mauvaise
   raison) : la MEME grille avec le jeu `round` -> `{ state: 'modal', rule: 'dialog' }`.
   Reproduit la mesure #29672.
3. **Test d'invariant du quota** : pour chaque message de la liste echantillon
   (les formes de `tests/desktop-quota.test.ts` : `You've hit your limit · resets
   10:30pm (Europe/London)`, `5-hour limit reached ∙ resets 2pm`, `weekly limit
   reached, resets in 2 hours`, `You've hit your limit`, `rate limited`, minutes),
   `detectRateLimit(m, now) !== null` IMPLIQUE `mustStayStock(m) === true`.
   Couverture honnete : l'invariant vaut pour la liste ; un nouveau libelle de
   `quota.ts` absent de la liste n'est pas vu. D'ou la capture du lot 2.
4. **Invariant de la regle de fin de tour** : pour `columns` de 40 a 400 et des
   `word`/`durationMs` varies, `[...turnRule].length < columns`, et
   `hasSpinnerRowCue(ligne) === false` (import de `detect/busy.ts`).
5. **Garde inchangee, prouvee par le diff** : `git diff --name-only` ne liste
   AUCUN de `desktop/src/main/xterm-screen.ts`, `screen-model*`, `quota.ts`,
   `attention*.ts`, `detect/*`, `tests/_fixture-verdicts.ts`.

Limite a dire : ces grilles prouvent que le JEU DE GLYPHES et la forme des lignes
sont compatibles avec les regles. Elles ne prouvent PAS que le moteur peint le
style `single` ainsi : c'est le lot 2. Le lien entre les deux est
`GUARD_SAFE_BORDER`, verifie cote harnais (6.2).

### 6.2 Test de comportement du rendu (`claude plugin test`)

Fichier d'amorce `tests/fixtures/readable-plugin/render-harness.tsx` : nom qui ne
correspond a aucun motif de decouverte de `bun test`. Le test bun le copie, avec
le paquet, dans un dossier temporaire sous le nom `render.test.tsx`, puis lance
`claude plugin test <tmp>` (precedent de copie : `desktop-kory-module-plugin-validate`).
Forme : celle du test du mod tiers (`engineBeneath(on)` pose des rendus
`engine:` sous le plugin, `$.ui.mount({ plugin, surface, component, props })`,
`find`/`findAll`). Assertions :
- cadre : un `Box` avec `borderStyle === GUARD_SAFE_BORDER` et jamais `round` ; titre
  `' You '` ; corps `Markdown` avec le texte ;
- `UserMessage` de notification, `AssistantMessage` de limite, surface `desktop` :
  le rendu `engine:` est atteint (le paquet a fait `next`) ;
- `isSummary` : `Markdown` avec `dimColor`, aucun `Box` a bordure ;
- `TurnDuration` : texte de la regle ;
- `options: { labels: 'fr' }` -> `' Vous '`.

A VERIFIER par le developpeur AVANT d'ecrire ce test (S4a) : comment fixer la
version dans le harnais. Piste (DEDUIT, `claude-code.d.ts:7082,7386`) : `$.session.version`
est un appel `$` dont l'evenement est `session.version` ; un `on('session.version', …)`
pose par le test SOUS le plugin le simulerait. `mock` n'a que `clock`, `store`,
`env`, `session` (`:16202`). Repli si la piste echoue : le test lit `claude
--version` et assertionne la branche qui correspond (cadre si supportee, stock +
toast sinon), avec un message d'assertion qui nomme la version. Ne jamais laisser
une mise a jour de la CLI rendre le gate rouge sans que le message le dise.

### 6.3 Pieges de gate

- `bun test` sans cible decouvre tout `*.test.ts(x)` du depot (465 fichiers, tous
  sous `tests/` : MESURE `git ls-files tests | grep -c -E "\.test\.tsx?$"` -> 465 ;
  aucun hors de `tests/`). Un fichier `*.test.tsx` DANS `desktop/readable-plugin/`
  importerait `claude-code/testing` et ferait tomber la suite (DEDUIT, decouverte
  par defaut de bun). D'ou le fichier d'amorce hors motif.
- `claude plugin test` execute « every `*.test.ts` and `*.test.tsx` under dir »
  (MESURE : `claude plugin test --help`).
- Couts : 2 lancements de `claude` (validate, test) ; `claude plugin test` du mod
  tiers : 1,0 s. Dire dans le corps du commit ce que le fichier achete et son temps.
- Exemption : reutiliser `KORY_SKIP_PLUGIN_VALIDATE=1`, pas de seconde variable.
- A lancer par le developpeur (cibles, pas la suite) :
  `bun test ./tests/desktop-readable-plugin.test.ts`,
  `bun test ./tests/desktop-kory-module-plugin-validate.test.ts`,
  `bun test ./tests/desktop-xterm-screen.test.ts`,
  `bun test ./tests/desktop-ci-typecheck-coverage.test.ts`,
  `bun test ./tests/desktop-ci-glob-coverage.test.ts`.
  Les deux derniers peuvent rougir sur un nouveau dossier source : a rapporter, pas
  a contourner par une exemption sans la nommer.

### 6.4 Mutations a nommer dans le commit

| Edition de la SOURCE | Test rouge |
|---|---|
| `GUARD_SAFE_BORDER` -> `'round'` | harnais (propriete `borderStyle`) |
| retirer l'appel a `mustStayStock` | harnais (rendu `engine:` attendu sur un message de limite) |
| ajouter `limit`-like au regex de `quota.ts` ET a l'echantillon sans toucher `mustStayStock` | invariant du quota |
| `turnRule` a largeur `columns` | invariant de largeur |
| ajouter `·` en tete d'une ligne attenuee | test d'invariant `hasSpinnerRowCue` sur la ligne attenuee |
| `MIN_SUPPORTED` au-dessus de la version courante, ou comparaison lexicale | harnais (branche stock + toast) |

### 6.5 Renvoye au lot 2

Captures reelles du CLI 2.1.303 dans une tuile PTY avec le paquet : tours simples,
plusieurs appels d'outil, reponse longue, liste numerotee, URL, 40/80/120
colonnes, `/clear`, reprise, pause, injection d'une directive pendant un cadre
visible. Verdicts ajoutes a `tests/_fixture-verdicts.ts` SANS toucher aux entrees
existantes. Capture du message de limite (6.6). Plus de regle de promotion par
version (decision operateur du 2026-10-20, 4.3) : le corpus sert de preuve sur la
version minimale et de banc de reparation quand une mise a jour casse le rendu.

### 6.6 Mesures de la ratification

**Quelle copie gagne (installation globale contre `--plugin-dir`).**
MESURE (source primaire, `https://code.claude.com/docs/en/plugins/loading`) : « An
enabled `--plugin-dir` … plugin replaces a same-named installed marketplace
plugin », remplacement silencieux, seule trace `Plugin "<name>" from --plugin-dir
overrides installed version` dans `~/.claude/debug/` ; exception : plugin verrouille
par les reglages geres (`--plugin-dir copy of "<name>" ignored`). Deux plugins
installes de MEME nom : un seul module de hooks charge. Un bug ouvert
(`anthropics/claude-code#72369`) pretend l'inverse : NON mesure sur 2.1.303.
MESURE locale : `grep -c readable-layout ~/.claude/plugins/installed_plugins.json`
-> `0`, aucune entree dans `enabledPlugins`, `~/.claude/dev-mods/*` vides : aucune
copie globale aujourd'hui. Cout d'une mesure vivante : 2 plugins jetables + une
installation marketplace (modifie `~/.claude/plugins`, accord de l'operateur) +
une session PTY, ~45 min de developer. NON faite. Conception immune au resultat :
nom unique `kory-readable-layout`, donc le mod tiers installe en meme temps n'est
pas remplace ; ordre de chaine entre deux plugins qui accrochent le meme
composant NON mesure (SUPPOSE : le premier charge repond). Pire cas : le mod tiers
dessine ses boites `round` -> `modal`, echec FERME, bruyant, jamais dangereux.
README + critere du lot 4 : un seul des deux actif.

**Message de limite.** NON mesure. `claude-code.d.ts` (`RenderComponent`, ligne
9771) ne liste aucun composant d'erreur d'API : impossible de savoir statiquement
s'il passe par `AssistantMessage`. Cout : un developer, ~1 h : transcript JSONL
synthetique portant une ligne d'erreur d'API, `claude --resume` dans un PTY avec un
plugin de sonde qui ecrit `e.component` et `e.props.text`. Consomme 0 quota SI la
CLI rejoue ces lignes (SUPPOSE) ; sinon la seule voie est un epuisement reel,
exclu. La conception ne depend pas du resultat (`mustStayStock`), l'ACTIVATION
(lot 4) en depend : a faire au lot 2.

## 7. Lots 2 a 4 et ce que 574feb89 exige du lot 1

| Lot | Contenu | Depend de |
|---|---|---|
| 2 | Corpus de captures PTY reelles, verdicts dans `_fixture-verdicts.ts`, sonde du message de limite, sonde « deux copies » | 1 |
| 3 | Distribution Deck, defaut DESACTIVE : 3e `--plugin-dir` (`pluginDirsForTile`, `session-command.ts:117-126`, nom dans une constante `DECK_*_DIRNAME`), entree `extraResources` + `tests/desktop-electron-builder-resources.test.ts`, `labels` pose depuis la locale, reglage operateur | 1 (peut chevaucher 2) |
| 4 | Revue visuelle (`DESIGN.md`, marges), validation de l'operateur en tuile, activation par defaut | 2 et 3 |
| 574feb89 | Distinction tour final / intermediaire | 4 (V1 observee) |

**Contraintes de sandbox decouvertes pour le lot 3 (DEDUIT).**
`rewritePluginDirForContainer` (`sandbox-command.ts:167-169`) utilise une regex SANS
drapeau `g` : seul le PREMIER `--plugin-dir "..."` est reecrit vers le chemin du
conteneur ; un troisieme garde son chemin hote, invisible dans le conteneur, et le
plugin ne charge pas, sans erreur (la fonction le dit : « the plugin would fail to
load silently »). Le plugin de role est deja omis en bac a sable
(`rolePluginOmitted`, `session-command.ts:124`). Le lot 3 choisit : projeter la copie
(arbre minuscule, sans `node_modules`) ou omettre comme le plugin de role, et rend
la reecriture multi-dossiers avec un test qui la mord.

**Ce que 574feb89 exige du lot 1 pour ne pas le refaire :**
1. `classifyAssistant($, e): Promise<BlockKind>` dans `register.tsx`, ASYNCHRONE des
   le lot 1, qui appelle aujourd'hui la partie synchrone de `layout.ts`.
   574feb89 remplace son corps (lecture de `$.state`, evenements `turn.start`,
   `turn.step`, `turn.complete` et `$.ui.invalidate`, existent dans les types :
   `claude-code.d.ts:4561-4582`, `:2393`) sans toucher au dessin ni aux versions.
2. `BlockKind = 'frame' | 'dim' | 'stock'` ferme, `switch` exhaustif au dessin.
3. `dim` accepte un corps `Markdown` (pas seulement le texte d'un resume).
4. `MIN_SUPPORTED` a capacites : 574feb89 ajoute `finalTurn`, avec un minimum
   valide par ses propres captures de repeinture.
5. Le harnais 6.2 est parametre par composant : il sert tel quel.
6. Le rig de capture du lot 2 doit pouvoir enregistrer DANS LE TEMPS (repeintures
   d'une meme ligne), faute de quoi 574feb89 devra le reecrire.
7. `types/index.d.ts` (`$.state`) n'existe PAS au lot 1 : 574feb89 le cree, avec la
   cle `types` dans `plugin.json`.

## 8. Hors perimetre du lot 1

Aucun cablage Deck, `electron-builder`, sandbox, `index.ts`, `session-command.ts` ;
aucune entree d'oracle ; aucune coloration du gras ; aucune logique de tour final ;
aucune modification de `xterm-screen.ts`, `screen-model*`, `quota.ts`, `attention*`,
`detect/*`.

## 9. Entrees hostiles (CLAUDE.md, « Five hostile inputs »)

Aucune nouvelle. Le texte rendu (modele, utilisateur) est un enfant de `Text` /
`Markdown`, que le moteur valide comme texte imprimable ; les libelles viennent
d'une table figee ; `userConfig.labels` est borne par `options` et retombe sur
`en`. Le paquet n'accepte aucun chemin, aucune commande, aucune URL. Il n'est pas
lisible depuis un depot clone : le Deck le charge depuis ses ressources.

## 10. Questions ouvertes

1. Defaut de `labels` : `en` (portable) recommande ; `fr` si l'operateur veut
   « Vous » des le lot 1 sans reglage.
2. Toast unique a version non supportee : garde (recommande) ou ligne de debug
   seule ?
3. Licence : ecrire depuis ce contrat (recommande) ou reprendre du code du mod
   MIT et en porter la notice.
