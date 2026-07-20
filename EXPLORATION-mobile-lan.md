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
  d'approbation `launch-approval.ts`). Les dialogues d'approbation sont
  aujourd'hui des dialogues natifs attachés à la fenêtre — à re-router en
  événement DeckApi (question + réponse) pour qu'ils puissent être rendus
  indifféremment sur le PC ou sur un mobile apparié « opérateur » (§5.3) ;
  le texte intégral du `launchCommand` à approuver s'affiche aussi bien sur
  un téléphone que sur le PC.
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

### Navigateur (PWA) ou app native Android ?

Question légitime : le client mobile est-il un site LAN ouvert dans le
navigateur, ou une vraie app Android ? Comparaison honnête :

| Critère | Web / PWA | App native Android |
|---|---|---|
| Distribution | Rien à installer — le scan du QR ouvre l'URL dans Chrome | APK à sideloader ou store à maintenir |
| Version | **Le PC sert l'UI** : le client est toujours exactement à la version de l'hôte, protocole compris | Risque de décalage app ↔ desktop à chaque release |
| Codebase | Le même bundle renderer (tout l'intérêt de la voie C) | Soit une 2ᵉ UI complète (terminaux, roadmap, graphe — énorme), soit une WebView… qui est le site web déguisé |
| Cert TLS auto-signé | Avertissement navigateur à la 1ʳᵉ visite (une fois, si le cert est stable) | Pinning propre du cert, zéro avertissement |
| Notifications hors app | WS tué par Android quand l'onglet passe en arrière-plan | Foreground service qui tient le WS → alerte « un agent demande ton attention » |
| Clavier terminal | Barre de touches web (pattern Termux/ttyd) | Contrôle total du clavier, IME custom possible |

**Décision opérateur : coquille Capacitor d'emblée** (pas de détour PWA). Le
critère qui tranche est le scénario réel d'usage : on lance des agents, on
pose le téléphone, on revient une heure plus tard. Android tue le WebSocket
d'un onglet en arrière-plan en quelques minutes — un client navigateur ne
survivrait jamais à une session de dev utile, et maintenir l'écran allumé
n'est pas une option. Il faut un process natif qui tienne la connexion.

La coquille reste FINE — deux façons de l'architecturer, la seconde retenue :

- ~~(a) Bundle web empaqueté dans l'APK~~ : on perdrait l'avantage structurel
  « l'hôte sert l'UI » — risque de décalage APK ↔ desktop à chaque release,
  à gérer par un handshake de version de protocole. À éviter.
- **(b) APK = pure coquille, l'UI vient toujours de l'hôte.** L'app Android
  embarque uniquement : le scanner QR natif, une WebView pointée sur l'URL
  scannée (le PC sert le même bundle renderer qu'en desktop), la confiance
  du certificat auto-signé de l'hôte (pinning — l'avertissement navigateur
  disparaît), le service foreground, et le verrou biométrique (5.5). La
  coquille ne change presque jamais ; l'UI est toujours exactement à la
  version de l'hôte. C'est la voie C jusqu'au bout.

### Arrière-plan : ne pas streamer, écouter

Tenir le flux complet (`pty:data` de N sessions) pendant une heure d'écran
éteint serait un gouffre à batterie — et ne sert à rien : personne ne lit un
terminal éteint. Le bon découpage :

- **Premier plan** : WS complet, tuiles live, comme sur le PC.
- **Arrière-plan** (service foreground Android, notification persistante
  « Compagnon connecté ») : le client bascule sur un **canal léger** — il
  garde le WS mais coupe les abonnements volumineux et ne reçoit plus que
  les événements de signal : `session:attention` (existe déjà dans DeckApi —
  c'est précisément « un agent demande ton attention »), `session:quota`,
  `inbox:new`, `broker:status` → notifications locales Android. Retour au
  premier plan → verrou biométrique → réabonnement complet + refresh d'état
  (le store se ré-hydrate par `listSessions`/`getConfig`, déjà le patron).
- Limite honnête : même un service foreground subit Doze (fenêtres de
  maintenance réseau, écran éteint longtemps). Pour le scénario « une heure »
  c'est en pratique OK avec l'exemption d'optimisation batterie demandée à
  l'installation ; les notifications peuvent au pire arriver par vagues.

### Revue vue par vue (contexte : Samsung S22, ~360×780 px CSS)

Servir l'UI du PC ne suffit pas : chaque vue doit être auditée pour le tactile.
Grille de lecture utilisée — un S22 en usage réel : une main, pouce, cibles
tactiles ≥ 48 px, **pas de hover** (39 règles `:hover` dans `styles.css` à
doubler d'une affordance visible), **pas de clic droit** (5 composants posent
un `onContextMenu` — mais tous passent par le `ContextMenu.tsx` partagé : UN
point d'adaptation → long-press + bottom sheet, le patron Android standard),
**pas de drag HTML5** (l'API `draggable` ne fonctionne pas au doigt), pas de
touche Échap (toute modale doit avoir sa croix), tooltips `title=` morts, et
un clavier virtuel qui mange la moitié de l'écran (`visualViewport` à écouter
pour re-fitter les terminaux).

Trois familles de traitement — c'est la classification qui pilote l'effort :

- **A. CSS seul** : la vue vit telle quelle en une colonne.
- **B. Recomposition** : mêmes composants, chrome réarrangé (drawer, sheets,
  pager).
- **C. Redesign d'interaction** : le modèle d'interaction desktop n'a pas
  d'équivalent tactile — il faut une présentation alternative.

| Vue | Famille | Usage mobile dominant | Traitement |
|---|---|---|---|
| 🖥 Agents | **B** | Surveiller, répondre à un agent | Pager 1×1 + barre de touches |
| 🏠 Home | **A** | Piloter le deck en langage naturel | Gratuit une fois Agents fait |
| 🗺 Roadmap | **C** | Consulter, changer un statut, « process now » | Kanban → une colonne + bottom sheet |
| 🕸 Graph | **C** | Lire une branche, répondre | Canvas → mode fil (thread) |
| 🌐 Browser | — | Exclu du mode distant (§3) | Masqué de la nav |
| ⎇ Worktrees | **A** | Consulter, supprimer | Liste + confirmations existantes |
| 📜 Journal | **A** | Lire | Chips de filtre, scroll |
| ✉ Inbox | **B** | LE centre de notifications | Écran plein + badge d'onglet |
| ⚙ Settings | **A/B** | Rare sur mobile | Liste Android groupée |
| Diff | **A** | Relire un diff | Déjà en rendu **unifié** ✅ — scroll horizontal par bloc |
| 🔍 Recherche | **B** | Retrouver dans les buffers | Overlay plein écran standard |
| Dialogues (workspaces, templates, snippets, ModelPicker, CreateMenu) | **B** | Rare | Bottom sheets / formulaires plein écran |

**Navigation générale** : le rail vertical devient une bottom-tab-bar Material
(5 emplacements max) : 🏠 Home, 🖥 Agents, 🗺 Roadmap, ✉ Inbox (badge
non-lus — c'est l'onglet le plus « mobile » de l'app), ⋯ Plus (Graph,
Journal, Worktrees, Settings). Chaque vue gagne une top app bar (titre +
actions), car sur desktop ces actions vivent dans des tooltips et des menus
contextuels invisibles au doigt. `StatusBanner` reste un bandeau persistant en
haut ; les toasts deviennent des snackbars en bas.

Détail des trois vues qui méritent l'analyse :

**🖥 Agents (famille B — la plus simple, confirmé).** `displayMode` forcé
`1×1` (le mode existe), la grille devient un **pager** : swipe horizontal
entre sessions + rangée de chips (nom, couleur, badge attention ⚠ / quota)
comme sélecteur direct — les deux patrons standards en un. La sidebar
desktop (redimensionnable à la souris — n'a pas de sens au doigt) disparaît
au profit des chips + d'un bottom sheet « toutes les sessions » (où le
réordonnancement se fait par poignées de drag, remplaçant le drag desktop).
La barre de touches xterm (Esc / Tab / Ctrl / ↑↓←→ / C-c / coller) se pose
au-dessus du clavier, patron Termux/ttyd. Point technique : re-fit du
terminal sur apparition du clavier et rotation (`visualViewport` +
l'addon-fit déjà présent).

**🗺 Roadmap (famille C — votre intuition est juste, mais le redesign est
borné).** Le kanban 4 colonnes + drag & drop HTML5 est intransposable :
au doigt, le drag inter-colonnes se bat avec le scroll vertical ET le swipe
horizontal, sur des cibles de 300 px — même Trello et Jira mobile ont
renoncé. Le patron standard mobile (Trello/Jira/GitHub Projects) :
**une colonne à la fois** — segmented control ou tabs de statut en haut
(idea / planned / in_progress / done, avec compteurs ; archived derrière le
« ⋯ ») + swipe horizontal entre colonnes, cartes pleine largeur. Le
déplacement devient **explicite** : tap sur la carte ou « ⋮ » → bottom sheet
« Déplacer vers… / Modifier / File d'attente / Process now / Archiver » —
exactement le contenu de l'actuel menu clic-droit, plus le changement de
statut. Rien n'est perdu sémantiquement : le drag desktop N'EST qu'un
changement de statut ; le tri en colonne est déjà automatique (MoSCoW), donc
aucun réordonnancement manuel à transposer. La confirmation sur « done »,
les cartes verrouillées 🔒 (grisées, non déplaçables) et le bouton ⏹ Stop se
conservent tels quels. La modale de détail devient une page plein écran avec
actions collantes en bas. Le coût réel est une **présentation alternative de
la même donnée** : les cinq appels IPC (`roadmapList/Upsert/Archive/Stop/
Assign`) et le tokenizer markdown sont inchangés.

**🕸 Graph (famille C — le plus gros morceau, à phaser).** Le canvas est
souris-only aujourd'hui (zoom molette, pan par drag — aucun handler touch,
vérifié dans `GraphView.tsx`), et même « touchifié » (pinch/pan), brancher
ou croiser des nœuds au doigt sur 6" est irréaliste. Mais l'architecture
sauve la mise : **le graphe est la source de vérité et chaque nœud recompile
son contexte depuis ses ancêtres** — une branche EST un fil de discussion.
Le mode mobile naturel est donc un **mode fil (thread)** : la branche
sélectionnée rendue comme une conversation linéaire (l'ordre existe déjà —
`outlineOrder` dans `shared/graph.ts`), sélecteur de branche aux
embranchements, composer en bas = UX de chat standard ; les nœuds de merge
gardent leur rendu documentaire par sections. Le canvas reste accessible en
lecture (pinch/pan, tap sur un nœud → l'ouvrir dans le fil) comme une
minimap. Phasage : lire + répondre au bout d'une branche = M-mobile ;
brancher/croiser/battle mode restent desktop-first sans que rien ne bloque.
Les action cards « graph draft » de l'inbox débouchent sur le fil, pas sur
le canvas.

Priorisation par valeur d'usage mobile (le compagnon sert à **surveiller et
débloquer**, pas à faire de l'authoring profond) : 1. Agents + Home +
barre de touches ; 2. Inbox ; 3. Roadmap une-colonne ; 4. Journal/Worktrees/
Diff (quasi gratuits) ; 5. Graph mode fil ; Settings et l'authoring graphe
avancé restent desktop.

Remarque importante : le mode mobile ne doit PAS être un fork du renderer.
C'est le même bundle, avec un état `isMobile` (posé par media query
`pointer: coarse` + largeur, ou par la coquille) et des media queries. Pour
les familles A/B, aucune divergence de code — du CSS et du chrome. Pour les
deux vues de famille C, la règle se précise : **état, données et logique
partagés, seule la couche de présentation est alternative** (`RoadmapBoard`
vs `RoadmapList`, `GraphCanvas` vs `GraphThread` — mêmes stores, mêmes appels
IPC, mêmes helpers `shared/`). Toute duplication de logique serait une dette
immédiate (i18n, thèmes, parité de features).

## 5. Sécurité — le vrai sujet

`ptyInput` = frappe dans un shell de l'utilisateur du PC. `createSession` =
lancement de process arbitraires (le `launchCommand`). `setConfig` /
`saveLaunchConfig` = modification de ce qui sera exécuté. **Le bridge LAN est
donc, fonctionnellement, un accès shell distant.** Le modèle de menace n'est
pas « quelqu'un lit ma roadmap », c'est « quelqu'un sur mon Wi-Fi exécute du
code sur mon PC ».

### 5.1 Socle minimal (non négociable)

Toutes ces briques sont déjà partiellement outillées dans le code :

1. **Off par défaut.** Le serveur LAN ne démarre que sur action explicite
   (Settings > « Accès mobile » ou bouton dédié), et l'état est visible en
   permanence dans la fenêtre PC (badge « 📱 accès mobile actif »).
2. **Appairage par token éphémère + QR code.** Le main mint un token
   **à usage unique** (32 octets aléatoires — même primitive que
   `deck-control.ts`), l'affiche en QR `https://<ip-lan>:<port>/#<token>`
   dans la fenêtre PC ; le téléphone l'échange à la première connexion contre
   un **credential d'appareil** durable (stocké côté mobile). Le WS refuse
   tout upgrade sans credential valide (précédent exact :
   `tests/broker-ws-auth.test.ts`).
3. **LAN-only appliqué, pas juste espéré.** Trois ceintures :
   bind sur l'interface privée choisie (pas `0.0.0.0` aveugle) ; rejet des
   adresses source hors RFC1918/ULA ; aucune fonctionnalité de type relais ou
   tunnel — le README doit dire explicitement « si vous voulez du hors-LAN,
   c'est votre VPN (Tailscale/WireGuard) qui le fournit, pas l'app ».
4. **TLS avec certificat auto-signé généré au premier lancement**, dont
   l'empreinte voyage dans le QR. Sans TLS, le token et chaque frappe passent
   en clair sur le Wi-Fi. C'est aussi la clé des APIs navigateur (clipboard,
   PWA, **WebAuthn** — cf. 5.2). Le coût (écran d'avertissement navigateur à
   la première visite) est acceptable en LAN.
5. **Journalisation.** Connexion/déconnexion d'un appareil distant → entrée
   journal (`journal.ts`) + toast sur le PC. La trame d'observabilité
   (O3–O6) est déjà là.

### 5.2 Niveau recommandé (par-dessus le socle)

Ce que le socle ne couvre pas, c'est la **vie après l'appairage** : téléphone
perdu/volé, session laissée ouverte, curiosité d'un tiers sur le même Wi-Fi.
Les mesures recommandées adressent précisément ça :

1. **Registre d'appareils + révocation.** Chaque appairage crée une entrée
   nommée (« Pixel d'Olivier », date, dernière activité) visible dans
   Settings ; révocation individuelle en un clic + **kill switch** global
   (« déconnecter tout et couper le serveur »). C'est la mesure au meilleur
   ratio coût/valeur de toute la liste.
2. **Step-up biométrique (WebAuthn plateforme)** pour les actions de tier 3
   (cf. 5.4) : l'action sensible demande Face ID / empreinte **sur le
   téléphone**, sans retour au PC. WebAuthn exige un contexte sécurisé —
   fourni par le TLS du socle. Fallback si WebAuthn indisponible : PIN
   d'appareil défini à l'appairage.
3. **Verrouillage d'inactivité.** Session distante verrouillée après N
   minutes sans interaction (rideau + re-auth step-up) ; borne dure de durée
   de vie du credential avec ré-appairage QR périodique (ex. 30 jours).
4. **Anti-bruteforce.** Rate-limit sur l'endpoint d'auth, lockout progressif,
   et invalidation du QR affiché après quelques minutes ou dès le premier
   échange réussi.
5. **Journal enrichi.** Chaque action distante taguée `device_id` dans le
   journal ; vue « activité distante » filtrable. Les approbations tier 3
   loggent le contenu approuvé (le hash + le texte du `launchCommand`).
6. **Conscience du réseau.** Avertir (voire refuser de démarrer) si
   l'interface active est classée « réseau public » (Windows network
   category / absence de passerelle privée). ~~Allowlist d'IPs clientes~~ —
   proposée dans une première version, **écartée** (voir 5.5 : apport quasi
   nul sous le mode éphémère, coût de maintenance réel).
7. **Option CA locale** (mkcert ou équivalent) pour remplacer l'auto-signé
   chez qui veut faire disparaître l'avertissement navigateur et ancrer la
   confiance TLS proprement.

### 5.3 Autonomie mobile : l'appairage QR EST le transfert de confiance

Position révisée par rapport à une première intuition « les approbations
sensibles restent sur le PC » — qui ne tient pas à l'examen, pour deux
raisons :

- **L'argument d'audit est faible** : le texte d'un `launchCommand` à
  approuver s'affiche aussi lisiblement sur un écran de téléphone que sur un
  moniteur. Le PC n'a aucun privilège épistémique.
- **L'argument de confiance est circulaire** : pour scanner le QR
  d'appairage, il faut être physiquement devant le PC déverrouillé — c'est-à-
  dire détenir déjà le privilège maximal (l'accès au shell local). La
  cérémonie d'appairage est donc **le** moment du transfert de confiance ;
  exiger ensuite des allers-retours vers le PC n'ajoute pas de sécurité, il
  n'ajoute que de la friction.

Le modèle propre est un **niveau de confiance par appareil, choisi à
l'appairage** :

| Profil | Capacités | Usage type |
|---|---|---|
| **Opérateur** (défaut du flux QR) | Tout, y compris tiers 3 avec step-up biométrique — autonomie complète, zéro retour PC | Le téléphone du propriétaire du PC |
| **Compagnon** | Tiers 0–1 (lecture + interaction avec l'existant) ; les actions tiers 2–3 génèrent une demande dans l'inbox de l'opérateur | Tablette du salon, appareil secondaire, démo |

Le risque résiduel de l'autonomie complète n'est pas « le mobile approuve »,
c'est « quelqu'un d'autre tient le mobile ». Il se traite avec les mesures
5.2 (step-up biométrique par action sensible, verrouillage d'inactivité,
révocation immédiate depuis le PC) — pas en amputant le profil opérateur.

### 5.4 Détecter le « sensible » : déclaratif, jamais heuristique

Question légitime : comment sait-on qu'une action est « sensible » ? Réponse
ferme : **on ne le détecte pas, on le déclare.** Aucune inspection de contenu
à l'exécution n'est fiable (les frappes `pty:input` sont un flux opaque —
impossible de distinguer `ls` de `rm -rf` sans parser un shell, et c'est une
course perdue). La sensibilité est une **classification statique de la
surface DeckApi**, une table constante en code — exactement l'esprit de la
règle C8 (harnais verrouillés en constantes, jamais configurables) :

| Tier | Nature | Exemples (méthodes DeckApi) |
|---|---|---|
| 0 — lecture | Aucun effet | `listSessions`, `roadmapList`, `journalList`, `getConfig`, `inboxHistory` |
| 1 — interaction | Agit sur l'existant | `ptyInput`/`ptyResize` vers une session ouverte, éditions roadmap/graphe, `announce` |
| 2 — exécution/structure | Crée ou relance des process, modifie la structure | `createSession`, `restartSession`, `applyTemplate`, `createWorktree`, `roadmapDispatch` |
| 3 — changement de confiance | Étend ce qui POURRA s'exécuter ou qui a accès | approbation `launch-approval`, `setConfig` sur champs sensibles, `saveLaunchConfig`, secrets provider, gestion des appairages, arrêt/démarrage du serveur mobile |

Trois ancrages montrent que le code réifie déjà ces frontières — le tiering
ne fait que les nommer :

- **`launch-approval.ts`** : l'app sait déjà *exactement* quand quelque chose
  de non-encore-approuvé est sur le point de s'exécuter — c'est le miss du
  cache sha256 par `project_key`. « Sensible » n'est pas une devinette, c'est
  cet événement-là.
- **`provider-secrets.ts`** : la frontière secrets existe déjà (le renderer ne
  voit que `hasKey`) ; le tier 3 la reprend telle quelle.
- **`setConfig`** : la sensibilité y est **par champ**, pas par appel — une
  allowlist de champs tier 3 (`launchCommand`, sources de digest, endpoints
  modèles) contre le reste en tier 1 (displayMode, thème, langue).

Limite à énoncer honnêtement : dès qu'un appareil a le tier 1, il a
`ptyInput`, donc un shell — donc l'exécution arbitraire *dans les sessions
ouvertes*. Les tiers ne protègent pas l'opérateur de son propre shell ; ils
protègent contre l'**escalade silencieuse de capacités** (nouvelle commande
de lancement, modification de config/secrets, nouvel appairage) et donnent la
granularité du profil « compagnon » et du step-up. La vraie frontière de
sécurité reste la décision d'appairage (5.3) — le reste est de la défense en
profondeur.

### 5.5 Décision opérateur : mode « session compagnon éphémère »

Le mode retenu est **plus contraignant** que le niveau recommandé générique —
et, paradoxalement, plus simple à construire. Flux exact :

1. L'app tourne sur le PC, des agents sont lancés. Avant de s'absenter,
   l'opérateur clique **« Compagnon »** → la fenêtre affiche un QR code
   (URL + token à usage unique, **lié à ce lancement de l'app**).
2. Scan depuis le mobile → accès à la même session : mêmes tuiles, mêmes
   flux `pty:data`, même roadmap.
3. **Fermeture de l'app PC = révocation.** Le WS tombe (trame close en arrêt
   propre ; timeout de heartbeat ping/pong ~5 s en cas de crash) → le mobile
   affiche « hôte déconnecté » et revient à l'écran d'accueil.
4. Relance de l'app PC → **séquence complète à refaire** (Compagnon + scan).
   Aucun credential ne survit au process.

Terminologie : ce bouton « Compagnon » correspond au profil *opérateur* de
5.3 (accès complet) — le profil restreint homonyme de 5.3 devient une option
future, hors périmètre.

Conséquences — la liste 5.2 fond considérablement :

| Mesure 5.1/5.2 | Sous le mode éphémère |
|---|---|
| Credential d'appareil durable (5.1.2) | **Remplacé** par un token de pure session — plus rien à stocker côté mobile |
| Registre d'appareils, révocation, kill switch (5.2.1) | **Superflus** — fermer l'app est la révocation ; le kill switch, c'est la croix de la fenêtre |
| Expiration / ré-appairage 30 j (5.2.3) | **Sans objet** — la durée de vie est celle du process |
| Step-up biométrique par action (5.2.2) | **Remplacé par mieux** : un **verrou d'app façon WhatsApp** (5.5 bis) — critère fort retenu |
| Verrouillage d'inactivité (5.2.3) | **Absorbé** par le verrou d'app : passer en arrière-plan/veille verrouille |
| Anti-bruteforce (5.2.4) | **Conservé** — le token reste devinable par force brute tant que le serveur écoute |
| TLS (5.1.4) | **Conservé**, avec une nuance importante : le **certificat doit rester stable d'un lancement à l'autre** (généré une fois, persisté) même si les tokens sont éphémères — sinon l'avertissement navigateur revient à chaque session |
| Journal (5.1.5) | **Conservé** |

**Allowlist IP : écartée.** Deux clarifications sur l'objection (fondée) qui
l'a tuée :

- Elle n'aurait **jamais** vécu côté broker : le broker ne joue aucun rôle
  dans l'accès mobile (§1.3 — le serveur compagnon est dans le process main
  d'Electron, sur le PC). Le stockage aurait été la config locale du Deck
  (`store.ts`, JSON sur disque), pas une DB, et l'écran de gestion un champ
  dans Settings. Pas de double maintenance broker/client.
- « Sans auth, n'importe qui pourrait ajouter une IP » — non : modifier la
  config exige d'être devant le PC, ce qui est déjà le privilège maximal
  (l'auth locale n'apporterait rien, cohérent avec le modèle actuel
  « exécuter le binaire suffit »).

Mais l'objection **maintenance** suffit : sous le mode éphémère, le token par
lancement gate déjà tout ; une liste d'IPs à entretenir (DHCP qui tourne,
téléphone qui change d'adresse) pour un gain marginal est du pur coût. Le
filtre statique « rejeter tout ce qui n'est pas RFC1918 » (5.1.3), lui, reste
: zéro maintenance, il encode « LAN only » et rien d'autre.

### 5.5 bis — Verrou d'app biométrique (façon WhatsApp) : critère fort retenu

Le scénario d'attaque résiduel du mode éphémère est précis : le téléphone
posé, session compagnon active, quelqu'un le ramasse. Réponse retenue
(décision opérateur) : **verrouillage écran = verrouillage de l'app**, comme
WhatsApp/Signal :

- Passage en arrière-plan ou mise en veille de l'écran → l'app se verrouille.
  À la réouverture, `BiometricPrompt` (empreinte / visage, fallback code de
  l'appareil) avant de ré-afficher quoi que ce soit. Sans empreinte
  autorisée, l'UI reste inaccessible.
- **Le verrou est un rideau, pas une déconnexion** : le service foreground et
  le canal léger (§4) continuent de tourner derrière — les agents avancent,
  les notifications arrivent, et au déverrouillage on retrouve la session
  telle quelle. Verrouiller ne casse jamais le flux de travail.
- Implémenté dans la **coquille native**, pas dans l'UI web : c'est la
  WebView entière qui est masquée. À coupler avec `FLAG_SECURE` sur
  l'activité — l'aperçu de l'app dans le sélecteur de tâches Android est
  noirci et les captures d'écran bloquées (un terminal affiche des chemins,
  du code, parfois des secrets ; la vignette des « apps récentes » est une
  fuite classique).
- Nuance à connaître : `BiometricPrompt` accepte **toute empreinte enrôlée
  sur le téléphone** — « personne autorisée » = « personne enrôlée sur
  l'appareil », c'est l'OS qui définit ce périmètre, pas l'app.
- Ce verrou **remplace** le step-up par action de 5.2.2 (plus simple, plus
  systématique) et **absorbe** le verrouillage d'inactivité de 5.2.3.

## 6. Découpage en lots (si la voie C est retenue)

| Lot | Contenu | Dépend de | Taille |
|---|---|---|---|
| **M1 — Bridge core** | Serveur HTTP statique (bundle renderer) + WS DeckApi dans le main ; shim `window.api` côté web ; fan-out des 14 `webContents.send` ; feature-gate `<webview>`/dialogues | — | **M** |
| **M2 — Bouton Compagnon & socle sécurité (5.1 + 5.5)** | Bouton « Compagnon » + QR, token de session éphémère lié au lancement, TLS auto-signé (cert stable persisté), filtre RFC1918, heartbeat + écran « hôte déconnecté », anti-bruteforce, table de tiers DeckApi (5.4), journalisation | M1 | **M** |
| **M3 — Mode mobile UI** (phasé selon la revue §4) | M3a chrome : bottom-tabs, top app bars, ContextMenu→bottom sheet, modales plein écran ; M3b Agents/Home : pager 1×1, chips, barre de touches, re-fit clavier ; M3c Roadmap une-colonne (`RoadmapList`) ; M3d vues famille A (Journal, Worktrees, Diff, Settings, Recherche) ; M3e Graph mode fil (`GraphThread`) ; dialogues d'approbation re-routés en DeckApi (§3) | M1 | **L** (M3e détachable) |
| **M4 — Coquille Android Capacitor** | Scanner QR natif, WebView sur l'UI servie par l'hôte, pinning du cert auto-signé, service foreground + bascule canal léger/complet (§4), notifications locales (`session:attention`, `inbox:new`), verrou biométrique + `FLAG_SECURE` (5.5 bis), écran « hôte déconnecté » natif | M1–M3 | **M/L** |
| **M5 — Confort** | mDNS, backpressure `pty:data`, reconnexion WS auto, profil restreint (option), conscience du profil réseau | M1–M4 | **S/M** |

M1+M2+M3 donnent un compagnon utilisable au premier plan (testable dans un
simple navigateur, qui reste le client de debug naturel) ; **M4 est
indispensable au scénario cible réel** — poser le téléphone une heure pendant
que les agents travaillent et être notifié — et porte les deux exigences
fortes retenues : survie en arrière-plan et verrou biométrique. Chaque lot est testable avec l'outillage existant
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
