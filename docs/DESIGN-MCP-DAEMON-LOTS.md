# Daemon MCP partagé : plan de réalisation par lots

Contrat : carte `7bd455f6` (daemon unique et relais Rust), carte `1dc74e6c` (reprise d'un pair par token au broker). Repli : carte `f4080f27` (bundle de `server.ts`). Carte archivée et remplacée : `4b3ece0a` (kory-roadmap en HTTP).

Ce document prescrit l'ordre du travail et les critères de sortie de chaque lot. Il ne déclare aucun lot réalisé : l'avancement se lit sur les cartes, et l'historique d'un lot livré dans le corps de son commit (`git log --all --grep "Card 7bd455f6"`). Les chemins dits nouveaux sont des cibles, pas des fichiers existants.

## Objectif

Chaque session Claude Code lance aujourd'hui deux processus bun : `server.ts` (claude-peers) et `server-roadmap.ts` (kory-roadmap). Un bun vide coûte déjà environ 90 Mo de mémoire résidente sous Windows, et chacun de ces serveurs entre 160 et 250 Mo (mesuré le 2026-11-06, 13 sessions, environ 4,7 Go au total). Cible : un seul daemon bun par utilisateur OS (un par racine de code si deux clones servent des sessions en même temps), et par session deux relais Rust de quelques Mo.

## Décisions de l'opérateur (2026-11-06)

1. **Un daemon local dédié**, pas une route Streamable HTTP sur le broker. En mode `remote`, le broker tourne sur une autre machine et ne lit pas les snapshots de session sous `~/.claude/peers`. Le daemon couvre les modes `local`, `replica` et `remote`.
2. **Un seul daemon pour les deux familles MCP.** claude-peers et kory-roadmap restent deux noms de serveur distincts dans la config de Claude Code : le découpage de `docs/DESIGN-MCP-FAMILIES.md` est conservé au niveau des noms, pas des processus. Le broker est déjà un point de panne commun aux deux familles ; la vraie contrainte est la reprise.
3. **Les deux familles passent par le même relais stdio** (`--family peers|roadmap`). Le transport HTTP avec `headersHelper` est écarté : il dépend d'un héritage d'environnement non documenté, et la reconnexion HTTP de Claude Code n'a pas été mesurée.
4. **Relais en Rust.** La CI GitHub échoue souvent : Windows se compile en local, Linux avec `cargo-zigbuild`, macOS en CI. Si le binaire manque pour une plateforme, la config lance les serveurs bun actuels. Un échec de CI retarde le gain sans rien casser.
5. **Scénario obligatoire** : des tuiles Kory et des sessions hors Kory ouvertes en même temps sur la même machine.

## Faits mesurés (Claude Code 2.1.318, Windows)

- Un relais stdio vers TCP de 40 lignes (prototype Go) est transparent pour `server/discover`, `initialize`, `tools/list`, `tools/call` et pour le push `notifications/claude/channel`. Le push est visible seulement en session interactive : `claude -p` n'affiche aucune notification de channel, même sans relais.
- Le parent du relais est `claude.exe`. Le relais voit `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`, le cwd et les variables injectées par Kory (`CLAUDE_PEERS_FORCE_GROUP`, `CLAUDE_PEERS_DESK_SESSION`).
- Deux sessions simultanées, l'une avec l'environnement d'une tuile Kory et l'autre sans, arrivent au daemon comme deux connexions distinctes avec chacune son environnement.
- La bannière de Claude Code affiche « no MCP server configured with that name » pour un channel déclaré seulement par `--mcp-config`, alors que le push arrive. Ne pas prendre cet avertissement pour un échec.
- `bun --smol` ne réduit pas la mémoire. Un bundle minifié la réduit d'environ un quart.

Non mesuré : la relance par `/mcp` d'un serveur stdio en échec, le vrai état de `server.ts` dans un daemon, les conteneurs sandbox, le relais sous Linux et macOS.

## Architecture cible

```text
claude.exe (session A, Kory)      claude.exe (session B, hors Kory)
  |-- relay --family peers  --+     |-- relay --family peers  --+
  |-- relay --family roadmap -+     |-- relay --family roadmap -+
                              |                                 |
                              +---------> daemon (bun) <--------+
                                            |
                                   broker de chaque session
                              (local, replica ou remote)
```

- **Relais** (un par session et par famille) : lit l'environnement que `server.ts` lit aujourd'hui, l'envoie dans un message d'identité unique, puis copie le JSON-RPC MCP dans les deux sens. Cherche le daemon de sa racine de code parmi 10 ports candidats ; s'il est absent, le lance sous le nom `kory-mcp-daemon` après avoir pris un verrou de lancement. Arrête un daemon bloqué par son PID vérifié. Après une coupure : répond aux appels par une erreur explicite, relance le daemon, rejoue son `initialize` gardé en mémoire, présente son ticket de reprise, envoie `notifications/tools/list_changed` si besoin ; le daemon émet la notice de reconnexion.
- **Daemon** (bun, TypeScript, reprend `server.ts` et `shared/roadmap-mcp.ts`) : un état par connexion de relais. Il ne lit jamais sa propre config ou son propre environnement pour une session : un repli enregistrerait sans erreur une tuile Kory dans le groupe par défaut de l'utilisateur. Son port d'écoute sert de verrou d'instance : un daemon par port, le plus bas gagne, un daemon par utilisateur et par racine de code. Il ne dépend pas de Kory : quitter Kory ne l'arrête pas, et Kory ne le lance pas.
- **Vivacité** : le broker reçoit le PID du relais, jamais celui du daemon. Sinon `cleanStalePeers` voit toutes les sessions vivantes tant que le daemon tourne. En modes `local` et `replica`, un relais vivant garde le pair actif même sans heartbeat. Le daemon écrit le snapshot de session que vérifie la famille roadmap ; la génération prouvée est celle du relais.
- **Identité après un crash du daemon** : le relais garde en mémoire un ticket de reprise remis par le daemon et le présente au daemon suivant. Le broker reprend alors le pair par son `instance_token` (carte `1dc74e6c`). Sans cela, chaque session reçoit un `peer_id` suffixé, et deux tuiles dans le même dossier et le même groupe peuvent échanger leurs identités.

## Ordre des lots

```text
L0 conception
 |-- L1 relais Rust ----------+
 |                            +--> L2 daemon + famille roadmap  (premier gain)
 |-- L3 broker : reprise par token --+
                                     +--> L4 famille peers dans le daemon
                                                  |
                                     L5 build et distribution
                                                  |
                                     L6 validation
```

L1 et L3 sont indépendants et peuvent avancer dans deux sessions en parallèle. La famille roadmap passe en premier : elle n'a pas d'état par session, elle donne le premier gain et elle valide le relais avant la partie difficile.

### L0 : conception

**Entrée :** ce document et les cartes.

**Travail :**
1. Inventaire exhaustif de l'état global de `server.ts`, de `server-roadmap.ts` et de tous les modules du dépôt qu'ils importent : variables de module, lectures de `process.pid`, `process.cwd()`, `process.env`, gestionnaires `process.on`, `process.exit`, fichiers nommés par PID ou par session, timers, WebSocket, objets `Server` MCP, sorties de log. Chaque entrée reçoit un traitement : champ par session, global au daemon, fourni par le message d'identité, ou à supprimer.
2. Document de conception `docs/DESIGN-MCP-DAEMON.md` : protocole entre relais et daemon (format du message d'identité, ticket de reprise, versions), authentification du canal local (le secret de groupe le traverse), cycle de vie (démarrage, instance unique, arrêt, mise à jour du binaire du daemon avec des sessions ouvertes), comportement pendant une coupure, repli vers bun, sandbox.
3. ADR `docs/adr/008-shared-mcp-daemon.md` : les décisions ci-dessus et les options écartées (route `/mcp` sur le broker, HTTP avec `headersHelper`, deux daemons, Go, lancement par WMI, daemon lancé par Kory).
4. Relecture critique de la conception par un sous-agent `challenger`, avant tout code.

**Sortie :** conception validée par l'opérateur ; estimation de L4 révisée d'après l'inventaire.

### L1 : relais Rust

**Dépend de :** L0 (protocole figé).

**Travail :** crate `relay/` à la racine ; lecture de l'environnement, message d'identité avec `code_root`, copie bidirectionnelle, recherche sur les 10 ports candidats, verrou de lancement, démarrage du daemon s'il est absent (`CREATE_BREAKAWAY_FROM_JOB` avec retrait journalisé, image `kory-mcp-daemon` copiée de `bun.exe` sous Windows), arrêt d'un daemon bloqué par son PID vérifié, reconnexion avec rejeu d'`initialize` et du ticket, erreur explicite pendant la coupure, repli bun au démarrage avec fichier d'état, sortie propre sur EOF de stdin.

**Tests :** tests Rust contre un faux daemon : rejeu après coupure, N relais et un seul lancement, daemon absent au démarrage, candidats étrangers ou d'une autre racine sautés, daemon bloqué arrêté, PID réutilisé jamais arrêté. Liste complète : `docs/DESIGN-MCP-DAEMON.md` §12.

**Sortie :** binaire Windows ; mémoire résidente mesurée au repos.

### L2 : daemon avec la famille roadmap

**Dépend de :** L1.

**Travail :** point d'entrée du daemon ; serveur MCP par connexion ; famille roadmap branchée sur `shared/roadmap-mcp.ts` et `shared/roadmap-tools.ts` ; mêmes refus fermés qu'aujourd'hui (snapshot, `projectKey`, génération vivante de l'auteur, URL du broker) avec une génération d'auteur qui n'est plus forcément `server.ts`. Config globale de Claude Code et lancement des tuiles Kory : relais `--family roadmap`, repli vers `server-roadmap.ts` si le binaire manque. Parcours des candidats et règle « le plus bas gagne » côté daemon ; bornes des connexions non authentifiées ; arrêt sur inactivité qui ferme l'écoute avant la dernière vérification. Hors cœur, dans ce lot : `BREAKAWAY_OK` (limites `0x2800`) dans `JOB_PREAMBLE_PS` (`desktop/src/main/shell-command.ts`), et `desktop/src/main/broker-spawn.ts` qui lance le broker avec `bun` quand l'entrée MCP est le relais. Broker lancé détaché par le daemon.

**Mesures :** un second `listen` du même utilisateur sur le même port échoue sous Windows ; un enfant bun non détaché meurt-il avec son parent, et `detached` ouvre-t-il une fenêtre ; un daemon lancé depuis une tuile Kory survit à la fermeture de cette tuile.

**Tests :** fichier qui démarre un seul daemon dans `beforeAll` : deux sessions de projets différents, une session Kory et une hors Kory, une session sans snapshot refusée avant tout trafic, daemon en double sur un port plus haut qui sort. Tests existants étendus : `desktop-broker-spawn`, `desktop-launch`.

**Sortie :** zéro processus `server-roadmap.ts` pour les sessions ouvertes ; les six outils `roadmap_*` se comportent comme avant. **Premier gain mesurable.**

### L3 : broker, reprise par token

**Dépend de :** L0. Carte `1dc74e6c`.

**Travail :** variante de `/register` qui reprend un pair par l'`instance_token` présenté, vérifié contre le PID enregistré (et sa génération quand elle existe) et le groupe, sans autre preuve, y compris hors Kory. Époque de dépôt et snapshot conservés si même PID de relais et même condensat de capability. Règle V : en `local` et `replica`, un PID de relais vivant garde le pair actif sans heartbeat. Règle S : la résurrection par `session_key` refuse une ligne dormante dont le PID est vivant. Version annoncée dans `/health`. Contrat complet : `docs/DESIGN-MCP-DAEMON.md` §8.4.

**Tests :** un broker démarré une fois : deux pairs avec le même host, le même cwd et le même groupe se réenregistrent par token après un redémarrage simulé du daemon, chacun retrouve son `peer_id` sans suffixe ; un token faux, un PID mort ou une génération différente est refusé ; une ligne dormante au PID vivant n'est pas ressuscitée par `session_key` ; un pair au PID vivant sans heartbeat reste actif ; le chemin actuel par `session_key` ne change pas pour un PID mort.

### L4 : famille peers dans le daemon

**Dépend de :** L2 et L3.

**Travail :** rendre multi-session l'état de `server.ts` d'après l'inventaire de L0 ; une WebSocket vers le broker par session ; enregistrement avec le PID du relais ; push de channel vers la bonne connexion ; ticket de reprise. Les tuiles sandbox gardent `server.ts` dans ce lot.

**Risque principal :** un état de module oublié devient un mélange silencieux entre sessions. Chaque élément de l'inventaire a un test ou une raison écrite.

**Tests :** daemon partagé : deux sessions dans le même groupe s'envoient des messages ; deux tuiles dans le même dossier gardent leur identité après un crash du daemon ; une tuile Kory n'entre jamais dans le groupe par défaut.

### L5 : build et distribution

**Dépend de :** L1. Peut commencer dès que le relais est stable.

**Travail :** build Windows local, Linux avec `cargo-zigbuild`, macOS en CI ; binaires dans le paquet npm `koryphaios` ; détection de plateforme et repli vers bun ; build du relais à chaque release, pas à chaque commit.

**Mesure :** sous Linux et macOS, un lien symbolique `kory-mcp-daemon` vers `bun` donne bien ce nom au processus dans `ps` et `top`.

### L6 : validation

**Dépend de :** L4 et L5.

**Matrice :** sessions Kory et hors Kory ensemble ; fermeture de la tuile Kory qui a lancé le daemon ; coupure du daemon de plus de 120 s sans perte de dépôt de contexte en `local` ; crash du daemon pendant que des messages circulent ; deux tuiles dans le même dossier ; modes `local`, `replica` et `remote` ; sandbox sur le repli ; mémoire mesurée avant et après dans le corps du commit ; test interactif du push de channel.

**Bascule (décision de l'opérateur, 2026-11-06).** Jusqu'à la fin de L6, les sessions de travail du poste de développement restent sur les serveurs bun, servis par le clone `koryphaios-mcp`. Seules des sessions de test utilisent le relais, par `--mcp-config` et `--strict-mcp-config`. Une fois la version stable validée, on déploie le broker et `koryphaios-mcp`, puis on passe la configuration MCP globale au relais.

## Estimation (2026-11-06)

| Lot | Durée |
| --- | --- |
| L0 | 0,5 à 1 jour |
| L1 | 1,5 à 2 jours (candidats, verrou de lancement, daemon bloqué, nom de processus) |
| L2 | 2 à 2,5 jours (job des tuiles, `broker-spawn.ts`, broker détaché) |
| L3 | 1 à 1,5 jour (règles V et S) |
| L4 | 3,5 à 4,5 jours, révisé après l'inventaire de L0 |
| L5 | 1 jour, plus les aléas de la CI |
| L6 | 1 jour |
| **Total** | **10,5 à 13,5 jours** |

Révision après L0 : estimation, pas mesure.

Le premier gain, environ la moitié de la mémoire, arrive après L2.

## Reprendre le chantier dans une nouvelle session

1. Lire la carte `7bd455f6` (contexte complet) et ce document.
2. `git log --all --grep "Card 7bd455f6"` et `git log --all --grep "Card 1dc74e6c"` pour les lots déjà livrés.
3. Prendre le premier lot dont les dépendances sont livrées ; passer la carte en `in_progress` seulement au début du travail.
4. Ajouter à la carte, par `roadmap_append_context`, ce que le lot a appris et qui change les lots suivants.
