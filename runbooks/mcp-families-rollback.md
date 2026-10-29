# Runbook : retour arrière du découpage MCP en familles (lot P5a)

## Objet

Le lot P5a retire l'ancien chemin : `claude-peers` ne sert plus aucun outil
`roadmap_*`, `send_message('operator')` est refusé avant transport pour tous,
`server-deck.ts` ne sert plus que la famille `kory-operator`, le garde de la
feuille de route et `hooks.json` ne connaissent plus que le préfixe
`mcp__kory-roadmap__`. Aucun pair ne peut retomber sur l'ancien chemin : si le
déploiement échoue en usage réel, on ne répare pas un morceau, on remet **toutes**
les surfaces ci-dessous dans leur état d'avant, dans l'ordre donné.

Aucune donnée n'est migrée par ce lot (la feuille de route et ses lignes sont
lues par les deux chemins) : le retour arrière ne restaure aucune base.

## Les surfaces à remettre

| Surface | Où elle vit | Ce que le retrait y change |
|---|---|---|
| Binaires broker, CLI, serveur MCP | clone `C:/Users/Olivier/workspace/koryphaios-mcp` (celui que désigne `mcpServers["claude-peers"].args` de `~/.claude.json`) | `server.ts`, `server-deck.ts`, `server-roadmap.ts` et `shared/` changent de révision ; `broker.ts` et `cli.ts` sont lancés depuis ce même clone |
| Entrées MCP utilisateur | `~/.claude.json`, clé `mcpServers` | entrée `kory-roadmap` ajoutée ; entrée `claude-peers` avec un éventuel `CLAUDE_PEERS_TOOLS` |
| Volume d'auth du sandbox | volume Docker `kory-claude-auth` (`SANDBOX_AUTH_VOLUME`, `desktop/src/main/sandbox-command.ts`), monté sur `~/.claude` de chaque conteneur `kory-sbx-*` | entrées MCP utilisateur propres aux conteneurs (`desktop/docs/sandbox.md`) : `claude-peers` (avant ce lot avec `CLAUDE_PEERS_TOOLS`) et `kory-roadmap` vers `<CORE>/server-roadmap.ts`, fichier absent de `0df397d` |
| Profils d'agents | `C:/Users/Olivier/.claude/claude-config/agents/*.md`, ceux listés dans l'en-tête du patch `C:/Users/Olivier/.agent-forge/scratch/mcp-families/global-agent-roadmap-mcp.patch` | `mcp__claude-peers__roadmap_*` remplacé par `mcp__kory-roadmap__roadmap_*` dans `tools:` |
| Deck packagé | installateur ou `win-unpacked` construit depuis `desktop/` | bundles `deck-plugin/mcp/*.mjs`, `deck-plugin/hooks/*.mjs`, `deck-plugin/hooks/hooks.json` embarqués par `extraResources` (`desktop/electron-builder.yml`) |
| deck-plugin installé | `<resources>/deck-plugin` d'un Deck packagé, `desktop/deck-plugin` d'un Deck lancé depuis les sources (`deckPluginDirFor`, `desktop/src/main/session-command.ts`) | `roadmap-guard-hook.mjs` et `hooks.json` : préfixe `claude-peers` retiré |
| Broker local du Deck | processus détaché, réutilisé tant qu'il répond sur `/health` | ne prend le code du clone qu'après arrêt et relance |
| Broker distant (`broker_url`) ou amont d'une réplique (`offline_replica`) | autre machine ou conteneur, mis à jour séparément (`runbooks/broker-db-migration.md`) | rien : P5a ne modifie ni `broker.ts` ni `cli.ts` (voir l'étape 5) |

Fait mesuré le jour de la rédaction : `git worktree list` ne dit pas la vérité
sur le clone `koryphaios-mcp` (il y figure en `8029eb1` alors que
`git -C C:/Users/Olivier/workspace/koryphaios-mcp rev-parse HEAD` rend `0df397d075c407e8498f688236c5249394ee5512`).
C'est un clone indépendant : seule la commande `git -C <clone> rev-parse HEAD`
fait foi.

## Avant le déploiement : la fiche à remplir

Sans cette fiche le retour arrière n'est pas exécutable. À remplir avant de
toucher à quoi que ce soit, à garder **hors de tout dépôt git** :

```bash
M=/c/Users/Olivier/workspace/koryphaios-mcp
git -C $M rev-parse HEAD                       # REV_AVANT, révision du clone avant déploiement
jq '.mcpServers["claude-peers"]' ~/.claude.json  # entrée claude-peers à restaurer telle quelle
jq -r '.mcpServers | keys[]' ~/.claude.json      # clés présentes (kory-roadmap doit être absente)
C=$(docker ps --filter name=kory-sbx --format '{{.Names}}' | head -1)   # un conteneur suffit : le volume d'auth est partagé
docker exec "$C" claude mcp get claude-peers   # entrée du conteneur : Scope, commande, Environment
docker exec "$C" claude mcp get kory-roadmap   # doit ne rien trouver avant le déploiement
```

Sans conteneur en marche, en démarrer un depuis le Deck avant de relever la partie
sandbox de la fiche. Noter aussi le chemin `<CORE>` de l'entrée `claude-peers` du
conteneur, sa forme (image qui embarque le dépôt, ou copie montée en `:ro`, jamais le
checkout de l'hôte, voir `desktop/docs/sandbox.md`) et sa révision :

```bash
git -C <copie côté hôte> rev-parse HEAD                                  # copie montée en :ro : REV_CORE_AVANT
docker inspect --format '{{.Config.Image}}' "$C"                         # image qui embarque le dépôt : son tag
docker image inspect --format '{{.Id}} {{.RepoTags}}' <tag ci-dessus>   # et son identifiant
```

À noter aussi : la version et l'emplacement du Deck packagé en service
(installateur `Koryphaios Setup <version>.exe` ou dossier `win-unpacked`), copiés
hors de `desktop/dist` (le builder vide ce dossier, voir
`.claude/rules/electron-packaging.md`).

Si la machine passe par un broker distant ou par une réplique, relever aussi le mode
(`broker_url` et `offline_replica` du fichier de configuration partagé, voir le README)
et la révision déployée de ce broker distant (`git -C <dépôt du broker> rev-parse HEAD`
sur sa machine), pour pouvoir montrer qu'elle n'a pas bougé.

État relevé le 2026-10-29, avant tout déploiement de ce lot : le clone est à
`0df397d075c407e8498f688236c5249394ee5512` ; l'entrée `claude-peers` a pour
commande `bun`, pour argument `C:\Users\Olivier\workspace\koryphaios-mcp\server.ts`
et pour seule variable d'environnement `CLAUDE_PEERS_GROUP` (donc pas de
`CLAUDE_PEERS_TOOLS`) ; aucune clé `kory-roadmap`. Le volume d'auth du sandbox n'a
pas été relevé ce jour-là (aucun conteneur interrogé) : à relever avec la fiche.

## Ordre du retour arrière

Chaque étape se termine, et son contrôle passe, avant la suivante.

### Étape 0 : fermer les sessions

Fermer toutes les tuiles Kory et toutes les sessions Claude Code qui chargent
`claude-peers` ou `kory-roadmap`.

Raison : une session ancienne n'est pas migrée par la modification d'un fichier
sur disque. Son processus MCP garde son code et sa liste d'outils, et les étapes
suivantes laisseraient un état mixte pendant qu'elle tourne.

Contrôle : le Deck n'affiche plus de tuile ouverte ; aucun processus `bun`
lancé sur `server.ts` ou `server-roadmap.ts` n'est connu de la session qui
déroule ce runbook.

Les conteneurs du sandbox s'arrêtent avec leurs tuiles : l'étape 2 bis a besoin d'un
conteneur en marche. Le vérifier ici (`$C` se recalcule à chaque étape qui l'emploie,
chaque appel Bash repart d'un shell neuf) :

```bash
C=$(docker ps --filter name=kory-sbx --format '{{.Names}}' | head -1)
[ -n "$C" ] || echo 'démarrer un conteneur depuis la vue Docker'
```

### Étape 1 : les binaires broker, CLI et serveur (le clone)

```bash
M=/c/Users/Olivier/workspace/koryphaios-mcp
git -C $M status --short
git -C $M fetch --all --prune
git -C $M checkout --detach <REV_AVANT>
git -C $M rev-parse HEAD
```

Le `fetch` passe **avant** le `checkout` : la révision de la fiche peut ne pas
être connue du clone. `status --short` ne doit montrer aucune modification de
fichier suivi (des fichiers non suivis, comme les notes de `docs/`, ne gênent
pas le `checkout`).

Contrôles :

1. `git -C $M rev-parse HEAD` rend exactement `REV_AVANT`.
2. `bun build --target=bun $M/broker.ts $M/server.ts $M/cli.ts --outdir=<scratch>`
   écrit `Bundled N modules` sans erreur.
3. `grep -c 'case "roadmap_list"' $M/server.ts` rend au moins 1 : l'ancien
   `server.ts` sert de nouveau la feuille de route.

### Étape 2 : les entrées MCP de `~/.claude.json`

Le lecteur de configuration est `claude mcp`. Remettre `claude-peers` comme
dans la fiche et retirer `kory-roadmap` :

```bash
claude mcp get claude-peers
claude mcp remove kory-roadmap --scope user
claude mcp remove claude-peers --scope user
claude mcp add --scope user --transport stdio claude-peers -e CLAUDE_PEERS_GROUP=<valeur de la fiche> -- bun 'C:\Users\Olivier\workspace\koryphaios-mcp\server.ts'
```

Le chemin Windows est entre guillemets simples : sans eux Git Bash retire les
antislashes et l'entrée stocke un chemin cassé (mesuré en revue).

La première commande note le `Scope:` de l'entrée en place ; si ce n'est pas
`User config`, retirer l'entrée dans **ce** scope (`--scope local` ou
`--scope project`). `claude mcp add` ne remplace jamais une clé existante : le
`remove` précède toujours le `add`. Reporter dans le `add` chaque `-e` de la
fiche, et seulement ceux-là : si le déploiement avait posé `CLAUDE_PEERS_TOOLS`
et que la fiche n'en porte pas, il ne revient pas.

Contrôles :

1. `claude mcp get claude-peers` : `Scope: User config`, argument se terminant par
   `koryphaios-mcp\server.ts`, `Environment:` identique à la fiche (sans
   `CLAUDE_PEERS_TOOLS` si la fiche n'en avait pas).
2. `claude mcp get kory-roadmap` ne trouve aucun serveur.
3. `jq -r '.mcpServers | keys[]' ~/.claude.json` ne liste pas `kory-roadmap`.

### Étape 2 bis : le volume d'auth du sandbox

Les entrées MCP utilisateur des conteneurs vivent sur le volume `kory-claude-auth`,
partagé par tous les conteneurs : on les remet depuis un seul conteneur en marche,
avec la même démarche que l'étape 2, dans le conteneur. `MSYS_NO_PATHCONV=1`
empêche Git Bash de réécrire les chemins POSIX passés à `docker exec`.

`<CORE>` est un artefact distinct du clone de l'étape 1 : `desktop/docs/sandbox.md`
impose une image qui embarque le dépôt ou une copie montée en `:ro`, jamais le
checkout de l'hôte, donc l'étape 1 ne le restaure pas. Le remettre d'abord à la
révision de la fiche, selon sa forme :

- copie montée en `:ro` (commandes côté hôte, sur le dossier source du montage) :

  ```bash
  git -C <copie côté hôte> fetch --all --prune
  git -C <copie côté hôte> checkout --detach <REV_CORE_AVANT>
  git -C <copie côté hôte> rev-parse HEAD
  ```

  puis refaire `bun install` dans la copie si `package.json` ou `bun.lock` diffèrent
  entre les deux révisions (la copie doit avoir `bun install` fait) ;
- image qui embarque le dépôt : reconstruire l'image depuis `REV_AVANT` sous le tag de
  la fiche, puis reconstruire le conteneur depuis la vue Docker (le conteneur en marche
  garde l'ancienne image) :

  ```bash
  git -C <contexte de build> checkout --detach <REV_AVANT>
  docker build -t <tag de la fiche> <contexte de build>
  ```

Recalculer `$C` après une reconstruction de conteneur. Puis remettre les entrées MCP :

```bash
C=$(docker ps --filter name=kory-sbx --format '{{.Names}}' | head -1)
MSYS_NO_PATHCONV=1 docker exec "$C" claude mcp remove kory-roadmap --scope user
MSYS_NO_PATHCONV=1 docker exec "$C" claude mcp remove claude-peers --scope user
MSYS_NO_PATHCONV=1 docker exec "$C" claude mcp add --scope user --transport stdio claude-peers <les -e de la fiche> -- bun '<CORE de la fiche>/server.ts'
```

Ne reporter dans le `add` que les `-e` relevés dans la fiche (donc
`CLAUDE_PEERS_TOOLS` seulement si la fiche en portait un).

Contrôles :

1. `docker exec "$C" claude mcp get claude-peers` : `Scope: User config`, commande et
   `Environment:` identiques à la fiche.
2. `docker exec "$C" claude mcp get kory-roadmap` ne trouve aucun serveur ; le badge
   **Roadmap server** de la vue Docker redevient non vert (il n'est vert que pour une
   entrée utilisateur `kory-roadmap`).
3. `MSYS_NO_PATHCONV=1 docker exec "$C" grep -c 'case "roadmap_list"' '<CORE>/server.ts'`
   rend au moins 1 : le `server.ts` du conteneur est celui d'avant le lot. Avec celui du
   lot P5a la commande rend 0 (ce `server.ts` ne contient plus ce `case`).

### Étape 3 : les profils d'agents

Remettre le préfixe `mcp__claude-peers__roadmap_` dans les profils que le patch
a modifiés. Ne pas utiliser `git apply -R` : il ne s'applique dans aucun des deux sens sur
les profils (mesuré, `patch does not apply` sur chaque fichier ; le patch est en
CRLF). Ne pas utiliser `sed -i` sans `-b` : il réécrit en LF les profils qui sont
en CRLF (mesuré sur des copies : plusieurs fichiers différaient après
l'aller-retour). La substitution suivante est exacte octet pour octet (aller-retour
mesuré sur des copies de tous les profils du patch, `cmp` identique pour chacun) :

```bash
P=/c/Users/Olivier/.agent-forge/scratch/mcp-families/global-agent-roadmap-mcp.patch
L=$(mktemp)
awk '/^\+\+\+ /{print $2}' $P | tr -d '\r' | tr '\134' '/' | sed 's|^C:|/c|' > $L
while read -r f; do sed -b -i 's/mcp__kory-roadmap__roadmap_/mcp__claude-peers__roadmap_/g' "$f"; done < $L
```

Contrôles :

1. `wc -l < $L` rend le nombre de fichiers de l'en-tête du patch, et
   `xargs grep -l 'mcp__claude-peers__roadmap_' < $L | wc -l` rend le même nombre.
2. `xargs grep -l 'mcp__kory-roadmap__' < $L` ne rend rien.
3. `grep -l 'mcp__kory-roadmap__' /c/Users/Olivier/.claude/claude-config/agents/*.md`
   ne rend rien. Un fichier qui apparaît ici est un profil créé ou édité après le
   déploiement : il a été converti par la substitution, le relire.

### Étape 4 : le Deck packagé et le deck-plugin installé

Reconstruire depuis `REV_AVANT`, dans un checkout dédié et jamais dans le
checkout partagé :

```bash
git -C /c/Users/Olivier/workspace/koryphaios worktree add --detach <dir> <REV_AVANT>
npm --prefix <dir>/desktop run build
```

(`node_modules` de `<dir>` et de `<dir>/desktop` par jonction vers le checkout
principal.) `npm run build` enchaîne `build:hook`, `build:cli`, `build:mcp` et
`build:design` : il reproduit `roadmap-guard-hook.mjs` et les bundles
`kory-operator` / `kory-deck` de l'ancienne révision. Pour un Deck packagé,
fabriquer l'installateur ou `win-unpacked` dans un dossier de sortie à part
(`electron-builder --dir --publish=never -c.directories.output=<scratch> -c.npmRebuild=false`),
quitter le Deck, puis remettre en place l'installation conservée dans la fiche ou
le résultat de cette construction. Pour un Deck lancé depuis les sources, le
`npm run build` ci-dessus dans le checkout qui le lance suffit.

Relancer le Deck SANS restaurer de workspace : une tuile restaurée démarre ses MCP
sur le broker encore en place, avant sa relance à l'étape 5. Si un workspace s'est
restauré, fermer ses tuiles avant l'étape 5.

Contrôles, sur le `deck-plugin` réellement chargé par le Deck relancé :

1. `hooks.json` : `grep -c 'mcp__claude-peers__roadmap_add' <deck-plugin>/hooks/hooks.json`
   rend au moins 1 (l'ancien matcher est revenu).
2. Le garde reconstruit refuse un accident de sérialisation sous l'ancien préfixe :

   ```bash
   printf '%s' '{"hook_event_name":"PreToolUse","tool_name":"mcp__claude-peers__roadmap_add","tool_input":{"title":"t","description":"</description>\n<parameter name=\"rationale\">x"}}' | bun <deck-plugin>/hooks/roadmap-guard-hook.mjs
   ```

   La sortie contient `"permissionDecision":"deny"`. Une sortie vide veut dire que
   le `.mjs` en place vient encore du lot P5a.

### Étape 5 : le broker local

Arrêter puis relancer le broker local du Deck : détaché et réutilisé, il garde le
code qu'il a chargé tant qu'il n'est pas arrêté (bouton Stop/Start du bandeau
broker du Deck ; à défaut tuer le processus **par le PID** du port d'écoute du
broker, jamais par nom d'image). Le broker se relance depuis le clone de l'étape 1
(`locateBrokerScript`, `desktop/src/main/broker-spawn.ts`, dérive `broker.ts` de
l'entrée `claude-peers`).

Contrôle : `/health` du broker répond ; le clone n'a pas bougé
(`git -C $M rev-parse HEAD` rend encore `REV_AVANT`).

Mesuré le jour de la rédaction : `git diff --stat 0df397d 49daf69 -- broker.ts cli.ts`
ne rend rien. `broker.ts` et `cli.ts` ne changent donc pas sur la série P1 à P4,
mais ils importent `shared/`, qui change (`config.ts`, `peer-cache.ts`) : la
relance du broker depuis le même clone n'est pas facultative.

**Broker distant ou amont d'une réplique : à laisser tel quel.** Mesuré le jour de la
rédaction, `git diff --stat 0df397d -- broker.ts cli.ts` ne rend rien sur l'arbre de
P5a : ces deux fichiers sont identiques à ceux de `0df397d`, et ce lot n'ajoute ni
route ni table au broker. Les clients du lot P5a et ceux d'avant parlent donc au même
broker par les mêmes routes (déduit des fichiers identiques, non rejoué contre un
broker distant) : le retour arrière ne redéploie rien là-bas et la révision relevée
dans la fiche doit être inchangée. Seul le broker local du Deck, qui est la réplique
quand `offline_replica` est actif, est relancé par cette étape. `shared/config.ts`
et `shared/peer-cache.ts` diffèrent entre les deux révisions et sont importés côté
client et côté broker local : un broker distant qui ne reçoit jamais ce code ne les
exécute pas.

### Étape 6 : recréer les sessions

Relancer les sessions Kory et les sessions Claude Code hors Kory : ce sont de
nouveaux processus MCP qui chargent l'ancien `server.ts`. Les workspaces
sauvegardés se restaurent normalement.

## Vérification finale

1. Depuis une session relancée hors Kory : `mcp__claude-peers__roadmap_list`
   répond (l'ancien chemin est de retour) et `list_peers` aussi.
2. Depuis une tuile worker relancée : `send_message` vers `operator` est accepté
   et le message arrive dans l'Inbox du Deck.
3. Depuis une tuile lead relancée : `ask_operator` arrive dans l'Inbox.
4. Une carte écrite par `roadmap_add` sous l'ancien préfixe est visible par
   `roadmap_list` : la feuille de route n'a pas bougé.

## Si le retour arrière est partiel

Symptômes attendus (déduits du code, non rejoués) :

- Entrées de `~/.claude.json` restaurées, profils non restaurés : les agents
  nomment `mcp__kory-roadmap__roadmap_*`, serveur absent, donc aucune carte
  accessible.
- Profils restaurés, `~/.claude.json` non restauré : les agents nomment
  `mcp__claude-peers__roadmap_*`, que le `server.ts` du lot P5a ne sert plus.
- Volume d'auth du sandbox non restauré : un agent en conteneur garde `kory-roadmap`
  vers un `server-roadmap.ts` que la copie d'avant n'a pas.
- Clone restauré, broker non relancé : le broker garde le code chargé avant
  l'arrêt.
- Deck non reconstruit : `hooks.json` n'accepte que `mcp__kory-roadmap__`, le
  garde ne se déclenche pas sur l'ancien préfixe.
