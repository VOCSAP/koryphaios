# Runbook : provisionner la confiance opérateur du broker

## Objet et limite du lot

`operator-trust.json` contient les clés publiques Ed25519 autorisées pour un
profil d'administration du broker. Il est frère de `config.json` :

- Windows : `%APPDATA%\claude-peers\operator-trust.json` ;
- Linux et macOS : `$XDG_CONFIG_HOME/claude-peers/operator-trust.json`, ou
  `~/.config/claude-peers/operator-trust.json` sans `XDG_CONFIG_HOME`.

Le fichier n'appartient ni à un dépôt, ni au `userData` du Deck. La commande
`init` ne crée que ce chemin global et ne l'écrase jamais. Le broker n'accorde
l'autorité opérateur qu'aux clés de cette politique, lue une seule fois au
démarrage : tout changement demande un redémarrage.

## Vérifications communes

1. Exporter seulement la partie publique de l'identité Deck :

   ```bash
   bun cli.ts operator-trust export
   ```

   Pour une identité dans un profil Deck non standard, indiquer son fichier :

   ```bash
   bun cli.ts operator-trust export --identity /chemin/vers/operator.json
   ```

   La sortie fournit `operator_id`, `public_key` et `fingerprint_sha256`. Ne
   transmettre que la clé publique et comparer l'empreinte par un canal
   administratif distinct.

2. Initialiser un profil encore absent :

   ```bash
   bun cli.ts operator-trust init --public-key '<clé-publique-base64>' --label 'Deck personnel'
   bun cli.ts operator-trust validate
   bun cli.ts operator-trust fingerprints
   ```

   Deux initialisations concurrentes ne fusionnent rien. Une seule crée le
   fichier ; l'autre s'arrête et indique si la clé demandée est déjà présente.

3. Préparer toute modification ultérieure dans un fichier séparé et la valider
   avant de remplacer le fichier actif :

   ```bash
   bun cli.ts operator-trust validate --input /chemin/vers/operator-trust.prepare.json
   ```

   Le format v1 est :

   ```json
   {
     "version": 1,
     "operators": [
       { "public_key": "<clé-publique-Ed25519-base64>", "label": "Deck personnel" }
     ]
   }
   ```

   Une entrée invalide annule le fichier entier. Ne copier ni clé privée, ni
   ligne historique de `approval_operators` dans cette politique.

## Protection du répertoire sous Windows

Le mode `0600` n'a pas d'effet sous Windows. La protection vient de l'ACL
héritée de `%APPDATA%`. Vérifier avec :

```bat
icacls "%APPDATA%\claude-peers"
```

Seuls le compte, `SYSTEM` et `Administrators` doivent avoir accès. Aucun groupe
large ne doit apparaître.

## Poste personnel en replica

1. Provisionner la politique du broker loopback avec la clé exportée du Deck.
2. Vérifier la politique locale avec `validate` et `fingerprints`.
3. Traiter le Bearer et la clé de l'upstream comme une relation de réplication,
   pas comme une inscription opérateur.

Mesuré : l'amont ne reçoit d'une réplique que des routes de réplication et de
fédération, sous Bearer (synchronisation des cartes et des documents de contexte,
verrou de carte en prise et en relâche, `/federation/sync`, `/federation/send`).
Aucune ne porte de signature opérateur. Une écriture opérateur faite par la
réplique n'est rattachée à aucun `operator_id` sur l'amont, qui ne peut donc pas
la rapprocher d'une clé de sa politique. Provisionner l'amont séparément, selon
« Broker distant sur LXC », si ses propres routes opérateur doivent accepter
cette identité.

## PC professionnel

1. Exporter la clé du Deck professionnel et vérifier l'empreinte avec son
   propriétaire.
2. Préparer une politique complète contenant la clé personnelle et la clé
   professionnelle si les deux doivent agir sur le même profil broker.
3. Valider le fichier préparé, arrêter le broker, remplacer le fichier de façon
   atomique, puis redémarrer le broker.

Une identité copiée entre deux postes est le même principal : elle n'ajoute pas
une seconde entrée. Deux clés distinctes nécessitent deux entrées explicites.

## Broker distant sur LXC

Le broker de la LXC tourne dans un conteneur à système de fichiers en lecture
seule, sans `bun` ni `cli.ts` : la politique se prépare et se valide sur un poste
qui a le dépôt, puis se copie sur l'hôte de la LXC. Elle vit dans
`/etc/mcp/claude-peers-trust`, monté en lecture seule dans le conteneur sous
`$XDG_CONFIG_HOME/claude-peers` (`XDG_CONFIG_HOME=/etc/claude-peers-admin`). Ce
répertoire est hors de `/var/lib/mcp/claude-peers`, que le service peut écrire :
le service ne peut pas réécrire sa propre liste de clés.

Ne déposer que `operator-trust.json` dans ce répertoire : le broker y lirait aussi
un `config.json` s'il existait, comme sa configuration globale.

La politique se pose AVANT la mise à jour du broker. Un broker qui démarre sans
politique lisible répond 503 à toute route opérateur. Les commandes `pct` ci-dessous
s'exécutent depuis l'hôte Proxmox, `<vmid>` désignant la LXC du broker.

1. Sur le poste Windows du Deck, exporter la clé publique et comparer son
   empreinte avec son propriétaire par un canal distinct :

   ```bash
   bun cli.ts operator-trust export
   ```

2. Écrire la politique complète dans un fichier de travail hors du dépôt,
   `"$TEMP/operator-trust.prepare.json"`, au format v1 décrit plus haut. Ne pas
   utiliser `init` pour la préparer : il écrit le profil global du poste. Valider
   le fichier :

   ```bash
   bun cli.ts operator-trust validate --input "$TEMP/operator-trust.prepare.json"
   ```

   `fingerprints` ne lit pas `--input` : vérifier que la `public_key` de chaque
   entrée du fichier préparé est identique, caractère pour caractère, à la sortie
   de l'étape 1, par exemple avec `grep -cF '<public_key>'` sur le fichier, qui doit
   rendre 1 par clé. Relever l'empreinte du fichier préparé :

   ```bash
   sha256sum "$TEMP/operator-trust.prepare.json"
   ```

3. Copier ce fichier sur l'hôte Proxmox, puis créer le répertoire dans la LXC
   (`./stack.sh start`, `restart` et `update` le créent aussi s'il manque) :

   ```bash
   pct exec <vmid> -- install -d -m 0750 -o root -g 1000 /etc/mcp/claude-peers-trust
   ```

4. Pousser le fichier sous le nom `operator-trust.json.new`, propriétaire et
   droits fixés à la copie, puis comparer les trois empreintes (poste, hôte
   Proxmox, LXC) : elles doivent être identiques.

   ```bash
   pct push <vmid> operator-trust.prepare.json /etc/mcp/claude-peers-trust/operator-trust.json.new --user 0 --group 1000 --perms 0640
   sha256sum operator-trust.prepare.json
   pct exec <vmid> -- sha256sum /etc/mcp/claude-peers-trust/operator-trust.json.new
   ```

5. Remplacer atomiquement le fichier actif :

   ```bash
   pct exec <vmid> -- mv -fT /etc/mcp/claude-peers-trust/operator-trust.json.new /etc/mcp/claude-peers-trust/operator-trust.json
   ```

   Le conteneur lit en uid 1000 : un fichier `root:root` en `0600` est illisible
   et le broker passe en état `invalid`. Le fichier doit rester la propriété de
   root, sans droit d'écriture pour le groupe ni les autres, dans un répertoire
   lui aussi à root, sans écriture groupe ou autres, traversable par l'uid 1000.
6. Depuis l'hôte Proxmox, dans un clone du dépôt de déploiement, pousser les
   fichiers de la stack de `config/mcp-server/` vers `/opt/mcp-server` de la LXC.
   Le compose porte la variable `XDG_CONFIG_HOME` et le volume de la politique,
   que le broker ne reçoit qu'à la recréation du conteneur :

   ```bash
   pct push <vmid> config/mcp-server/docker-compose.yml /opt/mcp-server/docker-compose.yml
   pct push <vmid> config/mcp-server/Dockerfile.claude-peers /opt/mcp-server/Dockerfile.claude-peers
   pct push <vmid> config/mcp-server/stack.sh /opt/mcp-server/stack.sh --perms 0755
   ```

7. Mettre le broker à jour, depuis l'hôte Proxmox, avec `update` et jamais
   `restart` : seul `update` recrée le conteneur et applique variable et volume.
   Le script avertit, sans bloquer (le compose sert d'autres conteneurs), si le
   répertoire ou le fichier est absent ou aux mauvais droits, ou si
   `operator-trust.json` est un répertoire, puis affiche `operator_trust_state`
   lu sur `/health` à la fin de `start`, `restart` et `update`.

   ```bash
   pct exec <vmid> -- bash -c 'cd /opt/mcp-server && ./stack.sh update'
   ```

8. Vérifier l'état chargé, depuis l'hôte Proxmox :

   ```bash
   pct exec <vmid> -- curl -s http://127.0.0.1:7899/health
   ```

   La réponse doit contenir `"operator_trust_state":"ready"`. `./stack.sh status`,
   lancé comme à l'étape 7, affiche la même ligne après une seule tentative. Le
   broker lit la politique une seule fois au démarrage : tout remplacement
   ultérieur du fichier demande le redémarrage décrit plus bas.

États possibles de `operator_trust_state` :

| État | Cause | Action |
|---|---|---|
| `ready` | Politique lue et valide. | Aucune. |
| `unconfigured` | Fichier absent du répertoire monté, répertoire non traversable par l'uid 1000, montage manquant, ou `XDG_CONFIG_HOME` absent de l'environnement du conteneur (compose non appliqué par `update`). | Reprendre les étapes 3 à 7, vérifier le volume et la variable dans `docker-compose.yml`. |
| `invalid` | Fichier illisible (droits), JSON ou clé invalide, ou `operator-trust.json` créé comme répertoire par docker. | Lire le journal du conteneur (`operator trust policy is invalid`), corriger, puis redémarrer le broker comme indiqué plus bas. |

Monter toujours le répertoire, jamais le fichier : docker crée un répertoire à la
place d'un fichier absent, et le broker lit alors `EISDIR` (`invalid`).

Rotation et compromission suivent les sections ci-dessous avec le même geste de
remplacement (étapes 4 et 5). Le conteneur et son volume existent déjà, seul le
fichier change : redémarrer le seul broker, depuis l'hôte Proxmox, avec

```bash
pct exec <vmid> -- bash -c 'cd /opt/mcp-server && docker compose restart claude-peers-broker'
```

et non `./stack.sh restart`, qui redémarre aussi les trois autres conteneurs.

Aucun POST, secret de groupe ou Bearer de réplication ne provisionne la
première clé d'un broker distant.

## Rotation normale

1. Exporter et vérifier la nouvelle clé publique.
2. Préparer une politique complète contenant la nouvelle et l'ancienne clé.
3. Valider le fichier préparé, effectuer le remplacement atomique pendant une
   maintenance, puis redémarrer le broker (sur la LXC, avec
   `docker compose restart claude-peers-broker`, voir « Broker distant sur LXC »).
4. Laisser l'ancienne entrée le temps de terminer ses objets existants.
5. Refaire la procédure avec une politique sans l'ancienne clé, puis
   redémarrer le broker.

La nouvelle identité ne reprend pas les objets ni les tokens de l'ancienne.

## Compromission

1. Arrêter le broker concerné. Sur la LXC, arrêter ce seul conteneur :

   ```bash
   pct exec <vmid> -- docker stop claude-peers-broker
   ```

   Ne pas utiliser `./stack.sh stop` : il supprime les quatre conteneurs
   (`docker compose down`), et `docker compose restart` ne relance pas un
   service supprimé.
2. Retirer immédiatement la clé compromise de la politique complète.
3. Valider le fichier préparé, le remplacer atomiquement et redémarrer le
   broker. Sur la LXC, redémarrer avec `docker compose restart claude-peers-broker`
   depuis `/opt/mcp-server` (commande ci-dessus) ; si `./stack.sh stop` a malgré
   tout été utilisé, relancer par `./stack.sh start`.
4. Considérer toutes les copies de cette même clé comme compromises.

Il n'y a pas de grâce : une clé retirée ne doit plus pouvoir régler de nouvel
objet après le redémarrage contrôlé.
