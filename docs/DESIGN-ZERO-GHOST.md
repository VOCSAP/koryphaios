# 56689093 : brief developer de A, nettoyage conservateur

**Implémenter le lecteur dans le PermissionRequest vivant ; ne pas activer 2b dans ce lot.**

## Problem framing

**SUPPOSÉ, arbitrage opérateur relayé par le lead le 2026-10-08 :** « mesurer la porte d'identité, puis A, puis 2b ». Cible : retirer notre ligne après la fin identifiée de l'outil, jamais conjecturer une réponse terminale. Limites explicites sous 2b : **« identiques = fantôme jusqu'à la fermeture de la tuile »** et **résultat déjà présent avant acquisition = fantôme conservé**, sauf règlement explicite ou autre fin du producteur. Avant 2b, garder le plafond actuel. Ce n'est pas zéro fantôme universel.

## Current structure

**DÉDUIT**, `desktop/hooks/approval-hook.ts:230-290,388-396` : bail admis → projection du payload → add → conservation locale de `{id, producer_secret}` → wait. Le contexte transcript doit rester local, séparé de `buildApprovalRequest`. **DÉDUIT**, `approval-hook.ts:293-365` : le retrait409 peut actuellement rouvrir une lecture décisionnelle ; interdire cette branche après fin observée.

**DÉDUIT**, `broker.ts:9505-9532` : `POST /approval/withdraw` résout l'objet par `authorizeTarget(...,[id])`, vérifie scope, secret producteur et ligne non fusionnable ; `pending`/`expired_notif` deviennent `answered_terminal`, déjà réglé rend409. Réutiliser `runApprovalClient("withdraw", JSON.stringify({id, producer_secret}), ...)`. **Aucune nouvelle route, table ou modification broker prévue.**

## Options et recommendation

Coûts **SUPPOSÉS**, hors sondes : **A, lecteur local : 4 à 8 h**, retour arrière dans le hook, risque de mauvaise association à garder fermé. **B, file Pre/PR/Post : 1 à 2 jours**, claims/stockage/nettoyage et producteurs supplémentaires à débrancher ; une FIFO ne prouve pas l'identité. **Recommandation : A resserrée ci-dessous**, plus petite surface, sans transfert de secret à un autre processus. Le faux retrait est plus grave qu'une ligne conservée.

## Target design & migration path

### 1. Porte d'identité dans `permission-transcript.ts` (nouveau)

Contrat à implémenter, pas comportement livré. Ajouter `transcript_path`, `prompt_id`, `agent_id` au payload typé ; transmettre un contexte local au lecteur, jamais au broker. Un homonyme satisfait **toutes** les conditions :

| Porte | Règle et test discriminant |
|---|---|
| **(a) Fichier propre** | `agent_id` présent : exactement `<transcript sans .jsonl>/subagents/agent-<agent_id>.jsonl` ; sinon `transcript_path`. Valider le segment agent, sans traversée. Test : parent + deux enfants, mêmes input/prompt ; seul fichier exact éligible, enfant absent jamais remplacé par parent. `agent_type` n'est pas une clé. |
| **(b) Appel complet** | Même `tool_name`, égalité profonde du `tool_input` COMPLET. Tests : ordre des clés sans effet ; propriété supplémentaire, types, ordre des tableaux et différence après160 caractères changent le verdict. Aucun résumé/préfixe/titre. |
| **(c) Ascendance** | La chaîne `parentUuid` atteint une ligne dont `promptId === prompt_id` complet. Tests : plusieurs sauts valides ; prompt étranger, chaîne manquante/cyclique ou UUID contradictoire refusés. |

**Resserrement nécessaire : compter tous les homonymes, terminés compris.** Ensemble local de `tool_use_id`, jamais réduit : dès deux, désarmer définitivement l'observateur. Acquérir une seule fois un unique candidat **encore sans résultat**, puis suivre uniquement son tuid. Unique déjà terminé au premier scan : ne pas adopter rétrospectivement. Vérifier l'ambiguïté avant de consommer un résultat du même passage. Coût assumé : les répétitions séquentielles identiques d'un même prompt perdent aussi le nettoyage automatique.

### 2. Boucle, bail et clôture

1. Après admission du bail, observer **dans le PR existant**, parallèlement à add/wait, sans retarder l'affichage. Zéro candidat : poll sans budget court de recherche tant que le flux vit ; avant2b, son budget actuel reste actif. Passages asynchrones sans chevauchement, travail/mémoire bornés ; cadence proposée250ms, pas une garantie de complétude.
2. **Ambiguïté : arrêter le lecteur seulement**, garder approbation et bail actifs. Fichier initialement absent : attendre ce fichier. Fragment : différer toute décision jusqu'à lecture complète. Rotation/troncature/compaction détectée, limite atteinte, journal invalide : désarmer, jamais conclure sur un sous-ensemble. Tracer une fois via le sink du hook, sans contenu ni secret.
3. **Verdict valide :** disposer le lecteur, recontrôler bail et clôture locale avant stdout. **Tool_result du tuid acquis :** verrou local irréversible interdisant tout verdict, abort du wait, retrait de notre id/secret sous signal neuf borné à2s, exit0 sans stdout. Si add est en vol, retirer dès réception de son id.409 est terminal : pas de late-read. Réponses réseau tardives et exceptions respectent le même verrou.
4. **Perte du bail / mort de tuile :** même arrêt sans verdict et retrait borné, sans second détecteur de vie. **DÉDUIT**, `desktop/hooks/permission-lease.ts:85-130` : disparition, identité/fraîcheur invalide ou séquence arrêtée invalident irréversiblement son signal. Réutiliser le bail `5eb3868` ; disposer les ressources sur toutes sorties, sans dépendre de `finally` après kill dur. Le nettoyage broker du producteur absent reste le repli No/Échap.

### 3. Preuves et matrice complémentaire

**MESURÉ ici, relecture d'archives, pas relance PTY :**

- `bun C:/Users/Olivier/.agent-forge/scratch/56689093/history.cjs T7-seq-ident-3 T7-seq-ident-4` → `PR2: matching tool_use=2 -> HISTORY(result 1639ms before PR) | CURRENT(result 1798ms after PR)` ; second essai : résultat précédent1655ms avant PR2. Causalité séquentielle observée2/2, pas garantie générale.
- `bun C:/Users/Olivier/.agent-forge/scratch/56689093/states.cjs T9-late-flush-yes` → `PermissionRequest-1 +20024ms tr-state lines=25 resolved=1 unresolved=eLCBRD[Write msg=KzBq7C par=f1f6b085 pr=0c266f4f main]`. Le Bash est déjà terminé lors de sa première visibilité ; la règle conservatrice le laisse non corrélé.

**SUPPOSÉ ici, mesures tierces corrigées par -10 :** visibilité retardée15ms à88s, aucun préfixe partiel observé sur13 runs N=2/3 ; «21 corrects/0 faux» signifie **5 identités indépendamment vérifiées +16 cohérentes**, pas21 preuves du contrat. **DÉDUIT**, `scratch/56689093/identity.cjs:31-33,43-50` : comparaison tronquée et vérité souvent par rang Post ; ne pas recycler ce script comme test de l'égalité complète. Challenge : filtrage des terminés réfuté ; version resserrée conditionnée au modèle de publication observé, non garantie universelle.

| Groupe de tests à ajouter | Résultat exigé |
|---|---|
| Unicité et journal | Deux/trois identiques dont un déjà terminé au premier scan ; ambiguïté jamais réarmée ; résultat préexistant non adopté ; attente>300ms ; fragments/rotation/compaction/limites ne fabriquent aucune unicité. |
| Cycle et courses | Résultat pendant add/wait ; ligne du frère toujours pending ; verdict/résultat/bail concurrents ;409 sans late-read ; réseau coupé ; aucun stdout après clôture observée, aucun timer après fin. |

**Livraison :** modifier `desktop/hooks/approval-hook.ts`, créer `desktop/hooks/permission-transcript.ts`, modifier `tests/approval-hook.test.ts`, créer `tests/permission-transcript.test.ts`. Régénérer le bundle par le build existant ; aucun Pre/Post, service main ni changement `hooks.json`. Tests ciblés prévus : `bun test ./tests/permission-transcript.test.ts`, puis `bun test ./tests/approval-hook.test.ts`. Aucun test produit exécuté pour ce lot documentaire.

## Open questions for the supervisor

**Avant2b :** faire valider les deux résidus nommés en tête, puis preuve PTY du vrai hook avec bail et paquet effectif : Yes long, No/Échap, identiques et sous-agent. Restent à mesurer : Edit/Write complet, N>=4, compaction/rotation, macOS/Linux et ancien appel ouvert pendant PR d'un message suivant (arrière-plan/reprise). Les captures actuelles n'établissent pas ces garanties. **DÉDUIT**, `docs/DESIGN-PERMISSION-LEASE.md:198,233` : renouvellement du credential et portes de vie du bail restent préalables à2b ; ce brief ne les lève pas. Le transcript reste une observation coopérative, pas une frontière de sécurité contre le compte OS.
