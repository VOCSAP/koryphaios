# La forme de `resolveApprovalAuth` : rendre l'omission du scope impossible

Conception, 2026-08-19. Lot C, cartes `1def56da` / `4df14b5b`.
Voisin : `DESIGN-NOTIFY-DECIDER.md` (§4.4, `deck_session_id`), meme zone
d'autorisation, compatibilite traitee en §5.

Lecture seule. Aucun code de production, aucun test lance, rien de stage, rien
ecrit dans `broker.ts` ni `server.ts`.
MESURE : `git check-ignore -v DESIGN-APPROVAL-SCOPE.md` -> code de sortie 1,
donc non ignore.

---

## 1. Je confirme la lecture du team-lead, et la mesure la durcit

Son hypothese : ajouter la clause manquante dans trois handlers les corrige tous
les trois et laisse le mecanisme intact, donc le cinquieme handler ecrit dans six
mois echouera OUVERT pareil. **Confirmee, et il y a pire.**

### 1.1 Le scope n'est pas une valeur, c'est une LISTE DE SCALAIRES enfilee a la main

```
$ grep -n "interface ResolvedAuth" -A 6 broker.ts
4218:interface ResolvedAuth {
4219-  operator_id: string;
4220-  kind: "operator" | "session";
4221-  /** Set for a session credential: the ONLY session_ref it may act on. */
4222-  session_ref: string | null;
4223-}
```

Et la couche du dessous refait le meme geste :

```
$ sed -n '4525,4538p' broker.ts
function settleApproval(
  id: string,
  operatorId: string,          <-- le scope arrive en PARAMETRE SCALAIRE
  ...
  `UPDATE pending_approvals ... WHERE id = ? AND operator_id = ? AND status IN ${allowed}`
```

**L'arite du scope croit avec chaque dimension, et chaque site doit etre
revisite.** Ajouter `project_key` veut dire un parametre de plus dans
`settleApproval`, dans sa clause SQL, et dans les quatre handlers. Ajouter
ensuite `deck_session_id` veut dire recommencer. C'est le defaut « keye par trop
peu » de CLAUDE.md, mais pose sur une SIGNATURE au lieu d'une table.

Symptome deja visible dans le meme corps de fonction, benin aujourd'hui :

```
const row = db.query("SELECT * FROM pending_approvals WHERE id = ?").get(id)
```

Ce `SELECT` n'a **aucune** clause d'identite. Il est sur, parce que l'`UPDATE`
juste avant a prouve la propriete. Mais il montre le comportement induit : des
qu'on enfile des scalaires, certaines requetes les perdent et ca ne se voit pas.

### 1.2 LA MESURE QUE PERSONNE N'A FAITE : `project_key` est fourni PAR L'AGENT

C'est le point qui change le verdict, et il n'est pas dans le rapport de
l'explorer.

```
$ sed -n '4447,4457p' broker.ts
  const approval: Approval = {
    id: randomUUID(),
    operator_id: auth.operator_id,        <-- issu du CREDENTIAL
    origin: {
      host: pick("host")...,              <-- issu du CORPS
      os_user_hash: pick("os_user_hash")..., <-- issu du CORPS
      project_key: pick("project_key")...,   <-- issu du CORPS
      group_id: pick("group_id")...,      <-- issu du CORPS
      from_peer: pick("from_peer")...,    <-- issu du CORPS
      session_ref: sessionRef,            <-- issu du CREDENTIAL (epingle)
```

```
$ sed -n '708,716p' broker.ts
  CREATE TABLE IF NOT EXISTS approval_session_tokens (
    token_id, operator_id, public_key, session_ref, created_at, expires_at, revoked_at
```

**Le jeton de session ne porte PAS `project_key`.** Deux champs seulement sont
derives du credential : `operator_id` et `session_ref`. `project_key` est un
champ que l'ECRIVAIN choisit.

Consequence : **la carte `4df14b5b` a rendu obligatoire un filtre sur une
dimension que la partie filtree declare elle-meme.** Le filtre est reel, la
dimension n'en est pas une. Un agent peut estampiller le `project_key` d'un
autre projet et sa question apparaitra dans le Courrier de ce projet-la.

Portee, mesuree et bornee, a ne pas dramatiser : `operator_id` reste derive du
credential, donc la fuite est **inter-PROJETS a l'interieur d'une meme
personne**, jamais inter-operateurs. Mais c'est exactement le cas que
`4df14b5b` existait pour fermer (« two Deck windows on two different repos share
the same operator_id »), donc la fermeture est incomplete d'une facon que
personne n'a remarquee.

**Corollaire pour le lot C : ajouter la clause manquante dans les trois handlers
sans changer l'origine de `project_key` produirait un lot VERT et une garantie
absente.** Le filtre s'appliquerait a une valeur choisie par celui qu'il est
cense contenir.

---

## 2. La forme : trois fonctions, pas une, et un scope OPAQUE

### 2.1 Pourquoi une seule fonction ne peut pas suffire

Les quatre handlers ne posent pas la meme question :

| Handler | Objet vise | Nature |
|---|---|---|
| `add` | **aucun**, il le cree | CREATION |
| `wait`, `claim` | un, par `id` | CIBLEE |
| `delivered` | plusieurs, par `ids[]` | CIBLEE (lot) |
| `list` | **aucun**, c'est une requete | REQUETE |

Une fonction unique ne peut rendre qu'un plus petit denominateur commun, cad une
IDENTITE, et laisser chaque appelant finir le travail. **C'est exactement la
forme actuelle, et c'est pour cela qu'elle echoue en trois endroits sur quatre.**
La reponse a la question du team-lead est donc : oui, le bon mouvement est de
resoudre l'objet vise et de rendre une decision qui porte deja sur lui, **mais
seulement pour la famille CIBLEE**. Les deux autres familles ont besoin d'autre
chose, et c'est ce decoupage qui rend l'omission impossible plutot que corrigee.

### 2.2 La forme proposee

```
// UNE valeur opaque. Ses champs ne sont PAS lisibles par un handler.
type ApprovalScope = { readonly __scope: unique symbol }

authorizeTarget(body, op): { scope: ApprovalScope; rows: ApprovalRow[] } | Err
authorizeQuery (body, op): { scope: ApprovalScope }                     | Err
authorizeCreate(body):     { stamp: OriginStamp }                       | Err

// SEUL producteur d'une clause d'identite sur pending_approvals :
approvalWhere(scope): { sql: string; params: unknown[] }
```

Trois proprietes, et c'est leur conjonction qui fait le travail :

1. **`resolveApprovalAuth` disparait.** Pas depreciee : SUPPRIMEE. Tant qu'elle
   existe, un cinquieme handler peut l'appeler et se retrouver non scope. Un
   mecanisme fail-closed qui cohabite avec son predecesseur fail-open est un
   mecanisme fail-open.
2. **Aucun handler ne detient jamais un `operator_id`.** Il ne peut donc pas
   ecrire `operator_id = ?`, ni l'oublier : il n'a pas la valeur. C'est ce qui
   transforme la discipline en impossibilite.
3. **`settleApproval` ne prend plus de scalaires** mais le scope, et compose sa
   clause par `approvalWhere`. Son arite cesse de croitre avec les dimensions.

### 2.3 Ce que devient `handleApprovalAdd`

Il n'a pas d'objet a resoudre, donc il ne recoit pas de scope mais un **STAMP** :
l'ensemble des champs d'origine **derives du credential**, que l'INSERT etale.

Cela repare le §1.2 par construction : `project_key` cesse d'etre `pick(...)`.
Le patron existe deja et il est documente au meme endroit — le commentaire dit
qu'un credential de session « can neither impersonate another tile nor emit
anonymously » pour `session_ref`. **On etend la meme discipline a la dimension
qui est devenue un scope depuis.**

Prerequis, et il est reel : `project_key` doit rejoindre
`approval_session_tokens`, pose par le Deck a la frappe du jeton
(`mintSessionToken`). C'est le meme mouvement, et le meme endroit, que
`deck_session_id` (§5).

`tile_ref` reste explicitement hors stamp : le code le declare deja « untrusted
routing hint », re-valide cote Deck. Ne pas le durcir par symetrie, ce serait
elargir sans raison.

---

## 3. Audit de couverture de MA PROPRE forme

Exigence du team-lead, et la partie qui compte.

### 3.1 Quelle degradation rend un SOUS-ENSEMBLE au lieu d'une erreur

| # | Degradation | Verdict |
|---|---|---|
| D1 | L'ancienne `resolveApprovalAuth` survit « pour la transition » | **Fatal.** Un nouveau handler l'appelle et n'est pas scope. C'est pourquoi la suppression est une exigence et non un nettoyage. |
| D2 | `approvalWhere(scope, opts?)` gagne un parametre OPTIONNEL de dimension | **Fatal et silencieux.** Un appelant qui l'omet obtient une clause plus courte, sans erreur. **Regle : aucun parametre optionnel de scope, jamais.** Une dimension nouvelle s'ajoute A L'INTERIEUR et s'applique a tous d'un coup. |
| D3 | Un handler re-interroge la table apres autorisation | Precedent deja present (`SELECT * ... WHERE id = ?`). **Mitigation : `authorizeTarget` rend les LIGNES qu'il a deja lues sous scope**, donc il n'y a plus de raison de re-interroger, et un round-trip disparait. |
| D4 | Quelqu'un ecrit du SQL brut sur `pending_approvals` sans passer par le helper | **NON FERME par le type.** Seul un test de discipline le rattrape : balayage de `pending_approvals` hors du module d'autorisation, allow-list d'UN fichier. Meme forme, memes trois conditions que la garde `new Notification` de `DESIGN-NOTIFY-DECIDER.md` §5.4, **y compris la contrainte de nommage `tests/desktop-*` ou `tests/notify-*`** sans laquelle il ne tournerait jamais en CI. |
| D5 | Le scope est opaque mais quelqu'un ajoute un accesseur « juste pour logger » | Realiste, et c'est la fin de la garantie. Le journal doit recevoir un rendu deja compose par le module, jamais les champs. |

### 3.2 Quelle croissance du DOMAINE produit le meme effet sans que rien ne bouge

| # | Croissance | Verdict |
|---|---|---|
| G1 | Un cinquieme HANDLER | **Couvert**, et c'est le but, a la stricte condition D1. Il devra choisir une des trois fonctions, et les trois scopent. |
| G2 | Une cinquieme DIMENSION de scope (`deck_session_id`, demain autre chose) | **C'est le gain principal.** Aujourd'hui : 4 handlers plus la signature de `settleApproval` plus sa clause SQL. Avec la forme : deux edits, dans le constructeur de scope et dans `approvalWhere`. **Aucun autre site ne detient les morceaux, donc aucun autre site ne peut oublier.** |
| G3 | Une nouvelle TABLE liee (des notes, un historique) | **NON COUVERT.** Le helper est type pour `pending_approvals`. Une table voisine ne recoit aucune protection et personne ne le remarquera. Nomme, pas ferme. |
| G4 | Un nouveau CANAL de reglement (autre que deck/telegram/discord/ntfy) | Couvert par `via`, deja une enumeration fermee. |

### 3.3 Ce sur quoi ma forme repose ENCORE sur la discipline, dit franchement

**D4 et G3.** Le type rend impossible d'oublier le scope **quand on passe par le
module** ; il ne rend pas impossible de ne pas passer par le module. C'est une
frontiere de module, pas une frontiere de langage, et la seule garde disponible
sans outillage nouveau est un test de discipline.

C'est strictement mieux que l'existant, qui repose sur la discipline **a chaque
appel**, alors que la forme n'y repose plus qu'**a chaque nouveau module**. Mais
ce n'est pas zero, et pretendre le contraire serait l'affirmation de couverture
que ce depot paie.

---

## 4. La fenetre de migration : la forme la SUPPRIME pour trois handlers sur quatre

Contrainte donnee : changement de protocole, meme ordre de deploiement contraint
que `4df14b5b`, et un fail-open pendant la fenetre serait pire que le defaut.

**Le point cle est une consequence directe de « resoudre l'objet d'abord ».**

- **Famille CIBLEE (`wait`, `claim`, `delivered`).** L'objet est designe par un
  `id` (uuid) et **il PORTE deja son propre `project_key`** : la colonne existe
  dans `pending_approvals`. Le serveur n'a donc **aucun besoin** que le client
  declare le scope : il resout la ligne, lit son `project_key`, et verifie que
  l'appelant peut agir dessus. **Un appelant qui n'envoie pas encore le champ
  fonctionne, et il fonctionne SCOPE.** Zero fenetre, zero fail-open, zero
  ordre de deploiement contraint pour ces trois-la.
- **Famille REQUETE (`list`).** Pas d'objet, donc rien d'ou lire le scope : le
  client DOIT le declarer. C'est le seul handler qui a une fenetre, et
  **elle est deja fermee**, par un 400 explicite et journalise (« project_key is
  required »). Precedent a reutiliser tel quel.
- **Famille CREATION (`add`).** Le champ vient du STAMP, cad du jeton. Fenetre
  reelle mais d'une autre nature : pendant la transition, des jetons emis avant
  le changement n'ont pas de `project_key`. **Repli fail-closed obligatoire :
  refuser la creation avec un message nommant la cause** (« ce jeton precede le
  scope de projet, relancez la session »), sur le modele mot pour mot du refus
  deja en place cote agent pour un credential trop ancien. **Ne jamais retomber
  sur `pick("project_key")` en repli : ce serait exactement le defaut du §1.2,
  reintroduit sous couvert de compatibilite.**

**Resume de l'ordre de deploiement : broker d'abord** (il accepte l'ancien et le
nouveau pour la famille ciblee, refuse fermement pour la creation), **Deck
ensuite**. L'inverse casse la creation.

---

## 5. Compatibilite avec `deck_session_id` : ce n'est pas un conflit, c'est le meme mouvement

Le team-lead demande explicitement de trancher ce point avant l'implementation.

**Aucune contradiction. Les deux conceptions convergent, et l'ordre compte.**

- `deck_session_id` (`DESIGN-NOTIFY-DECIDER.md` §4.4) est **la dimension de scope
  n°3**, apres `operator_id` et `project_key`.
- J'y ai deja etabli qu'il doit etre **derive par le broker du credential de
  session, jamais envoye par l'agent**. C'est litteralement le §2.3 du present
  document, applique a un autre champ. **Les deux exigent la meme chose au meme
  endroit** : `approval_session_tokens` gagne les colonnes, le Deck les pose a la
  frappe du jeton, le broker les estampille.
- L'`UPDATE` d'abandon que je decrivais (`WHERE deck_session_id = ? AND
  operator_id = ?`) devient un appel a `approvalWhere(scope)`, donc il herite du
  `project_key` sans que personne y pense. **Ecrit a la main, il aurait oublie
  `project_key` : c'est G2 en train de se produire, sur ma propre conception.**

**Consequence de sequencement, et c'est une recommandation ferme : faire la
FORME AVANT `deck_session_id`.** Dans l'autre sens, `deck_session_id` s'ajoute a
quatre handlers plus `settleApproval`, puis la forme les refactore tous. L'ordre
inverse fait le travail une fois.

---

## 6. Verdict

**La forme actuelle n'est PAS la bonne, et trois clauses ne suffisent pas** --
pour une raison plus forte que celle du dispatch : `project_key` est aujourd'hui
choisi par l'agent (§1.2), donc les trois clauses filtreraient sur une valeur
que la partie filtree declare.

**Mouvement recommande** : trois fonctions au lieu d'une, un scope opaque,
`resolveApprovalAuth` supprimee, `settleApproval` prenant le scope, et
`project_key` derive du jeton comme l'est deja `session_ref`.

**Ce que ce mouvement rend impossible** : oublier une dimension a un site
d'appel, et faire croitre l'arite du scope avec ses dimensions.

**Ce qu'il ne rend pas impossible, et qui reste en dette** : contourner le
module (D4), et une table voisine future sans protection (G3). Les deux sont des
tests de discipline, pas des garanties de langage.
