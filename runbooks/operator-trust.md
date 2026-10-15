# Runbook : provisionner la confiance opérateur du broker

## Objet et limite du lot

`operator-trust.json` contient les clés publiques Ed25519 autorisées pour un
profil d'administration du broker. Il est frère de `config.json` :

- Windows : `%APPDATA%\claude-peers\operator-trust.json` ;
- Linux et macOS : `$XDG_CONFIG_HOME/claude-peers/operator-trust.json`, ou
  `~/.config/claude-peers/operator-trust.json` sans `XDG_CONFIG_HOME`.

Le fichier n'appartient ni à un dépôt, ni au `userData` du Deck. La commande
`init` ne crée que ce chemin global et ne l'écrase jamais. Ce lot prépare le
contrat et l'administration locale ; le refus des clés inconnues devient actif
avec la garde broker du lot suivant.

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

Déduit du code, confirmé par mesure au lot 4 : dans cette topologie, le broker
distant ne reçoit que les routes de synchronisation sous Bearer. Il ne reçoit
pas la signature opérateur d'origine. Provisionner le distant séparément si ses
routes opérateur doivent accepter cette identité.

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

1. Recevoir la clé publique et son empreinte par le canal administratif retenu.
2. Se connecter à la LXC avec le compte de service du broker. Utiliser le même
   profil global que celui qui lance le broker.
3. Installer un `operator-trust.json` préparé à côté de sa configuration
   globale, avec des permissions privées sur le fichier, son répertoire et ses
   parents.
4. Lancer `bun cli.ts operator-trust validate` et
   `bun cli.ts operator-trust fingerprints` dans ce profil.
5. Redémarrer le service de façon contrôlée.

Aucun POST, secret de groupe ou Bearer de réplication ne provisionne la
première clé d'un broker distant.

## Rotation normale

1. Exporter et vérifier la nouvelle clé publique.
2. Préparer une politique complète contenant la nouvelle et l'ancienne clé.
3. Valider le fichier préparé, effectuer le remplacement atomique pendant une
   maintenance, puis redémarrer le broker.
4. Laisser l'ancienne entrée le temps de terminer ses objets existants.
5. Refaire la procédure avec une politique sans l'ancienne clé, puis
   redémarrer le broker.

La nouvelle identité ne reprend pas les objets ni les tokens de l'ancienne.

## Compromission

1. Arrêter le broker concerné.
2. Retirer immédiatement la clé compromise de la politique complète.
3. Valider le fichier préparé, le remplacer atomiquement et redémarrer le
   broker.
4. Considérer toutes les copies de cette même clé comme compromises.

Il n'y a pas de grâce : une clé retirée ne doit plus pouvoir régler de nouvel
objet après le redémarrage contrôlé.
