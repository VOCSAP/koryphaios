# EXPLORATION — Accès LAN à la fenêtre desktop depuis un mobile

> Travail exploratoire (pas de code) mené depuis `experimental`. Question posée :
> est-il possible de rendre accessible, sur le réseau LAN uniquement, la fenêtre
> desktop complète de Koryphaios sur un appareil mobile ? Scénario cible :
> l'app tourne sur le PC, l'opérateur « bascule » sur son téléphone pour
> continuer à piloter le deck. LAN only — jamais exposé sur le WAN.

## TL;DR

**Oui, c'est faisable, et l'architecture actuelle s'y prête remarquablement
bien** — mais pas par la voie « miroir de la fenêtre ». Le renderer est déjà
une web-app pure (React 19 + zustand + xterm.js) dont l'**unique** porte vers
Electron est l'objet `window.api` du préload (`desktop/src/preload/index.ts`,
187 lignes, ~70 canaux `invoke` + ~25 canaux push + 2 fire-and-forget). Servir
ce même bundle web sur le LAN et remplacer `window.api` par un shim WebSocket
donne le « vrai » deck dans le navigateur du téléphone, avec les terminaux
live, la roadmap, l'inbox, le graphe — tout sauf le navigateur embarqué
(`<webview>`, intrinsèquement Electron).

Le point dur n'est **pas** technique, il est **sécuritaire** : exposer
`pty:input` sur le LAN, c'est exposer un shell arbitraire sous l'identité de
l'utilisateur du PC. L'appairage (token + QR code) est non négociable.

En attendant, la réponse « zéro code » existe déjà : un outil de streaming
d'écran LAN (Sunshine/Moonlight, RustDesk en mode direct, VNC) rend la fenêtre
telle quelle — utilisable dès ce soir, mais illisible sur un écran 6".

## 1. État des lieux — ce que l'architecture donne déjà

### 1.1 Le renderer est une web-app pure ✅

Vérifié sur `experimental` :

- **Aucun `import 'electron'` dans le renderer** (grep négatif sur
  `desktop/src/renderer/src/`). React 19, zustand, xterm.js (rendu canvas/DOM ;
  l'addon WebGL est en devDependency mais **pas importé**), CSS custom
  properties. Tout cela tourne dans n'importe quel navigateur mobile moderne.
- **Un seul point de contact avec Electron** : `window.api` (type `DeckApi`,
  `desktop/src/shared/types.ts`), exposé par `contextBridge` dans
  `desktop/src/preload/index.ts`. La surface est propre et entièrement typée :
  - ~70 méthodes requête/réponse (`ipcRenderer.invoke`) — sessions, config,
    workspaces, roadmap, worktrees, graphe, templates, snippets, journal…
  - ~25 abonnements push (`subscribe`/`multiplex`) — `pty:data`, `pty:exit`,
    `sessions:changed`, `inbox:new`, `broker:status`, `menu:*`…
  - 2 fire-and-forget (`ptyInput`, `ptyResize`) — le chemin chaud clavier.
- **Chargement** : `mainWindow.loadFile(out/renderer/index.html)` en prod,
  dev-server Vite en dev (`desktop/src/main/index.ts:847-850`). Le bundle
  buildé est donc un site statique auto-suffisant.
- **Émission côté main très centralisée** : 14 sites `webContents.send` au
  total, tous dans `index.ts` et `ipc.ts`. Un fan-out vers des clients
  WebSocket en plus de la fenêtre se greffe en un point.

Conséquence directe : « rendre la fenêtre accessible » ne demande **pas** de
transporter des pixels — il suffit de transporter le **protocole DeckApi**.
Le téléphone fait tourner sa propre instance du renderer.

### 1.2 Précédents architecturaux dans le process main ✅

Le main process héberge déjà deux serveurs HTTP node:http, dependency-free et
testés :

| Serveur | Fichier | Modèle de sécurité |
|---|---|---|
| deck-control (superviseur) | `desktop/src/main/deck-control.ts` | 127.0.0.1, port aléatoire, Bearer token par lancement, jamais persisté |
| design endpoint (D2b) | `desktop/src/main/design-endpoint.ts` | idem + CORS, corps size-cappés et shape-checkés |

Un troisième serveur « accès mobile » suivrait exactement ce patron — à une
différence près, majeure : il écouterait sur une interface LAN, ce qui change
le domaine de menace (voir §5). Côté WebSocket, le broker (`broker.ts`) fournit
déjà un précédent complet d'upgrade WS authentifié par token
(`tests/broker-ws-auth.test.ts`).

### 1.3 Ce que le broker ne résout PAS ❌

Intuition tentante : « le broker est déjà accessible en HTTP sur le LAN, il
n'y a qu'à passer par lui ». Non : le broker est le plan de **contrôle**
(peers, messages, roadmap partagée). Le plan de **données** du deck — les PTYs
(`pty-manager.ts`, node-pty), la config, les workspaces, le graphe chiffré, les
worktrees — vit dans le process main d'Electron, sur le PC. Le mobile doit
parler au PC directement ; router les octets de terminal par le broker serait
contraire à sa philosophie outbound-only (documentée en tête de
`design-endpoint.ts`) et ajouterait un intermédiaire inutile sur un flux local.

### 1.4 Briques UI mobiles déjà présentes 🎁

- **Mode d'affichage `1×1`** (`DisplayModeBar.tsx`, `config.displayMode`) : la
  vue « une tuile plein écran » existe déjà — c'est exactement le mode
  naturel d'un téléphone (une session à la fois + un moyen de basculer).
- **NavRail** : la navigation par rail d'icônes se transpose trivialement en
  bottom-tab-bar mobile.
- **i18n** complet (3 fichiers, parité testée) et thème par CSS variables :
  aucune friction pour une variante de layout.
- **État déjà événementiel** : le store zustand s'hydrate par `listSessions`/
  `getConfig`/… puis vit sur les pushs (`sessions:changed`, etc.). Deux clients
  simultanés (fenêtre PC + téléphone) convergent naturellement — le multi-écran
  est presque gratuit sur le plan données.

## 2. Les trois voies possibles

### Voie A — Zéro code : streaming d'écran générique

Sunshine + Moonlight, RustDesk (connexion directe IP), ou un VNC classique,
bornés au LAN par leur config ou par le pare-feu.

- ✅ Disponible immédiatement, fidélité 100 % (y compris `<webview>`).
- ✅ LAN-only réalisable (bind interface locale, règles pare-feu).
- ❌ UX mobile très mauvaise : la fenêtre desktop (rail + sidebar + tuiles
  xterm à DPI desktop) est illisible sur 6" ; le clavier virtuel ne fait pas
  de Ctrl/Esc proprement ; latence de frappe perceptible dans un terminal.
- ❌ Aucune intégration produit (pas d'appairage, pas de notion de session).

**Verdict : le bon dépannage court terme, pas une feature.** À documenter dans
le README comme solution intérimaire, rien de plus.

### Voie B — Pixel streaming intégré à l'app

L'app capture sa propre fenêtre (`desktopCapturer` / offscreen rendering),
streame en WebRTC/MJPEG vers une page servie sur le LAN, et réinjecte les
interactions via `webContents.sendInputEvent`.

- ✅ Fidélité totale, zéro refactor du renderer.
- ❌ On hérite de TOUS les défauts de la voie A (lisibilité, clavier, latence)
  en payant en plus le coût de développement d'un pipeline vidéo + injection
  d'input — la partie la plus complexe et la plus fragile d'Electron.
- ❌ « Basculer en mode mobile » est impossible par construction : on streame
  la mise en page desktop, point.

**Verdict : la pire des deux mondes. À écarter.**

### Voie C — Web remoting du renderer (recommandée) ⭐

Le main process sert le bundle renderer buildé en HTTP sur le LAN + un
WebSocket qui transporte le protocole DeckApi. Côté navigateur, un shim
(~150 lignes, générique) détecte l'absence de `window.api` (donc : pas dans
Electron) et l'implémente au-dessus du WS :

- `invoke` → trame `{ id, method, args }` / réponse `{ id, result | error }`
  (le typage `DeckApi` existant rend le proxy mécanique — un `Proxy` JS ou une
  table générée depuis le type suffit) ;
- canaux push → trames serveur→client `{ channel, payload }`, branchées sur le
  même fan-out que les 14 `webContents.send` ;
- `ptyInput`/`ptyResize` → trames client→serveur sans réponse (chemin chaud).

Côté main, le bridge s'insère au niveau où `ipcMain.handle` est câblé
(`ipc.ts`) : les handlers actuels prennent `(event, ...args)` et n'utilisent
`event` que marginalement — le WS appelle la même table de handlers.

- ✅ Vraie UI native web sur le téléphone : texte net, scroll natif, layout
  adaptable, latence minimale (seuls les octets utiles transitent).
- ✅ Le « mode mobile » demandé devient un simple mode de layout du renderer
  (media query + `1×1` forcé + rail→tabs), pas un produit séparé.
- ✅ Multi-client gratuit ou presque : la fenêtre PC reste ouverte, le
  téléphone est un deuxième abonné aux mêmes événements.
- ❌ Demande un vrai lot sécurité (§5) et l'assomption de quelques trous de
  fonctionnalité (§4).

## 3. Voie C — inventaire de compatibilité de la surface DeckApi

Passage en revue des ~70 méthodes par famille, du point de vue « appelée
depuis un navigateur mobile via WS » :

| Famille | Exemples | Compatibilité |
|---|---|---|
| Sessions & PTY | `listSessions`, `createSession`, `ptyInput`, `ptyResize`, `onPtyData` | ✅ Totale — tout s'exécute côté main ; xterm.js tourne déjà dans le renderer |
| Config / i18n | `getConfig`, `setConfig`, `getI18n` | ✅ Totale |
| Workspaces / templates / snippets | `listWorkspaces`, `applyTemplate`… | ✅ Totale |
| Roadmap / inbox / journal / diff | `roadmapList`, `inboxHistory`, `collectDiff`… | ✅ Totale (le main parle au broker, comme aujourd'hui) |
| Graphe | `graphList`, `graphInfer`… | ✅ Totale (stores et inférences côté main) |
| Superviseur / aide / digest | `ensureSupervisor`, `askHelp` | ✅ Totale |
| **Navigateur embarqué** | `BrowserView.tsx` (`<webview>`), `getBrowserPreloadPath`, `captureBrowser` | ❌ `<webview>` n'existe que dans Electron. À masquer en mode distant (feature-gate sur le shim). L'alternative honnête : bouton « ouvrir l'URL dans le navigateur du téléphone » |
| Dialogues natifs | `pickDirectory` | ⚠️ `dialog.showOpenDialog` s'ouvrirait… sur l'écran du PC. En mode distant : remplacer par un champ chemin + un mini-browseur de répertoires servi par le main (ou dégrader : saisie manuelle) |
| Menus natifs | `onMenu*` (8 canaux) | ✅ Non-problème — ce sont des événements entrants ; le mobile a ses propres boutons |
| Captures design | `listCaptureWindows`, `captureWindow`, `onDesignPick` | ⚠️ Fonctionne (le main capture et renvoie des data-URLs) mais le mode design est un workflow desktop ; à masquer en v1 |

**Trou fonctionnel réel : uniquement le navigateur embarqué.** Tout le reste
est soit totalement compatible, soit dégradable proprement.

### Points d'attention d'implémentation (pour mémoire, hors périmètre ici)

- **Multi-fenêtre implicite** : quelques endroits du main supposent UNE
  `mainWindow` (focus de session, `render-process-gone`, dialogues
  d'approbation `launch-approval.ts`). L'approbation one-time d'un
  `launchCommand` projet doit **rester sur le PC** (ne jamais approuver depuis
  le mobile un code que seul l'écran du PC permet d'auditer) — au minimum en v1.
- **Backpressure `pty:data`** : sur le LAN Wi-Fi, un `cat` d'un gros fichier
  peut saturer le WS ; prévoir un cap/coalescing par session côté bridge
  (précédent direct : le flush WS cappé du broker, mécanique B de v0.3.3).
- **Clavier mobile + xterm.js** : le vrai sujet UX. Les claviers virtuels
  n'ont ni Ctrl ni Esc ni Tab fiables ; il faut une barre de touches
  (Esc / Tab / Ctrl / ↑↓←→ / C-c) au-dessus du clavier — pattern éprouvé par
  Termux, Blink, ttyd. Sans elle, piloter Claude Code au doigt est pénible.
- **HTTPS vs HTTP** : servir en HTTP simple suffit fonctionnellement
  (xterm/WS marchent sans contexte sécurisé), mais le presse-papiers
  (`navigator.clipboard`) et quelques APIs exigent un contexte sécurisé —
  argument de plus pour le TLS du §5.
- **Découverte** : mDNS (`kory._tcp.local`) est le confort ultime mais un QR
  code affiché dans la fenêtre PC (URL + token) suffit et sert déjà
  l'appairage — faire d'une pierre deux coups.

## 4. Le « mode mobile » côté UI

Le souhait « basculer en mode mobile » se décompose en trois niveaux, du plus
frustre au plus fini :

1. **Rien** (v0) : le layout desktop dans Safari/Chrome mobile. Utilisable en
   pinch-zoom, pas agréable. Suffit pour valider le bridge.
2. **Layout responsive** (v1) : media query ≤ ~700 px → rail devient
   bottom-tabs, sidebar devient drawer, `displayMode` forcé `1×1` avec un
   swipe/sélecteur de session, barre de touches terminal. Le gros est du CSS
   sur l'existant (`styles.css` est déjà centralisé en variables).
3. **PWA** (v2) : manifest + icône → « installée » sur l'écran d'accueil,
   plein écran sans chrome navigateur. Peu de travail une fois v1 acquise ;
   nécessite HTTPS (encore le §5).

Remarque importante : le mode mobile ne doit PAS être un fork du renderer.
C'est le même bundle, avec un état `isRemote` (posé par le shim) et des media
queries. Toute divergence de code UI serait une dette immédiate (i18n, thèmes,
parité de features).

## 5. Sécurité — le vrai sujet

`ptyInput` = frappe dans un shell de l'utilisateur du PC. `createSession` =
lancement de process arbitraires (le `launchCommand`). `setConfig` /
`saveLaunchConfig` = modification de ce qui sera exécuté. **Le bridge LAN est
donc, fonctionnellement, un accès shell distant.** Le modèle de menace n'est
pas « quelqu'un lit ma roadmap », c'est « quelqu'un sur mon Wi-Fi exécute du
code sur mon PC ».

Exigences minimales (toutes déjà partiellement outillées dans le code) :

1. **Off par défaut.** Le serveur LAN ne démarre que sur action explicite
   (Settings > « Accès mobile » ou bouton dédié), et l'état est visible en
   permanence dans la fenêtre PC (badge « 📱 accès mobile actif »).
2. **Appairage par token éphémère + QR code.** Le main mint un token (32
   octets aléatoires — même primitive que `deck-control.ts`), l'affiche en QR
   `https://<ip-lan>:<port>/#<token>` dans la fenêtre PC. Le WS refuse tout
   upgrade sans token (précédent exact : `tests/broker-ws-auth.test.ts`).
   Optionnel : confirmation à un coup sur le PC à la première connexion d'un
   appareil (TOFU — le patron TOFU des groupes existe déjà dans le broker).
3. **LAN-only appliqué, pas juste espéré.** Trois ceintures :
   bind sur l'interface privée choisie (pas `0.0.0.0` aveugle) ; rejet des
   adresses source hors RFC1918/ULA ; aucune fonctionnalité de type relais ou
   tunnel — le README doit dire explicitement « si vous voulez du hors-LAN,
   c'est votre VPN (Tailscale/WireGuard) qui le fournit, pas l'app ».
4. **TLS avec certificat auto-signé généré au premier lancement**, dont
   l'empreinte voyage dans le QR. Sans TLS, le token et chaque frappe passent
   en clair sur le Wi-Fi. C'est aussi la clé des APIs navigateur (clipboard,
   PWA). Le coût (écran d'avertissement navigateur à la première visite) est
   acceptable en LAN.
5. **Périmètre dégradé en v1.** Depuis le mobile : pas d'approbation de
   `launchCommand` (§3), pas d'édition des secrets provider (le renderer ne
   voit déjà que `hasKey` — garder ça), pas de `pickDirectory` natif.
6. **Journalisation.** Connexion/déconnexion d'un appareil distant → entrée
   journal (`journal.ts`) + toast sur le PC. La trame d'observabilité
   (O3–O6) est déjà là.

## 6. Découpage en lots (si la voie C est retenue)

| Lot | Contenu | Dépend de | Taille |
|---|---|---|---|
| **M1 — Bridge core** | Serveur HTTP statique (bundle renderer) + WS DeckApi dans le main ; shim `window.api` côté web ; fan-out des 14 `webContents.send` ; feature-gate `<webview>`/dialogues | — | **M** |
| **M2 — Appairage & sécurité** | Toggle Settings, token + QR dans la fenêtre PC, TLS auto-signé, filtre RFC1918, journalisation | M1 | **M** |
| **M3 — Mode mobile UI** | Media queries (rail→tabs, drawer), `1×1` forcé + sélecteur de session, barre de touches xterm | M1 | **M** |
| **M4 — Confort** | PWA (manifest, icônes), mDNS, backpressure `pty:data`, reconnexion WS auto | M1–M3 | **S/M** |

M1+M2 donnent un accès mobile fonctionnel mais spartiate ; M3 tient la
promesse « mode mobile ». Chaque lot est testable avec l'outillage existant
(`bun test` sur le bridge et le shim — logique pure dans `desktop/src/shared/`
conformément aux conventions, cf. DESKTOP.md).

## 7. Verdict

- **Faisable : oui, proprement.** L'app a — sans l'avoir cherché — la forme
  idéale pour ça : renderer 100 % web, contrat `DeckApi` unique et typé,
  émissions main centralisées, précédents HTTP/WS/token dans le code, mode
  `1×1` déjà en place. La voie C (web remoting du protocole, pas des pixels)
  est la seule qui tienne la promesse « basculer en mode mobile ».
- **Le navigateur embarqué est la seule feature non transposable** ; tout le
  reste est compatible ou dégradable explicitement.
- **Le budget réel est dans la sécurité et le clavier mobile**, pas dans le
  transport : exposer le deck sur le LAN, c'est exposer un shell — appairage
  QR + TLS + LAN-only appliqué sont le cœur du travail sérieux.
- **Court terme, zéro code** : Sunshine/Moonlight ou RustDesk en direct IP
  rendent la fenêtre dès aujourd'hui, en qualité « dépannage ».
