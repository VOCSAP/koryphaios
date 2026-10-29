# Runbook : déployer l'attestation d'Inbox (broker, serveur MCP des tuiles, Deck)

Public visé : l'opérateur qui met à jour un poste Koryphaios, avec ou sans
broker distant.

## Objet

Le dépôt de messages vers l'Inbox de l'opérateur (`ask_operator`,
`notify_operator`) repose sur un accusé que le broker renvoie à
l'enregistrement d'une tuile. Les trois composants parlent ce protocole et
doivent être mis à jour **dans un ordre précis**, sinon les tuiles perdent
l'accès à l'Inbox ou ne démarrent plus.

| Composant | Rôle dans le protocole | Fichier |
|---|---|---|
| Broker | Répond `inbox_binding` à `/register`, refuse un dépôt non attesté | `broker.ts` (`registerResponse`, `admitOperatorDeposit`) |
| Serveur MCP `claude-peers` d'une tuile | Exige l'accusé en contexte Kory, s'arrête sinon | `server.ts` (`attestRegister`, `registerFetch`, `confirmedInboxBinding`) |
| Serveurs MCP `kory-operator` / `kory-deck` (tuiles lead et superviseur) | Embarquent la même porte de readiness via l'import de `server.ts` | `server-deck.ts`, bundle `server-deck.mjs` |

## Ce que fait le code

1. **Le broker accuse.** La réponse de `/register` porte
   `inbox_binding: { version: 1, run_ref, group_id }`, relu du binding réel de
   l'instance retournée dans la table `inbox_instance_bindings`, ou `null` si
   l'instance n'est liée à aucun run (`registerResponse` dans `broker.ts`).
2. **Le serveur MCP refuse le nu en contexte Kory.** Quand
   `CLAUDE_PEERS_DESK_SESSION` est non vide, `attestRegister` exige un
   credential de run lisible couvrant le groupe, sinon il lève. Après
   l'envoi de la preuve signée, `registerFetch` compare l'accusé au credential
   (`confirmedInboxBinding` : version 1, même `run_ref`, même `group_id`, même
   groupe que la requête). Sans accusé concordant il lève
   `Kory Inbox registration was not confirmed by this claude-peers broker;
   update the broker and reconnect this session`. L'exception remonte
   jusqu'à `main()` de `server.ts`, qui journalise `Fatal:` et sort avec le
   code 1 : **le serveur claude-peers de la tuile s'arrête au boot**. Hors
   contexte Kory (variable vide), le comportement ancien est conservé.
   Après un envoi signé en échec, il n'y a jamais de retry nu (il frapperait
   une seconde identité non liée).
3. **La porte de readiness côté client.** `ask_operator` et
   `notify_operator` sont refusés localement tant que
   `inboxDepositReadiness` (`shared/inbox-readiness.ts`) rend une raison :
   pas de scope Inbox dans le credential, identité non encore confirmée, ou
   accusé qui ne correspond pas au run. Cette porte vit dans `server.ts`
   (`handleAskOperator` et `handleNotifyOperator`) ; `server-deck.ts`
   les importe, donc `server-deck.mjs` en embarque une copie figée au build.
   L'identité publiée entre les deux processus MCP d'une tuile passe par le
   fichier `session-identity-*.json` (`shared/peer-cache.ts`).
   `send_message` vers `operator` est refusé par `server.ts` avant tout transport.
4. **Le broker refuse un dépôt non attesté** (`admitOperatorDeposit`) : 401
   si une instance liée envoie sans preuve, 403 si l'instance n'est pas liée
   au run du credential, 403 si le groupe n'a pas de secret.

## D'où chaque composant est lancé (point qui décide l'ordre)

- **Serveur MCP `claude-peers` des tuiles** : lancé par Claude Code d'après
  l'entrée `mcpServers["claude-peers"]` de `~/.claude.json`, donc depuis le
  **clone que cette entrée désigne**, pas depuis le checkout de travail. Le
  clone se repère dans `args` : l'élément qui se termine par `server.ts`.
  Vérifié en lecture : le Deck lui-même s'en sert pour retrouver le broker
  (`locateBrokerScript` dans `desktop/src/main/broker-spawn.ts`, qui prend
  `broker.ts` comme voisin de ce `server.ts`).
- **Broker local du Deck** : lancé détaché (`startLoopbackBroker`,
  `desktop/src/main/index.ts`) depuis **ce même clone** via `~/.claude.json`,
  avec repli sur le dépôt où vit le Deck (`app-root`) seulement si l'entrée
  est absente ou ne désigne pas de `server.ts`. S'il répond déjà sur
  `/health`, il est réutilisé tel quel : **il ne prend pas le nouveau code
  tant qu'il n'est pas arrêté et relancé**.
- **`kory-operator` / `kory-deck`** : lancés par le Deck depuis leur bundle
  `deck-plugin/mcp/server-deck.mjs` (`deckLeadScriptPath` dans
  `desktop/src/main/supervisor.ts`), produit par `npm run build:mcp` dans
  `desktop/` et recopié dans le paquet par `extraResources`
  (`desktop/electron-builder.yml`). Un Deck qui n'a pas été reconstruit
  garde l'ancien bundle.
- **Broker distant** : conteneur ou service propre, mis à jour séparément ;
  voir `runbooks/broker-db-migration.md` pour la topologie d'un broker en
  conteneur.

## Ordre de déploiement

Chaque étape se termine avant la suivante.

### Étape 1 : brokers, accusé d'abord

1. Mettre à jour le **broker distant** s'il y en a un, puis le redémarrer.
2. Pour le **broker local du Deck** : mettre à jour le clone de l'étape 2,
   puis **arrêter** le broker local déjà lancé et le relancer. Comme il est
   détaché et réutilisé, redémarrer le Deck seul ne suffit pas.
   Arrêt et relance : bouton Stop/Start du bandeau broker du Deck ou menu de
   l'Avatar (libellés repris du journal du Deck, non vérifiés dans l'UI) ;
   à défaut, tuer le processus par le PID du port d'écoute du broker, jamais
   par nom d'image.

Raison : tant que le broker n'accuse pas, un serveur MCP à jour ne peut pas
confirmer son identité.

Symptôme si on inverse (serveur MCP à jour, broker ancien) : la tuile
n'obtient aucun outil `claude-peers`. Son journal MCP contient
`Kory Inbox registration was not confirmed by this claude-peers broker`
puis `Fatal:`, et le processus sort en 1.

### Étape 2 : le clone chargé par `~/.claude.json`

1. Lire `mcpServers["claude-peers"].args` dans `~/.claude.json` et repérer le
   chemin du `server.ts` (c'est le clone effectif ; `<clone>` ci-dessous).
2. Mettre ce clone au commit qui porte le protocole (même commit que le
   broker de l'étape 1) :

   ```bash
   git -C <clone> fetch
   git -C <clone> checkout <commit>
   git -C <clone> rev-parse HEAD
   ```

3. Contrôler que le résultat est bien le commit attendu.

Raison : c'est ce code que lancent toutes les tuiles et le broker local. Le
checkout de travail n'est pas chargé par les tuiles : y mettre le correctif ne
change rien pour elles.

Symptôme si on l'oublie (broker à jour, serveur MCP de tuile ancien) : la
tuile s'enregistre sans preuve ; l'instance n'est pas liée au run. Le premier
`ask_operator` est refusé avec **403 `the asking instance is not bound to
this run`** (mesuré, Kleos #36095 ; non rejoué ici).

### Étape 3 : le Deck

Reconstruire le bundle `server-deck.mjs` puis l'application :

```bash
npm --prefix <checkout>/desktop run build:mcp
```

puis la chaîne de build habituelle du Deck (`npm run build` dans `desktop/`,
qui enchaîne `build:mcp`) et relancer le Deck.

Raison : le bundle embarque la porte de readiness de `server.ts` au moment du
build. Un Deck non reconstruit continue de lancer l'ancien `kory-operator` ou
`kory-deck`.

Symptôme si on l'oublie : les tuiles lead et superviseur, dont l'un des serveurs
`kory-operator` ou `kory-deck` est ancien, gardent l'ancien comportement de dépôt pour `ask_operator`
(même 403 que ci-dessus face à un broker qui attend l'attestation).

### Étape 4 : reconnecter ou relancer les tuiles

Relancer chaque tuile (ou la reconnecter depuis le Deck) pour que son serveur
MCP se réenregistre auprès du broker mis à jour. Une tuile ouverte avant la
mise à jour garde son ancien processus MCP et son ancienne identité.

## Vérification après déploiement

1. **Fonctionnelle** : depuis une tuile relancée, appeler `ask_operator` avec
   un titre et une question. La question doit arriver dans l'Inbox du Deck.
   Un refus `ask_operator refused: Inbox registration is not yet confirmed`
   signifie que l'identité publiée n'est pas encore prête (attendre
   l'enregistrement, sinon reprendre l'étape 4).
2. **Côté broker local, lecture seule** : la table doit contenir au moins une
   ligne par tuile liée.

   ```bash
   bun -e 'import { Database } from "bun:sqlite"; const db = new Database(process.env.CLAUDE_PEERS_DB ?? (process.env.HOME + "/.claude-peers.db"), { readonly: true }); console.log(db.query("SELECT COUNT(*) AS n FROM inbox_instance_bindings").get());'
   ```

   La commande a été exécutée en lecture seule pendant la rédaction (elle a
   rendu `{ n: 0 }` sur un poste dont le broker local n'avait pas encore
   été mis à jour). `n: 0` avec des tuiles Kory ouvertes après le
   déploiement indique que le broker local n'a pas le nouveau code ou que les
   tuiles n'ont pas été relancées. Adapter le chemin de la base si
   `CLAUDE_PEERS_DB` ou le fichier de config du broker en désigne un autre
   (`shared/config.ts`).
3. Ne jamais ouvrir la base en écriture pour cette vérification.

## Retour arrière

L'ordre est l'inverse du déploiement, en remettant chaque composant au commit
précédent :

1. Relancer les tuiles sur l'ancien clone (étape 2 inversée) **après** avoir
   remis le clone à l'ancien commit : un ancien serveur MCP ne fait pas
   d'attestation et n'a pas besoin de l'accusé.
2. Reconstruire le Deck depuis l'ancien commit (`build:mcp` puis build).
3. Remettre le broker (distant et local, arrêt puis relance) à l'ancien
   commit en dernier.

Points d'attention :

- Un ancien broker ignore `inbox_binding` et les lignes de
  `inbox_instance_bindings` déjà écrites ; la table reste en place. Aucune
  restauration de base n'est nécessaire pour ce lot.
- Remettre le **broker** à l'ancien commit alors que des tuiles tournent
  encore sur le nouveau serveur MCP les fait s'arrêter au boot (symptôme de
  l'étape 1) : ne le faire qu'une fois les tuiles relancées sur l'ancien clone.
- Si seul le Deck est en cause, reconstruire son bundle suffit ; le broker et
  le clone n'ont pas à bouger.
