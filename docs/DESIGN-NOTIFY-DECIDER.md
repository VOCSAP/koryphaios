# Le decideur de notifications : frontiere, placement, contrat de types

Conception, 2026-08-19. Carte `63d73bde`. Complement de `DESIGN-NOTIFY-EVENTS.md`
(le MODELE) : ce document-ci porte l'ARBITRE.

Lecture seule sur le code. Aucun code de production ecrit, rien de stage, rien
touche dans `server.ts`.
MESURE (2026-08-20, apres deplacement dans `docs/`) :
`git check-ignore -v docs/DESIGN-NOTIFY-DECIDER.md` -> code de sortie 1, donc
non ignore. Le document vivait a la racine jusqu'au 2026-08-20, precisement
parce que `docs/` etait alors exclu par `.gitignore` (carte `70e29bc6`). Cette
exclusion a ete levee, et `docs/` est desormais l'emplacement voulu pour les
briefs de conception que le code cite par chemin.

---

## 0. Re-balayage des inventaires : trois confirmations, deux divergences

Consigne du team-lead : ne rien prendre pour argent comptant. Voici chaque
commande et son resultat brut.

### 0.1 Les trois appels en ligne : CONFIRME, et sur un perimetre plus large

```
$ grep -rn "new Notification(" desktop/src/
desktop/src/main/index.ts:957:    const n = new Notification({
desktop/src/main/index.ts:1003:  const n = new Notification(
desktop/src/main/index.ts:1160:      const n = new Notification({

$ grep -rn "Notification\." desktop/src/ | grep -v "^desktop/src/renderer"
desktop/src/main/index.ts:954:    if (!Notification.isSupported()) return
desktop/src/main/index.ts:1000:  if (!Notification.isSupported() || batch.length === 0) return
desktop/src/main/index.ts:1157:    if (fresh.length > 0 && Notification.isSupported()) {
```

La carte balayait `desktop/src/main/`. J'ai balaye **tout `desktop/src/`** :
meme compte. Trois emissions, trois gardes `isSupported()` appariees 1 pour 1,
zero emission cote renderer ou preload. **Le compte de la carte tient sur un
domaine plus large que celui ou il a ete etabli**, ce qui est le sens utile de
la verification.

### 0.2 Le gate unique : CONFIRME, et sa chaine complete fait QUATRE points

```
$ grep -n "notify" desktop/src/main/store.ts
48:  notifyAttention: true,

$ grep -rn "notify[A-Z]" desktop/src/shared/types.ts
283:  notifyAttention: boolean

$ grep -rn "config\.notify\|\.notifyAttention" desktop/src/
desktop/src/main/i18n.ts:332:  'settings.notifyAttention': 'System notification when a session waits ...'
desktop/src/main/index.ts:953:    if (!config.notifyAttention) return
desktop/src/renderer/src/components/SettingsView.tsx:171: checked={config.notifyAttention !== false}
desktop/src/renderer/src/components/SettingsView.tsx:174: <span>{t('settings.notifyAttention')}</span>
```

Un seul interrupteur, et surtout : **ajouter un type de notification aujourd'hui
demande de completer QUATRE endroits independants** (champ de type, valeur par
defaut, lecture, ligne de reglages) plus un libelle i18n, **et rien ne le force**.
C'est la surface exacte que la decision 1 de l'operateur exige de rendre
fail-closed. La carte disait « un seul gate » ; le fait actionnable est le
nombre de points a completer, pas le nombre de gates.

### 0.3 DIVERGENCE 1, et c'est la plus utile : `pending_approvals` a DEJA des bornes

La carte et le cadrage disent « `pending_approvals` n'a AUCUNE borne
aujourd'hui, il faut en ajouter une ». **C'est inexact.**

```
$ grep -n "pending_approvals" broker.ts | grep -i "delete\|update\|expire\|purge"
4535: UPDATE pending_approvals ...        (settle)
4690: UPDATE pending_approvals SET delivered_at = ? ...
4933: UPDATE pending_approvals SET status = 'expired_notif'
4938: DELETE FROM pending_approvals ...
```

`sweepApprovals` (broker.ts), docstring verbatim : « Expire the NOTIFICATION of
overdue pending approvals, and purge settled ones past the retention window.
**Pending rows are never deleted.** »

Trois mecanismes existent donc deja :

1. `notif_expires_at` (colonne `NOT NULL`, posee a l'ajout depuis
   `APPROVAL_NOTIF_TTL_HOURS`) : une approbation en attente au-dela de ce delai
   passe en `status = 'expired_notif'`.
2. Les lignes reglees (`answered`, `abandoned`) sont supprimees apres
   `APPROVAL_TTL_DAYS`.
3. Les lignes EN ATTENTE ne sont jamais supprimees.

**Et le comportement associe est deja exactement R2.** Verifie plutot que
suppose, parce que « la notification expire » ressemble beaucoup a « l'operateur
perd la question » :

```
$ grep -rn "expired_notif" broker.ts desktop/src/ shared/
broker.ts:4103  // blocked and the Deck can still settle an expired_notif approval.
broker.ts:4532  const allowed = via === "deck" ? "('pending','expired_notif')" : "('pending')";
desktop/src/main/approval-service.ts:216  // 'pending' and 'expired_notif' are exactly the statuses settleApproval ...
desktop/src/shared/types.ts:180  export type ApprovalStatus = 'pending' | 'answered' | 'expired_notif' | 'abandoned'
```

`fetchPendingApprovals` lance **deux** requetes, `status: 'pending'` ET
`status: 'expired_notif'`, et fusionne. Autrement dit : **la NOTIFICATION
DISTANTE expire, la QUESTION reste visible dans le Courrier local et reste
repondable.** C'est R2 applique, en production, correctement, avant que R2 n'ait
ete formulee.

**Consequence sur le travail de la decision 2 : il est plus petit que ce que la
carte annonce.** Il ne s'agit pas d'inventer une borne, mais d'ajouter une
SECONDE CAUSE d'expiration a un mecanisme qui existe, dont le statut cible
existe, et dont les deux consommateurs (broker et Deck) traitent deja ce statut.
Detail en §4.

### 0.4 DIVERGENCE 2 : trois des inconnues de la carte sont fermees

La carte declare encore trois inconnues (arme braille de `BUSY_RE`, motif de
choix numerote, et retrait/edition cote canaux distants). **Elle est datee du
matin.** Depuis, `DESIGN-NOTIFY-EVENTS.md` acte : U1 retiree (on remplace le
capteur au lieu de le reparer), U2 retiree par la mesure du corps du payload,
U3'/U5' fermees, U6 sans objet. Restent U2' (grain de classification) et U6'
(quel corps porte la limite d'usage). **Ne pas relancer de mesure sur les
inconnues de la carte : lire celles de la specification.**

### 0.5 Ce que le balayage a trouve et que personne n'avait cite : deux precedents fail-closed maison

```
$ grep -rn "satisfies Record<" desktop/src/ shared/
desktop/src/renderer/src/highlight.ts:63:} satisfies Record<CodeLang, GrammarLoader>
desktop/src/shared/code-lang.ts:7: (commentaire)
desktop/src/shared/companion.ts:217:} as const satisfies Record<keyof DeckApi, CompanionMethodSpec>

$ grep -rn ": never\b" desktop/src/ | grep exhaust
desktop/src/main/dispatch.ts:154:      const _exhaustive: never = item.status
```

`code-lang.ts`, en-tete verbatim : « The union below is the CONTRACT: the
renderer's grammar table is typed `satisfies Record<CodeLang, ...>`, so adding a
member here without shipping a grammar is a **COMPILE error**, never a blank
viewer at runtime. »

**Le depot possede deja le mecanisme que la decision 1 reclame, deux fois, et
documente.** La conception ci-dessous n'invente rien : elle applique le patron
de `code-lang.ts` aux notifications.

---

## 1. La frontiere du decideur

### 1.1 Signature

Un **decideur pur**, sans I/O, sans import electron, testable sous `bun`, dans
la lignee de `attention.ts` / `inbox-store.ts` / `approval-service.ts` (tous
« node builtins only » pour cette raison).

```
decideNotification(event: NotifyEvent, state: NotifyState): NotifyDecision
```

**ENTREE 1, l'evenement, deja typé a la source :**

```
NotifyEvent = {
  kind:  NotifyKind          // le contrat, §3
  key:   { sessionRef, kind, episodeId }
  meta:  { host, osUserHash, projectKey, sessionName, deckSessionId }
  title, body, raisedAt
}
```

**ENTREE 2, l'etat, injecte et non lu :**

```
NotifyState = {
  switches:  Readonly<Record<NotifyKind, boolean>>   // derive du config
  openEpisodes: ReadonlySet<EpisodeKey>              // ce qui est deja signale
  now:       number                                  // horloge injectee
  hostsSeen: number                                  // pour la regle de titre multi-hote
}
```

**SORTIE, une donnee, jamais un effet :**

```
NotifyDecision =
  | { act: 'emit',       channels: NotifyChannel[], title, body, key }
  | { act: 'extinguish', key }
  | { act: 'ignore',     reason: IgnoreReason }
```

`reason` est un type ferme (`'muted' | 'duplicate' | 'below-threshold' |
'textual-sensor-local-only' | ...`) et non une chaine libre : c'est ce qui rend
le journal de decision lisible et, surtout, ce qui permet de tester « il a
ignore POUR LA BONNE RAISON » plutot que « il n'a rien emis ».

### 1.2 Ce qui reste DEHORS, explicitement

- **La capture.** Le decodage OSC, la fenetre de frequence, le suivi du pty. Les
  capteurs produisent des `NotifyEvent`, ils ne decident rien.
- **L'emission.** `new Notification(...)`, le POST vers le broker, l'ecriture
  journal. Un adaptateur consomme une `NotifyDecision`.
- **La lecture de la configuration.** Le decideur recoit `switches`, il ne lit
  jamais `config`. Sans cela il redevient impur et non testable.
- **L'horloge et le hasard.** `now` est injecte (patron de `CompanionAuth`, qui
  prend deja `now: () => number` pour ses tests).
- **La persistance.** `openEpisodes` est fourni ; le decideur ne le mute pas, il
  rend une decision dont l'appelant deduit la mutation.

### 1.3 Pourquoi pur, et pourquoi j'ecarte l'alternative

- **Option A, service avec etat** (une classe qui tient `openEpisodes`, emet, et
  s'abonne). Moins de plomberie a l'appel. Cout : impossible a tester sans
  simuler electron, et l'etat interne devient un second porteur en plus du
  Courrier et du broker, cad exactement le probleme d'identite que la
  specification a passe la journee a fermer.
- **Option B, fonction pure + un mince proprietaire d'etat separe.** Cout : une
  indirection de plus. Gain : chaque regle (niveau, interrupteur, doublon,
  extinction) se prouve par un appel de fonction, sans DOM, sans electron, sans
  pty.

**Recommandation : B.** Force decisive : la decision 1 de l'operateur transforme
la table des types en contrat visible ; un contrat qu'on ne peut pas exercer
directement en test se verifie par relecture, et §5 montre que la relecture est
precisement ce qu'on cherche a reduire.

---

## 2. Placement et direction de dependance

### 2.1 Ou

**`desktop/src/shared/notify-policy.ts`** (module pur, aucune dependance
electron) pour le decideur et le contrat de types.
**`desktop/src/main/notify-router.ts`** pour le proprietaire d'etat mince : il
tient `openEpisodes`, lit `config`, appelle le decideur, et exerce les
adaptateurs.

Le choix de `shared/` n'est pas cosmetique : `desktop/src/shared/companion.ts`
et `code-lang.ts` y vivent deja pour la meme raison, et le second le dit dans
son en-tete (« Kept out of the renderer so it runs under `bun test` with no
DOM »).

### 2.2 Direction de dependance

```
capteurs (main)  ---->  notify-router (main)  ---->  notify-policy (shared, pur)
                              |
                              +-->  adaptateurs : Notification OS, broker, journal
```

Une seule fleche entrante sur le module pur, et **aucune sortante**. Le routeur
depend de la politique ; la politique ne connait ni electron, ni le broker, ni
le pty.

### 2.3 Ce que deviennent les trois sites

| Site actuel | Devient |
|---|---|
| handler de `service.on('attention', ...)` (`index.ts:957`) | emet un `NotifyEvent` ; **et sa moitie `openApprovals` / `claimApproval` part avec lui ou pas du tout** (piege inscrit sur la carte, confirme en lisant le handler) |
| `notifyInbox(batch)` (`index.ts:1003`) | emet N `NotifyEvent` de niveau C ; le groupement devient une regle du decideur, pas une astuce locale |
| bloc de `pollGraphDrafts()` (`index.ts:1160`) | emet un `NotifyEvent` ; **le `Set` en memoire `notifiedDraftIds` disparait** : sa fonction est exactement `openEpisodes`, dont c'est le travail |

Le troisieme point vaut d'etre souligne : la conception **supprime** un porteur
d'etat existant au lieu d'en ajouter un. Les deux defauts mesures de ce site
(pas de survie au redemarrage, croissance sans borne) ne se corrigent pas, ils
cessent d'exister.

---

## 3. Le contrat de types et son exhaustivite

### 3.1 Le mecanisme : une PICK-LIST, pas une deny-list

```
export type NotifyKind =
  | 'blocked.asked' | 'blocked.onscreen' | 'blocked.usage'
  | 'lost.exit' | 'lost.never-started'
  | 'mail.inbox' | 'mail.graph-draft'

export const NOTIFY_KINDS = {
  'blocked.asked': { level: 'A', switchKey: 'notifyBlocked', labelKey: '...', crossesMachine: true  },
  ...
} as const satisfies Record<NotifyKind, NotifySpec>
```

**Pourquoi cela ne peut pas retrecir en silence** : `satisfies Record<K, V>`
exige **toutes** les cles de l'union. Ajouter un membre a `NotifyKind` sans sa
ligne est une **erreur de compilation**, pas une notification muette. C'est
litteralement le patron de `code-lang.ts`, dont l'en-tete dit que le manque est
« a COMPILE error, never a blank viewer at runtime ».

L'inverse (une projection par rest-spread, ou une liste de types a EXCLURE)
echoue OUVERT : c'est la forme de `toPublicPeer` citee dans CLAUDE.md, ou un
17e champ part publiquement sans que rien ne casse. **Le sens de la table est
donc load-bearing : elle enumere ce qui est ADMIS, jamais ce qui est exclu.**

### 3.2 La chaine complete forcee, et les trois maillons

1. **La ligne de table** : forcee par `satisfies`. Compilation.
2. **L'interrupteur existe** : `switchKey` type comme
   `BooleanConfigKey = { [K in keyof AppConfig]: AppConfig[K] extends boolean ? K : never }[keyof AppConfig]`.
   Citer une cle inexistante ne compile pas.
3. **La ligne de reglages** : `SettingsView` **derive ses cases de la table**
   (`Object.entries(NOTIFY_KINDS)`) au lieu de les ecrire a la main. Un type
   ajoute apparait dans l'ecran sans qu'on y pense ; il ne peut pas manquer.
4. **Le libelle** : `labelKey` porte dans la meme ligne, donc le controle de
   parite de locales deja en place (`TESTING.md`) rougit sur une traduction
   absente.

### 3.3 LE PIEGE QUE MA PROPRE CONCEPTION FAILLIT INTRODUIRE, mesure

La forme naturelle serait `notify: Record<NotifyKind, boolean>` dans `AppConfig`.
**Elle serait fail-open**, et la mesure le prouve :

```
$ sed -n '100,106p' desktop/src/main/store.ts
export function loadConfig(): AppConfig {
  const raw = readJson<Partial<AppConfig> & {...}>(configPath(), {})
  const cfg = { ...DEFAULT_CONFIG, ...raw }
```

Le merge est un **spread SUPERFICIEL**, et `store.ts` le dit lui-meme pour un
autre champ : « a config written before this field existed gets `false` from the
DEFAULT_CONFIG spread below, never `undefined` ». Cette garantie **ne vaut que
pour les champs PLATS**. Un objet imbrique est remplace en bloc par
`raw.notify`, donc un type ajoute apres l'ecriture du fichier de configuration
rendrait `undefined` -> falsy -> **NOTIFICATION MUETTE, SILENCIEUSEMENT**, chez
tout operateur ayant deja lance l'application une fois. Vert en test, muet en
production, sur le cas exact que la decision 1 veut rendre visible.

**Donc : interrupteurs PLATS, un champ booleen par type**, ce que le spread
existant remplit deja correctement. La table les relie, elle ne les heberge pas.

**Residu honnete** : `satisfies` force « chaque type a un interrupteur », il ne
force pas « chaque type a le SIEN » (deux lignes pourraient pointer la meme
cle). C'est un test, pas une compilation, et il est dans la colonne « prouvable »
de §5.

---

## 4. Extinction et borne de duree de vie

### 4.1 Extinction, cote decideur

Le decideur ne connait qu'une chose : `openEpisodes`. Trois regles.

- Un `NotifyEvent` dont la cle est deja dans `openEpisodes` -> `ignore('duplicate')`.
  Cela remplace le `Set` de `pollGraphDrafts`.
- Un evenement d'extinction (front d'OSC 0, sortie de session, approbation
  reglee) -> `extinguish(key)`.
- **Aucune regle de TTL.** R2. Un episode ouvert depuis longtemps sort par la
  surface de sante, jamais par un balai.

**Detail que la mesure impose** (specification §6.6) : l'extinction est
**sur FRONT** (« une emission est arrivee depuis que l'episode est leve ») et non
**sur NIVEAU** (« la tuile est occupee »). Une salve suivie de silence satisfait
le front et echoue au niveau, et c'est le cas mesure.

### 4.2 La borne sur `pending_approvals` : etendre, pas inventer

Compte tenu de §0.3, la decision 2 se ramene a **une seconde cause pour un
mecanisme existant** :

- Le Deck **DECLARE** son `deckSessionId` (minte en memoire par lancement, jamais
  persiste). C'est deja la cle retenue pour la duree de vie du Courrier et pour
  l'appairage : **un mecanisme, trois objets**.
- `pending_approvals` porte cette valeur, comme il porte deja `origin_host`,
  `project_key` et `session_ref`.
- `sweepApprovals` gagne une clause : une ligne `pending` dont le
  `deck_session_id` n'est plus vivant passe en **`expired_notif`** -- le statut
  qui EXISTE DEJA et que les deux cotes traitent deja.

Ce que cela donne gratuitement : la question **cesse de sonner sur le telephone**
et **reste visible et repondable dans le Courrier** au relancement, ce qui est
exactement la phrase de l'operateur (« si reprise de session, l'utilisateur est
devant son PC, il repondra lui-meme »). **Le comportement voulu est le
comportement existant, applique a une seconde cause.**

### 4.3 CORRECTION mesuree : le statut cible n'est pas `expired_notif`, c'est `abandoned`

H3 mesuree le 2026-08-19. **Ma proposition de §4.2 etait la mauvaise, et elle
aurait conduit droit dans un defaut deja carde.**

Semantique documentee, `shared/types.ts` verbatim :

```
 * expired_notif  -> the NOTIFICATION expired (default 24h). The session is
 *                   still blocked and the Deck may still claim it.
 * abandoned      -> the producer gave up (session closed, host gone)
```

**`expired_notif` promet « la session est TOUJOURS bloquee ».** Quand le Deck
meurt, c'est faux : les sessions meurent avec lui (mots de l'operateur, « si on
ferme kory, on ferme les sessions CC »). Le producteur est parti, ce qui est
mot pour mot la definition d'`abandoned`.

**Et le choix n'est pas cosmetique, il est fonctionnel.** MESURE,
`broker.ts` : `const allowed = via === "deck" ? "('pending','expired_notif')" :
"('pending')"`. Un `expired_notif` **reste reclamable par le Deck**. Une reponse
donnee la partirait vers le `reply_token` d'un peer mort, cad la **perte
silencieuse** mesuree et cardee en `9f48d84b`. `abandoned` n'est pas dans
l'allow-list, donc il ferme ce chemin **par construction**.

**Et le statut est DEJA prevu pour ce cas, sans producteur.** Balayage :

```
$ grep -rn "abandoned" --include=*.ts --include=*.tsx . | grep -v node_modules | grep -v /dist/ | grep -v ^./tests/
broker.ts:4939:      WHERE status IN ('answered','abandoned') AND created_at < datetime('now', ?)
shared/types.ts:1059: * abandoned -> the producer gave up (session closed, host gone)
desktop/src/shared/types.ts:180: ... | 'abandoned'
(les occurrences de dispatch.ts relevent de la roadmap, pas des approbations)
```

**Aucun `SET status = 'abandoned'` nulle part.** Un statut declare, documente,
avec un CONSOMMATEUR (la purge) et **zero producteur** : exactement le motif que
CLAUDE.md nomme (`sandbox:changed` cable cote consommateur, jamais emis). La
clause de la decision 2 **n'ajoute donc pas un statut, elle en cable un qui
attendait son producteur depuis le debut.**

Cout revise : une clause dans `sweepApprovals`, ecrivant `'abandoned'`. Zero
nouveau statut, zero lecteur a modifier, et la purge existante ramasse ces
lignes apres `APPROVAL_TTL_DAYS`.

**Ce n'est pas une violation de R2**, meme si cela y ressemble. R2 interdit
d'effacer un episode dont la verite est INCONNUE, parce qu'un operateur peut
reellement attendre. Ici la verite est CONNUE : le producteur est mort. Ce n'est
pas un delai qui tranche, c'est un fait.

### 4.4 Identite de la clause : par quoi elle est keyee, et deux de quoi

**Le champ.** `deck_session_id`, minte en memoire a chaque lancement du Deck,
jamais persiste. Meme cle que la duree de vie du Courrier et que l'appairage :
un mecanisme, trois objets.

**Il ne doit JAMAIS etre un champ envoye par l'agent.** Le broker le derive du
credential de session, comme il epingle deja `session_ref` (commentaire de
`handleApprovalAdd` : « A session credential is pinned to its own session_ref:
it can neither impersonate another tile nor emit anonymously »). Le Deck le lie
a la frappe du jeton (`mintSessionToken`), le broker le recopie sur
l'approbation. Sinon c'est l'entree hostile n°4 : un agent declarerait
appartenir au Deck d'un autre et pourrait faire abandonner ses questions.

**« Et quand il y en a deux ? »**

| Deuxieme quoi | Ce qui se passe | Pourquoi c'est sur |
|---|---|---|
| Deux fenetres Deck vivantes, meme compte, meme projet | chacune minte son propre id ; chaque approbation porte celui du Deck qui a engendre sa session | l'id est minte PAR LANCEMENT ; abandonner celles de A ne touche aucune ligne de B |
| Deux comptes OS sur une machine | `operator_id` differents (mesure : `operator.json` est par compte OS) | le balayage est scope par operateur en plus de l'id |
| Broker partage, deux personnes | l'`UPDATE` est scope `WHERE deck_session_id = ? AND operator_id = ?`, l'`operator_id` venant de la preuve d'authentification, jamais du corps | **objet d'abord, droit ensuite** : on ne resout jamais « l'operateur de cette session Deck » pour comparer |

**Le signal qui declenche, et pourquoi il n'y a PAS de battement de coeur.**
Une seule cause : le Deck **DECLARE** son arret, authentifie par le credential
operateur dont il est le seul porteur. Pas de table de liveness, pas de seuil de
fraicheur.

Raison, et c'est R2 encore : un Deck vivant dont le battement tarde (machine en
veille, alea reseau sur un broker partage) verrait ses questions REELLES
abandonnees. Un seuil de fraicheur serait un TTL destructeur, exactement ce que
R2 interdit.

**Le cas du crash est donc traite par ce qui existe deja** : aucun arret n'est
declare, les lignes restent `pending`, et `notif_expires_at` arrete le telephone
au bout de `APPROVAL_NOTIF_TTL_HOURS`. Degradation assumee et bornee : apres un
crash, une notification peut survivre au Deck jusqu'a ce delai. Elle degrade
vers « tu recois une question a laquelle tu ne peux pas repondre », jamais vers
« ta question vivante a ete effacee ». C'est le bon sens de degradation.

### 4.5 Rapport a la carte `efd9dbfc`

**Meme mecanisme, et la carte le dit deja** (« Il doit etre minte PAR
LANCEMENT, ce qui est exactement la cle deja retenue »). Les deux chantiers
convergent sur **un seul champ nouveau**.

Deux consequences : son « cout cache » (une liaison invalidee a chaque relance)
est **caduc**, l'operateur ayant tranche que c'est le comportement voulu ; et de
ses « trois etages a re-keyer », seul `handleApprovalList` la concerne, les deux
autres appartenant au telephone (Option B, travail distinct).

**Recommandation : ne pas la clore, la SEQUENCER APRES ce chantier, dans le meme
lot.** Elle devient une clause de filtrage montee sur le champ que celui-ci
introduit, donc un cout marginal proche de zero. La clore maintenant perdrait
une mesure pour ne rien economiser.

---

## 5. Ligne de partage : prouvable par test contre relecture

C'est la liste a carder en dette. Elle est courte parce que la purete du §1 a ete
choisie pour cela.

### 5.1 Prouvable par test, sans DOM, sans electron, sans pty

1. Chaque regle de decision : muet, doublon, niveau, capteur textuel qui ne
   franchit pas la machine. Un appel de fonction, une assertion sur `act` **et
   sur `reason`**.
2. Extinction sur FRONT et non sur NIVEAU : la salve suivie de silence est un
   cas de test direct, avec le controle negatif (une E2 a niveau echoue dessus).
3. Les interrupteurs sont deux a deux distincts (le residu de §3.3).
4. Le titre porte l'hote **des que** `hostsSeen > 1`, et pas avant : les deux
   branches sont testables puisque `hostsSeen` est une entree.
5. La cle de dedoublonnage : deux evenements de meme `(sessionRef, kind,
   episodeId)` rendent `duplicate` ; un `sessionRef` different ne le rend pas
   (controle negatif, sans lui la garde mord sur le mauvais cas).
6. **L'exhaustivite elle-meme n'est pas un test, c'est le compilateur** : ajouter
   un membre a `NotifyKind` sans sa ligne casse `npm run typecheck`. Une sonde
   negative peut le figer via un fichier de type volontairement incomplet, mais
   le typecheck est la garde reelle.

### 5.2 Repose sur la RELECTURE (la dette)

1. **Que chaque capteur emette bien un `NotifyEvent`** et n'appelle plus
   `new Notification` en direct. C'est le mode d'echec par lequel la carte
   `63d73bde` est nee. **Voir §5.4 : la garde EST realisable, mais pas par du
   lint.**
2. **Que `SettingsView` derive reellement de la table** et ne reintroduise pas
   une case ecrite a la main. Compilable dans les deux cas.
3. **Que les deux moities du site attention partent ensemble** (`openApprovals`
   plus `claimApproval`). Aucun type ne le relie.
4. **Que la clause ajoutee a `sweepApprovals` lise une liste de sessions vivantes
   et non un drapeau de fermeture** (l'hypothese de §4.2).
5. **Que l'adaptateur n'invente pas de regle** : rien n'empeche techniquement un
   adaptateur de filtrer a son tour, ce qui recreerait une quatrieme regle a un
   endroit de plus.

### 5.3 Ce que je NE peux pas rendre prouvable, et je le dis

Le fait qu'un type de notification **manque a l'appel** parce que personne ne l'a
declare. Le contrat rend impossible d'ajouter un type sans son interrupteur ; il
ne rend pas impossible d'oublier d'ajouter le type. **Aucun mecanisme de ce
document ne couvre cela**, et pretendre le contraire serait exactement
l'affirmation de couverture que CLAUDE.md interdit.

---

### 5.4 H4 mesuree : le lint est IMPOSSIBLE, la garde est neanmoins realisable

**Balayage, resultat brut :**

```
$ find . -maxdepth 3 -iname "*eslint*" -not -path "./node_modules/*" -not -path "*/dist/*"
(vide)
$ grep -rn "eslint" package.json desktop/package.json
(vide)
$ grep -n '"lint"' desktop/package.json
(vide)
```

**Il n'y a AUCUN eslint dans ce depot** : ni fichier de configuration, ni
dependance, ni script. Le seul controle statique est `typecheck`. Ma
recommandation de §5.2 supposait « sans plugin nouveau » ; la mesure dit qu'il
faudrait introduire l'outil ENTIER. **Je la retire.**

**Substitut realisable aujourd'hui, avec zero outil nouveau : un TEST DE
DISCIPLINE.** Le depot en possede deja un
(`tests/desktop-inject-command-modal-guard.test.ts`). Il balaie l'arbre pour
`new Notification(` et exige que les seules occurrences soient dans
l'adaptateur.

**Audit de couverture de ma propre garde**, puisque CLAUDE.md l'exige et que
c'est precisement la classe de garde qui echoue en silence :

- **Sens du test.** Ce n'est PAS une liste codee en dur des sites attendus (le
  defaut cite dans CLAUDE.md, « 4 sur 8 »). C'est la recherche d'un jeton
  INTERDIT avec une allow-list d'UN fichier : une pick-list, donc elle echoue
  FERME. Tout nouvel appel, n'importe ou, la rend rouge.
- **Domaine balaye.** Doit couvrir tout `desktop/src/`, pas seulement `main/`.
  Un balayage restreint rendrait un SOUS-ENSEMBLE sans erreur.
- **PIEGE MESURE, ET IL DECIDE SI LA GARDE TOURNE :** la CI n'utilise pas
  `bun test`, elle enumere des globs.
  ```
  $ grep -rn "bun test" .github/workflows/
  desktop-build.yml:79: run: bun test tests/desktop-*.test.ts tests/notify-*.test.ts
     tests/mobile-shell-*.test.ts tests/cli-*.test.ts tests/config-*.test.ts
     tests/approval-identity.test.ts tests/peer-*.test.ts tests/graph-*.test.ts
     tests/logger.test.ts tests/roadmap-*.test.ts
  ```
  **Un fichier nomme `tests/notification-discipline.test.ts` ne matcherait
  AUCUN de ces globs et ne tournerait jamais en CI**, tout en passant en local.
  C'est le defaut « 78 fichiers sur 116 » de `TESTING.md`, applique a la garde
  elle-meme. **Contrainte de nommage, non negociable : le fichier doit
  s'appeler `tests/desktop-*.test.ts` ou `tests/notify-*.test.ts`.**

Avec ces trois conditions la ligne de dette n°1 **sort** de la relecture. Sans
elles, elle y reste, et je ne la promets pas.

---

## HYPOTHESES restantes (ma lecture, distincte des octets ci-dessus)

**H3 et H4 ne sont plus des hypotheses** : mesurees le 2026-08-19, H3 REFUTEE
(§4.3, le statut est `abandoned`, pas `expired_notif`), H4 REFUTEE (§5.4, aucun
eslint dans le depot).

- **H1.** Je lis les trois emissions actuelles comme trois moments d'ecriture et
  non trois decisions, parce qu'elles divergent sur trois axes independants
  (gate, dedoublonnage, forme du titre) sans qu'aucun commentaire n'assume ces
  divergences. Non verifiable dans le code.
- **H2.** Je suppose que le decideur doit couvrir les notifications OS **et** le
  franchissement de la frontiere de la machine, mais **pas** les toasts du
  renderer, la banniere de statut ni le journal, qui sont des surfaces
  consultees et non des interruptions. La carte ne le dit pas ; je pose la
  frontiere ici pour qu'elle soit contestable.
