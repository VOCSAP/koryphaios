# Brief — ce que Kory peut reprendre d'orca et de doop (fonctionnalité design)

Analyse comparative de [stablyai/orca](https://github.com/stablyai/orca)
(commit `6989c92b`, licence MIT) et [kgoedecke/doop](https://github.com/kgoedecke/doop)
(commit `5567f17`, licence **AGPL-3.0**), centrée sur la fonctionnalité design.
Même format que `DESIGN-HERDR-ADOPTION.md` : chaque chantier cite les mécanismes
sources et les fichiers Kory cibles, pour pouvoir démarrer sans refaire l'analyse.
Base : branche `experimental` (`518fe99`).

> Convention CLAUDE.md : les ids `OD1`…`OD7` servent à ce brief et aux messages
> de commit/cartes roadmap. Ne pas les recopier en tag dans des commentaires de
> code.

**Licences — à lire avant tout chantier.** Orca est MIT : idées ET code
adaptables. Doop est AGPL-3.0 : les **idées** sont libres, mais recopier du code
contaminerait le projet — tout chantier `doop` ci-dessous se réimplémente de
zéro à partir de l'intention.

## 1. Les deux repos en une page

**Orca** est un concurrent frontal du Deck : orchestrateur Electron multi-agents
(Codex, Claude Code, OpenCode), worktrees parallèles, terminaux splittés,
compagnon mobile, GitHub/Linear natifs. Sa fonctionnalité « Design Mode » est
l'homologue exact de notre element picker : cliquer un élément dans un Chromium
embarqué et envoyer HTML, CSS et screenshot croppé dans le prompt de l'agent.
Même architecture que nous (overlay injecté côté guest, description collée dans
le prompt, jamais d'auto-submit) — la comparaison est donc directe, mécanisme
par mécanisme, et c'est là que se trouvent les reprises les plus concrètes.

**Doop** est autre chose : un clone open source de Paper.design — canvas de
design **multijoueur** où humains et agents travaillent côte à côte. Les agents
s'y connectent par MCP et *streament* du HTML dans des frames (iframes
sandboxées) pendant que les humains regardent, éditent, commentent. Le sens du
flux est inversé par rapport à notre boucle : chez nous le browser sert à
donner du feedback humain→agent sur une app existante ; chez doop l'agent
produit le design DANS un espace que l'humain manipule. On n'adopte pas le
produit ; on adopte des intentions de pilotage d'agent (self-review obligatoire,
mémoire de design distillée, feedback pull-based) qui s'appliquent telles
quelles à notre demo driver et à notre boucle design.

## 2. Où en est Kory (baseline)

La boucle design d'`experimental` (`desktop/docs/browser-design.md`) : browser
embarqué + dock terminal, element picker `⌖`, presets viewport, draw mode `✏` +
screenshot composité, window mirror, REC + scénario démo (`demo_*` MCP,
`demo-control.ts`), design endpoint loopback pour apps externes
(`design-endpoint.ts`, `deck-design.js`).

Le payload d'un pick (`ElementPick`, `desktop/src/shared/types.ts:1014`) est
minimal : tag, id, classes, texte, sélecteurs candidats (QA-attrs d'abord,
`element-pick.ts`), taille, URL. C'est précisément l'écart principal avec orca.

## 3. Orca — le « grab », mécanisme par mécanisme

Fichiers source : `src/main/browser/grab-guest-script.ts` (overlay + extraction,
955 l.), `browser-grab-payload.ts` (re-validation main), `browser-grab-screenshot.ts`
(crop), `browser-grab-session-controller.ts` (cycle de vie),
`src/renderer/.../annotate/` (batch d'annotations, formatage markdown),
`src/shared/browser-grab-types.ts` (budgets, allowlist, patterns secrets).

### 3.1 Un payload riche, pas une description

Là où notre pick dit « tag, taille, sélecteur, texte », le grab d'orca capture :

- **Contexte page** : URL *assainie* (query et fragment supprimés), titre,
  viewport, scroll, devicePixelRatio, horodatage.
- **Cible** : sélecteur CSS minimal-unique, chemin lisible (`#id >
  [aria-label] > .classe`), chemin DOM complet, classes, `isFixed`, texte
  sélectionné le cas échéant, snippet texte (200 c.) et **snippet HTML (4 Ko)**.
- **Accessibilité** : rôle, accessible name, aria-label/labelledby — souvent le
  meilleur identifiant humain d'un élément.
- **~16 styles calculés** (display, position, box, couleurs, border, radius,
  typo, z-index), **filtrés de leurs valeurs par défaut** (`auto`, `normal`,
  `static`, fond transparent) pour ne montrer que ce qui est signifiant.
- **Attributs sur allowlist** (safe names + `aria-*`), valeurs bornées.
- **Contexte spatial** : rects viewport ET page, textes voisins (10×200 c.),
  éléments voisins, chemin d'ancêtres.

L'effet recherché : l'agent n'a plus besoin d'aller « regarder » l'élément — le
prompt contient déjà de quoi localiser le code et comprendre le style en place.

### 3.2 React fiber → fichier source

Le guest script lit les clés `__reactFiber$` de l'élément, remonte la pile de
composants (`<Card> <ProductList> <App>`) et extrait `_debugSource`
(`fileName:lineNumber:columnNumber`) quand le build de dev le fournit. Le prompt
contient alors **`Source: src/components/Card.tsx:42`** — l'agent ouvre
directement le bon fichier au lieu de greper un sélecteur. C'est LE raccourci
qui change la boucle : un pick devient une référence de code, pas une devinette.
(Dégradation propre : `null` hors React ou en build prod.)

### 3.3 Screenshot croppé de l'élément

`capturePage()` + crop au rect du pick, avec deux détails qui valent la
peine : (a) l'overlay de surbrillance est masqué pendant la capture
(try/finally de restauration) pour que le halo n'apparaisse pas sur l'image ;
(b) le facteur d'échelle CSS→bitmap est dérivé **empiriquement**
(`bitmapWidth / window.innerWidth`) au lieu du DPR du display primaire — correct
en multi-écrans à DPI mixtes. Budget dur 2 Mo, au-delà : pas de screenshot
plutôt qu'un payload obèse.

### 3.4 Sécurité en profondeur — la page est un adversaire

Orca traite le payload du guest comme **totalement untrusted** et re-valide
tout côté main (`clampGrabPayload`) : mêmes budgets, même allowlist
d'attributs, même redaction appliqués deux fois, pour qu'un guest compromis ne
puisse rien faire passer. Trois mécanismes précis :

- **Budgets partagés** (`GRAB_BUDGET`) déclarés dans le module shared et
  appliqués guest + main — pas de constante dupliquée qui dérive.
- **Patterns secrets** (`access_token`, `api_key`, `csrf`, `password`,
  `x-amz-`…) : toute valeur qui matche est remplacée par `[redacted]` — y
  compris dans les ids/aria servant aux sélecteurs et dans `sourceFile`.
- **Sanitisation d'URL** : protocoles http(s)/file seulement, query+hash
  supprimés partout (page, href/src/action) — un pick sur une page de callback
  OAuth ne peut pas coller un token dans le prompt d'un agent.

Notre C8 (harnais constant, données encadrées) couvre le sens Deck→page ; orca
couvre le sens page→prompt, qu'on ne borne aujourd'hui que par la taille.

### 3.5 Le mode annotation : du pick unitaire à la revue de design

Deuxième intention du grab (`GrabIntent: 'copy' | 'annotate'`) : au lieu de
coller chaque pick dans le prompt, on épingle jusqu'à 20 éléments, chacun avec
un **commentaire**, un **intent** (`fix | change | question | approve`) et une
**priorité** (`blocking | important | suggestion`), puis on envoie UN message
markdown `## Design Feedback` structuré (URL, viewport, puis une section par
annotation : élément, intent, sélecteur, source, bounds, styles, HTML,
feedback). C'est le passage de « corrige ce bouton » à « voici ma revue de la
page » — un lot de travail cohérent au lieu de dix allers-retours. Détail
d'orfèvre réutilisable : les fences markdown comptent la plus longue run de
backticks du contenu embarqué pour choisir leur marqueur (du HTML contenant
``` ne casse pas le message).

### 3.6 Raccourcis au survol, sans clic

En mode grab armé, `C` copie le contexte de l'élément **survolé** et `S` son
screenshot, sans consommer de clic. Indispensable pour les états qui ne
survivent pas à un clic : menus ouverts, hover states, dropdowns. Notre picker
actuel ne sait capturer que ce qu'on peut cliquer.

### 3.7 Cycle de vie rigoureux

Un seul grab actif par tab (le nouveau remplace l'ancien en préservant
l'overlay déjà armé), annulation sur navigation **main-frame seulement** (les
iframes de pub ne tuent pas le pick), timeout dur 120 s, teardown best-effort,
clic droit → menu d'actions vs clic gauche → action directe. Rien de
spectaculaire, mais c'est la check-list des bugs qu'on aura.

### 3.8 Le reste d'orca (hors périmètre, à noter)

`agent-browser-bridge` (l'agent pilote le browser — notre demo driver couvre
déjà l'intention), screencast CDP, import de cookies des browsers installés,
anti-détection, worktrees parallèles, compagnon mobile. Confirmations de
chemins déjà pris plus que sources d'idées neuves ; l'import de cookies serait
la seule vraie addition si le besoin « tester connecté » émerge.

## 4. Doop — des intentions de pilotage, pas des mécanismes UI

Fichiers source : `server/guide.ts` (playbook agent), `server/distill.ts`
(mémoire distillée), `server/mcp.ts`, README (§ streaming, § feedback).

### 4.1 Self-review obligatoire + nudges dans les résultats d'outils

Le guide de doop impose : après toute création/édition significative, appeler
`get_frame_screenshot` et juger le rendu sur une check-list nommée (fit,
spacing, hiérarchie, contraste, alignement, réalisme du contenu) AVANT de
continuer. Et surtout, le contrat est **rappelé par les résultats d'outils** :
`set_frame_html` répond « tu n'as pas encore VU ton design — screenshotte avant
de passer à autre chose ». Trois couches de pilotage (instructions compactes à
l'initialize → guide profond via un outil `get_guide`, rechargeable après
compaction → nudges dans les results) — la même architecture que nos `demo_*`
pourrait adopter : aujourd'hui notre driver s'arrête quand l'agent *déclare* le
scénario fini, rien ne l'oblige à avoir regardé le résultat.

### 4.2 La mémoire de design distillée

La meilleure idée du repo. Trois étages :

1. **Références épinglées** : l'humain marque des frames « fais comme ça » ;
   l'agent est instruit d'aller lire leur HTML comme ground truth du style.
2. **Décisions capturées** : chaque feedback design adressé (« coins plus
   ronds », « plus de blanc et de bleu ») devient une *décision* datée sur le
   canvas — y compris, sur déclaration de l'agent, le feedback donné en
   conversation, invisible du canvas sinon.
3. **Le distilleur** : un petit modèle (Haiku) généralise chaque décision en
   préférence courte (« make this button blue like the others » → « Prefer blue
   accent buttons ») puis, quand un motif durable se dégage, **propose UNE
   règle** à ajouter au style guide. La proposition reste pending : l'humain
   accepte ou rejette. Le commentaire du code résume l'intention : *« la mémoire
   auto-commitée devient bruyante ; la mémoire curée reste fiable »*. Le juge est
   sémantique, pas un compteur (« never use italics » fait règle à elle seule ;
   « nudge this button left » jamais), et les décisions ne sont consommées que
   quand une règle est proposée — un motif lent garde ses preuves.

Transposé chez nous : les feedbacks design donnés via picker/draw mode/graph
sont exactement des « décisions » ; leur distillation proposerait des règles
pour le `DESIGN.md` du **projet cible** (pas le nôtre) — l'utilisateur qui
corrige trois fois la même chose verrait Kory proposer d'en faire une règle
durable. On a déjà la culture style-guide-as-code ; doop montre comment la
nourrir automatiquement sans la polluer.

### 4.3 Feedback pull-based, réclamé exactement une fois

Les réponses humaines aux tâches d'agents deviennent des **requêtes ouvertes
sur le canvas**, pas du courrier pour un agent précis : le prochain appel
identifié de n'importe quel agent reçoit le bloc `HUMAN FEEDBACK` dans son
résultat d'outil et le réclame (claim unique, l'UI passe de « waiting » à
« picked up by X »). Les sessions d'agents étant éphémères, personne n'attend
personne : la requête attend le prochain vivant. C'est une réponse élégante au
problème qu'on connaît côté claude-peers (messages non lus d'un pair mort) —
l'intention « attacher le feedback au lieu de l'adresser » est réutilisable
pour les cartes roadmap et le supervisor.

### 4.4 Une doctrine de qualité partagée, source unique

`DESIGN_QUALITY` (une direction esthétique par frame, typo contrastée, un
accent, whitespace délibéré, contenu réaliste, anti-clichés IA nommés) est une
constante **partagée verbatim** entre le guide MCP des agents externes et le
system prompt des agents résidents, « so the two cannot drift apart » — le même
réflexe que notre parité i18n test-enforced. Si on écrit un jour une doctrine
design pour nos agents, elle doit vivre en un seul endroit exporté.

### 4.5 Divers notables

Streaming typewriter avec *healing* du HTML partiel (tag ouvert coupé,
`<script>` inachevé supprimé — jamais exécuter du JS à moitié écrit) ;
workflow redesign « audit d'abord, baseline persistée, puis DEUX directions
A/B » ; étiquette multijoueur (ne pas toucher la frame d'un autre sauf demande
humaine). Le premier est hors sujet pour nous (nos tiles sont déjà live) ; les
deux autres feraient de bons skills si la boucle design grossit.

## 5. Ce que les deux confirment de nos choix

- Overlay injecté côté guest + description collée dans le prompt, **jamais
  auto-soumise** (orca, à l'identique).
- Presets viewport avec annotation du contexte dans le prompt (orca :
  `browser-manager-viewport-override`).
- Préférence sélecteurs QA-attrs/`data-testid` (nous) vs id/classes stables +
  `nth-of-type` minimal-unique (orca) : nos deux stratégies se complètent, cf.
  OD1.
- L'agent doit pouvoir « voir » (notre draw mode + `Read` multimodal ; doop
  `get_frame_screenshot` ; orca screenshot croppé).
- Un scénario démo/design piloté par un agent jetable à capacités fermées
  (notre demo driver ; doop encadre pareil par guide + nudges).

## 6. Chantiers proposés

| Id | Chantier | Source | Effort | Impact |
| --- | --- | --- | --- | --- |
| OD1 | Enrichir `ElementPick` : styles calculés filtrés, a11y (rôle, accessible name), attributs allowlist, snippet HTML borné, rects viewport+page, textes voisins | orca §3.1 | M | **Fort** — chaque pick devient auto-suffisant |
| OD2 | Redaction secrets + sanitisation URL dans le payload pick, appliquées guest ET main (budgets partagés dans `shared/`) | orca §3.4 | S | Fort — on colle aujourd'hui des URLs brutes dans les prompts |
| OD3 | React fiber → `Source: fichier:ligne` dans le pick (dev builds, dégradation `null`) | orca §3.2 | S/M | **Fort** — le pick pointe le code |
| OD4 | Screenshot croppé auto de l'élément (overlay masqué pendant capture, échelle empirique, budget dur) | orca §3.3 | M | Moyen — complète draw mode pour le cas « cet élément précis » |
| OD5 | Mode annotation : N picks épinglés avec commentaire + intent + priorité → un message `Design Feedback` unique | orca §3.5 | M/L | Fort — fait passer la boucle du pick unitaire à la revue |
| OD6 | Nudges de self-review dans les résultats `demo_*` (+ hover-shortcuts `C`/`S` du picker, petit et indépendant) | doop §4.1, orca §3.6 | S | Moyen — qualité des démos et des fix design |
| OD7 | Mémoire design distillée : capturer les feedbacks picker/draw comme décisions, distiller en propositions de règles `DESIGN.md` du projet cible, validation humaine obligatoire | doop §4.2 | L | Fort à terme — réimplémentation from scratch (AGPL) |

Ordre suggéré : OD2 (petit, ferme une fuite réelle) → OD1 → OD3 → OD4/OD6 →
OD5 → OD7. OD1–OD5 vivent dans `desktop/src/shared/element-pick.ts`,
`desktop/src/preload/browser-inspect.ts`, `BrowserView.tsx` et un module main
de re-validation à créer ; OD6 dans `demo-driver.ts`/`demo-control.ts` ; OD7
est un chantier à part entière (stockage décisions + juge LLM + UI de
proposition).
