# Vérification Windows natif -- badge de modèle et anneau de contexte

Ce document est le point de reprise unique pour vérifier, sur Windows natif
(pas WSL), la fonctionnalité livrée par les commits de la branche portant sur
le badge modèle / anneau de contexte. Les mesures M1 à M7 n'ont **pas** pu
être exécutées sous Linux et restent à faire par l'opérateur sur sa machine
Windows. Tout ce dont la reprise a besoin est dans ce fichier.

## 1. Contexte

Chaque tuile Claude Code de la Sidebar affiche désormais le modèle courant
(badge) et un anneau qui se remplit selon `context_window.used_percentage`,
mis à jour après un `/model` ou un `/compact`. La source est le JSON stdin du
statusLine de Claude Code : chaque tuile est lancée avec `--settings` vers un
fichier commun (statusLine seul, `refreshInterval` 5 s). Le hook
`desktop/hooks/desk-statusline.ts` :

1. écrit `~/.claude/peers/desk-status-<token>.json` (le rapport lu par le
   Deck), gardé par `CLAUDE_PEERS_DESK_SESSION` ;
2. rechaîne ensuite le statusLine de l'opérateur lu dans les settings
   **globaux** uniquement, avec la même entrée stdin, pour ne jamais faire
   disparaître le statusLine de l'opérateur quand le Deck impose le sien.

**Tout statusLine configuré** (le nôtre ou celui de l'opérateur) fait
disparaître le hint `esc to interrupt` du footer de Claude Code ; `quota.ts`
et `attention.ts` doivent donc reconnaître l'occupation d'une tuile sans ce
hint, sous peine de rester bloqués sur une tuile limitée. `detect/busy.ts`
réunit plusieurs signaux indépendants du hint, lus dans `desktop/src/main/
detect/busy.ts` :

- le hint `esc to interrupt`, où qu'il apparaisse à l'écran ;
- les indices de minuteur/tokens/thinking (`(Ns ·`, `↓ N tokens`,
  `· thinking)`), comptés seulement sur la ligne du spinner, ou sur un
  réaffichage partiel qui commence par un déplacement de curseur avant et se
  termine par `tokens · thinking)` ;
- le titre OSC 0 en demi-cercles (ou trames braille sur les CLI plus
  anciennes) quand il change.

Voir `busy.ts` pour le détail exact des expressions régulières -- ce résumé
peut devenir périmé si le fichier évolue sans que ce document soit relu.

**Retrouver les commits concernés.** Depuis la racine du dépôt :

```
git fetch origin main
git log --oneline --grep "statusLine\|contexte" origin/main..HEAD
```

(adapter la base -- `origin/main` -- à la branche réelle si elle diffère ;
`git log --oneline -5` sur la branche donne un aperçu rapide sans dépendre de
cette base). `git log --all --grep "Card <id8>"` retrouve l'historique
complet d'un lot une fois son id de carte connu ; `git show <sha>` donne le
corps exact de chaque commit.

**Vérifié sur Linux** (gate `bun test`, smoke build, typecheck desktop) :
la logique pure (encodage/décodage du fichier de statut, détection busy/quota/
attention sur les fixtures PTY existantes, forme du hook construit, cache du
chaînage opérateur). **Non vérifié nulle part avant la vérification Windows
décrite ici**, cité explicitement dans le corps du commit
`feat(desktop): afficher le modele et le remplissage du contexte par
session` ("Risques ouverts (BACKLOG)") :

- l'héritage de `CLAUDE_PEERS_DESK_SESSION` par le PROCESSUS statusLine que
  Claude Code lui-même spawn (pas seulement par le hook) -- **M1** ;
- le comportement réel de ConPTY (busy cues, titre OSC 0) sur un vrai
  `claude` Windows, avec et sans statusLine -- **M2** ;
- le chaînage de la commande opérateur à travers Git Bash / PowerShell avec
  des caractères de citation difficiles (guillemets, apostrophe, `~`,
  `$(...)`), et le choix Git Bash vs PowerShell selon
  `CLAUDE_CODE_GIT_BASH_PATH` / PATH -- **M3** ;
- l'annulation côté Windows (`TerminateProcess`, pas de handler de signal) et
  les processus orphelins -- **M4** ;
- le coût CPU du chaînage à plusieurs tuiles -- **M5** ;
- la latence perçue du badge -- **M6** ;
- le rendu visuel réel dans la Sidebar -- **M7**.

## 2. Prérequis

- Windows 10 ou 11, **Git for Windows** installé (fournit Git Bash /
  `bash.exe`, ce que `chainShellFor()` cherche en priorité).
- `bun` et `node` installés et sur le PATH.
- Claude Code **>= 2.1.282** (version utilisée pour vérifier le masquage du
  hint sous Linux, via `claude --version` : `2.1.282 (Claude Code)`). Une
  version plus ancienne peut ne pas masquer le hint de la même façon --
  notez la version réelle utilisée dans les résultats.
- Ce dépôt, branche courante checked out.
- Construire le hook avant toute mesure :
  ```powershell
  cd desktop
  npm install
  npm run build:hook
  ```
  Ceci produit `desktop/deck-plugin/hooks/desk-statusline.mjs`, le fichier que
  Claude Code lance réellement (jamais le `.ts` source). Sans cette étape,
  M3, M4 et une partie de M1 ne testent rien de réel.

Tous les scripts de vérification sont dans `desktop/scripts/win-verify/`
(répertoire dédié, indépendant du code de production). Les scripts `.ts` sont lancés par `bun` depuis la racine du
dépôt ; les scripts `.ps1` sont spécifiques à Windows (comptage de
processus, échantillonnage CPU) et se lancent avec `pwsh -File` ou
`powershell -File`. Chaque script écrit ses sorties sous
`desktop/scripts/win-verify/out/` par défaut (`--out <dir>` pour
redéfinir). Ce répertoire est déjà ignoré par git (règle `out/` de
`desktop/.gitignore`) : ses captures ne doivent pas être commitées telles
quelles ; une capture retenue comme fixture est copiée à la main dans
`tests/pty-harness/fixtures/`.

## 3. Mesures à faire

### M1 -- Héritage de l'environnement par le processus statusLine

**Objectif.** Vérifier que le PROCESSUS que Claude Code spawn pour exécuter
la commande `statusLine` (donc notre hook `desk-statusline.mjs`, lancé en
grand-enfant du PTY) reçoit bien `CLAUDE_PEERS_DESK_SESSION` -- c'est la clé
qui décide si le hook écrit ou non le fichier de statut pour cette tuile
(`statusFileTarget` retourne `null` si le token est absent).

**Commandes.**
```powershell
bun desktop\scripts\win-verify\env-check.ts setup
```
Le script écrit deux scripts-sondes (`.sh` pour Git Bash, `.ps1` pour
PowerShell) qui dumpent leur propre `CLAUDE_PEERS_DESK_SESSION` dans un
fichier JSON, et DEUX fichiers de settings de statusLine : un qui force
l'appel du `.sh` via Git Bash (`bash "<chemin>.sh"`, chemin en slashes avant),
un qui force l'appel du `.ps1` via `powershell -NoProfile -ExecutionPolicy
Bypass -File`. Sur cette plateforme, c'est Claude Code lui-même qui choisit
Git Bash ou PowerShell pour lancer la commande `statusLine` (comportement non
documenté pour ce cas précis ; `chainShellFor()`, la fonction du hook Deck qui
choisit le shell pour RECHAÎNER la commande de l'opérateur, ne fait que
reproduire ce que la doc statusline de Claude Code documente pour ce
deuxième cas -- ce n'est pas elle qui décide ici) ; les deux fichiers séparés
forcent chaque branche à tour de rôle plutôt que de dépendre du choix de
Claude Code. `setup` imprime les commandes exactes à lancer pour chacun, par
exemple :
```powershell
$env:CLAUDE_PEERS_DESK_SESSION = "win-verify-m1-desk-session"
claude --settings "desktop\scripts\win-verify\out\env-check-settings-bash.json"
```
puis, après avoir refait `check --shell bash` (voir plus bas), le même avec
`env-check-settings-ps1.json`. Pour chaque run : laissez le statusLine se
rafraîchir au moins une fois (~5 s après l'apparition du prompt), puis
`Ctrl-C` pour quitter `claude`, puis, IMMÉDIATEMENT (avant de lancer l'autre
shell) :
```powershell
bun desktop\scripts\win-verify\env-check.ts check --shell bash
```
puis, pour le run PowerShell :
```powershell
bun desktop\scripts\win-verify\env-check.ts check --shell powershell
```
`--shell` est obligatoire : `check` refuse le verdict si le champ `shell` du
dump ne correspond pas (`sh` pour `--shell bash`, `powershell` pour
`--shell powershell`), et si le fichier de dump n'est pas plus récent que le
`setup` en cours -- un dump laissé par le run précédent, ou par un ancien
`setup`, ne peut donc plus produire un faux PASS. `check` supprime le fichier
de dump après l'avoir lu : les deux runs doivent donc s'enchaîner shell puis
`check --shell <même shell>`, jamais les deux runs avant l'un ou l'autre
`check`.

**Résultat attendu.** Le fichier de dump contient
`"CLAUDE_PEERS_DESK_SESSION":"win-verify-m1-desk-session"` et un champ
`"shell"` correspondant au `--shell` demandé, et `check` imprime `PASS`, pour
chacun des deux runs (Git Bash puis PowerShell).

**Résultats à consigner.** Le bloc complet imprimé par `check --shell ...`
(contenu du dump + verdict), une fois par shell.

**Critère pass/fail.** PASS si `CLAUDE_PEERS_DESK_SESSION` est présente et
égale au sentinel, si le champ `shell` du dump correspond au `--shell`
demandé, et si le dump est postérieur au `setup` en cours -- pour les DEUX
shells (Git Bash et PowerShell, lancez `setup`/le run/`check --shell ...` une
fois par shell, sans sauter d'étape). FAIL si l'une de ces trois conditions
manque -- en particulier pour PowerShell, une politique d'exécution par
défaut (Restricted) qui bloque le script `.ps1` produit un FAIL correct
(pas de dump), ce que `-ExecutionPolicy Bypass` dans la commande générée
évite. Un FAIL confirmerait que le badge ne s'affichera jamais sur aucune
tuile Windows pour ce shell.

### M2 -- Capture ConPTY réelle et rejeu des détecteurs busy/quota/attention

**Objectif.** Capturer un vrai transcript PTY Windows (ConPTY, via node-pty,
le même moteur que `desktop/src/main/pty-manager.ts`) d'un `claude --model
haiku` exécutant un prompt de quelques secondes, AVEC et SANS statusLine, et
vérifier que `createBusyCue` / `QuotaDetector` / `AttentionDetector`
détectent bien le tour comme occupé (et jamais le résumé de fin de tour).

**Commandes.**
```powershell
cd desktop
npm install    # prebuild win32 de node-pty ; sinon npm run rebuild si l'ABI ne correspond pas
cd ..
bun desktop\scripts\win-verify\capture-pty.ts --with-statusline --model haiku --out desktop\scripts\win-verify\out
bun desktop\scripts\win-verify\capture-pty.ts --without         --model haiku --out desktop\scripts\win-verify\out
```
Chaque appel spawn `claude --model haiku [--settings ...]`, attend, tape un
prompt (`sleep 4` par défaut -- voir `--prompt` pour un autre), et écrit un
fichier fixture `[{t, data}]` (même forme que
`tests/pty-harness/fixtures/*.json`). Puis rejouez chaque fixture :
```powershell
bun desktop\scripts\win-verify\replay-busy.ts desktop\scripts\win-verify\out\capture-with-statusline-*.json
bun desktop\scripts\win-verify\replay-busy.ts desktop\scripts\win-verify\out\capture-without-statusline-*.json
```

**Résultat attendu.** Pour la capture AVEC statusLine : `everBusy=true` (le
cue busy a bien déclenché sur au moins un chunk pendant le tour) et le
résumé de fin de tour (les derniers chunks) NE reste PAS `busy=true`. Pour la
capture SANS statusLine, le hint `esc to interrupt` doit être visible dans le
transcript brut (`grep -i "esc to interrupt"` sur le fichier fixture) et le
cue busy doit aussi déclencher, par un chemin différent (texte ou hint).
Comparez les deux fixtures : c'est la différence de mécanisme, pas seulement
le résultat final, qui prouve que le commit `detect/busy.ts` était nécessaire
sur Windows et pas seulement sur les fixtures Linux/macOS existantes.

**Résultats à consigner.** La sortie console de chaque `replay-busy.ts`
(résumé + 5 derniers chunks), et si possible les deux fichiers fixture
eux-mêmes (petits, quelques Ko) pour qu'ils puissent être ajoutés à
`tests/pty-harness/fixtures/` dans un commit ultérieur s'ils sont utiles.

**Critère pass/fail.** PASS si `everBusy=true` dans les deux cas et si aucun
`busy=true` ne persiste sur les chunks qui suivent le résumé final ("Worked
for Ns · done"). FAIL sinon -- notez précisément QUEL signal a manqué
(hint, spinner-row, titre OSC 0).

**Non exécutable sous Linux** : `desktop/node_modules/node-pty` n'a
qu'un binding natif prébuilt pour `darwin-*` et `win32-*` dans ce dépôt ;
aucun `linux-x64`. `capture-pty.ts --without --model haiku` échoue
proprement sous Linux (message clair vers `npm install`/`npm run rebuild`,
exit code 2), ce qui vérifie seulement la sortie d'erreur, pas la capture
elle-même. La capture réelle reste entièrement à faire sur Windows.

### M3 -- Chaînage à travers Git Bash et PowerShell

**Objectif.** Vérifier que le hook construit chaîne correctement la commande
statusLine de l'opérateur quand celle-ci contient des guillemets doubles
imbriqués, une apostrophe, un `~` et une substitution `$(...)`, dans les
deux shells possibles, et avec `CLAUDE_CODE_GIT_BASH_PATH` forcé.

**Commandes.**
```powershell
bun desktop\scripts\win-verify\chain-check.ts
bun desktop\scripts\win-verify\chain-check.ts --hide-git-bash
bun desktop\scripts\win-verify\chain-check.ts --git-bash-path "C:\Program Files\Git\bin\bash.exe"
```
Le script crée un `CLAUDE_CONFIG_DIR` temporaire avec un `settings.json`
dont le statusLine est `echo "operator's line ~ $(pwd)"`, lance le hook
construit avec un payload synthétique sur stdin, et rapporte : la décision de
`chainShellFor()` (fichier + args), le code de sortie, stdout/stderr, et le
contenu décodé du fichier de statut écrit pour la tuile.
`--hide-git-bash` retire du PATH toute entrée dont le texte contient `git`
(recherche large, pas seulement un dossier nommé `git`, et efface
`CLAUDE_CODE_GIT_BASH_PATH`), pour forcer la branche PowerShell.
`--git-bash-path` force un chemin explicite.

**Résultat attendu.** Sans `--hide-git-bash` et avec Git Bash installé :
`chainShellFor()` choisit `bash.exe`, et stdout contient `operator's line ~
<le répertoire courant>` -- l'apostrophe et le `~` sont passés tels quels,
`$(pwd)` est EXPANSÉ (pas imprimé littéralement). Avec `--hide-git-bash` :
`chainShellFor()` choisit `powershell.exe`, même résultat stdout (PowerShell
interprète aussi `$(...)` en substitution dans une chaîne entre guillemets
doubles). Le fichier de statut de la tuile doit exister et se décoder
correctement dans les trois cas (le chaînage ne doit jamais empêcher
l'écriture du rapport, qui se fait avant).

**Résultats à consigner.** La sortie console des trois invocations
(décision de shell + stdout + état du fichier de statut).

**Critère pass/fail.** PASS si, dans les trois cas, `exitCode=0`, le fichier
de statut est écrit et se décode, et le stdout contient la ligne attendue
avec l'apostrophe/`~`/substitution corrects (pas de guillemet perdu, pas de
`$(pwd)` imprimé littéralement, pas d'erreur de syntaxe visible dans
stderr). FAIL si un des trois shells tronque ou corrompt la commande, ou si
`--git-bash-path` est ignoré.

**Vérifié sur Linux (branche `/bin/sh` uniquement, sert de référence) :**
`chainShellFor()` retourne `{ file: '/bin/sh', args: ['-c', <commande>] }`
sur cette plateforme, et le script bout en bout écrit bien
`operator's line ~ <cwd>` sur stdout avec `$(pwd)` expansé (`bun
desktop/scripts/win-verify/chain-check.ts`, exit code 0). Les branches Git
Bash et PowerShell de `chainShellFor()` restent à vérifier sur Windows.

### M4 -- Annulation et processus orphelins

**Objectif.** Vérifier qu'un statusLine opérateur lent (300 s), rafraîchi/
annulé rapidement plusieurs fois de suite (comme Claude Code le fait à
chaque tick), ne laisse aucun processus survivre au-delà du `killTree()`
(`taskkill /T /F` sur win32 -- voir `desk-statusline.ts`, fonction
`killTree`).

**Commandes.**
```powershell
pwsh -File desktop\scripts\win-verify\orphans.ps1
```
(ou `powershell -File ...` si `pwsh` n'est pas installé). Le script lance le
hook construit 6 fois de suite avec un statusLine qui `Start-Sleep -Seconds
30` (ligne de commande marquée d'un jeton distinctif, `KORY-ORPHANS-MARKER`),
attend d'observer ce processus chaîné (ou au moins 1,5 s si jamais observé
dans les 4 s) avant de tuer chaque invocation du hook (simulant l'annulation
de Claude Code) -- tuer trop tôt, avant que `bun` n'ait seulement lancé le
processus chaîné, produirait un PASS qui ne prouve rien, faute de
petit-fils à nettoyer -- attend ensuite 60 s, puis liste tout processus dont
la ligne de commande référence encore le dossier temporaire de ce run ou le
marqueur `KORY-ORPHANS-MARKER`.

**Résultat attendu.** Zéro processus restant.

**Résultats à consigner.** La sortie console (tableau des processus
restants, ou "none (PASS)"), et le chemin du rapport JSON.

**Critère pass/fail.** PASS si `orphans-*.json` est vide. FAIL si un ou
plusieurs `powershell.exe`/`bun.exe` restent en vie -- notez leur
`CommandLine` complète, c'est ce qui dira si le gap est dans
`killTree()` (le commentaire du code note déjà que `TerminateProcess` ne
déclenche aucun handler côté enfant, donc un petit-enfant du process chaîné
pourrait survivre à `taskkill /T` si celui-ci n'a pas encore de PID connu au
moment du kill).

**Balayage au démarrage (`sweepStaleStatusFiles`, `session-status-file.ts`).**
Objectif : vérifier que le balayage effectué au démarrage du Deck ne touche
que les fichiers `desk-status-*.json` / `desk-statusline-cache-*.json`
(y compris leur résidu `.<pid>.tmp`) dont le token n'appartient à aucune
tuile connue ET dont le `mtime` a plus de 24 h -- jamais un fichier récent
d'un AUTRE Deck en cours d'exécution sur la même machine.

**Procédure.**
1. Créez à la main, sous `~\.claude\peers\`, un `desk-status-win-verify-old.json`
   et un `desk-statusline-cache-win-verify-old.json` avec un `mtime` forcé à
   plus de 24 h (PowerShell : `(Get-Item <fichier>).LastWriteTime =
   (Get-Date).AddHours(-25)`).
2. Créez de la même façon un `desk-status-win-verify-fresh.json` avec un
   `mtime` récent (quelques minutes).
3. Démarrez le Deck (ou redémarrez-le si déjà ouvert), avec zéro tuile portant
   ces deux tokens.
4. Vérifiez que les deux fichiers "old" ont disparu et que le fichier "fresh"
   est toujours là.

**Résultats à consigner.** Présence/absence des trois fichiers avant/après le
démarrage du Deck.

**Critère pass/fail.** PASS si les deux fichiers `-old` sont supprimés et le
fichier `-fresh` conservé. FAIL si un fichier récent disparaît (balayage trop
agressif, risque de supprimer un rapport d'un autre Deck actif) ou si un
fichier vieux de plus de 24 h survit.

**Avertissement "no statusLine report" après 60 s
(`statusSilenceOverdue`/`statusSilenceMessage`, `session-status-file.ts`).**
Objectif : vérifier que l'avertissement ne se déclenche PAS pendant que la
tuile attend l'opérateur (dialogue de confiance du workspace, prompt de
permission -- Claude Code ne lance aucun statusLine avant que le workspace
soit approuvé), et qu'il se déclenche UNE SEULE fois par tuile si le hook ne
peut jamais tourner.

**Procédure.**
1. Ouvrez une tuile dans un répertoire jamais approuvé par Claude Code (le
   dialogue de confiance doit apparaître) et laissez-la sur ce dialogue plus
   de 60 s : aucun avertissement de statusLine silencieux ne doit apparaître
   tant que le dialogue est affiché.
2. Approuvez le workspace ; le badge doit apparaître normalement dans les
   secondes qui suivent (voir M6).
3. Dans une autre tuile, retirez `bun` du PATH que Claude Code voit (ou
   forcez `disableAllHooks`/`allowManagedHooksOnly` dans les settings
   globaux), ouvrez une tuile Claude Code, et laissez-la idle plus de 60 s :
   l'avertissement doit apparaître une fois, avec le message de
   `statusSilenceMessage` (bun absent du PATH, hooks désactivés par
   politique, ou workspace non approuvé), et ne pas se répéter en boucle pour
   la même tuile.

**Résultats à consigner.** Horodatage/texte exact de l'avertissement (ou son
absence), pour les deux scénarios.

**Critère pass/fail.** PASS si aucun avertissement n'apparaît pendant le
dialogue de confiance et si l'avertissement du scénario 3 apparaît une seule
fois. FAIL si l'avertissement se déclenche pendant le dialogue de confiance
(faux positif) ou ne se déclenche jamais quand le hook est réellement cassé
(silence total, aucune trace pour l'opérateur).

### M5 -- Coût CPU à plusieurs tuiles

**Objectif.** Mesurer le surcoût CPU du statusLine avec N=8 tuiles
simultanément actives, comparer avec/sans statusLine opérateur, et avec le
réglage désactivé.

**Le réglage.** `Settings > General`, libellé exact (`settings.liveStatusLine`,
`desktop/locales/fr.json`) : **« Afficher le modèle et le remplissage du
contexte dans la liste des sessions »**. Le désactiver empêche le Deck
d'injecter son propre statusLine dans les tuiles qu'il lance ensuite (prend
effet au prochain démarrage d'une tuile, voir `settings.liveStatusLineHelp`).

**Ce qui tourne réellement toutes les 5 s, et ce qui ne tourne pas.** Deux
mécanismes distincts, à ne pas confondre :
1. Le hook bun du Deck lui-même (`desk-statusline.mjs`) : lancé par Claude
   Code à chaque tick de son `refreshInterval` (5 s), par tuile. C'est
   incompressible -- c'est le mécanisme même du statusLine -- et c'est ce qui
   écrit le rapport modèle/contexte lu par le badge.
2. La commande statusLine PROPRE À L'OPÉRATEUR (celle des settings globaux,
   rechaînée par le hook) : elle NE tourne PAS à chaque tick. Le hook met en
   cache sa sortie par tuile dans
   `~/.claude/peers/desk-statusline-cache-<token>.json`, sous une clé qui
   dérive de la commande et du payload stdin privé de ses seuls compteurs de
   temps qui montent sans événement derrière (`total_duration_ms`,
   `total_api_duration_ms` -- voir `VOLATILE_COST_FIELDS`,
   `desk-statusline.ts`). La commande de l'opérateur ne se relance que si
   cette clé change (un vrai événement : modèle, contexte, coût réel...) ou
   si le `refreshInterval` propre de l'opérateur (configuré dans SES
   settings, indépendant de celui du Deck) s'est écoulé depuis le dernier
   run mis en cache. Sur des tuiles idle, avec un opérateur sans
   `refreshInterval` (événements seulement), la commande opérateur ne
   devrait donc tourner qu'une poignée de fois au total, pas toutes les 5 s
   par tuile.

**Commandes.** Ouvrez le Deck avec 8 tuiles Claude Code actives et stables
(pas en cours de démarrage), laissez-les idle, puis pour chaque
configuration :
```powershell
pwsh -File desktop\scripts\win-verify\cpu-sample.ps1 -Label "8-tiles-with-operator-statusline" -Seconds 300
```
Répétez avec `-Label "8-tiles-without-operator-statusline"` (aucun
statusLine dans les settings globaux de l'opérateur -- seul celui du Deck
tourne) et `-Label "8-tiles-feature-disabled"` (réglage « Afficher le modèle
et le remplissage du contexte dans la liste des sessions » désactivé dans le
Deck). Le script échantillonne `Get-Counter '% Processor Time'` chaque
seconde sur `bun`, `node`, `claude`, `powershell`, `pwsh` pendant 5 minutes.

**Vérification complémentaire -- le cache existe et les ticks idle ne
relancent pas la commande opérateur.** Pendant (ou juste après) le run
`8-tiles-with-operator-statusline` :
1. Vérifiez que `~\.claude\peers\desk-statusline-cache-<token>.json` existe
   pour chaque tuile (un token par tuile -- `CLAUDE_PEERS_DESK_SESSION` de
   chacune) et que son `mtime` cesse de bouger une fois le cache chaud (pas
   de réécriture à chaque tick de 5 s).
2. Comptez les lancements de la commande OPÉRATEUR elle-même, pas de
   `bash.exe`/`powershell.exe` en général : sur Windows, Claude Code fait
   déjà tourner son propre hook Deck via Git Bash à chaque tick (environ 480
   lancements de `bash.exe` sur 8 tuiles × 5 minutes), donc filtrer sur le
   seul nom de processus fait échouer la mesure même quand le cache
   fonctionne. Donnez à la commande statusLine opérateur utilisée pour ce
   run un jeton distinctif dans sa propre ligne de commande, par exemple
   `bash -c "echo KORY-M5-MARKER; <commande reelle>"` (ou l'équivalent
   PowerShell), et comptez uniquement les `Win32_Process.CommandLine`
   contenant ce jeton -- par exemple `Get-CimInstance Win32_Process |
   Where-Object { $_.CommandLine -match 'KORY-M5-MARKER' } | Select
   ProcessId,CreationDate` répété chaque seconde (même principe que
   `orphans.ps1`, qui filtre déjà par ligne de commande plutôt que par nom).
   Une variante équivalente : ne compter que les processus dont le PARENT
   est un `bun.exe` correspondant au hook (`ParentProcessId` résolu via
   `Get-CimInstance Win32_Process` pour le `bun.exe` du hook), ce qui exclut
   par construction le `bash.exe` que Claude Code lance pour son propre
   hook. Sur 8 tuiles idle et 5 minutes, le nombre de lancements de la
   commande opérateur doit être largement inférieur à `8 tuiles × (300 s /
   5 s) = 480` (le compte si la commande tournait à chaque tick) -- proche
   de zéro une fois le cache chaud, hors événements réels.
3. Ne comptez pas comme un signe d'échec les relances légitimes suivantes,
   qui ne signalent pas un cache défaillant :
   - un backoff de 30 s après un timeout ou un échec de démarrage de la
     commande opérateur (`CHAIN_BACKOFF_MS`, `desk-statusline.ts`) : la
     commande reste en `backoff` et ne sert rien, donc elle se relance au
     prochain tick après ces 30 s, pas à chaque tick de 5 s ;
   - une sortie de plus de 32 KiB (`CHAIN_CACHE_MAX_OUT`, `desk-statusline.ts`)
     n'est jamais mise en cache et relance donc la commande à chaque tick
     par construction -- vérifier `CHAIN_CACHE_MAX_OUT`/`CHAIN_BACKOFF_MS`
     dans le fichier avant d'interpréter un compte élevé comme un défaut ;
   - un changement de clé de cache (`chainCacheKey`) : un vrai événement
     (`/model`, changement de contexte) fait légitimement tourner la
     commande une fois ;
   - le `refreshInterval` propre de l'opérateur, configuré dans SES
     settings, indépendant de celui du Deck.

**Résultat attendu.** Les trois runs `cpu-sample.ps1` impriment une
moyenne/pic par nom de processus (et un compte de tick manquants -- voir
`missingTicks` dans le rapport, qui doit rester bas) ; le fichier de cache
existe et n'est pas réécrit à chaque tick ; le compte de lancements de la
commande opérateur (identifiée par son marqueur ou par son parent `bun.exe`,
PAS par le seul nom `bash.exe`/`powershell.exe`) reste proche de zéro sur
des tuiles idle, hors relances légitimes listées ci-dessus.

**Résultats à consigner.** Les trois blocs `--- <label> ---` imprimés (ou les
trois JSON, avec leurs `missingTicks`), l'état du fichier de cache par
tuile, et le compte de lancements de la commande opérateur observé.

**Critère pass/fail.** Le coût CPU n'est pas un pass/fail binaire -- reporter
les trois chiffres avec le nombre de tuiles et laisser un humain juger si le
delta "avec statusLine opérateur" vs "sans" est raisonnable. Le compte de
lancements de la commande opérateur, lui, EST un critère binaire : PASS si
les ticks idle ne relancent pas la commande opérateur (cache servi, hors
relances légitimes ci-dessus), FAIL si chaque tick de 5 s relance la
commande opérateur par tuile (le cache ne fonctionne pas) -- en excluant
explicitement le hook Deck lui-même, qui tourne via Git Bash à chaque tick
par conception et n'est pas ce que cette mesure teste. Signaler tout chiffre
de CPU qui semble grossièrement disproportionné (par ex. `avgPct` > quelques
% soutenu par processus nommé) comme suspect à investiguer, pas comme un
FAIL automatique.

### M6 -- Latence du badge après `/model`

**Objectif.** Mesurer le délai entre `/model <autre-modele>` tapé dans une
tuile et la mise à jour visible du badge dans la Sidebar.

**Procédure (chronomètre manuel, pas de script -- nécessite le vrai Deck).**
1. Ouvrez une tuile Claude Code dans le Deck, notez le modèle affiché dans le
   badge de la Sidebar.
2. Tapez `/model <un autre modele>` dans la tuile et validez.
3. Démarrez un chronomètre au moment où vous validez.
4. Arrêtez-le dès que le badge de la Sidebar change de valeur.
5. Répétez 3 fois, notez les 3 délais.

**Résultat attendu.** `reportStatus()` écrit le fichier de statut AVANT que
`chainOperatorStatusLine()` ne lance ou n'attende la commande de l'opérateur
(`main()`, `desk-statusline.ts`) : le `CHAIN_TIMEOUT_MS` du hook (4 s max)
protège la commande opérateur elle-même, il ne retarde jamais l'écriture du
rapport que le badge lit. La latence du badge dépend donc uniquement du
`refreshInterval` du statusLine du Deck (5 s) et du cycle de poll du Deck
côté renderer (jusqu'à 4 s) : `refresh ≤ 5 s + poll ≤ 4 s`, donc typiquement
entre quelques centaines de ms et 9 s, même avec un statusLine opérateur lent
ou configuré. Sur Windows, le temps de démarrage du hook lui-même (lancement
de Git Bash puis de `bun` pour exécuter `desk-statusline.mjs`, avant même que
`reportStatus()` écrive le fichier) s'ajoute à cette borne de 9 s et reste à
mesurer ici -- ne pas supposer qu'il est négligeable avant de l'avoir
chronométré.

**Résultats à consigner.** Les 3 délais mesurés, et si un statusLine
opérateur était actif pendant la mesure.

**Critère pass/fail.** PASS si le délai reste sous ~9 s de façon
répétable. FAIL si le badge ne se met jamais à jour, ou si le délai dépasse
nettement 9 s de façon répétée -- ce dernier cas indiquerait que la commande
opérateur bloque bien l'écriture du rapport, contrairement à ce que montre
la lecture du code (`reportStatus` avant `chainOperatorStatusLine`).

### M7 -- Vérification visuelle du badge et de l'anneau

**Objectif.** Confirmer que le badge de modèle et l'anneau de contexte dans
la Sidebar respectent les règles visuelles du projet (voir `DESIGN.md` : pas
de contrôle à l'apparence native, pas d'emoji -- glyphes SVG grecs
uniquement).

**Procédure.**
1. Thème clair : ouvrez plusieurs tuiles à des `used_percentage` différents
   (visez un < 70 %, un entre 70 et 90 %, un > 90 %) et vérifiez que
   l'anneau change de couleur aux seuils 70 % / 90 %.
2. Répétez en thème sombre.
3. Coupez le réseau ou attendez avant le premier rapport statusLine pour
   observer l'état "modèle inconnu" -- l'anneau doit apparaître en pointillés
   (`dashed`), pas dans un état cassé ou vide silencieux.
4. Repliez le rail de navigation (mode compact) et vérifiez que le badge/
   anneau disparaît proprement (pas de texte tronqué de travers, pas de
   débordement).

**Résultats à consigner.** Des captures d'écran (ou une description
précise) pour chacun des 4 points, thème clair et sombre.

**Critère pass/fail.** PASS si les 4 points sont conformes. FAIL avec le
point précis en cause sinon (couleur de seuil, style pointillé, débordement
en rail replié).

## 4. Défaut préexistant à traiter séparément

**Où.** `desktop/src/main/screen-model.ts`, fonction `classifyInjectGuard`
(ligne 190-198) :

```ts
export function classifyInjectGuard(screen: Screen): InjectGuardState {
  const lines = screen.lines()
  const chevronRow = lines.findIndex((l) => /^\s*\u276F/.test(l))
  if (chevronRow <= 0) return 'modal'
  const { cy } = screen.cursor()
  return cy === chevronRow - 1 ? 'clear' : 'modal'
}
```

**Claim vérifiée en lisant le code, pas seulement devinée.**
`Screen.lines()` (même fichier, `makeScreen()`) expose
une grille FIXE de 200 lignes par défaut, sans défilement simulé -- chaque
ligne garde ce qui a été peint à cette position absolue jusqu'à la prochaine
écriture à cette même position. `lines.findIndex(...)` retourne le PREMIER
index qui matche `^\s*❯`, jamais le dernier. Quand Claude Code termine un
tour, il écho le prompt soumis comme historique ("❯ <texte de l'opérateur>")
au-dessus de la réponse, PUIS repeint un nouveau composer plus bas avec son
propre chevron -- donc dès le deuxième tour, la grille contient au moins
DEUX lignes qui matchent `^\s*❯` : l'écho historique (plus haut, trouvé en
premier par `findIndex`) et le composer courant (plus bas, où se trouve
réellement le curseur).

**Reproduction exécutée par simulation** (module pur, aucun repo muté,
aucun fichier existant touché) : construction d'un `Screen` avec un premier
chevron à la ligne 7 (composer du premier tour), puis simulation d'un
deuxième tour qui laisse ce chevron en historique et peint un nouveau
composer à la ligne 20 avec le curseur correctement placé une ligne
au-dessus (ligne 19) :

```
lines with chevron: [{i: 6, l: "❯ prompt one echoed in history"}, {i: 19, l: "❯"}]
cursor: {cy: 18, cx: 4}
classify -> modal
```

`chevronRow` vaut 6 (le PREMIER match, l'écho historique) au lieu de 19 (le
composer réel) ; le curseur (`cy=18`) est bien une ligne au-dessus du VRAI
composer (19), mais comme la fonction compare contre `chevronRow - 1 = 5`,
elle conclut `modal` alors que l'écran est en réalité `clear`.

**Attendu vs obtenu.** Attendu : `clear`, puisque le composer courant est
bien affiché et vide, curseur au bon endroit. Obtenu : `modal` dès que
l'historique contient un tour précédent -- ce qui est le cas de TOUTE
injection après le premier tour d'une session.

**Conséquence.** `ScreenGuard.classify()` (même fichier) est directement
cité par le guard d'injection de `session-service.ts`
(`this.screenGuard.classify(id) === 'modal'`, voir
`tests/desktop-inject-command-modal-guard.test.ts`) : toute directive/
injection du Deck vers une tuile est refusée dès que cette tuile a déjà
tenu un tour, statusLine ou pas -- ce bug est indépendant de la
fonctionnalité vérifiée par ce document, mais il partage le même fichier et
la même famille de détecteurs d'écran, d'où sa mention ici plutôt que son
silence.

**Piste suggérée (à discuter, pas à implémenter ici).** Ancrer la recherche
sur le DERNIER chevron (ou sur les dernières lignes non vides de la grille)
plutôt que le premier : `lines.length - 1 - [...lines].reverse().findIndex(...)`,
ou limiter la recherche à une fenêtre des N dernières lignes non-blanc
autour du curseur. Toute correction doit rester "fail closed" comme
aujourd'hui (aucun match -> `modal`) et être revue contre le même risque
d'écho que ce document décrit, pas seulement contre les captures à un seul
tour actuellement dans `tests/pty-harness/fixtures/`.

**À faire.** Ouvrir une carte de roadmap dédiée (`roadmap_*` MCP tools /
`BACKLOG.md`) citant ce document et la reproduction ci-dessus ; ne pas
corriger dans le cadre de cette vérification Windows.

## 5. Checklist récapitulative

- [ ] Prérequis installés (`claude --version`, `bun --version`, `node
      --version`, Git Bash présent) et notés dans les résultats
- [ ] `cd desktop && npm install && npm run build:hook` exécuté sans erreur
- [ ] M1 -- héritage `CLAUDE_PEERS_DESK_SESSION` (Git Bash) : PASS / FAIL
- [ ] M1 -- héritage `CLAUDE_PEERS_DESK_SESSION` (PowerShell) : PASS / FAIL
- [ ] M2 -- capture + rejeu AVEC statusLine : PASS / FAIL
- [ ] M2 -- capture + rejeu SANS statusLine : PASS / FAIL
- [ ] M3 -- chaînage Git Bash (défaut) : PASS / FAIL
- [ ] M3 -- chaînage PowerShell forcé (`--hide-git-bash`) : PASS / FAIL
- [ ] M3 -- `CLAUDE_CODE_GIT_BASH_PATH` explicite respecté : PASS / FAIL
- [ ] M4 -- zéro processus orphelin après 1 min : PASS / FAIL
- [ ] M4 -- balayage au démarrage (fichiers > 24 h supprimés, récents
      conservés) : PASS / FAIL
- [ ] M4 -- avertissement "no statusLine report" (silencieux pendant le
      dialogue de confiance, déclenché une fois si le hook ne tourne pas) :
      PASS / FAIL
- [ ] M5 -- CPU mesuré, 3 configurations : chiffres relevés
- [ ] M5 -- cache `desk-statusline-cache-<token>.json` présent et les ticks
      idle ne relancent pas la commande opérateur : PASS / FAIL
- [ ] M6 -- latence badge après `/model` : chiffres relevés
- [ ] M7 -- visuel clair/sombre, seuils 70/90 %, pointillé, rail replié :
      PASS / FAIL
- [ ] Défaut `classifyInjectGuard` : carte de roadmap ouverte (numéro :
      ______)

### Résultats

Remplir au fur et à mesure, une section par mesure.

```
Machine : Windows ___ (build ___), Git for Windows ___, Claude Code ___
Date de la verification : ___

M1 (Git Bash)   : PASS/FAIL -- ___
M1 (PowerShell) : PASS/FAIL -- ___

M2 (avec statusLine) : PASS/FAIL -- fixture: ___ -- everBusy=___
M2 (sans statusLine)  : PASS/FAIL -- fixture: ___ -- everBusy=___

M3 (Git Bash)          : PASS/FAIL -- stdout: ___
M3 (PowerShell forcee) : PASS/FAIL -- stdout: ___
M3 (GIT_BASH_PATH)     : PASS/FAIL -- stdout: ___

M4 (orphelins)  : PASS/FAIL -- processus restants: ___
M4 (balayage)   : PASS/FAIL -- fichiers supprimes/conserves: ___
M4 (silence 60s): PASS/FAIL -- ___

M5 avec statusLine op.    : avg=___% max=___%
M5 sans statusLine op.    : avg=___% max=___%
M5 reglage desactive      : avg=___% max=___%
M5 (cache/relances)       : PASS/FAIL -- lancements commande operateur (marqueur/parent bun) observes: ___

M6 : delais mesures (s) -- ___, ___, ___

M7 : ___

Carte roadmap classifyInjectGuard : ___
```
