# Avatar A2 : planche B'

Card 8fb62e61. Silhouette retenue par l'opérateur : **B'**, le masque Tragédie
aux ouvertures découpées dans une plaque, scène abaissée sous le menton.

| Image | Ce qu'elle montre |
| --- | --- |
| `planche-b-prime.png` | La planche de décision : B contre B', sept visages à 160 px, vue à 2 m, règle 8 en aplat monochrome, réduction Tray 16 et 32 px sur barre claire et sombre. Dessinée par le prototype `sources/geom.cjs`, pas par le code livré. |
| `peau-livree.png` | La peau livrée (`MaskSkin`) rendue depuis le code : sept faces, une scène à 12 Decks et une à 17 (`+6`), thème sombre puis clair, chacun sur fond de bureau sombre et clair. |

La planche juge une lisibilité, pas une conformité : le mouvement, le hit-test
Windows et la présence des ressources dans le paquet se valident ailleurs.

## Régénérer

Les sorties vont dans `BOARD_OUT`, par défaut `<tmp>/avatar-a2-board`, jamais
dans le dépôt. Depuis la racine du dépôt :

```bash
# Tray du prototype : raster et contraste WCAG (requis par --compare)
MAGICK_BIN="<chemin de magick>" bun docs/design/avatar-a2/sources/tray.ts
# Planche de décision B contre B'
desktop/node_modules/electron/dist/electron.exe docs/design/avatar-a2/sources/board.cjs --compare
# Peau livrée : la page HTML, puis sa capture
bun test ./docs/design/avatar-a2/sources/render-skin.tsx
desktop/node_modules/electron/dist/electron.exe docs/design/avatar-a2/sources/board.cjs --skin
```

`render-skin.tsx` passe par le lanceur de tests parce que lui seul résout
l'alias `@shared` par `mock.module`. Son nom ne correspond pas au motif
`*.test.*` : la suite complète ne le collecte pas. Les captures se font à
l'échelle 1 (1 px CSS = 1 px d'image), donc à la taille réelle.
