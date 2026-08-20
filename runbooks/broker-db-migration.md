# Playbook: muter la base SQLite du broker avec un script one-shot

Ce document couvre le cas general: **appliquer un script d'ecriture a la base
du broker `claude-peers`**, qui vit dans un conteneur Docker sur une autre
machine. Migration de schema, normalisation de donnees, correction en masse.

Il a ete ecrit apres une execution reelle, la normalisation de casse du
`project_key` (carte `69e5a3e0`, commit `a359b53`, executee le 2026-08-20).
Cette execution sert d'exemple travaille tout du long, et chaque piege ci-
dessous s'est reellement produit ou a reellement ete evite ce jour-la.

Chaque fait porte une etiquette:

- **MESURE** -- observe pendant l'execution du 2026-08-20, commande citee.
- **DEDUIT** -- lu dans une source primaire du depot, `fichier:ligne` cite.
- **NON MESURE** -- non verifie. Une commande de decouverte est donnee a la
  place. **Ne jamais substituer une valeur devinee a un NON MESURE.**

---

## 1. La topologie, mesuree

| Element | Valeur | Source |
|---|---|---|
| Poste client | `DESKTOP-7B2CIVN`, fuseau **Europe/Paris** | MESURE |
| Hote du broker | LXC `mcp-server`, `192.168.10.23`, fuseau **America/Sao_Paulo (UTC-3)** | MESURE, `date -u` |
| Acces | `pct enter <id>` depuis Proxmox | operateur |
| Stack | `/opt/mcp-server`, pilotee par `stack.sh` | MESURE |
| Clone koryphaios sur la LXC | `/opt/mcp-server/claude-peers` (nom historique) | MESURE |
| Conteneur | `claude-peers-broker`, image `mcp-server/claude-peers-broker:0.9.0` | `docker-compose.yml` |
| **Base, vue de l'hote** | **`/var/lib/mcp/claude-peers/peers.db`** | `docker-compose.yml`, bind mount |
| Base, vue du conteneur | `/var/lib/claude-peers/peers.db` (`CLAUDE_PEERS_DB`) | `docker-compose.yml` |
| Proprietaire du repertoire | `1000:1000` | MESURE, `stack.sh` fait `install -d -o 1000 -g 1000` |

**C'est un BIND MOUNT, pas un volume anonyme.** Le fichier est donc
directement visible et modifiable depuis l'hote. Aucun `docker cp` n'est
necessaire, jamais.

**Le decalage de fuseau de 5 h est un piege reel.** Un `ls -l` sur la LXC a
rendu une mtime de `12:11` pour un fichier checkout a `17:11` heure de Paris,
ce qui a l'air d'un fichier plus vieux que le commit dont il sort. Verifier
avec `date -u` avant de conclure a une anomalie.

### Ce que le repertoire contient, et pourquoi on sauvegarde TOUT

`peers.db`, plus `peers.db-wal` et `peers.db-shm` quand ils existent, plus
**`notify.key`** (cle AES-256-GCM chiffrant les jetons des canaux de
notification) et un sous-repertoire `logs/`. Une sauvegarde du seul `.db`
laisserait `notify.key` de cote.

Le script de migration, lui, ne touche jamais `notify.key`: il n'ouvre que
l'unique chemin passe en `--db`, et `bun:sqlite` n'ouvre rien d'autre du
repertoire. Garantie structurelle, pas une discipline.

---

## 2. Ce que le script DOIT faire, avant meme d'ecrire le runbook

`scripts/migrate-project-key-case.ts` sert de reference. Six proprietes, dont
chacune a ete introduite parce que son absence a produit un defaut reel:

1. **DECOUVRIR les tables, jamais les enumerer.** Interroger `sqlite_master`
   plus `PRAGMA table_info` pour trouver les tables portant la colonne visee.
   *Pourquoi*: la carte d'origine enumerait QUATRE tables porteuses de
   `project_key`, il y en avait **CINQ** -- `approval_session_tokens` est
   ajoutee par `ALTER TABLE`, donc invisible a un balayage des `CREATE TABLE`.
   Une liste ecrite a la main echoue en silence des que le domaine grandit.
2. **Aucune liste d'exclusion.** Zero exception vaut mieux qu'une exception
   justifiee, qui est une liste ecrite a la main de plus.
3. **`--dry-run` par DEFAUT, `--write` explicite, `--db` obligatoire.** Un
   chemin devine est la pire panne possible: pointe sur une base vide, le
   script trouve les tables, ne trouve rien a migrer, et rapporte un succes.
4. **UNE seule transaction** pour toutes les tables. Un echec en cours de
   route annule tout. Une base a moitie migree est pire que rien, puisque
   c'est exactement l'etat de casse mixte qu'on cherche a supprimer.
5. **REFUSER en cas de collision, jamais fusionner.** Le script s'arrete et
   nomme la table, la valeur cible et les formes existantes. La resolution est
   une decision humaine.
6. **Transformer en JS, pas en SQL.** `LOWER()` de SQLite est **ASCII
   seulement**, `.toLowerCase()` de JS est **Unicode**. Mesure:
   `"github.com/VOCSAP/ETE"` avec accents rend `.../EtE` en SQL contre
   `.../ete` en JS. Une migration en SQL aurait ecrit une TROISIEME forme, que
   plus aucun code ne produit, puis aurait declare la base propre. Nul sur
   `github.com`, non nul sur GitLab, Gitea ou tout hebergeur auto-heberge.

### Le piege de test qui a failli tout emporter

Le mode `--write` etait **casse depuis l'origine**: `bun:sqlite` jette
`"bad parameter or other API misuse"` sur un objet d'options ne portant que
`{readonly: false}`. Invisible parce que tous les tests visaient `:memory:`,
qui accepte cette forme sans broncher. **Au moins une branche de chaque mode
d'ouverture doit etre exercee contre un VRAI fichier disque.**

---

## 3. L'ordre d'execution, corrige

**Le point le plus important de ce document.** La premiere version de ce
runbook deplacait les surfaces de deploiement AVANT de migrer. C'est faux, et
ca fabrique la collision sur laquelle l'execution du 2026-08-20 a bute: une
session lancee entre les deux ecrit la NOUVELLE forme dans une base encore en
ANCIENNE forme.

> **Regle: aucune session ne doit s'enregistrer entre le moment ou une surface
> passe au nouveau code et la fin de la migration.**

Deux facons de la respecter. La seconde est plus sure.

**(A) Surfaces d'abord** -- deplacer les surfaces, puis migrer, en s'interdisant
absolument toute session entre les deux. Fragile: un `--resume`, un lancement
de l'app, un outil qui parle au broker suffit a violer l'invariant.

**(B) Migrer d'abord** -- arreter le broker, migrer, deplacer les surfaces,
relancer. Rien ne peut s'enregistrer pendant la migration puisque le broker
est arrete. **C'est la voie a preferer.**

L'execution du 2026-08-20 a suivi (A), a fabrique la collision, et l'a resolue
a la main. La garde a tenu et rien n'a ete perdu, mais c'etait evitable.

### Enumerer TOUTES les surfaces, y compris celles qui ne bougent pas

Une surface oubliee, c'est la migration defaite en silence par celle a
laquelle personne n'a pense.

| # | Surface | Verdict du 2026-08-20 |
|---|---|---|
| 1 | Clone MCP `C:\Users\Olivier\workspace\koryphaios-mcp`, en HEAD detache, enregistre `--scope user` | **DOIT BOUGER**. Etant en scope user, il couvre TOUS les projets du poste d'un coup |
| 2 | L'app Koryphaios (`kory`) | **DOIT ETRE RECONSTRUITE**: `cd desktop && npm run build`. Elle tourne depuis le checkout interactif, donc elle a la source, mais `out/` ne suit pas tout seul |
| 3 | Clone hote `/opt/mcp-server/claude-peers` qui build l'image du broker | **NE BOUGE PAS** pour une migration de donnees. Voir ci-dessous |

**Comment savoir si le broker a besoin du changement de code** -- bundler puis
greper le bundle, jamais lire les imports a l'oeil:

```bash
bun build --target=bun broker.ts --outdir=/tmp/broker-closure-check
grep -c "<symbole ou chemin de fichier>" /tmp/broker-closure-check/broker.js
```

`bun build` inline la fermeture transitive ENTIERE dans un fichier, donc un
compte a zero est une mesure directe d'absence, pas une inference. Mesure le
2026-08-20: zero occurrence de `normalizeRemoteUrl` / `computeProjectKey` dans
la fermeture de `broker.ts`, donc **aucun rebuild d'image**. Le broker ne fait
que stocker et comparer octet a octet la valeur qu'un client a deja calculee.

---

## 4. `stack.sh`, ce qu'il faut savoir avant de le lancer

`/opt/mcp-server/stack.sh` gere la stack. Deux de ses commandes sont des
pieges dans le contexte d'une migration:

| Commande | Ce qu'elle fait REELLEMENT | Verdict |
|---|---|---|
| `stack.sh update` | `ensure_repo` puis `docker compose up -d --build --force-recreate --wait` | **NE PAS LANCER avant la migration**: elle REDEMARRE le broker, donc reintroduit un ecrivain vif |
| `stack.sh stop` | `docker compose down` | **NE PAS LANCER**: elle arrete TOUS les services du compose (`docker-inspect`, `office`...), pas seulement le broker |
| `stack.sh backup-db` | `sqlite3 .backup` de `peers.db` seul | Insuffisant seul: laisse `notify.key` de cote |

Pour arreter le seul broker: `docker stop claude-peers-broker`.

Pour mettre le clone hote a jour **sans** toucher au conteneur, utiliser les
memes commandes qu'`ensure_repo`, eprouvees sur ce clone (qui est en
`--depth 1`, ou un `git pull` simple peut mal reagir):

```bash
cd /opt/mcp-server/claude-peers
git fetch --depth 1 origin experimental && git reset --hard FETCH_HEAD
git log --oneline -1
git status --porcelain          # doit etre VIDE
```

---

## 5. LE PIEGE WAL -- lire avant de copier quoi que ce soit

`broker.ts` execute `PRAGMA journal_mode = WAL` inconditionnellement au boot
(DEDUIT, `broker.ts:371`). **Ce broker est en mode WAL.** Les transactions
recentes vivent dans `peers.db-wal`, pas encore repliees dans `peers.db`.

**Ce n'etait pas theorique le 2026-08-20** (MESURE): `peers.db` faisait 5,2 Mo
date de 11:51, et `peers.db-wal` **4,7 Mo** date de 12:14. Pres de la moitie
de la base vivait dans le WAL. Un `cp peers.db` seul aurait donne un fichier
parfaitement valide a l'ouverture, ampute de 4,7 Mo d'ecritures recentes, sans
le moindre message.

**Arreter le conteneur ne garantit PAS un checkpoint.** Verifie directement:
`broker.ts` n'enregistre aucun handler `SIGTERM`/`SIGINT` et n'appelle
`db.close()` nulle part (MESURE, `grep -n 'SIGTERM\|SIGINT\|db\.close'
broker.ts` -> aucun match). `docker stop` envoie SIGTERM puis SIGKILL, sans
que rien ne ferme la base proprement.

Ce que l'arret garantit, c'est que **rien n'ecrit** pendant la copie, donc un
instantane COHERENT. La completude vient de toujours traiter **les trois
fichiers ensemble**, et de l'ouverture par le script, qui declenche la
recuperation WAL automatique de SQLite.

---

## 6. La procedure

Toutes les commandes sur la LXC, apres `pct enter <id>`, sauf mention.

### Etape 1 -- amener le script, sans toucher au conteneur

```bash
cd /opt/mcp-server/claude-peers
git fetch --depth 1 origin experimental && git reset --hard FETCH_HEAD
git log --oneline -1
git status --porcelain
ls -l scripts/<le-script>.ts
```

Le commit attendu doit apparaitre et `status` doit etre **vide**. Ne pas
conclure sur la mtime du fichier: le fuseau de la LXC decale de 5 h.

### Etape 2 -- arreter le seul broker

```bash
docker stop claude-peers-broker
docker ps --filter name=claude-peers-broker      # doit ne RIEN lister
```

### Etape 3 -- sauvegarder le repertoire ENTIER

```bash
cp -a /var/lib/mcp/claude-peers \
      /var/lib/mcp/claude-peers.pre-<carte>.$(date +%Y%m%dT%H%M%S).bak
ls -la /var/lib/mcp/claude-peers/ /var/lib/mcp/claude-peers.pre-<carte>.*/
```

Lister les deux cote a cote. Ce double listing dit d'un coup si le WAL est
present et prouve que `notify.key` a bien ete pris. Garder la sauvegarde
plusieurs jours apres confirmation en production.

### Etape 4 -- dry-run

```bash
cd /opt/mcp-server/claude-peers
docker run --rm \
  --user "$(stat -c '%u:%g' /var/lib/mcp/claude-peers)" \
  -v /var/lib/mcp/claude-peers:/var/lib/claude-peers \
  -v "$(pwd)/scripts/<le-script>.ts:/tmp/migrate.ts:ro" \
  oven/bun:1.3.14-debian \
  bun /tmp/migrate.ts --db /var/lib/claude-peers/peers.db
```

Le `cd` compte: `$(pwd)` doit resoudre vers le clone.

**Pourquoi un conteneur jetable plutot qu'un `bun` sur l'hote**: zero
prerequis sur l'hote, **exactement la meme version de bun que celle qui a
ecrit la base** (`Dockerfile.claude-peers` fait `FROM oven/bun:1.3.14-debian`,
et `bun:sqlite` est precisement la surface ou une derive de version mordrait),
et `--rm` ne laisse rien derriere. Le `--user "$(stat -c ...)"` resout
dynamiquement le proprietaire du bind mount, donc la question des droits ne se
pose pas. NON MESURE le 2026-08-20: l'egress reseau de la LXC vers Docker Hub
si l'image n'est pas deja la -- elle a du etre tiree, et le pull a fonctionne.

**Ce qui doit faire ARRETER:**

| Signal | Interpretation |
|---|---|
| Moins de tables que le schema n'en porte | Le schema differe de ce qu'on croit, pas l'inverse |
| `REFUSING: ... collision detected` | Deux formes coexistent. Resolution humaine, jamais reforcer |
| Compteur de cibles a 0 partout | Mauvais fichier `--db`, ou deja migre |
| Une table inconnue | Ce n'est pas la bonne base |

**Sain**: toutes les tables attendues, `no collision`, un bloc `before:` avec
des compteurs non nuls, et la ligne annoncant qu'aucune ecriture n'a eu lieu.

### Etape 5 -- resoudre une collision, si elle se produit

Le cas rencontre le 2026-08-20, et sa lecon. La collision portait sur la table
`peers`, **la seule des cinq qui soit ephemere**: ses lignes sont re-derivees
a chaque enregistrement de session.

Diagnostic avant tout geste. **Ne pas lancer `sqlite3` en root sans y
penser**: SQLite ecrit dans `-wal` et `-shm` meme pour un `SELECT`, et des
fichiers appartenant a root empecheraient le conteneur, qui tourne en uid
1000, d'ecrire au redemarrage. Verifier `ls -la` apres coup, et au besoin
`chown -R 1000:1000 /var/lib/mcp/claude-peers`.

```bash
sqlite3 /var/lib/mcp/claude-peers/peers.db \
  "SELECT project_key, status, COUNT(*) FROM peers GROUP BY 1,2 ORDER BY 1,2;"
sqlite3 /var/lib/mcp/claude-peers/peers.db \
  "SELECT peer_id, status, host, last_seen FROM peers WHERE project_key='<forme en trop>';"
```

Le 2026-08-20: deux lignes seulement dans la forme fautive, `last_seen` de la
minute, sur le poste client -- signature d'une session recente tournant deja
le code neuf. Suppression ciblee, les lignes historiques intactes:

```bash
sqlite3 /var/lib/mcp/claude-peers/peers.db \
  "DELETE FROM peers WHERE project_key='<forme en trop>';"
```

**Une inquietude qui s'est revelee infondee, et la lecon vaut**: on a craint
que la session vivante ne recree la ligne entre le `DELETE` et le `--write`.
Impossible: le broker etait **deja arrete**, donc rien ne pouvait
s'enregistrer. Verifier l'etat reel plutot que raisonner sur un mecanisme.

### Etape 6 -- ecrire

Meme commande plus `--write`. **Point de non-retour**: apres, la valeur
d'origine n'existe plus dans la base, et le seul retour arriere est la
sauvegarde de l'etape 3.

**Le controle qui compte dans la sortie**: les **totaux par table doivent etre
identiques avant et apres**. Aucune ligne perdue, aucune fusion silencieuse.
Le compteur de cible doit tomber a zero partout, et chaque compteur inverse
doit valoir son ancienne valeur plus le nombre de lignes modifiees. Le
2026-08-20: 375 lignes modifiees sur 4 tables, totaux 20 / 0 / 117 / 47 / 268
inchanges.

### Etape 7 -- redemarrer

```bash
docker start claude-peers-broker
sleep 3
curl -s http://127.0.0.1:7899/health
docker ps --filter name=claude-peers-broker
```

Attendu: `{"status":"ok",...}` et un conteneur `(healthy)`. En cas d'echec,
`docker logs --tail 30 claude-peers-broker`; un `SQLITE_READONLY` ou un
`unable to open database file` designe un probleme de droits, reparable par
`chown -R 1000:1000 /var/lib/mcp/claude-peers`.

### Etape 8 -- deplacer les surfaces, puis relancer

Sur le poste client, dans l'ordre: deplacer le clone MCP, reconstruire l'app,
puis seulement relancer.

```bash
git -C C:/Users/Olivier/workspace/koryphaios-mcp fetch origin experimental
git -C C:/Users/Olivier/workspace/koryphaios-mcp checkout <sha>
cd desktop && npm run build
```

### Etape 9 -- verifier, avec un CONTROLE NEGATIF

Un controle positif seul ne prouve rien: il est compatible avec "les deux
formes fonctionnent", donc avec une migration qui n'a rien fait.

```bash
bun cli.ts roadmap-export "<nouvelle forme>" | grep -c '"id"'   # attendu: > 0
bun cli.ts roadmap-export "<ancienne forme>" | grep -c '"id"'   # attendu: 0
bun cli.ts status                                                # les pairs portent la NOUVELLE forme
```

Le 2026-08-20: 241 contre 0, et les 241 correspondaient exactement a l'export
pris avant migration sous l'ancienne forme.

Rejouer le dry-run doit desormais montrer un compteur de cible a zero partout:
le script est idempotent.

---

## 7. Sauvegarder la roadmap avant, c'est deux secondes

Independamment de la sauvegarde du repertoire, exporter les roadmaps sur le
poste client. Les deux ne protegent pas de la meme chose: la sauvegarde vit
sur la LXC, a cote de ce qu'elle protege; l'export vit ailleurs et survit a la
perte de la machine. Et `roadmap-import` conserve les ids, donc c'est une
vraie restauration, pas une archive.

```bash
bun cli.ts roadmap-export <project_key> > /chemin/roadmap-<date>-<projet>.json
```

**Verifier le DECOMPTE, jamais la seule presence du fichier.** Trois modes
d'echec, mesures:

1. `roadmap-export` accepte n'importe quelle chaine comme `project_key` et
   rend `"items": []` **sans erreur** si elle ne correspond a rien. Un export
   de quatre lignes a l'air d'un succes.
2. Une commande qui s'execute et ECHOUE laisse un fichier de **zero octet**:
   le shell ouvre la redirection avant de resoudre la commande.
3. Une commande **jamais executee** laisse intact un fichier homonyme d'une
   autre session, qui se lit exactement comme un export frais.

```bash
ls -l --time-style=full-iso <fichier>
grep -o '"id"' <fichier> | wc -l
```

---

## 8. Retour arriere

La transaction du script ne protege que d'un echec en cours de route. Elle ne
protege PAS de "la migration a reussi mais quelque chose en aval est casse".
Une fois `--write` commite, le seul retour est la sauvegarde:

```bash
docker stop claude-peers-broker
rm -rf /var/lib/mcp/claude-peers
cp -a /var/lib/mcp/claude-peers.pre-<carte>.<timestamp>.bak /var/lib/mcp/claude-peers
docker start claude-peers-broker
```

Puis remettre les surfaces sur le commit precedent, et reconstruire l'app
depuis ce commit, pour que le code qui tourne et la base restauree
s'accordent.
