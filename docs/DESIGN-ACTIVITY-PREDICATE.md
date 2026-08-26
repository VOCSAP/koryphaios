# Arbitrage : le predicat d'activite lit-il le CONTENU du titre OSC 0, ou sa FREQUENCE ?

## Statut

Arbitrage rendu le 2026-08-26 par l'architecte, a la demande du team-lead,
sur le point laisse explicitement NON TRANCHE par la note de correspondance
deposee sur la carte `f8082208` le meme jour ("Ne pas concevoir sur le contenu
du titre avant qu'il soit rendu").

Ce document TRANCHE et remplace ce point d'attente. Il ne reouvre ni
`DESIGN-NOTIFY-EVENTS.md` (ferme le 2026-08-19) ni les six chantiers de
`DESIGN-HERDR-ADOPTION.md` : il resout la contradiction apparente entre eux.

Etiquettes : **MESURE** (commande executee, sortie citee), **DEDUIT** (lu dans
le code, chemin + symbole), **SUPPOSE** (non verifie).

**Verdict en une ligne : la FREQUENCE decide, le CONTENU decore.**

---

## 1. Ce que la contradiction cachait

**DEDUIT** (`docs/DESIGN-HERDR-ADOPTION.md`, section 1, puce "OSC comme signal
prioritaire") -- herdr classe par CONTENU seul : son entree de moteur est un
triplet `{ screen, osc_title, osc_progress }`, trois chaines, aucun horodatage
ni compteur.

**DEDUIT** (`docs/DESIGN-NOTIFY-EVENTS.md`, section 6.2) -- ce depot avait deja
ecrit la regle inverse : "Ne rien fonder sur l'identite du glyphe, qui changera
comme `esc to interrupt` ; fonder le predicat sur la frequence d'emission."

Les deux documents ne parlaient pas du meme decoupage, et c'est la source de la
contradiction : herdr classe en `working` / `blocked` / `idle` avec UN seul
moteur ; `DESIGN-NOTIFY-EVENTS.md` section 6.6 a etabli que ces trois classes
ont ici DEUX capteurs mecaniques disjoints (OSC 777 leve `blocked`, la
frequence d'OSC 0 separe `working` du reste), et que la partie textuelle ne
conditionne rien. La question posee -- contenu ou frequence -- ne porte donc
que sur la separation `working` / `pas working`.

---

## 2. Mesure nouvelle : ce que le titre contient reellement

Aucune des deux campagnes n'avait inventorie le CONTENU des titres : la sonde
du 2026-08-19 "compte les EMISSIONS et ne lit jamais le glyphe"
(`DESIGN-NOTIFY-EVENTS.md` section 6.6), et le rejeu du 2026-08-26 mesurait le
predicat textuel `BUSY_RE`, pas le titre. Je l'ai fait, sur les fixtures PTY
reelles deja versionnees, sans toucher au CLI vivant.

**MESURE** (2026-08-26) -- commande :

```sh
cd tests/pty-harness/fixtures && for f in *.json; do echo "=== $f ==="; \
  sed 's/},{/}\n{/g' "$f" | grep -o '"t":[0-9]*,"data".*' | grep 'u001b\]0;' \
  | sed 's/,"data".*\(u001b\]0;[^\\]*\).*/ TITLE=[\1]/' | sed 's/u001b\]0;//'; done
```

Sortie, sur les 7 fixtures (`turn-chunks-inherited-env.json`, tour complet) :

```
"t":297   TITLE=[claude]
"t":1487  TITLE=[✳ Claude Code]
"t":11051 TITLE=[◐ Claude Code]
"t":12015 TITLE=[◑ Claude Code]
...alternance ◐/◑ toutes les ~960 ms...
"t":16776 TITLE=[✳ Claude Code]
"t":17769 TITLE=[✳ Compter lentement de 1 a 30]
```

Quatre faits, tous **MESURE** :

1. **Le titre porte bien une animation de travail** : `◐`/`◑` (demi-cercles),
   presents uniquement dans la fenetre du tour. Densite de chunks par seconde
   sur la meme fixture : rien entre 7 s et 10 s, puis 15 a 22 chunks/s de 11 s
   a 16 s. La fenetre `◐/◑` [11051, 16819] coincide avec la fenetre d'activite
   reelle. Le CONTENU n'est donc PAS mort : herdr a raison sur ce point precis,
   et la regle `osc_title_working` de son manifest (braille **ou**
   demi-cercles) matcherait notre CLI.
2. **Le glyphe de repos `✳` est emis dans TOUTES les classes** : au repos a
   l'invite (`prompt-idle-with-esc`, t=755), a l'ouverture d'un dialogue
   (`dialog-open-no-esc`, t=8543), avec une saisie en cours
   (`draft-typed-with-esc`, t=771), dans le menu slash
   (`slash-menu-with-esc`, t=769), au demarrage (t=1487) ET en fin de tour
   (t=16776). Il confirme la mesure du 2026-08-19 : `absence de spinner`
   n'arbitre pas `idle` contre `blocked`.
3. **Le vocabulaire de glyphes a DEJA derive, et la derive a deja tue un
   predicat ici** : `desktop/src/main/thinking.ts` cherche du braille
   (`BUSY_RE = /esc to interrupt|[⠀-⣿]/i`), le titre emet des demi-cercles, et
   l'ecran de la meme fixture emet des `✳` et voisins (mesure du team-lead du
   2026-08-26, carte `fda382b3`). Trois vocabulaires distincts pour un meme
   etat, sur une meme version. Le manifest de herdr accumule d'ailleurs deux
   generations dans une seule regle, ce qui est la signature d'une regle qui
   meurt a chaque nouvelle generation jusqu'a ce que quelqu'un la rattrape.
4. **Fait nouveau, non porte par les cartes** : une emission ISOLEE de `✳`
   accompagne chaque changement d'etat d'interface (ouverture de dialogue,
   frappe, menu). Un predicat de pure recence a 3 s allume donc "working"
   pendant au plus 3 s a chacun de ces gestes. Ce n'est pas contradictoire avec
   M1a/M1b (0 emission sur 190 s et sur 45 s de repos avec repeinture) : ces
   emissions sont evenementielles, pas periodiques.

Reserve **MESURE** : les fixtures portent `v2.1.229` en clair dans leur banniere
de demarrage ; le CLI installe est `2.1.246`. Ces chiffres sont donc un
MINORANT, exactement comme le disait la carte `fda382b3`.

---

## 3. (a) Verdict

### La FREQUENCE est l'autorite. Le CONTENU ne decide de rien.

La force qui tranche n'est pas la qualite du signal aujourd'hui -- sur la
version mesuree, le contenu est STRICTEMENT PLUS RICHE que la frequence : il
distingue `working` de `pas working` avec une latence d'extinction nulle (le
`✳` de fin de tour arrive a t=16776, la ou la frequence devra attendre 3 s de
plus), et il ne produit pas le faux positif du point 2.4.

La force qui tranche est le MODE DE MORT, et il est asymetrique au point d'etre
decisif :

| | Capteur de CONTENU | Capteur de FREQUENCE |
|---|---|---|
| Mort par changement de vocabulaire du CLI | totale, **silencieuse**, aucun test rouge | impossible : ne lit pas le glyphe |
| Mort par changement de cadence | insensible | **visible** : les deux classes se rapprochent, le badge scintille |
| Mort par arret complet des emissions | totale, silencieuse | totale, silencieuse (voir la garde en section 6) |
| Precedents payes dans ce depot | trois (`BUSY_RE`, `detectWaiting`, quota) | zero |

Un predicat qui meurt en rendant `false` pour toujours est exactement la forme
de defaillance que CLAUDE.md nomme fail-open silencieux, et ce depot l'a payee
trois fois sur ce meme chemin PTY. Un taux qui derive produit un symptome que
l'operateur voit le jour meme. C'est le critere, et il est deja inscrit dans
`DESIGN-NOTIFY-EVENTS.md` section 6.2 : ce document ne fait que le confirmer
avec la mesure de contenu qui manquait.

### Ce que le CONTENU garde, et ce qu'il ne garde pas

Il garde trois roles, tous fail-safe, aucun n'est une decision :

1. **Etiquette d'affichage.** Le titre porte le LIBELLE DE LA TACHE en clair
   (`✳ Compter lentement de 1 a 30`, **MESURE** ci-dessus). C'est la meilleure
   source connue pour repondre a "que fait cet agent" sur une tuile, et elle est
   gratuite : le parseur la retient deja. Sa mort ne coute qu'un sous-titre
   vide.
2. **Suppresseur du faux positif de 2.4, optionnel.** Une emission isolee dont
   le titre est la forme au repos peut ne pas armer l'etat `working`. Si le
   glyphe change, le suppresseur cesse simplement d'agir et on retombe sur le
   verdict mecanique : degradation VERS le capteur robuste, jamais vers un etat
   invente. C'est la seule direction dans laquelle du contenu est admissible.
3. **Detecteur de derive, recommande.** Compter les desaccords ("le contenu dit
   au-repos alors que la frequence dit working", et l'inverse) et journaliser
   au-dela d'un seuil. C'est ce qui rend VISIBLE la mort du vocabulaire de
   glyphes, et c'est la reponse directe a la regle de couverture : on n'utilise
   pas le capteur perissable pour decider, on s'en sert comme temoin.

Il ne garde PAS : l'arbitrage `idle` contre `blocked` (c'est OSC 777, section
6.6 de `DESIGN-NOTIFY-EVENTS.md`), ni aucun role de haut rang dans un futur
moteur H1 pour l'agent-kind claude.

### Ce que cela impose a H1 (manifests)

**Non refute mais recadre.** Pour les agent-kinds SANS OSC 777 ni cadence
mesuree, le grattage de contenu reste le seul capteur disponible (section 2
bis.2 du brief herdr) et le portage des manifests garde tout son sens. Ce
verdict porte sur l'agent-kind CLAUDE, ou nous disposons de deux capteurs
mecaniques que herdr n'a pas. La consequence pour H1 est que son moteur doit
porter la CONFIANCE du capteur par regle, pas seulement sa priorite -- ce que
la section 2 bis.2 exigeait deja.

---

## 4. (b) Ou vit le producteur, et par quel canal il atteint le renderer

### Le capteur existe deja et n'a pas besoin d'etre reecrit

**DEDUIT** -- `desktop/src/main/detect/osc.ts`, `createOscParser`, est pur,
instancie par session dans une `Map`, et son en-tete inscrit deja la bonne
frontiere : "FREQUENCY DOES NOT ENTER THIS MODULE... The activity predicate
built on OSC 0's emission cadence lives entirely with the caller."
`session-service.ts` le nourrit deja a chaque chunk, a cote des quatre
detecteurs (`oscParserFor(e.id).feed(e.data)` dans le handler `pty.on('data')`).

**MESURE** -- `grep -rn "oscSnapshot\|detect/osc" src/ ../tests/` : quatre
occurrences dans `session-service.ts` (import, commentaire, `oscSnapshot(id)`,
`oscParserFor`) et le fichier de test. Aucun consommateur de production, ce que
la carte `fda382b3` avait deja mesure.

### Un manque a combler dans osc.ts : le compteur d'emissions

`OscSnapshot` porte `title | progress | notify`, tous des DERNIERES VALEURS. Un
appelant ne peut pas distinguer "un titre vient d'etre peint" de "le meme titre
est toujours le dernier vu" : sur l'alternance `◐`/`◑` il s'en sortirait par
comparaison de chaine, mais une salve de six emissions IDENTIQUES (le cas M4
mesure, celui de l'extinction sur front) serait vue comme UNE.

**Ajout minimal recommande** : un champ `titleSeq: number`, compteur monotone
des applications d'OSC 0/2. Sans horloge, sans taux, sans glyphe : le contrat
"la frequence n'entre pas dans ce module" est preserve, le module ne fait que
compter ce qu'il a extrait.

Alternative ecartee : faire rendre a `feed()` un booleen "un titre est arrive
dans CE chunk". Rejetee parce que `oscSnapshot(id)` lit l'etat par
`feed('')` (**DEDUIT**, `session-service.ts`, `oscSnapshot`), donc le booleen y
serait toujours faux et le sens de la valeur dependrait du site d'appel. Un
compteur se lit identiquement des deux cotes.

### Le producteur d'etat : un module pur a horloge injectee

Nouveau fichier `desktop/src/main/detect/activity.ts`, meme discipline que ses
voisins (aucun import electron/node-pty, testable sous bun) :

```
createActivityTracker({ idleMs, now, setTimer, clearTimer })
  -> { observe(seq: number): void, state(): Activity, on(cb): void }
```

Forme deja eprouvee : `ThinkingDetector` (`desktop/src/main/thinking.ts`) est
EXACTEMENT cette machine -- etat par session, timer d'oisivete re-arme a chaque
signal, emission sur TRANSITION seulement. **DEDUIT** : seul son predicat
d'admission (`BUSY_RE.test(stripAnsi(data))`) est mort ; sa mecanique est
saine et son handler cote `session-service.ts` ecrit `r.thinking` puis
`broadcast()`. Le travail n'est donc pas d'inventer une machine, c'est de
changer sa SOURCE et de rendre son horloge injectable (section 7).

Deux differences obligatoires avec l'existant :

- `idleMs` passe de 1500 a **3000**, la constante deja retenue par
  `DESIGN-NOTIFY-EVENTS.md` section 6.6 et deliberement identique a celle de la
  recence d'octets. Ne pas en introduire une troisieme.
- l'etat rendu est **TERNAIRE**, voir section 6 : `'working' | 'idle' |
  'unknown'`. Un booleen est ce qui rend silencieuse la degradation par
  croissance du domaine.

### Le canal vers le renderer : aucun canal nouveau

**DEDUIT** (chaine verifiee de bout en bout par le team-lead le 2026-08-26,
carte `fda382b3`, et retrouvee dans le code) : handler `on('thinking')` ->
`r.thinking` + `broadcast()` -> `emit('changed')` -> `ipc.ts` diffuse
`sessions:changed` -> preload `onSessionsChanged` -> `store.ts` ->
`TerminalTile.tsx` / `Sidebar.tsx`. Le cablage est VIVANT ; c'est la source qui
n'emettait rien. Reutiliser ce canal, et ne pas en ouvrir un second.

Le passage de `thinking: boolean` a un champ ternaire est un changement de
contrat sur `SessionRuntime` et sur la projection `deck-control.ts` : il touche
les memes sites, dans le meme lot, et c'est precisement pour cela qu'il doit
etre fait maintenant plutot qu'apres.

---

## 5. (c) Table des consommateurs

| Consommateur | Chemin + symbole | Branche ? | Raison |
|---|---|---|---|
| Point d'etat de la tuile et de la barre laterale | `TerminalTile.tsx`, `Sidebar.tsx` (classe `dot-thinking`) | **OUI** | c'est la question "l'agent produit-il" |
| Marque `done` vu/pas-vu (H6) | carte `fda382b3`, store renderer | **OUI**, sur la transition `working -> idle` | c'est son prerequis declare, et il est debloque par ce verdict |
| Extinction mecanique E2 de l'episode de quota | carte `f8082208` | **OUI, mais sur FRONT** : `titleSeq` a augmente depuis la levee. Jamais sur `state() === 'idle'` | M4 mesure une salve de six emissions puis le silence : un extincteur a niveau la rate |
| Compte d'occupation de l'arret de flotte | `ipc.ts`, canal `agents:stop-state` | **OUI** | meme question ; doit compter `unknown` a part, jamais comme `idle` |
| Projection vers le bridge MCP superviseur | `deck-control.ts`, champ `thinking` | **OUI** | meme question, mais changement de contrat visible par des agents tiers : a annoncer, pas a glisser |
| Levee d'un niveau A (bloque) | decideur de notifications, `63d73bde` | **NON** | la levee vient d'OSC 777 et de lui seul (section 6.6) |
| `waitIdle` | `session-service.ts`, `waitIdle`, appele par `injectCommand` | **NON -- EXCLU EXPLICITEMENT** | voir ci-dessous |
| `autoResume`, `interrupt`, verdict d'approbation (`buildKeystrokes`) | `session-service.ts`, `index.ts` | **NON** | ce sont des ECRIVAINS : meme exclusion que `waitIdle` |

### Pourquoi `waitIdle` est exclu, et ce qu'il faut faire a la place

**MESURE** reprise de la campagne (M3, 2026-08-19) : 20 759 ms de frappe non
soumise, 41 caracteres tapes puis effaces, **0 emission OSC 0**, alors que 731
octets d'echo circulaient sur 51 evenements.

`waitIdle` ne pose pas la question "l'agent produit-il", il pose "puis-je
ecrire dans ce pty maintenant". Le brancher sur OSC 0 le ferait repondre OUI
precisement pendant que l'operateur tape : une injection ecraserait une frappe
humaine en cours, sans erreur ni trace. Degradation OUVERTE, la forme la plus
chere de ce depot.

**Piege a nommer, parce qu'il est contre-intuitif.** Aujourd'hui `waitIdle`
rend `true` immediatement et toujours (**DEDUIT** : `r.thinking` est constant a
faux, mesure du 2026-08-26). Donner un producteur vivant a ce champ SANS
repointer `waitIdle` ne le laisse pas en l'etat : cela le fait passer de
"toujours ouvert" a "ouvert exactement quand l'operateur tape". Le compteur de
defauts baisse, le defaut devient intermittent et non reproductible, et il
prend l'apparence d'une reparation. **Le lot qui donne une source vivante au
champ DOIT repointer `waitIdle` dans le meme commit**, sinon il aggrave la
lisibilite du bug qu'il n'a pas corrige.

Repointage recommande dans ce meme lot, a titre conservatoire : recence
d'octets (`lastOutputAt`, deja presente, seuil 3 s), dont l'artefact d'echo est
la BONNE reponse a cette question-la (mesure du 2026-08-17, carte `8691dea3`).
La reparation de fond reste un VERROU du main process, elle appartient a
`8691dea3` et n'est pas un predicat.

**Consequence de nommage, non negociable.** `DESIGN-NOTIFY-EVENTS.md` section
6.2 impose "un seul predicat d'activite". La regle vaut PAR QUESTION : le
second signal ne doit jamais s'appeler activite, occupation ou `busy`, sous
peine d'etre reutilise a tort au premier refactor. Le nommer d'apres sa
question (`ptyQuietFor`, `writeGate`, `pendingWriteLock`), jamais d'apres son
mecanisme.

---

## 6. (d) Audit de couverture

Regle CLAUDE.md : un mecanisme qui DECIDE doit voir sa couverture auditee, pas
seulement sa sensibilite. Deux moities.

### Moitie 1 : quelle degradation rend le domaine plus PETIT, sans erreur ni rouge ?

| Degradation | Effet | Silencieuse ? | Garde |
|---|---|---|---|
| Le CLI change son glyphe de titre | **aucun** sur le predicat | -- | c'est precisement le gain du verdict |
| Le CLI ralentit sa cadence au-dela de 3 s | scintillement `working`/`idle` pendant un tour | **non** : symptome visible le jour meme | re-mesurer le seuil au bump de CLI |
| Le CLI **cesse** d'emettre OSC 0 | le predicat rend `idle` pour toujours | **OUI, totale** | c'est le seul trou serieux du verdict, garde ci-dessous |
| `osc.ts` reste bloque en etat OSC (carte `5b324e11`) | plus aucun titre applique, donc plus aucune emission comptee | **OUI** | meme garde ; et cette carte doit passer AVANT ou AVEC le consommateur, comme son propre sequencement l'exige |
| Le parseur n'est pas nourri de TOUS les chunks (echantillonnage, coalescence, poll) | une machine incrementale sous-echantillonnee n'est plus incrementale | **OUI** | nourrir depuis le MEME site d'appel que les autres detecteurs, une seule fois par chunk ; interdit de rebrancher via un poll |

**Garde exigee pour la seule degradation silencieuse** : une sonde de vraisemblance
cote main. Si une session a produit plus de N kilooctets de sortie sur une
fenetre glissante et **zero** emission OSC 0 sur la meme fenetre, journaliser un
avertissement (`reportError`/journal, pas `console.error`) et faire passer la
session en `unknown`, jamais en `idle`. C'est le controle negatif permanent qui
manquait a `BUSY_RE` et qui aurait fait parler sa mort en 2026-08-11 au lieu de
2026-08-26.

### Moitie 2 : quelle croissance du DOMAINE produit le meme effet, capteur inchange ?

C'est la moitie la plus probable, et elle est structurelle : **un agent-kind qui
ne peint pas de titre**. Codex, Gemini, Cursor, un shell nu, une session
sandbox : rien ne garantit qu'ils emettent OSC 0, et **rien n'a ete mesure**
(SUPPOSE, explicitement). Avec un champ booleen, ces sessions rendent `false` =
`idle` en permanence : le badge n'apparait jamais, H6 ne marque jamais rien,
le compte d'arret de flotte les oublie. Aucune erreur, aucun rouge, domaine
silencieusement retreci -- exactement le defaut d'aujourd'hui, deplace d'un
cran.

**C'est cela qui impose l'etat TERNAIRE.** `unknown` doit etre l'etat par
defaut d'une session dont l'agent-kind n'a pas de cadence mesuree, et il doit
etre RENDU comme tel. Le boolean n'est pas une simplification, c'est le
mecanisme qui rend cette degradation invisible.

Corollaire sur les consommateurs : chacun doit statuer sur `unknown`
explicitement. Un affichage l'affiche (un point neutre, pas le point d'idle).
Le compte d'arret de flotte le compte a part. H6 ne pose pas de marque `done`
sur une transition qui part de `unknown`. Une garde d'ecriture le traite comme
occupe, par conservatisme.

Corollaire sur l'asymetrie deja documentee dans
`desktop/src/main/attention.ts` (`detectWaiting` vs `stillWaiting`, "lever et
eteindre sont des decisions opposees sous incertitude") : la reprendre telle
quelle. Sous incertitude, on peut refuser d'ecrire ; on ne doit jamais EFFACER
un etat que l'operateur attend.

---

## 7. (e) Comment le cablage sera prouve

Regle CLAUDE.md : extraire dans un module pur rend le SITE D'APPEL invisible
aux tests, et la mesure du 2026-08-26 donne le chiffre (12 mutations de cablage
sur 13 restaient vertes apres extraction). Le capteur est deja pur et deja
branche sur rien : c'est exactement l'etat ou le trou est maximal.

Par puissance decroissante, ce que le lot doit livrer :

1. **Injection de dependances, c'est-a-dire la seule qui ferme par
   construction.** `createActivityTracker` recoit `now` et ses primitives de
   timer. Le cablage lui-meme devient pur et executable : on peut rejouer une
   trace horodatee sans horloge reelle, donc les timers, l'annulation et les
   chemins alternatifs cessent d'etre un residu suppose.
2. **Sonde comportementale sur une fixture REELLE, qui est le critere
   d'acceptation.** Rejouer `tests/pty-harness/fixtures/turn-chunks-inherited-env.json`
   avec ses horodatages enregistres, dans le vrai chemin de traitement de
   chunk, horloge simulee, et exiger la SEQUENCE : `unknown` avant t=297,
   `working` a t=297 (le titre isole n'est pas supprime, section 2.4 :
   suppresseur optionnel, hors perimetre), `idle` a t=4487 (le vrai creux
   entre les deux titres isoles et l'alternance soutenue), `working` a
   partir de t=11051. CORRIGE 2026-08-26 par le lot d'implementation
   (`spec_1449bb52`), qui a mesure une DIXIEME emission de titre a t=17769
   ("Compter lentement de 1 a 30", 993ms apres 16776, donc a l'interieur de
   la meme cadence soutenue) absente de l'illustration ci-dessus : elle
   reporte l'extinction a t=17769+3000=20769, apres le dernier octet capture
   par la fixture (t=19879). La sequence reste `working` jusqu'a la fin de
   la fenetre capturee ; l'extinction n'est prouvee qu'en extrapolant
   l'horloge simulee au-dela (`tests/desktop-activity.test.ts`). Les deux
   fixtures de tour sont deja au depot ; il n'y a pas de capture a refaire.
3. **Controle negatif, et il doit SHIPPER dans le commit.** La meme sonde
   nourrie d'un flux sans aucun OSC 0 (par exemple une fixture filtree, ou le
   retour a l'ancien producteur `BUSY_RE`) doit ROUGIR. Une sonde mesuree rouge
   en session puis laissee hors du diff n'est pas une garde : rien ne la
   rejouera. C'est la clause explicite de la carte `8691dea3`.
4. **Batterie de mutations a passer en revue**, chacune devant produire au
   moins un rouge : intervertir les deux arguments du site d'appel ; jeter le
   retour de `feed` ; supprimer le re-armement du timer ; inverser la
   comparaison de seuil ; remplacer `3000` par un litteral different ; nourrir
   le parseur un chunk sur deux (le cas sous-echantillonnage) ; deplacer
   l'appel apres le `return` d'une branche du handler.
5. **Scan de source explicitement REFUSE comme preuve.** Un
   `toContain("oscParserFor(")` passe quand l'appel existe mais que son
   resultat est jete, et quand un argument est remplace par un litteral. La
   presence n'est pas un contrat. Le depot en a la mesure ; ne pas la
   reapprendre.

Point de vigilance particulier a ce lot : le nouveau champ ternaire est lu par
`deck-control.ts`, donc par des agents MCP hors du depot. Le test de surface
correspondant doit constater le changement de contrat, pas l'absorber.

---

## 8. (f) Ce que je n'ai PAS tranche

1. **Le comportement du CLI 2.1.246.** Les fixtures portent `v2.1.229`, la
   campagne `2.1.233`/`2.1.235`. Je n'ai PAS mesure le CLI installe. Cela ne
   bloque pas l'arbitrage, et c'est un point que je defends plutot que je ne
   l'excuse : une mesure fraiche ne pourrait deplacer que le SEUIL NUMERIQUE,
   jamais le choix du capteur, puisque le choix repose sur le mode de mort et
   non sur les chiffres. En revanche, le seuil de 3 s doit etre re-mesure au
   prochain bump, et la garde de la section 6 existe justement pour que
   personne n'ait a y penser.
2. **La couverture des agent-kinds non-claude.** Aucune mesure d'OSC 0 pour
   codex, gemini, cursor, un shell nu ou une session sandbox. C'est SUPPOSE de
   bout en bout, et c'est la raison de l'etat `unknown`. Leur entree dans le
   predicat est hors perimetre de ce document.
3. **OSC 9;4 (progress).** Zero mesure locale (section 2 bis.1 du brief herdr).
   Je ne le fais entrer nulle part.
4. **Le rendu visuel de `unknown`.** Choix de `DESIGN.md` et du skill
   `deck-design`, pas le mien. Contrainte que je pose : il doit etre
   distinguable d'`idle`, sinon la moitie 2 de l'audit de couverture est
   annulee a l'ecran.
5. **Le detecteur de derive de la section 3.3.** Je le recommande, je ne le
   rends pas obligatoire : c'est un temoin, pas une garde, et son cout n'a pas
   ete estime.
6. **Le verrou d'ecriture du main process.** Il appartient a `8691dea3` (et sa
   forme au dossier `DESIGN-QUEUE-WRITE-AUTHORITY.md`). Je ne fais qu'exclure
   `waitIdle` du predicat et poser le repointage conservatoire.
7. **L'etat exact de la carte `5b324e11`.** `osc.ts` accepte desormais le ST 8
   bits et remet son drapeau de plafonnement, ce qui ressemble a la correction
   demandee (**DEDUIT**, lecture de `osc.ts`, constante `ST_8BIT` et
   reinitialisation de `capped`). Je n'ai PAS verifie que les deux consequences
   mesurees par la carte ont disparu. A confirmer avant de brancher le
   consommateur, comme le sequencement de la carte l'exige.

---

## Cartes que ce document alimente

`f8082208` (badge de quota decouple, extinction E2 sur front), `fda382b3` (H6,
debloquee par ce verdict), `8691dea3` (`waitIdle` exclu, repointage
conservatoire), `5b324e11` (a passer avant ou avec le consommateur),
`1aa69066` (ajout de `titleSeq` a `osc.ts`), et le chantier H1 de
`docs/DESIGN-HERDR-ADOPTION.md` (recadre, non refute).
