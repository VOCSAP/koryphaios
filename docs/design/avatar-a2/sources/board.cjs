// Board bench: renders one page per silhouette plus an overview, captures each
// with capturePage at device scale 1 (1 CSS px = 1 image px = real size).
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const g = require('./geom.cjs')

app.commandLine.appendSwitch('force-device-scale-factor', '1')
const OUT = process.env.BOARD_OUT || path.join(os.tmpdir(), 'avatar-a2-board')
let contrastRows = null
const contrastOf = () => (contrastRows ??= JSON.parse(fs.readFileSync(path.join(OUT, 'tray', 'contrast.json'), 'utf-8')))

const CSS = `
  html{overflow:hidden} body{margin:0;background:${g.BG};color:#151515;font:12px/1.35 "Segoe UI",sans-serif;padding:20px 24px;width:max-content}
  h1{font-size:20px;margin:0 0 2px} h2{font-size:13px;margin:22px 0 8px;text-transform:uppercase;letter-spacing:.06em;color:#262626}
  .sub{color:#262626;margin-bottom:6px}
  .row{display:flex;gap:14px;align-items:flex-start}
  .cell{width:160px;text-align:center}
  .cell b{display:block;font-size:13px;margin-top:2px}
  .mv{font-size:10.5px;color:#1f1f1f;margin-top:2px;min-height:42px}
  .cost{font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#2b2b2b}
  .small .cell{width:56px}
  .bar{display:flex;gap:18px;padding:12px 16px;border-radius:8px;align-items:flex-end}
  .bar.light{background:#f3f3f3;color:#202020} .bar.dark{background:#202020;color:#e6e6e6}
  .ti{text-align:center;font-size:10.5px}
  .ti .z{image-rendering:pixelated;width:64px;height:64px;display:block;margin:0 auto 4px}
  .ti .px{display:flex;gap:6px;justify-content:center;align-items:flex-end;height:34px}
  .bars{display:flex;gap:16px}
`

function trayCell(sil, bar, v) {
  const contrast = contrastOf()
  const r16 = contrast.find((r) => r.sil === sil && r.bar === bar && r.variant === v && r.size === 16)
  const r32 = contrast.find((r) => r.sil === sil && r.bar === bar && r.variant === v && r.size === 32)
  const f = (r) => `${r.own.face.toFixed(2)}${r.own.badge !== null ? ` · badge ${r.own.badge.toFixed(2)}` : ''}`
  const base = `tray/${sil}/${v}-${bar}`
  return `<div class="ti"><img class="z" src="${base}-16.png"><div class="px"><img src="${base}-16.png" width="16" height="16"><img src="${base}-32.png" width="32" height="32"></div>${v}<br>16 px ${f(r16)}<br>32 px ${f(r32)}</div>`
}

function boardHtml(sil) {
  const s = g.SILS[sil]
  const faces = g.FACES.map((f) => `<div class="cell">${g.figureSvg(sil, f, 160)}<b>${g.LABEL[f]}</b><div class="mv">${g.MOTION[f].text}</div><div class="cost">${g.MOTION[f].cost}</div></div>`).join('')
  const far = g.FACES.map((f) => `<div class="cell">${g.figureSvg(sil, f, 48)}<div>${g.LABEL[f]}</div></div>`).join('')
  const r8 = [['control', 'témoin à éviter : disques serrés, sans scène'], [1, '1 Deck'], [3, '3 Decks'], [4, '4 Decks'], [6, '6 Decks']]
    .map(([n, label]) => `<div class="cell">${g.rule8Svg(sil, n, 160)}<div>${label}</div></div>`).join('')
  const bars = ['light', 'dark'].map((bar) => `<div class="bar ${bar}">${g.TRAY_VARIANTS.map((v) => trayCell(sil, bar, v)).join('')}<div class="ti" style="align-self:center;max-width:90px">barre ${bar === 'light' ? 'claire #f3f3f3' : 'sombre #202020'}<br>contraste pic,<br>seuil 3:1</div></div>`).join('')
  return `<!doctype html><meta charset="utf-8"><style>${CSS}</style><body>
    <h1>Silhouette ${sil} · ${s.name}</h1><div class="sub">${s.note}. Monochrome sur gris moyen #808080, taille réelle (personnage 160 px de large).</div>
    <h2>Sept visages · mouvement en mode continu</h2><div class="row">${faces}</div>
    <h2>Vu à environ 2 m (30 %)</h2><div class="row small">${far}</div>
    <h2>Règle 8 · aplat monochrome</h2><div class="row">${r8}</div>
    <h2>Réduction au Tray · 16 et 32 px, zoom ×4 du 16 px</h2><div class="bars">${bars}</div>
  </body>`
}

function overviewHtml() {
  const rows = Object.keys(g.SILS).map((sil) => `<h2>${sil} · ${g.SILS[sil].name}</h2><div class="row">${g.FACES.map((f) => `<div class="cell">${g.figureSvg(sil, f, 160)}<b>${g.LABEL[f]}</b></div>`).join('')}</div>`).join('')
  return `<!doctype html><meta charset="utf-8"><style>${CSS}</style><body><h1>Avatar A2 · trois silhouettes, sept visages</h1>${rows}</body>`
}

let win
function compareHtml() {
  const row = (fn, w) => g.FACES.map((f) => `<div class="cell"${w < 100 ? '' : ''}>${fn(f, w)}<b>${g.LABEL[f]}</b></div>`).join('')
  const B = (f, w) => g.figureSvg('B', f, w)
  const P = (f, w) => g.figureSvgPrime(f, w)
  const r8 = [['control', 'témoin à éviter'], [1, '1 Deck'], [3, '3 Decks'], [4, '4 Decks'], [6, '6 Decks']]
    .map(([n, label]) => `<div class="cell">${g.rule8SvgPrime(n, 160)}<div>${label}</div></div>`).join('')
  const bars = ['light', 'dark'].map((bar) => `<div class="bar ${bar}">${g.TRAY_VARIANTS.map((v) => trayCell('B', bar, v)).join('')}${g.TRAY_VARIANTS.map((v) => trayCell('Bp', bar, v)).join('')}<div class="ti" style="align-self:center;max-width:90px">B (4 à gauche)<br>B' (4 à droite)<br>barre ${bar === 'light' ? 'claire #f3f3f3' : 'sombre #202020'}</div></div>`).join('')
  return `<!doctype html><meta charset="utf-8"><style>${CSS}</style><body>
    <h1>B · Tragédie contre B' · masque de théâtre</h1><div class="sub">Monochrome sur #808080, taille réelle 160 px. B' : ouvertures découpées dans une plaque, scène abaissée et élargie.</div>
    <h2>B</h2><div class="row">${row(B, 160)}</div>
    <h2>B'</h2><div class="row">${row(P, 160)}</div>
    <h2>Vu à environ 2 m (30 %) · B en haut, B' en bas</h2><div class="row small">${row(B, 48)}</div><div class="row small" style="margin-top:8px">${row(P, 48)}</div>
    <h2>Règle 8 · B' en aplat monochrome</h2><div class="row">${r8}</div>
    <h2>Tray · 16 et 32 px, zoom ×4 du 16 px</h2><div class="bars" style="flex-direction:column">${bars}</div>
  </body>`
}

async function capture(name, html) {
  const file = path.join(OUT, `${name}.html`)
  fs.writeFileSync(file, html)
  win = win ?? new BrowserWindow({ width: 1400, height: 1200, show: false, webPreferences: { offscreen: true } })
  await win.loadFile(file)
  const [w, h] = await win.webContents.executeJavaScript('[document.body.scrollWidth, document.body.scrollHeight]')
  win.setContentSize(w, h)
  await new Promise((r) => setTimeout(r, 600))
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: w, height: h })
  fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG())
  console.log(name, w, h, img.getSize())
}

app.whenReady().then(async () => {
  try {
    if (process.argv.includes('--skin')) await capture('skin-real', fs.readFileSync(path.join(OUT, 'skin-real.html'), 'utf-8'))
    else if (process.argv.includes('--compare')) await capture('compare-B', compareHtml())
    else {
      for (const sil of Object.keys(g.SILS)) await capture(`board-${sil}`, boardHtml(sil))
      await capture('overview', overviewHtml())
    }
  } catch (e) {
    console.error('board capture failed', e)
    process.exitCode = 1
  }
  app.quit()
})
