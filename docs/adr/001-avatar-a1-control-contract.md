# Avatar A1 : compléter le contrat de contrôle

Statut : proposition technique au team-lead, carte `1d136f60`. Les décisions opérateur 13 et 18 restent inchangées. Ce texte ne prouve aucune implémentation des ajouts proposés.

## Problem framing

DÉDUIT : le brief exige à la fois le remplacement d'un ancien avatar, le refus des versions inconnues, une commande `focus` consentie et le renommage en A1 (`docs/DESIGN-KORY-AVATAR.md:302-307`, `:787-828`, `:987-999`). Les précisions ci-dessous séparent ces contrats sans étendre l'avatar au contrôle générique du Deck.

## Current structure

- DÉDUIT : `parseAvatarAttachRequest` accepte uniquement la version 1 ; son erreur décrit un refus, pas une procédure de remplacement (`desktop/src/shared/avatar-protocol.ts:99-115`).
- DÉDUIT : le client HTTPS/WSS applique Bearer et certificat de run ; son validateur interdit query et fragment (`desktop/src/main/avatar-transport.ts:21-74`).
- DÉDUIT : les chemins de démarrage broker consultés sondent la disponibilité puis lancent si nécessaire ; ils ne comparent pas de versions dans ce chemin (`server.ts:182-219`, `desktop/src/main/broker-spawn.ts:144-168`). Ils fournissent un précédent de lancement, pas la négociation demandée.
- DÉDUIT : le précédent WS core ouvre `/ws`, authentifie l'upgrade si nécessaire, puis lie la connexion par une première frame `type: 'auth'` (`server.ts:327-345`). Le companion fournit un précédent HTTPS + WebSocketServer borné et des enveloppes requête/réponse corrélées (`desktop/src/main/companion-server.ts:192-206`, `desktop/src/shared/companion.ts:537-548`).

## 1. Version et remplacement

### Options

- A : arrêter automatiquement sur tout entier supérieur reçu dans `/attach`. Coût faible, mais confond version inconnue et demande de remplacement ; rayon d'impact : tous les Decks branchés. Changer ce comportement après livraison modifierait la sémantique du premier protocole.
- B : séparer refus de branchement et demande explicite de remplacement. Un aller-retour et une petite route supplémentaires ; arrêt réservé à un client ayant reconnu le protocole de contrôle. Extension additive, même rayon d'impact lors de l'arrêt mais déclenchement explicite.

### Recommendation

Retenir B. Un numéro supérieur ne constitue pas à lui seul une demande d'arrêt. Conserver le rejet du parseur, avec un résultat HTTP exploitable par le Deck.

### Target design & migration path

1. `/attach` inconnu : HTTP `409`, corps `{error: 'unsupported_protocol_version', protocol_version: 1, supported_protocol_versions: [1], avatarRunId}` ; refus tracé, aucun arrêt. Une version mal formée relève du `400`, sans modifier les garanties du parseur pur. La réponse de succès annonce aussi la version négociée. Les versions anciennes explicitement prises en charge passent par leur parseur dédié, pas par un test `<=`.
2. Le Deck compare la version annoncée à la sienne. Seulement s'il reconnaît le protocole de contrôle ancien et dispose de son propre binaire plus récent, il demande `POST /restart` avec `{avatarRunId, next_protocol_version}`. Cette petite enveloppe de contrôle doit rester comprise par les futures versions ; elle ne transporte aucun chemin ni commande exécutable. Version inconnue du client : refus tracé et intervention explicite, jamais arrêt au jugé.
3. `/restart` vérifie Bearer, Origin absent, taille bornée, run courant et entier sûr strictement supérieur à la version courante. Le premier demandeur reçoit `202 {status: 'restarting', avatarRunId}` ; les suivants reçoivent `409 {error: 'restart_in_progress'}` et ne lancent rien. Après émission de la réponse, l'avatar ferme ses connexions, libère son rendez-vous et son verrou de vie, puis quitte. Il ne lance pas de binaire.
4. Le Deck initiateur attend la fin de CE run, puis lance son propre `kory --avatar` et se rebranche. Les autres Decks reconnectent après une grâce bornée, sans relance concurrente immédiate. Le singleton arbitre une éventuelle course résiduelle ; toute attente/reprise est bornée et tracée. Un rendez-vous remplacé est relu et réauthentifié, jamais effacé de force. Aucun kill ni boucle de remplacement illimitée.

La matrice de tests doit couvrir : inconnu sans arrêt, ancien connu accepté par un avatar récent, demande explicite de remplacement, deux demandeurs, changement de run pendant la demande et échec de relance visible.

## 2. Canal des commandes

### Options

- A : réutiliser le RPC générique du companion (`ch` et `args`). Moins de vocabulaire, mais couplage à une surface bien plus large que `focus` et risque d'autorité excessive ; retrait ultérieur coûteux pour ses consommateurs.
- B : petit protocole typé sur le WSS avatar existant. Quelques types et validations supplémentaires, rayon d'impact limité au branchement ; ajout futur de commandes explicite et réversible avant publication.

### Recommendation

Retenir B : `wss://127.0.0.1:<port>/ws`, connexion ouverte par le Deck, sur le même serveur TLS que les routes HTTPS. Ni URL Deck entrante, ni `deck-control`, ni secret dans la query.

### Target design & migration path

- Upgrade : mêmes contrôles Bearer/Origin/certificat que HTTPS ; taille de frame bornée. Première frame du Deck : `{type: 'bind', protocol_version: 1, deckRunId, broker_url}`. L'avatar ne lie qu'un branchement accepté par `/attach` ; réponse `{type: 'bound', protocol_version: 1, deckRunId, broker_url}`.
- Avatar vers Deck : `{type: 'command', requestId, command: 'focus', deckRunId, broker_url}`. `requestId` est un UUID par geste, sans arguments libres. Le Deck valide l'enveloppe, l'identité exacte, la connexion courante et `AVATAR_COMMANDS = ['focus']` avant tout effet.
- Deck vers avatar : `{type: 'command_result', requestId, ok, error?}`. L'accusé décrit l'exécution/refus du handler, pas une preuve du premier plan OS. Délai borné, refus et absence de réponse visibles et tracés ; aucune commande rejouée après reconnexion.
- Un nouvel attach du même couple remplace sa connexion ; fermeture et callbacks d'une ancienne socket ne peuvent ni retirer ni commander la nouvelle. Le clic Tray autorise d'abord `AllowSetForegroundWindow(deckPid)` sur Windows, puis seulement l'envoi de `focus`.

## 3. Renommage

DÉDUIT : le renommage est dans A1, sans ambiguïté sur le palier : décision 18 (`docs/DESIGN-KORY-AVATAR.md:998-999`) et liste A1 (`:795-811`). `e458a48` ajoute la priorité du renommage explicite, sans reporter cette capacité. Les réglages existants ne portent que `autoAttach` et `projects[projectKey].optOut` (`desktop/src/main/avatar-settings.ts:8-15`, `:31-42`) ; cela ne réduit pas le contrat.

### Options

- A : livrer le geste de renommage dans A1. Coût d'une surface opérateur et de son état si le renommage workspace existant ne suffit pas ; respecte le palier annoncé.
- B : reporter le geste. Coût immédiat inférieur, mais modification de la décision opérateur 18 ; nécessite une dérogation explicite, ne peut pas être déduit de l'append technique de la carte.

### Recommendation

Retenir A. Ne pas ajouter silencieusement un alias global par projet : deux Decks du même projet doivent rester distinguables.

### Open questions for the supervisor

DÉDUIT : les passages cités fixent la priorité du nom explicite et sa transmission au branchement suivant, sans préciser dans ces passages la durée de vie ni la clé de persistance d'un alias distinct du workspace. Si un tel alias est nécessaire, le superviseur doit faire préciser sa portée avant d'ajouter son stockage. Ce point ne permet pas de reporter le renommage hors A1.

## Validation de l'état actuel

MESURÉ : `bun test ./tests/desktop-avatar-protocol.test.ts` donne `6 pass`, `0 fail`, `33 expect() calls`. DÉDUIT : le cas rejeté inclut `AVATAR_PROTOCOL_VERSION + 1` (`tests/desktop-avatar-protocol.test.ts:22-30`). Cette mesure porte sur l'existant, pas sur les ajouts proposés ici.
