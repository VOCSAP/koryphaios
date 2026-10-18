# Buffer de contexte éphémère : contrat du lot L1 (identité, registre en RAM, dépôt CLI)

Carte `b7ee3194`. Dossier de conception du 2026-10-12, aucun code de production modifié par ce fichier.

Vocabulaire : « L1 », « L2 », « L3 » sont les trois tranches de livraison de CETTE carte. Elles ne désignent pas un Lot au sens de `CLAUDE.md` (objet partagé persisté côté broker). Ne pas les confondre dans le code ni dans les messages de commit.

Étiquettes : **MESURÉ** (commande lancée, sortie citée), **DÉDUIT** (lu dans le code, `fichier:ligne`), **SUPPOSÉ** (non vérifié, à mesurer avant de s'y fier).

## 0. Résumé

1. L'identité de la CLI repose sur une **capacité de dépôt** : un secret aléatoire de 256 bits minté par le Deck à chaque `startPty` et passé en ENV au PTY (`CLAUDE_PEERS_DEPOSIT_CAPABILITY`).
2. Le **server.ts du même lancement** en présente l'empreinte SHA-256 à son `/register` ; le broker la lie, en RAM, au `instance_token` que ce `/register` vient de résoudre. La CLI présente la capacité brute, le broker la hache et retrouve le propriétaire. Le `peer_id` n'entre jamais dans la clé.
3. La « révocation en fin de lancement » n'est PAS un acte du Deck : le broker la **dérive** (pair actif, époque de liaison inchangée). Correction de la formule de la carte, voir §5.2.
4. Le registre est un `Map` en RAM dans le broker, jamais persisté, jamais fédéré, jamais logué. Il n'existe aucun outil MCP, aucune route de lecture du contenu.
5. Une seule route (`POST /context/deposit`), une seule commande (`bun cli.ts context-deposit`), un seul champ ajouté à `/register`, une seule variable d'environnement ajoutée côté Deck.

## 1. Objectif

Permettre à un pair de déposer, par la CLI, un résumé de son contexte utile dans un tampon du broker, sous un identifiant de dépôt, avec une preuve que le dépôt appartient bien à CE pair. L1 livre l'identité, le registre et le dépôt. La transaction de `/clear` et la reprise par push viennent après (L2, L3) et réutilisent exactement ce que L1 fige.

## 2. Hors périmètre

| Hors L1 | Où ça va |
|---|---|
| Directive `clear` portant l'id de dépôt, `prepare`, attente d'une NOUVELLE rotation `SessionStart source=clear`, release idempotent | L2 |
| Push du contenu au seul propriétaire, ACK technique automatique du server, suppression 5 min après le premier ACK, activation, scénario réel par mot témoin | L3 |
| Toute lecture du contenu (route, outil MCP, CLI) | Exclu par décision opérateur |
| Persistance SQLite, fédération, réplication | Exclu par décision opérateur |
| Skill ou instruction destinée à l'agent pour savoir QUAND et COMMENT déposer, découverte du chemin de `cli.ts` par l'agent | À trancher avec L2 (question 6, §19) |
| Lancements SANDBOX | Hors L1 : la capacité est neutralisée (`''`) pour eux, §12 |

## 3. Structure actuelle mesurée

| Frontière | Constat |
|---|---|
| Identité de la CLI | **DÉDUIT**, `cli.ts:3-8` : « 'send' is intentionally absent -- the broker requires a valid instance_token ... which only a registered MCP peer holds ». **DÉDUIT**, `cli.ts:299-311` : `roadmap-add` n'a aucune preuve, `by` est préfixé `cli:` comme revendication non prouvée, et tout `instance_token` du payload est jeté. **DÉDUIT**, `cli.ts:278-281` : la CLI dérive son `project_key` du cwd, pas de la charge utile. La CLI n'a donc AUCUNE identité de pair aujourd'hui. |
| Résolution de config de la CLI | **DÉDUIT**, `cli.ts:15-20` : `loadConfig()` puis `Authorization: Bearer <broker_token>` seulement si un token est configuré. |
| Env des tuiles | **DÉDUIT**, `desktop/src/main/session-service.ts:1461-1474` : `sessionEnv` = scope (`getScopeEnv()`), `CLAUDE_PEERS_DESK_SESSION: def.id`, `CLAUDE_PEERS_ROLE`, `KORY_PERMISSION_LEASE: ''`, `KORY_APPROVAL_MODULE`, TTSR. Les clés sans valeur applicable sont émises à `''`. |
| Neutralisation d'un env hérité | **DÉDUIT**, `desktop/src/main/pty-manager.ts:148-150` : une clé absente de `extraEnv` est supprimée ou forcée à `''` pour qu'une valeur héritée du process Deck ne ressuscite pas la fonction ; `session-service.ts:588` passe `KORY_PERMISSION_LEASE: ''` aux PTY utilitaires. **DÉDUIT**, `approval-runtime.ts:94-99` : même règle (« Always emit the key »). |
| Précédent « une capacité par lancement » | **DÉDUIT**, `desktop/src/main/permission-lease-runtime.ts:50-73` : `createLease(tileId)` mint un `launchId = randomUUID()` ; `session-service.ts:1390` révoque le bail précédent au début de `startPty`, `:1543-1553` en crée un pour les lancements hôte non sandbox de Claude. `session-service.ts:1402` : `startPty` n'a qu'un appelant (`spawnSession`), donc tout lancement passe par lui. |
| Précédent « un credential » | **DÉDUIT**, `approval-runtime.ts:1-4` : le jeton de session d'approbation est minté PAR FENÊTRE, pas par tuile ni par lancement. Il ne convient pas à une propriété par pair. |
| Clé de session du broker | **DÉDUIT**, `broker.ts:1745-1755` et `:2395` : `sessionKey(host, cwd, group, desk_session)`. **DÉDUIT**, `shared/types.ts:123-134` : `desk_session` est « a capability the caller DECLARES, not one it proves ». |
| Collision active au register | **DÉDUIT**, `broker.ts:2475-2505` : si la session_key appartient à un pair actif, le broker mint un NOUVEAU `(peer_id, instance_token)` et ne touche pas `peer_sessions`. Un second process qui hérite l'env d'une tuile (un `claude` imbriqué) devient donc un second pair actif. |
| Un seul site d'appel de `/register` | **MESURÉ**, `aidex_query handleRegister` : `broker.ts:2359` (définition) et `:11486` (route) ; aucun autre appelant, y compris la fédération. |
| Sites de bascule en dormant (pairs locaux) | **MESURÉ**, `grep -n "status = 'dormant'" broker.ts` : `:1810` (PID mort), `:1852` et `:1855` (heartbeat périmé), `:2439` (PID mort au register), `:2590` (`/disconnect`). Les trois autres hits (`:6345`, `:8518`, `:8773`) ne visent que des lignes relayées ou miroirs. Plus `/unregister` (`:2605`) et la purge des dormants (`:1835`). |
| Hook SessionEnd | **MESURÉ**, `Grep SessionEnd` (arbre entier, `node_modules` exclu) : `broker.ts` (commentaire, `:599`) et `desktop/hooks/claude-code-types.ts` (types) seulement ; **MESURÉ**, lecture complète de `desktop/deck-plugin/hooks/hooks.json` : aucun événement `SessionEnd`, un `SessionStart` vers `desk-backchannel-hook.mjs`. Aucun hook SessionEnd n'est câblé. La mesure du debugger (carte, 17:13) reste la référence : `/clear` ne déconnecte pas le pair. |
| Fichier d'identité par tuile | **DÉDUIT**, `shared/peer-cache.ts:151-170` : `session-identity-<desk>.json` contient `peer_id`, `group_id`, `instance_token`, écrit par server.ts, clé = jeton de tuile. Lu par `server-deck.ts:89-113`. |
| Auth HTTP du broker | **DÉDUIT**, `broker.ts:11399-11404` : Origin puis Bearer sur toute route sauf `/health`. `:11475-11481` : le corps est parsé en JSON AVANT le `switch`. `:11848-11852` : le catch 500 logue le chemin et l'erreur, jamais le corps. |
| `toPublicPeer` | **DÉDUIT**, `broker.ts:2657-2676` : liste blanche ; `instance_token`, `pid`, `client_pid`, `claude_cli_pid`, `relay_*` sont retenus. Le registre n'est pas une colonne de `peers`, donc hors de cette liste. |
| Résolution tuile vers pair côté broker | **DÉDUIT**, `broker.ts:11255-11286` (`handleTilePeers`) : refuse un groupe exempt de TOFU (`:11261`), exige le secret de groupe, et renvoie `null` quand plus d'un pair correspond (`:11280`). Précédent de l'échec fermé sur ambiguïté. |
| Groupe d'une tuile | **DÉDUIT**, `shared/config.ts:561-573` : le groupe forcé par le Deck passe avant `.claude-peers.local.json`, `.claude-peers.json`, `default_group` et `CLAUDE_PEERS_GROUP`. Hors du Deck, ces fichiers du dépôt décident du groupe de server.ts. |
| Env hérité par les sous-processus de Claude Code | **DÉDUIT**, documentation Claude Code `code.claude.com/docs/en/env-vars` (page récupérée le 2026-10-12) : `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, désactivé par défaut, retire les « credentials » des environnements des commandes Bash, des hooks et des serveurs MCP stdio, en reconnaissant un credential « by its variable name or its value ». Sans cette variable, l'env est hérité. |
| Bash d'une tuile réelle voit-il l'env ? | **SUPPOSÉ**. La session qui a produit ce dossier n'est pas une tuile Kory (`env` n'y montre ni `CLAUDE_PEERS_DESK_SESSION` ni `KORY_*`), donc la propagation vers la commande Bash d'un agent de tuile n'est pas mesurée ici. Mesure M1, §16. |

## 4. Forces

1. Le résultat doit être sûr quand il y a deux de tout : deux tuiles dans un même cwd, deux fenêtres Kory, un `claude` imbriqué qui hérite l'env, un renommage `set_id`, une résurrection, un second lancement de la même tuile.
2. L'identité doit survivre à `/clear` (même process MCP, même pair, mesuré par le debugger) et mourir avec le lancement.
3. Un contenu volumineux et potentiellement sensible ne doit exister que dans la RAM du broker, ne transiter par aucun chemin loggé ou persistant, et n'être lisible par personne d'autre que son pair auteur.
4. Plus petit changement : pas d'outil MCP, pas de table, pas de route Deck, un champ de plus au register.

## 5. Modèle d'identité

### 5.1 Options

| | Option | Verdict |
|---|---|---|
| **A** | **Capacité par lancement, minée par le Deck, passée en ENV ; empreinte présentée par le server.ts du même lancement à son `/register` ; liaison en RAM ; vivacité dérivée.** | **Retenue.** |
| B | Le Deck mint la capacité ET l'enregistre auprès du broker (route signée), le broker retrouve le pair par `desk_session_hash`. C'est la lettre de la carte. Rejetée : (1) exige une nouvelle route authentifiée Deck vers broker et un échec « broker absent au lancement » ; (2) retrouve le pair par un identifiant DÉCLARÉ (`shared/types.ts:123-134`) ; (3) dans la branche de collision active (`broker.ts:2475-2505`) `peer_sessions` n'est pas mis à jour, donc un `claude` imbriqué serait attribué EN SILENCE au pair de la tuile, et son résumé serait poussé au mauvais process ; (4) ajoute une seconde voie de révocation qui peut diverger de la vie réelle du pair. |
| C | La CLI lit `session-identity-<desk>.json` (`peer-cache.ts:151-170`) et présente l'`instance_token`. Rejetée : fichier clé par TUILE, dernier écrivain gagnant ; `server.ts:2499-2503` le supprime au boot et `:2626-2636` à la sortie, donc un `claude` imbriqué écrase puis efface celui du père ; l'`instance_token` est stable d'un lancement à l'autre (résurrection), donc ne distingue pas les lancements ; et il livre à un sous-processus d'agent un credential que le design garde hors de sa portée. |
| D | Identité déclarée (`--by`, `peer_id`), comme `roadmap-add` (`cli.ts:299-311`). Rejetée : revendication non prouvée, et `peer_id` est mutable (`set_id`, `broker.ts:2608-2650`). |
| E | Jeton de session d'approbation existant. Rejeté : minté par fenêtre (`approval-runtime.ts:1-4`), pas par pair. |
| F | Correspondance par ancêtre de processus (`claude_cli_pid`). Rejetée comme identité (non portable sous Windows, falsifiable) ; retenue seulement comme RAFFINEMENT possible du cas « contesté », §6 et §19. |
| G | Outil MCP. Exclu par décision opérateur. |

Pourquoi A : le secret ne vit que dans l'env d'un lancement, la liaison est affirmée par le seul process qui le détient et qui parle déjà au broker de façon authentifiée (`instance_token`), et l'ambiguïté (deux pairs vivants derrière la même capacité) est détectable et traitée en échec fermé, ce que B et C ne permettent pas.

### 5.2 Ce qui change par rapport à la formule de la carte

La carte dit : « mintée par le Deck par lancement, passée en ENV au PTY, liée au peer côté broker, révoquée en fin de lancement ».

- **Validé** : mintée par le Deck, par lancement (au `startPty`, à côté du bail de permission, `session-service.ts:1543-1553`), passée en ENV, liée au pair côté broker.
- **Corrigé, la liaison** : elle n'est pas posée par un appel du Deck au broker mais par le `/register` du server.ts qui hérite de l'env. Le broker n'a ainsi jamais besoin de croire le Deck sur « quel pair est quoi ».
- **Corrigé, la révocation** : le Deck n'a rien à révoquer. Le broker dérive la vivacité d'une capacité de deux faits qu'il possède déjà : le pair propriétaire est `active`, et la liaison porte la même **époque** que le dépôt (§8.3). Un nouveau lancement ou un `/register` de plus change l'époque ; une bascule en dormant (cinq sites, §3) ou un `/disconnect` rend le pair non actif. Aucun de ces sites n'est modifié, donc aucun ne peut être oublié.

## 6. « Que se passe-t-il quand il y en a deux ? »

| Cas | Comportement retenu | Mécanisme |
|---|---|---|
| Deux tuiles, même cwd, même groupe | Capacités distinctes, pairs distincts (la clé de session inclut `desk_session`, `broker.ts:2395`). Chaque CLI n'atteint que son pair. Les quotas et les `--replace` sont par propriétaire. | Résolution : capacité → empreinte → pairs actifs liés → un seul. |
| Une personne, deux fenêtres Kory | Groupes distincts par défaut (le groupe est le RUN, `CLAUDE.md`), capacités distinctes. Avec `--scope <id>` partagé le groupe est identique, les capacités restent distinctes : aucune confusion, l'autorisation passe par le propriétaire du dépôt et non par le groupe. | Le groupe n'est jamais fourni par la CLI. |
| Deux identités pour un même humain sur un broker partagé | Aucune hypothèse « un humain = un groupe » n'est faite : la route ne prend ni groupe, ni opérateur. | Idem. |
| `set_id` entre le dépôt et la reprise | Le dépôt reste attaché. La clé est `instance_token` + époque, jamais `peer_id`. Le `peer_id` n'est lu qu'à la fabrication de la réponse. | §8.1. |
| Même tuile relancée (restart, resume, restore) | Nouvelle capacité à chaque `startPty`. Le pair est le même `instance_token` (résurrection) mais le `/register` apporte une nouvelle empreinte donc une nouvelle époque : les dépôts de l'ancien lancement sont purgés, l'ancienne capacité répond 401. | §8.3. |
| Reconnexion MCP dans le même process Claude (même env, même empreinte) | Nouveau `/register` donc nouvelle époque : les dépôts précédents sont purgés. Conforme à « purge à la déconnexion du peer ». | Époque incrémentée à CHAQUE `/register`. |
| Résurrection d'un pair dormant par `cc_session_id` (Restore) | Le jeton peut être réutilisé sous une autre tuile. Même règle : l'empreinte ou l'époque change, rien ne survit. | Idem. |
| `claude` imbriqué ou coéquipier d'agent-teams qui hérite l'env d'une tuile | Il s'enregistre comme second pair ACTIF avec la MÊME empreinte. Tant que les deux sont actifs, la capacité est **contestée** : 409 `contested`, rien n'est stocké. Quand l'un s'arrête, l'autre redevient unique. Choisir « le premier gagne » aurait attribué en silence le contexte de l'imbriqué au pair de la tuile. | Compte des pairs actifs liés à l'empreinte, calculé à chaque appel. |
| Même CLI lancée deux fois dans la même tuile | Même capacité, même propriétaire : les deux dépôts comptent dans son quota. | Propriétaire unique. |
| Un autre pair, sans capacité | 401. Il ne peut ni déposer, ni remplacer, ni savoir si un identifiant existe (404 identique pour inconnu et étranger). | §9. |
| Broker redémarré | Registre et liaisons perdus ; les lignes `peers` persistent mais server.ts ne se réenregistre pas (**DÉDUIT**, `server.ts` n'appelle `/register` qu'au boot `:2538` et dans `switch_group` `:2060`). Les dépôts échouent en 401 jusqu'au prochain lancement. Refus explicite, jamais silencieux. Un re-lien sur heartbeat fermerait ce trou, question 3, §19. | RAM seule. |

## 7. Les cinq entrées hostiles

| Entrée | Classe | Traitement |
|---|---|---|
| Fichiers du dépôt cloné (`.claude-peers.json`, `.claude-peers.local.json`, `.claude/claude-peers/config.json`, `templates/*.json`) | 1 | **Jamais lus par le chemin de dépôt.** La CLI n'envoie aucun groupe, aucun projet, aucun pair : l'identité est la seule capacité. Test : un `.claude-peers.json` hostile dans le cwd ne change pas le corps de la requête (A19). |
| Valeurs dérivées de git par la CLI (`HEAD`, branche, racine) | 1, par ricochet | Obtenues avec `Bun.spawn` en argv (aucun shell). Le broker les REVALIDE : SHA `^[0-9a-f]{40}$` ou `^[0-9a-f]{64}$` ; branche et racine bornées, sans caractère de contrôle, sinon 400 (jamais corrigées en silence). Ce sont des revendications du client, non des preuves. |
| Champs de message ou de pair vers la frontière HTTP | 2 | Un dépôt n'est pas un message : aucun `from_token`/`to_token`. La réponse ne contient ni `instance_token`, ni PID, ni empreinte de capacité. `owner_peer_id` est le champ déjà public de `toPublicPeer`. Le registre n'est jamais sérialisé par `/admin/peers`, `/health`, `/group-stats`. |
| Argument IPC renderer ou compagnon vers un chemin | 3 | Aucun canal IPC ajouté en L1. `--input <fichier>` est un argument d'agent lu par la CLI : fichier régulier seulement (pas de FIFO ni de périphérique), plafond d'octets avant lecture. Aucun nouvel accès : l'agent peut déjà lire ce fichier. |
| Chaîne d'agent vers `executeJavaScript`, page, terminal, ligne de commande | 4 | Le texte déposé est une CHAÎNE D'AGENT qui peut recopier du contenu hostile du dépôt (blanchiment d'injection). En L1 elle n'est qu'une donnée en RAM. **Contrainte L3** : poussée comme message de canal, cadrée comme « contexte sauvegardé par vous, daté, à revérifier », jamais comme consigne, jamais frappée dans le PTY (`pty.write`), jamais transmise au Deck ni au renderer. |
| Tout ce qui est MONTÉ dans un sandbox | 5 | Rien n'est monté. Les lancements sandbox reçoivent `''` (le chemin hook d'approbation est déjà indisponible en sandbox, `DESKTOP.md:148-151`). Un agent supposé compromis ne reçoit donc pas la capacité. |
| Variable d'environnement `CLAUDE_PEERS_DEPOSIT_CAPABILITY` | capacité | Toujours émise, `''` quand non applicable (même règle que `KORY_PERMISSION_LEASE`), jamais persistée dans le workspace du Deck, jamais écrite dans un log, jamais envoyée au broker au register (seule l'empreinte l'est). Lisible par tout process du même compte via `/proc/<pid>/environ` ou équivalent : la capacité ne vaut que « déposer dans mon propre tampon », ce qui ne justifie pas le transport par fichier chmod 600 du secret de groupe. |
| Corps de la route de dépôt | 4 | Borne d'octets lue sur `Content-Length` AVANT le `req.json()` (`broker.ts:11475-11481` parse avant le `switch`) ; sans `Content-Length`, refus 400 ; chaîne bien formée (pas de surrogate isolé), sans contrôle sauf `\n`, `\t`, `\r`, sans contrôle bidirectionnel ni séparateur de ligne Unicode. Refus, jamais nettoyage silencieux. |

## 8. Le registre

### 8.1 Clé et forme

Clé primaire : `deposit_id`, 16 caractères hexadécimaux aléatoires (`randomBytes(8)`), unique dans tout le broker, régénéré en cas de collision. Index secondaire : par `owner_instance_token`.

```ts
// Forme logique. Types et noms définitifs : à l'implémentation.
interface ContextDeposit {
  deposit_id: string;
  group_id: string;              // copié du pair propriétaire à la création
  owner_instance_token: string;  // l'autorité. Jamais peer_id, jamais cwd, jamais desk_session
  epoch: number;                 // époque de liaison du propriétaire à la création
  text: string;
  chars: number;                 // points de code
  head_at_deposit: string | null;
  branch: string | null;
  git_root: string | null;
  deposited_at: string;          // horloge du broker, jamais celle de la CLI
  state: "held";                 // seul état en L1 ; L2 et L3 l'élargissent
}
```

Ce que la clé NE contient pas, et pourquoi (« keyed by what ») : pas le `peer_id` (mutable), pas le cwd ni `desk_session` (déclarés, partagés par un `claude` imbriqué), pas le groupe seul (deux pairs par groupe), pas la capacité (rotation à chaque lancement).

### 8.2 Liaisons

```ts
// RAM, côté broker, aucune colonne SQLite.
bindings: Map<instance_token, { capability_hash: string; epoch: number }>
byHash:   Map<capability_hash, Set<instance_token>>
```

Pose : un seul site, l'enrobage de la route `/register` (`broker.ts:11485-11491`), APRÈS un `handleRegister` réussi, avec `result.instance_token` et le champ `deposit_capability_hash` du corps. Les quatre branches de retour de `handleRegister` (`:2468`, `:2504`, `:2530`, `:2555`) sont ainsi couvertes par un seul point, au lieu de quatre éditions dont une peut être oubliée.

Règles à chaque `/register` :
1. Groupe exempt de TOFU (`default`) : aucune liaison (le Deck pose toujours un secret ; même précédent que `broker.ts:11261`). Les dépôts éventuels du jeton sont supprimés.
2. Empreinte absente ou mal formée (64 hexadécimaux minuscules exigés) : aucune liaison, avertissement, dépôts du jeton supprimés.
3. Empreinte valide : `epoch` du jeton incrémenté (toujours, même empreinte identique), liaison remplacée, dépôts du jeton supprimés (ils appartiennent à l'époque précédente), index `byHash` mis à jour.

### 8.3 Vivacité dérivée

Un dépôt est **vivant** si et seulement si : le pair `owner_instance_token` existe avec `status = 'active'`, ET `bindings.get(token)?.epoch === deposit.epoch`.

Un seul filtre `live()` est appliqué par TOUTE méthode publique du registre (créer, remplacer, compter pour un quota, décrire, prendre pour push). Les dépôts morts sont supprimés au passage. Un balayage périodique (`guardedInterval`, même cadence que `cleanStalePeers`) libère la RAM des propriétaires disparus, et `/disconnect` et `/unregister` purgent immédiatement pour que la RAM libérée suive « à la déconnexion ». Les cinq sites de bascule en dormant ne sont pas touchés : le prédicat les couvre par construction, et le balayage rattrape le reste.

### 8.4 Plafond, quotas, refus

Toutes ces valeurs sont des constantes NOMMÉES et RÉGLABLES, sans copie littérale dans le code, les tests, les commentaires ou la doc.

| Constante | Rôle | Valeur initiale |
|---|---|---|
| `CONTEXT_DEPOSIT_MAX_CHARS` | Plafond par dépôt, en points de code. **Une seule constante nommée**, dans `shared/context-buffer.ts`, importée par la CLI, le broker et les tests. Plafond réglable, initialement fixé à 4000 par l'opérateur, à relever selon l'usage. | 4000 (réglable) |
| `CONTEXT_DEPOSIT_MAX_BODY_BYTES` | Borne d'octets du corps, DÉRIVÉE de la précédente (pire cas UTF-8 par point de code, plus une marge de champs). Aucune seconde valeur à maintenir. | dérivée |
| `CONTEXT_DEPOSITS_PER_OWNER` | Dépôts vivants simultanés par pair | 3 |
| `CONTEXT_DEPOSITS_PER_GROUP` | Dépôts vivants par groupe | 96 |
| `CONTEXT_DEPOSITS_TOTAL` | Dépôts vivants dans tout le broker | 256 |

Les trois quotas sont des valeurs de conception **SUPPOSÉES**, non mesurées. Refus au-delà du plafond ou d'un quota : jamais de troncature, jamais d'éviction silencieuse, jamais de remplacement implicite. Le seul retrait est un `--replace <deposit_id>` explicite du propriétaire (§9) ; c'est un ajout de l'architecte, retirable sans toucher au reste (question 4, §19).

Ordre de contrôle : forme du corps, capacité, plafond de caractères, contenu, quota par propriétaire, quota par groupe, quota global.

## 9. Route du broker

`POST /context/deposit`, derrière Origin et Bearer comme toute route (`broker.ts:11399-11404`).

Requête :

```json
{
  "deposit_capability": "<64 hexadécimaux>",
  "text": "<contenu>",
  "replace": "<deposit_id propre, optionnel>",
  "head": "<sha ou null>", "branch": "<ou null>", "git_root": "<ou null>"
}
```

Réponse 200 :

```json
{
  "ok": true, "deposit_id": "...", "owner_peer_id": "...", "chars": 0,
  "limit_chars": 0, "deposited_at": "...", "head_at_deposit": "..." ,
  "state": "held", "replaced": "<id ou absent>",
  "held": [{ "deposit_id": "...", "chars": 0, "deposited_at": "..." }]
}
```

`limit_chars` vient de la constante. `held` ne liste que les dépôts du propriétaire (métadonnées seules, jamais le texte).

Refus (corps `{ "error": "<phrase>", "reason": "<code>", ... }`) :

| HTTP | `reason` | Quand |
|---|---|---|
| 400 | `bad_body`, `empty_text`, `ill_formed_text`, `forbidden_characters`, `bad_git_fact`, `bad_replace_id`, `length_required` | Corps invalide |
| 401 | `capability` | Capacité absente, mal formée, inconnue, pair non actif, liaison absente. Un seul code pour ne pas servir d'oracle. |
| 404 | `replace_not_found` | `replace` inconnu OU appartenant à un autre propriétaire (réponse identique) |
| 409 | `contested` | Plusieurs pairs actifs derrière la même empreinte |
| 413 | `too_long`, `body_too_large` | Plafond dépassé. `too_long` porte `max_chars` et `got_chars`. Rien n'est stocké. |
| 429 | `quota_owner`, `quota_group`, `quota_total` | Quota atteint. `quota_owner` liste les identifiants détenus pour permettre `--replace`. |

Le texte, la capacité et ses empreintes n'apparaissent dans AUCUN message d'erreur ni journal.

Interface interne de L2 et L3 (module, pas route) : `describe(deposit_id)` rend les métadonnées d'un dépôt vivant sans le texte ; seul `takeReleasedForResume(deposit_id, released_attempt_id)` donne accès au texte, pour la reprise corrélée et non acquittée d'un dépôt vivant. L'accès large `takeForPush` est supprimé. Aucune route Deck n'est ajoutée en L1.

## 10. Liaison côté server.ts

`server.ts` lit `process.env.CLAUDE_PEERS_DEPOSIT_CAPABILITY`. Si la valeur est vide ou n'a pas la forme attendue, le champ est omis. Sinon il envoie `deposit_capability_hash = sha256(valeur)` en hexadécimal dans le corps de `/register`, aux DEUX sites qui construisent ce corps : le boot (`server.ts:2538-2559`) et `switch_group` (`server.ts:2060-2082`). Précédent de la règle « les deux sites ou aucun » : `role` et `desk_session`, commentaires `server.ts:2070-2079`. La valeur brute n'est jamais envoyée ni loguée.

Compatibilité : un broker ancien ignore le champ (le corps est un cast nu, `broker.ts:11486`) ; un server.ts ancien ne l'envoie pas, la CLI reçoit 401. Les deux sens dégradent en refus explicite.

## 11. Commande CLI

```
bun <repo>/cli.ts context-deposit --input <fichier|-> [--replace <deposit_id>]
```

- `--input <fichier>` : fichier régulier, UTF-8. `--input -` : stdin. Obligatoire.
- `--replace <deposit_id>` : remplace explicitement un dépôt vivant du même propriétaire, de façon atomique.
- Aucun autre drapeau. En particulier PAS de `--by`, `--group`, `--project-key`, `--token`, `--peer` : l'identité vient de la seule capacité. Un drapeau inconnu fait échouer avec le code 2.

Étapes : (1) lire `CLAUDE_PEERS_DEPOSIT_CAPABILITY` et vérifier sa forme ; absente ou mal formée, sortie immédiate code 5 SANS appel réseau ; (2) lire le texte avec un plafond d'octets ; (3) lire `HEAD`, branche et racine par `git` en argv dans `process.cwd()` (hors dépôt : trois `null`, ce n'est pas une erreur) ; (4) `POST /context/deposit` avec `loadConfig()` et `authHeaders()` comme les autres verbes.

Codes de retour :

| Code | Sens |
|---|---|
| 0 | Dépôt stocké |
| 1 | Broker injoignable, erreur réseau, 5xx ou 401 d'authentification bearer du broker (distinct du refus `capability`) |
| 2 | Usage : drapeau inconnu, entrée absente, illisible, vide, non régulière, trop volumineuse en octets |
| 3 | Texte trop long (`too_long`) ou contenu refusé (`empty_text`, `ill_formed_text`, `forbidden_characters`) |
| 4 | Quota (`quota_owner`, `quota_group`, `quota_total`) ou `replace_not_found` |
| 5 | Identité : pas de capacité dans l'env, capacité refusée (401), capacité contestée (409) |

Sortie, lignes `clé: valeur` stables pour un agent. Succès sur stdout :

```
context-deposit: stored
deposit_id: <16 hex>
peer_id: <owner_peer_id>
chars: <n> (limit <limit_chars>)
deposited_at: <ISO 8601>
head_at_deposit: <sha ou none>  branch: <nom ou none>
kept: memory of the broker only; dropped when this session disconnects or relaunches; never written to disk
next: give this deposit_id to the lead. Do not run /clear yourself.
```

Refus sur stderr, première ligne `context-deposit: refused (<reason>)` puis une ligne de remède propre à la cause. Exemples : `too_long` indique `got_chars` et `limit_chars` et demande de raccourcir (ordre de la consigne mesurée : prochaine action, état, décisions) ; `quota_owner` liste les identifiants détenus et propose `--replace` ; `capability` explique que la capacité est absente ou invalide, ou que sa liaison à un pair actif manque (notamment hors lancement Kory ou en sandbox) ; `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` conserve la variable `_CAPABILITY` et ne suffit donc pas à expliquer ce refus (§16 M1) ; `contested` dit qu'une seconde session vivante partage cette capacité (session imbriquée ou coéquipier) et qu'il faut la terminer. La capacité, le texte et l'empreinte ne sont JAMAIS imprimés.

## 12. Côté Deck

- Nouveau module pur `desktop/src/main/deposit-capability.ts` (sans import Electron, testable sous bun) : le nom de la variable, `mintDepositCapability()` (32 octets aléatoires, 64 hexadécimaux).
- `session-service.ts`, dans `startPty` : clé initialisée à `''` dans le littéral `sessionEnv` (`:1461-1468`, comme `KORY_PERMISSION_LEASE`), puis valeur minée ici, à côté du bail (`:1543-1553`), pour `!sandboxed && isClaudeLaunch(base)`. Le superviseur (jamais sandboxé) en reçoit une. Aucune table, aucun handle, rien à révoquer : la valeur n'existe que dans `sessionEnv`, jamais dans `def` ni dans le workspace persisté.
- `pty-manager.ts`, ligne voisine de `:150` : clé absente de `extraEnv` forcée à `''`. `spawnUtility` (`session-service.ts:588`) l'ajoute à ses `extraEnv`.
- Sandbox : `''`. Lancement non Claude : `''`.
- Le Deck n'appelle pas le broker pour cela et n'en reçoit jamais le texte.

## 13. Fichiers à toucher

| Fichier | Nature |
|---|---|
| `shared/context-buffer.ts` (nouveau) | Constantes (`CONTEXT_DEPOSIT_MAX_CHARS`, dérivée en octets, quotas, nom de variable), `hashCapability`, `isCapabilityShape`, comptage en points de code, validation du texte et des faits git, types de fil |
| `shared/context-registry.ts` (nouveau) | Classe pure `ContextRegistry` et `LaunchBindings` ; vivacité et horloge injectées |
| `broker.ts` | Enrobage de `/register` (liaison), route `/context/deposit`, borne de `Content-Length` avant `req.json()` pour ce chemin, purge dans `handleDisconnect` et `handleUnregister`, balayage `guardedInterval` |
| `shared/types.ts` | `RegisterRequest.deposit_capability_hash?` (jamais traité comme preuve d'autorisation en soi, même mise en garde que `desk_session`) |
| `server.ts` | Envoi de l'empreinte aux deux `/register` |
| `cli.ts` | Verbe `context-deposit`, entrée d'aide |
| `desktop/src/main/deposit-capability.ts` (nouveau) | Minage et nom |
| `desktop/src/main/session-service.ts` | Minage dans `startPty`, valeur par défaut `''`, `spawnUtility` |
| `desktop/src/main/pty-manager.ts` | Neutralisation d'une valeur héritée |
| `ARCHITECTURE.md` | Section du tampon : identité, vivacité dérivée, local par construction. Une ligne dans le modèle d'identité |
| `DESKTOP.md` | Une ligne sur la variable et le sandbox |
| `tests/` | Voir §15 |

Aucun changement : `toPublicPeer`, schéma SQLite, `FederatedPeer`, `FederatedMessage`, outils MCP, canaux IPC `DeckApi`.

## 14. Critères d'acceptation

Chaque critère se vérifie par une commande ou un test nommé au §15.

1. **Dépôt nominal.** Avec une capacité liée à un pair actif, `POST /context/deposit` d'un texte dont la longueur ne dépasse pas la limite rend 200 avec `deposit_id`, `chars`, `limit_chars`, `deposited_at`, `owner_peer_id`, `state: "held"`, et le registre détient une entrée au nom de ce jeton.
2. **Plafond sans troncature.** Un texte d'exactement `CONTEXT_DEPOSIT_MAX_CHARS` points de code est accepté ; un de plus est refusé 413 `too_long` avec `max_chars` égal à la constante importée et `got_chars` exact ; rien n'est stocké. Le comptage se fait en points de code (un test utilise des caractères hors plan de base). Aucun test n'écrit la valeur numérique en littéral.
3. **Contenu refusé, jamais corrigé.** Texte vide ou blanc, surrogate isolé, caractère de contrôle autre que `\n`, `\t`, `\r`, contrôle bidirectionnel, séparateur de ligne Unicode : 400 avec un `reason` distinct, rien de stocké.
4. **Quotas sans éviction.** Chacun des trois quotas refuse en 429 avec son `reason` ; le contenu du registre est identique avant et après le refus ; aucune entrée n'est retirée.
5. **Remplacement explicite.** `replace` d'un dépôt propre est atomique (le quota est évalué après retrait ; en cas d'échec la cible reste) ; `replace` d'un identifiant inconnu et d'un identifiant étranger rendent la même réponse 404.
6. **Capacité inconnue.** Absente, mal formée, inconnue, liaison absente, pair dormant : 401 `capability`, rien de stocké. Une capacité de groupe exempt de TOFU ne lie jamais.
7. **Liaison sur les quatre branches de `/register`.** Inscription neuve, résurrection d'un dormant, réinsertion après purge, collision active : chacune lie l'empreinte au jeton retourné. Une empreinte absente ou mal formée supprime la liaison précédente et les dépôts du jeton.
8. **Deux tuiles, même cwd.** Capacités distinctes : le dépôt, le quota et le `replace` de l'une n'affectent jamais l'autre ; une capacité ne peut ni décrire ni retirer le dépôt de l'autre.
9. **Contesté.** Deux pairs ACTIFS derrière la même empreinte : 409 `contested`, rien de stocké ; dès que l'un est dormant, l'autre dépose.
10. **Renommage.** `set_id` entre un dépôt et la lecture suivante ne le détache pas ; aucun champ `peer_id` n'est stocké dans l'entrée.
11. **Nouveau lancement et reconnexion.** Un `/register` du même jeton avec une autre empreinte, ou avec la même, supprime ses dépôts antérieurs ; l'ancienne capacité répond 401 dans le premier cas.
12. **Départ du pair.** Pour chacun des sites `/disconnect`, PID mort (`cleanStalePeers`), heartbeat périmé (`sweepInactivePeers`), `/unregister` : le dépôt est refusé en 401 immédiatement (prédicat) et l'entrée n'existe plus après au plus un balayage du registre.
13. **Jamais persisté.** Après dépôt, ni le fichier SQLite ni son WAL ne contiennent le texte témoin ; après redémarrage du broker, le dépôt n'existe plus ; le module du registre n'importe aucun accès à la base.
14. **Jamais fédéré.** Broker en mode replica : le corps des appels vers l'amont (`/federation/sync`, `/federation/send`, sync de feuille de route) ne contient ni le texte ni l'empreinte ; un corps de `/federation/sync` portant `deposit_capability_hash` pour un pair ne lie rien ; une capacité ne résout jamais un pair relayé ou miroir.
15. **Jamais logué ni publié.** Texte témoin et capacité brute absents de la sortie des journaux du broker (y compris sur un chemin 500 provoqué), de `/admin/peers`, `/health`, `/group-stats` et de tout corps d'erreur.
16. **Capacité jamais stockée brute.** Le broker ne conserve que l'empreinte ; aucune réponse ne la contient.
17. **server.ts.** Les deux `/register` (boot et `switch_group`) portent `deposit_capability_hash = sha256(env)` ; valeur vide ou mal formée : champ omis ; la valeur brute n'est ni envoyée ni loguée. Les deux corps sont comparés comme ENSEMBLES de clés.
18. **CLI.** Syntaxe et codes de retour du §11 ; sans capacité dans l'env, code 5 et ZÉRO requête reçue par un faux broker ; sortie à lignes `clé: valeur` ; la capacité, le texte et l'empreinte ne sont jamais imprimés ; entrée non régulière ou au-delà de la borne d'octets refusée code 2 ; `--input -` lit stdin ; drapeau inconnu code 2.
19. **La CLI ignore le dépôt.** Avec un `.claude-peers.json` et un `.claude-peers.local.json` hostiles dans le cwd, l'ensemble des clés et des valeurs de groupe/projet de la requête est identique à celui sans ces fichiers (la requête ne porte aucun groupe, projet ni pair).
20. **Faits git.** SHA 40 ou 64 hexadécimaux ou `null` ; hors dépôt les trois faits sont `null` et le code reste 0 ; lancement de `git` en argv, jamais par un shell ; un fait mal formé reçu par le broker est refusé 400.
21. **Deck.** `startPty` émet une valeur de 64 hexadécimaux pour un lancement Claude hôte et `''` pour un lancement sandbox, non Claude, et pour les PTY utilitaires ; une valeur présente dans l'env du process Deck n'atteint jamais une tuile ; deux tuiles, et deux `startPty` de la même tuile, ont des valeurs deux à deux distinctes ; la valeur est absente du workspace persisté et des journaux.
22. **Aucune surface MCP.** Les outils exposés par `server.ts` et `server-deck.ts` et le test de budget de surface MCP sont inchangés.
23. **Un seul filtre.** Chaque méthode publique du registre passe par le filtre de vivacité : un test injecte un propriétaire mort et vérifie que TOUTE méthode publique se comporte comme si l'entrée n'existait pas, en énumérant les méthodes par réflexion pour qu'une méthode ajoutée plus tard échoue le test tant qu'elle n'est pas classée.
24. **Plafond non figé.** La limite est lue de `CONTEXT_DEPOSIT_MAX_CHARS` partout (CLI, broker, réponse, message d'erreur) ; le registre accepte une limite injectée et un test avec une limite arbitraire prouve qu'elle n'est pas codée en dur ; aucun test, commentaire ni paragraphe de documentation ne l'énonce comme immuable.
25. **Mesures.** M1 et M2 du §16 sont exécutées et leur résultat figure dans le message de commit de la livraison qui active le Deck.

## 15. Tests à écrire

| Fichier | Contenu |
|---|---|
| `tests/context-registry.test.ts` | Registre pur : critères 2 (avec limite injectée), 4, 5, 10, 11, 23, 24 ; unicité des identifiants ; époque ; aucune méthode publique hors filtre. |
| `tests/broker-context-deposit.test.ts` | Broker réel : critères 1, 3, 6 à 9, 12 à 16 ; les quatre branches de `/register` ; les cas « deux » (deux tuiles même cwd, deux fenêtres même groupe via scope partagé, renommage, résurrection, contesté puis levé) ; contrôle négatif : un pair sans capacité ; canari dans le fichier SQLite et son WAL ; redémarrage du broker ; mode replica avec amont factice qui enregistre ses requêtes. |
| `tests/server-deposit-capability.test.ts` | Critère 17, avec la comparaison des deux corps de `/register` en ensembles de clés (précédent `server.ts:2074-2079`). |
| `tests/cli-context-deposit.test.ts` | Critères 18 à 20 contre un faux broker HTTP : codes, sortie, zéro requête sans capacité, dépôt hostile, fichier non régulier, borne d'octets, stdin, argv de `git`. |
| `tests/desktop-deposit-capability.test.ts` | Critère 21, sur le modèle de `tests/desktop-permission-lease-lifecycle.test.ts` (corps de `startPty` exécuté, pas relu comme texte) ; contrôle négatif avec une valeur héritée hostile. |
| Existant | Le test de budget de surface MCP et le test qui compare `toPublicPeer` au schéma réel de `peers` doivent rester verts sans modification (critère 22). |

Garde-fous de couverture (`CLAUDE.md`, « A guard needs its COVERAGE audited ») : le critère 23 est la garde de couverture du filtre de vivacité ; sa dégradation sûre est « méthode non classée = test rouge », pas « méthode ignorée ». Une garde par balayage de source (`toContain("fn(")`) est exclue comme preuve des critères 13 et 15 ; ils sont prouvés par un canari mesuré dans les sorties réelles.

## 16. Mesures à faire pendant l'implémentation

- **M1.** Dans une vraie tuile Kory, depuis la commande Bash de l'agent : vérifier la présence de `CLAUDE_PEERS_DESK_SESSION` et `CLAUDE_PEERS_DEPOSIT_CAPABILITY` sans afficher leurs valeurs, puis vérifier que `bun cli.ts context-deposit --input <fichier>` aboutit.
  Comparer avec `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` : le suffixe `_CAPABILITY` est volontaire pour conserver la capacité de dépôt dans les sous-processus malgré le scrub, contrairement au suffixe `_TOKEN`.
  Sur un broker distant exigeant un bearer, le retrait de `CLAUDE_PEERS_BROKER_TOKEN` produit `failed (HTTP 401)` (sortie 1), pas le refus `capability` (sortie 5).
  Sur un broker local sans bearer, le scrub n'empêche pas le dépôt si la capacité reste liée à un unique pair actif : le dépôt appartient à ce pair, il n'est pas anonyme ; les refus des §9 et §14.6 restent applicables si la capacité est invalide.
  Risque accepté (contrainte de sécurité L3, carte `b7ee3194`) : tout processus héritant de l'env peut déposer ou remplacer au nom de la tuile, donc injecter un texte survivant au `/clear` ; le push le cadre comme une donnée datée à revérifier, avec `deposited_at` et l'identifiant du dépôt (§17.7).
- **M2.** Dans une tuile, démarrer un `claude` imbriqué et, si possible, un coéquipier d'agent-teams : confirmer qu'ils s'enregistrent comme pairs actifs avec la même empreinte (donc 409 `contested`), et qu'après leur arrêt la tuile redépose.
- **M3.** Lecture de `--input -` et fins de ligne CRLF sous Windows.
- **M4 (coût).** Taille réelle du pire dépôt (plafond de points de code d'un texte très astral) dans le registre, pour confirmer que les quotas §8.4 tiennent en quelques mégaoctets.

## 17. Contrat de reprise L3 : déclenchement, transport et garantie

**Statut : contrat de conception ratifié sur B2 et C1, pas constat de livraison.** Décision opérateur transmise par le lead le 2026-10-16 : **C1 seul**, push sans outil de lecture, ACK technique puis purge à +300 s ; C3 est rejetée. B2 (rejeu à la reconnexion WS tant que le propriétaire reste actif) est ratifiée au titre de la décision opérateur du 2026-10-12 : garde jusqu'à la déconnexion, sous quotas, sans TTL avant ACK. **Garantie limitée :** une perte silencieuse entre notification et modèle reste possible ; cette limite doit être écrite au journal sans contenu du dépôt, jamais présentée comme « modèle a lu ». Le journal documente la limite, il ne détecte pas une perte que le protocole ne signale pas.

### Contraintes communes (numérotation conservée)

1. **Le propriétaire est `(owner_instance_token, epoch)`.** Résoudre d'abord l'OBJET (le dépôt), puis vérifier le droit sur cet objet. Le `peer_id` sert à désigner la cible de la directive, jamais à router le texte, acquitter ou conserver un dépôt.
2. **Le Deck ne reçoit que les métadonnées.** La transaction exige le credential opérateur signé et le secret du groupe ; aucune réponse de transaction, erreur ou journal ne contient le texte. Aucun outil de lecture ni chemin pull n'est ajouté.
3. **Réservation et reprise sont deux protections différentes.** `held` est remplaçable ; `reserved` protège la tentative avant la barrière. L3 ajoute `resuming`, non remplaçable et non réservable, pour protéger la tentative libérée avec succès jusqu'à sa purge. Le TTL de réservation ne s'applique pas à `resuming`. La purge du propriétaire (fin, dormance, changement d'époque) reste prioritaire ; la seule perte de WS n'est pas une fin de propriétaire (§17.B).
4. **Barrière de clear.** Le Deck doit observer la nouvelle rotation `SessionStart source=clear`, corrélée à la tuile et aux identifiants de session de référence. **DÉDUIT**, `desktop/src/main/directive-run.ts:98-109` : la baseline est lue avant l'injection et `waitForClearBackchannel` est attendu après ; le broker ne reçoit pas ce résultat dans le release actuel (`:118`). L3 transporte cette attestation par `cleared`, pas par `pty.write` ni par un délai.
5. **Transport dédié au seul propriétaire.** `wsPool.get(owner_instance_token)` est le modèle de routage, pas `pushPeerMessage` : **DÉDUIT**, `broker.ts:3638-3653` et `:3668-3680` utilisent le jeton mais fabriquent des messages ordinaires. Ajouter une variante `context_resume` à `WsFrame` (**DÉDUIT**, `shared/types.ts:1560` ne contient que `WsMessageFrame`). La trame porte `deposit_id`, `attempt_id` (la tentative libérée), les métadonnées de cadrage et le texte, jamais le jeton. Aucun passage dans `messages`, la réplication, le fallback de messages ou leurs logs. **DÉDUIT**, `server.ts:405` logue les 80 premiers caractères d'un message ordinaire : une branche dédiée doit l'éviter, y compris en erreur.
6. **ACK technique, pas ACK de lecture.** Après résolution de `await mcp.notification`, server.ts envoie un ACK authentifié par son `instance_token`, portant `deposit_id` et `attempt_id`. Le broker résout le dépôt puis vérifie propriétaire actif, époque courante, état `resuming`, succès de la libération et égalité avec **`released_attempt_id`**, jamais avec `attempt_id` vidé au release. Aucun ACK inconnu, étranger, précoce ou d'une ancienne tentative ne modifie le registre. Contrat C1 ratifié : premier ACK accepté à `t0`, purge à `t0 + 300 s`, échéance immuable malgré doublons/rejeux ; avant le premier ACK, pas de TTL du dépôt. Cet ACK autorise la purge même sans preuve de lecture modèle ; la limite de perte silencieuse acceptée figure au journal (§17.C).
7. **Cadrage du texte.** Message de canal « contexte sauvegardé par vous le `<deposited_at>`, `head_at_deposit` = `<sha>`, état antérieur à ce moment, revérifier git avant d'agir », jamais une consigne opérateur, jamais du texte frappé dans le PTY.
8. **Entrée agent et refus avant tout clear.** Le nom canonique agent-facing est **`context_deposit_id`** (snake_case comme `peer_ids`/`workstream`). Dans **`parseRunDirectiveArgs` côté Deck**, la présence des alias **`contextDepositId` ou `deposit_id` est refusée en 400**, même si le nom canonique est aussi fourni ; ne jamais les jeter en silence. Si `context_deposit_id` est présent, refuser en 400 si `directive != clear_reload`, si `peer_ids.length != 1` ou si la valeur ne satisfait pas `isDepositIdShape` (y compris `null`, chaîne vide, mauvais type). Valider avant toute réservation/injection. `workstream` garde sa validation existante. Une absence véritable conserve le chemin historique sans dépôt ; une valeur invalide ne doit jamais y retomber. Le nom interne `contextDepositId` et le champ `deposit_id` de la transaction broker ne sont pas des alias agent-facing. Un dépôt absent/inaccessible à la réservation refuse explicitement la directive. **Limite :** ce refus avant clear ne garantit pas la lecture du push après clear (§17.C).
9. **Teams et imbriqués.** La capacité contestée reste un refus, pas un choix arbitraire de propriétaire. Aucun rejeu WS ou ACK ne doit contourner les invariants de propriété/époque.

### 17.A. Déclencheur : le résultat signé de la barrière

**Structure actuelle, DÉDUIT :** `directive-run.ts:94-123` libère dans un `finally` si `attemptId` a été obtenu ; cette libération arrive après succès, injection refusée ou échec de la barrière. Correction du diagnostic initial : un refus de confiance (`:96-97`) précède la réservation (`:99`), donc il n'émet **pas** de release. `broker.ts:2866-2875` n'exige actuellement que l'identifiant de tentative au release. `shared/context-registry.ts:273-277` vide `attempt_id` et conserve `released_attempt_id` ; `:287-293` sélectionne tous les dépôts vivants d'un propriétaire sans filtrer leur état.

| Option | Coût, risque, réversibilité et portée | Décision |
|---|---|---|
| A1. Déduire le succès de tout release, ou pousser dès l'injection PTY | Peu de modifications, mais confond abandon et clear confirmé ; texte envoyé dans l'ancien contexte. Portée : chaque chemin d'échec. Retirer ce comportement ne récupère pas un contexte déjà effacé. | Rejetée. |
| A2. Attestation `cleared` dans le release signé existant | Modification du contrat Deck, transaction et registre ; aucune nouvelle autorité ni nouveau signal hook. Échec fermé possible en cas de version incompatible. | **Retenue.** La barrière reste au composant qui la voit. |

Contrat A2 :

- Le Deck initialise `cleared = false` et ne le passe à `true` **qu'après la résolution de `waitForClearBackchannel`**. Le `finally` transmet ce booléen avec le dépôt et la tentative, couvert par la signature opérateur. Pas de réservation = pas de release. Une erreur après le `/clear` ne permet ni de l'annuler ni de prétendre que le contexte a été restauré.
- Le broker valide le type booléen. Pour la compatibilité avec un ancien Deck, un champ absent signifie **abandon sans push**, jamais succès ; `null`/chaîne/nombre sont refusés en 400. L'activation d'un nouveau Deck exige néanmoins le broker L3, sinon son `cleared:true` serait ignoré par l'ancien contrat ; c'est la sonde `/health` du §18.4 qui ferme ce cas avant la réservation, et le 409 de réservation qui ferme celui d'un propriétaire sans consommateur.
- Une première libération valide fige son résultat : `false` rend `held`, `true` rend `resuming` et conserve `released_attempt_id`. Un doublon de même tentative et même résultat est idempotent. Changer `false` en `true` ou l'inverse pour la même tentative répond 409, sans push ni modification. Tentative expirée/supplantée et dépôt disparu répondent 409 ; une expiration de réservation ne fabrique jamais de succès.
- Seul `takeReleasedForResume(deposit_id, released_attempt_id)` donne accès au texte **du dépôt et de sa tentative libérée**, filtré par vivacité/époque, résultat `cleared:true`, état `resuming` et absence d'ACK. L'accès large `takeForPush` est supprimé. Résoudre le jeton propriétaire depuis l'entrée, pas depuis une cible fournie au push. Une énumération de reprise à l'auth WS ne rend que des identifiants admissibles ; chaque lecture de texte repasse par cet accès exact.
- Après la transition réussie, tenter l'envoi dédié (§17.B). Un doublon HTTP de release ne déclenche pas une seconde notification à lui seul. `resuming` bloque `replace` et une seconde réservation pendant toute la rétention : un ACK tardif ne peut donc effacer un nouveau cycle du même dépôt.

### 17.B. Propriétaire actif sans socket : attendre l'auth WS, sans ressusciter un dépôt

**MESURÉ :** `bun test ./tests/broker-websocket.test.ts` donne `4 pass`, `0 fail`, `9 expect() calls`. Le cas `pending messages flush on reconnect` (`tests/broker-websocket.test.ts:90-125`) enregistre un pair, lui adresse deux messages sans WS, puis authentifie sa WS et les reçoit. Cette mesure prouve le cas « pair enregistré sans WS » pour les messages ordinaires ; elle ne prouve ni une coupure au milieu d'un vrai `/clear`, ni le futur rejeu de contexte L3.

**DÉDUIT :** `broker.ts:11654-11661` ajoute la socket au pool lors de la trame **`auth` WS** puis, sur `close`, retire seulement cette socket. Ce n'est pas une route HTTP `/auth`. Les appels `forgetOwner` visent `/disconnect` et `/unregister` (`:11794-11803`). `server.ts:412-416` programme une reconnexion WS après fermeture et `:348-349` réauthentifie le même jeton. Une coupure WS peut donc laisser un propriétaire actif et un dépôt vivant ; assimiler toute fermeture WS à `forgetOwner` serait incorrect.

| Option | Coût, risque, réversibilité et portée | Décision |
|---|---|---|
| B1. Refuser la reprise dès que la socket est absente | Moins de logique de rejeu ; erreur visible, mais après la barrière le clear a déjà eu lieu. Un précontrôle WS ne ferme pas la course entre contrôle et envoi. | Rejetée comme seul mécanisme. |
| B2. Garder la reprise en RAM et la retenter à la prochaine auth WS du propriétaire | Ajoute un point de flush dédié et des métadonnées d'ACK ; peut produire un doublon si l'ACK se perd. Ne change pas la durée de vie du propriétaire ni les quotas. | **Retenue et ratifiée**, au titre de la décision opérateur du 2026-10-12. Une panne de transport n'est pas une fin de lancement. |

Contrat B2 :

- Au release réussi, socket absente/non ouverte ou envoi échoué = dépôt `resuming`, **en attente**, sans ACK synthétique ni perte de texte. La réponse de transaction reste sans contenu et distingue « en attente de transport » de « trame envoyée » ; aucune des deux ne signifie « modèle a lu ». Un échec d'envoi est tracé sans texte dans le log broker ; le Deck rapporte la reprise différée via son `reportError`/journal, pas comme une restauration réussie.
- Après une trame `auth` WS validée et `wsPool.set`, lancer le flush **RAM dédié** des reprises non acquittées de CE jeton. Ne pas les insérer dans `flushPendingForToken`, qui reste le chemin des messages ordinaires. Revalider le dépôt et `released_attempt_id` juste avant de lire/envoyer ; jamais de diffusion au groupe.
- Un ACK perdu autorise un rejeu au prochain auth WS. Le server garde une déduplication en RAM par `(deposit_id, attempt_id)` : après une notification déjà résolue, il renvoie l'ACK sans réémettre le texte ; si la notification a échoué, il ne mémorise pas le succès et n'acquitte pas. Le broker cesse les rejeux automatiques après le premier ACK technique. Cette déduplication n'améliore PAS la garantie de lecture modèle (§17.C).
- Pas de nouveau TTL avant ACK, ni de timer de notification ajouté en L3. Si le propriétaire devient dormant, se déconnecte par HTTP, se réenregistre avec une nouvelle époque, ou si le broker redémarre, la purge prime. Une nouvelle WS ne ressuscite rien. Un dépôt en attente compte toujours dans les quotas et reste non remplaçable ; un propriétaire vivant dont la WS ne revient jamais peut donc immobiliser sa place.

**Ratification produit :** selon la décision opérateur du 2026-10-12, confirmée par le lead le 2026-10-16, la garde jusqu'à la déconnexion, sous quotas et sans TTL avant ACK, couvre B2. La reprise différée après une coupure WS et l'immobilisation correspondante du quota sont donc retenues ; ce n'est pas la promesse d'un succès immédiat. **SUPPOSÉ :** fréquence et durée réelles des coupures pendant un clear non mesurées ici. Ne pas les utiliser pour déclarer le risque négligeable.

### 17.C. ACK et lecture : C1 seul, ratifié avec sa limite

**DÉDUIT :** `server.ts:391-405` attend `mcp.notification` puis note l'id comme notifié ; ce code ne reçoit aucune preuve de lecture du modèle. La règle locale `~/.claude/claude-config/rules/mcp.md`, section « mcp.notification() est fire-and-forget », consigne une perte possible entre deux tours et distingue notification et pull explicite. Le push L3 n'est pas livré par cette analyse et cette perte n'est **pas remesurée** ici. Avec le contrat initial (aucun pull, purge à +300 s du premier ACK), une notification perdue peut ainsi conduire à la destruction du seul dépôt sans que le modèle ait reçu le contexte. Un scénario nominal par mot témoin ne prouve pas l'absence de cette course.

| Option | Garantie et coût proposés | Risque, réversibilité et portée |
|---|---|---|
| C1. Conserver push seul, ACK technique puis purge à +300 s | **Retenue et ratifiée par l'opérateur le 2026-10-16.** Pas de nouvelle surface agent, notification **best-effort**, aucune garantie de lecture ou de récupération. Documenter explicitement « envoyé » plutôt que « restauré ». | La perte silencieuse possible est acceptée et sa limite écrite au journal. Irréversible après purge ; le journal ne détecte pas une perte que le protocole ne signale pas. |
| C2. Garder jusqu'à une « lecture prouvée », sans chemin de lecture/confirmation supplémentaire | Retarder la purge ne crée ni accès au texte ni signal de lecture. Il faudrait définir un nouvel événement corrélé, et non assimiler une activité quelconque du pair à une preuve. | Rétention et quota bloqués pour une garantie non définie. Rejetée comme formulation de contrat exécutable. |
| C3. Ajouter un pull explicite réservé au propriétaire ; notification comme indice | **Alternative rejetée par l'opérateur.** Elle offrirait un autre accès en cas de notification perdue, au prix d'un outil décrit à chaque tour pour un usage rare déclenché par la directive amont. | Ne pas ajouter de route de lecture, d'outil MCP ni d'instruction de pull ; ne pas déplacer la purge vers une lecture. La raison opérateur est reproduite ci-dessous. |

**Contre-avis indépendant (lecture seule, non mesure d'exécution) :** le reviewer conclut « TIENT » sur le déclenchement signé et le rejeu RAM, avec ratification explicite nécessaire de la limite MCP ; cette ratification est désormais acquise pour C1. Ses deux réserves sont incorporées ici : état protégé `resuming` distinct de `held`, et déduplication/ré-ACK par `(deposit_id, attempt_id)`. La tentative corrélée est conservée dans `released_attempt_id` ; aucune recherche sur le `attempt_id` vidé au release. L'échéance C1 doit nommer son unité : `ack_expires_at_ms = now().getTime() + 300_000`, jamais un mélange secondes/millisecondes.

**Décision opérateur : C1 seul.** Raison transmise par le lead le 2026-10-16 : « un outil de lecture se paie en description à chaque tour alors qu'il servirait rarement, puisque la reprise vient d'un flux amont (la directive clear_reload) qui en déclenche l'usage. » Le coût récurrent de description de l'outil, et non le seul coût d'implémentation, décide contre C3. Les exclusions des §0/2/4/5 restent donc inchangées.

**Garanties C1 à afficher et journaliser :** le clear est confirmé par sa barrière ; le transport vise seulement le propriétaire ; l'ACK atteste une notification techniquement émise et arrête les rejeux. Il **ne prouve pas que le modèle a lu**. Une notification peut être perdue silencieusement, puis le dépôt purgé 300 s après le premier ACK, sans chemin pull de récupération. Le journal de la reprise doit nommer cette limite, sans le texte du dépôt, par exemple : « Reprise par notification uniquement ; lecture par le modèle non garantie, perte silencieuse possible ; purge 300 s après le premier ACK technique. » Cette mention décrit la garantie du mécanisme, pas un échec observé ; ne jamais écrire « modèle a lu » ni déclarer une perte particulière sans preuve. Les erreurs détectables de transport gardent leur trace propre (§17.B).

**Coût estimé, SUPPOSÉ (pas une mesure de livraison) :** C1 ajoute environ 2 à 4 h de cadrage/tests de limites au lot de transport A/B. L'implémentation de C3 est hors périmètre, et aucun contrat de pull n'est à préparer pour ce lot.

### Critères de clôture L3, à exécuter par le développeur

- **Producteur :** rejet 400 des deux alias (seuls ou avec canonique), mauvaise directive, plusieurs pairs, valeur absente vs `null`/mal formée ; aucun appel d'injection sur refus. Un dépôt valide parvient de `parseRunDirectiveArgs` au chemin réservé, sans changer le chemin sans dépôt.
- **A :** confiance refusée = ni réservation ni release ; injection refusée/barrière échouée = release `false`, aucun push ; barrière résolue = release `true`, un seul dépôt ; doublons identiques idempotents, booléen contradictoire et ancienne tentative refusés. `replace`/reserve refusés sur `resuming`.
- **B :** paire de contrôles « fermeture WS seule, propriétaire vivant » et « `/disconnect`, propriétaire purgé » ; release réussi sans WS puis auth = rejeu du bon dépôt uniquement ; aucune reprise pour tentative abandonnée/expirée, autre propriétaire, autre époque ou dépôt purgé. Envoi échoué = conservation et trace sans contenu. ACK perdu = ré-ACK sans seconde notification dans le même server.
- **ACK/rétention :** ACK étranger, avant release, mauvaise tentative refusés ; premier ACK fixe l'échéance C1, aucun doublon ne la prolonge. Horloge injectée aux limites 299/300 s ; purge propriétaire prioritaire dans tous les états. Aucun outil de lecture ni changement de déclencheur de purge.
- **Garantie produit :** scénario réel par mot témoin, plus simulation d'une notification résolue mais non remise au modèle. C1 doit écrire au journal la possibilité de perte silencieuse, sans inventer un succès modèle ni prétendre détecter cette perte ; la purge reste déclenchée par l'ACK technique. Canari absent des logs, SQLite/WAL, réplication et réponses Deck dans tous les chemins, y compris échec.

## 18. Ordre de livraison et déploiement

### L1 : dépôt sans activation de la reprise

Chaque pas ci-dessous concerne L1, pas la compatibilité du protocole de reprise L3.

1. `shared/context-buffer.ts`, `shared/context-registry.ts` et leurs tests purs.
2. Broker : liaison au register, route, purges, balayage ; tests broker. Sans server.ts à jour, aucune liaison : tout dépôt répond 401.
3. `server.ts` : envoi de l'empreinte. Sans Deck à jour, l'env est vide : le champ est omis.
4. `cli.ts` : le verbe. Sans capacité, code 5, aucun appel réseau.
5. Deck : minage, neutralisation. C'est l'interrupteur d'activation : tant qu'il n'est pas livré, la fonction est dormante partout.

Ordre L1 : broker, puis core (server.ts et cli.ts), puis Deck ; une version sans capacité/liaison doit refuser le dépôt plutôt que le rendre anonyme.

### L3 : décision de garantie, transport, puis producteur

1. Appliquer les décisions ratifiées B2 (reprise différée) et C1 seul (§19.7-8), avec leur limite de lecture écrite au journal. L'arbitrage produit est clos ; le contrôle de compatibilité avant activation reste requis.
2. Livrer le registre et le broker : release signé avec `cleared`, état `resuming`, accès exact, transport RAM dédié, rejeu à auth WS et ACK authentifié. Avec un ancien release sans `cleared`, aucun push. Aucun dépôt dormant/abandonné ne devient éligible par défaut.
3. Livrer server.ts : réception `context_resume`, cadrage sans log du texte, déduplication et ACK. Ne livrer ni outil de lecture ni chemin pull. Pas de garantie de lecture déduite du seul succès de `notification`.
4. Activer seulement ensuite le producteur Deck et le schéma agent `context_deposit_id`, avec validation avant injection. Le support du protocole L3 par le broker **et le server propriétaire** doit être vérifié avant le premier clear ; une réservation L2 réussie n'est pas cette preuve, et un succès HTTP générique non plus. Le mécanisme est fixé par le lead le 2026-10-16 (§18.4 ci-dessous) : deux contrôles, un par composant, parce que seul le broker connaît le couple cible → propriétaire.
5. Faire les tests ciblés du §17 et le scénario réel, puis le gate unique du lead. Les tests du futur transport et le scénario de perte MCP restent à exécuter ; le run `broker-websocket.test.ts` documenté en §17.B n'en tient pas lieu.

### 18.4. Contrôle de compatibilité L3 avant le premier clear avec dépôt

**Statut : mécanisme fixé par le lead le 2026-10-16.** Il remplace la mention « au brief » du point 4. Il ne modifie aucune des décisions B2/C1 (§17) ni le contrat de release A2 ; il ajoute un refus **avant** la réservation et un refus **à** la réservation.

**Pourquoi deux contrôles.** Le producteur Deck parle au broker, jamais au server.ts propriétaire de la cible ; seul le broker sait quel `instance_token` possède le pair visé par la directive. Un contrôle unique côté Deck ne peut donc prouver que le broker. Le second contrôle vit là où l'information existe : dans la phase `reserve` de `/context/transaction`, qui résout déjà le dépôt puis son propriétaire.

**(a) Le broker annonce sa version de reprise sur `GET /health`.** Champ `context_resume_version: 1`, de type nombre. Précédent exact : **DÉDUIT**, `broker.ts:11742-11751` (arbre de travail) sert déjà sur `/health`, sans Origin ni Bearer (`:11727-11732`), le couple `operator_trust_version` / `operator_trust_state` que le Deck lit avant un clear ; et `desktop/src/main/broker-client.ts:57-64` fait cette lecture avec `AbortSignal.timeout(2000)`, sans cache. La sonde L3 reprend cette forme :

- À **chaque** directive portant `context_deposit_id`, le Deck sonde `/health` sur le **même endpoint** que celui qui recevra la transaction (local ou `broker_url` distant, §19.1), avec un timeout de **2 s** et **sans cache**. Une valeur lue à la directive précédente ne vaut rien pour celle-ci : le broker a pu redémarrer dans une autre version entre les deux.
- Refus fermé, **avant la réservation et avant `/clear`**, si le champ manque, si sa valeur n'est pas un nombre `>= 1`, si la réponse n'est pas `2xx`, ou en cas d'erreur réseau ou de timeout. Le refus est tracé par `reportError`/journal sans contenu du dépôt. Pas de réservation signifie pas de release (§17.A), donc aucune trace broker n'est laissée par ce refus.
- Le champ est une **version de protocole**, pas un drapeau de fonctionnalité : une rupture ultérieure du contrat de reprise l'incrémente, et le Deck refuse ce qu'il ne connaît pas. `/health` reste non authentifiée et ne sérialise toujours pas le registre (§7, classe 2) ; ce nombre ne révèle rien sur les dépôts.

**(b) Le server.ts annonce son support au broker, qui refuse la réservation d'une cible dont le propriétaire ne l'a pas annoncé.**

- Le server.ts qui consomme la trame `context_resume` l'annonce dans le corps de `/register`, aux **deux** sites qui construisent ce corps (boot et `switch_group`), selon la règle « les deux sites ou aucun » déjà appliquée à `deposit_capability_hash` (§10). Nom proposé pour le lot L3d, non arbitré : `context_resume_version: 1` (nombre), le même nom que sur `/health` pour qu'une seule constante serve aux deux annonces.
- Le broker garde l'annonce **en RAM, par `instance_token`**, posée après tout `/register` réussi au même site que la liaison de capacité : **DÉDUIT**, `broker.ts:2724-2731` (`bindDepositCapability`) couvre les quatre branches de retour de `handleRegister` par un seul appel. Un nouveau `/register` du même jeton remplace l'annonce ; un redémarrage du broker la perd, comme il perd les dépôts, donc aucune incohérence entre les deux ne peut survivre. Une annonce absente ou mal typée vaut « non annoncé », jamais « annoncé ».
- En phase **`reserve`**, après résolution du dépôt et de son propriétaire, le broker répond **409 `{ ok:false, reason:"owner_lacks_context_resume" }`** si le propriétaire **de la cible** n'a pas annoncé le support. Le contrôle est **par cible et au moment de la réservation**, pas par groupe ni par broker. **DÉDUIT**, `broker.ts:2876-2880` (arbre de travail) rend déjà `{ ok:false, reason }` en 409 depuis le résultat du registre : le nouveau motif s'ajoute à cette forme. Le Deck traite ce 409 comme tout refus de réservation : directive refusée avant `/clear`, trace sans contenu, aucun release.
- Le contrôle **ne porte pas** sur le server.ts qui a déposé : seul le propriétaire **courant** de la cible recevra la trame, et c'est lui que la réservation vérifie.

**Fenêtre de course acceptée.** Entre la réservation et le `/clear`, le propriétaire peut se réenregistrer dans une version sans annonce, ou le broker redémarrer. Cette fenêtre est **acceptée** : la purge propriétaire ou la perte du dépôt rend alors un release 409 (§17.A), sans push ; le contexte est effacé sans reprise, ce que le journal rapporte comme une reprise non effectuée, jamais comme une restauration. Fermer cette fenêtre demanderait un verrou sur `/register` que rien d'autre ne justifie.

**Matrice de déploiement.** Le flux est **fermé par défaut** tant que l'un des deux contrôles n'a pas de quoi répondre :

| Deck | Broker | Server propriétaire | Résultat |
|---|---|---|---|
| L3c | sans L3d | quelconque | `/health` sans champ : refus Deck avant réservation |
| L3c | L3d | sans L3d | 409 `owner_lacks_context_resume` à la réservation |
| L3c | L3d | L3d | réservation acceptée, flux L3 nominal |
| sans L3c | L3d | quelconque | pas de `context_deposit_id` dans le schéma agent : chemin historique sans dépôt |

**Ce qui a été écarté.**

| Option | Pourquoi |
|---|---|
| (a) seul : sonder `/health` sans contrôle du propriétaire | Un broker L3d devant un server.ts ancien accepte la réservation, le Deck exécute `/clear`, et la trame n'a aucun consommateur : le dépôt est purgé par le propriétaire ou immobilisé, le contexte perdu. C'est exactement le cas que le point 4 interdit. |
| Cache de la sonde `/health` (par endpoint ou par run) | Un broker redémarré dans une autre version entre deux directives rend le cache périmé ; la directive suivante passerait sur une valeur fausse. Le coût d'une requête locale de 2 s maximum par directive avec dépôt est inférieur à celui d'un `/clear` sans reprise. |
| Contrôle du propriétaire côté Deck (lire le propriétaire puis sa version) | Exigerait une route Deck exposant le couple cible → `instance_token`, ou une version par pair dans `list_peers` ; ouvre une surface de plus pour une information que le broker possède déjà au bon moment. |

**Répartition des lots.**

- **L3c (Deck)** : la sonde `/health` avant réservation, le refus fermé sur champ absent, valeur `< 1`, erreur ou timeout, et le traitement du 409 `owner_lacks_context_resume` comme refus avant `/clear`. Tant que L3d n'est pas déployé, un Deck L3c refuse chaque directive avec dépôt : c'est le comportement voulu.
- **L3d (core)** : le champ `context_resume_version` sur `/health`, l'annonce du server.ts aux deux sites de `/register`, sa conservation par `instance_token` au site de `bindDepositCapability`, et le 409 de réservation.
- Ordre de déploiement : L3c et L3d sont indépendants parce que le flux est fermé par défaut dans toute combinaison partielle ; un déploiement L3d seul n'active rien sans le producteur.

**Critères de clôture à ajouter à ceux du §17 :** Deck : `/health` sans champ, champ `0`, champ chaîne `"1"`, réponse 500, timeout simulé à 2 s, chacun refusé avant toute requête `/context/transaction` (faux broker qui compte ses requêtes) ; deux directives successives font deux sondes. Broker : réservation sur une cible dont le propriétaire n'a pas annoncé rend 409 avec le motif exact et ne change pas l'état du dépôt ; le même propriétaire réenregistré avec l'annonce rend la réservation possible ; un `/register` sans le champ efface une annonce antérieure du même jeton ; `/health` porte le champ en nombre dans les trois modes de broker ; le corps de `/health` ne contient aucun identifiant de dépôt.

## 19. Questions encore ouvertes

Exigent l'opérateur :

1. **Broker partagé distant.** Un client en mode `remote` (`broker_url`) dépose dans la RAM du broker partagé, pas dans celle d'un broker local au Deck. La règle `CLAUDE.md` nomme le mode replica, pas ce cas. Proposition : accepter, parce que l'accès est limité par capacité et par propriétaire et que ces brokers portent déjà les messages et la feuille de route du même groupe ; le transport est celui du `broker_url` configuré. À confirmer ou à refuser.
2. **Coéquipiers et sessions imbriquées.** L1 refuse le dépôt tant que deux pairs vivants partagent la capacité (409), ce qui prive un lead à coéquipiers de la fonction. Accepter cette limite pour L1, ou financer le raffinement par ancêtre de processus (option F), à mesurer d'abord (M2) ?

Pour le lead, sans bloquer L1 :

3. **Re-lien sur heartbeat** après redémarrage du broker (le heartbeat porterait l'empreinte). Recommandation de l'architecte : ne pas l'inclure en L1 ; un redémarrage du broker est un événement visible, le refus 401 est explicite. À réévaluer si l'usage montre des redémarrages fréquents.
4. **`--replace`** : ajout de l'architecte, absent des décisions opérateur. Sans lui, un pair qui a atteint son quota ne peut libérer de place qu'en se relançant. Retirable seul.
5. **Valeurs des trois quotas** (3, 96, 256) : valeurs de conception non mesurées (M4).
6. **Instruction à l'agent** (skill du `deck-plugin`, découverte du chemin de `cli.ts` : `roadmap-card/SKILL.md:71-74` suppose `<repo>/cli.ts`). Non couvert par L1 ; à rattacher à L2 puisque c'est la directive du lead qui dit à l'agent de déposer. Aucun outil ni instruction de pull à ajouter pour L3.

**Arbitrages opérateur L3 clos, décisions transmises par le lead le 2026-10-16 :**

7. **Garantie de reprise (C) : C1 seul, retenu et ratifié.** Maintenir « sans outil MCP/aucune lecture », avec notification potentiellement perdue et purge 300 s après le premier ACK technique. La limite de perte silencieuse est acceptée, écrite au journal et jamais appelée « modèle a lu ». **C3 rejetée** : « un outil de lecture se paie en description à chaque tour alors qu'il servirait rarement, puisque la reprise vient d'un flux amont (la directive clear_reload) qui en déclenche l'usage. » Les exclusions des §0/2/4/5 restent inchangées ; détails des garanties : §17.C.
8. **Reprise différée (B) : B2 retenue et ratifiée** au titre de la décision opérateur du **2026-10-12** : garde jusqu'à la déconnexion, sous quotas, sans TTL avant ACK. Conserver en RAM la tentative libérée jusqu'à auth WS et ACK tant que le propriétaire vit ; sa place de quota reste immobilisée. Aucune survie à `/disconnect`, changement d'époque ou redémarrage broker. Cette récupération de transport ne résout pas la perte entre notification MCP et modèle.

9. **Contrôle de compatibilité L3 avant activation du producteur : fixé par le lead le 2026-10-16** (§18.4). Sonde `/health` par le Deck à chaque directive avec dépôt (`context_resume_version >= 1`, 2 s, sans cache, refus fermé avant réservation), et 409 `owner_lacks_context_resume` en phase `reserve` quand le propriétaire de la cible n'a pas annoncé son support au `/register`. Écartés : la sonde seule, le cache de la sonde. La ratification de C1/B2 ne dispensait pas de ce contrôle ; il est désormais une exigence de L3c et L3d. Reste au lot L3d le seul nom du champ d'annonce au `/register`, proposé identique à celui de `/health`.

## 20. Risques résiduels

- La capacité est lisible par tout process du même compte OS qui lit l'environnement d'un process de la tuile. Elle ne donne que le droit de déposer dans le tampon de CE pair (et d'y remplacer ses dépôts), mais un dépôt hostile sera poussé dans son contexte à la prochaine reprise : d'où le cadrage de la contrainte 7 et la classe 4 du §7. Ce n'est pas une frontière contre un process compromis du même compte.
- Les valeurs des quotas ne sont pas mesurées.
- Le comportement exact des coéquipiers et des sessions imbriquées vis-à-vis du `/register` est **SUPPOSÉ** jusqu'à M2.
- Un `/disconnect` tardif d'un ancien process pour le même jeton peut basculer en dormant le pair d'un nouveau lancement et purger un dépôt de celui-ci. La cause existe déjà (le `/disconnect` est clé par `instance_token` seul, `broker.ts:2586-2593`) ; L1 ne l'aggrave pas et L2 refuse une directive sur un dépôt inexistant (contrainte 8).
