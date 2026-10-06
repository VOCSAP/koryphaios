# ADR 005 : permissions et questions répondues par le module Claude Code, sans frappe dans le terminal

Statut : **proposé**, carte `173814b2-b963-46fd-85bc-0eb547c6c92e`. Décisions opérateur du 2026-10-06 transmises par le team-lead : F1 = attente dans `tool.check` avant le menu natif, bouton de réponse sur la tuile ; F4 = tout `AskUserQuestion` dans la carte. F2 et F3 tranchés par le lead sur recommandation. Les autres choix ci-dessous sont des choix de conception, pas des décisions attribuées à l'opérateur. Conception uniquement ; aucun changement de code n'est livré par cet ADR.

`MESURÉ` désigne une commande exécutée ou une sonde rapportée dans la carte ; `DÉDUIT` une conclusion tirée des sources citées ; `SUPPOSÉ` une propriété non vérifiée.

## Problem framing

Aujourd'hui un verdict donné dans le Courrier ou au téléphone est TAPÉ dans le PTY de la tuile (`buildKeystrokes`, `desktop/src/main/approval-service.ts:347-364`), sous la garde d'une vérification d'écran. La frappe ne nomme aucun dialogue, limite `AskUserQuestion` à une question, et laisse un dialogue à l'écran après règlement. Les function hooks de Claude Code (CLI >= 2.1.289) permettent au module du deck-plugin de rendre lui-même la réponse au moteur. La même capacité permet à un module d'ACCORDER une permission à la place de l'opérateur (`MESURÉ`, sonde D4c) : c'est la surface critique de cet ADR.

Forces : aucune réponse rendue sans verdict opérateur ; échec vers le menu natif, jamais vers un accord ; pas de double exécution d'un outil ; pas de double livraison d'un verdict ; la chaîne actuelle reste le repli (CLI ancien, sandbox).

## Current structure

- `MESURÉ` `desktop/deck-plugin/hooks/hooks.json:2,16-39` : un module (`kory-telemetry.mjs`) et le hook commande `approval-hook.mjs` sur `PermissionRequest` et `Notification`.
- `MESURÉ` `desktop/src/main/approval-runtime.ts:141-172` : un credential de session par FENÊTRE, fichier mode 600, partagé par toutes ses tuiles.
- `MESURÉ` `shared/approval.ts:232` : une session ne peut que `add` et `wait`.
- `MESURÉ` `broker.ts:8758`, `broker.ts:8670` : toute route autre que `channel` est ramenée à `pty`, à l'écriture et à la lecture.
- `MESURÉ` `desktop/src/main/approval-service.ts:403-415` : le poller ne s'abstient de frapper que pour la route `channel`.
- `MESURÉ` `broker.ts:9159-9174` : un verdict est `allow|deny|text` avec un seul `answer_text`.
- `MESURÉ` (sondes L0, L0bis, CC 2.1.291) : pas de `node:crypto` dans le moteur ; ordre `tool.call` puis `tool.check` puis dialogue ; `PermissionRequest` part après le retour de `tool.check` et jamais si celui-ci rend `allow` ; un second `next(e)` laisse le premier menu ouvert et permet une double exécution ; `{ deny }` retire le menu en ~150 ms ; `$.process.run` hérite de l'env, spawn bun médian 50 ms ; `answers` est indexé par le texte de la question.

## Options

### Où le module attend

- **A, course avec le menu natif** : `next(e)` en vol, premier arrivé gagne. Écartée pour les permissions : l'accord venu du Courrier exige un second `next(e)`, et la double exécution est `MESURÉE` (M1). Pour `AskUserQuestion` elle reste possible, mais le dialogue ouvert déclenche `PermissionRequest` (M4), donc une seconde ligne Courrier, un marqueur de désarmement, et la gestion du faux refus du `next` abandonné.
- **B, attente avant le menu natif** (retenue) : le module attend le verdict, puis rend la réponse ou laisse le moteur ouvrir son menu. Coût : pas de menu natif pendant l'attente, « Yes, always » indisponible. Compensé par le bouton de la tuile et la remise au terminal.

### Signature

- **Helper bun** (retenue) : zéro nouvelle forme d'authentification ; bun est déjà requis par tous les hooks commande du plugin.
- ed25519 en JavaScript pur dans le moteur : cryptographie portée à la main sur le chemin d'accord. Écartée.
- HMAC bâti sur `crypto.subtle.digest` : le broker stockerait un secret, contraire à `shared/approval.ts:101-106`. Écartée.

### Règlement

- **Op session `withdraw`** (retenue) : la session ferme sa propre ligne, sans verdict.
- Règlement par le Deck sur signal : le Deck signerait avec la clé opérateur une demande d'origine session. Écartée.

## Décision de conception

1. **Permissions : attente dans `tool.check`.** `v = await next(e)`. Si `v.decision !== 'ask'`, rendre `v`. Sinon lever la ligne (`add`), boucler sur `wait`. Verdict `allow` : rendre `{ decision: 'allow' }`. Verdict `deny` : rendre `{ decision: 'deny', reason }`, sans secret dans `reason` (le modèle le lit). Tout autre cas : rendre `v`, le moteur ouvre son menu et la chaîne actuelle prend le relais.
2. **`AskUserQuestion` : attente dans `tool.call`, AVANT `next(e)`.** Le module lève la ligne, attend, puis rend `{ result: { answers } }` sans appeler `next` (aucun menu, D4a). Sans verdict : `return next(e)`. Raison : seul `tool.call` peut rendre des réponses ; attendre avant `next` supprime le dialogue natif, donc le `PermissionRequest` en double, le marqueur et le faux refus. Les deux espèces partagent une seule machine d'attente.
3. **Un seul verdict accorde.** Une fonction totale lit la réponse de `wait` : seule `answered` + `allow` accorde, seule `answered` + `answers` valide répond, `answered` + `deny` refuse. Tout le reste (attente, remise au terminal, abandon, expiration, erreur du helper, JSON invalide) vaut « pas de verdict ». Le module n'élève jamais un verdict moteur autre que `ask`. Aucun `.catch` qui refuse : un hook en échec est sauté et le menu natif reste.
4. **Helper signataire.** `approval-client.mjs add|wait|withdraw`, lancé par `$.process.run` depuis `$.plugin.root`, lit le credential, signe avec `buildAuthProof` et parle au broker. Le module ne lit pas le fichier credential. Chaque `wait` dure moins de 30 s.
5. **Route `hook`.** Nouvelle valeur de `reply_route`, acceptée seulement avec `merge: 'never'`. Le poller du Deck la classe `settle` et ne frappe jamais. Le module exige l'écho de la route dans la réponse de `add`, sinon il n'attend pas.
6. **`withdraw` et vivacité.** Op session limité à une ligne de sa `session_ref`, non fusionnable, en attente ; statut `answered_terminal`, sans verdict. Colonne `last_wait_at` rafraîchie par chaque `wait` ; un `claim` sur une ligne `hook` sans attente récente est refusé et la ligne close, pour qu'une réponse ne parte jamais dans le vide après un crash du CLI.
7. **Remise au terminal.** L'opérateur peut rendre la main au menu natif : `claim` opérateur `handback`, que le module lit comme « pas de verdict ». C'est le chemin qui rend « Yes, always » et l'écran natif des questions.
8. **Schéma des questions.** La ligne porte `questions_json` (question, en-tête, options, multiSelect), bornée et nettoyée par le broker. Le verdict `answers` porte un objet indexé par le texte de la question ; le broker refuse une clé inconnue, et un libellé hors options n'est admis que comme texte libre borné. Le module revalide avant de rendre.
9. **Bouton de la tuile.** Une tuile dont une ligne `hook` est en attente affiche Autoriser, Refuser, ou le formulaire de questions, et la remise au terminal. Le bouton passe par le même `claim` que le Courrier.
10. **Repli.** Le Deck émet toujours `KORY_APPROVAL_MODULE` (`'1'` ou `''`) sur le prédicat de `desktop/src/main/session-service.ts:1393`. Route coupée en sandbox quelle que soit la version. Sans la variable, les handlers rendent `next(e)`.

## Mode de défaillance

| Panne | Effet |
|---|---|
| Broker ou helper indisponible | menu natif, chaîne actuelle |
| Module non chargé | chaîne actuelle, aucune ligne `hook` |
| CLI tué pendant l'attente | ligne close au premier `claim`, l'opérateur est prévenu |
| Opérateur absent | la tuile attend ; la remise au terminal reste possible |

## Points d'audit avant le lot permissions

1. Un plugin de projet d'un dépôt cloné peut-il charger son propre module décisionnel dans une tuile sans consentement.
2. `brokerUrl` vient d'un fichier réinscriptible par le même utilisateur : l'épingler par env au spawn, le helper refuse un fichier qui diverge.
3. La fonction de verdict est totale et rejette `NaN`, un statut inconnu et un `allow` sur une ligne qui n'est pas celle du module.
4. Aucun id d'approbation n'atteint un autre porteur du credential de fenêtre.
5. `withdraw` ne ferme ni une ligne fusionnable ni une ligne d'une autre session ; `claim` reste refusé à une session.
6. Le texte libre d'une réponse atteint le modèle : bornes, nettoyage, et aucune clé hors `questions_json`.
7. `reason` d'un refus et sortie du helper ne portent aucun secret.
8. Écriture du `.mjs` et du helper sur l'hôte ; projection en sandbox.

## Reste à mesurer

- Forme de `answers` pour une question à choix multiples (`SUPPOSÉ` : libellés joints par une virgule).
- `Notification` `agent_needs_input` part-elle pendant l'attente dans `tool.call`.
- Attente au-delà de 120 s dans `tool.check`.
- Arrêt du hook sur `next.signal` (Échap) et `withdraw` qui suit.
