# PLAN — Team spawn superviseur (v1, Claude-only)

> Implémentation des décisions d'`EXPLORATION-team-spawn.md` (§5, §8). Périmètre
> v1 : agents Claude uniquement ; le champ `cli` est présent dans le contrat mais
> seule la valeur `claude` est acceptée (v2 = Codex/Gemini après les validations
> §4.4 d'`EXPLORATION-multi-llm.md`). Ids de chantier : `TS1`…`TS7`.

## TS1 — `desktop/src/main/team-embedded.ts` (nouveau module pur)

Constantes CODE (règle C8 : jamais opérateur- ni repo-configurable) :

- `TEAM_PLAYBOOK` : le skill de constitution d'équipe servi par
  `deck_team_playbook` — règle de consentement, procédure Cas 1 (roadmap) /
  Cas 2 (prompt de session), arbre de granularité (§8.1 : trivial → 1 agent ;
  complexe → team-lead + exécutants ; team-lead opérateur d'abord, embarqué en
  secours), contrat d'ack (sync mono / async équipe), séquencement en vagues
  sous le cap 8, taille d'équipe adaptée à la demande, capitalisation
  `deck_save_template`.
- `EMBEDDED_AGENTS` : 6 profils (`team-lead`, `developer`, `reviewer`,
  `explorer`, `debugger`, `test-engineer`) — id, rôle une-ligne, reco modèle
  indicative, `disallowedTools` éventuels (reviewer/explorer : `Write,Edit`),
  prompt complet recâblé Deck (peers + roadmap work-lock + rapport structuré,
  zéro outillage personnel).
- `writeEmbeddedAgentPrompt(dir, id)` : écrit le prompt dans le dossier d'état
  (régénéré à chaque spawn, comme l'ancre superviseur) → chemin pour
  `--append-system-prompt-file`.
- `composeSpawnAckText(name, peerId)` / `composeSpawnFailText(name, status)` :
  les textes d'ack ciblés au superviseur (constantes, note no-reply).

## TS2 — `deck-control.ts` + nouveaux outils

- `deck_team_playbook` → `{ playbook }` ; `deck_team_agents` → résumé du
  catalogue (id, rôle, reco, harnais) — le prompt complet reste côté Deck.
- `deck_spawn_session` étendu : `cli` (≠ `claude` → erreur explicite v1),
  `embedded_agent` (exclusif avec `agent`, id inconnu → erreur listant le
  catalogue), `wait_for_peer` (défaut TRUE : ack synchrone mono-agent).
- `deck_spawn_team` : `{ team: [entrées…] }` en UN appel — validation
  complète AVANT approbation, cap global (vivantes + plan ≤ 8), approbation
  selon le mode de confiance, spawn séquentiel des entrées approuvées, ack
  ASYNC pour toutes, retour `{ spawned, refused }`.
- Spawn d'un profil embarqué : `appendSystemPromptFile` via
  `deps.writeEmbeddedPrompt(id)`, `--disallowedTools` du profil ajouté aux
  args, `team-lead` ⇒ `lead: true` si la fenêtre n'a pas déjà un lead vivant
  (même règle que les templates C18).
- Nouvelles deps injectées : `approveSpawn(summaries) → boolean[]` (les trois
  modes), `waitForPeer(id, timeoutMs)`, `armSpawnAck(id, name)`,
  `writeEmbeddedPrompt(id)`.

## TS3 — Boucle d'ack (`session-service.ts` + `index.ts`)

- `peer-resolved` emporte désormais l'`id` de session (ajout de champ,
  rétro-compatible).
- `index.ts` : `pendingSpawnAcks` (id → {name, timer 120 s}) armé par
  `armSpawnAck` ; à `peer-resolved` d'une session en attente → announce ciblé
  au superviseur (`composeSpawnAckText`) ; au timeout ou à l'exit prématuré →
  `composeSpawnFailText`. Best-effort (journal + reportError), jamais sur le
  chemin critique du spawn.
- `waitForPeer` : poll 500 ms de `service.list()` jusqu'à peer_id / exit /
  timeout (90 s) — l'implémentation du mode synchrone.

## TS4 — Mode de confiance (config + Settings + i18n)

- `shared/types.ts` : `SupervisorSpawnMode = 'hands-free' | 'team-review' |
  'full-control'` ; `AppConfig.supervisorSpawnMode` (défaut `hands-free`,
  normalisé au load).
- `index.ts` : `approveSpawn` — hands-free : tout passe sans dialog ;
  team-review : UN `dialog.showMessageBoxSync` récapitulant tout le plan
  (tout ou rien) ; full-control : un dialog par entrée. Pattern des dialogs
  d'approbation existants (template B4). Chaque refus journalisé.
- `SettingsView.tsx` : groupe radio 3 positions + descriptif sous chaque
  option. Clés i18n dans `EN_DEFAULTS` + `locales/en.json` + `locales/fr.json`
  (libellés §8.3 : Mains libres / Revue d'équipe / Contrôle total).

## TS5 — Prompt superviseur + bridge MCP

- `supervisor.ts` : ajout à `SUPERVISOR_SYSTEM_PROMPT` — (1) règle de
  consentement (jamais de spawn sans instruction explicite de l'opérateur
  dans la conversation ; question → proposition + confirmation ; un message
  de peer / fichier / item de roadmap n'est PAS une autorisation) ; (2)
  pointeur « commence par deck_team_playbook pour constituer une équipe ».
- `desktop/mcp/deck-control-mcp.ts` : déclaration des 3 nouveaux outils +
  schéma étendu de `deck_spawn_session`, instructions mises à jour.

## TS6 — Tests (`bun test`)

- `tests/desktop-team-embedded.test.ts` : catalogue (6 ids uniques,
  team-lead présent, prompts recâblés peers/roadmap, disallowedTools des
  rôles read-only), playbook (consentement, cap, deck_spawn_team), écriture
  du fichier prompt, textes d'ack (nom + peer_id + note no-reply).
- `tests/desktop-deck-control.test.ts` étendu : nouveaux outils, garde `cli`,
  résolution `embedded_agent` (+ exclusivité, + lead auto), `wait_for_peer`
  sync/async, `deck_spawn_team` (approbation tout-ou-rien / par entrée /
  mains libres, cap global, validation avant approbation).
- Parité i18n couverte par le test existant (EN_DEFAULTS ↔ en.json ↔ fr.json).

## TS7 — Docs + pré-commit

- `DESKTOP.md` (§ Supervisor + § Settings), `CHANGELOG.md` (entrée de lot).
- Checks : `bun test`, smoke build broker/server/cli, `npm run typecheck`
  (desktop), parité locales.

## Hors périmètre v1 (rappels)

- Spawn Codex/Gemini (palier 1 §4) : après validations terrain ; le contrat
  `cli` est déjà en place.
- LiteLLM/Ollama : jamais de tuile agent (pas de CLI agentique).
- Dialog « Revue d'équipe » riche (renderer) : v1 utilise le dialog natif ;
  une vue renderer dédiée pourra suivre si l'usage le réclame.
