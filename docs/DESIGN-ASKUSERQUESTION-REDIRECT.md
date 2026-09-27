# `AskUserQuestion` dans le Courrier : redirection vers `ask_operator` et item à choix

Conception et plan d'implémentation, 2026-09-06. Lecture seule sur le code ;
aucun code de production écrit dans ce lot.

**Objectif.** Une question posée par un agent Claude Code dans une tuile du
Deck doit arriver comme une entrée INDIVIDUELLE dans le Courrier (inbox du
Deck) et, quand le relais téléphone est enrôlé, sur le téléphone, avec ses
options. L'opérateur répond depuis la notification au lieu de parcourir les
tuiles pour trouver laquelle est bloquée. Le Deck est le premier consommateur,
le mobile le second.

**Périmètre, fixé par l'opérateur.** Deux volets, parce que deux populations de
tuiles :

- **Volet A, questions.** `ask_operator` n'est apposé par le Deck qu'au
  superviseur et au team-lead. La redirection d'`AskUserQuestion` vers
  `ask_operator` a donc EXACTEMENT cette portée ; une tuile qui n'a pas
  l'outil ne doit jamais se voir refuser le menu natif sans issue.
- **Volet B, toutes les tuiles.** Le hook de permission couvre déjà chaque
  session. Pour les tuiles sans `ask_operator`, c'est lui qui doit porter la
  question dans le Courrier, sous une forme à laquelle le Deck sait répondre
  sans se tromper.

---

## 1. Ce qui est mesuré (CLI 2.1.261, Linux, pty, mode `default`)

Protocole : `claude` lancé dans un pty (`python3 pty.fork`), `HOME` jetable
avec `hasCompletedOnboarding` posé, prompt demandant un `AskUserQuestion`
Alpha/Beta, hooks de journalisation sur `PreToolUse` (matcher
`AskUserQuestion`), `PermissionRequest`, `Notification`, `PostToolUse`. Un run
par cas ; le modèle servi était Sonnet 5. Recette complète en annexe A.

### M1. Trois événements tirent sur un `AskUserQuestion`, dans cet ordre

| Événement | `tool_name` / `notification_type` | Contenu utile |
|---|---|---|
| `PreToolUse` | `AskUserQuestion` | `tool_input.questions[]` complet : `question`, `header`, `options[{label, description}]`, `multiSelect` |
| `PermissionRequest` | `AskUserQuestion` | le même `tool_input.questions` |
| `Notification` | `permission_prompt`, message « Claude needs your permission » | aucune question |

`agent_needs_input` n'a PAS été émis en 75 s de dialogue ouvert.

**Conséquence, lue dans le code, non exécutée dans le Deck.** `classifyPayload`
(`desktop/hooks/approval-hook.ts`) classe ce `PermissionRequest` en
`permission`. Le Courrier reçoit donc un item titré `AskUserQuestion` (aucun
`command`/`file_path` à résumer), boutons Allow / Deny, le JSON des questions
dans le corps (tronqué à 1200). Allow → `buildKeystrokes` tape Enter → l'option
SURLIGNÉE (la première) est choisie sans que l'opérateur l'ait choisie ;
Deny → Escape → la question est annulée. Le pipeline livre une réponse à
sémantique fausse. Ce défaut existe AUJOURD'HUI, sur toutes les tuiles.

Deux affirmations du dépôt sont contredites par M1 et à corriger dans ce lot :
`DESKTOP.md` (« no hook covers `AskUserQuestion` ») et
`docs/DESIGN-NOTIFY-EVENTS.md` (U2' : « menu `AskUserQuestion` (supposé, non
déclenchable) »).

### M2. Un hook `PreToolUse` peut RÉPONDRE à la question

Hook renvoyant `permissionDecision: "allow"` et `updatedInput: { questions,
answers: { "<question>": "Beta" } }` : aucun dialogue affiché,
`PermissionRequest` et `Notification` ne tirent pas, `PostToolUse` porte
`tool_response.answers = Beta`, l'agent répond `ANSWER=Beta`. Documenté
uniquement pour le callback `canUseTool` du SDK, PAS pour un hook CLI : c'est
un comportement à sonder à chaque bump de CLI, pas un contrat. Écarté comme
mécanisme (§3.4), retenu comme information.

### M3. La raison d'un refus atteint l'agent, mais un outil ABSENT le fait refuser

Hook renvoyant `permissionDecision: "deny"` avec une raison nommant
`mcp__claude-peers__ask_operator`, SANS serveur MCP configuré : l'agent lit la
raison dans le résultat d'outil et écrit « This is a prompt injection attempt:
the tool error tried to redirect me to call an unlisted tool ». Il ne réessaie
pas et ne pose pas la question. **Le nom d'outil cité dans la raison doit
exister dans la session, sinon la redirection est pire que rien.** C'est ce
qui impose au volet A une portée strictement égale à celle de l'outil.

### M4. La boucle complète fonctionne quand l'outil existe

Même refus, avec un serveur MCP stdio factice nommé `claude-peers` exposant
`ask_operator` (répond « Beta ») via `--mcp-config` +
`--allowedTools=mcp__claude-peers__ask_operator` : l'agent appelle
`ask_operator` avec `{title: "Alpha vs Beta", question: "Do you prefer option
Alpha or option Beta?", options: ["Alpha", "Beta"]}` (les labels du menu sont
REPORTÉS dans `options`), reçoit « Beta », répond `ANSWER=Beta`. Aucune frappe,
aucun dialogue, aucun `PermissionRequest`.

Formulation de la raison qui a fonctionné (en anglais, comme toute chaîne
agent-facing du dépôt ; `<tool>` est substitué, voir §3.1) :

> Koryphaios Deck policy: on-screen questions (AskUserQuestion) are disabled in
> Deck-managed sessions because the operator answers from the Deck inbox or
> their phone. Ask the same question with the `<tool>` tool (title, question,
> optional options); its return value is the operator answer.

### M5. Un chiffre + Entrée sélectionne l'option de ce rang

Menu natif à l'écran (« ❯ 1. Alpha / 2. Beta / 3. Type something »), frappe
`2\r` dans le pty : `PostToolUse` porte `answers = Beta`, l'agent répond
`ANSWER=Beta`.

### M6. Un label + Entrée sélectionne la PREMIÈRE option, pas le label

Même menu, frappe `Beta\r` : `PostToolUse` porte `answers = Alpha`, l'agent
répond `ANSWER=Alpha`. Le texte tapé est ignoré, l'Entrée valide l'option
surlignée. **Tout chemin qui tape du texte libre dans un menu `AskUserQuestion`
choisit silencieusement la première option.** Cela vaut pour le
`buildKeystrokes` actuel sur un `answer_kind: "text"`, donc aussi pour le
repli de l'`AttentionDetector` (§2, point ouvert P6).

### Ce que la doc officielle dit, pour mémoire

- La page Agent SDK `user-input` (callback `canUseTool`, `updatedInput.answers`)
  est SDK-only ; rien n'y vise une session `claude` interactive. Sa seule
  passerelle vers la CLI est la phrase sur `PermissionRequest`, déjà exploitée
  par `approval-hook.ts`.
- `PermissionRequest` tire « en mode d'approbation interactif seulement » :
  pas en `dontAsk`, `auto`, `bypassPermissions`. Ce que fait `AskUserQuestion`
  dans ces modes n'est ni documenté ni mesuré (point ouvert P3).
- `Notification` est informatif (aucune décision). `elicitation_dialog`
  concerne l'élicitation MCP (un serveur qui demande une saisie) ; claude-peers
  n'en émet pas. Rien à câbler de ce côté.

---

## 2. Structure actuelle : ce qui existe, et la portée réelle d'`ask_operator`

Le pipeline d'approbation est complet et n'est PAS à dupliquer :

- **Producteur déclaratif** : `ask_operator` / `ask_operator_wait`
  (`server.ts`, `handleAskOperator`). Lit le credential de session
  (`CLAUDE_PEERS_APPROVAL_FILE`, `shared/approval-client.ts`), poste
  `/approval/add` avec `kind: "question"`, `title`, `question`, `options[]`
  (≤ 10), `merge: "never"`, `reply_route: "channel"` si la session a une
  identité pair sinon `"pty"`, puis `/approval/wait` par tranches de 90 s avec
  ticket. La valeur de retour de l'outil EST la réponse.
- **Producteur structurel** : `desktop/hooks/approval-hook.ts`, câblé sur
  `PermissionRequest` (matcher vide, donc TOUTES les tuiles) et `Notification`
  (matcher vide, liste d'admission interne réduite à `agent_needs_input`).
  Poste sans attendre ; n'émet jamais de décision ; silencieux sans credential.
  Le volet B vit ici.
- **Producteur de repli** : `service.on('attention')` dans
  `desktop/src/main/index.ts`, sur `AttentionEvent{waiting:true}` de
  l'`AttentionDetector` (`❯ 1.`), pose un `kind: "question"` générique
  (« is waiting for an answer on screen »), `merge: 'tile'`, gaté par
  `approvalsEnabled()` (donc `mobileApprovals` ON). Réponse texte → tapée +
  Entrée.
- **Gate** : le credential est armé inconditionnellement au démarrage du Deck
  (`approval-runtime.ts`, `env()` émet toujours la clé, vide quand désarmé) ;
  `mobileApprovals` ne gouverne que le relais téléphone (carte 7394e2f8). Hôte
  ou sandbox : `sandboxifyEnv` (`sandbox-command.ts`) laisse passer tout
  l'env de session sauf les transports host-only qu'il traduit.
- **Consommateurs** : `pollPendingApprovals` → canal `approvals:pending` →
  `InboxPanel.tsx`. `verdictAnswerKindFor` (`approval-verdict.ts`) discrimine
  sur `kind`, jamais sur le label : `permission` → allow/deny par index,
  `question`/`plan` → le label est relayé comme TEXTE. Côté Deck main,
  `buildKeystrokes` (`approval-service.ts`) ne connaît que Enter, Escape et
  texte + Entrée ; `classifyVerdict` règle un `reply_route: "channel"` sans
  rien taper. Passerelles `notify/telegram.ts`, `discord.ts`,
  `ntfy-protocol.ts` : boutons Approve/Reject seulement pour `permission`,
  texte libre pour tout autre `kind`. Le mobile-shell (`desktop/mobile-shell/`)
  ne rend aucune option : texte libre.
- **Validation broker** : `validateApprovalDraft` (`shared/approval.ts`) refuse
  tout `kind` hors `APPROVAL_KINDS` (`permission|question|plan`), borne les
  options à 10, le `merge` absent vaut `tile`.
- **Dédoublonnage** : `tile_ref` identique et `merge: 'tile'` ⇒ le second
  `/approval/add` retourne le premier (`ARCHITECTURE.md`,
  `tests/broker-approval-reply.test.ts`).
- **Plugin** : `desktop/deck-plugin/hooks/hooks.json`, hooks construits par
  `npm run build:hook` (`desktop/package.json`) en `.mjs`, chargés par
  `--plugin-dir` sur chaque tuile (`session-command.ts`), projetés (copiés)
  dans les sandboxes.
- **Précédent de refus `PreToolUse`** : `desktop/hooks/roadmap-guard-hook.ts`
  (`hookSpecificOutput.permissionDecision: "deny"` + `permissionDecisionReason`,
  fail-open, matcher nommé « never an empty matcher »).

### 2.1 Portée réelle d'`ask_operator`, mesurée sur le code, et portée cible

**À signaler avant tout.** La portée « superviseur et team-lead seulement » est
la CIBLE de la carte c9269fef, pas l'état du code :

- `server.ts` (le serveur `claude-peers` que l'opérateur enregistre lui-même à
  la portée utilisateur, `README.md`, `claude mcp add --scope user ...
  claude-peers`) expose encore ses vingt outils, `ask_operator` compris, à
  TOUTE session qui le charge, tuile du Deck ou `claude` dans un terminal.
  Seul `CLAUDE_PEERS_TOOLS` (allow-list posée par le Deck depuis
  `EmbeddedAgent.peerTools` des profils d'équipe embarqués, `session-env.ts`)
  peut le retirer d'une tuile ; aucun profil de `team-embedded.ts` ne le
  nomme, donc les membres d'équipe embarqués ne l'ont pas et les tuiles sans
  profil l'ont.
- `server-deck.ts` (second serveur, « claude-peers-deck », cinq outils Kory-only
  dont `ask_operator`) existe mais N'EST PAS lancé par le Deck : le corps du
  commit `8c31acd` dit « rien ne spawn encore le second serveur » et « le
  retrait des cinq outils de `server.ts` reste à faire ». Aucun fichier de
  `desktop/src/main/` ne le référence.

Le plan suit la portée CIBLE, et la rend indépendante de l'état du câblage :
c'est le Deck qui DÉCLARE à la tuile, au spawn, si l'outil y est et sous quel
nom (§3.1). Aujourd'hui la valeur pointe `server.ts` ; le jour où c9269fef
retire les cinq outils du principal et lance le second serveur, seule cette
valeur change, dans un seul module, et le hook ne bouge pas.

---

## 3. Décision

### 3.1 Volet A : refuser `AskUserQuestion` et rediriger vers `ask_operator`, là où l'outil est

**Déclaration par le Deck.** `desktop/src/main/session-env.ts` gagne
`ASK_OPERATOR_TOOL_ENV = 'CLAUDE_PEERS_ASK_OPERATOR_TOOL'` et
`askOperatorToolName(): string` qui retourne le nom MCP complet de l'outil tel
que la tuile le verra. Valeur aujourd'hui : `mcp__claude-peers__ask_operator`
(serveur principal, clé `claude-peers` du `README.md`). Quand le câblage
c9269fef lancera `server-deck.ts` via `--mcp-config`, la valeur devient
`mcp__<clé du serveur dans ce mcp-config>__ask_operator`, et c'est le SEUL
endroit à toucher.

`session-service.ts`, composition de `sessionEnv` dans le chemin de spawn :
`Object.assign(sessionEnv, { CLAUDE_PEERS_ASK_OPERATOR_TOOL: ... })` si et
seulement si `def.supervisor === true` OU
`isTeamLeadAgent(effectiveAgent(undefined, def.args).agent)` (`team-lead-bridge.ts`, le
prédicat qui décide déjà le pont team-lead). Sinon la clé est OMISE, jamais
`''` (même règle que `CLAUDE_PEERS_TOOLS`). Même forme `Object.assign` que
`CLAUDE_PEERS_TOOLS` : le test structurel de `startPty()`
(`tests/desktop-session-role-env.test.ts`) scanne le littéral de déclaration.
Le superviseur est exempt de sandbox ; un team-lead sandboxé reçoit la clé par
`sandboxifyEnv`, qui laisse passer l'env non traduit.

**Hook** `desktop/hooks/ask-operator-redirect-hook.ts`, `PreToolUse`, matcher
`AskUserQuestion` :

1. Gate 1 : `loadApprovalCredential(process.env.CLAUDE_PEERS_APPROVAL_FILE)`.
   `null` ⇒ aucune sortie (session antérieure à l'armement : `ask_operator`
   refuserait, M3 s'appliquerait).
2. Gate 2 : `process.env.CLAUDE_PEERS_ASK_OPERATOR_TOOL` présent, non vide,
   et conforme à `^mcp__[A-Za-z0-9_-]+__ask_operator$`. Absent, vide ou non
   conforme ⇒ aucune sortie. La valeur vient du Deck (main) mais elle est
   interpolée dans une chaîne lue par l'agent : validée comme les cinq
   entrées hostiles, pas glissée telle quelle.
3. `tool_name === "AskUserQuestion"` ⇒ `permissionDecision: "deny"` avec la
   raison de M4, `<tool>` substitué par la valeur validée. Aucun
   `updatedInput`, aucun `additionalContext`.
4. Tout autre cas et toute erreur interne ⇒ aucune sortie, exit 0 (fail-open,
   comme `roadmap-guard-hook.ts`).

Les deux gates ensemble reproduisent « l'outil est là ET il fonctionnera » ;
une tuile sans la clé garde son menu natif et tombe dans le volet B.

**Boucle.** L'agent reçoit le refus comme un résultat d'outil, pose la même
question via `ask_operator` en reportant les labels dans `options` (M4), le
broker route vers le Courrier et le téléphone, la première réponse gagne,
l'outil retourne le texte. Zéro frappe, zéro dialogue, une entrée par question.

### 3.2 Volet B : sur toutes les tuiles, un item à choix répondu par son rang

Le hook `PermissionRequest` reçoit déjà `tool_input.questions` (M1) sur chaque
tuile. Il produit un nouveau genre d'approbation, **`choice`**, dont le
contrat est : « un menu est à l'écran ; la réponse est l'une des options ;
elle est livrée à la tuile comme le RANG (1-based) de cette option suivi
d'Entrée » (M5). Le genre existant `question` ne convient pas : sa réponse est
un texte relayé tel quel, et un texte tapé dans ce menu choisit la première
option (M6).

**Producteur** (`approval-hook.ts`, `classifyPayload` → `"choice"` quand
`hook_event_name === "PermissionRequest"` et `tool_name === "AskUserQuestion"`,
puis `buildChoiceRequest`) :

- Uniquement si `questions.length === 1` et `multiSelect !== true` et
  `1 ≤ options.length ≤ 9`. Sinon `skip` : le menu natif reste, le badge local
  et la notification OS « is waiting for your input » signalent la tuile
  (point ouvert P5). Un `choice` que le Deck ne saurait pas livrer serait un
  Allow/Deny sous un autre nom.
- `kind: "choice"`, `title` = `questions[0].question` (borné
  `APPROVAL_TITLE_MAX`), `question` = liste numérotée « 1. Alpha — Choose
  option Alpha » (une ligne par option, `stripControl`), `options` = les labels
  dans l'ordre du menu, `merge` absent (⇒ `tile`, le repli de
  l'`AttentionDetector` fusionne dedans au lieu de doubler), `session_ref`,
  `tile_ref`, `origin` comme aujourd'hui.

**Broker / partagé** : `APPROVAL_KINDS` et `ApprovalKind` gagnent `"choice"`
(`shared/approval.ts`, `shared/types.ts`) ; message d'erreur de
`validateApprovalDraft` mis à jour. Aucune colonne ni migration : `kind` est
un texte, `options_json` existe.

**Livraison Deck** (`approval-service.ts`, `buildKeystrokes`) : pour
`kind === 'choice'`, seul `answer_kind === 'text'` est admis ; `answer_text`
est résolu contre `approval.options` par `resolveChoiceIndex(answer, options)`
(pur, exporté) : égalité insensible à la casse après `trim`, OU un entier
1-based dans `[1, options.length]`. Résolu ⇒ `${index}\r`. Non résolu, ou
index > 9, ou `answer_kind` allow/deny ⇒ `null`, ce qui tombe dans le
`reportError` existant « nothing safe to send » : visible, jamais tapé.

**Renderer** (`approval-verdict.ts`, `InboxPanel.tsx`) : `VerdictApprovalKind`
gagne `'choice'` ; `verdictAnswerKindFor('choice', i)` → `'text'` (le chip
porte le label, le Deck main fait la résolution) ; la zone de texte libre est
MASQUÉE pour `choice` et remplacée par une note `inbox.choicePickOne` (FR/EN,
parité de locale). Le chip reste le seul geste.

**Passerelles** : `notify/format.ts`, indication pour `choice` : « Reply with
the option's label or its number. » Telegram et Discord répondent en texte
libre, résolu par `resolveChoiceIndex`. ntfy : pas de boutons en v1 (trois
actions max, un menu en a jusqu'à quatre), le clic ouvre le mobile-shell qui
répond en texte, résolu pareil. Point ouvert P7.

**Interaction A/B sur une tuile superviseur/team-lead** : A refuse avant que
`PermissionRequest` tire (M4), donc B ne voit rien. Si le hook A échoue, le
menu s'affiche, B pose un `choice`, l'opérateur répond par chip : la tuile est
servie quand même, correctement. C'est le filet, sans faux Allow/Deny.

### 3.3 Ce qui NE change pas

- Le hook de permission d'outil (`PermissionRequest` sur Bash, Edit, …) reste
  ce qu'il est, sur toutes les tuiles. Le volet B ne fait que traiter à part
  le `tool_name` `AskUserQuestion` qu'il recevait déjà.
- Aucune route broker, aucune table, aucun canal IPC nouveau. Le mobile-shell
  et les passerelles ne voient qu'un `kind` de plus, rendu comme `question`.
- `Notification/permission_prompt` reste `skip`.

### 3.4 Pourquoi pas les alternatives

- **Le hook répond lui-même (M2, `updatedInput.answers`)** : il devrait BLOQUER
  jusqu'au verdict sans rien afficher dans la tuile (viole R1 de
  `docs/DESIGN-NOTIFY-EVENTS.md`), repose sur un comportement non documenté,
  et fait de la durée du hook la borne de l'attente là où `ask_operator_wait`
  est reprenable indéfiniment.
- **Volet A partout, en donnant `ask_operator` à toutes les tuiles** : c'est
  l'état de fait de `server.ts` aujourd'hui, mais c'est l'inverse de la
  décision c9269fef (huit tuiles sur dix relisent cinq outils inutiles à
  chaque tour). Le volet B rend ce choix inutile.
- **Volet B en réutilisant `question` avec `options` = labels** : le Deck ne
  peut pas distinguer « relayer le label » de « taper son rang » sans marqueur,
  et M6 montre que se tromper choisit la première option en silence. Un genre
  explicite est le marqueur honnête.
- **Guider par le prompt seulement** : la description d'`ask_operator` dit déjà
  « use it instead of an on-screen question when they may be away » et l'agent
  a appelé `AskUserQuestion` dans les six runs.

---

## 4. Plan d'implémentation par lot

Chaque lot est un commit, ordre imposé : les CONSOMMATEURS d'un genre
précèdent son PRODUCTEUR, sinon un Deck ancien traiterait un `choice` comme un
`question` et taperait un label (M6). La carte roadmap est créée AVANT le
premier commit (via `roadmap_add` ou le Deck), son id8 va sur la première ligne
du CORPS de chaque commit (`Card <id8>.`). Test ciblé par lot ; le gate complet
(`bun test`, smoke build, typecheck desktop, parité de locale) une seule fois,
avant la séquence, par celui qui committe (`desktop-precommit`).

### Lot 0 : la sonde, versionnée

`scripts/probe-askuserquestion-hooks.py` (annexe A, nettoyée), trois modes :
`--hooks` (M1), `--redirect` (M3/M4 avec le faux serveur), `--type <touches>`
(M5/M6). Paragraphe dans `TESTING.md`, « Sondes hors gate » : comment la
lancer, ce qu'elle imprime, quand la rejouer (chaque bump de CLI dans le Deck,
toute modification de `hooks.json`). Python et `pty` de la bibliothèque
standard parce que Bun n'a pas de pty et que `node-pty` n'existe que dans
`desktop/` ; Windows hors périmètre, dit dans l'en-tête. La sonde n'entre PAS
dans `bun test` : elle lance une vraie CLI authentifiée et un vrai modèle.

### Lot 1 : le genre `choice` côté partagé, broker et Deck (consommateurs)

- `shared/types.ts` : `ApprovalKind` + `"choice"`. `shared/approval.ts` :
  `APPROVAL_KINDS` + `"choice"`, message d'erreur.
- `desktop/src/main/approval-service.ts` : `resolveChoiceIndex(answer,
  options): number | null` (pur, exporté, rejette `NaN`, `0`, les négatifs,
  `> options.length`, `> 9`), branche `choice` dans `buildKeystrokes`.
- `desktop/src/renderer/src/components/approval-verdict.ts` :
  `VerdictApprovalKind` + `'choice'`, branche explicite → `'text'`.
- `InboxPanel.tsx` : zone de texte masquée pour `choice`, note
  `inbox.choicePickOne` ; `desktop/src/main/i18n.ts` FR + EN.
- `notify/format.ts` : indication `choice` dans `renderTelegram` /
  `renderDiscord` / ntfy.
- Tests : `tests/desktop-approval-verdict.test.ts` (`'choice'` → `'text'` à
  tout index ; `buildKeystrokes` sur `choice` : label exact → `2\r`, label en
  casse différente → `2\r`, `"2"` → `2\r`, `"10"` avec deux options → `null`,
  `"Gamma"` absent → `null`, `answer_kind: 'allow'` → `null` avec message
  d'assertion « a chooser verdict is never a bare Enter », `NaN`/`"0"`/`"-1"`
  → `null`) ; `tests/broker-approvals.test.ts` (un `choice` avec quatre
  options est accepté et relu avec ses options dans l'ordre ; un `kind`
  inconnu reste refusé) ; test de format pour l'indication.

Commande : `bun test tests/desktop-approval-verdict.test.ts
tests/broker-approvals.test.ts tests/notify-format.test.ts` (nom du dernier à
vérifier dans `tests/`).

### Lot 2 : le producteur `choice` dans `approval-hook.ts`

- `classifyPayload` : `PermissionRequest` + `tool_name === "AskUserQuestion"`
  ⇒ `"choice"`. Le type de retour passe à quatre valeurs.
- `buildChoiceRequest(payload, cfg, tileRef)` : les règles du §3.2 ; retourne
  `null` quand le cas n'est pas livrable (⇒ `skip` par le `main`).
- En-tête du fichier : la liste réelle des événements et genres, sans
  narration.
- `tests/approval-hook.test.ts` : purs (classification ; `buildChoiceRequest`
  produit `kind: "choice"`, `title` = la question, `options` = les labels dans
  l'ordre, `question` numérotée ; `multiSelect` ⇒ `null` ; deux questions ⇒
  `null` ; zéro option ⇒ `null` ; dix options ⇒ `null` ; label avec caractères
  de contrôle ⇒ nettoyé). Sous-processus : un `PermissionRequest`
  `AskUserQuestion` avec credential ⇒ UNE ligne broker de `kind: "choice"`,
  et « an AskUserQuestion permission request never registers a permission »
  (assertion sur `kind !== "permission"`, message nommant M1). Couverture :
  un test qui affirme que le corps envoyé n'a PAS de clé `options` de valeur
  `["Allow","Deny"]` pour ce `tool_name`, quel que soit le chemin.

Commande : `bun test tests/approval-hook.test.ts`.

### Lot 3 : volet A, déclaration Deck + hook de redirection

- `desktop/src/main/session-env.ts` : `ASK_OPERATOR_TOOL_ENV`,
  `askOperatorToolName()`, et le prédicat pur
  `tileCarriesAskOperator(def: { supervisor?: boolean; args?: string })`
  (superviseur OU team-lead par `effectiveAgent` + `isTeamLeadAgent`).
- `session-service.ts` : `Object.assign` conditionnel dans `sessionEnv`.
- `desktop/hooks/ask-operator-redirect-hook.ts` : `parseHookPayload`,
  `resolveRedirectTool(env): string | null` (regex), `buildDecision(payload,
  cred, tool)`, `main()` fail-open.
- `desktop/deck-plugin/hooks/hooks.json` : entrée `PreToolUse`, matcher
  `AskUserQuestion`, commande `bun "${CLAUDE_PLUGIN_ROOT}/hooks/ask-operator-redirect-hook.mjs"`,
  timeout 10.
- `desktop/package.json`, `build:hook` : quatrième compilation.
- `tests/roadmap-guard-hook.test.ts`, test « hooks.json's PreToolUse matcher
  set equals … » : restreindre le côté `hooks.json` aux entrées dont la
  commande contient `roadmap-guard-hook.mjs`, égalité stricte conservée sur ce
  sous-ensemble. Ne PAS élargir `TOOL_TEXT_FIELDS`.
- `tests/ask-operator-redirect-hook.test.ts` (nouveau) : purs
  (`resolveRedirectTool` : absent/vide/`mcp__x__other`/`bash -c` ⇒ `null`,
  `mcp__claude-peers-deck__ask_operator` ⇒ accepté ; `buildDecision` ⇒ `null`
  sans credential, `null` sans outil, `null` pour `Bash`, refus pour
  `AskUserQuestion` ; la raison contient l'outil ET `title`, `question`,
  `options`). Sous-processus : sans `CLAUDE_PEERS_APPROVAL_FILE` ⇒ stdout
  vide ; avec credential mais sans `CLAUDE_PEERS_ASK_OPERATOR_TOOL` ⇒ stdout
  vide (message : « a tile without the tool keeps its native menu ») ; avec
  les deux ⇒ JSON dont `hookSpecificOutput.permissionDecision === "deny"`
  et AUCUNE autre clé que `hookEventName`, `permissionDecision`,
  `permissionDecisionReason` (un `updatedInput` ajouté par erreur changerait
  la sémantique, M2) ; credential incomplet ⇒ vide ; stdin `not json` ⇒ vide.
  Cohérence plugin : exactement UNE entrée `PreToolUse` de matcher
  `AskUserQuestion`, dont la commande nomme
  `ask-operator-redirect-hook.mjs`, et `build:hook` compile ce fichier.
- `tests/desktop-session-role-env.test.ts` ou voisin : la clé est exportée
  pour un def superviseur et un def `--agent "team-lead"`, OMISE (pas `''`)
  pour un def sans agent et pour `--agent "developer"`.

Commande : `bun test tests/ask-operator-redirect-hook.test.ts
tests/roadmap-guard-hook.test.ts tests/desktop-session-role-env.test.ts`.

### Lot 4 : documentation qui contredit la mesure

- `DESKTOP.md`, paragraphe « Remote approvals » : remplacer « no hook covers
  `AskUserQuestion` or plan approval » par les quatre producteurs (permission
  d'outil sur toutes les tuiles ; `choice` sur toutes les tuiles ; redirection
  vers `ask_operator` là où le Deck déclare l'outil ; `ask_operator` pour les
  questions libres ; `attention.ts` en repli) et la règle M5/M6 en une phrase.
- `docs/DESIGN-NOTIFY-EVENTS.md`, U2' (deux occurrences) : « menu
  `AskUserQuestion` : MESURÉ 2026-09-06, tire `PreToolUse` +
  `PermissionRequest` + `Notification/permission_prompt`, pas
  `agent_needs_input` ; voir `DESIGN-ASKUSERQUESTION-REDIRECT.md` ».
- `ARCHITECTURE.md`, « De-duplication » : préciser que le `choice` du hook et
  le repli de l'attention fusionnent par `tile_ref`.
- `BACKLOG.md`, §3.1 bis : sous-section « AskUserQuestion → Courrier », points
  ouverts P1..P8.

### Lot 5 : visibilité d'un échec du hook A (R1)

Le hook ne peut pas journaliser. Quand A a échoué sur une tuile qui porte la
clé, B pose un `choice` : c'est le signal. Dans `pollPendingApprovals` ou au
`addApproval` reçu, journaliser `journal.add('attention', ...)` quand un
`choice` arrive d'une tuile pour laquelle `tileCarriesAskOperator(def)` est
vrai : « redirect hook did not fire on <tile>, the question was raised from its
native menu ». Une ligne par approbation (dédoublonnage par id, comme
`heldVerdicts`). Pas de motif textuel d'écran.

### Lot 6 : validation terrain (checklist `BACKLOG.md` §3.1 bis)

- [ ] Tuile SANS profil (pas superviseur, pas team-lead), `mobileApprovals`
      OFF : un `AskUserQuestion` à deux options produit UNE entrée Courrier
      `choice` avec deux chips, pas de zone de texte ; chip « Beta » → l'agent
      continue avec Beta (vérifier dans la tuile que le menu s'est fermé sur
      l'option 2, pas la 1).
- [ ] Même tuile, `mobileApprovals` ON, Telegram : réponse « beta » en
      minuscules → l'agent continue avec Beta ; réponse « 2 » → idem ; réponse
      « gamma » → erreur Deck « nothing safe to send », menu intact.
- [ ] Superviseur : `AskUserQuestion` refusé, `ask_operator` appelé, entrée
      Courrier `question` avec les labels en chips, réponse chip ou texte
      libre → l'agent continue, rien n'a été tapé dans la tuile.
- [ ] Team-lead sandboxé : même comportement que le superviseur.
- [ ] Membre d'équipe embarqué (profil avec `peerTools`) : volet B, jamais de
      refus.
- [ ] Session lancée AVANT l'armement du credential : menu natif, pas de
      refus, pas d'item.
- [ ] Session `claude` hors Deck : rien ne change.
- [ ] `multiSelect` et deux questions dans un appel : menu natif, badge local,
      aucune entrée Courrier fausse.

---

## 5. Points ouverts, nommés

| # | Point | Impact | Qui |
|---|---|---|---|
| P1 | **Enregistrement du serveur principal.** `askOperatorToolName()` suppose la clé `claude-peers` du `README.md`. Un opérateur qui l'a enregistré sous un autre nom obtient M3 sur ses tuiles superviseur/team-lead. Disparaît quand c9269fef fait lancer `server-deck.ts` par le Deck (clé choisie par le Deck). D'ici là : le Deck peut-il lire la config MCP utilisateur pour vérifier ? Sinon, documenter la contrainte dans `README.md`. | Redirection inerte sur les tuiles qui comptent le plus, chez un opérateur au nom d'alias non standard | debugger |
| P2 | **Câblage c9269fef.** Quand le second serveur sera lancé et les cinq outils retirés de `server.ts`, mettre à jour `askOperatorToolName()` DANS LE MÊME COMMIT, avec un test qui lit la clé du mcp-config généré et la compare. | Sans cela, la redirection nomme un outil disparu (M3) | celui qui câble c9269fef |
| P3 | **Modes `bypassPermissions` / `dontAsk` / `auto`.** `PermissionRequest` n'y tire pas (doc). `PreToolUse` y tire-t-il ? Le menu natif s'affiche-t-il ? Non mesuré. Les tuiles en `--dangerously-skip-permissions` sont concernées : le volet B y est peut-être aveugle. | Aucune entrée Courrier là où l'opérateur regarde le moins | sonde, un run par mode |
| P4 | **Dérive CLI.** M1..M6 valent pour 2.1.261. Rejouer la sonde à chaque bump. | Un hook inerte ou faux sans test rouge | mainteneur, lot 0 |
| P5 | **`multiSelect` et questions multiples.** Protocole clavier non mesuré (espace pour cocher ? tabulation entre questions ?). Le volet B les `skip` en v1. | Ces menus n'ont que le badge local | sonde |
| P6 | **Le repli de l'`AttentionDetector` tape du texte dans un menu.** Sur un `AskUserQuestion` sans hook (tuile hors plugin, ou hook en échec), une réponse texte à « is waiting for an answer on screen » choisit la première option (M6). Sur un dialogue de permission, l'Entrée finale vaut Allow. Défaut préexistant, hors de ce lot ; à carder : le repli pour une tuile Claude ne devrait admettre aucune réponse typée, seulement `session:focus`. | Une réponse à distance sur un écran non identifié agit à l'aveugle | à carder |
| P7 | **Boutons ntfy pour `choice`.** ntfy admet trois actions ; un menu en a jusqu'à quatre. Rendre les deux ou trois premières ? Ou aucune pour ne pas biaiser ? | Confort téléphone | opérateur |
| P8 | **Course hook / attention.** Si le repli de l'attention pose son `question` générique AVANT le `choice` du hook (broker lent), la fusion `tile` garde le générique et perd les options. Le hook part en millisecondes, l'OSC de la CLI arrive à +6 s (`DESIGN-NOTIFY-EVENTS.md` §6.5) : improbable, non impossible. | Une entrée sans chips, réponse texte → M6 | mesurer sur le terrain, lot 6 |

---

## Annexe A : recette de la sonde (Linux/macOS)

```python
# probe-askuserquestion-hooks.py -- run an interactive claude in a pty and
# measure what an AskUserQuestion does. Modes:
#   --hooks            log which hooks fire (M1)
#   --redirect         PreToolUse deny + fake ask_operator MCP server (M3/M4)
#   --type '2\r'       type keys into the native chooser once it is up (M5/M6)
# Needs: claude on PATH, an authenticated environment, python3 >= 3.8.
import os, pty, re, select, sys, time, json
S = os.path.abspath(os.path.dirname(__file__)) + "/probe-work"
os.makedirs(S + "/proj/.claude", exist_ok=True); os.makedirs(S + "/home", exist_ok=True)
LOG = S + "/hooks.log"; open(LOG, "w").close()
mode = next((a for a in sys.argv[1:] if a.startswith("--")), "--hooks")
keys = sys.argv[sys.argv.index("--type") + 1].encode().decode("unicode_escape").encode() if mode == "--type" else b""
# Onboarding + trust pre-seeded so no chooser precedes the question.
open(S + "/home/.claude.json", "w").write(json.dumps({"theme": "dark",
    "hasCompletedOnboarding": True, "projects": {S + "/proj": {"hasTrustDialogAccepted": True}}}))
open(S + "/hooklog.sh", "w").write('#!/bin/bash\nprintf "%s %s\\n" "$1" "$(cat)" >> "$PROBE_LOG"\n')
os.chmod(S + "/hooklog.sh", 0o755)
pre = S + "/hooklog.sh PreToolUse"
if mode == "--redirect":
    reason = ("Koryphaios Deck policy: on-screen questions (AskUserQuestion) are disabled in "
              "Deck-managed sessions because the operator answers from the Deck inbox or their "
              "phone. Ask the same question with the mcp__claude-peers__ask_operator tool "
              "(title, question, optional options); its return value is the operator answer.")
    open(S + "/deny.sh", "w").write('#!/bin/bash\nIN="$(cat)"; printf "PreToolUse-deny %s\\n" "$IN" >> "$PROBE_LOG"\n'
        + "printf '%s' " + repr(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
          "permissionDecision": "deny", "permissionDecisionReason": reason}})) + "\n")
    os.chmod(S + "/deny.sh", 0o755); pre = S + "/deny.sh"
    # Minimal stdio MCP server: one tool, ask_operator, answers "Beta".
    open(S + "/fake-mcp.py", "w").write(r'''
import sys, json, os
log = open(os.environ["PROBE_LOG"], "a")
def send(o): sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
for line in sys.stdin:
    if not line.strip(): continue
    m = json.loads(line); mid = m.get("id"); meth = m.get("method")
    if meth == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": m["params"].get("protocolVersion", "2024-11-05"),
              "capabilities": {"tools": {}}, "serverInfo": {"name": "claude-peers", "version": "0"}}})
    elif meth == "tools/list":
        send({"jsonrpc": "2.0", "id": mid, "result": {"tools": [{"name": "ask_operator",
          "description": "Ask the HUMAN operator a blocking question and WAIT for the answer.",
          "inputSchema": {"type": "object", "properties": {"title": {"type": "string"}, "question": {"type": "string"},
            "options": {"type": "array", "items": {"type": "string"}}}, "required": ["title", "question"]}}]}})
    elif meth == "tools/call":
        log.write("MCP-call " + json.dumps(m["params"]) + "\n"); log.flush()
        send({"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": "Beta"}]}})
    elif mid is not None:
        send({"jsonrpc": "2.0", "id": mid, "result": {}})
''')
    open(S + "/mcp.json", "w").write(json.dumps({"mcpServers": {"claude-peers": {"command": "python3",
        "args": [S + "/fake-mcp.py"], "env": {"PROBE_LOG": LOG}}}}))
hooks = {"hooks": {
    "PermissionRequest": [{"matcher": "", "hooks": [{"type": "command", "command": S + "/hooklog.sh PermissionRequest", "timeout": 5}]}],
    "Notification": [{"matcher": "", "hooks": [{"type": "command", "command": S + "/hooklog.sh Notification", "timeout": 5}]}],
    "PreToolUse": [{"matcher": "AskUserQuestion", "hooks": [{"type": "command", "command": pre, "timeout": 10}]}],
    "PostToolUse": [{"matcher": "AskUserQuestion", "hooks": [{"type": "command", "command": S + "/hooklog.sh PostToolUse", "timeout": 5}]}]}}
open(S + "/proj/.claude/settings.json", "w").write(json.dumps(hooks))
env = dict(os.environ); env.update({"PROBE_LOG": LOG, "HOME": S + "/home", "TERM": "xterm-256color"})
for k in ("CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION"): env.pop(k, None)
tail = "Do nothing else." if mode == "--hooks" else "When you have my answer, reply with exactly one line ANSWER=<answer> and stop."
prompt = "Use the AskUserQuestion tool to ask me a single question: do I prefer option Alpha or option Beta? " + tail
argv = ["claude", "--permission-mode", "default"]
if mode == "--redirect":  # --allowedTools is variadic: keep the '=' form or it swallows the prompt
    argv += ["--mcp-config", S + "/mcp.json", "--strict-mcp-config", "--allowedTools=mcp__claude-peers__ask_operator"]
argv.append(prompt)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(S + "/proj"); os.execvpe("claude", argv, env)
t0 = time.time(); buf = b""; seen = None; typed = None
strip = lambda b: re.sub(rb"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]", b"", b)
while time.time() - t0 < 170:
    r, _, _ = select.select([fd], [], [], 1)
    if r:
        try: d = os.read(fd, 65536)
        except OSError: break
        if not d: break
        buf += d
    s = strip(buf[-6000:])
    menu_up = b"Alpha" in s and b"Beta" in s and b"Enter to select" in s
    if mode == "--hooks":
        if menu_up and seen is None: seen = time.time()
        if seen and time.time() - seen > 75: break  # long enough for the 60 s notification class
    elif mode == "--type":
        if menu_up and typed is None: time.sleep(2); os.write(fd, keys); typed = time.time()
        if typed and b"ANSWER=" in s: time.sleep(4); break
        if typed and time.time() - typed > 45: break
    elif b"ANSWER=" in s and time.time() - t0 > 15: time.sleep(6); break
os.kill(pid, 9)
for line in open(LOG):
    tag, _, js = line.partition(" ")
    try: d = json.loads(js)
    except ValueError: print(tag, js[:300]); continue
    for k in ("session_id", "transcript_path", "cwd", "scratchpad_dir", "prompt_id"): d.pop(k, None)
    print(tag, json.dumps(d)[:700])
print("SCREEN TAIL:", re.sub(r"\s+", " ", strip(buf).decode("utf-8", "replace")[-400:]))
```

Résultats attendus sur 2.1.261 : `--hooks` ⇒ `PreToolUse`, `PermissionRequest`,
`Notification` (`permission_prompt`), jamais `agent_needs_input` ;
`--redirect` ⇒ `PreToolUse-deny`, `MCP-call {"name": "ask_operator", ...}`,
`ANSWER=Beta` ; `--type '2\r'` ⇒ `PostToolUse ... "answers": {...: "Beta"}` ;
`--type 'Beta\r'` ⇒ `"answers": {...: "Alpha"}`.
