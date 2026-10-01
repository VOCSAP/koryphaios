// Renders the shipped MaskSkin for the seven faces plus two stage stress cases,
// both themes on both desktop backgrounds, into a page board.js captures.
// Run through the test runner, which alone resolves the @shared alias mock:
//   bun test ./docs/design/avatar-a2/sources/render-skin.tsx
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mock, test } from 'bun:test'
import * as geometry from '../../../../desktop/src/shared/avatar-mask-geometry'

const REPO = join(import.meta.dir, '..', '..', '..', '..')
const OUT = process.env.BOARD_OUT ?? join(tmpdir(), 'avatar-a2-board')

mock.module('@shared/avatar-mask-geometry', () => ({ ...geometry }))

test('render the shipped skin board', async () => {
  const React = await import(join(REPO, 'desktop/node_modules/react/index.js'))
  const { renderToStaticMarkup } = await import(join(REPO, 'desktop/node_modules/react-dom/server.node.js'))
  const { AvatarState } = await import(join(REPO, 'desktop/src/shared/avatar-state.ts'))
  const { AVATAR_SKINS, AVATAR_FACES, avatarThemeVars } = await import(join(REPO, 'desktop/src/renderer/src/avatar/skins.ts'))

  const c = (p: Record<string, number> = {}) => ({ working: 0, idle: 0, unknown: 0, waiting: 0, exited: 0, rateLimited: 0, ...p })
  const ids = ['a', 'b', 'c', 'd'].map((deckRunId) => ({ deckRunId, broker_url: 'b1' }))
  function summary(face: string) {
    const clock = { now: 1e6 }
    const s = new AvatarState({ now: () => clock.now })
    const four = (p: Record<string, number>[], unread = 0) =>
      ids.forEach((identity, i) => s.receiveSnapshot({ identity, counters: c(p[i] ?? { idle: 1 }), unread: i === 0 ? unread : 0 }))
    if (face === 'panne') {
      s.receiveSnapshot({ identity: ids[1], counters: c({ working: 1 }), unread: 0 })
      clock.now += 20000
      ;[ids[0], ids[2], ids[3]].forEach((identity, i) => s.receiveSnapshot({ identity, counters: c(i === 0 ? { working: 1 } : { idle: 1 }), unread: 0 }))
    }
    if (face === 'reclame') four([{ waiting: 2 }, { idle: 1 }, { working: 1 }, { idle: 1 }])
    if (face === 'perdu') four([{ idle: 1 }, { exited: 1 }, { working: 1 }, { rateLimited: 1 }])
    if (face === 'courrier') four([{ idle: 1 }, { working: 0 }, { idle: 1 }, { idle: 1 }], 3)
    if (face === 'travaille') four([{ working: 1 }, { working: 2 }, { idle: 1 }, { working: 1 }])
    if (face === 'endormi') four([])
    if (face === 'cap12') {
      for (let i = 0; i < 12; i++) {
        const counters = c(i % 3 === 0 ? { exited: 1 } : i % 3 === 1 ? { rateLimited: 1 } : { working: 1 })
        s.receiveSnapshot({ identity: { deckRunId: `r${i}`, broker_url: i % 3 === 2 ? 'b3' : 'b2' }, counters, unread: 0 })
      }
      s.setBrokerReachable('b3', false)
    }
    if (face === 'over17') {
      for (let i = 0; i < 17; i++) s.receiveSnapshot({ identity: { deckRunId: `r${i}`, broker_url: 'b1' }, counters: c(i % 2 ? { working: 1 } : { exited: 1 }), unread: 0 })
    }
    return s.summary()
  }

  const rows = (['dark', 'light'] as const).map((theme) => {
    const vars = Object.entries(avatarThemeVars(theme)).map(([k, v]) => `${k}:${v}`).join(';')
    const cells = [...AVATAR_FACES, 'cap12', 'over17'].map((face: string) => {
      const svg = renderToStaticMarkup(React.createElement(AVATAR_SKINS.mask, { summary: summary(face) }))
      return `<div class="cell"><div class="avatar-root" data-halo="on" style="${vars}">${svg}</div><b>${face}</b></div>`
    }).join('')
    const [first, second] = theme === 'dark' ? ['#1a1d24', '#f2f2f2'] : ['#e9eef5', '#15171c']
    return `<h2>${theme} · fond de bureau ${theme === 'dark' ? 'sombre puis clair' : 'clair puis sombre'}</h2>
    <div class="brow" style="background:${first}">${cells}</div>
    <div class="brow" style="background:${second}">${cells}</div>`
  }).join('')

  const styles = pathToFileURL(join(REPO, 'desktop/src/renderer/src/styles.css')).href
  // The Deck stylesheet styles .row and the document; the board page overrides both.
  const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${styles}">
<style>html,body{overflow:visible!important;height:auto!important;width:max-content!important;display:block!important}body{margin:0;padding:16px;background:#808080;font:12px "Segoe UI"}.brow{display:flex;flex-wrap:nowrap;gap:10px;padding:10px;margin-bottom:6px}.cell{flex:none;width:160px;text-align:center;color:#888}h2{font-size:13px;margin:8px 0}</style>
<body>${rows}</body>`
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, 'skin-real.html'), html)
  console.log(`wrote ${join(OUT, 'skin-real.html')}`)
})
