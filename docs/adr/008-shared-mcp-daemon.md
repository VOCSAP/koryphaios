# ADR 008 : un daemon MCP local partagé, joint par un relais Rust par session et par famille

Statut : **Acceptée (2026-11-06, opérateur)**, cartes `7bd455f6` et `1dc74e6c`. Les décisions de principe du §4 et les arbitrages Q1 à Q5, Q7, Q9 et Q10 de la conception ont été pris par l'opérateur le 2026-11-06. La revue critique du même jour est intégrée à la conception. Restent ouvertes deux confirmations (§9), dont Q11 à trancher avant L1. Aucun code livré par cet ADR. Conception détaillée : `docs/DESIGN-MCP-DAEMON.md`.

**Décision : un daemon bun par utilisateur OS et par racine de code sert les familles `claude-peers` et `kory-roadmap`. Claude Code lance par session et par famille un relais stdio Rust qui s'authentifie au daemon sur TCP loopback, lui envoie l'identité de la session, puis copie le JSON-RPC MCP. Les serveurs bun actuels restent le repli.**

Les constats portent `DÉDUIT`, `MESURÉ` ou `SUPPOSÉ`. Les coûts sont des estimations.

## 1. Problème

**MESURÉ par l'opérateur le 2026-11-06, non rejoué ici** : 13 sessions, environ 4,7 Go de mémoire résidente pour les deux serveurs bun de chaque session ; entre 160 et 250 Mo par serveur, environ 90 Mo pour un bun vide. La mémoire croît avec le nombre de sessions, alors que le travail utile de ces serveurs est faible.

**DÉDUIT**, `server.ts:391-407,484-544,1074-1097,2061-2084` : `server.ts` porte l'état de LA session dans des variables de module et lit `process.env`, `process.cwd()` et `process.pid`. Ses helpers partagés font de même par défaut (`shared/config.ts:395-434,537`, `shared/peer-cache.ts:478-487`). Mutualiser le processus exige donc un modèle d'état par session, pas seulement un transport.

## 2. Contraintes à respecter

- **Groupe = run Kory** (`CLAUDE.md`) : une tuile Kory est forcée dans un groupe par son environnement. Un daemon qui lirait le sien enregistrerait la tuile dans le groupe par défaut de l'utilisateur, sans erreur.
- **« Keyed by what, and what happens when there are two? »** : deux tuiles dans le même dossier et le même groupe sont deux identités. Après un crash du daemon, une ré-inscription naïve suffixe ou échange leurs identités (`broker.ts:2884-2929`, collision sur PID vivant).
- **Approbations locales par construction** : rien de ce que le daemon garde n'est persisté ni fédéré. Le daemon est local au poste dans les trois modes du broker.
- **Familles MCP** (`docs/DESIGN-MCP-FAMILIES.md`) : deux noms de serveur distincts sont conservés ; le découpage vit au niveau des noms, pas des processus.
- **Cinq entrées hostiles** : le hello vient de l'environnement d'un processus du même utilisateur. Ce n'est pas une frontière de privilège (§5 de la conception), mais il est validé à la frontière : types, tailles, cwd absolu, PID entiers.

## 3. Options

| Option | Coût | Risque et rayon d'impact | Réversibilité |
|---|---|---|---|
| A. Route Streamable HTTP `/mcp` sur le broker | moyen | En mode `remote`, le broker est sur une autre machine et ne lit ni les snapshots de `~/.claude/peers` ni les PID locaux ; déplace l'identité locale vers un serveur partagé. | Faible : change le contrat du broker. |
| B. Transport HTTP de Claude Code avec `headersHelper` | faible | Repose sur un héritage d'environnement non documenté vers le helper ; reconnexion HTTP de Claude Code non mesurée. | Bonne. |
| C. Deux daemons, un par famille | moyen | Double le coût fixe ; la roadmap devrait toujours relire un snapshot sur disque pour trouver la session peers. | Bonne. |
| D. Un daemon, relais Go | moyen | Prototype Go de 40 lignes mesuré transparent par l'opérateur ; empreinte du runtime Go plus forte qu'un binaire Rust (**SUPPOSÉ**). | Bonne. |
| E. Bundle minifié de `server.ts`, carte `f4080f27` | faible | **MESURÉ par l'opérateur** : environ un quart de mémoire en moins ; la croissance reste linéaire. Aucune panne commune à plusieurs sessions (revue critique). | Totale. |
| **F. Un daemon pour les deux familles, relais Rust par session et par famille, repli bun** | **10,5 à 13,5 jours** (plan des lots révisé) | Un état de module oublié mélange les sessions ; un crash du daemon coupe toutes les sessions, d'où la reprise par token. | Bonne : la configuration revient à la forme bun. |

**Retenue : F**, décidée par l'opérateur. La force décisive est la mémoire : seul un processus unique rend le coût par session indépendant de bun. E reste le repli si F échoue.

## 4. Décisions de principe (opérateur, 2026-11-06)

1. Daemon local dédié, couvrant les modes `local`, `replica` et `remote`. A écartée.
2. Un seul daemon pour les deux familles. C écartée : le broker est déjà un point de panne commun ; la vraie contrainte est la reprise.
3. Les deux familles passent par le même relais stdio, `--family peers|roadmap`. B écartée.
4. Relais en Rust. D écartée. Windows compilé en local, Linux par `cargo-zigbuild`, macOS en CI. Binaire absent : les serveurs bun actuels.
5. Sessions Kory et hors Kory ensemble sur la même machine : scénario obligatoire.

## 5. Décisions de réalisation

| Sujet | Décision | Écarté |
|---|---|---|
| Transport | TCP `127.0.0.1` sur 10 ports candidats dérivés de l'utilisateur OS (Q1) ; un daemon par port, le plus bas gagne ; surcharge par variable d'environnement. | Pipe nommé et socket unix : deux codes ; libuv ne fixe pas le descripteur de sécurité d'un pipe (MESURÉ documentaire, nodejs/node#47086). Port fixe unique. |
| Authentification | HMAC mutuel sur nonces, clé de 32 octets dans `~/.claude/peers/mcp-daemon.key` ; le relais n'envoie rien avant la preuve du daemon ; connexions non authentifiées bornées en nombre et en durée. | Loopback sans preuve : un autre compte qui occupe le port recevrait les secrets de groupe. |
| Menace | Protège d'un autre compte OS et d'un conteneur sandbox sans clé ; n'ajoute aucune capacité à un processus du même utilisateur. | Promettre une isolation entre processus du même utilisateur. |
| Racine de code | Le hello porte un condensat de la racine ; un daemon refuse une autre racine, le relais passe au candidat suivant. | Servir toute racine en silence ; refuser et forcer le repli bun. |
| Trames | `u32` de longueur, un octet de type, JSON ; type `MCP` distinct du contrôle. | NDJSON avec méthode réservée. |
| Identité de session | Hello : PID et ppid du relais avec heure de création, cwd, tty, env filtré, racine, ticket. Le daemon ne lit jamais son env pour une session ; il est lancé avec un env filtré et purge les variables de session du sien. | Hériter l'env du premier relais. |
| Code | Fabriques de session sans effet de bord ; `server.ts` et `server-roadmap.ts` deviennent des entrées stdio minces sur la même fabrique ; les helpers perdent leurs défauts `process.*`. | Deux implémentations, ou défauts conservés sous un test de discipline. |
| Lancement | Par le relais seulement, sous un verrou de lancement ; détaché, cwd neutre, `CREATE_BREAKAWAY_FROM_JOB` avec retrait journalisé ; image nommée `kory-mcp-daemon` (copie de `bun.exe` sous Windows, lien symbolique sous POSIX). | Lancement par WMI (sans objet après mesure) ; daemon lancé par Kory, qui laisserait les sessions hors Kory sans daemon ; N lancements arbitrés par le port. |
| Job des tuiles Kory | `BREAKAWAY_OK` ajouté au job des tuiles (limites `0x2800`, Q10). **MESURÉ** : sans lui, un daemon lancé depuis une tuile meurt avec elle ; avec lui, seul l'enfant qui le demande sort du job. | Garder `0x2000`, qui couperait toutes les sessions à la fermeture d'une tuile. |
| Vivacité | Le broker reçoit le PID du relais et sa génération ; en `local` et `replica`, un relais vivant garde le pair actif sans heartbeat (Q9) ; le snapshot porte la génération du relais, mesurée par le daemon. `claude_cli_pid` est envoyé mais n'est une preuve de rien (aucun lecteur, MESURÉ). | PID du daemon ; `claude_cli_pid` comme preuve. |
| Reprise | Ticket MACé gardé en mémoire par le relais ; le broker reprend par token si le PID du relais est le même, sans autre preuve, y compris hors Kory (Q4) ; époque de dépôt et snapshot conservés (Q3) ; résurrection par `session_key` refusée pour une ligne au PID vivant. | Ticket stocké par le daemon, perdu avec lui. |
| Roadmap | Liaison par `(socket de messagerie, PID et heure de création de claude.exe)` ; deux candidats : refus ; aucun : snapshot. | Socket seul ; premier candidat. |
| Cycle de vie | Arrêt après 600 s sans session (Q2), écoute fermée avant la dernière vérification ; mise à jour = arrêt contrôlé et reprise, par la CLI seule (Q7) ; un daemon bloqué est arrêté par son PID vérifié ; rejets non gérés journalisés sans sortie ; broker lancé détaché. | Daemon sans arrêt ; ne jamais tuer un daemon bloqué. |
| Repli | Forme bun à l'installation si le binaire manque ; repli bun du relais au démarrage seulement, listé par `mcp-daemon status` (Q5). | Repli au milieu d'une session, qui suffixerait l'identité. |
| Sandbox | Tuiles sandbox sur bun dans ce chantier. | Daemon hôte servant des processus de conteneur. |

## 6. Conséquences

- **Positives** : coût mémoire fixe d'un daemon plus quelques Mo par relais (à mesurer en L1 et L6) ; plus de PowerShell par appel roadmap quand les deux relais sont liés ; `ensureBroker` en vol unique ; logs étiquetés par session ; le daemon se distingue des autres processus bun et échappe à un `taskkill /IM bun.exe`.
- **Négatives** : un crash du daemon coupe toutes les sessions pendant la reprise, et les appels en vol ont une issue inconnue ; un binaire de plus à construire par plateforme ; clé locale, ports candidats et fichiers d'état sont de nouveaux éléments d'exploitation.
- **Sécurité, contrepartie acceptée** : avec `BREAKAWAY_OK`, tout processus d'une tuile peut sortir du job en le demandant et échapper à l'arrêt de l'arbre. C'est du code du même utilisateur, qui pouvait déjà lancer un processus hors de Kory.
- **Changements hors cœur** : `desktop/src/main/shell-command.ts` (job des tuiles) et `desktop/src/main/broker-spawn.ts` (broker lancé avec `bun` quand l'entrée MCP est le relais), en L2 ; les appelants des helpers du §7.3 de la conception passent leur env explicitement.

## 7. Lots

Ordre et critères de sortie : `docs/DESIGN-MCP-DAEMON-LOTS.md`, aligné sur la conception. `family_unavailable` permet d'installer les deux relais dès L2 (le relais peers se replie sur `server.ts`). L3 étend `tests/broker-resume.test.ts` et `tests/broker-sweep-inactive.test.ts`.

## 8. Mesures restantes

1. L1 : mémoire résidente du relais au repos.
2. L2 : un second `listen` du même utilisateur sur le même port échoue sous Windows ; un enfant bun non détaché meurt-il avec son parent, et `detached` ouvre-t-il une fenêtre ; un daemon lancé depuis une tuile Kory survit à la fermeture de la tuile.
3. L5 : le nom `kory-mcp-daemon` par lien symbolique sous Linux et macOS.

Un résultat contraire change la réalisation du lot concerné, pas la décision F. Aucun test exécuté pour cet ADR documentaire ; aucun résultat futur n'est revendiqué vert.

## 9. Arbitrages opérateur

Décidés le 2026-11-06 : Q1 (10 ports candidats), Q2 (arrêt après 600 s), Q3 (époque de dépôt gardée à la reprise), Q4 (reprise nue par token et PID hors Kory), Q5 (repli au démarrage, listé par `status`), Q7 (CLI seule, procédure dans `README.md`), Q9 (relais vivant = pair actif en `local` et `replica`), Q10 (`BREAKAWAY_OK`). Q6 (WMI) est sans objet.

Ouverts, avec recommandation : Q8 (notice de reconnexion en channel : oui ; touche L4 seulement) et Q11 (un daemon par racine de code quand deux clones servent des sessions : oui ; touche la recherche des candidats en L1 et le parcours du daemon en L2, à confirmer avant L1).
