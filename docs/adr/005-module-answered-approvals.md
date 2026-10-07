# ADR 005 : les permissions sont servies par le hook `PermissionRequest`, pas par `tool.check`

Statut : **accepté pour les permissions**, carte `b29a4ea4` (L8), issue de `173814b2`. Décisions opérateur du 2026-10-07 consignées dans la carte : plafond de 30 minutes, tous les outils sauf `AskUserQuestion` et `ExitPlanMode`. L'activation « sur les tuiles servies » de la première version ne tient plus : le hook sert dès qu'un credential d'approbation existe, sans lire `KORY_APPROVAL_MODULE`. **Décision du lead, en attente de confirmation opérateur pour le sandbox et les CLI non Claude.** Cet ADR remplace la proposition initiale (permissions servies dans `tool.check`, livrée puis retirée) ; il ne présente pas le traitement des questions par le module comme livré.

Les mentions `DÉDUIT` renvoient au code lu ; les observations rapportées sont distinguées des mesures exécutées pour ce document.

## Problème et contraintes

Le verdict distant doit régler la permission correspondant à l'appel, sans dépendre de la largeur de la tuile ni provoquer une seconde exécution. Le menu natif doit rester disponible quand le hook ne peut pas servir la demande. Un échec technique ne vaut ni accord ni refus opérateur.

**Contexte rapporté par l'opérateur dans la carte L8, non reproduit pour cette rédaction** : la garde d'écran ne peut pas transmettre le verdict distant d'un Bash long, dont l'affichage dépend de la largeur de la tuile. **DÉDUIT**, poll des verdicts de `desktop/src/main/index.ts` : le chemin PTY prépare la frappe, lit l'écran et exige `matchPermissionDialog` avant `service.write` ; enlever cette garde pour contourner le problème supprimerait la vérification du dialogue visé.

**Contrainte découverte à la livraison de la première version** : un mod `tool.check` répond après les règles et les `PreToolUse`, mais **avant** le classifieur du mode auto (documenté au 2026-10-07 : <https://code.claude.com/docs/en/permission-modes> et <https://code.claude.com/docs/en/permissions>, section « Extend permissions with hooks »). Servir depuis `tool.check` envoyait donc au Courrier chaque action non allowlistée d'une tuile en mode auto, que le classifieur aurait tranchée seul.

## Structure actuelle

| Frontière | Responsabilité déduite du code |
|---|---|
| Moteur Claude Code → hook | `PermissionRequest` ne se déclenche que lorsqu'un dialogue natif va s'ouvrir, donc après règles, `PreToolUse` et classifieur. Le plugin le déclare en commande bloquante, timeout 1860 s (`desktop/deck-plugin/hooks/hooks.json`). |
| Hook → helper | `approval-hook.ts` appelle `runApprovalClient` en processus (`add`, `wait`, `withdraw`), sans spawn de `approval-client.mjs` par le module (`desktop/hooks/approval-hook.ts`, `desktop/hooks/approval-client.ts`). |
| Helper → broker | `add` porte `session_ref`, `tile_ref`, `reply_route: 'hook'` et `merge: 'never'` ; `wait` et `withdraw` portent l'id et le secret producteur (`buildSignedRequest`). |
| Réponse broker → verdict | `verdictOf(expectedId, helperOutput)` valide la forme et l'identité avant de produire `allow`, `deny`, `wait` ou `none` (`desktop/hooks/approval-verdict.ts`). |
| Hook → moteur | Un seul JSON sur stdout (`hookSpecificOutput`, `hookEventName: "PermissionRequest"`, décision `allow` ou `deny`) ; sinon sortie 0 sans stdout. |
| Deck → livraison | `classifyVerdict` classe les réponses `hook` comme `settle`, pas comme frappe ; la livraison PTY des autres routes conserve sa vérification d'écran (`desktop/src/main/approval-service.ts`, `desktop/src/main/index.ts`). |
| Module `tool.check` | Ne fait plus que de la télémétrie : une ligne de debug lorsqu'un `ask` éligible passe et que `KORY_APPROVAL_MODULE` vaut `'1'`. Il rend toujours le verdict du moteur (`desktop/hooks/kory-approvals.ts`). |

**DÉDUIT**, `desktop/src/main/session-service.ts` (calcul de `koryModuleServed` et `sessionEnv`) : le Deck émet `KORY_APPROVAL_MODULE='1'` seulement pour un lancement Claude hors sandbox, avec le plugin fourni et le support hôte requis. Cette variable ne gouverne plus que la télémétrie du module : `approval-hook.ts` ne la lit pas et sert dès que `loadConfig` trouve un credential d'approbation.

## Options et recommandation

- **Option A : conserver la frappe comme chemin principal.** Coût immédiat faible et retour arrière simple. Risque : le verdict reste tributaire du contenu visible du dialogue ; élargir la reconnaissance d'écran étend la surface de la garde. La difficulté des commandes longues demeure.
- **Option B : servir la permission dans `tool.check`.** Réglait l'id et la largeur de tuile, mais court-circuite le classifieur auto. **Écartée après livraison** : le Courrier recevait plus que ce que le terminal aurait demandé.
- **Option C : servir la permission depuis le hook `PermissionRequest`, bloquant.** Même règlement par id d'approbation, au point où le terminal demanderait réellement. Coût : un processus de hook qui vit jusqu'à 30 minutes. Risque : le hook produit un `allow`, donc `verdictOf` et la garde d'entrée sont des frontières d'autorisation. Réversibilité : toute sortie sans stdout rend la main au menu natif.

**Recommandation retenue : option C.** La force décisive est de ne s'exécuter que lorsqu'un dialogue natif va réellement s'ouvrir, quel que soit le mode, tout en réglant l'appel par son id plutôt que par la représentation du dialogue. Il ne s'agit pas d'assouplir la garde d'écran.

## Décision et contrat du chemin hook

### 1. Admissibilité et contenu présenté

**DÉDUIT**, `main()` de `desktop/hooks/approval-hook.ts` : le hook ne sert que `hook_event_name === "PermissionRequest"` (`classifyPayload`). `AskUserQuestion` et `ExitPlanMode` ne sont jamais servis (`EXCLUDED_PERMISSION_TOOLS`) : sortie sans stdout, rien n'est posé au Courrier. Sans credential (`loadConfig` nul), le hook sort aussi sans rien faire.

**Garde avant tout `add`** (`hasUnsafePermissionRepresentation`) :

- Dans `tool_input`, tout caractère `\p{Cf}`, `\p{Zl}`, `\p{Zp}` ou `\p{Cc}` rend l'appel inadmissible, récursivement sur tableaux et objets, clés comprises. Seuls `\n` et `\t` sont admis, et seulement dans les valeurs ; une clé est contrôlée sans exemption.
- `tool_name` et `cwd` sont contrôlés sans exemption : un saut de ligne y est refusé.
- Un `tool_name` ou un `cwd` présent mais non textuel vaut dangereux.

Un appel inadmissible n'est pas refusé : il retombe sur le menu natif. Cette garde remplace l'ancien repli du module, qui ne cherchait `\p{Cf}`, `\p{Zl}` et `\p{Zp}` que dans le titre résumé et la question déjà coupée. **DÉDUIT** : la détection porte désormais sur l'input entier avant coupe. La suite prévue par la carte `0bc8cbab` (L8.5a, détection et révélation côté broker) n'est pas évaluée ici ; **non vérifié**.

**DÉDUIT**, `buildApprovalRequest` : la question contient `The agent wants to use <outil>.`, puis `Input: <JSON>`, puis `Working directory: <cwd>` ; elle est bornée par `capVisibly(..., APPROVAL_QUESTION_MAX)`, soit 4000 points de code avec un marqueur de coupe visible portant la longueur d'origine (`shared/approval.ts`, `shared/text.ts`). Le titre est `summarizeToolInput`, dont le détail est coupé à `TITLE_DETAIL_MAX` (`desktop/hooks/tool-summary.ts`). La commande n'est plus placée en tête verbatim et n'est pas garantie entière.

### 2. Un seul interpréteur du verdict

**DÉDUIT**, `desktop/hooks/approval-verdict.ts` : `verdictOf` lit uniquement les propriétés propres de données ; les propriétés héritées et les getters ne comptent pas. L'implémentation est une succession de `if`, pas une table exhaustive typée.

| Réponse du helper | Résultat |
|---|---|
| Id attendu vide ou `ok !== true` | `none` |
| `pending === true`, sans propriété de données `approval` définie | `wait` ; si une approbation accompagne ce marqueur, `none` |
| Approbation dont `id` diffère ou dont `reply_route !== 'hook'` | `none` |
| Bonne ligne, statut `pending` ou `expired_notif` | `wait` |
| Bonne ligne, statut `answered`, `answer_kind` égal à `allow` ou `deny` | Respectivement `allow` ou `deny` ; tout autre cas donne `none` |

Cette dernière branche exclut notamment `answered_terminal`, `abandoned`, les statuts inconnus, ainsi que les réponses `text` et `answers`. Un texte opérateur n'est jamais converti en permission.

### 3. Attente et retrait

**DÉDUIT**, `servePermissionRows` : après un `add` qui rend un id et un secret producteur non vides, le hook boucle sur `wait`. Chaque poll dure au plus 25 s (`PERMISSION_WAIT_SEC`, réduit au temps restant) ; le budget total est de 30 minutes (`PERMISSION_BUDGET_MS`, 1800 s), mesuré sur l'horloge monotone (`performance.now()`) et propagé aux requêtes par un `AbortSignal`. Le timeout de 1860 s de `hooks.json` laisse 60 s de marge au retrait. `allow` écrit `{behavior: "allow"}` ; `deny` écrit `{behavior: "deny", message: "Denied by the operator from Koryphaios"}`. `answer_text` et les suggestions de permission ne sont jamais renvoyés.

`none` (y compris un échec du helper, tracé), le budget épuisé ou toute exception font tenter `withdraw`. Si le retrait réussit, le hook sort sans stdout et le menu natif décide. Si le retrait échoue en `HTTP 409`, la ligne a été réglée entre-temps : une dernière lecture de `WITHDRAW_GRACE_SEC` (20 s) peut encore écrire un `allow` ou `deny` valide, pour ne pas perdre un verdict déjà accepté. Un autre échec de retrait est tracé et le hook sort sans stdout. Une exception après un `add` réussi déclenche le même retrait (`servePermission`).

**Session principale : le menu natif reste affiché pendant l'attente ; la première réponse, terminal ou Courrier, l'emporte.** Sonde de course rapportée par le commit `c9492be` : PTY Claude Code 2.1.292, 11 essais sans double exécution (`hyp_96d4d83c`), non rejouée pour ce document. **Sous-agents en arrière-plan : ce n'est pas vrai.** Le hook y est attendu AVANT la construction du dialogue, donc aucun menu natif pendant l'attente, jusqu'à 30 minutes (<https://github.com/anthropics/claude-code/issues/82150>, ouverte : « PermissionRequest hook is awaited before the local dialog for background subagents; the main session runs them in parallel »).

**Côté broker** (`handleApprovalWait`, `hookProducerGone`, `abandonIfHookProducerGone`) : une permission de route `hook` a une échéance absolue de 30 minutes depuis sa création, indépendante de l'horodatage du dernier `wait`. Passée l'échéance, la ligne devient `abandoned`, les waiters en cours sont réveillés et un claim tardif est refusé (410, couvert par `tests/broker-approvals.test.ts`). Le temps d'un long poll est ramené au temps restant avant l'échéance, et le timer d'un `wait` se résout toujours. L'échéance ne s'applique pas aux questions de route `hook`. La borne d'un long poll `hook` reste distincte : 30 s (`HOOK_WAIT_MAX_SEC`, `shared/approval.ts`).

### 4. Repli et conséquences

Le repli est **le menu natif**, jamais une réponse fabriquée : panne du helper, broker injoignable, sortie invalide, `add` sans id ou secret, garde d'entrée, outil exclu, budget épuisé. Le hook n'accorde pas sur un défaut technique et ne refuse pas non plus. La garde d'écran et la frappe PTY restent le chemin des routes `pty` : la question du hook `Notification` (`agent_needs_input`, posée sans route `hook`) et les approbations des autres CLI. **DÉDUIT**, `postQuestion` n'envoie pas de `reply_route` et une route absente se résout en `pty` (`resolveReplyRoute` accepte `hook` et `channel`) ; le poll des verdicts de `index.ts` exige `matchPermissionDialog` pour une permission et `permissionDialogShown` négatif pour le reste. La route `hook` n'est pas frappée par le Deck.

Conséquences :

1. Le Courrier reçoit ce que le terminal aurait demandé, y compris en mode auto, et un appel n'est plus réglé par la reconnaissance d'un Bash long à l'écran.
2. La panne reste un manque de verdict distant, non une autorisation. Les traces du hook vont sur stderr (`trace`) ; le puits de journal du hook relève de la carte `04df2b93` et n'est pas livré.
3. **Ligne fantôme acceptée**, mesurée sur la carte `b29a4ea4` (sonde de course) : sur Non ou Échap au terminal, l'arbre de processus du hook est tué en ~200 ms, donc `hookProducerGone` retire la ligne environ une minute plus tard (waiter parqué jusqu'à 25 s, puis `HOOK_WAIT_STALE_MS` = 45 s dans `broker.ts`), balayée sur `/approval/list` et sur claim ; sur Oui, le hook n'est ni tué ni prévenu et continue de boucler, donc la ligne reste jusqu'à l'échéance de 30 minutes. Zéro fantôme : carte `56689093` ; bail de fermeture de tuile : carte `6dbebca2`.
4. L'attente est bornée et la course retrait/réponse est traitée explicitement.
5. **Limites de Claude Code**, documentées au 2026-10-07 : `PermissionRequest` ne se déclenche que lorsqu'un dialogue va s'afficher, porte `permission_mode`, n'a pas de `tool_use_id` (la ligne ne se rattache donc pas à l'appel d'outil) et son `allow` ne surcharge pas une règle `deny` ni `ask` des réglages (<https://code.claude.com/docs/en/hooks>). En `--bg`, la décision du hook est écartée (<https://github.com/anthropics/claude-code/issues/88698>, ouverte). Les teammates agent-teams ne dispatchent jamais le hook (<https://github.com/anthropics/claude-code/issues/82418>, vue par renvoi croisé seulement, non lue directement). Pour la concurrence hook/dialogue, voir §3 : session principale seulement.
6. Les exclusions et la coupe visible ne doivent pas être masquées par une promesse « toutes les permissions ». La partie coupée n'est pas lisible et la coupe ne constitue pas une analyse de sécurité de la commande.

## Questions (non livré côté module seulement)

Décision opérateur F4 (2026-10-06) : tout `AskUserQuestion` va dans la carte. Les colonnes `questions_json` et `answers_json` existent côté broker, avec une validation des questions à la création (`broker.ts`), et les parties Deck et Courrier sont livrées (d'après le lead, non revérifié ici) ; seul le côté module ne l'est pas. Conception, non implémentée : le module attend dans `tool.call`, AVANT `next(e)`, lève la ligne, puis rend `{ result: { answers } }` sans appeler `next` (aucun menu). `answers` est un objet indexé par le texte de la question. Sans verdict : `next(e)`. Aujourd'hui `AskUserQuestion` n'est jamais servi et `tool.call` délègue à `next(e)`.

Mesure N1 (carte `173814b2`, Claude Code 2.1.291, PTY réel, non rejouée ici) : pour un `multiSelect` avec Apple et Cherry cochés, `answers` vaut `{"Pick fruits?":"Apple, Cherry"}`, une seule chaîne jointe par `", "` dans l'ordre d'affichage des options, de même forme que le choix simple. Le module doit produire lui-même cette chaîne ; un libellé contenant `", "` la rendrait ambiguë (non testé).

## Points d'audit qui s'appliquent encore au hook

Le hook décide dans une tuile, donc ces points de la conception initiale restent à tenir ; leur état n'a pas été revérifié pour ce document (**SUPPOSÉ**) :

1. Un plugin de projet d'un dépôt cloné peut-il charger son propre hook décisionnel dans une tuile sans consentement.
2. `brokerUrl` vient d'un fichier réinscriptible par le même utilisateur : l'épingler par env au spawn, refuser un fichier qui diverge.
3. Le secret producteur ne doit atteindre aucun autre porteur du credential de fenêtre ; `withdraw` ne ferme ni une ligne fusionnable ni une ligne d'une autre session.

## Rejets motivés (hérités)

- **ed25519 en JavaScript pur dans le moteur** : cryptographie portée à la main sur le chemin d'accord ; le moteur n'a pas `node:crypto` (sondes L0). Le hook signe en processus avec `buildAuthProof`, via `runApprovalClient`.
- **HMAC sur `crypto.subtle.digest`** : le broker devrait stocker un secret partagé, alors que `shared/approval.ts` ne lui fait stocker que la clé publique : la session garde sa clé privée et signe avec (`buildAuthProof(cfg.privateKey, ...)` dans `approval-hook.ts`).
- **Règlement par le Deck sur signal (`withdraw` signé par la clé opérateur)** : le Deck signerait une demande d'origine session ; le `withdraw` reste une op de session.

## Sondes d'ordre des événements

Sondes L0 et L0bis, Claude Code 2.1.291, rapportées dans la carte `173814b2` et non rejouées ici : ordre `tool.call`, puis `tool.check`, puis dialogue ; `PermissionRequest` part après le retour de `tool.check` et jamais si celui-ci rend `allow`. Ces sondes établissent l'ordre des événements ; le rejet de l'option B repose sur l'ordre avec le classifieur auto (voir « Options et recommandation »). La double exécution mesurée (M1) concernait un second `next(e)` dans `tool.call`, forme « course » écartée après cette mesure ; attendre dans `tool.check` avait été retenu pour l'éviter.

## Périmètre futur et migration

1. **Conserver le repli existant.** Cette décision n'autorise ni la suppression de la garde d'écran des routes `pty` ni son relâchement ; la sortie sans stdout reste le mode dégradé du hook.
2. **Séparer les questions des permissions.** La proposition initiale d'attendre `AskUserQuestion` dans `tool.call` pour rendre `{ result: { answers } }` reste hors du périmètre livré ici : le handler `tool.call` actuel délègue à `next(e)`. Ne pas documenter une machine d'attente commune comme réalisée.
3. **Zéro fantôme et bail de tuile** : cartes `56689093` et `6dbebca2`.
4. **Preuves PTY restantes** (mode `accept-edits`, règle `ask`) : annoncées comme reste à faire (« C3 ») par le commit `c9492be`. Aucune n'est rapportée ici.

Aucun test runtime ni nouvelle sonde PTY n'a été exécuté pour cette mise à jour documentaire ; les références de code établissent le comportement décrit, pas une nouvelle certification de toutes ses branches.
