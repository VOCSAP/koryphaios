# Choregos : recadrage de L2 sous version minimale

Date : 2026-10-21. Carte : f732182b. Statut : proposition de découpage, pas une activation. Le détail est séparé du contexte de carte à la demande du team-lead. Ce brief distingue les sondes L2, la finition V1 de Prosopon et la qualification côté Kory.

## Problème et décision déjà acquise

**MESURÉ**, `roadmap_get(ab5ae18c)` : « Une version égale ou supérieure à une version minimale validée active le plugin. » Cette décision opérateur remplace la certification exacte, pas les obligations de sûreté du rendu. Les releases futures s'activent sans qualification préalable ; les captures ne prouvent que les versions et scénarios effectivement observés. Un mauvais rendu qui ne lève aucune exception ne déclenche pas nécessairement R7.

**Proposition** : conserver les sondes quota, deux copies, composition, corpus réel et oracle. Garder un CLI épinglé pour la reproductibilité de CI, avec le minimum supporté comme référence. Ne recréer ni liste blanche de versions certifiées, ni revalidation bloquante à chaque mise à jour.

## Structure actuelle et frontières

Chemins `choregos:` relatifs au dépôt `VOCSAP/choregos`, chemins `kory:` relatifs à Koryphaios.

- **DÉDUIT**, `choregos:plugins/prosopon/hooks/versions.ts:3-26` : `MIN_SUPPORTED` vaut `2.1.303` pour `layout` et `links`, avec comparaison numérique ; versions absentes, invalides, anciennes ou `-dev` refusées. `choregos:CONTRACT.md:5-14` borne R1/R2/R3/R5/R8 aux ajouts du plugin, et maintient R4 sur le contenu de quota.
- **DÉDUIT**, `choregos:plugins/prosopon/hooks/register.tsx:29-39,46-70` : le hook courant traite `AssistantMessage`, produit le cadre directement, et laisse `dim` en stock. Le code lu ne réalise donc pas à lui seul la V1 UserMessage/TurnDuration/libellés décrite par `kory:docs/DESIGN-READABLE-PLUGIN.md:104-106,174-187`. Ne pas présenter une qualification de ce squelette comme livraison de la V1 complète.
- **DÉDUIT**, `choregos:plugins/mitos/hooks/register.ts:11-34` : Mitos réécrit le texte puis appelle `next`. Prosopon peut répondre par un arbre sans appeler `next` ; leur composition dépend donc de l'ordre réel, à sonder plutôt qu'à supposer.
- **DÉDUIT**, `kory:desktop/mods/choregos.lock.json:2-8` : le snapshot Prosopon pointe déjà sur `67d3fe6`, qui porte la version minimale. `kory:tests/desktop-mods.test.ts:253-346` construit les cadres synthétiquement, utilise un composeur réel à une largeur et teste des chaînes de quota ; ce n'est pas une capture de la V1 peinte par le CLI.
- **DÉDUIT**, `kory:.github/workflows/desktop-build.yml:120,129` et `choregos:.github/workflows/ci.yml:72-74` : Kory et Choregos épinglent tous deux `2.1.303` (Kory épinglait `2.1.293` avant le lot K1). `kory:desktop/src/main/statusline-settings.ts:38-43` impose `tui: 'default'` et `CLAUDE_CODE_NO_FLICKER: '0'` : les captures de référence doivent reproduire ces réglages.

La source des plugins et les tests de leurs arbres restent dans Choregos. Kory consomme des commits identifiés, maintient son oracle et affirme les verdicts de sa propre garde. Ne pas copier la garde dans Choregos, ni modifier le snapshot à la main.

## Options et recommandation

**Option A : qualifier le squelette, finir la V1 plus tard.** Coût initial faible, pas de modification de rendu préalable ; impact limité au harnais et retour arrière simple. Risque : appeler cela « L2 terminé » masque les surfaces non livrées et exige une nouvelle capture après la V1.

**Option B : sondes exploratoires maintenant, finition V1 distincte, qualification finale ensuite.** Coût initial supérieur, mais chaque capture finale nomme le rendu réellement distribué. Impact de production limité à Choregos, garde Kory inchangée ; rollback par commit du snapshot. Risque de dépendance à une sonde réelle de quota, à rendre explicite plutôt que remplacée par un exemple fabriqué.

**Recommandation : B.** Le facteur décisif est l'identité de l'artefact testé, pas son admissibilité semver. Les sondes C1 et l'alignement K1 peuvent démarrer en parallèle ; la clôture du corpus K2 dépend du candidat V1 C2. Une observation sur le squelette reste utile mais ne vaut pas preuve sur les branches ajoutées ensuite.

## Lots exécutables

### C1 : sondes de runtime, Choregos, debugger + test-engineer

**Périmètre** : conserver la source de production inchangée pendant l'observation. Étendre les tests existants sous `plugins/prosopon/tests/` et `plugins/mitos/tests/` si une sonde devient un garde. Ajouter un protocole reproductible dans `docs/L2-PROBES.md` de Choregos, avec scripts de sonde isolés seulement si nécessaires.

1. Identifier le vrai chemin de rendu d'un quota : composant reçu, texte avant/après, sortie PTY native/plugin et entrée du détecteur Kory. Ne pas épuiser délibérément un abonnement. Sans événement réel disponible, distinguer le test injecté de la capture réelle et laisser cette preuve ouverte.
2. Installer dans un profil jetable une copie A et charger une copie B du même plugin par `--plugin-dir`, avec des marqueurs distincts ; observer la copie gagnante et le nombre réel de hooks exécutés. Ne pas toucher aux plugins ou réglages globaux de l'opérateur.
3. Charger Prosopon/Mitos seuls, ensemble dans les deux ordres de `--plugin-dir`, puis comme installations marketplace. Observer les appels `next`, les cadres et les URI finales, pas seulement le succès du chargement. Consigner un ordre reproductible ou la dégradation observée ; aucun changement de protocole inter-plugin sans nouveau cadrage.

**Acceptation** : exécutable/version et commits identifiés, chemins des copies connus, contrôles stock et plugin visibles, effet distinct de chaque copie, lien Mitos conservé dans l'ordre annoncé, comportement opposé documenté. Les sondes exploratoires ne certifient pas le futur rendu C2.

**Mutations à tuer dans les gardes retenus** : bypass R4 qui encadre le quota ; double exécution du même hook ; ordre inversé ou retour anticipé qui supprime Mitos. Une simple permutation de données est un scénario, pas une mutation de source ; le compte rendu doit nommer la source effectivement mutée sur miroir.

### C2 : finition V1, Choregos, developer

**Ce lot est distinct du corpus L2.** Fichiers : `plugins/prosopon/hooks/register.tsx`, `layout.ts`, tests existants de Prosopon, `CONTRACT.md` et README concernés. La distinction final/intermédiaire de 574feb89 reste hors périmètre.

Réaliser le contrat V1 déjà accepté : cadre UserMessage réservé à l'origine composer, libellés, règle TurnDuration, branches de repli et R4. Préparer `dim` dans une copie candidate ; l'activer seulement après capture différentielle native/candidate aux frontières de wrap. Si la preuve échoue, garder stock et signaler la V1 partielle, ne pas déclarer `dim` livré. Les restrictions nouvelles sur le Markdown de l'agent exigent un cas démontré, pas un retour au filtrage généralisé écarté par l'opérateur.

**Acceptation** : arbres montés vérifiant chaque branche, `next(e)` pour notification/quota/entrée invalide, résumé natif tant que `dim` n'est pas prouvé ; R6/R7 conservés. La version minimale accepte aussi une release supérieure non listée. Le rendu visuel candidat est enregistré avec `default` et son commit ; aucun verdict `clear` revendiqué par Choregos seul.

**Mutations** : origine composer ignorée ; quota encadré ; coins single remplacés par round ; règle de largeur égale à celle du terminal ; `dim` activé sans repli ; égalité exacte ou comparaison lexicale remplaçant R6 ; erreur supprimant le repli natif.

### K1 : référence de CI, Koryphaios, developer

Fichier : `.github/workflows/desktop-build.yml`, installation ET garde de version. Passer au minimum `2.1.303`, déjà référence de la CI Choregos. Vérifier sur le binaire installé les validateurs et tests de plugins concernés ; ne pas confondre pin d'outillage et autorisation runtime. Pas de matrice exhaustive des patches futurs, pas de `latest` flottant.

**Acceptation** : installation et sortie réelle `claude --version` concordent ; le garde refuse un exécutable discordant. La preuve de compatibilité runtime au-dessus du minimum reste dans les tests R6, pas dans l'égalité de ce garde de CI.

**Mutations** : installation seule mise à jour sans sa garde ; garde neutralisée qui accepte le mauvais binaire. Réutiliser les contrôles de CI existants, pas un test qui ne recherche que le texte `2.1.303`.

### K2 : snapshot et corpus de sûreté, Koryphaios, test-engineer + developer

Dépend de C1, C2 et K1 pour sa clôture. Fichiers : `scripts/sync-mods.ts` comme outil de consommation, `desktop/mods/prosopon/`, `desktop/mods/choregos.lock.json`, `tests/pty-harness/fixtures/`, `tests/_fixture-verdicts.ts`, `tests/desktop-mods.test.ts`, consommateurs de fixtures `desktop-xterm-screen.test.ts` et `desktop-attention.test.ts`, tests de quota existants. Ne modifier le synchroniseur que si un défaut de consommation est démontré ; pas de resync redondant de `67d3fe6`.

- Synchroniser le commit candidat validé, puis capturer avec une COPIE DE TRAVAIL de ce snapshot. Aucun lancement `--plugin-dir` sur `desktop/mods` : la contrainte de génération de types est consignée dans l'append f732182b du 2026-10-20 à 13:01. Vérifier l'empreinte distribuée avant/après la sonde.
- Captures PTY réelles en rendu `default`, à 40 et 80 colonnes, 120 comme témoin ; session neuve et reprise, cadres UserMessage/AssistantMessage, résumé, fin de tour, `/clear`, pause et dialogues/pickers réels avec cadres présents. Fixer le profil, les prompts synthétiques et les options ; noter la version CLI effectivement utilisée, les commits et la géométrie.
- Vérifier les deux sens : composeur au repos avec cadres = `clear` ; permission/picker réel avec cadres au-dessus ou entre dialogue et composeur = `modal`. Préserver les verdicts existants ; les nouvelles valeurs de l'oracle viennent d'un scénario relu, pas de la sortie du détecteur qu'on prétend tester. Conserver la preuve quota native/plugin et le test de son détecteur.
- Rejouer à la géométrie capturée dès le premier octet. **DÉDUIT**, `tests/desktop-xterm-screen.test.ts:39-59` démarre à 120 colonnes et traite les marqueurs RESIZE ; `tests/desktop-attention.test.ts:608-625` les ignore dans son extraction des pickers. Auditer et aligner les lecteurs de nouvelles fixtures avant d'annoncer une preuve à 40/80. Ne pas modifier les détecteurs de production pour compenser un harnais mal dimensionné.
- Captures publiques : profil jetable, données synthétiques, scan de secrets avant intégration, réduction documentée sans altérer les séquences ou checkpoints décisifs. Aucun token ou contenu privé dans le corpus. Retirer le corps sensible ne suffit pas si les métadonnées le conservent.

**Acceptation** : deux sens prouvés à 40 et 80 colonnes sur le candidat C2 nommé, lecteurs de fixtures alignés sur la géométrie capturée, verdicts existants inchangés, empreinte du snapshot inchangée après capture, scan de secrets vert sur les nouvelles fixtures.

**Mutations** : snapshot altéré non détecté ; chargement de la copie distribuée au lieu de travail ; replay forcé à 120 ; oracle privé d'une nouvelle fixture ; branche de garde rendant `clear` en présence d'un cadre malgré un vrai dialogue ; bypass R4. Muter uniquement en miroir, jamais affaiblir durablement la garde. Pour le rendu réellement peint, une mutation du plugin exige de recapturer son effet : muter la source ne change pas une fixture figée.

## Clôture et décisions opérateur

**Proposition de clôture L2** : C1, K1 et K2 complets sur le candidat C2 nommé ; origine du quota documentée ; résolution de deux copies et ordre de chaîne connus ; vrais dialogues toujours refusés ; limites du corpus explicites. Les workers exécutent les fichiers ciblés ; le séquenceur seul exécute le gate complet avant commit. L3 (copie de travail distribuée, packaging/sandbox) et L4 (activation opt-in validée visuellement) restent distincts.

Aucune nouvelle décision nécessaire pour conserver les sondes ou le minimum déjà ratifié. Trois situations seulement remontent à l'opérateur : abandon ou réduction de V1 ; compromis visible imposé par la composition des deux plugins ; absence persistante de preuve quota empêchant l'activation. Ni un changement silencieux de la garde, ni le retour à la certification exacte ne sont des solutions autorisées par ce brief.
