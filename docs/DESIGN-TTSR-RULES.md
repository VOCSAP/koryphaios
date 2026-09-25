# Règles à la demande (TTSR) : règles Kory, règles globales, règles de dépôt

Conception et plan d'implémentation, 2026-09-25. Aucun code de production écrit
dans ce lot.

Origine : analyse d'[oh-my-pi](https://github.com/can1357/oh-my-pi) (omp),
mécanisme « Time Traveling Stream Rules » (`docs/ttsr-injection-lifecycle.md`
chez eux). Des autres pistes d'omp examinées dans la même analyse (rapports
typés de sous-agents, compaction des sorties d'outils, intercepteur bash),
aucune n'a été retenue : pas de plus-value suffisante face à l'existant.

## 1. Intention

Une règle n'est payée en tokens que le jour où elle sert. Au lieu de porter une
consigne dans CLAUDE.md (relue à chaque tour), un hook compare l'entrée d'un
outil à un motif et, s'il correspond, bloque l'appel ou injecte le texte de la
règle. Tant que rien ne se déclenche, le coût en contexte est nul.

Différence assumée avec omp : Kory pilote Claude Code et ne maîtrise pas son
flux de génération. La détection porte donc sur les **appels d'outils**
(`PreToolUse`, `PostToolUse`), jamais sur le texte en cours de génération.

Critère d'éligibilité d'une règle : un motif **mécanique, détectable par regex
sur l'entrée (ou la sortie Bash) d'un outil**. Les règles de jugement (« keyed
by what », les cinq entrées hostiles, la canonicalisation des chemins) restent
dans CLAUDE.md : elles guident la conception avant l'écriture, le TTSR
n'intervient qu'au moment d'écrire.

## 2. Trois sources de règles

| Source | Où | Qui écrit | Activation | Préfixe d'id |
|---|---|---|---|---|
| Kory (fixes) | constantes de code, `desktop/src/shared/ttsr-builtin.ts` | le code | actives par défaut, désactivables une à une | `kory/` |
| Globales | `<globalConfigDir>/ttsr-rules.json` | l'opérateur, via le Deck | case « Actif » | `user/` |
| Dépôt | `<projectDir>/.claude/claude-peers/rules.json` | un agent (via la skill) ou un humain | **approbation opérateur**, puis case « Actif » | `repo/` |

Les préfixes sont posés par le chargeur, pas écrits dans les fichiers : un
même id dans deux sources ne peut pas se masquer.

Les règles Kory s'appliquent à toute session, dans n'importe quel dépôt : elles
doivent rester génériques. Tout ce qui est propre à un dépôt (ex. « pas
d'emoji dans l'UI du Deck ») est une règle de dépôt.

### 2.1 Règles Kory livrées

Toutes `PreToolUse`, mode `deny`.

| id | Outils / champ | Motif (esquisse, à affiner en P1) |
|---|---|---|
| `empty-catch` | Edit, MultiEdit, Write / texte ajouté | `catch\s*(\([^)]*\))?\s*\{\s*\}` et `\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)` |
| `control-byte` | Edit, MultiEdit, Write / texte ajouté | octet `\x00`, `\x07` ou `\x1b` brut |
| `git-add-all` | Bash / commande | `git add (-A\|--all\|\.)(\s\|$)` |
| `git-no-verify` | Bash / commande | `--no-verify` |
| `git-force-push` | Bash / commande | `git push .*(--force\b\|-f\b)` sans `--force-with-lease` |
| `secret-literal` | Edit, MultiEdit, Write / texte ajouté | `sk-ant-`, `ghp_`, `AKIA[0-9A-Z]{16}`, `-----BEGIN [A-Z ]*PRIVATE KEY` |

Déjà couvert ailleurs, donc absent : le garde « pas de suite complète »
(`.claude/hooks/no-full-suite.sh`).

### 2.2 Exemples de règles de dépôt pour Koryphaios

Ce sont des exemples, pas des livrables : ils serviront de jeu d'essai à la
skill et au CLI (P3).

| id | Outils / chemins | Motif | Mode |
|---|---|---|---|
| `bun-not-node` | Bash, hors `desktop/` | `^(npm\|npx\|node\|yarn\|pnpm)\b` | deny |
| `no-emoji-ui` | Edit, Write sur `desktop/src/renderer/**` | `\p{Extended_Pictographic}` (flag `u`) | deny |
| `no-new-chantier-id` | Edit | `//.*\b(C\d+\|MB\d+\|TS\d+\|GX\d+\|CT\d+\|SBX\d+)\b` | warn |
| `no-history-comment` | Edit | `//.*\b(previously\|used to\|see [\w/.-]+\.(md\|ts))` | warn |
| `console-error-not-trace` | Edit sur `desktop/src/main/**` | `console\.error\(` | warn |
| `gitignored-doc-name` | Write / `file_path` | nom de base dans la liste `.gitignore` de CLAUDE.md | warn |

## 3. Format d'un fichier de règles

Même format pour les règles globales et les règles de dépôt.

```json
{
  "version": 1,
  "rules": [
    {
      "id": "no-emoji-ui",
      "event": "PreToolUse",
      "tools": ["Edit", "MultiEdit", "Write"],
      "field": "added",
      "paths": ["desktop/src/renderer/**"],
      "pattern": "\\p{Extended_Pictographic}",
      "flags": "u",
      "mode": "deny",
      "message": "No emoji in the Deck UI: use a Greek SVG glyph from components/icons.tsx."
    }
  ]
}
```

| Champ | Valeurs | Remarque |
|---|---|---|
| `id` | kebab-case, unique dans le fichier | préfixé par la source au chargement |
| `event` | `PreToolUse` \| `PostToolUse` | |
| `tools` | sous-ensemble de `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `Bash` | `PostToolUse` : `Bash` seulement en v1 |
| `field` | `added` \| `command` \| `file_path` \| `output` | `added` = `new_string` (Edit), chaque `edits[].new_string` (MultiEdit), `content` (Write), `new_source` (NotebookEdit) ; `command` = Bash ; `output` = `stdout` + `stderr` de Bash, `PostToolUse` seulement |
| `paths` | globs relatifs à la racine du projet, optionnel | sans `..`, sans chemin absolu |
| `pattern` / `flags` | regex JS, flags parmi `i`, `m`, `s`, `u` | |
| `mode` | `deny` \| `warn` | `deny` interdit en `PostToolUse` |
| `message` | texte non vide, ≤ 400 caractères | c'est ce que l'agent reçoit : consigne + remède |

Tout champ inconnu est une **erreur**, pas un avertissement : une faute de
frappe (`"patern"`) ne doit pas produire une règle qui ne se déclenche jamais.

## 4. Architecture

```
 Deck main                                   session (host ou sandbox)
 ┌──────────────────────────────┐            ┌─────────────────────────────┐
 │ builtins + ttsr-rules.json   │  compile   │ ttsr-hook.mjs (deck-plugin) │
 │ + rules.json du dépôt        │ ─────────▶ │ lit $CLAUDE_PEERS_TTSR_FILE │
 │   (si hash approuvé)         │  fichier   │ → deny / additionalContext  │
 │ + toggles « Actif »          │  effectif  └─────────────────────────────┘
 └──────────────────────────────┘  par tuile
          ▲ watcher sur rules.json du dépôt
```

### 4.1 Module partagé (source unique)

`desktop/src/shared/ttsr-rules.ts`, sans dépendance Electron, importé par le
hook, le CLI et le Deck main :

- `parseRulesFile(text): { ok: true, rules } | { ok: false, errors[] }` : le
  validateur (§5) ;
- `extractField(payload, field): string[]` : les chaînes testées par outil ;
- `evaluate(rules, payload, projectDir): { denies[], warns[] }` : le moteur ;
- `rulesHash(text)` : sha256 des octets du fichier.

Un validateur a tous ses chemins d'appel énumérés : hook (défensif, sur le
fichier effectif), CLI (`check`), Deck main (chargement global et dépôt,
approbation, sauvegarde depuis l'UI). Les trois passent par `parseRulesFile`,
et un test le fait respecter.

### 4.2 Fichier effectif par tuile

Le Deck main compile, pour chaque tuile, l'ensemble des règles **actives et
autorisées** dans `<userData>/<APP_STATE_SUBDIR>/ttsr/<def.id>.json`, et passe
ce chemin dans `CLAUDE_PEERS_TTSR_FILE`, à côté de `CLAUDE_PEERS_DESK_SESSION`
(`session-service.ts`).

- **Pourquoi par tuile** (« keyed by what, et s'il y en a deux ? ») : deux
  worktrees du même projet peuvent porter deux versions de `rules.json` ; une
  clé par projet ferait gagner la dernière écrite, sans bruit.
- Le hook ne voit **jamais** de contenu de dépôt non approuvé : la confiance
  est tranchée côté Deck, le hook reste trivial.
- Réécrit à la création de la tuile, à chaque changement de toggle, de règle
  globale ou d'approbation, et quand le watcher voit changer le `rules.json`
  du dépôt ; supprimé à la fermeture de la tuile.
- Écriture via `atomic-write.ts` : le hook ne doit jamais lire un fichier à
  moitié écrit.
- Superviseur : son bloc d'env omet volontairement `CLAUDE_PEERS_DESK_SESSION`.
  Décision à prendre en P2 : règles Kory seules, ou aucune.

### 4.3 Le hook `desktop/hooks/ttsr-hook.ts`

Compilé en `deck-plugin/hooks/ttsr-hook.mjs` par `build:hook`. Entrées dans
`hooks.json` :

- `PreToolUse`, matcher `Edit|MultiEdit|Write|NotebookEdit|Bash` ;
- `PostToolUse`, matcher `Bash`.

Comportement :

1. Pas de `CLAUDE_PEERS_TTSR_FILE`, fichier absent ou aucune règle pour cet
   événement et cet outil : sortie immédiate, code 0, rien sur stdout.
2. Chemins : `file_path` arrive absolu ; le filtre `paths` le relativise à la
   racine du projet après `canonicalPath` des deux côtés (règle CLAUDE.md).
3. Texte testé plafonné (ex. 256 Kio par champ) avant la regex : borne le coût
   d'un motif pathologique.
4. Sortie :
   - au moins un `deny` → `permissionDecision: "deny"`, avec les messages
     concaténés (plafonnés) dans `permissionDecisionReason` ;
   - sinon, au moins un `warn` → `additionalContext` seul.
5. **Un `warn` n'émet jamais `permissionDecision: "allow"`** : « allow »
   sauterait l'invite de permission de l'opérateur. C'est la garantie de
   sécurité centrale du hook ; un test la fait respecter avec un message qui
   nomme ce qu'il protège.
6. Échec interne : fail-open (code 0, pas de décision), **avec une trace**. Ne
   pas recopier le `.catch(() => {})` de `roadmap-guard-hook.ts`. Sink à
   choisir avec la skill `error-reporting` (fichier journal dont le chemin
   passe par l'env, ou back-channel).

Précédence documentée par Claude Code entre hooks : `deny` > `defer` > `ask` >
`allow`. Un `deny` TTSR l'emporte donc sur les hooks de l'opérateur (AiDex
compris) ; l'inverse est vrai aussi.

### 4.4 Approbation des règles de dépôt

Le fichier de dépôt est un « cloned-repo value » (entrée hostile n°1). Il ne
passe pas par un shell, mais une règle peut bloquer l'agent (un `deny` trop
large rend la session inutilisable), injecter du texte, ou être affaiblie par
l'agent qui l'a écrite. D'où :

- **Store** : `<userData>/<APP_STATE_SUBDIR>/ttsr-approvals.json`, de la forme
  `{ [project_key]: sha256[] }`. C'est un **ensemble** de hashes, pas une valeur
  unique comme `launch-approval.ts` : deux worktrees aux versions différentes
  sont approuvables sans se désapprouver l'un l'autre. Taille bornée (ex. les
  20 derniers).
- **Unité d'approbation** : le fichier entier, par son hash. Une modification,
  même d'un caractère, remet le fichier en attente et retire ses règles du
  fichier effectif au prochain passage du watcher.
- **Fichier invalide** : il est rejeté en bloc, aucune règle chargée, et
  l'erreur est visible dans les Réglages. Jamais de sous-ensemble chargé en
  silence (audit de couverture d'un garde : un chargement partiel serait un
  échec ouvert invisible).
- Lecture défensive du store : contrairement à `readApprovals`, pas de
  `catch {}` qui renvoie `{}` sans trace.

### 4.5 Réglages : catégorie « Règles »

Nouvelle entrée dans `CATEGORIES` de `SettingsView.tsx`. Tableau à quatre
colonnes :

| Nom | Hook | Définition | Actif |
|---|---|---|---|
| id + badge de source (Kory / Global / Dépôt) | événement + outils | bouton *Voir* (Kory, lecture seule) ou *Éditer* (Global, Dépôt) | case à cocher |

- Règles de dépôt : regroupées par projet des tuiles vivantes. Un fichier en
  attente affiche le badge « à approuver » et un bouton *Approuver* ; sa case
  « Actif » reste désactivée tant qu'il n'est pas approuvé.
- *Éditer* ouvre une modale de formulaire (les champs du §3) avec une zone
  « Tester » (texte d'essai → correspond / ne correspond pas), qui passe par le
  moteur partagé via IPC. L'édition d'une règle de dépôt depuis le Deck écrit
  le fichier du dépôt, ce qui change son hash : ré-approbation implicite par
  l'opérateur au moment de l'enregistrement.
- Canaux IPC (chaîne `add-deck-view`) : `rules:list`, `rules:setEnabled`,
  `rules:saveGlobal`, `rules:saveRepo`, `rules:approveRepo`, `rules:test`.
  - Tout argument `projectDir` est revalidé côté main contre l'ensemble des
    répertoires de travail autorisés (`requireWorkDir`, entrée hostile n°3).
  - Proposition de tier : les canaux qui modifient un garde-fou
    (`setEnabled`, `save*`, `approveRepo`) ne sont pas joignables par le
    companion.
- Visuel : `DESIGN.md` + skill `deck-design` ; aucun contrôle natif, aucun
  emoji. Clés i18n dans toutes les locales (parité).
- Toggles des règles Kory : liste `ttsrDisabled: string[]` dans la config
  globale, pour qu'une règle Kory ajoutée plus tard soit active par défaut.
  Toggles des règles globales et de dépôt : `ttsrEnabled`, clés préfixées par
  la source.

## 5. Le CLI `kory-rules`

`desktop/cli/kory-rules.ts`, compilé en `deck-plugin/bin/kory-rules.mjs`
(nouvelle cible dans le script de build). Il s'exécute dans la session de
l'agent, avec `bun`, sur le fichier du dépôt courant par défaut.

| Commande | Effet | Code de sortie |
|---|---|---|
| `check [fichier]` | valide le format (règles ci-dessous) ; liste toutes les erreurs, pas seulement la première | 0 si valide, 1 sinon |
| `list` | règles du fichier + statut lu dans `$CLAUDE_PEERS_TTSR_FILE` : `active`, `en attente d'approbation`, `désactivée` | 0 |
| `test <id> --text "…"` / `--file <chemin>` | simule l'entrée d'outil et affiche correspond / ne correspond pas | 0 si le résultat attendu (`--expect match\|none`) est obtenu, 1 sinon |
| `scan <id>` | compte les correspondances dans `git ls-files` restreint aux `paths` de la règle | 0 ; avertissement si une règle `deny` sur `Write` touche du code existant |

Règles de validation (`parseRulesFile`, partagé) :

- `version === 1` ; `rules` est un tableau de 50 éléments au plus ; fichier de
  64 Kio au plus ;
- `id` kebab-case et unique ; énumérations `event`, `tools`, `field` et `mode`
  respectées ; `field` compatible avec les outils et l'événement ; pas de
  `deny` en `PostToolUse` ;
- `pattern` compile avec les flags donnés ;
- **rejet d'un motif qui correspond à la chaîne vide** : une règle `deny` qui
  correspond à tout bloquerait l'agent sur chaque appel ;
- rejet heuristique des quantificateurs imbriqués (`(a+)+`, `(\w*)*`). Ce
  n'est pas une garantie contre le ReDoS : le moteur de regex JS n'a pas de
  délai d'exécution, le plafond de taille (§4.3) et le `timeout` du hook
  bornent le reste ;
- `paths` : globs relatifs, sans `..`, sans racine absolue ;
- `message` non vide, 400 caractères au plus ;
- champ inconnu = erreur.

Pas de commande `add` : l'agent édite le JSON avec Edit, puis lance `check`. Un
`add` à drapeaux serait plus long à écrire que l'édition elle-même.

## 6. La skill `repo-rules`

`desktop/deck-plugin/skills/repo-rules/SKILL.md`. Livrée dans le plugin
embarqué : présente dans les seules sessions Kory, projetée en sandbox avec le
reste du plugin (§8).

Frontmatter :

```yaml
---
name: repo-rules
description: Add or change a repo-specific guard rule (.claude/claude-peers/rules.json) that blocks or warns on a tool call matching a regex. Use when the same mechanical mistake recurs in this repo, or when the operator asks for a rule. Not for judgment rules.
allowed-tools: Bash(bun "${CLAUDE_PLUGIN_ROOT}/bin/kory-rules.mjs" *)
---
```

La description reste courte : c'est le seul coût payé à chaque tour. C'est
aussi ce qui informe l'agent que le mécanisme existe. Pas de ligne
`SessionStart`, pas d'outil MCP.

Contenu du corps :

1. **Quand créer une règle** : erreur mécanique récurrente, détectable sur
   l'entrée d'un outil. Contre-exemples : les règles de jugement (elles restent
   dans CLAUDE.md).
2. **Format** : le §3 en condensé, plus un exemple complet.
3. **Marche à suivre** : éditer le fichier, `check`, `test --expect match` sur
   un cas positif et `--expect none` sur un cas négatif, `scan`, puis
   **prévenir l'opérateur** qu'une approbation l'attend dans Réglages › Règles.
   La règle est inactive tant qu'elle n'est pas approuvée ; ne pas le présenter
   comme fait.
4. **Interdits** :
   - ne jamais désactiver, supprimer ou élargir une règle existante sans
     demande de l'opérateur ;
   - pas de `deny` sur `Write` pour un motif déjà présent dans le code
     (`scan` le montre) ;
   - pas de règle de jugement ;
   - un `message` impératif, qui donne le remède, pas seulement l'interdit.

Le chemin `${CLAUDE_PLUGIN_ROOT}` est substitué dans le contenu d'une skill de
plugin et dans `allowed-tools` (doc Skills de Claude Code, vérifiée le
2026-09-25) : le CLI s'exécute sans invite de permission.

## 7. Phases

Chaque phase est livrable seule.

| Phase | Contenu | Sortie visible |
|---|---|---|
| **P0 : sondes** | (a) latence d'un hook bun par appel d'outil sur la machine cible ; (b) `additionalContext` sans décision en `PreToolUse` dans la version de Claude Code visée ; (c) livraison d'un fichier en sandbox (§8) ; (d) cohabitation avec les hooks AiDex de l'opérateur | mesures notées dans le corps du commit P1 |
| **P1 : noyau** | `ttsr-rules.ts` (validateur, extraction, moteur, hash) + `ttsr-builtin.ts` + tests | aucune |
| **P2 : hook** | `ttsr-hook.ts`, entrées `hooks.json`, cible de build, compilation du fichier effectif par tuile, env `CLAUDE_PEERS_TTSR_FILE`, `ttsrDisabled` dans la config | règles Kory actives |
| **P3 : CLI + skill** | `kory-rules` (`check`, `list`, `test`, `scan`), skill `repo-rules`, jeu d'essai §2.2 | un agent peut rédiger une règle (inactive) |
| **P4 : approbation** | store des approbations, watcher sur le `rules.json` du dépôt, recompilation | les règles de dépôt approuvées s'appliquent |
| **P5 : Réglages** | catégorie « Règles », tableau, modale Voir/Éditer + Tester, IPC, i18n | gestion complète depuis le Deck |
| **P6 : sandbox** | fichier effectif livré dans le conteneur et rafraîchi (§8) | parité host/sandbox |

Avant P5, l'opérateur approuve par un moyen minimal (dialogue au démarrage de
la tuile, sur le modèle de `launch-approval.ts`) pour que P4 soit utilisable
sans UI dédiée.

## 8. Points ouverts

1. **Sandbox.** Le plugin est copié dans le conteneur (`sandbox-service.ts`),
   mais le fichier effectif vit dans `userData` côté host. Il faut reprendre le
   mécanisme qui rend `CLAUDE_PEERS_APPROVAL_FILE` (`approval-runtime.ts`)
   utilisable dans une session sandbox, et le rafraîchissement à chaud
   (entrée hostile n°5 : copier, jamais monter). Non instruit dans ce lot.
2. **Superviseur** : règles Kory seules, ou aucune (§4.2).
3. **Latence** : un processus bun par appel d'outil ciblé. Aucune mesure
   disponible ; P0 tranche. Si c'est trop lent : une seule entrée `hooks.json`
   par événement (déjà le cas), et une sortie la plus précoce possible quand le
   fichier effectif est vide.
4. **Répétition des `warn`** : une règle `warn` se redéclenche à chaque appel
   correspondant, et coûte à chaque fois. Option v2 : `repeat: "once"` par
   session, avec un petit état dans le répertoire de la tuile.
5. **Faux positifs de `Write`** : une réécriture complète teste tout le
   fichier, code existant compris. Mitigation : `scan` dans la skill, et les
   règles `warn` ciblent de préférence `Edit`.

## 9. Tests (voir `TESTING.md`)

- **Validateur** : un cas par règle de rejet du §5, dont le motif qui
  correspond à la chaîne vide, le champ inconnu, l'id dupliqué et le `deny` en
  `PostToolUse`.
- **Moteur** : des fixtures de payload par outil (même logique que
  `tests/fixtures/roadmap-guard/`), dont MultiEdit à plusieurs éditions et le
  filtre `paths`.
- **Garantie « warn n'émet jamais allow »** : une assertion dont le message
  nomme l'invite de permission qu'elle protège.
- **Chemins** : filtre `paths` sous un préfixe symlinké construit par le test
  (section « Cross-platform tests »).
- **Approbations** : deux worktrees du même `project_key` avec deux hashes, les
  deux restent approuvés ; une modification du fichier le remet en attente ; un
  fichier invalide n'expose aucune règle.
- **Plugin** : un test qui vérifie que le chemin du CLI cité par la skill
  existe dans la sortie du build, sur le modèle de
  `tests/desktop-deck-plugin-agent-refs.test.ts`.
- **Locales** : parité des nouvelles clés i18n.

## 10. Hors périmètre

- Règles jugées par un modèle (`question` chez omp) et règles sur arbre
  syntaxique (`astCondition`).
- Interruption du flux de génération (impossible depuis les hooks de Claude
  Code).
- Règles de dépôt appliquées sans approbation, quelle que soit l'option.
- Outil MCP de gestion des règles : son coût par tour n'est pas justifié pour
  un usage aussi ponctuel.
