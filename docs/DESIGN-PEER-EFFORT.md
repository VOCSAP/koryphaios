# Effort des peers piloté par le team-lead -- plan d'implémentation

Le team-lead ou le superviseur joint un niveau d'effort à une délégation
(`send_message`, champ optionnel `effort`). Le peer destinataire travaille à
ce niveau jusqu'au changement suivant. Le message part toujours, que l'effort
soit appliqué ou non.

Les mesures qui fondent ce plan (sémantique de `turn.step`, coût en cache d'un
changement d'effort) sont dans le corps du commit qui livre ce document, pas
ici.

## 1. Décisions opérateur

| # | Décision |
|---|---|
| D1 | Le message part toujours. Un effort non appliqué est signalé avec sa raison, jamais bloquant. |
| D2 | Seuls les rôles `team-lead` et superviseur peuvent demander un effort. Toute autre demande est ignorée avec raison `sender_not_authorized`. |
| D3 | Option Deck « Ajuster automatiquement l'effort des peers », désactivée par défaut. |
| D4 | Seuil « jusqu'à » sur une échelle graduée `low · medium · high · xhigh · max`, par défaut `high`. Un effort demandé au-dessus est ramené au seuil. |
| D5 | Liste des modèles sur lesquels le changement est permis. Hors liste : ignoré avec raison `model_not_allowed`. |
| D6 | Un effort appliqué reste en place jusqu'à la demande suivante (persistant, pas limité au tour). |

## 2. Mécanisme retenu

`/effort` tapé dans la tuile est exclu : la commande écrit dans
`settings.json` et changerait l'effort de toutes les sessions de l'opérateur.

Le mécanisme est celui du mod effortless : un hook `turn.step` du module Kory
(chargé dans chaque tuile Claude par le plugin Deck) réécrit l'effort de
chaque requête modèle (`next({ ...e, effort })`).

Faits établis sur Claude Code 2.1.310 :

- `turn.step` porte UNE requête modèle. La réécriture ne vaut que pour elle :
  la requête suivante revient à l'effort de session. La persistance (D6) est
  donc la charge du module, qui réapplique le niveau à chaque requête.
- L'API des modules n'expose aucun moyen de changer l'effort de session.
- `CLAUDE_EFFORT` et l'interface de la tuile montrent l'effort de session, pas
  l'effort réécrit. L'effort effectif n'est observable que par le module, qui
  doit le publier.
- Un changement d'effort par le module coûte en cache exactement ce que coûte
  un `/effort` natif. Selon la documentation Claude Code (prompt caching,
  « Changing effort level »), ce coût est nul sur Opus 5.5, Sonnet 5.5,
  Haiku 5.5 et Fable 5.1 (>= 2.1.260) avec clé API ou abonnement, hors
  Bedrock, Agent Platform, passerelle d'applications Claude,
  `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` ou configuration HIPAA. À vérifier
  sur la machine de l'opérateur (V1).
- Le chargement des modules dépend d'un interrupteur de déploiement côté
  serveur : tout le mécanisme en dépend.

## 3. Flux

```
team-lead --send_message{effort}--> broker --(role ok, enum ok)--> server.ts du peer
  server.ts: écrit la demande d'effort (fichier par session) PUIS notifie Claude Code
  module Kory, turn.step (fil principal) :
      lit la demande + la politique du Deck -> decideEffort() -> next({...e, effort})
      publie l'effort effectif + raison dans le fichier d'état de session
  Deck : lit le fichier d'état (déjà le cas pour le modèle) -> tuile, journal
```

Le fichier de demande est écrit avant la notification : le tour déclenché par
le message lit la demande dès sa première requête. Aucune retenue côté broker,
aucune attente d'inactivité de la tuile.

### Clés : « et s'il y en a deux ? »

- **Demande d'effort** : un fichier par session de tuile, nommé à partir de
  `CLAUDE_PEERS_DESK_SESSION` comme le fichier d'état (`statusFileName`). Deux
  tuiles = deux fichiers ; un peer sans ce jeton (hors Deck) n'en écrit pas.
- **Politique** (activé, seuil, modèles) : un fichier par exécution du Deck,
  dont le chemin est transmis à chaque tuile par variable d'environnement au
  lancement. Deux Kory sur la même machine ont deux politiques distinctes ; le
  Deck réécrit son fichier à chaque changement d'option, donc les tuiles déjà
  ouvertes suivent.
- **Rôle de l'expéditeur** : `role` du `Peer` côté broker, posé au lancement
  par `CLAUDE_PEERS_ROLE`. Réservé par rôle, non résistant à un agent hostile
  envers sa propre tuile (même limite que `role`).

### Entrées hostiles (tableau CLAUDE.md)

- #1 : l'option, le seuil et la liste de modèles sont GLOBAUX uniquement
  (même règle que `magicCompact` dans `launch-config.ts`). Une configuration de
  dépôt ne peut ni activer l'option ni relever le seuil.
- #2 : `effort` est une énumération validée par le broker ; aucun autre champ
  du message n'est copié dans le fichier de demande.
- #4 : le niveau passe d'un agent à un autre ; il est revalidé contre la liste
  fermée à chaque frontière (broker, `server.ts`, module) et n'est jamais tapé
  dans un terminal.

## 4. Vérifications préalables sur la machine (bloquantes)

| # | Question | Procédure | Si négatif |
|---|---|---|---|
| V1 | Le cache survit-il à un changement d'effort, avec l'abonnement de l'opérateur ? | Mod sonde (annexe A) + `claude -p` à trois tours, Sonnet 5.5 puis Opus 5.5 puis Fable 5.1 ; lire `cache_creation_input_tokens` au tour 2. | Valeurs par défaut de D5 restreintes aux modèles qui passent ; avertissement dans l'option. |
| V2 | Le module Kory est-il chargé dans une tuile, avec `turn.step`, sans `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` ? | Tuile lancée par le Deck avec `--debug-file` ; chercher `hooks module` et la liste `events:`. | Ajouter la variable à l'environnement de tuile, ou arrêter le chantier. |
| V3 | Quelle valeur `CLAUDE_PEERS_ROLE` porte la tuile superviseur ? | `list_peers` depuis une tuile, champ `role` du superviseur ; `git grep` du lancement superviseur. | Sans valeur : poser `supervisor` au lancement (lot 2). |
| V4 | Haiku 5.5 accepte-t-il un effort ? | Mod sonde sur `claude-haiku-5-5` : `e.effort` présent ou absent au `turn.step`. | Haiku exclu d'office de D5. |

## 5. Lots, tests d'abord

Chaque lot : écrire les tests, constater le rouge, implémenter, vert, commit.
Chaque test nomme la mutation de la source qui le fait rougir (« mutations sur
miroir » du corps de commit, skill `mirror-probe`). Les tests étendent le
fichier existant du module ; un nouveau fichier seulement pour un nouveau
module source.

### Lot 1 -- vocabulaire partagé

Source : `shared/effort.ts` (nouveau) : `EFFORT_LEVELS`, `isEffortLevel`,
`effortRank`, `clampEffort(level, max)`. `deck-control.ts` importe la liste au
lieu de sa constante locale.

Tests : `tests/shared-effort.test.ts` (nouveau module, pur).

| Test | Mutation qui le rougit |
|---|---|
| la liste vaut exactement `low, medium, high, xhigh, max`, dans cet ordre | retirer ou permuter un niveau |
| `isEffortLevel` refuse `''`, `'HIGH'`, `' high'`, `NaN`, `null`, `3`, `'ultra'` | remplacer le test d'appartenance par `typeof === 'string'` |
| `clampEffort('max', 'high') === 'high'`, `clampEffort('low', 'high') === 'low'` | renvoyer `level` sans comparer |
| `deck-control` refuse toujours un effort hors liste | réintroduire une liste locale divergente |

Tests existants à relancer : `tests/desktop-deck-control.test.ts`.

### Lot 2 -- broker : champ `effort` sur `send_message`

Source : `SendMessageRequest.effort?` et `Message.effort?` (`shared/types.ts`) ;
`handleSendMessage` (`broker.ts`) ; colonne `effort` nullable sur les messages
(migration) ; réponse enrichie `effort_status: 'forwarded' | 'ignored'` et
`effort_reason`.

Règles : niveau invalide -> message envoyé, effort ignoré (`invalid_level`) ;
expéditeur sans rôle autorisé -> ignoré (`sender_not_authorized`) ; message
relayé par fédération -> effort retiré (`remote_peer`), l'effort étant une
affaire du Deck local.

Tests : étendre `tests/broker-send-ack.test.ts` (broker partagé en
`beforeAll`).

| Test | Mutation |
|---|---|
| lead -> message livré avec `effort: 'high'`, `effort_status: 'forwarded'` | ne pas stocker la colonne |
| `developer` -> message livré SANS effort, raison `sender_not_authorized` | supprimer le contrôle de rôle |
| niveau `'ultra'` -> message livré sans effort, raison `invalid_level` | supprimer la validation |
| sans `effort` -> comportement inchangé, aucun champ ajouté | poser une valeur par défaut |
| superviseur -> `forwarded` (valeur de rôle fixée par V3) | limiter au seul `team-lead` |

Si une nouvelle route ou une colonne de `roadmap_items` apparaissait, suivre
`.claude/rules/broker-contracts.md` ; ce lot n'en ajoute pas.

### Lot 3 -- `server.ts` : schéma de l'outil et écriture avant notification

Source :
- schéma `send_message` : propriété `effort` (énumération du lot 1) ;
- fonction pure `shared/effort-request.ts` : nom de fichier depuis le jeton de
  session, encodage/décodage `{ level, message_id, at }` ;
- les chemins de livraison entrante de `server.ts` (poussée WebSocket, poll,
  résolution `wait_for_message`) passent par UNE fonction de livraison qui
  écrit la demande puis notifie.

Tests :
- `tests/shared-effort-request.test.ts` (nouveau module, pur) :
  aller-retour d'encodage ; décodage d'un fichier corrompu -> `null` tracé ;
  jeton absent -> pas de chemin. Mutation : accepter un niveau hors liste au
  décodage.
- test de la fonction de livraison avec dépendances factices : l'écriture
  précède la notification ; sans effort, aucune écriture. Mutation : inverser
  l'ordre ; ne brancher qu'un des chemins (le test énumère les trois appels).
- `tests/server-tools-allowlist.test.ts` ou le test de schéma existant :
  `effort` présent avec l'énumération exacte.

### Lot 4 -- module Kory : application persistante

Source :
- `desktop/src/shared/effort-policy.ts` : `decideEffort({ requested, policy,
  model, sessionEffort, lastSessionEffort, overridden })` ->
  `{ effort?: EffortLevel; reason }` ;
- `desktop/hooks/kory-effort.ts` : hôte injecté (modèle `TelemetryHost`),
  enregistré par `kory-module.ts` ; `turn.step` sur le fil principal
  uniquement (`agentId` absent) ;
- `desktop/src/shared/session-status.ts` : champs `effort` effectif et
  `effort_reason`.

Règles de `decideEffort` : option désactivée -> rien ; modèle hors liste ou
sans effort -> rien ; seuil -> `clampEffort` ; demande persistante (D6)
jusqu'à la suivante ; si l'effort de session change sans que le module l'ait
demandé (choix de l'opérateur dans la tuile), le module cesse d'appliquer
jusqu'à la prochaine demande (`operator_override`, marqué dans le fichier de
demande pour survivre à un rechargement).

Tests :
- `tests/desktop-effort-policy.test.ts` (nouveau, pur) :

| Test | Mutation |
|---|---|
| désactivé -> aucun effort | ignorer `enabled` |
| `max` demandé, seuil `high` -> `high` | supprimer le plafonnement |
| modèle hors liste -> raison `model_not_allowed` | ignorer la liste |
| deux tours sans nouvelle demande -> effort réappliqué aux deux | n'appliquer qu'au tour du message |
| changement d'effort de session non demandé -> `operator_override` jusqu'à nouvelle demande | ignorer le changement |
| nouvelle demande après override -> appliquée | override définitif |

- `tests/desktop-kory-effort.test.ts` (nouveau, hôte factice) : une étape de
  sous-agent passe inchangée (mutation : retirer le filtre `agentId`) ; le
  fichier d'état reçoit l'effort effectif ; un fichier de demande illisible
  laisse passer la requête et trace l'erreur (règle « no silent errors »).
- étendre `tests/desktop-kory-module-plugin-validate.test.ts` : le module
  construit se charge et déclare `turn.step`.
- étendre `tests/desktop-session-status.test.ts` pour les nouveaux champs.

### Lot 5 -- options du Deck et fichier de politique

Source : `FeatureFlags.peerEffort = { enabled, max, models }` dans
`launch-config.ts`, GLOBAL uniquement ; défauts `enabled: false`,
`max: 'high'`, `models` selon V1/V4 ; écriture du fichier de politique par le
processus principal à chaque changement ; chemin transmis aux tuiles par
variable d'environnement (`session-service.ts`, à côté de
`CLAUDE_PEERS_ROLE`) ; `SettingsView.tsx` : case à cocher, échelle graduée
(réutiliser les crans de `CreateMenu.tsx`), liste de modèles cochables issue du
catalogue ; clés i18n dans toutes les langues.

Tests :
- étendre `tests/desktop-features.test.ts` : défaut désactivé ; seuil invalide
  -> défaut ; configuration de dépôt sans effet sur `peerEffort` (mutation :
  fusionner la config dépôt) ;
- étendre `tests/desktop-session-role-env.test.ts` : la variable du chemin de
  politique est posée sur chaque tuile ;
- étendre `tests/desktop-settings-view-dom.test.ts` (happy-dom) : case
  décochée par défaut ; échelle inactive tant que décochée ; déplacer le
  curseur enregistre le seuil ; décocher un modèle l'enregistre ;
- parité des locales (contrôle existant).

Visuel : `DESIGN.md` et skill `deck-design` -- aucun contrôle à l'aspect
natif, aucun emoji.

### Lot 6 -- consignes du lead et du superviseur

Source : `team-embedded.ts`, `supervisor.ts` : le champ `effort` n'est décrit
que si l'option est active, avec le seuil courant et la recommandation de
changer l'effort à la délégation, idéalement après un `clear`.

Tests : étendre `tests/desktop-team-embedded.test.ts` : texte présent si
activé, absent sinon (mutation : texte inconditionnel).

### Lot 7 (différé) -- exposition dans `list_peers`

L'effort et le modèle effectifs lus par le Deck dans le fichier d'état
remontent au broker et apparaissent dans `list_peers`. Non nécessaire au
mécanisme (l'application est idempotente) ; à inscrire au `BACKLOG.md` une
fois les lots 1 à 6 livrés.

## 6. Validation de bout en bout (machine, Deck lancé)

1. Option désactivée : le lead délègue avec `effort: 'xhigh'` -> message reçu,
   raison `disabled` dans le journal, effort inchangé.
2. Option activée, seuil `high` : délégation `xhigh` -> effort effectif `high`
   affiché sur la tuile ; deuxième tour sans nouvelle demande -> toujours
   `high`.
3. L'opérateur change l'effort dans la tuile -> `operator_override` ; nouvelle
   délégation -> appliquée.
4. Un `developer` envoie `effort: 'max'` à un pair -> message reçu, effort
   ignoré (`sender_not_authorized`).
5. Tuile sur un modèle décoché -> `model_not_allowed`.
6. `~/.claude/settings.json` inchangé après l'ensemble (somme de contrôle avant
   et après).

## Annexe A -- mod sonde pour V1, V2, V4

Trois fichiers dans un dossier de travail hors dépôt :

`.claude-plugin/plugin.json`

```json
{ "name": "efftest", "version": "0.1.0", "description": "Probe turn.step effort semantics" }
```

`hooks/hooks.json`

```json
{ "modules": ["./register.ts"] }
```

`hooks/register.ts` (remplacer `LOG` par un chemin absolu de la machine)

```ts
import type { Register } from 'claude-code'

const LOG = '<absolute path>/steps.log'
let firstTurn: string | undefined
const lines: string[] = []

export const register: Register = (on) => {
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    if (firstTurn === undefined) firstTurn = e.turnId
    // Rewrite only the steps of the first turn; pass every later one untouched.
    const out = e.turnId === firstTurn ? 'low' : e.effort
    lines.push(`turn=${e.turnId === firstTurn ? 1 : 'later'} index=${e.index} model=${e.model} in=${String(e.effort)} out=${String(out)}`)
    await $.fs.write(LOG, lines.join('\n') + '\n')
    return yield* next({ ...e, effort: out })
  })
}
```

Exécution (Git Bash sous Windows), un modèle à la fois :

```bash
msg() { printf '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"%s"}]}}\n' "$1"; }
( msg "Reply with the single word one."; sleep 35; msg "Reply with the single word two."; sleep 35; msg "Reply with the single word three." ) | \
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude -p --input-format stream-json --output-format stream-json --verbose \
  --model claude-sonnet-5-5 --effort high --plugin-dir <probe dir> --setting-sources "" \
  | grep '"type":"result"' | grep -o -E '"cache_(creation|read)_input_tokens":[0-9]+'
```

Lecture : tour 2, `cache_creation_input_tokens` proche de zéro = cache
conservé ; quelques milliers = cache de conversation réécrit. Témoin : la même
commande sans `--plugin-dir`. `steps.log` donne l'effort reçu et envoyé à
chaque requête.
