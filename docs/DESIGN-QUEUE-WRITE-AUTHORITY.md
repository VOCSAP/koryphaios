# Ecriture reservee de la file de dispatch : ce qui contraint toute garde

## Statut

Ce fichier est la REDUCTION d'un brief ecrit le 2026-08-25 par l'architecte
sous le nom `DESIGN-ROLE-AUTHORIZATION.md` (jamais commite), qui refutait la
forme d'autorisation PAR LE ROLE proposee pour le lot 2 de `7defe381`.

**La conception par le role est ABANDONNEE.** Arbitrage operateur du
2026-08-25 : la reservation passe par un VERROU D'EXECUTION sur le lot
(carte `011d3547`) -- le lot enregistre son auteur, ne bloque rien tant qu'il
n'est pas execute, et se verrouille au moment du traitement ; `operator_id`
porte la reservation, `group_id` porte le verrou d'execution. Aucun role n'est
requis.

Tout ce qui argumentait la regle par le role a donc ete RETIRE (voir §8).
Ce qui reste ci-dessous ne parle plus de role : ce sont les contraintes
mesurees que **n'importe quelle** garde sur l'ecriture de la file doit
affronter, verrou d'execution compris.

Etiquettes : **MESURE** (commande executee, sortie citee), **DEDUIT** (lu dans
le code, `file:line`), **SUPPOSE** (non verifie).

---

## 1. La cle de l'objet : `project_key`, jamais le groupe

**MESURE** (2026-08-25, broker.ts:525-547) -- `CREATE TABLE IF NOT EXISTS
roadmap_items` declare 22 colonnes : `id`, `project_key`, `kind`, `title`, ...,
`queue`, `directive`, `target_peer_ids`. **Aucune colonne de groupe.**

**MESURE** (2026-08-25) -- `grep -o "ALTER TABLE roadmap_items ADD COLUMN
[a-z_]*" broker.ts | sort -u` rend six noms : `context`, `inactive`,
`lock_parked_at`, `lock_parked_by`, `operator_id`, `queue`. La table VIVANTE
est donc plus large que son `CREATE TABLE`, et **elle porte deja
`operator_id`** ; elle ne porte toujours aucune colonne de groupe. (Un
comptage independant du team-lead donne 28 colonnes en base, sans colonne de
groupe.)

**DEDUIT** -- `project_key` est resolu cote client par `resolveProjectKey`
(server.ts, `roadmapProjectKey`), donc depuis le remote git ; le `group_id`
vient du secret de scope, donc de la fenetre Kory. **Deux groupes differents
partagent la meme roadmap des qu'ils travaillent sur le meme depot** -- deux
fenetres Kory, ou une fenetre plus une session `cli.ts`. Le debugger a
REPRODUIT ce partage le 2026-08-25 (meme `project_key`, meme carte listee des
deux cotes).

Consequence, et c'est la raison pour laquelle la forme par le role est tombee :
une regle qui interroge le GROUPE DE L'APPELANT rend deux verdicts differents
sur le MEME objet, alors que l'objet n'a pas de groupe. C'est l'inversion que
CLAUDE.md interdit -- resoudre l'OBJET d'abord, puis demander si CE peer peut
agir sur LUI.

**Ce que cela impose au verrou d'execution.** Le couple retenu
(`operator_id` = reservation, `group_id` = verrou d'execution) resout bien
l'objet, mais deux points doivent etre tranches a l'ecriture :
1. `operator_id` existe deja sur `roadmap_items` (mesure ci-dessus) ; le
   `group_id` du verrou, lui, est une colonne NOUVELLE. Verifier qu'il n'est
   pas confondu avec les colonnes `lock_parked_by` / `lock_parked_at` deja
   presentes, qui portent deja une semantique de verrou.
2. Un verrou keye par `group_id` retrouve, en petit, la question du §1 : deux
   fenetres Kory sur le meme depot sont deux `group_id`. La difference est
   qu'ici le groupe est une propriete de l'EXECUTION en cours, pas de
   l'appelant qui ecrit -- ce qui est defendable, mais doit etre ecrit dans le
   commentaire du verrou, sans quoi le prochain lecteur croira que le verrou
   protege la carte contre un autre groupe.

---

## 2. Le superviseur n'a pas de role, et il n'ecrit PAS comme operateur

**MESURE** -- `grep -c "supervisor" broker.ts server.ts` rend `0` et `0`. Le
coeur ignore entierement la notion.

**MESURE** -- le superviseur est cree sans role :
`desktop/src/main/index.ts:2106-2113`, `service.create({ name: SUPERVISOR_NAME,
prompt, supervisor: true, mcpConfig, appendSystemPromptFile, announce })`.
Or `session-service.ts:960-964` exporte `CLAUDE_PEERS_ROLE: def.role ?? ''` :
le superviseur s'enregistre donc avec un role vide, comme n'importe quel agent.

**MESURE, et cela contredit le briefing de la carte `7defe381`** --
`grep -c "roadmap" desktop/src/main/deck-control.ts` rend `0`. Le pont
deck-control n'expose AUCUN outil roadmap. La phrase du briefing *"le
superviseur est couvert par ailleurs (il ecrit deja comme operateur)"* est
**fausse pour la roadmap** : le superviseur ecrit par le MCP claude-peers
ordinaire, authentifie par son `instance_token` comme n'importe quel pair.

**Pourquoi cela survit a l'abandon du role.** Toute garde sur l'ecriture de la
file, y compris un verrou d'execution, doit repondre a "que se passe-t-il quand
c'est le SUPERVISEUR qui ecrit ?". Aujourd'hui la reponse par defaut est "il
est traite comme un agent quelconque", et le briefing de `7defe381` affirme le
contraire. Cette phrase doit etre corrigee dans la carte, quelle que soit la
conception retenue, sinon elle egarera qui prendra le lot.

---

## 3. Deux definitions de "actif" coexistent, facteur 15

**MESURE** -- broker.ts:1706-1730 : la selection des pairs d'un groupe filtre
`status = 'active'` en SQL ; broker.ts:1740-1747 derive ensuite un
`activity_status` a partir de `last_activity_at` et `ACTIVITY_TIMEOUT_MS`.
**MESURE** -- `ACTIVITY_TIMEOUT_MS` = 1800 s (broker.ts:171),
`ACTIVE_STALE_SEC` = 120 s (broker.ts:173-176), balayage toutes les 60 s
(broker.ts:1015-1021, `UPDATE peers SET status = 'dormant' WHERE status =
'active' AND last_seen < ?`).

Un facteur 15 separe les deux, et elles lisent **deux colonnes differentes**
(`last_seen` pour le heartbeat, `last_activity_at` pour les echanges).

**Consequence pour un verrou d'execution.** Un verrou qui se libere "quand le
detenteur n'est plus actif" doit dire LAQUELLE des deux il lit. La bonne forme
n'est jamais "il existe exactement un peer actif" mais "**aucun AUTRE peer
actif n'existe**", parce que la ligne de l'appelant lui-meme peut venir d'etre
balayee (`last_seen` > 120 s) alors qu'il est precisement la.

**DEDUIT** (de ce qui precede plus les mesures de `b313f0c3`) -- apres une
restauration d'espace de travail, les lignes des sessions non proprietaires de
la `session_key` restent `status='active'` jusqu'a 180 s
(`ACTIVE_STALE_SEC` + `SWEEP_INTERVAL_SEC`), sauf si le `POST /disconnect`
best-effort les a marquees dormantes. Tout comptage est SUR-evalue pendant
cette fenetre.

---

## 4. Le domaine a proteger est plus grand que le champ `queue`

R2 parlait de "modifier le workflow, mettre en file, reordonner". Le workflow
affiche est une fonction de plusieurs champs, dont trois sont **deja ouverts a
tous aujourd'hui**.

**MESURE** -- `server.ts:708-747`, l'outil `roadmap_update` expose deja, sans
aucune restriction : `status`, `depends_on`, `locked`, `directive`,
`target_peer_ids`, en plus des champs redactionnels.

**DEDUIT** -- `desktop/src/shared/workflow.ts` :
- `queuedItems` (:73-77) filtre `queue !== null && status !== 'done' &&
  status !== 'archived'`. Donc **poser `status: 'done'` ou archiver DESENFILE
  une carte** sans jamais toucher `queue`.
- `unmetDeps` (:228-241), `laneEdges` et `dependsWouldCycle` lisent
  `depends_on`. Donc **reecrire `depends_on` reorganise la voie** et change ce
  qui est dispatchable.
- `isHead` (:46-48) lit `locked && status === 'in_progress' && queue === null`,
  et `laneItems` (:110-118) place ces tetes AVANT la file. Donc **poser
  `locked` / `in_progress` insere en tete de voie**.

Garder le seul champ `queue` laisse donc **trois chemins ouverts vers le meme
effet**. Ce n'est pas une faille (le modele de menace est l'accident), mais
c'est une garde qui ne fait pas ce que son nom annonce, et le nom est ce que le
prochain lecteur croira. Un verrou d'execution pose sur le LOT est mieux place
qu'une garde par champ pour couvrir ces trois chemins -- a condition que le
verrou soit consulte par les ecritures de `status`, `depends_on` et `locked`,
et pas seulement par celle de `queue`.

**Le cas `directive` a ete arbitre, ne pas le rouvrir.** N'importe quel pair
peut transformer une carte en carte `directive` et lui donner des
`target_peer_ids` ; en tete de file, le Deck l'execute, et `clear` detruit le
contexte des cibles. La chaine depot hostile -> template -> `role: team-lead`
-> directive `clear` a ete portee a l'operateur le 2026-08-25 : **il a decide
de NE PAS la traiter** (l'operateur voit dans l'UI les cartes qui vont etre
jouees ; une carte reellement malveillante equivaut a une execution arbitraire
obtenue autrement ; corriger le fond demanderait de toucher aux
fonctionnalites de Kory). Risque accepte, explicitement.

---

## 5. Fermeture par le type : le bon grain est le CHAMP, pas l'outil

**MESURE** (tsc 5.9.3, sonde `C:/tmp/arch-b313f0c3-probe/p9-tools.ts`,
`--noEmit --strict --target es2022 --moduleResolution bundler --module esnext`)
-- un `as const` sur le tableau des outils rend une union litterale de noms, et
un `Record<ToolName, WriteTier>` incomplet ne compile plus :

```
p9-tools.ts(15,14): error TS2741: Property 'roadmap_queue' is missing in type
'{ roadmap_list: "open"; roadmap_add: "open"; }' but required in type
'Record<"roadmap_list" | "roadmap_add" | "roadmap_queue", WriteTier>'.
```

**MESURE** -- `server.ts:454`, `const TOOLS = [` n'est PAS `as const`
aujourd'hui (seuls les `type: "object" as const` internes le sont), donc `name`
s'elargit en `string` et l'union n'existe pas encore. Le prealable est
d'ajouter `as const` au tableau.

**Mais le niveau "outil" est le mauvais grain.** `roadmap_add` et
`roadmap_update` contiennent CHACUN des champs ouverts et des champs sensibles
(§4). Une table par outil obligerait a verrouiller des outils entiers -- ce qui
fermerait "creer, lire, commenter", qui doivent rester ouverts -- ou a les
declarer ouverts, ce qui laisse passer les champs. Le grain correct est le
**champ** :

```ts
type WriteTier = 'open' | 'reserved-coordination'
const UPSERT_FIELD_TIER: Record<keyof RoadmapUpsertRequest, WriteTier> = { ... }
```

**MESURE** -- `shared/types.ts`, `RoadmapUpsertRequest` est une interface nommee
d'une vingtaine de cles (`id`, `project_key`, `by`, `instance_token`, `kind`,
`title`, ..., `queue`, `locked`, `inactive`). C'est la MEME forme que celle
mesuree sur `SessionDef` (TS2741 / TS2353 / TS1360, voir
`DESIGN-SESSION-FIELD-CAPTURE.md` §5) : aucun nouveau mecanisme a inventer.

Deux precautions, toutes deux issues de la regle de couverture de CLAUDE.md :
1. **Le defaut runtime pour un nom inconnu doit etre RESERVE**, pas ouvert.
   Une table typee ferme l'ajout d'un champ AU COMPILATEUR ; elle ne ferme pas
   un corps de requete portant une cle inattendue.
2. **La table doit couvrir la TROISIEME surface.** `7defe381` nomme
   `handleRoadmapImport` (broker.ts vers 3879) comme ecrivant aussi `queue`.
   Son domaine de champs n'est pas `RoadmapUpsertRequest` : une table posee sur
   le seul upsert laisse l'import hors couverture, et l'import est precisement
   le contournement evident. Auditer, ou exempter en ecrivant pourquoi. **Cette
   surface reste a couvrir par le verrou d'execution exactement de la meme
   facon.**

---

## 6. Ou vit le refus, et de quoi il doit etre fait

**MESURE** -- le canal est deja intact de bout en bout, aucune plomberie a
ajouter. `brokerFetch` (server.ts) fait
`throw new Error('Broker error (' + path + '): ' + res.status + ' ' + err)` en
incluant le CORPS de la reponse ; `roadmapToolError` (server.ts:1097) le rend
en `{ content: [...], isError: true }` avec le texte `Roadmap error: <message>`.
Le texte ecrit par le broker arrive donc verbatim a l'agent.

**MESURE** -- `grep -c "isFrLocale\|i18n\|locale" server.ts broker.ts` rend `0`
et `0`. Le coeur n'a aucune infrastructure de langue.

Recommandation, valable pour n'importe quelle garde :
1. **Le texte vit au BROKER**, dans le refus, parce que c'est le seul endroit
   qui connait la raison reelle (qui detient le verrou, depuis quand). Le
   dupliquer cote `server.ts` creerait deux verites qui divergeront.
2. **En anglais**, comme tout le coeur. La phrase francaise a la premiere
   personne voulue par l'operateur est la ligne de l'AGENT, qui reformule.
   Coder du francais dans le coeur poserait aussi la question pour `cli.ts`.
3. **Un refus, pas une exception muette** : `isError: true`, la convention deja
   utilisee par les six outils roadmap. Le message doit contenir trois choses :
   la raison, le remede (qui peut liberer le verrou, et comment), et
   **l'interdiction de reessayer** -- sans quoi un agent traitera `isError`
   comme un echec transitoire et bouclera.
4. **Piege a fermer explicitement** : le refus ne doit jamais transiter par un
   `catch` qui le degrade en "operation impossible". Le test d'acceptation doit
   verifier le TEXTE recu par l'outil, pas seulement le code HTTP cote broker.

---

## 7. Une mesure a garder, detachee de sa conclusion d'origine

**MESURE citee dans `2e1f6821`** -- `handleRegister` est le SEUL point
d'ecriture du role d'un pair, et `CLAUDE_PEERS_ROLE` est fige au spawn
(`session-service.ts:963`). Le seul moyen actuel de changer le role d'une
session vivante est donc de **la tuer et la relancer**, c'est-a-dire detruire
le contexte chaud que le Deck existe pour preserver.

Cette mesure servait a montrer qu'un refus disant "demande le role team-lead"
nommait un remede destructeur. Le refus par le role n'existe plus, mais la
mesure reste vraie et vaut pour tout message d'erreur, toute UI et toute carte
qui suggererait de "changer le role" d'une session en cours.

---

## 8. Ce qui a ete retire de la version d'origine, et pourquoi

- **La condition unique d'autorisation par le role** ("reserve ssi un pair du
  groupe porte `team-lead` et que l'appelant n'en porte ni `team-lead` ni
  `supervisor`") : sans objet, la conception par le role est abandonnee.
- **Le comptage de R3** (une session seule) et sa fenetre d'instabilite de
  180 s : sans objet pour la meme raison ; la partie generalisable est au §3.
- **L'ordre des prerequis `2e1f6821` / `dae1259e`** : il etait derive de R4
  (produire un refus dont le remede est actionnable). La mesure qui le fondait
  est conservee au §7 ; la conclusion d'ordonnancement ne vaut plus.
- **Les lots recommandes** de la version d'origine : ils decrivaient la
  livraison d'une garde par le role.

Rien de ce qui precede n'a jamais ete commite ; la version integrale n'existe
donc nulle part ailleurs. C'est assume : la reduction supprime des sections qui
auraient fait lire comme actuelle une conception rejetee.

---

## 9. Questions ouvertes

1. **Le verrou d'execution consulte-t-il les trois autres chemins** (`status`,
   `depends_on`, `locked`) ou seulement `queue` (§4) ? Un verrou qui ne garde
   que `queue` porte un nom plus large que son effet.
2. **Le superviseur** (§2) : traite comme un pair quelconque, ou distingue ? La
   phrase fausse du briefing de `7defe381` doit etre corrigee dans les deux cas.
3. **`handleRoadmapImport`** (§5) : couvert par le verrou, ou exempte avec
   motif ecrit ?
4. **Le verrou se libere-t-il quand son detenteur disparait**, et sur laquelle
   des deux definitions de "actif" (§3) ?
