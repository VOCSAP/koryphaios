# PLAN — Accès mobile LAN (chantiers MB1…MB6)

## Statut (mis à jour en fin de session d'implémentation)

| Lot | État | Notes |
|---|---|---|
| MB1 Bridge | ✅ livré | `shared/companion.ts`, `api-registry.ts`, `companion-server.ts`, `remote-api.ts` ; typecheck + build OK |
| MB2 Appairage | ✅ livré | bouton 📱 + `CompanionDialog`, token à usage unique, cert persistant, lockout, journal |
| MB3 UI mobile | ✅ livré | `MobileNav`/`MobileSheet`/`MobileAgents`/`KeyBar`, refit `visualViewport`, CSS `.is-mobile` |
| MB4 Roadmap + panier | ✅ livré | `RoadmapList`, `shared/hold-gesture.ts` |
| MB5 Canal léger | ✅ livré | bascule `mode: light` sur `visibilitychange` + backpressure `bufferedAmount` |
| MB6 Coquille Android | 🟡 scaffold | `mobile-shell/` documenté ; **non buildé** (pas de SDK Android ici) |
| M3e Graph mode fil | ⏸ reporté | hors périmètre v1 (vue Graph absente de la nav mobile) |

**Vérifié** : `bun test` (544 pass, dont 17 nouveaux), typecheck node+web, build
electron-vite de production, parité i18n.

**NON vérifié (limites de l'environnement, à faire côté opérateur)** :
- End-to-end du pont WS live (lancer l'app Electron demande un affichage ; le
  serveur compagnon se lie à une interface LAN absente du conteneur CI).
- La coquille Android et ses capacités natives (service foreground, verrou
  biométrique + `FLAG_SECURE`, pinning cert) : nécessitent le SDK Android.

**Reste à faire pour une v1 utilisable en production** :
1. Essai réel « téléphone sur le Wi-Fi » (le premier test à l'usage).
2. Implémenter les TODOs natifs de `mobile-shell/README.md`.
3. Décider si M3e (Graph mode fil) rentre en v1.1.
4. Doc opérateur README (comment démarrer l'accès, avertissement cert).

---


Implémentation de `EXPLORATION-mobile-lan.md` (voie C, mode session compagnon
éphémère, coquille Capacitor). Règle d'or : **zéro changement de comportement
pour la fenêtre desktop** — tout le mode mobile est dérivé, activé uniquement
pour un client distant (`isRemote`), jamais pour la fenêtre Electron, même
étroite (classe racine `is-mobile` posée par le client distant, PAS de media
query sur le desktop).

Correspondance avec les lots de l'exploration : MB1=M1, MB2=M2, MB3+MB4=M3a–d,
MB5=canal léger (§4 arrière-plan), MB6=M4 (coquille). M3e (Graph mode fil) est
**explicitement reporté** — trop gros pour atterrir proprement dans ce lot ;
la vue Graph n'apparaît pas dans la nav mobile v1.

## MB1 — Bridge : protocole DeckApi sur HTTPS+WS

- `desktop/src/shared/companion.ts` (pur, bun-testable) : manifeste des
  méthodes DeckApi (`kind: invoke | send | event`, canal), types de trames
  (`hello/welcome/req/res/ev/hb/mode`), garde RFC1918/ULA, constantes
  (heartbeat 5 s, timeout client 12 s), canaux bloqués à distance
  (dialogues natifs, browser/design, contrôle compagnon) + table de tiers
  (0–3, cf. exploration §5.4).
- `desktop/src/main/api-registry.ts` : `regHandle`/`regOn` (wrappent
  `ipcMain.handle`/`.on` ET alimentent une table pour le bridge),
  `broadcast(channel, payload)` (fenêtre + clients WS), `invokeRemote()`.
- `ipc.ts` : bascule mécanique sur le registre ; les événements d'ÉTAT
  passent par `broadcast` (pty:*, sessions:changed, session:thinking/quota/
  attention, workspace:current, config:changed, broker:status, inbox:new,
  graphDrafts:update). Les événements de FENÊTRE restent sur `mainWindow`
  uniquement : menu:*, design:pick, inbox:open, session:focus (le
  superviseur pilote la fenêtre desktop, pas le téléphone).
- `desktop/src/main/companion-server.ts` : serveur HTTPS (cert auto-signé
  persistant, généré via `selfsigned`) + WS (`ws`), bind sur l'interface
  privée détectée, sert le bundle `out/renderer` (message clair si absent en
  dev non buildé), token d'appairage à usage unique → credential de session
  (reconnexion), lockout anti-bruteforce, heartbeat applicatif, journal.
- Préload + DeckApi : `companionStart/Stop/Status` + `onCompanionChanged`
  (desktop uniquement ; bloqués à distance).
- `desktop/src/renderer/src/remote-api.ts` : shim `window.api` sur WS depuis
  le manifeste ; overlay « hôte déconnecté » ; `main.tsx` : bootstrap async
  si `window.api` absent.
- Dépendances desktop ajoutées : `ws`, `selfsigned`, `qrcode-generator`
  (pur JS tous les trois).

## MB2 — Bouton Compagnon + socle sécurité (5.1/5.5)

- Bouton 📱 dans le NavRail (desktop seulement) → modale QR
  (`CompanionDialog.tsx`) : QR de `https://<ip>:<port>/#t=<token>`, état
  (clients connectés), bouton stop. i18n ×3 fichiers.
- Cycle de vie : fermeture app = arrêt serveur (rien à faire, même process) ;
  chaque `companionStart` re-mint le token ; cert stable persisté sous l'état
  app.
- Filtre source non-RFC1918 refusé (HTTP et WS), lockout 10 échecs/10 min,
  entrées journal connexion/déconnexion/refus.

## MB3 — Chrome mobile + vues familles A/B

- Store renderer : `remote` (shim connecté) + `mobile` (remote ET
  pointer:coarse/écran étroit) → classe racine `is-mobile`.
- `MobileNav.tsx` : bottom-tabs 🏠 🖥 🗺 ✉ ⋯ (le « ⋯ » ouvre une sheet :
  Journal, Worktrees, Réglages ; Browser et Graph absents en v1).
- Agents : `TerminalPager` — 1 session plein écran, chips de sessions
  (couleur + badge attention/quota), `KeyBar` xterm (Esc/Tab/Ctrl/flèches/
  C‑c/coller), re-fit sur `visualViewport`.
- Inbox plein écran ; Journal/Worktrees/Settings/Diff : CSS une colonne ;
  boutons masqués à distance : import de plan, export journal (dialogues
  natifs), vue browser.

## MB4 — Roadmap mobile (une colonne + panier)

- `RoadmapList.tsx` : tabs de statut avec compteurs (+ archivées derrière
  ⋯), cartes pleine largeur triées MoSCoW, bottom sheet d'actions
  (Déplacer vers… / Modifier / Process now / File / Archiver ; entrée
  « Soulever »), détail plein écran (réutilise `RoadmapItemModal`).
- Panier flottant : `desktop/src/shared/hold-gesture.ts` (machine à états
  pure du geste appui-long→saisie→mouvement=décrochage, testée bun) +
  plateau de vignettes docké au-dessus des tabs, pose = tap vignette sur la
  colonne cible, undo snackbar, cartes 🔒 non soulevables.
- Mêmes appels IPC que le kanban desktop (aucune nouvelle surface).

## MB5 — Canal léger arrière-plan

- Client : Page Visibility → trame `mode: light` (coupe pty:data/thinking) ;
  retour visible → `mode: full` + ré-hydratation (`listSessions`).
- Serveur : filtre par client + garde-fou `bufferedAmount` (drop des trames
  pty:data au-delà du seuil, signalé une fois au journal).

## MB6 — Coquille Capacitor (scaffold)

- `mobile-shell/` : config Capacitor + page d'amorçage (scan QR → charge
  l'URL de l'hôte), doc de build. **Non compilable dans cet environnement**
  (pas de SDK Android) : livré comme scaffold documenté ; verrou
  biométrique + service foreground notés comme TODO natifs dans son README.

## Tests / vérifs par phase

- bun : manifeste (couverture 1:1 des méthodes DeckApi via `satisfies`,
  unicité des canaux, tier pour chaque canal), garde RFC1918, cycle de vie
  token/lockout (logique pure extraite), machine à états du geste.
- `npm run typecheck` (desktop), `bun test`, smoke check cœur inchangé,
  parité i18n.
