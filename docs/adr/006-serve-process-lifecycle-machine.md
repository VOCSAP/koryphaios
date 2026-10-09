# ADR 006 : le cycle de vie du serveur de dev est un automate pur, exécuté par un pilote mince

Statut : **accepté** (option B ratifiée par l'opérateur le 2026-10-09 à 17:19, §3), après contre-expertise, sur mandat du team-lead (carte LS2 `9fb72acb`, défauts restants `cb092ec2`, prérequis de LS3 `4d6ec4fb`). Aucun code livré par cet ADR. Décisions opérateur du 2026-10-09 : une passe de conception précède LS3 ; M2 est tranché (§10).

Étiquettes : `DÉDUIT` renvoie au code lu à HEAD `9a7c6c5` ; `SUPPOSÉ` n'a pas été vérifié ; `MESURÉ (challenger)` cite les sondes du challenger indépendant, hors dépôt : `reap-order`, `win-window`, `ps-timing` (Linux : `node:24-bookworm`, Node 24.21, libuv 1.52.1, trois runs identiques), et non une mesure faite pour ce document.

## 1. Problème

`ServeService` (`desktop/src/main/serve-service.ts`) possède un processus de dev : spawn, readiness, arrêt gradué, nettoyage au quit. Son cycle de vie est un automate implicite, réparti entre `start`, `stop`, `startInner`, `attachChild`, `awaitReady`, `fail` et `stopRunning`, qui partagent `current`, `startPromise`, `currentState` et `running.stopping`. Chaque `await` (mesure de stamp, grâce de 3 s, fetch) ouvre un point d'entrelacement avec `stop()`, `exit`, `error` et le quit. Trois revues ont chacune trouvé de nouveaux entrelacements (`cb092ec2`).

Ce qui ne doit pas casser : le contrat consommé par LS3 (`state()`, `start()`, `stop()`, événement `changed`, statuts `idle | starting | ready | failed | stopping`) ; la règle du brief « on ne signale jamais un PID retrouvé par nom ou par port » (`docs/DESIGN-LAUNCHSTATION-ADOPTION.md`, §LS2) ; le budget de l'effet `serve` du quit (`index.ts:3558-3566`, `timeoutMs: 16_000`).

## 2. Ce que la contre-expertise a changé avant tout choix de structure

Trois faits mesurés simplifient le cycle de vie, QUELLE QUE SOIT la structure retenue :

1. **La re-mesure du stamp pendant l'arrêt est nuisible.** `MESURÉ (challenger)` : libuv récolte un lot d'enfants par `waitpid`, puis appelle leurs callbacks un par un, avec du JavaScript intercalé. Dans le handler `exit` de B, on obtient `A exit seen=false; /proc/A=ENOENT; kill(-A,0)=ESRCH`. Un leader peut donc être récolté alors que son `exit` n'est pas encore observé. Dans cette fenêtre, la re-mesure échoue (Linux : `ENOENT` ; Windows : `stampStatus:1`, `Get-Process: Impossible de trouver…`). Elle mène à `failed` et abandonne le groupe, ce qui recrée M2 par la garde elle-même. La fenêtre devient probable au quit, quand plusieurs enfants sortent ensemble.
2. **La vérification `pgid == pid` porte sur un état impossible.** `MESURÉ (challenger)` : `detached` fait un `setsid()` (`setpgid Operation not permitted`, `pgid==pid True sid==pid True`).
3. **Ce qui protège un signal sur `-pid`, c'est l'existence du GROUPE**, pas l'absence de récolte du leader : POSIX n'attribue pas un PID égal à l'identifiant d'un groupe existant. `DÉDUIT` de cette règle ; `pid_max = 4194304` sous Linux (`MESURÉ (challenger)`).

Conséquence : le stamp n'a plus de consommateur dans Serve. Son seul rôle était de réautoriser un signal. Serve abandonne donc le stamp ; `process-stamp.ts` reste pour `clodex-process-io.ts`. L'identité devient : le `ChildProcess` tenu par le Deck (aucun PID n'est retrouvé par nom ou par port), plus l'existence du groupe sous POSIX, plus `exit` non observé sous Windows. **Conflit avec le brief à signaler** : §LS2 écrit « Identité = PID + spawn time mémorisés ». L'intention du brief est respectée, son mécanisme est remplacé parce qu'il a été mesuré nuisible (§10).

Après ces trois retraits, il reste cinq points d'attente : la préparation, le fetch de santé, la grâce, `taskkill` et le délai du quit.

## 3. Options, chiffrées à valeur égale

Les deux options couvrent la même liste `cb092ec2` (tableau du §5) et les mêmes décisions du §2 ; seule la structure diffère.

- **B. Réducteur pur + pilote** (précédent `avatar-window-state.ts`). Chaque attente devient un couple « effet émis / événement de résultat porteur d'un `op` ». Un `switch` exhaustif sur (phase × événement) est vérifié par le compilateur, et une table de test joue chaque case.
- **C. Acteur sérialisé.** Une fonction asynchrone par exécution est seule à écrire l'état. `exit`, `stop` et `quit` sont des promesses mises en course (`Promise.race`) contre chaque attente. `stop()` rejoint la promesse d'arrêt unique de l'exécution. Ce n'est pas une file de messages qui bloquerait pendant la grâce (le premier jet de cet ADR attaquait cet homme de paille).

| | B | C |
|---|---|---|
| Production | réducteur 450 à 600 lignes + pilote environ 250 | environ 350 à 400 lignes (réécriture des 451 actuelles) |
| Tests | table d'environ 16 événements × 6 phases × {frais, périmé} × 3 plateformes, sans minuteur ni micro-tâche, plus environ 15 scénarios de pilote ; 700 à 900 lignes | les 38 tests actuels (787 lignes) + environ 10 scénarios d'entrelacement à faux minuteurs et `settle()` |
| Effort | 1,5 à 2 j + une revue | 0,5 à 0,75 j + une revue |
| Couverture `cb092ec2` | complète | complète |
| Où vit le risque résiduel | une case mal remplie, visible dans la table | une attente non mise en course contre `exit`, `stop` ou `quit`, visible seulement si quelqu'un écrit le scénario |
| Réversibilité | totale, API inchangée | totale, API inchangée |

Repères de taille, `MESURÉ` (`wc -l`) : `avatar-window-state.ts` 1307 lignes, `avatar-window-controller.ts` 370, `tests/desktop-avatar-window-state.test.ts` 1533. Serve a moins de phases et n'a ni géométrie, ni persistance, ni publication. Mon premier chiffre (350 à 450) était sous-estimé.

**Recommandation : B**, avec une marge réduite. La force décisive : la classe de défaut qui a échappé à trois revues, c'est une attente qui ne réagit pas à un événement concurrent. Avec cinq attentes et trois événements préemptifs, C contient quinze courses implicites, qu'aucun outil n'énumère. B en fait quinze cases que le compilateur exige et que la table joue sans aucun minuteur. Le surcoût, d'environ un jour, porte sur un module LATENT (`DÉDUIT` : aucun appelant de production, `index.ts:334` et `:3562`). Ce qui ferait basculer vers C : si le lead juge qu'après les simplifications du §2 cinq attentes se relisent sans table, le gain de B ne paie plus son jour. Je ne le juge pas ainsi, mais c'est un arbitrage de coût, pas un fait. **Option D** (xstate) écartée : une dépendance dans le main sans apport sur le précédent maison.

**Décision : option B, ratifiée par l'opérateur le 2026-10-09 à 17:19** (transmise par le lead).

**Écart assumé au brief LS2** (`docs/DESIGN-LAUNCHSTATION-ADOPTION.md`, §LS2, « Identité = PID + `spawn` time mémorisés ») : l'identité d'un processus de Serve ne repose plus sur « PID + heure de démarrage », mais sur l'existence du groupe (POSIX) et sur un `exit` non observé du `ChildProcess` tenu par le Deck (Windows). Le motif est au §2 : la re-mesure s'est révélée nuisible à la mesure. L'intention du brief reste respectée : aucun PID retrouvé par nom ou par port n'est jamais signalé.

## 4. Cible (option B)

- `desktop/src/main/serve-lifecycle.ts` (nouveau, PUR, aucun import `node:`) : `reduce(state, event) -> { state, effects, reply }`, sélecteurs, `stopBudgetMs(platform)`. La plateforme est une donnée de l'état initial, donc la table se joue pour `win32`, `linux` et `darwin` sur n'importe quel hôte.
- `desktop/src/main/serve-service.ts` (réécrit en pilote) : garde l'API publique et les `deps` injectables, sauf `measureProcess`, qui disparaît. Il exécute les effets, traduit les résultats et les événements du `ChildProcess` en événements, et publie `changed` quand le sélecteur public change. **File run-to-completion** calquée sur `avatar-window-controller.ts:285-303` : un événement dispatché pendant un traitement est mis en file, et `reduce` comme chaque effet sont sous `try/catch` avec `reportError`. Un listener ne peut donc jamais figer `quit()`.
- Chaque effet asynchrone est borné par lui-même (`execFile` à 3 s, fetch abortable). Son résultat revient TOUJOURS comme événement. Le spawn est synchrone : le pilote attache `exit` et `error`, puis dispatche `Spawned` ou `SpawnFailed`, que la file sérialise avant tout événement venu d'ailleurs.

### Phases

| Phase | Processus possédé | Statut public |
|---|---|---|
| `idle{failure}` | non | `failed` si `failure`, sinon `idle` |
| `preparing{op}` | non (port, puis environnement LS2b) | `starting` |
| `spawning{op, pendingStop}` | transitoire | `starting` |
| `probing{op, pid, probeOp}` | oui | `starting` |
| `ready{op, pid}` | oui | `ready` |
| `stopping{op, pid, reason, leaderExited, step}` | oui | `stopping` |

Champs transverses : `quitting` (définitif), `logOpen` (op du journal ouvert), compteurs monotones `op` et `timerId`. Un résultat porteur d'un `op` ou d'un `timerId` périmé rend `none`, laisse l'état identique et n'émet aucun effet.

`reason` : `operator`, `quit`, `readinessTimeout`, `childError`, `leaderExited`. Le premier motif fixe l'issue ; un `Stop` ou un `Quit` ultérieur s'y joint. `step` : POSIX `SIGINT -> grace -> SIGTERM -> grace -> SIGKILL` ; Windows `taskkill -> (si échec) killLeader -> grace`.

### Événements (16)

`Start{action}`, `Stop`, `Quit`, `QuitDeadline` ; `Prepared{op, port, env}`, `PrepareFailed{op, error}`, `Spawned{op, pid}`, `SpawnFailed{op, error}` ; `ProbeAnswered{op, status}`, `ProbeFailed{op, error}` ; `SignalResult{op, signal, outcome: sent | absent | failed, error?}`, `GroupProbed{op, outcome: present | absent | failed}`, `TaskkillDone{op, code, stderr}` ; `ChildExited{op, code, signal}`, `ChildError{op, error}` ; `TimerFired{timerId}` (genres `probeDelay`, `readyDeadline`, `grace`). Le réducteur ne lit jamais l'horloge.

### Effets

`prepare`, `spawn{op, file, args, cwd, env, detached}`, `openLog{op}`, `closeLog{op}`, `probe{op, url, timeoutMs}`, `abortProbe{op}`, `signalGroup{op, pid, signal}`, `probeGroup{op, pid}` (signal 0 sur `-pid`), `taskkill{op, pid}`, `killLeader{op}` (`child.kill()` par le handle, Windows), `armTimer`, `cancelTimer`, `report{message}`.

### Invariants, assertés sur chaque case de la table

- **I1, aucun processus vivant lâché** : une entrée en `idle` depuis une phase qui possède un processus n'est permise que si l'une de ces conditions est vraie : le groupe est absent (`SignalResult absent`, `GroupProbed absent`) ; SIGKILL a été envoyé, quel qu'en soit le résultat ; `taskkill` a réussi ; `killLeader` a été émis ; ou, sous Windows, `exit` a été observé (résidu du §8).
- **I2, une escalade** : au plus un `signalGroup` par signal et par `op`, et au plus un `taskkill` par `op`.
- **I3, Windows** : aucun `taskkill` après `ChildExited` du même `op`.
- **I4, quit** : après `Quit`, aucun `prepare` ni `spawn`.
- **I5, périmé** : `op` ou `timerId` périmé donne `none`, sans effet.
- **I6, journal** : toute entrée en `idle` alors que `logOpen` est posé émet `closeLog`.

## 5. Table des transitions

`->` phase suivante ; `[...]` effets ; `deferred` = la commande se joint à l'arrêt en cours. Un événement périmé vaut `none` partout.

| Événement \ phase | idle | preparing | spawning | probing | ready | stopping |
|---|---|---|---|---|---|---|
| `Start` | `-> preparing` [prepare] ; `rejected` si `quitting` | busy | busy | busy | busy | busy |
| `Stop` | none | `-> idle` | `pendingStop = operator` | `-> stopping(operator)` [abortProbe, cancelTimer, 1er pas] | `-> stopping(operator)` [1er pas] | **deferred** |
| `Quit` | `quitting` | comme `Stop`, + `quitting` | comme `Stop`, + `quitting` | idem | idem | `quitting`, deferred |
| `QuitDeadline` | none | none | none | none | none | POSIX [signalGroup SIGKILL] ; Windows [killLeader] ; `-> idle(failure)` [closeLog, report] |
| `Prepared` | | `-> spawning` [spawn] | | | | |
| `PrepareFailed` | | `-> idle(failure)` [report] | | | | |
| `Spawned` | | | `pendingStop` ? `-> stopping(pendingStop)` [openLog, 1er pas] : `-> probing` [openLog, armTimer readyDeadline, probe] | | | |
| `SpawnFailed` | | | `-> idle(failure)` [report] | | | |
| `ProbeAnswered` 200-399 | | | | `-> ready` [cancelTimer readyDeadline] | | none |
| `ProbeAnswered` autre, `ProbeFailed` | | | | [armTimer probeDelay] | | none |
| `TimerFired probeDelay` | | | | [probe] | | |
| `TimerFired readyDeadline` | | | | `-> stopping(readinessTimeout)` [abortProbe, report, 1er pas] | | |
| `TimerFired grace` | | | | | | POSIX : signal suivant ; Windows après `killLeader` : `-> idle(failure)` [report] |
| `SignalResult sent` | | | | | | SIGKILL : `-> idle(issue)` ; sinon [armTimer grace] |
| `SignalResult absent` (ESRCH) | | | | | | `-> idle(issue)` [cancelTimer] |
| `SignalResult failed` (EPERM) ou `GroupProbed failed` (EPERM), darwin | | | | | | `-> idle(issue)` [cancelTimer], sans report : groupe vide ou zombie (§6, MESURÉ), que l'exit soit observé ou non ; résidu setuid au §8 |
| `SignalResult failed` (EPERM…) | | | | | | [report] ; SIGINT/SIGTERM : signal suivant sans grâce ; SIGKILL : [probeGroup] |
| `GroupProbed absent` | | | | | | `-> idle(issue)` [cancelTimer] |
| `GroupProbed present`, `failed` | | | | | | pendant une grâce : none ; après l'échec de SIGKILL : `-> idle(failure « group unreachable »)` [report] |
| `TaskkillDone` | | | | | | 0 : `-> idle(issue)` ; non nul et leader vivant : [killLeader, armTimer grace, report] ; non nul et `exit` observé : `-> idle(failure)` [report résidu] |
| `ChildExited` POSIX | none | | | `-> stopping(leaderExited)` [abortProbe, report, SIGINT] | idem sans abortProbe | `leaderExited` ; pendant une grâce : [probeGroup] |
| `ChildExited` Windows | none | | | `-> idle(failure)` [abortProbe, report résidu] | `-> idle(failure)` [report résidu] | `leaderExited` ; `taskkill` en vol : attendre son résultat ; après `killLeader` : `-> idle(failure)` [cancelTimer, report] |
| `ChildError` | none | | | `-> stopping(childError)` [report, 1er pas] | idem | [report] |

« 1er pas » : POSIX [signalGroup SIGINT] ; Windows [taskkill]. Toute entrée en `idle` émet en plus `closeLog` (I6), que la table n'a pas répété. `spawning` n'a plus de case interdite : la file du pilote garantit que `Spawned` ou `SpawnFailed` y arrive avant toute commande, et une commande arrivée quand même y est définie.

### `cb092ec2` case par case

| Défaut | Où il est fermé | Absorbé ? |
|---|---|---|
| **B1** `powershell.exe` nu résolu dans le cwd du dépôt | argument `file` de l'effet `spawn` : chemin System32 absolu par `windowsSystemExecutable`, `spawns[0].file` asserté | non : corrigé dans le lot de migration, qui réécrit le site du spawn |
| **B2** second `stop()` pendant l'escalade d'un échec de readiness | `Stop × stopping = deferred`, I2 | oui |
| **M1** échec entre le spawn et le stamp : `child.kill()` seul | la phase `verifying` n'existe plus (§2) ; une erreur après le spawn passe par `stopping` | oui, par suppression |
| **M2** groupe POSIX abandonné quand le leader sort | `ChildExited POSIX × {probing, ready} -> stopping(leaderExited)` | oui, décision opérateur |
| **M3** aucun test n'épingle une seule suppression du dossier de session | câblage du quit (§7) | non : test de `desktop-before-quit.test.ts` dans le lot |
| **M4** timeout de `defaultRun` testé par tautologie | pilote | non : dans le lot |
| **M5** `reportError` retiré du catch de `stop()` | les cases d'échec émettent `report`, que la table asserte | oui |
| NIT logger capturé par enfant | `openLog{op}` / `closeLog{op}`, I6 ; le pilote jette les données d'un `op` fermé | oui |
| NIT try/finally dans l'effet du quit | §7 | non : câblage |
| NIT mutant « comparaison de pgid » vert | la comparaison disparaît (§2, point 2) | sans objet |
| NIT `defaultRun` perd `error.message` | pilote | non : dans le lot |
| NIT 3 s d'attente inconditionnelle après SIGINT | `ChildExited × stopping` pendant une grâce -> `probeGroup` | oui |
| NIT budget darwin d'environ 18 s | plus de mesure dans l'arrêt : `stopBudgetMs` vaut environ 6 s (§7) | oui |
| NIT commentaire « A stable group id… » | le choix « signaler `-pid` tant que le groupe existe » vit dans le commentaire de `signalGroup` | oui |

Changement de comportement assumé : `ChildError` après le spawn et une sortie inattendue sous POSIX passent par `stopping` au lieu de laisser le processus (`DÉDUIT` serve-service.ts:347-364). Les tests `test:472`, `:486` et `:508` changent d'attendu : `stopping`, puis `failed`.

## 6. Windows et POSIX

| Point | POSIX | Windows |
|---|---|---|
| Spawn | `detached: true` : `setsid()`, `pgid == sid == pid` (`MESURÉ (challenger)`) | `detached: false` : avec `detached: true`, PowerShell n'exécute pas la commande (nodejs/node#51018, mesuré sous l'Electron du Deck, Kleos) |
| Shell | `$SHELL` (LS2b change la forme) | PowerShell par chemin System32 absolu (B1) |
| Arrêt | `kill(-pid, SIGINT/SIGTERM/SIGKILL)`, 3 s de grâce, sans mesure | `taskkill /T /F /PID`, sans pas gracieux (brief, décision 8.4) ; en cas d'échec, `child.kill()` par le handle |
| Autorisation de signaler | le groupe existe (règle de réutilisation des PID) | `exit` non observé : `SUPPOSÉ`, le handle tenu par libuv empêche la réattribution du PID tant que son callback de sortie n'a pas tourné |
| ESRCH | groupe vide : arrêt réussi | sans objet |
| EPERM | avance vers le signal suivant, puis `probeGroup` (I1) ; sous darwin : groupe vide ou zombie, donc `idle(issue)` | sans objet |
| Après la sortie du leader | groupe encore adressable par `-pid` | arbre inatteignable : `taskkill /T` part d'une racine morte, et un `taskkill` après `exit` observé pourrait viser un PID réattribué (I3) |

**darwin, MESURÉ** (run GitHub Actions `37953324666`, macOS 26.6.2 arm64, XNU 12377) : `killpg` sur un groupe composé seulement d'un zombie (`ps` STAT `Z<`, `pid == pgid`) rend `EPERM` (errno 1) AVANT le `waitpid`, puis `ESRCH` (errno 3) APRÈS. Linux rend un succès dans le même cas (`MESURÉ (challenger)`). Sous darwin, un `EPERM` sur notre groupe signifie donc « groupe vide ou zombie », que l'exit du leader soit observé ou non (arbitrage du lead, 2026-10-09). Justification : ce groupe est lancé par le Deck sous le même compte ; le seul vrai refus de droits possible vient d'un descendant setuid resté seul dans le groupe, résidu assumé au §8. Hors de ce cas, un `report` serait parasite. Cellule qui en découle (§5) : `SignalResult failed` (EPERM) et `GroupProbed failed` (EPERM) × `stopping`, plateforme `darwin` : `-> idle(issue)` [cancelTimer], sans `report`, exactement comme `SignalResult absent`. Hors de ce cas (autre plateforme ou autre errno), la ligne générale `SignalResult failed` s'applique.

## 7. Intégration au quit

`before-quit.ts` lance les effets en parallèle et borne chacun par son `timeoutMs` (`DÉDUIT` before-quit.ts:55-68). Défauts du câblage actuel, `DÉDUIT` : `sessionDir.close()` n'arrive qu'après `serve.stop()` (`index.ts:3562-3563`), alors que l'accesseur se décrit comme « the first step of the quit path » (`session-state.ts:43-49`). Le journal de Serve a capturé la chaîne du dossier (`serve-service.ts:305`) et `log.ts:121` refait `ensureDir` à chaque écriture : il contourne la porte et recrée le dossier après sa suppression. Enfin, si les 16 s sont dépassées, `close` et `remove` ne s'exécutent jamais.

Câblage cible :

```ts
{
  label: 'serve',
  timeoutMs: 16_000,
  run: async () => {
    sessionDir.close()
    try {
      await serve.quit({ deadlineMs: SERVE_QUIT_DEADLINE_MS })
    } finally {
      removeSessionStateDir(appStateDir(), activeScope.groupId, reportSessionState)
    }
  }
}
```

1. La porte se ferme en premier. Serve n'en a plus besoin après le spawn, puisque `Quit` interdit tout nouveau `prepare` (I4). `SUPPOSÉ` : `ttsr.stop()`, lancé avant dans la même boucle, n'a plus d'écriture asynchrone dans le dossier de session. C'est le seul voisin dont le commentaire (`index.ts:3547`) dépend de l'ordre actuel ; la revue doit le vérifier.
2. `serve.quit()` dispatche `Quit`, arme un minuteur interne de `SERVE_QUIT_DEADLINE_MS` (12 s), puis se résout à la première phase `idle`. Si le minuteur expire, le pilote dispatche `QuitDeadline` : SIGKILL au groupe ou `killLeader`, `closeLog`, puis `idle` (I1 tenu). `quit()` ne rejette jamais. La borne interne précède donc toujours la borne de 16 s, et le `finally` s'exécute avant la limite.
3. `closeLog` précède toujours `remove` (I6, et `closeLog` de `QuitDeadline`). Le pilote jette les données d'un `op` fermé, donc aucune écriture ne recrée le dossier.
4. `stopBudgetMs(platform)` est pur : POSIX `2 × 3 s` de grâce plus des signaux synchrones, environ 6 s ; Windows `3 s` (`taskkill`) + `3 s` de grâce après `killLeader`, 6 s. Un test asserte `stopBudgetMs < SERVE_QUIT_DEADLINE_MS < 16_000`, avec les constantes exportées.
5. Le `stopAll()` de la carte LS3 est ce `quit()`.

## 8. Ce que l'on refuse de modéliser

- **Réattribution d'un PGID** entre deux signaux POSIX : il faudrait que le groupe se vide, puis qu'un nouveau processus obtienne ce numéro et devienne leader de groupe, le tout dans la grâce. Résidu accepté.
- **Réattribution d'un PID pendant un `taskkill` en vol** (Windows) : l'`exit` observé pendant que `taskkill.exe` tourne libère le handle. Résidu accepté, de l'ordre de la milliseconde.
- **Orphelins Windows** après la sortie du leader : inatteignables sans Job Object. La variante `KILL_ON_JOB_CLOSE` est mesurée pour les tuiles PTY (Kleos #21057), pas pour un spawn à stdio en pipe : carte de suite à part.
- **Évasions volontaires** : `setsid()` d'un descendant, `CREATE_BREAKAWAY_FROM_JOB`.
- **Descendant setuid resté seul dans le groupe (darwin)** : il rend `EPERM` à `killpg` et serait pris pour un groupe vide (§6), donc laissé vivant. Assumé : un serveur de dev n'a aucune raison de lancer un binaire setuid.
- **Crash du Deck** (pas de `before-quit`) : rien n'est persisté et aucun ramassage n'a lieu au démarrage suivant, conformément au caractère local d'un run.
- **Contention de port** entre l'allocation et le `bind` : déjà acceptée par le brief.
- **Santé** au-delà du code HTTP ; **plusieurs instances** (une par fenêtre Deck) ; **horloge** (les délais sont des minuteurs).
- **Exploration exhaustive des séquences** : `17^8 × 3 ≈ 2,1e10` séquences pour les 17 événements (§11, A5), sans déduplication possible tant que `op` et `timerId` sont monotones (`DÉDUIT`, arithmétique). Un générateur des événements « possibles ici » serait un second modèle non vérifié. Retirée de l'exigence : la garantie est la table complète (phase × événement × {frais, périmé} × plateforme), avec I1 à I6 assertés sur chaque case, et les scénarios nommés de `cb092ec2` et de la fenêtre de récolte mesurée.

## 9. Coût et ordre des lots

1. **Lot de migration** (carte à créer, absorbe `cb092ec2`). Comportement darwin de `killpg` : mesuré par le run GitHub Actions `37953324666` (§6). Contenu : `serve-lifecycle.ts`, `tests/desktop-serve-lifecycle.test.ts`, `serve-service.ts` réécrit en pilote avec sa file, puis B1, M3, M4, les NITs du pilote et le câblage du quit du §7. Les 38 tests actuels restent des tests d'intégration du pilote, moins ceux qui encodent une mesure de stamp ou un entrelacement, lesquels migrent vers la table. Effort : 1,5 à 2 jours plus une revue (§3).
2. **LS2b** (`c206d3a5`) ensuite, sans toucher l'automate : la capture de l'environnement du shell de login vit dans l'effet `prepare`, déjà interruptible par `Stop` et `Quit`, et doit être bornée comme les autres effets ; `Start` exige `ApprovedServeAction`.
3. **LS3** (`4d6ec4fb`) : contrat inchangé.

**LS2c est ABSORBÉ**, pas corrigé avant : rien n'en est atteignable avant LS3, et rapiécer un code destiné à être remplacé reproduirait la méthode qui a échoué trois fois.

## 10. Décisions et questions ouvertes

1. **M2, TRANCHÉ par l'opérateur le 2026-10-09 (transmis par le lead)** : quand le leader POSIX sort de lui-même, le groupe est RÉCOLTÉ (`-> stopping(leaderExited)`, escalade sans mesure, arrêt au premier ESRCH), et non plus abandonné. Raison : sinon les descendants gardent le port et les fichiers au-delà du quit. Sous Windows, le résidu du §8 reste.
2. **Identité, lead** : abandon du stamp dans Serve (§2), sur mesures du challenger. Cela contredit la lettre du brief §LS2 (« PID + spawn time ») : à acter en amendant le brief.
3. **B contre C, lead** : B recommandé (§3). Si le coût prime, C couvre la même liste pour environ un jour de moins, avec le risque résiduel décrit.
4. **darwin EPERM, TRANCHÉ par la mesure** (§6) : EPERM sur notre groupe vaut « groupe vide ou zombie », exit observé ou non.

## 11. Amendements à l'implémentation

- **A1** `QuitDeadline × stopping` n'émet ni SIGKILL si SIGKILL figure déjà parmi les actes de l'`op`, ni `killLeader` s'il a déjà été émis ou si l'`exit` Windows est observé : la ligne du §5 violait I2 quand SIGKILL avait échoué et qu'un `probeGroup` était en vol.
- **A2** `GroupProbed` porte un `code` d'erreur : la ligne darwin EPERM du §5 doit le distinguer, comme pour `SignalResult`.
- **A3** `probing` n'a pas de `probeOp` : un seul probe est en vol à la fois, et un `ProbeAnswered` ou un `ProbeFailed` reçu pendant l'attente `probeDelay` vaut `none`.
- **A4** `op` s'incrémente au seul `Start`, et une cellule vide du §5 vaut `none`, sans effet ni `report` : la table l'asserte telle quelle.
- **A5** Un 17e événement, `LogFailed{op}`, mène à `stopping(logSetup)` depuis `probing` ou `ready` : un serveur sans `serve.log` est une panne invisible. `Spawned` avec un `pendingStop` n'émet pas `openLog`, puisque le dossier de session est déjà fermé au quit.
- **A6** `idle{failure}` porte `url`, `port` et `pid` quand l'exécution les connaissait : le statut `failed` vu par LS3 les expose déjà.
- **A7** `start()` se résout à la première phase hors de `preparing` et `spawning` ; `busy` et `rejected` rendent l'état courant sans lever, comme l'API actuelle.
- **A8** Les chemins System32 de PowerShell et de `taskkill` se résolvent dans l'effet `prepare` : un `SystemRoot` invalide donne `PrepareFailed`, et le réducteur reste sans import `node:`.
- **A9** `LogFailed × stopping` émet `report` et oublie le journal, sans changer le sous-pas ; un résultat qui ne correspond pas au sous-pas en cours (autre signal, `TaskkillDone` hors `taskkill`, minuteur autre que celui du sous-pas) vaut `none`.
- **A10** `probeGroup` et `GroupProbed` portent un `probeId` : une réponse dont l'id n'est pas celui du probe en attente est périmée (I5), et quitter une grâce oublie son probe, pour qu'une réponse tardive ne déclenche ni un signal en trop ni un faux « unreachable ».
- **A11** `SignalResult sent` reçu après l'`exit` du leader arme la grâce ET sonde le groupe : la grâce pleine ne s'applique plus seulement quand l'`exit` arrive après le signal.
